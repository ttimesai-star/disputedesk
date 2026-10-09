import type {
  AcceptClaimInput,
  Dispute,
  DisputeList,
  DisputeState,
  Order,
  ProvideEvidenceInput,
  TrackerCollection,
  TransactionSearchResponse,
  WebhookEvent,
  WebhookHeaders,
} from "./types.ts";

export type PayPalMode = "mock" | "sandbox";

export interface ListDisputesParams {
  dispute_state?: DisputeState;
  disputed_transaction_id?: string;
  start_time?: string;
  page_size?: number;
  next_page_token?: string;
}

export interface TransactionSearchParams {
  transaction_id: string;
  start_date: string;
  end_date: string;
}

/**
 * Everything DisputeDesk needs from PayPal. Two implementations:
 *  - HttpPayPalClient: real REST calls against api-m.sandbox.paypal.com
 *  - MockPayPalClient: in-memory store shaped exactly like the REST responses
 */
export interface PayPalGateway {
  readonly mode: PayPalMode;

  // Disputes v1
  listDisputes(params?: ListDisputesParams): Promise<DisputeList>;
  getDispute(id: string): Promise<Dispute>;
  provideEvidence(id: string, input: ProvideEvidenceInput): Promise<void>;
  acceptClaim(id: string, input: AcceptClaimInput): Promise<void>;
  sendMessage(id: string, message: string): Promise<void>;

  // Orders v2
  getOrder(id: string): Promise<Order>;

  // Transaction Search v1
  searchTransactions(params: TransactionSearchParams): Promise<TransactionSearchResponse>;

  // Shipment Tracking v1
  listTrackers(transactionId: string): Promise<TrackerCollection>;

  // Webhooks v1
  verifyWebhookSignature(headers: WebhookHeaders, webhookId: string, event: WebhookEvent): Promise<boolean>;
}

export class PayPalApiError extends Error {
  readonly status: number;
  readonly issue?: string;
  readonly debugId?: string;

  constructor(status: number, message: string, issue?: string, debugId?: string) {
    super(message);
    this.name = "PayPalApiError";
    this.status = status;
    this.issue = issue;
    this.debugId = debugId;
  }
}
