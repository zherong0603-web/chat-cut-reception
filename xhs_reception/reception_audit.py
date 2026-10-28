"""Read-only reception projection over the existing Engine tables.

Grouping is for human review only. It never supplies business events, dispatch
permission, notification delivery or five-second acceptance evidence.
"""

from datetime import datetime, timezone
import html
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import time
from zoneinfo import ZoneInfo

from .engine import Engine


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _utc(value):
    if not _finite(value):
        return None
    try:
        return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError):
        return None


def _proof(row):
    return row.get("evidence") or {}


def _platform_time(row):
    return row.get("timestamp") if row.get("timestamp_source") == "platform_ui" and _finite(row.get("timestamp")) else None


def _milliseconds(observed, origin):
    return round((observed - origin) * 1000, 3) if _finite(observed) and _finite(origin) else None


def _parse_utc(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value):
        return None
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00").timestamp()
    except ValueError:
        return None


def _order(row):
    return (row["timestamp"] if _finite(row.get("timestamp")) else row["detected_at"],
            row["detected_at"], row["event_id"])


def _native_pair(value, account, conversation):
    if not isinstance(value, str):
        return False
    for prefix in (account + "." + conversation + ".", conversation + "." + account + "."):
        if value.startswith(prefix) and re.fullmatch(r"[A-Za-z0-9_-]{1,256}", value[len(prefix):]):
            return True
    return False


def _scoped(proof, row):
    return (proof.get("source") == "platform_ui" and proof.get("account_id") == row["account_id"]
            and proof.get("conversation_id") == row["conversation_id"]
            and isinstance(proof.get("reference"), str) and bool(proof["reference"])
            and _finite(proof.get("observed_at")))


def _native_inbound(row, now):
    proof = _proof(row)
    native = row["event_id"][3:] if row["event_id"].startswith("id_") else None
    expected = ("TEXT", "left") if row["type"] == "CUSTOMER_MESSAGE" else ("RICH_HINT", "center")
    return (_scoped(proof, row) and _native_pair(native, row["account_id"], row["conversation_id"])
            and proof.get("native_message_id") == "jarvis-msg-" + native
            and proof.get("reference") == row["event_id"]
            and (proof.get("native_message_type"), proof.get("native_direction")) == expected
            and proof["observed_at"] == row["detected_at"] and row["detected_at"] <= now + 1
            and (row.get("timestamp") is None or _finite(row["timestamp"]) and row["timestamp"] <= row["detected_at"] + 1))


def _history_confirmed(row, now):
    proof, payload = _proof(row), row["payload"]
    receipt = proof.get("native_server_history")
    if not isinstance(receipt, dict):
        return False
    native = receipt.get("native_message_id")
    receipt_time = _parse_utc(receipt.get("observed_at_utc"))
    return (row["status"] == "SENT" and _scoped(proof, row) and proof.get("intent_id") == row["intent_id"]
            and _finite(row.get("submitted_at")) and _finite(row.get("confirmed_at"))
            and row["submitted_at"] <= row["confirmed_at"] <= now + 1
            and proof["observed_at"] == row["confirmed_at"]
            and receipt_time is not None and row["submitted_at"] - .001 <= receipt_time <= row["confirmed_at"] + .001
            and receipt.get("status") == "server_history_confirmed"
            and receipt.get("operation") == payload.get("operation")
            and _native_pair(native, row["account_id"], row["conversation_id"])
            and proof.get("native_message_id") == "jarvis-msg-" + native
            and receipt.get("reference") == "https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg#" + native)


