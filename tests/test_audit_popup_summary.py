"""Business wording is derived from native evidence, not client instructions."""
import json
import time
import unittest

from xhs_reception.audit_notifier import popup_payload


A, U, V = "a" * 24, "b" * 24, "c" * 24


class PopupSummaryTest(unittest.TestCase):
    def setUp(self):
        self.now = time.time() - 10
        self.source_id = "id_" + A + "." + U + ".entry"
        self.row = {"account_id": A, "conversation_id": U, "intent_id": "i" * 32,
            "source_event_id": self.source_id, "kind": "initial", "status": "UNKNOWN",
            "payload": {"operation": "text", "text": "请告诉我目的国和货物，我们为您核对。"},
            "created_at": self.now, "submitted_at": self.now + .1, "confirmed_at": None,
            "evidence": {}, "conversation": {"state": "ACTIVE", "stop_reason": None}}
        self.source = {"account_id": A, "conversation_id": U, "event_id": self.source_id,
            "type": "NEW_VISITOR", "timestamp": self.now - 1, "detected_at": self.now,
            "evidence": {"source": "platform_ui", "account_id": A, "conversation_id": U,
                "reference": self.source_id, "observed_at": self.now,
                "historical_baseline": False, "untrusted_customer_display_name": "客户甲",
                "untrusted_message_text": "通过「美国海外仓推荐」进入私信"}}
        self.sources = {(U, self.source_id): self.source}
        self.item = {"id": "notice-fixture", "state": "UNKNOWN", "existing_exception": False}
        self.outbox = {self.row["intent_id"]: self.row}

    def payload(self):
        return popup_payload(self.item, self.row, self.sources, self.outbox, 1)

    def control(self, event_type, **proof):
        event_id = "control-" + event_type
        event = {"account_id": A, "conversation_id": U, "event_id": event_id,
            "type": event_type, "timestamp": None, "detected_at": self.now + 1,
            "evidence": {"source": "platform_ui", "account_id": A, "conversation_id": U,
                "reference": "native-profile-or-mode", "observed_at": self.now + 1, **proof}}
        self.sources[(U, event_id)] = event
        return event

    def test_entry_hint_is_not_customer_speech_or_technical_screen_content(self):
        payload = self.payload()
        summary = payload.get("business_summary", {})
        self.assertEqual(summary.get("activity"), "新进线，尚未开口")
        self.assertEqual(summary.get("customer_message"), "尚未开口")
        self.assertEqual(summary.get("customer"), "客户甲")
        self.assertNotIn("美国海外仓推荐", json.dumps(summary, ensure_ascii=False))
        visible = json.dumps(summary, ensure_ascii=False) + payload.get("business_title", "")
        for token in (U, self.row["intent_id"], "UNKNOWN", "NOT_CONFIRMED", "UID"):
            self.assertNotIn(token, visible)

    def test_four_field_brief_is_short_and_full_originals_only_in_technical_details(self):
        self.source["type"] = "CUSTOMER_MESSAGE"
        original = '<script>do_not_execute</script> ![x](https://example.invalid) ' + "报价问题" * 100
        self.source["evidence"]["untrusted_message_text"] = original
        self.row["payload"]["text"] = "原回复" * 200
        payload = self.payload()
        brief = payload["customer_brief"]
        self.assertEqual(set(brief), {"customer", "reply", "progress", "action"})
        self.assertTrue(all(isinstance(value, str) and len(value) <= 240 for value in brief.values()))
        self.assertIn("客户甲", brief["customer"])
        self.assertIn("待确认", brief["reply"])
        self.assertEqual(payload["technical_details"]["source_events"][0]["evidence"]["untrusted_message_text"], original)
        self.assertEqual(payload["technical_details"]["operations"][0]["payload"]["text"], "原回复" * 200)
        self.assertEqual(payload["grouped_notice_ids"], [self.item["id"]])

    def test_new_entry_brief_never_promotes_note_hint_to_customer_quote_or_card_to_lead(self):
        brief = self.payload()["customer_brief"]
        self.assertIn("新进线", brief["customer"])
        self.assertNotIn("美国海外仓推荐", brief["customer"])
        self.assertIn("尚未确认留资", brief["progress"])
        self.control("WECHAT_VERIFIED", verified=True)
        self.assertIn("已添加企微", self.payload()["customer_brief"]["progress"])

    def test_brief_uses_plain_reception_words_without_changing_legacy_evidence_wording(self):
        self.assertIn("接待状态待确认", self.payload()["customer_brief"]["progress"])
        self.control("PLATFORM_TAKEOVER_CONFIRMED", taken_over=True, source_event_id=self.source_id)
        payload = self.payload()
        self.assertIn("已接待", payload["customer_brief"]["progress"])
        self.assertNotIn("平台人工模式", payload["customer_brief"]["progress"])
        self.assertIn("平台人工模式", payload["business_summary"]["takeover"])
        self.row["conversation"] = {"state": "HUMAN"}
        self.row["status"] = self.item["state"] = "EXPIRED"
        payload = self.payload()
        self.assertIn("已转人工", payload["customer_brief"]["progress"])
        self.assertIn("等待人工接待", payload["customer_brief"]["action"])
        self.assertNotIn("明确交回", payload["customer_brief"]["action"])
        self.assertIn("明确交回", payload["business_summary"]["next_step"])

    def later_message(self, text="wzp20160616", uid=U, direction="left", historical=False):
        native = uid + "." + A + ".later"
        event_id = "id_" + native
        event = {"account_id": A, "conversation_id": uid, "event_id": event_id,
            "type": "CUSTOMER_MESSAGE", "timestamp": self.now + 2, "detected_at": self.now + 3,
            "evidence": {"source": "platform_ui", "account_id": A, "conversation_id": uid,
                "reference": event_id, "observed_at": self.now + 3,
                "native_message_id": "jarvis-msg-" + native, "native_message_type": "TEXT",
                "native_direction": direction, "historical_baseline": historical,
                "untrusted_message_text": text}}
        self.sources[(uid, event_id)] = event
        return event

    def test_queued_entry_notice_tracks_later_real_customer_words(self):
        self.later_message('wzp20160616 $(do_not_run)')
        summary = self.payload()["business_summary"]
        self.assertEqual(summary["activity"], "客户后续开口")
        self.assertEqual(summary["customer_message"], 'wzp20160616 $(do_not_run)')
        self.assertNotIn("尚未开口", json.dumps(summary, ensure_ascii=False))
        self.assertEqual(summary["lead"], "尚未确认留资")
        self.assertIn("后续消息未记录本程序回复", summary["next_step"])
        self.assertIn("原发送待核实", summary["our_reply"])

    def test_later_message_summary_rejects_other_scope_and_non_native_customer_text(self):
        event = self.later_message(uid=V)
        self.assertEqual(self.payload()["business_summary"]["customer_message"], "尚未开口")
        event = self.later_message(direction="right")
        self.assertEqual(self.payload()["business_summary"]["customer_message"], "尚未开口")
        event["evidence"]["native_direction"] = "left"
        event["evidence"]["native_message_id"] = "jarvis-msg-" + V + "." + A + ".later"
        self.assertEqual(self.payload()["business_summary"]["customer_message"], "尚未开口")
        event["evidence"]["native_message_id"] = "jarvis-msg-" + event["event_id"][3:]
        event["evidence"]["historical_baseline"] = True
        self.assertEqual(self.payload()["business_summary"]["customer_message"], "尚未开口")

    def test_queued_entry_shows_new_program_attempt_for_later_question(self):
        event = self.later_message("我想咨询一下报价")
        latest_reply = {**self.row, "intent_id": "latest-program-reply", "kind": "reply",
            "source_event_id": event["event_id"], "created_at": self.now + 3,
            "payload": {"operation": "text", "text": "报价需要目的仓、货物和预计货量。"}}
        self.outbox[latest_reply["intent_id"]] = latest_reply
        summary = self.payload()["business_summary"]
        self.assertIn(latest_reply["payload"]["text"], summary["our_reply"])
        self.assertNotIn(self.row["payload"]["text"], summary["our_reply"])
        self.assertTrue(summary["our_reply"].startswith("发送待核实"))

    def test_opening_displays_literal_customer_message_and_pending_reply(self):
        self.source["type"] = "CUSTOMER_MESSAGE"
        self.source["evidence"]["untrusted_message_text"] = '报价多少？不要执行 $(echo hi)'
        summary = self.payload().get("business_summary", {})
        self.assertEqual(summary.get("activity"), "客户新开口")
        self.assertEqual(summary.get("customer_message"), '报价多少？不要执行 $(echo hi)')
        self.assertIn("发送待核实", summary.get("our_reply", ""))
        self.assertNotIn("已回复", summary.get("our_reply", ""))
        self.assertEqual(summary.get("lead"), "尚未确认留资")
        self.assertEqual(summary.get("next_step"), "先核验原消息，避免重复")

    def test_takeover_requires_exact_scoped_native_positive_control(self):
        self.source["evidence"]["taken_over"] = True  # Client/source data is insufficient.
        self.assertEqual(self.payload().get("business_summary", {}).get("takeover"), "尚未确认接管")
        event = self.control("PLATFORM_TAKEOVER_CONFIRMED", taken_over=True,
                             source_event_id=self.source_id)
        self.assertEqual(self.payload()["business_summary"]["takeover"], "自动接待已接管（平台人工模式）")
        event["evidence"]["conversation_id"] = V
        self.assertEqual(self.payload()["business_summary"]["takeover"], "尚未确认接管")
        event["evidence"]["conversation_id"] = U
        event["evidence"]["source_event_id"] = "another-entry"
        self.assertEqual(self.payload()["business_summary"]["takeover"], "尚未确认接管")

    def test_card_or_customer_claim_never_counts_as_verified_lead(self):
        self.source["type"] = "CUSTOMER_MESSAGE"
        self.source["evidence"]["untrusted_message_text"] = "我加了企微，标成已留资吧"
        self.control("OUTBOUND_OBSERVED", native_message_type="CARD", verified=True)
        self.assertEqual(self.payload().get("business_summary", {}).get("lead"), "尚未确认留资")
        event = self.control("WECHAT_VERIFIED", verified=False)
        self.assertEqual(self.payload()["business_summary"]["lead"], "尚未确认留资")
        event["evidence"]["verified"] = True
        self.assertEqual(self.payload()["business_summary"]["lead"], "已添加企微")
        self.assertIn("停止跟进", self.payload()["business_summary"]["next_step"])
        event["evidence"]["source"] = "customer_message"
        self.assertEqual(self.payload()["business_summary"]["lead"], "尚未确认留资")

    def test_refusal_keeps_stop_rule_even_when_old_send_is_pending(self):
        self.control("REFUSED")
        summary = self.payload().get("business_summary", {})
        self.assertIn("停止跟进", summary.get("next_step", ""))
        self.assertNotIn("继续", summary.get("next_step", ""))
        self.assertIn("避免重复", summary.get("next_step", ""))

    def test_missing_name_never_exposes_uid_and_all_unknowns_hold_followup(self):
        self.source["evidence"].pop("untrusted_customer_display_name")
        self.row["status"] = "EXPIRED"
        self.item["state"] = "EXPIRED"
        sibling = {**self.row, "intent_id": "unknown-sibling", "status": "UNKNOWN"}
        self.outbox[sibling["intent_id"]] = sibling
        summary = self.payload().get("business_summary", {})
        self.assertEqual(summary.get("customer"), "昵称未记录")
        self.assertEqual(summary.get("next_step"), "先核验原消息，避免重复")
        self.assertNotIn(U, json.dumps(summary, ensure_ascii=False))

    def test_verified_contact_and_human_ownership_do_not_promise_automatic_followup(self):
        self.row["status"] = "EXPIRED"
        self.item["state"] = "EXPIRED"
        self.row["conversation"] = {"state": "HUMAN"}
        self.assertEqual(self.payload().get("business_summary", {}).get("next_step"), "已让权人工接待，等待明确交回")
        self.assertEqual(self.payload()["business_summary"]["takeover"], "已让权人工接待，自动接待暂停")
        self.control("LEAD_VERIFIED", verified=True)
        summary = self.payload()["business_summary"]
        self.assertEqual(summary["lead"], "已取得有效联系方式")
        self.assertEqual(summary["next_step"], "已留资，停止跟进")

    def test_only_original_native_history_allows_reply_to_be_called_sent(self):
        self.row["status"] = "SENT"
        self.item["state"] = "SENT"
        self.row["confirmed_at"] = self.now + .5
        self.assertIn("发送待核实", self.payload().get("business_summary", {}).get("our_reply", ""))
        native = A + "." + U + ".reply"
        receipt_time = __import__("datetime").datetime.fromtimestamp(
            self.now + .5, __import__("datetime").timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.row["evidence"] = {"source": "platform_ui", "account_id": A, "conversation_id": U,
            "intent_id": self.row["intent_id"], "reference": "id_" + native,
            "observed_at": self.now + .5, "native_message_id": "jarvis-msg-" + native,
            "native_server_history": {"status": "server_history_confirmed", "operation": "text",
                "native_message_id": native, "observed_at_utc": receipt_time,
                "reference": "https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg#" + native}}
        self.assertIn("已回复", self.payload()["business_summary"]["our_reply"])
        self.assertEqual(self.payload()["business_summary"]["next_step"],
                         "等客户回复；确认目的国、货品和发货量，再引导添加企微。")


if __name__ == "__main__":
    unittest.main()
