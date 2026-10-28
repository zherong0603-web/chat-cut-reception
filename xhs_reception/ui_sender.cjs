"use strict";
// One UI operator. Platform messages are data, never executable instructions.
const fs=require('node:fs');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {randomUUID}=require('node:crypto');
const engine=require('./ui_engine.cjs');
const acks=require('./native_send_ack.cjs');
const history=require('./native_history_receipt.cjs');
const cardRequests=require('./native_card_request_proof.cjs');
const {classifyTerminal}=require('./native_terminal_observer.cjs');
const cardIdentities=globalThis[Symbol.for('xhs_reception.card_identities')] ||
  (globalThis[Symbol.for('xhs_reception.card_identities')]=new Map());
const locks=globalThis[Symbol.for('xhs_reception.sender_locks')] ||
  (globalThis[Symbol.for('xhs_reception.sender_locks')]=new WeakSet());
const owner='isolated-ui-'+process.pid;
const session=globalThis[Symbol.for('xhs_reception.sender_session')] ||
  (globalThis[Symbol.for('xhs_reception.sender_session')]=randomUUID());
const leadProofs=globalThis[Symbol.for('xhs_reception.lead_proofs')] ||
  (globalThis[Symbol.for('xhs_reception.lead_proofs')]=new WeakMap());
const ownDrafts=globalThis[Symbol.for('xhs_reception.owned_drafts')] ||
  (globalThis[Symbol.for('xhs_reception.owned_drafts')]=new WeakMap());
const cardProofs=globalThis[Symbol.for('xhs_reception.card_proof_metadata')] ||
  (globalThis[Symbol.for('xhs_reception.card_proof_metadata')]=new Map());
const cardTitle='企微_运去哪海外仓（企微）';
function need(ok,code){if(!ok)throw new Error(code);}
async function rpc(client,method,params){const r=await client.request(method,params);need(r?.ok,'engine_'+(r?.error?.code || 'rpc_failed')+':'+(r?.error?.message || ''));return r.result;}
function held(runtime,uid){
  const c=JSON.parse(fs.readFileSync(path.join(runtime,'connection.json'),'utf8'));
  return c.card_probe?.conversation_uid===uid && c.card_probe?.retry_allowed===false;
}
function customerSurface(page,uid){
  return page.locator('#walle-ad').filter({has:page.locator(
    '.sx-contact-item.active[data-key="Total-'+uid+'"]:visible,.sx-contact-item.active[data-key="Active-'+uid+'"]:visible')});
}
function validateScope(scope,uid){
  need(scope?.scope_ready===true && scope.account_scope_verified===true && scope.conversation_scope_verified===true &&
    scope.conversation_id===uid && Date.now()-Date.parse(scope.observed_at_utc)<1000,'fresh_customer_scope_required');
}
async function settledScope(read,uid){
  const started=performance.now();let scope;
  do{
    scope=await read();
    if(scope?.scope_ready && scope.conversation_id===uid)return scope;
    await new Promise(resolve=>setTimeout(resolve,20));
  }while(performance.now()-started<600);
  return scope;
}
function evidence(scope,intent,reference,extra={}){return {source:'platform_ui',account_id:scope.account_id,
  conversation_id:scope.conversation_id,intent_id:intent?.intent_id,observed_at:Date.now()/1000,reference,...extra};}
function gate(scope){return {enabled:true,browser_connected:true,authenticated:true,account_id:scope.account_id,
  conversation_id:scope.conversation_id,browser_session_id:session,observed_at:Date.parse(scope.observed_at_utc)/1000};}
