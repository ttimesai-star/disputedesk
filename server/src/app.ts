import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PayPalApiError, type PayPalGateway } from "./paypal/client.ts";
import { MockPayPalClient, signMockWebhook } from "./paypal/mock.ts";
import { cachedCertFetcher, readWebhookHeaders, verifyWebhookOffline } from "./paypal/webhook.ts";
import type { AcceptClaimType, Dispute, Evidence, WebhookEvent } from "./paypal/types.ts";
import { ask, type ToolRunner } from "./agent/assistant.ts";
import { AuditLog } from "./agent/audit.ts";
import type { Llm } from "./agent/llm.ts";
import { translateQuery } from "./agent/nlquery.ts";
import { DisputePipeline } from "./agent/pipeline.ts";
import { PolicyStore, runAutopilot } from "./agent/policies.ts";
import { buildRows, mapLimit } from "./agent/rows.ts";
import type { HealthInfo } from "./shared.ts";

export interface AppDeps {
  paypal: PayPalGateway;
  llm: Llm | null;
  llmNames: string[];
  tools: ToolRunner | null;
  dataDir: string | null;
  staticDir?: string;
  webhookId?: string;
  /** "api" (POST verify-webhook-signature) or "offline" (cert + CRC32). Sandbox only. */
  webhookVerify?: "api" | "offline";
}

export interface App {
  server: Server;
  pipeline: DisputePipeline;
  audit: AuditLog;
  policies: PolicyStore;
  /** Resolves when background webhook processing is idle (tests). */
  idle(): Promise<void>;
}

