from datetime import timedelta

# Differences inside these limits are normal drift (rounding, fees, clock skew)
# and are not reported. Anything larger is shown to the operator.
PRICE_TOLERANCE = 0.001   # fraction of our price
AMOUNT_TOLERANCE = 0.001  # fraction of our amount
TIME_TOLERANCE = timedelta(seconds=60)

# Two rows further apart than this are not considered the same trade at all.
MATCH_WINDOW = timedelta(hours=1)


def find_match(our_transaction, other_transactions, matched_other_ids):
    """Pick the other-side row most likely to be the same trade, or None."""
    candidates = [
        other for other in other_transactions
        if other.id not in matched_other_ids
    ]

    # Best case: both systems recorded the same trade reference.
    for other in candidates:
        if other.external_id == our_transaction.external_id:
            return other

    # Otherwise: same instrument, side and quantity, closest in time.
    same_trade = [
        other for other in candidates
        if other.instrument == our_transaction.instrument
        and other.side == our_transaction.side
        and other.quantity == our_transaction.quantity
        and abs(other.timestamp - our_transaction.timestamp) <= MATCH_WINDOW
    ]

    if not same_trade:
        return None

    return min(
        same_trade,
        key=lambda other: abs(other.timestamp - our_transaction.timestamp),
    )


def compare_transactions(our_transaction, other_transaction):
    """Return the fields that differ by more than the tolerance.

    Each entry has the same keys as the field_differences table so the
    caller can store it directly. An empty list means the rows agree.
    """
    differences = []

    if our_transaction.quantity != other_transaction.quantity:
        differences.append(field_difference(
            "quantity", our_transaction.quantity, other_transaction.quantity
        ))

    price_gap = other_transaction.price - our_transaction.price
    if abs(price_gap) > abs(our_transaction.price) * PRICE_TOLERANCE:
        differences.append(field_difference(
            "price", our_transaction.price, other_transaction.price
        ))

    amount_gap = other_transaction.amount - our_transaction.amount
    if abs(amount_gap) > abs(our_transaction.amount) * AMOUNT_TOLERANCE:
        differences.append(field_difference(
            "amount", our_transaction.amount, other_transaction.amount
        ))

    time_gap = other_transaction.timestamp - our_transaction.timestamp
    if abs(time_gap) > TIME_TOLERANCE:
        differences.append(field_difference(
            "timestamp",
            our_transaction.timestamp.isoformat(),
            other_transaction.timestamp.isoformat(),
            time_gap.total_seconds(),
        ))

    return differences


def field_difference(field_name, our_value, other_value, gap=None):
    if gap is None:
        gap = other_value - our_value

    return {
        "field_name": field_name,
        "our_value": str(our_value),
        "other_value": str(other_value),
        "difference": round(gap, 8),
    }
