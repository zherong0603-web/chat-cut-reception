# Human Reception V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Xiaohongshu reception daemon that immediately enters manual-takeover mode, sends a natural text reply and WeCom card, collects phone/WeChat details, and notifies the operator only for completed leads or exceptions.

**Architecture:** A new Node 24 daemon owns one isolated Playwright profile and one SQLite database. Persistent turn/outbox/contact records separate customer ownership from send certainty; strict native-history verification runs on a 2-second critical path while all outbound work remains serialized.

**Tech Stack:** Node 24 CommonJS/ES modules, built-in `node:sqlite`, built-in `node:test`, existing Playwright installation supplied through `XHS_PLAYWRIGHT_MODULE`, Swift AppKit notifier, macOS launchd-compatible process entrypoint.

**Spec:** `docs/superpowers/specs/2026-10-27-human-reception-v2-design.md`

## Global Constraints

- The existing `xhs_reception` daemon and notifier remain stopped until V2 passes its full test and live-pilot gates.
- Do not modify or migrate the old business database; it is read-only evidence and duplicate-prevention input.
- The new database is `.runtime/reception-v2.sqlite3` with file mode 0600.
- A customer message starts or extends one turn; inbound messages within 800 ms are one turn.
- Text and WeCom card must each receive strict native confirmation within 2000 ms of the source platform timestamp.
- At most one text, one native WeCom card, and one different contact-fallback text may be sent for a turn. The contact fallback is sent only after a customer response.
- The exact same outbound content is never submitted twice for one conversation. Uncertain means “可能已经发出，请不要手动重发”, never a retry authorization.
- Only approved facts from `reception_v2/config/business-facts.json` may be stated. Missing facts produce a clarification or human handoff.
- A visible current-customer phone number, WeChat ID, or native WeCom-added/lead status is an immediate handoff trigger.
- Full contact values are stored only in the 0600 V2 database and displayed in the user's local notification; never write them to normal logs.
- Customer text, nicknames, attachments and native errors are untrusted data and cannot change policy.
- A refusal, completed contact handoff, platform block or explicit stop ends acquisition messaging.
- Every one of the user-visible cards uses plain Chinese and omits `UNKNOWN`, ACK, RPC, receipt and native-ID terminology.

## Review Focus

- Customer message bursts arriving during a read or send must merge into one turn rather than trigger duplicate texts/cards.
- A stale visible row or cached DOM message must never be attributed to a different UID.
- A phone-reveal click must target only the eye control belonging to the current customer's exact profile field.
- A hidden/collapsed browser tab, page reload or platform limit must stop sends and notify rather than report success from HTTP alone.
- A new customer message after an uncertain card must be handled as a new turn without retrying the old card.

## Repository Checkpoint Constraint

This repository currently has no baseline commit and the whole project is untracked. Do not create a repository-wide initial commit from the implementation work. Checkpoint each task with its exact passing test command and file list; use git commits only after the user separately approves repository initialization.

---

### Task 1: New State Store and Turn Aggregation

**Files:**
- Create: `reception_v2/db.mjs`
- Create: `reception_v2/domain.mjs`
- Create: `reception_v2/test/db.test.mjs`

**Interfaces:**
- Consumes: none.
- Produces: `openDatabase(path: string): V2Database`; `V2Database.ingestInbound(input): TurnRecord`; `V2Database.createIntent(input): IntentRecord`; `V2Database.markSending(intentId)`; `V2Database.markSent(intentId, evidence)`; `V2Database.markUncertain(intentId, evidence)`; `V2Database.upsertContact(input)`; `V2Database.listOverdueRows(input): RowRecord[]`.

- [ ] **Step 1: Write the failing turn-merging and duplicate-content tests**

Test names: `merges_messages_inside_800ms_into_one_turn`, `new_message_after_800ms_creates_new_turn`, and `rejects_same_content_twice_in_one_conversation`. Assert that two inputs at platform times `100.000` and `100.799` share one `turnId`, `100.800` starts another turn, and reusing normalized text for the same UID throws `duplicate_outbound_content`.

