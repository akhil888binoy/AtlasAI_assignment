from datetime import timedelta


def find_match(
    our_transaction,
    other_transactions,
    matched_other_ids
):

    for other_transaction in other_transactions:

        # Skip already matched transactions
        if other_transaction.id in matched_other_ids:
            continue

        if our_transaction.instrument != other_transaction.instrument:
            continue

        if our_transaction.side != other_transaction.side:
            continue

        if our_transaction.quantity != other_transaction.quantity:
            continue

        time_difference = abs(
            our_transaction.timestamp -
            other_transaction.timestamp
        )

        if time_difference <= timedelta(seconds=5):
            return other_transaction

    return None


def compare_transactions(our_transaction, other_transaction):

    if our_transaction.price == other_transaction.price:
        return "MATCHED"

    return "DIFFERENCE"


