import { test } from "node:test";
import assert from "node:assert/strict";
import { MockPayPalClient } from "../src/paypal/mock.ts";
import { buildMockStore, disputeIdFor } from "../src/paypal/fixtures.ts";
import { buildCaseFile } from "../src/agent/casefile.ts";
import { assessByRules } from "../src/agent/rules.ts";
import { DisputePipeline, inventsIdentifiers, refineWithLlm } from "../src/agent/pipeline.ts";
import type { ChatResult, Llm } from "../src/agent/llm.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const mock = () => new MockPayPalClient(buildMockStore(NOW));

function fakeLlm(reply: string | Error): Llm & { calls: number } {
  return {
    calls: 0,
    async chat(): Promise<ChatResult> {
      this.calls++;
      if (reply instanceof Error) throw reply;
      return { content: reply, toolCalls: [], provider: "fake", model: "test" };
    },
  };
}

test("case file joins dispute, transaction search, order and tracking into a sorted timeline", async () => {
  const file = await buildCaseFile(mock(), disputeIdFor(1), NOW);
  assert.deepEqual(file.dataGaps, []);
  assert.equal(file.facts.delivered, true);
  assert.equal(file.facts.addressConfirmed, true);
  assert.equal(file.facts.carrier, "USPS");
  assert.equal(file.facts.daysToDue, 6);
  assert.ok(file.order, "order linked through custom_id");
  const kinds = file.timeline.map((t) => t.kind);
  for (const k of ["order", "payment", "shipment", "delivery", "dispute", "message", "deadline"]) assert.ok(kinds.includes(k as never), `timeline has ${k}`);
  const times = file.timeline.map((t) => t.at);
  assert.deepEqual(times, [...times].sort());
});

test("refunds issued after the first 30 days are still found (multi-window transaction search)", async () => {
  const file = await buildCaseFile(mock(), disputeIdFor(5), NOW);
  assert.equal(file.facts.refundIds.length, 1);
  assert.ok(file.timeline.some((t) => t.kind === "refund"));
});

test("rules: delivered INR with tracking -> FIGHT with tracking evidence from PayPal data", async () => {
  const file = await buildCaseFile(mock(), disputeIdFor(1), NOW);
  const a = assessByRules(file.facts, { now: NOW });
  assert.equal(a.recommendation, "FIGHT");
  assert.ok(a.winProbability >= 0.8);
  assert.equal(a.evidence[0]!.evidence_type, "PROOF_OF_FULFILLMENT");
  assert.equal(a.evidence[0]!.evidence_info?.tracking_info?.[0]?.tracking_number, "9405511899223197428490");
});

test("rules: INR without tracking -> ACCEPT; in-transit inquiry -> MESSAGE_BUYER; refund issued -> PROOF_OF_REFUND", async () => {
  const p = mock();
  const noTracking = assessByRules((await buildCaseFile(p, disputeIdFor(2), NOW)).facts);
  assert.equal(noTracking.recommendation, "ACCEPT");
  assert.ok(noTracking.riskFlags.includes("No proof of shipment"));
  const transit = assessByRules((await buildCaseFile(p, disputeIdFor(7), NOW)).facts);
  assert.equal(transit.recommendation, "MESSAGE_BUYER");
  assert.match(transit.buyerMessage, /9400111899561234567890/);
  const refunded = assessByRules((await buildCaseFile(p, disputeIdFor(5), NOW)).facts);
  assert.equal(refunded.recommendation, "FIGHT");
  assert.equal(refunded.evidence[0]!.evidence_type, "PROOF_OF_REFUND");
});

test("rules: cases waiting on PayPal or closed get WAIT", async () => {
  const p = mock();
  assert.equal(assessByRules((await buildCaseFile(p, disputeIdFor(4), NOW)).facts).recommendation, "WAIT");
  assert.equal(assessByRules((await buildCaseFile(p, disputeIdFor(12), NOW)).facts).recommendation, "WAIT");
});

