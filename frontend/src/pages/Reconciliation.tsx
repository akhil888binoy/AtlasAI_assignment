import { useEffect, useState } from "react";

type Status =
  | "MATCHED"
  | "DIFFERENCE"
  | "MISSING_ON_OTHER_SIDE"
  | "MISSING_ON_OUR_SIDE"
  | "MANUALLY_MATCHED"
  | "ACCEPTED_UNPAIRED"
  | "CANCELLED";

type Transaction = {
  id: number;
  external_id: string;
  timestamp: string;
  instrument: string;
  side: string;
  quantity: number;
  price: number;
  amount: number;
  status: string;
  // What this trade said in an earlier run, for fields a correction changed.
  previous_values: Partial<Record<string, string | number>>;
};

type Difference = {
  field_name: string;
  our_value: string;
  other_value: string;
  difference: number;
};

type ResultRow = {
  result_id: number;
  status: Status;
  our_transaction: Transaction | null;
  other_transaction: Transaction | null;
  differences: Difference[];
};

type Run = {
  id: number;
  created_at: string;
  our_file: string;
  other_file: string;
  status: string;
  summary: Partial<Record<Status, number>>;
};

type Filter = "ATTENTION" | "ALL" | Status;

const STATUS: Record<Status, { label: string; dot: string; badge: string }> = {
  DIFFERENCE: { label: "Difference", dot: "bg-amber-500", badge: "bg-amber-50 text-amber-800 ring-amber-200" },
  MISSING_ON_OTHER_SIDE: { label: "Missing external", dot: "bg-red-500", badge: "bg-red-50 text-red-800 ring-red-200" },
  MISSING_ON_OUR_SIDE: { label: "Missing internal", dot: "bg-sky-500", badge: "bg-sky-50 text-sky-800 ring-sky-200" },
  MATCHED: { label: "Matched", dot: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  MANUALLY_MATCHED: { label: "Manual match", dot: "bg-violet-500", badge: "bg-violet-50 text-violet-800 ring-violet-200" },
  ACCEPTED_UNPAIRED: { label: "Accepted", dot: "bg-slate-500", badge: "bg-slate-100 text-slate-700 ring-slate-200" },
  CANCELLED: { label: "Cancelled", dot: "bg-slate-300", badge: "bg-slate-50 text-slate-500 ring-slate-200" },
};

const STATUS_ORDER = Object.keys(STATUS) as Status[];
const NEEDS_ATTENTION: Status[] = ["DIFFERENCE", "MISSING_ON_OTHER_SIDE", "MISSING_ON_OUR_SIDE"];
const MISSING: Status[] = ["MISSING_ON_OTHER_SIDE", "MISSING_ON_OUR_SIDE"];

const FIELDS = [
  { key: "external_id", label: "Reference" },
  { key: "timestamp", label: "Time" },
  { key: "instrument", label: "Instrument" },
  { key: "side", label: "Side" },
  { key: "quantity", label: "Quantity" },
  { key: "price", label: "Price" },
  { key: "amount", label: "Amount" },
] as const;

const FIELD_LABEL = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]));

function formatValue(value: string | number | undefined) {
  if (value === undefined || value === null) return "-";
  if (typeof value === "number") {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value);
  }
  return value;
}

// Timestamps arrive as ISO strings; show them as sent, no timezone guessing.
function formatTimestamp(value: string | undefined) {
  return value ? value.replace("T", " ").slice(0, 19) : "-";
}

function formatTime(value: string | undefined) {
  return value ? value.slice(11, 19) : "-";
}

function formatGap(difference: Difference) {
  const sign = difference.difference > 0 ? "+" : "";
  if (difference.field_name === "timestamp") {
    return `${sign}${formatValue(difference.difference / 60)} min`;
  }
  return `${sign}${formatValue(difference.difference)}`;
}

function describeDifferences(row: ResultRow) {
  return row.differences.map((d) => `${FIELD_LABEL[d.field_name]} ${formatGap(d)}`).join(" · ");
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/reconciliation${path}`, options);

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed with status ${response.status}`);
  }

  return response.json();
}

