import tempfile
import unittest
from pathlib import Path

from src.services.file_parser import parse_other_statement, parse_our_ledger


class FileParserTests(unittest.TestCase):
    def test_parse_our_ledger_accepts_assignment_headers(self):
        csv_text = (
            "trade_id,traded_at,instrument,side,quantity,price,gross_amount,state\n"
            "T-1,2026-09-01 09:15:00,BTC-USD,BUY,0.5,60000.0,30000.0,COMPLETED\n"
            "T-2,2026-09-01 09:20:00,ETH-USD,SELL,1.0,3400.0,3400.0,CANCELLED\n"
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            file_path = Path(tmp_dir) / "our.csv"
            file_path.write_text(csv_text)

            transactions = parse_our_ledger(file_path)

        self.assertEqual(len(transactions), 2)
        self.assertEqual(transactions[0]["external_id"], "T-1")
        self.assertEqual(transactions[0]["instrument"], "BTC-USD")
        self.assertEqual(transactions[0]["side"], "BUY")
        self.assertEqual(transactions[0]["quantity"], 0.5)
        self.assertEqual(transactions[0]["amount"], 30000.0)
        self.assertEqual(transactions[1]["status"], "CANCELLED")

    def test_parse_other_statement_normalizes_external_format(self):
        csv_text = (
            "reference,executed_at,symbol,direction,qty,unit_price,total,status\n"
            "EXT-1,01/09/2026 09:15:02,BTCUSD,B,0.5,60000.0,30000.0,SETTLED\n"
            "EXT-2,01/09/2026 09:20:00,ETHUSD,S,1.0,3400.0,3400.0,CANCELLED\n"
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            file_path = Path(tmp_dir) / "other.csv"
            file_path.write_text(csv_text)

            transactions = parse_other_statement(file_path)

        self.assertEqual(len(transactions), 2)
        self.assertEqual(transactions[0]["external_id"], "EXT-1")
        self.assertEqual(transactions[0]["instrument"], "BTC-USD")
        self.assertEqual(transactions[0]["side"], "BUY")
        self.assertEqual(transactions[0]["status"], "ACTIVE")
        self.assertEqual(transactions[1]["status"], "CANCELLED")


if __name__ == "__main__":
    unittest.main()
