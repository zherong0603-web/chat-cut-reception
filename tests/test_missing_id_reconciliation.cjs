"use strict";
// Legacy single-click result recovery: actual sender + actual strict native GET
// parser; only external page/RPC boundaries are synthetic. No live DB or send.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{createRequire}=require('node:module');
const file=path.resolve(__dirname,'../xhs_reception/ui_sender.cjs'),real=createRequire(file),history=real('./native_history_receipt.cjs');
const A='aaaaaaaaaaaaaaaaaaaaaaaa',U='bbbbbbbbbbbbbbbbbbbbbbbb',V='cccccccccccccccccccccccc',text='SYNTHETIC_ORIGINAL_APPROVED_TEXT';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(options={},check){
  const submittedMs=Date.now()-60000+(options.fractional?0.563:0),candidateMs=options.delta!==undefined?submittedMs+options.delta:Math.ceil(submittedMs)+322;
  const pair=A+'.'+U+'.',raw='original-candidate',full=pair+raw;
  const intent={intent_id:'exact-original-intent',account_id:A,conversation_id:U,kind:'reply',source_event_id:'id_'+U+'.'+A+'.old-question',
    payload:{operation:'text',text},status:'UNKNOWN',submitted_at:submittedMs/1000,evidence:{source:'platform_ui',account_id:A,conversation_id:U,
      reference:'one-ui-click-result-unknown',observed_at:submittedMs/1000+3.257,reason:'legacy native history refresh failed after a single UI click'}};
  const candidate={account_id:A,conversation_id:U,message_id:raw,dom_id:'id_'+full,native_dom_id:'jarvis-msg-'+full,
    raw_timestamp:String(candidateMs),raw_type:'TEXT',raw_text:text,direction:'right',native_error_class_candidates:[],
    native_ai_attribution_observed:false,native_system_attribution_observed:false};
  const newer={account_id:A,conversation_id:U,message_id:'later-question',dom_id:'id_'+pair+'later-question',native_dom_id:'jarvis-msg-'+pair+'later-question',
    raw_timestamp:String(Date.now()-1000),raw_type:'TEXT',raw_text:'SYNTHETIC_NEW_QUESTION',direction:'left'};
  const anchor={classification:'existing_native_outbound_event',existing_outbound_event_verified:true,bound_to_other_intent:false,account_id:A,conversation_id:U,
    original_intent_id:intent.intent_id,original_source_event_id:intent.source_event_id,original_submitted_at:intent.submitted_at,
    event_id:'observed-outbound:id_'+full,dom_id:'id_'+full,native_message_id:'jarvis-msg-'+full,native_message_raw_id:raw,
    type:'OUTBOUND_OBSERVED',source:'platform_ui',timestamp_source:'platform_ui',native_message_type:'TEXT',native_direction:'right',historical_baseline:false,
    platform_timestamp_ms:candidateMs,detected_at:submittedMs/1000+3.46,observed_at:submittedMs/1000+3.46,text};
  const m={intent,anchor,messages:[candidate,newer],refreshes:0,reconciles:[],history:[],serverRows:[],menus:0,scopeUID:U};
  options.mutate?.(m,candidate);options.mutateAnchor?.(anchor);
  const page=new EventEmitter(),api=history.attach(page);
  const scope=()=>({scope_ready:true,account_scope_verified:true,conversation_scope_verified:true,account_id:A,conversation_id:m.scopeUID,
    observed_at_utc:new Date().toISOString(),messages:m.messages});
  const client={request:async(method,params)=>{
    if(method==='status')return {ok:true,result:{account_scope:A,outbox:[intent]}};
    assert.equal(method,'reconcile');m.reconciles.push(params);assert.equal(params.intent_id,intent.intent_id);assert.equal(params.result,'sent');intent.status='SENT';
    return {ok:true,result:{status:'SENT'}};
  }};
  const deps={'./ui_engine.cjs':{getClient:()=>client},'./native_history_receipt.cjs':{attach:()=>({verify:params=>{m.history.push(params);return api.verify(params);}})}};
  const module={exports:{}},wrapped=vm.runInNewContext('(function(exports,require,module,__filename,__dirname){\n'+fs.readFileSync(file,'utf8')+'\n})',
    {process,Buffer,URL,setTimeout,clearTimeout,console,globalThis:{}},{filename:file});
  wrapped(module.exports,name=>deps[name] || real(name),module,file,path.dirname(file));
  async function refreshHistory(){
    m.refreshes++;if(options.forbidReload&&m.preloaded)throw Error('native_reload_must_not_run_after_fresh_exact_history');if(options.noHistory)return;
    const rows=m.messages.filter(row=>row.direction==='right').map(row=>({sixin_message:{id:row.native_dom_id.slice(11),sender_id:A,receiver_id:U,
      message_type:'TEXT',created_at:Number(row.raw_timestamp),content:text},message_extension:{customer_user_id:U}}));
    options.mutateServer?.(rows);m.serverRows=rows;
    const request={url:()=> 'https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg?customer_user_id='+U,method:()=> 'GET',response:async()=>({status:()=>200,
      body:async()=>Buffer.from(JSON.stringify({success:true,code:0,data:{messages:rows}}))})};
    m.serverRequestAt=Date.now();page.emit('request',request);page.emit('requestfinished',request);
    const deadline=Date.now()+500;while(!api.records().length){if(Date.now()>deadline)throw Error('fixture_history_timeout');await delay(1);}
  }
  const run=async extra=>{m.verificationStartedAt??=Date.now();if(options.existingHistory&&!m.preloaded){await refreshHistory();m.preloaded=true;m.refreshes=0;if(options.beforeMaintenance){m.verificationStartedAt=Date.now()+2;await delay(3);}}return module.exports.reconcileAndComplete({page,runtime:'/unused-synthetic',uid:U,currentScope:async()=>scope(),refreshHistory,
    openCardMenu:async()=>{m.menus++;throw Error('card_or_customer_send_forbidden');},reconcileOnly:true,expectedIntentId:intent.intent_id,
    expectedNativeMessageId:null,expectedRawId:null,originalVerificationStartedAtMs:m.verificationStartedAt,allowOriginalTextIdRecovery:true,originalTextRecoveryAnchor:options.noAnchor?undefined:anchor,...extra});};
  try{await check({m,run,candidate,submittedMs});}finally{api.detach();}
}
async function freshStrictOriginalHistoryConfirmsBeforeAnyNativeReload(){await fixture({existingHistory:true,forbidReload:true},async({m,run})=>{
  const result=await run();assert.equal(result.status,'SENT');assert.equal(m.refreshes,0);assert.equal(m.reconciles.length,1);assert.equal(m.history.length,1);
  assert.equal(m.menus,0);assert.equal(m.reconciles[0].evidence.native_server_history.request_started_at_ms,m.serverRequestAt);
});}
async function strictHistoryFromBeforeThisMaintenanceLeaseRequiresOneFreshRead(){await fixture({existingHistory:true,beforeMaintenance:true},async({m,run})=>{const result=await run();assert.equal(result.status,'SENT');assert.equal(m.refreshes,1);assert(m.reconciles[0].evidence.native_server_history.request_started_at_ms>=m.verificationStartedAt);});
  await fixture({existingHistory:true,beforeMaintenance:true,forbidReload:true},async({m,run})=>{await assert.rejects(run(),/native_reload_must_not_run/);assert.equal(m.reconciles.length,0);assert.equal(m.intent.status,'UNKNOWN');});}
