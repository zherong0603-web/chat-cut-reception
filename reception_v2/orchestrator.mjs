import { DEFAULT_CARD } from './account-config.mjs';
import { ConversationState } from './domain.mjs';

function activeInboundMessages(scope) {
  return (scope.messages || []).filter(message => message.isCustomerText === true || message.isEntryHint === true)
    .sort((a, b) => a.platformTimeMs - b.platformTimeMs);
}

function cardPayload(card) {
  return card && typeof card === 'object' ? card : { details: String(card || '') };
}

function contactDisplay(item) {
  if (item.kind === 'phone') return `手机号 ${item.value}`;
  if (item.kind === 'wechat') return `微信号 ${item.value}`;
  if (item.kind === 'wechat_candidate') return `疑似微信号 ${item.value}`;
  if (item.kind === 'wecom_added') return '已添加企微';
  if (item.kind === 'lead_submitted') return '已提交留资卡';
  return `联系方式 ${item.value}`;
}

export function parseSidebarTimeToday(value, nowMs=Date.now()) {
  const match=/^(\d{2}):(\d{2}):(\d{2})$/.exec(String(value||'').trim());
  if(!match)return null;
  const hour=Number(match[1]),minute=Number(match[2]),second=Number(match[3]);
  if(hour>23||minute>59||second>59)return null;
  const now=new Date(nowMs),candidate=new Date(nowMs);
  candidate.setHours(hour,minute,second,0);
  if(candidate.getTime()>nowMs+60_000)candidate.setDate(candidate.getDate()-1);
  return candidate.getTime();
}

export function isTodaySidebarTime(value, nowMs=Date.now()) {
  const parsed=parseSidebarTimeToday(value,nowMs);if(parsed===null)return false;
  const parsedDate=new Date(parsed),nowDate=new Date(nowMs);
  return parsedDate.getFullYear()===nowDate.getFullYear()&&parsedDate.getMonth()===nowDate.getMonth()&&parsedDate.getDate()===nowDate.getDate();
}

export function isRecentSidebarTime(value, nowMs=Date.now(), { lookbackDays = 1 } = {}) {
  const text=String(value||'').trim(), now=new Date(nowMs);
  let candidate=null;
  const clockMatch=/^(\d{2}):(\d{2}):(\d{2})$/.exec(text);
  const dateMatch=/^(\d{1,2})\/(\d{1,2})$/.exec(text);
  if(clockMatch)candidate=new Date(parseSidebarTimeToday(text,nowMs));
  else if(dateMatch){
    const month=Number(dateMatch[1]),day=Number(dateMatch[2]);if(month<1||month>12||day<1||day>31)return false;
    candidate=new Date(nowMs);candidate.setFullYear(now.getFullYear(),month-1,day);candidate.setHours(0,0,0,0);
    if(candidate.getMonth()!==month-1||candidate.getDate()!==day)return false;
    if(candidate.getTime()>now.getTime()+86_400_000)candidate.setFullYear(now.getFullYear()-1);
  }
  if(!candidate||Number.isNaN(candidate.getTime()))return false;
  const candidateDay=new Date(candidate),nowDay=new Date(now);candidateDay.setHours(0,0,0,0);nowDay.setHours(0,0,0,0);
  const ageDays=Math.round((nowDay.getTime()-candidateDay.getTime())/86_400_000);
  return ageDays>=0&&ageDays<=Math.max(0,lookbackDays);
}

