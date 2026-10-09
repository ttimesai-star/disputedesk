import { test } from "node:test";
import assert from "node:assert/strict";
import { MockPayPalClient } from "../src/paypal/mock.ts";
import { buildMockStore, disputeIdFor } from "../src/paypal/fixtures.ts";
import { DisputePipeline } from "../src/agent/pipeline.ts";
import { AuditLog } from "../src/agent/audit.ts";
import { DEFAULT_SETTINGS, PolicyStore, matchPolicy, runAutopilot, validateSettings } from "../src/agent/policies.ts";
import { parseQueryByRules, translateQuery, validateQuery } from "../src/agent/nlquery.ts";
import type { ChatResult, Llm } from "../src/agent/llm.ts";

const NOW = new Date("2026-10-10T12:00:00Z");

function setup(settings = { ...structuredClone(DEFAULT_SETTINGS), autopilot: true }) {
  const paypal = new MockPayPalClient(buildMockStore(NOW));
  const pipeline = new DisputePipeline(paypal, { llm: null, now: NOW });
  const audit = new AuditLog(null);
  const policies = new PolicyStore(null);
  policies.set(settings);
  return { paypal, pipeline, audit, policies };
}

test("policy validation rejects malformed or dangerous settings", () => {
  assert.throws(() => validateSettings({ autopilot: "yes", dailyAutoAcceptLimit: 10, policies: [] }), /autopilot/);
  assert.throws(() => validateSettings({ autopilot: true, dailyAutoAcceptLimit: -1, policies: [] }), /dailyAutoAcceptLimit/);
  const p = DEFAULT_SETTINGS.policies[0]!;
  assert.throws(() => validateSettings({ autopilot: true, dailyAutoAcceptLimit: 10, policies: [{ ...p, maxWinProbability: 2 }] }), /maxWinProbability/);
  assert.throws(() => validateSettings({ autopilot: true, dailyAutoAcceptLimit: 10, policies: [{ ...p, action: "REFUND_EVERYTHING" }] }), /action/);
  assert.throws(() => validateSettings({ autopilot: true, dailyAutoAcceptLimit: 10, policies: [{ ...p, reasons: ["NOPE"] }] }), /unknown reason/);
  assert.throws(() => validateSettings({ autopilot: true, dailyAutoAcceptLimit: 10, policies: [p, p] }), /unique/);
  // dryRun defaults to true when omitted: never act for real by accident
  const { dryRun: _omit, ...rest } = p;
  assert.equal(validateSettings({ autopilot: true, dailyAutoAcceptLimit: 10, policies: [rest] }).policies[0]!.dryRun, true);
});

test("autopilot off does nothing", async () => {
  const deps = setup({ ...structuredClone(DEFAULT_SETTINGS), autopilot: false });
  const r = await runAutopilot(deps);
  assert.equal(r.acted, 0);
  assert.equal((await deps.paypal.getDispute(disputeIdFor(8))).status, "WAITING_FOR_SELLER_RESPONSE");
});

test("autopilot refunds the small not-as-described claim, dry-runs duplicates, messages in-transit buyers, never touches FIGHT cases", async () => {
  const deps = setup();
  await runAutopilot(deps);
  assert.equal((await deps.paypal.getDispute(disputeIdFor(8))).status, "RESOLVED", "12 USD SNAD accepted");
  assert.equal((await deps.paypal.getDispute(disputeIdFor(6))).status, "WAITING_FOR_SELLER_RESPONSE", "duplicate policy is dry-run");
  assert.ok(deps.audit.list().some((e) => e.disputeId === disputeIdFor(6) && e.outcome === "dry-run"));
  const transit = await deps.paypal.getDispute(disputeIdFor(7));
  assert.equal(transit.messages!.at(-1)!.posted_by, "SELLER");
  assert.equal((await deps.paypal.getDispute(disputeIdFor(1))).status, "WAITING_FOR_SELLER_RESPONSE", "FIGHT case untouched");
  // A second run must not message the same buyer again.
  const before = transit.messages!.length;
  await runAutopilot(deps);
  assert.equal((await deps.paypal.getDispute(disputeIdFor(7))).messages!.length, before);
});

