# Customer Audit Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the user-approved four-field per-customer audit card with click-to-expand technical details.
**Architecture:** Keep the existing read-only Python notifier, durable per-intent ledger, nonactivating Swift panel and report exports. Coalesce only the unread presentation by account/UID; ACK only the displayed member IDs supplied by the actual button.
**Tech Stack:** Python standard library/SQLite mode=ro; Swift AppKit; existing HTML/Markdown renderer.
**Spec:** docs/superpowers/specs/2026-10-27-customer-audit-brief-design.md (approved via the user's explicit selection).

## Global Constraints

- No browser/worker/business DB mutation, UNKNOWN retry, cursor reset or desktop focus/input control.
- Preserve original notice IDs, read/ACK history, strict receipts and real entry clocks/counts.
- All customer/native strings are untrusted; plain-text/escaped rendering only.
- Only actual “知道了” ACK can mark displayed notices read; details toggles never ACK.
- Existing LaunchAgent helper and detached notifier remain single-instance.

## Review Focus

- Same name/different UID or another account must not merge.
- An unseen late-arriving notice must remain unread after an older displayed group ACK.
- Card UNKNOWN with strict SENT text must stay visibly pending and not become lead success.
- Long/untrusted words must not hide status or execute HTML/shell/links.
- Upgrading unread legacy notices must preserve read/cursor/ACK and keep reception running.

### Task 1: Python customer brief and unread grouping
**Files:** xhs_reception/audit_notifier.py; tests/test_audit_notifier.py; tests/test_audit_popup_summary.py.
**Interfaces:** popup payload adds `customer_brief` with string keys `customer`, `reply`, `progress`, `action`; `technical_details` JSON object; `grouped_notice_ids` list. Existing `notice_id` remains group leader ID. Report adds `customer_cards`, each with `conversation_id`, `customer_brief`, `technical_details` (including original samples). Original JSON `samples`/counts unchanged.
- [x] Write failing real notifier tests for one UID/text+card, distinct UID, exact displayed-member ACK, late arrival, legacy ACK and strict unknown summaries.
- [x] Implement projection/grouping/Markdown collapsed details without changing the durable underlying notice history or business DB.
- [x] Run targeted notifier/summary tests and report their results.

### Task 2: Nonactivating panel and genuine details button
**Files:** xhs_reception/audit_popup.swift; tests/test_audit_popup_body.py (plus focused offscreen test if necessary).
**Interfaces:** Consume the four `customer_brief` strings and bounded `technical_details`; fall back to existing business summary for legacy payloads. User-only markRead writes original `notice_id` and exact `notice_ids` snapshot from `grouped_notice_ids`.
- [x] Write failing offscreen checks for four-field/default layout, expandable technical details, details without ACK and long hostile strings.
- [x] Implement in-panel details toggle, preserve nonkey/nonmain, scrolling and manual acknowledgement; implementation version v4.
- [x] Compile with existing SDK and verify offscreen rendering in light/dark without opening an application window or clicking the production panel.

### Task 3: Report, independent review and production rollout
**Files:** xhs_reception/reception_audit.py; tests/test_reception_audit.py; README.md; existing .runtime/reception-fix-evidence.json.
- [x] Add failing HTML tests for per-customer briefs and collapsed escaped original evidence; implement while retaining legacy CLI report fallback.
- [x] Independently review source and grouping/ACK/privacy cases; run appropriate project tests.
- [x] Save current DB outbox hashes, ledger/cursor/read/ACK and process baselines. Build/atomically replace helper binary; restart only the approved notifier/helper components through their existing entrypoints, never the reception worker.
- [x] Verify two advancing live v4 health snapshots, nonactivating single-instance panel, no forged ACK, preserved existing records and same worker epoch/cursor. Accept a genuinely empty queue as null notice/zero body/hidden; four-field layout and details were verified offscreen. Save results in existing evidence and update README.
- [x] Report concise background activation with material limitations, never claim human visibility from local drawing.
- [ ] On the first natural new notification, independently check four-field drawing/revision and details availability. Expand/ACK evidence must come from actual user gestures; do not fabricate production notifications or clicks.

No repository-wide add/commit is required for this local running-service update.

## Current production result

The frozen source passed 188 Python/offscreen checks and separate independent audit/Red Team review before deployment. The exact v4 candidate e398 was activated at the original path, mode 0700, through the existing LaunchAgent at 05:37:31Z. A native Documents prompt initially blocked loading. The original PID10623 subsequently produced fresh v4 health before the rollback guard ran, so the rollback and further kickstart were skipped. Independent audit and Red Team each verified advancing v4/notifier health at05:47:21Z and05:47:26Z, one helper, nonkey/nonmain, all40 original outbox rows and40 notification objects unchanged, realACK05:34:12 preserved, and the original daemon/RPC/notifier/epoch/future-only boundary. The actual queue is empty, so null notice/zero body/details unavailable/hidden is correct; a new production card, details gesture and genuine review still await a natural notice. No programmatic system grant, TCC/attribution change, synthetic notification or ACK occurred; the precise OS resolution cause is unknown. The user preference to handle ordinary authorized permissions autonomously without repeated questions is saved in AGENTS.md and the monitor. Current evidence is in `permission_reply_activation_20261027` within the existing runtime evidence.
