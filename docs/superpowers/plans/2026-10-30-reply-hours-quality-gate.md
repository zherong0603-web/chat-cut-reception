# Reply Hours and MQL Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reply only during 19:00–23:59:30 Asia/Shanghai and deterministically stop peers, cooperation requests, and named unsupported businesses before any WeCom solicitation.

**Architecture:** A pure reply-window module gates orchestration and sender calls. A deterministic responder classifier runs before contact extraction and card generation. Off-window messages are silently baselined and never backfilled.

**Tech Stack:** Node.js 24 ESM, node:test, existing reception_v2 SQLite/Playwright runtime.

**Spec:** Approved directly in chat on 2026-10-30.

## Global Constraints

- Window: 19:00:00 inclusive; no new send at or after 23:59:30; midnight closes the window.
- No off-window reply, queue, or later backfill.
- Exclusions produce at most one refusal, never a WeCom card, contact scan, or MQL.
- Time zone is always Asia/Shanghai.
- Ambiguous genuine logistics demand remains qualified.

### Task 1: Reply-window scheduler

**Files:** Create `reception_v2/reply-schedule.mjs`; create `reception_v2/test/reply-schedule.test.mjs`.

- [x] Test 18:59:59, 19:00:00, 23:59:29, 23:59:30, and 00:00:00 boundaries.
- [x] Implement `replyWindowState(nowMs)` and `createReplySchedule()`.
- [x] Run the focused test.

### Task 2: Deterministic quality gate

**Files:** Modify `reception_v2/responder.mjs`; modify `reception_v2/test/responder.test.mjs`; modify `reception_v2/config/business-facts.json`.

- [x] Test the screenshot: “我是做美线尾程提拆派服务，后期有资源可以合作一下”.
- [x] Test 找货盘、个人转运/快递、自发货、移仓换标、其他仓退货、自发货退件、合作/渠道/代理.
- [x] Test genuine “美国尾程派送有货，需要报价” remains qualified.
- [x] Implement peer/cooperation and unsupported-business intents returning STOPPED with `offerCard=false`.

### Task 3: Orchestration and sender hard gates

**Files:** Modify `reception_v2/orchestrator.mjs`, `reception_v2/sender.mjs`, `reception_v2/main.mjs`, `reception_v2/runtime.mjs`, and tests.

- [x] Outside hours, read for health but do not ingest, contact-scan, enter manual mode, create intent, or send.
- [x] At 19:00, rebaseline current rows so off-window messages are not backfilled.
- [x] Check the schedule again before sender actions.
- [x] Skip welcome/card for silent peer-profile visitors.
- [x] Run full reception_v2 tests and live status checks.
