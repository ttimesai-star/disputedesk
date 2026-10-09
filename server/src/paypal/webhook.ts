import { createVerify } from "node:crypto";
import type { WebhookHeaders } from "./types.ts";

/** Dispute webhook event types (developer.paypal.com/api/rest/webhooks/event-names/#disputes). */
export const DISPUTE_EVENTS = ["CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED"] as const;

/** Reads the PAYPAL-* transmission headers. Returns null when any is missing. */
export function readWebhookHeaders(get: (name: string) => string | undefined): WebhookHeaders | null {
  const h = {
    authAlgo: get("paypal-auth-algo"),
    certUrl: get("paypal-cert-url"),
    transmissionId: get("paypal-transmission-id"),
    transmissionSig: get("paypal-transmission-sig"),
    transmissionTime: get("paypal-transmission-time"),
  };
  return Object.values(h).every((v) => typeof v === "string" && v.length > 0) ? (h as WebhookHeaders) : null;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Only certificates served by PayPal over HTTPS are trusted. */
export function isTrustedCertUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "api.paypal.com" || u.hostname === "api.sandbox.paypal.com" || u.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

export interface OfflineVerifyOptions {
  /** Downloads the PEM certificate (or public key) from cert_url. Injected for tests and caching. */
  fetchCert: (url: string) => Promise<string>;
  /** Reject transmissions older than this (replay protection). Default 10 minutes. */
  maxAgeMs?: number;
  now?: () => number;
  /** Optional set of seen transmission IDs to reject replayed webhooks. */
  seenTransmissionIds?: Set<string>;
}

/**
 * Self-verification as documented by PayPal ("verify signature locally"):
 *   message   = `${transmission_id}|${transmission_time}|${webhook_id}|${crc32(raw_body)}`
 *   signature = base64 SHA256withRSA over message, checked with the certificate at cert_url.
 * Must be given the raw request body, not re-serialized JSON.
 */
export async function verifyWebhookOffline(h: WebhookHeaders, webhookId: string, rawBody: Uint8Array, opts: OfflineVerifyOptions): Promise<boolean> {
  if (h.authAlgo !== "SHA256withRSA") return false;
  if (!isTrustedCertUrl(h.certUrl)) return false;
  if (opts.seenTransmissionIds?.has(h.transmissionId)) return false;
  const sent = Date.parse(h.transmissionTime);
  const now = (opts.now ?? Date.now)();
  if (Number.isNaN(sent) || Math.abs(now - sent) > (opts.maxAgeMs ?? 10 * 60_000)) return false;
  const pem = await opts.fetchCert(h.certUrl);
  const message = `${h.transmissionId}|${h.transmissionTime}|${webhookId}|${crc32(rawBody)}`;
  try {
    const ok = createVerify("RSA-SHA256").update(message).verify(pem, h.transmissionSig, "base64");
    if (ok && opts.seenTransmissionIds) {
      if (opts.seenTransmissionIds.size >= 1000) {
        const first = opts.seenTransmissionIds.keys().next().value;
        if (first !== undefined) opts.seenTransmissionIds.delete(first);
      }
      opts.seenTransmissionIds.add(h.transmissionId);
    }
    return ok;
  } catch {
    return false;
  }
}

/** Fetches a PayPal certificate with a size-bounded in-memory cache (max 100 entries). */
export function cachedCertFetcher(fetchImpl: typeof fetch = fetch, maxCacheSize = 100): (url: string) => Promise<string> {
  const cache = new Map<string, string>();
  return async (url) => {
    const hit = cache.get(url);
    if (hit) return hit;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Certificate download failed: HTTP ${res.status}`);
    const pem = await res.text();
    if (cache.size >= maxCacheSize) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(url, pem);
    return pem;
  };
}
