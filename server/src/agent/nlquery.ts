import type { GridFilter, QueryResult } from "../shared.ts";
import { parseJsonObject, type Llm } from "./llm.ts";

/** Grid columns the query language may touch. Mirrors DisputeRow in shared.ts. */
export const QUERY_COLUMNS = {
  amount: { type: "number", about: "dispute amount" },
  dueInDays: { type: "number", about: "days until the seller response deadline (negative = overdue)" },
  winScore: { type: "number", about: "estimated chance to win, 0-100" },
  reason: { type: "text", about: "PayPal reason code", values: ["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", "UNAUTHORISED", "CREDIT_NOT_PROCESSED", "DUPLICATE_TRANSACTION", "INCORRECT_AMOUNT", "PAYMENT_BY_OTHER_MEANS", "CANCELED_RECURRING_BILLING", "PROBLEM_WITH_REMITTANCE", "OTHER"] },
  status: { type: "text", about: "dispute status", values: ["OPEN", "WAITING_FOR_BUYER_RESPONSE", "WAITING_FOR_SELLER_RESPONSE", "UNDER_REVIEW", "RESOLVED", "OTHER"] },
  stage: { type: "text", about: "lifecycle stage", values: ["INQUIRY", "CHARGEBACK", "PRE_ARBITRATION", "ARBITRATION"] },
  channel: { type: "text", about: "INTERNAL = PayPal claim, EXTERNAL = card chargeback", values: ["INTERNAL", "EXTERNAL", "ALERT"] },
  recommendation: { type: "text", about: "AI recommendation", values: ["FIGHT", "ACCEPT", "MESSAGE_BUYER", "WAIT"] },
  buyer: { type: "text", about: "buyer name" },
  item: { type: "text", about: "item purchased" },
  currency: { type: "text", about: "ISO currency code" },
} as const;

type Col = keyof typeof QUERY_COLUMNS;
const NUMBER_OPS = ["equals", "notEqual", "lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual", "inRange"] as const;
const TEXT_OPS = ["equals", "notEqual", "contains", "notContains", "startsWith"] as const;
const SORTABLE = ["amount", "dueInDays", "winScore", "createdAt"];

const SYSTEM = `Translate a seller's question about their PayPal disputes into an AG Grid filter model.
Columns: ${JSON.stringify(QUERY_COLUMNS)}
Return ONE JSON object: {"filterModel":{<column>:<filter>},"sort":{"colId":"amount|dueInDays|winScore|createdAt","sort":"asc|desc"}|null,"explanation":"short sentence"}
Filters:
- number: {"filterType":"number","type":"equals|notEqual|lessThan|lessThanOrEqual|greaterThan|greaterThanOrEqual|inRange","filter":N,"filterTo":N (inRange only)}
- text:   {"filterType":"text","type":"equals|notEqual|contains|notContains|startsWith","filter":"..."}
- several values of one text column: {"filterType":"text","operator":"OR","conditions":[{"filterType":"text","type":"equals","filter":"..."}, ...]}
Use the exact enum values listed. "this week" = dueInDays <= 7. "urgent" = dueInDays <= 2. Only use listed columns.`;