const MAX_BODY = 1_000_000;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
const MOCK_WEBHOOK_ID = "WH-MOCK-DISPUTEDESK";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApp(deps: AppDeps): App {
  const audit = new AuditLog(deps.dataDir);
  const policies = new PolicyStore(deps.dataDir);
  const pipeline = new DisputePipeline(deps.paypal, { llm: deps.llm });
  const pending = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    pending.add(p);
    p.finally(() => pending.delete(p)).catch(() => undefined);
  };

  async function handleWebhook(raw: Buffer, header: (n: string) => string | undefined): Promise<{ status: number; body: unknown }> {
    const h = readWebhookHeaders(header);
    if (!h) return { status: 400, body: { error: "missing PayPal transmission headers" } };
    let event: WebhookEvent<Dispute>;
    try {
      event = JSON.parse(raw.toString("utf8")) as WebhookEvent<Dispute>;
    } catch {
      return { status: 400, body: { error: "invalid JSON" } };
    }
    const webhookId = deps.paypal.mode === "mock" ? MOCK_WEBHOOK_ID : deps.webhookId;
    if (!webhookId) return { status: 500, body: { error: "PAYPAL_WEBHOOK_ID is not configured" } };
    const ok =
      deps.paypal.mode === "sandbox" && deps.webhookVerify === "offline"
        ? await verifyWebhookOffline(h, webhookId, raw, { fetchCert: certFetcher })
        : await deps.paypal.verifyWebhookSignature(h, webhookId, event);
    if (!ok) {
      audit.record({ actor: "webhook", action: event.event_type ?? "unknown", disputeId: null, outcome: "error", detail: "Signature verification failed; event ignored" });
      return { status: 401, body: { error: "signature verification failed" } };
    }
    const disputeId = event.resource?.dispute_id ?? null;
    audit.record({ actor: "webhook", action: event.event_type, disputeId, outcome: "ok", detail: event.summary ?? "verified" });
    if (disputeId && event.event_type.startsWith("CUSTOMER.DISPUTE.")) {
      pipeline.invalidate(disputeId);
      // Acknowledge fast (PayPal retries on timeouts), analyze and run policies in the background.
      track(
        (async () => {
          if (event.event_type === "CUSTOMER.DISPUTE.RESOLVED") return;
          const view = await pipeline.analyze(disputeId);
          const a = view.assessment;
          audit.record({ actor: "agent", action: "analyze", disputeId, outcome: "ok", detail: `${a?.recommendation} (${Math.round((a?.winProbability ?? 0) * 100)}% win, ${a?.source})` });
          await runAutopilot({ paypal: deps.paypal, pipeline, policies, audit }, [disputeId]);
        })().catch((e) => audit.record({ actor: "agent", action: "analyze", disputeId, outcome: "error", detail: (e as Error).message })),
      );
    }
    return { status: 200, body: { received: true } };
  }
  const certFetcher = cachedCertFetcher();

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const m = req.method ?? "GET";
    const p = url.pathname;
    const disputeMatch = p.match(/^\/api\/disputes\/([A-Za-z0-9-]+)(?:\/(analyze|evidence|accept|message))?$/);

    if (m === "GET" && p === "/api/health") {
      const info: HealthInfo = { ok: true, paypal: deps.paypal.mode, llm: deps.llmNames, toolkit: !!deps.tools };
      return json(res, 200, info);
    }
    if (m === "GET" && p === "/api/disputes") return json(res, 200, await buildRows(deps.paypal, pipeline));
    if (m === "POST" && p === "/api/disputes/analyze-all") {
      const list = await deps.paypal.listDisputes({ dispute_state: "REQUIRED_ACTION", page_size: 50 });
      const views = await mapLimit(list.items, 2, (s) => pipeline.analyze(s.dispute_id));
      audit.record({ actor: "agent", action: "analyze-all", disputeId: null, outcome: "ok", detail: `${views.length} disputes analyzed (${views.filter((v) => v.assessment?.source === "llm").length} by LLM)` });
      return json(res, 200, { analyzed: views.length });
    }
    if (disputeMatch) {
      const id = disputeMatch[1]!;
      const action = disputeMatch[2];
      if (m === "GET" && !action) {
        const cached = pipeline.cached(id);
        return json(res, 200, cached ?? (await pipeline.analyze(id, { useLlm: false })));
      }
      if (m === "POST" && action === "analyze") {
        const view = await pipeline.analyze(id, { force: true });
        audit.record({ actor: "agent", action: "analyze", disputeId: id, outcome: view.assessment?.llmError ? "error" : "ok", detail: view.assessment?.llmError ? `LLM failed, rule-based draft used: ${view.assessment.llmError}` : `${view.assessment?.recommendation} (${Math.round((view.assessment?.winProbability ?? 0) * 100)}% win, ${view.assessment?.source})` });
        return json(res, 200, view);
      }
      if (m === "POST" && action === "evidence") {
        const body = (await readJson(req)) as { evidences?: Evidence[] };
        const evidences = validateEvidence(body.evidences);
        const d = await deps.paypal.getDispute(id);
        await act(id, "provide-evidence", d.dispute_amount, () => deps.paypal.provideEvidence(id, { evidences }), `${evidences.length} evidence item(s): ${evidences.map((e) => e.evidence_type).join(", ")}`);
        return json(res, 200, await pipeline.analyze(id, { useLlm: false, force: true }));
      }
      if (m === "POST" && action === "accept") {
        const body = (await readJson(req)) as { note?: string; accept_claim_type?: AcceptClaimType };
        const note = String(body.note ?? "").trim();
        if (!note) throw new HttpError(400, "note is required");
        const d = await deps.paypal.getDispute(id);
        await act(id, "accept-claim", d.dispute_amount, () => deps.paypal.acceptClaim(id, { note: note.slice(0, 2000), ...(body.accept_claim_type ? { accept_claim_type: body.accept_claim_type } : {}) }), note.slice(0, 160));
        return json(res, 200, await pipeline.analyze(id, { useLlm: false, force: true }));
      }
      if (m === "POST" && action === "message") {
        const body = (await readJson(req)) as { message?: string };
        const message = String(body.message ?? "").trim();
        if (!message) throw new HttpError(400, "message is required");
        await act(id, "send-message", undefined, () => deps.paypal.sendMessage(id, message.slice(0, 2000)), message.slice(0, 160));
        return json(res, 200, await pipeline.analyze(id, { useLlm: false, force: true }));
      }
    }
    if (p === "/api/policies") {
      if (m === "GET") return json(res, 200, policies.get());
      if (m === "PUT") {
        const next = await readJson(req);
        let saved;
        try {
          saved = policies.set(next);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        audit.record({ actor: "seller", action: "update-policies", disputeId: null, outcome: "ok", detail: `autopilot ${saved.autopilot ? "on" : "off"}, ${saved.policies.filter((x) => x.enabled).length} active policies, cap ${saved.dailyAutoAcceptLimit}` });
        return json(res, 200, saved);
      }
    }
    if (m === "POST" && p === "/api/policies/run") return json(res, 200, await runAutopilot({ paypal: deps.paypal, pipeline, policies, audit }));
    if (m === "GET" && p === "/api/audit") return json(res, 200, audit.list());
    if (m === "POST" && p === "/api/query") {
      const body = (await readJson(req)) as { q?: string };
      if (!body.q?.trim()) throw new HttpError(400, "q is required");
      return json(res, 200, await translateQuery(body.q, deps.llm));
    }
    if (m === "POST" && p === "/api/ask") {
      if (!deps.llm || !deps.tools) throw new HttpError(503, "Ask needs an LLM key (GEMINI_API_KEY or GROQ_API_KEY)");
      const body = (await readJson(req)) as { q?: string };
      if (!body.q?.trim()) throw new HttpError(400, "q is required");
      const rows = await buildRows(deps.paypal, pipeline);
      const index = rows.map((x) => [x.disputeId, `${x.amount} ${x.currency}`, x.reason, x.status, x.buyer, x.item, x.sellerTransactionId ?? ""].join(" | ")).join("\n");
      const r = await ask(deps.llm, deps.tools, body.q, index);
      audit.record({ actor: "agent", action: "ask", disputeId: null, outcome: "ok", detail: `${body.q.slice(0, 80)} -> ${r.toolCalls.map((t) => t.name).join(", ") || "no tools"}` });
      return json(res, 200, r);
    }
    if (m === "POST" && p === "/api/webhooks/paypal") {
      const raw = await readBody(req);
      const r = await handleWebhook(raw, (n) => headerValue(req, n));
      return json(res, r.status, r.body);
    }
    if (m === "POST" && p === "/api/demo/simulate-dispute") {
      if (!(deps.paypal instanceof MockPayPalClient)) throw new HttpError(400, "Simulation is only available in mock mode; use the sandbox Webhooks Simulator instead");
      const event = simulateDisputeEvent(deps.paypal);
      const raw = Buffer.from(JSON.stringify(event));
      const tid = randomUUID();
      const time = new Date().toISOString();
      const headers: Record<string, string> = {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-MOCK",
        "paypal-transmission-id": tid,
        "paypal-transmission-time": time,
        "paypal-transmission-sig": signMockWebhook(tid, time, MOCK_WEBHOOK_ID, raw.toString("utf8")),
      };
      const r = await handleWebhook(raw, (n) => headers[n]);
      return json(res, r.status, { ...(r.body as object), dispute_id: event.resource.dispute_id });
    }
    if (p.startsWith("/api/")) throw new HttpError(404, "not found");
    if (m === "GET" || m === "HEAD") return serveStatic(res, p, deps.staticDir);
    throw new HttpError(405, "method not allowed");
  }

  async function act(id: string, action: string, amount: Dispute["dispute_amount"] | undefined, fn: () => Promise<void>, detail: string): Promise<void> {
    try {
      await fn();
      pipeline.invalidate(id);
      audit.record({ actor: "seller", action, disputeId: id, outcome: "ok", detail, amount });
    } catch (e) {
      audit.record({ actor: "seller", action, disputeId: id, outcome: "error", detail: (e as Error).message, amount });
      throw e;
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    route(req, res, url).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : e instanceof PayPalApiError ? (e.status >= 400 && e.status < 500 ? e.status : 502) : 500;
      if (status >= 500) console.error(e);
      if (!res.headersSent) json(res, status, { error: e instanceof Error ? e.message : "internal error" });
    });
  });

  return {
    server,
    pipeline,
    audit,
    policies,
    idle: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

function validateEvidence(v: unknown): Evidence[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 10) throw new HttpError(400, "evidences must be a non-empty array (max 10)");
  return v.map((e, i) => {
    const o = e as Record<string, unknown>;
    if (typeof o.evidence_type !== "string" || !/^[A-Z_]{3,60}$/.test(o.evidence_type)) throw new HttpError(400, `evidences[${i}].evidence_type is invalid`);
    const out: Evidence = { evidence_type: o.evidence_type };
    if (typeof o.notes === "string" && o.notes.trim()) out.notes = o.notes.trim().slice(0, 2000);
    if (o.evidence_info && typeof o.evidence_info === "object") out.evidence_info = o.evidence_info as Evidence["evidence_info"];
    return out;
  });
}

