# PayPal API notes

Field names, enums and endpoints in `server/src/paypal/` were checked against PayPal's published
OpenAPI specifications (github.com/paypal/paypal-rest-api-specifications, `openapi/*.json`),
retrieved 2026-10-10:

| Spec | Used for |
| --- | --- |
| `customer_disputes_v1.json` | `GET /v1/customer/disputes`, `GET /v1/customer/disputes/{id}`, `POST .../provide-evidence`, `POST .../accept-claim`, `POST .../send-message`; enums `dispute_reason`, `status`, `dispute_state`, `dispute_lifecycle_stage`, `dispute_channel`, `accept_claim_type`, `evidence.evidence_type`, `dispute_outcome.outcome_code` |
| `checkout_orders_v2.json` | `GET /v2/checkout/orders/{id}` |
| `reporting_transactions_v1.json` | `GET /v1/reporting/transactions` (`transaction_id`, `start_date`, `end_date`, `fields`), 31-day maximum range |
| `shipping_shipment_tracking_v1.json` | `GET /v1/shipping/trackers?transaction_id=` returning `{ trackers: [...] }` |
| `notifications_webhooks_v1.json` | `POST /v1/notifications/verify-webhook-signature` (`auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time`, `webhook_id`, `webhook_event`) -> `verification_status` |

## Request bodies

- **provide-evidence**: `multipart/form-data`. The spec lists the file part `evidence-file`; the evidence itself goes
  in a JSON part named `input` (`{ "evidences": [ { "evidence_type", "evidence_info": { "tracking_info" | "refund_ids" }, "notes" } ] }`),
  as in PayPal's integration guide. Each part carries an explicit `Content-Type`, so the client builds the multipart body itself.
- **accept-claim**: JSON `{ note, accept_claim_type?, refund_amount? }`. The spec only documents the optional
  `accept-claim-document` multipart file; the JSON fields follow the API reference page.
- **send-message**: JSON `{ message }`.
- POSTs carry a fresh `PayPal-Request-Id` for idempotent retries.

To confirm in the sandbox once credentials exist: multipart `input` handling for provide-evidence, the accept-claim JSON body,
and how dispute webhooks behave in the Webhooks Simulator.

## Webhook verification

Two modes:
1. `api` (default): `POST /v1/notifications/verify-webhook-signature`.
2. `offline`: PayPal's documented local check. `message = transmission_id|transmission_time|webhook_id|crc32(raw body)`,
   SHA256withRSA against the certificate at `cert_url`. Certificates are only fetched from `https://*.paypal.com`, and
   transmissions older than 10 minutes are rejected.

## @paypal/agent-toolkit 1.11.0 findings

- The `openai` export builds tools from zod schemas. Tools for disputes: `list_disputes`, `get_dispute`, `accept_dispute_claim`.
  There are no tools for provide-evidence or send-message.
- `PayPalClient` uses `https://api.paypal.com` (live) unless `configuration.context.sandbox === true`.
- `acceptDisputeClaimParameters.note` is validated with `DISPUTE_ID_REGEX` (`^[A-Za-z0-9_-]{1,255}$`), so any note
  containing a space fails validation. DisputeDesk does not expose `accept_dispute_claim` to the model.
- The generated JSON schemas include `$schema`, `additionalProperties`, `default`, `pattern` and `anyOf` with `null`/`not` branches.
  Gemini's OpenAI-compatible endpoint accepts only a subset, so `sanitizeSchema()` strips those before sending the tools.

## Linking a dispute to an order

Disputes reference the capture (`seller_transaction_id`), not the order. DisputeDesk expects the merchant to set
`purchase_units[].custom_id` to the PayPal order id at checkout; it comes back as `disputed_transactions[].custom`
and as `transaction_info.custom_field` in Transaction Search. Without it, the order is a listed data gap.