/** Validates a filter model coming from the LLM (or anyone): unknown columns or operators are rejected. */
export function validateQuery(raw: Record<string, unknown>): Omit<QueryResult, "source"> {
  const fm = raw.filterModel;
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) throw new Error("filterModel must be an object");
  const out: Record<string, GridFilter> = {};
  for (const [col, f] of Object.entries(fm as Record<string, unknown>)) {
    if (!(col in QUERY_COLUMNS)) throw new Error(`unknown column ${col}`);
    const spec = QUERY_COLUMNS[col as Col];
    const g = f as Record<string, unknown>;
    if (spec.type === "number") {
      if (g.filterType !== "number" || !NUMBER_OPS.includes(g.type as never) || !Number.isFinite(Number(g.filter))) throw new Error(`bad number filter on ${col}`);
      const nf: GridFilter = { filterType: "number", type: g.type as (typeof NUMBER_OPS)[number], filter: Number(g.filter) };
      if (g.type === "inRange") {
        if (!Number.isFinite(Number(g.filterTo))) throw new Error(`inRange on ${col} needs filterTo`);
        nf.filterTo = Number(g.filterTo);
      }
      out[col] = nf;
    } else if (g.operator === "OR" && Array.isArray(g.conditions)) {
      const conditions = g.conditions.slice(0, 2).map((c) => {
        const cc = c as Record<string, unknown>;
        if (typeof cc.filter !== "string" || (cc.type !== "equals" && cc.type !== "contains")) throw new Error(`bad condition on ${col}`);
        return { filterType: "text" as const, type: cc.type as "equals" | "contains", filter: normalizeEnum(col as Col, cc.filter) };
      });
      out[col] = { filterType: "text", operator: "OR", conditions };
    } else {
      if (g.filterType !== "text" || !TEXT_OPS.includes(g.type as never) || typeof g.filter !== "string") throw new Error(`bad text filter on ${col}`);
      out[col] = { filterType: "text", type: g.type as (typeof TEXT_OPS)[number], filter: normalizeEnum(col as Col, g.filter) };
    }
  }
  let sort: QueryResult["sort"] = null;
  const s = raw.sort as Record<string, unknown> | null | undefined;
  if (s && typeof s === "object" && SORTABLE.includes(String(s.colId)) && (s.sort === "asc" || s.sort === "desc")) sort = { colId: String(s.colId), sort: s.sort };
  return { filterModel: out, sort, explanation: typeof raw.explanation === "string" ? raw.explanation.slice(0, 200) : "" };
}

function normalizeEnum(col: Col, v: string): string {
  const spec = QUERY_COLUMNS[col] as { values?: readonly string[] };
  if (!spec.values) return v;
  const up = v.toUpperCase().replace(/[\s-]+/g, "_");
  return spec.values.includes(up) ? up : v;
}

export async function translateQuery(q: string, llm: Llm | null): Promise<QueryResult> {
  const text = q.trim().slice(0, 300);
  if (llm) {
    try {
      const r = await llm.chat([
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ]);
      const parsed = parseJsonObject(r.content);
      if (parsed) return { ...validateQuery(parsed), source: "llm" };
    } catch {
      // fall through to the rule parser
    }
  }
  return { ...parseQueryByRules(text), source: "rules" };
}