test("daily auto-refund cap blocks further automatic refunds", async () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.autopilot = true;
  s.dailyAutoAcceptLimit = 10; // smaller than the 12 USD claim
  const deps = setup(s);
  await runAutopilot(deps);
  assert.equal((await deps.paypal.getDispute(disputeIdFor(8))).status, "WAITING_FOR_SELLER_RESPONSE");
  assert.ok(deps.audit.list().some((e) => e.outcome === "skipped" && /cap/.test(e.detail)));
});

test("matchPolicy requires the analysis to agree with the policy action", async () => {
  const deps = setup();
  const s = deps.policies.get();
  s.policies = [{ id: "all", name: "accept anything", enabled: true, maxAmount: 10_000, reasons: [], maxWinProbability: 1, action: "ACCEPT", dryRun: false }];
  const view = await deps.pipeline.analyze(disputeIdFor(1)); // FIGHT recommendation
  assert.equal(matchPolicy(view, s), null);
});

test("rule query parser covers common seller phrasings", () => {
  const a = parseQueryByRules("not received over $100 due this week");
  assert.deepEqual(a.filterModel.amount, { filterType: "number", type: "greaterThan", filter: 100 });
  assert.deepEqual(a.filterModel.dueInDays, { filterType: "number", type: "lessThanOrEqual", filter: 7 });
  assert.deepEqual(a.filterModel.reason, { filterType: "text", type: "equals", filter: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" });
  const b = parseQueryByRules("chargebacks I should fight, biggest first");
  assert.deepEqual(b.filterModel.stage, { filterType: "text", type: "equals", filter: "CHARGEBACK" });
  assert.deepEqual(b.filterModel.recommendation, { filterType: "text", type: "equals", filter: "FIGHT" });
  assert.deepEqual(b.sort, { colId: "amount", sort: "desc" });
  const c = parseQueryByRules("win chance below 30%");
  assert.deepEqual(c.filterModel.winScore, { filterType: "number", type: "lessThan", filter: 30 });
  assert.equal(c.filterModel.amount, undefined);
  const d = parseQueryByRules("duplicate or subscription between $5 and $50");
  assert.deepEqual(d.filterModel.amount, { filterType: "number", type: "inRange", filter: 5, filterTo: 50 });
  assert.equal((d.filterModel.reason as { operator: string }).operator, "OR");
});

test("LLM query output is validated: unknown columns and operators are rejected", () => {
  assert.throws(() => validateQuery({ filterModel: { password: { filterType: "text", type: "equals", filter: "x" } } }), /unknown column/);
  assert.throws(() => validateQuery({ filterModel: { amount: { filterType: "number", type: "regex", filter: 1 } } }), /bad number filter/);
  const ok = validateQuery({ filterModel: { reason: { filterType: "text", type: "equals", filter: "not as described" } }, sort: { colId: "amount", sort: "desc" } });
  assert.deepEqual(ok.filterModel.reason, { filterType: "text", type: "equals", filter: "not as described" });
  const enumNorm = validateQuery({ filterModel: { recommendation: { filterType: "text", type: "equals", filter: "message buyer" } } });
  assert.deepEqual(enumNorm.filterModel.recommendation, { filterType: "text", type: "equals", filter: "MESSAGE_BUYER" });
});

test("translateQuery uses the LLM when valid and falls back to rules otherwise", async () => {
  const good: Llm = { chat: async (): Promise<ChatResult> => ({ content: JSON.stringify({ filterModel: { amount: { filterType: "number", type: "greaterThan", filter: 50 } }, sort: null, explanation: "Over 50" }), toolCalls: [], provider: "f", model: "m" }) };
  const bad: Llm = { chat: async (): Promise<ChatResult> => ({ content: JSON.stringify({ filterModel: { nope: {} } }), toolCalls: [], provider: "f", model: "m" }) };
  assert.equal((await translateQuery("big ones", good)).source, "llm");
  const fb = await translateQuery("over $50", bad);
  assert.equal(fb.source, "rules");
  assert.deepEqual(fb.filterModel.amount, { filterType: "number", type: "greaterThan", filter: 50 });
});