function postJson<T>(path: string, body: object) {
  return api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function Reconciliation() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<number | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [filter, setFilter] = useState<Filter>("ATTENTION");
  const [selectedResultId, setSelectedResultId] = useState<number | null>(null);
  // Rows picked for a manual match, one per side.
  const [pickedOur, setPickedOur] = useState<Transaction | null>(null);
  const [pickedOther, setPickedOther] = useState<Transaction | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const run = runs.find((r) => r.id === runId) ?? null;
  const selectedRow = results.find((row) => row.result_id === selectedResultId) ?? null;

  const visibleRows = results.filter((row) => {
    if (filter === "ALL") return true;
    if (filter === "ATTENTION") return NEEDS_ATTENTION.includes(row.status);
    return row.status === filter;
  });

  const counts = results.reduce<Partial<Record<Status, number>>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
  const openCount = NEEDS_ATTENTION.reduce((sum, status) => sum + (counts[status] ?? 0), 0);

  async function loadRuns() {
    const data = await api<Run[]>("/runs");
    setRuns(data);
    return data;
  }

  async function openRun(id: number) {
    setRunId(id);
    setPickedOur(null);
    setPickedOther(null);
    const data = await api<{ results: ResultRow[] }>(`/${id}/results`);
    setResults(data.results);
    // Land on the first row that needs a decision.
    const first = data.results.find((row) => NEEDS_ATTENTION.includes(row.status));
    setSelectedResultId(first?.result_id ?? null);
  }

  // Refresh the current run's rows after a hand resolution.
  async function refreshResults() {
    if (runId === null) return;
    const data = await api<{ results: ResultRow[] }>(`/${runId}/results`);
    setResults(data.results);
    await loadRuns();
  }

  useEffect(() => {
    loadRuns()
      .then((data) => data[0] && openRun(data[0].id))
      .catch((err) => setError(err.message));
  }, []);

  async function withBusy(label: string, work: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy("");
    }
  }

  function startRun(ourFile: File, otherFile: File) {
    const formData = new FormData();
    formData.append("our_file", ourFile);
    formData.append("other_file", otherFile);

    return withBusy("Running...", async () => {
      const upload = await api<{ run_id: number }>("/upload", { method: "POST", body: formData });
      await api(`/${upload.run_id}/reconcile`, { method: "POST" });
      await loadRuns();
      await openRun(upload.run_id);
    });
  }

  function acceptUnpaired(transaction: Transaction) {
    return withBusy("Saving...", async () => {
      await postJson(`/${runId}/accept-unpaired`, { transaction_id: transaction.id });
      await refreshResults();
    });
  }

  function pickForMatch(row: ResultRow) {
    if (row.our_transaction) setPickedOur(row.our_transaction);
    if (row.other_transaction) setPickedOther(row.other_transaction);
  }

  function clearPicks() {
    setPickedOur(null);
    setPickedOther(null);
  }

  function confirmManualMatch() {
    if (!pickedOur || !pickedOther) return;
    return withBusy("Matching...", async () => {
      await postJson(`/${runId}/manual-match`, {
        our_transaction_id: pickedOur.id,
        other_transaction_id: pickedOther.id,
      });
      clearPicks();
      setSelectedResultId(null);
      await refreshResults();
    });
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-375 items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
              R
            </span>
            <span className="text-base font-semibold">Reconciliation</span>
          </div>
          {busy && <span className="text-sm text-slate-500">{busy}</span>}
        </div>
      </header>

      <div className="mx-auto grid max-w-375 gap-6 px-6 py-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-4">
          <UploadForm busy={busy} onSubmit={startRun} />
          <RunList runs={runs} activeRunId={runId} onOpen={(id) => withBusy("Loading...", () => openRun(id))} />
        </aside>

        <section className="min-w-0 space-y-4">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {error}
            </div>
          )}

          {run ? (
            <RunHeading run={run} openCount={openCount} />
          ) : (
            <EmptyState />
          )}

          {run && (
            <>
              <StatStrip counts={counts} filter={filter} setFilter={setFilter} total={results.length} />

              {(pickedOur || pickedOther) && (
                <MatchBar
                  pickedOur={pickedOur}
                  pickedOther={pickedOther}
                  busy={busy}
                  onConfirm={confirmManualMatch}
                  onClear={clearPicks}
                />
              )}

              <div className="grid items-start gap-4 xl:grid-cols-[1fr_360px]">
                <ResultsTable
                  rows={visibleRows}
                  selectedResultId={selectedResultId}
                  onSelect={setSelectedResultId}
                />
                {selectedRow ? (
                  <RowDetail
                    row={selectedRow}
                    busy={busy}
                    onAcceptUnpaired={acceptUnpaired}
                    onPickForMatch={pickForMatch}
                  />
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
                    Select a row to see both sides field by field.
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center">
      <h2 className="text-lg font-semibold">No runs yet</h2>
      <p className="mt-2 text-sm text-slate-500">
        Upload today's ledger and the counterparty statement to start the first run.
      </p>
    </div>
  );
}

function RunHeading({ run, openCount }: { run: Run; openCount: number }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Run #{run.id}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {formatTimestamp(run.created_at)} · {run.our_file} against {run.other_file}
        </p>
      </div>
      <p className={`text-sm font-medium ${openCount > 0 ? "text-amber-700" : "text-emerald-700"}`}>
        {openCount === 0 ? "Everything is resolved" : `${openCount} ${openCount === 1 ? "row needs" : "rows need"} a decision`}
      </p>
    </div>
  );
}

function StatStrip({
  counts,
  filter,
  setFilter,
  total,
}: {
  counts: Partial<Record<Status, number>>;
  filter: Filter;
  setFilter: (filter: Filter) => void;
  total: number;
}) {
  const cell = (value: Filter, label: string, count: number, dot?: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setFilter(value)}
      className={`flex flex-1 flex-col gap-1 whitespace-nowrap border-b-2 px-4 py-3 text-left hover:bg-slate-50 ${
        filter === value ? "border-indigo-600 bg-indigo-50/40" : "border-transparent"
      }`}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
        {dot && <span className={`h-2 w-2 rounded-full ${dot}`} />}
        {label}
      </span>
      <span className="text-2xl font-semibold tabular-nums">{count}</span>
    </button>
  );

  const openCount = NEEDS_ATTENTION.reduce((sum, status) => sum + (counts[status] ?? 0), 0);

  return (
    <div className="flex overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      {cell("ATTENTION", "Needs attention", openCount)}
      {STATUS_ORDER.map((status) => cell(status, STATUS[status].label, counts[status] ?? 0, STATUS[status].dot))}
      {cell("ALL", "All rows", total)}
    </div>
  );
}

