import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from src.services.file_parser import parse_transactions


def parse_csv(csv_text, source):
    with tempfile.TemporaryDirectory() as tmp_dir:
        file_path = Path(tmp_dir) / "file.csv"
        file_path.write_text(csv_text)
        return parse_transactions(file_path, source)


class FileParserTests(unittest.TestCase):
    def test_parses_our_ledger_format(self):
        rows = parse_csv(
            "trade_id,traded_at,instrument,side,quantity,price,gross_amount,state\n"
            "T-1,2026-09-01T09:15:00Z,BTC-USD,BUY,0.5,60000.0,30010.0,SETTLED\n"
            "T-2,2026-09-01 09:20:00,ETH-USD,SELL,1.0,3400.0,3400.0,CANCELLED\n",
            "OUR_LEDGER",
        )

        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["source"], "OUR_LEDGER")
        self.assertEqual(rows[0]["external_id"], "T-1")
        self.assertEqual(rows[0]["timestamp"], datetime(2026, 9, 1, 9, 15))
        self.assertEqual(rows[0]["instrument"], "BTC-USD")
        self.assertEqual(rows[0]["side"], "BUY")
        # The file's own total wins over quantity * price.
        self.assertEqual(rows[0]["amount"], 30010.0)
        self.assertEqual(rows[0]["status"], "ACTIVE")
        self.assertEqual(rows[1]["status"], "CANCELLED")

    def test_parses_other_statement_format(self):
        rows = parse_csv(
            "reference,executed_at,symbol,direction,qty,unit_price,total,status\n"
            "EXT-1,01/09/2026 09:15:02,BTCUSD,B,0.5,60000,30000.00,SETTLED\n",
            "OTHER_STATEMENT",
        )

        self.assertEqual(rows[0]["external_id"], "EXT-1")
        self.assertEqual(rows[0]["timestamp"], datetime(2026, 9, 1, 9, 15, 2))
        self.assertEqual(rows[0]["instrument"], "BTC-USD")
        self.assertEqual(rows[0]["side"], "BUY")
        self.assertEqual(rows[0]["quantity"], 0.5)

    def test_amount_falls_back_to_quantity_times_price(self):
        rows = parse_csv(
            "id,date,instrument,direction,quantity,execution_price,status\n"
            "X-1,2026-09-01 09:15:00,SOL-USD,S,10,150,COMPLETED\n",
            "OTHER_STATEMENT",
        )

        self.assertEqual(rows[0]["amount"], 1500.0)

    def test_missing_column_is_reported(self):
        with self.assertRaises(KeyError):
            parse_csv("trade_id,traded_at\nT-1,2026-09-01 09:15:00\n", "OUR_LEDGER")


if __name__ == "__main__":
    unittest.main()
