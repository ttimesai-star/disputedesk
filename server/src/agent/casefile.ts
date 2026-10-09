import type { PayPalGateway } from "../paypal/client.ts";
import type { Dispute, Order, Tracker, TransactionDetail } from "../paypal/types.ts";
import type { CaseFacts, TimelineEvent } from "../shared.ts";

export interface CaseFile {
  dispute: Dispute;
  order: Order | null;
  transactions: TransactionDetail[];
  trackers: Tracker[];
  facts: CaseFacts;
  timeline: TimelineEvent[];
  /** What we tried to load and could not (shown to the seller, fed to the LLM as unknowns). */
  dataGaps: string[];
}

const ORDER_ID = /^[A-Z0-9]{17,32}$/;
const DAY = 86_400_000;

/**
 * Collects everything PayPal knows about one dispute:
 *   Disputes v1 (claim, messages, deadlines) -> Transaction Search (payment, refunds, address status)
 *   -> Orders v2 (items, listing description) -> Shipment Tracking (carrier, delivery status).
 * Each source is optional: a failure becomes a data gap instead of failing the whole case.
 */
export async function buildCaseFile(paypal: PayPalGateway, disputeId: string, now: Date = new Date()): Promise<CaseFile> {
  const dispute = await paypal.getDispute(disputeId);
  const tx = dispute.disputed_transactions[0];
  const sellerTxId = tx?.seller_transaction_id ?? null;
  const dataGaps: string[] = [];

  let transactions: TransactionDetail[] = [];
  let trackers: Tracker[] = [];
  let order: Order | null = null;

  if (sellerTxId) {
    const created = Date.parse(tx?.create_time ?? dispute.create_time);
    // Transaction Search allows at most 31 days per request. Walk 30-day windows from just before
    // the payment to today (max 3) so later refunds and reversals are found too.
    const windows: { start: Date; end: Date }[] = [];
    for (let s = created - 2 * DAY; s < now.getTime() && windows.length < 3; s += 30 * DAY) {
      windows.push({ start: new Date(s), end: new Date(Math.min(s + 30 * DAY, now.getTime())) });
    }
    const [txRes, trRes] = await Promise.allSettled([
      Promise.all(windows.map((w) => paypal.searchTransactions({ transaction_id: sellerTxId, start_date: w.start.toISOString(), end_date: w.end.toISOString() }))),
      paypal.listTrackers(sellerTxId),
    ]);
    if (txRes.status === "fulfilled") {
      const seen = new Map<string, TransactionDetail>();
      for (const r of txRes.value) for (const t of r.transaction_details) seen.set(t.transaction_info.transaction_id, t);
      transactions = [...seen.values()];
    } else dataGaps.push(`Transaction Search: ${errMsg(txRes.reason)}`);
    if (trRes.status === "fulfilled") trackers = trRes.value.trackers;
    else dataGaps.push(`Shipment Tracking: ${errMsg(trRes.reason)}`);
  } else {
    dataGaps.push("Dispute has no seller transaction id");
  }

  // Merchants put their PayPal order id into custom_id at checkout; it comes back as `custom`.
  const orderId = [tx?.custom, transactions[0]?.transaction_info.custom_field].find((v): v is string => typeof v === "string" && ORDER_ID.test(v)) ?? null;
  if (orderId) {
    try {
      order = await paypal.getOrder(orderId);
    } catch (e) {
      dataGaps.push(`Orders v2: ${errMsg(e)}`);
    }
  } else {
    dataGaps.push("Order id not linked (set custom_id to the order id at checkout)");
  }

  const facts = deriveFacts(dispute, order, transactions, trackers, sellerTxId, orderId, now);
  const timeline = buildTimeline(dispute, order, transactions, trackers, sellerTxId);
  return { dispute, order, transactions, trackers, facts, timeline, dataGaps };
}

export function deriveFacts(
  dispute: Dispute,
  order: Order | null,
  transactions: TransactionDetail[],
  trackers: Tracker[],
  sellerTxId: string | null,
  orderId: string | null,
  now: Date,
): CaseFacts {
  const payment = transactions.find((t) => t.transaction_info.transaction_id === sellerTxId);
  const refunds = transactions.filter((t) => t.transaction_info.paypal_reference_id === sellerTxId && Number(t.transaction_info.transaction_amount?.value ?? 0) < 0);
  const items = order?.purchase_units.flatMap((u) => u.items ?? []) ?? [];
  const digital = items.length > 0 ? items.every((i) => i.category === "DIGITAL_GOODS") : !order?.purchase_units.some((u) => u.shipping);
  const due = dispute.seller_response_due_date ? Date.parse(dispute.seller_response_due_date) : NaN;
  const statuses = trackers.map((t) => t.status);
  const messages = dispute.messages ?? [];
  return {
    amount: Number(dispute.dispute_amount.value),
    currency: dispute.dispute_amount.currency_code,
    reason: dispute.reason,
    stage: dispute.dispute_life_cycle_stage ?? "UNKNOWN",
    channel: dispute.dispute_channel ?? "UNKNOWN",
    status: dispute.status,
    daysToDue: Number.isNaN(due) ? null : Math.ceil((due - now.getTime()) / DAY),
    digital,
    hasTracking: trackers.some((t) => !!t.tracking_number),
    delivered: statuses.some((s) => s === "DELIVERED" || s === "DELIVERED_BY_SELLER" || s === "LOCAL_PICKUP"),
    inTransit: statuses.some((s) => s === "SHIPPED" || s === "IN_TRANSIT" || s === "DROPPED_OFF" || s === "DELIVERY_SCHEDULED" || s === "DELIVERY_DELAYED"),
    returned: statuses.includes("RETURNED"),
    carrier: trackers[0]?.carrier ?? null,
    trackingNumbers: trackers.map((t) => t.tracking_number).filter((v): v is string => !!v),
    refundIds: refunds.map((r) => r.transaction_info.transaction_id),
    addressConfirmed: payment?.payer_info?.address_status === "Y",
    // protection_eligibility "01" = eligible, "02" = partially eligible (Transaction Search docs)
    protectionEligible: payment?.transaction_info.protection_eligibility === "01",
    itemDescription: items.map((i) => i.description ?? i.name).join("; ") || order?.purchase_units[0]?.description || null,
    buyerMessages: messages.filter((m) => m.posted_by === "BUYER").length,
    sellerReplied: messages.some((m) => m.posted_by === "SELLER"),
    orderId,
  };
}

