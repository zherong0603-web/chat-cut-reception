"""Temporary SQLite fixtures only. Never runs a real notification or browser."""

import json
from datetime import datetime, timezone
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import types
import unittest
from unittest.mock import patch

from xhs_reception import DispatchGate, Engine, Event
from xhs_reception.audit_notifier import (AuditNotifier, NotifierError, SCRIPT, mark_read,
                                          notifier_status, notify_macos)


A, U, V = "a" * 24, "b" * 24, "c" * 24
PRIVATE = '实际回复 " & ` $(echo PRIVATE)\n不要执行 ![x](https://example.invalid/x)'


class AuditNotifierTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.db = self.directory / "fixture.sqlite3"
        self.now = time.time() - 7200
        self.engine = Engine(self.db, clock=lambda: self.now)
        self.counter = 0
        self.observers = []
        self.notifications = []

    def tearDown(self):
        for observer in self.observers:
            observer.close()
        self.engine.close()
        self.temp.cleanup()

    def incoming(self, uid=U, historical=False):
        self.counter += 1
        self.now += .1
        raw = "source" + str(self.counter)
        native = A + "." + uid + "." + raw
        event_id = "id_" + native
        self.engine.ingest_event(Event(A, uid, event_id, "CUSTOMER_MESSAGE", self.now - .01, self.now,
            {"source": "platform_ui", "timestamp_source": "platform_ui", "account_id": A,
             "conversation_id": uid, "reference": event_id, "observed_at": self.now,
             "native_message_id": "jarvis-msg-" + native, "native_message_type": "TEXT",
             "native_direction": "left", "historical_baseline": historical,
             "untrusted_message_text": "客户原话PRIVATE_INCOMING", "untrusted_customer_display_name": "客户甲"}))
        return event_id

    def submit(self, result="sent", uid=U, operation="text", kind="reply", new_source=True):
        if new_source:
            self.incoming(uid)
        row = self.engine.prepare_intent(A, uid, kind, {"operation": operation, "text": PRIVATE})
        gate = DispatchGate(True, True, True, A, uid, "temporary-fixture", self.now)
        self.engine.claim_intent(row["intent_id"], "fixture", gate)
        self.engine.begin_submit(row["intent_id"], "fixture", gate)
        self.now += .1
        raw = "reply" + str(self.counter) + operation
        native = A + "." + uid + "." + raw
        proof = {"source": "platform_ui", "account_id": A, "conversation_id": uid,
            "intent_id": row["intent_id"], "reference": "id_" + native, "observed_at": self.now,
            "native_message_id": "jarvis-msg-" + native, "native_message_raw_id": raw,
            "native_server_history": {"status": "server_history_confirmed", "operation": operation,
                "native_message_id": native,
                "observed_at_utc": datetime.fromtimestamp(self.now, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "reference": "https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg#" + native},
            "native_wecom_card_confirmed": operation == "native_card", "usefulness_verified": True, "useful": True}
        return self.engine.confirm(row["intent_id"], "fixture", result, proof)

    def observer(self, *, enabled=True, callback=True):
        def fake(title, subtitle, body):
            self.notifications.append((title, subtitle, body))
            return {"command_state": "command_completed", "exit_code": 0, "visible_verified": True}
        observer = AuditNotifier(self.db, account_id=A, notifications_enabled=enabled,
                                 deliver=fake if callback else None)
        self.observers.append(observer)
        return observer

    def read(self, name):
        return json.loads((self.directory / name).read_text())

    def test_cold_baseline_suppresses_old_sent_but_warns_existing_unknown_once(self):
        self.submit(uid=V)
        unknown = self.submit("unknown")
        observer = self.observer()
        observer.poll_once(); observer.poll_once()
        self.assertEqual(len(self.notifications), 1)
        self.assertIn("存量异常", self.notifications[0][0])
        self.assertIn("结果未知", self.notifications[0][0])
        self.assertEqual(observer.state["notifications"][0]["intent_id"], unknown["intent_id"])
        self.assertFalse(observer.state["notifications"][0]["visible_verified"])
        observer.close()
        self.observer().poll_once()
        self.assertEqual(len(self.notifications), 1)

    def test_new_sent_notification_contains_actual_reply_and_name_without_ledger_body(self):
        observer = self.observer(); observer.poll_once()
        self.submit()
        before = self.engine.db.total_changes
        observer.poll_once(); observer.poll_once()
        self.assertEqual(self.engine.db.total_changes, before)
        self.assertEqual(len(self.notifications), 1)
        self.assertIn("客户甲", self.notifications[0][0])
        self.assertEqual(self.notifications[0][2], PRIVATE)
        ledger = (self.directory / "audit-notifier-state.json").read_text()
        self.assertNotIn("PRIVATE", ledger)
        self.assertNotIn("客户原话", ledger)
        self.assertEqual(os.stat(self.directory / "audit-notifier-state.json").st_mode & 0o777, 0o600)

    def test_committed_cursor_coalesces_resolved_unknown_and_no_other_account_broadening(self):
        observer = self.observer(); observer.poll_once()
        unknown = self.submit("unknown")
        self.now += .1
        self.engine.reconcile(unknown["intent_id"], "sent", {**unknown["evidence"], "observed_at": self.now})
        self.engine.db.execute("INSERT INTO audit_log(at,account_id,conversation_id,action,detail) VALUES(?,?,?,?,?)",
                               (self.now, V, U, "SEND_UNKNOWN", json.dumps({"intent_id": unknown["intent_id"]})))
        observer.poll_once()
        self.assertEqual([item["state"] for item in observer.state["notifications"]], ["SENT"])
        self.assertEqual(len(self.notifications), 1)

    def test_popup_fifo_ack_and_card_state_changes_without_new_send(self):
        observer = self.observer(callback=False); observer.poll_once()
        text = self.submit()
        observer.poll_once()
        first = self.read("popup-current.json")
        self.assertEqual(first["state"], "SENT")
        self.assertEqual(first["reply_text"], PRIVATE)
        self.assertEqual(first["customer_name"], "客户甲")
        card = self.submit("unknown", operation="native_card", kind="card", new_source=False)
        observer.poll_once()
        updated = self.read("popup-current.json")
        self.assertEqual(updated["notice_id"], first["notice_id"])
        self.assertEqual(updated["card_state"], "UNKNOWN")
        (self.directory / "popup-ack.json").write_text(json.dumps({"version": 1,
            "notice_id": first["notice_id"], "action": "mark_read", "acknowledged_at_utc": "synthetic"}))
        observer.poll_once()
        second = self.read("popup-current.json")
        self.assertIn(card["intent_id"], second["notice_id"])
        self.assertEqual(second["state"], "UNKNOWN")
        self.assertEqual(second["reply_text"], PRIVATE)
        self.assertTrue(observer.state["notifications"][0]["read"])
        self.assertEqual(next(row for row in self.engine.list_outbox(A) if row["intent_id"] == card["intent_id"])["status"], "UNKNOWN")

    def test_popup_unknown_resolved_supersedes_stale_unread_warning(self):
        observer = self.observer(callback=False); observer.poll_once()
        unknown = self.submit("unknown"); observer.poll_once()
        self.now += .1
        self.engine.reconcile(unknown["intent_id"], "sent", {**unknown["evidence"], "observed_at": self.now})
        observer.poll_once()
        self.assertEqual(self.read("popup-current.json")["state"], "SENT")
        self.assertTrue(observer.state["notifications"][0]["superseded"])

    def test_customer_card_groups_unread_by_exact_scope_without_rewriting_ledger(self):
        observer = self.observer(callback=False); observer.poll_once()
        text = self.submit()
        card = self.submit("unknown", operation="native_card", kind="card", new_source=False)
        self.submit(uid=V)
        before = self.engine.db.total_changes
        observer.poll_once()
        payload = self.read("popup-current.json")
        ledger = observer.state["notifications"]
        self.assertEqual(payload["notice_id"], ledger[0]["id"])
        self.assertEqual(payload["grouped_notice_ids"], [item["id"] for item in ledger[:2]])
        self.assertEqual(payload["pending_count"], 3)
        self.assertEqual(payload["pending_customer_count"], 2)
        self.assertEqual(set(payload["customer_brief"]), {"customer", "reply", "progress", "action"})
        self.assertIn("待确认", payload["customer_brief"]["reply"])
        self.assertNotIn("已添加企微", payload["customer_brief"]["progress"])
        self.assertEqual({row["intent_id"] for row in payload["technical_details"]["operations"]},
                         {text["intent_id"], card["intent_id"]})
        self.assertEqual(len(ledger), 3)
        self.assertFalse(any(item["read"] for item in ledger))
        self.assertEqual(self.engine.db.total_changes, before)

    def test_snapshot_group_ack_never_marks_later_same_customer_notice_read(self):
        observer = self.observer(callback=False); observer.poll_once()
        self.submit(); self.submit(); observer.poll_once()
        displayed = self.read("popup-current.json")
        self.assertEqual(len(displayed["grouped_notice_ids"]), 2)
        (self.directory / "popup-ack.json").write_text(json.dumps({"version": 1,
            "notice_id": displayed["notice_id"], "notice_ids": displayed["grouped_notice_ids"],
            "action": "mark_read", "acknowledged_at_utc": "synthetic"}))
        late = self.submit()
        observer.poll_once()
        ledger = observer.state["notifications"]
        self.assertTrue(all(item["read"] for item in ledger[:2]))
        self.assertFalse(ledger[2]["read"])
        current = self.read("popup-current.json")
        self.assertIn(late["intent_id"], current["notice_id"])
        self.assertEqual(current["grouped_notice_ids"], [ledger[2]["id"]])
        self.assertEqual(current["pending_count"], 1)

    def test_ack_of_older_drawn_subset_survives_new_group_publication_without_reading_new_member(self):
        observer = self.observer(callback=False); observer.poll_once()
        self.submit(); self.submit(); observer.poll_once()
        drawn = self.read("popup-current.json")
        late = self.submit(); observer.poll_once()
        published = self.read("popup-current.json")
        self.assertEqual(published["notice_id"], drawn["notice_id"])
        self.assertEqual(len(published["grouped_notice_ids"]), 3)
        (self.directory / "popup-ack.json").write_text(json.dumps({"version": 1,
            "notice_id": drawn["notice_id"], "notice_ids": drawn["grouped_notice_ids"], "action": "mark_read"}))
        observer.poll_once()
        self.assertTrue(all(item["read"] for item in observer.state["notifications"][:2]))
        self.assertFalse(observer.state["notifications"][2]["read"])
        self.assertIn(late["intent_id"], self.read("popup-current.json")["notice_id"])

    def test_group_ack_rejects_members_not_in_published_snapshot_or_other_uid(self):
        observer = self.observer(callback=False); observer.poll_once()
        self.submit(); observer.poll_once()
        displayed = self.read("popup-current.json")
        self.submit(uid=V)
        foreign = A + ":" + self.engine.list_outbox(A)[-1]["intent_id"] + ":SENT"
        for ids in ([displayed["notice_id"], foreign], ["unpublished"], [], "not-an-array"):
            with self.subTest(ids=ids):
                (self.directory / "popup-ack.json").write_text(json.dumps({"version": 1,
                    "notice_id": displayed["notice_id"], "notice_ids": ids, "action": "mark_read"}))
                observer.poll_once()
                self.assertFalse(any(item["read"] for item in observer.state["notifications"]))

    def test_report_keeps_sample_counts_but_displays_unique_customer_cards_with_folded_evidence(self):
        observer = self.observer(callback=False); observer.poll_once()
        self.submit(); self.submit(); self.submit(uid=V)
        observer.poll_once()
        report = self.read("reception-audit.json")
        self.assertEqual(report["returned_units"], 3)
        self.assertEqual(len(report["samples"]), 3)
        self.assertEqual(len(report["customer_cards"]), 2)
        grouped = {card["conversation_id"]: card for card in report["customer_cards"]}
        self.assertEqual(len(grouped[U]["technical_details"]["samples"]), 2)
        self.assertEqual(grouped[U]["technical_details"]["operations"][0]["payload"]["text"], PRIVATE)
        md = (self.directory / "reception-audit.md").read_text()
        self.assertEqual(md.count("<summary>技术详情</summary>"), 2)
        self.assertIn("<summary>存量异常（不计新进线）</summary>", md)
        self.assertIn("客户原话PRIVATE_INCOMING", md)
        self.assertIn(PRIVATE, md)

    def test_unanswered_report_question_is_not_shown_as_waiting_for_customer(self):
        self.incoming()
        observer = self.observer(callback=False); observer.poll_once()
        card = self.read("reception-audit.json")["customer_cards"][0]
        self.assertIn("未记录本程序回复", card["customer_brief"]["action"])

    def test_markdown_brief_escapes_customer_markup_and_keeps_full_folded_json(self):
        from xhs_reception.audit_notifier import render_markdown
        hostile = '<script>alert(1)</script> ![x](https://example.invalid) **not a heading**'
        report = {"samples": [{}], "customer_cards": [{"conversation_id": U,
            "customer_brief": dict.fromkeys(("customer", "reply", "progress", "action"), hostile),
            "technical_details": {"samples": [], "conversation_id": U, "original": "原话" * 9000}}]}
        md = render_markdown(report)
        visible = md.split("<details>", 1)[0]
        self.assertNotIn("<script>", visible)
        self.assertNotIn("![x]", visible)
        self.assertIn("原话" * 9000, md)

    def test_disabled_preview_can_later_enable_existing_warning_once(self):
        self.submit("unknown")
        observer = self.observer(enabled=False); observer.poll_once(); observer.close()
        self.observer().poll_once()
        self.assertEqual(len(self.notifications), 1)

    def test_expired_and_cancelled_are_not_claimed_sent(self):
        observer = self.observer(); observer.poll_once(); self.incoming()
        first = self.engine.prepare_intent(A, U, "reply", {"operation": "text", "text": PRIVATE}, expires_at=self.now + .1)
        self.now += .2; self.engine.expire_unsubmitted(A, U)
        self.incoming(V)
        second = self.engine.prepare_intent(A, V, "reply", {"operation": "text", "text": PRIVATE})
        self.incoming(V)
        observer.poll_once()
        self.assertEqual({item["state"] for item in observer.state["notifications"]}, {"EXPIRED", "BLOCKED"})
        self.assertEqual(len(self.notifications), 2)
        self.assertTrue(all("已核验发送" not in title for title, _, _ in self.notifications))

    def test_single_instance_and_missing_database_never_initializes_sqlite(self):
        observer = self.observer()
        with self.assertRaisesRegex(NotifierError, "already_running"):
            self.observer()
        observer.close()
        missing = self.directory / "absent.sqlite3"
        absent = AuditNotifier(missing, account_id=A)
        self.observers.append(absent)
        with self.assertRaisesRegex(NotifierError, "database_missing"):
            absent.poll_once()
        self.assertFalse(missing.exists())

    def test_readonly_connections_and_source_collision_rejected(self):
        observer = self.observer()
        real = sqlite3.connect
        with patch("xhs_reception.audit_notifier.sqlite3.connect", wraps=real) as connect:
            observer.poll_once()
        self.assertGreaterEqual(connect.call_count, 2)
        self.assertTrue(all("mode=ro" in call.args[0] and call.kwargs.get("uri") for call in connect.call_args_list))
        observer.close()
        collision = self.directory / "reception-audit.json"
        original = collision.read_bytes()
        with self.assertRaisesRegex(NotifierError, "output_database_collision"):
            AuditNotifier(collision, account_id=A)
        self.assertEqual(collision.read_bytes(), original)

    def test_panel_exports_literal_originals_and_separate_existing_exception(self):
        self.incoming(historical=True)
        self.now += .1
        self.engine.ingest_event(Event(A, U, "native-baseline", "OUTBOUND_OBSERVED", self.now, self.now,
            {"source": "platform_ui", "timestamp_source": "platform_ui", "account_id": A,
             "conversation_id": U, "reference": "synthetic-native-outbound", "observed_at": self.now,
             "native_message_id": "jarvis-msg-" + A + "." + U + ".baseline",
             "historical_baseline": True}))
        self.now += 1801
        unknown = self.submit("unknown", kind="followup", new_source=False)
        observer = self.observer(callback=False); observer.poll_once()
        report = self.read("reception-audit.json")
        self.assertEqual(report["returned_units"], 0)
        self.assertEqual(report["existing_exceptions_not_counted_as_entries"][0]["intent_id"], unknown["intent_id"])
        md = (self.directory / "reception-audit.md").read_text()
        self.assertIn("```text\n" + PRIVATE + "\n```", md)
        self.assertIn("本地", md)
        for name in ["reception-audit.md", "reception-audit.html", "reception-audit.json", "popup-current.json"]:
            self.assertEqual(os.stat(self.directory / name).st_mode & 0o777, 0o600)

    def test_mark_read_requests_are_applied_by_single_writer_and_not_delivery_evidence(self):
        self.submit("unknown")
        observer = self.observer(); observer.poll_once()
        identity = observer.state["notifications"][0]["id"]
        self.assertEqual(len(notifier_status(self.directory)["unread"]), 1)
        mark_read(self.directory, [identity]); observer.poll_once()
        self.assertEqual(notifier_status(self.directory)["unread"], [])
        self.assertFalse(observer.state["notifications"][0]["visible_verified"])

    def test_notification_source_fixed_args_and_timeout_never_claim_visible(self):
        calls = []
        def fake(*args, **kwargs):
            calls.append((args, kwargs)); return types.SimpleNamespace(returncode=0)
        result = notify_macos('title"', "subtitle", PRIVATE, runner=fake)
        self.assertEqual(calls[0][0][0], ["/usr/bin/osascript", "-", 'title"', "subtitle", PRIVATE])
        self.assertEqual(calls[0][1]["input"], SCRIPT)
        self.assertNotIn("PRIVATE", SCRIPT)
        self.assertNotIn("shell", calls[0][1])
        self.assertFalse(result["visible_verified"])
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired("synthetic", 3)
        self.assertEqual(notify_macos("", "", "", runner=timeout)["command_state"], "command_timed_out")

    def test_sent_record_without_native_history_is_never_greenwashed(self):
        observer = self.observer(callback=False); observer.poll_once()
        row = self.submit()
        proof = {key: value for key, value in row["evidence"].items() if key != "native_server_history"}
        self.engine.db.execute("UPDATE outbox SET evidence=? WHERE intent_id=?", (json.dumps(proof), row["intent_id"]))
        observer.poll_once()
        payload = self.read("popup-current.json")
        self.assertIn("原生回执未核验", payload["title"])
        self.assertFalse(payload["native_history_confirmed"])
        self.assertEqual(payload["timestamp_source"], "outbox.confirmed_at")
        self.assertEqual(payload["created_at_utc"], __import__("xhs_reception.audit_notifier", fromlist=["_utc"])._utc(row["confirmed_at"]))

    def test_unchanged_poll_has_no_repeat_payload_or_ledger_fsync(self):
        self.submit("unknown")
        observer = self.observer(callback=False); observer.poll_once()
        files = [self.directory / name for name in ("popup-current.json", "audit-notifier-state.json", "reception-audit.json")]
        stats = [file.stat().st_mtime_ns for file in files]
        observer.poll_once()
        self.assertEqual([file.stat().st_mtime_ns for file in files], stats)

    def test_resolved_unknown_across_audit_page_never_emits_stale_warning(self):
        observer = self.observer(); observer.poll_once()
        unknown = self.submit("unknown")
        for _ in range(501):
            self.engine.db.execute("INSERT INTO audit_log(at,account_id,conversation_id,action,detail) VALUES(?,?,?,?,?)",
                                   (self.now, A, U, "EVENT_INGESTED", "{}"))
        self.now += .1
        self.engine.reconcile(unknown["intent_id"], "sent", {**unknown["evidence"], "observed_at": self.now})
        observer.poll_once()
        self.assertEqual(self.notifications, [])
        observer.poll_once()
        self.assertEqual(len(self.notifications), 1)
        self.assertIn("已核验发送", self.notifications[0][0])
        self.assertEqual([item["state"] for item in observer.state["notifications"]], ["SENT"])


if __name__ == "__main__":
    unittest.main()
