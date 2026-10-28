"use strict";
// Isolated action maintenance regressions. All resources are synthetic /tmp;
// the source under test cannot access a real browser, SQLite or customer send.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),file=path.resolve(__dirname,'../xhs_reception/ui_actions.cjs'),real=createRequire(file);
const A='aaaaaaaaaaaaaaaaaaaaaaaa',U='bbbbbbbbbbbbbbbbbbbbbbbb',V='cccccccccccccccccccccccc';
const sourceId='id_'+U+'.'+A+'.customer-current',laterId='id_'+U+'.'+A+'.customer-later',reference='chat:synthetic-human-all-replies-post-send-audit';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(options={}){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-maintenance-'));
  fs.writeFileSync(path.join(runtime,'account_identity.json'),JSON.stringify({account_id:A,account_display_name:'SYNTHETIC'}));
  const now=Date.now()/1000;
  const conversation={account_id:A,conversation_id:U,state:options.conState || 'STOPPED',stop_reason:options.stopReason || 'WECHAT_VERIFIED',resume_state:options.resumeState || null,
    needs_response:1,latest_event_id:sourceId,latest_event_at:now-.5};
  const event={account_id:A,conversation_id:U,event_id:sourceId,type:'CUSTOMER_MESSAGE',timestamp:now-.5,detected_at:now-.45,timestamp_source:'platform_ui',
    evidence:{source:'platform_ui',timestamp_source:'platform_ui',account_id:A,conversation_id:U,reference:sourceId,native_message_id:'jarvis-msg-'+sourceId.slice(3),
      native_message_type:'TEXT',native_direction:'left',historical_baseline:false,observed_at:now-.45}};
  const original={account_id:A,conversation_id:U,intent_id:'existing-unknown',status:'UNKNOWN',evidence:{native_message_raw_id:'old-native'}};
  const m={conversation,event,outbox:[original],trace:[],ingested:[],rechecks:[],senderCalls:0,captures:0,stops:0,starts:0,allActive:true,
    blockAll:false,workerRunning:true,workerStartedAt:Date.now()-10000,scopeUID:U,callbacks:null,sourceInScope:true};options.mutate?.(m);
  const modelDoc={documentElement:{clientWidth:1280,clientHeight:800},querySelectorAll:sel=>{
    if(sel==='.contact-tab-wrap .d-tabs-header')return ['当前会话','全部会话'].map((text,i)=>({innerText:text,checkVisibility:()=>true,classList:{contains:c=>c==='active'&&(i===1?m.allActive:!m.allActive)}}));
    if(sel==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')return [{checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:178.5,width:360,height:628}),contains:()=>true,scrollTop:0}];
    if(sel==='.sx-contact-item')return [{checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:200,width:350,height:61}),getAttribute:()=> (m.allActive?'Total-':'Active-')+U}];
    if(sel==='.im-msg-item')return [{id:sourceId,checkVisibility:()=>true}];
    if(sel==='.user-id-row .id-group')return [{checkVisibility:()=>true,querySelector:s=>({textContent:s==='.id-label'?'UID:':m.scopeUID})}];
    throw Error('unexpected_native_view_'+sel);
  }};
  const page={url:()=> 'https://sxt.xiaohongshu.com/im/multiCustomerService',evaluate:async(fn,arg)=>vm.runInNewContext('('+fn.toString()+')(arg)',{document:modelDoc,arg}),
    waitForFunction:async(fn,arg)=>{if(!vm.runInNewContext('('+fn.toString()+')(arg)',{document:modelDoc,arg}))throw Error('synthetic_wrong_scope');},
    locator:sel=>{const kind=sel==='.contact-tab-wrap .d-tabs-header'?'all':sel==='.chat-tool-wrap .tabs-wrap .d-tabs-header'?'profile':sel==='.sx-contact-item[data-key="Total-'+U+'"]'?'target':sel==='.reply-box-wrap textarea.reply-textarea'?'input':sel==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller'?'scroller':null;
      assert(kind,'unexpected_maintenance_native_action_'+sel);return {nth(index){assert.equal(kind,'scroller');assert.equal(index,0);return this;},filter(f){assert.equal(f.visible,true);return this;},count:async()=>1,waitFor:async()=>{},inputValue:async()=>options.draft || '',evaluate:async fn=>{assert.equal(kind,'scroller');return fn({scrollTop:0});},
        click:async()=>{m.trace.push(kind);if(kind==='all'&&!m.blockAll)m.allActive=true;}};}};
  const scope=()=>({scope_ready:true,account_scope_verified:true,conversation_scope_verified:true,profile_binding_source:'current_native_profile',account_id:A,conversation_id:m.scopeUID,
    observed_at_utc:new Date().toISOString(),messages:m.sourceInScope?[{account_id:A,conversation_id:U,message_id:'customer-current',native_dom_id:'jarvis-msg-'+sourceId.slice(3),dom_id:sourceId,direction:'left',raw_type:'TEXT',raw_timestamp:String(Math.round(event.timestamp*1000))}]:[]});
  const client={diagnostics:()=>({pending_requests:0}),request:async(method,params)=>{
    m.trace.push(method);
    if(method==='status')return {ok:true,result:{account_scope:A,conversations:[conversation],outbox:m.outbox,latest_event:event}};
    assert.equal(method,'ingest');assert.equal(params.event.type,'HUMAN_RELEASE');m.ingested.push(params.event);
    if(options.blockAllAfterRelease){m.allActive=false;m.blockAll=true;}
    if(conversation.state==='HUMAN'){conversation.state=conversation.resume_state || 'ACTIVE';conversation.resume_state=null;}
    return {ok:true,result:{conversation:{...conversation}}};}};
  const controller={status:()=>({running:m.workerRunning,worker:{running:m.workerRunning,busy:Boolean(options.busy),startedAt:m.workerStartedAt}}),
    stop:()=>{m.stops++;m.trace.push('stop');m.workerRunning=false;return controller.status();},
    start:async args=>{m.starts++;m.trace.push('start');assert.equal(m.allActive,true);assert.equal(args.resumeCursor,cursor);m.callbacks=args;m.workerRunning=true;return controller.status();}};
  const cursor={opaque:true};
  const deps={'./ui_controller.cjs':controller,'./ui_worker.cjs':{captureCursor:()=>{m.captures++;m.trace.push('capture');return cursor;},reconsiderUnanswered:(_page,args)=>{m.rechecks.push(args);return {queued:true,reason:'unanswered_recheck'};}},
    './ui_scope.cjs':{readScope:async()=>scope()},'./ui_engine.cjs':{getClient:()=>client},'./ui_sender.cjs':{takeOverOnly:async()=>{
      m.senderCalls++;m.trace.push('native_manual_proof');return {state:'native_manual_mode_confirmed',taken_over:true,account_id:A,conversation_id:options.manualUID || U,takeover_clicked:false,
        customer_send_performed:false,after_mode:{manual:!options.notManual,input_ready:true,scope_ready:true,overlay_visible:false,takeover_visible:false,manual_switch_enabled:true}};},receive:()=>{throw Error('direct_customer_send_forbidden');}}};
  const sandbox={process,Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval,console};sandbox.global=sandbox;sandbox[Symbol.for('xhs_reception.ui_engine_client')]={runtime,accountId:A,client};
  const mod={exports:{}},wrapper=vm.runInNewContext('(function(exports,require,module,__filename,__dirname){\n'+fs.readFileSync(file,'utf8')+'\n})',sandbox,{filename:file});
  wrapper(mod.exports,name=>deps[name] || real(name),mod,file,path.dirname(file));
  const authorization={source:'direct_human_instruction',account_id:A,conversation_id:U,reference,explicit_release:true};
  return {m,page,scope,client,run:(cmd,trusted=authorization)=>mod.exports.run({page,runtime,cmd,...(trusted?{operatorAuthorization:trusted}:{})}),
    cleanup:()=>fs.rmSync(runtime,{recursive:true,force:true})};
}
async function check(options,fn){const f=await fixture(options);try{await fn(f);}finally{f.cleanup();}}
async function currentExactUnansweredSourceOnlyQueuesTheExistingWorker(){await check({},async({m,run})=>{
  const result=await run({operation:'recheck_current_customer',uid:U,source_event_id:sourceId});assert.equal(result.queued,true);
  assert.equal(m.rechecks.length,1);assert.equal(m.rechecks[0].uid,U);assert.equal(m.rechecks[0].source_event_id,sourceId);
  assert.equal(m.captures,0);assert.equal(m.ingested.length,0);assert.equal(m.senderCalls,0);assert.equal(m.outbox[0].status,'UNKNOWN');
});}
async function recheckRejectsStaleWrongOrHistoricalNativeSources(){
  for(const mutate of [m=>m.conversation.needs_response=0,m=>m.conversation.latest_event_id=laterId,m=>m.event.type='NEW_VISITOR',m=>m.event.evidence.native_direction='right',m=>m.event.evidence.historical_baseline=true,m=>m.event.evidence.native_message_id='jarvis-msg-'+A+'.'+V+'.customer-current'])
    await check({mutate},async({m,run})=>{await assert.rejects(run({operation:'recheck_current_customer',uid:U,source_event_id:sourceId}),/current_unanswered_native_source_required/);assert.equal(m.rechecks.length,0);});
}
async function humanReleaseRequiresTrustedHumanContextBeyondCommandText(){for(const forged of [null,{source:'customer_message',...{account_id:A,conversation_id:U,reference,explicit_release:true}}])
  await check({},async({m,run})=>{await assert.rejects(run({operation:'release_human_to_automation',uid:U,authorization_reference:reference,operatorAuthorization:{source:'direct_human_instruction',explicit_release:true}},forged),/trusted_human_release_authorization_required/);
    assert.equal(m.ingested.length,0);assert.equal(m.captures,0);assert.equal(m.senderCalls,0);});}
