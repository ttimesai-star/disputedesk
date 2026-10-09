import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpPayPalClient, buildMultipart } from "../src/paypal/http.ts";
import { PayPalApiError } from "../src/paypal/client.ts";
import { createPayPalGateway } from "../src/paypal/index.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(handler: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body ?? "");
    const c: Call = { url: String(input), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body };
    calls.push(c);
    return handler(c, calls.length);
  }) as typeof fetch;
  return { calls, impl };
}

const tokenRes = (token = "TOKEN-1", expires = 32400) => new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: expires }), { status: 200 });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function client(handler: (c: Call, n: number) => Response | Promise<Response>, now = () => 1_000_000) {
  const f = fakeFetch((c, n) => (c.url.endsWith("/v1/oauth2/token") ? tokenRes(`TOKEN-${n}`) : handler(c, n)));
  return { f, c: new HttpPayPalClient({ clientId: "cid", clientSecret: "secret", fetchImpl: f.impl, now }) };
}

test("OAuth uses client credentials with Basic auth against the sandbox and caches the token", async () => {
  const { f, c } = client(() => ok({ items: [] }));
  await c.listDisputes();
  await c.listDisputes();
  const tokenCalls = f.calls.filter((x) => x.url.endsWith("/v1/oauth2/token"));
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0]!.url, "https://api-m.sandbox.paypal.com/v1/oauth2/token");
  assert.equal(tokenCalls[0]!.body, "grant_type=client_credentials");
  assert.equal(tokenCalls[0]!.headers.authorization, `Basic ${Buffer.from("cid:secret").toString("base64")}`);
  assert.equal(f.calls[1]!.headers.authorization, "Bearer TOKEN-1");
});

test("concurrent requests share one token fetch; expired token is refreshed", async () => {
  let now = 0;
  const { f, c } = client(() => ok({ items: [] }), () => now);
  await Promise.all([c.listDisputes(), c.listDisputes(), c.listDisputes()]);
  assert.equal(f.calls.filter((x) => x.url.endsWith("/oauth2/token")).length, 1);
  now = 32400 * 1000; // past expiry (minus the 60 s safety margin)
  await c.listDisputes();
  assert.equal(f.calls.filter((x) => x.url.endsWith("/oauth2/token")).length, 2);
});

test("a 401 triggers exactly one token refresh and retry", async () => {
  const { f, c } = client((call, n) => (n === 2 ? new Response("{}", { status: 401 }) : ok({ items: [{ dispute_id: "PP-D-1" }] })));
  const r = await c.listDisputes();
  assert.equal(r.items.length, 1);
  assert.equal(f.calls.filter((x) => x.url.endsWith("/oauth2/token")).length, 2);
});

test("listDisputes builds the documented query string", async () => {
  const { f, c } = client(() => ok({ items: [] }));
  await c.listDisputes({ dispute_state: "REQUIRED_ACTION", page_size: 20 });
  assert.equal(f.calls[1]!.url, "https://api-m.sandbox.paypal.com/v1/customer/disputes?dispute_state=REQUIRED_ACTION&page_size=20");
});

