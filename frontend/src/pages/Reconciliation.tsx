import { useMemo, useState } from "react";

type UploadResponse = {
  run_id: number;
  status: string;
  our_transactions: number;
  other_transactions: number;
};

type Summary = {
  matched: number;
  differences: number;
  missing_on_other_side: number;
  missing_on_our_side: number;
};

type ReconcileResponse = {
  run_id: number;
  status: string;
  summary: Summary;
};

type Transaction = {
  id: number;
  external_id: string;
  timestamp: string;
  instrument: string;
  side: string;
  quantity: number;
  price: number;
  amount: number;
};

type ResultRow = {
  result_id: number;
  status:
    | "MATCHED"
    | "DIFFERENCE"
    | "MISSING_ON_OTHER_SIDE"
    | "MISSING_ON_OUR_SIDE";
  our_transaction: Transaction | null;
  other_transaction: Transaction | null;
};

type ResultsResponse = {
  run_id: number;
  results: ResultRow[];
};

type RequestState = "idle" | "uploading" | "reconciling" | "loading-results";
type Filter = "ALL" | ResultRow["status"];

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

const emptySummary: Summary = {
  matched: 0,
  differences: 0,
  missing_on_other_side: 0,
  missing_on_our_side: 0,
};

const statusLabels: Record<ResultRow["status"], string> = {
  MATCHED: "Matched",
  DIFFERENCE: "Difference",
  MISSING_ON_OTHER_SIDE: "Missing external",
  MISSING_ON_OUR_SIDE: "Missing internal",
};

const filterOptions: Array<{ value: Filter; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "MATCHED", label: "Matched" },
  { value: "DIFFERENCE", label: "Differences" },
  { value: "MISSING_ON_OTHER_SIDE", label: "Missing external" },
  { value: "MISSING_ON_OUR_SIDE", label: "Missing internal" },
];

function formatMoney(value?: number) {
  if (value === undefined) return "-";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value?: number) {
  if (value === undefined) return "-";

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 8,
  }).format(value);
}

function formatDate(value?: string) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getPriceDifference(row: ResultRow) {
  if (!row.our_transaction || !row.other_transaction) return undefined;

  return row.other_transaction.price - row.our_transaction.price;
}

function getActionLabel(requestState: RequestState) {
  if (requestState === "uploading") return "Uploading files...";
  if (requestState === "reconciling") return "Reconciling...";
  if (requestState === "loading-results") return "Loading results...";

  return "Run reconciliation";
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, options);

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;

    try {
      const body = await response.json();
      message = body.detail ?? message;
    } catch {
      // Keep the status-based message when the server does not return JSON.
    }

    throw new Error(message);
  }

  return response.json();
}

