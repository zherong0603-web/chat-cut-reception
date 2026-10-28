"""Independent, read-only business observer. Never dispatches customer messages.

Run separately from the UI worker. The notification command completing is not
evidence that macOS displayed it or that the user read it. No Engine is created.
"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import time

from .reception_audit import (atomic_export, read_reception_audit, render_html,
                              validate_export_paths, _history_confirmed)


VERSION = 1
STATES = {"SENT", "UNKNOWN", "EXPIRED", "BLOCKED", "NOT_SENT"}
ACTIONS = {"SEND_SENT": "SENT", "RECONCILED_SENT": "SENT",
           "SEND_UNKNOWN": "UNKNOWN", "RECOVERY_UNKNOWN": "UNKNOWN",
           "INTENT_EXPIRED_UNSUBMITTED": "EXPIRED", "INTENT_CANCELLED": "BLOCKED",
           "SEND_LIMIT": "BLOCKED", "RECONCILED_NOT_SENT": "NOT_SENT"}


def _current_state_matches(row, state):
    return row["status"] in ({"CANCELLED", "LIMIT", "BLOCKED"} if state == "BLOCKED" else {state})
SCRIPT = '''on run argv
display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv) sound name "Glass"
end run
'''


class NotifierError(Exception):
    pass


def _json(path):
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream)


def _safe_text(value, maximum=240):
    if not isinstance(value, str):
        return ""
    return value.encode("utf-8", "replace").decode("utf-8")[:maximum]


def _utc(value=None):
    return datetime.fromtimestamp(time.time() if value is None else value, timezone.utc).isoformat(timespec="milliseconds")


def _export(path, value):
    path = Path(path)
    if path.is_symlink():
        raise NotifierError("output_symlink_rejected")
    atomic_export(path, json.dumps(value, ensure_ascii=True, allow_nan=False, indent=2) + "\n")


def _export_text(path, value):
    if Path(path).is_symlink():
        raise NotifierError("output_symlink_rejected")
    atomic_export(path, value)


@contextmanager
def _lock(path, nonblocking=True):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        except BlockingIOError as error:
            raise NotifierError("notifier_already_running") from error
        yield
    finally:
        os.close(descriptor)


def notify_macos(title, subtitle, body, *, runner=subprocess.run):
    """Fixed source, argv-only content, no shell; bounded independent process."""
    try:
        result = runner(["/usr/bin/osascript", "-", _safe_text(title, 120), _safe_text(subtitle, 120),
                         _safe_text(body)], input=SCRIPT, text=True, capture_output=True,
                        timeout=3, check=False)
        return {"command_state": "command_completed" if result.returncode == 0 else "command_failed",
                "exit_code": result.returncode, "visible_verified": False, "user_read_verified": False}
    except subprocess.TimeoutExpired:
        return {"command_state": "command_timed_out", "visible_verified": False, "user_read_verified": False}
    except OSError:
        return {"command_state": "command_unavailable", "visible_verified": False, "user_read_verified": False}


def read_snapshot(db, cursor, account):
    """One SQLite read transaction; never initializes/migrates a database."""
    connection = None
    try:
        if not db.is_file():
            raise NotifierError("database_missing")
        connection = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=.2)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        maximum = connection.execute("SELECT COALESCE(MAX(id),0) FROM audit_log").fetchone()[0]
        audits = [dict(row) for row in connection.execute(
            "SELECT * FROM audit_log WHERE id>? ORDER BY id LIMIT 500", (cursor,))]
        outbox = {}
        conversations = {row["conversation_id"]: dict(row) for row in connection.execute(
            "SELECT * FROM conversations WHERE account_id=?", (account,))}
        for row in connection.execute("SELECT * FROM outbox WHERE account_id=?", (account,)):
            row = dict(row)
            for name in ("payload", "evidence"):
                row[name] = json.loads(row[name]) if row[name] else {}
                if not isinstance(row[name], dict):
                    raise ValueError("invalid object")
            row["conversation"] = conversations.get(row["conversation_id"], {})
            outbox[row["intent_id"]] = row
        sources = {}
        for row in connection.execute("SELECT * FROM events WHERE account_id=?", (account,)):
            row = dict(row)
            row["evidence"] = json.loads(row["evidence"])
            if not isinstance(row["evidence"], dict):
                raise ValueError("invalid object")
            sources[(row["conversation_id"], row["event_id"])] = row
        return maximum, audits, outbox, sources
    except (OSError, sqlite3.Error, ValueError, TypeError) as error:
        raise NotifierError("database_unreadable_or_invalid") from error
    finally:
        if connection is not None:
            connection.close()


def _descriptor(row, state, sources, existing=False, outbox=None):
    source = sources.get((row["conversation_id"], row["source_event_id"]), {})
    proof = source.get("evidence", {})
    name = next((_safe_text(proof.get(key), 60) for key in
                 ("untrusted_customer_display_name", "untrusted_customer_name", "customer_name")
                 if isinstance(proof.get(key), str) and proof[key].strip()), "UID " + row["conversation_id"][-8:])
    historical = row["kind"] == "followup" or proof.get("historical_baseline") is True
    kind = "历史跟进" if historical else "客户接待"
    operation = "企微卡" if row["payload"].get("operation") == "native_card" else "文字"
    label = {"SENT": "已核验发送", "UNKNOWN": "结果未知，已停发", "EXPIRED": "发送前过期，未发送",
             "BLOCKED": "发送被阻止或已取消", "NOT_SENT": "已核验未发送"}[state]
    if state == "SENT" and not _history_confirmed(row, time.time()):
        label = "已记录SENT，原生回执未核验"
    title = ("存量异常 · " if existing else "") + name + " · " + label
    body = row["payload"].get("text") if operation == "文字" else "企业微信名片"
    return title, kind + " · " + operation, _safe_text(body), historical


def _card_state(row, outbox):
    def status(item):
        if item["status"] == "SENT" and not (_history_confirmed(item, time.time())
                and item["evidence"].get("native_wecom_card_confirmed") is True):
            return "SENT_UNVERIFIED"
        return item["status"]
    if row["payload"].get("operation") == "native_card":
        return status(row)
    companions = [item for item in outbox.values() if item["account_id"] == row["account_id"]
        and item["conversation_id"] == row["conversation_id"] and item["payload"].get("operation") == "native_card"
        and (item["payload"].get("companion_text_intent_id") == row["intent_id"] or
             row["kind"] != "followup" and item["source_event_id"] == row["source_event_id"]
             and item["created_at"] >= row["created_at"])]
    return status(max(companions, key=lambda item: item["created_at"])) if companions else "NOT_CONFIRMED"


def _native_control(event, row):
    proof = event.get("evidence", {})
    observed = proof.get("observed_at")
    return (event.get("account_id") == row["account_id"]
        and event.get("conversation_id") == row["conversation_id"]
        and proof.get("source") in ("platform_ui", "official_api")
        and proof.get("account_id") == row["account_id"]
        and proof.get("conversation_id") == row["conversation_id"]
        and isinstance(proof.get("reference"), str) and bool(proof["reference"].strip())
        and type(observed) in (int, float) and math.isfinite(observed) and observed <= time.time() + 1)


def _latest_customer_words(row, source, sources):
    floor = source.get("timestamp")
    if type(floor) not in (int, float) or not math.isfinite(floor):
        floor = source.get("detected_at")
    if type(floor) not in (int, float) or not math.isfinite(floor):
        return None
    candidates = []
    for event in sources.values():
        proof = event.get("evidence", {})
        at, detected = event.get("timestamp"), event.get("detected_at")
        event_id = event.get("event_id")
        if (event.get("type") != "CUSTOMER_MESSAGE" or not _native_control(event, row)
                or type(at) not in (int, float) or not math.isfinite(at) or at < floor
                or type(detected) not in (int, float) or not math.isfinite(detected)
                or at > detected + 1 or detected > time.time() + 1
                or proof.get("historical_baseline") is not False
                or proof.get("native_message_type") != "TEXT" or proof.get("native_direction") != "left"
                or not isinstance(event_id, str) or proof.get("reference") != event_id
                or proof.get("native_message_id") != "jarvis-msg-" + event_id[3:]):
            continue
        prefixes = ("id_" + row["account_id"] + "." + row["conversation_id"] + ".",
                    "id_" + row["conversation_id"] + "." + row["account_id"] + ".")
        if not any(event_id.startswith(prefix) and re.fullmatch(r"[A-Za-z0-9_-]{1,256}",
                event_id[len(prefix):]) for prefix in prefixes):
            continue
        if _safe_text(proof.get("untrusted_message_text"), 4000):
            candidates.append(event)
    return max(candidates, key=lambda event: (event["timestamp"], event["detected_at"], event["event_id"])) if candidates else None


def _business_summary(row, source, sources, outbox, reply_row):
    """A display-only projection. No scheduling, reconciliation or send actions."""
    proof = source.get("evidence", {})
    customer = next((_safe_text(proof.get(key), 128) for key in
        ("untrusted_customer_display_name", "untrusted_customer_name", "customer_name")
        if isinstance(proof.get(key), str) and proof[key].strip()), "昵称未记录")
    historical = row["kind"] == "followup" or proof.get("historical_baseline") is True
    if historical:
        activity = "历史跟进"
    elif source.get("type") == "NEW_VISITOR":
        activity = "新进线，尚未开口"
    elif source.get("type") == "CUSTOMER_MESSAGE":
        activity = "客户新开口"
    else:
        activity = "接待更新，进线类型待核验"
    incoming = (_safe_text(proof.get("untrusted_message_text"), 4000)
                if source.get("type") == "CUSTOMER_MESSAGE" else "")
    if not incoming:
        incoming = "尚未开口" if source.get("type") == "NEW_VISITOR" else "原话未记录"
    latest = _latest_customer_words(row, source, sources)
    later_opening = latest is not None and latest["event_id"] != source.get("event_id")
    if later_opening:
        activity = "客户后续开口"
        incoming = _safe_text(latest["evidence"].get("untrusted_message_text"), 4000)
        latest_attempts = [other for other in outbox.values() if other["account_id"] == row["account_id"]
            and other["conversation_id"] == row["conversation_id"] and other["source_event_id"] == latest["event_id"]
            and other["payload"].get("operation") == "text"]
        if latest_attempts:
            reply_row = max(latest_attempts, key=lambda other: other["created_at"])
    controls = [event for event in sources.values() if _native_control(event, row)]
    anchor_ids = {row["source_event_id"], row["evidence"].get("reception_event_id")}
    taken_over = any(event["type"] == "PLATFORM_TAKEOVER_CONFIRMED"
        and event["evidence"].get("taken_over") is True
        and event["evidence"].get("source_event_id") in anchor_ids for event in controls)
    wechat = any(event["type"] == "WECHAT_VERIFIED"
                 and event["evidence"].get("verified") is True for event in controls)
    lead = any(event["type"] == "LEAD_VERIFIED"
               and event["evidence"].get("verified") is True for event in controls)
    refused = any(event["type"] == "REFUSED" for event in controls)
    lead_summary = "已添加企微" if wechat else "已取得有效联系方式" if lead else "尚未确认留资"
    current = [other for other in outbox.values() if other["account_id"] == row["account_id"]
               and other["conversation_id"] == row["conversation_id"]]
    unresolved = any(other["status"] in ("UNKNOWN", "SUBMITTING") for other in current)
    conversation = row.get("conversation", {})
    if wechat or lead:
        next_step = "已留资，停止跟进"
    elif refused:
        next_step = "客户明确拒绝，停止跟进"
    elif conversation.get("state") == "STOPPED":
        next_step = "会话已停止，暂不跟进"
    elif conversation.get("state") == "HUMAN":
        next_step = "已让权人工接待，等待明确交回"
    elif conversation.get("state") == "PAUSED_LIMIT":
        next_step = "平台限制中，等待可发核验"
    else:
        next_step = "等客户回复；确认目的国、货品和发货量，再引导添加企微。"
    if unresolved:
        next_step = "先核验原消息，避免重复" + ("；" + next_step if "停止" in next_step
            or conversation.get("state") in ("HUMAN", "PAUSED_LIMIT") else "")
    if later_opening and not any(other.get("source_event_id") == latest["event_id"]
            and other.get("payload", {}).get("operation") == "text" and _history_confirmed(other, time.time())
            for other in current):
        next_step += "；后续消息未记录本程序回复"
    if reply_row is None:
        reply_summary = "本次未记录文字回复"
    else:
        sent = _history_confirmed(reply_row, time.time())
        state = reply_row["status"]
        reply_status = ("已回复" if sent else "发送待核实" if state in ("SENT", "UNKNOWN", "SUBMITTING")
                        else "未发送")
        if later_opening and reply_row["source_event_id"] != latest["event_id"]:
            reply_status = "前次回复已核验" if sent else "原发送待核实" if state in ("SENT", "UNKNOWN", "SUBMITTING") else "前次未发送"
        reply_summary = reply_status + "：\n" + _safe_text(reply_row["payload"].get("text"), 4000)
    card = _card_state(row, outbox)
    card_summary = ("已发送" if card == "SENT" else "发送待核实" if card in
                    ("SENT_UNVERIFIED", "UNKNOWN", "SUBMITTING") else "尚未确认发送")
    reply_summary += "\n企微名片：" + card_summary
    takeover_summary = ("已让权人工接待，自动接待暂停" if conversation.get("state") == "HUMAN" else
                        "自动接待已接管（平台人工模式）" if taken_over else "尚未确认接管")
    return {"customer": customer, "activity": activity, "takeover": takeover_summary,
            "customer_message": incoming, "our_reply": reply_summary,
            "lead": lead_summary, "next_step": next_step}


def _compact(value, maximum):
    text = re.sub(r"\s+", " ", _safe_text(value, 16000)).strip()
    return text if len(text) <= maximum else text[:maximum - 1] + "…"


def _customer_brief(summary, card_state):
    customer = _compact(summary["customer"], 40) + " · " + _compact(summary["activity"], 28)
    if summary["customer_message"] not in ("尚未开口", "原话未记录"):
        customer += "：“" + _compact(summary["customer_message"], 90) + "”"
    card = ("已核验发送" if card_state == "SENT" else "待确认" if card_state in
            ("SENT_UNVERIFIED", "UNKNOWN", "SUBMITTING") else "尚未确认发送")
    reply = _compact(summary["our_reply"].split("\n企微名片：", 1)[0].replace("发送待核实", "发送待确认"), 150) + "；企微名片：" + card
    next_step = summary["next_step"]
    reception = {"自动接待已接管（平台人工模式）": "已接待", "已让权人工接待，自动接待暂停": "已转人工"}.get(
        summary["takeover"], "接待状态待确认")
    action = ("需关注：原发送待确认，避免重复" if "先核验原消息" in next_step else
              "需关注：后续开口尚未记录本程序回复" if "后续消息未记录" in next_step else
              "无需立即处理；" + next_step if "停止" in next_step else
              "需关注：已转人工，等待人工接待" if "明确交回" in next_step else
              "需关注：" + next_step if "平台限制" in next_step else
              "需关注：本次开口未记录本程序回复" if summary["our_reply"].startswith("本次未记录文字回复")
                  and summary["customer_message"] not in ("尚未开口", "原话未记录") else
              "无需立即处理，等待客户回复")
    return {"customer": customer, "reply": reply,
            "progress": _compact(summary["lead"] + "；" + reception, 180),
            "action": _compact(action, 200)}


def _customer_card_state(row, outbox):
    cards = [other for other in outbox.values() if other["account_id"] == row["account_id"]
             and other["conversation_id"] == row["conversation_id"] and other["payload"].get("operation") == "native_card"]
    if any(other["status"] in ("UNKNOWN", "SUBMITTING") for other in cards):
        return "UNKNOWN"
    return _card_state(max(cards, key=lambda other: other["created_at"]), outbox) if cards else "NOT_CONFIRMED"


def _technical_details(row, sources, outbox, members, samples=None, reply_row=None):
    scope_rows = [other for other in outbox.values() if other["account_id"] == row["account_id"]
                  and other["conversation_id"] == row["conversation_id"]]
    ids = {row.get("intent_id")} | {member.get("intent_id") for member in members}
    if reply_row is not None:
        ids.add(reply_row["intent_id"])
    if row["payload"].get("operation") == "native_card":
        anchors = [other for other in scope_rows if other["source_event_id"] == row["source_event_id"]
                   and other["payload"].get("operation") == "text" and other["created_at"] <= row["created_at"]]
        companion = next((other for other in anchors if other["intent_id"] ==
                          row["payload"].get("companion_text_intent_id")), None)
        if companion is not None or anchors:
            ids.add((companion or max(anchors, key=lambda other: other["created_at"]))["intent_id"])
    source = sources.get((row["conversation_id"], row["source_event_id"]), {})
    latest = _latest_customer_words(row, source, sources)
    if latest is not None:
        latest_replies = [other for other in scope_rows if other["source_event_id"] == latest["event_id"]
                          and other["payload"].get("operation") == "text"]
        if latest_replies:
            ids.add(max(latest_replies, key=lambda other: other["created_at"])["intent_id"])
    if samples is not None:
        ids.update(attempt["intent_id"] for sample in samples for attempt in sample["reply_attempts"])
    operations = sorted((other for other in scope_rows if other["intent_id"] in ids),
                        key=lambda other: (other["created_at"], other["intent_id"]))
    source_ids = {other["source_event_id"] for other in operations} | {row["source_event_id"]}
    if latest is not None:
        source_ids.add(latest["event_id"])
    result = {"account_id": row["account_id"], "conversation_id": row["conversation_id"],
              "notice_ids": [member["id"] for member in members], "notices": members,
              "source_events": [event for event in sources.values() if event.get("account_id") == row["account_id"]
                    and event.get("conversation_id") == row["conversation_id"] and event.get("event_id") in source_ids],
              "operations": operations}
    if samples is not None:
        result["samples"] = samples
    return result


def _popup_technical_details(details, *, force=False):
    # Match the transport's actual ASCII JSON bytes, before the helper's file
    # size guard. The original evidence remains complete in report exports.
    encoded = json.dumps(details, ensure_ascii=True, allow_nan=False, indent=2)
    if not force and len(encoded.encode("utf-8")) <= 120000:
        return details
    return {"truncated": True, "explanation": "技术记录较长，完整原文和回执保存在接待审计报告。",
            "full_report": "reception-audit.json", "account_id": details["account_id"],
            "conversation_id": details["conversation_id"],
            "notice_ids": details["notice_ids"], "original_serialized_bytes": len(encoded.encode("utf-8"))}


def _bounded_popup_payload(payload):
    def size():
        return len((json.dumps(payload, ensure_ascii=True, allow_nan=False, indent=2) + "\n").encode("utf-8"))
    if size() > 262144:
        payload["technical_details"] = _popup_technical_details(payload["technical_details"], force=True)
    if size() > 262144:
        # Legacy fields repeat the same long text; the brief and report retain
        # their separate roles. Never truncate notification/ACK identities.
        for key in ("customer_text", "reply_text"):
            payload[key] = _compact(payload.get(key, ""), 512)
        payload["business_summary"] = {key: _compact(value, 512)
                                       for key, value in payload["business_summary"].items()}
        payload["compatibility_text_truncated"] = True
    if size() > 262144:
        raise NotifierError("popup_identity_budget_exceeded")
    return payload


def _notification_details(unread, sources, outbox):
    groups = {}
    for item in unread:
        if item["intent_id"] in outbox:
            groups.setdefault((item["account_id"], item["conversation_id"]), []).append(item)
    return {members[0]["id"]: _technical_details(outbox[members[-1]["intent_id"]], sources, outbox, members)
            for members in groups.values()}


def build_customer_cards(report, outbox, sources):
    """Presentation only: retain the ten original units and deduplicate their scopes."""
    groups = {}
    for sample in report.get("samples", []):
        groups.setdefault((sample["account_id"], sample["conversation_id"]), []).append(sample)
    cards = []
    for (account, uid), samples in groups.items():
        latest_id = samples[0]["latest_inbound_event_id"]
        source = sources.get((uid, latest_id), {})
        candidates = [row for row in outbox.values() if row["account_id"] == account
                      and row["conversation_id"] == uid and row["source_event_id"] == latest_id]
        row = max(candidates, key=lambda item: item["created_at"]) if candidates else {
            "account_id": account, "conversation_id": uid, "source_event_id": latest_id,
            "intent_id": None, "kind": "initial", "status": "NOT_SENT", "created_at": 0,
            "payload": {}, "evidence": {}, "conversation": {"state": samples[0]["conversation_state"],
                                                           "stop_reason": samples[0]["stop_reason"]}}
        text_rows = [item for item in candidates if item["payload"].get("operation") == "text"]
        reply = max(text_rows, key=lambda item: item["created_at"]) if text_rows else None
        summary = _business_summary(row, source, sources, outbox, reply)
        cards.append({"account_id": account, "conversation_id": uid,
                      "customer_brief": _customer_brief(summary, _customer_card_state(row, outbox)),
                      "technical_details": _technical_details(row, sources, outbox, [], samples)})
    return cards


def popup_payload(item, row, sources, outbox, pending_count, *, grouped_items=None, pending_customer_count=None):
    title, subtitle, _, _ = _descriptor(row, item["state"], sources, item["existing_exception"])
    source = sources.get((row["conversation_id"], row["source_event_id"]), {})
    proof = source.get("evidence", {})
    name = next((_safe_text(proof.get(key), 128) for key in
                 ("untrusted_customer_display_name", "untrusted_customer_name", "customer_name")
                 if isinstance(proof.get(key), str) and proof[key].strip()), "UID " + row["conversation_id"][-8:])
    reply = row["payload"].get("text")
    reply_row = row if row["payload"].get("operation") == "text" else None
    if row["payload"].get("operation") == "native_card":
        candidates = [other for other in outbox.values() if other["conversation_id"] == row["conversation_id"]
            and other["account_id"] == row["account_id"] and other["source_event_id"] == row["source_event_id"]
            and other["payload"].get("operation") == "text" and other["created_at"] <= row["created_at"]]
        anchor = next((other for other in candidates if other["intent_id"] == row["payload"].get("companion_text_intent_id")), None)
        if anchor is None and candidates:
            anchor = max(candidates, key=lambda other: other["created_at"])
        reply = anchor["payload"].get("text") if anchor else None
        reply_row = anchor
    business_time = row.get("confirmed_at") if item["state"] in ("SENT", "NOT_SENT") else row.get("submitted_at")
    timestamp_source = "outbox.confirmed_at" if item["state"] in ("SENT", "NOT_SENT") else "outbox.submitted_at"
    if business_time is None:
        business_time, timestamp_source = row["created_at"], "outbox.created_at"
    history_confirmed = _history_confirmed(row, time.time())
    summary = _business_summary(row, source, sources, outbox, reply_row)
    status = ("发送待核实" if "发送待核实" in summary["our_reply"] else
              "已回复" if summary["our_reply"].startswith("已回复") else "接待更新")
    members = grouped_items if grouped_items is not None else [item]
    return _bounded_popup_payload({"version": 1, "notice_id": item["id"], "title": title, "subtitle": subtitle,
        "business_title": summary["customer"] + " · " + status,
        "business_subtitle": summary["activity"], "business_summary": summary,
        "customer_brief": _customer_brief(summary, _customer_card_state(row, outbox)),
        "customer_card_state": _customer_card_state(row, outbox),
        "technical_details": _popup_technical_details(_technical_details(row, sources, outbox, members, reply_row=reply_row)),
        "grouped_notice_ids": [member["id"] for member in members],
        "customer_name": name, "customer_uid": row["conversation_id"],
        "customer_text": _safe_text(proof.get("untrusted_message_text"), 4000),
        "reply_text": _safe_text(reply, 4000), "operation": row["payload"].get("operation"),
        "state": item["state"], "card_state": _card_state(row, outbox),
        "existing_exception": item["existing_exception"], "created_at_utc": _utc(business_time),
        "timestamp_source": timestamp_source, "native_history_confirmed": history_confirmed,
        "sound": "Glass", "pending_count": pending_count,
        "pending_customer_count": pending_count if pending_customer_count is None else pending_customer_count,
        "interpretation": "SENT_status_alone_is_not_native_history_delivery_or_read_confirmation"})


class AuditNotifier:
    def __init__(self, db_path, *, account_id, state_dir=None, deliver=None, notifications_enabled=False):
        if not isinstance(account_id, str) or not re.fullmatch(r"[a-f0-9]{24}", account_id):
            raise NotifierError("explicit_account_required")
        self.db = Path(db_path).expanduser().resolve()
        self.directory = Path(state_dir).expanduser().resolve() if state_dir else self.db.parent
        if not self.directory.is_dir():
            raise NotifierError("existing_state_directory_required")
        output_names = ("audit-notifier-state.json", "audit-notifier.lock", "audit-notifier-read.json",
                        "audit-notifier-read.lock", "reception-audit.json", "reception-audit.html",
                        "reception-audit.md", "popup-current.json", "popup-ack.json")
        if any((self.directory / name).resolve() == self.db for name in output_names):
            raise NotifierError("output_database_collision")
        try:
            validate_export_paths(self.db, *(self.directory / name for name in output_names))
        except ValueError as error:
            raise NotifierError("output_database_collision") from error
        self.account = account_id
        self.path = self.directory / "audit-notifier-state.json"
        self._guard = _lock(self.directory / "audit-notifier.lock")
        self._guard.__enter__()
        self.enabled = notifications_enabled
        # Production defaults to a passive payload for root's independent panel.
        # A callback can be injected in tests; no helper or notification is started.
        self.deliver = deliver
        self._last_state_content = None
        self._last_state_save = 0
        self._popup_signature = None
        try:
            if self.path.is_symlink():
                raise NotifierError("ledger_symlink_rejected")
            self.state = _json(self.path) if self.path.exists() else {
                "version": VERSION, "account_id": account_id, "db_path": str(self.db),
                "cursor": None, "notifications": [], "export_signature": None}
            if (self.state.get("version") != VERSION or self.state.get("account_id") != account_id
                    or self.state.get("db_path") != str(self.db)
                    or not isinstance(self.state.get("notifications"), list)
                    or self.state.get("cursor") is not None and type(self.state["cursor"]) is not int):
                raise NotifierError("ledger_scope_or_schema_mismatch")
            for item in self.state["notifications"]:
                if self.enabled and item.get("command_state") == "disabled":
                    item["command_state"] = "pending"
                elif item.get("command_state") == "attempt_started":
                    item["command_state"] = "command_outcome_unknown"
        except Exception:
            self.close()
            raise

    def close(self):
        if self._guard is not None:
            self._guard.__exit__(None, None, None)
            self._guard = None

    def _save(self, force=False):
        self.state.update(pid=os.getpid(), notifications_enabled=self.enabled,
                          notification_delivery="command_completion_is_not_visible_or_user_read_confirmation")
        semantic = {key: value for key, value in self.state.items() if key != "updated_at_utc"}
        content = json.dumps(semantic, sort_keys=True, ensure_ascii=True)
        if not force and content == self._last_state_content and time.monotonic() - self._last_state_save < 5:
            return
        self.state["updated_at_utc"] = _utc()
        _export(self.path, self.state)
        self._last_state_content = content
        self._last_state_save = time.monotonic()

    def _queue(self, row, state, audit_id, existing=False):
        key = row["account_id"] + ":" + row["intent_id"] + ":" + state
        if any(item["id"] == key for item in self.state["notifications"]):
            return
        if state in ("SENT", "NOT_SENT"):
            for previous in self.state["notifications"]:
                if previous["intent_id"] == row["intent_id"] and previous["state"] == "UNKNOWN":
                    previous["command_state"] = "popup_superseded"
                    previous["superseded"] = True
                    if self.state.get("active_popup_id") == previous["id"]:
                        self.state["active_popup_id"] = None
        self.state["notifications"].append({"id": key, "intent_id": row["intent_id"],
            "account_id": self.account, "conversation_id": row["conversation_id"], "state": state,
            "audit_id": audit_id, "existing_exception": existing, "read": False,
            "command_state": "pending", "visible_verified": False, "user_read_verified": False})

    def _apply_read_requests(self):
        request = self.directory / "audit-notifier-read.json"
        with _lock(self.directory / "audit-notifier-read.lock", nonblocking=False):
            if not request.exists():
                return
            data = _json(request)
            ids = set(data.get("ids", []))
            for item in self.state["notifications"]:
                if item["id"] in ids:
                    item["read"] = True
            request.unlink()
        self._apply_popup_ack()

    def _apply_popup_ack(self):
        path = self.directory / "popup-ack.json"
        if not path.is_file() or path.is_symlink():
            return
        value = _json(path)
        if (value.get("version") != 1 or value.get("action") != "mark_read"
                or value.get("notice_id") != self.state.get("active_popup_id")):
            return
        ids = [value["notice_id"]]
        if "notice_ids" in value:
            ids = value["notice_ids"]
            published = self.state.get("active_popup_notice_ids", [])
            if (not isinstance(ids, list) or not ids
                    or any(not isinstance(identity, str) or len(identity) > 512 for identity in ids)
                    or len(set(ids)) != len(ids) or not set(ids).issubset(set(published))):
                return
        leader = next((item for item in self.state["notifications"] if item["id"] == value["notice_id"]), None)
        selected = [item for item in self.state["notifications"] if item["id"] in ids]
        if (leader is None or leader.get("account_id") != self.account or len(selected) != len(ids)
                or any(item.get("account_id") != self.account or item.get("conversation_id") != leader["conversation_id"]
                       or item.get("superseded") or item.get("read") for item in selected)):
            return
        for item in selected:
            item.update(read=True, user_acknowledged=True, command_state="popup_acknowledged")
        self.state["active_popup_id"] = None
        self.state["active_popup_notice_ids"] = []

    def poll_once(self):
        cursor = self.state["cursor"]
        maximum, audits, outbox, sources = read_snapshot(self.db, cursor or 0, self.account)
        file = self.db.stat()
        identity = [file.st_dev, file.st_ino]
        if self.state.get("db_identity", identity) != identity or cursor is not None and maximum < cursor:
            raise NotifierError("database_replaced_or_cursor_regressed")
        self.state["db_identity"] = identity
        if cursor is None:
            # No old successes are replayed. Existing uncertain submissions warn once.
            self.state["cursor"] = maximum
            for row in outbox.values():
                if row["status"] == "UNKNOWN":
                    self._queue(row, "UNKNOWN", maximum, existing=True)
        else:
            transitions = {}
            for audit in audits:
                self.state["cursor"] = audit["id"]
                if audit["account_id"] != self.account or audit["action"] not in ACTIONS:
                    continue
                detail = json.loads(audit["detail"])
                row = outbox.get(detail.get("intent_id"))
                if row is None or row["conversation_id"] != audit["conversation_id"]:
                    continue
                state = ACTIONS[audit["action"]]
                # The audit can span several batches. A later committed result
                # already visible in outbox must never become a stale warning.
                if _current_state_matches(row, state):
                    transitions[row["intent_id"]] = (row, state, audit["id"])
            for row, state, audit_id in transitions.values():
                self._queue(row, state, audit_id)
        self._apply_read_requests()
        self._apply_popup_ack()
        for item in self.state["notifications"]:
            row = outbox.get(item["intent_id"])
            if row is not None and not _current_state_matches(row, item["state"]):
                item.update(command_state="popup_superseded", superseded=True)
                if self.state.get("active_popup_id") == item["id"]:
                    self.state["active_popup_id"] = None
        self.state["health"] = "observing"
        # Durable cursor + pending IDs precede notification side effects. On a
        # crash after an OS request, replay can duplicate a banner, never a send.
        self._save()
        for item in self.state["notifications"]:
            if item["command_state"] != "pending" or item.get("superseded"):
                continue
            row = outbox.get(item["intent_id"])
            if row is None:
                item["command_state"] = "record_unavailable"
            elif not self.enabled:
                item["command_state"] = "disabled"
            elif self.deliver is not None:
                title, subtitle, body, _ = _descriptor(row, item["state"], sources, item["existing_exception"])
                item["command_state"] = "attempt_started"
                self._save()
                try:
                    result = self.deliver(title, subtitle, body)
                    item.update({key: value for key, value in result.items()
                                 if key in ("command_state", "exit_code")})
                    item.update(visible_verified=False, user_read_verified=False)
                    if item["command_state"] == "pending":
                        item["command_state"] = "invalid_notification_result"
                except Exception:
                    item["command_state"] = "command_failed"
            else:
                item["command_state"] = "popup_queued_unverified"
            self._save()
        unread = [item for item in self.state["notifications"] if not item["read"] and not item.get("superseded")]
        if self.enabled and self.deliver is None:
            current = next((item for item in unread if item["id"] == self.state.get("active_popup_id")), None)
            if current is None:
                current = next((item for item in unread if item["command_state"] == "popup_queued_unverified"), None)
            if current is not None and current["intent_id"] in outbox:
                members = [item for item in unread if item.get("account_id") == current["account_id"]
                           and item.get("conversation_id") == current["conversation_id"] and item["intent_id"] in outbox]
                # Identity remains the earliest unread ledger member, even when
                # a later operation supplies the current business status.
                current = members[0]
                latest = members[-1]
                display = {**latest, "id": current["id"]}
                customer_count = len({(item.get("account_id"), item["conversation_id"]) for item in unread})
                payload = popup_payload(display, outbox[latest["intent_id"]], sources, outbox, len(unread),
                                        grouped_items=members, pending_customer_count=customer_count)
                # Refresh changing card state without changing the notice ID.
                popup_signature = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
                if popup_signature != self._popup_signature:
                    _export(self.directory / "popup-current.json", payload)
                    self._popup_signature = popup_signature
                self.state["active_popup_id"] = current["id"]
                self.state["active_popup_notice_ids"] = payload["grouped_notice_ids"]
                self._save()
            elif current is None:
                popup = self.directory / "popup-current.json"
                if popup.exists() and not popup.is_symlink():
                    popup.unlink()
                self._popup_signature = None
                self.state["active_popup_notice_ids"] = []
        report = read_reception_audit(self.db, account_id=self.account, limit=10)
        exceptions = []
        for row in outbox.values():
            if row["status"] not in ("UNKNOWN", "SUBMITTING", "LIMIT"):
                continue
            title, subtitle, body, historical = _descriptor(row, "BLOCKED" if row["status"] == "LIMIT" else "UNKNOWN", sources)
            exceptions.append({"intent_id": row["intent_id"], "conversation_id": row["conversation_id"],
                "status": row["status"], "historical_followup": historical, "description": title,
                "operation": row["payload"].get("operation"), "text": row["payload"].get("text"),
                "submitted_at_utc": _utc(row["submitted_at"]) if row.get("submitted_at") else None})
        report["existing_exceptions_not_counted_as_entries"] = exceptions
        report["customer_cards"] = build_customer_cards(report, outbox, sources)
        # Unread FIFO customers can fall outside the latest-ten entry window.
        # Keep their full original evidence in this same existing JSON report.
        report["notification_details"] = _notification_details(unread, sources, outbox)
        report["notification_status"] = {"visible_verified": False,
            "unread": [item for item in self.state["notifications"] if not item["read"] and not item.get("superseded")]}
        semantic = {key: value for key, value in report.items() if key != "generated_at_utc"}
        signature = hashlib.sha256(json.dumps(semantic, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        if signature != self.state.get("export_signature"):
            _export(self.directory / "reception-audit.json", report)
            extra = "<section><details><summary>存量异常（不计新进线）</summary>" + "".join(
                "<article><p>" + html.escape(item["description"]) + "</p><pre>" + html.escape(item["text"] or "企业微信名片") +
                "</pre><code>" + html.escape(item["intent_id"]) + "</code></article>" for item in exceptions) + "</details></section>"
            _export_text(self.directory / "reception-audit.html", render_html(report).replace("</html>", extra + "</html>"))
            _export_text(self.directory / "reception-audit.md", render_markdown(report))
            self.state["export_signature"] = signature
            self._save()
        return self.state


def render_markdown(report):
    lines = ["# 最近真实接待审计", "", "仅保存证据；不代表送达、已读、已加企微或3秒达标。", ""]
    cards = report.get("customer_cards")
    for index, card in enumerate(cards or [], 1):
        brief, detail = card["customer_brief"], card["technical_details"]
        lines += ["## 客户 " + str(index), ""]
        for label, key in (("客户", "customer"), ("我方回复", "reply"), ("进展", "progress"), ("处理", "action")):
            lines += ["- " + label + "：" + _markdown_text(brief[key])]
        lines += ["", "<details>", "<summary>技术详情</summary>", ""]
        for unit in detail["samples"]:
            for incoming in unit["inbound_events"]:
                lines += ["入站 " + _times(incoming["platform_received_at_utc"]), "",
                          _literal(incoming["customer_text"] or incoming["platform_entry_text"] or ""), ""]
            for attempt in unit["reply_attempts"]:
                lines += [_literal(attempt["text"] or "企业微信名片"), ""]
        lines += [_literal(json.dumps(detail, ensure_ascii=False, allow_nan=False, indent=2), maximum=None), "", "</details>", ""]
    if cards is None:  # Legacy callers keep their original evidence projection.
        for unit in report.get("samples", []):
            lines += ["## " + _markdown_text(unit["conversation_id"]) + " · " + unit["anchor_type"], ""]
            for incoming in unit["inbound_events"]:
                lines += ["入站 " + _times(incoming["platform_received_at_utc"]), "",
                          _literal(incoming["customer_text"] or incoming["platform_entry_text"] or ""), ""]
            for attempt in unit["reply_attempts"]:
                lines += [str(attempt["operation"]) + " · " + attempt["status"] + " · " + attempt["result"], "",
                          _literal(attempt["text"] or "企业微信名片"), "", "提交 " + _times(attempt["submitted_at_utc"]), ""]
    if not report.get("samples"):
        lines += ["当前没有真实新进线或开口样本，未补造数据。", ""]
    lines += ["<details>", "<summary>存量异常（不计新进线）</summary>", ""]
    for item in report.get("existing_exceptions_not_counted_as_entries", []):
        lines += [_literal(item["description"]), "", _literal(item["text"] or "企业微信名片"), "",
                  "提交 " + _times(item["submitted_at_utc"]), "", item["intent_id"], ""]
    lines += ["</details>", ""]
    return "\n".join(lines) + "\n"


def _markdown_text(value):
    return re.sub(r"([\\`*_{}\[\]()#+.!|])", r"\\\1", html.escape(str(value), quote=False))


def _literal(value, maximum=16000):
    value = _safe_text(str(value), maximum)
    fence = "`" * max(3, 1 + max((len(part) for part in re.findall(r"`+", value)), default=0))
    return fence + "text\n" + value + "\n" + fence


def _times(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return "UTC " + value + "；本地 " + parsed.astimezone().isoformat(timespec="seconds")
    except (AttributeError, TypeError, ValueError):
        return "时间未核验"


def notifier_status(state_dir):
    path = Path(state_dir) / "audit-notifier-state.json"
    if not path.is_file():
        return {"classification": "local_audit_notifier", "state": "not_initialized"}
    state = _json(path)
    return {key: state.get(key) for key in ("pid", "account_id", "cursor", "health", "updated_at_utc", "notifications_enabled")} | {
        "classification": "local_audit_notifier", "saved_report_only": True,
        "visible_verified": False, "unread": [item for item in state["notifications"] if not item["read"] and not item.get("superseded")]}


def mark_read(state_dir, ids):
    directory = Path(state_dir)
    if not ids or any(not isinstance(item, str) or len(item) > 512 for item in ids):
        raise NotifierError("notification_ids_required")
    path = directory / "audit-notifier-read.json"
    with _lock(directory / "audit-notifier-read.lock", nonblocking=False):
        previous = _json(path).get("ids", []) if path.exists() else []
        _export(path, {"ids": sorted(set(previous + ids))})
    return {"mark_read_requested": len(ids), "applied_by_next_notifier_poll": True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path(__file__).resolve().parents[1] / ".runtime/reception.sqlite3")
    parser.add_argument("--state-dir", "--runtime", dest="state_dir", type=Path)
    parser.add_argument("--account")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    run.add_argument("--interval", type=float, default=.75)
    run.add_argument("--once", action="store_true")
    run.add_argument("--enable-notifications", action="store_true")
    commands.add_parser("notifier-status")
    read = commands.add_parser("mark-read")
    read.add_argument("ids", nargs="+")
    args = parser.parse_args(argv)
    directory = args.state_dir or args.db.expanduser().resolve().parent
    if args.command != "run":
        value = notifier_status(directory) if args.command == "notifier-status" else mark_read(directory, args.ids)
        print(json.dumps(value, ensure_ascii=True)); return 0
    if not .5 <= args.interval <= 1:
        parser.error("interval must be between 0.5 and 1 seconds")
    stop = False
    def stopping(*_):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGTERM, stopping)
    signal.signal(signal.SIGINT, stopping)
    observer = AuditNotifier(args.db, account_id=args.account, state_dir=directory,
                             notifications_enabled=args.enable_notifications)
    try:
        while not stop:
            started = time.monotonic()
            try:
                observer.poll_once()
            except Exception as error:
                observer.state["health"] = str(error) if isinstance(error, NotifierError) else "observer_error"
                observer._save()
            if args.once:
                break
            time.sleep(max(0, args.interval - (time.monotonic() - started)))
    finally:
        observer.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (NotifierError, OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": str(error) if isinstance(error, NotifierError) else "notifier_configuration_error"}), file=sys.stderr)
        raise SystemExit(3)
