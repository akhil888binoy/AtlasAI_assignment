import asyncio
import tempfile
import unittest
from pathlib import Path

from fastapi import UploadFile
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import src.models
import src.routers.reconciliation as reconciliation_router
from src.database.database import Base


OUR_LEDGER_CSV = """trade_id,traded_at,instrument,side,quantity,price,gross_amount,state
T-1,2026-09-01 09:15:00,BTC-USD,BUY,0.5,60000.0,30000.0,COMPLETED
T-2,2026-09-01 09:20:00,ETH-USD,SELL,10.0,3400.0,34000.0,COMPLETED
T-3,2026-09-01 09:25:00,SOL-USD,BUY,1.0,145.0,145.0,CANCELLED
"""

OTHER_STATEMENT_CSV = """reference,executed_at,symbol,direction,qty,unit_price,total,status
EXT-1,01/09/2026 09:15:02,BTCUSD,B,0.5,60000.0,30000.0,SETTLED
EXT-2,01/09/2026 09:20:00,ETHUSD,S,10.0,3417.0,34170.0,SETTLED
EXT-3,01/09/2026 09:30:00,SOLUSD,B,2.0,150.0,300.0,SETTLED
EXT-4,01/09/2026 09:35:00,BTCUSD,S,1.0,61000.0,61000.0,CANCELLED
"""


class ReconciliationRouteTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(bind=self.engine)
        self.Session = sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=self.engine,
        )
        self.session = self.Session()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.upload_root = Path(self.tmp_dir.name)
        self.open_files = []

        self.original_upload_dir = reconciliation_router.UPLOAD_DIR
        self.original_our_dir = reconciliation_router.OUR_LEDGER_DIR
        self.original_other_dir = reconciliation_router.OTHER_STATEMENT_DIR

        reconciliation_router.UPLOAD_DIR = self.upload_root
        reconciliation_router.OUR_LEDGER_DIR = self.upload_root / "our_ledger"
        reconciliation_router.OTHER_STATEMENT_DIR = (
            self.upload_root / "other_statements"
        )
        reconciliation_router.OUR_LEDGER_DIR.mkdir(parents=True, exist_ok=True)
        reconciliation_router.OTHER_STATEMENT_DIR.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        for file in self.open_files:
            file.close()

        self.session.close()
        Base.metadata.drop_all(bind=self.engine)
        self.engine.dispose()
        self.tmp_dir.cleanup()

        reconciliation_router.UPLOAD_DIR = self.original_upload_dir
        reconciliation_router.OUR_LEDGER_DIR = self.original_our_dir
        reconciliation_router.OTHER_STATEMENT_DIR = self.original_other_dir

    def test_upload_reconcile_and_get_results(self):
        upload_response = asyncio.run(
            reconciliation_router.upload_files(
                our_file=self.make_upload_file("our.csv", OUR_LEDGER_CSV),
                other_file=self.make_upload_file("other.csv", OTHER_STATEMENT_CSV),
                db=self.session,
            )
        )

        self.assertEqual(upload_response["status"], "INGESTED")
        self.assertEqual(upload_response["our_transactions"], 2)
        self.assertEqual(upload_response["other_transactions"], 3)

        reconcile_response = reconciliation_router.reconcile(
            upload_response["run_id"],
            db=self.session,
        )

        self.assertEqual(reconcile_response["status"], "RECONCILED")
        self.assertEqual(
            reconcile_response["summary"],
            {
                "matched": 1,
                "differences": 1,
                "missing_on_other_side": 0,
                "missing_on_our_side": 1,
            },
        )

        results_response = reconciliation_router.get_results(
            upload_response["run_id"],
            db=self.session,
        )

        statuses = [row["status"] for row in results_response["results"]]
        self.assertEqual(statuses.count("MATCHED"), 1)
        self.assertEqual(statuses.count("DIFFERENCE"), 1)
        self.assertEqual(statuses.count("MISSING_ON_OUR_SIDE"), 1)

        difference_row = next(
            row for row in results_response["results"] if row["status"] == "DIFFERENCE"
        )
        self.assertEqual(difference_row["our_transaction"]["external_id"], "T-2")
        self.assertEqual(difference_row["other_transaction"]["external_id"], "EXT-2")

    def make_upload_file(self, filename, content):
        path = self.upload_root / filename
        path.write_text(content)
        file = path.open("rb")
        self.open_files.append(file)
        return UploadFile(file, filename=filename)


if __name__ == "__main__":
    unittest.main()