def _attempt(row, now):
    proof, payload = _proof(row), row["payload"]
    confirmed = _history_confirmed(row, now)
    card_confirmed = (confirmed and payload.get("operation") == "native_card"
                      and proof.get("native_wecom_card_confirmed") is True)
    return {"intent_id": row["intent_id"], "source_event_id": row["source_event_id"],
            "reception_event_id": proof.get("reception_event_id"), "kind": row["kind"],
            "operation": payload.get("operation"), "status": row["status"],
            "text": payload.get("text") if payload.get("operation") == "text" else None,
            "created_at_utc": _utc(row["created_at"]), "submitted_at_utc": _utc(row.get("submitted_at")),
            "confirmed_at_utc": _utc(row.get("confirmed_at")) if row["status"] == "SENT" else None,
            "confirmed_at_timestamp": row.get("confirmed_at") if row["status"] == "SENT" else None,
            "native_message_id": proof.get("native_message_id"),
            "native_history_observed_at_utc": proof.get("native_server_history", {}).get("observed_at_utc") if isinstance(proof.get("native_server_history"), dict) else None,
            "native_history_confirmed": confirmed, "native_wecom_card_confirmed": card_confirmed,
            "usefulness_verified": proof.get("usefulness_verified") is True and proof.get("useful") is True,
            "submission_unknown": row["status"] in ("SUBMITTING", "UNKNOWN"),
            "result": ("native_history_confirmed" if confirmed and (payload.get("operation") != "native_card" or card_confirmed)
                       else "sent_recorded" if row["status"] == "SENT"
                       else "submission_unknown" if row["status"] in ("SUBMITTING", "UNKNOWN") else "not_sent")}


def _inbound(row):
    proof = _proof(row)
    return {"event_id": row["event_id"], "type": row["type"],
            "customer_text": proof.get("untrusted_message_text") if row["type"] == "CUSTOMER_MESSAGE" else None,
            "customer_display_name": proof.get("untrusted_customer_display_name") or row["conversation_id"],
            "platform_entry_text": proof.get("untrusted_message_text") if row["type"] == "NEW_VISITOR" else None,
            "platform_received_at_utc": _utc(_platform_time(row)), "timestamp_source": row["timestamp_source"],
            "recorded_timestamp_utc": _utc(row.get("timestamp")),
            "detected_at_utc": _utc(row["detected_at"]), "native_message_id": proof.get("native_message_id"),
            "detection_delay_ms": _milliseconds(row["detected_at"], _platform_time(row)),
            "response_intent_ids": [], "text_reply_status": "not_sent", "native_card_status": "not_sent"}


def _result(attempts, operation):
    relevant = [item for item in attempts if item["operation"] == operation]
    # A later unresolved operation stays visible even if an earlier one succeeded.
    if any(item["submission_unknown"] for item in relevant):
        return "submission_unknown"
    if any(item["result"] == "native_history_confirmed" for item in relevant):
        return "native_history_confirmed"
    if any(item["status"] == "SENT" for item in relevant):
        return "sent_recorded"
    return "not_sent"


