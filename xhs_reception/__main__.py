"""Local control by default; explicitly approved isolated probes never send."""

import argparse
import json
import math
import re
import time
from dataclasses import fields
from datetime import datetime
from pathlib import Path
import sqlite3
import sys

from .engine import Engine, EngineError, Event


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / ".runtime" / "reception.sqlite3"
DEFAULT_CONFIG = ROOT / "reception.json"
DEFAULT_CONNECTION = ROOT / ".runtime" / "connection.json"


def read_json(path):
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream)


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2))


def saved_json(path, maximum=65536):
    try:
        file = Path(path)
        if not file.exists():
            return {}, {"file_status": "missing"}
        if not file.is_file() or file.stat().st_size > maximum:
            return {}, {"file_status": "invalid", "reason": "unsupported_file"}
        def invalid_constant(_):
            raise ValueError("nonfinite JSON")
        with file.open(encoding="utf-8") as stream:
            value = json.load(stream, parse_constant=invalid_constant)
        if not isinstance(value, dict):
            raise ValueError("object required")
        return value, {"file_status": "recorded"}
    except (OSError, ValueError, UnicodeError):
        return {}, {"file_status": "invalid", "reason": "unreadable_or_invalid_json"}


def finite(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def utc_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value):
        return None
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00").timestamp()
    except ValueError:
        return None


def saved_database(db, account=None):
    """Diagnostic reads never invoke Engine's schema initialization."""
    connection = None
    try:
        if not db.is_file():
            return {"file_status": "missing"}, [], [], []
        connection = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        required = {
            "conversations": {"account_id", "conversation_id", "state", "created_at"},
            "events": {"account_id", "conversation_id", "event_id", "type", "evidence", "timestamp_source"},
            "outbox": {"account_id", "conversation_id", "intent_id", "status", "payload", "evidence", "created_at"},
            "audit_log": {"id", "action", "detail"},
        }
        if any(not names <= {row[1] for row in connection.execute("PRAGMA table_info(" + table + ")")}
               for table, names in required.items()) or not connection.execute(
                   "SELECT 1 FROM sqlite_master WHERE type='index' AND name='one_unsettled_per_conversation'").fetchone():
            return {"file_status": "invalid", "reason": "engine_schema_required"}, [], [], []
        result = []
        for table in ("conversations", "events", "outbox"):
            sql, params = "SELECT * FROM " + table, ()
            if account is not None:
                sql += " WHERE account_id=?"
                params = (account,)
            rows = []
            for row in connection.execute(sql, params):
                value = dict(row)
                for name in ("payload", "evidence"):
                    if name in value and value[name] is not None:
                        value[name] = json.loads(value[name])
                        if not isinstance(value[name], dict):
                            raise ValueError("invalid saved evidence")
                rows.append(value)
            result.append(rows)
        return {"file_status": "recorded", "read_only": True}, *result
    except (OSError, ValueError, sqlite3.Error):
        return {"file_status": "invalid", "reason": "unreadable_or_invalid_database"}, [], [], []
    finally:
        if connection is not None:
            connection.close()


def dispatch_report(args, db):
    config, config_file = saved_json(args.config)
    report, report_file = saved_json(args.receiver_report or db.parent / "worker-status.json")
    receiver = {**report_file, "current_runtime_verified": False,
                "interpretation": "saved_report_only_not_current_liveness_or_readiness"}
    if report_file["file_status"] == "recorded":
        recorded = utc_timestamp(report.get("recorded_at_utc"))
        if report.get("classification") != "local_ui_controller_health" or recorded is None or recorded > time.time() + 1:
            receiver.update(file_status="invalid", reason="unrecognized_receiver_report")
        else:
            receiver.update(recorded_at_utc=report["recorded_at_utc"], running_reported=report.get("running") is True,
                            report_age_seconds=max(0, time.time() - recorded))
            for name in ("processed_scopes", "held_conversations"):
                if type(report.get(name)) is int and report[name] >= 0:
                    receiver[name] = report[name]
            last = report.get("last_result")
            if isinstance(last, dict) and isinstance(last.get("state"), str) and re.fullmatch(r"[A-Za-z_]{1,80}", last["state"]):
                receiver["last_result_state"] = last["state"]
    configured = {**config_file, "enabled_in_config": config.get("live_dispatch_enabled") is True,
                  "browser": config.get("browser") if config.get("browser") in ("iab", "isolated_playwright") else None,
                  "establishes_runtime_readiness": False}
    return config, {"command_sends_messages": False, "configured_dispatch": configured,
                    "receiver_last_report": receiver}