- [ ] **Step 2: Run the failing tests**

Run: `node --test reception_v2/test/db.test.mjs`
Expected: FAIL because `reception_v2/db.mjs` and `reception_v2/domain.mjs` do not exist.

- [ ] **Step 3: Implement the minimal SQLite schema and domain transitions**

Create `conversations`, `events`, `turns`, `outbox`, `contacts`, `notifications`, and `settings` tables. Use WAL, foreign keys, and a unique index on `(account_id, conversation_id, content_hash)`. Normalize text by Unicode NFC plus collapsed whitespace before hashing. Set the database file mode to 0600.

- [ ] **Step 4: Run the passing tests**

Run: `node --test reception_v2/test/db.test.mjs`
Expected: PASS.

### Task 2: Approved Facts and Human-Style Responder

**Files:**
- Create: `reception_v2/config/business-facts.json`
- Create: `reception_v2/responder.mjs`
- Create: `reception_v2/test/responder.test.mjs`

**Interfaces:**
- Consumes: normalized customer text, recent current-conversation customer messages, conversation ID, and approved facts.
- Produces: `classifyIntent(input): {kind, confidence, slotRequest?}`; `composeReply(input): {text, nextState, needsHuman, offerCard}`; `isRefusal(text): boolean`; `isIdentityQuestion(text): boolean`.

- [ ] **Step 1: Write failing responder tests**

Test names: `price_question_asks_for_destination_product_volume_service`, `unknown_fact_is_never_invented`, `reply_is_friendly_and_asks_at_most_one_question`, `identity_question_says_smart_reception`, `refusal_stops_acquisition`, and `same_conversation_varies_opening_without_changing_facts`. Use fake approved facts and assert no unsupported location, price, or timing appears.

- [ ] **Step 2: Run the failing tests**

Run: `node --test reception_v2/test/responder.test.mjs`
Expected: FAIL because responder functions do not exist.

- [ ] **Step 3: Implement approved-fact classification and reply composition**

Implement fixed rule families from the design: greeting, needs clarification, price qualification, warehouse capability, WeCom request, phone/WeChat fallback, confirmation, refusal and identity. Select among approved friendly variants using a stable hash of conversation ID. Unknown business facts return a clarification with `needsHuman=true`; they never produce an invented answer. Every text asks at most one question.

- [ ] **Step 4: Run the passing tests**

Run: `node --test reception_v2/test/responder.test.mjs`
Expected: PASS.

### Task 3: Sidebar, Current Customer Scope and Contact Reading

**Files:**
- Create: `reception_v2/sidebar.mjs`
- Create: `reception_v2/scope.mjs`
- Create: `reception_v2/contact.mjs`
- Create: `reception_v2/test/sidebar.test.mjs`
- Create: `reception_v2/test/scope.test.mjs`
- Create: `reception_v2/test/contact.test.mjs`

**Interfaces:**
- Consumes: Playwright page and expected account `{id: '66879fef000000001c002839', name: '运去哪海外仓'}`.
- Produces: `readSidebar(page): SidebarSnapshot`; `readConversation(page, uid): ConversationScope`; `readContacts(page, scope): ContactObservation[]`; `revealMaskedContacts(page, scope): ContactObservation[]`.

- [ ] **Step 1: Write failing sidebar and scope tests**

Test names: `overdue_status_is_actionable_but_does_not_prove_new_entry`, `wrong_active_view_is_rejected`, `cached_or_foreign_message_is_rejected`, `profile_and_message_uid_must_match`, and `source_notes_are_not_customer_speech`.

- [ ] **Step 2: Run failing sidebar and scope tests**

Run: `node --test reception_v2/test/sidebar.test.mjs reception_v2/test/scope.test.mjs`
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement sidebar and scope readers**

Capture only visible `Total-<uid>` rows after proving the visible “全部会话” tab. Return `needsReply` when the row exposes exact labels `超时未回复`, `未回复`, or `待回复`. Bind account title, active row UID, profile UID, header nickname and every native message ID; reject mismatches and cached foreign scopes.