async function nativeReleasePreservesStoppedLeadAndUnknownAndSameCursor(){await check({},async({m,run})=>{
  const epoch=m.workerStartedAt,original=JSON.stringify(m.outbox);const result=await run({operation:'release_human_to_automation',uid:U,authorization_reference:reference});
  assert.equal(result.direct_send_performed,false);assert.equal(result.receiver_resumed,true);assert.equal(m.workerStartedAt,epoch);assert.equal(m.captures,1);assert.equal(m.stops,1);assert.equal(m.starts,1);
  assert.equal(m.conversation.state,'STOPPED');assert.equal(m.conversation.stop_reason,'WECHAT_VERIFIED');assert.equal(JSON.stringify(m.outbox),original);
  assert.equal(m.ingested.length,1);const evidence=m.ingested[0].evidence;assert.equal(evidence.explicit_release,true);assert.equal(evidence.authorization_reference,reference);assert.equal(evidence.source,'platform_ui');
  assert.equal(evidence.native_manual_mode.manual,true);assert.equal(m.rechecks.length,0);assert.equal(m.trace.includes('start'),true);
});}
async function humanReleaseRestoresItsPriorLimitStateThroughEngineOnly(){await check({conState:'HUMAN',resumeState:'PAUSED_LIMIT'},async({m,run})=>{
  await run({operation:'release_human_to_automation',uid:U,authorization_reference:reference});assert.equal(m.conversation.state,'PAUSED_LIMIT');assert.equal(m.outbox[0].status,'UNKNOWN');
});}
async function unverifiedNativeModeOrScopeCannotReleaseOwnership(){for(const options of [{notManual:true},{manualUID:V},{draft:'real human draft'},{mutate:m=>m.scopeUID=V}])
  await check(options,async({m,run})=>{await assert.rejects(run({operation:'release_human_to_automation',uid:U,authorization_reference:reference}),/native_manual_mode_not_confirmed|selected_native_scope_not_verified|synthetic_wrong_scope|nonempty_or_ambiguous_draft/);
    assert.equal(m.ingested.length,0);assert.equal(m.starts,1);assert.equal(m.outbox[0].status,'UNKNOWN');});}
