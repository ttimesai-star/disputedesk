import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISPUTE_REASONS } from "../paypal/types.ts";
import type { PayPalGateway } from "../paypal/client.ts";
import type { CaseView, Policy, PolicySettings } from "../shared.ts";
import type { AuditLog } from "./audit.ts";
import type { DisputePipeline } from "./pipeline.ts";

export const DEFAULT_SETTINGS: PolicySettings = {
  autopilot: false,
  dailyAutoAcceptLimit: 100,
  policies: [
    {
      id: "small-snad",
      name: "Refund small not-as-described claims",
      enabled: true,
      maxAmount: 15,
      reasons: ["MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"],
      maxWinProbability: 0.6,
      action: "ACCEPT",
      dryRun: false,
    },
    {
      id: "duplicates",
      name: "Refund duplicate charges",
      enabled: true,
      maxAmount: 100,
      reasons: ["DUPLICATE_TRANSACTION"],
      maxWinProbability: 0.3,
      action: "ACCEPT",
      dryRun: true,
    },
    {
      id: "in-transit",
      name: "Send tracking on item-not-received inquiries",
      enabled: true,
      maxAmount: 500,
      reasons: ["MERCHANDISE_OR_SERVICE_NOT_RECEIVED"],
      maxWinProbability: 1,
      action: "MESSAGE_BUYER",
      dryRun: false,
    },
  ],
};

export class PolicyStore {
  private settings: PolicySettings;
  private readonly file: string | null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? join(dataDir, "policies.json") : null;
    this.settings = structuredClone(DEFAULT_SETTINGS);
    if (this.file && existsSync(this.file)) {
      try {
        this.settings = validateSettings(JSON.parse(readFileSync(this.file, "utf8")));
      } catch {
        // corrupt file -> defaults (safe: autopilot off)
      }
    }
  }

  get(): PolicySettings {
    return structuredClone(this.settings);
  }

  set(next: unknown): PolicySettings {
    this.settings = validateSettings(next);
    if (this.file) {
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.settings, null, 2));
    }
    return this.get();
  }
}

/** Strict validation: policies control money, so anything malformed is rejected, not coerced. */
export function validateSettings(v: unknown): PolicySettings {
  if (!v || typeof v !== "object") throw new Error("settings must be an object");
  const o = v as Record<string, unknown>;
  if (typeof o.autopilot !== "boolean") throw new Error("autopilot must be boolean");
  const limit = Number(o.dailyAutoAcceptLimit);
  if (!Number.isFinite(limit) || limit < 0 || limit > 100_000) throw new Error("dailyAutoAcceptLimit must be 0..100000");
  if (!Array.isArray(o.policies) || o.policies.length > 50) throw new Error("policies must be an array (max 50)");
  const ids = new Set<string>();
  const policies: Policy[] = o.policies.map((p, i) => {
    const q = p as Record<string, unknown>;
    const id = String(q.id ?? "").trim();
    if (!/^[a-z0-9-]{1,40}$/.test(id) || ids.has(id)) throw new Error(`policy ${i}: id must be unique [a-z0-9-]`);
    ids.add(id);
    const maxAmount = Number(q.maxAmount);
    const maxWin = Number(q.maxWinProbability);
    if (!Number.isFinite(maxAmount) || maxAmount < 0) throw new Error(`policy ${id}: maxAmount must be >= 0`);
    if (!Number.isFinite(maxWin) || maxWin < 0 || maxWin > 1) throw new Error(`policy ${id}: maxWinProbability must be 0..1`);
    if (q.action !== "ACCEPT" && q.action !== "MESSAGE_BUYER") throw new Error(`policy ${id}: action must be ACCEPT or MESSAGE_BUYER`);
    const reasons = Array.isArray(q.reasons) ? q.reasons.map(String) : [];
    for (const r of reasons) if (!(DISPUTE_REASONS as readonly string[]).includes(r)) throw new Error(`policy ${id}: unknown reason ${r}`);
    return {
      id,
      name: String(q.name ?? id).slice(0, 80),
      enabled: q.enabled === true,
      maxAmount,
      reasons: reasons as Policy["reasons"],
      maxWinProbability: maxWin,
      action: q.action,
      dryRun: q.dryRun !== false,
    };
  });
  return { autopilot: o.autopilot, dailyAutoAcceptLimit: limit, policies };
}