test("LLM refinement is accepted when valid, and its probability is clamped to +-0.25 of the rules", async () => {
  const file = await buildCaseFile(mock(), disputeIdFor(3), NOW);
  const base = assessByRules(file.facts, { now: NOW });
  const llm = fakeLlm(
    "```json\n" +
      JSON.stringify({
        recommendation: "FIGHT",
        win_probability: 0.99,
        rationale: ["Listing discloses that glaze color varies."],
        risk_flags: ["Buyer may escalate"],
        evidence_notes: { ITEM_DESCRIPTION: "The listing states each piece is unique and color varies from the photo." },
        buyer_message: "Thanks for your message. As noted in the listing, each glaze is unique.",
        accept_note: "Accepting with return.",
      }) +
      "\n```",
  );
  const a = await refineWithLlm(llm, file, base);
  assert.equal(a.source, "llm");
  assert.equal(a.model, "fake:test");
  assert.equal(a.winProbability, Math.round((base.winProbability + 0.25) * 100) / 100);
  assert.match(a.evidence[0]!.notes!, /color varies/);
  assert.ok(a.riskFlags.includes("Buyer may escalate"));
  assert.ok(a.expected.fight > base.expected.fight, "higher odds improve the fight outcome");
});

test("LLM text that invents a tracking number is discarded in favour of the rule-based draft", async () => {
  const file = await buildCaseFile(mock(), disputeIdFor(1), NOW);
  const base = assessByRules(file.facts, { now: NOW });
  const llm = fakeLlm(JSON.stringify({ recommendation: "FIGHT", win_probability: 0.8, rationale: ["ok"], evidence_notes: { PROOF_OF_FULFILLMENT: "Delivered, see tracking 1Z12345E0291980793." }, buyer_message: "Your tracking is 1Z12345E0291980793", accept_note: "x" }));
  const a = await refineWithLlm(llm, file, base);
  assert.equal(a.source, "llm");
  assert.equal(a.evidence[0]!.notes, base.evidence[0]!.notes);
  assert.equal(a.buyerMessage, base.buyerMessage);
});

test("LLM failure or garbage falls back to the rule-based assessment with the error recorded", async () => {
  const file = await buildCaseFile(mock(), disputeIdFor(1), NOW);
  const base = assessByRules(file.facts, { now: NOW });
  const down = await refineWithLlm(fakeLlm(new Error("gemini LLM HTTP 429: quota")), file, base);
  assert.equal(down.source, "rules");
  assert.match(down.llmError!, /429/);
  const garbage = await refineWithLlm(fakeLlm("I think you should fight!"), file, base);
  assert.equal(garbage.source, "rules");
  const badEnum = await refineWithLlm(fakeLlm(JSON.stringify({ recommendation: "SUE", win_probability: 0.5 })), file, base);
  assert.equal(badEnum.source, "rules");
  assert.match(badEnum.llmError!, /unknown recommendation/);
});

test("LLM cannot override WAIT on a case the seller cannot act on", async () => {
  const file = await buildCaseFile(mock(), disputeIdFor(4), NOW);
  const base = assessByRules(file.facts, { now: NOW });
  const a = await refineWithLlm(fakeLlm(JSON.stringify({ recommendation: "ACCEPT", win_probability: 0.3 })), file, base);
  assert.equal(a.recommendation, "WAIT");
});

test("pipeline caches per update_time and skips the LLM for resolved disputes", async () => {
  const llm = fakeLlm(JSON.stringify({ recommendation: "FIGHT", win_probability: 0.8, rationale: ["r"] }));
  const pipe = new DisputePipeline(mock(), { llm, now: NOW });
  await pipe.analyze(disputeIdFor(1));
  await pipe.analyze(disputeIdFor(1));
  assert.equal(llm.calls, 1);
  const resolved = await pipe.analyze(disputeIdFor(12));
  assert.equal(resolved.assessment!.source, "rules");
  assert.equal(llm.calls, 1);
});

test("identifier guard flags unknown id-like tokens only", () => {
  const known = new Set(["9405511899223197428490"]);
  assert.equal(inventsIdentifiers("Tracking 9405511899223197428490 shows delivered on 2026-09-24.", known), false);
  assert.equal(inventsIdentifiers("Tracking 9405511899223100000099 shows delivered.", known), true);
  assert.equal(inventsIdentifiers("A hand-thrown vase, reactive glaze.", known), false);
});
