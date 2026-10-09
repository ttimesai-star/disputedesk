import { useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import type { AuditEntry } from "../../../server/src/shared.ts";
import { api, money } from "../api.ts";
import { gridTheme } from "./DisputesGrid.tsx";

function Outcome(p: ICellRendererParams<AuditEntry, AuditEntry["outcome"]>) {
  return <span className={`outcome outcome-${p.value}`}>{p.value}</span>;
}

export function AuditLog() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api
      .audit()
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const cols = useMemo<ColDef<AuditEntry>[]>(
    () => [
      { field: "at", headerName: "Time", width: 180, sort: "desc", valueFormatter: (p) => new Date(p.value).toLocaleString() },
      { field: "actor", headerName: "Who", width: 100, filter: "agTextColumnFilter" },
      { field: "action", headerName: "Action", width: 210, filter: "agTextColumnFilter" },
      { field: "disputeId", headerName: "Case", width: 120, filter: "agTextColumnFilter" },
      { field: "outcome", headerName: "Outcome", width: 110, cellRenderer: Outcome, filter: "agTextColumnFilter" },
      { colId: "amount", headerName: "Amount", width: 110, valueGetter: (p) => (p.data?.amount ? money(Number(p.data.amount.value), p.data.amount.currency_code) : "") },
      { field: "detail", headerName: "Detail", flex: 1, minWidth: 260, tooltipField: "detail", filter: "agTextColumnFilter" },
    ],
    [],
  );

  return (
    <main className="panel">
      <div className="panel-head">
        <div>
          <h2>Agent log</h2>
          <p className="muted">Every webhook, analysis, policy decision and seller action, newest first. Stored in data/audit.jsonl.</p>
        </div>
        <button className="secondary" onClick={load}>Refresh</button>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div className="grid-wrap tall">
        <AgGridReact<AuditEntry> theme={gridTheme} rowData={rows ?? undefined} loading={rows === null} columnDefs={cols} defaultColDef={{ resizable: true, sortable: true }} getRowId={(p) => p.data.id} tooltipShowDelay={300} overlayNoRowsTemplate="Nothing yet. Analyze a dispute or simulate a webhook." />
      </div>
    </main>
  );
}