export function buildTimeline(dispute: Dispute, order: Order | null, transactions: TransactionDetail[], trackers: Tracker[], sellerTxId: string | null): TimelineEvent[] {
  const ev: TimelineEvent[] = [];
  if (order?.create_time) {
    const items = order.purchase_units.flatMap((u) => u.items ?? []).map((i) => `${i.quantity} x ${i.name}`).join(", ");
    ev.push({ at: order.create_time, kind: "order", title: `Order ${order.id} ${order.status.toLowerCase()}`, detail: items || undefined, source: "orders" });
  }
  for (const t of transactions) {
    const i = t.transaction_info;
    const at = i.transaction_initiation_date;
    if (!at) continue;
    const amt = i.transaction_amount ? `${i.transaction_amount.value} ${i.transaction_amount.currency_code}` : "";
    if (i.transaction_id === sellerTxId) {
      const addr = t.payer_info?.address_status === "Y" ? "confirmed address" : "unconfirmed address";
      ev.push({ at, kind: "payment", title: `Payment captured ${amt}`, detail: `Transaction ${i.transaction_id}, buyer ${t.payer_info?.email_address ?? "unknown"}, ${addr}`, source: "transactions" });
    } else if (Number(i.transaction_amount?.value ?? 0) < 0) {
      ev.push({ at, kind: "refund", title: `Refund issued ${amt}`, detail: `Refund transaction ${i.transaction_id}`, source: "transactions" });
    }
  }
  for (const t of trackers) {
    if (t.shipment_date) ev.push({ at: t.shipment_date, kind: "shipment", title: `Shipped via ${t.carrier ?? t.carrier_name_other ?? "carrier"}`, detail: t.tracking_number ? `Tracking ${t.tracking_number}` : undefined, source: "tracking" });
    if (t.last_updated_time && t.status !== "SHIPPED") {
      const kind = t.status === "DELIVERED" ? "delivery" : t.status === "RETURNED" ? "return" : "shipment";
      ev.push({ at: t.last_updated_time, kind, title: `Carrier status: ${t.status.replace(/_/g, " ").toLowerCase()}`, detail: t.tracking_number, source: "tracking" });
    }
  }
  ev.push({ at: dispute.create_time, kind: "dispute", title: `Dispute opened: ${humanReason(dispute.reason)}`, detail: `${dispute.dispute_life_cycle_stage ?? ""} via ${dispute.dispute_channel ?? "PayPal"}`.trim(), source: "disputes" });
  for (const m of dispute.messages ?? []) {
    ev.push({ at: m.time_posted, kind: "message", title: `${m.posted_by === "BUYER" ? "Buyer" : m.posted_by === "SELLER" ? "Seller" : "PayPal"} wrote`, detail: m.content, source: "disputes" });
  }
  for (const e of dispute.evidences ?? []) {
    if (e.date) ev.push({ at: e.date, kind: "evidence", title: `Evidence ${e.evidence_type.replace(/_/g, " ").toLowerCase()}`, detail: e.notes, source: "disputes" });
  }
  if (dispute.dispute_outcome) {
    ev.push({ at: dispute.update_time, kind: "resolution", title: `Resolved: ${dispute.dispute_outcome.outcome_code.replace(/_/g, " ").toLowerCase()}`, source: "disputes" });
  } else if (dispute.seller_response_due_date) {
    ev.push({ at: dispute.seller_response_due_date, kind: "deadline", title: "Seller response due", source: "disputes" });
  }
  return ev.sort((a, b) => a.at.localeCompare(b.at));
}

export function humanReason(reason: string): string {
  const map: Record<string, string> = {
    MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "item not received",
    MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "not as described",
    UNAUTHORISED: "unauthorized payment",
    CREDIT_NOT_PROCESSED: "refund not processed",
    DUPLICATE_TRANSACTION: "duplicate charge",
    INCORRECT_AMOUNT: "incorrect amount",
    PAYMENT_BY_OTHER_MEANS: "paid by other means",
    CANCELED_RECURRING_BILLING: "canceled subscription billed",
    PROBLEM_WITH_REMITTANCE: "remittance problem",
    OTHER: "other",
  };
  return map[reason] ?? reason.toLowerCase();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
