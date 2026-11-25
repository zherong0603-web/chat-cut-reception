import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_CARD } from './account-config.mjs';
import { acceptsAccountTitle } from './sidebar.mjs';
import { assertReplySourceWindow } from './reply-schedule.mjs';
const MESSAGE_ENDPOINT = '/api-sxt/edith/chatline/msg';

function nativeHistoryRequestScope(request,expectedUid=null){
  try{
    if(request?.method()!=='GET')return null;
    const url=new URL(request.url()),uids=url.searchParams.getAll('customer_user_id');
    if(url.origin!=='https://sxt.xiaohongshu.com'||url.pathname!==MESSAGE_ENDPOINT||url.username||url.password||url.hash||url.href.includes('#')||uids.length!==1||!/^[a-f0-9]{24}$/.test(uids[0])||(expectedUid!==null&&uids[0]!==expectedUid))return null;
    return {url:url.href,uid:uids[0]};
  }catch{return null;}
}

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

function assertNativeSendAllowed({canSend=()=>true,replySchedule=null,sourcePlatformTimeMs=null,now=Date.now}){
  if(canSend()!==true)throw new Error('outside_reply_hours');
  assertReplySourceWindow(replySchedule,sourcePlatformTimeMs,now());
}

async function clickPreparedCardElement({ page, scope, cardConfig = DEFAULT_CARD, assertActive = async () => {}, canSend = () => true,replySchedule=null,sourcePlatformTimeMs=null,now=Date.now }) {
  const root = activeConversationRootLocator(page, scope);
  if (await root.count() !== 1) throw new Error('exact_active_conversation_root_required');
  const title = root.locator('.chat-tool-wrap .card-box__content-title[title="' + cardConfig.title + '"]').filter({ visible: true });
  if (await title.count() !== 1) throw new Error('exact_native_wecom_card_required');
  const cardElement = title.locator('..').locator('..');
  if (await cardElement.count() !== 1) throw new Error('exact_native_wecom_card_required');
  await cardElement.hover({ timeout: 1000 });
  const button = cardElement.getByRole('button', { name: '发送', exact: true });
  if (await button.count() !== 1 || !(await button.isEnabled())) throw new Error('unique_enabled_card_send_required');
  assertNativeSendAllowed({canSend,replySchedule,sourcePlatformTimeMs,now});
  await button.click({ timeout: 1000 }); await assertActive(scope);
}

export async function clickPreparedWeComCard({ page, scope, cardConfig = DEFAULT_CARD, assertActive = async () => {}, canSend = () => true,replySchedule=null,sourcePlatformTimeMs=null,now=Date.now }) {
  await assertActive(scope);
  return clickPreparedCardElement({page,scope,cardConfig,assertActive,canSend,replySchedule,sourcePlatformTimeMs,now});
}

export async function sendConfiguredWeComCard({ page, scope, cardConfig = DEFAULT_CARD, assertActive = async () => {}, canSend = () => true,replySchedule=null,sourcePlatformTimeMs=null,now=Date.now }) {
  await assertActive(scope);
  const root = activeConversationRootLocator(page, scope);
  if (await root.count() !== 1) throw new Error('exact_active_conversation_root_required');
  assertNativeSendAllowed({canSend,replySchedule,sourcePlatformTimeMs,now});
  await prepareWeComCardPanel(root, cardConfig); await assertActive(scope);
  return clickPreparedCardElement({page,scope,cardConfig,assertActive,canSend,replySchedule,sourcePlatformTimeMs,now});
}

export async function clickConfiguredTextSend({ page, scope, assertActive = async () => {}, canSend = () => true,replySchedule=null,sourcePlatformTimeMs=null,now=Date.now }) {
  await assertActive(scope);const root=activeConversationRootLocator(page,scope);
  if(await root.count()!==1)throw new Error('exact_active_conversation_root_required');
  const button=root.locator('.reply-bottom-bar button').filter({visible:true});
  if(await button.count()!==1||!(await button.isEnabled()))throw new Error('unique_enabled_send_control_required');
  assertNativeSendAllowed({canSend,replySchedule,sourcePlatformTimeMs,now});
  await button.click({timeout:1000});await assertActive(scope);
}

