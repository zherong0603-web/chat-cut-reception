import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CARD_CLICK_ACK_TEXT } from './domain.mjs';

const KINDS = new Set(['ready_to_follow']);
const HIDDEN_KINDS = new Set(['needs_operator', 'send_failed']);
const LABELS = { ready_to_follow: '可以跟进', needs_operator: '需要你处理', send_failed: '消息没有发出去' };
const queueName = 'reception-v2-notification-queue.json';
const hiddenName = 'reception-v2-hidden-events.json';
const ackRequestName = 'reception-v2-notification-ack-request.json';

export function shouldNotify(event) { return KINDS.has(event?.kind); }

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function bounded(value, length = 600) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length); }

export function renderCardText(card) {
  const f = card.fields || {};
  return [LABELS[card.kind], '客户：' + (f['客户'] || ''), '想了解：' + (f['想了解'] || ''),
    '联系方式：' + (f['联系方式'] || ''), '我已完成：' + (f['我已完成'] || ''), '下一步：' + (f['下一步'] || '')].join('\n');
}

export function safeLogProjection(card) {
  return JSON.stringify({ noticeId: card.noticeId, kind: card.kind, customer: card.fields?.['客户'], contact_state: card.fields?.['联系方式'] ? 'present' : 'none' });
}

function localTime(ms) {
  if(!Number.isFinite(ms))return '时间未记录';
  return new Date(ms+8*3600_000).toISOString().replace('T',' ').slice(0,19)+'（北京时间）';
}

function transcriptText(value) {
  return typeof value === 'string' && value.trim() ? value : '';
}

