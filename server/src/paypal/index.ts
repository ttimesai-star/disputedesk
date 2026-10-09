import type { PayPalGateway } from "./client.ts";
import { HttpPayPalClient, SANDBOX_BASE_URL } from "./http.ts";
import { MockPayPalClient } from "./mock.ts";

export * from "./client.ts";
export type * from "./types.ts";

/**
 * PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET set  -> sandbox REST client
 * otherwise                                   -> in-memory mock with the demo shop
 * Live mode is refused: this is a hackathon build and must never move real money.
 */
export function createPayPalGateway(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): PayPalGateway {
  const target = (env.PAYPAL_ENV ?? "sandbox").toLowerCase();
  if (target !== "sandbox") throw new Error(`PAYPAL_ENV=${env.PAYPAL_ENV} is not supported; DisputeDesk only talks to the PayPal sandbox.`);
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    return new HttpPayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, baseUrl: SANDBOX_BASE_URL, fetchImpl });
  }
  return new MockPayPalClient();
}
