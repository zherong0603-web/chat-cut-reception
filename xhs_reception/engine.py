"""SQLite state machine. No method in this module sends an external message.

An adapter must observe the actual account and conversation, claim an intent,
persist SUBMITTING immediately before its single external submission, then
confirm the observed result. Unknown results require reconciliation, never a
retry. Browser availability is deliberately not inferred from a saved login.
"""

import json
import math
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional


class EngineError(Exception):
    pass


class NotEligible(EngineError):
    pass


class GateClosed(EngineError):
    pass


class InvalidTransition(EngineError):
    pass


@dataclass(frozen=True)
class Event:
    account_id: str
    conversation_id: str
    event_id: str
    type: str
    timestamp: Optional[float] = None
    detected_at: Optional[float] = None
    evidence: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DispatchGate:
    enabled: bool = False
    browser_connected: bool = False
    authenticated: bool = False
    account_id: Optional[str] = None
    conversation_id: Optional[str] = None
    browser_session_id: Optional[str] = None
    observed_at: Optional[float] = None


EVENT_TYPES = frozenset({
    "NEW_VISITOR", "CUSTOMER_MESSAGE", "PLATFORM_LIMIT", "SEND_ELIGIBLE",
    "WECHAT_VERIFIED", "LEAD_VERIFIED", "REFUSED", "HUMAN_TAKEOVER",
    "HUMAN_RELEASE", "PLATFORM_TAKEOVER_CONFIRMED", "OUTBOUND_OBSERVED",
})
LIVE_STATUSES = ("PREPARED", "CLAIMED", "SUBMITTING", "UNKNOWN")
EVIDENCE_SOURCES = frozenset({"platform_ui", "official_api"})


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(name + " must be a finite numeric UTC timestamp")
    return float(value)


