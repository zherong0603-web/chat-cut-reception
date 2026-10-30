import { DEFAULT_CARD } from './account-config.mjs';
import { OutboxState } from './domain.mjs';

function normalized(value) { return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim(); }

export function verifyNativeHistory(intent, receipt, sourcePlatformTimeMs, submittedAtMs = null, card = DEFAULT_CARD) {
  if (!receipt || receipt.serverStatus !== 'confirmed') return false;
  if (receipt.accountId !== intent.accountId || receipt.conversationId !== intent.conversationId) return false;
  if (receipt.senderId !== intent.accountId || receipt.receiverId !== intent.conversationId || receipt.direction !== 'OUTBOUND') return false;
  const nativeId = String(receipt.nativeId || '');
  const nativePrefixes = [`id_${intent.accountId}.${intent.conversationId}.`, `id_${intent.conversationId}.${intent.accountId}.`];
  if (!nativePrefixes.some(prefix => nativeId.startsWith(prefix) && nativeId.length > prefix.length)) return false;
  if (!Number.isFinite(receipt.observedAtMs) || !Number.isFinite(receipt.platformTimeMs)) return false;
  if (submittedAtMs !== null && (!Number.isFinite(submittedAtMs) || receipt.platformTimeMs < submittedAtMs || receipt.observedAtMs < submittedAtMs || !Number.isFinite(receipt.visibleAtMs) || receipt.visibleAtMs < submittedAtMs)) return false;
  if (receipt.platformTimeMs < sourcePlatformTimeMs || receipt.platformTimeMs > receipt.observedAtMs + 1000) return false;
  if (intent.kind === 'card') return receipt.type === 'CARD' && receipt.cardTitle === card.title;
  return receipt.type === 'TEXT' && normalized(receipt.content) === normalized(intent.content);
}

function isPlatformBlock(error) {
  return error?.code === 'platform_blocked' || /platform_blocked|发送受限|无法发送/.test(String(error?.message || ''));
}