export function createOrchestrator(deps) {
  const card = deps.card || DEFAULT_CARD;
  const required = ['store','sender','composeReply','facts','readSidebar','selectConversation','readContacts','revealMaskedContacts','notifier','now','accountId'];
  for (const key of required) if (!deps[key]) throw new TypeError('missing_dependency_' + key);
  const state = { baselineReady: false, seen: new Map(), replyCheckAt: new Map(), takeoverRetryAt: new Map(), contactFailureUntil: new Map(), processing: false, contactCursor: 0, nextContactScanAt: 0 };
  const fingerprint=row=>JSON.stringify([row.time??null,row.preview??'',row.statusTags||[],row.statusText||'']);
  const contactReady=row=>clock()>=(state.contactFailureUntil.get(row.uid)||0);
  const deferContact=row=>state.contactFailureUntil.set(row.uid,clock()+300_000);
  const clock=deps.now;
  const sleep=deps.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const stopping=()=>deps.isStopping?.()===true;
  const isTransientTakeoverError=error=>/native_takeover_control_required|exact_visible_customer_row_required|target_message_dom_not_hydrated|selected_scope_mismatch|scope_not_ready|page_not_visible/.test(String(error?.message||error));
  const enqueue=async input=>stopping()?null:deps.notifier.enqueue(input);
  const notifyBlocked=async input=>stopping()?null:deps.notifier.notifyBlocked(input);

  async function processRow(row, { contactOnly = false } = {}) {
    if (!row || typeof row.uid !== 'string') throw new TypeError('sidebar_row_required');
    if (state.processing) throw new Error('orchestrator_busy');
    state.processing = true;
    try {
      const cardClickedToday=/对方已点击你的企业微信联系卡/.test(String(row.preview||''))&&isTodaySidebarTime(row.time,clock());
      if (contactOnly && !cardClickedToday && deps.store.getConversation(deps.accountId, row.uid)?.state === ConversationState.CONTACT_OBTAINED) {
        return { state: ConversationState.CONTACT_OBTAINED, skipped: 'contact_already_handed_off' };
      }
      let scope = await deps.selectConversation(row.uid);
      if (!scope || scope.conversationId !== row.uid) throw new Error('selected_scope_mismatch');
      if (!contactOnly||cardClickedToday) await deps.sender.enterHumanMode(scope);

      let cardClickAck=null;
      if(cardClickedToday){
        const clickTime=parseSidebarTimeToday(row.time,clock())??clock();
        const eventId=`sidebar-card-click:${scope.accountId}:${scope.conversationId}:${row.time||''}:${String(row.preview||'').replace(/\s+/g,'_').slice(0,40)}`;
        const clickTurn=deps.store.ingestInbound({accountId:scope.accountId,conversationId:scope.conversationId,eventId,text:'',type:'CARD_CLICK',platformTimeMs:clickTime,nickname:scope.nickname,evidence:{source:'platform_ui',preview:row.preview}});
        const content='看到您点击企微卡了，客服小姐姐会在企微里回复您，请留意消息～';
        try{
          const intent=deps.store.createIntent({turnId:clickTurn.turnId,kind:'text',content});
          cardClickAck=await deps.sender.sendText(intent.intentId,scope,clickTurn.openedAtMs);
        }catch(error){if(error?.message!=='duplicate_outbound_content')throw error;cardClickAck={state:'already_acknowledged'};}
      }

      const observeContacts = async (scoped) => {
        const leadFallback = row.leadSignal === true
          ? { accountId: scoped.accountId, conversationId: scoped.conversationId, kind: 'lead_submitted', value: '已提交留资卡', source: 'sidebar', verified: true }
          : null;
        const contacts = [];
        let observed = [];
        try { observed = await deps.revealMaskedContacts(scoped); }
        catch (error) {
          if (!leadFallback) {
            await enqueue({ kind: 'needs_operator', accountId: scoped.accountId, conversationId: scoped.conversationId,
              customer: scoped.nickname || row.uid, need: row.preview || '当前客户', contact: '联系方式读取失败', completed: '资料区号码未能完整读取', next: '请人工查看客户资料' });
            return { handled: { state: ConversationState.NEEDS_HUMAN, reason: error.message } };
          }
        }
        if (!observed.length && !leadFallback) observed = await deps.readContacts(scoped);
        contacts.push(...observed);
        if (leadFallback && !contacts.some(contact => ['phone', 'wechat', 'wecom_added'].includes(contact.kind))) contacts.push(leadFallback);
        if (!contacts.length) return { contacts };
        for (const contact of contacts) deps.store.upsertContact(contact);
        const verified=contacts.filter(contact=>contact.verified!==false), candidates=contacts.filter(contact=>contact.verified===false);
        if(candidates.length){
          const customerText=activeInboundMessages(scoped).at(-1)?.text || row.preview || '';
          await enqueue({kind:'needs_operator',accountId:scoped.accountId,conversationId:scoped.conversationId,
            customer:scoped.nickname||row.uid,need:customerText||'当前客户',contact:candidates.map(contactDisplay).join('；'),
            completed:'发现疑似联系方式，尚未确认',next:'请核对后联系客户；自动接待继续',details:{candidates,customerText}});
        }
        if(!verified.length)return {contacts,candidates};
        deps.store.setConversationState(scoped.accountId, scoped.conversationId, ConversationState.CONTACT_OBTAINED);
        const customerText=activeInboundMessages(scoped).at(-1)?.text || row.preview || '';
        await enqueue({ kind: 'ready_to_follow', accountId: scoped.accountId, conversationId: scoped.conversationId,
          customer: scoped.nickname || row.uid, need: customerText || '已进线客户',
          contact: verified.map(contactDisplay).join('；'),
          completed: '已读取当前客户资料', next: '请销售马上联系客户', details: { contacts: verified, candidates, customerText } });
        return { handled: { state: ConversationState.CONTACT_OBTAINED, contacts: verified } };
      };
      const firstContacts=await observeContacts(scope);if(firstContacts.handled)return {...firstContacts.handled,cardClickAck};
      if(contactOnly)return { state: 'no_contact' };

      const inbound = activeInboundMessages(scope);
      let turn = null;
      const ingestVisible=()=>{for (const message of activeInboundMessages(scope)) turn = deps.store.ingestInbound({ accountId: scope.accountId, conversationId: scope.conversationId,
        eventId: message.nativeId, text: message.isEntryHint ? '' : message.text, type: message.isEntryHint ? 'NEW_VISITOR' : 'CUSTOMER_MESSAGE', platformTimeMs: message.platformTimeMs, nickname: scope.nickname });};
      ingestVisible();
      if (!turn && row.needsReply === true) {
        const anchor=`sidebar-overdue:${scope.accountId}:${scope.conversationId}:${row.time||''}:${row.preview||''}`;
        const overduePlatformTimeMs=parseSidebarTimeToday(row.time,clock());
        turn=deps.store.ingestInbound({accountId:scope.accountId,conversationId:scope.conversationId,eventId:anchor,text:'',
          type:'SIDEBAR_OVERDUE',platformTimeMs:overduePlatformTimeMs??0,nickname:scope.nickname,evidence:{source:'platform_ui',overdue_status:row.statusTags,
            platform_time_source:overduePlatformTimeMs===null?'unknown':'sidebar_time',platform_time_text:row.time||null}});
      }
      if (!turn) return { state: 'no_customer_message' };
      while (turn && turn.quietUntilMs > clock()) {
        await sleep(turn.quietUntilMs - clock());
        scope = await deps.selectConversation(row.uid);
        if (!scope || scope.conversationId !== row.uid) throw new Error('selected_scope_mismatch');
        ingestVisible();
      }
      const laterContacts=await observeContacts(scope);if(laterContacts.handled)return laterContacts.handled;
      if (!turn) return { state: 'no_turn' };
      if (turn.state !== ConversationState.CHATTING && turn.attemptCount > 0) return { state: turn.state, skipped: true };
      if (turn.attemptCount >= 3) return { state: turn.state, reason: 'turn_attempt_limit_reached' };

      const nativeOutboundTexts=(scope.messages||[]).filter(message=>message.direction==='right'&&message.type==='TEXT'&&typeof message.text==='string')
        .map(message=>message.text).filter(Boolean);
      const nativeCardAlreadySent=(scope.messages||[]).some(message=>message.direction==='right'&&message.type==='CARD'&&String(message.text||'').includes(card.title));
      const priorTexts=[...new Set([...deps.store.listConversationOutboundTexts(scope.accountId,scope.conversationId),...nativeOutboundTexts])];
      const reply = deps.composeReply({ customerText: turn.inboundTexts.join('\n'), facts: deps.facts, conversationId: scope.conversationId, history: inbound, avoidTexts: priorTexts });
      if (reply.nextState === ConversationState.STOPPED || !reply.text) {
        deps.store.setConversationState(scope.accountId, scope.conversationId, ConversationState.STOPPED);
        deps.store.setTurnState(turn.turnId, ConversationState.STOPPED);
        return { state: ConversationState.STOPPED, needsHuman: reply.needsHuman };
      }

      let textIntent;
      try { textIntent = deps.store.createIntent({ turnId: turn.turnId, kind: 'text', content: reply.text }); }
      catch (error) {
        if (error?.message !== 'duplicate_outbound_content') throw error;
        deps.store.setConversationState(scope.accountId, scope.conversationId, ConversationState.NEEDS_HUMAN);
        deps.store.setTurnState(turn.turnId, ConversationState.NEEDS_HUMAN);
        await enqueue({ kind: 'needs_operator', accountId: scope.accountId, conversationId: scope.conversationId,
          customer: scope.nickname || row.uid, need: turn.inboundTexts.at(-1) || row.preview || '新消息', contact: '暂未取得',
          completed: '为避免重复回复，本次没有再次发送', next: '请人工回复客户的新问题' });
        return { state: ConversationState.NEEDS_HUMAN, reason: 'duplicate_generated_reply_prevented', turn, reply };
      }
      let textResult, cardIntent = null, cardResult = null, bothWithinTwoSeconds = null, bothWithinThreeSeconds = null;
      if (reply.offerCard && !nativeCardAlreadySent) {
        try {
          cardIntent = deps.store.createIntent({ turnId: turn.turnId, kind: 'card', payload: { cardTitle: card.title } });
        } catch (error) {
          if (error?.message !== 'duplicate_outbound_content') throw error;
        }
        if (cardIntent) {
          const pair = await deps.sender.sendTextAndCard(textIntent.intentId, cardIntent.intentId, scope, turn.openedAtMs);
          textResult = pair.text || { state: pair.state };
          cardResult = pair.card || { state: pair.state };
          bothWithinTwoSeconds = pair.withinTwoSeconds; bothWithinThreeSeconds = pair.withinThreeSeconds;
        } else {
          textResult = await deps.sender.sendText(textIntent.intentId, scope, turn.openedAtMs);
          cardResult = { state: 'already_sent_or_blocked', duplicate: true };
        }
      } else if(nativeCardAlreadySent){
        textResult=await deps.sender.sendText(textIntent.intentId,scope,turn.openedAtMs);
        cardResult={state:'already_present_native_history',duplicate:true};
      } else {
        textResult = await deps.sender.sendText(textIntent.intentId, scope, turn.openedAtMs);
      }

      const retryPhrases=['可以的，您直接加我企微，客服小姐姐会具体回答您～','没问题，直接加我企微就行，客服小姐姐会详细回答您～'];
      for(let retryAttempt=1;retryAttempt<=2;retryAttempt++){
        if(textResult.state!=='uncertain'&&cardResult?.state!=='uncertain')break;
        if(textResult.state==='uncertain'){
          const prior=new Set(deps.store.listConversationOutboundTexts(scope.accountId,scope.conversationId));
          const content=retryPhrases.find(value=>!prior.has(value))||`${reply.text} 这边直接帮您对接～`;
          const retryIntent=deps.store.createIntent({turnId:turn.turnId,kind:'text',content,maxAttempts:6});
          textResult=await deps.sender.sendText(retryIntent.intentId,scope,turn.openedAtMs);
        }
        if(cardResult?.state==='uncertain'&&cardIntent){
          const retryCard=deps.store.createIntent({turnId:turn.turnId,kind:'card',payload:{cardTitle:card.title,retryOf:cardIntent.intentId,retryAttempt},maxAttempts:6});
          cardResult=await deps.sender.sendWeComCard(retryCard.intentId,scope,turn.openedAtMs);
        }
      }
      bothWithinTwoSeconds=cardResult&&!cardResult.duplicate?textResult.withinTwoSeconds===true&&cardResult.withinTwoSeconds===true:null;
      bothWithinThreeSeconds=cardResult&&!cardResult.duplicate?textResult.withinThreeSeconds===true&&cardResult.withinThreeSeconds===true:null;
      if (textResult.state === 'send_blocked' || cardResult?.state === 'send_blocked') {
        deps.store.setConversationState(scope.accountId, scope.conversationId, ConversationState.SEND_BLOCKED);
        deps.store.setTurnState(turn.turnId, ConversationState.SEND_BLOCKED);
        await notifyBlocked({ kind: 'send_failed', accountId: scope.accountId, conversationId: scope.conversationId,
          customer: scope.nickname || row.uid, need: (turn.inboundTexts.at(-1)||'新客户进线'), completed: '平台限制发送', next: '请人工回复客户' });
        return { state: ConversationState.SEND_BLOCKED, text: textResult, card: cardResult };
      }

      let fallbackResult = null;

      const sendUncertain = textResult.state === 'uncertain' || cardResult?.state === 'uncertain';

      const timingFailed = (textResult.state === 'sent' && textResult.withinThreeSeconds === false) || (cardResult?.state === 'sent' && cardResult.withinThreeSeconds === false);
      const nextState = reply.needsHuman || sendUncertain || timingFailed ? ConversationState.NEEDS_HUMAN : ConversationState.WAITING_CONTACT;
      deps.store.setConversationState(scope.accountId, scope.conversationId, nextState);
      deps.store.setTurnState(turn.turnId, nextState);
      if (timingFailed && !sendUncertain) {
        await enqueue({ kind: 'needs_operator', accountId: scope.accountId, conversationId: scope.conversationId,
          customer: scope.nickname || row.uid, need: (turn.inboundTexts.at(-1)||'新客户进线'), contact: '暂未取得',
          completed: '文字和企微卡已发出，但未在3秒内完成平台落库', next: '请检查客户是否已经看到', details: { customerText: (turn.inboundTexts.at(-1)||'新客户进线'), text: textResult, card: cardResult } });
      } else if (sendUncertain) {
        await notifyBlocked({ kind: 'send_failed', accountId: scope.accountId, conversationId: scope.conversationId,
          customer: scope.nickname || row.uid, need: (turn.inboundTexts.at(-1)||'新客户进线'), contact: '暂未取得',
          completed: '消息可能已经发出，请不要手动重发', next: '请检查原对话或等待客户回复', details: { text: textResult, card: cardResult, fallback: fallbackResult, customerText: (turn.inboundTexts.at(-1)||'新客户进线') } });
      } else if (reply.needsHuman) {
        await enqueue({ kind: 'needs_operator', accountId: scope.accountId, conversationId: scope.conversationId,
          customer: scope.nickname || row.uid, need: (turn.inboundTexts.at(-1)||'新客户进线'), contact: '暂未取得',
          completed: '已人工接管并回复，业务资料不足', next: '请人工确认客户问题', details: { reply: reply.text, customerText: (turn.inboundTexts.at(-1)||'新客户进线') } });
      }
      return { state: nextState, turn, reply, text: textResult, card: cardResult, fallback: fallbackResult, bothWithinTwoSeconds, bothWithinThreeSeconds };
    } finally { state.processing = false; }
  }

  async function takeoverRows(sourceRows, { maxRows = Infinity, requireMarked = true } = {}) {
    const marked = requireMarked ? (sourceRows || []).filter(row => row.platformAiActive === true || (row.statusTags || []).includes('接待中')) : (sourceRows || []);
    const rows = marked.filter(row => isRecentSidebarTime(row.time, clock())).slice(0, Math.max(0, maxRows));
    const results = [], failed = [];
    for (const row of rows) {
      let lastError=null, succeeded=false;
      for(let attempt=1;attempt<=3;attempt++){
        try {
          const scope = await deps.selectConversation(row.uid);
          if (!scope || scope.conversationId !== row.uid) throw new Error('selected_scope_mismatch');
          const mode = await deps.sender.enterHumanMode(scope);
          results.push({ uid: row.uid, state: ConversationState.NEEDS_HUMAN, human_takeover_clicked: mode.clicked === true, attempts: attempt });
          state.takeoverRetryAt.delete(row.uid);succeeded=true;break;
        } catch (error) {
          lastError=error;
          if(attempt<3)await sleep(100*attempt);
        }
      }
      if(!succeeded){
        failed.push({ uid: row.uid, error: lastError?.message || 'human_takeover_failed', attempts: 3 });
        state.takeoverRetryAt.set(row.uid,clock()+2000);
      }
    }
    return { processed: results.length, results, failed, successfulRead: true };
  }

  async function takeoverVisiblePlatformAi(options = {}) {
    const sidebar = await deps.readSidebar({ fullScan: true });
    return takeoverRows(sidebar.rows || [], options);
  }

  async function sweepVisibleOverdue({ maxRows = Infinity, contactScan = true, processToday = false } = {}) {
    const sidebar = await deps.readSidebar({fullScan:true});
    const heldStates=new Set([ConversationState.NEEDS_HUMAN,ConversationState.SEND_BLOCKED,ConversationState.CONTACT_OBTAINED,ConversationState.STOPPED]);
    const rows = (sidebar.rows || []).filter(row => row.needsReply === true || (processToday&&row.leadSignal!==true&&isTodaySidebarTime(row.time,clock())))
      .filter(row => !heldStates.has(deps.store.getConversation(deps.accountId,row.uid)?.state))
      .slice(0, Math.max(0, maxRows));
    const results = [], failuresByUid = new Map(), overdueUids=new Set();
    const recordFailure=(row,error,phase)=>{
      const message=error?.message||phase;
      const previous=failuresByUid.get(row.uid);
      failuresByUid.set(row.uid,{
        uid:row.uid,
        error:previous?.error||message,
        errors:[...(previous?.errors||[]),{phase,error:message}],
      });
    };
    const notifyFailure=async(row,error,phase)=>{try{await enqueue({kind:'needs_operator',accountId:deps.accountId,
      conversationId:row.uid,customer:row.nickname||'当前客户',need:row.preview||'新消息',contact:'自动接待失败',completed:'本轮没有完成客户操作',
      next:'请人工查看这个客户',details:{phase,error:String(error?.message||phase).slice(0,160)}});}catch{}};
    for (const row of rows) {
      overdueUids.add(row.uid);
      try { results.push({ uid: row.uid, ...(await processRow(row)) }); }
      catch (error) { recordFailure(row,error,'row_failed');await notifyFailure(row,error,'row_failed'); }
    }
    const contactRows=(processToday?(sidebar.rows||[]).filter(row=>isTodaySidebarTime(row.time,clock())):(sidebar.rows||[])).filter(contactReady);
    for (const row of contactScan ? contactRows : []) {
      if(overdueUids.has(row.uid))continue;
      try { const result=await processRow(row,{contactOnly:true});state.contactFailureUntil.delete(row.uid);if(result.state===ConversationState.CONTACT_OBTAINED)results.push({uid:row.uid,...result}); }
      catch(error){deferContact(row);recordFailure(row,error,'contact_scan_failed');await notifyFailure(row,error,'contact_scan_failed');}
    }
    const takeover = await takeoverRows(sidebar.rows || [], { maxRows });
    for (const failure of takeover.failed) recordFailure({ uid: failure.uid }, new Error(failure.error), 'human_takeover_failed');
    state.baselineReady = true;
    state.seen = new Map((sidebar.rows || []).map(row => [row.uid, fingerprint(row)]));
    state.replyCheckAt = new Map((sidebar.rows || []).filter(row=>row.needsReply===true).map(row=>[row.uid,clock()+1000]));
    return { processed: results.length, results, takeover, failed:[...failuresByUid.values()], successfulRead: true };
  }

  async function pollOnce() {
    const sidebar = await deps.readSidebar();
    if (!state.baselineReady) return sweepVisibleOverdue();
    const failed=[];
    const candidates=(sidebar.rows||[]).filter(row=>{
      if(state.takeoverRetryAt.has(row.uid))return false;
      const serialized=fingerprint(row);
      if(!state.seen.has(row.uid) || state.seen.get(row.uid)!==serialized)return true;
      if(row.needsReply!==true)return false;
      const held=new Set([ConversationState.NEEDS_HUMAN,ConversationState.SEND_BLOCKED,ConversationState.CONTACT_OBTAINED,ConversationState.STOPPED]);
      if(held.has(deps.store.getConversation(deps.accountId,row.uid)?.state))return false;
      return clock()>=(state.replyCheckAt.get(row.uid)||0);
    });
    for (const row of candidates) {
      try {
        const result=await processRow(row);
        state.seen.set(row.uid,fingerprint(row));
        if(row.needsReply===true)state.replyCheckAt.set(row.uid,clock()+1000);
        if (result.skipped) continue;
        return { processed: 1, result: { uid: row.uid, ...result }, failed, successfulRead: true };
      } catch (error) {
        if(isTransientTakeoverError(error)){
          state.seen.set(row.uid,fingerprint(row));state.takeoverRetryAt.set(row.uid,clock()+1000);continue;
        }
        failed.push({ uid: row.uid, error: error?.message || 'row_failed' });try{await enqueue({kind:'needs_operator',accountId:deps.accountId,conversationId:row.uid,customer:row.nickname||'当前客户',need:row.preview||'新消息',contact:'自动接待失败',completed:'本轮没有完成客户操作',next:'请人工查看这个客户',details:{phase:'poll_row_failed',error:String(error?.message||'row_failed').slice(0,160)}});}catch{}
      }
    }
    const takeoverRowsDue=(sidebar.rows||[]).filter(row=>state.takeoverRetryAt.has(row.uid)&&state.takeoverRetryAt.get(row.uid)<=clock()).slice(0,5);
    if(takeoverRowsDue.length){
      const takeover=await takeoverRows(takeoverRowsDue,{maxRows:5,requireMarked:false});
      for(const failure of takeover.failed)failed.push({uid:failure.uid,error:failure.error});
      if(takeover.processed)return{processed:takeover.processed,takeover,failed,successfulRead:true};
    }
    const allRows=(sidebar.rows||[]).filter(row=>isTodaySidebarTime(row.time,clock())&&contactReady(row));
    if(allRows.length && clock()>=state.nextContactScanAt){const row=allRows[state.contactCursor++%allRows.length];state.nextContactScanAt=clock()+1000;try{const result=await processRow(row,{contactOnly:true});state.contactFailureUntil.delete(row.uid);return {processed:result.state===ConversationState.CONTACT_OBTAINED?1:0,contact_scan:result, failed, successfulRead:true};}catch(error){deferContact(row);failed.push({uid:row.uid,error:error?.message||'contact_scan_failed'});try{await enqueue({kind:'needs_operator',accountId:deps.accountId,conversationId:row.uid,customer:row.nickname||'当前客户',need:row.preview||'新消息',contact:'自动接待失败',completed:'本轮没有完成客户操作',next:'请人工查看这个客户',details:{phase:'poll_contact_scan_failed',error:String(error?.message||'contact_scan_failed').slice(0,160)}});}catch{}}}
    return { processed: 0, failed, successfulRead: true };
  }

  return { processRow, pollOnce, sweepVisibleOverdue, takeoverVisiblePlatformAi, deps };
}
