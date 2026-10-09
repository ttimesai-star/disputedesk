import type { PayPalGateway } from "../paypal/client.ts";
import type { ChatMessage, Llm, ToolCall, ToolSpec } from "./llm.ts";

/**
 * "Ask DisputeDesk": a read-only research agent the seller can chat with.
 *
 * Tool definitions come from the official @paypal/agent-toolkit (OpenAI flavour), restricted to
 * read actions: list_disputes, get_dispute, list_transactions, get_order, get_shipment_tracking.
 *  - sandbox mode: tool calls are executed by the toolkit itself against api-m.sandbox.paypal.com
 *  - mock mode:    the same tool calls are executed against the in-memory gateway
 * Write actions (evidence, accept, message) are deliberately NOT exposed to the model: they go
 * through the seller-approved flow or the policy engine, both of which are journaled.
 */

export const READ_ONLY_ACTIONS = {
  disputes: { list: true, get: true },
  transactions: { list: true },
  orders: { get: true },
  shipment: { get: true },
} as const;

export interface ToolRunner {
  tools: ToolSpec[];
  run(call: ToolCall): Promise<string>;
  kind: "agent-toolkit" | "agent-toolkit-schemas+mock";
}

interface ToolkitLike {
  getTools(): { type: "function"; function: { name: string; description?: string; parameters?: unknown } }[];
  handleToolCall(call: ToolCall): Promise<{ content: unknown }>;
}

async function loadToolkit(clientId: string, clientSecret: string): Promise<ToolkitLike> {
  const mod = (await import("@paypal/agent-toolkit/openai")) as unknown as { PayPalAgentToolkit: new (o: unknown) => ToolkitLike };
  // context.sandbox MUST be true: the toolkit defaults to the live API otherwise.
  return new mod.PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: READ_ONLY_ACTIONS, context: { sandbox: true } } });
}

export async function createToolRunner(paypal: PayPalGateway, env: NodeJS.ProcessEnv = process.env): Promise<ToolRunner> {
  if (paypal.mode === "sandbox" && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    const tk = await loadToolkit(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET);
    return {
      kind: "agent-toolkit",
      tools: tk.getTools().map(toSpec),
      run: async (call) => {
        const res = await tk.handleToolCall(call);
        return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      },
    };
  }
  // Mock: reuse the toolkit's tool schemas (constructed offline with placeholder credentials, never called).
  const tk = await loadToolkit("mock-client-id", "mock-client-secret");
  return { kind: "agent-toolkit-schemas+mock", tools: tk.getTools().map(toSpec), run: (call) => runOnGateway(paypal, call) };
}

/** Gemini's OpenAI-compatible endpoint accepts only a JSON-schema subset; strip what it rejects. */
export function sanitizeSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(sanitizeSchema);
  if (!s || typeof s !== "object") return s;
  const o = s as Record<string, unknown>;
  if (Array.isArray(o.anyOf)) {
    const branches = (o.anyOf as Record<string, unknown>[]).filter((b) => b && b.type !== "null" && !("not" in b));
    const first = branches.length === 1 ? sanitizeSchema(branches[0]) : sanitizeSchema(branches[0] ?? { type: "string" });
    return { ...(first as object), ...(o.description ? { description: o.description } : {}) };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "$schema" || k === "additionalProperties" || k === "default" || k === "pattern") continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, sanitizeSchema(pv)])) : sanitizeSchema(v);
  }
  return out;
}

function toSpec(t: ReturnType<ToolkitLike["getTools"]>[number]): ToolSpec {
  return { type: "function", function: { name: t.function.name, description: (t.function.description ?? "").trim().slice(0, 1000), parameters: sanitizeSchema(t.function.parameters ?? { type: "object", properties: {} }) as Record<string, unknown> } };
}

async function runOnGateway(paypal: PayPalGateway, call: ToolCall): Promise<string> {
  const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  const str = (k: string) => (typeof args[k] === "string" && args[k] ? (args[k] as string) : undefined);
  switch (call.function.name) {
    case "list_disputes":
      return JSON.stringify(await paypal.listDisputes({ dispute_state: str("dispute_state") as never, disputed_transaction_id: str("disputed_transaction_id"), page_size: Number(args.page_size) || 10 }));
    case "get_dispute":
      return JSON.stringify(await paypal.getDispute(String(args.dispute_id)));
    case "get_order":
      return JSON.stringify(await paypal.getOrder(String(args.id)));
    case "get_shipment_tracking": {
      const tx = str("transaction_id");
      if (!tx) return JSON.stringify({ error: "transaction_id is required in this build" });
      return JSON.stringify(await paypal.listTrackers(tx));
    }
    case "list_transactions": {
      const tx = str("transaction_id");
      if (!tx) return JSON.stringify({ error: "transaction_id is required in this build" });
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 86_400_000);
      return JSON.stringify(await paypal.searchTransactions({ transaction_id: tx, start_date: str("start_date") ?? start.toISOString(), end_date: str("end_date") ?? end.toISOString() }));
    }
    default:
      return JSON.stringify({ error: `tool ${call.function.name} is not available` });
  }
}

const SYSTEM = `You are DisputeDesk's research assistant for a PayPal seller. Use the PayPal tools to look up disputes,
orders, transactions and shipment tracking, then answer briefly and concretely (amounts, ids, dates).
You can only read data. If the seller asks you to refund, accept or submit evidence, tell them to use the
buttons on the dispute card, which require their confirmation.
If the seller does not give an id, find it in the case index below (or call list_disputes), then call the tools for details.`;

export interface AskResult {
  answer: string;
  toolCalls: { name: string; args: string }[];
  provider: string | null;
}

export async function ask(llm: Llm, runner: ToolRunner, question: string, caseIndex = "", maxSteps = 6): Promise<AskResult> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: caseIndex ? `${SYSTEM}\n\nCase index (id | amount | reason | status | buyer | item | seller transaction id):\n${caseIndex.slice(0, 6000)}` : SYSTEM,
    },
    { role: "user", content: question.slice(0, 1000) },
  ];
  const log: AskResult["toolCalls"] = [];
  let provider: string | null = null;
  for (let step = 0; step < maxSteps; step++) {
    const r = await llm.chat(messages, runner.tools);
    provider = `${r.provider}:${r.model}`;
    if (!r.toolCalls.length) return { answer: r.content ?? "", toolCalls: log, provider };
    messages.push({ role: "assistant", content: r.content, tool_calls: r.toolCalls });
    for (const call of r.toolCalls) {
      log.push({ name: call.function.name, args: call.function.arguments });
      let content: string;
      try {
        content = (await runner.run(call)).slice(0, 12_000);
      } catch (e) {
        content = JSON.stringify({ error: (e as Error).message });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  return { answer: "Stopped after the maximum number of tool steps; try a narrower question.", toolCalls: log, provider };
}
