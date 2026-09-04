from fastapi import APIRouter, UploadFile, File, Depends
from sqlalchemy.orm import Session
from datetime import datetime
from pathlib import Path
import shutil
from src.services.reconciliation import find_match, compare_transactions
from src.models.reconciliation_results import ReconciliationResult
from src.models.field_differences import FieldDifference
from src.database.database import get_session
from src.models.reconciliation_runs import ReconciliationRun
from src.models.transactions import Transaction
from src.services.file_parser import (
    parse_our_ledger,
    parse_other_statement
)

router = APIRouter(
    prefix="/reconciliation",
    tags=["Reconciliation"]
)

UPLOAD_DIR = Path("uploads")
OUR_LEDGER_DIR = UPLOAD_DIR / "our_ledger"
OTHER_STATEMENT_DIR = UPLOAD_DIR / "other_statements"

OUR_LEDGER_DIR.mkdir(parents=True, exist_ok=True)
OTHER_STATEMENT_DIR.mkdir(parents=True, exist_ok=True)


@router.post("/upload")
async def upload_files(
    our_file: UploadFile = File(...),
    other_file: UploadFile = File(...),
    db: Session = Depends(get_session)
):

    # 1. Create reconciliation run
    reconciliation_run = ReconciliationRun(
        created_at=datetime.utcnow(),
        our_file=our_file.filename,
        other_file=other_file.filename,
        status="UPLOADED"
    )

    db.add(reconciliation_run)
    db.commit()
    db.refresh(reconciliation_run)

    # 2. Save uploaded files
    our_file_path = OUR_LEDGER_DIR / our_file.filename
    other_file_path = OTHER_STATEMENT_DIR / other_file.filename

    with open(our_file_path, "wb") as buffer:
        shutil.copyfileobj(our_file.file, buffer)

    with open(other_file_path, "wb") as buffer:
        shutil.copyfileobj(other_file.file, buffer)

    # 3. Parse and normalize our ledger
    our_transactions = parse_our_ledger(our_file_path)

    # 4. Parse and normalize other statement
    other_transactions = parse_other_statement(other_file_path)

    # 5. Remove cancelled transactions
    our_transactions = [
        transaction
        for transaction in our_transactions
        if transaction["status"] != "CANCELLED"
    ]

    other_transactions = [
        transaction
        for transaction in other_transactions
        if transaction["status"] != "CANCELLED"
    ]

    # 6. Store our ledger transactions
    for transaction in our_transactions:
        db.add(
            Transaction(
                run_id=reconciliation_run.id,
                **transaction
            )
        )

    # 7. Store other statement transactions
    for transaction in other_transactions:
        db.add(
            Transaction(
                run_id=reconciliation_run.id,
                **transaction
            )
        )

    # 8. Mark ingestion as completed
    reconciliation_run.status = "INGESTED"

    db.commit()

    # 9. Return ingestion summary
    return {
        "run_id": reconciliation_run.id,
        "status": "INGESTED",
        "our_transactions": len(our_transactions),
        "other_transactions": len(other_transactions)
    }