def build_reception_audit(conversations, events, outbox, *, account_id=None, limit=10, now=None, core_bundle=None):
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("limit must be an integer from 1 to 100")
    now = time.time() if now is None else now
    selected = [event for event in events if (account_id is None or event["account_id"] == account_id)
                and event["type"] in ("NEW_VISITOR", "CUSTOMER_MESSAGE")]
    historical = [event for event in selected if _proof(event).get("historical_baseline") is True]
    observed = [event for event in selected if _proof(event).get("historical_baseline") is not True
                and _native_inbound(event, now)]
    observed.sort(key=_order)
    event_index = {(row["account_id"], row["event_id"]): row for row in observed}
    anchors, membership, latest_entry = {}, {}, {}
    for event in observed:
        scope = (event["account_id"], event["conversation_id"])
        key = (event["account_id"], event["event_id"])
        if event["type"] == "NEW_VISITOR":
            latest_entry[scope] = key
        anchor = key if event["type"] == "NEW_VISITOR" or scope not in latest_entry else latest_entry[scope]
        if anchor == key:
            anchors[key] = {"account_id": event["account_id"], "conversation_id": event["conversation_id"],
                            "customer_display_name": _proof(event).get("untrusted_customer_display_name") or event["conversation_id"],
                            "anchor_event_id": event["event_id"],
                            "anchor_type": "platform_entry" if event["type"] == "NEW_VISITOR" else "customer_message_opening",
                            "received_at_utc": _utc(_platform_time(event)), "timestamp_source": event["timestamp_source"],
                            "recorded_timestamp_utc": _utc(event.get("timestamp")),
                            "detected_at_utc": _utc(event["detected_at"]), "inbound_events": [],
                            "detection_delay_ms": _milliseconds(event["detected_at"], _platform_time(event)),
                            "takeover_evidence": [], "reply_attempts": [], "association_warnings": []}
        membership[key] = anchor
        anchors[anchor]["inbound_events"].append(_inbound(event))
    excluded_historical_attempts, outbound_exceptions = 0, []
    for row in outbox:
        if account_id is not None and row["account_id"] != account_id:
            continue
        source = event_index.get((row["account_id"], row["source_event_id"]))
        if source is None or source["conversation_id"] != row["conversation_id"]:
            excluded_historical_attempts += 1
            if row["status"] in ("UNKNOWN", "SUBMITTING", "LIMIT", "EXPIRED"):
                outbound_exceptions.append({"account_id": row["account_id"], "conversation_id": row["conversation_id"],
                    "historical_or_unassigned": True, "counts_as_new_reception": False, **_attempt(row, now)})
            continue
        source_key = (row["account_id"], row["source_event_id"])
        anchor = membership[source_key]
        explicit = _proof(row).get("reception_event_id")
        association = "source_event" if source["type"] == "NEW_VISITOR" else "presentation_only"
        if explicit is not None:
            target_key = (row["account_id"], explicit)
            target = event_index.get(target_key)
            valid = (target is not None and target["type"] == "NEW_VISITOR"
                     and target["conversation_id"] == row["conversation_id"]
                     and (source["type"] != "NEW_VISITOR" or explicit == source["event_id"]))
            if not valid:
                anchors[anchor]["association_warnings"].append({"intent_id": row["intent_id"], "reason": "invalid_explicit_entry_link"})
            else:
                anchor = target_key
                association = "source_event" if source["type"] == "NEW_VISITOR" else "explicit_reception_event"
        projected = _attempt(row, now)
        projected["entry_association"] = association
        projected["source_platform_to_submit_ms"] = _milliseconds(row.get("submitted_at"), _platform_time(source))
        projected["source_platform_to_confirm_ms"] = _milliseconds(row.get("confirmed_at"), _platform_time(source)) if row["status"] == "SENT" else None
        entry_clock = _platform_time(event_index[anchor])
        projected["entry_platform_to_submit_ms"] = _milliseconds(row.get("submitted_at"), entry_clock)
        projected["entry_platform_to_confirm_ms"] = _milliseconds(row.get("confirmed_at"), entry_clock) if row["status"] == "SENT" else None
        anchors[anchor]["reply_attempts"].append(projected)
        # Direct source association alone answers this exact customer event.
        for unit in anchors.values():
            for incoming in unit["inbound_events"]:
                if unit["account_id"] == row["account_id"] and unit["conversation_id"] == row["conversation_id"] and incoming["event_id"] == row["source_event_id"]:
                    incoming["response_intent_ids"].append(row["intent_id"])
    for event in events:
        if event["type"] != "PLATFORM_TAKEOVER_CONFIRMED":
            continue
        proof = _proof(event)
        key = (event["account_id"], proof.get("source_event_id"))
        if key in anchors and anchors[key]["conversation_id"] == event["conversation_id"] and _scoped(proof, event) and proof.get("taken_over") is True and proof["observed_at"] <= now + 1 and (event_index[key].get("timestamp") is None or proof["observed_at"] >= event_index[key]["timestamp"]):
            anchors[key]["takeover_evidence"].append({"event_id": event["event_id"], "reference": proof["reference"],
                "confirmed_at_utc": _utc(proof["observed_at"]), "taken_over": True,
                "confirmed_at_timestamp": proof["observed_at"],
                "platform_to_confirm_ms": _milliseconds(proof["observed_at"], _platform_time(event_index[key]))})
    conversation_index = {(row["account_id"], row["conversation_id"]): row for row in conversations}
    for key, unit in anchors.items():
        unit["reply_attempts"].sort(key=lambda item: (item["created_at_utc"] or "", item["intent_id"]))
        for incoming in unit["inbound_events"]:
            attempts = [attempt for other in anchors.values() for attempt in other["reply_attempts"]
                        if attempt["intent_id"] in incoming["response_intent_ids"]]
            incoming["text_reply_status"] = _result(attempts, "text")
            incoming["native_card_status"] = _result(attempts, "native_card")
        latest = unit["inbound_events"][-1]
        con = conversation_index.get((unit["account_id"], unit["conversation_id"]), {})
        unit["conversation_state"] = con.get("state", "unknown")
        unit["stop_reason"] = con.get("stop_reason")
        unit["latest_inbound_event_id"] = latest["event_id"]
        unit["latest_inbound_text_reply_status"] = latest["text_reply_status"]
        unit["latest_inbound_native_card_status"] = latest["native_card_status"]
        unit["contains_unknown"] = any(attempt["submission_unknown"] for attempt in unit["reply_attempts"])
        exact = [attempt for attempt in unit["reply_attempts"] if attempt["entry_association"] != "presentation_only"]
        text = [attempt for attempt in exact if attempt["kind"] in ("initial", "reply") and attempt["operation"] == "text" and attempt["native_history_confirmed"] and attempt["usefulness_verified"]]
        cards = [attempt for attempt in exact if attempt["kind"] == "card" and attempt["native_wecom_card_confirmed"]]
        core_sample = next((sample for sample in (core_bundle or {}).get("samples", [])
                            if sample["account_id"] == unit["account_id"] and sample["entry_event_id"] == unit["anchor_event_id"]), None)
        strict_receipts = unit["anchor_type"] == "platform_entry" and bool(unit["takeover_evidence"]) and bool(text) and bool(cards)
        core_milestones_verified = (core_sample is not None
            and core_sample["useful_text_confirmed_at"] in {attempt["confirmed_at_timestamp"] for attempt in text}
            and core_sample["native_wecom_card_confirmed_at"] in {attempt["confirmed_at_timestamp"] for attempt in cards}
            and core_sample["platform_takeover_confirmed_at"] in {proof["confirmed_at_timestamp"] for proof in unit["takeover_evidence"]})
        complete = (strict_receipts and _platform_time(event_index[key]) is not None and core_sample is not None
                    and core_sample["complete"] is True and core_milestones_verified
                    and core_sample["platform_entry_to_all_confirmed_seconds"] >= 0)
        unit["full_bundle"] = {"assessment": core_sample["assessment"] if complete else "unverified",
            "complete": bool(complete), "target_ms": 5000,
            "platform_to_all_confirmed_ms": _milliseconds(core_sample["completed_at"], core_sample["platform_entry_at"]) if complete else None,
            "clock_source": unit["timestamp_source"], "policy": "existing_core_bundle_plus_scoped_native_history_required"}
        # Preserve the original five-second field for historical readers. The
        # current target has its own verdict and exactly the same strict proof
        # requirements; a legacy pass must never stand in for a three-second pass.
        within_three = complete and core_sample["platform_entry_to_all_confirmed_seconds"] <= 3
        unit["three_second_bundle"] = {**unit["full_bundle"], "target_ms": 3000,
            "assessment": ("meets" if within_three else "misses") if complete else "unverified"}
    ordered = sorted(anchors, key=lambda key: _order(event_index[key]), reverse=True)
    return {"classification": "local_reception_audit_projection", "generated_at_utc": _utc(now),
            "read_only": True, "command_sends_messages": False, "account_scope": account_id,
            "counting_rule": "each_nonhistorical_native_NEW_VISITOR; each_native_CUSTOMER_MESSAGE_without_a_preceding_nonhistorical_entry_is_a_message_opening",
            "grouping": "later_customer_messages_in_same_conversation_use_latest_entry_window_for_presentation_only",
            "acceptance_credit": "full_bundle_uses_existing_core_and_strict_receipts_only; presentation_grouping_earns_none",
            "total_observed_units": len(anchors), "returned_units": min(limit, len(anchors)),
            "platform_entry_units": sum(unit["anchor_type"] == "platform_entry" for unit in anchors.values()),
            "message_opening_units": sum(unit["anchor_type"] == "customer_message_opening" for unit in anchors.values()),
            "excluded_historical_inbound_events": len(historical),
            "excluded_unverified_inbound_events": len(selected) - len(historical) - len(observed),
            "excluded_outbox_without_current_observed_source": excluded_historical_attempts,
            "historical_or_unassigned_outbound_exceptions": sorted(outbound_exceptions, key=lambda item: item["created_at_utc"] or "", reverse=True)[:100],
            "samples": [anchors[key] for key in ordered[:limit]]}


