import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from xhs_reception import Engine
from xhs_reception.rpc_bridge import EngineRPC, MAX_LINE_CHARS, serve


class RPCTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "rpc.sqlite3"
        self.engine = Engine(self.db, clock=lambda: 100000.0)

    def tearDown(self):
        self.engine.close()
        self.temp.cleanup()

    def request(self, bridge, method, params=None):
        return bridge.handle({"id": "test-request", "method": method, "params": params or {}})

    def ingest_prepare(self, bridge, account="a1"):
        event = {"account_id": account, "conversation_id": "c1", "event_id": "fixture-event",
                 "type": "CUSTOMER_MESSAGE", "timestamp": 100000.0,
                 "evidence": {"timestamp_source": "platform_ui"}}
        self.assertTrue(self.request(bridge, "ingest", {"event": event})["ok"])
        prepared = self.request(bridge, "prepare", {
            "account_id": account, "conversation_id": "c1", "kind": "reply",
            "payload": {"operation": "text", "text": "unit-test-fixture"},
        })
        self.assertTrue(prepared["ok"])
        return prepared["result"]["intent_id"]

    def test_bad_json_unknown_method_and_unknown_fields_are_isolated(self):
        requests = [
            "not JSON",
            json.dumps({"id": 1, "method": "__getattribute__", "params": {}}),
            json.dumps({"id": 2, "method": "status", "params": {"enable_live": True}}),
            json.dumps({"id": 3, "method": "ingest", "params": {"event": {"enable_live": True}}}),
            json.dumps({"id": 4, "method": "claim", "params": {"intent_id": "x", "owner": "w", "gate": {"bypass": True}}}),
            json.dumps({"id": 5, "method": "status", "params": {}}),
        ]
        output = io.StringIO()
        serve(self.engine, io.StringIO("\n".join(requests) + "\n"), output)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(responses), 6)
        self.assertEqual(responses[0]["error"]["code"], "parse_error")
        self.assertEqual(responses[1]["error"]["code"], "method_not_found")
        self.assertTrue(all(not row["ok"] for row in responses[:-1]))
        self.assertTrue(responses[-1]["ok"])
        self.assertEqual(self.engine.list_conversations(), [])

    def test_unbound_bridge_and_missing_gate_cannot_claim(self):
        unbound = EngineRPC(self.engine)
        intent = self.ingest_prepare(unbound)
        params = {"intent_id": intent, "owner": "test-worker"}
        self.assertEqual(self.request(unbound, "claim", params)["error"]["code"], "account_binding_required")
        bound = EngineRPC(self.engine, account_id="a1")
        self.assertEqual(self.request(bound, "claim", params)["error"]["code"], "GateClosed")
        self.assertEqual(self.engine.list_outbox()[0]["status"], "PREPARED")

    def test_bridge_checks_account_scope_for_events_and_outgoing_intents(self):
        unbound = EngineRPC(self.engine)
        intent = self.ingest_prepare(unbound, account="other-account")
        bound = EngineRPC(self.engine, account_id="a1")
        result = self.request(bound, "claim", {"intent_id": intent, "owner": "test-worker"})
        self.assertEqual(result["error"]["code"], "intent_scope_mismatch")
        result = self.request(bound, "metrics", {"account_id": "other-account"})
        self.assertEqual(result["error"]["code"], "account_scope_mismatch")
        self.assertEqual(self.request(bound, "status")["result"]["conversations"], [])

    def test_null_read_scope_cannot_broaden_bound_account(self):
        unbound = EngineRPC(self.engine)
        self.ingest_prepare(unbound, account="a1")
        self.ingest_prepare(unbound, account="other-account")
        bound = EngineRPC(self.engine, account_id="a1")

        status = self.request(bound, "status", {"account_id": None})
        self.assertTrue(status["ok"])
        self.assertEqual(status["result"]["account_scope"], "a1")
        self.assertEqual({row["account_id"] for row in status["result"]["conversations"]}, {"a1"})
        self.assertEqual({row["account_id"] for row in status["result"]["outbox"]}, {"a1"})
        metrics = self.request(bound, "metrics", {"account_id": None})
        self.assertEqual(metrics["result"]["recorded_inbound_events"], 1)

        # Explicit null preserves the unbound administrative read contract.
        all_status = self.request(unbound, "status", {"account_id": None})
        self.assertEqual({row["account_id"] for row in all_status["result"]["conversations"]},
                         {"a1", "other-account"})
        self.assertEqual(self.request(unbound, "metrics", {"account_id": None})
                         ["result"]["recorded_inbound_events"], 2)

    def test_expire_unsubmitted_requires_bound_account_and_only_explicitly_mutates(self):
        unbound = EngineRPC(self.engine)
        intent = self.ingest_prepare(unbound)
        self.engine.clock = lambda: 100010.0
        params = {"account_id": "a1", "conversation_id": "c1"}
        self.assertEqual(self.request(unbound, "expire_unsubmitted", params)["error"]["code"], "account_binding_required")
        bound = EngineRPC(self.engine, account_id="a1")
        self.assertEqual(self.request(bound, "expire_unsubmitted", {**params, "account_id": "other"})["error"]["code"], "account_scope_mismatch")
        self.assertEqual(self.request(bound, "status")["result"]["outbox"][0]["status"], "PREPARED")
        result = self.request(bound, "expire_unsubmitted", params)
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["expired_intent_ids"], [intent])
        self.assertEqual(self.request(bound, "status")["result"]["outbox"][0]["status"], "EXPIRED")

    def test_conversation_status_projects_latest_native_metadata_without_body(self):
        bridge = EngineRPC(self.engine, account_id="a1")
        proof = {"source": "platform_ui", "timestamp_source": "platform_ui", "account_id": "a1",
                 "conversation_id": "c1", "reference": "native-fixture", "native_message_id": "native-fixture-id",
                 "native_message_type": "TEXT", "native_direction": "left", "historical_baseline": True,
                 "observed_at": 100000.0, "untrusted_message_text": "PRIVATE_CUSTOMER_BODY", "phone": "PRIVATE_PHONE"}
        self.assertTrue(self.request(bridge, "ingest", {"event": {"account_id": "a1", "conversation_id": "c1",
            "event_id": "native-fixture", "type": "CUSTOMER_MESSAGE", "timestamp": 99900.0,
            "detected_at": 100000.0, "evidence": proof}})["ok"])
        before = len(self.engine.audit())
        result = self.request(bridge, "status", {"conversation_id": "c1"})
        latest = result["result"]["latest_event"]
        self.assertEqual(latest["event_id"], "native-fixture")
        self.assertEqual(latest["evidence"]["native_direction"], "left")
        self.assertEqual(latest["timestamp"], 99900.0)
        self.assertNotIn("PRIVATE_CUSTOMER_BODY", json.dumps(result))
        self.assertNotIn("PRIVATE_PHONE", json.dumps(result))
        self.assertEqual(len(self.engine.audit()), before)
        self.assertNotIn("latest_event", self.request(bridge, "status")["result"])
        self.assertIsNone(self.request(bridge, "status", {"conversation_id": "missing"})["result"]["latest_event"])

    def test_full_submitting_unknown_reconciliation_survives_multiple_requests(self):
        bridge = EngineRPC(self.engine, account_id="a1")
        intent = self.ingest_prepare(bridge)
        gate = {"enabled": True, "browser_connected": True, "authenticated": True,
                "account_id": "a1", "conversation_id": "c1", "browser_session_id": "test-only-session",
                "observed_at": 100000.0}
        params = {"intent_id": intent, "owner": "test-worker", "gate": gate}
        self.assertTrue(self.request(bridge, "claim", params)["ok"])
        self.assertTrue(self.request(bridge, "begin_submit", params)["ok"])
        self.assertTrue(self.request(bridge, "confirm", {"intent_id": intent, "owner": "test-worker", "result": "unknown"})["ok"])
        blocked = self.request(bridge, "prepare", {"account_id": "a1", "conversation_id": "c1", "kind": "reply", "payload": {"operation": "text"}})
        self.assertEqual(blocked["error"]["code"], "NotEligible")
        evidence = {"source": "platform_ui", "reference": "test-only-observation", "observed_at": 100000.0,
                    "account_id": "a1", "conversation_id": "c1", "intent_id": intent, "verified_not_sent": True}
        reconciled = self.request(bridge, "reconcile", {"intent_id": intent, "result": "not_sent", "evidence": evidence})
        self.assertTrue(reconciled["ok"])
        self.assertEqual(reconciled["result"]["status"], "NOT_SENT")
        self.assertEqual(self.request(bridge, "metrics")["result"]["recorded_inbound_events"], 1)

    def test_oversized_line_is_drained_without_eating_next_request(self):
        stream = io.StringIO("x" * (MAX_LINE_CHARS + 20) + '\n{"id":2,"method":"status"}\n')
        output = io.StringIO()
        serve(self.engine, stream, output)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(responses), 2)
        self.assertEqual(responses[0]["error"]["code"], "line_too_large")
        self.assertTrue(responses[1]["ok"])

    def test_duplicate_fields_nonfinite_and_deep_json_do_not_stop_next_request(self):
        lines = [
            '{"id":1,"method":"status","method":"claim"}',
            '{"id":2,"method":"status","params":{"account_id":NaN}}',
            "[" * 2000 + "0" + "]" * 2000,
            '{"id":4,"method":"status"}',
        ]
        output = io.StringIO()
        serve(self.engine, io.StringIO("\n".join(lines) + "\n"), output)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(responses), 4)
        self.assertTrue(all(row["error"]["code"] == "parse_error" for row in responses[:3]))
        self.assertTrue(responses[-1]["ok"])

    def test_real_cli_process_uses_only_json_lines_and_persists_observation(self):
        request = {"id": 1, "method": "ingest", "params": {"event": {
            "account_id": "a1", "conversation_id": "c1", "event_id": "test-only-event", "type": "CUSTOMER_MESSAGE",
        }}}
        lines = [json.dumps(request), '{"id":2,"method":"status"}', '{"id":3,"method":"metrics"}']
        completed = subprocess.run(
            [sys.executable, "-u", "-m", "xhs_reception", "--db", str(self.db), "--account", "a1", "rpc"],
            input="\n".join(lines) + "\n", capture_output=True, text=True, timeout=5,
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        responses = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual([row["id"] for row in responses], [1, 2, 3])
        self.assertTrue(all(row["ok"] for row in responses))
        self.assertEqual(len(responses[1]["result"]["conversations"]), 1)
        self.assertEqual(responses[1]["result"]["outbox"], [])
        self.assertEqual(responses[2]["result"]["recorded_inbound_events"], 1)
        self.assertEqual(len(self.engine.list_conversations()), 1)

    def test_lone_surrogate_id_does_not_break_cli_json_lines_or_next_request(self):
        completed = subprocess.run(
            [sys.executable, "-u", "-m", "xhs_reception", "--db", str(self.db), "--account", "a1", "rpc"],
            input='{"id":"\\ud800","method":"status"}\n{"id":2,"method":"status"}\n',
            capture_output=True, text=True, timeout=5,
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stderr, "")
        self.assertTrue(completed.stdout.isascii())
        responses = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual(len(responses), 2)
        self.assertEqual(responses[0]["id"], "\ud800")
        self.assertEqual(responses[1]["id"], 2)
        self.assertTrue(all(row["ok"] for row in responses))


if __name__ == "__main__":
    unittest.main()
