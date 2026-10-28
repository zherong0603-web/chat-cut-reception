import os
import tempfile
import unittest

from xhs_reception import DispatchGate, Engine, Event, GateClosed, InvalidTransition, NotEligible


class Clock:
    def __init__(self):
        self.value = 100000.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temp.name, "state.sqlite3")
        self.clock = Clock()
        self.engine = Engine(self.path, clock=self.clock)

    def tearDown(self):
        self.engine.close()
        self.temp.cleanup()

    def incoming(self, event_id="event-1", kind="CUSTOMER_MESSAGE", conversation="c1", timestamp="now", evidence=None):
        if timestamp == "now":
            timestamp = self.clock()
        if evidence is None and kind in ("PLATFORM_LIMIT", "REFUSED", "HUMAN_TAKEOVER", "HUMAN_RELEASE"):
            evidence = self.evidence(conversation_id=conversation)
        evidence = dict(evidence or {})
        if timestamp is not None:
            evidence.setdefault("timestamp_source", "platform_ui")
        return self.engine.ingest_event(Event("a1", conversation, event_id, kind,
                                             timestamp=timestamp, evidence=evidence or {}))

    def gate(self, **changes):
        data = dict(enabled=True, browser_connected=True, authenticated=True,
                    account_id="a1", conversation_id="c1", browser_session_id="session-1",
                    observed_at=self.clock())
        data.update(changes)
        return DispatchGate(**data)

    def evidence(self, **changes):
        data = dict(source="platform_ui", reference="observed-conversation-state",
                    observed_at=self.clock(), account_id="a1", conversation_id="c1")
        if hasattr(self, "current_intent"):
            data["intent_id"] = self.current_intent
        data.update(changes)
        return data

    def prepare(self, kind="reply"):
        return self.engine.prepare_intent("a1", "c1", kind, {"operation": "text", "value": "unit-test-fixture"})

    def submitting(self, kind="reply"):
        intent = self.prepare(kind)
        self.current_intent = intent["intent_id"]
        self.engine.claim_intent(intent["intent_id"], "worker-1", self.gate())
        return self.engine.begin_submit(intent["intent_id"], "worker-1", self.gate())

    def sent(self, kind="reply", **evidence):
        intent = self.submitting(kind)
        self.clock.advance(.5)
        return self.engine.confirm(intent["intent_id"], "worker-1", "sent", self.evidence(**evidence))

    def test_default_gate_closed_even_with_prepared_intent(self):
        self.incoming()
        intent = self.prepare()
        with self.assertRaises(GateClosed):
            self.engine.claim_intent(intent["intent_id"], "worker-1")
        self.assertEqual(self.engine.list_outbox()[0]["status"], "PREPARED")

    def test_gate_requires_exact_account_conversation_live_session_and_freshness(self):
        self.incoming()
        intent = self.prepare()
        for gate in (self.gate(account_id="other"), self.gate(conversation_id="other"),
                     self.gate(browser_connected=False), self.gate(authenticated=False),
                     self.gate(browser_session_id=None), self.gate(observed_at=self.clock() - 11)):
            with self.subTest(gate=gate), self.assertRaises(GateClosed):
                self.engine.claim_intent(intent["intent_id"], "worker-1", gate)

    def test_gate_rechecked_immediately_before_submission(self):
        self.incoming()
        intent = self.prepare()
        self.engine.claim_intent(intent["intent_id"], "worker-1", self.gate())
        with self.assertRaises(GateClosed):
            self.engine.begin_submit(intent["intent_id"], "worker-1", self.gate(authenticated=False))
        with self.assertRaises(GateClosed):
            self.engine.begin_submit(intent["intent_id"], "worker-1", self.gate(browser_session_id="other-session"))
        with self.assertRaises(InvalidTransition):
            self.engine.begin_submit(intent["intent_id"], "worker-2", self.gate())

    def test_explicit_expiry_is_scoped_idempotent_and_audited_without_reader_mutation(self):
        self.incoming()
        first = self.prepare()
        self.incoming("other-event", conversation="c2")
        other = self.engine.prepare_intent("a1", "c2", "reply", {"operation": "text"})
        self.clock.advance(10)
        self.assertEqual(self.engine.list_outbox()[0]["status"], "PREPARED")
        result = self.engine.expire_unsubmitted("a1", "c1")
        self.assertEqual(result, {"account_id": "a1", "conversation_id": "c1",
                                  "expired_intent_ids": [first["intent_id"]]})
        rows = {row["intent_id"]: row for row in self.engine.list_outbox()}
        self.assertEqual(rows[first["intent_id"]]["status"], "EXPIRED")
        self.assertEqual(rows[other["intent_id"]]["status"], "PREPARED")
        self.assertIsNone(rows[first["intent_id"]]["submitted_at"])
        self.assertEqual(self.engine.expire_unsubmitted("a1", "c1")["expired_intent_ids"], [])
        expired_audits = [row for row in self.engine.audit() if row["action"] == "INTENT_EXPIRED_UNSUBMITTED"]
        self.assertEqual([row["detail"]["intent_id"] for row in expired_audits], [first["intent_id"]])
        self.assertEqual(self.prepare()["status"], "PREPARED")

    def test_expiry_preserves_live_claim_and_submit_wins_before_expiry(self):
        self.incoming()
        intent = self.prepare()
        self.engine.claim_intent(intent["intent_id"], "worker-1", self.gate())
        self.clock.advance(5)
        with Engine(self.path, clock=self.clock) as second:
            self.assertEqual(second.expire_unsubmitted("a1", "c1")["expired_intent_ids"], [])
            self.assertEqual(second.list_outbox()[0]["status"], "CLAIMED")
            self.engine.begin_submit(intent["intent_id"], "worker-1", self.gate())
            self.clock.advance(100)
            self.assertEqual(second.expire_unsubmitted("a1", "c1")["expired_intent_ids"], [])
            self.assertEqual(second.list_outbox()[0]["status"], "SUBMITTING")
            self.engine.confirm(intent["intent_id"], "worker-1", "unknown")
            self.clock.advance(86400)
            self.assertEqual(second.expire_unsubmitted("a1", "c1")["expired_intent_ids"], [])
            self.assertEqual(second.list_outbox()[0]["status"], "UNKNOWN")
            with self.assertRaises(NotEligible):
                second.prepare_intent("a1", "c1", "reply", {"operation": "text"})
            with self.assertRaises(InvalidTransition):
                second.claim_intent(intent["intent_id"], "worker-2", self.gate())

    def test_expiry_wins_before_begin_submit_and_cannot_reopen_original_intent(self):
        self.incoming()
        intent = self.prepare()
        self.engine.claim_intent(intent["intent_id"], "worker-1", self.gate())
        self.clock.advance(10)
        with Engine(self.path, clock=self.clock) as second:
            self.assertEqual(second.expire_unsubmitted("a1", "c1")["expired_intent_ids"], [intent["intent_id"]])
        with self.assertRaises(InvalidTransition):
            self.engine.begin_submit(intent["intent_id"], "worker-1", self.gate())
        self.assertEqual(self.engine.list_outbox()[0]["status"], "EXPIRED")

    def test_event_is_idempotent_and_account_scoped(self):
        self.incoming()
        self.assertTrue(self.incoming()["duplicate"])
        self.assertEqual(len(self.engine.audit()), 1)
        with self.assertRaises(ValueError):
            self.incoming(conversation="wrong-conversation")
        self.engine.ingest_event(Event("a2", "c1", "event-1", "CUSTOMER_MESSAGE"))
        self.assertEqual(len(self.engine.list_conversations()), 2)

    def test_one_unsettled_intent_per_conversation_across_connections(self):
        self.incoming()
        self.prepare()
        with Engine(self.path, clock=self.clock) as second:
            with self.assertRaises(NotEligible):
                second.prepare_intent("a1", "c1", "card", {"operation": "card"})

    def test_only_same_owner_can_submit_and_confirm(self):
        self.incoming()
        intent = self.submitting()
        with self.assertRaises(InvalidTransition):
            self.engine.confirm(intent["intent_id"], "other", "sent", self.evidence())
        self.engine.confirm(intent["intent_id"], "worker-1", "unknown")
        with self.assertRaises(InvalidTransition):
            self.engine.begin_submit(intent["intent_id"], "worker-1", self.gate())

    def test_second_reader_does_not_mutate_submitting_and_restart_cannot_dispatch(self):
        self.incoming()
        intent = self.submitting()
        with Engine(self.path, clock=self.clock) as reader:
            self.assertEqual(reader.list_outbox()[0]["status"], "SUBMITTING")
            with self.assertRaises(InvalidTransition):
                reader.claim_intent(intent["intent_id"], "worker-2", self.gate())
        self.engine.close()
        self.engine = Engine(self.path, clock=self.clock)
        self.assertEqual(self.engine.list_outbox()[0]["status"], "SUBMITTING")
        self.clock.advance(86400)
        with self.assertRaises(InvalidTransition):
            self.engine.claim_intent(intent["intent_id"], "worker-2", self.gate())
        self.assertEqual(self.engine.recover_inflight(exclusive_worker_owner="worker-new"), [intent["intent_id"]])
        self.assertEqual(self.engine.list_outbox()[0]["status"], "UNKNOWN")

    def test_unknown_send_blocks_all_new_work_even_after_inbound_and_reboot(self):
        self.incoming()
        intent = self.submitting()
        self.engine.confirm(intent["intent_id"], "worker-1", "unknown")
        self.clock.advance(2)
        self.incoming("event-2")
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")
        self.assertEqual(self.engine.due_conversations(), [])
        with self.assertRaises(NotEligible):
            self.prepare()
        with self.assertRaises(ValueError):
            self.engine.reconcile(intent["intent_id"], "not_sent", self.evidence())
        self.engine.reconcile(intent["intent_id"], "not_sent", self.evidence(verified_not_sent=True))
        self.assertEqual(len(self.engine.due_conversations()), 1)
        self.prepare()

    def test_unknown_can_be_verified_sent_without_retry(self):
        self.incoming()
        intent = self.submitting()
        self.engine.confirm(intent["intent_id"], "worker-1", "unknown")
        self.clock.advance(100)
        self.engine.reconcile(intent["intent_id"], "sent", self.evidence())
        self.assertEqual(self.engine.list_outbox()[0]["status"], "SENT")
        with self.assertRaises(NotEligible):
            self.prepare()

    def test_limit_pauses_not_stops_and_time_restart_new_message_do_not_unlock(self):
        self.incoming()
        intent = self.submitting()
        self.engine.confirm(intent["intent_id"], "worker-1", "limit", self.evidence())
        self.clock.advance(172800)
        self.incoming("event-2")
        with Engine(self.path, clock=self.clock) as restarted:
            self.assertEqual(restarted.get_conversation("a1", "c1")["state"], "PAUSED_LIMIT")
            self.assertEqual(restarted.due_conversations(), [])
            with self.assertRaises(NotEligible):
                restarted.prepare_intent("a1", "c1", "reply", {"operation": "text"})

    def test_resume_requires_positive_fresh_evidence_newer_than_limit(self):
        self.incoming()
        self.incoming("limit", "PLATFORM_LIMIT")
        blocked = self.clock()
        self.clock.advance(20)
        invalid = [self.evidence(allowed=False), self.evidence(allowed=True, observed_at=blocked),
                   self.evidence(allowed=True, observed_at=self.clock() - 11),
                   self.evidence(allowed=True, probe_send=True),
                   dict(allowed=True, observed_at=self.clock())]
        for index, evidence in enumerate(invalid):
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.incoming("bad-" + str(index), "SEND_ELIGIBLE", evidence=evidence)
        self.incoming("allowed", "SEND_ELIGIBLE", evidence=self.evidence(allowed=True))
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")
        self.assertEqual(self.engine.due_conversations()[0]["due_kind"], "response")
        self.prepare()

    def test_resume_after_first_block_preserves_unanswered_event_and_original_clock(self):
        self.incoming()
        intent = self.submitting()
        self.engine.confirm(intent["intent_id"], "worker-1", "limit", self.evidence())
        self.clock.advance(86400)
        self.incoming("allowed", "SEND_ELIGIBLE", evidence=self.evidence(allowed=True))
        self.assertEqual(self.engine.get_conversation("a1", "c1")["latest_event_id"], "event-1")
        self.sent()
        self.assertGreater(self.engine.metrics()["p95_platform_to_confirm_seconds"], 86400)

    def test_resume_reassesses_one_current_followup_without_backlog(self):
        self.incoming()
        self.sent()
        self.incoming("limit", "PLATFORM_LIMIT")
        self.clock.advance(86400)
        self.incoming("allowed", "SEND_ELIGIBLE", evidence=self.evidence(allowed=True))
        self.assertEqual(len(self.engine.due_conversations()), 1)
        self.sent("followup")
        self.assertEqual(self.engine.due_conversations(), [])
        self.assertEqual(len(self.engine.list_outbox()), 2)

    def test_minimum_followup_interval_survives_restart_and_applies_to_each_send(self):
        self.incoming()
        self.sent()
        self.clock.advance(1799)
        with self.assertRaises(NotEligible):
            self.prepare("followup")
        self.clock.advance(1)
        self.sent("followup")
        self.clock.advance(1799)
        with self.assertRaises(NotEligible):
            self.prepare("followup")
        with self.assertRaises(ValueError):
            Engine(":memory:", min_followup_interval=1799)

    def test_new_inbound_cancels_unsent_draft_and_stale_claim(self):
        self.incoming()
        intent = self.prepare()
        self.engine.claim_intent(intent["intent_id"], "worker-1", self.gate())
        self.clock.advance(.1)
        self.incoming("event-2")
        self.assertEqual(self.engine.list_outbox()[0]["status"], "CANCELLED")
        with self.assertRaises(InvalidTransition):
            self.engine.begin_submit(intent["intent_id"], "worker-1", self.gate())
        new = self.prepare()
        self.assertEqual(new["source_event_id"], "event-2")

    def test_platform_time_is_latency_source_not_an_abandon_deadline(self):
        self.incoming(timestamp=self.clock() - 3600)
        self.assertEqual(len(self.engine.due_conversations()), 1)
        self.sent()
        self.assertGreater(self.engine.metrics()["p95_platform_to_confirm_seconds"], 3600)

    def test_companion_card_and_text_are_individually_confirmed_and_not_repeated(self):
        self.incoming()
        self.sent()
        self.sent("card")
        with self.assertRaises(NotEligible):
            self.prepare("card")
        with self.assertRaises(NotEligible):
            self.prepare("followup")
        self.assertEqual(len(self.engine.list_outbox()), 2)

    def test_card_may_precede_text_but_late_companion_card_does_not_bypass_interval(self):
        self.incoming()
        self.sent("card")
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 1)
        self.sent()
        self.clock.advance(31)
        self.incoming("event-2")
        self.sent()
        self.clock.advance(31)
        with self.assertRaises(NotEligible):
            self.prepare("card")

    def test_human_ownership_latches_until_explicit_release_and_preserves_limit(self):
        self.incoming()
        self.incoming("human", "HUMAN_TAKEOVER")
        self.incoming("limit", "PLATFORM_LIMIT")
        self.clock.advance(1)
        self.incoming("new-message")
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "HUMAN")
        with self.assertRaises(ValueError):
            self.incoming("bad-release", "HUMAN_RELEASE")
        self.incoming("release", "HUMAN_RELEASE", evidence=self.evidence(explicit_release=True))
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "PAUSED_LIMIT")
        with self.assertRaises(NotEligible):
            self.prepare()

    def test_terminal_outcomes_cannot_be_overridden_by_events_or_late_send_confirmation(self):
        for event_type in ("WECHAT_VERIFIED", "LEAD_VERIFIED", "REFUSED"):
            with self.subTest(event_type=event_type):
                conv = "c-" + event_type
                self.incoming("in-" + event_type, conversation=conv)
                ev = self.evidence(verified=True, conversation_id=conv) if event_type != "REFUSED" else self.evidence(conversation_id=conv)
                self.incoming("stop-" + event_type, event_type, conversation=conv, evidence=ev)
                self.incoming("later-" + event_type, conversation=conv)
                self.assertEqual(self.engine.get_conversation("a1", conv)["state"], "STOPPED")
        self.incoming()
        intent = self.submitting()
        self.incoming("refused", "REFUSED")
        self.engine.confirm(intent["intent_id"], "worker-1", "sent", self.evidence())
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "STOPPED")
        self.assertEqual(self.engine.due_conversations(), [])

    def test_lead_outcomes_require_verified_evidence(self):
        self.incoming()
        with self.assertRaises(ValueError):
            self.incoming("unverified-lead", "LEAD_VERIFIED", evidence={"verified": True})
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")

    def test_send_confirmation_requires_observed_evidence_and_cannot_precede_submission(self):
        self.incoming()
        intent = self.submitting()
        for evidence in ({}, self.evidence(observed_at=self.clock() - 1)):
            with self.assertRaises(ValueError):
                self.engine.confirm(intent["intent_id"], "worker-1", "sent", evidence)
        self.assertEqual(self.engine.list_outbox()[0]["status"], "SUBMITTING")

    def test_metrics_keep_failures_unknowns_and_unanswered_in_denominator(self):
        self.incoming()
        self.sent(usefulness_verified=True, useful=True)
        self.incoming("unanswered", conversation="c2")
        self.incoming("unknown", conversation="c3", timestamp=None)
        intent = self.engine.prepare_intent("a1", "c3", "reply", {"operation": "text"})
        gate = self.gate(conversation_id="c3")
        self.engine.claim_intent(intent["intent_id"], "worker-1", gate)
        self.engine.begin_submit(intent["intent_id"], "worker-1", gate)
        self.engine.confirm(intent["intent_id"], "worker-1", "unknown")
        metrics = self.engine.metrics()
        self.assertEqual(metrics["recorded_inbound_events"], 3)
        self.assertEqual(metrics["confirmed_response_samples"], 1)
        self.assertEqual(metrics["unanswered_events"], 2)
        self.assertEqual(metrics["unknown_result_events"], 1)
        self.assertEqual(metrics["platform_timestamp_unknown_samples"], 1)
        self.assertIsNone(metrics["within_5_seconds_rate"])
        self.assertEqual(metrics["target_assessment"], "unverified")

    def test_metrics_do_not_treat_confirmed_but_unreviewed_reply_as_useful(self):
        self.incoming()
        self.sent()
        metrics = self.engine.metrics()
        self.assertEqual(metrics["verified_useful_within_5_seconds"], 0)
        self.assertIsNone(metrics["within_5_seconds_rate"])

    def test_expired_prepared_payload_can_be_replaced_but_never_submitted(self):
        self.incoming()
        old = self.prepare()
        self.clock.advance(11)
        with self.assertRaises(NotEligible):
            self.engine.claim_intent(old["intent_id"], "worker-1", self.gate())
        fresh = self.prepare()
        self.assertNotEqual(fresh["intent_id"], old["intent_id"])
        self.assertEqual(self.engine.list_outbox()[0]["status"], "EXPIRED")

    def test_wrong_scope_evidence_cannot_restore_stop_or_confirm_another_conversation(self):
        self.incoming()
        intent = self.submitting()
        for evidence in (self.evidence(account_id="wrong-account"),
                         self.evidence(conversation_id="wrong-conversation"),
                         self.evidence(intent_id="wrong-intent")):
            with self.subTest(evidence=evidence), self.assertRaises(ValueError):
                self.engine.confirm(intent["intent_id"], "worker-1", "sent", evidence)
        self.engine.confirm(intent["intent_id"], "worker-1", "limit", self.evidence())
        self.clock.advance(1)
        for field in ("account_id", "conversation_id"):
            wrong = self.evidence(allowed=True, verified=True, **{field: "wrong"})
            with self.assertRaises(ValueError):
                self.incoming("wrong-allowed-" + field, "SEND_ELIGIBLE", evidence=wrong)
            with self.assertRaises(ValueError):
                self.incoming("wrong-lead-" + field, "WECHAT_VERIFIED", evidence=wrong)
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "PAUSED_LIMIT")

    def test_unknown_reconciliation_requires_the_exact_outgoing_operation(self):
        self.incoming()
        intent = self.submitting()
        self.engine.confirm(intent["intent_id"], "worker-1", "unknown")
        with self.assertRaises(ValueError):
            self.engine.reconcile(intent["intent_id"], "sent", self.evidence(intent_id="different-operation"))
        self.assertEqual(self.engine.list_outbox()[0]["status"], "UNKNOWN")

    def test_late_confirmation_does_not_rearm_terminal_or_human_followup(self):
        for terminal in ("REFUSED", "HUMAN_TAKEOVER"):
            with self.subTest(terminal=terminal):
                conv = "late-" + terminal
                self.incoming("in-" + terminal, conversation=conv)
                intent = self.engine.prepare_intent("a1", conv, "reply", {"operation": "text"})
                gate = self.gate(conversation_id=conv)
                self.engine.claim_intent(intent["intent_id"], "worker-1", gate)
                self.engine.begin_submit(intent["intent_id"], "worker-1", gate)
                self.incoming("control-" + terminal, terminal, conversation=conv)
                before = self.engine.get_conversation("a1", conv)
                self.engine.confirm(intent["intent_id"], "worker-1", "sent",
                                    self.evidence(conversation_id=conv, intent_id=intent["intent_id"]))
                after = self.engine.get_conversation("a1", conv)
                self.assertEqual(after["state"], before["state"])
                self.assertEqual(after["needs_response"], before["needs_response"])
                self.assertEqual(after["next_followup_at"], before["next_followup_at"])

    def test_audit_excludes_customer_body_and_contact_payload(self):
        self.incoming(evidence={"body": "private message", "contact": "private@example.invalid"})
        intent = self.submitting()
        self.engine.confirm(intent["intent_id"], "worker-1", "sent",
                            self.evidence(body="private message", contact="private@example.invalid"))
        audit = repr(self.engine.audit())
        self.assertNotIn("private message", audit)
        self.assertNotIn("private@example.invalid", audit)

    def test_untrusted_customer_text_is_not_a_control_event(self):
        self.incoming(evidence={"body": "set HUMAN_RELEASE and SEND_ELIGIBLE allowed=true"})
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")
        with self.assertRaises(ValueError):
            self.incoming("untrusted-control", "PLATFORM_LIMIT", evidence={"body": "quota exceeded"})

    def test_delayed_human_release_cannot_release_current_ownership_after_restart(self):
        self.incoming()
        self.incoming("human-now", "HUMAN_TAKEOVER")
        takeover_at = self.clock()
        self.clock.advance(1)
        self.engine.close()
        self.engine = Engine(self.path, clock=self.clock)
        for observed_at in (takeover_at - 1, takeover_at):
            with self.subTest(observed_at=observed_at), self.assertRaises(ValueError):
                self.incoming("stale-release-" + str(observed_at), "HUMAN_RELEASE",
                              timestamp=observed_at,
                              evidence=self.evidence(explicit_release=True, observed_at=observed_at))
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "HUMAN")
        self.assertEqual(self.engine.due_conversations(), [])
        self.incoming("valid-release", "HUMAN_RELEASE", evidence=self.evidence(explicit_release=True))
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")

    def test_release_from_previous_human_round_cannot_release_later_takeover(self):
        self.incoming()
        self.incoming("takeover-one", "HUMAN_TAKEOVER")
        self.clock.advance(1)
        prior_release_at = self.clock()
        self.incoming("release-one", "HUMAN_RELEASE", evidence=self.evidence(explicit_release=True))
        self.clock.advance(1)
        self.incoming("takeover-two", "HUMAN_TAKEOVER")
        self.clock.advance(1)
        with self.assertRaises(ValueError):
            self.incoming("delayed-prior-release", "HUMAN_RELEASE", timestamp=prior_release_at,
                          evidence=self.evidence(explicit_release=True, observed_at=prior_release_at))
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "HUMAN")

    def platform_takeover(self, source_event_id="event-1", **changes):
        return self.incoming("platform-takeover-" + source_event_id, "PLATFORM_TAKEOVER_CONFIRMED",
                             evidence=self.evidence(taken_over=True, source_event_id=source_event_id, **changes))

    def native_card_sent(self, **changes):
        intent = self.engine.prepare_intent("a1", "c1", "card", {"operation": "native_card", "card_id": "unit-test-card"})
        self.current_intent = intent["intent_id"]
        self.engine.claim_intent(intent["intent_id"], "worker-1", self.gate())
        self.engine.begin_submit(intent["intent_id"], "worker-1", self.gate())
        self.clock.advance(.5)
        return self.engine.confirm(intent["intent_id"], "worker-1", "sent",
                                   self.evidence(native_wecom_card_confirmed=True, **changes))

    def test_full_reception_bundle_requires_all_three_within_five_seconds_from_platform_entry(self):
        self.incoming(kind="NEW_VISITOR")
        self.clock.advance(.2)
        self.platform_takeover()
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")
        self.sent("initial", usefulness_verified=True, useful=True)
        self.native_card_sent()
        report = self.engine.metrics()
        bundle = report["reception_bundle"]
        self.assertEqual(bundle["complete_bundles"], 1)
        self.assertEqual(bundle["within_5_seconds_count"], 1)
        self.assertEqual(bundle["target_assessment"], "meets")
        self.assertAlmostEqual(bundle["samples"][0]["platform_entry_to_all_confirmed_seconds"], 1.2)
        self.assertIn("p95_platform_to_confirm_seconds", report)  # Legacy interface remains.

    def test_fast_text_cannot_hide_missing_takeover_or_unknown_native_card_result(self):
        self.incoming(kind="NEW_VISITOR")
        self.sent("initial", usefulness_verified=True, useful=True)
        intent = self.engine.prepare_intent("a1", "c1", "card", {"operation": "native_card"})
        self.engine.claim_intent(intent["intent_id"], "worker-1", self.gate())
        self.engine.begin_submit(intent["intent_id"], "worker-1", self.gate())
        self.engine.confirm(intent["intent_id"], "worker-1", "unknown")
        self.clock.advance(5)
        bundle = self.engine.metrics()["reception_bundle"]
        self.assertEqual(bundle["complete_bundles"], 0)
        self.assertEqual(bundle["within_5_seconds_count"], 0)
        self.assertEqual(bundle["target_assessment"], "misses")
        self.assertIn("platform_takeover_confirmed_at", bundle["samples"][0]["missing_receipts"])
        self.assertIn("native_wecom_card_confirmed_at", bundle["samples"][0]["missing_receipts"])
        self.assertIn("UNKNOWN", bundle["samples"][0]["attempt_statuses"])

    def test_missing_platform_time_never_completes_bundle_even_with_three_receipts(self):
        self.incoming(kind="NEW_VISITOR", timestamp=None)
        self.platform_takeover()
        self.sent("initial", usefulness_verified=True, useful=True)
        self.native_card_sent()
        bundle = self.engine.metrics()["reception_bundle"]
        self.assertEqual(bundle["complete_bundles"], 0)
        self.assertEqual(bundle["platform_timestamp_unknown_events"], 1)
        self.assertIsNone(bundle["within_5_seconds_rate"])
        self.assertIsNone(bundle["samples"][0]["completed_at"])
        self.assertEqual(bundle["target_assessment"], "unverified")

    def test_local_detection_clock_cannot_be_relabelled_as_entry_acceptance(self):
        self.incoming(kind="NEW_VISITOR", evidence={"timestamp_source": "detected_at"})
        self.platform_takeover()
        self.sent("initial", usefulness_verified=True, useful=True)
        self.native_card_sent()
        bundle = self.engine.metrics()["reception_bundle"]
        self.assertEqual(bundle["complete_bundles"], 0)
        self.assertEqual(bundle["platform_timestamp_unknown_events"], 1)
        self.assertIsNone(bundle["within_5_seconds_rate"])

    def test_bundle_clock_includes_detection_delay_and_slow_card_confirmation(self):
        self.incoming(kind="NEW_VISITOR", timestamp=self.clock() - 4)
        self.platform_takeover()
        self.sent("initial", usefulness_verified=True, useful=True)
        self.clock.advance(1)
        self.native_card_sent()
        report = self.engine.metrics()
        self.assertLess(report["p95_platform_to_confirm_seconds"], 5)
        bundle = report["reception_bundle"]
        self.assertEqual(bundle["complete_bundles"], 1)
        self.assertEqual(bundle["within_5_seconds_count"], 0)
        self.assertEqual(bundle["target_assessment"], "misses")
        self.assertAlmostEqual(bundle["samples"][0]["platform_entry_to_all_confirmed_seconds"], 6)

    def test_platform_takeover_receipt_requires_real_entry_association_and_scope(self):
        self.incoming(kind="NEW_VISITOR")
        with self.assertRaises(ValueError):
            self.platform_takeover(source_event_id="not-observed")
        with self.assertRaises(ValueError):
            self.platform_takeover(conversation_id="other-customer")
        self.incoming("customer-message")
        with self.assertRaises(ValueError):
            self.platform_takeover(source_event_id="customer-message")
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")

    def test_later_customer_reply_needs_explicit_entry_link_for_bundle(self):
        self.incoming(kind="NEW_VISITOR")
        self.platform_takeover()
        self.clock.advance(.1)
        self.incoming("opened")
        self.sent("reply", usefulness_verified=True, useful=True, reception_event_id="event-1")
        self.native_card_sent(reception_event_id="event-1")
        self.assertEqual(self.engine.metrics()["reception_bundle"]["complete_bundles"], 1)

    def test_normal_sent_card_without_native_wecom_receipt_is_incomplete(self):
        self.incoming(kind="NEW_VISITOR")
        self.platform_takeover()
        self.sent("initial", usefulness_verified=True, useful=True)
        self.sent("card", native_wecom_card_confirmed=True)  # Payload is text, not a native card.
        bundle = self.engine.metrics()["reception_bundle"]
        self.assertEqual(bundle["complete_bundles"], 0)
        self.assertIn("native_wecom_card_confirmed_at", bundle["samples"][0]["missing_receipts"])

    def test_numeric_entry_timestamp_without_declared_source_stays_unknown(self):
        self.engine.ingest_event(Event("a1", "c1", "event-1", "NEW_VISITOR", timestamp=self.clock()))
        self.platform_takeover()
        self.sent("initial", usefulness_verified=True, useful=True)
        self.native_card_sent()
        metrics = self.engine.metrics()
        self.assertEqual(metrics["samples"][0]["timestamp_source"], "unknown")
        self.assertIsNone(metrics["p95_platform_to_confirm_seconds"])
        self.assertIsNone(metrics["within_5_seconds_rate"])
        self.assertEqual(metrics["reception_bundle"]["complete_bundles"], 0)
        self.assertEqual(metrics["reception_bundle"]["platform_timestamp_unknown_events"], 1)

    def test_new_visitor_outgoing_receipt_cannot_be_reassigned_to_another_entry(self):
        self.incoming("entry-a", kind="NEW_VISITOR")
        self.clock.advance(.1)
        self.incoming("entry-b", kind="NEW_VISITOR")
        intent = self.submitting("initial")
        with self.assertRaises(ValueError):
            self.engine.confirm(intent["intent_id"], "worker-1", "sent",
                                self.evidence(reception_event_id="entry-a", usefulness_verified=True, useful=True))
        self.assertEqual(self.engine.list_outbox()[0]["status"], "SUBMITTING")
        self.engine.confirm(intent["intent_id"], "worker-1", "sent",
                            self.evidence(usefulness_verified=True, useful=True))
        self.native_card_sent()
        self.platform_takeover(source_event_id="entry-a")
        self.platform_takeover(source_event_id="entry-b")
        bundle = self.engine.metrics()["reception_bundle"]
        self.assertEqual(bundle["complete_bundles"], 1)
        samples = {sample["entry_event_id"]: sample for sample in bundle["samples"]}
        self.assertFalse(samples["entry-a"]["complete"])
        self.assertTrue(samples["entry-b"]["complete"])

    def test_legacy_conflicting_receipt_cannot_double_credit_two_entries(self):
        self.incoming("entry-a", kind="NEW_VISITOR")
        self.clock.advance(.1)
        self.incoming("entry-b", kind="NEW_VISITOR")
        self.sent("initial", usefulness_verified=True, useful=True)
        self.native_card_sent()
        self.platform_takeover(source_event_id="entry-a")
        self.platform_takeover(source_event_id="entry-b")
        # Simulate an old DB written before the attribution fix; do not create runtime data.
        import json
        for receipt in self.engine.list_outbox():
            proof = receipt["evidence"]
            proof["reception_event_id"] = "entry-a"
            self.engine.db.execute("UPDATE outbox SET evidence=? WHERE intent_id=?",
                                   (json.dumps(proof), receipt["intent_id"]))
        bundle = self.engine.metrics()["reception_bundle"]
        self.assertEqual(bundle["complete_bundles"], 0)
        self.assertEqual(bundle["within_5_seconds_count"], 0)

    def observed_outbound(self, event_id="native-outbound", timestamp=None, conversation="c1", **proof):
        if timestamp is None:
            timestamp = self.clock()
        evidence = self.evidence(conversation_id=conversation, timestamp_source="platform_ui",
                                 native_message_id="message-" + event_id, **proof)
        return self.engine.ingest_event(Event("a1", conversation, event_id, "OUTBOUND_OBSERVED",
                                             timestamp=timestamp, evidence=evidence))

    def test_observed_outbound_requires_native_scoped_timestamp_evidence(self):
        self.incoming()
        bad = [
            (None, self.evidence(timestamp_source="platform_ui", native_message_id="m")),
            (self.clock(), self.evidence(timestamp_source="unknown", native_message_id="m")),
            (self.clock(), self.evidence(timestamp_source="platform_ui")),
            (self.clock(), self.evidence(timestamp_source="platform_ui", native_message_id="m", conversation_id="other")),
            (self.clock(), self.evidence(timestamp_source="platform_ui", native_message_id="m", source="official_api")),
        ]
        for index, (timestamp, evidence) in enumerate(bad):
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.engine.ingest_event(Event("a1", "c1", "bad-observation-" + str(index), "OUTBOUND_OBSERVED",
                                             timestamp=timestamp, evidence=evidence))
        self.assertIsNone(self.engine.get_conversation("a1", "c1")["last_sent_at"])
        self.assertEqual(self.engine.list_outbox(), [])

    def test_observed_old_outbound_never_moves_sent_or_followup_baseline_backwards(self):
        self.incoming()
        self.sent()
        before = self.engine.get_conversation("a1", "c1")
        self.observed_outbound(timestamp=self.clock() - 100)
        after = self.engine.get_conversation("a1", "c1")
        self.assertEqual(after["last_sent_at"], before["last_sent_at"])
        self.assertEqual(after["next_followup_at"], before["next_followup_at"])
        self.assertEqual(len(self.engine.list_outbox()), 1)

    def test_observed_outbound_needs_exact_current_reply_link_and_nonolder_time(self):
        self.incoming(timestamp=self.clock() - 100)
        self.observed_outbound("linked-old", timestamp=self.clock() - 50, responds_to_event_id="event-1")
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 0)
        self.incoming("new-incoming")
        self.observed_outbound("missing-link")
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 1)
        self.observed_outbound("old-link", responds_to_event_id="event-1")
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 1)
        self.observed_outbound("older-native", timestamp=self.clock() - 1, responds_to_event_id="new-incoming")
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 1)
        self.observed_outbound("current-native", responds_to_event_id="new-incoming")
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 0)

    def test_observed_outbound_never_releases_human_terminal_or_platform_limit(self):
        for control, state in (("HUMAN_TAKEOVER", "HUMAN"), ("REFUSED", "STOPPED"), ("PLATFORM_LIMIT", "PAUSED_LIMIT")):
            with self.subTest(control=control):
                conv = "native-" + control
                self.incoming("in-" + control, conversation=conv)
                self.incoming("control-" + control, control, conversation=conv)
                before = self.engine.get_conversation("a1", conv)
                self.observed_outbound("observed-" + control, conversation=conv)
                after = self.engine.get_conversation("a1", conv)
                self.assertEqual(after["state"], state)
                self.assertEqual(after["next_followup_at"], before["next_followup_at"])
                self.assertEqual(after["resume_state"], before["resume_state"])
                self.assertEqual(after["last_limit_at"], before["last_limit_at"])
                self.assertEqual(after["last_sent_at"], self.clock())

    def test_observed_outbound_does_not_resolve_submitting_or_unknown(self):
        self.incoming()
        intent = self.submitting()
        self.observed_outbound("observed-while-submitting", responds_to_event_id="event-1")
        self.assertEqual(self.engine.list_outbox()[0]["status"], "SUBMITTING")
        self.engine.confirm(intent["intent_id"], "worker-1", "unknown")
        self.observed_outbound("observed-while-unknown", responds_to_event_id="event-1")
        self.assertEqual(self.engine.list_outbox()[0]["status"], "UNKNOWN")
        self.assertEqual(self.engine.due_conversations(), [])
        with self.assertRaises(NotEligible):
            self.prepare("followup")

    def test_observed_outbound_enforces_minimum_interval_without_claiming_sent_or_bundle(self):
        self.incoming(kind="NEW_VISITOR", timestamp=self.clock() - 10)
        self.observed_outbound(responds_to_event_id="event-1", usefulness_verified=True, useful=True,
                               native_wecom_card_confirmed=True)
        self.assertEqual(self.engine.list_outbox(), [])
        metrics = self.engine.metrics()
        self.assertEqual(metrics["confirmed_response_samples"], 0)
        self.assertEqual(metrics["reception_bundle"]["complete_bundles"], 0)
        self.clock.advance(1799)
        with self.assertRaises(NotEligible):
            self.prepare("followup")
        self.clock.advance(1)
        self.assertEqual(self.prepare("followup")["status"], "PREPARED")

    def test_observed_confirmed_reply_cancels_only_unsubmitted_old_draft(self):
        self.incoming()
        intent = self.prepare()
        self.engine.claim_intent(intent["intent_id"], "worker-1", self.gate())
        self.observed_outbound(responds_to_event_id="event-1")
        self.assertEqual(self.engine.list_outbox()[0]["status"], "CANCELLED")
        with self.assertRaises(InvalidTransition):
            self.engine.begin_submit(intent["intent_id"], "worker-1", self.gate())

    def test_late_own_confirmation_cannot_undo_newer_observed_outbound_baseline(self):
        self.incoming()
        intent = self.submitting()
        self.clock.advance(.5)
        own_receipt_at = self.clock()
        self.clock.advance(5)
        self.observed_outbound()
        native_sent_at = self.clock()
        self.engine.confirm(intent["intent_id"], "worker-1", "sent", self.evidence(observed_at=own_receipt_at))
        con = self.engine.get_conversation("a1", "c1")
        self.assertEqual(con["last_sent_at"], native_sent_at)
        self.assertEqual(con["next_followup_at"], native_sent_at + 1800)
        self.assertEqual(self.engine.list_outbox()[0]["confirmed_at"], own_receipt_at)

    def followup_text_anchor(self):
        self.incoming()
        self.sent()
        self.clock.advance(1800)
        return self.sent("followup", native_message_id="native-followup-text")

    def prepare_followup_card(self, anchor):
        return self.engine.prepare_intent("a1", "c1", "card", {
            "operation": "native_card", "card_id": "unit-test-card",
            "companion_text_intent_id": anchor["intent_id"],
        })

    def finish_followup_card(self, prepared):
        self.current_intent = prepared["intent_id"]
        self.engine.claim_intent(prepared["intent_id"], "worker-1", self.gate())
        self.engine.begin_submit(prepared["intent_id"], "worker-1", self.gate())
        self.clock.advance(.5)
        return self.engine.confirm(prepared["intent_id"], "worker-1", "sent", self.evidence(native_wecom_card_confirmed=True))

    def test_followup_text_card_each_round_once_and_later_round_not_permanently_blocked(self):
        self.incoming()
        self.sent()
        self.sent("card")  # Existing initial card must not consume future rounds.
        self.clock.advance(1800)
        anchor = self.sent("followup", native_message_id="first-followup-text")
        card = self.finish_followup_card(self.prepare_followup_card(anchor))
        with self.assertRaises(NotEligible):
            self.prepare_followup_card(anchor)
        with self.assertRaises(NotEligible):
            self.prepare("followup")
        self.clock.advance(1800)
        next_anchor = self.sent("followup", native_message_id="next-followup-text")
        next_card = self.finish_followup_card(self.prepare_followup_card(next_anchor))
        self.assertNotEqual(card["intent_id"], next_card["intent_id"])
        self.assertEqual(len(self.engine.list_outbox()), 6)

    def test_followup_companion_requires_confirmed_text_anchor_not_initial_or_native_card(self):
        self.incoming()
        initial = self.sent()
        with self.assertRaises(NotEligible):
            self.prepare_followup_card(initial)
        self.clock.advance(1800)
        native = self.engine.prepare_intent("a1", "c1", "followup", {"operation": "native_card"})
        self.engine.claim_intent(native["intent_id"], "worker-1", self.gate())
        self.engine.begin_submit(native["intent_id"], "worker-1", self.gate())
        self.engine.confirm(native["intent_id"], "worker-1", "sent", self.evidence(intent_id=native["intent_id"]))
        with self.assertRaises(NotEligible):
            self.prepare_followup_card(native)

    def test_followup_companion_rejects_other_account_conversation_and_inbound_source(self):
        anchor = self.followup_text_anchor()
        payload = {"operation": "native_card", "companion_text_intent_id": anchor["intent_id"]}
        self.incoming("other-conversation-event", conversation="c2")
        with self.assertRaises(NotEligible):
            self.engine.prepare_intent("a1", "c2", "card", payload)
        self.engine.ingest_event(Event("a2", "c1", "other-account-event", "CUSTOMER_MESSAGE", timestamp=self.clock()))
        with self.assertRaises(NotEligible):
            self.engine.prepare_intent("a2", "c1", "card", payload)
        self.clock.advance(.1)
        self.incoming("new-inbound")
        with self.assertRaises(NotEligible):
            self.prepare_followup_card(anchor)

    def test_followup_companion_window_rechecked_before_claim(self):
        anchor = self.followup_text_anchor()
        self.clock.advance(29)
        card = self.prepare_followup_card(anchor)
        self.clock.advance(2)
        with self.assertRaises(NotEligible):
            self.engine.claim_intent(card["intent_id"], "worker-1", self.gate())

    def test_followup_companion_window_rechecked_before_submit(self):
        anchor = self.followup_text_anchor()
        self.clock.advance(29)
        card = self.prepare_followup_card(anchor)
        self.engine.claim_intent(card["intent_id"], "worker-1", self.gate())
        self.clock.advance(2)
        with self.assertRaises(NotEligible):
            self.engine.begin_submit(card["intent_id"], "worker-1", self.gate())

    def test_other_native_outbound_after_anchor_blocks_prepared_companion(self):
        anchor = self.followup_text_anchor()
        card = self.prepare_followup_card(anchor)
        self.clock.advance(.1)
        self.observed_outbound("another-operator-send")
        with self.assertRaises(NotEligible):
            self.engine.claim_intent(card["intent_id"], "worker-1", self.gate())

    def test_other_native_outbound_after_claim_blocks_companion_submit(self):
        anchor = self.followup_text_anchor()
        card = self.prepare_followup_card(anchor)
        self.engine.claim_intent(card["intent_id"], "worker-1", self.gate())
        self.clock.advance(.1)
        self.observed_outbound("another-operator-send")
        with self.assertRaises(NotEligible):
            self.engine.begin_submit(card["intent_id"], "worker-1", self.gate())

    def test_observation_of_same_native_anchor_does_not_cancel_its_companion(self):
        anchor = self.followup_text_anchor()
        card = self.prepare_followup_card(anchor)
        self.engine.ingest_event(Event("a1", "c1", "same-anchor-observed", "OUTBOUND_OBSERVED",
            timestamp=self.clock(), evidence=self.evidence(timestamp_source="platform_ui",
                native_message_id="native-followup-text", responds_to_event_id="event-1")))
        self.assertEqual(self.engine.list_outbox()[-1]["status"], "PREPARED")
        self.assertEqual(self.finish_followup_card(card)["status"], "SENT")

    def test_historical_baseline_keeps_source_without_creating_unanswered_live_task(self):
        for kind in ("NEW_VISITOR", "CUSTOMER_MESSAGE"):
            with self.subTest(kind=kind):
                conv = "history-" + kind
                self.incoming("history-" + kind, kind=kind, conversation=conv,
                              timestamp=self.clock() - 100, evidence={"historical_baseline": True})
                con = self.engine.get_conversation("a1", conv)
                self.assertEqual(con["latest_event_id"], "history-" + kind)
                self.assertEqual(con["needs_response"], 0)
        self.assertEqual(self.engine.due_conversations(), [])
        metrics = self.engine.metrics()
        self.assertEqual(metrics["recorded_inbound_events"], 0)
        self.assertEqual(metrics["historical_inbound_events"], 2)
        self.assertEqual(metrics["all_recorded_inbound_events"], 2)
        self.assertEqual(metrics["reception_bundle"]["recorded_entry_events"], 0)
        self.assertEqual(metrics["reception_bundle"]["historical_entry_events"], 1)
        self.assertIsNone(metrics["within_5_seconds_rate"])

    def test_historical_baseline_can_be_followup_source_after_native_outbound_interval(self):
        self.incoming(kind="NEW_VISITOR", timestamp=self.clock() - 100, evidence={"historical_baseline": True})
        self.observed_outbound(timestamp=self.clock() - 50)
        self.clock.advance(1750)
        prepared = self.prepare("followup")
        self.assertEqual(prepared["source_event_id"], "event-1")
        self.assertEqual(prepared["kind"], "followup")

    def test_baseline_duplicate_cannot_promote_same_old_event_into_live_entry(self):
        self.incoming(kind="NEW_VISITOR", evidence={"historical_baseline": True})
        replay = self.incoming(kind="NEW_VISITOR", evidence={"historical_baseline": False})
        self.assertTrue(replay["duplicate"])
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 0)
        self.assertEqual(self.engine.metrics()["historical_inbound_events"], 1)
        self.assertEqual(self.engine.metrics()["recorded_inbound_events"], 0)
        self.clock.advance(1)
        self.incoming("genuine-new-message")
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 1)
        self.assertEqual(self.engine.metrics()["recorded_inbound_events"], 1)

    def test_history_scan_does_not_erase_already_unanswered_live_need_or_count_history_reply(self):
        self.incoming(timestamp=self.clock() - 100)
        self.incoming("later-historical-context", timestamp=self.clock() - 50, evidence={"historical_baseline": True})
        self.assertEqual(self.engine.get_conversation("a1", "c1")["needs_response"], 1)
        self.sent(usefulness_verified=True, useful=True)
        metrics = self.engine.metrics()
        self.assertEqual(metrics["historical_inbound_events"], 1)
        self.assertEqual(metrics["recorded_inbound_events"], 1)
        self.assertEqual(metrics["confirmed_response_samples"], 0)
        self.assertEqual(metrics["unanswered_events"], 1)

    def test_historical_entry_never_enters_bundle_even_if_all_receipts_exist(self):
        self.incoming("live-pending", timestamp=self.clock() - 20)
        self.incoming("historical-entry", kind="NEW_VISITOR", timestamp=self.clock() - 10,
                      evidence={"historical_baseline": True})
        self.platform_takeover(source_event_id="historical-entry")
        self.sent("initial", usefulness_verified=True, useful=True)
        self.native_card_sent()
        bundle = self.engine.metrics()["reception_bundle"]
        self.assertEqual(bundle["historical_entry_events"], 1)
        self.assertEqual(bundle["recorded_entry_events"], 0)
        self.assertEqual(bundle["complete_bundles"], 0)
        self.assertEqual(bundle["target_assessment"], "unverified")

    def test_old_round_late_confirmation_defers_current_followup_schedule(self):
        self.incoming("old-round")
        intent = self.submitting()
        self.clock.advance(1)
        self.incoming("current-round")
        self.clock.advance(1)
        self.observed_outbound("external-current-reply", responds_to_event_id="current-round")
        earlier_due = self.engine.get_conversation("a1", "c1")["next_followup_at"]
        self.clock.advance(8)
        self.engine.confirm(intent["intent_id"], "worker-1", "sent", self.evidence())
        con = self.engine.get_conversation("a1", "c1")
        self.assertEqual(con["latest_event_id"], "current-round")
        self.assertEqual(con["needs_response"], 0)
        self.assertEqual(con["next_followup_at"], con["last_sent_at"] + 1800)
        self.clock.advance(earlier_due - self.clock())
        self.assertEqual(self.engine.due_conversations(), [])
        self.clock.advance(8)
        self.assertEqual(self.engine.due_conversations()[0]["due_kind"], "followup")
        self.assertEqual(self.prepare("followup")["status"], "PREPARED")

    def service_question(self, raw="service-question", text="我想咨询一下报价", **proof_changes):
        event_id = "id_a1.c1." + raw
        proof = self.evidence(reference=event_id, timestamp_source="platform_ui",
                              native_message_id="jarvis-msg-a1.c1." + raw,
                              native_message_type="TEXT", native_direction="left",
                              historical_baseline=False, untrusted_message_text=text)
        proof.update(proof_changes)
        self.incoming(event_id, evidence=proof)
        return event_id

    def service_prepare(self, source=None, **payload_changes):
        payload = {"operation": "text", "text": "请发目的国、货品和预计件量，方便核对报价。",
                   "text_only_service": True, "source_message_text": "我想咨询一下报价"}
        payload.update(payload_changes)
        return self.engine.prepare_intent("a1", "c1", "service_reply", payload, source_event_id=source)

    def service_lead(self, kind="WECHAT_VERIFIED"):
        self.incoming("original-before-lead")
        proof = self.evidence(verified=True)
        self.incoming("verified-lead", kind, evidence=proof)
        self.clock.advance(1)
        return self.service_question()

    def native_external_takeover(self, timestamp, raw="old-external", **proof_changes):
        native = "jarvis-msg-a1.c1." + raw
        proof = self.evidence(reference="id_a1.c1." + raw, native_message_id=native,
                              timestamp_source="platform_ui",
                              ownership_reason="native_non_ai_outbound_from_other_operator")
        proof.update(proof_changes)
        return self.incoming("external-operator:" + native, "HUMAN_TAKEOVER", timestamp=timestamp, evidence=proof)

    def direct_human_release(self, event_id="direct-owner-return", **proof_changes):
        proof = self.evidence(explicit_release=True, authorization_source="direct_human_instruction",
                              authorization_reference="real-human-automatic-reception-instruction")
        proof.update(proof_changes)
        return self.incoming(event_id, "HUMAN_RELEASE", timestamp=None, evidence=proof)

    def test_late_old_native_takeover_preserves_newer_explicit_release_and_unsent_work(self):
        self.incoming()
        release_at = self.clock()
        self.direct_human_release()
        prepared = self.prepare()
        self.clock.advance(1)
        detected = self.clock()
        self.native_external_takeover(release_at - 1800)
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")
        self.assertEqual(self.engine.list_outbox()[0]["status"], "PREPARED")
        event = self.engine.db.execute("SELECT * FROM events WHERE type='HUMAN_TAKEOVER'").fetchone()
        self.assertEqual((event["timestamp"], event["detected_at"]), (release_at - 1800, detected))
        self.assertEqual(len([row for row in self.engine.audit() if row["action"] == "EVENT_INGESTED"]), 3)
        self.engine.close()
        self.engine = Engine(self.path, clock=self.clock)
        self.assertTrue(self.native_external_takeover(release_at - 1800)["duplicate"])
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")
        self.assertEqual(self.engine.list_outbox()[0]["intent_id"], prepared["intent_id"])

    def test_new_customer_message_reopens_after_inferred_operator_turn(self):
        self.incoming("customer-one")
        self.native_external_takeover(self.clock())
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "HUMAN")
        self.clock.advance(1)
        self.incoming("customer-two")
        con = self.engine.get_conversation("a1", "c1")
        self.assertEqual((con["state"], con["needs_response"]), ("ACTIVE", 1))
        self.prepare()

    def test_startup_repairs_legacy_inferred_human_hold_after_newer_inbound(self):
        self.incoming("customer-one")
        self.native_external_takeover(self.clock())
        self.clock.advance(1)
        self.incoming("customer-two")
        # Reproduce a row persisted by the old conversation-wide ownership rule.
        self.engine.db.execute("UPDATE conversations SET state='HUMAN',resume_state='ACTIVE' WHERE account_id='a1' AND conversation_id='c1'")
        self.engine.close()
        self.engine = Engine(self.path, clock=self.clock)
        con = self.engine.get_conversation("a1", "c1")
        self.assertEqual((con["state"], con["needs_response"]), ("ACTIVE", 1))
        self.prepare()

    def test_native_control_clock_boundary_and_incomplete_provenance_still_hold_human(self):
        cases = [(0, {}), (-.5, {}), (-10, {}), (.1, {}), (-1800, {"source": "official_api"}),
                 (-1800, {"timestamp_source": "unknown"}), (-1800, {"reference": "wrong"}),
                 (-1800, {"native_message_id": "jarvis-msg-other.c1.old-external"}),
                 (-1800, {"ownership_reason": "manual_human_control"}),
                 (-1800, {"observed_at": self.clock()})]
        for index, (offset, changes) in enumerate(cases):
            with self.subTest(index=index), Engine(os.path.join(self.temp.name, "human-boundary-%s.sqlite3" % index), clock=self.clock) as other:
                original, self.engine = self.engine, other
                try:
                    self.incoming()
                    release_at = self.clock()
                    self.direct_human_release()
                    self.clock.advance(1)
                    self.native_external_takeover(release_at + offset, **changes)
                    expected = "ACTIVE" if not changes and offset < 0 else "HUMAN"
                    self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], expected)
                    if expected == "HUMAN":
                        with self.assertRaises(NotEligible):
                            self.prepare()
                    else:
                        self.prepare()
                finally:
                    self.engine = original

    def test_missing_native_time_or_direct_human_control_cannot_be_released_by_old_authorization(self):
        self.incoming()
        old = self.clock() - 1800
        self.direct_human_release()
        self.clock.advance(1)
        self.native_external_takeover(None)
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "HUMAN")
        self.clock.advance(1)
        self.direct_human_release("fresh-return")
        self.clock.advance(1)
        self.incoming("active-human-control", "HUMAN_TAKEOVER", timestamp=old)
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "HUMAN")

    def test_old_inferred_output_does_not_block_a_later_auto_turn_or_require_valid_release(self):
        for index, release_changes in enumerate(({"authorization_source": "unknown"}, {"authorization_reference": ""})):
            with self.subTest(index=index), Engine(os.path.join(self.temp.name, "human-authorization-%s.sqlite3" % index), clock=self.clock) as other:
                original, self.engine = self.engine, other
                try:
                    self.incoming()
                    release_at = self.clock()
                    self.direct_human_release(**release_changes)
                    self.clock.advance(1)
                    self.native_external_takeover(release_at - 1800)
                    self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")
                finally:
                    self.engine = original
        with Engine(os.path.join(self.temp.name, "human-wide-clock-boundary.sqlite3"), clock=self.clock,
                    freshness_seconds=30) as other:
            original, self.engine = self.engine, other
            try:
                self.incoming()
                release_at = self.clock()
                self.direct_human_release()
                self.clock.advance(1)
                self.native_external_takeover(release_at - 20)
                self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")
            finally:
                self.engine = original

    def test_old_native_takeover_does_not_block_stopped_service_after_restart_or_lower_gate_barrier(self):
        source = self.service_lead()
        release_at = self.clock()
        self.direct_human_release()
        old_gate = self.gate()
        self.clock.advance(1)
        self.native_external_takeover(release_at - 1800)
        self.engine.close()
        self.engine = Engine(self.path, clock=self.clock)
        self.assertTrue(self.engine.get_conversation("a1", "c1")["service_reply"]["eligible"])
        prepared = self.service_prepare(source)
        with self.assertRaises(GateClosed):
            self.engine.claim_intent(prepared["intent_id"], "worker-1", old_gate)
        self.engine.claim_intent(prepared["intent_id"], "worker-1", self.gate())
        self.engine.begin_submit(prepared["intent_id"], "worker-1", self.gate())
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "STOPPED")

    def test_release_checks_original_native_order_but_cannot_release_newer_native_operator(self):
        self.incoming()
        original_native_at = self.clock() - 1800
        self.native_external_takeover(original_native_at)
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")
        self.clock.advance(1)
        self.direct_human_release(observed_at=self.clock() - 60)
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "ACTIVE")
        self.clock.advance(1)
        self.native_external_takeover(self.clock(), raw="truly-new-external")
        with self.assertRaises(ValueError):
            self.direct_human_release("delayed-old-return", observed_at=self.clock() - 60)
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "HUMAN")

    def test_verified_lead_new_question_gets_one_text_without_reopening_acquisition(self):
        source = self.service_lead()
        con = self.engine.get_conversation("a1", "c1")
        self.assertTrue(con["service_reply"]["eligible"])
        self.assertEqual(con["state"], "STOPPED")
        intent = self.service_prepare(source)
        self.current_intent = intent["intent_id"]
        self.engine.claim_intent(intent["intent_id"], "worker-1", self.gate())
        self.engine.begin_submit(intent["intent_id"], "worker-1", self.gate())
        self.clock.advance(.1)
        self.engine.confirm(intent["intent_id"], "worker-1", "sent", self.evidence())
        con = self.engine.get_conversation("a1", "c1")
        self.assertEqual((con["state"], con["stop_reason"], con["needs_response"], con["next_followup_at"]),
                         ("STOPPED", "WECHAT_VERIFIED", 0, None))
        self.assertEqual(self.engine.due_conversations(), [])
        for kind in ("initial", "reply", "card", "followup"):
            with self.subTest(kind=kind), self.assertRaises(NotEligible):
                self.engine.prepare_intent("a1", "c1", kind, {"operation": "native_card"})
        with self.assertRaises(NotEligible):
            self.service_prepare(source)

    def test_service_reply_requires_exact_new_native_question_and_text_only_payload(self):
        source = self.service_lead("LEAD_VERIFIED")
        for change in ({"operation": "native_card"}, {"text_only_service": False},
                       {"source_message_text": "另一条报价问题"}, {"text": ""}):
            with self.subTest(change=change), self.assertRaises(NotEligible):
                self.service_prepare(source, **change)
        with self.assertRaises(NotEligible):
            self.service_prepare("not-the-current-event")
        for key, value in (("historical_baseline", True), ("native_direction", "right"),
                           ("native_message_type", "RICH_HINT"), ("source", "official_api"),
                           ("native_message_id", "jarvis-msg-other.c1.wrong-pair")):
            self.clock.advance(1)
            bad = self.service_question("bad-" + key, **{key: value})
            with self.subTest(key=key), self.assertRaises(NotEligible):
                self.service_prepare(bad)

    def test_service_reply_never_releases_original_unknown(self):
        self.incoming()
        old = self.submitting("card")
        self.engine.confirm(old["intent_id"], "worker-1", "unknown", self.evidence())
        self.incoming("verified-lead", "WECHAT_VERIFIED", evidence=self.evidence(verified=True))
        self.clock.advance(1)
        source = self.service_question()
        with self.assertRaises(NotEligible):
            self.service_prepare(source)
        self.assertEqual(self.engine.list_outbox()[0]["status"], "UNKNOWN")
        self.current_intent = old["intent_id"]
        self.engine.reconcile(old["intent_id"], "sent", self.evidence())
        self.assertEqual(self.service_prepare(source)["kind"], "service_reply")

    def test_service_reply_respects_refusal_human_and_limit_evidence_while_stopped(self):
        for control in ("REFUSED", "HUMAN_TAKEOVER", "PLATFORM_LIMIT"):
            with self.subTest(control=control):
                # Independent temporary Engine per control keeps refusal absolute.
                other = Engine(os.path.join(self.temp.name, control + ".sqlite3"), clock=self.clock)
                original = self.engine
                self.engine = other
                try:
                    source = self.service_lead()
                    prepared = self.service_prepare(source)
                    self.current_intent = prepared["intent_id"]
                    self.engine.claim_intent(prepared["intent_id"], "worker-1", self.gate())
                    self.clock.advance(.1)
                    self.incoming("late-control", control)
                    with self.assertRaises((NotEligible, InvalidTransition)):
                        self.engine.begin_submit(prepared["intent_id"], "worker-1", self.gate())
                    if control == "REFUSED":
                        self.incoming("another-verified-lead", "LEAD_VERIFIED", evidence=self.evidence(verified=True))
                        self.clock.advance(1)
                        newer = self.service_question("after-refusal")
                        with self.assertRaises(NotEligible):
                            self.service_prepare(newer)
                finally:
                    self.engine.close();self.engine = original

    def test_historical_or_prelead_question_cannot_become_service_reply(self):
        self.incoming("initial")
        self.clock.advance(1)
        source = self.service_question()
        self.clock.advance(1)
        self.incoming("verified-after-question", "WECHAT_VERIFIED", evidence=self.evidence(verified=True))
        with self.assertRaises(NotEligible):
            self.service_prepare(source)

    def test_service_claim_requires_native_gate_after_latest_control_release(self):
        source = self.service_lead()
        prepared = self.service_prepare(source)
        old_gate = self.gate()
        self.clock.advance(.1)
        self.incoming("manual-owner", "HUMAN_TAKEOVER")
        self.clock.advance(.1)
        self.incoming("explicit-owner-return", "HUMAN_RELEASE", evidence=self.evidence(explicit_release=True))
        with self.assertRaises(GateClosed):
            self.engine.claim_intent(prepared["intent_id"], "worker-1", old_gate)
        self.engine.claim_intent(prepared["intent_id"], "worker-1", self.gate())
        self.engine.begin_submit(prepared["intent_id"], "worker-1", self.gate())
        self.assertEqual(self.engine.get_conversation("a1", "c1")["state"], "STOPPED")

    def test_stopped_service_limit_needs_positive_later_eligibility(self):
        source = self.service_lead()
        self.clock.advance(.1)
        self.incoming("service-limit", "PLATFORM_LIMIT")
        with self.assertRaises(NotEligible):
            self.service_prepare(source)
        self.clock.advance(.1)
        self.incoming("service-allowed", "SEND_ELIGIBLE", evidence=self.evidence(allowed=True))
        self.assertEqual(self.service_prepare(source)["kind"], "service_reply")


if __name__ == "__main__":
    unittest.main()
