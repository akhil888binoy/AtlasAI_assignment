# Transaction Reconciliation

Two systems recorded the same trades and disagree. This app loads both files every morning, matches the rows, shows what differs and by how much, and lets a person resolve what the machine could not.

- Backend: FastAPI, SQLAlchemy, Alembic, PostgreSQL
- Frontend: React, TypeScript, Vite, Tailwind
- Tests: Python `unittest`, no database, no browser

## How to run

Backend. Create `.env` in the project root:

```env
DEBUG=True
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DB_NAME
```

```bash
uv sync
uv run alembic upgrade head
uv run uvicorn main:app --port 8000
```

Frontend, in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The dev server proxies `/reconciliation` to the backend.

Tests:

```bash
uv run python -m unittest discover -s tests -t .
```

Sample files live in `samples/`. A good demo order:

1. Upload `our_ledger.csv` and `other_statement.csv`. Every case below appears once.
2. Upload the same two files again. It is refused as a duplicate of the first run.
3. Resolve the two unmatched rows by hand (match `T-1011` with `C-9005`, accept `C-9006` as unpaired).
4. Upload `our_ledger_corrected.csv` with the statement. Yesterday's decisions still hold, and `T-1009` shows what it said before the correction.

## How it works

```
upload  ->  parse + normalise  ->  store rows for this run
run     ->  apply earlier manual decisions  ->  auto match  ->  compare  ->  store results
review  ->  filter to what needs attention  ->  inspect a row  ->  match by hand / accept unpaired
```

Tables:

| table | holds |
|---|---|
| `reconciliation_runs` | one row per morning run: file names, content hashes, status |
| `transactions` | every parsed row from both files, normalised, tagged with its run and source |
| `reconciliation_results` | one row per outcome in a run: a pair, or a single row with no pair, and its status |
| `field_differences` | for a pair that disagrees: which field, both values, the gap |
| `manual_decisions` | what a person decided, keyed by trade reference so it survives across runs |

Result statuses: `MATCHED`, `DIFFERENCE`, `MISSING_ON_OTHER_SIDE`, `MISSING_ON_OUR_SIDE`, `MANUALLY_MATCHED`, `ACCEPTED_UNPAIRED`, `CANCELLED`.

Endpoints:

```
POST /reconciliation/upload                  both CSVs -> new run
POST /reconciliation/{run_id}/reconcile      match and compare
GET  /reconciliation/runs                    run history with counts
GET  /reconciliation/{run_id}/results        rows, differences, previous values
POST /reconciliation/{run_id}/manual-match   {our_transaction_id, other_transaction_id}
POST /reconciliation/{run_id}/accept-unpaired {transaction_id}
```

## Decisions

**Different file formats.** One parser, driven by a table of column aliases in `src/services/file_parser.py`. `trade_id`, `reference` and `id` all mean the same thing; so do `BUY` and `B`, `BTC-USD` and `BTCUSD`, and the three date formats seen so far. A third company means adding its column names to that table. Timestamps with a timezone are converted to UTC and compared as naive UTC.

**The file's own total counts.** When a file has a `gross_amount` or `total` column that value is stored as the amount, rather than quantity times price. That is what the other side actually booked, fees included, and it is what the comparison should see.

**Matching, in order.** First, the same trade reference on both sides. The example data shows both companies sometimes share references, and that is the most reliable signal. Second, same instrument, side and quantity, closest in time within one hour. A row further away than an hour is not the same trade.

**Tolerance.** Small drift is normal and is not reported. Price and amount within 0.1 percent of our value, time within 60 seconds. Anything beyond that becomes a `DIFFERENCE` with the field, both values and the gap. Quantity must match exactly. The limits are constants at the top of `src/services/reconciliation.py`.

**Cancelled rows** are stored but never compared. They appear in the results as `CANCELLED` so the reviewer can see they were skipped rather than lost.

**Same file twice.** Both uploads are hashed. If the same pair has been uploaded before the upload is refused with the earlier run's id. A pair where only one file is identical is a new run, because the other file changed.

**Corrections.** A correction file is just a new run. The corrected values are the ones used from then on because each run works from its own rows. To answer "what did the row used to say", the results endpoint looks up the most recent earlier copy of each trade by source and reference and reports any fields that changed. The UI shows this under the current value.

**Manual decisions survive.** A decision is stored by trade reference, not row id, because tomorrow's upload creates new rows. When a run starts it applies stored decisions before automatic matching: a stored pair becomes `MANUALLY_MATCHED` (and is still compared, so a later price change on that pair is visible), an accepted row becomes `ACCEPTED_UNPAIRED`. Only rows that are still missing a pair can be resolved by hand.

**Re-running a run** deletes and rebuilds its results. Rows and decisions are untouched.

**Route functions are tested directly** with an in-memory SQLite database, without HTTP. The parser and comparison logic are tested with plain files and plain objects, without any database.

## Left out

- No authentication. `resolved_by` defaults to `operator`.
- No undo for a manual decision. Deleting the row from `manual_decisions` and re-running is the workaround.
- Runs are global, not per counterparty. A third company's statement would need a `source` on the run.
- Tolerances are fixed constants, not configurable per instrument or per counterparty.
- Matching is a linear scan per row. Fine for thousands of rows a day, not for millions.
- No pagination on results.

## Next

1. Per-counterparty runs and a `source` column on runs, so several statements can be reconciled independently.
2. Undo for manual decisions, with who and when shown in the UI.
3. Configurable tolerances stored in the database and shown on the review screen.
4. A one-to-many case: one ledger row filled by several statement rows. The current matcher only pairs one to one.
5. Index `transactions(source, external_id)` once volume grows, and page the results endpoint.
