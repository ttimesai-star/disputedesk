import { useCallback, useEffect, useState } from "react";
import type { DisputeRow, HealthInfo, QueryResult } from "../../server/src/shared.ts";
import { api } from "./api.ts";
import { DisputesGrid } from "./components/DisputesGrid.tsx";
import { DisputeCard } from "./components/DisputeCard.tsx";
import { QueryBar } from "./components/QueryBar.tsx";
import { PoliciesPanel } from "./components/PoliciesPanel.tsx";
import { AuditLog } from "./components/AuditLog.tsx";
import { AskPanel } from "./components/AskPanel.tsx";

type Tab = "disputes" | "policies" | "log";

export function App() {
  const [tab, setTab] = useState<Tab>("disputes");
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [rows, setRows] = useState<DisputeRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState<QueryResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await api.disputes());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch((e: Error) => setError(e.message));
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const analyzeAll = async () => {
    setBusy("Analyzing open disputes...");
    try {
      const r = await api.analyzeAll();
      setToast(`${r.analyzed} disputes analyzed`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const simulate = async () => {
    setBusy("Simulating CUSTOMER.DISPUTE.CREATED webhook...");
    try {
      const r = await api.simulate();
      // The webhook is processed in the background; give it a moment, then refresh.
      await new Promise((res) => setTimeout(res, 1500));
      await refresh();
      setSelected(r.dispute_id);
      setToast(`Webhook received: new dispute ${r.dispute_id}. See the agent log for what happened.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const open = rows?.filter((r) => r.status === "WAITING_FOR_SELLER_RESPONSE") ?? [];
  const atRisk = open.reduce((s, r) => s + r.amount, 0);
  const urgent = open.filter((r) => r.dueInDays !== null && r.dueInDays <= 2).length;
  const fight = open.filter((r) => r.recommendation === "FIGHT").length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="26" height="26"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M9 16.5l4.5 4.5L23 11" stroke="white" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <div>
            <h1>DisputeDesk</h1>
            <p className="sub">AI copilot for PayPal disputes and chargebacks</p>
          </div>
        </div>
        <nav className="tabs" aria-label="Sections">
          {(["disputes", "policies", "log"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {t === "disputes" ? "Disputes" : t === "policies" ? "Autopilot policies" : "Agent log"}
            </button>
          ))}
        </nav>
        <div className="badges">
          {health && (
            <>
              <span className={`badge ${health.paypal === "sandbox" ? "ok" : "warn"}`} title="PayPal connection">PayPal {health.paypal}</span>
              <span className={`badge ${health.llm.length ? "ok" : "warn"}`} title={health.llm.join(", ") || "No LLM key: rule-based drafts"}>
                {health.llm.length ? `AI: ${health.llm[0]!.split(":")[0]}` : "AI: rules only"}
              </span>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="banner error" role="alert">
          {error} <button className="link" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      {busy && <div className="banner info">{busy}</div>}
      {toast && <div className="toast" role="status">{toast}</div>}

      {tab === "disputes" && (
        <main className="workspace">
          <section className="main-col">
            <div className="kpis">
              <Kpi label="Need your response" value={String(open.length)} />
              <Kpi label="Money at risk" value={`$${atRisk.toFixed(2)}`} />
              <Kpi label="Due within 2 days" value={String(urgent)} tone={urgent ? "warn" : undefined} />
              <Kpi label="Worth fighting" value={String(fight)} />
            </div>
            <div className="toolbar">
              <QueryBar onResult={setQuery} hasLlm={!!health?.llm.length} />
              <div className="toolbar-actions">
                <button onClick={analyzeAll} disabled={!!busy} title="Run the LLM over every dispute that needs a response">Analyze all with AI</button>
                {health?.paypal === "mock" && (
                  <button className="secondary" onClick={simulate} disabled={!!busy} title="Fire a signed CUSTOMER.DISPUTE.CREATED webhook at this server">Simulate new dispute</button>
                )}
              </div>
            </div>
            {query && (
              <div className="query-explain">
                <span className="pill">{query.source === "llm" ? "AI filter" : "Keyword filter"}</span> {query.explanation}{" "}
                <button className="link" onClick={() => setQuery(null)}>Clear</button>
              </div>
            )}
            <DisputesGrid rows={rows} query={query} selected={selected} onSelect={setSelected} />
            {health?.toolkit && <AskPanel enabled={!!health.llm.length} />}
          </section>
          <aside className={selected ? "side-col open" : "side-col"}>
            {selected ? (
              <DisputeCard key={selected} id={selected} onClose={() => setSelected(null)} onChanged={refresh} onToast={setToast} />
            ) : (
              <div className="empty-card">
                <h2>Pick a dispute</h2>
                <p>Select a row to see the full timeline from PayPal, the AI's recommendation and a ready-to-send evidence draft.</p>
              </div>
            )}
          </aside>
        </main>
      )}
      {tab === "policies" && <PoliciesPanel onToast={setToast} onChanged={refresh} />}
      {tab === "log" && <AuditLog />}

      <footer className="foot">
        PayPal sandbox only. Estimates are heuristics plus AI reasoning, not legal advice. Every action is journaled.
      </footer>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}
