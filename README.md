# Transaction Reconciliation

Small full-stack app for reconciling internal ledger trades against an external statement.

The backend ingests two CSV files, normalizes the transaction fields, ignores cancelled rows, matches records, and stores reconciliation results. The frontend provides a simple review workspace for uploading files and inspecting matched trades, price differences, and missing records.

## Tech Stack

- Backend: FastAPI, SQLAlchemy, Alembic
- Database: PostgreSQL for normal app runs
- Frontend: React, TypeScript, Vite, Tailwind CSS
- Tests: Python `unittest`

## Project Structure

```text
.
├── main.py
├── src/
│   ├── database/
│   ├── models/
│   ├── routers/
│   └── services/
├── tests/
├── uploads/
└── frontend/
    └── src/
```

## Backend Setup

Create a `.env` file in the project root:

```env
DEBUG=True
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DB_NAME
```

Install and run the backend with `uv`:

```bash
uv sync
uv run alembic upgrade head
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

API docs are available at:

```text
http://127.0.0.1:8000/docs
```

## Frontend Setup

In a second terminal:

```bash
cd frontend
npm install
npm run dev -- --host 127.0.0.1
```

Open:

```text
http://127.0.0.1:5173/
```

The Vite dev server proxies `/reconciliation` requests to the backend at `http://localhost:8000`.

## CSV Inputs

The app expects two CSV files:

### Internal Ledger

Supported headers include:

```text
trade_id,traded_at,instrument,side,quantity,price,gross_amount,state
```

Also supported:

```text
trade_id,time,symbol,side,qty,price
```

### External Statement

Supported headers include:

```text
reference,executed_at,symbol,direction,qty,unit_price,total,status
```

Also supported:

```text
id,date,instrument,direction,quantity,execution_price,status
```

The parser normalizes:

- `BTCUSD` to `BTC-USD`
- `B` to `BUY`
- `S` to `SELL`
- `SETTLED` and `COMPLETED` to active records
- `CANCELLED` rows are ignored during reconciliation

Sample CSV files are available in:

```text
uploads/our_ledger/our_ledger.csv
uploads/other_statements/other_statement.csv
```

## Reconciliation Rules

A transaction is considered a candidate match when:

- Instrument matches
- Side matches
- Quantity matches
- Timestamp is within 5 seconds

After a candidate match is found:

- Same price means `MATCHED`
- Different price means `DIFFERENCE`
- Internal-only rows are `MISSING_ON_OTHER_SIDE`
- External-only rows are `MISSING_ON_OUR_SIDE`

## Main API Endpoints

```text
POST /reconciliation/upload
POST /reconciliation/{run_id}/reconcile
GET  /reconciliation/{run_id}/results
```

## Running Tests

The backend tests use Python's built-in `unittest`, so no extra test dependency is required.

```bash
uv run python -m unittest discover -s tests -v
```

Current coverage includes:

- CSV parser normalization
- Matching and comparison logic
- Upload, reconcile, and results route flow using an isolated in-memory SQLite database

## Frontend Checks

```bash
cd frontend
npm run lint
npm run build
```

## Notes

- The backend uses the database configured in `DATABASE_URL` for normal app runs.
- Tests do not use the real database; they create an isolated in-memory SQLite database.
- Uploaded files are stored under `uploads/`.
