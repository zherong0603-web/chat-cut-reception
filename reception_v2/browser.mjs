import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_CARD } from './account-config.mjs';
import { acceptsAccountTitle } from './sidebar.mjs';
const MESSAGE_ENDPOINT = '/api-sxt/edith/chatline/msg';

export function nativeMessageBelongsToIntent(id, intent) {
  const value = String(id || '');
  const prefixes = [`${intent.accountId}.${intent.conversationId}.`, `${intent.conversationId}.${intent.accountId}.`];
  return prefixes.some(prefix => value.startsWith(prefix) && value.length > prefix.length);
}

export function nativeMessageMatchesOutboundIntent(row, intent, startedAtMs, card = DEFAULT_CARD) {
  const message = row?.sixin_message;
  if (!message || !nativeMessageBelongsToIntent(message.id, intent)) return false;
  if (message.sender_id !== intent.accountId || message.receiver_id !== intent.conversationId) return false;
  if (row?.message_extension?.customer_user_id !== intent.conversationId) return false;
  const createdAt = Number(message.created_at), type = message.message_type || message.type;
  if (!Number.isFinite(createdAt) || createdAt < startedAtMs) return false;
  if (intent.kind === 'card') {
    if (type !== 'CARD') return false;
    const content=String(message.content||'');
    if(content.includes(card.title))return true;
    try{const value=JSON.parse(content);return value.contentType==='COMMERCIAL_BUSINESS_CARD'&&value.id===card.id&&value.csaAccountNo===card.csaAccountNo&&value.name===card.visibleName&&value.corpName===card.corpName;}catch{return false;}
  }
  return type === 'TEXT' && String(message.content || '').trim() === String(intent.content || '').trim();
}

export function activeConversationRootLocator(page, scope) {
  const exactActiveRow = page.locator(`.sx-contact-item.active[data-key="Total-${scope.conversationId}"]`);
  return page.locator('#walle-ad').filter({ has: exactActiveRow });
}

export async function prepareWeComCardPanel(root, cardConfig = DEFAULT_CARD) {
  const segments = root.locator('.chat-tool-wrap .d-segment-item').filter({ hasText: /^名片$/, visible: true });
  if (await segments.count() !== 1) {
    const existing = root.locator('.chat-tool-wrap .tabs-wrap .d-tabs-header').filter({ hasText: /^获客工具$/, visible: true });
    if (await existing.count() === 1) await existing.click({ timeout: 1500 });
    else {
      const tool = root.locator('.reply-tools .tool-item:has(svg.servicePage-icon)').filter({ visible: true });
      if (await tool.count() !== 1) throw new Error('unique_native_lead_tools_control_required');
      await tool.click({ timeout: 1500 });
    }
  }
  await segments.waitFor({ state: 'visible', timeout: 1500 });
  if (await segments.count() !== 1) throw new Error('unique_native_card_tab_required');
  await segments.click({ timeout: 1500 });
  await root.locator('.chat-tool-wrap .card-box__content-title[title="' + cardConfig.title + '"]').filter({ visible: true }).waitFor({ state: 'visible', timeout: 2000 });
}

export async function sendConfiguredWeComCard({ page, scope, cardConfig = DEFAULT_CARD, assertActive = async () => {} }) {
  await assertActive(scope);
  const root = activeConversationRootLocator(page, scope);
  if (await root.count() !== 1) throw new Error('exact_active_conversation_root_required');
  await prepareWeComCardPanel(root, cardConfig); await assertActive(scope);
  const title = root.locator('.chat-tool-wrap .card-box__content-title[title="' + cardConfig.title + '"]').filter({ visible: true });
  if (await title.count() !== 1) throw new Error('exact_native_wecom_card_required');
  const cardElement = title.locator('..').locator('..');
  if (await cardElement.count() !== 1) throw new Error('exact_native_wecom_card_required');
  await cardElement.hover({ timeout: 1000 });
  const button = cardElement.getByRole('button', { name: '发送', exact: true });
  if (await button.count() !== 1 || !(await button.isEnabled())) throw new Error('unique_enabled_card_send_required');
  await button.click({ timeout: 1000 }); await assertActive(scope);
}

function deepFindMessages(value) {
  const found = [];
  const seen = new Set();
  function walk(node, depth = 0) {
    if (!node || depth > 8 || seen.has(node)) return;
    if (typeof node !== 'object') return;
    seen.add(node);
    if (node.sixin_message && typeof node.sixin_message === 'object') found.push(node);
    for (const child of Object.values(node)) walk(child, depth + 1);
  }
  walk(value);
  return found;
}