function UploadForm({
  busy,
  onSubmit,
}: {
  busy: string;
  onSubmit: (ourFile: File, otherFile: File) => void;
}) {
  const [ourFile, setOurFile] = useState<File | null>(null);
  const [otherFile, setOtherFile] = useState<File | null>(null);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ourFile && otherFile) onSubmit(ourFile, otherFile);
      }}
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2 className="text-sm font-semibold">New run</h2>
      <div className="mt-3 space-y-2">
        <FilePicker id="our-file" label="Our ledger" file={ourFile} onChange={setOurFile} />
        <FilePicker id="other-file" label="Their statement" file={otherFile} onChange={setOtherFile} />
      </div>
      <button
        type="submit"
        disabled={busy !== "" || !ourFile || !otherFile}
        className="mt-3 w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {busy || "Upload and reconcile"}
      </button>
    </form>
  );
}

function FilePicker({
  id,
  label,
  file,
  onChange,
}: {
  id: string;
  label: string;
  file: File | null;
  onChange: (file: File | null) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={`block cursor-pointer rounded-md border px-3 py-2 hover:border-indigo-400 ${
        file ? "border-indigo-300 bg-indigo-50/50" : "border-dashed border-slate-300 bg-slate-50"
      }`}
    >
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium text-slate-800">
        {file ? file.name : "Choose a CSV file"}
      </div>
      <input
        id={id}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
    </label>
  );
}

