"""Offline quality review/correction contracts; temporary SQLite only."""
import copy
import os
import sqlite3
import tempfile
import unittest

from xhs_reception import DispatchGate, Engine, Event, GateClosed, InvalidTransition, NotEligible
from xhs_reception.rpc_bridge import EngineRPC


class ReplyQualityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = 100000.0
        self.engine = Engine(os.path.join(self.temp.name, "quality.sqlite3"), clock=lambda: self.now)
        self.source = "id_c1.a1.1eadfdf2a45dd4b"
        self.question(self.source)

    def tearDown(self):
        self.engine.close()
        self.temp.cleanup()

    def evidence(self, **extra):
        return dict(source="platform_ui", account_id="a1", conversation_id="c1",
                    observed_at=self.now, reference="synthetic-native-reference", **extra)

    def question(self, source=None, **changes):
        source = source or self.source
        proof = self.evidence(timestamp_source="platform_ui", native_message_id="jarvis-msg-" + source[3:],
                              native_message_type="TEXT", native_direction="left", historical_baseline=False,
                              untrusted_message_text="日本的有吗")
        proof["reference"] = source
        proof.update(changes)
        self.engine.ingest_event(Event("a1", "c1", source, "CUSTOMER_MESSAGE", timestamp=self.now, evidence=proof))

    def gate(self, **changes):
        data = dict(enabled=True, browser_connected=True, authenticated=True, account_id="a1", conversation_id="c1",
                    browser_session_id="quality-session", observed_at=self.now)
        data.update(changes)
        return DispatchGate(**data)

    def sent(self, kind="reply", **changes):
        payload = {"operation": "text", "text": "可以加企微咨询"} if kind == "reply" else {"operation": "native_card"}
        row = self.engine.prepare_intent("a1", "c1", kind, payload)
        self.engine.claim_intent(row["intent_id"], "original-worker", self.gate())
        self.engine.begin_submit(row["intent_id"], "original-worker", self.gate())
        self.now += .1
        native = "a1.c1.native-original-" + kind
        proof = self.evidence(intent_id=row["intent_id"], native_message_id="jarvis-msg-" + native,
                              native_message_raw_id="native-original-" + kind,
                              native_server_history={"status": "server_history_confirmed", "verifier_version": 7,
                                "operation": "text" if kind == "reply" else "native_card", "native_message_id": native,
                                "native_created_at_ms": self.now * 1000}, usefulness_verified=True, useful=True)
        proof.update(changes)
        return self.engine.confirm(row["intent_id"], "original-worker", "sent", proof)

    def review(self, original, **changes):
        review = dict(source="independent_audit", reviewer="red-team-fixture", classification="not_useful",
                      reason_code="question_not_answered", reference="independent-exact-source-review",
                      observed_at=self.now, account_id="a1", conversation_id="c1", intent_id=original["intent_id"],
                      source_event_id=self.source)
        review.update(changes)
        return self.engine.review_reply_quality("a1", "c1", original["intent_id"], self.source, review)

    def prepare_correction(self, original, **changes):
        payload = dict(operation="text", text="日本方向能否承接，需要先核实仓储和服务资源。你这边是什么货品、预计多少货量，需要一件代发吗？",
                       correction_of_intent_id=original["intent_id"], source_message_text="日本的有吗")
        payload.update(changes)
        return self.engine.prepare_intent("a1", "c1", "correction_reply", payload, source_event_id=self.source)

    def test_independent_review_preserves_original_strict_receipt_clock_and_rearms_exact_source(self):
        original = self.sent()
        original_copy = copy.deepcopy(original)
        card = self.sent("card")
        event_before = self.engine.get_latest_event_metadata("a1", "c1")
        result = self.review(original)
        self.assertEqual(result["intent_id"], original["intent_id"])
        current = next(row for row in self.engine.list_outbox() if row["intent_id"] == original["intent_id"])
        for key in ("status", "submitted_at", "confirmed_at", "source_event_id", "payload"):
            self.assertEqual(current[key], original_copy[key])
        for key in ("native_message_id", "native_message_raw_id", "native_server_history"):
            self.assertEqual(current["evidence"][key], original_copy["evidence"][key])
        self.assertIs(current["evidence"]["usefulness_verified"], True)
        self.assertIs(current["evidence"]["useful"], False)
        self.assertEqual(self.engine.get_latest_event_metadata("a1", "c1"), event_before)
        con = self.engine.get_conversation("a1", "c1")
        self.assertEqual(con["needs_response"], 1)
        self.assertEqual(con["correction_reply"]["correction_of_intent_id"], original["intent_id"])
        self.assertTrue(con["correction_reply"]["eligible"])
        audits = [row for row in self.engine.audit() if row["action"] == "REPLY_QUALITY_REVIEWED"]
        self.assertEqual(len(audits), 1)
        self.review(original)
        self.assertEqual(len([row for row in self.engine.audit() if row["action"] == "REPLY_QUALITY_REVIEWED"]), 1)
        self.assertEqual(next(row for row in self.engine.list_outbox() if row["intent_id"] == card["intent_id"]), card)

    def test_quality_review_requires_independent_exact_strict_sent_text_and_cannot_forge_new_source(self):
        original = self.sent()
        for change in ({"reviewer": "original-worker"}, {"classification": "useful"},
                       {"source": "platform_ui"}, {"intent_id": "another"}, {"source_event_id": "another"},
                       {"reference": ""}, {"observed_at": self.now + 10}):
            with self.subTest(change=change), self.assertRaises((ValueError, NotEligible, InvalidTransition)):
                self.review(original, **change)
        card = self.sent("card")
        with self.assertRaises((ValueError, NotEligible, InvalidTransition)):
            self.review(card)
        self.now += 1
        self.question("id_c1.a1.later-customer-source")
        self.review(original)
        con = self.engine.get_conversation("a1", "c1")
        self.assertEqual(con["latest_event_id"], "id_c1.a1.later-customer-source")
        self.assertFalse(con["correction_reply"]["eligible"])
        with self.assertRaises(NotEligible):
            self.prepare_correction(original)

    def test_missing_strict_history_cannot_become_correction_authorization(self):
        original = self.sent(native_server_history={"status": "unknown"})
        with self.assertRaises((ValueError, NotEligible, InvalidTransition)):
            self.review(original)
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 0)

    def test_correction_is_one_text_only_and_old_unknown_never_cleared(self):
        original = self.sent()
        pending = self.engine.prepare_intent("a1", "c1", "card", {"operation": "native_card"})
        self.engine.claim_intent(pending["intent_id"], "original-worker", self.gate())
        self.engine.begin_submit(pending["intent_id"], "original-worker", self.gate())
        self.engine.confirm(pending["intent_id"], "original-worker", "unknown")
        self.review(original)
        with self.assertRaises(NotEligible):
            self.prepare_correction(original)
        self.assertEqual(self.engine.list_outbox()[-1]["status"], "UNKNOWN")
        self.now += .1
        self.engine.reconcile(pending["intent_id"], "not_sent", self.evidence(intent_id=pending["intent_id"], verified_not_sent=True))
        for change in ({"operation": "native_card"}, {"correction_of_intent_id": "wrong"}, {"source_message_text": "wrong"}):
            with self.subTest(change=change), self.assertRaises(NotEligible):
                self.prepare_correction(original, **change)
        with self.assertRaises(NotEligible):
            self.engine.prepare_intent("a1", "c1", "reply", {"operation": "text", "text": "generic bypass"})
        correction = self.prepare_correction(original)
        self.engine.claim_intent(correction["intent_id"], "corrector", self.gate())
        self.engine.begin_submit(correction["intent_id"], "corrector", self.gate())
        self.now += .1
        self.engine.confirm(correction["intent_id"], "corrector", "sent", self.evidence(intent_id=correction["intent_id"]))
        self.review(original)
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 0)
        with self.assertRaises(NotEligible):
            self.prepare_correction(original)

    def test_correction_rechecks_native_source_and_controls_at_prepare_claim_submit(self):
        original = self.sent()
        self.review(original)
        correction = self.prepare_correction(original)
        old_gate = self.gate()
        self.now += .1
        self.engine.ingest_event(Event("a1", "c1", "human-control", "HUMAN_TAKEOVER", evidence=self.evidence()))
        self.now += .1
        self.engine.ingest_event(Event("a1", "c1", "human-release", "HUMAN_RELEASE", evidence=self.evidence(explicit_release=True)))
        with self.assertRaises((GateClosed, NotEligible, InvalidTransition)):
            self.engine.claim_intent(correction["intent_id"], "corrector", old_gate)
        # Takeover cancelled the never-submitted intent; fresh preparation is safe.
        correction = self.prepare_correction(original)
        with self.assertRaises(GateClosed):
            self.engine.claim_intent(correction["intent_id"], "corrector", old_gate)
        self.engine.claim_intent(correction["intent_id"], "corrector", self.gate())
        self.now += .1
        self.question("id_c1.a1.new-question-before-submit")
        with self.assertRaises((NotEligible, InvalidTransition)):
            self.engine.begin_submit(correction["intent_id"], "corrector", self.gate())

    def test_late_old_native_operator_does_not_revoke_released_quality_correction(self):
        original = self.sent()
        self.review(original)
        released_at = self.now
        self.engine.ingest_event(Event("a1", "c1", "direct-human-return", "HUMAN_RELEASE",
            evidence=self.evidence(explicit_release=True, authorization_source="direct_human_instruction",
                                   authorization_reference="real-human-full-automatic-instruction")))
        correction = self.prepare_correction(original)
        old_gate = self.gate()
        self.now += 1
        native = "jarvis-msg-c1.a1.old-external"
        proof = self.evidence(timestamp_source="platform_ui", native_message_id=native,
                              ownership_reason="native_non_ai_outbound_from_other_operator")
        proof["reference"] = "id_c1.a1.old-external"
        self.engine.ingest_event(Event("a1", "c1", "external-operator:" + native, "HUMAN_TAKEOVER",
                                      timestamp=released_at - 1800, evidence=proof))
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")
        with self.assertRaises(GateClosed):
            self.engine.claim_intent(correction["intent_id"], "corrector", old_gate)
        self.engine.claim_intent(correction["intent_id"], "corrector", self.gate())
        self.now += 1
        proof["observed_at"] = self.now
        proof["native_message_id"] = "jarvis-msg-c1.a1.new-external"
        proof["reference"] = "id_c1.a1.new-external"
        self.engine.ingest_event(Event("a1", "c1", "external-operator:" + proof["native_message_id"],
                                      "HUMAN_TAKEOVER", timestamp=self.now, evidence=proof))
        with self.assertRaises((NotEligible, InvalidTransition)):
            self.engine.begin_submit(correction["intent_id"], "corrector", self.gate())

    def test_refusal_and_historical_native_source_never_gain_correction_permission(self):
        original = self.sent()
        self.review(original)
        self.now += .1
        self.engine.ingest_event(Event("a1", "c1", "customer-refusal", "REFUSED", evidence=self.evidence()))
        with self.assertRaises(NotEligible):
            self.prepare_correction(original)
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "STOPPED")
        other = Engine(os.path.join(self.temp.name, "historical-quality.sqlite3"), clock=lambda: self.now)
        current = self.engine
        self.engine = other
        try:
            self.engine.ingest_event(Event("a1", "c1", "prior-unanswered", "CUSTOMER_MESSAGE", timestamp=self.now))
            self.now += .1
            self.question(historical_baseline=True)
            original = self.sent()
            with self.assertRaises((ValueError, NotEligible, InvalidTransition)):
                self.review(original)
        finally:
            self.engine.close()
            self.engine = current

    def test_quality_rpc_is_explicit_account_bound_and_rejects_untrusted_extra_fields(self):
        original = self.sent()
        review = dict(source="independent_audit", reviewer="red-team-fixture", classification="not_useful",
                      reason_code="question_not_answered", reference="independent-review", observed_at=self.now,
                      account_id="a1", conversation_id="c1", intent_id=original["intent_id"], source_event_id=self.source)
        params = dict(account_id="a1", conversation_id="c1", intent_id=original["intent_id"], source_event_id=self.source, review=review)
        request = {"id": 1, "method": "review_reply_quality", "params": params}
        self.assertEqual(EngineRPC(self.engine).handle(request)["error"]["code"], "account_binding_required")
        bound = EngineRPC(self.engine, account_id="a1")
        self.assertEqual(bound.handle({**request, "params": {**params, "account_id": "a2"}})["error"]["code"], "account_scope_mismatch")
        self.assertEqual(bound.handle({**request, "params": {**params, "bypass": True}})["error"]["code"], "invalid_params")
        self.assertTrue(bound.handle(request)["ok"])

    def unknown_card(self):
        row = self.engine.prepare_intent("a1", "c1", "card", {"operation": "native_card"})
        self.engine.claim_intent(row["intent_id"], "original-worker", self.gate())
        self.engine.begin_submit(row["intent_id"], "original-worker", self.gate())
        return self.engine.confirm(row["intent_id"], "original-worker", "unknown", self.evidence(
            intent_id=row["intent_id"], native_message_raw_id="original-unknown-card",
            native_message_id="jarvis-msg-a1.c1.original-unknown-card"))

    def test_reviewed_correction_binds_prior_card_unknown_without_changing_or_repeating_it(self):
        original = self.sent()
        unknown = self.unknown_card()
        self.review(original)
        capability = self.engine.get_conversation("a1", "c1")["correction_reply"]
        self.assertTrue(capability["eligible"])
        self.assertEqual(capability["prior_unknown_hold_ids"], [unknown["intent_id"]])
        for ids in ([], ["wrong"], [unknown["intent_id"], unknown["intent_id"]]):
            with self.subTest(ids=ids), self.assertRaises(NotEligible):
                self.prepare_correction(original, prior_unknown_hold_ids=ids)
        with self.assertRaises(NotEligible):
            self.prepare_correction(original, prior_unknown_hold_ids=[unknown["intent_id"]], text=original["payload"]["text"])
        with self.assertRaises(NotEligible):
            self.engine.prepare_intent("a1", "c1", "reply", {"operation": "text", "text": "normal still blocked"})
        correction = self.prepare_correction(original, prior_unknown_hold_ids=[unknown["intent_id"]])
        with Engine(os.path.join(self.temp.name, "quality.sqlite3"), clock=lambda: self.now) as other:
            with self.assertRaises(NotEligible):
                other.prepare_intent("a1", "c1", "correction_reply", correction["payload"], source_event_id=self.source)
        self.engine.claim_intent(correction["intent_id"], "corrector", self.gate())
        self.engine.begin_submit(correction["intent_id"], "corrector", self.gate())
        self.now += .1
        self.engine.confirm(correction["intent_id"], "corrector", "sent", self.evidence(intent_id=correction["intent_id"]))
        self.assertEqual(next(row for row in self.engine.list_outbox() if row["intent_id"] == unknown["intent_id"]), unknown)
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 0)
        self.review(original)
        with self.assertRaises(NotEligible):
            self.prepare_correction(original, prior_unknown_hold_ids=[unknown["intent_id"]])

    def test_prior_unknown_set_change_between_claim_and_submit_closes_special_gate(self):
        original = self.sent()
        unknown = self.unknown_card()
        self.review(original)
        correction = self.prepare_correction(original, prior_unknown_hold_ids=[unknown["intent_id"]])
        self.engine.claim_intent(correction["intent_id"], "corrector", self.gate())
        self.now += .1
        self.engine.reconcile(unknown["intent_id"], "not_sent", self.evidence(intent_id=unknown["intent_id"], verified_not_sent=True))
        with self.assertRaises(NotEligible):
            self.engine.begin_submit(correction["intent_id"], "corrector", self.gate())

    def test_service_can_answer_only_a_question_after_prior_card_submission_and_retains_unknown(self):
        original = self.sent()
        unknown = self.unknown_card()
        self.now += .1
        self.engine.ingest_event(Event("a1", "c1", "lead-added", "WECHAT_VERIFIED", evidence=self.evidence(verified=True)))
        self.now += .1
        new_source = "id_c1.a1.independent-new-service-question"
        self.question(new_source)
        payload = dict(operation="text", text="请提供货品和预计货量。", text_only_service=True,
                       source_message_text="日本的有吗", prior_unknown_hold_ids=[unknown["intent_id"]])
        capability = self.engine.get_conversation("a1", "c1")["service_reply"]
        self.assertTrue(capability["eligible"])
        service = self.engine.prepare_intent("a1", "c1", "service_reply", payload, source_event_id=new_source)
        self.engine.claim_intent(service["intent_id"], "service-worker", self.gate())
        self.engine.begin_submit(service["intent_id"], "service-worker", self.gate())
        self.now += .1
        self.engine.confirm(service["intent_id"], "service-worker", "unknown", self.evidence(intent_id=service["intent_id"]))
        self.assertEqual(next(row for row in self.engine.list_outbox() if row["intent_id"] == unknown["intent_id"]), unknown)
        with self.assertRaises(NotEligible):
            self.engine.prepare_intent("a1", "c1", "service_reply", payload, source_event_id=new_source)
        # A late original-card receipt belongs to its old source and cannot clear this new question.
        self.engine.reconcile(unknown["intent_id"], "sent", self.evidence(intent_id=unknown["intent_id"]))
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 1)

    def test_new_service_source_during_card_submit_is_not_an_independent_later_question(self):
        original = self.sent()
        self.engine.ingest_event(Event("a1", "c1", "lead-added", "WECHAT_VERIFIED", evidence=self.evidence(verified=True)))
        # Restore the independent setup in another database: prepare a card before lead terminal stop.
        other = Engine(os.path.join(self.temp.name, "during-submit.sqlite3"), clock=lambda: self.now)
        current = self.engine
        self.engine = other
        try:
            self.question()
            self.sent()
            unknown = self.unknown_card()
            self.engine.ingest_event(Event("a1", "c1", "lead-added", "WECHAT_VERIFIED", evidence=self.evidence(verified=True)))
            # Observed later, but its original platform clock is exactly the prior card submission.
            proof = self.evidence(timestamp_source="platform_ui", native_message_id="jarvis-msg-c1.a1.during-card",
                native_message_type="TEXT", native_direction="left", historical_baseline=False, untrusted_message_text="日本的有吗")
            proof["reference"] = "id_c1.a1.during-card"
            self.now += .2
            proof["observed_at"] = self.now
            self.engine.ingest_event(Event("a1", "c1", "id_c1.a1.during-card", "CUSTOMER_MESSAGE",
                timestamp=unknown["submitted_at"], evidence=proof))
            self.assertFalse(self.engine.get_conversation("a1", "c1")["service_reply"]["eligible"])
        finally:
            self.engine.close()
            self.engine = current

    def test_existing_unknown_index_migrates_atomically_and_keeps_active_submission_unique(self):
        original = self.sent()
        unknown = self.unknown_card()
        self.engine.db.execute("DROP INDEX one_unsettled_per_conversation")
        self.engine.db.execute("CREATE UNIQUE INDEX one_unsettled_per_conversation ON outbox(account_id,conversation_id) "
                               "WHERE status IN ('PREPARED','CLAIMED','SUBMITTING','UNKNOWN')")
        before = copy.deepcopy(self.engine.list_outbox())
        with Engine(os.path.join(self.temp.name, "quality.sqlite3"), clock=lambda: self.now) as other:
            self.assertEqual(other.list_outbox(), before)
            sql = other.db.execute("SELECT sql FROM sqlite_master WHERE name='one_unsettled_per_conversation'").fetchone()[0]
            self.assertNotIn("UNKNOWN", sql)
            self.review(original)
            correction = self.prepare_correction(original, prior_unknown_hold_ids=[unknown["intent_id"]])
            with self.assertRaises(sqlite3.IntegrityError):
                other.db.execute("UPDATE outbox SET status='PREPARED' WHERE intent_id=?", (unknown["intent_id"],))
            self.assertEqual(next(row for row in other.list_outbox() if row["intent_id"] == unknown["intent_id"]), unknown)
            self.assertEqual(next(row for row in other.list_outbox() if row["intent_id"] == correction["intent_id"])["status"], "PREPARED")

    def test_active_customer_question_is_one_text_service_without_card_or_followup(self):
        self.sent()
        self.now += .2
        self.source = "id_c1.a1.later-independent-customer-question"
        self.question()
        capability = self.engine.get_conversation("a1", "c1")["service_reply"]
        self.assertTrue(capability["eligible"])
        payload = dict(operation="text", text="日本方向能否承接，需要核实资源。请提供货品和货量，需要一件代发吗？",
                       text_only_service=True, source_message_text="日本的有吗")
        service = self.engine.prepare_intent("a1", "c1", "service_reply", payload, source_event_id=self.source)
        self.engine.claim_intent(service["intent_id"], "service-worker", self.gate())
        self.engine.begin_submit(service["intent_id"], "service-worker", self.gate())
        self.now += .1
        self.engine.confirm(service["intent_id"], "service-worker", "sent", self.evidence(intent_id=service["intent_id"]))
        con = self.engine.get_conversation("a1", "c1")
        self.assertEqual((con["state"], con["needs_response"], con["next_followup_at"]), ("ACTIVE", 0, None))
        self.assertEqual(self.engine.due_conversations(), [])
        with self.assertRaises(NotEligible):
            self.engine.prepare_intent("a1", "c1", "service_reply", payload, source_event_id=self.source)
        self.assertEqual(len([row for row in self.engine.list_outbox() if row["kind"] == "service_reply"]), 1)

    def test_active_service_question_after_prior_card_submit_binds_only_that_old_hold(self):
        self.sent()
        unknown = self.unknown_card()
        self.now += .2
        source = "id_c1.a1.independent-active-price-question"
        self.question(source, untrusted_message_text="这个费用怎么算")
        capability = self.engine.get_conversation("a1", "c1")["service_reply"]
        self.assertTrue(capability["eligible"])
        self.assertEqual(capability["prior_unknown_hold_ids"], [unknown["intent_id"]])
        payload = dict(operation="text", text="核价需要目的仓、货品、件量和尺寸重量。", text_only_service=True,
                       source_message_text="这个费用怎么算", prior_unknown_hold_ids=[unknown["intent_id"]])
        service = self.engine.prepare_intent("a1", "c1", "service_reply", payload, source_event_id=source)
        self.assertEqual(service["kind"], "service_reply")
        self.assertEqual(next(row for row in self.engine.list_outbox() if row["intent_id"] == unknown["intent_id"]), unknown)

    def test_platform_entry_keeps_initial_reception_and_cannot_become_text_service(self):
        self.now += .1
        source = "id_c1.a1.new-platform-entry"
        proof = self.evidence(timestamp_source="platform_ui", native_message_id="jarvis-msg-c1.a1.new-platform-entry",
                              native_message_type="RICH_HINT", native_direction="center", historical_baseline=False)
        proof["reference"] = source
        self.engine.ingest_event(Event("a1", "c1", source, "NEW_VISITOR", timestamp=self.now, evidence=proof))
        self.assertFalse(self.engine.get_conversation("a1", "c1")["service_reply"]["eligible"])
        with self.assertRaises(NotEligible):
            self.engine.prepare_intent("a1", "c1", "service_reply", dict(operation="text", text="hello",
                text_only_service=True, source_message_text="not a customer utterance"), source_event_id=source)
        self.assertEqual(self.engine.prepare_intent("a1", "c1", "initial", {"operation": "text", "text": "初接信息"})["kind"], "initial")

    def test_active_service_cannot_submit_after_refusal_human_or_platform_limit(self):
        for control in ("REFUSED", "HUMAN_TAKEOVER", "PLATFORM_LIMIT"):
            with self.subTest(control=control):
                other = Engine(os.path.join(self.temp.name, "active-" + control + ".sqlite3"), clock=lambda: self.now)
                current = self.engine
                self.engine = other
                try:
                    self.question()
                    self.sent()
                    self.now += .2
                    source = "id_c1.a1.later-question-before-control"
                    self.question(source)
                    payload = dict(operation="text", text="请提供货品和货量。", text_only_service=True, source_message_text="日本的有吗")
                    service = self.engine.prepare_intent("a1", "c1", "service_reply", payload, source_event_id=source)
                    self.engine.claim_intent(service["intent_id"], "service-worker", self.gate())
                    self.now += .1
                    self.engine.ingest_event(Event("a1", "c1", "late-control", control, evidence=self.evidence()))
                    with self.assertRaises((NotEligible, InvalidTransition)):
                        self.engine.begin_submit(service["intent_id"], "service-worker", self.gate())
                    self.assertIsNone(next(row for row in self.engine.list_outbox() if row["intent_id"] == service["intent_id"])["submitted_at"])
                finally:
                    self.engine.close()
                    self.engine = current

    def test_first_customer_opening_keeps_normal_text_card_round(self):
        self.assertFalse(self.engine.get_conversation("a1", "c1")["service_reply"]["eligible"])
        reply = self.engine.prepare_intent("a1", "c1", "reply", {"operation": "text", "text": "请提供目的仓、货品与尺寸重量。"})
        self.assertEqual(reply["source_event_id"], self.source)

    def test_active_service_requires_prior_strict_text_not_an_unknown_or_same_source_receipt(self):
        original = self.sent()
        self.assertFalse(self.engine.get_conversation("a1", "c1")["service_reply"]["eligible"])
        # A new native question does not turn a non-strict prior receipt into a verified reception round.
        other = Engine(os.path.join(self.temp.name, "non-strict-prior.sqlite3"), clock=lambda: self.now)
        current = self.engine
        self.engine = other
        try:
            self.question()
            self.sent(native_server_history={"status": "unknown"})
            self.now += .2
            self.question("id_c1.a1.new-after-unverified-receipt")
            self.assertFalse(self.engine.get_conversation("a1", "c1")["service_reply"]["eligible"])
        finally:
            self.engine.close()
            self.engine = current


if __name__ == "__main__":
    unittest.main()