export function modeMatchesScope(mode, scope) {
  return Boolean(mode?.scopeReady === true && mode.conversationId === scope.conversationId && mode.activeKey === 'Total-' + scope.conversationId);
}

export async function selectVisibleConversation(page, scope, modeFn) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const clicked = await page.evaluate(({ conversationId }) => {
      const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
      let rows = Array.from(document.querySelectorAll('.sx-contact-item')).filter(rendered)
        .filter(row => row.getAttribute('data-key') === 'Total-' + conversationId);
      if (rows.length !== 1) {
        const scroller=Array.from(document.querySelectorAll('.vue-recycle-scroller.scroller')).filter(rendered)
          .filter(el=>el.scrollHeight>el.clientHeight).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0];
        if(!scroller)return false;
        const max=Math.max(0,scroller.scrollHeight-scroller.clientHeight);
        const next=Math.min(max,scroller.scrollTop+Math.max(100,Math.floor(scroller.clientHeight*0.75)));
        scroller.scrollTop=next>=max?0:next;
        return false;
      }
      rows[0].click();
      return true;
    }, { conversationId: scope.conversationId });
    if (clicked) {
      await page.waitForTimeout(50);
      const mode = await modeFn(scope);
      if (modeMatchesScope(mode, scope)) {
        if (typeof page.waitForFunction === 'function') {
          await page.waitForFunction(({ accountId, conversationId }) => {
            const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
            const active = Array.from(document.querySelectorAll('.sx-contact-item.active')).filter(rendered);
            const prefixes = ['id_' + accountId + '.' + conversationId + '.', 'id_' + conversationId + '.' + accountId + '.'];
            return active.length === 1 && active[0].getAttribute('data-key') === 'Total-' + conversationId &&
              Array.from(document.querySelectorAll('.im-msg-item')).filter(rendered).some(item => prefixes.some(prefix => (item.id || '').startsWith(prefix)));
          }, { accountId: scope.accountId, conversationId: scope.conversationId }, { timeout: 5000 }).catch(() => { throw new Error('target_message_dom_not_hydrated'); });
        }
        return mode;
      }
    }
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(25);
    else await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('exact_visible_customer_row_required');
}

export function browserLaunchOptions({ chromium, headless, env = process.env }) {
  const executablePath=String(env.XHS_BROWSER_EXECUTABLE||'').trim() || (typeof chromium?.executablePath==='function'?chromium.executablePath():null);
  return { headless, ...(executablePath?{executablePath}:{}), ...(headless?{}:{args:['--window-position=-10000,-10000']}) };
}

async function waitForInbox(page, accountName) {
  await page.goto('https://sxt.xiaohongshu.com/im/multiCustomerService', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.locator('#walle-ad').first().waitFor({ state: 'attached', timeout: 20_000 });
  const readyDeadline = Date.now() + 20_000;
  while (Date.now() < readyDeadline) {
    if (acceptsAccountTitle(await page.title(), accountName)) break;
    await page.waitForTimeout(100);
  }
  if (!acceptsAccountTitle(await page.title(), accountName)) {
    const loginControls=await page.locator('input[type="password"],button:has-text("登录"),input[placeholder*="手机号"]').count().catch(()=>0);
    throw new Error(loginControls>0?'auth_required':'account_title_not_ready');
  }
  const rowsDeadline = Date.now() + 10_000;
  while (Date.now() < rowsDeadline && await page.locator('.sx-contact-item').count() === 0) await page.waitForTimeout(100);
}

async function loadChromium() {
  const modulePath = process.env.XHS_PLAYWRIGHT_MODULE;
  if (!modulePath) throw new Error('playwright_module_required');
  const mod = await import(pathToFileURL(path.resolve(modulePath)).href);
  const chromium = mod.chromium || mod.default?.chromium;
  if (!chromium) throw new Error('playwright_chromium_required');
  return chromium;
}

export async function openInteractiveLogin({ profileDir, accountName, timeoutMs = 15 * 60_000 }) {
  const chromium = await loadChromium();
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(profileDir, 0o700);
  const context = await chromium.launchPersistentContext(profileDir, browserLaunchOptions({chromium,headless:false}));
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto('https://sxt.xiaohongshu.com/im/multiCustomerService', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const title = await page.title();
      if (acceptsAccountTitle(title, accountName)) return { accountTitle: title };
      await page.waitForTimeout(500);
    }
    throw new Error('interactive_login_timeout');
  } finally {
    await context.close();
  }
}