/** First enabled policy whose conditions match the analyzed case, or null. */
export function matchPolicy(view: CaseView, settings: PolicySettings): Policy | null {
  const a = view.assessment;
  if (!a || view.dispute.status !== "WAITING_FOR_SELLER_RESPONSE") return null;
  for (const p of settings.policies) {
    if (!p.enabled) continue;
    if (view.facts.amount > p.maxAmount) continue;
    if (p.reasons.length && !p.reasons.includes(view.facts.reason)) continue;
    if (a.winProbability > p.maxWinProbability) continue;
    // A policy may only do what the analysis also recommends: never auto-refund a case the agent says to fight.
    if (p.action === "ACCEPT" && a.recommendation !== "ACCEPT") continue;
    if (p.action === "MESSAGE_BUYER" && a.recommendation !== "MESSAGE_BUYER") continue;
    // Don't message again until the buyer has replied.
    if (p.action === "MESSAGE_BUYER" && view.dispute.messages?.at(-1)?.posted_by === "SELLER") continue;
    return p;
  }
  return null;
}

export interface AutopilotDeps {
  paypal: PayPalGateway;
  pipeline: DisputePipeline;
  policies: PolicyStore;
  audit: AuditLog;
}

/** Runs policies over the given disputes (or all that need seller action). Respects kill switch and daily cap. */
export async function runAutopilot(deps: AutopilotDeps, disputeIds?: string[], actor: "agent" = "agent"): Promise<{ acted: number; skipped: number }> {
  const settings = deps.policies.get();
  if (!settings.autopilot) {
    deps.audit.record({ actor: "system", action: "autopilot", disputeId: null, outcome: "skipped", detail: "Autopilot is off" });
    return { acted: 0, skipped: 0 };
  }
  const ids = disputeIds ?? (await deps.paypal.listDisputes({ dispute_state: "REQUIRED_ACTION" })).items.map((d) => d.dispute_id);
  let acted = 0;
  let skipped = 0;
  for (const id of ids) {
    let view: CaseView;
    try {
      view = await deps.pipeline.analyze(id);
    } catch (e) {
      deps.audit.record({ actor, action: "analyze", disputeId: id, outcome: "error", detail: (e as Error).message });
      continue;
    }
    const policy = matchPolicy(view, settings);
    if (!policy) {
      skipped++;
      continue;
    }
    const a = view.assessment!;
    const amount = view.dispute.dispute_amount;
    if (policy.action === "ACCEPT") {
      const used = deps.audit.autoAcceptedToday();
      if (!policy.dryRun && used + Number(amount.value) > settings.dailyAutoAcceptLimit) {
        deps.audit.record({ actor, action: "accept-claim", disputeId: id, outcome: "skipped", detail: `Policy "${policy.name}" matched but the daily auto-refund cap (${settings.dailyAutoAcceptLimit}) would be exceeded`, amount });
        skipped++;
        continue;
      }
      if (policy.dryRun) {
        deps.audit.record({ actor, action: "accept-claim", disputeId: id, outcome: "dry-run", detail: `Policy "${policy.name}": would accept (${a.acceptType ?? "REFUND"}). ${a.rationale[0] ?? ""}`, amount });
      } else {
        try {
          const allowed = view.dispute.allowed_response_options?.accept_claim?.accept_claim_types;
          const type = a.acceptType && (!allowed || allowed.includes(a.acceptType)) ? a.acceptType : undefined;
          await deps.paypal.acceptClaim(id, { note: a.acceptNote, ...(type ? { accept_claim_type: type } : {}) });
          deps.pipeline.invalidate(id);
          deps.audit.record({ actor, action: "accept-claim", disputeId: id, outcome: "ok", detail: `Policy "${policy.name}": accepted. ${a.rationale[0] ?? ""}`, amount });
        } catch (e) {
          deps.audit.record({ actor, action: "accept-claim", disputeId: id, outcome: "error", detail: (e as Error).message, amount });
        }
      }
    } else {
      if (policy.dryRun) {
        deps.audit.record({ actor, action: "send-message", disputeId: id, outcome: "dry-run", detail: `Policy "${policy.name}": would send "${a.buyerMessage.slice(0, 120)}"` });
      } else {
        try {
          await deps.paypal.sendMessage(id, a.buyerMessage);
          deps.pipeline.invalidate(id);
          deps.audit.record({ actor, action: "send-message", disputeId: id, outcome: "ok", detail: `Policy "${policy.name}": ${a.buyerMessage.slice(0, 160)}` });
        } catch (e) {
          deps.audit.record({ actor, action: "send-message", disputeId: id, outcome: "error", detail: (e as Error).message });
        }
      }
    }
    acted++;
  }
  return { acted, skipped };
}
