# Transaction Reconciliation

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

Open http://localhost:5173.

Tests:

```bash
uv run python -m unittest discover -s tests -t .
```

Sample files are in `samples/`. Upload `our_ledger.csv` with `other_statement.csv` for a first run, then `our_ledger_corrected.csv` with the same statement to see a correction.

## What I decided and why

**Different file formats.** One parser driven by a table of column aliases. `trade_id`, `reference` and `id` all mean the same thing; so do `BUY` and `B`, `BTC-USD` and `BTCUSD`, and the date formats seen so far. A third company means adding its column names to that table.

**The file's own total counts.** When a file has a `gross_amount` or `total` column, that value is the amount, not quantity times price. It is what that side actually booked, fees included.

**Matching, in order.** First, the same trade reference on both sides. Second, same instrument, side and quantity, closest in time within one hour. Further apart than an hour is not the same trade.

**Tolerance.** Price and amount within 0.1 percent, time within 60 seconds, are normal drift and not reported. Beyond that the row is a difference and the operator sees the field, both values and the gap. Quantity must match exactly.

**Cancelled rows** are stored but never compared. They show as cancelled so the reviewer can see they were skipped, not lost.

**Same file twice.** Uploads are hashed. The same pair of files is refused with the earlier run's id.

**Corrections.** A correction file is a new run, so the corrected values are the ones used from then on. The results also show what each changed row said in the previous run.

**Manual decisions survive.** A decision is stored by trade reference, not row id, because tomorrow's upload creates new rows. Each run applies stored decisions before automatic matching. Only rows still missing a pair can be resolved by hand.

**Comparison logic has no database or browser.** The parser and matcher are plain functions tested with files and plain objects. Route tests use an in-memory SQLite database.

## What I left out

- Authentication. `resolved_by` is always `operator`.
- Undo for a manual decision.
- Per-counterparty runs. A third statement would need a source on the run.
- Configurable tolerances. They are constants in the code.
- Pagination. Results load in one page.

## What I would do next

1. Per-counterparty runs so several statements reconcile independently.
2. Undo for manual decisions, showing who decided and when.
3. Tolerances stored in the database and shown on the review screen.
4. One-to-many matching, where one ledger row is filled by several statement rows.
