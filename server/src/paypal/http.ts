import { randomUUID } from "node:crypto";
import { PayPalApiError, type ListDisputesParams, type PayPalGateway, type TransactionSearchParams } from "./client.ts";
import type {
  AcceptClaimInput,
  Dispute,
  DisputeList,
  Order,
  ProvideEvidenceInput,
  TrackerCollection,
  TransactionSearchResponse,
  WebhookEvent,
  WebhookHeaders,
} from "./types.ts";

export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

export interface HttpClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** Real PayPal REST client (sandbox). OAuth 2.0 client credentials, token cached until shortly before expiry. */
export class HttpPayPalClient implements PayPalGateway {
  readonly mode = "sandbox" as const;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private token: CachedToken | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(opts: HttpClientOptions) {
    if (!opts.clientId || !opts.clientSecret) throw new Error("PayPal client id and secret are required");
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.baseUrl = (opts.baseUrl ?? SANDBOX_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.now = opts.now ?? Date.now;
  }

  // ---------- OAuth ----------

  /** POST /v1/oauth2/token (grant_type=client_credentials). */
  async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    // Collapse concurrent refreshes into one request.
    this.tokenInFlight ??= this.fetchToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toApiError(res, "OAuth token request failed");
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new PayPalApiError(res.status, "OAuth response has no access_token");
    // Refresh 60 s early so a token never expires mid-request.
    const ttlMs = Math.max(0, ((data.expires_in ?? 300) - 60) * 1000);
    this.token = { value: data.access_token, expiresAt: this.now() + ttlMs };
    return data.access_token;
  }

  private async request<T>(method: string, path: string, init: { body?: BodyInit; contentType?: string; idempotent?: boolean } = {}): Promise<T> {
    const send = async (token: string) =>
      this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(init.contentType ? { "content-type": init.contentType } : {}),
          // PayPal-Request-Id makes POST retries idempotent on PayPal's side.
          ...(init.idempotent ? { "paypal-request-id": randomUUID() } : {}),
        },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

    let res = await send(await this.getAccessToken());
    if (res.status === 401) {
      // Token revoked or expired early: refresh once.
      this.token = null;
      this.tokenInFlight = null;
      res = await send(await this.getAccessToken());
    }
    if (!res.ok) throw await toApiError(res, `${method} ${path} failed`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ---------- Disputes v1 ----------

  listDisputes(params: ListDisputesParams = {}): Promise<DisputeList> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    const suffix = qs.size ? `?${qs}` : "";
    return this.request<DisputeList>("GET", `/v1/customer/disputes${suffix}`).then((r) => ({ ...r, items: r?.items ?? [] }));
  }

  async getDispute(id: string): Promise<Dispute> {
    return this.request<Dispute>("GET", `/v1/customer/disputes/${encodeId(id)}`);
  }

  /**
   * POST /v1/customer/disputes/{id}/provide-evidence
   * multipart/form-data: part "input" (application/json, { evidences: [...] }) + optional "evidence-file" parts.
   */
  async provideEvidence(id: string, input: ProvideEvidenceInput): Promise<void> {
    if (!input.evidences.length) throw new Error("At least one evidence item is required");
    const { body, contentType } = buildMultipart([
      { name: "input", contentType: "application/json", data: JSON.stringify({ evidences: input.evidences }) },
      ...(input.files ?? []).map((f) => ({ name: "evidence-file", filename: f.name, contentType: f.contentType, data: f.data })),
    ]);
    await this.request("POST", `/v1/customer/disputes/${encodeId(id)}/provide-evidence`, { body: body as Uint8Array<ArrayBuffer>, contentType, idempotent: true });
  }

  /** POST /v1/customer/disputes/{id}/accept-claim with JSON { note, accept_claim_type?, refund_amount? }. */
  async acceptClaim(id: string, input: AcceptClaimInput): Promise<void> {
    if (!input.note.trim()) throw new Error("A note is required to accept a claim");
    await this.request("POST", `/v1/customer/disputes/${encodeId(id)}/accept-claim`, {
      body: JSON.stringify(input),
      contentType: "application/json",
      idempotent: true,
    });
  }

  /** POST /v1/customer/disputes/{id}/send-message with JSON { message }. */
  async sendMessage(id: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error("Message must not be empty");
    await this.request("POST", `/v1/customer/disputes/${encodeId(id)}/send-message`, {
      body: JSON.stringify({ message }),
      contentType: "application/json",
      idempotent: true,
    });
  }

  // ---------- Orders v2 ----------

  async getOrder(id: string): Promise<Order> {
    return this.request<Order>("GET", `/v2/checkout/orders/${encodeId(id)}`);
  }

  // ---------- Transaction Search v1 ----------

  searchTransactions(p: TransactionSearchParams): Promise<TransactionSearchResponse> {
    const qs = new URLSearchParams({ transaction_id: p.transaction_id, start_date: p.start_date, end_date: p.end_date, fields: "all" });
    return this.request<TransactionSearchResponse>("GET", `/v1/reporting/transactions?${qs}`).then((r) => ({
      ...r,
      transaction_details: r?.transaction_details ?? [],
    }));
  }

  // ---------- Shipment Tracking v1 ----------

  listTrackers(transactionId: string): Promise<TrackerCollection> {
    const qs = new URLSearchParams({ transaction_id: transactionId });
    return this.request<TrackerCollection>("GET", `/v1/shipping/trackers?${qs}`).then((r) => ({ trackers: r?.trackers ?? [] }));
  }

  // ---------- Webhooks v1 ----------

  /** POST /v1/notifications/verify-webhook-signature -> verification_status SUCCESS | FAILURE. */
  async verifyWebhookSignature(h: WebhookHeaders, webhookId: string, event: WebhookEvent): Promise<boolean> {
    const res = await this.request<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      contentType: "application/json",
      body: JSON.stringify({
        auth_algo: h.authAlgo,
        cert_url: h.certUrl,
        transmission_id: h.transmissionId,
        transmission_sig: h.transmissionSig,
        transmission_time: h.transmissionTime,
        webhook_id: webhookId,
        webhook_event: event,
      }),
    });
    return res?.verification_status === "SUCCESS";
  }
}

function encodeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid PayPal id: ${id}`);
  return id;
}

async function toApiError(res: Response, fallback: string): Promise<PayPalApiError> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { name?: string; message?: string; debug_id?: string; details?: { issue?: string; description?: string }[]; error_description?: string };
    const issue = j.details?.[0]?.issue ?? j.name;
    const msg = j.details?.[0]?.description ?? j.message ?? j.error_description ?? fallback;
    return new PayPalApiError(res.status, `PayPal ${res.status}: ${msg}`, issue, j.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined);
  } catch {
    return new PayPalApiError(res.status, `PayPal ${res.status}: ${fallback}`, undefined, res.headers.get("paypal-debug-id") ?? undefined);
  }
}

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType: string;
  data: string | Uint8Array;
}

/** Minimal RFC 7578 encoder: gives each part an explicit Content-Type, which PayPal needs for the JSON "input" part. */
export function buildMultipart(parts: MultipartPart[], boundary = `----disputedesk${randomUUID().replace(/-/g, "")}`): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const disposition = `form-data; name="${p.name}"${p.filename ? `; filename="${p.filename.replace(/"/g, "")}"` : ""}`;
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${p.contentType}\r\n\r\n`));
    chunks.push(typeof p.data === "string" ? enc.encode(p.data) : p.data);
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