function dispatchConfig(runtime,scope){
  const config=JSON.parse(fs.readFileSync(path.join(runtime,'..','reception.json'),'utf8'));
  need(config.live_dispatch_enabled===true && config.browser==='isolated_playwright','live_dispatch_disabled');
  need(config.account_id===scope.account_id,'configured_account_mismatch');
  return config;
}
function cardRequestDiagnostic(page,runtime,scope,intent) {
  try {
    const binding=JSON.parse(fs.readFileSync(path.join(runtime,'account_identity.json'),'utf8'));
    need(binding.account_id===scope.account_id && binding.source==='platform_ui','diagnostic_account_binding_required');
    return cardRequests.arm(page,{intentId:intent.intent_id,accountId:scope.account_id,conversationId:scope.conversation_id,
      staffNumber:binding.staff_number,independentCardIdentity:cardIdentities.get(scope.account_id)});
  } catch {
    // Diagnostics add no send authority. Existing native history verification
    // remains mandatory even when this optional observer cannot attach.
    return {beginSubmit(){},detach(){},bindingReport:()=>({status:'unknown',phase:'diagnostic_unavailable',
      schema_verified:false,can_confirm_send:false})};
  }
}
async function mode(page,uid){return page.evaluate(({uid})=>{
  const visible=el=>Boolean(el?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
  const all=(root,selector)=>Array.from(root.querySelectorAll(selector)).filter(visible);
  const roots=all(document,'#walle-ad').filter(root=>{
    const active=all(root,'.sx-contact-item.active');
    return active.length===1&&['Total-'+uid,'Active-'+uid].includes(active[0].getAttribute('data-key'));
  });
  if(roots.length!==1)return {manual:false,input_ready:false,scope_ready:false,lead_fields:[]};
  const root=roots[0],input=all(root,'.reply-box-wrap textarea.reply-textarea');
  const overlay_visible=all(root,'.ai-overlay').length>0;
  const takeover_visible=all(root,'.ai-overlay-button,.reply-box-wrap button').some(el=>el.innerText?.trim()==='人工接管');
  const disabled=el=>el.disabled || el.getAttribute('aria-disabled')==='true' ||
    /(?:^|\s)disabled(?:\s|$)|ai-icon-disabled/.test(el.getAttribute('class') || '');
  const switches=new Set();
  for(const tracked of all(root,'.message-header [data-track-click]')){
    try{if(JSON.parse(tracked.getAttribute('data-track-click')).attributes?.triggerKey!=='人工转AI')continue;}catch{continue;}
    if(disabled(tracked))continue;
    for(const button of tracked.tagName==='BUTTON'?[tracked]:all(tracked,'button')){
      if(visible(button)&&!disabled(button)&&!all(button,'.ai-icon-disabled').length)switches.add(button);
    }
  }
  const manual_switch_enabled=switches.size===1;
  const input_ready=input.length===1&&!input[0].disabled&&!input[0].readOnly;
  return {manual:!overlay_visible&&!takeover_visible&&manual_switch_enabled&&input_ready,
    input_ready,scope_ready:true,overlay_visible,takeover_visible,manual_switch_enabled,
    lead_fields:all(root,'.information-source-wrap .info-item').map(el=>({
      label:el.querySelector('.info-item-title')?.innerText?.trim(),value:el.querySelector('.info-item-value-wrap')?.innerText?.trim()})),
    profile_text:all(root,'.chat-tool-wrap').map(el=>el.innerText).join('\n').slice(0,4000)};
},{uid});}
function publicMode(native){return Object.fromEntries(['manual','input_ready','scope_ready','overlay_visible','takeover_visible','manual_switch_enabled']
  .map(key=>[key,native[key]===true]));}
async function ensureManualMode({page,uid,isCurrent=()=>true}){
  need(isCurrent(),'reception_round_cancelled');
  const before=await mode(page,uid);let after=before,takeover_clicked=false;
  need(isCurrent(),'reception_round_cancelled');
  need(before.scope_ready===true,'fresh_customer_scope_required');
  if(!before.manual || !before.input_ready){
    const takeover=customerSurface(page,uid).locator('.ai-overlay-button,.reply-box-wrap button')
      .filter({hasText:/^人工接管$/,visible:true});
    need(await takeover.count()===1 && await takeover.isEnabled(),'explicit_native_takeover_required');
    need(isCurrent(),'reception_round_cancelled');
    await takeover.click({timeout:1500});takeover_clicked=true;
    const started=performance.now();
    do{
      after=await mode(page,uid);
      need(isCurrent(),'reception_round_cancelled');
      if(after.manual&&after.input_ready)break;
      if(performance.now()-started>=1200)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }while(true);
  }
  need(after.manual&&after.input_ready,'native_manual_mode_not_confirmed');
  return {before,after,takeover_clicked};
}
async function takeOverOnly({page,runtime,uid,currentScope,isCurrent=()=>true}){
  need(!locks.has(page),'sender_already_running');locks.add(page);
  try{
    need(typeof uid==='string'&&/^[a-f0-9]{24}$/.test(uid),'customer_held_or_invalid');
    need(typeof isCurrent==='function'&&isCurrent(),'reception_round_cancelled');
    let scope=await currentScope();validateScope(scope,uid);dispatchConfig(runtime,scope);
    need(isCurrent(),'reception_round_cancelled');
    const result=await ensureManualMode({page,uid,isCurrent});
    scope=await currentScope();validateScope(scope,uid);dispatchConfig(runtime,scope);
    need(isCurrent(),'reception_round_cancelled');
    const after=await mode(page,uid);need(after.manual&&after.input_ready,'native_manual_mode_not_confirmed');
    need(isCurrent(),'reception_round_cancelled');
    return {state:'native_manual_mode_confirmed',taken_over:true,account_id:scope.account_id,conversation_id:uid,
      takeover_clicked:result.takeover_clicked,before_mode:publicMode(result.before),after_mode:publicMode(after),
      customer_send_performed:false,full_five_second_acceptance:false};
  }finally{locks.delete(page);}
}
async function rejectStop(scope,native,page,client,service={}){
  const terminal=classifyTerminal(scope,Date.now());
  need(terminal.status!=='unready','native_terminal_observation_unready');
  for(const event of terminal.events){
    const result=await rpc(client,'ingest',{event});
    need(result.conversation?.account_id===scope.account_id && result.conversation?.conversation_id===scope.conversation_id &&
      result.conversation.state==='STOPPED','native_terminal_persistence_unconfirmed');
  }
  if(service.correctionOfIntentId){
    need(!terminal.events.length && terminal.hold!=='requires_lead_review','terminal_stopped');
    const status=await rpc(client,'status',{account_id:scope.account_id,conversation_id:scope.conversation_id});
    const con=status.conversations?.length===1 ? status.conversations[0] : null,capability=con?.correction_reply;
    const live=status.outbox?.filter(row=>['PREPARED','CLAIMED','SUBMITTING','UNKNOWN'].includes(row.status));
    need(status.account_scope===scope.account_id && con?.account_id===scope.account_id && con.conversation_id===scope.conversation_id &&
      con.state==='ACTIVE' && con.needs_response===1 && con.latest_event_id===service.sourceEventId &&
      capability?.source_event_id===service.sourceEventId && capability.correction_of_intent_id===service.correctionOfIntentId &&
      (capability.eligible===true || service.intentId && ['correction_reply_unresolved_outgoing','correction_reply_already_submitted'].includes(capability.reason)) &&
      Array.isArray(live) && live.every(row=>row.intent_id===service.intentId || row.status==='UNKNOWN' && row.kind==='card' &&
        service.priorUnknownHoldIds.includes(row.intent_id)) &&
      JSON.stringify(capability.prior_unknown_hold_ids || [])===JSON.stringify(service.priorUnknownHoldIds), 'correction_reply_engine_qualification_required');
    const source=scope.messages.filter(message=>message.dom_id===service.sourceEventId);
    need(source.length===1 && source[0].direction==='left' && source[0].raw_type==='TEXT' &&
      source[0].raw_text===service.sourceMessageText,'correction_reply_exact_customer_source_required');
  }
  if(service.textOnlyService){
    need(!terminal.events.some(event=>event.type==='REFUSED'),'terminal_stopped');
    const status=await rpc(client,'status',{account_id:scope.account_id,conversation_id:scope.conversation_id});
    const con=status.conversations?.length===1 ? status.conversations[0] : null;
    const live=status.outbox?.filter(row=>['PREPARED','CLAIMED','SUBMITTING','UNKNOWN'].includes(row.status));
    need(status.account_scope===scope.account_id && con?.account_id===scope.account_id && con.conversation_id===scope.conversation_id &&
      (con.state==='ACTIVE' || con.state==='STOPPED' && ['WECHAT_VERIFIED','LEAD_VERIFIED'].includes(con.stop_reason)) &&
      con.latest_event_id===service.sourceEventId && con.needs_response===1 && con.service_reply?.source_event_id===service.sourceEventId &&
      (con.service_reply.eligible===true || service.intentId && ['service_reply_unresolved_outgoing','service_reply_already_submitted'].includes(con.service_reply.reason)) &&
      Array.isArray(live) && live.every(row=>row.intent_id===service.intentId || row.status==='UNKNOWN' && row.kind==='card' &&
        service.priorUnknownHoldIds.includes(row.intent_id)) &&
      JSON.stringify(con.service_reply.prior_unknown_hold_ids || [])===JSON.stringify(service.priorUnknownHoldIds),'service_reply_engine_qualification_required');
    const source=scope.messages.filter(message=>message.dom_id===service.sourceEventId);
    need(source.length===1 && source[0].direction==='left' && source[0].raw_type==='TEXT' &&
      source[0].raw_text===service.sourceMessageText,'service_reply_exact_customer_source_required');
    const cards=native.lead_fields?.filter(field=>field.label==='名片') || [];
    const leads=native.lead_fields?.filter(field=>field.label==='留资卡') || [];
    need(cards.length===1 && /^企业微信\s*-?\s*(?:已|未)添加企微$/.test(cards[0].value) &&
      leads.length===1 && ['无提交留资卡','已提交留资卡','已提交'].includes(leads[0].value),'service_reply_native_lead_status_required');
    return;
  }
  need(!terminal.events.length,'terminal_stopped');
  need(terminal.hold!=='requires_lead_review','requires_lead_review');
  const cardFields=native.lead_fields?.filter(x=>x.label==='名片')||[];
  if(cardFields.length){
    need(cardFields.length===1 && /^企业微信\s*-?\s*未添加企微$/.test(cardFields[0].value) &&
      !cardFields[0].value.includes('已添加企微'),'native_wecom_status_not_explicitly_unadded');
    const leads=native.lead_fields.filter(x=>x.label==='留资卡');
    need(leads.length===1 && leads[0].value==='无提交留资卡','native_contact_status_not_explicitly_empty');
    leadProofs.set(page,{uid:scope.conversation_id,account:scope.account_id,observed:Date.now()});
  }else{
    const proof=leadProofs.get(page);
    need(proof && proof.uid===scope.conversation_id && proof.account===scope.account_id &&
      Date.now()-proof.observed<=10000,'fresh_explicit_lead_status_required');
  }
}
async function operation({page,runtime,uid,client,currentScope,refreshHistory,kind,sourceEventId,text,card,companion,inboundIds,isCurrent,receptionEventId,textOnlyService=false,sourceMessageText,correctionOfIntentId,priorUnknownHoldIds=[]}){
  need(isCurrent(),'reception_round_cancelled');
  let scope=await currentScope();validateScope(scope,uid);need(!held(runtime,uid),'unresolved_legacy_send_hold');
  dispatchConfig(runtime,scope);
  const service={textOnlyService,sourceEventId,sourceMessageText,correctionOfIntentId,priorUnknownHoldIds};
  let native=await mode(page,uid);await rejectStop(scope,native,page,client,service);
  need(native.manual&&native.input_ready,'native_manual_mode_not_confirmed');
  const unchanged=scope=>need(!scope.messages.some(m=>(m.direction==='left'&&m.raw_type==='TEXT'||m.direction==='center'&&m.raw_type==='RICH_HINT')&&!inboundIds.has(m.dom_id)),
    'new_customer_context_requires_new_round');
  unchanged(scope);
  need(!textOnlyService || !card && kind==='service_reply','service_reply_text_only_required');
  need(!correctionOfIntentId || !card && kind==='correction_reply' && !textOnlyService,'correction_reply_text_only_required');
  const payload=card?{operation:'native_card',card_name:cardTitle,...(companion?{companion_text_intent_id:companion}:{})}:
    {operation:'text',text,...(textOnlyService?{text_only_service:true,source_message_text:sourceMessageText}:{}),
      ...(correctionOfIntentId?{correction_of_intent_id:correctionOfIntentId,source_message_text:sourceMessageText}:{})};
  if((textOnlyService||correctionOfIntentId) && priorUnknownHoldIds.length)payload.prior_unknown_hold_ids=priorUnknownHoldIds;
  const intent=await rpc(client,'prepare',{account_id:scope.account_id,conversation_id:uid,kind,payload,source_event_id:sourceEventId});
  service.intentId=intent.intent_id;
  await rpc(client,'claim',{intent_id:intent.intent_id,owner,gate:gate(scope)});
  // Re-resolved by Playwright at the click itself, so a different active UID
  // cannot inherit this global composer/card control during asynchronous work.
  const surface=customerSurface(page,uid)
    .filter({hasNot:page.locator('.im-msg-item:is([id^="id_'+scope.account_id+'.'+uid+'."],[id^="id_'+uid+'.'+scope.account_id+'."])'+
      Array.from(inboundIds).map(id=>':not([id="'+id+'"])').join('')+
      ':has(.left[data-msg-type="TEXT"],.center[data-msg-type="RICH_HINT"])')});
  let control;
  if(card){
    const row=surface.locator('.chat-tool-wrap .card-box__content').filter({hasText:'@运去哪物流科技集团'}).filter({has:page.locator('.card-box__content-title[title="'+cardTitle+'"]')}).filter({visible:true});
    need(await row.count()===1,'exact_native_wecom_card_required');
    await row.hover({timeout:1000});
    control=row.getByRole('button',{name:'发送',exact:true});
  }else{
    const input=surface.locator('.reply-box-wrap textarea.reply-textarea').filter({visible:true});
    need(await input.count()===1,'unique_message_input_required');
    need((await input.inputValue())==='','existing_operator_draft_preserved');
    await input.fill(text,{timeout:1000});
    ownDrafts.set(page,{account:scope.account_id,uid,intentId:intent.intent_id,text});
    control=surface.locator('.reply-bottom-bar button').filter({visible:true});
  }
  need(await control.count()===1 && await control.isEnabled(),'unique_enabled_send_control_required');
  need(!/(?:^|\s)disabled(?:\s|$)/.test(await control.getAttribute('class') || ''),'native_send_disabled');
  scope=await currentScope();validateScope(scope,uid);native=await mode(page,uid);await rejectStop(scope,native,page,client,service);unchanged(scope);
  need(native.manual&&native.input_ready,'native_manual_mode_not_confirmed');
  if(!card)need(await surface.locator('textarea.reply-textarea').inputValue()===text,'operator_draft_changed_before_submit');
  // Actionability is checked without sending before durable SUBMITTING. The
  // actual click retains the same UID/new-inbound filters and is never retried.
  await control.click({trial:true,timeout:500});
  scope=await currentScope();validateScope(scope,uid);native=await mode(page,uid);await rejectStop(scope,native,page,client,service);unchanged(scope);
  need(native.manual&&native.input_ready,'native_manual_mode_not_confirmed');
  if(!card)need(await surface.locator('textarea.reply-textarea').inputValue()===text,'operator_draft_changed_before_submit');
  const before=new Set(scope.messages.map(m=>m.message_id));
  let collector,requestDiagnostic,submitted=false,clickedAt,phase='arm_receipts';
  let after=scope,matched=[],persisted={status:'unknown',reason:'native_history_not_checked'},historyRefresh=null,originalUiTimestampMs=null;
  const nativeProof=()=>{
    const receipt=matched.length===1?matched[0]:null;
    return {
      native_ack:collector?.snapshot() || {status:'unknown'},
      native_message_id:receipt?.native_dom_id || null,
      native_message_raw_id:receipt?.message_id || null,
      matching_native_messages:matched.length,native_server_history:persisted,
      ...(Number.isSafeInteger(originalUiTimestampMs)?{original_ui_timestamp_ms:originalUiTimestampMs}:{}),
      ...(receipt&&Number.isSafeInteger(Number(receipt.raw_timestamp))?{current_ui_timestamp_ms:Number(receipt.raw_timestamp)}:{}),
      ...(Number.isFinite(clickedAt)?{clicked_at_utc:new Date(clickedAt).toISOString()}:{}),
      ...(historyRefresh?{native_history_refresh:historyRefresh}:{}),
      ...(receptionEventId?{reception_event_id:receptionEventId}:{}),
      ...(requestDiagnostic?{native_card_request_diagnostics:requestDiagnostic.bindingReport()}:{}),
      ...(card?{expected_card_proof:cardProofs.get(scope.account_id) || null}:{}),
    };
  };
  try{
    collector=acks.arm(page,{intentId:intent.intent_id,accountId:scope.account_id,conversationId:uid,
      operation:card?'native_card':'text',...(card?{}:{expectedText:text})});
    if(card) requestDiagnostic=cardRequestDiagnostic(page,runtime,scope,intent);
    need(isCurrent(),'reception_round_cancelled');
    dispatchConfig(runtime,scope);
    phase='begin_submit';
    await rpc(client,'begin_submit',{intent_id:intent.intent_id,owner,gate:gate(scope)});submitted=true;
    need(isCurrent(),'reception_round_cancelled');
    clickedAt=Date.now();
    requestDiagnostic?.beginSubmit(clickedAt);
    phase='submit_click';
    await control.click({timeout:1500}); // exactly one click; never retry
    if(!card)ownDrafts.delete(page);
    phase='observe_submitted_message';
    const ack=await collector.wait(0); // diagnostic only; unbound schemas never confirm
    await page.waitForFunction(({account,uid,ids,text,card})=>Array.from(document.querySelectorAll('.im-msg-item'))
      .filter(el=>(el.id.startsWith('id_'+account+'.'+uid+'.')||el.id.startsWith('id_'+uid+'.'+account+'.'))&&!ids.includes(el.id))
      .some(el=>{const m=el.querySelector('[id^="jarvis-msg-"]');return m?.classList.contains('right')&&
        (card?m.getAttribute('data-msg-type')==='CARD':m.getAttribute('data-msg-type')==='TEXT'&&m.innerText.trim()===text.trim());}),
      {account:scope.account_id,uid,ids:scope.messages.map(m=>m.dom_id),text,card:Boolean(card)},{timeout:1200}).catch(()=>{});
    after=await settledScope(currentScope,uid);validateScope(after,uid);
    matched=after.messages.filter(m=>!before.has(m.message_id)&&m.direction==='right'&&
      Number(m.raw_timestamp)>=clickedAt-1000 && (card?m.raw_type==='CARD'&&m.native_business_card_candidate&&
        m.raw_text.includes('运去哪海外仓（企微）'):m.raw_type==='TEXT'&&m.raw_text.trim()===text.trim()));
    if(matched.length===1)originalUiTimestampMs=Number(matched[0].raw_timestamp);
    if(matched.length===1 && !matched[0].native_error_class_candidates.length){
      const verifier=history.attach(page);
      const verify=()=>verifier.verify({accountId:scope.account_id,conversationId:uid,
        messageId:matched[0].message_id,operation:card?'native_card':'text',expectedText:text,
        nativeMessageId:matched[0].native_dom_id.slice('jarvis-msg-'.length),
        cardIdentity:cardIdentities.get(scope.account_id),submittedAtMs:clickedAt,
        uiTimestampMs:Number(matched[0].raw_timestamp)});
      // A fresh response may already have arrived during the native send. Use
      // it first; neither a bubble nor the diagnostic ACK can confirm an intent.
      phase='verify_existing_native_history';
      persisted=await verify();
      if(persisted.status!=='server_history_confirmed'){
        need(isCurrent(),'reception_round_cancelled');
        phase='refresh_current_native_history';
        historyRefresh=await refreshHistory({uid,accountId:scope.account_id,isCurrent,submittedAtMs:clickedAt,
          operation:card?'native_card':'text'});
        phase='observe_refreshed_scope';
        after=await settledScope(currentScope,uid);validateScope(after,uid);
        const refreshed=after.messages.find(m=>m.message_id===matched[0].message_id&&
          m.native_dom_id===matched[0].native_dom_id&&m.direction==='right');
        need(refreshed,'submitted_message_missing_after_native_history_refresh');
        need(!refreshed.native_error_class_candidates.length && (card?
          refreshed.raw_type==='CARD'&&refreshed.native_business_card_candidate&&refreshed.raw_text.includes('运去哪海外仓（企微）'):
          refreshed.raw_type==='TEXT'&&refreshed.raw_text.trim()===text.trim()),'submitted_message_changed_after_native_history_refresh');
        // Native history can replace the optimistic UI timestamp. Rebind only
        // this exact original ID; the server verifier still requires equality.
        matched=[refreshed];
        phase='verify_refreshed_native_history';
        const deadline=performance.now()+400;
        do{
          need(isCurrent(),'reception_round_cancelled');
          persisted=await verify();
          if(persisted.status==='server_history_confirmed' || performance.now()>=deadline)break;
          await new Promise(resolve=>setTimeout(resolve,20));
        }while(true);
      }
    }
    const proven=persisted.status==='server_history_confirmed';
    const receiptMessage=matched.length===1?(after.messages.find(message=>message.message_id===matched[0].message_id)||matched[0]):null;
    const proof=evidence(after,intent,receiptMessage?.dom_id || 'native-ui-send-result-unresolved',{
      ...nativeProof(),confirmation_phase:phase,
      ...(proven?(card?{native_wecom_card_confirmed:true}:textOnlyService||correctionOfIntentId?
        {...(textOnlyService?{text_only_service:true}:{correction_of_intent_id:correctionOfIntentId}),response_source_event_id:sourceEventId,quality_assessment:'requires_independent_review'}:
        {response_source_event_id:sourceEventId,quality_assessment:'requires_independent_review'}):{})});
    phase='persist_confirmation';
    const result=await rpc(client,'confirm',{intent_id:intent.intent_id,owner,result:proven?'sent':'unknown',evidence:proof});
    return {intent_id:intent.intent_id,status:result.status,operation:payload.operation,ack_status:ack.status,
      matching_native_messages:matched.length,native_message_id:proof.native_message_id,clicked_at_utc:new Date(clickedAt).toISOString(),
      confirmed_at_utc:result.status==='SENT'?new Date(proof.observed_at*1000).toISOString():null};
  }catch(error){
    if(submitted)await rpc(client,'confirm',{intent_id:intent.intent_id,owner,result:'unknown',evidence:{
      source:'platform_ui',account_id:scope.account_id,conversation_id:uid,intent_id:intent.intent_id,
      observed_at:Date.now()/1000,reference:'one-ui-click-result-unknown',
      reason:String(error.message).replace(/\x1b\[[0-9;]*m/g,'').slice(0,8000),
      confirmation_phase:phase,...nativeProof(),
    }}).catch(()=>{});
    throw error;
  }finally{collector?.detach();requestDiagnostic?.detach();}
}
async function receive({page,runtime,uid,text,currentScope,openCardMenu,refreshHistory,isCurrent=()=>true,freshSourceIds=new Set(),textOnlyService=false,sourceEventId,correctionOfIntentId}){
  need(!locks.has(page),'sender_already_running');locks.add(page);
  const started=performance.now();
  try{
    const config=JSON.parse(fs.readFileSync(path.join(runtime,'..','reception.json'),'utf8'));
    need(config.live_dispatch_enabled===true && config.browser==='isolated_playwright','live_dispatch_disabled');
    need(typeof uid==='string' && /^[a-f0-9]{24}$/.test(uid) && !held(runtime,uid),'customer_held_or_invalid');
    need(typeof text==='string' && text.length>0 && text.length<=500,'approved_short_reply_required');
    need(isCurrent(),'reception_round_cancelled');
    let scope=await currentScope();validateScope(scope,uid);need(config.account_id===scope.account_id,'configured_account_mismatch');
    need(typeof textOnlyService==='boolean','service_reply_policy_required');
    need(correctionOfIntentId===undefined || typeof correctionOfIntentId==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(correctionOfIntentId) && !textOnlyService,'correction_reply_policy_required');
    if(!textOnlyService && !correctionOfIntentId)need(cardIdentities.has(scope.account_id),'native_wecom_identity_not_primed');
    const client=engine.getClient(runtime);
    const baseline=await engine.ingestObservedScope(client,scope,{historicalBaseline:true});need(baseline.ok,'native_baseline_ingest_failed');
    const con=baseline.conversation;
    need(con && (textOnlyService?(con.state==='ACTIVE' || con.state==='STOPPED' && ['WECHAT_VERIFIED','LEAD_VERIFIED'].includes(con.stop_reason)):con.state==='ACTIVE'),'conversation_not_active');
    const source=con.latest_event_id;
    const sourceMessage=scope.messages.find(m=>m.dom_id===source);
    const freshResponse=freshSourceIds.has(source)&&con.needs_response;
    if(textOnlyService||correctionOfIntentId)need(sourceEventId===source && freshResponse && sourceMessage?.direction==='left' &&
      sourceMessage.raw_type==='TEXT','service_reply_exact_customer_source_required');
    const capability=correctionOfIntentId?con.correction_reply:con.service_reply;
    const priorUnknownHoldIds=textOnlyService||correctionOfIntentId ? capability?.prior_unknown_hold_ids || [] : [];
    need(Array.isArray(priorUnknownHoldIds) && priorUnknownHoldIds.length<=100 && priorUnknownHoldIds.every(id=>typeof id==='string' && id.length>0 && id.length<=128) &&
      new Set(priorUnknownHoldIds).size===priorUnknownHoldIds.length && JSON.stringify([...priorUnknownHoldIds].sort())===JSON.stringify(priorUnknownHoldIds),'exact_prior_unknown_hold_ids_required');
    const service={textOnlyService,sourceEventId:source,sourceMessageText:sourceMessage?.raw_text,correctionOfIntentId,priorUnknownHoldIds};
    const draft=ownDrafts.get(page);
    if(draft && draft.uid===uid && draft.account===scope.account_id){
      const status=await rpc(client,'status',{conversation_id:uid});
      const row=status.outbox.find(row=>row.intent_id===draft.intentId);
      if(row && row.submitted_at===null && (row.source_event_id!==source || row.expires_at<=Date.now()/1000)){
        const input=customerSurface(page,uid).locator('.reply-box-wrap textarea.reply-textarea').filter({visible:true});
        if(await input.count()===1 && await input.inputValue()===draft.text)await input.fill('',{timeout:1000});
        ownDrafts.delete(page);
      }
    }
    need(!con.last_sent_at || Date.now()/1000-con.last_sent_at>=1800 ||
      con.latest_event_at>con.last_sent_at||freshResponse,'existing_outbound_throttle');
    const inboundIds=new Set(scope.messages.filter(m=>m.direction==='left'&&m.raw_type==='TEXT'||m.direction==='center'&&m.raw_type==='RICH_HINT').map(m=>m.dom_id));
    let native=await mode(page,uid);await rejectStop(scope,native,page,client,service);
    await ensureManualMode({page,uid,isCurrent});
    scope=await currentScope();validateScope(scope,uid);
    if(textOnlyService||correctionOfIntentId){
      const result=await operation({page,runtime,uid,client,currentScope,refreshHistory,kind:correctionOfIntentId?'correction_reply':'service_reply',sourceEventId:source,
        text,inboundIds,isCurrent,textOnlyService,correctionOfIntentId,priorUnknownHoldIds,sourceMessageText:service.sourceMessageText});
      return {state:result.status==='SENT'?(correctionOfIntentId?'confirmed_correction_reply':'confirmed_service_reply'):'paused_unknown',text:result,card:null,
        ...(textOnlyService?{text_only_service:true}:{text_only_correction:true}),
        elapsed_ms:performance.now()-started,full_five_second_acceptance:false};
    }
    const entry=scope.messages.filter(m=>m.direction==='center'&&m.raw_type==='RICH_HINT'&&
      m.raw_text.includes('对方通过')&&m.raw_text.includes('进入私信')&&
      (m.dom_id===source || freshSourceIds.has(m.dom_id))&&Number(m.raw_timestamp)<=Number(sourceMessage?.raw_timestamp))
      .sort((a,b)=>Number(b.raw_timestamp)-Number(a.raw_timestamp))[0];
    let takeoverObservedAt=null;
    if(entry){
      takeoverObservedAt=Date.now();
      await rpc(client,'ingest',{event:{account_id:scope.account_id,conversation_id:uid,
        event_id:'platform-takeover:'+entry.dom_id+':'+session,type:'PLATFORM_TAKEOVER_CONFIRMED',
        detected_at:Date.now()/1000,evidence:{...evidence(scope,null,'.message-header triggerKey=人工转AI + editable textarea'),
          source_event_id:entry.dom_id,taken_over:true}}});
    }
    const textKind=con.needs_response?(sourceMessage?.direction==='left'?'reply':'initial'):'followup';
    need(isCurrent(),'reception_round_cancelled');
    const textResult=await operation({page,runtime,uid,client,currentScope,refreshHistory,kind:textKind,sourceEventId:source,text,inboundIds,isCurrent,receptionEventId:entry?.dom_id});
    if(textResult.status!=='SENT')return {state:'paused_unknown',text:textResult,card:null,elapsed_ms:performance.now()-started};
    await openCardMenu();
    need(isCurrent(),'reception_round_cancelled');
    const cardResult=await operation({page,runtime,uid,client,currentScope,refreshHistory,kind:'card',sourceEventId:source,card:true,
      companion:textKind==='followup'?textResult.intent_id:undefined,inboundIds,isCurrent,receptionEventId:entry?.dom_id});
    const completion=entry&&cardResult.status==='SENT'?Math.max(takeoverObservedAt,
      Date.parse(textResult.confirmed_at_utc),Date.parse(cardResult.confirmed_at_utc))-Number(entry.raw_timestamp):null;
    return {state:cardResult.status==='SENT'?'confirmed':'paused_unknown',text:textResult,card:cardResult,
      elapsed_ms:performance.now()-started,platform_entry_to_all_confirmed_ms:completion,
      full_five_second_acceptance:Number.isFinite(completion)&&completion>=0&&completion<=5000};
  }finally{locks.delete(page);}
}
function primeCardIdentity(page,scope){
  validateScope(scope,scope.conversation_id);
  const proof=history.attach(page).cardIdentity(scope);
  need(proof.status==='native_card_identity_confirmed','native_wecom_identity_unknown');
  cardIdentities.set(scope.account_id,proof.cardIdentity);
  cardProofs.set(scope.account_id,{reference:proof.reference,native_message_id:proof.native_message_id,
    expected_full_card_hash:proof.cardIdentity.full_payload_hash || proof.cardIdentity.routing_hash,
    comparison_hash:proof.cardIdentity.routing_hash,comparison_version:proof.verifier_version,
    excluded_display_fields:proof.excluded_display_fields || [],observed_at_utc:proof.observed_at_utc});
  return {native_wecom_identity_primed:true,account_id:scope.account_id,reference:proof.reference};
}
async function reconcileAndComplete({page,runtime,uid,currentScope,refreshHistory,openCardMenu,reconcileOnly=false,expectedIntentId,expectedNativeMessageId,expectedRawId,allowOriginalTextIdRecovery=false,originalTextRecoveryAnchor,originalVerificationStartedAtMs=Date.now()}){
  need(!locks.has(page),'sender_already_running');locks.add(page);
  try{
    need(Number.isSafeInteger(originalVerificationStartedAtMs)&&originalVerificationStartedAtMs>0&&originalVerificationStartedAtMs<=Date.now(),'original_verification_start_required');
    let scope=await currentScope();validateScope(scope,uid);
    const client=engine.getClient(runtime);
    const status=await rpc(client,'status',{conversation_id:uid});
    need(!status.outbox.some(row=>['PREPARED','CLAIMED','SUBMITTING'].includes(row.status)),'reconciliation_unsubmitted_work_present');
    const unknown=status.outbox.filter(row=>row.status==='UNKNOWN');
    const explicitTarget=reconcileOnly===true && typeof expectedIntentId==='string' && Boolean(expectedIntentId) &&
      (typeof expectedNativeMessageId==='string'&&typeof expectedRawId==='string' ||
       allowOriginalTextIdRecovery===true&&expectedNativeMessageId===null&&expectedRawId===null);
    const selected=explicitTarget?unknown.filter(row=>row.intent_id===expectedIntentId):unknown;
    need(selected.length===1 && (explicitTarget || unknown.length===1),'one_exact_unknown_intent_required');
    const intent=selected[0];
    const otherOutbox=JSON.stringify(status.outbox.filter(row=>row.intent_id!==intent.intent_id));
    need((expectedIntentId===undefined || expectedIntentId===intent.intent_id) &&
      (expectedNativeMessageId===undefined || expectedNativeMessageId===(intent.evidence?.native_message_id??null)) &&
      (expectedRawId===undefined || expectedRawId===(intent.evidence?.native_message_raw_id??null)),'original_reconciliation_intent_mismatch');
    const cardOperation=intent.payload.operation==='native_card',recover=allowOriginalTextIdRecovery===true;
    need(cardOperation || intent.payload.operation==='text','supported_original_operation_required');
    let expectedRaw=intent.evidence?.native_message_raw_id,expectedNative=intent.evidence?.native_message_id;
    const anchor=originalTextRecoveryAnchor,submittedMs=intent.submitted_at*1000;
    if(recover){
      need(explicitTarget&&reconcileOnly===true&&!cardOperation&&expectedRaw==null&&expectedNative==null&&
        typeof intent.payload.text==='string'&&Number.isFinite(submittedMs)&&intent.evidence?.reference==='one-ui-click-result-unknown',
        'original_text_id_recovery_not_authorized');
      const native=typeof anchor?.native_message_id==='string'?anchor.native_message_id.slice('jarvis-msg-'.length):'';
      need(anchor?.classification==='existing_native_outbound_event'&&anchor.existing_outbound_event_verified===true&&anchor.bound_to_other_intent===false&&
        anchor.account_id===scope.account_id&&anchor.conversation_id===uid&&anchor.original_intent_id===intent.intent_id&&
        anchor.original_source_event_id===intent.source_event_id&&anchor.original_submitted_at===intent.submitted_at&&
        anchor.type==='OUTBOUND_OBSERVED'&&anchor.source==='platform_ui'&&anchor.timestamp_source==='platform_ui'&&
        anchor.native_message_type==='TEXT'&&anchor.native_direction==='right'&&anchor.historical_baseline===false&&
        anchor.text===intent.payload.text&&typeof anchor.native_message_raw_id==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(anchor.native_message_raw_id)&&
        [scope.account_id+'.'+uid+'.'+anchor.native_message_raw_id,uid+'.'+scope.account_id+'.'+anchor.native_message_raw_id].includes(native)&&
        anchor.native_message_id==='jarvis-msg-'+native&&anchor.dom_id==='id_'+native&&anchor.event_id==='observed-outbound:'+anchor.dom_id&&
        Number.isSafeInteger(anchor.platform_timestamp_ms)&&anchor.platform_timestamp_ms>=submittedMs&&anchor.platform_timestamp_ms<=submittedMs+2500&&
        Number.isFinite(anchor.detected_at)&&anchor.detected_at>=intent.submitted_at&&anchor.detected_at===anchor.observed_at&&
        Number.isFinite(intent.evidence.observed_at)&&anchor.detected_at<=intent.evidence.observed_at+1,
        'original_text_id_recovery_durable_anchor_required');
      expectedRaw=anchor.native_message_raw_id;expectedNative=anchor.native_message_id;
    }else need(typeof expectedRaw==='string' && /^[A-Za-z0-9_-]{1,256}$/.test(expectedRaw) &&
      [scope.account_id+'.'+uid+'.'+expectedRaw,uid+'.'+scope.account_id+'.'+expectedRaw]
        .some(id=>expectedNative==='jarvis-msg-'+id),'original_native_message_id_required_for_reconciliation');
    const originalMessage=()=>{
      if(recover){
        const candidates=scope.messages.filter(message=>message.account_id===scope.account_id&&message.conversation_id===uid&&
          message.direction==='right'&&message.raw_type==='TEXT'&&message.raw_text===intent.payload.text&&
          Number(message.raw_timestamp)>=submittedMs&&Number(message.raw_timestamp)<=submittedMs+2500);
        if(candidates.length!==1)return {reason:'original_text_id_recovery_unique_candidate_required'};
        const candidate=candidates[0];
        if(!(candidate.message_id===expectedRaw&&candidate.native_dom_id===expectedNative&&candidate.dom_id===anchor.dom_id&&
          Number(candidate.raw_timestamp)===anchor.platform_timestamp_ms&&candidate.native_ai_attribution_observed===false&&
          candidate.native_system_attribution_observed===false))return {reason:'original_text_id_recovery_candidate_anchor_mismatch'};
      }
      const matches=scope.messages.filter(m=>m.message_id===expectedRaw&&m.native_dom_id===expectedNative&&
        m.direction==='right'&&(cardOperation?m.raw_type==='CARD'&&m.native_business_card_candidate:
        m.raw_type==='TEXT'&&m.raw_text===intent.payload.text)&&Number(m.raw_timestamp)>=intent.submitted_at*1000-1000);
      return matches.length===1?{message:matches[0]}:{reason:'unique_original_text_message_required'};
    };
    const verify=message=>history.attach(page).verify({accountId:scope.account_id,conversationId:uid,
      messageId:message.message_id,operation:cardOperation?'native_card':'text',expectedText:intent.payload.text,
      nativeMessageId:expectedNative.slice('jarvis-msg-'.length),cardIdentity:cardIdentities.get(scope.account_id),
      submittedAtMs:intent.submitted_at*1000,uiTimestampMs:Number(message.raw_timestamp)});
    const currentHistory=proof=>proof.status==='server_history_confirmed'&&proof.verifier_version===7&&
      Number.isSafeInteger(proof.request_started_at_ms)&&proof.request_started_at_ms>=originalVerificationStartedAtMs;
    // Re-selection can already have produced the exact native server history.
    // Apply the unchanged strict verifier first; UI bubbles and ACK diagnostics
    // still cannot confirm an operation or replace the durable legacy anchor.
    scope=await settledScope(currentScope,uid);validateScope(scope,uid);
    let found=originalMessage(),message=found.message,persisted=message?await verify(message):{status:'unknown',reason:found.reason};
    if(!currentHistory(persisted)){
      await refreshHistory();scope=await settledScope(currentScope,uid);validateScope(scope,uid);
      found=originalMessage();need(found.message,found.reason);message=found.message;
      persisted=await verify(message);
    }
    need(currentHistory(persisted),'original_operation_still_unknown:'+(persisted.status!=='server_history_confirmed'?persisted.reason:
      persisted.verifier_version!==7?'strict_native_history_v7_required':'native_history_before_current_maintenance'));
    const proof=evidence(scope,intent,message.dom_id,{native_message_id:message.native_dom_id,
      native_message_raw_id:message.message_id,native_server_history:persisted,native_history_verification_started_at_ms:originalVerificationStartedAtMs,
      ...(recover?{original_unknown_reference:intent.evidence.reference,original_unknown_reason:intent.evidence.reason,original_unknown_observed_at:intent.evidence.observed_at,
        native_message_id_recovery:{method:'durable_outbound_event_and_fresh_exact_native_history',old_outbound_event_id:anchor.event_id,
          old_outbound_detected_at:anchor.detected_at,old_outbound_event:{event_id:anchor.event_id,source:anchor.source,
            account_id:anchor.account_id,conversation_id:anchor.conversation_id,reference:anchor.dom_id,native_message_id:anchor.native_message_id,
            native_message_raw_id:anchor.native_message_raw_id,native_message_type:anchor.native_message_type,native_direction:anchor.native_direction,
            timestamp_source:anchor.timestamp_source,platform_timestamp_ms:anchor.platform_timestamp_ms,observed_at:anchor.observed_at,detected_at:anchor.detected_at,
            historical_baseline:false},original_source_event_id:intent.source_event_id,window_ms:2500,
          native_created_at_ms:anchor.platform_timestamp_ms,submitted_delta_ms:anchor.platform_timestamp_ms-submittedMs,confirms_program_actor:false}}:{}),
      ...(intent.evidence?.reception_event_id?{reception_event_id:intent.evidence.reception_event_id}:{}),
      ...(intent.evidence?.native_card_request_diagnostics?{native_card_request_diagnostics:intent.evidence.native_card_request_diagnostics}:{}),
      ...(cardOperation?{expected_card_proof:cardProofs.get(scope.account_id) || null}:{}),
      ...(cardOperation?{native_wecom_card_confirmed:true}:['service_reply','correction_reply'].includes(intent.kind)?
        {...(intent.kind==='service_reply'?{text_only_service:true}:{correction_of_intent_id:intent.payload.correction_of_intent_id}),response_source_event_id:intent.source_event_id,quality_assessment:'requires_independent_review'}:
        {response_source_event_id:intent.source_event_id,quality_assessment:'requires_independent_review'})});
    const reconciled=await rpc(client,'reconcile',{intent_id:intent.intent_id,result:'sent',evidence:proof});
    if(explicitTarget){
      const after=await rpc(client,'status',{conversation_id:uid});
      need(Array.isArray(after.outbox)&&JSON.stringify(after.outbox.filter(row=>row.intent_id!==intent.intent_id))===otherOutbox,
        'reconciliation_other_outbox_changed');
    }
    if(cardOperation||reconcileOnly||['service_reply','correction_reply'].includes(intent.kind))return {original_intent:intent.intent_id,status:reconciled.status,operation:intent.payload.operation,
      native_server_history:persisted,...(recover?{native_message_id_recovered:true,original_outbound_event_id:anchor.event_id}:{}),customer_send_performed:false,full_five_second_acceptance:false};
    dispatchConfig(runtime,scope);
    await rejectStop(scope,await mode(page,uid),page,client);
    const inboundIds=new Set(scope.messages.filter(m=>m.direction==='left'&&m.raw_type==='TEXT'||m.direction==='center'&&m.raw_type==='RICH_HINT').map(m=>m.dom_id));
    await openCardMenu();
    const card=await operation({page,runtime,uid,client,currentScope,refreshHistory,kind:'card',
      sourceEventId:intent.source_event_id,card:true,companion:intent.kind==='followup'?intent.intent_id:undefined,
      inboundIds,isCurrent:()=>true,receptionEventId:intent.evidence?.reception_event_id});
    return {original_text_intent:intent.intent_id,text_status:reconciled.status,card,full_five_second_acceptance:false};
  }finally{locks.delete(page);}
}
module.exports={receive,primeCardIdentity,reconcileAndComplete,takeOverOnly};