export function createNativeReceiptReader({accountId,card=DEFAULT_CARD,nativeRecords,request=null,isActive=()=>true,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const inFlight=new Map(),groups=new Map();let nextRequestId=0;
  const pending=reason=>({serverStatus:'pending',observedAtMs:now(),...(reason?{reason}:{})});
  const validIntent=intent=>intent?.accountId===accountId&&/^[a-f0-9]{24}$/.test(intent?.conversationId||'')&&['text','contact_fallback','card'].includes(intent?.kind);
  const validEnvelope=body=>body?.success===true&&body?.code===0&&Array.isArray(body?.data?.messages);
  async function withinBudget(operation,deadlineMs){
    let timer;
    try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('native_history_budget_expired')),Math.max(1,deadlineMs-now()));})]);}
    finally{clearTimeout(timer);}
  }
  async function waitForSharedRead(operation,deadlineMs){
    if(now()>=deadlineMs)return {status:'pending',reason:'native_history_wait_budget_expired'};
    try{const result=await withinBudget(operation,deadlineMs);return now()>=deadlineMs?{status:'pending',reason:'native_history_wait_budget_expired'}:result;}
    catch{return {status:'pending',reason:'native_history_wait_budget_expired'};}
  }

  function peekReceipt(intent,{startedAtMs=0}={}){
    if(!isActive())return pending('native_transport_closed');
    if(!validIntent(intent)||!Number.isFinite(startedAtMs)||startedAtMs<=0||startedAtMs>now())return pending('native_receipt_scope_invalid');
    const matches=new Map(),signatures=new Map(),conflicting=new Set();
    const expectedId=intent.payload?.nativeId||intent.payload?.receipt?.nativeId||null;
    for(const record of nativeRecords){
      if(record.status!==200||record.responseOk!==true||!validEnvelope(record.body)||record.queryUserIds?.length!==1||record.queryUserIds[0]!==intent.conversationId||
          !Number.isFinite(record.requestStartedAtMs)||record.requestStartedAtMs<startedAtMs||!Number.isFinite(record.receivedAtMs)||record.receivedAtMs<record.requestStartedAtMs||record.receivedAtMs>now())continue;
      if(record.source!=='native_history_get'&&!nativeHistoryRequestScope(record.request,intent.conversationId))continue;
      for(const row of record.body.data.messages){
        if(!row||typeof row!=='object'||!row.sixin_message||typeof row.sixin_message!=='object')continue;
        const message=row.sixin_message,nativeId='id_'+String(message.id),platformTimeMs=Number(message.created_at);
        if(!nativeMessageBelongsToIntent(message.id,intent))continue;
        if(expectedId&&nativeId!==expectedId)continue;
        const type=message.message_type||message.type;let identity=String(message.content||'').trim();
        if(type==='CARD'){try{const value=JSON.parse(identity);identity=[value?.contentType,value?.id,value?.csaAccountNo,value?.name,value?.corpName];}catch{identity=['invalid_card'];}}
        const signature=JSON.stringify([message.sender_id,message.receiver_id,row.message_extension?.customer_user_id,message.direction??null,type,platformTimeMs,identity]);
        if(signatures.has(nativeId)&&signatures.get(nativeId)!==signature)conflicting.add(nativeId);else signatures.set(nativeId,signature);
        if(!nativeMessageMatchesOutboundIntent(row,intent,startedAtMs,card)||platformTimeMs>record.receivedAtMs+1000)continue;
        const previous=matches.get(nativeId);
        if(!previous||record.receivedAtMs<previous.observedAtMs)matches.set(nativeId,{observedAtMs:record.receivedAtMs,message});
      }
    }
    const hasConflict=Array.from(matches.keys()).some(id=>conflicting.has(id));
    if(matches.size!==1||hasConflict)return pending(matches.size>1||hasConflict?'native_receipt_ambiguous':undefined);
    const [nativeId,match]=matches.entries().next().value,message=match.message;
    return {serverStatus:'confirmed',accountId:intent.accountId,conversationId:intent.conversationId,
      ...(intent.kind==='card'?{type:'CARD',cardTitle:card.title}:{type:'TEXT',content:intent.content}),
      platformTimeMs:Number(message.created_at),observedAtMs:match.observedAtMs,visibleAtMs:null,
      senderId:String(message.sender_id),receiverId:String(message.receiver_id),direction:'OUTBOUND',nativeId};
  }

  function observedTemplate(uid){
    for(let i=nativeRecords.length-1;i>=0;i--){
      const record=nativeRecords[i];if(record.status!==200||record.responseOk!==true||!validEnvelope(record.body)||record.queryUserIds?.length!==1||record.queryUserIds[0]!==uid||!record.request)continue;
      const scope=nativeHistoryRequestScope(record.request,uid);if(scope)return {url:scope.url,request:record.request};
    }
    return null;
  }

  function groupKey(intent, startedAtMs, receiptGroupId) {
    return JSON.stringify([accountId, intent.conversationId, receiptGroupId || intent.intentId || `${intent.kind}:${startedAtMs}`]);
  }

  function groupFor(intent,{startedAtMs,timeoutMs,receiptGroupId,receiptBudgetDeadlineMs}){
    if(!validIntent(intent)||!Number.isFinite(startedAtMs)||startedAtMs<=0||startedAtMs>now())return null;
    const key=groupKey(intent,startedAtMs,receiptGroupId);
    let group=groups.get(key);
    if(!group){
      for(const [other,item]of groups)if(item.deadlineMs<now())groups.delete(other);
      const requestedDeadline=Number.isFinite(receiptBudgetDeadlineMs)?receiptBudgetDeadlineMs:now()+Math.min(2000,Math.max(0,timeoutMs));
      const createdAtMs=now(),deadlineMs=Math.min(requestedDeadline,createdAtMs+2000);
      group={deadlineMs,secondReadAtMs:createdAtMs+Math.min(1400,Math.floor(Math.max(0,deadlineMs-createdAtMs)*0.7)),requests:new Map()};groups.set(key,group);
    }
    return group;
  }

  async function readNativeHistory(intent,{startedAtMs=0,timeoutMs=2000,receiptGroupId=null,receiptBudgetDeadlineMs=null}={}){
    const waiterDeadlineMs=now()+Math.max(0,timeoutMs);
    const group=groupFor(intent,{startedAtMs,timeoutMs,receiptGroupId,receiptBudgetDeadlineMs});
    if(!isActive())return {status:'pending',reason:'native_transport_closed'};
    if(!group||!request?.get)return {status:'pending',reason:'native_history_unavailable'};
    const deadlineMs=Math.min(group.deadlineMs,waiterDeadlineMs);
    if(now()>=deadlineMs)return {status:'pending',reason:'native_history_budget_expired'};
    const uid=intent.conversationId,existing=inFlight.get(uid);
    if(existing){
      if(existing.requestStartedAtMs===null||existing.requestStartedAtMs>=startedAtMs){
        if(!group.requests.has(existing.id)&&group.requests.size>=2)return {status:'pending',reason:'native_history_attempt_limit'};
        group.requests.set(existing.id,existing);existing.requiredStartedAtMs=Math.max(existing.requiredStartedAtMs,startedAtMs);
        return waitForSharedRead(existing.promise,deadlineMs);
      }
      const previous=await waitForSharedRead(existing.promise,deadlineMs);
      if(previous.reason==='native_history_wait_budget_expired'||now()>=deadlineMs)return {status:'pending',reason:'native_history_wait_budget_expired'};
      return readNativeHistory(intent,{startedAtMs,timeoutMs:Math.max(0,deadlineMs-now()),receiptGroupId,receiptBudgetDeadlineMs:deadlineMs});
    }
    if(group.requests.size>=2)return {status:'pending',reason:'native_history_attempt_limit'};
    if(group.requests.size>0&&now()<group.secondReadAtMs)return {status:'pending',reason:'native_history_backoff',retryAfterMs:group.secondReadAtMs-now()};
    const template=observedTemplate(uid);if(!template)return {status:'pending',reason:'native_history_template_unavailable'};
    const flight={id:++nextRequestId,requestStartedAtMs:null,requiredStartedAtMs:startedAtMs,promise:null,reservedAtMs:now(),finishedAtMs:null,httpStatus:null,result:null};
    group.requests.set(flight.id,flight);inFlight.set(uid,flight);
    flight.promise=(async()=>{
      let response, stage='headers';
      function finish(result, outcome=result) {
        flight.result=result;
        return outcome;
      }
      try{
        const observedHeaders=await withinBudget(template.request.allHeaders(),deadlineMs),headers={};
        for(const [name,value]of Object.entries(observedHeaders||{}))if(!name.startsWith(':')&&!['host','cookie','content-length','connection','accept-encoding'].includes(name.toLowerCase()))headers[name]=value;
        const remaining=Math.floor(deadlineMs-now());
        if(!isActive()||remaining<=0||now()<flight.requiredStartedAtMs)return finish('budget_expired',{status:'pending',reason:'native_history_budget_expired'});
        flight.requestStartedAtMs=now();
        stage='request';
        response=await request.get(template.url,{headers,timeout:Math.max(1,remaining),maxRedirects:0,failOnStatusCode:false});
        const httpStatus=response.status();
        flight.httpStatus=Number.isInteger(httpStatus)?httpStatus:null;
        if(httpStatus!==200)return finish('http_status',{status:'pending',reason:'native_history_http_status',httpStatus});
        stage='body';
        const body=await withinBudget(response.json(),deadlineMs),observedAtMs=now();
        if(!isActive())return finish('transport_closed',{status:'pending',reason:'native_transport_closed'});
        const responseOk=validEnvelope(body);
        nativeRecords.push({status:httpStatus,body,queryUserIds:[uid],responseOk,requestStartedAtMs:flight.requestStartedAtMs,receivedAtMs:observedAtMs,source:'native_history_get'});
        if(nativeRecords.length>100)nativeRecords.splice(0,nativeRecords.length-100);
        return finish(responseOk?'read':'invalid_envelope',{status:responseOk?'read':'pending',...(responseOk?{}:{reason:'native_history_envelope_invalid'}),requestStartedAtMs:flight.requestStartedAtMs,observedAtMs,httpStatus});
      }catch{
        const expired=now()>=deadlineMs;
        return finish(stage+(expired?'_timeout':'_failed'),{status:'pending',reason:expired?'native_history_budget_expired':'native_history_read_failed'});
      }
      finally{
        flight.finishedAtMs=now();
        if(inFlight.get(uid)===flight)inFlight.delete(uid);
        try{response?.dispose?.()?.catch?.(()=>{});}catch{}
      }
    })();
    return waitForSharedRead(flight.promise,deadlineMs);
  }

  async function waitForReceipt(intent,{startedAtMs=0,timeoutMs=2000,receiptGroupId=null,receiptBudgetDeadlineMs=null}={}){
    const deadline=now()+Math.max(0,timeoutMs);let lastReason, match='not_observed';
    function withDiagnostics(receipt) {
      if (!validIntent(intent)) return receipt;
      const group=groups.get(groupKey(intent,startedAtMs,receiptGroupId));
      const attempts=Array.from(group?.requests.values()??[],flight=>({
        reservedAtMs:flight.reservedAtMs,requestStartedAtMs:flight.requestStartedAtMs,
        finishedAtMs:flight.finishedAtMs,httpStatus:flight.httpStatus,result:flight.result??'in_flight',
      }));
      if (receipt.serverStatus === 'confirmed') match='strict_match';
      return {...receipt,historyDiagnostics:{attempts,match}};
    }
    while(isActive()){
      const cached=peekReceipt(intent,{startedAtMs});if(cached.serverStatus==='confirmed')return withDiagnostics(cached);
      match=cached.reason==='native_receipt_ambiguous'?'ambiguous':'not_observed';
      if(now()>=deadline)return withDiagnostics(pending(lastReason||cached.reason));
      const result=await readNativeHistory(intent,{startedAtMs,timeoutMs:Math.min(2000,Math.max(0,deadline-now())),receiptGroupId,receiptBudgetDeadlineMs});
      lastReason=result.reason;
      if(now()>=deadline)return withDiagnostics(pending('native_history_wait_budget_expired'));
      const fresh=peekReceipt(intent,{startedAtMs});if(fresh.serverStatus==='confirmed')return withDiagnostics(fresh);
      match=fresh.reason==='native_receipt_ambiguous'?'ambiguous':'not_observed';
      const remaining=deadline-now();if(remaining<=0)return withDiagnostics(pending(lastReason||fresh.reason));
      await sleep(Math.min(25,remaining,Number.isFinite(result.retryAfterMs)?Math.max(0,result.retryAfterMs):25));
    }
    return withDiagnostics(pending('native_transport_closed'));
  }
  return {peekReceipt,readNativeHistory,waitForReceipt};
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