export function createSender({ store, browser, card = DEFAULT_CARD, now = Date.now }) {
  if (!store || !browser) throw new TypeError('store_and_browser_required');

  async function enterHumanMode(scope) {
    const before = await browser.mode(scope);
    if (before.pageVisible === false) throw new Error('page_not_visible');
    if (!before.scopeReady) throw new Error('scope_not_ready');
    if (before.manual && before.inputReady) return { clicked: false, before, after: before };
    if (!before.takeoverVisible) throw new Error('native_takeover_control_required');
    await browser.clickTakeover(scope);
    let after = null;
    for (let index = 0; index < 20; index++) {
      after = await browser.mode(scope);
      if (after.manual && after.inputReady) return { clicked: true, before, after };
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('native_manual_mode_not_confirmed');
  }

  async function finalize(intentId, scope, sourcePlatformTimeMs, receipt, startedAtMs) {
    const intent = store.getIntent(intentId);
    const verified = verifyNativeHistory(intent, receipt, sourcePlatformTimeMs, startedAtMs, card);
    if (!verified) return { state: 'uncertain', intent: store.markUncertain(intentId, { receipt, verified: false }) };
    const elapsed = receipt.observedAtMs - sourcePlatformTimeMs;
    const result = store.markSent(intentId, {
      ...receipt, verified: true, visibleElapsedMs: receipt.visibleAtMs ? receipt.visibleAtMs - sourcePlatformTimeMs : null,
      [`${intent.kind}ConfirmedMs`]: elapsed, withinTwoSeconds: elapsed <= 2000,
    });
    return { state: 'sent', intent: result, withinTwoSeconds: elapsed <= 2000, confirmedMs: elapsed };
  }

  async function retryVerification(intentId, scope, sourcePlatformTimeMs, startedAtMs, initial) {
    if (initial?.state !== 'uncertain' || typeof browser.refreshConversation !== 'function') return initial;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { await browser.refreshConversation(scope); }
      catch { continue; }
      const intent = store.getIntent(intentId);
      const receipt = await browser.waitForReceipt(intent, { startedAtMs, timeoutMs: 2500 });
      if (!verifyNativeHistory(intent, receipt, sourcePlatformTimeMs, startedAtMs, card)) continue;
      const elapsed = receipt.observedAtMs - sourcePlatformTimeMs;
      const reconciled = store.markReconciledSent(intentId, {
        ...receipt, verified: true, reconciled: true, verificationAttempt: attempt + 1,
        visibleElapsedMs: receipt.visibleAtMs ? receipt.visibleAtMs - sourcePlatformTimeMs : null,
        [`${intent.kind}ConfirmedMs`]: elapsed, withinTwoSeconds: elapsed <= 2000,
      });
      return { state: 'sent', intent: reconciled, withinTwoSeconds: elapsed <= 2000, confirmedMs: elapsed };
    }
    return initial;
  }

  async function assertSafeMode(scope) {
    const mode = await browser.mode(scope);
    if (mode.pageVisible === false) throw new Error('page_not_visible');
    if (!mode.scopeReady) throw new Error('scope_not_ready');
    if (mode.conversationId && mode.conversationId !== scope.conversationId) throw new Error('active_uid_changed_before_send');
    if (!mode.manual || !mode.inputReady) throw new Error('native_manual_mode_required');
    return mode;
  }

  async function sendText(intentId, scope, sourcePlatformTimeMs) {
    const intent = store.getIntent(intentId);
    if (!['text', 'contact_fallback'].includes(intent.kind) || intent.state !== OutboxState.PREPARED) throw new Error('intent_not_prepared');
    const mode = await browser.mode(scope);
    if (mode.pageVisible === false) throw new Error('page_not_visible');
    if (mode.conversationId && mode.conversationId !== scope.conversationId) throw new Error('active_uid_changed_before_send');
    if (!mode.manual || !mode.inputReady) throw new Error('native_manual_mode_required');
    try { await browser.fillText(scope, intent.content); }
    catch (error) {
      if (isPlatformBlock(error)) return { state: 'send_blocked', intent: store.markFailed(intentId, 'platform_blocked') };
      throw error;
    }
    const afterFill = await browser.mode(scope);
    if (afterFill.pageVisible === false) throw new Error('page_not_visible');
    if (afterFill.conversationId && afterFill.conversationId !== scope.conversationId) throw new Error('active_uid_changed_before_send');
    if (!afterFill.manual || !afterFill.inputReady) throw new Error('native_manual_mode_required');
    const startedAtMs = now();
    store.markSending(intentId, startedAtMs);
    try {
      await browser.clickTextSend(scope);
      const receipt = await browser.waitForReceipt(store.getIntent(intentId), { startedAtMs });
      const initial = await finalize(intentId, scope, sourcePlatformTimeMs, receipt, startedAtMs);
      return await retryVerification(intentId, scope, sourcePlatformTimeMs, startedAtMs, initial);
    } catch (error) {
      if (isPlatformBlock(error)) return { state: 'send_blocked', intent: store.markFailed(intentId, 'platform_blocked') };
      return { state: 'uncertain', intent: store.markUncertain(intentId, { error: error?.message || 'send_error' }) };
    }
  }

  async function sendWeComCard(intentId, scope, sourcePlatformTimeMs) {
    const intent = store.getIntent(intentId);
    if (intent.kind !== 'card' || intent.state !== OutboxState.PREPARED) throw new Error('intent_not_prepared');
    const mode = await browser.mode(scope);
    if (mode.pageVisible === false) throw new Error('page_not_visible');
    if (mode.conversationId && mode.conversationId !== scope.conversationId) throw new Error('active_uid_changed_before_send');
    if (!mode.manual || !mode.inputReady) throw new Error('native_manual_mode_required');
    const startedAtMs = now();
    store.markSending(intentId, startedAtMs);
    try {
      await browser.sendCard(scope);
      const receipt = await browser.waitForReceipt(store.getIntent(intentId), { startedAtMs });
      const initial = await finalize(intentId, scope, sourcePlatformTimeMs, receipt, startedAtMs);
      return await retryVerification(intentId, scope, sourcePlatformTimeMs, startedAtMs, initial);
    } catch (error) {
      if (isPlatformBlock(error)) return { state: 'send_blocked', intent: store.markFailed(intentId, 'platform_blocked') };
      return { state: 'uncertain', intent: store.markUncertain(intentId, { error: error?.message || 'send_error' }) };
    }
  }


  async function sendTextAndCard(textIntentId, cardIntentId, scope, sourcePlatformTimeMs) {
    const textIntent = store.getIntent(textIntentId), cardIntent = store.getIntent(cardIntentId);
    if (textIntent.kind !== 'text' || textIntent.state !== OutboxState.PREPARED ||
        cardIntent.kind !== 'card' || cardIntent.state !== OutboxState.PREPARED) throw new Error('intent_not_prepared');
    const mode = await browser.mode(scope);
    if (mode.pageVisible === false) throw new Error('page_not_visible');
    if (mode.conversationId && mode.conversationId !== scope.conversationId) throw new Error('active_uid_changed_before_send');
    if (!mode.manual || !mode.inputReady) throw new Error('native_manual_mode_required');
    try { await browser.fillText(scope, textIntent.content); }
    catch (error) {
      if (isPlatformBlock(error)) return { state: 'send_blocked', text: { state: 'send_blocked', intent: store.markFailed(textIntentId, 'platform_blocked') }, card: null };
      throw error;
    }
    await assertSafeMode(scope);
    const textStartedAtMs = now(); store.markSending(textIntentId, textStartedAtMs);
    try { await browser.clickTextSend(scope); }
    catch (error) {
      if (isPlatformBlock(error)) return { state: 'send_blocked', text: { state: 'send_blocked', intent: store.markFailed(textIntentId, 'platform_blocked') }, card: null };
      store.markUncertain(textIntentId, { error: error?.message || 'send_error' });
      return { state: 'uncertain', text: { state: 'uncertain', intent: store.getIntent(textIntentId) }, card: null };
    }
    await assertSafeMode(scope);
    const cardStartedAtMs = now(); store.markSending(cardIntentId, cardStartedAtMs);
    try { await browser.sendCard(scope); }
    catch (error) {
      store.markUncertain(textIntentId, { error: 'card_send_failed_after_text_submit' });
      if (isPlatformBlock(error)) return { state: 'send_blocked', text: { state: 'uncertain', intent: store.getIntent(textIntentId) }, card: { state: 'send_blocked', intent: store.markFailed(cardIntentId, 'platform_blocked') } };
      store.markUncertain(cardIntentId, { error: error?.message || 'send_error' });
      return { state: 'uncertain', text: { state: 'uncertain', intent: store.getIntent(textIntentId) }, card: { state: 'uncertain', intent: store.getIntent(cardIntentId) } };
    }
    const [textReceipt, cardReceipt] = await Promise.all([
      browser.waitForReceipt(store.getIntent(textIntentId), { startedAtMs: textStartedAtMs }),
      browser.waitForReceipt(store.getIntent(cardIntentId), { startedAtMs: cardStartedAtMs }),
    ]);
    let [text, card] = await Promise.all([
      finalize(textIntentId, scope, sourcePlatformTimeMs, textReceipt, textStartedAtMs),
      finalize(cardIntentId, scope, sourcePlatformTimeMs, cardReceipt, cardStartedAtMs),
    ]);
    text = await retryVerification(textIntentId, scope, sourcePlatformTimeMs, textStartedAtMs, text);
    card = await retryVerification(cardIntentId, scope, sourcePlatformTimeMs, cardStartedAtMs, card);
    const withinTwoSeconds = text.state === 'sent' && card.state === 'sent' && text.withinTwoSeconds === true && card.withinTwoSeconds === true;
    return { state: text.state === 'sent' && card.state === 'sent' ? 'sent' : 'uncertain', text, card, withinTwoSeconds };
  }

  return { enterHumanMode, sendText, sendWeComCard, sendTextAndCard };
}
