import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

export function createNotifierStore(runtimeDir) {
  const file = path.join(runtimeDir, queueName);
  const hiddenFile = path.join(runtimeDir, hiddenName);
  const ackRequestFile = path.join(runtimeDir, ackRequestName);
  let mutationTail = Promise.resolve();
  function serialize(operation) { const next = mutationTail.then(operation, operation); mutationTail = next.then(() => undefined, () => undefined); return next; }
  async function read() {
    if (!fs.existsSync(file)) return [];
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(value) ? value : []; }
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
    return {dedupeKey, noticeId: crypto.randomUUID(), kind: input.kind,
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
    if (duplicate) return duplicate;
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
