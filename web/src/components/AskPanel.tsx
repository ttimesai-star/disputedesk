import { useState } from "react";
import { api } from "../api.ts";

export function AskPanel({ enabled }: { enabled: boolean }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; tools: string[]; provider: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.ask(q);
      setAnswer({ text: r.answer, tools: r.toolCalls.map((t) => t.name), provider: r.provider });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ask">
      <h3>Ask about your disputes</h3>
      <p className="muted small">Read-only research agent built on the PayPal Agent Toolkit tools (disputes, orders, transactions, tracking).</p>
      <form
        className="querybar"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder='e.g. "Which buyer opened the vase dispute and what did they say?"' disabled={!enabled} aria-label="Question" />
        <button type="submit" disabled={!enabled || busy}>{busy ? "Thinking..." : "Ask"}</button>
      </form>
      {!enabled && <p className="muted small">Needs GEMINI_API_KEY or GROQ_API_KEY.</p>}
      {err && <div className="banner error">{err}</div>}
      {answer && (
        <div className="answer">
          <p>{answer.text}</p>
          <div className="muted small">
            Tools used: {answer.tools.length ? answer.tools.join(", ") : "none"} {answer.provider ? `· ${answer.provider}` : ""}
          </div>
        </div>
      )}
    </section>
  );
}
