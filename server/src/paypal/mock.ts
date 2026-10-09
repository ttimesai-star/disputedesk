import { createHmac, timingSafeEqual } from "node:crypto";
import { PayPalApiError, type ListDisputesParams, type PayPalGateway, type TransactionSearchParams } from "./client.ts";
import { buildMockStore, type MockStore } from "./fixtures.ts";
import type {
  AcceptClaimInput,
  Dispute,
  DisputeList,
  DisputeSummary,
  Order,
  ProvideEvidenceInput,
  TrackerCollection,
  TransactionSearchResponse,
  WebhookEvent,
  WebhookHeaders,
} from "./types.ts";

/** Secret used only by the mock to sign simulated webhooks. Not a PayPal secret. */
export const MOCK_WEBHOOK_SECRET = "disputedesk-mock-webhook-secret";

/**
 * In-memory PayPal used when no sandbox credentials are configured.
 * It enforces the same state rules the real API documents, so the UI and
 * the agent behave identically in both modes:
 *  - evidence only while status is WAITING_FOR_SELLER_RESPONSE
 *  - accept-claim only while the dispute is not RESOLVED
 */
export class MockPayPalClient implements PayPalGateway {
  readonly mode = "mock" as const;
  readonly store: MockStore;

  constructor(store: MockStore = buildMockStore()) {
    this.store = store;
  }

  async listDisputes(params: ListDisputesParams = {}): Promise<DisputeList> {
    let all = [...this.store.disputes.values()];
    if (params.dispute_state) all = all.filter((d) => d.dispute_state === params.dispute_state);
    if (params.disputed_transaction_id) all = all.filter((d) => d.disputed_transactions.some((t) => t.seller_transaction_id === params.disputed_transaction_id));
    if (params.start_time) {
      const since = Date.parse(params.start_time);
      all = all.filter((d) => Date.parse(d.create_time) >= since);
    }
    all.sort((a, b) => b.create_time.localeCompare(a.create_time));
    const items: DisputeSummary[] = all.slice(0, params.page_size ?? 50).map((d) => ({
      dispute_id: d.dispute_id,
      create_time: d.create_time,
      update_time: d.update_time,
      reason: d.reason,
      status: d.status,
      dispute_state: d.dispute_state,
      dispute_amount: d.dispute_amount,
      dispute_life_cycle_stage: d.dispute_life_cycle_stage,
      dispute_channel: d.dispute_channel,
      links: d.links,
    }));
    return { items };
  }

  async getDispute(id: string): Promise<Dispute> {
    return structuredClone(this.mustGet(id));
  }

  async provideEvidence(id: string, input: ProvideEvidenceInput): Promise<void> {
    const d = this.mustGet(id);
    if (d.status !== "WAITING_FOR_SELLER_RESPONSE") {
      throw new PayPalApiError(422, `PayPal 422: Evidence can only be provided while the dispute is WAITING_FOR_SELLER_RESPONSE (is ${d.status})`, "INVALID_DISPUTE_STATE");
    }
    if (!input.evidences.length) throw new PayPalApiError(400, "PayPal 400: evidences must not be empty", "MISSING_REQUIRED_PARAMETER");
    const now = new Date().toISOString();
    d.evidences = [...(d.evidences ?? []), ...input.evidences.map((e) => ({ ...e, source: "SUBMITTED_BY_SELLER" as const, date: now }))];
    d.status = "UNDER_REVIEW";
    d.dispute_state = "UNDER_PAYPAL_REVIEW";
    d.update_time = now;
  }

  async acceptClaim(id: string, input: AcceptClaimInput): Promise<void> {
    const d = this.mustGet(id);
    if (d.status === "RESOLVED") throw new PayPalApiError(422, "PayPal 422: Dispute is already resolved", "INVALID_DISPUTE_STATE");
    const allowed = d.allowed_response_options?.accept_claim?.accept_claim_types;
    if (input.accept_claim_type && allowed && !allowed.includes(input.accept_claim_type)) {
      throw new PayPalApiError(422, `PayPal 422: accept_claim_type ${input.accept_claim_type} is not allowed`, "INVALID_ACCEPT_CLAIM_TYPE");
    }
    const now = new Date().toISOString();
    d.status = "RESOLVED";
    d.dispute_state = "RESOLVED";
    d.dispute_outcome = { outcome_code: "ACCEPTED", amount_refunded: input.refund_amount ?? d.dispute_amount };
    d.messages = [...(d.messages ?? []), { posted_by: "SELLER", time_posted: now, content: input.note }];
    d.update_time = now;
  }

  async sendMessage(id: string, message: string): Promise<void> {
    const d = this.mustGet(id);
    if (!message.trim()) throw new PayPalApiError(400, "PayPal 400: message must not be empty", "MISSING_REQUIRED_PARAMETER");
    const now = new Date().toISOString();
    d.messages = [...(d.messages ?? []), { posted_by: "SELLER", time_posted: now, content: message }];
    d.update_time = now;
  }

  async getOrder(id: string): Promise<Order> {
    const o = this.store.orders.get(id);
    if (!o) throw new PayPalApiError(404, `PayPal 404: order ${id} not found`, "RESOURCE_NOT_FOUND");
    return structuredClone(o);
  }

  async searchTransactions(p: TransactionSearchParams): Promise<TransactionSearchResponse> {
    const start = Date.parse(p.start_date);
    const end = Date.parse(p.end_date);
    if (end - start > 31 * 86_400_000) throw new PayPalApiError(400, "PayPal 400: date range greater than 31 days", "INVALID_REQUEST");
    // Like the real API, a transaction_id search also returns related records (e.g. refunds referencing it).
    const details = [...this.store.transactions.values()].filter((t) => {
      const i = t.transaction_info;
      const at = Date.parse(i.transaction_initiation_date ?? "");
      return (i.transaction_id === p.transaction_id || i.paypal_reference_id === p.transaction_id) && at >= start && at <= end;
    });
    return { transaction_details: structuredClone(details), total_items: details.length, total_pages: 1, page: 1 };
  }

  async listTrackers(transactionId: string): Promise<TrackerCollection> {
    return { trackers: structuredClone(this.store.trackers.get(transactionId) ?? []) };
  }

  /** Mock verification: HMAC-SHA256 over `${transmissionId}|${transmissionTime}|${webhookId}|${body}`. */
  async verifyWebhookSignature(h: WebhookHeaders, webhookId: string, event: WebhookEvent): Promise<boolean> {
    const expected = signMockWebhook(h.transmissionId, h.transmissionTime, webhookId, JSON.stringify(event));
    const a = Buffer.from(expected);
    const b = Buffer.from(h.transmissionSig);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Simulates PayPal opening a new dispute (used by the demo "simulate webhook" button). */
  ingestDispute(d: Dispute): void {
    this.store.disputes.set(d.dispute_id, structuredClone(d));
  }

  private mustGet(id: string): Dispute {
    const d = this.store.disputes.get(id);
    if (!d) throw new PayPalApiError(404, `PayPal 404: dispute ${id} not found`, "RESOURCE_NOT_FOUND");
    return d;
  }
}

export function signMockWebhook(transmissionId: string, transmissionTime: string, webhookId: string, body: string): string {
  return createHmac("sha256", MOCK_WEBHOOK_SECRET).update(`${transmissionId}|${transmissionTime}|${webhookId}|${body}`).digest("base64");
}
