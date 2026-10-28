"""Popup transport stays bounded without losing original report evidence."""
import json
import unittest
import sqlite3
from unittest.mock import patch

from tests import test_audit_popup_summary as fixtures
from tests import test_audit_notifier as storage_fixtures
from xhs_reception.audit_notifier import build_customer_cards, popup_payload


class PopupPayloadBudgetTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PopupSummaryTest()
        self.fixture.setUp()

    def test_large_native_evidence_cannot_block_the_short_popup_and_reports_keep_it(self):
        fixture = self.fixture
        original = '原生不可信诊断👋 <script>literal</script>' * 30000
        fixture.row['evidence']['untrusted_native_diagnostic'] = original
        payload = fixture.payload()
        self.assertLess(len((json.dumps(payload, ensure_ascii=True, allow_nan=False, indent=2) + '\n').encode()), 262144)
        self.assertEqual(payload['grouped_notice_ids'], [fixture.item['id']])
        self.assertIn('待确认', payload['customer_brief']['reply'])
        self.assertTrue(payload['technical_details']['truncated'])
        self.assertEqual(payload['technical_details']['full_report'], 'reception-audit.json')
        report = {'samples': [{'account_id': fixtures.A, 'conversation_id': fixtures.U,
            'latest_inbound_event_id': fixture.source_id, 'conversation_state': 'ACTIVE',
            'stop_reason': None, 'reply_attempts': [{'intent_id': fixture.row['intent_id']}]}]}
        cards = build_customer_cards(report, fixture.outbox, fixture.sources)
        self.assertEqual(cards[0]['technical_details']['operations'][0]['evidence']['untrusted_native_diagnostic'], original)
        self.assertEqual(fixture.row['evidence']['untrusted_native_diagnostic'], original)

    def test_card_only_unread_details_keep_the_full_text_used_by_its_brief(self):
        fixture = self.fixture
        fixture.row['payload']['text'] = '完整文字原文' * 1000
        card = {**fixture.row, 'intent_id': 'card-intent', 'created_at': fixture.now + .5,
            'payload': {'operation': 'native_card', 'companion_text_intent_id': fixture.row['intent_id']}}
        fixture.outbox[card['intent_id']] = card
        notice = {**fixture.item, 'id': 'card-only-unread', 'intent_id': card['intent_id']}
        payload = popup_payload(notice, card, fixture.sources, fixture.outbox, 1)
        operations = {item['intent_id']: item for item in payload['technical_details']['operations']}
        self.assertIn(fixture.row['intent_id'], operations)
        self.assertEqual(operations[fixture.row['intent_id']]['payload']['text'], fixture.row['payload']['text'])

    def test_complete_transport_counts_repeated_unicode_compatibility_fields(self):
        fixture = self.fixture
        fixture.source['type'] = 'CUSTOMER_MESSAGE'
        fixture.source['evidence']['untrusted_message_text'] = '👋' * 4000
        fixture.row['payload']['text'] = '👋' * 4000
        payload = fixture.payload()
        self.assertLess(len((json.dumps(payload, ensure_ascii=True, allow_nan=False, indent=2) + '\n').encode()), 262144)
        self.assertEqual(payload['notice_id'], fixture.item['id'])
        self.assertEqual(payload['grouped_notice_ids'], [fixture.item['id']])
        self.assertTrue(payload['technical_details']['truncated'])

    def test_large_popup_outside_latest_ten_has_complete_evidence_in_same_report(self):
        fixture = storage_fixtures.AuditNotifierTest()
        fixture.setUp()
        try:
            observer = fixture.observer(callback=False)
            observer.poll_once()
            row = fixture.submit('unknown')
            original = '未受信任的完整原生诊断👋' * 30000
            with sqlite3.connect(fixture.db) as connection:
                evidence = json.loads(connection.execute('SELECT evidence FROM outbox WHERE intent_id=?', (row['intent_id'],)).fetchone()[0])
                evidence['untrusted_native_diagnostic'] = original
                connection.execute('UPDATE outbox SET evidence=? WHERE intent_id=?', (json.dumps(evidence), row['intent_id']))
            old_outside_latest_ten = {'samples': [], 'returned_units': 0, 'generated_at_utc': '2026-10-27T00:00:00Z'}
            with patch('xhs_reception.audit_notifier.read_reception_audit', return_value=old_outside_latest_ten):
                observer.poll_once()
            popup = fixture.read('popup-current.json')
            report = fixture.read('reception-audit.json')
            self.assertLess((fixture.directory / 'popup-current.json').stat().st_size, 262144)
            self.assertTrue(popup['technical_details']['truncated'])
            complete = report['notification_details'][popup['notice_id']]
            self.assertEqual(complete['operations'][0]['evidence']['untrusted_native_diagnostic'], original)
            self.assertEqual(report['samples'], [])
        finally:
            fixture.tearDown()


if __name__ == '__main__':
    unittest.main()