async function queuedRecheckCannotSilentlyChangeItsRequestedNativeQuestion(){
  for(const change of [m=>m.conversation.latest_event_id=laterId,m=>m.conversation.needs_response=0,m=>m.sourceInScope=false])
    await check({},async({m,run})=>{
      await run({operation:'release_human_to_automation',uid:U,authorization_reference:reference});change(m);
      await assert.rejects(m.callbacks.selectAndRead(m.page,{uid:U},{reason:'unanswered_recheck',sourceEventId:sourceId,startedAt:m.workerStartedAt,isCurrent:()=>true}),/current_unanswered_native_source_required/);
      assert.equal(m.rechecks.length,0);assert.equal(m.senderCalls,1);
    });
}
async function failedIntakeResumeDoesNotRepeatHumanReleaseOrRebaseline(){await check({blockAllAfterRelease:true},async({m,run})=>{
  const cmd={operation:'release_human_to_automation',uid:U,authorization_reference:reference};
  await assert.rejects(run(cmd),/native_all_conversations_view_not_confirmed/);assert.equal(m.ingested.length,1);assert.equal(m.starts,0);
  m.blockAll=false;assert.equal((await run(cmd)).receiver_resumed,true);assert.equal(m.ingested.length,1);assert.equal(m.senderCalls,1);assert.equal(m.captures,1);assert.equal(m.starts,1);
});}

