import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditEntry } from "../shared.ts";

/** Append-only journal of every action taken by the agent, the seller or a webhook. */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private readonly file: string | null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? join(dataDir, "audit.jsonl") : null;
    if (this.file && dataDir) {
      mkdirSync(dataDir, { recursive: true });
      if (existsSync(this.file)) {
        for (const line of readFileSync(this.file, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            this.entries.push(JSON.parse(line) as AuditEntry);
          } catch {
            // skip a torn line rather than refusing to start
          }
        }
      }
    }
  }

  record(e: Omit<AuditEntry, "id" | "at">): AuditEntry {
    const entry: AuditEntry = { id: randomUUID(), at: new Date().toISOString(), ...e };
    this.entries.push(entry);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  list(limit = 200): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  /** Sum refunded automatically by the agent since the start of the current UTC day. */
  autoAcceptedToday(now: Date = new Date()): number {
    const day = now.toISOString().slice(0, 10);
    return this.entries
      .filter((e) => e.actor === "agent" && e.action === "accept-claim" && e.outcome === "ok" && e.at.startsWith(day))
      .reduce((s, e) => s + Number(e.amount?.value ?? 0), 0);
  }
}
