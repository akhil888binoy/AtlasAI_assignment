import hashlib
import shutil
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, selectinload

from src.database.database import get_session
from src.models.field_differences import FieldDifference
from src.models.manual_decisions import ManualDecision
from src.models.reconciliation_results import ReconciliationResult
from src.models.reconciliation_runs import ReconciliationRun
from src.models.transactions import Transaction
from src.services.file_parser import parse_transactions
from src.services.reconciliation import compare_transactions
from src.services.run_reconciliation import run_reconciliation

router = APIRouter(prefix="/reconciliation", tags=["Reconciliation"])

UPLOAD_DIR = Path("uploads")
OUR_LEDGER_DIR = UPLOAD_DIR / "our_ledger"
OTHER_STATEMENT_DIR = UPLOAD_DIR / "other_statements"

OUR_LEDGER_DIR.mkdir(parents=True, exist_ok=True)
OTHER_STATEMENT_DIR.mkdir(parents=True, exist_ok=True)

COMPARED_FIELDS = ("timestamp", "instrument", "side", "quantity", "price", "amount")
UNMATCHED_STATUSES = ("MISSING_ON_OTHER_SIDE", "MISSING_ON_OUR_SIDE")


def file_hash(upload):
    digest = hashlib.sha256(upload.file.read()).hexdigest()
    upload.file.seek(0)
    return digest


def save_upload(upload, directory, run_id):
    path = directory / f"{run_id}_{upload.filename}"
    with open(path, "wb") as buffer:
        shutil.copyfileobj(upload.file, buffer)
    return path


@router.post("/upload")
async def upload_files(
    our_file: UploadFile = File(...),
    other_file: UploadFile = File(...),
    db: Session = Depends(get_session),
):
    our_hash = file_hash(our_file)
    other_hash = file_hash(other_file)

    duplicate = (
        db.query(ReconciliationRun)
        .filter_by(our_file_hash=our_hash, other_file_hash=other_hash)
        .first()
    )
    if duplicate:
        raise HTTPException(
            status_code=409,
            detail=f"These exact files were already uploaded as run #{duplicate.id}.",
        )

    run = ReconciliationRun(
        created_at=datetime.utcnow(),
        our_file=our_file.filename,
        other_file=other_file.filename,
        our_file_hash=our_hash,
        other_file_hash=other_hash,
        status="UPLOADED",
    )
    db.add(run)
    db.flush()

    our_path = save_upload(our_file, OUR_LEDGER_DIR, run.id)
    other_path = save_upload(other_file, OTHER_STATEMENT_DIR, run.id)

    transactions = (
        parse_transactions(our_path, "OUR_LEDGER")
        + parse_transactions(other_path, "OTHER_STATEMENT")
    )
    for transaction in transactions:
        db.add(Transaction(run_id=run.id, **transaction))

    run.status = "INGESTED"
    db.commit()

    return {
        "run_id": run.id,
        "status": run.status,
        "our_transactions": sum(1 for t in transactions if t["source"] == "OUR_LEDGER"),
        "other_transactions": sum(1 for t in transactions if t["source"] == "OTHER_STATEMENT"),
    }


