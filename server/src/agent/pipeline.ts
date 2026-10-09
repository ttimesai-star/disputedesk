import type { PayPalGateway } from "../paypal/client.ts";
import type { Evidence } from "../paypal/types.ts";
import type { Assessment, CaseView, Recommendation } from "../shared.ts";
import { buildCaseFile, type CaseFile } from "./casefile.ts";
import { parseJsonObject, type Llm } from "./llm.ts";
import { assessByRules, type RuleOptions } from "./rules.ts";

const RECOMMENDATIONS: Recommendation[] = ["FIGHT", "ACCEPT", "MESSAGE_BUYER", "WAIT"];
/** The LLM may move the rule-based win estimate by at most this much: it reasons, it does not invent odds. */
const MAX_PROBABILITY_SHIFT = 0.25;

const SYSTEM_PROMPT = `You are DisputeDesk, an assistant for an online seller handling PayPal disputes and chargebacks.
You get a case file built from PayPal APIs (dispute, transaction, order, tracking, messages) and a rule-based baseline.
Decide whether the seller should FIGHT (submit evidence), ACCEPT (refund), MESSAGE_BUYER (resolve in the inquiry thread) or WAIT.
Rules:
- Use only facts present in the case file. Never invent tracking numbers, refund ids, dates, policies or amounts.
- If key evidence is missing, say so in risk_flags instead of guessing.
- evidence_notes: one factual paragraph per evidence type in the baseline, written for a PayPal reviewer, at most 600 characters each.
- buyer_message: polite, specific, under 400 characters. No promises the facts don't support.
- accept_note: one sentence for the accept-claim note.
Reply with ONE JSON object only:
{"recommendation":"FIGHT|ACCEPT|MESSAGE_BUYER|WAIT","win_probability":0.0-1.0,"rationale":["..."],"risk_flags":["..."],"evidence_notes":{"<EVIDENCE_TYPE>":"..."},"buyer_message":"...","accept_note":"..."}`;

export interface PipelineOptions extends RuleOptions {
  llm: Llm | null;
}

export class DisputePipeline {
  private readonly paypal: PayPalGateway;
  private readonly opts: PipelineOptions;
  private readonly cache = new Map<string, { view: CaseView; updateTime: string }>();

  constructor(paypal: PayPalGateway, opts: PipelineOptions) {
    this.paypal = paypal;
    this.opts = opts;
  }

  /** Cached assessment, if one exists for the dispute's current update_time. */
  cached(disputeId: string): CaseView | null {
    return this.cache.get(disputeId)?.view ?? null;
  }

  invalidate(disputeId: string): void {
    this.cache.delete(disputeId);
  }

  /** Full pipeline: collect case file -> rules -> LLM refinement (guarded) -> cache. */
  async analyze(disputeId: string, { useLlm = true, force = false }: { useLlm?: boolean; force?: boolean } = {}): Promise<CaseView> {
    const now = this.opts.now ?? new Date();
    const file = await buildCaseFile(this.paypal, disputeId, now);
    const hit = this.cache.get(disputeId);
    if (!force && hit && hit.updateTime === file.dispute.update_time && (hit.view.assessment?.source === "llm" || !useLlm || !this.opts.llm)) return hit.view;

    const baseline = assessByRules(file.facts, { ...this.opts, now });
    let assessment = baseline;
    if (useLlm && this.opts.llm && file.dispute.status !== "RESOLVED") {
      assessment = await refineWithLlm(this.opts.llm, file, baseline);
    }
    const view: CaseView = { dispute: file.dispute, facts: file.facts, timeline: file.timeline, assessment, dataGaps: file.dataGaps };
    this.cache.set(disputeId, { view, updateTime: file.dispute.update_time });
    return view;
  }
}

/** Asks the LLM to refine the baseline, then validates every field. Any failure returns the baseline with llmError set. */
export async function refineWithLlm(llm: Llm, file: CaseFile, baseline: Assessment): Promise<Assessment> {
  try {
    const reply = await llm.chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ case_file: summarize(file), baseline: { recommendation: baseline.recommendation, win_probability: baseline.winProbability, rationale: baseline.rationale, evidence_types: baseline.evidence.map((e) => e.evidence_type), expected_outcome: baseline.expected } }) },
    ]);
    const parsed = parseJsonObject(reply.content);
    if (!parsed) throw new Error("LLM reply was not a JSON object");
    return mergeLlm(parsed, file, baseline, `${reply.provider}:${reply.model}`);
  } catch (e) {
    return { ...baseline, llmError: (e as Error).message.slice(0, 200) };
  }
}