const REASON_WORDS: [RegExp, string][] = [
  [/not (been )?received|never (arrived|got)|didn'?t (arrive|get)|\binr\b|lost/i, "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"],
  [/not as described|\bsnad\b|damaged|broken|wrong item/i, "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"],
  [/unauthori[sz]ed|fraud|stolen/i, "UNAUTHORISED"],
  [/refund not|credit not|not refunded/i, "CREDIT_NOT_PROCESSED"],
  [/duplicate|charged twice|double/i, "DUPLICATE_TRANSACTION"],
  [/subscription|recurring|membership/i, "CANCELED_RECURRING_BILLING"],
  [/incorrect amount|overcharg|wrong amount/i, "INCORRECT_AMOUNT"],
];

/** Offline parser for the common phrasings, used when no LLM is configured or it fails. */
export function parseQueryByRules(q: string): Omit<QueryResult, "source"> {
  const fm: Record<string, GridFilter> = {};
  const why: string[] = [];
  const num = (s: string) => Number(s.replace(/,/g, ""));

  const between = q.match(/between\s*\$?([\d,.]+)\s*(?:and|-)\s*\$?([\d,.]+)/i);
  const over = q.match(/(?:over|above|more than|greater than|>\s*|at least)\s*\$?([\d,.]+)/i);
  const under = q.match(/(?:under|below|less than|<\s*|at most)\s*\$?([\d,.]+)/i);
  if (between) {
    fm.amount = { filterType: "number", type: "inRange", filter: num(between[1]!), filterTo: num(between[2]!) };
    why.push(`amount ${between[1]}-${between[2]}`);
  } else if (over && !/win|chance|odds|%/i.test(q.slice(over.index ?? 0, (over.index ?? 0) + over[0].length + 12))) {
    fm.amount = { filterType: "number", type: /at least/i.test(over[0]) ? "greaterThanOrEqual" : "greaterThan", filter: num(over[1]!) };
    why.push(`amount > ${over[1]}`);
  } else if (under && !/win|chance|odds|%/i.test(q.slice(under.index ?? 0, (under.index ?? 0) + under[0].length + 12))) {
    fm.amount = { filterType: "number", type: /at most/i.test(under[0]) ? "lessThanOrEqual" : "lessThan", filter: num(under[1]!) };
    why.push(`amount < ${under[1]}`);
  }

  const win = q.match(/(?:win|chance|odds)[^\d]{0,20}(\d{1,3})\s*%?|(\d{1,3})\s*%\s*(?:win|chance|odds)/i);
  if (win) {
    const v = Number(win[1] ?? win[2]);
    const low = /(?:below|under|less|low)/i.test(q);
    fm.winScore = { filterType: "number", type: low ? "lessThan" : "greaterThanOrEqual", filter: v };
    why.push(`win ${low ? "<" : ">="} ${v}%`);
  } else if (/(likely|easy|strong|good chance).{0,10}win|winnable/i.test(q)) {
    fm.winScore = { filterType: "number", type: "greaterThanOrEqual", filter: 60 };
    why.push("win >= 60%");
  }

  const inDays = q.match(/(?:due|deadline)\s*(?:in|within)\s*(\d+)\s*days?/i);
  if (/overdue|past due/i.test(q)) {
    fm.dueInDays = { filterType: "number", type: "lessThan", filter: 0 };
    why.push("overdue");
  } else if (inDays) {
    fm.dueInDays = { filterType: "number", type: "lessThanOrEqual", filter: Number(inDays[1]) };
    why.push(`due within ${inDays[1]} days`);
  } else if (/due today|urgent|asap/i.test(q)) {
    fm.dueInDays = { filterType: "number", type: "lessThanOrEqual", filter: /today/i.test(q) ? 0 : 2 };
    why.push("urgent");
  } else if (/due tomorrow/i.test(q)) {
    fm.dueInDays = { filterType: "number", type: "lessThanOrEqual", filter: 1 };
    why.push("due by tomorrow");
  } else if (/this week|next 7 days/i.test(q)) {
    fm.dueInDays = { filterType: "number", type: "lessThanOrEqual", filter: 7 };
    why.push("due this week");
  }

  const reasons = REASON_WORDS.filter(([re]) => re.test(q)).map(([, r]) => r);
  if (reasons.length === 1) fm.reason = { filterType: "text", type: "equals", filter: reasons[0]! };
  else if (reasons.length > 1) fm.reason = { filterType: "text", operator: "OR", conditions: reasons.slice(0, 2).map((r) => ({ filterType: "text" as const, type: "equals" as const, filter: r })) };
  if (reasons.length) why.push(`reason: ${reasons.join(" or ").toLowerCase().replace(/_/g, " ")}`);

  if (/\bfight\b|contest/i.test(q)) fm.recommendation = { filterType: "text", type: "equals", filter: "FIGHT" };
  else if (/\baccept\b|refund them|give up/i.test(q)) fm.recommendation = { filterType: "text", type: "equals", filter: "ACCEPT" };
  if (fm.recommendation && "filter" in fm.recommendation) why.push(`recommended: ${String(fm.recommendation.filter).toLowerCase()}`);

  if (/chargeback/i.test(q) && !/inquir/i.test(q)) fm.stage = { filterType: "text", type: "equals", filter: "CHARGEBACK" };
  else if (/inquir/i.test(q)) fm.stage = { filterType: "text", type: "equals", filter: "INQUIRY" };
  if (/card|bank|issuer|external/i.test(q)) fm.channel = { filterType: "text", type: "equals", filter: "EXTERNAL" };
  if (/\bopen\b|need(s)? (my )?action|waiting (on|for) me/i.test(q)) fm.status = { filterType: "text", type: "equals", filter: "WAITING_FOR_SELLER_RESPONSE" };
  else if (/resolved|closed/i.test(q)) fm.status = { filterType: "text", type: "equals", filter: "RESOLVED" };
  if (fm.stage && "filter" in fm.stage) why.push(String(fm.stage.filter).toLowerCase());
  if (fm.status && "filter" in fm.status) why.push(String(fm.status.filter).toLowerCase().replace(/_/g, " "));

  let sort: QueryResult["sort"] = null;
  if (/biggest|largest|highest amount|most expensive/i.test(q)) sort = { colId: "amount", sort: "desc" };
  else if (/smallest|cheapest/i.test(q)) sort = { colId: "amount", sort: "asc" };
  else if (/soonest|most urgent|by deadline/i.test(q)) sort = { colId: "dueInDays", sort: "asc" };

  return { filterModel: fm, sort, explanation: why.length ? `Showing disputes: ${why.join(", ")}.` : "No filters recognized; showing all disputes." };
}
