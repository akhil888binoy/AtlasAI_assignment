import unittest
from datetime import datetime
from types import SimpleNamespace

from src.services.reconciliation import compare_transactions, find_match


def transaction(
    *,
    transaction_id=1,
    instrument="BTC-USD",
    side="BUY",
    quantity=1.0,
    price=100.0,
    timestamp=None,
):
    return SimpleNamespace(
        id=transaction_id,
        instrument=instrument,
        side=side,
        quantity=quantity,
        price=price,
        timestamp=timestamp or datetime(2026, 9, 1, 9, 15, 0),
    )


class ReconciliationServiceTests(unittest.TestCase):
    def test_find_match_uses_instrument_side_quantity_and_time_window(self):
        our_transaction = transaction(timestamp=datetime(2026, 9, 1, 9, 15, 0))
        other_transactions = [
            transaction(transaction_id=2, instrument="ETH-USD"),
            transaction(
                transaction_id=3,
                timestamp=datetime(2026, 9, 1, 9, 15, 4),
            ),
        ]

        match = find_match(our_transaction, other_transactions, set())

        self.assertEqual(match.id, 3)

    def test_find_match_ignores_already_matched_transactions(self):
        our_transaction = transaction(timestamp=datetime(2026, 9, 1, 9, 15, 0))
        other_transaction = transaction(
            transaction_id=2,
            timestamp=datetime(2026, 9, 1, 9, 15, 2),
        )

        match = find_match(our_transaction, [other_transaction], {2})

        self.assertIsNone(match)

    def test_find_match_rejects_transactions_outside_time_window(self):
        our_transaction = transaction(timestamp=datetime(2026, 9, 1, 9, 15, 0))
        other_transaction = transaction(
            transaction_id=2,
            timestamp=datetime(2026, 9, 1, 9, 15, 6),
        )

        match = find_match(our_transaction, [other_transaction], set())

        self.assertIsNone(match)

    def test_compare_transactions_reports_match_or_difference(self):
        our_transaction = transaction(price=100.0)

        self.assertEqual(
            compare_transactions(our_transaction, transaction(price=100.0)),
            "MATCHED",
        )
        self.assertEqual(
            compare_transactions(our_transaction, transaction(price=101.0)),
            "DIFFERENCE",
        )


if __name__ == "__main__":
    unittest.main()
