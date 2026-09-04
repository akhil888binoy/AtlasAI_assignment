import asyncio
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException, UploadFile
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import src.models  # noqa: F401  registers every table on Base
import src.routers.reconciliation as api
from src.database.database import Base


OUR_LEDGER_CSV = """trade_id,traded_at,instrument,side,quantity,price,gross_amount,state
T-1,2026-09-01 09:15:00,BTC-USD,BUY,0.5,60000.0,30000.0,SETTLED
T-2,2026-09-01 09:20:00,ETH-USD,SELL,10.0,3400.0,34000.0,SETTLED
T-3,2026-09-01 09:25:00,SOL-USD,BUY,1.0,145.0,145.0,CANCELLED
T-4,2026-09-01 09:30:00,BTC-USD,BUY,0.2,60100.0,12020.0,SETTLED
"""

OTHER_STATEMENT_CSV = """reference,executed_at,symbol,direction,qty,unit_price,total,status
T-1,01/09/2026 09:15:02,BTCUSD,B,0.5,60000.0,30000.0,SETTLED
X-2,01/09/2026 09:20:00,ETHUSD,S,10.0,3417.0,34170.0,SETTLED
X-5,01/09/2026 09:30:00,BTCUSD,B,0.15,60100.0,9015.0,SETTLED
"""

# A correction: T-4 now has a different price.
CORRECTED_LEDGER_CSV = OUR_LEDGER_CSV.replace("60100.0,12020.0", "60150.0,12030.0")


class ReconciliationRouteTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(bind=self.engine)
        self.db = sessionmaker(bind=self.engine)()

        self.tmp_dir = tempfile.TemporaryDirectory()
        self.upload_root = Path(self.tmp_dir.name)
        self.open_files = []
        self.original_dirs = (api.OUR_LEDGER_DIR, api.OTHER_STATEMENT_DIR)
        api.OUR_LEDGER_DIR = self.upload_root / "our"
        api.OTHER_STATEMENT_DIR = self.upload_root / "other"
        api.OUR_LEDGER_DIR.mkdir()
        api.OTHER_STATEMENT_DIR.mkdir()

    def tearDown(self):
        for file in self.open_files:
            file.close()
        self.db.close()
        self.engine.dispose()
        self.tmp_dir.cleanup()
        api.OUR_LEDGER_DIR, api.OTHER_STATEMENT_DIR = self.original_dirs

    def run_files(self, our_csv=OUR_LEDGER_CSV, other_csv=OTHER_STATEMENT_CSV):
        upload = asyncio.run(api.upload_files(
            our_file=self.upload_file("our.csv", our_csv),
            other_file=self.upload_file("other.csv", other_csv),
            db=self.db,
        ))
        api.reconcile(upload["run_id"], db=self.db)
        return upload["run_id"]

    def results_by_status(self, run_id):
        grouped = {}
        for row in api.get_results(run_id, db=self.db)["results"]:
            grouped.setdefault(row["status"], []).append(row)
        return grouped

    def test_upload_reconcile_and_results(self):
        run_id = self.run_files()
        results = self.results_by_status(run_id)

        self.assertEqual(len(results["MATCHED"]), 1)
        self.assertEqual(len(results["DIFFERENCE"]), 1)
        self.assertEqual(len(results["MISSING_ON_OTHER_SIDE"]), 1)
        self.assertEqual(len(results["MISSING_ON_OUR_SIDE"]), 1)
        self.assertEqual(len(results["CANCELLED"]), 1)

        difference = results["DIFFERENCE"][0]
        self.assertEqual(difference["our_transaction"]["external_id"], "T-2")
        self.assertEqual(difference["other_transaction"]["external_id"], "X-2")
        self.assertEqual(
            [d["field_name"] for d in difference["differences"]],
            ["price", "amount"],
        )

    def test_same_files_twice_are_rejected(self):
        self.run_files()

        with self.assertRaises(HTTPException) as raised:
            self.run_files()

        self.assertEqual(raised.exception.status_code, 409)

    def test_manual_decisions_apply_to_the_next_run(self):
        run_id = self.run_files()
        results = self.results_by_status(run_id)
        our_id = results["MISSING_ON_OTHER_SIDE"][0]["our_transaction"]["id"]
        other_id = results["MISSING_ON_OUR_SIDE"][0]["other_transaction"]["id"]

        api.manual_match(run_id, our_transaction_id=our_id, other_transaction_id=other_id, resolved_by="tester", db=self.db)

        results = self.results_by_status(run_id)
        self.assertEqual(len(results["MANUALLY_MATCHED"]), 1)
        self.assertNotIn("MISSING_ON_OTHER_SIDE", results)
        self.assertNotIn("MISSING_ON_OUR_SIDE", results)

        # Tomorrow's files arrive: the decision is remembered by trade reference.
        next_run_id = self.run_files(our_csv=CORRECTED_LEDGER_CSV)
        results = self.results_by_status(next_run_id)
        self.assertEqual(results["MANUALLY_MATCHED"][0]["our_transaction"]["external_id"], "T-4")

    def test_accepted_unpaired_row_stays_accepted(self):
        run_id = self.run_files()
        other_id = self.results_by_status(run_id)["MISSING_ON_OUR_SIDE"][0]["other_transaction"]["id"]

        api.accept_unpaired(run_id, transaction_id=other_id, resolved_by="tester", db=self.db)

        next_run_id = self.run_files(our_csv=CORRECTED_LEDGER_CSV)
        results = self.results_by_status(next_run_id)
        self.assertEqual(results["ACCEPTED_UNPAIRED"][0]["other_transaction"]["external_id"], "X-5")

    def test_accepting_the_same_trade_in_two_runs_stores_one_decision(self):
        first_run = self.run_files()
        second_run = self.run_files(our_csv=CORRECTED_LEDGER_CSV)

        for run_id in (first_run, second_run):
            other_id = self.results_by_status(run_id)["MISSING_ON_OUR_SIDE"][0]["other_transaction"]["id"]
            api.accept_unpaired(run_id, transaction_id=other_id, resolved_by="tester", db=self.db)

        decisions = self.db.query(api.ManualDecision).filter_by(other_external_id="X-5").count()
        self.assertEqual(decisions, 1)

    def test_resolving_a_matched_row_is_refused(self):
        run_id = self.run_files()
        matched_id = self.results_by_status(run_id)["MATCHED"][0]["our_transaction"]["id"]

        with self.assertRaises(HTTPException) as raised:
            api.accept_unpaired(run_id, transaction_id=matched_id, resolved_by="tester", db=self.db)

        self.assertEqual(raised.exception.status_code, 400)

    def test_correction_shows_previous_values(self):
        self.run_files()
        next_run_id = self.run_files(our_csv=CORRECTED_LEDGER_CSV)

        corrected = self.results_by_status(next_run_id)["MISSING_ON_OTHER_SIDE"][0]
        self.assertEqual(corrected["our_transaction"]["external_id"], "T-4")
        self.assertEqual(
            corrected["our_transaction"]["previous_values"],
            {"price": 60100.0, "amount": 12020.0},
        )

    def test_list_runs_includes_summary(self):
        run_id = self.run_files()

        runs = api.list_runs(db=self.db)

        self.assertEqual(runs[0]["id"], run_id)
        self.assertEqual(runs[0]["summary"]["MATCHED"], 1)

    def upload_file(self, filename, content):
        path = self.upload_root / filename
        path.write_text(content)
        file = path.open("rb")
        self.open_files.append(file)
        return UploadFile(file, filename=filename)


if __name__ == "__main__":
    unittest.main()
