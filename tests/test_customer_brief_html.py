"""Business view stays readable while original audit evidence remains expandable."""
from html.parser import HTMLParser
import json
import unittest

from xhs_reception.reception_audit import render_html


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.depth = 0
        self.hidden = 0
        self.visible = []
        self.detail_text = []
        self.details = []
        self.scripts = 0
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "details":
            self.depth += 1
            self.details.append(values)
        if tag in ("style", "script", "title"):
            self.hidden += 1
        if tag == "script":
            self.scripts += 1

    def handle_endtag(self, tag):
        if tag == "details":
            self.depth -= 1
        if tag in ("style", "script", "title"):
            self.hidden -= 1

    def handle_data(self, value):
        if not self.hidden:
            (self.detail_text if self.depth else self.visible).append(value)


class CustomerBriefHTMLTests(unittest.TestCase):
    def report(self):
        return {
            "generated_at_utc": "2026-10-27T04:00:00Z", "returned_units": 2,
            "total_observed_units": 34, "platform_entry_units": 27, "message_opening_units": 7,
            "samples": [], "customer_cards": [{
                "conversation_id": "private-native-customer-id",
                "customer_brief": {"customer": "客户甲｜报价多少？",
                    "reply": "已回复：请问发往哪个国家？；企微卡：发送待确认",
                    "progress": "尚未确认添加企微", "action": "无需操作，名片结果待核对"},
                "technical_details": {"intent_id": "private-intent-id", "state": "UNKNOWN",
                    "native_time": "2026-10-27T04:00:00.123Z", "full_reply": "完整回复不能丢失",
                    "three_second_bundle": {"complete": False, "assessment": "unverified"}}
            }],
            "existing_exceptions_not_counted_as_entries": [{"intent_id": "old-private-exception"}]
        }

    def test_customer_four_fields_are_visible_and_original_evidence_starts_collapsed(self):
        source = render_html(self.report())
        document = Document(source)
        visible = "".join(document.visible)
        detail = "".join(document.detail_text)
        for value in ["客户甲", "发往哪个国家", "发送待确认", "尚未确认添加企微", "无需操作"]:
            self.assertIn(value, visible)
        for value in ["private-native-customer-id", "private-intent-id", "UNKNOWN", "2026-10-27T04:00:00", "old-private-exception"]:
            self.assertNotIn(value, visible)
            self.assertIn(value, detail)
        self.assertIn("完整回复不能丢失", detail)
        self.assertIn("技术详情", detail)
        self.assertTrue(document.details)
        self.assertTrue(all("open" not in attrs for attrs in document.details))
        self.assertNotIn('http-equiv="refresh"', source)

    def test_customer_and_technical_strings_cannot_create_html_elements(self):
        report = self.report()
        hostile = '</details><script>do_not_execute()</script><img src=x onerror="do_not_execute()">'
        report["customer_cards"][0]["customer_brief"]["customer"] = hostile
        report["customer_cards"][0]["technical_details"]["untrusted_text"] = hostile
        source = render_html(report)
        document = Document(source)
        self.assertEqual(document.scripts, 0)
        self.assertIn(hostile, "".join(document.visible))
        self.assertIn(json.dumps(hostile, ensure_ascii=False), "".join(document.detail_text))
        self.assertNotIn("<img", source)
        self.assertEqual(document.depth, 0)

    def test_empty_customer_projection_does_not_invent_a_success(self):
        report = self.report()
        report["customer_cards"] = []
        document = Document(render_html(report))
        self.assertIn("暂无客户接待更新", "".join(document.visible))
        self.assertNotIn("已成功接待", "".join(document.visible))


if __name__ == "__main__":
    unittest.main()
