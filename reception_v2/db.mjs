import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { contentHash, ConversationState, OutboxState, normalizeText, TURN_WINDOW_MS } from './domain.mjs';

function nowIso() { return new Date().toISOString(); }
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

class V2Database {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        nickname TEXT,
        state TEXT NOT NULL,
        latest_turn_id TEXT,
        latest_inbound_at_ms INTEGER,
        contact_state TEXT NOT NULL DEFAULT 'none',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(account_id, conversation_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        platform_time_ms INTEGER,
        detected_at_ms INTEGER NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(account_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        opened_at_ms INTEGER NOT NULL,
        quiet_until_ms INTEGER NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, conversation_id, source_event_id)
      );
      CREATE TABLE IF NOT EXISTS turn_inbound_events (
        turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        text TEXT NOT NULL,
        platform_time_ms INTEGER NOT NULL,
        PRIMARY KEY(turn_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        intent_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content TEXT,
        state TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        submitted_at_ms INTEGER,
        confirmed_at_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, conversation_id, content_hash)
      );
      CREATE TABLE IF NOT EXISTS contacts (
        contact_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        verified INTEGER NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(account_id, conversation_id, kind, value)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        notice_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS legacy_unknown_blacklist (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY(account_id,conversation_id,content_hash)
      );
    `);
    fs.chmodSync(this.filePath, 0o600);
    this.recoverInflightSending();
  }

  recoverInflightSending() {
    const rows = this.db.prepare("SELECT intent_id,evidence_json FROM outbox WHERE state='sending'").all();
    if (!rows.length) return 0;
    transaction(this.db, () => {
      const statement = this.db.prepare("UPDATE outbox SET state='uncertain',evidence_json=?,updated_at=? WHERE intent_id=? AND state='sending'");
      for (const row of rows) {
        let payload={}; try { payload=JSON.parse(row.evidence_json); } catch {}
        payload.recovered_on_startup=true;
        statement.run(JSON.stringify(payload),nowIso(),row.intent_id);
      }
    });
    return rows.length;
  }

  close() { this.db.close(); }

  ingestInbound({ accountId, conversationId, eventId, text, platformTimeMs, detectedAtMs = Date.now(), nickname = null, evidence = {}, type = 'CUSTOMER_MESSAGE' }) {
    if (!accountId || !conversationId || !eventId || !Number.isFinite(platformTimeMs)) throw new TypeError('invalid_inbound');
    const normalized = normalizeText(text);
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT turn_id FROM turn_inbound_events WHERE event_id=?').get(eventId);
      if (existing) return this.getTurn(existing.turn_id);
      const now = nowIso();
      this.db.prepare(`INSERT OR IGNORE INTO conversations
        (account_id,conversation_id,nickname,state,contact_state,updated_at)
        VALUES(?,?,?,?,?,?)`).run(accountId, conversationId, nickname, ConversationState.CHATTING, 'none', now);
      if (nickname) this.db.prepare('UPDATE conversations SET nickname=?,updated_at=? WHERE account_id=? AND conversation_id=?')
        .run(nickname, now, accountId, conversationId);
      let turn = this.db.prepare(`SELECT * FROM turns WHERE account_id=? AND conversation_id=?
        AND quiet_until_ms>? ORDER BY opened_at_ms DESC LIMIT 1`).get(accountId, conversationId, platformTimeMs);
      if (!turn) {
        const turnId = crypto.randomUUID();
        this.db.prepare(`INSERT INTO turns
          (turn_id,account_id,conversation_id,source_event_id,opened_at_ms,quiet_until_ms,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(turnId, accountId, conversationId, eventId, platformTimeMs,
          platformTimeMs + TURN_WINDOW_MS, ConversationState.CHATTING, now, now);
        turn = this.db.prepare('SELECT * FROM turns WHERE turn_id=?').get(turnId);
      }
      this.db.prepare('INSERT INTO events (account_id,conversation_id,event_id,type,platform_time_ms,detected_at_ms,evidence_json) VALUES(?,?,?,?,?,?,?)')
        .run(accountId, conversationId, eventId, type, platformTimeMs, detectedAtMs, JSON.stringify(evidence));
      this.db.prepare('INSERT INTO turn_inbound_events (turn_id,event_id,text,platform_time_ms) VALUES(?,?,?,?)')
        .run(turn.turn_id, eventId, normalized, platformTimeMs);
      const extendedQuietUntil = Math.max(turn.quiet_until_ms, platformTimeMs + TURN_WINDOW_MS);
      this.db.prepare('UPDATE turns SET quiet_until_ms=?,updated_at=? WHERE turn_id=?').run(extendedQuietUntil, now, turn.turn_id);
      turn = { ...turn, quiet_until_ms: extendedQuietUntil };
      this.db.prepare(`UPDATE conversations SET latest_turn_id=?,latest_inbound_at_ms=?,updated_at=?
        WHERE account_id=? AND conversation_id=?`).run(turn.turn_id, platformTimeMs, now, accountId, conversationId);
      return this.getTurn(turn.turn_id);
    });
  }

  getTurn(turnId) {
    const turn = this.db.prepare('SELECT * FROM turns WHERE turn_id=?').get(turnId);
    if (!turn) throw new Error('turn_not_found');
    const inboundTexts = this.db.prepare('SELECT text FROM turn_inbound_events WHERE turn_id=? ORDER BY platform_time_ms,event_id')
      .all(turnId).map(row => row.text);
    return { turnId: turn.turn_id, accountId: turn.account_id, conversationId: turn.conversation_id,
      sourceEventId: turn.source_event_id, openedAtMs: turn.opened_at_ms, quietUntilMs: turn.quiet_until_ms,
      state: turn.state, attemptCount: turn.attempt_count, inboundTexts };
  }

  getConversation(accountId, conversationId) {
    const row = this.db.prepare('SELECT * FROM conversations WHERE account_id=? AND conversation_id=?').get(accountId, conversationId);
    return row ? { accountId: row.account_id, conversationId: row.conversation_id, nickname: row.nickname,
      state: row.state, latestTurnId: row.latest_turn_id, latestInboundAtMs: row.latest_inbound_at_ms,
      contactState: row.contact_state } : null;
  }

  setConversationState(accountId, conversationId, state) {
    const result = this.db.prepare('UPDATE conversations SET state=?,updated_at=? WHERE account_id=? AND conversation_id=?')
      .run(state, nowIso(), accountId, conversationId);
    if (Number(result.changes) !== 1) throw new Error('conversation_not_found');
    return this.getConversation(accountId, conversationId);
  }

  setTurnState(turnId, state) {
    const result = this.db.prepare('UPDATE turns SET state=?,updated_at=? WHERE turn_id=?').run(state, nowIso(), turnId);
    if (Number(result.changes) !== 1) throw new Error('turn_not_found');
    return this.getTurn(turnId);
  }

  listConversationOutboundTexts(accountId, conversationId) {
    return this.db.prepare("SELECT content FROM outbox WHERE account_id=? AND conversation_id=? AND kind IN ('text','contact_fallback') AND content IS NOT NULL ORDER BY created_at")
      .all(accountId, conversationId).map(row => row.content);
  }

  listIntents(turnId) {
    return this.db.prepare('SELECT intent_id FROM outbox WHERE turn_id=? ORDER BY created_at').all(turnId).map(row => this.getIntent(row.intent_id));
  }

  listTurns(accountId, conversationId) {
    return this.db.prepare('SELECT turn_id FROM turns WHERE account_id=? AND conversation_id=? ORDER BY opened_at_ms,turn_id')
      .all(accountId, conversationId).map(row => this.getTurn(row.turn_id));
  }

  createIntent({ turnId, kind, content = null, payload = {}, maxAttempts = 3 }) {
    const turn = this.getTurn(turnId);
    if (!['text', 'card', 'contact_fallback'].includes(kind)) throw new TypeError('invalid_intent_kind');
    const normalized = content === null ? JSON.stringify(payload) : normalizeText(content);
    const hash = contentHash(normalized);
    const duplicate = this.db.prepare('SELECT intent_id FROM outbox WHERE account_id=? AND conversation_id=? AND content_hash=?')
      .get(turn.accountId, turn.conversationId, hash);
    const legacyBlocked = this.db.prepare('SELECT 1 FROM legacy_unknown_blacklist WHERE account_id=? AND conversation_id=? AND content_hash=?')
      .get(turn.accountId, turn.conversationId, hash);
    if (duplicate || legacyBlocked) throw new Error('duplicate_outbound_content');
    if (turn.attemptCount >= maxAttempts) throw new Error('turn_attempt_limit_reached');
    const intentId = crypto.randomUUID();
    const now = nowIso();
    this.db.prepare(`INSERT INTO outbox
      (intent_id,turn_id,account_id,conversation_id,kind,content_hash,content,state,evidence_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(intentId, turnId, turn.accountId, turn.conversationId, kind, hash,
      content === null ? null : normalized, OutboxState.PREPARED, JSON.stringify(payload), now, now);
    this.db.prepare('UPDATE turns SET attempt_count=attempt_count+1,updated_at=? WHERE turn_id=?').run(now, turnId);
    return this.getIntent(intentId);
  }

  importLegacyUnknowns(rows) {
    let inserted = 0;
    const statement = this.db.prepare('INSERT OR IGNORE INTO legacy_unknown_blacklist (account_id,conversation_id,content_hash) VALUES(?,?,?)');
    transaction(this.db, () => { for (const row of rows) inserted += Number(statement.run(row.accountId, row.conversationId, row.contentHash).changes); });
    return inserted;
  }

  getIntent(intentId) {
    const row = this.db.prepare('SELECT * FROM outbox WHERE intent_id=?').get(intentId);
    if (!row) throw new Error('intent_not_found');
    return { intentId: row.intent_id, turnId: row.turn_id, accountId: row.account_id,
      conversationId: row.conversation_id, kind: row.kind, contentHash: row.content_hash,
      content: row.content, state: row.state, payload: JSON.parse(row.evidence_json), submittedAtMs: row.submitted_at_ms,
      confirmedAtMs: row.confirmed_at_ms };
  }

  markSending(intentId, submittedAtMs = Date.now()) {
    const now = nowIso();
    const result = this.db.prepare("UPDATE outbox SET state='sending',submitted_at_ms=?,updated_at=? WHERE intent_id=? AND state='prepared'")
      .run(submittedAtMs, now, intentId);
    if (Number(result.changes) !== 1) throw new Error('invalid_intent_transition');
    return this.getIntent(intentId);
  }

  markSent(intentId, evidence = {}) {
    const now = nowIso();
    const result = this.db.prepare("UPDATE outbox SET state='sent',confirmed_at_ms=?,evidence_json=?,updated_at=? WHERE intent_id=? AND state='sending'")
      .run(Number(evidence.confirmedAtMs) || Date.now(), JSON.stringify(evidence), now, intentId);
    if (Number(result.changes) !== 1) throw new Error('invalid_intent_transition');
    return this.getIntent(intentId);
  }

  markReconciledSent(intentId, evidence = {}) {
    const now = nowIso();
    const result = this.db.prepare("UPDATE outbox SET state='sent',confirmed_at_ms=?,evidence_json=?,updated_at=? WHERE intent_id=? AND state='uncertain'")
      .run(Number(evidence.confirmedAtMs) || Date.now(), JSON.stringify(evidence), now, intentId);
    if (Number(result.changes) !== 1) throw new Error('invalid_intent_transition');
    return this.getIntent(intentId);
  }

  markReconciledAbsent(intentId, evidence = {}) {
    const now = nowIso();
    const result = this.db.prepare("UPDATE outbox SET state='failed',evidence_json=?,updated_at=? WHERE intent_id=? AND state='uncertain'")
      .run(JSON.stringify(evidence), now, intentId);
    if (Number(result.changes) !== 1) throw new Error('invalid_intent_transition');
    return this.getIntent(intentId);
  }

  markFailed(intentId, reason = 'platform_blocked') {
    const now = nowIso();
    const result = this.db.prepare("UPDATE outbox SET state='failed',evidence_json=?,updated_at=? WHERE intent_id=? AND state IN ('prepared','sending')")
      .run(JSON.stringify({ reason }), now, intentId);
    if (Number(result.changes) !== 1) throw new Error('invalid_intent_transition');
    return this.getIntent(intentId);
  }

  markUncertain(intentId, evidence = {}) {
    const now = nowIso();
    const result = this.db.prepare("UPDATE outbox SET state='uncertain',evidence_json=?,updated_at=? WHERE intent_id=? AND state='sending'")
      .run(JSON.stringify(evidence), now, intentId);
    if (Number(result.changes) !== 1) throw new Error('invalid_intent_transition');
    return this.getIntent(intentId);
  }

  upsertContact({ accountId, conversationId, kind, value, source, verified = false, observedAtMs = Date.now() }) {
    if (!['phone', 'wechat', 'wechat_candidate', 'wecom_added', 'lead_submitted'].includes(kind)) throw new TypeError('invalid_contact_kind');
    const now = nowIso();
    this.db.prepare(`INSERT OR IGNORE INTO conversations
      (account_id,conversation_id,nickname,state,contact_state,updated_at)
      VALUES(?,?,?,?,?,?)`).run(accountId, conversationId, null, ConversationState.CHATTING, 'obtained', now);
    const existing = this.db.prepare('SELECT * FROM contacts WHERE account_id=? AND conversation_id=? AND kind=? AND value=?')
      .get(accountId, conversationId, kind, value);
    if (existing) return existing.contact_id;
    const contactId = crypto.randomUUID();
    this.db.prepare(`INSERT INTO contacts
      (contact_id,account_id,conversation_id,kind,value,source,verified,observed_at_ms,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(contactId, accountId, conversationId, kind, value, source, verified ? 1 : 0, observedAtMs, now);
    this.db.prepare('UPDATE conversations SET contact_state=?,updated_at=? WHERE account_id=? AND conversation_id=?')
      .run('obtained', now, accountId, conversationId);
    return contactId;
  }

  listOverdueRows({ accountId } = {}) {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM conversations WHERE account_id=? AND state NOT IN ('stopped','contact_obtained') ORDER BY latest_inbound_at_ms DESC").all(accountId)
      : this.db.prepare("SELECT * FROM conversations WHERE state NOT IN ('stopped','contact_obtained') ORDER BY latest_inbound_at_ms DESC").all();
    return rows.map(row => ({ accountId: row.account_id, conversationId: row.conversation_id,
      nickname: row.nickname, state: row.state, latestTurnId: row.latest_turn_id, latestInboundAtMs: row.latest_inbound_at_ms }));
  }
}

export function openDatabase(filePath) { return new V2Database(filePath); }
