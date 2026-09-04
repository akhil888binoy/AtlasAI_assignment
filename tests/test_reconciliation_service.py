import unittest
from datetime import datetime
from types import SimpleNamespace

from src.services.reconciliation import compare_transactions, find_match


def transaction(
    *,
    transaction_id=1,
    external_id="T-1",
    instrument="BTC-USD",
    side="BUY",
    quantity=1.0,
    price=100.0,
    amount=None,
    timestamp=None,
):
    return SimpleNamespace(
        id=transaction_id,
        external_id=external_id,
        instrument=instrument,
        side=side,
        quantity=quantity,
        price=price,
        amount=amount if amount is not None else quantity * price,
        timestamp=timestamp or datetime(2026, 9, 1, 9, 15, 0),
    )


class FindMatchTests(unittest.TestCase):
    def test_same_reference_wins_even_if_fields_differ(self):
        ours = transaction(external_id="T-1")
        others = [
            transaction(transaction_id=2, external_id="X-9"),
            transaction(transaction_id=3, external_id="T-1", quantity=2.0),
        ]

        self.assertEqual(find_match(ours, others, set()).id, 3)

    def test_falls_back_to_closest_in_time_with_same_trade_fields(self):
        ours = transaction(timestamp=datetime(2026, 9, 1, 9, 15, 0))
        others = [
            transaction(transaction_id=2, external_id="X-1", instrument="ETH-USD"),
            transaction(transaction_id=3, external_id="X-2", timestamp=datetime(2026, 9, 1, 9, 40, 0)),
            transaction(transaction_id=4, external_id="X-3", timestamp=datetime(2026, 9, 1, 9, 15, 4)),
        ]

        self.assertEqual(find_match(ours, others, set()).id, 4)

    def test_ignores_already_matched_and_rows_outside_window(self):
        ours = transaction(timestamp=datetime(2026, 9, 1, 9, 15, 0))
        others = [
            transaction(transaction_id=2, external_id="X-1", timestamp=datetime(2026, 9, 1, 9, 15, 2)),
            transaction(transaction_id=3, external_id="X-2", timestamp=datetime(2026, 9, 1, 11, 0, 0)),
        ]

        self.assertIsNone(find_match(ours, others, {2}))


class CompareTransactionsTests(unittest.TestCase):
    def test_tiny_drift_is_not_a_difference(self):
        ours = transaction(price=62000.0, amount=31000.0, timestamp=datetime(2026, 9, 1, 9, 15, 0))
        other = transaction(price=62000.5, amount=31010.0, timestamp=datetime(2026, 9, 1, 9, 15, 30))

        self.assertEqual(compare_transactions(ours, other), [])

    def test_large_price_gap_is_reported_with_amount(self):
        ours = transaction(quantity=10.0, price=3400.0)
        other = transaction(quantity=10.0, price=3417.0)

        differences = compare_transactions(ours, other)

        self.assertEqual([d["field_name"] for d in differences], ["price", "amount"])
        self.assertEqual(differences[0]["difference"], 17.0)
        self.assertEqual(differences[0]["our_value"], "3400.0")
        self.assertEqual(differences[0]["other_value"], "3417.0")

    def test_large_time_gap_is_reported_in_seconds(self):
        ours = transaction(timestamp=datetime(2026, 9, 1, 10, 0, 0))
        other = transaction(timestamp=datetime(2026, 9, 1, 10, 40, 0))

        differences = compare_transactions(ours, other)

        self.assertEqual(differences[0]["field_name"], "timestamp")
        self.assertEqual(differences[0]["difference"], 2400.0)

    def test_quantity_must_match_exactly(self):
        differences = compare_transactions(transaction(quantity=1.0), transaction(quantity=1.001))

        self.assertEqual(differences[0]["field_name"], "quantity")


if __name__ == "__main__":
    unittest.main()