let simulated = 0;
function simulateDisputeEvent(paypal: MockPayPalClient): WebhookEvent<Dispute> {
  // Clone a template dispute with a fresh id, as PayPal would deliver a brand-new case.
  const template = [...paypal.store.disputes.values()].find((d) => d.reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" && Number(d.dispute_amount.value) <= 15) ?? [...paypal.store.disputes.values()][0]!;
  simulated++;
  const now = new Date();
  const d: Dispute = structuredClone(template);
  d.dispute_id = `PP-D-${90000 + simulated}`;
  d.create_time = now.toISOString();
  d.update_time = now.toISOString();
  d.status = "WAITING_FOR_SELLER_RESPONSE";
  d.dispute_state = "REQUIRED_ACTION";
  d.dispute_outcome = undefined;
  d.seller_response_due_date = new Date(now.getTime() + 10 * 86_400_000).toISOString();
  d.messages = [{ posted_by: "BUYER", time_posted: now.toISOString(), content: "The glaze is chipped on one side." }];
  d.evidences = [];
  paypal.ingestDispute(d);
  return { id: `WH-${randomUUID()}`, create_time: now.toISOString(), resource_type: "dispute", event_type: "CUSTOMER.DISPUTE.CREATED", summary: `A new dispute opened with Case # ${d.dispute_id}`, resource: d, event_version: "1.0", resource_version: "1.0" };
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

function serveStatic(res: ServerResponse, pathname: string, dir?: string): void {
  if (!dir || !existsSync(dir)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Web app not built. Run `npm run build`, or use `npm run dev:web` during development.");
    return;
  }
  const root = resolve(dir);
  let file = resolve(join(root, normalize(decodeURIComponent(pathname))));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff" });
  createReadStream(file).pipe(res);
}
