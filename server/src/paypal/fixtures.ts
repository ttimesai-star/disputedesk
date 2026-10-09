// Demo store for mock mode: a small online shop ("Northwind Ceramics") with a dozen
// disputes covering every common reason. Shapes follow the official PayPal schemas;
// dates are relative to `now` so deadlines in the demo always look live.

import type { Dispute, Order, Tracker, TransactionDetail, DisputeReason, DisputeStatus, DisputeLifecycleStage, DisputeChannel, DisputeMessage } from "./types.ts";

export interface MockStore {
  disputes: Map<string, Dispute>;
  orders: Map<string, Order>;
  transactions: Map<string, TransactionDetail>;
  trackers: Map<string, Tracker[]>;
}

interface Scenario {
  n: number;
  reason: DisputeReason;
  status: DisputeStatus;
  stage: DisputeLifecycleStage;
  channel: DisputeChannel;
  amount: string;
  item: string;
  category: "PHYSICAL_GOODS" | "DIGITAL_GOODS";
  buyer: string;
  country: string;
  paidDaysAgo: number;
  openedDaysAgo: number;
  dueInDays: number | null;
  tracking: Omit<Tracker, "transaction_id"> | null;
  messages: [DisputeMessage["posted_by"], number, string][];
  refunded?: boolean;
  addressConfirmed?: boolean;
  resolved?: "RESOLVED_SELLER_FAVOUR" | "RESOLVED_BUYER_FAVOUR";
  description?: string;
}