async function exactLegacyOriginalTextCanRecoverOnlyItsMissingNativeIdentity(){await fixture({fractional:true},async({m,run,candidate})=>{
  const result=await run();assert.equal(result.status,'SENT');assert.equal(result.customer_send_performed,false);assert.equal(m.reconciles.length,1);assert.equal(m.menus,0);
  const proof=m.reconciles[0].evidence;assert.equal(proof.native_message_raw_id,candidate.message_id);assert.equal(proof.native_message_id,candidate.native_dom_id);
  assert.equal(proof.native_server_history.status,'server_history_confirmed');assert.equal(proof.native_message_id_recovery.old_outbound_event.reference,candidate.dom_id);
  assert.equal(proof.native_message_id_recovery.old_outbound_event.native_direction,'right');assert.equal(proof.native_message_id_recovery.confirms_program_actor,false);
  assert.equal(proof.original_unknown_reason,m.intent.evidence.reason);assert.equal(proof.usefulness_verified,undefined);assert.equal(m.history[0].nativeMessageId,candidate.native_dom_id.slice(11));
  assert.equal(m.history[0].uiTimestampMs,Number(candidate.raw_timestamp));assert.equal(m.intent.source_event_id,'id_'+U+'.'+A+'.old-question');
});}
async function recoveryWindowIsClosedAndCannotAdoptLaterSameText(){
  for(const delta of [0,2500])await fixture({delta},async({run})=>assert.equal((await run()).status,'SENT'));
  for(const delta of [-1,2501])await fixture({delta},async({m,run})=>{await assert.rejects(run(),/recovery|unique_original/);assert.equal(m.reconciles.length,0);assert.equal(m.intent.status,'UNKNOWN');});
}
async function ambiguousOrAttributedOrForeignCandidatesCannotRecover(){
  for(const mutate of [m=>m.messages.push({...m.messages[0],message_id:'second',dom_id:'id_'+A+'.'+U+'.second',native_dom_id:'jarvis-msg-'+A+'.'+U+'.second'}),
    (_m,c)=>c.direction='left',(_m,c)=>c.raw_type='CARD',(_m,c)=>c.raw_text='different text',(_m,c)=>c.account_id=V,
    (_m,c)=>c.native_dom_id='jarvis-msg-'+A+'.'+V+'.original-candidate',(_m,c)=>c.native_ai_attribution_observed=true,(_m,c)=>c.native_system_attribution_observed=true])
    await fixture({mutate},async({m,run})=>{await assert.rejects(run(),/recovery|unique_original/);assert.equal(m.reconciles.length,0);assert.equal(m.intent.status,'UNKNOWN');assert.equal(m.menus,0);});
}
async function nativeHistoryStillRequiresEveryExactScopeContentTypeAndTimeField(){
  for(const mutateServer of [rows=>rows[0].sixin_message.sender_id=V,rows=>rows[0].sixin_message.receiver_id=V,rows=>rows[0].message_extension.customer_user_id=V,
    rows=>rows[0].sixin_message.message_type='CARD',rows=>rows[0].sixin_message.created_at++,rows=>rows[0].sixin_message.content='different',rows=>rows[0].sixin_message.id=A+'.'+U+'.another'])
    await fixture({mutateServer},async({m,run})=>{await assert.rejects(run(),/original_operation_still_unknown/);assert.equal(m.reconciles.length,0);assert.equal(m.intent.status,'UNKNOWN');assert.equal(m.menus,0);});
  await fixture({noHistory:true},async({m,run})=>{await assert.rejects(run(),/original_operation_still_unknown/);assert.equal(m.reconciles.length,0);});
}
async function missingIdRecoveryRequiresExplicitExactOriginalIntentAndReadOnlyMode(){
  for(const extra of [{allowOriginalTextIdRecovery:false},{reconcileOnly:false},{expectedIntentId:undefined},{expectedIntentId:'other-intent'}])
    await fixture({},async({m,run})=>{await assert.rejects(run(extra),/original_native|recovery|original_reconciliation_intent_mismatch|one_exact_unknown_intent_required/);assert.equal(m.reconciles.length,0);assert.equal(m.menus,0);});
  for(const mutate of [m=>m.intent.evidence.native_message_raw_id='known-raw',m=>m.intent.evidence.native_message_id='jarvis-msg-'+A+'.'+U+'.known',m=>m.intent.payload.operation='native_card'])
    await fixture({mutate},async({m,run})=>{await assert.rejects(run(),/original_native|recovery|original_reconciliation_intent_mismatch|one_exact_unknown_intent_required/);assert.equal(m.reconciles.length,0);assert.equal(m.menus,0);});
}
async function durableOriginalOutboundAnchorIsMandatoryAndCannotBeRebound(){
  await fixture({noAnchor:true},async({m,run})=>{await assert.rejects(run(),/durable_anchor/);assert.equal(m.reconciles.length,0);});
  for(const mutateAnchor of [a=>a.bound_to_other_intent=true,a=>a.original_intent_id='different-intent',a=>a.original_source_event_id='later-question',a=>a.native_direction='left',
    a=>a.historical_baseline=true,a=>a.account_id=V,a=>a.event_id='invented',a=>a.detected_at+=60,a=>a.text='different'])
    await fixture({mutateAnchor},async({m,run})=>{await assert.rejects(run(),/durable_anchor/);assert.equal(m.reconciles.length,0);assert.equal(m.intent.status,'UNKNOWN');});
}

(async()=>{const tests=[strictHistoryFromBeforeThisMaintenanceLeaseRequiresOneFreshRead,freshStrictOriginalHistoryConfirmsBeforeAnyNativeReload,durableOriginalOutboundAnchorIsMandatoryAndCannotBeRebound,exactLegacyOriginalTextCanRecoverOnlyItsMissingNativeIdentity,recoveryWindowIsClosedAndCannotAdoptLaterSameText,
  ambiguousOrAttributedOrForeignCandidatesCannotRecover,nativeHistoryStillRequiresEveryExactScopeContentTypeAndTimeField,missingIdRecoveryRequiresExplicitExactOriginalIntentAndReadOnlyMode];
  for(const test of tests){await test();console.log('PASS '+test.name);}console.log(tests.length+' isolated legacy missing-ID recovery regressions passed; no production evidence generated.');
})().catch(error=>{console.error(error);process.exitCode=1;});