def recorded_evidence(db, account):
    database, conversations, events, outbox = saved_database(db, account)
    identity, identity_file = saved_json(db.parent / "account_identity.json")
    observed = utc_timestamp(identity.get("observed_at_utc"))
    valid_identity = (isinstance(account, str) and re.fullmatch(r"[a-f0-9]{24}", account) is not None
                      and identity.get("account_id") == account and identity.get("source") == "platform_ui"
                      and isinstance(identity.get("reference"), str) and ".userInfo-popover" in identity["reference"]
                      and "主账号ID" in identity["reference"] and observed is not None and observed <= time.time() + 1
                      and identity.get("url") == "https://sxt.xiaohongshu.com/im/multiCustomerService"
                      and isinstance(identity.get("account_display_name"), str) and bool(identity["account_display_name"].strip())
                      and identity.get("title") == identity["account_display_name"] + "-私信通")
    binding = {**identity_file, "native_identity_record_valid": bool(valid_identity),
               "database_account_matches": bool(valid_identity and any(row["account_id"] == account for row in conversations)),
               "current_authentication_verified": False}
    if valid_identity:
        binding.update(account_id=account, observed_at_utc=identity["observed_at_utc"])
    inbound = {"new_visitors": 0, "customer_messages": 0, "historical_baselines": 0}
    for row in events:
        proof = row.get("evidence") or {}
        if (proof.get("source") == "platform_ui" and proof.get("account_id") == row["account_id"]
                and proof.get("conversation_id") == row["conversation_id"]):
            if row["type"] in ("NEW_VISITOR", "CUSTOMER_MESSAGE"):
                inbound["new_visitors" if row["type"] == "NEW_VISITOR" else "customer_messages"] += 1
                inbound["historical_baselines"] += proof.get("historical_baseline") is True
    history = {"text": 0, "native_card": 0, "delivery_verified": False, "read_verified": False,
               "wecom_added_verified": False, "interpretation": "saved_scoped_server_history_receipts_only"}
    for row in outbox:
        proof, payload = row.get("evidence") or {}, row.get("payload") or {}
        receipt = proof.get("native_server_history")
        if not isinstance(receipt, dict):
            continue
        native = receipt.get("native_message_id")
        parts = native.split(".") if isinstance(native, str) else []
        receipt_time = utc_timestamp(receipt.get("observed_at_utc"))
        submitted, confirmed = row.get("submitted_at"), row.get("confirmed_at")
        if (row["status"] == "SENT" and proof.get("source") == "platform_ui"
                and proof.get("account_id") == row["account_id"] and proof.get("conversation_id") == row["conversation_id"]
                and proof.get("intent_id") == row["intent_id"] and receipt.get("status") == "server_history_confirmed"
                and receipt.get("operation") == payload.get("operation") and receipt_time is not None
                and finite(submitted) and finite(confirmed) and submitted <= confirmed <= time.time() + 1
                and submitted - .001 <= receipt_time <= confirmed + .001 and proof.get("observed_at") == confirmed
                and len(parts) == 3 and re.fullmatch(r"[A-Za-z0-9_-]{1,256}", parts[2])
                and tuple(parts[:2]) in {(row["account_id"], row["conversation_id"]), (row["conversation_id"], row["account_id"])}
                and receipt.get("reference") == "https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg#" + native
                and proof.get("native_message_id") == "jarvis-msg-" + native and payload.get("operation") in ("text", "native_card")):
            history[payload["operation"]] += 1
    return {"database": database, "native_account_binding": binding, "native_inbound_observations": inbound,
            "sent_outbox_records": sum(row["status"] == "SENT" for row in outbox), "native_server_history_confirmations": history}


def doctor(args):
    db = Path(args.db).expanduser().resolve()
    config, diagnostics = dispatch_report(args, db)
    connection, connection_file = saved_json(args.connection, 1024 * 1024)
    isolated = connection.get("isolated_browser") if isinstance(connection.get("isolated_browser"), dict) else {}
    minimum = config.get("followup_minimum_seconds")
    checks = {
        "confirmed_policy": finite(minimum) and minimum >= 1800
        and config.get("platform_limit_action") == "pause_until_fresh_conversation_eligibility_evidence"
        and config.get("followup_maximum_count") is None
        and config.get("followup_expiry_seconds") is None,
        "configured_account": isinstance(config.get("account_id"), str) and re.fullmatch(r"[a-f0-9]{24}", config["account_id"]) is not None
        and (args.account is None or args.account == config["account_id"]),
        "approved_browser": (config.get("browser") == "iab" and config.get("browser_visibility") == "hidden")
        or (config.get("browser") == "isolated_playwright"
            and config.get("browser_visibility") == "headless"
            and config.get("desktop_input_allowed") is False
            and isolated.get("user_authorization") is True),
    }
    emit({
        "mode": "saved_evidence_diagnostics", "live_ready": False, **diagnostics,
        "configuration_checks": checks, "connection_file": connection_file,
        "recorded_evidence": recorded_evidence(db, args.account or config.get("account_id")),
        "unverified_requirements": ["current_browser_connection_and_authenticated_dispatch_gate",
            "continuous_cross_customer_detection_of_real_new_inbound", "real_entry_all_three_confirmed_within_five_seconds",
            "native_platform_limit_and_later_same_conversation_recovery", "background_network_and_login_recovery",
            "verified_wecom_added_or_valid_contact_association"],
        "warning": "这里只汇总保存的证据和上次运行报告，不证明当前登录或接待进程仍可用；服务器聊天记录确认不等于送达、已读或已加企微。",
    })