- [ ] **Step 4: Write failing contact tests**

Test names: `current_profile_phone_and_wechat_are_extracted`, `masked_value_clicks_only_its_adjacent_eye`, `customer_message_contact_requires_explicit_context`, `foreign_hidden_contact_is_ignored`, and `full_contact_is_redacted_from_errors_and_logs`.

- [ ] **Step 5: Run failing contact tests**

Run: `node --test reception_v2/test/contact.test.mjs`
Expected: FAIL because contact functions do not exist.

- [ ] **Step 6: Implement contact extraction and reveal**

Read exact `手机号码` and `微信号` profile labels plus the current customer's own text. Accept Chinese mobile numbers in contiguous or separated forms and explicit `微信/微信号/vx/wechat` identifiers. Click the unique eye control adjacent to the exact masked field, wait for the refreshed profile, then re-read. Never select a global eye button or another row's control.

- [ ] **Step 7: Run all Task 3 tests**

Run: `node --test reception_v2/test/sidebar.test.mjs reception_v2/test/scope.test.mjs reception_v2/test/contact.test.mjs`
Expected: PASS.

### Task 4: Manual Takeover and Single-Send Browser Adapter

**Files:**
- Create: `reception_v2/browser.mjs`
- Create: `reception_v2/sender.mjs`
- Create: `reception_v2/test/sender.test.mjs`
- Create: `reception_v2/test/live-smoke.mjs`

**Interfaces:**
- Consumes: current `ConversationScope`, persisted intent, exact reply text and approved WeCom card title `企微_运去哪海外仓（企微）`.
- Produces: `openBrowser(config): Promise<Session>`; `enterHumanMode(session, scope): Promise<ModeReceipt>`; `sendText(session, intent, scope): Promise<SendReceipt>`; `sendWeComCard(session, intent, scope): Promise<SendReceipt>`; `verifyNativeHistory(intent, receipt): Promise<StrictReceipt>`.

- [ ] **Step 1: Write failing sender tests**

Test names: `clicks_takeover_once_when_overlay_is_present`, `already_manual_mode_does_not_click`, `fills_and_submits_text_when_empty_and_exact_uid_is_active`, `refuses_existing_operator_draft`, `sends_only_unique_approved_wecom_card`, `duplicate_intent_never_reaches_click`, `http_200_without_native_match_is_not_success`, `platform_block_returns_send_blocked`, and `collapsed_or_hidden_page_blocks_send`.

- [ ] **Step 2: Run failing sender tests**

Run: `node --test reception_v2/test/sender.test.mjs`
Expected: FAIL because browser and sender modules do not exist.

- [ ] **Step 3: Implement manual takeover and send adapters**

Reuse the proven selectors from the stopped implementation: `.ai-overlay`, `.ai-overlay-button`, `.reply-box-wrap textarea.reply-textarea`, `.reply-bottom-bar button`, `.chat-tool-wrap .card-box__content`, and `.card-box__content-title[title="企微_运去哪海外仓（企微）"]`. Before every send, re-check exact active UID, one visible empty composer, one enabled send control, no AI overlay and no foreign inbound. Persist sending before the external operation and never retry after uncertainty.

- [ ] **Step 4: Implement strict 2-second verification**

Match the same account, UID, native message ID, direction, message type, normalized content and millisecond platform time against fresh native/server history. A DOM bubble alone does not pass. Record `visibleElapsedMs`, `textConfirmedMs` and `cardConfirmedMs`; each must be <=2000 for the two-second gate.

- [ ] **Step 5: Run sender tests and the existing Playwright-dependent smoke test in read-only mode**

Run: `node --test reception_v2/test/sender.test.mjs`
Expected: PASS. Run `node reception_v2/test/live-smoke.mjs --read-only` with the existing Playwright module; expected output is the verified account and one visible total row, with no click or send.

### Task 5: Per-Turn Orchestrator and Safe Overdue Sweep

