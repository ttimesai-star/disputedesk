import { useEffect, useState } from "react";
import type { Policy, PolicySettings } from "../../../server/src/shared.ts";
import { REASON_LABEL, api } from "../api.ts";

const REASONS = Object.keys(REASON_LABEL);

export function PoliciesPanel({ onToast, onChanged }: { onToast: (s: string) => void; onChanged: () => void }) {
  const [s, setS] = useState<PolicySettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.policies().then(setS).catch((e: Error) => setError(e.message));
  }, []);

  if (!s) return <main className="panel">{error ? <div className="banner error">{error}</div> : "Loading..."}</main>;

  const update = (next: PolicySettings) => {
    setS(next);
    setDirty(true);
  };
  const setPolicy = (i: number, patch: Partial<Policy>) => update({ ...s, policies: s.policies.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  const save = async () => {
    try {
      setS(await api.savePolicies(s));
      setDirty(false);
      setError(null);
      onToast("Policies saved");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const runNow = async () => {
    try {
      const r = await api.runPolicies();
      onToast(s.autopilot ? `Autopilot handled ${r.acted} dispute(s), left ${r.skipped} for you` : "Autopilot is off: nothing was done");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <main className="panel">
      <div className="panel-head">
        <div>
          <h2>Autopilot policies</h2>
          <p className="muted">
            When a dispute arrives (webhook) or you press "Run now", the agent analyzes it and applies the first matching policy. A policy only fires if the AI's own recommendation
            agrees with it, so a case worth fighting is never auto-refunded.
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={s.autopilot} onChange={(e) => update({ ...s, autopilot: e.target.checked })} />
          <span>Autopilot {s.autopilot ? "on" : "off"}</span>
        </label>
      </div>
      {error && <div className="banner error">{error}</div>}

      <label className="field inline">
        Daily auto-refund cap ($)
        <input type="number" min={0} step={1} value={s.dailyAutoAcceptLimit} onChange={(e) => update({ ...s, dailyAutoAcceptLimit: Number(e.target.value) })} />
      </label>

      <div className="policies">
        {s.policies.map((p, i) => (
          <div key={p.id} className={`policy ${p.enabled ? "" : "disabled"}`}>
            <div className="policy-head">
              <label className="switch">
                <input type="checkbox" checked={p.enabled} onChange={(e) => setPolicy(i, { enabled: e.target.checked })} />
                <input className="policy-name" value={p.name} onChange={(e) => setPolicy(i, { name: e.target.value })} aria-label="Policy name" />
              </label>
              <button className="link danger-text" onClick={() => update({ ...s, policies: s.policies.filter((_, j) => j !== i) })}>Remove</button>
            </div>
            <div className="policy-grid">
              <label className="field">
                Action
                <select value={p.action} onChange={(e) => setPolicy(i, { action: e.target.value as Policy["action"] })}>
                  <option value="ACCEPT">Accept claim (refund)</option>
                  <option value="MESSAGE_BUYER">Message buyer</option>
                </select>
              </label>
              <label className="field">
                Max amount ($)
                <input type="number" min={0} value={p.maxAmount} onChange={(e) => setPolicy(i, { maxAmount: Number(e.target.value) })} />
              </label>
              <label className="field">
                Only if win odds at most (%)
                <input type="number" min={0} max={100} value={Math.round(p.maxWinProbability * 100)} onChange={(e) => setPolicy(i, { maxWinProbability: Number(e.target.value) / 100 })} />
              </label>
              <label className="field checkbox">
                <input type="checkbox" checked={p.dryRun} onChange={(e) => setPolicy(i, { dryRun: e.target.checked })} />
                Dry run (log only)
              </label>
            </div>
            <div className="reason-chips" role="group" aria-label="Reasons">
              {REASONS.map((r) => {
                const on = p.reasons.includes(r as Policy["reasons"][number]);
                return (
                  <button
                    key={r}
                    className={on ? "chip on" : "chip"}
                    onClick={() => setPolicy(i, { reasons: on ? p.reasons.filter((x) => x !== r) : [...p.reasons, r as Policy["reasons"][number]] })}
                  >
                    {REASON_LABEL[r]}
                  </button>
                );
              })}
              {p.reasons.length === 0 && <span className="muted small">Any reason</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="panel-actions">
        <button
          className="secondary"
          onClick={() =>
            update({
              ...s,
              policies: [...s.policies, { id: `policy-${Date.now().toString(36)}`, name: "New policy", enabled: false, maxAmount: 20, reasons: [], maxWinProbability: 0.3, action: "ACCEPT", dryRun: true }],
            })
          }
        >
          Add policy
        </button>
        <button onClick={save} disabled={!dirty}>Save</button>
        <button className="secondary" onClick={runNow} disabled={dirty} title={dirty ? "Save first" : "Run policies over all open disputes"}>Run now</button>
      </div>
    </main>
  );
}