export function buildReceptionTimeline(db, accountId, uid, saved = {}) {
  const inbound = db.prepare("SELECT DISTINCT e.event_id,e.platform_time_ms,i.text FROM events e LEFT JOIN turn_inbound_events i ON i.event_id=e.event_id AND i.turn_id IN (SELECT turn_id FROM turns WHERE account_id=e.account_id AND conversation_id=e.conversation_id) WHERE e.account_id=? AND e.conversation_id=? AND e.type='CUSTOMER_MESSAGE' ORDER BY e.platform_time_ms,e.event_id").all(accountId, uid);
  const rows = db.prepare("SELECT o.kind,o.state,o.content,o.evidence_json,o.submitted_at_ms,(SELECT json_group_array(event_id) FROM turn_inbound_events WHERE turn_id=o.turn_id) AS source_event_ids_json FROM outbox o WHERE o.account_id=? AND o.conversation_id=? ORDER BY o.created_at,o.intent_id").all(accountId, uid);
  const customers = inbound.filter(row => transcriptText(row.text)).map(row => ({
    role: 'customer', text: row.text, timeMs: Number.isFinite(row.platform_time_ms) ? row.platform_time_ms : null,
    nativeId: row.event_id, status: 'observed',
  }));
  const byNativeId = new Map(customers.filter(message => message.nativeId).map(message => [message.nativeId, message]));
  for (const observed of Array.isArray(saved.customerMessages) ? saved.customerMessages : []) {
    if (!observed?.nativeId || !transcriptText(observed.text)) continue;
    const previous = byNativeId.get(observed.nativeId);
    if (previous) {
      if (Number.isFinite(observed.platformTimeMs) && previous.timeMs === observed.platformTimeMs) previous.text = observed.text;
      continue;
    }
    const message = {
      role: 'customer', text: observed.text, timeMs: Number.isFinite(observed.platformTimeMs) ? observed.platformTimeMs : null,
      nativeId: observed.nativeId, status: 'observed',
    };
    customers.push(message);
    byNativeId.set(message.nativeId, message);
  }
  const savedText = transcriptText(saved.customerText) || transcriptText(saved.customer_text);
  const savedMs = Number.isFinite(saved.customerMessageTimeMs) ? saved.customerMessageTimeMs : null;
  let independentUntimedSnapshot = null;
  if (savedText && !customers.some(message => saved.customerNativeId
    ? message.nativeId === saved.customerNativeId
    : savedMs !== null && message.text === savedText && message.timeMs === savedMs)) {
    const snapshot = {role: 'customer', text: savedText, timeMs: savedMs, nativeId: saved.customerNativeId || null, status: 'observed'};
    customers.push(snapshot);
    if (snapshot.nativeId) byNativeId.set(snapshot.nativeId, snapshot);
    if (savedMs === null) independentUntimedSnapshot = snapshot;
  }
  const latestCustomer = independentUntimedSnapshot || customers.filter(message => message.timeMs !== null).sort((a, b) => b.timeMs - a.timeMs)[0] || customers.at(-1);
  const replyPriority = { no_record: 0, prepared: 1, failed: 2, uncertain: 3, confirmed: 4 };
  for (const message of customers) message.replyStatus = message.nativeId ? 'no_record' : 'unknown';
  const outgoing = rows.map(row => {
    let receipt = {}; try { receipt = JSON.parse(row.evidence_json || '{}'); } catch {}
    const confirmed = row.state === 'sent' && receipt.verified === true && receipt.serverStatus === 'confirmed'
      && Number.isFinite(receipt.platformTimeMs);
    const timeMs = confirmed ? receipt.platformTimeMs : null;
    let sourceIds = []; try { sourceIds = JSON.parse(row.source_event_ids_json || '[]'); } catch {}
    if (!Array.isArray(sourceIds)) sourceIds = [];
    const confirmedAfter = message => confirmed && timeMs !== null && message?.timeMs != null && timeMs >= message.timeMs
      && Number.isFinite(row.submitted_at_ms) && row.submitted_at_ms >= message.timeMs;
    const questionReply = (row.kind === 'text' || row.kind === 'contact_fallback') && row.content !== CARD_CLICK_ACK_TEXT;
    if (questionReply) {
      for (const sourceId of sourceIds) {
        const customer = byNativeId.get(sourceId);
        if (!customer) continue;
        const status = confirmedAfter(customer) ? 'confirmed' : ['prepared', 'failed'].includes(row.state) ? row.state : 'uncertain';
        if (replyPriority[status] > replyPriority[customer.replyStatus]) customer.replyStatus = status;
      }
    }
    return {role: 'our', text: row.kind === 'card' ? '企业微信名片' : transcriptText(row.content), timeMs,
      status: confirmed ? 'confirmed' : row.state, kind: row.kind,
      isAfterLatestCustomer: (questionReply || row.kind === 'card') && confirmedAfter(latestCustomer) && sourceIds.includes(latestCustomer.nativeId)};
  });
  const messages = [...customers, ...outgoing].sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity));
  const sentMessages = outgoing.map(message => {
    const state = message.status === 'confirmed' ? '平台已确认' : message.status === 'prepared' ? '尚未提交' : message.status === 'failed' ? '发送失败' : '尚不能确认发出';
    return (message.status === 'confirmed' ? localTime(message.timeMs) + ' ' : '') + state + '：' + message.text;
  }).join('\n');
  return {customerText: latestCustomer?.text || '尚未记录客户文字原话',
    openedAt: latestCustomer?.timeMs == null ? '开口时间未留存' : localTime(latestCustomer.timeMs), messages,
    sentMessages: sentMessages || '本程序没有发送记录'};
}