function RunList({
  runs,
  activeRunId,
  onOpen,
}: {
  runs: Run[];
  activeRunId: number | null;
  onOpen: (id: number) => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold">Runs</h2>
      {runs.length === 0 && <p className="px-4 py-6 text-sm text-slate-500">No runs yet.</p>}
      <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto">
        {runs.map((run) => {
          const open = NEEDS_ATTENTION.reduce((sum, status) => sum + (run.summary[status] ?? 0), 0);
          const active = run.id === activeRunId;
          return (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => onOpen(run.id)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-slate-50 ${
                  active ? "bg-indigo-50/60" : ""
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${open > 0 ? "bg-amber-500" : "bg-emerald-500"}`} />
                <span className="min-w-0 flex-1">
                  <span className={`block font-medium ${active ? "text-indigo-700" : ""}`}>Run #{run.id}</span>
                  <span className="block truncate text-xs text-slate-500">{formatTimestamp(run.created_at)}</span>
                </span>
                <span className="text-xs tabular-nums text-slate-500">{open} open</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MatchBar({
  pickedOur,
  pickedOther,
  busy,
  onConfirm,
  onClear,
}: {
  pickedOur: Transaction | null;
  pickedOther: Transaction | null;
  busy: string;
  onConfirm: () => void;
  onClear: () => void;
}) {
  const slot = (transaction: Transaction | null, hint: string) =>
    transaction ? (
      <span className="rounded bg-white px-2 py-0.5 font-semibold ring-1 ring-violet-200">{transaction.external_id}</span>
    ) : (
      <span className="text-violet-700/70">{hint}</span>
    );

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm">
      <span className="font-semibold text-violet-900">Manual match</span>
      {slot(pickedOur, "pick an internal row")}
      <span className="text-violet-400">↔</span>
      {slot(pickedOther, "pick an external row")}
      <div className="ml-auto flex gap-2">
        <button
          type="button"
          onClick={onClear}
          className="rounded-md px-3 py-1.5 font-medium text-violet-900 hover:bg-violet-100"
        >
          Clear
        </button>
        <button
          type="button"
          disabled={!pickedOur || !pickedOther || busy !== ""}
          onClick={onConfirm}
          className="rounded-md bg-violet-600 px-3 py-1.5 font-semibold text-white hover:bg-violet-700 disabled:bg-slate-300"
        >
          Confirm match
        </button>
      </div>
    </div>
  );
}

function ResultsTable({
  rows,
  selectedResultId,
  onSelect,
}: {
  rows: ResultRow[];
  selectedResultId: number | null;
  onSelect: (id: number) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-12 text-center text-sm text-slate-500 shadow-sm">
        Nothing in this view.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2.5">Status</th>
            <th className="px-3 py-2.5">Internal</th>
            <th className="px-3 py-2.5">External</th>
            <th className="px-3 py-2.5">Time</th>
            <th className="px-3 py-2.5">Trade</th>
            <th className="px-4 py-2.5">What differs</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const trade = row.our_transaction ?? row.other_transaction;
            const selected = row.result_id === selectedResultId;
            return (
              <tr
                key={row.result_id}
                onClick={() => onSelect(row.result_id)}
                className={`cursor-pointer ${selected ? "bg-indigo-50" : "hover:bg-slate-50"}`}
              >
                <td className="px-4 py-2.5">
                  <StatusBadge status={row.status} />
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 font-medium">
                  {row.our_transaction?.external_id ?? <span className="font-normal text-slate-400">none</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 font-medium">
                  {row.other_transaction?.external_id ?? <span className="font-normal text-slate-400">none</span>}
                </td>
                <td className="px-3 py-2.5 tabular-nums text-slate-500">{formatTime(trade?.timestamp)}</td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <span className={trade?.side === "BUY" ? "text-emerald-700" : "text-red-700"}>{trade?.side}</span>{" "}
                  <span className="tabular-nums">{formatValue(trade?.quantity)}</span> {trade?.instrument}
                  <span className="text-slate-400"> @ </span>
                  <span className="tabular-nums">{formatValue(trade?.price)}</span>
                </td>
                <td className="px-4 py-2.5 text-amber-700">{describeDifferences(row)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${STATUS[status].badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS[status].dot}`} />
      {STATUS[status].label}
    </span>
  );
}

function RowDetail({
  row,
  busy,
  onAcceptUnpaired,
  onPickForMatch,
}: {
  row: ResultRow;
  busy: string;
  onAcceptUnpaired: (transaction: Transaction) => void;
  onPickForMatch: (row: ResultRow) => void;
}) {
  const differenceFor = (field: string) => row.differences.find((d) => d.field_name === field);
  const unmatched = MISSING.includes(row.status);
  const lonelyTransaction = row.our_transaction ?? row.other_transaction;

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm xl:sticky xl:top-6">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold">Row detail</h2>
        <StatusBadge status={row.status} />
      </div>

      <div className="grid grid-cols-[88px_1fr_1fr] border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        <span>Field</span>
        <span>Internal</span>
        <span>External</span>
      </div>

      <div className="divide-y divide-slate-100">
        {FIELDS.map((field) => {
          const difference = differenceFor(field.key);
          return (
            <div key={field.key} className={`px-4 py-2.5 ${difference ? "bg-amber-50" : ""}`}>
              <div className="grid grid-cols-[88px_1fr_1fr] gap-2 text-sm">
                <span className="text-slate-500">{field.label}</span>
                <FieldValue transaction={row.our_transaction} field={field.key} />
                <FieldValue transaction={row.other_transaction} field={field.key} />
              </div>
              {difference && (
                <div className="mt-1 pl-24 text-xs font-semibold text-amber-700">
                  differs by {formatGap(difference)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {unmatched && lonelyTransaction && (
        <div className="space-y-2 border-t border-slate-200 p-4">
          <p className="text-xs text-slate-500">
            This row has no pair. Match it with a row on the other side, or accept that none exists.
            Either decision is remembered for future runs.
          </p>
          <button
            type="button"
            disabled={busy !== ""}
            onClick={() => onPickForMatch(row)}
            className="w-full rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:bg-slate-300"
          >
            Pick for manual match
          </button>
          <button
            type="button"
            disabled={busy !== ""}
            onClick={() => onAcceptUnpaired(lonelyTransaction)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Accept: no pair exists
          </button>
        </div>
      )}
    </div>
  );
}

function FieldValue({
  transaction,
  field,
}: {
  transaction: Transaction | null;
  field: (typeof FIELDS)[number]["key"];
}) {
  if (!transaction) return <span className="text-slate-300">—</span>;

  const show = (value: string | number | undefined) =>
    field === "timestamp" ? formatTimestamp(String(value)) : formatValue(value);
  const previous = transaction.previous_values[field];
  return (
    <span className="min-w-0 wrap-break-word tabular-nums">
      {show(transaction[field])}
      {previous !== undefined && (
        <span className="block text-xs font-normal text-slate-500">was {show(previous)}</span>
      )}
    </span>
  );
}

export default Reconciliation;
