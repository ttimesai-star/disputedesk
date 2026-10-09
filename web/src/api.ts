import type { AuditEntry, CaseView, DisputeRow, HealthInfo, PolicySettings, QueryResult } from "../../server/src/shared.ts";
import type { AcceptClaimType, Evidence } from "../../server/src/paypal/types.ts";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  health: () => call<HealthInfo>("GET", "/health"),
  disputes: () => call<DisputeRow[]>("GET", "/disputes"),
  dispute: (id: string) => call<CaseView>("GET", `/disputes/${id}`),
  analyze: (id: string) => call<CaseView>("POST", `/disputes/${id}/analyze`),
  analyzeAll: () => call<{ analyzed: number }>("POST", "/disputes/analyze-all"),
  submitEvidence: (id: string, evidences: Evidence[]) => call<CaseView>("POST", `/disputes/${id}/evidence`, { evidences }),
  accept: (id: string, note: string, accept_claim_type?: AcceptClaimType | null) => call<CaseView>("POST", `/disputes/${id}/accept`, { note, ...(accept_claim_type ? { accept_claim_type } : {}) }),
  message: (id: string, message: string) => call<CaseView>("POST", `/disputes/${id}/message`, { message }),
  policies: () => call<PolicySettings>("GET", "/policies"),
  savePolicies: (s: PolicySettings) => call<PolicySettings>("PUT", "/policies", s),
  runPolicies: () => call<{ acted: number; skipped: number }>("POST", "/policies/run"),
  audit: () => call<AuditEntry[]>("GET", "/audit"),
  query: (q: string) => call<QueryResult>("POST", "/query", { q }),
  ask: (q: string) => call<{ answer: string; toolCalls: { name: string; args: string }[]; provider: string | null }>("POST", "/ask", { q }),
  simulate: () => call<{ received: boolean; dispute_id: string }>("POST", "/demo/simulate-dispute"),
};

export const REASON_LABEL: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorized",
  CREDIT_NOT_PROCESSED: "Refund not processed",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  INCORRECT_AMOUNT: "Incorrect amount",
  PAYMENT_BY_OTHER_MEANS: "Paid other way",
  CANCELED_RECURRING_BILLING: "Canceled subscription",
  PROBLEM_WITH_REMITTANCE: "Remittance problem",
  OTHER: "Other",
};

export const REC_LABEL: Record<string, string> = { FIGHT: "Fight", ACCEPT: "Accept", MESSAGE_BUYER: "Message buyer", WAIT: "Wait" };

export function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function pretty(code: string): string {
  return code.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
