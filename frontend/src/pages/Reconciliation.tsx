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

const STATUS: Record<Status, { label: string; tone: string }> = {
  MATCHED: { label: "Matched", tone: "bg-emerald-100 text-emerald-800" },
  DIFFERENCE: { label: "Difference", tone: "bg-amber-100 text-amber-800" },
  MISSING_ON_OTHER_SIDE: { label: "Missing external", tone: "bg-red-100 text-red-800" },
  MISSING_ON_OUR_SIDE: { label: "Missing internal", tone: "bg-sky-100 text-sky-800" },
  MANUALLY_MATCHED: { label: "Manual match", tone: "bg-violet-100 text-violet-800" },
  ACCEPTED_UNPAIRED: { label: "Accepted unpaired", tone: "bg-slate-200 text-slate-700" },
  CANCELLED: { label: "Cancelled", tone: "bg-slate-100 text-slate-500" },
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

function formatValue(value: string | number | undefined) {
  if (value === undefined || value === null) return "-";
  if (typeof value === "number") {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value);
  }
  // Timestamps arrive as ISO strings; show them as sent, no timezone guessing.
  return value.replace("T", " ").slice(0, 19);
}

function formatGap(difference: Difference) {
  if (difference.field_name === "timestamp") {
    const minutes = difference.difference / 60;
    return `${minutes > 0 ? "+" : ""}${formatValue(minutes)} min`;
  }
  return `${difference.difference > 0 ? "+" : ""}${formatValue(difference.difference)}`;
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

  async function loadRuns() {
    const data = await api<Run[]>("/runs");
    setRuns(data);
    return data;
  }

  async function openRun(id: number) {
    setRunId(id);
    setSelectedResultId(null);
    setPickedOur(null);
    setPickedOther(null);
    const data = await api<{ results: ResultRow[] }>(`/${id}/results`);
    setResults(data.results);
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

  function confirmManualMatch() {
    if (!pickedOur || !pickedOther) return;
    return withBusy("Matching...", async () => {
      await postJson(`/${runId}/manual-match`, {
        our_transaction_id: pickedOur.id,
        other_transaction_id: pickedOther.id,
      });
      setPickedOur(null);
      setPickedOther(null);
      setSelectedResultId(null);
      await refreshResults();
    });
  }

  return (
    <main className="min-h-screen bg-[#f7f8fb] text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-5 py-6 sm:px-8">
          <h1 className="text-2xl font-semibold">Transaction reconciliation</h1>
          <p className="mt-1 text-sm text-slate-600">
            Upload today's ledger and statement, then work through the rows that do not agree.
          </p>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-5 py-6 sm:px-8 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-4">
          <UploadForm busy={busy} onSubmit={startRun} />
          <RunList runs={runs} activeRunId={runId} onOpen={(id) => withBusy("Loading...", () => openRun(id))} />
        </aside>

        <section className="space-y-4">
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {error}
            </div>
          )}

          {(pickedOur || pickedOther) && (
            <MatchBar
              pickedOur={pickedOur}
              pickedOther={pickedOther}
              busy={busy}
              onConfirm={confirmManualMatch}
              onClear={() => {
                setPickedOur(null);
                setPickedOther(null);
              }}
            />
          )}

          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-7">
            {STATUS_ORDER.map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setFilter(status)}
                className={`rounded-md border p-3 text-left shadow-sm ${
                  filter === status ? "border-slate-950" : "border-slate-200"
                } ${STATUS[status].tone}`}
              >
                <div className="text-xs font-medium">{STATUS[status].label}</div>
                <div className="mt-1 text-2xl font-semibold">{counts[status] ?? 0}</div>
              </button>
            ))}
          </div>

          <ResultsTable
            rows={visibleRows}
            total={results.length}
            filter={filter}
            setFilter={setFilter}
            selectedResultId={selectedResultId}
            onSelect={setSelectedResultId}
          />

          {selectedRow && (
            <RowDetail
              row={selectedRow}
              busy={busy}
              onAcceptUnpaired={acceptUnpaired}
              onPickForMatch={pickForMatch}
            />
          )}
        </section>
      </div>
    </main>
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
      className="rounded-md border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2 className="text-base font-semibold">Start a run</h2>
      <div className="mt-3 space-y-2">
        <FilePicker id="our-file" label="Our ledger" file={ourFile} onChange={setOurFile} />
        <FilePicker id="other-file" label="Their statement" file={otherFile} onChange={setOtherFile} />
      </div>
      <button
        type="submit"
        disabled={busy !== "" || !ourFile || !otherFile}
        className="mt-4 w-full rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
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
      className="block cursor-pointer rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2.5 hover:border-slate-400 hover:bg-white"
    >
      <div className="text-sm font-semibold text-slate-800">{label}</div>
      <div className="mt-0.5 truncate text-sm text-slate-500">{file ? file.name : "Choose a CSV file"}</div>
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
    <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-semibold">Previous runs</h2>
      {runs.length === 0 && <p className="mt-2 text-sm text-slate-500">No runs yet.</p>}
      <ul className="mt-3 space-y-2">
        {runs.map((run) => {
          const open = NEEDS_ATTENTION.reduce((sum, status) => sum + (run.summary[status] ?? 0), 0);
          return (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => onOpen(run.id)}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                  run.id === activeRunId ? "border-slate-950 bg-slate-50" : "border-slate-200"
                }`}
              >
                <div className="flex justify-between font-semibold">
                  <span>Run #{run.id}</span>
                  <span className={open > 0 ? "text-amber-700" : "text-emerald-700"}>
                    {open} open
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{formatValue(run.created_at)}</div>
                <div className="mt-0.5 truncate text-xs text-slate-500">
                  {run.our_file} + {run.other_file}
                </div>
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
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-violet-200 bg-violet-50 px-4 py-3 text-sm">
      <span className="font-semibold text-violet-900">Manual match:</span>
      <span>{pickedOur ? pickedOur.external_id : "pick an internal row"}</span>
      <span className="text-slate-400">with</span>
      <span>{pickedOther ? pickedOther.external_id : "pick an external row"}</span>
      <div className="ml-auto flex gap-2">
        <button
          type="button"
          onClick={onClear}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium hover:bg-slate-50"
        >
          Clear
        </button>
        <button
          type="button"
          disabled={!pickedOur || !pickedOther || busy !== ""}
          onClick={onConfirm}
          className="rounded-md bg-violet-700 px-3 py-1.5 font-semibold text-white hover:bg-violet-800 disabled:bg-slate-400"
        >
          Confirm match
        </button>
      </div>
    </div>
  );
}

function ResultsTable({
  rows,
  total,
  filter,
  setFilter,
  selectedResultId,
  onSelect,
}: {
  rows: ResultRow[];
  total: number;
  filter: Filter;
  setFilter: (filter: Filter) => void;
  selectedResultId: number | null;
  onSelect: (id: number) => void;
}) {
  const filterButton = (value: Filter, label: string) => (
    <button
      type="button"
      onClick={() => setFilter(value)}
      className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
        filter === value
          ? "border-slate-950 bg-slate-950 text-white"
          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
        <div>
          <h2 className="text-base font-semibold">Results</h2>
          <p className="text-sm text-slate-500">
            {rows.length} of {total} rows. Click a row to inspect it.
          </p>
        </div>
        <div className="flex gap-2">
          {filterButton("ATTENTION", "Needs attention")}
          {filterButton("ALL", "All")}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-slate-500">Nothing to show.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-215 w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Internal</th>
                <th className="px-4 py-2">External</th>
                <th className="px-4 py-2">Trade</th>
                <th className="px-4 py-2">What differs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const trade = row.our_transaction ?? row.other_transaction;
                return (
                  <tr
                    key={row.result_id}
                    onClick={() => onSelect(row.result_id)}
                    className={`cursor-pointer hover:bg-slate-50 ${
                      row.result_id === selectedResultId ? "bg-slate-100" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-4 py-2.5 font-medium">
                      {row.our_transaction?.external_id ?? <span className="text-slate-400">none</span>}
                    </td>
                    <td className="px-4 py-2.5 font-medium">
                      {row.other_transaction?.external_id ?? <span className="text-slate-400">none</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {trade?.side} {formatValue(trade?.quantity)} {trade?.instrument} @ {formatValue(trade?.price)}
                    </td>
                    <td className="px-4 py-2.5 text-amber-700">
                      {row.differences.map((d) => `${d.field_name} ${formatGap(d)}`).join(", ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${STATUS[status].tone}`}>
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
    <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold">Row detail</h2>
          <StatusBadge status={row.status} />
        </div>
        {unmatched && lonelyTransaction && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy !== ""}
              onClick={() => onPickForMatch(row)}
              className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-900 hover:bg-violet-100"
            >
              Pick for manual match
            </button>
            <button
              type="button"
              disabled={busy !== ""}
              onClick={() => onAcceptUnpaired(lonelyTransaction)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
            >
              Accept: no pair exists
            </button>
          </div>
        )}
      </div>

      <table className="mt-4 w-full text-sm">
        <thead className="text-left text-xs font-semibold uppercase text-slate-500">
          <tr>
            <th className="py-1.5 pr-4">Field</th>
            <th className="py-1.5 pr-4">Internal</th>
            <th className="py-1.5 pr-4">External</th>
            <th className="py-1.5">Gap</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {FIELDS.map((field) => {
            const difference = differenceFor(field.key);
            return (
              <tr key={field.key} className={difference ? "bg-amber-50" : ""}>
                <td className="py-2 pr-4 font-medium text-slate-600">{field.label}</td>
                <td className="py-2 pr-4">
                  <FieldValue transaction={row.our_transaction} field={field.key} />
                </td>
                <td className="py-2 pr-4">
                  <FieldValue transaction={row.other_transaction} field={field.key} />
                </td>
                <td className="py-2 font-semibold text-amber-700">
                  {difference ? formatGap(difference) : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
  if (!transaction) return <span className="text-slate-400">-</span>;

  const previous = transaction.previous_values[field];
  return (
    <div>
      {formatValue(transaction[field])}
      {previous !== undefined && (
        <div className="text-xs text-slate-500">was {formatValue(previous)} in an earlier run</div>
      )}
    </div>
  );
}

export default Reconciliation;