export function mergeLlm(raw: Record<string, unknown>, file: CaseFile, baseline: Assessment, model: string): Assessment {
  const rec = String(raw.recommendation ?? "").toUpperCase() as Recommendation;
  if (!RECOMMENDATIONS.includes(rec)) throw new Error(`LLM returned unknown recommendation "${String(raw.recommendation)}"`);
  // Seller cannot act while PayPal or the buyer holds the case: keep WAIT regardless of the model.
  const recommendation = baseline.recommendation === "WAIT" ? "WAIT" : rec;

  const pRaw = Number(raw.win_probability);
  if (!Number.isFinite(pRaw)) throw new Error("LLM win_probability is not a number");
  const p = Math.min(baseline.winProbability + MAX_PROBABILITY_SHIFT, Math.max(baseline.winProbability - MAX_PROBABILITY_SHIFT, pRaw));
  const winProbability = Math.round(Math.min(0.99, Math.max(0.01, p)) * 100) / 100;

  const known = knownIdentifiers(file);
  const notes = (raw.evidence_notes && typeof raw.evidence_notes === "object" ? raw.evidence_notes : {}) as Record<string, unknown>;
  const evidence: Evidence[] = baseline.evidence.map((e) => {
    const text = typeof notes[e.evidence_type] === "string" ? (notes[e.evidence_type] as string).trim().slice(0, 2000) : "";
    // Structured parts (tracking_info, refund_ids) always come from PayPal data; the model only writes prose.
    return text && !inventsIdentifiers(text, known) ? { ...e, notes: text } : e;
  });

  const buyerMessage = cleanText(raw.buyer_message, 1000, known) ?? baseline.buyerMessage;
  const acceptNote = cleanText(raw.accept_note, 500, known) ?? baseline.acceptNote;
  const rationale = strList(raw.rationale, 6) ?? baseline.rationale;
  const riskFlags = strList(raw.risk_flags, 6) ?? baseline.riskFlags;

  const fee = baseline.expected.assumedFee;
  // Recompute the fight outcome with the refined probability, keeping the baseline's handling cost.
  const handling = -baseline.expected.fight - (1 - baseline.winProbability) * (file.facts.amount + fee);
  const fight = Math.round((-(1 - winProbability) * (file.facts.amount + fee) - handling) * 100) / 100;
  return {
    ...baseline,
    recommendation,
    winProbability,
    rationale,
    riskFlags: [...new Set([...riskFlags, ...baseline.riskFlags])].slice(0, 8),
    evidence,
    buyerMessage,
    acceptNote,
    expected: { ...baseline.expected, fight },
    source: "llm",
    model,
  };
}

function summarize(file: CaseFile) {
  return {
    facts: file.facts,
    timeline: file.timeline.map((t) => `${t.at.slice(0, 10)} ${t.title}${t.detail ? ` - ${t.detail}` : ""}`),
    data_gaps: file.dataGaps,
    allowed_accept_types: file.dispute.allowed_response_options?.accept_claim?.accept_claim_types ?? [],
  };
}

/** Every id-like token PayPal gave us for this case. */
function knownIdentifiers(file: CaseFile): Set<string> {
  const ids = new Set<string>();
  const add = (v: string | undefined | null) => v && ids.add(v.toUpperCase());
  add(file.dispute.dispute_id);
  for (const t of file.dispute.disputed_transactions) {
    add(t.seller_transaction_id);
    add(t.buyer_transaction_id);
    add(t.invoice_number);
    add(t.custom);
  }
  for (const t of file.transactions) {
    add(t.transaction_info.transaction_id);
    add(t.transaction_info.invoice_id);
  }
  for (const t of file.trackers) add(t.tracking_number);
  add(file.order?.id);
  return ids;
}

/** Long alphanumeric tokens with digits look like tracking numbers or ids; any we did not supply is a hallucination. */
export function inventsIdentifiers(text: string, known: Set<string>): boolean {
  const tokens = text.toUpperCase().match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9-]{10,}\b/g) ?? [];
  return tokens.some((t) => !known.has(t) && !/^\d{4}-\d{2}-\d{2}$/.test(t));
}

function cleanText(v: unknown, max: number, known: Set<string>): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t && !inventsIdentifiers(t, known) ? t : null;
}

function strList(v: unknown, max: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 300)).slice(0, max);
  return out.length ? out : null;
}