def read_reception_audit(db_path, *, account_id=None, limit=10):
    db = Path(db_path).expanduser().resolve()
    if not db.is_file():
        return {"database": {"file_status": "missing"}, "samples": [], "total_observed_units": None}
    connection = None
    try:
        connection = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        values = []
        for table in ("conversations", "events", "outbox"):
            sql, parameters = "SELECT * FROM " + table, ()
            if account_id is not None:
                sql += " WHERE account_id=?"
                parameters = (account_id,)
            rows = []
            for saved in connection.execute(sql, parameters):
                row = dict(saved)
                for name in ("evidence", "payload"):
                    if name in row:
                        row[name] = json.loads(row[name]) if row[name] else {}
                        if not isinstance(row[name], dict):
                            raise ValueError("invalid saved object")
                rows.append(row)
            values.append(rows)
        now = time.time()
        bundle = Engine.reception_metrics_snapshot(connection, account_id, clock=lambda: now)
        result = build_reception_audit(*values, account_id=account_id, limit=limit, now=now, core_bundle=bundle)
        return {"database": {"file_status": "recorded", "read_only": True}, **result}
    except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
        return {"database": {"file_status": "invalid", "reason": "unreadable_or_invalid_database"},
                "samples": [], "total_observed_units": None}
    finally:
        if connection is not None:
            connection.close()