@router.post("/{run_id}/reconcile")
def reconcile(
    run_id: int,
    db: Session = Depends(get_session)
):

    # 1. Get all transactions for this reconciliation run
    transactions = (
        db.query(Transaction)
        .filter(Transaction.run_id == run_id)
        .all()
    )

    # 2. Separate transactions by source
    our_transactions = [
        transaction
        for transaction in transactions
        if transaction.source == "OUR_LEDGER"
    ]

    other_transactions = [
        transaction
        for transaction in transactions
        if transaction.source == "OTHER_STATEMENT"
    ]

    # 3. Keep track of transactions already matched
    matched_other_ids = set()

    # 4. Initialize result counters
    matched_count = 0
    difference_count = 0
    missing_on_other_side_count = 0
    missing_on_our_side_count = 0

    # 5. Match our transactions against the other statement
    for our_transaction in our_transactions:

        other_transaction = find_match(
            our_transaction,
            other_transactions,
            matched_other_ids
        )

        # 6. No matching transaction found
        if other_transaction is None:

            result = ReconciliationResult(
                run_id=run_id,
                our_transaction_id=our_transaction.id,
                other_transaction_id=None,
                status="MISSING_ON_OTHER_SIDE"
            )

            db.add(result)

            missing_on_other_side_count += 1

            continue

        # 7. Mark other transaction as matched
        matched_other_ids.add(other_transaction.id)

        # 8. Compare the matched transactions
        status = compare_transactions(
            our_transaction,
            other_transaction
        )

        # 9. Save reconciliation result
        result = ReconciliationResult(
            run_id=run_id,
            our_transaction_id=our_transaction.id,
            other_transaction_id=other_transaction.id,
            status=status
        )

        db.add(result)
        db.flush()

        # 10. Update counters
        if status == "MATCHED":

            matched_count += 1

        elif status == "DIFFERENCE":

            difference_count += 1

            # Save price difference
            difference = FieldDifference(
                result_id=result.id,
                field_name="price",
                our_value=str(our_transaction.price),
                other_value=str(other_transaction.price),
                difference=(
                    other_transaction.price
                    - our_transaction.price
                )
            )

            db.add(difference)

    # 11. Find transactions that exist only on the other side
    for other_transaction in other_transactions:

        if other_transaction.id in matched_other_ids:
            continue

        result = ReconciliationResult(
            run_id=run_id,
            our_transaction_id=None,
            other_transaction_id=other_transaction.id,
            status="MISSING_ON_OUR_SIDE"
        )

        db.add(result)

        missing_on_our_side_count += 1

    # 12. Mark reconciliation run as completed
    reconciliation_run = (
        db.query(ReconciliationRun)
        .filter(ReconciliationRun.id == run_id)
        .first()
    )

    if reconciliation_run:
        reconciliation_run.status = "RECONCILED"

    # 13. Save all results
    db.commit()

    # 14. Return reconciliation summary
    return {
        "run_id": run_id,
        "status": "RECONCILED",
        "summary": {
            "matched": matched_count,
            "differences": difference_count,
            "missing_on_other_side": missing_on_other_side_count,
            "missing_on_our_side": missing_on_our_side_count
        }
    }

@router.get("/{run_id}/results")
def get_results(
    run_id: int,
    db: Session = Depends(get_session)
):

    # Get all reconciliation results for this run
    results = (
        db.query(ReconciliationResult)
        .filter(ReconciliationResult.run_id == run_id)
        .all()
    )

    response = []

    for result in results:

        our_transaction = None
        other_transaction = None

        # Get our transaction
        if result.our_transaction_id is not None:
            our_transaction = (
                db.query(Transaction)
                .filter(
                    Transaction.id == result.our_transaction_id
                )
                .first()
            )

        # Get other transaction
        if result.other_transaction_id is not None:
            other_transaction = (
                db.query(Transaction)
                .filter(
                    Transaction.id == result.other_transaction_id
                )
                .first()
            )

        response.append({
            "result_id": result.id,
            "status": result.status,

            "our_transaction": (
                {
                    "id": our_transaction.id,
                    "external_id": our_transaction.external_id,
                    "timestamp": our_transaction.timestamp,
                    "instrument": our_transaction.instrument,
                    "side": our_transaction.side,
                    "quantity": our_transaction.quantity,
                    "price": our_transaction.price,
                    "amount": our_transaction.amount
                }
                if our_transaction
                else None
            ),

            "other_transaction": (
                {
                    "id": other_transaction.id,
                    "external_id": other_transaction.external_id,
                    "timestamp": other_transaction.timestamp,
                    "instrument": other_transaction.instrument,
                    "side": other_transaction.side,
                    "quantity": other_transaction.quantity,
                    "price": other_transaction.price,
                    "amount": other_transaction.amount
                }
                if other_transaction
                else None
            )
        })

    return {
        "run_id": run_id,
        "results": response
    }