def main(argv=None):
    parser = argparse.ArgumentParser(description="小红书单账号接待控制与保存证据诊断；诊断命令不发送消息")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--account", default=None)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init", help="初始化空的本地持久化数据库")
    status_parser = sub.add_parser("status", help="查看保存状态、配置与上次接待报告；不证明实时就绪")
    status_parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    status_parser.add_argument("--receiver-report", default=None)
    sub.add_parser("metrics", help="查看实际观测数据，空数据不报告达标")
    sub.add_parser("rpc", help="持久 stdin/stdout JSON-lines 本机引擎桥；不启动浏览器或发送")
    audit = sub.add_parser("audit", help="查看本地审计事件")
    audit.add_argument("--limit", type=int, default=50)
    reception_audit = sub.add_parser("reception-audit", help="只读最近真实进线/开口及完整回复；历史追发不计新进线")
    reception_audit.add_argument("--limit", type=int, default=10)
    reception_audit.add_argument("--export-json", help="可选：原子导出本机私有 JSON；不修改业务数据库")
    reception_audit.add_argument("--export-html", help="可选：原子导出本机私有 HTML；客户内容仅作转义文本")
    ingest = sub.add_parser("ingest", help="录入真实观察事件；不会发送消息")
    ingest.add_argument("event_file", help="含Event字段的JSON文件")
    diag = sub.add_parser("doctor", help="报告真实接入缺口，不启动浏览器或发送")
    diag.add_argument("--config", default=str(DEFAULT_CONFIG))
    diag.add_argument("--connection", default=str(DEFAULT_CONNECTION))
    diag.add_argument("--receiver-report", default=None)
    browser = sub.add_parser("browser-probe", help="预检隔离浏览器 DOM 延迟；默认阻断，不启动浏览器")
    browser.add_argument("--allow-isolated-browser", action="store_true",
                         help="仅在用户明确批准 IAB-only 规则例外后使用；不授权接管或发送")
    browser.add_argument("--node-executable", help="已安装 Node 的绝对路径；或 XHS_PROBE_NODE_EXECUTABLE")
    browser.add_argument("--playwright-module", help="已有 Node Playwright 入口绝对路径；或 XHS_PROBE_PLAYWRIGHT_MODULE")
    args = parser.parse_args(argv)

    if args.command == "browser-probe":
        from .browser_probe import probe
        result, exit_code = probe(ROOT, allow_isolated_browser=args.allow_isolated_browser,
                                  node_executable=args.node_executable,
                                  playwright_module=args.playwright_module)
        emit(result)
        return exit_code

    if args.command == "doctor":
        doctor(args)
        return 3  # A non-ready control plane must not pass a production health check.

    if args.command == "status":
        db = Path(args.db).expanduser().resolve()
        _, diagnostics = dispatch_report(args, db)
        database, conversations, _, outbox = saved_database(db, args.account)
        emit({"mode": "saved_state_diagnostics", **diagnostics, "database": database,
              "conversations": conversations, "outbox": outbox})
        return 0 if database["file_status"] == "recorded" else 2

    if args.command == "reception-audit":
        from .reception_audit import atomic_export, read_reception_audit, render_html, validate_export_paths
        if not 1 <= args.limit <= 100:
            raise ValueError("limit must be from 1 to 100")
        validate_export_paths(args.db, args.export_json, args.export_html)
        report = read_reception_audit(args.db, account_id=args.account, limit=args.limit)
        if report["database"]["file_status"] == "recorded":
            if args.export_json:
                atomic_export(args.export_json, json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
            if args.export_html:
                atomic_export(args.export_html, render_html(report))
        emit(report)
        return 0 if report["database"]["file_status"] == "recorded" else 2

    db = Path(args.db).expanduser().resolve()
    if args.command != "init" and not db.exists():
        emit({"error": "database_not_initialized", "action": "运行 python3 -m xhs_reception init；空数据不会被当作真实进线。"})
        return 2
    if args.command == "init":
        db.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    engine = Engine(str(db))
    try:
        if args.command == "init":
            emit({"initialized": True, "db": str(db), "live_dispatch": False})
        elif args.command == "metrics":
            emit(engine.metrics(args.account))
        elif args.command == "rpc":
            from .rpc_bridge import serve
            serve(engine, sys.stdin, sys.stdout, account_id=args.account)
        elif args.command == "audit":
            if args.limit < 1:
                raise ValueError("limit must be positive")
            emit(engine.audit(args.account)[-args.limit:])
        elif args.command == "ingest":
            event_data = read_json(args.event_file)
            allowed = {field.name for field in fields(Event)}
            unknown = set(event_data) - allowed
            if unknown:
                raise ValueError("unsupported event fields: " + ", ".join(sorted(unknown)))
            if args.account and event_data.get("account_id") != args.account:
                raise ValueError("event account differs from selected account")
            emit(engine.ingest_event(Event(**event_data)))
    finally:
        close = getattr(engine, "close", None)
        if close:
            close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, TypeError, EngineError, sqlite3.Error) as error:
        emit({"error": str(error)})
        sys.exit(2)