def validate_export_paths(db_path, *paths):
    """Reject aliases of the source SQLite/sidecars before writing any export."""
    db = Path(db_path).expanduser().resolve()
    protected = [db] + [Path(str(db) + suffix) for suffix in ("-wal", "-shm", "-journal")]
    destinations = [Path(path).expanduser().resolve() for path in paths if path is not None]
    def same(left, right):
        return left == right or left.exists() and right.exists() and left.samefile(right)
    if any(same(destination, source) for destination in destinations for source in protected):
        raise ValueError("audit exports must not replace the source database or SQLite sidecars")
    if any(same(left, right) for index, left in enumerate(destinations) for right in destinations[index + 1:]):
        raise ValueError("JSON and HTML audit exports must have distinct destinations")


def atomic_export(path, text):
    # Replace the chosen directory entry rather than following a final symlink.
    destination = Path(path).expanduser().absolute()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination.parent,
                                         prefix="." + destination.name + ".", delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def _render_customer_cards_html(report):
    escape = lambda value: html.escape(str(value) if value is not None else "待核实", quote=True)
    fields = (("customer", "客户"), ("reply", "我方回复"),
              ("progress", "客户进展"), ("action", "需要你处理"))
    blocks = []
    for card in report["customer_cards"]:
        brief = card.get("customer_brief", {})
        evidence = dict(card.get("technical_details", {}))
        evidence["conversation_id"] = card.get("conversation_id")
        evidence["account_id"] = card.get("account_id")
        body = "".join("<div class=field><dt>" + label + "</dt><dd>" +
                       escape(brief.get(key)) + "</dd></div>" for key, label in fields)
        blocks.append("<article><dl>" + body + "</dl><details><summary>技术详情</summary><pre>" +
                      escape(json.dumps(evidence, ensure_ascii=False, indent=2)) + "</pre></details></article>")
    metadata = {key: value for key, value in report.items() if key not in ("samples", "customer_cards")}
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">'
            '<title>客户接待动态</title><style>body{font:16px system-ui;max-width:800px;margin:24px auto;padding:0 16px;'
            'background:#f5f6f8;color:#19202b}article{background:white;padding:20px;margin:16px 0;border-radius:12px}'
            'dl{margin:0}.field{margin:0 0 16px}dt{font-size:13px;color:#586374;margin-bottom:5px}'
            'dd{margin:0;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}'
            'details{border-top:1px solid #e4e8ed;padding-top:12px}summary{cursor:pointer;color:#4d5d73}'
            'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f3f6;padding:12px;font-size:13px}'
            '@media(prefers-color-scheme:dark){body{background:#16191e;color:#ebedf2}article{background:#22262d}'
            'dt,summary{color:#b0bac9}details{border-color:#3a414d}pre{background:#181c22}}</style>'
            '<h1>客户接待动态</h1>' + ("".join(blocks) if blocks else '<p>暂无客户接待更新</p>') +
            '<details><summary>报告详情</summary><pre>' +
            escape(json.dumps(metadata, ensure_ascii=False, indent=2)) + '</pre></details></html>\n')


