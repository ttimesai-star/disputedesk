import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { cachedCertFetcher, crc32, isTrustedCertUrl, readWebhookHeaders, verifyWebhookOffline } from "../src/paypal/webhook.ts";
import { MockPayPalClient, signMockWebhook } from "../src/paypal/mock.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

function signed(body: string, opts: { webhookId?: string; time?: string } = {}) {
  const time = opts.time ?? "2026-10-10T12:00:00Z";
  const msg = `tid-1|${time}|${opts.webhookId ?? "WH-1"}|${crc32(new TextEncoder().encode(body))}`;
  const sig = createSign("RSA-SHA256").update(msg).sign(privateKey, "base64");
  return { authAlgo: "SHA256withRSA", certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", transmissionId: "tid-1", transmissionSig: sig, transmissionTime: time };
}
const opts = { fetchCert: async () => pem, now: () => Date.parse("2026-10-10T12:01:00Z") };

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("offline verification accepts a correctly signed raw body", async () => {
  const body = '{"event_type":"CUSTOMER.DISPUTE.CREATED"}';
  assert.equal(await verifyWebhookOffline(signed(body), "WH-1", new TextEncoder().encode(body), opts), true);
});

test("offline verification rejects tampering, wrong webhook id, foreign certs and stale messages", async () => {
  const body = '{"event_type":"CUSTOMER.DISPUTE.CREATED"}';
  const h = signed(body);
  const enc = (s: string) => new TextEncoder().encode(s);
  assert.equal(await verifyWebhookOffline(h, "WH-1", enc(body.replace("CREATED", "RESOLVED")), opts), false);
  assert.equal(await verifyWebhookOffline(h, "WH-OTHER", enc(body), opts), false);
  assert.equal(await verifyWebhookOffline({ ...h, certUrl: "https://evil.example.com/cert" }, "WH-1", enc(body), opts), false);
  assert.equal(await verifyWebhookOffline({ ...h, certUrl: "http://api.paypal.com/cert" }, "WH-1", enc(body), opts), false);
  assert.equal(await verifyWebhookOffline({ ...h, authAlgo: "SHA1withRSA" }, "WH-1", enc(body), opts), false);
  const old = signed(body, { time: "2026-10-10T10:00:00Z" });
  assert.equal(await verifyWebhookOffline(old, "WH-1", enc(body), opts), false);
});

test("cachedCertFetcher respects maxCacheSize limit", async () => {
  let fetched = 0;
  const mockFetch = (async (url: RequestInfo | URL) => {
    fetched++;
    return new Response(`pem-${String(url)}`, { status: 200 });
  }) as typeof fetch;
  const fetcher = cachedCertFetcher(mockFetch, 2);
  await fetcher("https://api.sandbox.paypal.com/cert/1");
  await fetcher("https://api.sandbox.paypal.com/cert/2");
  assert.equal(fetched, 2);
  await fetcher("https://api.sandbox.paypal.com/cert/1");
  assert.equal(fetched, 2);
  await fetcher("https://api.sandbox.paypal.com/cert/3");
  assert.equal(fetched, 3);
  await fetcher("https://api.sandbox.paypal.com/cert/1");
  assert.equal(fetched, 4);
});

test("offline verification rejects replayed transmission ids when seenTransmissionIds is passed", async () => {
  const body = '{"event_type":"CUSTOMER.DISPUTE.CREATED"}';
  const seen = new Set<string>();
  const verifyOpts = { ...opts, seenTransmissionIds: seen };
  const h = signed(body);
  assert.equal(await verifyWebhookOffline(h, "WH-1", new TextEncoder().encode(body), verifyOpts), true);
  assert.equal(await verifyWebhookOffline(h, "WH-1", new TextEncoder().encode(body), verifyOpts), false);
});

test("trusted cert hosts are PayPal over https only", () => {
  assert.equal(isTrustedCertUrl("https://api.paypal.com/v1/notifications/certs/X"), true);
  assert.equal(isTrustedCertUrl("https://api.sandbox.paypal.com/v1/notifications/certs/X"), true);
  assert.equal(isTrustedCertUrl("https://paypal.com.evil.io/x"), false);
  assert.equal(isTrustedCertUrl("not a url"), false);
});

test("transmission headers are required", () => {
  const all: Record<string, string> = { "paypal-auth-algo": "a", "paypal-cert-url": "b", "paypal-transmission-id": "c", "paypal-transmission-sig": "d", "paypal-transmission-time": "e" };
  assert.ok(readWebhookHeaders((n) => all[n]));
  const missing = { ...all, "paypal-transmission-sig": "" };
  assert.equal(readWebhookHeaders((n) => missing[n as keyof typeof missing]), null);
});

test("mock gateway verifies its own simulated signatures only", async () => {
  const mock = new MockPayPalClient();
  const event = { id: "e1", create_time: "", resource_type: "dispute", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-D-1" } };
  const sig = signMockWebhook("t", "time", "WH", JSON.stringify(event));
  const h = { authAlgo: "SHA256withRSA", certUrl: "https://api.sandbox.paypal.com/c", transmissionId: "t", transmissionSig: sig, transmissionTime: "time" };
  assert.equal(await mock.verifyWebhookSignature(h, "WH", event), true);
  assert.equal(await mock.verifyWebhookSignature({ ...h, transmissionSig: "forged" }, "WH", event), false);
  assert.equal(await mock.verifyWebhookSignature(h, "WH", { ...event, event_type: "CUSTOMER.DISPUTE.RESOLVED" }), false);
});