test("provideEvidence posts multipart with a JSON 'input' part and a PayPal-Request-Id", async () => {
  const { f, c } = client(() => new Response(JSON.stringify({ links: [] }), { status: 200 }));
  await c.provideEvidence("PP-D-123", {
    evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: [{ carrier_name: "USPS", tracking_number: "9405" }] }, notes: "Delivered" }],
    files: [{ name: "label.pdf", contentType: "application/pdf", data: new TextEncoder().encode("%PDF") }],
  });
  const call = f.calls[1]!;
  assert.equal(call.url, "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-123/provide-evidence");
  assert.equal(call.method, "POST");
  assert.match(call.headers["content-type"]!, /^multipart\/form-data; boundary=/);
  assert.ok(call.headers["paypal-request-id"]);
  assert.match(call.body, /name="input"\r\nContent-Type: application\/json\r\n\r\n\{"evidences":\[\{"evidence_type":"PROOF_OF_FULFILLMENT"/);
  assert.match(call.body, /name="evidence-file"; filename="label.pdf"\r\nContent-Type: application\/pdf/);
});

test("acceptClaim and sendMessage send JSON bodies to the documented endpoints", async () => {
  const { f, c } = client(() => ok({ links: [] }));
  await c.acceptClaim("PP-D-9", { note: "Refunding in full", accept_claim_type: "REFUND" });
  await c.sendMessage("PP-D-9", "Tracking is 9405");
  assert.equal(f.calls[1]!.url, "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-9/accept-claim");
  assert.deepEqual(JSON.parse(f.calls[1]!.body), { note: "Refunding in full", accept_claim_type: "REFUND" });
  assert.equal(f.calls[2]!.url, "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-9/send-message");
  assert.deepEqual(JSON.parse(f.calls[2]!.body), { message: "Tracking is 9405" });
  await assert.rejects(c.acceptClaim("PP-D-9", { note: "  " }), /note is required/);
});

test("orders, transaction search, tracking and webhook verification hit the right paths", async () => {
  const { f, c } = client((call) => {
    if (call.url.includes("/v1/notifications/verify-webhook-signature")) return ok({ verification_status: "SUCCESS" });
    if (call.url.includes("/v1/shipping/trackers")) return ok({ trackers: [{ transaction_id: "TX1234567890", status: "DELIVERED" }] });
    if (call.url.includes("/v1/reporting/transactions")) return ok({ transaction_details: [] });
    return ok({ id: "5O190127TN364715T", status: "COMPLETED", purchase_units: [] });
  });
  await c.getOrder("5O190127TN364715T");
  await c.searchTransactions({ transaction_id: "TX1234567890", start_date: "2026-09-01T00:00:00Z", end_date: "2026-09-30T00:00:00Z" });
  const t = await c.listTrackers("TX1234567890");
  const v = await c.verifyWebhookSignature({ authAlgo: "SHA256withRSA", certUrl: "https://api.sandbox.paypal.com/c", transmissionId: "t1", transmissionSig: "sig", transmissionTime: "2026-10-10T00:00:00Z" }, "WH-1", { id: "e", create_time: "", resource_type: "dispute", event_type: "CUSTOMER.DISPUTE.CREATED", resource: {} });
  assert.equal(f.calls[1]!.url, "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T");
  assert.match(f.calls[2]!.url, /\/v1\/reporting\/transactions\?transaction_id=TX1234567890&start_date=.*&end_date=.*&fields=all$/);
  assert.equal(f.calls[3]!.url, "https://api-m.sandbox.paypal.com/v1/shipping/trackers?transaction_id=TX1234567890");
  assert.equal(t.trackers[0]!.status, "DELIVERED");
  assert.equal(v, true);
  assert.deepEqual(Object.keys(JSON.parse(f.calls[4]!.body)).sort(), ["auth_algo", "cert_url", "transmission_id", "transmission_sig", "transmission_time", "webhook_event", "webhook_id"]);
});

test("PayPal error bodies become PayPalApiError with issue and debug_id", async () => {
  const { c } = client(() => new Response(JSON.stringify({ name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed", debug_id: "abc123", details: [{ issue: "INVALID_DISPUTE_STATE", description: "Dispute is not in a valid state" }] }), { status: 422 }));
  await assert.rejects(c.acceptClaim("PP-D-1", { note: "x" }), (e: unknown) => {
    assert.ok(e instanceof PayPalApiError);
    assert.equal(e.status, 422);
    assert.equal(e.issue, "INVALID_DISPUTE_STATE");
    assert.equal(e.debugId, "abc123");
    return true;
  });
});

test("ids are validated before they reach a URL", async () => {
  const { c } = client(() => ok({}));
  await assert.rejects(c.getDispute("../v1/oauth2/token"), /Invalid PayPal id/);
});

test("gateway factory: mock without credentials, sandbox with, live refused", () => {
  assert.equal(createPayPalGateway({}).mode, "mock");
  assert.equal(createPayPalGateway({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" }).mode, "sandbox");
  assert.throws(() => createPayPalGateway({ PAYPAL_ENV: "live", PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" }), /only talks to the PayPal sandbox/);
});

test("buildMultipart produces a well-formed body", () => {
  const { body, contentType } = buildMultipart([{ name: "input", contentType: "application/json", data: "{}" }], "B");
  assert.equal(contentType, "multipart/form-data; boundary=B");
  assert.equal(new TextDecoder().decode(body), '--B\r\nContent-Disposition: form-data; name="input"\r\nContent-Type: application/json\r\n\r\n{}\r\n--B--\r\n');
});