function Reconciliation() {
  const [ourFile, setOurFile] = useState<File | null>(null);
  const [otherFile, setOtherFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<UploadResponse | null>(null);
  const [reconciliation, setReconciliation] =
    useState<ReconcileResponse | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [error, setError] = useState("");

  const isBusy = requestState !== "idle";
  const hasResults = results.length > 0;

  const filteredResults = useMemo(() => {
    if (filter === "ALL") return results;

    return results.filter((row) => row.status === filter);
  }, [filter, results]);

  const totals = useMemo(() => {
    if (reconciliation?.summary) return reconciliation.summary;

    return results.reduce<Summary>((summary, row) => {
      if (row.status === "MATCHED") summary.matched += 1;
      if (row.status === "DIFFERENCE") summary.differences += 1;
      if (row.status === "MISSING_ON_OTHER_SIDE") {
        summary.missing_on_other_side += 1;
      }
      if (row.status === "MISSING_ON_OUR_SIDE") {
        summary.missing_on_our_side += 1;
      }

      return summary;
    }, { ...emptySummary });
  }, [reconciliation, results]);

  const exceptionCount =
    totals.differences +
    totals.missing_on_other_side +
    totals.missing_on_our_side;

  const completionRate =
    results.length === 0 ? 0 : Math.round((totals.matched / results.length) * 100);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!ourFile || !otherFile) {
      setError("Select both CSV files before starting reconciliation.");
      return;
    }

    setError("");
    setUpload(null);
    setReconciliation(null);
    setResults([]);
    setFilter("ALL");

    const formData = new FormData();
    formData.append("our_file", ourFile);
    formData.append("other_file", otherFile);

    try {
      setRequestState("uploading");
      const uploadData = await apiRequest<UploadResponse>(
        "/reconciliation/upload",
        {
          method: "POST",
          body: formData,
        },
      );
      setUpload(uploadData);

      setRequestState("reconciling");
      const reconcileData = await apiRequest<ReconcileResponse>(
        `/reconciliation/${uploadData.run_id}/reconcile`,
        { method: "POST" },
      );
      setReconciliation(reconcileData);

      setRequestState("loading-results");
      const resultsData = await apiRequest<ResultsResponse>(
        `/reconciliation/${uploadData.run_id}/results`,
      );
      setResults(resultsData.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setRequestState("idle");
    }
  };

  return (
    <main className="min-h-screen bg-[#f7f8fb] text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-7 sm:px-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase text-slate-600">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              Reconciliation workspace
            </div>
            <h1 className="mt-4 text-3xl font-semibold text-slate-950 sm:text-4xl">
              Transaction reconciliation
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              Upload the internal ledger and external statement, run automated
              matching, then review every matched trade and exception.
            </p>
          </div>

          <RunStatus upload={upload} reconciliation={reconciliation} />
        </div>
      </header>

      <section className="mx-auto grid max-w-7xl gap-6 px-5 py-6 sm:px-8 lg:grid-cols-[380px_1fr]">
        <aside className="space-y-4">
          <form
            onSubmit={handleSubmit}
            className="rounded-md border border-slate-200 bg-white p-5 shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Input files</h2>
                <p className="mt-1 text-sm text-slate-500">
                  CSV uploads are processed together as one run.
                </p>
              </div>
              <span className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                CSV
              </span>
            </div>

            <div className="mt-5 space-y-3">
              <FilePicker
                id="our-ledger"
                label="Internal ledger"
                file={ourFile}
                onChange={setOurFile}
              />
              <FilePicker
                id="other-statement"
                label="External statement"
                file={otherFile}
                onChange={setOtherFile}
              />
            </div>

            {error && (
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isBusy}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {isBusy && (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              )}
              {getActionLabel(requestState)}
            </button>
          </form>

          <ProcessPanel requestState={requestState} upload={upload} />
        </aside>

        <section className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard label="Matched" value={totals.matched} tone="green" />
            <SummaryCard
              label="Differences"
              value={totals.differences}
              tone="amber"
            />
            <SummaryCard
              label="Missing external"
              value={totals.missing_on_other_side}
              tone="red"
            />
            <SummaryCard
              label="Missing internal"
              value={totals.missing_on_our_side}
              tone="blue"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
            <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold">Match quality</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {hasResults
                      ? `${completionRate}% of result rows matched cleanly`
                      : "Run reconciliation to calculate the match rate"}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-semibold">{completionRate}%</div>
                  <div className="text-xs font-medium uppercase text-slate-500">
                    Matched
                  </div>
                </div>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: `${completionRate}%` }}
                />
              </div>
            </div>

            <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-sm font-medium text-slate-500">
                Exceptions
              </div>
              <div className="mt-2 text-3xl font-semibold">{exceptionCount}</div>
              <p className="mt-2 text-sm leading-5 text-slate-500">
                Rows requiring manual review after automated matching.
              </p>
            </div>
          </div>

          <ResultsTable
            filter={filter}
            filteredResults={filteredResults}
            hasResults={hasResults}
            results={results}
            setFilter={setFilter}
          />
        </section>
      </section>
    </main>
  );
}