export async function openBrowser({ profileDir, headless = false, accountId, accountName, card: cardConfig = DEFAULT_CARD }) {
  const chromium = await loadChromium();
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(profileDir, 0o700);
  const context = await chromium.launchPersistentContext(profileDir, browserLaunchOptions({chromium,headless}));
  const page = context.pages()[0] || await context.newPage();
  const transport={crashed:false,closed:false};
  page.on('crash',()=>{transport.crashed=true;});page.on('close',()=>{transport.closed=true;});context.on('close',()=>{transport.closed=true;});
  const nativeRecords = [];
  const requestStarts = new WeakMap();
  page.on('request', request => {
    if (request.url().includes(MESSAGE_ENDPOINT)) requestStarts.set(request, Date.now());
  });
  page.on('response', async response => {
    try {
      const request = response.request();
      if (!response.url().includes(MESSAGE_ENDPOINT) || response.status() !== 200) return;
      const body = await response.json();
      let queryUserIds=[];try{queryUserIds=new URL(request.url()).searchParams.getAll('customer_user_id');}catch{}
      const responseOk=body?.success===true&&body?.code===0&&Array.isArray(body?.data?.messages);
      nativeRecords.push({ request, status: response.status(), body, queryUserIds, responseOk, requestStartedAtMs: requestStarts.get(request) || 0, receivedAtMs: Date.now() });
      if (nativeRecords.length > 100) nativeRecords.splice(0, nativeRecords.length - 100);
    } catch {}
  });
  await waitForInbox(page, accountName);

  let pendingText = null;
  async function assertActive(scope) {
    const value = await browser.mode(scope);
    if (value.pageVisible === false) throw new Error('page_not_visible');
    if (!value.scopeReady) throw new Error('scope_not_ready');
    if (value.conversationId !== scope.conversationId) throw new Error('active_uid_changed_before_send');
    return value;
  }

  const browser = {
    page, context, nativeRecords,
    isTransportHealthy() { return !transport.crashed && !transport.closed && !page.isClosed(); },
    async recoverNavigation() { if (!this.isTransportHealthy()) throw new Error('page has been closed'); await waitForInbox(page, accountName); },
    async selectConversation(scope) { return selectVisibleConversation(page, scope, value => this.mode(value)); },
    async refreshConversation(scope) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.locator('#walle-ad').first().waitFor({ state: 'attached', timeout: 15_000 });
      const titleDeadline = Date.now() + 8_000;
      while (Date.now() < titleDeadline && !acceptsAccountTitle(await page.title(), accountName)) await page.waitForTimeout(100);
      if (!acceptsAccountTitle(await page.title(), accountName)) throw new Error('account_title_not_ready');
      const rowsDeadline = Date.now() + 5_000;
      while (Date.now() < rowsDeadline && await page.locator('.sx-contact-item').count() === 0) await page.waitForTimeout(100);
      await page.evaluate(() => {
        const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
        const all = Array.from(document.querySelectorAll('.contact-tab-wrap .d-tabs-header')).filter(rendered).find(el => String(el.innerText || '').trim() === '全部会话');
        if (all && !String(all.getAttribute('class') || '').split(/\s+/).includes('active')) all.click();
      });
      await page.waitForTimeout(120);
      return selectVisibleConversation(page, scope, value => this.mode(value));
    },
    async mode(scope) { return page.evaluate(({ accountId, conversationId }) => {
      const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
      const all = (root, selector) => Array.from(root.querySelectorAll(selector)).filter(rendered);
      const roots = all(document, '#walle-ad').filter(root => {
        const active = all(root, '.sx-contact-item.active');
        return active.length === 1 && active[0].getAttribute('data-key') === 'Total-' + conversationId;
      });
      if (roots.length !== 1) return { pageVisible: document.visibilityState !== 'hidden', scopeReady: false, manual: false, inputReady: false, overlayVisible: false, takeoverVisible: false };
      const root = roots[0], active = all(root, '.sx-contact-item.active'), input = all(root, '.reply-box-wrap textarea.reply-textarea');
      const overlayVisible = all(root, '.ai-overlay').length > 0;
      const takeoverVisible = all(root, '.ai-overlay-button,.reply-box-wrap button').some(el => String(el.innerText || '').trim() === '人工接管');
      const switches = all(root, '.message-header [data-track-click]').filter(el => {
        try { if(JSON.parse(el.getAttribute('data-track-click')).attributes?.triggerKey !== '人工转AI' || el.disabled)return false;
          const buttons=Array.from(el.querySelectorAll('button')).filter(rendered);
          return el.matches('button') || (buttons.length === 1 && !buttons[0].disabled);
        } catch { return false; }
      });
      const inputReady = input.length === 1 && !input[0].disabled && !input[0].readOnly;
      return { pageVisible: document.visibilityState !== 'hidden', scopeReady: true, activeKey: active[0].getAttribute('data-key'),
        manual: !overlayVisible && !takeoverVisible && switches.length === 1 && inputReady,
        inputReady, overlayVisible, takeoverVisible, accountId, conversationId };
    }, { accountId: scope.accountId, conversationId: scope.conversationId }); },
    async clickTakeover(scope) { await page.evaluate(({ conversationId }) => {
      const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
      const rows = Array.from(document.querySelectorAll('.sx-contact-item.active')).filter(rendered)
        .filter(el => el.getAttribute('data-key') === 'Total-' + conversationId);
      if (rows.length !== 1) throw new Error('active_customer_required');
      const root = rows[0].closest('#walle-ad');
      const buttons = Array.from(root.querySelectorAll('.ai-overlay-button,.reply-box-wrap button')).filter(rendered)
        .filter(el => String(el.innerText || '').trim() === '人工接管');
      if (buttons.length !== 1 || buttons[0].disabled) throw new Error('native_takeover_control_required');
      buttons[0].click();
    }, { conversationId: scope.conversationId }); },
    async fillText(scope, text) { await assertActive(scope); const root = activeConversationRootLocator(page, scope);
      if (await root.count() !== 1) throw new Error('exact_active_conversation_root_required');
      const input = root.locator('.reply-box-wrap textarea.reply-textarea').filter({ visible: true });
      if (await input.count() !== 1) throw new Error('unique_message_input_required');
      if (await input.inputValue() !== '') throw new Error('existing_operator_draft_preserved');
      await input.fill(text, { timeout: 1000 }); pendingText = text; await assertActive(scope); },
    async clickTextSend(scope) { await assertActive(scope); const root = activeConversationRootLocator(page, scope);
      if (await root.count() !== 1) throw new Error('exact_active_conversation_root_required');
      const button = root.locator('.reply-bottom-bar button').filter({ visible: true });
      if (await button.count() !== 1 || !(await button.isEnabled())) throw new Error('unique_enabled_send_control_required');
      await button.click({ timeout: 1000 }); await assertActive(scope); },
    async sendCard(scope) { return sendConfiguredWeComCard({ page, scope, cardConfig, assertActive }); },
    async waitForReceipt(intent, { startedAtMs = 0, timeoutMs = 2000 } = {}) { const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        const candidates = nativeRecords.filter(record => record.requestStartedAtMs >= startedAtMs && record.responseOk === true &&
          record.queryUserIds?.length === 1 && record.queryUserIds[0] === intent.conversationId)
          .flatMap(record => deepFindMessages(record.body).filter(row => nativeMessageMatchesOutboundIntent(row,intent,startedAtMs,cardConfig))
            .map(row => ({row,observedAtMs:record.receivedAtMs||Date.now()})));
        const match = candidates.find(({row}) => (row.sixin_message.message_type || row.sixin_message.type) === (intent.kind === 'card' ? 'CARD' : 'TEXT'));
        if (match) {
          const message=match.row.sixin_message;
          return { serverStatus: 'confirmed', accountId: intent.accountId, conversationId: intent.conversationId,
            ...(intent.kind === 'card'?{type:'CARD',cardTitle:cardConfig.title}:{content:intent.content,type:'TEXT'}),
            platformTimeMs: Number(message.created_at), observedAtMs: match.observedAtMs, visibleAtMs: null,
            senderId: String(message.sender_id), receiverId: String(message.receiver_id), direction: 'OUTBOUND', nativeId: 'id_' + String(message.id) };
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return { serverStatus: 'pending', observedAtMs: Date.now() };
    },
    async close() { await context.close(); },
  };
  return browser;
}