export function createNotifierStore(runtimeDir, { db = null } = {}) {
  const file = path.join(runtimeDir, queueName);
  const hiddenFile = path.join(runtimeDir, hiddenName);
  const ackRequestFile = path.join(runtimeDir, ackRequestName);
  let mutationTail = Promise.resolve();
  function serialize(operation) { const next = mutationTail.then(operation, operation); mutationTail = next.then(() => undefined, () => undefined); return next; }
  async function read() {
    if (!fs.existsSync(file)) return [];
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(value) ? value.map(card=>{try{return db?{...card,timeline:buildReceptionTimeline(db,card.accountId,card.conversationId,card.details||{})}:card;}catch{return card;}}) : []; }
    catch { return []; }
  }
  async function write(cards) { atomicJson(file, cards.slice(-100)); }
  async function readHidden() { try { const value=JSON.parse(fs.readFileSync(hiddenFile,'utf8')); return Array.isArray(value)?value:[]; } catch { return []; } }
  async function writeHidden(events) { atomicJson(hiddenFile, events.slice(-200)); }
  async function flushAcknowledgementsInner() {
    if (!fs.existsSync(ackRequestFile)) return [];
    const claimFile = ackRequestFile + '.claim.' + process.pid + '.' + crypto.randomUUID();
    try { fs.renameSync(ackRequestFile, claimFile); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    let request; try { request = JSON.parse(fs.readFileSync(claimFile, 'utf8')); } catch { try{fs.unlinkSync(claimFile);}catch{} return []; }
    const ids = new Set(Array.isArray(request?.noticeIds) ? request.noticeIds : [request?.noticeId].filter(Boolean));
    const cards = await read(); let changed = false;
    for (const card of cards) if (ids.has(card.noticeId) && !card.acknowledgedAt) { card.acknowledgedAt = new Date().toISOString(); changed = true; }
    if (changed) await write(cards);
    try { fs.unlinkSync(claimFile); } catch {}
    return cards.filter(card => ids.has(card.noticeId));
  }
  function flushAcknowledgements() { return serialize(flushAcknowledgementsInner); }
  function cardFor(input) {
    const dedupeKey = [input.kind, input.accountId, input.conversationId, input.contact].join('\0');
    const timeline=db?buildReceptionTimeline(db,input.accountId,input.conversationId,input.details||{}):null;
    return {timeline, dedupeKey, noticeId: crypto.randomUUID(), kind: input.kind,
      fields: { '客户': bounded(input.customer, 80), '想了解': bounded(input.need),
        '联系方式': bounded(input.contact), '我已完成': bounded(input.completed), '下一步': bounded(input.next) },
      details: input.details && typeof input.details === 'object' ? input.details : {},
      accountId: bounded(input.accountId, 64), conversationId: bounded(input.conversationId, 64),
      createdAt: new Date().toISOString(), acknowledgedAt: null};
  }
  function enqueue(input) { return serialize(async () => {
    if (HIDDEN_KINDS.has(input.kind)) {
      const events=await readHidden();const dedupeKey=[input.kind,input.accountId,input.conversationId,input.contact].join('\0');
      const duplicate=events.find(event=>event.dedupeKey===dedupeKey);if(duplicate)return duplicate;
      const event=cardFor(input);events.push(event);await writeHidden(events);return event;
    }
    if (!shouldNotify(input)) throw new Error('notification_required');
    await flushAcknowledgementsInner();
    const dedupeKey = [input.kind, input.accountId, input.conversationId, input.contact].join('\0');
    const cardsBefore = await read(); const duplicate = cardsBefore.find(card => card.dedupeKey === dedupeKey);
    if (duplicate) {
      const current = input.details?.customerMessageTimeMs;
      const previous = duplicate.details?.customerMessageTimeMs;
      const priorDetails = duplicate.details || {};
      const currentId = input.details?.customerNativeId;
      const alreadyObserved = currentId === priorDetails.customerNativeId || priorDetails.customerMessages?.some?.(message => message?.nativeId === currentId);
      if (!Number.isFinite(current) || current < previous || (current === previous && (!currentId || alreadyObserved))) return duplicate;
      const priorMessage = { nativeId: priorDetails.customerNativeId, platformTimeMs: previous, text: priorDetails.customerText };
      const observations = new Map();
      for (const details of [priorDetails, input.details]) {
        for (const message of Array.isArray(details.customerMessages) ? details.customerMessages : []) {
          if (message?.nativeId) observations.set(message.nativeId, message);
        }
      }
      if (priorMessage.nativeId && !observations.has(priorMessage.nativeId)) observations.set(priorMessage.nativeId, priorMessage);
      const refreshed = cardFor({ ...input, details: { ...input.details, customerMessages: [...observations.values()] } });
      const updated = { ...refreshed, noticeId: duplicate.noticeId, createdAt: duplicate.createdAt, acknowledgedAt: duplicate.acknowledgedAt };
      await write(cardsBefore.map(card => card.noticeId === duplicate.noticeId ? updated : card));
      return updated;
    }
    const card = cardFor(input);
    const cards = await read(); cards.push(card); await write(cards); return card;
  }); }
  function acknowledge(noticeId) { return serialize(async () => {
    const cards = await read(); const card = cards.find(value => value.noticeId === noticeId);
    if (!card) throw new Error('notice_not_found');
    const temp = ackRequestFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ noticeId }) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, ackRequestFile);
    await flushAcknowledgementsInner();
    return (await read()).find(value => value.noticeId === noticeId);
  }); }
  async function notifyBlocked(input) { return enqueue({ ...input, kind: 'send_failed' }); }
  return { enqueue, notifyBlocked, acknowledge, read, flushAcknowledgements, file, hiddenFile, ackRequestFile };
}
