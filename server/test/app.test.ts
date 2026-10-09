import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { MockPayPalClient, signMockWebhook } from "../src/paypal/mock.ts";
import { disputeIdFor } from "../src/paypal/fixtures.ts";
import { createToolRunner, ask, sanitizeSchema } from "../src/agent/assistant.ts";
import type { ChatResult, Llm, ToolCall } from "../src/agent/llm.ts";
import type { AuditEntry, DisputeRow } from "../src/shared.ts";

async function start(llm: Llm | null = null) {
  const paypal = new MockPayPalClient();
  const app = createApp({ paypal, llm, llmNames: [], tools: null, dataDir: null });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return { app, paypal, call, close: () => new Promise((r) => app.server.close(r)) };
}

test("GET /api/disputes returns a row per dispute with a rule-based score", async () => {
  const s = await start();
  try {
    const r = await s.call("GET", "/api/disputes");
    assert.equal(r.status, 200);
    const rows = r.body as DisputeRow[];
    assert.equal(rows.length, 12);
    const one = rows.find((x) => x.disputeId === disputeIdFor(1))!;
    assert.equal(one.recommendation, "FIGHT");
    assert.equal(one.assessedBy, "rules");
    assert.ok(one.winScore! >= 80);
    assert.equal(one.buyer, "Emily Carter");
  } finally {
    await s.close();
  }
});

