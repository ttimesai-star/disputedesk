import { useState } from "react";
import type { QueryResult } from "../../../server/src/shared.ts";
import { api } from "../api.ts";

const EXAMPLES = ["not received over $100 due this week", "chargebacks worth fighting, biggest first", "win odds below 30%", "duplicate or subscription claims"];

export function QueryBar({ onResult, hasLlm }: { onResult: (r: QueryResult | null) => void; hasLlm: boolean }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (text: string) => {
    if (!text.trim()) return onResult(null);
    setBusy(true);
    setErr(null);
    try {
      onResult(await api.query(text));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="querybar"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(q);
      }}
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Ask the table${hasLlm ? "" : " (keyword mode)"}: e.g. "${EXAMPLES[0]}"`}
        aria-label="Filter disputes in plain English"
        list="query-examples"
      />
      <datalist id="query-examples">
        {EXAMPLES.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <button type="submit" disabled={busy}>{busy ? "..." : "Filter"}</button>
      {err && <span className="error-text">{err}</span>}
    </form>
  );
}
