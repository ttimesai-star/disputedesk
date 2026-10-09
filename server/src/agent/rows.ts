import type { PayPalGateway } from "../paypal/client.ts";
import type { CaseView, DisputeRow } from "../shared.ts";
import type { DisputePipeline } from "./pipeline.ts";

/** Runs `fn` over items with at most `limit` in flight (PayPal sandbox rate-limits bursts). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export function toRow(v: CaseView): DisputeRow {
  const d = v.dispute;
  const tx = d.disputed_transactions[0];
  return {
    disputeId: d.dispute_id,
    amount: Number(d.dispute_amount.value),
    currency: d.dispute_amount.currency_code,
    reason: d.reason,
    status: d.status,
    stage: d.dispute_life_cycle_stage ?? "",
    channel: d.dispute_channel ?? "",
    buyer: tx?.buyer?.name ?? tx?.buyer?.email ?? "",
    item: tx?.items?.map((i) => i.item_description).filter(Boolean).join(", ") ?? "",
    createdAt: d.create_time,
    dueAt: d.seller_response_due_date ?? null,
    dueInDays: v.facts.daysToDue,
    winScore: v.assessment ? Math.round(v.assessment.winProbability * 100) : null,
    recommendation: v.assessment?.recommendation ?? null,
    assessedBy: v.assessment?.source ?? null,
    sellerTransactionId: tx?.seller_transaction_id ?? null,
  };
}

/**
 * Grid rows: every dispute from Disputes v1, each with at least a rule-based assessment
 * (cheap, no LLM). LLM assessments appear once a dispute was analyzed individually or via "Analyze all".
 */
export async function buildRows(paypal: PayPalGateway, pipeline: DisputePipeline): Promise<DisputeRow[]> {
  const list = await paypal.listDisputes({ page_size: 50 });
  const views = await mapLimit(list.items, 4, async (s) => {
    const cached = pipeline.cached(s.dispute_id);
    if (cached && cached.dispute.update_time === s.update_time) return cached;
    return pipeline.analyze(s.dispute_id, { useLlm: false });
  });
  return views.map(toRow);
}