def _identifier(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(name + " must be a nonempty string")
    return value


class Engine:
    def __init__(self, db_path, *, clock: Callable[[], float] = time.time,
                 min_followup_interval=1800, freshness_seconds=10,
                 claim_ttl_seconds=15):
        if not math.isfinite(min_followup_interval) or min_followup_interval < 1800:
            raise ValueError("min_followup_interval must be at least 1800 seconds")
        if not math.isfinite(freshness_seconds) or freshness_seconds <= 0:
            raise ValueError("freshness_seconds must be positive")
        if not math.isfinite(claim_ttl_seconds) or claim_ttl_seconds <= 0:
            raise ValueError("claim_ttl_seconds must be positive")
        self.clock = clock
        self.min_followup_interval = float(min_followup_interval)
        self.freshness_seconds = float(freshness_seconds)
        self.claim_ttl_seconds = float(claim_ttl_seconds)
        self.db = sqlite3.connect(str(db_path), timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                account_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'ACTIVE', resume_state TEXT,
                stop_reason TEXT, last_limit_at REAL,
                latest_event_id TEXT, latest_event_at REAL,
                needs_response INTEGER NOT NULL DEFAULT 0,
                last_sent_at REAL, next_followup_at REAL,
                created_at REAL NOT NULL, updated_at REAL NOT NULL,
                PRIMARY KEY(account_id, conversation_id)
            );
            CREATE TABLE IF NOT EXISTS events (
                account_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                event_id TEXT NOT NULL, type TEXT NOT NULL,
                timestamp REAL, detected_at REAL NOT NULL,
                timestamp_source TEXT NOT NULL, evidence TEXT NOT NULL,
                PRIMARY KEY(account_id, event_id),
                FOREIGN KEY(account_id, conversation_id)
                    REFERENCES conversations(account_id, conversation_id)
            );
            CREATE TABLE IF NOT EXISTS outbox (
                intent_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL, kind TEXT NOT NULL,
                source_event_id TEXT NOT NULL, payload TEXT NOT NULL,
                status TEXT NOT NULL, created_at REAL NOT NULL,
                expires_at REAL NOT NULL, owner TEXT, claimed_at REAL,
                lease_until REAL, browser_session_id TEXT, submitted_at REAL,
                confirmed_at REAL, evidence TEXT, error TEXT,
                FOREIGN KEY(account_id, conversation_id)
                    REFERENCES conversations(account_id, conversation_id)
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL,
                account_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                action TEXT NOT NULL, detail TEXT NOT NULL
            );
        """)
        # UNKNOWN is retained per original operation. Only explicitly qualified
        # text policies may coexist with old card uncertainty; all pending UI
        # submissions still share one durable conversation lease.
        with self._tx():
            index = self.db.execute("SELECT sql FROM sqlite_master WHERE type='index' AND name='one_unsettled_per_conversation'").fetchone()
            if index is None or "UNKNOWN" in index["sql"].upper():
                self.db.execute("DROP INDEX IF EXISTS one_unsettled_per_conversation")
                self.db.execute("CREATE UNIQUE INDEX one_unsettled_per_conversation ON outbox(account_id,conversation_id) "
                                "WHERE status IN ('PREPARED','CLAIMED','SUBMITTING')")
        self._repair_legacy_inferred_human_holds()

    def _repair_legacy_inferred_human_holds(self):
        """Make legacy inferred operator replies turn-scoped, never permanent.

        Older receivers labelled any right-side message without an AI label as
        HUMAN_TAKEOVER. Those rows did not prove a continuing manual takeover;
        after a later customer message they blocked every following turn. A
        new inbound turn now belongs to automation unless an explicit human
        control event says otherwise. This repair is idempotent and audit-only.
        """
        with self._tx():
            conversations = self.db.execute("SELECT * FROM conversations WHERE state='HUMAN'").fetchall()
            for con in conversations:
                controls = self.db.execute(
                    "SELECT * FROM events WHERE account_id=? AND conversation_id=? "
                    "AND type IN ('HUMAN_TAKEOVER','HUMAN_RELEASE') ORDER BY timestamp,detected_at",
                    (con["account_id"], con["conversation_id"]),
                ).fetchall()
                takeovers = [row for row in controls if row["type"] == "HUMAN_TAKEOVER"]
                if not takeovers:
                    continue
                inferred = []
                explicit = False
                for takeover in takeovers:
                    proof = json.loads(takeover["evidence"])
                    if proof.get("ownership_reason") == "native_non_ai_outbound_from_other_operator":
                        inferred.append(takeover)
                    else:
                        explicit = True
                if explicit or not inferred:
                    continue

                latest_inbound = None
                for event in self.db.execute(
                    "SELECT * FROM events WHERE account_id=? AND conversation_id=? "
                    "AND type IN ('NEW_VISITOR','CUSTOMER_MESSAGE') ORDER BY timestamp DESC,detected_at DESC",
                    (con["account_id"], con["conversation_id"]),
                ):
                    proof = json.loads(event["evidence"])
                    if proof.get("historical_baseline") is not True and event["timestamp"] is not None:
                        latest_inbound = event
                        break
                latest_outbound = None
                for event in self.db.execute(
                    "SELECT * FROM events WHERE account_id=? AND conversation_id=? AND type='OUTBOUND_OBSERVED' "
                    "ORDER BY timestamp DESC,detected_at DESC",
                    (con["account_id"], con["conversation_id"]),
                ):
                    proof = json.loads(event["evidence"])
                    if proof.get("historical_baseline") is not True and event["timestamp"] is not None:
                        latest_outbound = event
                        break
                if latest_inbound is None:
                    continue

                latest_inferred = max(inferred, key=lambda row: (row["timestamp"] or float("-inf"), row["detected_at"]))
                needs_response = int(latest_outbound is None or latest_outbound["timestamp"] < latest_inbound["timestamp"])
                should_release = latest_inbound["timestamp"] > latest_inferred["timestamp"]
                changes = {"updated_at": self._now()}
                if should_release:
                    changes.update(state=con["resume_state"] or "ACTIVE", resume_state=None)
                if needs_response != con["needs_response"]:
                    changes["needs_response"] = needs_response
                if len(changes) == 1:
                    continue
                assignments = ",".join(key + "=?" for key in changes)
                self.db.execute(
                    "UPDATE conversations SET " + assignments + " WHERE account_id=? AND conversation_id=?",
                    tuple(changes.values()) + (con["account_id"], con["conversation_id"]),
                )
                self._audit(con["account_id"], con["conversation_id"], "LEGACY_INFERRED_OWNERSHIP_NORMALIZED",
                            {"reason": "newer_customer_turn" if should_release else "answered_inferred_turn"})
    def recover_inflight(self, *, exclusive_worker_owner):
        """Call only after acquiring exclusive runtime ownership, never from readers.

        A nonempty owner is an audit identifier, not an operating-system lock.
        The future worker must obtain its actual process lock before calling.
        """
        _identifier(exclusive_worker_owner, "exclusive_worker_owner")
        recovered = []
        with self._tx():
            for row in self.db.execute("SELECT * FROM outbox WHERE status='SUBMITTING'").fetchall():
                self.db.execute("UPDATE outbox SET status='UNKNOWN', error=? WHERE intent_id=?",
                                ("process reopened during submission; reconcile before any retry", row["intent_id"]))
                self._audit(row["account_id"], row["conversation_id"], "RECOVERY_UNKNOWN",
                            {"intent_id": row["intent_id"], "recovery_owner": exclusive_worker_owner})
                recovered.append(row["intent_id"])
        return recovered

    def close(self):
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    @contextmanager
    def _tx(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        else:
            self.db.execute("COMMIT")

    def _now(self):
        return _number(self.clock(), "clock")

    def _audit(self, account, conversation, action, detail):
        safe_fields = {"event_id", "type", "platform_timestamp", "detected_at", "timestamp_source",
                       "intent_id", "kind", "owner", "recovery_owner", "reason", "historical_baseline",
                       "source_event_id", "reviewer", "classification", "reference"}
        safe = {key: value for key, value in detail.items() if key in safe_fields}
        if isinstance(detail.get("evidence"), dict):
            safe["evidence"] = {key: value for key, value in detail["evidence"].items()
                                if key in {"source", "reference", "observed_at", "account_id", "conversation_id", "intent_id"}}
        self.db.execute("INSERT INTO audit_log(at,account_id,conversation_id,action,detail) VALUES(?,?,?,?,?)",
                        (self._now(), account, conversation, action, json.dumps(safe, ensure_ascii=False)))

    def _conversation(self, account, conversation):
        row = self.db.execute("SELECT * FROM conversations WHERE account_id=? AND conversation_id=?",
                              (account, conversation)).fetchone()
        if row is None:
            raise NotEligible("conversation has not been observed")
        return row

    def _intent(self, intent_id):
        row = self.db.execute("SELECT * FROM outbox WHERE intent_id=?", (intent_id,)).fetchone()
        if row is None:
            raise InvalidTransition("unknown intent")
        return row

    def _cancel_unsubmitted(self, account, conversation, reason):
        rows = self.db.execute("SELECT intent_id FROM outbox WHERE account_id=? AND conversation_id=? AND status IN ('PREPARED','CLAIMED')",
                               (account, conversation)).fetchall()
        self.db.execute("UPDATE outbox SET status='CANCELLED',error=? WHERE account_id=? AND conversation_id=? AND status IN ('PREPARED','CLAIMED')",
                        (reason, account, conversation))
        for row in rows:
            self._audit(account, conversation, "INTENT_CANCELLED", {"intent_id": row["intent_id"], "reason": reason})

    def _observed_evidence(self, evidence, account_id, conversation_id, *, intent_id=None, after=None):
        if not isinstance(evidence, dict) or evidence.get("source") not in EVIDENCE_SOURCES:
            raise ValueError("requires evidence source platform_ui or official_api")
        if evidence.get("account_id") != account_id or evidence.get("conversation_id") != conversation_id:
            raise ValueError("evidence must match the target account and conversation")
        if intent_id is not None and evidence.get("intent_id") != intent_id:
            raise ValueError("evidence must identify the exact outgoing intent")
        _identifier(evidence.get("reference"), "evidence.reference")
        observed = _number(evidence.get("observed_at"), "evidence.observed_at")
        if observed > self._now() + 1:
            raise ValueError("evidence cannot come from the future")
        if after is not None and observed <= after:
            raise ValueError("evidence must be newer than the blocking observation")
        if evidence.get("probe_send"):
            raise ValueError("trial sending is not eligibility evidence")
        return observed

    def _human_owned(self, controls, account, conversation):
        """Order clearly old native output separately from its later discovery.

        The ten-second minimum is a conservative ownership uncertainty window,
        never a tolerance for matching a sent message or its server receipt.
        All unbound/near-boundary controls retain their observation-time hold.
        """
        takeovers, releases = [], []
        latest_event = self.db.execute(
            "SELECT e.type,e.timestamp FROM events e JOIN conversations c "
            "ON c.account_id=e.account_id AND c.conversation_id=e.conversation_id "
            "WHERE c.account_id=? AND c.conversation_id=? AND e.event_id=c.latest_event_id",
            (account, conversation),
        ).fetchone()
        later_nonhistorical_inbound = None
        if latest_event is not None and latest_event["type"] in ("NEW_VISITOR", "CUSTOMER_MESSAGE"):
            latest_proof = self.db.execute(
                "SELECT evidence FROM events WHERE account_id=? AND conversation_id=? AND event_id="
                "(SELECT latest_event_id FROM conversations WHERE account_id=? AND conversation_id=?)",
                (account, conversation, account, conversation),
            ).fetchone()
            if latest_proof is not None and json.loads(latest_proof["evidence"]).get("historical_baseline") is not True:
                later_nonhistorical_inbound = latest_event["timestamp"]
        for control in controls:
            if control["type"] not in ("HUMAN_TAKEOVER", "HUMAN_RELEASE"):
                continue
            proof = json.loads(control["evidence"])
            at = self._observed_evidence(proof, account, conversation)
            if control["type"] == "HUMAN_RELEASE":
                if proof.get("explicit_release") is True:
                    releases.append((at, proof))
            else:
                takeovers.append((control, proof, at))
        for control, proof, observed in takeovers:
            detected = _number(control["detected_at"], "control.detected_at")
            native = proof.get("native_message_id")
            timestamp = control["timestamp"]
            prefixes = ("jarvis-msg-" + account + "." + conversation + ".",
                        "jarvis-msg-" + conversation + "." + account + ".")
            prefix = next((value for value in prefixes if isinstance(native, str) and native.startswith(value)), None)
            bound_native = (proof.get("source") == "platform_ui" and proof.get("timestamp_source") == "platform_ui"
                            and control["timestamp_source"] == "platform_ui" and type(timestamp) in (int, float)
                            and math.isfinite(timestamp) and 0 <= timestamp <= detected + 1 and observed == detected
                            and proof.get("ownership_reason") == "native_non_ai_outbound_from_other_operator"
                            and prefix is not None and re.fullmatch(r"[A-Za-z0-9_-]{1,256}", native[len(prefix):]) is not None
                            and control["event_id"] == "external-operator:" + native
                            and proof.get("reference") == "id_" + native[len("jarvis-msg-"):])
            if (bound_native and later_nonhistorical_inbound is not None
                    and later_nonhistorical_inbound > timestamp):
                continue
            def covers(release):
                at, evidence = release
                if at > max(observed, detected):
                    return True
                authorization = evidence.get("authorization_reference")
                return (bound_native and evidence.get("authorization_source") == "direct_human_instruction"
                        and isinstance(authorization, str) and 0 < len(authorization.strip()) <= 2048
                        and at > timestamp + max(10.0, self.freshness_seconds))
            if not any(covers(release) for release in releases):
                return True
        return False

    def _reception_event(self, account_id, conversation_id, event_id, observed_at):
        """Associate a real receipt with an explicitly identified platform entry."""
        _identifier(event_id, "reception_event_id")
        event = self.db.execute("SELECT * FROM events WHERE account_id=? AND conversation_id=? AND event_id=? AND type='NEW_VISITOR'",
                                (account_id, conversation_id, event_id)).fetchone()
        if event is None:
            raise ValueError("reception_event_id must identify this conversation's observed NEW_VISITOR")
        if event["timestamp"] is not None and observed_at < event["timestamp"]:
            raise ValueError("receipt cannot precede its platform entry")
        return event

    def _reception_assignment(self, row, evidence, observed_at):
        """A single outgoing operation can belong to at most one real entry."""
        source = self.db.execute("SELECT * FROM events WHERE account_id=? AND conversation_id=? AND event_id=?",
                                 (row["account_id"], row["conversation_id"], row["source_event_id"])).fetchone()
        explicit = evidence.get("reception_event_id")
        if source["type"] == "NEW_VISITOR":
            if explicit is not None and explicit != source["event_id"]:
                raise ValueError("an operation sourced from NEW_VISITOR cannot be assigned to another entry")
            return source["event_id"]
        if explicit is None:
            return None
        if source["type"] != "CUSTOMER_MESSAGE":
            raise ValueError("only CUSTOMER_MESSAGE may explicitly link an operation to its original entry")
        entry = self._reception_event(row["account_id"], row["conversation_id"], explicit, observed_at)
        return entry["event_id"]

    def ingest_event(self, event):
        if not isinstance(event, Event):
            raise TypeError("event must be Event")
        for name in ("account_id", "conversation_id", "event_id"):
            _identifier(getattr(event, name), name)
        if event.type not in EVENT_TYPES:
            raise ValueError("unsupported event type")
        now = self._now()
        detected = now if event.detected_at is None else _number(event.detected_at, "detected_at")
        timestamp = None if event.timestamp is None else _number(event.timestamp, "timestamp")
        if detected > now + 1 or (timestamp is not None and timestamp > now + 1):
            raise ValueError("event cannot come from the future")
        if timestamp is not None and timestamp > detected + 1:
            raise ValueError("platform timestamp cannot follow detection")
        evidence = dict(event.evidence)
        # Serialize before the transaction so unsupported payloads cannot partially apply.
        serialized = json.dumps(evidence, ensure_ascii=False, allow_nan=False)
        source = evidence.get("timestamp_source", "unknown")
        if timestamp is None:
            source = "unknown"
        with self._tx():
            existing = self.db.execute("SELECT conversation_id FROM events WHERE account_id=? AND event_id=?",
                                       (event.account_id, event.event_id)).fetchone()
            if existing:
                if existing["conversation_id"] != event.conversation_id:
                    raise ValueError("event ID already belongs to another conversation")
                return {"duplicate": True, "conversation": dict(self._conversation(event.account_id, event.conversation_id))}
            self.db.execute("INSERT OR IGNORE INTO conversations(account_id,conversation_id,created_at,updated_at) VALUES(?,?,?,?)",
                            (event.account_id, event.conversation_id, now, now))
            con = self._conversation(event.account_id, event.conversation_id)
            if event.type == "OUTBOUND_OBSERVED":
                observed = self._observed_evidence(evidence, event.account_id, event.conversation_id)
                if timestamp is None or evidence.get("source") != "platform_ui" or source != "platform_ui":
                    raise ValueError("native outbound observation requires a known platform_ui timestamp and source")
                _identifier(evidence.get("native_message_id"), "evidence.native_message_id")
                if timestamp > observed + 1:
                    raise ValueError("native outbound timestamp cannot follow its observation")
            if event.type == "PLATFORM_TAKEOVER_CONFIRMED":
                observed = self._observed_evidence(evidence, event.account_id, event.conversation_id)
                if evidence.get("taken_over") is not True:
                    raise ValueError("platform takeover requires a positive native UI/API receipt")
                self._reception_event(event.account_id, event.conversation_id,
                                      evidence.get("source_event_id"), observed)
            if event.type in ("PLATFORM_LIMIT", "REFUSED", "HUMAN_TAKEOVER", "HUMAN_RELEASE"):
                # Control events come from observed UI/API state, never instructions
                # embedded in a customer's message or an LLM-generated conclusion.
                self._observed_evidence(evidence, event.account_id, event.conversation_id)
            if event.type == "SEND_ELIGIBLE":
                observed = self._observed_evidence(evidence, event.account_id, event.conversation_id, after=con["last_limit_at"])
                if evidence.get("allowed") is not True:
                    raise ValueError("SEND_ELIGIBLE requires an explicit allowed observation")
                if now - observed > self.freshness_seconds:
                    raise ValueError("eligibility observation is stale")
            if event.type in ("WECHAT_VERIFIED", "LEAD_VERIFIED"):
                self._observed_evidence(evidence, event.account_id, event.conversation_id)
                if evidence.get("verified") is not True:
                    raise ValueError("lead outcomes require verified evidence")
            if event.type == "HUMAN_RELEASE" and evidence.get("explicit_release") is not True:
                raise ValueError("HUMAN_RELEASE must be explicit")
            if event.type == "HUMAN_RELEASE" and con["state"] == "HUMAN":
                takeovers = self.db.execute("SELECT * FROM events WHERE account_id=? AND conversation_id=? AND type='HUMAN_TAKEOVER'",
                                           (event.account_id, event.conversation_id)).fetchall()
                if not takeovers:
                    raise ValueError("cannot establish current human ownership round; observe a fresh takeover first")
                if self._human_owned([*takeovers, {"type": "HUMAN_RELEASE", "evidence": serialized}],
                                     event.account_id, event.conversation_id):
                    raise ValueError("evidence must be newer than the blocking observation")
            self.db.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)",
                            (event.account_id, event.conversation_id, event.event_id, event.type,
                             timestamp, detected, source, serialized))
            state, resume = con["state"], con["resume_state"]
            changes = {"updated_at": now}
            event_at = timestamp if timestamp is not None else detected
            if event.type in ("NEW_VISITOR", "CUSTOMER_MESSAGE"):
                if con["latest_event_at"] is None or event_at >= con["latest_event_at"]:
                    changes.update(latest_event_id=event.event_id, latest_event_at=event_at)
                    if evidence.get("historical_baseline") is not True:
                        changes["needs_response"] = 1
                    self._cancel_unsubmitted(event.account_id, event.conversation_id, "new inbound event supersedes unsent work")
                if state == "HUMAN":
                    controls = self.db.execute(
                        "SELECT * FROM events WHERE account_id=? AND conversation_id=? "
                        "AND type IN ('HUMAN_TAKEOVER','HUMAN_RELEASE')",
                        (event.account_id, event.conversation_id),
                    ).fetchall()
                    inferred = [control for control in controls if control["type"] == "HUMAN_TAKEOVER" and
                                json.loads(control["evidence"]).get("ownership_reason") ==
                                "native_non_ai_outbound_from_other_operator"]
                    explicit = [control for control in controls if control["type"] == "HUMAN_TAKEOVER" and control not in inferred]
                    latest_inferred = max(inferred, key=lambda row: (row["timestamp"] or float("-inf"), row["detected_at"])) if inferred else None
                    if (latest_inferred is not None and not explicit and evidence.get("historical_baseline") is not True
                            and event_at > latest_inferred["timestamp"]):
                        changes.update(state=resume or "ACTIVE", resume_state=None)
                # Explicit human ownership and unresolved submissions are preserved.
            elif event.type == "OUTBOUND_OBSERVED":
                last_sent = max(con["last_sent_at"], timestamp) if con["last_sent_at"] is not None else timestamp
                changes["last_sent_at"] = last_sent
                if state == "ACTIVE":
                    baseline = last_sent + self.min_followup_interval
                    changes["next_followup_at"] = max(con["next_followup_at"], baseline) if con["next_followup_at"] is not None else baseline
                if (con["latest_event_id"] is not None and evidence.get("responds_to_event_id") == con["latest_event_id"]
                        and con["latest_event_at"] is not None and timestamp >= con["latest_event_at"]):
                    changes["needs_response"] = 0
                    if con["needs_response"]:
                        self._cancel_unsubmitted(event.account_id, event.conversation_id,
                                                 "native outbound explicitly answers current inbound")
                # This is a throttle baseline, never confirmation of our outbox.
            elif event.type in ("WECHAT_VERIFIED", "LEAD_VERIFIED", "REFUSED"):
                changes.update(state="STOPPED", stop_reason=event.type, resume_state=None,
                               needs_response=0, next_followup_at=None)
                self._cancel_unsubmitted(event.account_id, event.conversation_id, event.type)
            elif event.type == "HUMAN_TAKEOVER" and state != "STOPPED":
                controls = self.db.execute("SELECT * FROM events WHERE account_id=? AND conversation_id=? AND type IN ('HUMAN_TAKEOVER','HUMAN_RELEASE')",
                                           (event.account_id, event.conversation_id)).fetchall()
                if self._human_owned(controls, event.account_id, event.conversation_id):
                    changes.update(state="HUMAN", resume_state=resume if state == "HUMAN" else state)
                    self._cancel_unsubmitted(event.account_id, event.conversation_id, "human takeover")
            elif event.type == "HUMAN_RELEASE" and state == "HUMAN":
                changes.update(state=resume or "ACTIVE", resume_state=None)
            elif event.type == "PLATFORM_LIMIT" and state != "STOPPED":
                # The local time when the block became known is deliberately conservative.
                changes.update(last_limit_at=now)
                if state == "HUMAN":
                    changes.update(resume_state="PAUSED_LIMIT")
                else:
                    changes.update(state="PAUSED_LIMIT")
                self._cancel_unsubmitted(event.account_id, event.conversation_id, "platform limit")
            elif event.type == "SEND_ELIGIBLE" and state != "STOPPED":
                if state == "HUMAN" and resume == "PAUSED_LIMIT":
                    changes.update(resume_state="ACTIVE")
                elif state == "PAUSED_LIMIT":
                    changes.update(state="ACTIVE")
                # Drop the old response; evaluate at most one current followup when eligible.
                if state == "PAUSED_LIMIT" or resume == "PAUSED_LIMIT":
                    self._cancel_unsubmitted(event.account_id, event.conversation_id, "fresh eligibility requires reevaluation")
                    changes.update(needs_response=con["needs_response"])
                    if con["last_sent_at"] is not None:
                        changes.update(next_followup_at=max(now, con["last_sent_at"] + self.min_followup_interval))
            assignments = ",".join(key + "=?" for key in changes)
            self.db.execute("UPDATE conversations SET " + assignments + " WHERE account_id=? AND conversation_id=?",
                            tuple(changes.values()) + (event.account_id, event.conversation_id))
            self._audit(event.account_id, event.conversation_id, "EVENT_INGESTED",
                        {"event_id": event.event_id, "type": event.type,
                         "platform_timestamp": timestamp, "detected_at": detected, "timestamp_source": source,
                         "historical_baseline": evidence.get("historical_baseline") is True})
            return {"duplicate": False, "conversation": dict(self._conversation(event.account_id, event.conversation_id))}

    def _active(self, con):
        if con["state"] != "ACTIVE":
            raise NotEligible("conversation is " + con["state"])

    def _bound_prior_card_unknowns(self, con, source_id, kind, payload=None):
        rows = self.db.execute("SELECT * FROM outbox WHERE account_id=? AND conversation_id=? AND status='UNKNOWN' ORDER BY intent_id",
                               (con["account_id"], con["conversation_id"])).fetchall()
        source = self.db.execute("SELECT timestamp FROM events WHERE account_id=? AND conversation_id=? AND event_id=?",
                                (con["account_id"], con["conversation_id"], source_id)).fetchone()
        for row in rows:
            proof = json.loads(row["evidence"] or "{}")
            raw, native = proof.get("native_message_raw_id"), proof.get("native_message_id")
            prefixes = (con["account_id"] + "." + con["conversation_id"] + ".", con["conversation_id"] + "." + con["account_id"] + ".")
            prior_source = self.db.execute("SELECT timestamp FROM events WHERE account_id=? AND conversation_id=? AND event_id=?",
                                           (con["account_id"], con["conversation_id"], row["source_event_id"])).fetchone()
            if (row["kind"] != "card" or json.loads(row["payload"]).get("operation") != "native_card"
                    or row["submitted_at"] is None or not isinstance(raw, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,256}", raw) is None
                    or not isinstance(native, str) or not any(native == "jarvis-msg-" + prefix + raw for prefix in prefixes)
                    or proof.get("source") != "platform_ui"
                    or proof.get("account_id") != con["account_id"] or proof.get("conversation_id") != con["conversation_id"]
                    or proof.get("intent_id") != row["intent_id"] or prior_source is None
                    or kind == "service_reply" and (source is None or source["timestamp"] is None or source["timestamp"] <= row["submitted_at"])
                    or kind == "correction_reply" and row["source_event_id"] != source_id):
                raise NotEligible(kind + "_unresolved_outgoing")
        ids = [row["intent_id"] for row in rows]
        if payload is not None and payload.get("prior_unknown_hold_ids", []) != ids:
            raise NotEligible(kind + "_prior_unknown_binding_changed")
        return ids

    def _service_reply_checks(self, con, source_id, payload=None, *, exclude_intent_id=None):
        """One exact customer-initiated text, never acquisition or a proactive followup."""
        def require(ok, reason):
            if not ok:
                raise NotEligible("service_reply_" + reason)
        account, conversation = con["account_id"], con["conversation_id"]
        stopped_lead = con["state"] == "STOPPED" and con["stop_reason"] in ("WECHAT_VERIFIED", "LEAD_VERIFIED")
        require(con["state"] == "ACTIVE" or stopped_lead, "active_or_verified_lead_required")
        require(con["needs_response"] == 1 and source_id == con["latest_event_id"], "current_unanswered_source_required")
        require(not any(not self._correction_consumed(row) for row in self._reviewed_corrections(con)), "independent_correction_required")
        event = self.db.execute("SELECT * FROM events WHERE account_id=? AND conversation_id=? AND event_id=?",
                                (account, conversation, source_id)).fetchone()
        require(event is not None and event["type"] == "CUSTOMER_MESSAGE", "customer_message_required")
        proof = json.loads(event["evidence"])
        prefix = next((prefix for prefix in ("id_" + account + "." + conversation + ".", "id_" + conversation + "." + account + ".")
                       if source_id.startswith(prefix)), None)
        require(prefix is not None and re.fullmatch(r"[A-Za-z0-9_-]{1,256}", source_id[len(prefix):]) is not None,
                "native_source_id_required")
        require(event["timestamp"] is not None and event["timestamp_source"] == "platform_ui"
                and event["timestamp"] == con["latest_event_at"] and proof.get("source") == "platform_ui"
                and proof.get("timestamp_source") == "platform_ui" and proof.get("account_id") == account
                and proof.get("conversation_id") == conversation and proof.get("reference") == source_id
                and proof.get("native_message_id") == "jarvis-msg-" + source_id[3:]
                and proof.get("native_message_type") == "TEXT" and proof.get("native_direction") == "left"
                and proof.get("historical_baseline") is False and proof.get("observed_at") == event["detected_at"],
                "fresh_native_customer_source_required")
        original = proof.get("untrusted_message_text")
        require(isinstance(original, str) and bool(original.strip()) and len(original) <= 4000, "source_text_required")
        controls = self.db.execute("SELECT * FROM events WHERE account_id=? AND conversation_id=? AND type IN "
                                   "('WECHAT_VERIFIED','LEAD_VERIFIED','REFUSED','HUMAN_TAKEOVER','HUMAN_RELEASE','PLATFORM_LIMIT','SEND_ELIGIBLE')",
                                   (account, conversation)).fetchall()
        observed = {}
        for control in controls:
            evidence = json.loads(control["evidence"])
            try:
                at = self._observed_evidence(evidence, account, conversation)
            except (ValueError, TypeError):
                raise NotEligible("service_reply_invalid_control_evidence")
            observed.setdefault(control["type"], []).append((at, evidence))
        verified = [at for kind in ("WECHAT_VERIFIED", "LEAD_VERIFIED") for at, evidence in observed.get(kind, [])
                    if evidence.get("verified") is True]
        if stopped_lead:
            require(bool(verified) and event["timestamp"] > min(verified), "question_must_follow_verified_lead")
        else:
            prior_texts = self.db.execute("SELECT * FROM outbox WHERE account_id=? AND conversation_id=? AND status='SENT' "
                                         "AND source_event_id!=? AND submitted_at<?",
                                         (account, conversation, source_id, event["timestamp"])).fetchall()
            prior_confirmed = False
            for prior in prior_texts:
                try:
                    self._strict_quality_original(prior, prior["source_event_id"])
                except NotEligible:
                    continue
                prior_confirmed = True
                break
            require(prior_confirmed, "prior_strict_text_round_required")
        require(not observed.get("REFUSED"), "refused")
        require(not self._human_owned(controls, account, conversation), "human_owned")
        if observed.get("PLATFORM_LIMIT"):
            limited = max(at for at, _ in observed["PLATFORM_LIMIT"])
            require(any(at > limited and evidence.get("allowed") is True and self._now() - at <= self.freshness_seconds
                        for at, evidence in observed.get("SEND_ELIGIBLE", [])), "platform_limit")
        prior_unknowns = self._bound_prior_card_unknowns(con, source_id, "service_reply", payload)
        require(self.db.execute("SELECT 1 FROM outbox WHERE account_id=? AND conversation_id=? AND kind='service_reply' "
                                "AND source_event_id=? AND submitted_at IS NOT NULL AND intent_id!=?",
                                (account, conversation, source_id, exclude_intent_id or "")).fetchone() is None, "already_submitted")
        require(self.db.execute("SELECT 1 FROM outbox WHERE account_id=? AND conversation_id=? AND "
                                "status IN ('PREPARED','CLAIMED','SUBMITTING') AND intent_id!=?",
                                (account, conversation, exclude_intent_id or "")).fetchone() is None, "unresolved_outgoing")
        if payload is not None:
            require(set(payload) - {"prior_unknown_hold_ids"} == {"operation", "text", "text_only_service", "source_message_text"}
                    and payload.get("operation") == "text" and payload.get("text_only_service") is True
                    and isinstance(payload.get("text"), str) and 0 < len(payload["text"]) <= 500
                    and payload.get("source_message_text") == original, "exact_text_only_payload_required")
        return {"eligible": True, "source_event_id": source_id, "first_verified_lead_observed_at": min(verified) if verified else None,
                "prior_unknown_hold_ids": prior_unknowns,
                "latest_control_observed_at": max([event["detected_at"]] + [at for values in observed.values() for at, _ in values])}

    def _service_reply_status(self, con):
        try:
            return self._service_reply_checks(con, con["latest_event_id"])
        except NotEligible as error:
            try:
                ids = self._bound_prior_card_unknowns(con, con["latest_event_id"], "service_reply")
            except NotEligible:
                ids = []
            return {"eligible": False, "source_event_id": con["latest_event_id"], "reason": str(error), "prior_unknown_hold_ids": ids}

    def _quality_source_text(self, account, conversation, source_id):
        event = self.db.execute("SELECT * FROM events WHERE account_id=? AND conversation_id=? AND event_id=?",
                                (account, conversation, source_id)).fetchone()
        if event is None or event["type"] != "CUSTOMER_MESSAGE":
            raise NotEligible("correction_reply_customer_message_required")
        proof = json.loads(event["evidence"])
        prefix = next((value for value in ("id_" + account + "." + conversation + ".", "id_" + conversation + "." + account + ".")
                       if source_id.startswith(value)), None)
        text = proof.get("untrusted_message_text")
        if (prefix is None or re.fullmatch(r"[A-Za-z0-9_-]{1,256}", source_id[len(prefix):]) is None
                or event["timestamp"] is None or event["timestamp_source"] != "platform_ui"
                or proof.get("source") != "platform_ui" or proof.get("timestamp_source") != "platform_ui"
                or proof.get("account_id") != account or proof.get("conversation_id") != conversation
                or proof.get("reference") != source_id or proof.get("native_message_id") != "jarvis-msg-" + source_id[3:]
                or proof.get("native_message_type") != "TEXT" or proof.get("native_direction") != "left"
                or proof.get("historical_baseline") is not False or proof.get("observed_at") != event["detected_at"]
                or not isinstance(text, str) or not text.strip() or len(text) > 4000):
            raise NotEligible("correction_reply_exact_native_customer_source_required")
        return text

    def _strict_quality_original(self, row, source_id):
        proof = json.loads(row["evidence"] or "{}")
        history = proof.get("native_server_history", {})
        native = proof.get("native_message_id")
        raw = proof.get("native_message_raw_id")
        prefixes = (row["account_id"] + "." + row["conversation_id"] + ".", row["conversation_id"] + "." + row["account_id"] + ".")
        if (row["status"] != "SENT" or row["kind"] not in ("initial", "reply", "service_reply")
                or row["source_event_id"] != source_id or json.loads(row["payload"]).get("operation") != "text"
                or row["submitted_at"] is None or row["confirmed_at"] is None
                or proof.get("source") != "platform_ui" or proof.get("account_id") != row["account_id"]
                or proof.get("conversation_id") != row["conversation_id"] or proof.get("intent_id") != row["intent_id"]
                or not isinstance(history, dict) or history.get("status") != "server_history_confirmed"
                or history.get("verifier_version") != 7 or history.get("operation") != "text"
                or not isinstance(raw, str) or not raw or not isinstance(native, str)
                or not any(native == "jarvis-msg-" + prefix + raw for prefix in prefixes)
                or history.get("native_message_id") != native[len("jarvis-msg-"):]):
            raise NotEligible("quality_review_strict_sent_text_required")
        return proof

    def _reviewed_corrections(self, con):
        rows = self.db.execute("SELECT * FROM outbox WHERE account_id=? AND conversation_id=? AND source_event_id=? AND status='SENT'",
                               (con["account_id"], con["conversation_id"], con["latest_event_id"])).fetchall()
        return [row for row in rows if isinstance(json.loads(row["evidence"] or "{}").get("quality_review"), dict)
                and json.loads(row["evidence"])["quality_review"].get("classification") == "not_useful"]

    def _correction_consumed(self, original, exclude_intent_id=None):
        rows = self.db.execute("SELECT payload FROM outbox WHERE account_id=? AND conversation_id=? AND kind='correction_reply' AND submitted_at IS NOT NULL AND intent_id!=?",
                               (original["account_id"], original["conversation_id"], exclude_intent_id or "")).fetchall()
        return any(json.loads(row["payload"]).get("correction_of_intent_id") == original["intent_id"] for row in rows)

    def _correction_reply_checks(self, con, source_id, payload=None, *, exclude_intent_id=None):
        def require(ok, reason):
            if not ok:
                raise NotEligible("correction_reply_" + reason)
        account, conversation = con["account_id"], con["conversation_id"]
        require(con["state"] == "ACTIVE", "active_conversation_required")
        require(con["needs_response"] == 1 and source_id == con["latest_event_id"], "current_unanswered_source_required")
        text = self._quality_source_text(account, conversation, source_id)
        originals = self._reviewed_corrections(con)
        require(len(originals) == 1, "independent_review_required")
        original = originals[0]
        proof = self._strict_quality_original(original, source_id)
        review = proof["quality_review"]
        require(review.get("source") == "independent_audit" and review.get("intent_id") == original["intent_id"]
                and review.get("source_event_id") == source_id and proof.get("usefulness_verified") is True
                and proof.get("useful") is False, "independent_review_required")
        audits = self.db.execute("SELECT detail FROM audit_log WHERE account_id=? AND conversation_id=? AND action='REPLY_QUALITY_REVIEWED'",
                                (account, conversation)).fetchall()
        require(any(all(json.loads(row["detail"]).get(key) == expected for key, expected in {
            "intent_id": original["intent_id"], "source_event_id": source_id, "reviewer": review.get("reviewer"),
            "classification": "not_useful", "reference": review.get("reference")}.items()) for row in audits), "independent_review_audit_required")
        require(not self._correction_consumed(original, exclude_intent_id), "already_submitted")
        prior_unknowns = self._bound_prior_card_unknowns(con, source_id, "correction_reply", payload)
        controls = self.db.execute("SELECT * FROM events WHERE account_id=? AND conversation_id=? AND type IN "
                                   "('REFUSED','HUMAN_TAKEOVER','HUMAN_RELEASE','PLATFORM_LIMIT','SEND_ELIGIBLE')", (account, conversation)).fetchall()
        observed = {}
        for control in controls:
            evidence = json.loads(control["evidence"])
            at = self._observed_evidence(evidence, account, conversation)
            observed.setdefault(control["type"], []).append((at, evidence))
        require(not observed.get("REFUSED"), "refused")
        require(not self._human_owned(controls, account, conversation), "human_owned")
        if observed.get("PLATFORM_LIMIT"):
            limited = max(at for at, _ in observed["PLATFORM_LIMIT"])
            require(any(at > limited and evidence.get("allowed") is True and self._now() - at <= self.freshness_seconds
                        for at, evidence in observed.get("SEND_ELIGIBLE", [])), "platform_limit")
        require(self.db.execute("SELECT 1 FROM outbox WHERE account_id=? AND conversation_id=? AND status IN "
                                "('PREPARED','CLAIMED','SUBMITTING') AND intent_id!=?",
                                (account, conversation, exclude_intent_id or "")).fetchone() is None, "unresolved_outgoing")
        if payload is not None:
            require(set(payload) - {"prior_unknown_hold_ids"} == {"operation", "text", "correction_of_intent_id", "source_message_text"}
                    and payload.get("operation") == "text" and payload.get("correction_of_intent_id") == original["intent_id"]
                    and payload.get("source_message_text") == text and isinstance(payload.get("text"), str)
                    and 0 < len(payload["text"]) <= 500 and payload["text"].strip() != json.loads(original["payload"]).get("text", "").strip(), "exact_text_only_payload_required")
        return {"eligible": True, "source_event_id": source_id, "correction_of_intent_id": original["intent_id"],
                "prior_unknown_hold_ids": prior_unknowns,
                "latest_control_observed_at": max([review["observed_at"]] + [at for values in observed.values() for at, _ in values])}

    def _correction_reply_status(self, con):
        try:
            return self._correction_reply_checks(con, con["latest_event_id"])
        except (NotEligible, ValueError) as error:
            originals = self._reviewed_corrections(con)
            try:
                ids = self._bound_prior_card_unknowns(con, con["latest_event_id"], "correction_reply")
            except NotEligible:
                ids = []
            return {"eligible": False, "source_event_id": con["latest_event_id"], "reason": str(error),
                    "prior_unknown_hold_ids": ids,
                    **({"correction_of_intent_id": originals[0]["intent_id"]} if len(originals) == 1 else {})}

    def review_reply_quality(self, account_id, conversation_id, intent_id, source_event_id, review):
        """Independent quality observation; never changes a delivery receipt or invents an inbound."""
        with self._tx():
            row = self._intent(intent_id)
            if row["account_id"] != account_id or row["conversation_id"] != conversation_id:
                raise ValueError("quality review target scope mismatch")
            proof = self._strict_quality_original(row, source_event_id)
            self._quality_source_text(account_id, conversation_id, source_event_id)
            required = {"source", "reviewer", "classification", "reason_code", "reference", "observed_at",
                        "account_id", "conversation_id", "intent_id", "source_event_id"}
            if (not isinstance(review, dict) or set(review) != required or review.get("source") != "independent_audit"
                    or review.get("classification") != "not_useful" or review.get("reason_code") != "question_not_answered"
                    or review.get("account_id") != account_id or review.get("conversation_id") != conversation_id
                    or review.get("intent_id") != intent_id or review.get("source_event_id") != source_event_id
                    or not isinstance(review.get("reviewer"), str) or not review["reviewer"].strip()
                    or len(review["reviewer"]) > 128 or review["reviewer"] == row["owner"]
                    or not isinstance(review.get("reference"), str) or not review["reference"].strip() or len(review["reference"]) > 1024):
                raise ValueError("requires bounded independent not_useful review of exact intent/source")
            at = _number(review["observed_at"], "quality_review.observed_at")
            if at < row["confirmed_at"] or at > self._now() + 1:
                raise ValueError("quality review observation must follow the original confirmation")
            previous = proof.get("quality_review")
            if previous is not None and any(previous.get(key) != review[key] for key in required - {"observed_at"}):
                raise ValueError("an independent quality review cannot be replaced")
            if previous is None:
                proof.update(usefulness_verified=True, useful=False, quality_review=dict(review))
                self.db.execute("UPDATE outbox SET evidence=? WHERE intent_id=?", (json.dumps(proof, ensure_ascii=False, allow_nan=False), intent_id))
                self._audit(account_id, conversation_id, "REPLY_QUALITY_REVIEWED", {
                    "intent_id": intent_id, "source_event_id": source_event_id, "reviewer": review["reviewer"],
                    "classification": "not_useful", "reason": review["reason_code"], "reference": review["reference"]})
            con = self._conversation(account_id, conversation_id)
            rearm = con["state"] == "ACTIVE" and con["latest_event_id"] == source_event_id and not self._correction_consumed(row)
            if rearm:
                self.db.execute("UPDATE conversations SET needs_response=1,updated_at=? WHERE account_id=? AND conversation_id=?",
                                (self._now(), account_id, conversation_id))
            return {"intent_id": intent_id, "source_event_id": source_event_id, "review": proof["quality_review"], "rearmed": bool(rearm)}

    def _expire_unsent(self, account, conversation):
        now = self._now()
        expired = []
        rows = self.db.execute("SELECT intent_id FROM outbox WHERE account_id=? AND conversation_id=? AND status IN ('PREPARED','CLAIMED') AND expires_at<=? ORDER BY created_at,intent_id",
                               (account, conversation, now)).fetchall()
        for row in rows:
            self.db.execute("UPDATE outbox SET status='EXPIRED',error='intent expired before submission' WHERE intent_id=? AND status IN ('PREPARED','CLAIMED') AND expires_at<=?",
                            (row["intent_id"], now))
            expired.append(row["intent_id"])
            self._audit(account, conversation, "INTENT_EXPIRED_UNSUBMITTED",
                        {"intent_id": row["intent_id"], "reason": "intent expired before submission"})
        return expired

    def expire_unsubmitted(self, account_id, conversation_id):
        """Expire only timed-out, never-submitted work; readers remain read-only."""
        _identifier(account_id, "account_id")
        _identifier(conversation_id, "conversation_id")
        with self._tx():
            self._conversation(account_id, conversation_id)
            expired = self._expire_unsent(account_id, conversation_id)
            return {"account_id": account_id, "conversation_id": conversation_id,
                    "expired_intent_ids": expired}

    def _followup_companion(self, account_id, conversation_id, source_event_id, payload):
        """Validate one card against one confirmed followup-text round."""
        anchor_id = payload.get("companion_text_intent_id")
        if not isinstance(anchor_id, str) or not anchor_id:
            raise NotEligible("companion card requires its exact followup text intent")
        if payload.get("operation") != "native_card":
            raise NotEligible("followup companion must be a native card operation")
        anchor = self.db.execute("SELECT * FROM outbox WHERE intent_id=?", (anchor_id,)).fetchone()
        if (anchor is None or anchor["account_id"] != account_id or anchor["conversation_id"] != conversation_id
                or anchor["source_event_id"] != source_event_id or anchor["status"] != "SENT"
                or anchor["kind"] != "followup" or json.loads(anchor["payload"]).get("operation") != "text"):
            raise NotEligible("companion anchor must be this conversation's confirmed followup text")
        if anchor["confirmed_at"] is None or not 0 <= self._now() - anchor["confirmed_at"] <= 30:
            raise NotEligible("followup companion must be submitted within 30 seconds of text confirmation")
        for outgoing in self.db.execute("SELECT * FROM outbox WHERE account_id=? AND conversation_id=? AND status='SENT'",
                                        (account_id, conversation_id)):
            outgoing_payload = json.loads(outgoing["payload"])
            if outgoing["kind"] == "card" and outgoing_payload.get("companion_text_intent_id") == anchor_id:
                raise NotEligible("this followup round already has a confirmed card")
            if outgoing["intent_id"] != anchor_id and outgoing["confirmed_at"] >= anchor["confirmed_at"]:
                raise NotEligible("another confirmed outbound superseded the followup round")
        proof = json.loads(anchor["evidence"] or "{}")
        own_ids = {proof["native_message_id"]} if isinstance(proof.get("native_message_id"), str) else set()
        if isinstance(proof.get("native_message_ids"), list):
            own_ids.update(value for value in proof["native_message_ids"] if isinstance(value, str))
        for outbound in self.db.execute("SELECT evidence,detected_at FROM events WHERE account_id=? AND conversation_id=? AND type='OUTBOUND_OBSERVED' AND detected_at>=?",
                                        (account_id, conversation_id, anchor["confirmed_at"])):
            native_id = json.loads(outbound["evidence"]).get("native_message_id")
            if native_id not in own_ids:
                raise NotEligible("another native outbound observation superseded the followup round")
        return anchor

    def prepare_intent(self, account_id, conversation_id, kind, payload, *, source_event_id=None, expires_at=None):
        """Prepare one atomic external operation. A text and a card are separate intents."""
        if kind not in ("initial", "reply", "followup", "card", "service_reply", "correction_reply"):
            raise ValueError("unsupported outgoing kind")
        if not isinstance(payload, dict) or not payload:
            raise ValueError("payload must be a nonempty operation dictionary")
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        with self._tx():
            now = self._now()
            con = self._conversation(account_id, conversation_id)
            if kind != "service_reply":
                self._active(con)
            self._expire_unsent(account_id, conversation_id)
            if self.db.execute("SELECT 1 FROM outbox WHERE account_id=? AND conversation_id=? AND status IN ('PREPARED','CLAIMED','SUBMITTING')",
                               (account_id, conversation_id)).fetchone():
                raise NotEligible("conversation has unresolved outgoing work")
            if kind not in ("service_reply", "correction_reply") and self.db.execute(
                    "SELECT 1 FROM outbox WHERE account_id=? AND conversation_id=? AND status='UNKNOWN'", (account_id, conversation_id)).fetchone():
                raise NotEligible("conversation has unresolved outgoing work")
            source_event_id = source_event_id or con["latest_event_id"]
            if not source_event_id or source_event_id != con["latest_event_id"]:
                raise NotEligible("intent must use the current inbound event")
            deadline = now + self.freshness_seconds
            if kind != "correction_reply" and any(not self._correction_consumed(original) for original in self._reviewed_corrections(con)):
                raise NotEligible("reviewed question requires its exact text-only correction")
            if kind == "correction_reply":
                self._correction_reply_checks(con, source_event_id, payload)
            elif kind == "service_reply":
                self._service_reply_checks(con, source_event_id, payload)
            elif kind in ("initial", "reply", "card"):
                if kind != "card" and not con["needs_response"]:
                    raise NotEligible("current event has already received a confirmed response")
                if kind == "card":
                    if "companion_text_intent_id" in payload:
                        self._followup_companion(account_id, conversation_id, source_event_id, payload)
                    else:
                        cards = self.db.execute("SELECT payload FROM outbox WHERE account_id=? AND conversation_id=? AND source_event_id=? AND kind='card' AND status='SENT'",
                                                (account_id, conversation_id, source_event_id)).fetchall()
                        if any("companion_text_intent_id" not in json.loads(card["payload"]) for card in cards):
                            raise NotEligible("an initial card has already been confirmed for the current event")
                        if not con["needs_response"]:
                            response = self.db.execute("SELECT MAX(confirmed_at) AS at FROM outbox WHERE account_id=? AND conversation_id=? AND source_event_id=? AND kind IN ('initial','reply') AND status='SENT'",
                                                       (account_id, conversation_id, source_event_id)).fetchone()
                            if response["at"] is None or now - response["at"] > 30:
                                raise NotEligible("companion card must belong to the current response round")
            else:
                if con["needs_response"]:
                    raise NotEligible("respond to the current inbound event first")
                if con["next_followup_at"] is None or now < con["next_followup_at"]:
                    raise NotEligible("followup is not due")
                if con["last_sent_at"] is None or now - con["last_sent_at"] < self.min_followup_interval:
                    raise NotEligible("minimum followup interval has not elapsed")
            if expires_at is not None:
                deadline = min(deadline, _number(expires_at, "expires_at"))
            if now >= deadline:
                raise NotEligible("prepared intent has no remaining validity")
            intent_id = uuid.uuid4().hex
            self.db.execute("INSERT INTO outbox(intent_id,account_id,conversation_id,kind,source_event_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
                            (intent_id, account_id, conversation_id, kind, source_event_id, encoded, "PREPARED", now, deadline))
            self._audit(account_id, conversation_id, "INTENT_PREPARED", {"intent_id": intent_id, "kind": kind})
            return self._decode(self._intent(intent_id))

    def _gate(self, row, gate):
        if not isinstance(gate, DispatchGate):
            raise GateClosed("an explicit DispatchGate is required")
        if gate.enabled is not True or gate.browser_connected is not True or gate.authenticated is not True:
            raise GateClosed("real dispatch requires live authorization, browser connection and authentication")
        if gate.account_id != row["account_id"] or gate.conversation_id != row["conversation_id"]:
            raise GateClosed("observed account or conversation does not match intent")
        if not gate.browser_session_id:
            raise GateClosed("a current browser session is required")
        try:
            observed = _number(gate.observed_at, "gate.observed_at")
        except ValueError as exc:
            raise GateClosed(str(exc)) from exc
        if observed > self._now() + 1 or self._now() - observed > self.freshness_seconds:
            raise GateClosed("browser observation is stale")
        event = self.db.execute("SELECT detected_at FROM events WHERE account_id=? AND event_id=?",
                                (row["account_id"], row["source_event_id"])).fetchone()
        con = self._conversation(row["account_id"], row["conversation_id"])
        if observed < event["detected_at"] or (con["last_limit_at"] is not None and observed <= con["last_limit_at"]):
            raise GateClosed("browser observation predates the current event or limit")
        if row["kind"] == "service_reply":
            service = self._service_reply_checks(con, row["source_event_id"], json.loads(row["payload"]), exclude_intent_id=row["intent_id"])
            if observed < service["latest_control_observed_at"]:
                raise GateClosed("browser observation predates the current service control")
        if row["kind"] == "correction_reply":
            correction = self._correction_reply_checks(con, row["source_event_id"], json.loads(row["payload"]), exclude_intent_id=row["intent_id"])
            if observed < correction["latest_control_observed_at"]:
                raise GateClosed("browser observation predates the independent quality review or current control")

    def _dispatch_checks(self, row):
        con = self._conversation(row["account_id"], row["conversation_id"])
        if row["kind"] == "service_reply":
            self._service_reply_checks(con, row["source_event_id"], json.loads(row["payload"]), exclude_intent_id=row["intent_id"])
        elif row["kind"] == "correction_reply":
            self._correction_reply_checks(con, row["source_event_id"], json.loads(row["payload"]), exclude_intent_id=row["intent_id"])
        else:
            self._active(con)
            if self.db.execute("SELECT 1 FROM outbox WHERE account_id=? AND conversation_id=? AND status='UNKNOWN'",
                               (row["account_id"], row["conversation_id"])).fetchone():
                raise NotEligible("conversation has unresolved outgoing work")
        if self._now() >= row["expires_at"]:
            raise NotEligible("intent expired")
        if row["source_event_id"] != con["latest_event_id"]:
            raise NotEligible("new inbound message superseded intent")
        if row["kind"] == "card" and "companion_text_intent_id" in json.loads(row["payload"]):
            self._followup_companion(row["account_id"], row["conversation_id"], row["source_event_id"], json.loads(row["payload"]))
        if row["kind"] == "followup" and (con["last_sent_at"] is None or self._now() - con["last_sent_at"] < self.min_followup_interval):
            raise NotEligible("minimum followup interval has not elapsed")

    def claim_intent(self, intent_id, owner, gate=DispatchGate()):
        _identifier(owner, "owner")
        with self._tx():
            row = self._intent(intent_id)
            if row["status"] == "CLAIMED" and row["lease_until"] <= self._now():
                # No submission occurred, so another worker may claim after a fresh check.
                pass
            elif row["status"] != "PREPARED":
                raise InvalidTransition("only prepared or expired unsubmitted claims may be claimed")
            self._dispatch_checks(row)
            self._gate(row, gate)
            now = self._now()
            self.db.execute("UPDATE outbox SET status='CLAIMED',owner=?,claimed_at=?,lease_until=?,browser_session_id=? WHERE intent_id=?",
                            (owner, now, now + self.claim_ttl_seconds, gate.browser_session_id, intent_id))
            self._audit(row["account_id"], row["conversation_id"], "INTENT_CLAIMED", {"intent_id": intent_id, "owner": owner})
            return self._decode(self._intent(intent_id))

    def begin_submit(self, intent_id, owner, gate=DispatchGate()):
        """Commit immediately before ONE external operation. Do not retry this call."""
        with self._tx():
            row = self._intent(intent_id)
            if row["status"] != "CLAIMED" or row["owner"] != owner:
                raise InvalidTransition("submission requires this worker's active claim")
            if row["lease_until"] <= self._now():
                raise InvalidTransition("claim lease expired before submission")
            self._dispatch_checks(row)
            self._gate(row, gate)
            if row["browser_session_id"] != gate.browser_session_id:
                raise GateClosed("browser session changed; prepare a fresh claim")
            self.db.execute("UPDATE outbox SET status='SUBMITTING',submitted_at=? WHERE intent_id=?",
                            (self._now(), intent_id))
            self._audit(row["account_id"], row["conversation_id"], "SUBMITTING", {"intent_id": intent_id, "owner": owner})
            return self._decode(self._intent(intent_id))

    def _record_sent(self, row, evidence):
        observed = self._observed_evidence(evidence, row["account_id"], row["conversation_id"], intent_id=row["intent_id"])
        if observed < row["submitted_at"]:
            raise ValueError("send confirmation predates submission")
        reception_entry = self._reception_assignment(row, evidence, observed)
        if reception_entry is not None:
            evidence["reception_event_id"] = reception_entry
        self.db.execute("UPDATE outbox SET status='SENT',confirmed_at=?,evidence=?,error=NULL WHERE intent_id=?",
                        (observed, json.dumps(evidence, ensure_ascii=False, allow_nan=False), row["intent_id"]))
        con = self._conversation(row["account_id"], row["conversation_id"])
        last_sent = max(con["last_sent_at"], observed) if con["last_sent_at"] is not None else observed
        changes = {"last_sent_at": last_sent, "updated_at": self._now()}
        if row["kind"] == "service_reply":
            changes["next_followup_at"] = None
            if row["source_event_id"] == con["latest_event_id"] and (con["state"] == "ACTIVE" or
                    con["state"] == "STOPPED" and con["stop_reason"] in ("WECHAT_VERIFIED", "LEAD_VERIFIED")):
                changes["needs_response"] = 0
        elif con["state"] == "ACTIVE":
            baseline = last_sent + self.min_followup_interval
            changes["next_followup_at"] = max(con["next_followup_at"], baseline) if con["next_followup_at"] is not None else baseline
            if row["source_event_id"] == con["latest_event_id"] and row["kind"] in ("initial", "reply", "correction_reply"):
                changes["needs_response"] = 0
        assignments = ",".join(key + "=?" for key in changes)
        self.db.execute("UPDATE conversations SET " + assignments + " WHERE account_id=? AND conversation_id=?",
                        tuple(changes.values()) + (row["account_id"], row["conversation_id"]))

    def confirm(self, intent_id, owner, result, evidence=None):
        if result not in ("sent", "limit", "unknown"):
            raise ValueError("result must be sent, limit or unknown")
        evidence = dict(evidence or {})
        with self._tx():
            row = self._intent(intent_id)
            if row["status"] != "SUBMITTING" or row["owner"] != owner:
                raise InvalidTransition("confirmation requires this worker's submitted intent")
            if result == "sent":
                self._record_sent(row, evidence)
            elif result == "limit":
                observed = self._observed_evidence(evidence, row["account_id"], row["conversation_id"], intent_id=intent_id)
                if observed < row["submitted_at"]:
                    raise ValueError("limit observation predates submission")
                self.db.execute("UPDATE outbox SET status='LIMIT',confirmed_at=?,evidence=? WHERE intent_id=?",
                                (observed, json.dumps(evidence, ensure_ascii=False), intent_id))
                con = self._conversation(row["account_id"], row["conversation_id"])
                if con["state"] != "STOPPED":
                    new_state = "HUMAN" if con["state"] == "HUMAN" else "PAUSED_LIMIT"
                    resume = "PAUSED_LIMIT" if new_state == "HUMAN" else None
                    self.db.execute("UPDATE conversations SET state=?,resume_state=?,last_limit_at=?,updated_at=? WHERE account_id=? AND conversation_id=?",
                                    (new_state, resume, self._now(), self._now(), row["account_id"], row["conversation_id"]))
                self._cancel_unsubmitted(row["account_id"], row["conversation_id"], "platform limit")
            else:
                self.db.execute("UPDATE outbox SET status='UNKNOWN',evidence=?,error='external result unknown; reconciliation required' WHERE intent_id=?",
                                (json.dumps(evidence, ensure_ascii=False, allow_nan=False), intent_id))
            self._audit(row["account_id"], row["conversation_id"], "SEND_" + result.upper(),
                        {"intent_id": intent_id, "evidence": evidence})
            return self._decode(self._intent(intent_id))

    def reconcile(self, intent_id, result, evidence):
        """Resolve a submitted unknown result using observation, never a trial send."""
        if result not in ("sent", "not_sent"):
            raise ValueError("reconciliation result must be sent or not_sent")
        with self._tx():
            row = self._intent(intent_id)
            if row["status"] != "UNKNOWN":
                raise InvalidTransition("only unknown submissions can be reconciled")
            observed = self._observed_evidence(evidence, row["account_id"], row["conversation_id"], intent_id=intent_id)
            if observed < row["submitted_at"]:
                raise ValueError("reconciliation observation predates submission")
            if result == "sent":
                self._record_sent(row, evidence)
            else:
                if evidence.get("verified_not_sent") is not True:
                    raise ValueError("not_sent requires positive verification, not absence of confirmation")
                self.db.execute("UPDATE outbox SET status='NOT_SENT',confirmed_at=?,evidence=? WHERE intent_id=?",
                                (observed, json.dumps(evidence, ensure_ascii=False, allow_nan=False), intent_id))
            self._audit(row["account_id"], row["conversation_id"], "RECONCILED_" + result.upper(),
                        {"intent_id": intent_id, "evidence": evidence})
            return self._decode(self._intent(intent_id))

    @staticmethod
    def _decode(row):
        result = dict(row)
        for key in ("payload", "evidence", "detail"):
            if key in result and result[key] is not None:
                result[key] = json.loads(result[key])
        return result

    def get_conversation(self, account_id, conversation_id):
        row = self.db.execute("SELECT * FROM conversations WHERE account_id=? AND conversation_id=?", (account_id, conversation_id)).fetchone()
        if row is None:
            return None
        return dict(row, service_reply=self._service_reply_status(row), correction_reply=self._correction_reply_status(row))

    def get_latest_event_metadata(self, account_id, conversation_id):
        """Project original native provenance without customer text or arbitrary evidence."""
        con = self.get_conversation(account_id, conversation_id)
        if con is None or not con["latest_event_id"]:
            return None
        row = self.db.execute("SELECT * FROM events WHERE account_id=? AND conversation_id=? AND event_id=?",
                              (account_id, conversation_id, con["latest_event_id"])).fetchone()
        if row is None:
            return None
        proof = json.loads(row["evidence"])
        allowed = {"source", "timestamp_source", "account_id", "conversation_id", "reference",
                   "native_message_id", "native_message_type", "native_direction", "historical_baseline", "observed_at"}
        result = {key: row[key] for key in ("account_id", "conversation_id", "event_id", "type",
                                           "timestamp", "detected_at", "timestamp_source")}
        result["evidence"] = {key: value for key, value in proof.items() if key in allowed}
        return result

    def list_conversations(self, account_id=None):
        sql = "SELECT * FROM conversations"
        params = ()
        if account_id is not None:
            sql += " WHERE account_id=?"
            params = (account_id,)
        return [dict(row) for row in self.db.execute(sql + " ORDER BY created_at,conversation_id", params)]

    def list_outbox(self, account_id=None):
        sql = "SELECT * FROM outbox"
        params = ()
        if account_id is not None:
            sql += " WHERE account_id=?"
            params = (account_id,)
        return [self._decode(row) for row in self.db.execute(sql + " ORDER BY created_at,intent_id", params)]

    def audit(self, account_id=None):
        sql = "SELECT * FROM audit_log"
        params = ()
        if account_id is not None:
            sql += " WHERE account_id=?"
            params = (account_id,)
        return [self._decode(row) for row in self.db.execute(sql + " ORDER BY id", params)]

    def due_conversations(self, account_id=None):
        """Return at most one current task per active conversation; never a backlog."""
        now = self._now()
        rows = []
        for con in self.list_conversations(account_id):
            if con["state"] != "ACTIVE":
                continue
            if self.db.execute("SELECT 1 FROM outbox WHERE account_id=? AND conversation_id=? AND (status IN ('SUBMITTING','UNKNOWN') OR (status IN ('PREPARED','CLAIMED') AND expires_at>?))",
                               (con["account_id"], con["conversation_id"], now)).fetchone():
                continue
            if con["needs_response"]:
                rows.append(dict(con, due_kind="response"))
            elif con["next_followup_at"] is not None and now >= con["next_followup_at"]:
                rows.append(dict(con, due_kind="followup"))
        return rows

    def metrics(self, account_id=None):
        """All recorded inbound events remain in the denominator, including failures.

        This is an event-level observation report, not a claim that every inbound
        event was platform-eligible. Useful-response SLA requires a separate
        reviewed usefulness observation as well as the platform event clock.
        """
        sql = "SELECT * FROM events WHERE type IN ('NEW_VISITOR','CUSTOMER_MESSAGE')"
        params = ()
        if account_id is not None:
            sql += " AND account_id=?"
            params = (account_id,)
        samples = []
        responses = []
        historical_inbound_events = 0
        for event in self.db.execute(sql + " ORDER BY detected_at,event_id", params):
            if json.loads(event["evidence"]).get("historical_baseline") is True:
                historical_inbound_events += 1
                continue
            attempts = self.db.execute("SELECT * FROM outbox WHERE account_id=? AND source_event_id=? AND kind IN ('initial','reply') ORDER BY confirmed_at,intent_id",
                                       (event["account_id"], event["event_id"])).fetchall()
            sent = next((row for row in attempts if row["status"] == "SENT"), None)
            evidence = json.loads(sent["evidence"]) if sent is not None else {}
            platform_clock_known = event["timestamp"] is not None and event["timestamp_source"] in {"platform", "platform_ui", "official_api"}
            platform_elapsed = None if sent is None or not platform_clock_known else sent["confirmed_at"] - event["timestamp"]
            sample = {
                "account_id": event["account_id"], "conversation_id": event["conversation_id"],
                "event_id": event["event_id"], "intent_id": sent["intent_id"] if sent else None,
                "platform_timestamp": event["timestamp"], "timestamp_source": event["timestamp_source"],
                "platform_clock_known": platform_clock_known,
                "detected_at": event["detected_at"],
                "send_confirmed_at": sent["confirmed_at"] if sent else None,
                "detection_to_confirm_seconds": sent["confirmed_at"] - event["detected_at"] if sent else None,
                "platform_to_confirm_seconds": platform_elapsed,
                "usefulness_verified": evidence.get("usefulness_verified") is True,
                "useful": evidence.get("useful") if type(evidence.get("useful")) is bool else None,
                "attempt_statuses": [row["status"] for row in attempts],
                "conversation_state": self._conversation(event["account_id"], event["conversation_id"])["state"],
            }
            samples.append(sample)
            if sent is not None:
                responses.append(sample)
        def percentile(values):
            values = sorted(values)
            return values[max(0, math.ceil(len(values) * .95) - 1)] if values else None
        platform = [s["platform_to_confirm_seconds"] for s in responses if s["platform_to_confirm_seconds"] is not None]
        useful = [s["platform_to_confirm_seconds"] for s in responses if s["usefulness_verified"] and s["useful"] is True and s["platform_to_confirm_seconds"] is not None]
        complete = bool(samples) and all(s["platform_to_confirm_seconds"] is not None and s["usefulness_verified"] and s["useful"] is not None for s in samples)
        within_target = sum(s["platform_to_confirm_seconds"] is not None and s["platform_to_confirm_seconds"] <= 5 and s["usefulness_verified"] and s["useful"] is True for s in samples)
        states = {}
        for con in self.list_conversations(account_id):
            states[con["state"]] = states.get(con["state"], 0) + 1
        report = {
            "states": states, "recorded_inbound_events": len(samples),
            "historical_inbound_events": historical_inbound_events,
            "all_recorded_inbound_events": len(samples) + historical_inbound_events,
            "confirmed_response_samples": len(responses),
            "unanswered_events": sum(s["send_confirmed_at"] is None for s in samples),
            "unknown_result_events": sum(any(x in ("UNKNOWN", "SUBMITTING") for x in s["attempt_statuses"]) for s in samples),
            "limited_events": sum("LIMIT" in s["attempt_statuses"] for s in samples),
            "platform_timestamp_unknown_samples": sum(not s["platform_clock_known"] for s in samples),
            "p95_detection_to_confirm_seconds": percentile([s["detection_to_confirm_seconds"] for s in responses]),
            "p95_platform_to_confirm_seconds": percentile(platform),
            "p95_verified_useful_platform_to_confirm_seconds": percentile(useful),
            "verified_useful_within_5_seconds": within_target,
            "verified_useful_known_timestamp_samples": len(useful),
            "within_5_seconds_rate": within_target / len(samples) if complete else None,
            "target_assessment": "meets" if complete and within_target / len(samples) >= .95 else ("misses" if complete else "unverified"),
            "denominator_scope": "nonhistorical_recorded_inbound_events; eligibility not independently established",
            "response_percentiles_scope": "confirmed_subset_only; not an end-to-end SLA verdict",
            "samples": samples,
        }
        report["reception_bundle"] = self._reception_bundle_metrics(account_id)
        return report

    @classmethod
    def reception_metrics_snapshot(cls, connection, account_id=None, *, clock=time.time):
        """Reuse bundle metrics inside an existing read-only snapshot, without init.

        The caller owns the connection/transaction. No schema or journal settings
        are changed, and the query-only connection cannot update business state.
        """
        if connection.execute("PRAGMA query_only").fetchone()[0] != 1:
            raise ValueError("a query-only SQLite connection is required")
        reader = object.__new__(cls)
        reader.db, reader.clock = connection, clock
        return reader._reception_bundle_metrics(account_id)

    def _reception_bundle_metrics(self, account_id):
        """Strict entry-to-all-three acceptance, separate from legacy first reply."""
        sql = "SELECT * FROM events WHERE type='NEW_VISITOR'"
        params = ()
        if account_id is not None:
            sql += " AND account_id=?"
            params = (account_id,)
        samples = []
        historical_entry_events = 0
        now = self._now()
        for entry in self.db.execute(sql + " ORDER BY detected_at,event_id", params):
            if json.loads(entry["evidence"]).get("historical_baseline") is True:
                historical_entry_events += 1
                continue
            takeovers = self.db.execute("SELECT evidence FROM events WHERE account_id=? AND conversation_id=? AND type='PLATFORM_TAKEOVER_CONFIRMED'",
                                       (entry["account_id"], entry["conversation_id"])).fetchall()
            takeover_times = [proof["observed_at"] for proof in (json.loads(row["evidence"]) for row in takeovers)
                              if proof.get("source_event_id") == entry["event_id"] and proof.get("taken_over") is True]
            text_times, card_times = [], []
            attempts = self.db.execute("SELECT * FROM outbox WHERE account_id=? AND conversation_id=?",
                                      (entry["account_id"], entry["conversation_id"])).fetchall()
            statuses = []
            for attempt in attempts:
                proof = json.loads(attempt["evidence"]) if attempt["evidence"] else {}
                try:
                    assigned_entry = self._reception_assignment(attempt, proof, attempt["confirmed_at"] if attempt["confirmed_at"] is not None else now)
                except ValueError:
                    # Legacy or malformed contradictory receipts never earn credit.
                    continue
                if assigned_entry != entry["event_id"]:
                    continue
                statuses.append(attempt["status"])
                if attempt["status"] != "SENT":
                    continue
                payload = json.loads(attempt["payload"])
                if attempt["kind"] in ("initial", "reply") and payload.get("operation") == "text" and proof.get("usefulness_verified") is True and proof.get("useful") is True:
                    text_times.append(attempt["confirmed_at"])
                if attempt["kind"] == "card" and payload.get("operation") == "native_card" and proof.get("native_wecom_card_confirmed") is True:
                    card_times.append(attempt["confirmed_at"])
            milestones = {
                "platform_takeover_confirmed_at": min(takeover_times) if takeover_times else None,
                "useful_text_confirmed_at": min(text_times) if text_times else None,
                "native_wecom_card_confirmed_at": min(card_times) if card_times else None,
            }
            missing = [name for name, value in milestones.items() if value is None]
            clock_known = entry["timestamp"] is not None and entry["timestamp_source"] in {"platform", "platform_ui", "official_api"}
            complete = clock_known and not missing
            completed_at = max(milestones.values()) if complete else None
            elapsed = completed_at - entry["timestamp"] if complete else None
            # Missing/unknown receipts cannot become successes by omission.
            within = elapsed <= 5 if complete else (False if clock_known and now - entry["timestamp"] > 5 else None)
            samples.append({
                "account_id": entry["account_id"], "conversation_id": entry["conversation_id"],
                "entry_event_id": entry["event_id"], "platform_entry_at": entry["timestamp"],
                "timestamp_source": entry["timestamp_source"], "platform_clock_known": clock_known,
                "detected_at": entry["detected_at"],
                **milestones, "missing_receipts": missing,
                "complete": bool(complete), "completed_at": completed_at,
                "platform_entry_to_all_confirmed_seconds": elapsed,
                "within_5_seconds": within,
                "assessment": "meets" if within is True else ("misses" if within is False else "unverified"),
                "attempt_statuses": statuses,
            })
        elapsed = sorted(sample["platform_entry_to_all_confirmed_seconds"] for sample in samples if sample["complete"])
        decidable = bool(samples) and all(sample["within_5_seconds"] is not None for sample in samples)
        within_count = sum(sample["within_5_seconds"] is True for sample in samples)
        return {
            "acceptance": "single_real_entry_all_three_confirmed_within_5_seconds",
            "target_seconds": 5, "clock": "platform_entry_to_all_three_confirmed",
            "required_receipts": ["platform_takeover", "useful_text", "native_wecom_card"],
            "recorded_entry_events": len(samples),
            "historical_entry_events": historical_entry_events,
            "all_recorded_entry_events": len(samples) + historical_entry_events,
            "complete_bundles": sum(sample["complete"] for sample in samples),
            "incomplete_events": sum(not sample["complete"] for sample in samples),
            "platform_timestamp_unknown_events": sum(not sample["platform_clock_known"] for sample in samples),
            "within_5_seconds_count": within_count,
            "within_5_seconds_rate": within_count / len(samples) if decidable else None,
            "target_assessment": ("meets" if within_count == len(samples) else "misses") if decidable else "unverified",
            "p95_completed_bundle_seconds": elapsed[max(0, math.ceil(len(elapsed) * .95) - 1)] if elapsed else None,
            "percentile_scope": "complete_bundles_only; incomplete_events_remain_in_entry_denominator",
            "samples": samples,
        }
