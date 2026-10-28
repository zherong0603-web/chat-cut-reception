"""Local JSON-lines bridge to one existing Engine; no browser or network access."""

from dataclasses import fields
import json
import sqlite3

from .engine import DispatchGate, EngineError, Event


MAX_LINE_CHARS = 1024 * 1024


class RPCError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def _object(value, allowed, required=()):
    if not isinstance(value, dict):
        raise RPCError("invalid_params", "expected a JSON object")
    unknown = set(value) - set(allowed)
    missing = set(required) - set(value)
    if unknown:
        raise RPCError("invalid_params", "unsupported fields: " + ", ".join(sorted(unknown)))
    if missing:
        raise RPCError("invalid_params", "missing fields: " + ", ".join(sorted(missing)))
    return value


def _evidence(value):
    # Evidence content remains data for the existing Engine's scoped validators;
    # it is never interpreted as RPC methods, gates, configuration or code.
    if not isinstance(value, dict):
        raise RPCError("invalid_params", "evidence must be a JSON object")
    return value


class EngineRPC:
    """Each instance retains one Engine connection for the life of stdin."""

    def __init__(self, engine, *, account_id=None):
        if account_id is not None and (not isinstance(account_id, str) or not account_id.strip()):
            raise ValueError("account scope must be a nonempty string")
        self.engine = engine
        self.account_id = account_id

    def _account(self, account_id):
        if not isinstance(account_id, str) or not account_id.strip():
            raise RPCError("invalid_params", "account_id must be nonempty")
        if self.account_id is not None and account_id != self.account_id:
            raise RPCError("account_scope_mismatch", "request account differs from the selected account")
        return account_id

    def _read_account(self, params):
        # JSON null means the same as an omitted read scope. It must never
        # broaden an account-bound bridge into an all-account reader.
        account = params.get("account_id")
        if account is None:
            account = self.account_id
        return self._account(account) if account is not None else None

    def _intent_scope(self, intent_id):
        if self.account_id is None:
            raise RPCError("account_binding_required", "verify the real UI account before starting RPC with --account")
        if not isinstance(intent_id, str) or not intent_id:
            raise RPCError("invalid_params", "intent_id must be nonempty")
        if not any(row["intent_id"] == intent_id for row in self.engine.list_outbox(self.account_id)):
            raise RPCError("intent_scope_mismatch", "intent does not belong to the selected account")

    def dispatch(self, method, params):
        if method == "ingest":
            _object(params, {"event"}, {"event"})
            event = _object(params["event"], {item.name for item in fields(Event)},
                            {"account_id", "conversation_id", "event_id", "type"})
            self._account(event["account_id"])
            if "evidence" in event:
                _evidence(event["evidence"])
            return self.engine.ingest_event(Event(**event))
        if method == "status":
            _object(params, {"account_id", "conversation_id"})
            account = self._read_account(params)
            if "conversation_id" in params:
                if account is None:
                    raise RPCError("invalid_params", "conversation lookup requires account_id")
                conversations = self.engine.get_conversation(account, params["conversation_id"])
                conversations = [] if conversations is None else [conversations]
            else:
                conversations = self.engine.list_conversations(account)
            outbox = self.engine.list_outbox(account)
            if "conversation_id" in params:
                outbox = [row for row in outbox if row["conversation_id"] == params["conversation_id"]]
            result = {"account_scope": self.account_id, "performs_browser_actions": False,
                      "conversations": conversations, "outbox": outbox}
            if "conversation_id" in params:
                result["latest_event"] = self.engine.get_latest_event_metadata(account, params["conversation_id"])
            return result
        if method == "metrics":
            _object(params, {"account_id"})
            return self.engine.metrics(self._read_account(params))
        if method == "prepare":
            _object(params, {"account_id", "conversation_id", "kind", "payload", "source_event_id", "expires_at"},
                    {"account_id", "conversation_id", "kind", "payload"})
            self._account(params["account_id"])
            return self.engine.prepare_intent(**params)
        if method == "review_reply_quality":
            _object(params, {"account_id", "conversation_id", "intent_id", "source_event_id", "review"},
                    {"account_id", "conversation_id", "intent_id", "source_event_id", "review"})
            self._intent_scope(params["intent_id"])
            self._account(params["account_id"])
            _evidence(params["review"])
            return self.engine.review_reply_quality(**params)
        if method == "expire_unsubmitted":
            _object(params, {"account_id", "conversation_id"}, {"account_id", "conversation_id"})
            if self.account_id is None:
                raise RPCError("account_binding_required", "verify the real UI account before expiring unsubmitted work")
            self._account(params["account_id"])
            return self.engine.expire_unsubmitted(**params)
        if method in ("claim", "begin_submit"):
            _object(params, {"intent_id", "owner", "gate"}, {"intent_id", "owner"})
            gate = _object(params.get("gate", {}), {item.name for item in fields(DispatchGate)})
            self._intent_scope(params["intent_id"])
            operation = self.engine.claim_intent if method == "claim" else self.engine.begin_submit
            return operation(params["intent_id"], params["owner"], DispatchGate(**gate))
        if method == "confirm":
            _object(params, {"intent_id", "owner", "result", "evidence"}, {"intent_id", "owner", "result"})
            self._intent_scope(params["intent_id"])
            if "evidence" in params:
                _evidence(params["evidence"])
            return self.engine.confirm(**params)
        if method == "reconcile":
            _object(params, {"intent_id", "result", "evidence"}, {"intent_id", "result", "evidence"})
            self._intent_scope(params["intent_id"])
            _evidence(params["evidence"])
            return self.engine.reconcile(**params)
        raise RPCError("method_not_found", "unsupported RPC method")

    def handle(self, request):
        request_id = None
        try:
            _object(request, {"id", "method", "params"}, {"id", "method"})
            request_id = request["id"]
            if request_id is not None and (isinstance(request_id, bool) or not isinstance(request_id, (str, int))):
                request_id = None
                raise RPCError("invalid_request", "id must be a string, integer or null")
            if not isinstance(request["method"], str):
                raise RPCError("invalid_request", "method must be a string")
            result = self.dispatch(request["method"], request.get("params", {}))
            return {"id": request_id, "ok": True, "result": result}
        except RPCError as error:
            return {"id": request_id, "ok": False, "error": {"code": error.code, "message": str(error)}}
        except (EngineError, ValueError, TypeError, KeyError, sqlite3.Error) as error:
            return {"id": request_id, "ok": False,
                    "error": {"code": type(error).__name__, "message": str(error)}}