const SCENARIOS: Scenario[] = [
  {
    n: 1, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE", stage: "CHARGEBACK", channel: "INTERNAL",
    amount: "129.00", item: "Stoneware dinner set (4 pcs)", category: "PHYSICAL_GOODS", buyer: "Emily Carter", country: "US",
    paidDaysAgo: 21, openedDaysAgo: 4, dueInDays: 6, addressConfirmed: true,
    tracking: { tracking_number: "9405511899223197428490", carrier: "USPS", status: "DELIVERED", shipment_date: "", tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9405511899223197428490" },
    messages: [["BUYER", 4, "I never got my plates. Where is my order?"]],
  },
  {
    n: 2, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", channel: "INTERNAL",
    amount: "18.50", item: "Glazed espresso cup", category: "PHYSICAL_GOODS", buyer: "Lucas Moreau", country: "FR",
    paidDaysAgo: 30, openedDaysAgo: 6, dueInDays: 2, tracking: null,
    messages: [["BUYER", 6, "Ordered a month ago, nothing arrived and no tracking was ever sent."]],
  },
  {
    n: 3, reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", status: "WAITING_FOR_SELLER_RESPONSE", stage: "CHARGEBACK", channel: "INTERNAL",
    amount: "240.00", item: "Hand-thrown floor vase, 60 cm", category: "PHYSICAL_GOODS", buyer: "Hannah Schmidt", country: "DE",
    paidDaysAgo: 25, openedDaysAgo: 3, dueInDays: 7, addressConfirmed: true,
    description: "Hand-thrown floor vase, 60 cm, reactive glaze. Each piece is unique; color varies from the photo.",
    tracking: { tracking_number: "1Z999AA10123456784", carrier: "UPS", status: "DELIVERED", shipment_date: "" },
    messages: [["BUYER", 3, "The color is darker than in the photos. Not what I expected."], ["SELLER", 2, "Our listing notes that every reactive glaze is unique. Happy to offer a partial refund."]],
  },
  {
    n: 4, reason: "UNAUTHORISED", status: "UNDER_REVIEW", stage: "CHARGEBACK", channel: "EXTERNAL",
    amount: "560.00", item: "Custom tea service, 12 pcs", category: "PHYSICAL_GOODS", buyer: "Daniel Okafor", country: "GB",
    paidDaysAgo: 40, openedDaysAgo: 9, dueInDays: 3, addressConfirmed: true,
    tracking: { tracking_number: "JD014600003828384852", carrier: "ROYAL_MAIL", status: "DELIVERED", shipment_date: "" },
    messages: [],
  },
  {
    n: 5, reason: "CREDIT_NOT_PROCESSED", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", channel: "INTERNAL",
    amount: "64.00", item: "Set of 2 ramen bowls (returned)", category: "PHYSICAL_GOODS", buyer: "Sofia Rossi", country: "IT",
    paidDaysAgo: 35, openedDaysAgo: 2, dueInDays: 8, refunded: true,
    tracking: { tracking_number: "RR123456785IT", carrier: "POSTE_ITALIANE", status: "RETURNED", shipment_date: "" },
    messages: [["BUYER", 2, "I sent the bowls back two weeks ago and still have no refund."]],
  },
  {
    n: 6, reason: "DUPLICATE_TRANSACTION", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", channel: "INTERNAL",
    amount: "45.00", item: "Ceramic planter (charged twice)", category: "PHYSICAL_GOODS", buyer: "Mia Johansson", country: "SE",
    paidDaysAgo: 12, openedDaysAgo: 1, dueInDays: 9, tracking: null,
    messages: [["BUYER", 1, "I was charged twice for the same planter, please refund one."]],
  },
  {
    n: 7, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", channel: "INTERNAL",
    amount: "89.00", item: "Serving platter, speckled", category: "PHYSICAL_GOODS", buyer: "Noah Williams", country: "US",
    paidDaysAgo: 6, openedDaysAgo: 1, dueInDays: 12,
    tracking: { tracking_number: "9400111899561234567890", carrier: "USPS", status: "IN_TRANSIT", shipment_date: "" },
    messages: [["BUYER", 1, "Still not here, is it lost?"]],
  },
  {
    n: 8, reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", channel: "INTERNAL",
    amount: "12.00", item: "Spoon rest", category: "PHYSICAL_GOODS", buyer: "Chloe Martin", country: "CA",
    paidDaysAgo: 15, openedDaysAgo: 2, dueInDays: 5,
    tracking: { tracking_number: "7023210039414", carrier: "CANADA_POST", status: "DELIVERED", shipment_date: "" },
    messages: [["BUYER", 2, "Arrived with a chip on the edge."]],
  },
  {
    n: 9, reason: "INCORRECT_AMOUNT", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", channel: "INTERNAL",
    amount: "15.00", item: "Shipping overcharge on mug set", category: "PHYSICAL_GOODS", buyer: "Liam Brown", country: "AU",
    paidDaysAgo: 10, openedDaysAgo: 3, dueInDays: 4,
    tracking: { tracking_number: "33AUS0000000001", carrier: "AUSTRALIA_POST", status: "DELIVERED", shipment_date: "" },
    messages: [["BUYER", 3, "Checkout showed $8 shipping but I was charged $23."]],
  },
  {
    n: 10, reason: "CANCELED_RECURRING_BILLING", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", channel: "INTERNAL",
    amount: "9.99", item: "Glaze-of-the-month club (monthly)", category: "DIGITAL_GOODS", buyer: "Ava Nguyen", country: "US",
    paidDaysAgo: 5, openedDaysAgo: 1, dueInDays: 10, tracking: null,
    messages: [["BUYER", 1, "I cancelled the membership last month but was billed again."]],
  },
  {
    n: 11, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE", stage: "CHARGEBACK", channel: "INTERNAL",
    amount: "49.00", item: "Online wheel-throwing course (video)", category: "DIGITAL_GOODS", buyer: "Ethan Kim", country: "KR",
    paidDaysAgo: 18, openedDaysAgo: 5, dueInDays: 1, tracking: null,
    messages: [["BUYER", 5, "Never got access to the course."]],
    description: "Online wheel-throwing course, 14 video lessons. Access link e-mailed after payment; download log available.",
  },
  {
    n: 12, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "RESOLVED", stage: "CHARGEBACK", channel: "INTERNAL",
    amount: "75.00", item: "Pair of candle holders", category: "PHYSICAL_GOODS", buyer: "Grace Lee", country: "US",
    paidDaysAgo: 60, openedDaysAgo: 30, dueInDays: null, resolved: "RESOLVED_SELLER_FAVOUR",
    tracking: { tracking_number: "9405511899223100000012", carrier: "USPS", status: "DELIVERED", shipment_date: "" },
    messages: [["BUYER", 30, "Item not received."], ["SELLER", 29, "Tracking shows delivered to your confirmed address."]],
  },
];

const ALNUM = "ABCDEFGHJKLMNPRSTUVWXY0123456789";
/** Deterministic 17-character PayPal-style id. */
function pid(seed: number, salt: number): string {
  // xorshift32 seeded from (seed, salt); Math.imul keeps the arithmetic in 32-bit integers.
  let x = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0 || 1;
  let out = "";
  for (let i = 0; i < 17; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += ALNUM[x % ALNUM.length];
  }
  return out;
}

export function disputeIdFor(n: number): string {
  return `PP-D-${String(41000 + n * 137)}`;
}

export function buildMockStore(now: Date = new Date()): MockStore {
  const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  const store: MockStore = { disputes: new Map(), orders: new Map(), transactions: new Map(), trackers: new Map() };

  for (const s of SCENARIOS) {
    const orderId = pid(s.n, 1);
    const captureId = pid(s.n, 2);
    const disputeId = disputeIdFor(s.n);
    const money = { currency_code: "USD", value: s.amount };
    const [given, surname] = s.buyer.split(" ");
    const email = `${s.buyer.toLowerCase().replace(" ", ".")}@example.com`;

    store.orders.set(orderId, {
      id: orderId,
      status: "COMPLETED",
      intent: "CAPTURE",
      create_time: iso(s.paidDaysAgo),
      update_time: iso(s.paidDaysAgo),
      payer: { email_address: email, payer_id: pid(s.n, 3).slice(0, 13), name: { given_name: given, surname } },
      purchase_units: [
        {
          reference_id: "default",
          description: s.item,
          invoice_id: `NWC-${10200 + s.n}`,
          amount: money,
          items: [{ name: s.item, quantity: "1", unit_amount: money, category: s.category, description: s.description }],
          shipping: s.category === "PHYSICAL_GOODS" ? { name: { full_name: s.buyer }, address: { address_line_1: "1 Example St", admin_area_2: "Springfield", postal_code: "00000", country_code: s.country } } : undefined,
          payments: { captures: [{ id: captureId, status: s.refunded ? "REFUNDED" : "COMPLETED", amount: money, create_time: iso(s.paidDaysAgo), final_capture: true }] },
        },
      ],
    });

    store.transactions.set(captureId, {
      transaction_info: {
        transaction_id: captureId,
        transaction_event_code: "T0006",
        transaction_initiation_date: iso(s.paidDaysAgo),
        transaction_updated_date: iso(s.paidDaysAgo),
        transaction_amount: money,
        fee_amount: { currency_code: "USD", value: (-(Number(s.amount) * 0.0349 + 0.49)).toFixed(2) },
        transaction_status: "S",
        transaction_subject: s.item,
        invoice_id: `NWC-${10200 + s.n}`,
        custom_field: orderId,
        protection_eligibility: s.category === "PHYSICAL_GOODS" && s.addressConfirmed ? "01" : "02",
      },
      payer_info: { account_id: pid(s.n, 3).slice(0, 13), email_address: email, address_status: s.addressConfirmed ? "Y" : "N", payer_status: "Y", country_code: s.country, payer_name: { given_name: given, surname } },
      shipping_info: s.category === "PHYSICAL_GOODS" ? { name: s.buyer, address: { line1: "1 Example St", city: "Springfield", country_code: s.country, postal_code: "00000" } } : undefined,
      cart_info: { item_details: [{ item_code: `SKU-${s.n}`, item_name: s.item, item_quantity: "1", item_amount: money }] },
    });
    if (s.refunded) {
      const refundId = pid(s.n, 4);
      store.transactions.set(refundId, {
        transaction_info: {
          transaction_id: refundId,
          paypal_reference_id: captureId,
          transaction_event_code: "T1107",
          transaction_initiation_date: iso(3),
          transaction_amount: { currency_code: "USD", value: `-${s.amount}` },
          transaction_status: "S",
          transaction_subject: `Refund: ${s.item}`,
        },
      });
    }

    if (s.tracking) {
      store.trackers.set(captureId, [{ ...s.tracking, transaction_id: captureId, shipment_date: iso(s.paidDaysAgo - 1).slice(0, 10), last_updated_time: iso(Math.max(0, s.paidDaysAgo - 6)) }]);
    }

    const resolved = s.status === "RESOLVED";
    store.disputes.set(disputeId, {
      dispute_id: disputeId,
      create_time: iso(s.openedDaysAgo),
      update_time: iso(Math.max(0, s.openedDaysAgo - 1)),
      reason: s.reason,
      status: s.status,
      dispute_state: resolved ? "RESOLVED" : s.status === "UNDER_REVIEW" ? "UNDER_PAYPAL_REVIEW" : "REQUIRED_ACTION",
      dispute_amount: money,
      dispute_life_cycle_stage: s.stage,
      dispute_channel: s.channel,
      seller_response_due_date: s.dueInDays === null ? undefined : new Date(now.getTime() + s.dueInDays * 86_400_000).toISOString(),
      disputed_transactions: [
        {
          seller_transaction_id: captureId,
          buyer_transaction_id: pid(s.n, 5),
          create_time: iso(s.paidDaysAgo),
          transaction_status: "COMPLETED",
          gross_amount: money,
          invoice_number: `NWC-${10200 + s.n}`,
          custom: orderId,
          buyer: { name: s.buyer, email },
          seller: { email: "sales@northwind-ceramics.example", name: "Northwind Ceramics" },
          items: [{ item_id: `SKU-${s.n}`, item_description: s.item, item_quantity: "1" }],
        },
      ],
      messages: s.messages.map(([posted_by, d, content]) => ({ posted_by, time_posted: iso(d), content })),
      evidences: resolved ? [{ evidence_type: "PROOF_OF_FULFILLMENT", source: "SUBMITTED_BY_SELLER", date: iso(29), notes: "Tracking attached." }] : [],
      dispute_outcome: s.resolved ? { outcome_code: s.resolved } : undefined,
      allowed_response_options: resolved ? undefined : { accept_claim: { accept_claim_types: s.category === "PHYSICAL_GOODS" ? ["REFUND", "REFUND_WITH_RETURN", "PARTIAL_REFUND"] : ["REFUND", "PARTIAL_REFUND"] } },
      links: [{ href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}`, rel: "self", method: "GET" }],
    });
  }
  return store;
}