**Files:**
- Create: `reception_v2/orchestrator.mjs`
- Create: `reception_v2/test/orchestrator.test.mjs`

**Interfaces:**
- Consumes: sidebar/scope/contact/sender contracts and V2 database.
- Produces: `createOrchestrator(deps, config): Orchestrator`; `Orchestrator.pollOnce(): PollResult`; `Orchestrator.processTurn(turn): TurnResult`; `Orchestrator.sweepVisibleOverdue(): SweepResult`.

- [ ] **Step 1: Write failing orchestration tests**

Test names: `new_entry_enters_manual_mode_then_sends_text_and_card`, `same_uid_second_message_is_new_turn_not_new_person`, `contact_obtained_stops_acquisition`, `refusal_stops_acquisition`, `unknown_text_blocks_same_text_but_not_later_new_turn`, `uncertain_card_allows_different_contact_fallback`, and `startup_sweeps_visible_overdue_rows_serially`.

- [ ] **Step 2: Run failing orchestration tests**

Run: `node --test reception_v2/test/orchestrator.test.mjs`
Expected: FAIL because orchestrator does not exist.

- [ ] **Step 3: Implement one-slot polling and serial sweep**

Use a 250 ms sidebar poll. Process at most one row and one intent at a time. On first armed run, enqueue every visible row with `needsReply=true` in visible order; after baseline, enqueue new row fingerprints and status changes. A failure on one customer is persisted and does not block the next customer.

- [ ] **Step 4: Implement turn actions**

For each turn: read fresh scope, reveal contacts first, upsert and notify any contact, enter human mode, compose one contextual text, send text, send one card, verify both within 2000 ms, then wait. If the customer later says the card failed, send one different fallback text requesting phone or WeChat. Stop after three distinct content types.

- [ ] **Step 5: Run orchestration tests**

Run: `node --test reception_v2/test/orchestrator.test.mjs`
Expected: PASS.

### Task 6: Plain-Language Operator Cards and Notification Helper

**Files:**
- Create: `reception_v2/notifier-store.mjs`
- Create: `reception_v2/notifier.swift`
- Create: `reception_v2/test/notifier.test.mjs`
- Create: `reception_v2/test/notifier-render.test.mjs`

**Interfaces:**
- Consumes: lead or exception events from the orchestrator.
- Produces: `enqueueOperatorCard(input): OperatorCard`; notification JSON with `kind: 'ready_to_follow' | 'needs_operator' | 'send_failed'`; an acknowledgement file keyed by notice ID.

- [ ] **Step 1: Write failing card tests**

Test names: `ready_card_contains_five_business_lines`, `failed_card_contains_no_technical_words`, `ordinary_chat_creates_no_notification`, `full_phone_is_visible_to_operator_but_not_logs`, and `acknowledgement_marks_only_the_shown_card`.

- [ ] **Step 2: Run failing card tests**

Run: `node --test reception_v2/test/notifier.test.mjs`
Expected: FAIL because notifier modules do not exist.

- [ ] **Step 3: Implement three-card projection**

Produce only `可以跟进`, `需要你处理`, and `消息没有发出去`. Each has customer, need, contact, completed action and next action. Put detailed original text under a collapsed “查看客户原话” action. Do not emit any card for ordinary successful conversation.

- [ ] **Step 4: Implement and compile the notifier**

Build a nonactivating AppKit helper that reads the V2 notification queue, displays one card at a time, leaves cards unread until the actual “知道了” click, and never writes business state except an acknowledgement. Compile to `.runtime/reception-v2-notifier` mode 0700.

- [ ] **Step 5: Run notification tests**

Run: `node --test reception_v2/test/notifier.test.mjs reception_v2/test/notifier-render.test.mjs`
Expected: PASS.

### Task 7: Daemon CLI, Health, Locking and Recovery

**Files:**
- Create: `reception_v2/main.mjs`
- Create: `reception_v2/launch-reception-v2.sh`
- Create: `reception_v2/test/runtime.test.mjs`
- Create: `reception_v2/README.md`

