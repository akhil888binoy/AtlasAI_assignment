from collections import Counter

from src.models.field_differences import FieldDifference
from src.models.manual_decisions import ManualDecision
from src.models.reconciliation_results import ReconciliationResult
from src.models.transactions import Transaction
from src.services.reconciliation import compare_transactions, find_match


def run_reconciliation(db, run_id):
    """Match and compare every row in a run, store the results, return counts by status.

    Steps: apply decisions people made earlier, auto-match the rest,
    record what is left over on each side, and list cancelled rows as skipped.
    """
    # Re-running a run replaces its previous results.
    db.query(ReconciliationResult).filter_by(run_id=run_id).delete()

    transactions = db.query(Transaction).filter_by(run_id=run_id).all()
    our_rows = [t for t in transactions if t.source == "OUR_LEDGER" and t.status == "ACTIVE"]
    other_rows = [t for t in transactions if t.source == "OTHER_STATEMENT" and t.status == "ACTIVE"]
    cancelled_rows = [t for t in transactions if t.status == "CANCELLED"]

    # Decisions people made on earlier runs still apply today.
    decisions = db.query(ManualDecision).all()
    manual_pairs = {
        d.our_external_id: d.other_external_id
        for d in decisions if d.our_external_id and d.other_external_id
    }
    accepted_ours = {d.our_external_id for d in decisions if not d.other_external_id}
    accepted_others = {d.other_external_id for d in decisions if not d.our_external_id}

    other_by_external_id = {t.external_id: t for t in other_rows}
    matched_other_ids = set()
    statuses = Counter()

    def add_result(status, our=None, other=None, differences=()):
        result = ReconciliationResult(
            run_id=run_id,
            our_transaction_id=our.id if our else None,
            other_transaction_id=other.id if other else None,
            status=status,
        )
        db.add(result)
        db.flush()
        for difference in differences:
            db.add(FieldDifference(result_id=result.id, **difference))
        statuses[status] += 1

    for our in our_rows:
        paired_id = manual_pairs.get(our.external_id)
        other = other_by_external_id.get(paired_id) if paired_id else None
        if other is not None and other.id not in matched_other_ids:
            matched_other_ids.add(other.id)
            add_result("MANUALLY_MATCHED", our, other, compare_transactions(our, other))
            continue

        if our.external_id in accepted_ours:
            add_result("ACCEPTED_UNPAIRED", our=our)
            continue

        other = find_match(our, other_rows, matched_other_ids)
        if other is None:
            add_result("MISSING_ON_OTHER_SIDE", our=our)
            continue

        matched_other_ids.add(other.id)
        differences = compare_transactions(our, other)
        add_result("DIFFERENCE" if differences else "MATCHED", our, other, differences)

    for other in other_rows:
        if other.id in matched_other_ids:
            continue
        if other.external_id in accepted_others:
            add_result("ACCEPTED_UNPAIRED", other=other)
        else:
            add_result("MISSING_ON_OUR_SIDE", other=other)

    # Cancelled rows are never compared, but the operator should see they were skipped.
    for row in cancelled_rows:
        if row.source == "OUR_LEDGER":
            add_result("CANCELLED", our=row)
        else:
            add_result("CANCELLED", other=row)

    return statuses
