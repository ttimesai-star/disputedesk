import { useEffect, useState } from "react";
import type { CaseView } from "../../../server/src/shared.ts";
import type { AcceptClaimType, Evidence } from "../../../server/src/paypal/types.ts";
import { REASON_LABEL, REC_LABEL, api, money, pretty } from "../api.ts";

const KIND_ICON: Record<string, string> = {
  order: "O", payment: "$", shipment: "S", delivery: "D", return: "R", refund: "-", message: "M", dispute: "!", evidence: "E", deadline: "T", resolution: "OK",
};

export function DisputeCard({ id, onClose, onChanged, onToast }: { id: string; onClose: () => void; onChanged: () => void; onToast: (s: string) => void }) {
  const [view, setView] = useState<CaseView | null>(null);
  const [loading, setLoading] = useState<string | null>("Loading case file...");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const [acceptType, setAcceptType] = useState<AcceptClaimType | "">("");

  const apply = (v: CaseView) => {
    setView(v);
    setEvidence(v.assessment?.evidence ?? []);
    setMessage(v.assessment?.buyerMessage ?? "");
    setNote(v.assessment?.acceptNote ?? "");
    setAcceptType(v.assessment?.acceptType ?? "");
    setEditing(false);
  };

  useEffect(() => {
    api
      .dispute(id)
      .then(apply)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(null));
  }, [id]);

  const run = async (label: string, fn: () => Promise<CaseView>, done: string) => {
    setLoading(label);
    setError(null);
    try {
      apply(await fn());
      onToast(done);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  };

  if (!view) {
    return (
      <div className="card">
        <CardHead id={id} onClose={onClose} />
        {error ? <div className="banner error">{error}</div> : <div className="skeleton">{loading}</div>}
      </div>
    );
  }

  const d = view.dispute;
  const a = view.assessment;
  const f = view.facts;
  const actionable = d.status === "WAITING_FOR_SELLER_RESPONSE";
  const allowedTypes = d.allowed_response_options?.accept_claim?.accept_claim_types ?? [];

  return (
    <div className="card">
      <CardHead id={id} onClose={onClose} />
      <div className="case-summary">
        <div className="amount">{money(f.amount, f.currency)}</div>
        <div>
          <div className="reason">{REASON_LABEL[f.reason] ?? f.reason}</div>
          <div className="muted small">
            {pretty(f.stage)} via {f.channel === "EXTERNAL" ? "card issuer" : "PayPal"} · {pretty(d.status)}
            {f.daysToDue !== null && actionable ? ` · due in ${f.daysToDue}d` : ""}
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading && <div className="banner info">{loading}</div>}

      {a && (
        <section className="verdict">
          <div className="verdict-head">
            <span className={`rec big rec-${a.recommendation.toLowerCase()}`}>{REC_LABEL[a.recommendation]}</span>
            <span className="muted small">
              Win odds ~{Math.round(a.winProbability * 100)}% · {a.source === "llm" ? `AI (${a.model})` : "rule-based draft"}
            </span>
            <button className="secondary small-btn" onClick={() => run("Asking the AI...", () => api.analyze(id), "Re-analyzed")} disabled={!!loading}>
              {a.source === "llm" ? "Re-analyze" : "Analyze with AI"}
            </button>
          </div>
          {a.llmError && <div className="note warn">AI unavailable, showing the rule-based draft ({a.llmError}).</div>}
          <ul className="rationale">
            {a.rationale.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {a.riskFlags.length > 0 && (
            <div className="flags">
              {a.riskFlags.map((r) => (
                <span key={r} className="flag">{r}</span>
              ))}
            </div>
          )}
          <div className="ev-compare">
            <div>
              <span className="muted small">If you fight</span>
              <strong>{money(a.expected.fight, f.currency)}</strong>
            </div>
            <div>
              <span className="muted small">If you accept now</span>
              <strong>{money(a.expected.accept, f.currency)}</strong>
            </div>
            <div className="muted small">Expected outcome; assumes a {money(a.expected.assumedFee, f.currency)} fee if a claim is lost.</div>
          </div>
        </section>
      )}

      {view.dataGaps.length > 0 && (
        <div className="note">
          Missing data: {view.dataGaps.join("; ")}
        </div>
      )}

      <section>
        <h3>Timeline</h3>
        <ol className="timeline">
          {view.timeline.map((t, i) => (
            <li key={i} className={`tl tl-${t.kind}`}>
              <span className="tl-icon" aria-hidden="true">{KIND_ICON[t.kind] ?? "."}</span>
              <div>
                <div className="tl-title">{t.title}</div>
                {t.detail && <div className="tl-detail">{t.detail}</div>}
                <div className="tl-meta">
                  {new Date(t.at).toLocaleString()} · {t.source}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {a && actionable && (
        <section className="drafts">
          <div className="drafts-head">
            <h3>Drafts</h3>
            <button className="link" onClick={() => setEditing((e) => !e)}>{editing ? "Done editing" : "Edit"}</button>
          </div>

          <h4>Evidence for PayPal</h4>
          {evidence.length === 0 && <p className="muted small">No evidence can be built from PayPal data for this reason. Attach documents in the PayPal Resolution Center.</p>}
          {evidence.map((e, i) => (
            <div key={i} className="evidence">
              <div className="ev-type">{pretty(e.evidence_type)}</div>
              {e.evidence_info?.tracking_info?.map((t) => (
                <div key={t.tracking_number} className="muted small">Tracking: {t.carrier_name} {t.tracking_number}</div>
              ))}
              {e.evidence_info?.refund_ids?.map((r) => (
                <div key={r.refund_id} className="muted small">Refund id: {r.refund_id}</div>
              ))}
              {editing ? (
                <textarea value={e.notes ?? ""} rows={4} onChange={(ev) => setEvidence(evidence.map((x, j) => (j === i ? { ...x, notes: ev.target.value } : x)))} />
              ) : (
                <p>{e.notes}</p>
              )}
            </div>
          ))}
          <button
            onClick={() => confirm(`Submit ${evidence.length} evidence item(s) to PayPal for ${id}?`) && run("Submitting evidence...", () => api.submitEvidence(id, evidence), "Evidence sent to PayPal")}
            disabled={!!loading || evidence.length === 0}
          >
            Send evidence
          </button>

          <h4>Message to buyer</h4>
          {editing ? <textarea value={message} rows={4} onChange={(e) => setMessage(e.target.value)} /> : <p className="quote">{message}</p>}
          <button className="secondary" onClick={() => run("Sending message...", () => api.message(id, message), "Message posted to the case")} disabled={!!loading || !message.trim()}>
            Send message
          </button>

          <h4>Accept and refund</h4>
          {editing ? <textarea value={note} rows={2} onChange={(e) => setNote(e.target.value)} /> : <p className="quote">{note}</p>}
          <div className="accept-row">
            {allowedTypes.length > 0 && (
              <select value={acceptType} onChange={(e) => setAcceptType(e.target.value as AcceptClaimType)} aria-label="Accept type">
                {allowedTypes.map((t) => (
                  <option key={t} value={t}>
                    {pretty(t)}
                  </option>
                ))}
              </select>
            )}
            <button
              className="danger"
              onClick={() => confirm(`Accept the claim and refund ${money(f.amount, f.currency)}? This cannot be undone.`) && run("Accepting claim...", () => api.accept(id, note, acceptType || null), "Claim accepted, refund issued")}
              disabled={!!loading || !note.trim()}
            >
              Accept claim
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function CardHead({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <div className="card-head">
      <h2>{id}</h2>
      <button className="icon-btn" onClick={onClose} aria-label="Close">
        ×
      </button>
    </div>
  );
}