@router.post("/{run_id}/reconcile")
def reconcile(run_id: int, db: Session = Depends(get_session)):
    run = db.get(ReconciliationRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")

    summary = run_reconciliation(db, run_id)

    run.status = "RECONCILED"
    db.commit()

    return {"run_id": run_id, "status": run.status, "summary": dict(summary)}


def get_unmatched_result(db, run_id, transaction_id):
    """The result row for a transaction that is still missing its pair, or 400."""
    result = (
        db.query(ReconciliationResult)
        .filter(
            ReconciliationResult.run_id == run_id,
            ReconciliationResult.status.in_(UNMATCHED_STATUSES),
            or_(
                ReconciliationResult.our_transaction_id == transaction_id,
                ReconciliationResult.other_transaction_id == transaction_id,
            ),
        )
        .first()
    )
    if result is None:
        raise HTTPException(
            status_code=400,
            detail="Only rows that are still unmatched can be resolved by hand.",
        )
    return result


def save_decision(db, our_external_id, other_external_id, resolved_by):
    """Store a hand decision once. Making the same decision again on a later run is a no-op."""
    exists = (
        db.query(ManualDecision)
        .filter_by(our_external_id=our_external_id, other_external_id=other_external_id)
        .first()
    )
    if exists is None:
        db.add(ManualDecision(
            our_external_id=our_external_id,
            other_external_id=other_external_id,
            resolved_by=resolved_by,
            resolved_at=datetime.utcnow(),
        ))


@router.post("/{run_id}/manual-match")
def manual_match(
    run_id: int,
    our_transaction_id: int = Body(...),
    other_transaction_id: int = Body(...),
    resolved_by: str = Body("operator"),
    db: Session = Depends(get_session),
):
    our_result = get_unmatched_result(db, run_id, our_transaction_id)
    other_result = get_unmatched_result(db, run_id, other_transaction_id)

    our = our_result.our_transaction
    other = other_result.other_transaction
    if our is None or other is None:
        raise HTTPException(status_code=400, detail="Pick one row from each side.")

    save_decision(db, our.external_id, other.external_id, resolved_by)

    our_result.other_transaction_id = other.id
    our_result.status = "MANUALLY_MATCHED"
    for difference in compare_transactions(our, other):
        db.add(FieldDifference(result_id=our_result.id, **difference))
    db.delete(other_result)
    db.commit()

    return {"result_id": our_result.id, "run_id": run_id, "status": our_result.status}


@router.post("/{run_id}/accept-unpaired")
def accept_unpaired(
    run_id: int,
    transaction_id: int = Body(...),
    resolved_by: str = Body("operator"),
    db: Session = Depends(get_session),
):
    result = get_unmatched_result(db, run_id, transaction_id)
    transaction = result.our_transaction or result.other_transaction

    if transaction.source == "OUR_LEDGER":
        save_decision(db, transaction.external_id, None, resolved_by)
    else:
        save_decision(db, None, transaction.external_id, resolved_by)

    result.status = "ACCEPTED_UNPAIRED"
    db.commit()

    return {"result_id": result.id, "run_id": run_id, "status": result.status}


@router.get("/runs")
def list_runs(db: Session = Depends(get_session)):
    runs = db.query(ReconciliationRun).order_by(ReconciliationRun.id.desc()).all()

    counts = (
        db.query(ReconciliationResult.run_id, ReconciliationResult.status, func.count())
        .group_by(ReconciliationResult.run_id, ReconciliationResult.status)
        .all()
    )
    summaries = defaultdict(dict)
    for run_id, status, count in counts:
        summaries[run_id][status] = count

    return [
        {
            "id": run.id,
            "created_at": run.created_at,
            "our_file": run.our_file,
            "other_file": run.other_file,
            "status": run.status,
            "summary": summaries[run.id],
        }
        for run in runs
    ]


def previous_versions(db, run_id, external_ids):
    """The most recent earlier copy of each trade, keyed by (source, external_id).

    Answers "what did this row say before the correction?".
    """
    earlier = (
        db.query(Transaction)
        .filter(Transaction.run_id < run_id, Transaction.external_id.in_(external_ids))
        .order_by(Transaction.run_id.desc())
        .all()
    )
    versions = {}
    for transaction in earlier:
        versions.setdefault((transaction.source, transaction.external_id), transaction)
    return versions


def transaction_json(transaction, versions):
    if transaction is None:
        return None

    before = versions.get((transaction.source, transaction.external_id))
    changed = {} if before is None else {
        field: getattr(before, field)
        for field in COMPARED_FIELDS
        if getattr(before, field) != getattr(transaction, field)
    }

    return {
        "id": transaction.id,
        "external_id": transaction.external_id,
        "timestamp": transaction.timestamp,
        "instrument": transaction.instrument,
        "side": transaction.side,
        "quantity": transaction.quantity,
        "price": transaction.price,
        "amount": transaction.amount,
        "status": transaction.status,
        "previous_values": changed,
    }


@router.get("/{run_id}/results")
def get_results(run_id: int, db: Session = Depends(get_session)):
    results = (
        db.query(ReconciliationResult)
        .filter_by(run_id=run_id)
        .options(
            selectinload(ReconciliationResult.our_transaction),
            selectinload(ReconciliationResult.other_transaction),
            selectinload(ReconciliationResult.differences),
        )
        .order_by(ReconciliationResult.id)
        .all()
    )

    external_ids = {
        t.external_id
        for result in results
        for t in (result.our_transaction, result.other_transaction)
        if t is not None
    }
    versions = previous_versions(db, run_id, external_ids)

    return {
        "run_id": run_id,
        "results": [
            {
                "result_id": result.id,
                "status": result.status,
                "our_transaction": transaction_json(result.our_transaction, versions),
                "other_transaction": transaction_json(result.other_transaction, versions),
                "differences": [
                    {
                        "field_name": d.field_name,
                        "our_value": d.our_value,
                        "other_value": d.other_value,
                        "difference": d.difference,
                    }
                    for d in result.differences
                ],
            }
            for result in results
        ],
    }