test("serveStatic handles malformed percent-encoded URIs gracefully and accept claim validates accept_claim_type", async () => {
  const paypal = new MockPayPalClient();
  const app = createApp({ paypal, llm: null, llmNames: [], tools: null, dataDir: null, staticDir: process.cwd() });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/%ff`);
    assert.equal(res.status, 400);
    const id = disputeIdFor(1);
    const badTypeRes = await fetch(`${base}/api/disputes/${id}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "Accepted", accept_claim_type: "INVALID_TYPE" }) });
    assert.equal(badTypeRes.status, 400);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test("seller actions go to PayPal and the journal; bad input is rejected", async () => {
  const s = await start();
  try {
    const id = disputeIdFor(1);
    assert.equal((await s.call("POST", `/api/disputes/${id}/evidence`, { evidences: [] })).status, 400);
    assert.equal((await s.call("POST", `/api/disputes/${id}/accept`, { note: "" })).status, 400);
    const ev = await s.call("POST", `/api/disputes/${id}/evidence`, { evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", notes: "Delivered" }] });
    assert.equal(ev.status, 200);
    assert.equal(ev.body.dispute.status, "UNDER_REVIEW");
    // PayPal state rule: no second evidence submission once under review
    const again = await s.call("POST", `/api/disputes/${id}/evidence`, { evidences: [{ evidence_type: "OTHER", notes: "x" }] });
    assert.equal(again.status, 422);
    const msg = await s.call("POST", `/api/disputes/${disputeIdFor(7)}/message`, { message: "Tracking: 9400111899561234567890" });
    assert.equal(msg.status, 200);
    const audit = (await s.call("GET", "/api/audit")).body as AuditEntry[];
    assert.deepEqual(audit.slice(0, 3).map((e) => [e.action, e.outcome]), [["send-message", "ok"], ["provide-evidence", "error"], ["provide-evidence", "ok"]]);
  } finally {
    await s.close();
  }
});

test("simulated CUSTOMER.DISPUTE.CREATED webhook is verified, analyzed and handled by policy", async () => {
  const s = await start();
  try {
    const settings = (await s.call("GET", "/api/policies")).body;
    settings.autopilot = true;
    assert.equal((await s.call("PUT", "/api/policies", settings)).status, 200);
    const r = await s.call("POST", "/api/demo/simulate-dispute");
    assert.equal(r.status, 200);
    await s.app.idle();
    const id = r.body.dispute_id as string;
    assert.equal((await s.paypal.getDispute(id)).status, "RESOLVED", "small not-as-described claim auto-accepted");
    const audit = (await s.call("GET", "/api/audit")).body as AuditEntry[];
    const forId = audit.filter((e) => e.disputeId === id).map((e) => `${e.actor}:${e.action}:${e.outcome}`);
    assert.deepEqual(forId.reverse(), ["webhook:CUSTOMER.DISPUTE.CREATED:ok", "agent:analyze:ok", "agent:accept-claim:ok"]);
  } finally {
    await s.close();
  }
});

test("a redelivered webhook event is acknowledged but processed only once", async () => {
  const s = await start();
  try {
    const event = { id: "WH-DUP-1", create_time: new Date().toISOString(), resource_type: "dispute", event_type: "CUSTOMER.DISPUTE.UPDATED", resource: { dispute_id: disputeIdFor(1) } };
    const body = JSON.stringify(event);
    const time = new Date().toISOString();
    const headers = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/x", "paypal-transmission-id": "t-dup", "paypal-transmission-time": time, "paypal-transmission-sig": signMockWebhook("t-dup", time, "WH-MOCK-DISPUTEDESK", body) };
    const first = await s.call("POST", "/api/webhooks/paypal", body, headers);
    const second = await s.call("POST", "/api/webhooks/paypal", body, headers);
    await s.app.idle();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    const analyses = ((await s.call("GET", "/api/audit")).body as AuditEntry[]).filter((e) => e.action === "analyze" && e.disputeId === disputeIdFor(1));
    assert.equal(analyses.length, 1);
  } finally {
    await s.close();
  }
});

test("webhook with a forged signature is rejected with 401", async () => {
  const s = await start();
  try {
    const event = { id: "WH-1", create_time: "", resource_type: "dispute", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: disputeIdFor(1) } };
    const headers = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/x", "paypal-transmission-id": "t", "paypal-transmission-time": new Date().toISOString(), "paypal-transmission-sig": "forged" };
    assert.equal((await s.call("POST", "/api/webhooks/paypal", event, headers)).status, 401);
    assert.equal((await s.call("POST", "/api/webhooks/paypal", event)).status, 400, "missing headers");
  } finally {
    await s.close();
  }
});

test("invalid policies are refused with 400", async () => {
  const s = await start();
  try {
    assert.equal((await s.call("PUT", "/api/policies", { autopilot: true, dailyAutoAcceptLimit: 1e9, policies: [] })).status, 400);
  } finally {
    await s.close();
  }
});

test("Ask uses PayPal Agent Toolkit tool schemas; in mock mode calls run on the mock gateway", async () => {
  const paypal = new MockPayPalClient();
  const runner = await createToolRunner(paypal, {});
  assert.equal(runner.kind, "agent-toolkit-schemas+mock");
  const names = runner.tools.map((t) => t.function.name).sort();
  assert.deepEqual(names, ["get_dispute", "get_order", "get_shipment_tracking", "list_disputes", "list_transactions"]);
  assert.ok(!JSON.stringify(runner.tools).includes("$schema"), "schemas sanitized for Gemini");
  let step = 0;
  const llm: Llm = {
    async chat(): Promise<ChatResult> {
      step++;
      if (step === 1) {
        const call: ToolCall = { id: "c1", type: "function", function: { name: "get_dispute", arguments: JSON.stringify({ dispute_id: disputeIdFor(1) }) } };
        return { content: null, toolCalls: [call], provider: "f", model: "m" };
      }
      return { content: "Dispute is for 129.00 USD.", toolCalls: [], provider: "f", model: "m" };
    },
  };
  const r = await ask(llm, runner, "How much is the plates dispute?");
  assert.equal(r.answer, "Dispute is for 129.00 USD.");
  assert.deepEqual(r.toolCalls.map((t) => t.name), ["get_dispute"]);
});

test("sanitizeSchema collapses nullable anyOf and drops unsupported keys", () => {
  const out = sanitizeSchema({ $schema: "x", type: "object", additionalProperties: false, properties: { a: { anyOf: [{ type: "string", pattern: "^x$" }, { type: "null" }], default: null, description: "d" } } });
  assert.deepEqual(out, { type: "object", properties: { a: { type: "string", description: "d" } } });
});