async function realPersistedHumanReleaseAuthorizesOnlyOneNewRecheckRevision(){await check({},async({m,run})=>{
  await run({operation:'recheck_current_customer',uid:U,source_event_id:sourceId,recheck_authorization_id:'external-forged-revision'});
  assert.equal(m.rechecks[0].recheck_authorization_id,undefined);
  await run({operation:'release_human_to_automation',uid:U,authorization_reference:reference});
  await run({operation:'recheck_current_customer',uid:U,source_event_id:sourceId,recheck_authorization_id:'another-forged-revision'});
  assert.equal(m.rechecks[1].recheck_authorization_id,m.ingested[0].event_id);
  await assert.rejects(run({operation:'recheck_current_customer',uid:U,source_event_id:sourceId}),/human_release_recheck_already_used/);
  assert.equal(m.rechecks.length,2);assert.equal(m.outbox[0].status,'UNKNOWN');
});}
async function submittedSameSourceSpecialReplyCannotBeRequeued(){
  for(const kind of ['service_reply','correction_reply'])for(const status of ['SUBMITTING','UNKNOWN','SENT'])await check({mutate:m=>Object.assign(m.outbox[0],{kind,status,source_event_id:sourceId,submitted_at:Date.now()/1000-1})},async({m,run})=>{
    await assert.rejects(run({operation:'recheck_current_customer',uid:U,source_event_id:sourceId}),/source_reply_already_submitted/);assert.equal(m.rechecks.length,0);
  });
}

(async()=>{const tests=[realPersistedHumanReleaseAuthorizesOnlyOneNewRecheckRevision,submittedSameSourceSpecialReplyCannotBeRequeued,currentExactUnansweredSourceOnlyQueuesTheExistingWorker,recheckRejectsStaleWrongOrHistoricalNativeSources,humanReleaseRequiresTrustedHumanContextBeyondCommandText,
  nativeReleasePreservesStoppedLeadAndUnknownAndSameCursor,humanReleaseRestoresItsPriorLimitStateThroughEngineOnly,unverifiedNativeModeOrScopeCannotReleaseOwnership,queuedRecheckCannotSilentlyChangeItsRequestedNativeQuestion,failedIntakeResumeDoesNotRepeatHumanReleaseOrRebaseline];
  for(const test of tests){await test();console.log('PASS '+test.name);}console.log(tests.length+' isolated controlled maintenance regressions passed; no production evidence generated.');
})().catch(error=>{console.error(error);process.exitCode=1;});