def render_html(report):
    if isinstance(report.get("customer_cards"), list):
        return _render_customer_cards_html(report)
    escape = lambda value: html.escape(str(value) if value is not None else "unknown", quote=True)
    labels = {"platform_entry": "真实进入私信", "customer_message_opening": "仅观测到客户开口（无进线事件）",
        "NEW_VISITOR": "平台进线提示", "CUSTOMER_MESSAGE": "客户开口", "text": "文字", "native_card": "原生企微卡",
        "SENT": "已记录发送", "UNKNOWN": "结果未知，禁止重发", "SUBMITTING": "已开始提交，待核验",
        "PREPARED": "草稿已准备，未提交", "CLAIMED": "已领取，未提交", "CANCELLED": "已取消，未发送",
        "EXPIRED": "已过期，未发送", "LIMIT": "平台限制", "ACTIVE": "自动接待中", "HUMAN": "外部操作方接管",
        "STOPPED": "已停止", "PAUSED_LIMIT": "平台限制暂停", "unknown": "未知",
        "initial": "首次回复", "reply": "回答开口", "followup": "后续跟进", "card": "伴随企微卡",
        "native_history_confirmed": "原生聊天记录已核验", "sent_recorded": "仅有发送记录，原生回执未核验",
        "submission_unknown": "提交结果未知，禁止重发", "not_sent": "尚未确认发送",
        "unverified": "未验证", "meets": "三项均在5秒内确认", "misses": "三项已确认，但超过5秒"}
    label = lambda value: escape(labels.get(value, value))
    current_label = lambda value: escape({"meets": "三项均在3秒内确认", "misses": "三项已确认，但超过3秒",
                                         "unverified": "未验证"}.get(value, value))
    def display_time(value):
        stamp = _parse_utc(value)
        if stamp is None:
            return "未知"
        local = datetime.fromtimestamp(stamp, timezone.utc).astimezone(ZoneInfo("Asia/Shanghai"))
        return escape(local.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]) + "（上海）<br><small>UTC " + escape(value) + "</small>"
    def display_ms(value):
        return escape(value) + " ms" if _finite(value) else "未知"
    def operation_html(item):
        return ("<li><p>" + label(item["kind"]) + " / " + label(item["operation"]) + " / " + label(item["status"]) +
                "</p><p>" + label(item["result"]) + "</p>" + ("<pre>" + escape(item["text"]) + "</pre>" if item["text"] is not None else "") +
                "<p>提交 " + display_time(item["submitted_at_utc"]) + "；确认 " + display_time(item["confirmed_at_utc"]) +
                "</p><p>相对客户原消息：提交 " + display_ms(item.get("source_platform_to_submit_ms")) + "；确认 " +
                display_ms(item.get("source_platform_to_confirm_ms")) + "</p><p>相对本次平台进线：提交 " +
                display_ms(item.get("entry_platform_to_submit_ms")) + "；确认 " + display_ms(item.get("entry_platform_to_confirm_ms")) +
                "</p><code>" + escape(item["intent_id"]) + "</code></li>")
    blocks = []
    for unit in report.get("samples", []):
        incoming = "".join("<li><p>" + label(item["type"]) + " · 收到 " + display_time(item["platform_received_at_utc"]) +
                           " · 检测 " + display_time(item["detected_at_utc"]) + "</p><p>检测延迟 " + display_ms(item["detection_delay_ms"]) + "</p><pre>" +
                           escape(item["customer_text"] or item["platform_entry_text"]) + "</pre><p>文字：" +
                           label(item["text_reply_status"]) + "；企微卡：" + label(item["native_card_status"]) + "</p></li>"
                           for item in unit["inbound_events"])
        replies = "".join(operation_html(item) for item in unit["reply_attempts"])
        takeovers = "".join("<li>平台接管确认 " + display_time(item["confirmed_at_utc"]) + "；距进线 " +
                             display_ms(item["platform_to_confirm_ms"]) + "<br><code>" + escape(item["reference"]) + "</code></li>"
                             for item in unit["takeover_evidence"]) or "<li>尚无接管确认回执</li>"
        blocks.append("<article><h2>" + label(unit["anchor_type"]) + " · " + escape(unit["customer_display_name"]) +
                      "</h2><p><code>" + escape(unit["conversation_id"]) + "</code></p><p>进线/开口 " + display_time(unit["received_at_utc"]) +
                      "；检测延迟 " + display_ms(unit["detection_delay_ms"]) + "</p><p>3秒三项验收：" + current_label(unit["three_second_bundle"]["assessment"]) +
                      "；总耗时 " + display_ms(unit["three_second_bundle"]["platform_to_all_confirmed_ms"]) +
                      "</p><p>历史5秒口径：" + label(unit["full_bundle"]["assessment"]) + "</p><ol>" + takeovers +
                      "</ol><p>当前状态 " + label(unit["conversation_state"]) + "；存在未核验操作：" + ("是" if unit["contains_unknown"] else "否") +
                      "</p><h3>真实入站</h3><ol>" + incoming + "</ol><h3>我方操作</h3><ol>" + replies + "</ol></article>")
    exceptions = report.get("historical_or_unassigned_outbound_exceptions", [])
    exception_html = ("<article><h2>历史或未归属的异常操作（不计新进线）</h2>" + "".join(
        "<h3>" + escape(item["conversation_id"]) + "</h3><ol>" + operation_html(item) + "</ol>" for item in exceptions) + "</article>") if exceptions else ""
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
            '<meta http-equiv="refresh" content="2"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">'
            '<title>最近真实接待审计</title><style>body{font:16px system-ui;max-width:1000px;margin:24px auto;padding:0 16px;'
            'background:#f5f6f8;color:#19202b}article{background:white;padding:20px;margin:16px 0;border-radius:12px}'
            'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f3f6;padding:12px}code{overflow-wrap:anywhere}'
            'li{margin:16px 0}p{line-height:1.5}</style><h1>最近真实接待审计</h1><p>生成 UTC ' +
            escape(report.get("generated_at_utc")) + '；样本 ' + escape(report.get("returned_units", 0)) +
            '。只读保存证据，不代表送达、已读、已加企微或 5 秒达标。</p>' +
            ("".join(blocks) if blocks else "<p>当前无可显示的真实新进线或开口样本。</p>") + exception_html + '</html>\n')
