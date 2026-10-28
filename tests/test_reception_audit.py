"""Temporary SQLite fixtures only; no business or notification evidence."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

from xhs_reception import DispatchGate, Engine, Event
from xhs_reception.reception_audit import read_reception_audit


A, U, OTHER = "a" * 24, "b" * 24, "c" * 24


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ReceptionAuditTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / "fixture.sqlite3"
        self.now = time.time() - 100
        self.engine = Engine(self.path, clock=lambda: self.now)

    def tearDown(self):
        self.engine.close()
        self.temp.cleanup()

    def incoming(self, raw, kind="CUSTOMER_MESSAGE", uid=U, account=A, historical=False,
                 text="fixture customer question", unknown_clock=False, **extra):
        native = account + "." + uid + "." + raw
        proof = {"source": "platform_ui", "timestamp_source": "unknown" if unknown_clock else "platform_ui",
                 "account_id": account, "conversation_id": uid, "reference": "id_" + native,
                 "observed_at": self.now, "native_message_id": "jarvis-msg-" + native,
                 "native_message_type": "TEXT" if kind == "CUSTOMER_MESSAGE" else "RICH_HINT",
                 "native_direction": "left" if kind == "CUSTOMER_MESSAGE" else "center",
                 "historical_baseline": historical, "untrusted_message_text": text, **extra}
        row = Event(account, uid, "id_" + native, kind,
                    timestamp=None if unknown_clock else self.now, detected_at=self.now, evidence=proof)
        self.engine.ingest_event(row)
        self.now += .1
        return row.event_id

    def attempt(self, source, operation="text", kind="reply", result="sent", uid=U,
                reception=None, text="fixture complete response <script>alert('x')</script>"):
        intent = self.engine.prepare_intent(A, uid, kind, {"operation": operation, "text": text} if operation == "text" else
                                            {"operation": operation, "card_name": "fixture native card"}, source_event_id=source)
        gate = DispatchGate(True, True, True, A, uid, "temporary-fixture-session", self.now)
        self.engine.claim_intent(intent["intent_id"], "fixture", gate)
        self.engine.begin_submit(intent["intent_id"], "fixture", gate)
        submitted = self.now
        self.now += .1
        native = A + "." + uid + ".out-" + intent["intent_id"]
        proof = {"source": "platform_ui", "account_id": A, "conversation_id": uid, "intent_id": intent["intent_id"],
                 "reference": "id_" + native, "observed_at": self.now, "native_message_id": "jarvis-msg-" + native,
                 "native_server_history": {"status": "server_history_confirmed", "operation": operation,
                    "native_message_id": native, "reference": "https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg#" + native,
                    "observed_at_utc": iso(submitted + .05)},
                 **({"reception_event_id": reception} if reception else {}),
                 **({"native_wecom_card_confirmed": True} if operation == "native_card" else {"usefulness_verified": True, "useful": True})}
        self.engine.confirm(intent["intent_id"], "fixture", result, proof)
        return intent["intent_id"]

    def report(self, **kwargs):
        return read_reception_audit(self.path, account_id=A, **kwargs)

    def takeover(self, entry, uid=U):
        self.engine.ingest_event(Event(A, uid, "takeover-" + entry, "PLATFORM_TAKEOVER_CONFIRMED", timestamp=self.now,
            evidence={"source": "platform_ui", "account_id": A, "conversation_id": uid, "reference": "native-fixture-takeover",
                      "observed_at": self.now, "source_event_id": entry, "taken_over": True}))

    def command(self, *extra, path=None):
        result = subprocess.run([sys.executable, "-m", "xhs_reception", "--db", str(path or self.path),
                                 "--account", A, "reception-audit", *extra], capture_output=True, text=True,
                                cwd=Path(__file__).resolve().parents[1], timeout=5)
        self.assertEqual(result.stderr, "")
        return result.returncode, json.loads(result.stdout)

    def test_empty_projection_is_zero_without_initializing_or_mutating_business_state(self):
        before = self.engine.db.total_changes
        result = self.report()
        self.assertEqual(result["database"], {"file_status": "recorded", "read_only": True})
        self.assertEqual(result["total_observed_units"], 0)
        self.assertEqual(result["samples"], [])
        self.assertEqual(self.engine.db.total_changes, before)
        self.assertEqual(self.engine.audit(), [])

    def test_native_entry_customer_text_takeover_and_unknown_remain_distinct(self):
        entry = self.incoming("entry", kind="NEW_VISITOR", text="对方通过测试进入私信", untrusted_customer_display_name="fixture nickname")
        self.engine.ingest_event(Event(A, U, "takeover-fixture", "PLATFORM_TAKEOVER_CONFIRMED", timestamp=self.now,
            evidence={"source": "platform_ui", "account_id": A, "conversation_id": U, "reference": "native-takeover-control",
                      "observed_at": self.now, "source_event_id": entry, "taken_over": True}))
        first = self.attempt(entry, kind="initial")
        question = self.incoming("question", text="complete customer request with quote and destination")
        reply = self.attempt(question, reception=entry)
        unknown = self.attempt(question, operation="native_card", kind="card", result="unknown", reception=entry)
        new_question = self.incoming("later-question", text="this question still needs its own reply")
        before = [dict(row) for row in self.engine.db.execute("SELECT * FROM outbox")]
        sample = self.report()["samples"][0]
        self.assertEqual(sample["customer_display_name"], "fixture nickname")
        self.assertEqual(sample["anchor_event_id"], entry)
        self.assertEqual(len(sample["takeover_evidence"]), 1)
        self.assertEqual(len(sample["reply_attempts"]), 3)
        by_id = {row["intent_id"]: row for row in sample["reply_attempts"]}
        self.assertTrue(by_id[first]["native_history_confirmed"])
        self.assertTrue(by_id[reply]["text"].endswith("</script>"))
        self.assertEqual(by_id[unknown]["status"], "UNKNOWN")
        self.assertFalse(by_id[unknown]["native_wecom_card_confirmed"])
        self.assertIsNone(by_id[unknown]["confirmed_at_utc"])
        self.assertTrue(sample["contains_unknown"])
        self.assertEqual(sample["full_bundle"]["assessment"], "unverified")
        self.assertEqual(sample["latest_inbound_event_id"], new_question)
        self.assertEqual(sample["latest_inbound_text_reply_status"], "not_sent")
        question_projection = next(row for row in sample["inbound_events"] if row["event_id"] == question)
        self.assertEqual(question_projection["text_reply_status"], "native_history_confirmed")
        self.assertEqual(question_projection["native_card_status"], "submission_unknown")
        self.assertEqual([dict(row) for row in self.engine.db.execute("SELECT * FROM outbox")], before)

    def test_historical_followup_and_unverified_manual_input_are_not_new_receptions(self):
        self.now -= 4000
        source = self.incoming("old", historical=True)
        self.engine.ingest_event(Event(A, U, "historical-outbound-baseline", "OUTBOUND_OBSERVED", timestamp=self.now,
            evidence={"source": "platform_ui", "timestamp_source": "platform_ui", "account_id": A,
                      "conversation_id": U, "reference": "native-fixture-outbound", "observed_at": self.now,
                      "native_message_id": "jarvis-msg-" + A + "." + U + ".baseline"}))
        self.now += 1801
        unknown = self.attempt(source, kind="followup", result="unknown")
        self.engine.ingest_event(Event(A, U, "unverified-manual-fixture", "CUSTOMER_MESSAGE", timestamp=self.now,
                                      evidence={"untrusted_message_text": "not native evidence"}))
        report = self.report()
        self.assertEqual(report["total_observed_units"], 0)
        self.assertEqual(report["excluded_historical_inbound_events"], 1)
        self.assertEqual(report["excluded_unverified_inbound_events"], 1)
        self.assertEqual(report["excluded_outbox_without_current_observed_source"], 1)
        exception = report["historical_or_unassigned_outbound_exceptions"][0]
        self.assertEqual(exception["intent_id"], unknown)
        self.assertEqual(exception["status"], "UNKNOWN")
        self.assertFalse(exception["counts_as_new_reception"])

    def test_only_three_strict_original_receipts_can_report_five_second_pass(self):
        entry = self.incoming("entry", kind="NEW_VISITOR")
        self.takeover(entry)
        self.attempt(entry, kind="initial")
        self.attempt(entry, operation="native_card", kind="card")
        sample = self.report()["samples"][0]
        self.assertEqual(sample["full_bundle"]["assessment"], "meets")
        self.assertTrue(sample["full_bundle"]["complete"])
        self.assertGreater(sample["full_bundle"]["platform_to_all_confirmed_ms"], 0)
        self.assertLess(sample["full_bundle"]["platform_to_all_confirmed_ms"], 5000)
        self.assertEqual(sample["detection_delay_ms"], 0)
        self.assertGreater(sample["reply_attempts"][0]["entry_platform_to_confirm_ms"], 0)
        self.assertGreater(sample["takeover_evidence"][0]["platform_to_confirm_ms"], 0)

    def test_current_three_second_boundary_does_not_borrow_legacy_five_second_pass(self):
        for index, (milliseconds, verdict) in enumerate(((2999, "meets"), (3000, "meets"), (3001, "misses"))):
            with self.subTest(milliseconds=milliseconds):
                self.now = 100000.0 + index * 100
                entered_at = self.now
                uid = f"{index + 20:024x}"
                entry = self.incoming("current-target-entry", kind="NEW_VISITOR", uid=uid)
                self.takeover(entry, uid=uid)
                self.attempt(entry, kind="initial", uid=uid)
                self.now = entered_at + milliseconds / 1000 - .1
                self.attempt(entry, operation="native_card", kind="card", uid=uid)
                changes = self.engine.db.total_changes
                sample = next(item for item in self.report()["samples"] if item["conversation_id"] == uid)
                self.assertIn("three_second_bundle", sample, "current three-second verdict must be independently projected")
                current = sample["three_second_bundle"]
                self.assertEqual(current["target_ms"], 3000)
                self.assertTrue(current["complete"])
                self.assertEqual(current["assessment"], verdict)
                self.assertAlmostEqual(current["platform_to_all_confirmed_ms"], milliseconds, places=3)
                self.assertEqual(sample["full_bundle"]["target_ms"], 5000)
                self.assertEqual(sample["full_bundle"]["assessment"], "meets")
                self.assertEqual(self.engine.db.total_changes, changes)

    def test_current_three_second_verdict_requires_entry_clock_and_all_strict_receipts(self):
        entry = self.incoming("missing-card-entry", kind="NEW_VISITOR")
        self.takeover(entry)
        self.attempt(entry, kind="initial")
        sample = self.report()["samples"][0]
        self.assertIn("three_second_bundle", sample, "missing receipts still require an explicit unverified current verdict")
        self.assertEqual(sample["three_second_bundle"]["assessment"], "unverified")
        self.assertFalse(sample["three_second_bundle"]["complete"])
        self.assertIsNone(sample["three_second_bundle"]["platform_to_all_confirmed_ms"])
        opening = self.incoming("message-only-current-target", uid=OTHER)
        self.attempt(opening, uid=OTHER)
        self.attempt(opening, operation="native_card", kind="card", uid=OTHER)
        sample = next(item for item in self.report()["samples"] if item["conversation_id"] == OTHER)
        self.assertEqual(sample["anchor_type"], "customer_message_opening")
        self.assertEqual(sample["three_second_bundle"]["assessment"], "unverified")

    def test_missing_takeover_or_platform_clock_is_unverified_even_with_sent_text_and_card(self):
        for unknown_clock in (False, True):
            with self.subTest(unknown_clock=unknown_clock):
                uid = U if not unknown_clock else OTHER
                entry = self.incoming("entry-no-proof", kind="NEW_VISITOR", uid=uid, unknown_clock=unknown_clock)
                if unknown_clock:
                    self.takeover(entry, uid=uid)
                self.attempt(entry, kind="initial", uid=uid)
                self.attempt(entry, operation="native_card", kind="card", uid=uid)
                sample = next(item for item in self.report()["samples"] if item["conversation_id"] == uid)
                self.assertEqual(sample["full_bundle"]["assessment"], "unverified")
                self.assertFalse(sample["full_bundle"]["complete"])
                self.assertIsNone(sample["full_bundle"]["platform_to_all_confirmed_ms"])

    def test_contradictory_entry_link_cannot_duplicate_one_reply_across_entries(self):
        first = self.incoming("first-entry", kind="NEW_VISITOR")
        self.attempt(first, kind="initial")
        second = self.incoming("second-entry", kind="NEW_VISITOR")
        intent = self.attempt(second, kind="initial")
        row = next(item for item in self.engine.list_outbox() if item["intent_id"] == intent)
        row["evidence"]["reception_event_id"] = first
        self.engine.db.execute("UPDATE outbox SET evidence=? WHERE intent_id=?", (json.dumps(row["evidence"]), intent))
        samples = self.report()["samples"]
        self.assertEqual(sum(attempt["intent_id"] == intent for unit in samples for attempt in unit["reply_attempts"]), 1)
        target = next(unit for unit in samples if unit["anchor_event_id"] == second)
        self.assertEqual(target["association_warnings"], [{"intent_id": intent, "reason": "invalid_explicit_entry_link"}])
        self.assertEqual(target["full_bundle"]["assessment"], "unverified")

    def test_invalid_early_receipt_cannot_borrow_a_different_later_receipt_to_match_core_pass(self):
        entry = self.incoming("entry", kind="NEW_VISITOR")
        self.takeover(entry)
        early = self.attempt(entry, kind="initial")
        self.attempt(entry, operation="native_card", kind="card")
        row = next(item for item in self.engine.list_outbox() if item["intent_id"] == early)
        row["evidence"]["native_server_history"]["native_message_id"] = OTHER + "." + U + ".foreign"
        self.engine.db.execute("UPDATE outbox SET evidence=? WHERE intent_id=?", (json.dumps(row["evidence"]), early))
        question = self.incoming("later-question")
        self.now += 6
        self.attempt(question, reception=entry)
        self.assertEqual(self.engine.metrics(A)["reception_bundle"]["samples"][0]["assessment"], "meets")
        sample = self.report()["samples"][0]
        self.assertEqual(sample["full_bundle"]["assessment"], "unverified")
        self.assertFalse(sample["full_bundle"]["complete"])

    def test_core_snapshot_api_refuses_non_query_only_connections(self):
        with self.assertRaisesRegex(ValueError, "query-only"):
            Engine.reception_metrics_snapshot(self.engine.db, A)
        self.assertEqual(self.engine.list_conversations(), [])

    def test_message_only_openings_are_real_messages_not_invented_entries_and_unknown_time_stays_unknown(self):
        first = self.incoming("first-message", unknown_clock=True)
        second = self.incoming("second-message")
        report = self.report()
        self.assertEqual(report["platform_entry_units"], 0)
        self.assertEqual(report["message_opening_units"], 2)
        self.assertEqual([row["anchor_event_id"] for row in report["samples"]], [second, first])
        self.assertEqual(report["samples"][1]["anchor_type"], "customer_message_opening")
        self.assertIsNone(report["samples"][1]["received_at_utc"])
        self.assertEqual(report["samples"][1]["timestamp_source"], "unknown")
        self.assertEqual(report["samples"][1]["takeover_evidence"], [])

    def test_numeric_time_without_platform_source_is_not_displayed_as_platform_received_time(self):
        self.incoming("unknown-source", timestamp_source="unknown")
        sample = self.report()["samples"][0]
        self.assertIsNotNone(sample["recorded_timestamp_utc"])
        self.assertIsNone(sample["received_at_utc"])
        self.assertIsNone(sample["inbound_events"][0]["platform_received_at_utc"])
        self.assertIsNone(sample["detection_delay_ms"])
        self.assertEqual(sample["full_bundle"]["assessment"], "unverified")

    def test_ten_unit_limit_order_and_account_scope(self):
        ids = []
        for number in range(12):
            ids.append(self.incoming("entry-" + str(number), kind="NEW_VISITOR", uid=f"{number:024x}"))
        self.incoming("other-account", kind="NEW_VISITOR", account=OTHER)
        report = self.report(limit=10)
        self.assertEqual(report["total_observed_units"], 12)
        self.assertEqual([row["anchor_event_id"] for row in report["samples"]], list(reversed(ids[-10:])))
        self.assertNotIn(OTHER, json.dumps(report))

    def test_wrong_native_receipt_never_upgrades_saved_sent_record(self):
        source = self.incoming("message")
        intent = self.attempt(source)
        row = self.engine.list_outbox()[0]
        row["evidence"]["native_server_history"]["native_message_id"] = OTHER + "." + U + ".wrong"
        self.engine.db.execute("UPDATE outbox SET evidence=? WHERE intent_id=?", (json.dumps(row["evidence"]), intent))
        attempt = self.report()["samples"][0]["reply_attempts"][0]
        self.assertEqual(attempt["status"], "SENT")
        self.assertFalse(attempt["native_history_confirmed"])
        self.assertEqual(attempt["result"], "sent_recorded")

    def test_atomic_exports_match_one_snapshot_and_escape_untrusted_body(self):
        source = self.incoming("message", text="customer <img src=x onerror=alert(1)>")
        self.attempt(source)
        json_path, html_path = self.root / "audit.json", self.root / "audit.html"
        code, report = self.command("--limit", "10", "--export-json", str(json_path), "--export-html", str(html_path))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(json_path.read_text()), report)
        exported = html_path.read_text()
        self.assertNotIn("<script>", exported)
        self.assertNotIn("<img src=x", exported)
        self.assertIn("&lt;script&gt;", exported)
        self.assertIn("&lt;img src=x", exported)
        self.assertIn('http-equiv="refresh" content="2"', exported)
        self.assertIn("（上海）", exported)
        self.assertIn("原生聊天记录已核验", exported)
        self.assertEqual(json_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(html_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.root.glob(".*.tmp")), [])

    def test_exports_cannot_replace_database_aliases_sidecars_or_each_other(self):
        self.incoming("source")
        symlink, hardlink = self.root / "source-symlink", self.root / "source-hardlink"
        symlink.symlink_to(self.path)
        os.link(self.path, hardlink)
        before, modified = self.path.read_bytes(), self.path.stat().st_mtime_ns
        for destination in (self.path, symlink, hardlink, Path(str(self.path) + "-wal"), Path(str(self.path) + "-shm")):
            for option in ("--export-json", "--export-html"):
                with self.subTest(destination=destination.name, option=option):
                    code, error = self.command(option, str(destination))
                    self.assertEqual(code, 2)
                    self.assertIn("must not replace", error["error"])
        same = self.root / "same-export"
        code, error = self.command("--export-json", str(same), "--export-html", str(same))
        self.assertEqual(code, 2)
        self.assertIn("distinct destinations", error["error"])
        self.assertFalse(same.exists())
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.path.stat().st_mtime_ns, modified)
        self.assertEqual(self.engine.list_conversations()[0]["account_id"], A)

    def test_invalid_and_missing_database_never_become_empty_success_or_get_created(self):
        missing, bad = self.root / "missing.sqlite3", self.root / "broken.sqlite3"
        bad.write_bytes(b"not SQLite")
        before = bad.stat()
        for path in (missing, bad):
            code, report = self.command(path=path)
            self.assertEqual(code, 2)
            self.assertIsNone(report["total_observed_units"])
        self.assertFalse(missing.exists())
        self.assertEqual(bad.read_bytes(), b"not SQLite")
        self.assertEqual(bad.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertFalse(Path(str(bad) + "-wal").exists())
        self.assertFalse(Path(str(bad) + "-shm").exists())


if __name__ == "__main__":
    unittest.main()
