// npm run analyze -- <dispute_id>    (no id: analyze every dispute that needs action)
import { createLlm } from "./agent/llm.ts";
import { DisputePipeline } from "./agent/pipeline.ts";
import { createPayPalGateway } from "./paypal/index.ts";

const paypal = createPayPalGateway();
const pipeline = new DisputePipeline(paypal, { llm: createLlm() });
const ids = process.argv.slice(2).length ? process.argv.slice(2) : (await paypal.listDisputes({ dispute_state: "REQUIRED_ACTION" })).items.map((d) => d.dispute_id);
for (const id of ids) {
  const v = await pipeline.analyze(id);
  const a = v.assessment!;
  console.log(`\n${id}  ${v.facts.amount} ${v.facts.currency}  ${v.facts.reason}  due in ${v.facts.daysToDue ?? "-"}d`);
  console.log(`  -> ${a.recommendation}  win ${Math.round(a.winProbability * 100)}%  [${a.source}${a.model ? ` ${a.model}` : ""}${a.llmError ? ` | LLM error: ${a.llmError}` : ""}]`);
  for (const r of a.rationale) console.log(`     - ${r}`);
  for (const e of a.evidence) console.log(`     evidence ${e.evidence_type}: ${e.notes ?? ""}`);
}