def serve(engine, input_stream, output_stream, *, account_id=None):
    """One request and response per line; malformed lines do not stop the worker."""
    bridge = EngineRPC(engine, account_id=account_id)

    def emit(value):
        # JSON permits escaped lone surrogates. Keep the wire ASCII so an
        # echoed string cannot fail UTF-8 encoding and terminate the worker.
        output_stream.write(json.dumps(value, ensure_ascii=True, allow_nan=False) + "\n")
        output_stream.flush()

    def invalid_constant(_):
        raise ValueError("non-finite JSON numbers are not allowed")

    def unique_object(pairs):
        obj = {}
        for key, value in pairs:
            if key in obj:
                raise ValueError("duplicate JSON fields are not allowed")
            obj[key] = value
        return obj

    while True:
        line = input_stream.readline(MAX_LINE_CHARS + 1)
        if not line:
            return
        if len(line) > MAX_LINE_CHARS:
            while not line.endswith("\n"):
                line = input_stream.readline(MAX_LINE_CHARS + 1)
                if not line:
                    break
            emit({"id": None, "ok": False, "error": {"code": "line_too_large", "message": "request exceeds the JSON-line size limit"}})
            continue
        try:
            request = json.loads(line, parse_constant=invalid_constant, object_pairs_hook=unique_object)
        except (ValueError, TypeError, RecursionError):
            emit({"id": None, "ok": False, "error": {"code": "parse_error", "message": "invalid JSON request line"}})
            continue
        emit(bridge.handle(request))