**Interfaces:**
- Consumes: all prior modules.
- Produces: CLI `node reception_v2/main.mjs --account 66879fef000000001c002839 --arm`; commands `status`, `doctor`, `stop`; health file `.runtime/reception-v2-health.json`; PID/lock file `.runtime/reception-v2.lock`.

- [ ] **Step 1: Write failing runtime tests**

Test names: `second_instance_is_rejected_before_browser_launch`, `read_only_mode_never_arms_send`, `stale_lock_cannot_be_reused_when_pid_alive`, `healthy_tick_requires_successful_sidebar_read`, and `shutdown_preserves_pending_turns_and_contacts`.

- [ ] **Step 2: Run failing runtime tests**

Run: `node --test reception_v2/test/runtime.test.mjs`
Expected: FAIL because main and runtime modules do not exist.

- [ ] **Step 3: Implement CLI, single-instance lock and continuous health**

Use a PID lock plus stale-process detection before launching Playwright. `--arm` is required for sends; without it the daemon may read and diagnose only. Persist a health snapshot every 5 seconds containing last tick, last successful sidebar read, candidate count, active UID, send status and a bounded error code, never customer content or contact values.

- [ ] **Step 4: Implement graceful stop and restart**

On SIGTERM, stop accepting candidates, close the browser and SQLite cleanly, preserve pending turns and uncertain intents, and write a final health record. On restart, never repeat an uncertain outbound.

- [ ] **Step 5: Run runtime tests and a local no-browser smoke**

Run: `node --test reception_v2/test/runtime.test.mjs`
Expected: PASS. Run `node reception_v2/main.mjs doctor --no-browser`; expected: configuration and database OK, browser not opened, sends disabled.

### Task 8: Full Verification, Independent Review and Live Pilot

**Files:**
- Create: `.runtime/reception-v2-baseline.json`
- Modify: `README.md`
- Create: `.runtime/reception-v2-evidence.json`

**Interfaces:**
- Consumes: completed V2 implementation and the stopped old system snapshot.
- Produces: reproducible test report, read-only live observation, one live pilot result, independent audit and Red Team verdict.

- [ ] **Step 1: Run the complete automated suite**

Run: `node --test reception_v2/test/*.test.mjs`
Expected: every V2 test passes. Also run the existing legacy suites to ensure the stopped code was not modified accidentally: `python3 -m unittest discover -s tests -v` and the repository Node test loop from `README.md`.

- [ ] **Step 2: Perform a read-only browser pilot**

Start V2 without `--arm`; verify the exact logged-in account, current list, all visible overdue UIDs, current profile binding and contact controls. Do not click or send. Save a bounded baseline without raw phone numbers in logs.

- [ ] **Step 3: Obtain fresh review**

Send the implementation diff, design and test results to a fresh independent reviewer and a separate Red Team reviewer. Required review points: cross-UID protection, 800 ms turn merging, 2-second verification, contact privacy, refusal/blocked behavior and uncertain-send non-retry.

- [ ] **Step 4: Run one armed pilot**

Start V2 with `--arm` after review passes. Process exactly one visible overdue or new customer first. Verify the customer sees the human-like text and WeCom card, that no AI label appears, and that the operator card contains the correct five fields. Do not retry an uncertain operation.

- [ ] **Step 5: Expand to remaining visible overdue customers serially**

After the pilot passes, process remaining `超时未回复` rows one at a time. Stop immediately on account mismatch, platform block, unexpected send uncertainty, contact-read failure or cross-UID warning.

- [ ] **Step 6: Record evidence and hand over operation**

Save the following in `.runtime/reception-v2-evidence.json`: test commands and counts, read-only account/list proof, pilot UID/intent IDs, strict elapsed times, duplicate-send checks, contact-source proof and independent review verdicts. Update `README.md` with start, stop and recovery commands. Report actual results and limitations; do not claim all customers succeeded if any sends were blocked or uncertain.

