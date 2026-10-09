import { useEffect, useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import { colorSchemeVariable, themeQuartz, type ColDef, type GridReadyEvent, type ICellRendererParams, type RowClickedEvent, type GridApi } from "ag-grid-community";
import type { DisputeRow, QueryResult } from "../../../server/src/shared.ts";
import { REASON_LABEL, REC_LABEL, money, pretty } from "../api.ts";

export const gridTheme = themeQuartz.withPart(colorSchemeVariable).withParams({
  fontFamily: "inherit",
  accentColor: "var(--accent)",
  headerFontWeight: 600,
  borderRadius: 8,
  wrapperBorderRadius: 10,
});

function RecCell(p: ICellRendererParams<DisputeRow, string | null>) {
  if (!p.value) return <span className="muted">-</span>;
  return (
    <span className={`rec rec-${p.value.toLowerCase()}`}>
      {REC_LABEL[p.value] ?? p.value}
      {p.data?.assessedBy === "llm" && <span className="ai-dot" title="Refined by AI" />}
    </span>
  );
}

function WinCell(p: ICellRendererParams<DisputeRow, number | null>) {
  if (p.value === null || p.value === undefined) return <span className="muted">-</span>;
  const tone = p.value >= 60 ? "good" : p.value >= 35 ? "mid" : "bad";
  return (
    <span className="win">
      <span className="win-bar">
        <span className={`win-fill ${tone}`} style={{ width: `${p.value}%` }} />
      </span>
      <span className="win-num">{p.value}%</span>
    </span>
  );
}

function DueCell(p: ICellRendererParams<DisputeRow, number | null>) {
  const d = p.value;
  if (d === null || d === undefined || p.data?.status !== "WAITING_FOR_SELLER_RESPONSE") return <span className="muted">-</span>;
  const label = d < 0 ? `${-d}d overdue` : d === 0 ? "today" : `${d}d`;
  return <span className={d <= 2 ? "due urgent" : "due"}>{label}</span>;
}

export function DisputesGrid({ rows, query, selected, onSelect }: { rows: DisputeRow[] | null; query: QueryResult | null; selected: string | null; onSelect: (id: string) => void }) {
  const apiRef = useRef<GridApi<DisputeRow> | null>(null);

  const columns = useMemo<ColDef<DisputeRow>[]>(
    () => [
      { field: "disputeId", headerName: "Case", width: 120, pinned: "left" },
      { field: "amount", headerName: "Amount", width: 115, type: "numericColumn", filter: "agNumberColumnFilter", valueFormatter: (p) => (p.data ? money(p.value, p.data.currency) : "") },
      { field: "reason", headerName: "Reason", flex: 1.2, minWidth: 150, filter: "agTextColumnFilter", valueFormatter: (p) => REASON_LABEL[p.value] ?? p.value },
      {
        field: "dueInDays",
        headerName: "Due",
        width: 105,
        filter: "agNumberColumnFilter",
        cellRenderer: DueCell,
        sort: "asc",
        // Cases with no seller deadline (closed, under review) sink to the bottom in either direction.
        comparator: (a, b, na, nb, desc) => {
          const ka = na.data?.status === "WAITING_FOR_SELLER_RESPONSE" ? a : null;
          const kb = nb.data?.status === "WAITING_FOR_SELLER_RESPONSE" ? b : null;
          if (ka === null && kb === null) return 0;
          if (ka === null) return desc ? -1 : 1;
          if (kb === null) return desc ? 1 : -1;
          return ka - kb;
        },
      },
      { field: "winScore", headerName: "Win odds", width: 135, filter: "agNumberColumnFilter", cellRenderer: WinCell },
      { field: "recommendation", headerName: "AI says", width: 150, filter: "agTextColumnFilter", cellRenderer: RecCell },
      { field: "stage", headerName: "Stage", width: 120, filter: "agTextColumnFilter", valueFormatter: (p) => pretty(p.value ?? "") },
      { field: "status", headerName: "Status", width: 170, filter: "agTextColumnFilter", valueFormatter: (p) => pretty(p.value ?? "") },
      { field: "buyer", headerName: "Buyer", width: 140, filter: "agTextColumnFilter" },
      { field: "item", headerName: "Item", flex: 1.4, minWidth: 180, filter: "agTextColumnFilter", tooltipField: "item" },
      { field: "channel", headerName: "Channel", width: 110, filter: "agTextColumnFilter", valueFormatter: (p) => (p.value === "EXTERNAL" ? "Card issuer" : p.value === "INTERNAL" ? "PayPal" : p.value) },
      { field: "createdAt", headerName: "Opened", width: 115, filter: "agDateColumnFilter", valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleDateString() : "") },
      { field: "currency", hide: true, filter: "agTextColumnFilter" },
    ],
    [],
  );

  const applyQuery = (gridApi: GridApi<DisputeRow>) => {
    gridApi.setFilterModel(query?.filterModel ?? null);
    gridApi.applyColumnState({ state: query?.sort ? [{ colId: query.sort.colId, sort: query.sort.sort }] : [{ colId: "dueInDays", sort: "asc" }], defaultState: { sort: null } });
  };

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    applyQuery(api);
  }, [query, rows]);

  useEffect(() => {
    apiRef.current?.forEachNode((n) => n.setSelected(n.data?.disputeId === selected));
  }, [selected, rows]);

  return (
    <div className="grid-wrap">
      <AgGridReact<DisputeRow>
        theme={gridTheme}
        rowData={rows ?? undefined}
        loading={rows === null}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true, filter: true }}
        getRowId={(p) => p.data.disputeId}
        rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
        onGridReady={(e: GridReadyEvent<DisputeRow>) => {
          apiRef.current = e.api;
          applyQuery(e.api);
        }}
        onRowClicked={(e: RowClickedEvent<DisputeRow>) => e.data && onSelect(e.data.disputeId)}
        rowClassRules={{ "row-resolved": (p) => p.data?.status === "RESOLVED" }}
        overlayNoRowsTemplate="No disputes match. Clear the filter to see all."
        tooltipShowDelay={400}
        animateRows
      />
    </div>
  );
}
