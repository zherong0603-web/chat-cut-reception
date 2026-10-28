import crypto from 'node:crypto';

export const TURN_WINDOW_MS = 800;

export const ConversationState = Object.freeze({
  CHATTING: 'chatting',
  WAITING_CONTACT: 'waiting_contact',
  CONTACT_OBTAINED: 'contact_obtained',
  NEEDS_HUMAN: 'needs_human',
  SEND_BLOCKED: 'send_blocked',
  STOPPED: 'stopped',
});

export const OutboxState = Object.freeze({
  PREPARED: 'prepared',
  SENDING: 'sending',
  SENT: 'sent',
  UNCERTAIN: 'uncertain',
  FAILED: 'failed',
});

export function normalizeText(value) {
  if (typeof value !== 'string') throw new TypeError('text_required');
  return value.normalize('NFC').replace(/\s+/g, ' ').replace(/\s*([，。！？；：、,.!?;:])\s*/g, '$1').trim();
}

export function contentHash(value) {
  return crypto.createHash('sha256').update(normalizeText(value)).digest('hex');
}
