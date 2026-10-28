import json
import math
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone

from xhs_reception import DispatchGate, Engine, Event


ACCOUNT = "a" * 24
UID = "b" * 24
OTHER = "c" * 24


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class CLIDiagnosticsTest(unittest.TestCase):
    """All records are temporary fixtures, never runtime or delivery evidence."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name)
        self.db = self.runtime / "fixture.sqlite3"
        self.config = self.runtime / "reception.json"
        self.connection = self.runtime / "connection.json"
        self.report = self.runtime / "worker-status.json"
        self.now = math.floor(time.time() * 1000) / 1000 - 1
        self.engine = Engine(self.db, clock=lambda: self.now)
        self.write(self.config, {"account_id": ACCOUNT, "browser": "isolated_playwright", "browser_visibility": "headless",
            "desktop_input_allowed": False, "live_dispatch_enabled": True, "followup_minimum_seconds": 1800,
            "platform_limit_action": "pause_until_fresh_conversation_eligibility_evidence",
            "followup_maximum_count": None, "followup_expiry_seconds": None})
        self.write(self.connection, {"browser_status": "connected", "isolated_browser": {"user_authorization": True}})
        self.write(self.runtime / "account_identity.json", {"account_id": ACCOUNT, "account_display_name": "fixture",
            "source": "platform_ui", "reference": ".userInfo-popover 主账号ID", "observed_at_utc": iso(self.now),
            "url": "https://sxt.xiaohongshu.com/im/multiCustomerService", "title": "fixture-私信通"})
        self.write(self.report, {"classification": "local_ui_controller_health", "running": True,
            "recorded_at_utc": iso(self.now), "processed_scopes": 2, "held_conversations": 1,
            "last_result": {"state": "receive_returned", "untrusted_message_text": "PRIVATE_FIXTURE_TEXT"}})

    def tearDown(self):
        self.engine.close()
        self.temp.cleanup()

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value), encoding="utf-8")

    def command(self, name, db=None):
        args = [sys.executable, "-m", "xhs_reception", "--db", str(db or self.db), "--account", ACCOUNT,
                name, "--config", str(self.config), "--receiver-report", str(self.report)]
        if name == "doctor":
            args += ["--connection", str(self.connection)]
        result = subprocess.run(args, capture_output=True, text=True, timeout=5,
                                cwd=str(Path(__file__).resolve().parents[1]))
        self.assertEqual(result.stderr, "")
        return result.returncode, json.loads(result.stdout), result.stdout

    def observed(self, event_id="source", uid=UID, historical=False):
        self.engine.ingest_event(Event(ACCOUNT, uid, event_id, "CUSTOMER_MESSAGE", timestamp=self.now - .5,
            detected_at=self.now, evidence={"source": "platform_ui", "timestamp_source": "platform_ui",
                "account_id": ACCOUNT, "conversation_id": uid, "reference": "id_fixture_" + event_id,
                "observed_at": self.now, "historical_baseline": historical}))

    def confirmed(self, operation="text", kind="reply", raw="mtext"):
        row = self.engine.prepare_intent(ACCOUNT, UID, kind, {"operation": operation})
        gate = DispatchGate(enabled=True, browser_connected=True, authenticated=True, account_id=ACCOUNT,
            conversation_id=UID, browser_session_id="temporary-fixture", observed_at=self.now)
        self.engine.claim_intent(row["intent_id"], "fixture", gate)
        self.engine.begin_submit(row["intent_id"], "fixture", gate)
        submitted = self.now
        self.now += .1
        native = ACCOUNT + "." + UID + "." + raw
        receipt = {"status": "server_history_confirmed", "verifier_version": 6,
            "operation": operation, "native_message_id": native,
            "reference": "https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg#" + native,
            "observed_at_utc": iso(submitted + .09), "delivery_verified": False, "read_verified": False,
            "wecom_added_verified": False}
        return self.engine.confirm(row["intent_id"], "fixture", "sent", {"source": "platform_ui",
            "account_id": ACCOUNT, "conversation_id": UID, "intent_id": row["intent_id"],
            "observed_at": self.now, "reference": "id_" + native, "native_message_id": "jarvis-msg-" + native,
            "native_server_history": receipt})

    def test_status_separates_configuration_report_and_command_side_effects(self):
        self.observed()
        before = len(self.engine.audit())
        exit_code, value, raw = self.command("status")
        self.assertEqual(exit_code, 0)
        self.assertFalse(value["command_sends_messages"])
        self.assertNotIn("live_dispatch", value)
        self.assertTrue(value["configured_dispatch"]["enabled_in_config"])
        self.assertFalse(value["configured_dispatch"]["establishes_runtime_readiness"])
        self.assertTrue(value["receiver_last_report"]["running_reported"])
        self.assertFalse(value["receiver_last_report"]["current_runtime_verified"])
        self.assertEqual(value["receiver_last_report"]["last_result_state"], "receive_returned")
        self.assertNotIn("PRIVATE_FIXTURE_TEXT", raw)
        self.assertEqual(len(value["conversations"]), 1)
        self.assertEqual(len(self.engine.audit()), before)

    def test_doctor_reports_scoped_saved_history_without_claiming_live_or_delivery(self):
        self.observed()
        self.confirmed()
        self.confirmed("native_card", "card", "mcard")
        self.observed("history", OTHER, historical=True)
        before = len(self.engine.audit())
        exit_code, value, _ = self.command("doctor")
        self.assertEqual(exit_code, 3)
        self.assertFalse(value["live_ready"])
        self.assertTrue(all(value["configuration_checks"].values()))
        evidence = value["recorded_evidence"]
        self.assertTrue(evidence["native_account_binding"]["native_identity_record_valid"])
        self.assertTrue(evidence["native_account_binding"]["database_account_matches"])
        self.assertFalse(evidence["native_account_binding"]["current_authentication_verified"])
        self.assertEqual(evidence["native_inbound_observations"]["historical_baselines"], 1)
        history = evidence["native_server_history_confirmations"]
        self.assertEqual((history["text"], history["native_card"]), (1, 1))
        self.assertFalse(history["delivery_verified"])
        self.assertFalse(history["read_verified"])
        self.assertFalse(history["wecom_added_verified"])
        self.assertIn("native_platform_limit_and_later_same_conversation_recovery", value["unverified_requirements"])
        self.assertEqual(len(self.engine.audit()), before)

    def test_mismatched_identity_and_receipt_never_count_as_bound_history(self):
        self.observed()
        card = self.confirmed("native_card", "card", "wrong-card")
        proof = card["evidence"]
        proof["native_server_history"]["native_message_id"] = ACCOUNT + "." + OTHER + ".wrong-card"
        self.engine.db.execute("UPDATE outbox SET evidence=? WHERE intent_id=?", (json.dumps(proof), card["intent_id"]))
        identity = json.loads((self.runtime / "account_identity.json").read_text())
        identity["account_id"] = OTHER
        self.write(self.runtime / "account_identity.json", identity)
        _, value, _ = self.command("doctor")
        evidence = value["recorded_evidence"]
        self.assertEqual(evidence["sent_outbox_records"], 1)
        self.assertEqual(evidence["native_server_history_confirmations"]["native_card"], 0)
        self.assertFalse(evidence["native_account_binding"]["native_identity_record_valid"])

    def test_missing_and_bad_files_only_report_diagnostics_without_creating_database(self):
        absent = self.runtime / "absent" / "no.sqlite3"
        self.config.write_text('{"PRIVATE_SECRET":', encoding="utf-8")
        self.report.write_text("not JSON PRIVATE_SECRET", encoding="utf-8")
        self.connection.unlink()
        for name, expected in (("status", 2), ("doctor", 3)):
            exit_code, value, raw = self.command(name, absent)
            self.assertEqual(exit_code, expected)
            self.assertFalse(value["configured_dispatch"]["enabled_in_config"])
            self.assertEqual(value["configured_dispatch"]["file_status"], "invalid")
            self.assertEqual(value["receiver_last_report"]["file_status"], "invalid")
            self.assertNotIn("PRIVATE_SECRET", raw)
        self.assertFalse(absent.exists())
        self.assertFalse(absent.parent.exists())

    def test_unrelated_sqlite_is_not_initialized_by_status_or_doctor(self):
        unrelated = self.runtime / "unrelated.sqlite3"
        with sqlite3.connect(unrelated) as connection:
            connection.execute("CREATE TABLE fixture_only(value TEXT)")
        self.assertEqual(self.command("status", unrelated)[0], 2)
        self.assertEqual(self.command("doctor", unrelated)[0], 3)
        with sqlite3.connect(unrelated) as connection:
            self.assertEqual(connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [("fixture_only",)])

    def test_old_running_report_and_green_config_never_establish_readiness(self):
        report = json.loads(self.report.read_text())
        report["recorded_at_utc"] = iso(self.now - 172800)
        self.write(self.report, report)
        exit_code, value, _ = self.command("doctor")
        self.assertEqual(exit_code, 3)
        self.assertTrue(value["configured_dispatch"]["enabled_in_config"])
        self.assertTrue(value["receiver_last_report"]["running_reported"])
        self.assertGreaterEqual(value["receiver_last_report"]["report_age_seconds"], 172800)
        self.assertFalse(value["live_ready"])
        self.assertFalse(value["recorded_evidence"]["native_account_binding"]["database_account_matches"])

    def test_extreme_json_integer_stays_a_structured_nonready_diagnostic(self):
        config = json.loads(self.config.read_text())
        config["followup_minimum_seconds"] = 10 ** 400
        self.write(self.config, config)
        exit_code, value, _ = self.command("doctor")
        self.assertEqual(exit_code, 3)
        self.assertFalse(value["configuration_checks"]["confirmed_policy"])
        self.assertFalse(value["live_ready"])


if __name__ == "__main__":
    unittest.main()