export function browserLaunchOptions({ chromium, headless, visible = false, env = process.env }) {
  const executablePath=String(env.XHS_BROWSER_EXECUTABLE||'').trim() || (typeof chromium?.executablePath==='function'?chromium.executablePath():null);
  return { headless, ...(executablePath?{executablePath}:{}), ...((headless||visible)?{}:{args:['--window-position=-10000,-10000']}) };
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

export async function openInteractiveLogin({ profileDir, accountName, visible = false, signal = null, timeoutMs = 15 * 60_000 }) {
  const chromium = await loadChromium();
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(profileDir, 0o700);
  const context = await chromium.launchPersistentContext(profileDir, browserLaunchOptions({chromium,headless:false,visible}));
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto('https://sxt.xiaohongshu.com/im/multiCustomerService', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('interactive_login_cancelled');
      const title = await page.title();
      if (acceptsAccountTitle(title, accountName)) return { accountTitle: title };
      await page.waitForTimeout(500);
    }
    throw new Error('interactive_login_timeout');
  } finally {
    await context.close();
  }
}

export async function openBrowser({ profileDir, headless = true, accountId, accountName, card: cardConfig = DEFAULT_CARD, replySchedule = null }) {
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
    if (nativeHistoryRequestScope(request)) requestStarts.set(request, Date.now());
  });
  page.on('response', async response => {
    try {
      const request = response.request();
      const scope=nativeHistoryRequestScope(request);if(!scope||response.status()!==200)return;
      const body = await response.json();
      const queryUserIds=[scope.uid];
      const responseOk=body?.success===true&&body?.code===0&&Array.isArray(body?.data?.messages);
      nativeRecords.push({ request, status: response.status(), body, queryUserIds, responseOk, requestStartedAtMs: requestStarts.get(request) || 0, receivedAtMs: Date.now() });
      if (nativeRecords.length > 100) nativeRecords.splice(0, nativeRecords.length - 100);
    } catch {}
  });
  await waitForInbox(page, accountName);

  const receiptReader=createNativeReceiptReader({accountId,card:cardConfig,nativeRecords,request:context.request,isActive:()=>!transport.crashed&&!transport.closed&&!page.isClosed()});

  let pendingText = null;
  const canSend=()=>!replySchedule||replySchedule.isAllowed()===true;
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
    async clickTakeover(scope,sourcePlatformTimeMs) { assertNativeSendAllowed({canSend,replySchedule,sourcePlatformTimeMs});await page.evaluate(({ conversationId }) => {
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
    async fillText(scope, text,sourcePlatformTimeMs) { await assertActive(scope); const root = activeConversationRootLocator(page, scope);
      if (await root.count() !== 1) throw new Error('exact_active_conversation_root_required');
      const input = root.locator('.reply-box-wrap textarea.reply-textarea').filter({ visible: true });
      if (await input.count() !== 1) throw new Error('unique_message_input_required');
      if (await input.inputValue() !== '') throw new Error('existing_operator_draft_preserved');
      assertNativeSendAllowed({canSend,replySchedule,sourcePlatformTimeMs});
      await input.fill(text, { timeout: 1000 }); pendingText = text; await assertActive(scope); },
    async clickTextSend(scope,sourcePlatformTimeMs) { return clickConfiguredTextSend({page,scope,assertActive,canSend,replySchedule,sourcePlatformTimeMs}); },
    async prepareCard(scope,sourcePlatformTimeMs) { await assertActive(scope); const root=activeConversationRootLocator(page,scope); if(await root.count()!==1)throw new Error('exact_active_conversation_root_required'); assertNativeSendAllowed({canSend,replySchedule,sourcePlatformTimeMs});await prepareWeComCardPanel(root,cardConfig); await assertActive(scope); },
    async clickPreparedCard(scope,sourcePlatformTimeMs) { return clickPreparedWeComCard({page,scope,cardConfig,assertActive,canSend,replySchedule,sourcePlatformTimeMs}); },
    async sendCard(scope,sourcePlatformTimeMs) { return sendConfiguredWeComCard({ page, scope, cardConfig, assertActive, canSend,replySchedule,sourcePlatformTimeMs }); },
    peekReceipt:receiptReader.peekReceipt,
    readNativeHistory:receiptReader.readNativeHistory,
    waitForReceipt:receiptReader.waitForReceipt,
    async close() { await context.close(); },
  };
  return browser;
}
