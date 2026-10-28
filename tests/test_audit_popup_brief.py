"""Offscreen/plain-data checks; no NSWindow, runtime state or production ACK."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from tests.test_audit_popup_body import ROOT, SDK, SWIFTC


HARNESS = r'''
import AppKit
import Foundation
__PRODUCTION_BODY__

let first: [String: Any] = [
    "notice_id": "notice-first", "state": "UNKNOWN", "customer_uid": "private-uid",
    "grouped_notice_ids": ["notice-first", "notice-card"],
    "customer_brief": ["customer": "客户甲，问美国一件代发", "reply": "已准备回复，结果待确认",
                       "progress": "未确认留资", "action": "核验原消息，避免重复"],
    "technical_details": ["intent_id": "private-intent", "raw": "<script>不可执行</script>",
                          "url": "https://example.invalid/private"]]
var presentation = PopupPresentation()
presentation.update(first)
let initial = presentation.displayText
let firstAck = presentation.acknowledgement(at: "2026-10-27T00:00:00Z")!
let unrenderedAck = popupRenderedAcknowledgement(presentation, contentRevision: 2, drawnRevision: 1,
                                                at: "2026-10-27T00:00:00Z")
let renderedAck = popupRenderedAcknowledgement(presentation, contentRevision: 2, drawnRevision: 2,
                                              at: "2026-10-27T00:00:00Z")
let initialCollapsed = !presentation.detailsExpanded
presentation.toggleDetails()
let expanded = presentation.displayText
let detailAck = presentation.acknowledgement(at: "2026-10-27T00:00:00Z")!
var refresh = first
refresh["grouped_notice_ids"] = ["notice-first", "notice-card", "notice-late"]
presentation.update(refresh)
let keptExpanded = presentation.detailsExpanded
let refreshedAck = presentation.acknowledgement(at: "2026-10-27T00:00:00Z")!
var next = first
next["notice_id"] = "notice-next"
next["grouped_notice_ids"] = ["notice-next"]
presentation.update(next)
let nextCollapsed = !presentation.detailsExpanded
let legacy: [String: Any] = ["notice_id": "notice-legacy", "state": "UNKNOWN",
    "customer_uid": "private-legacy-uid", "business_summary": [
      "customer": "旧通知客户", "activity": "新进线，尚未开口", "customer_message": "尚未开口",
      "our_reply": "发送待核实：旧稿件", "lead": "尚未确认留资", "next_step": "先核验原消息，避免重复"]]
presentation.update(legacy)
let legacyAck = presentation.acknowledgement(at: "2026-10-27T00:00:00Z")!
let legacyBrief = presentation.displayText
var hostile = first
hostile["customer_brief"] = ["customer": String(repeating: "恶意长昵称 <script>\n", count: 300),
                            "reply": "待确认", "progress": "未确认留资", "action": "请先核验"]
hostile["technical_details"] = ["raw": String(repeating: "很长的技术原话", count: 20000)]
let boundedBrief = popupBriefDetails(hostile)
let boundedTechnical = popupTechnicalDetails(hostile)
let longSentWithUnknownCard = popupBriefDetails([
    "state": "SENT", "card_state": "UNKNOWN", "customer_brief": [
        "customer": "客户甲", "reply": "已回复：" + String(repeating: "完整业务回复", count: 30) + "；企微名片：待确认",
        "progress": "尚未确认留资", "action": "核验原消息，避免重复"]])
let maliciousLegacy = popupBriefDetails(["notice_id": "legacy-raw", "state": "SENT", "card_state": "SENT",
    "reply_text": "普通草稿；企微名片：已发送"])
let structuredUnknownCard = popupBriefDetails(["state": "SENT", "card_state": "SENT",
    "customer_card_state": "UNKNOWN", "customer_brief": ["customer": "客户甲",
      "reply": "已回复：正文；企微名片：已核验发送", "progress": "尚未确认留资", "action": "核验原消息"]])
let data: [String: Any] = ["initial": initial, "initial_collapsed": initialCollapsed,
    "expanded": expanded, "first_ack": firstAck, "details_ack": detailAck,
    "kept_expanded": keptExpanded, "refreshed_ack": refreshedAck, "next_collapsed": nextCollapsed,
    "legacy_ack": legacyAck, "legacy_brief": legacyBrief,
    "brief_field_count": presentation.briefFieldCount,
    "bounded_brief": boundedBrief, "bounded_technical_count": boundedTechnical.count,
    "long_sent_with_unknown_card": longSentWithUnknownCard,
    "malicious_legacy": maliciousLegacy, "structured_unknown_card": structuredUnknownCard,
    "unrendered_ack_rejected": unrenderedAck == nil, "rendered_ack_allowed": renderedAck != nil,
    "bounded_technical_truncated": boundedTechnical.contains("已截断")]
let encoded = try! JSONSerialization.data(withJSONObject: data, options: [.sortedKeys])
print(String(data: encoded, encoding: .utf8)!)
'''


@unittest.skipUnless(sys.platform == "darwin" and SDK.exists() and SWIFTC.exists(),
                     "requires existing macOS AppKit SDK and Swift compiler")
class AuditPopupBriefTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="chatcut-popup-brief-test-")
        output = Path(cls.temporary.name)
        source = (ROOT / "xhs_reception/audit_popup.swift").read_text()
        body = source[source.index("@MainActor final class AuditBodyView"):
                      source.index("\nfunc writeJSON")]
        harness = output / "brief.swift"
        harness.write_text(HARNESS.replace("__PRODUCTION_BODY__", body))
        executable = output / "brief-check"
        cls.build = subprocess.run([str(SWIFTC), "-sdk", str(SDK), "-target", "arm64-apple-macos15",
                                   "-framework", "AppKit", str(harness), "-o", str(executable)],
                                  capture_output=True, text=True)
        if cls.build.returncode == 0:
            result = subprocess.run([str(executable)], check=True, capture_output=True, text=True)
            cls.result = json.loads(result.stdout)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def result_ready(self):
        self.assertEqual(self.build.returncode, 0, "brief/state contract missing: " + self.build.stderr)
        return self.result

    def test_default_card_has_only_four_business_fields_and_pending_is_visible(self):
        result = self.result_ready()
        self.assertTrue(result["initial_collapsed"])
        self.assertEqual(result["brief_field_count"], 4)
        for label in ("客户：", "回复：", "进展：", "处理："):
            self.assertIn(label, result["initial"])
        self.assertIn("待确认", result["initial"])
        for private in ("private-uid", "private-intent", "UNKNOWN", "example.invalid", "技术详情"):
            self.assertNotIn(private, result["initial"])

    def test_details_toggle_keeps_ack_snapshot_and_resets_only_for_new_notice(self):
        result = self.result_ready()
        self.assertIn("private-intent", result["expanded"])
        self.assertIn("<script>不可执行</script>", result["expanded"])
        self.assertEqual(result["first_ack"], result["details_ack"])
        self.assertTrue(result["kept_expanded"])
        self.assertTrue(result["next_collapsed"])

    def test_ack_only_contains_exact_displayed_members_and_legacy_stays_single(self):
        result = self.result_ready()
        self.assertEqual(result["first_ack"]["notice_id"], "notice-first")
        self.assertEqual(result["first_ack"]["notice_ids"], ["notice-first", "notice-card"])
        self.assertNotIn("notice-late", result["first_ack"]["notice_ids"])
        self.assertEqual(result["refreshed_ack"]["notice_ids"], ["notice-first", "notice-card", "notice-late"])
        self.assertEqual(result["legacy_ack"]["notice_id"], "notice-legacy")
        self.assertNotIn("notice_ids", result["legacy_ack"])
        self.assertTrue(result["unrendered_ack_rejected"])
        self.assertTrue(result["rendered_ack_allowed"])

    def test_legacy_summary_is_four_fields_and_hostile_long_content_is_bounded(self):
        result = self.result_ready()
        self.assertIn("客户：旧通知客户", result["legacy_brief"])
        self.assertIn("待确认", result["legacy_brief"])
        self.assertNotIn("private-legacy-uid", result["legacy_brief"])
        self.assertLess(len(result["bounded_brief"]), 1200)
        self.assertLessEqual(result["bounded_technical_count"], 60100)
        self.assertTrue(result["bounded_technical_truncated"])

    def test_unknown_card_remains_explicit_when_sent_text_is_long(self):
        result = self.result_ready()
        reply = result["long_sent_with_unknown_card"].split("\n\n")[1]
        self.assertIn("企微名片：待确认", reply)
        self.assertIn("已回复", reply)

    def test_card_success_cannot_be_granted_by_legacy_reply_words(self):
        result = self.result_ready()
        self.assertIn("企微名片：尚未确认发送", result["malicious_legacy"])
        self.assertIn("发送待确认", result["malicious_legacy"])
        self.assertNotIn("企微名片：已发送", result["malicious_legacy"])
        self.assertIn("企微名片：待确认", result["structured_unknown_card"])
        self.assertNotIn("企微名片：已核验发送", result["structured_unknown_card"])


if __name__ == "__main__":
    unittest.main()