function RunStatus({
  upload,
  reconciliation,
}: {
  upload: UploadResponse | null;
  reconciliation: ReconcileResponse | null;
}) {
  if (!upload) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        No run started
      </div>
    );
  }

  return (
    <div className="min-w-44 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium text-slate-500">Run</span>
        <span className="font-semibold text-slate-950">#{upload.run_id}</span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-4">
        <span className="font-medium text-slate-500">Status</span>
        <span className="rounded bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">
          {reconciliation?.status ?? upload.status}
        </span>
      </div>
    </div>
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
      className="block cursor-pointer rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-4 hover:border-slate-400 hover:bg-white"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-800">{label}</div>
          <div className="mt-1 truncate text-sm text-slate-500">
            {file ? file.name : "Choose a CSV file"}
          </div>
        </div>
        <span className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700">
          Browse
        </span>
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

function ProcessPanel({
  requestState,
  upload,
}: {
  requestState: RequestState;
  upload: UploadResponse | null;
}) {
  const steps = [
    {
      label: "Upload files",
      done: Boolean(upload),
      active: requestState === "uploading",
    },
    {
      label: "Run matcher",
      done: upload?.status === "INGESTED" || upload?.status === "RECONCILED",
      active: requestState === "reconciling",
    },
    {
      label: "Load review table",
      done: requestState === "idle" && Boolean(upload),
      active: requestState === "loading-results",
    },
  ];

  return (
    <div className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Run progress</h2>
      <div className="mt-4 space-y-3">
        {steps.map((step) => (
          <div key={step.label} className="flex items-center gap-3">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                step.done
                  ? "bg-emerald-100 text-emerald-700"
                  : step.active
                    ? "bg-slate-950 text-white"
                    : "bg-slate-100 text-slate-400"
              }`}
            >
              {step.done ? "OK" : ""}
            </span>
            <span
              className={`text-sm ${
                step.active ? "font-semibold text-slate-950" : "text-slate-600"
              }`}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "green" | "amber" | "red" | "blue";
}) {
  const tones = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-800",
    blue: "border-sky-200 bg-sky-50 text-sky-800",
  };

  return (
    <div className={`rounded-md border p-4 shadow-sm ${tones[tone]}`}>
      <div className="text-sm font-medium">{label}</div>
      <div className="mt-2 text-3xl font-semibold">{value}</div>
    </div>
  );
}

function ResultsTable({
  filter,
  filteredResults,
  hasResults,
  results,
  setFilter,
}: {
  filter: Filter;
  filteredResults: ResultRow[];
  hasResults: boolean;
  results: ResultRow[];
  setFilter: (filter: Filter) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-4 border-b border-slate-200 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Review results</h2>
          <p className="mt-1 text-sm text-slate-500">
            {filteredResults.length} of {results.length} rows shown
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {filterOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                filter === option.value
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {hasResults ? (
        <div className="overflow-x-auto">
          <table className="min-w-[980px] divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Internal trade</th>
                <th className="px-4 py-3">External trade</th>
                <th className="px-4 py-3">Instrument</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3 text-right">Internal price</th>
                <th className="px-4 py-3 text-right">External price</th>
                <th className="px-4 py-3 text-right">Delta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredResults.map((row) => (
                <ResultTableRow key={row.result_id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyResults />
      )}
    </div>
  );
}

function ResultTableRow({ row }: { row: ResultRow }) {
  const ourTransaction = row.our_transaction;
  const otherTransaction = row.other_transaction;
  const transaction = ourTransaction ?? otherTransaction;
  const priceDifference = getPriceDifference(row);

  return (
    <tr className="align-top hover:bg-slate-50">
      <td className="px-4 py-4">
        <StatusBadge status={row.status} />
      </td>
      <td className="px-4 py-4">
        <TransactionCell transaction={ourTransaction} />
      </td>
      <td className="px-4 py-4">
        <TransactionCell transaction={otherTransaction} />
      </td>
      <td className="px-4 py-4">
        <div className="font-semibold text-slate-900">
          {transaction?.instrument ?? "-"}
        </div>
        <div className="mt-1 text-xs text-slate-500">
          {transaction?.side ?? "-"}
        </div>
      </td>
      <td className="px-4 py-4 text-right font-medium">
        {formatNumber(transaction?.quantity)}
      </td>
      <td className="px-4 py-4 text-right">{formatMoney(ourTransaction?.price)}</td>
      <td className="px-4 py-4 text-right">
        {formatMoney(otherTransaction?.price)}
      </td>
      <td
        className={`px-4 py-4 text-right font-semibold ${
          priceDifference ? "text-amber-700" : "text-slate-500"
        }`}
      >
        {priceDifference === undefined ? "-" : formatMoney(priceDifference)}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: ResultRow["status"] }) {
  const styles: Record<ResultRow["status"], string> = {
    MATCHED: "bg-emerald-100 text-emerald-800",
    DIFFERENCE: "bg-amber-100 text-amber-800",
    MISSING_ON_OTHER_SIDE: "bg-red-100 text-red-800",
    MISSING_ON_OUR_SIDE: "bg-sky-100 text-sky-800",
  };

  return (
    <span
      className={`inline-flex rounded px-2.5 py-1 text-xs font-semibold ${styles[status]}`}
    >
      {statusLabels[status]}
    </span>
  );
}

function TransactionCell({ transaction }: { transaction: Transaction | null }) {
  if (!transaction) {
    return <span className="text-slate-400">No record</span>;
  }

  return (
    <div className="min-w-36">
      <div className="font-semibold text-slate-900">{transaction.external_id}</div>
      <div className="mt-1 text-xs text-slate-500">
        {formatDate(transaction.timestamp)}
      </div>
    </div>
  );
}

function EmptyResults() {
  return (
    <div className="flex min-h-72 items-center justify-center px-6 py-12">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md bg-slate-100 text-lg font-semibold text-slate-500">
          CSV
        </div>
        <h3 className="mt-4 text-base font-semibold">No results yet</h3>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Upload both files and run reconciliation to populate this review
          table.
        </p>
      </div>
    </div>
  );
}

export default Reconciliation;
