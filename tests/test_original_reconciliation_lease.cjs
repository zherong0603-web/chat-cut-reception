"use strict";
// Actual action dispatch and opaque worker cursor, /tmp-only protocol/native UI
// fixtures. This suite never opens a real account, browser or business DB.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const file=path.resolve(__dirname,'../xhs_reception/ui_actions.cjs'),real=createRequire(file),workerPath=real.resolve('./ui_worker.cjs');
const A='aaaaaaaaaaaaaaaaaaaaaaaa',U='bbbbbbbbbbbbbbbbbbbbbbbb',V='cccccccccccccccccccccccc';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(options={}) {
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-original-reconciliation-'));
  fs.writeFileSync(path.join(runtime,'account_identity.json'),JSON.stringify({account_id:A,account_display_name:'SYNTHETIC'}));
  const original={intent_id:'original-intent',account_id:A,conversation_id:U,status:'UNKNOWN',submitted_at:Date.now()/1000-10,
    payload:{operation:options.operation || 'native_card',text:'SYNTHETIC'},evidence:{native_message_raw_id:'original-native',native_message_id:'jarvis-msg-'+A+'.'+U+'.original-native'}};
  const other={intent_id:'untouched-other-unknown',account_id:A,conversation_id:U,status:options.otherStatus || 'UNKNOWN',payload:{operation:'text',text:'do not resend'},evidence:{reason:'original other hold'}};
  const m={original,other,trace:[],captures:0,stops:0,starts:0,reconciles:0,sends:0,allActive:true,profileVisible:false,uid:V,
    blockAll:false,failReconciliation:Boolean(options.failReconciliation),conState:options.conState || 'HUMAN',pending:options.pending || 0};
  options.mutate?.(m);
  const document={documentElement:{clientWidth:1280,clientHeight:800},querySelectorAll:selector=>{
    if(selector==='.contact-tab-wrap .d-tabs-header')return ['当前会话','全部会话'].map((text,index)=>({innerText:text,checkVisibility:()=>true,classList:{contains:cls=>cls==='active'&&(index===1?m.allActive:!m.allActive)}}));
    if(selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')return [{checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:178.5,width:360,height:628}),contains:()=>true,scrollTop:0}];
    if(selector==='.sx-contact-item')return [{checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:200,width:350,height:61}),getAttribute:()=> (m.allActive?'Total-':'Active-')+U}];
    if(selector==='.sx-contact-item.active')return [{checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:200,width:350,height:61}),getAttribute:()=> 'Total-'+m.uid}];
    if(selector==='.user-id-row .id-group')return m.profileVisible?[{checkVisibility:()=>true,querySelector:sel=>({textContent:sel==='.id-label'?'UID:':m.uid})}]:[];
    if(selector==='.im-msg-item')return [{id:'id_'+A+'.'+m.uid+'.original-native',checkVisibility:()=>true}];
    throw Error('unexpected_fixture_dom_'+selector);
  }};
  const page={url:()=> 'https://sxt.xiaohongshu.com/im/multiCustomerService',
    evaluate:async(fn,arg)=>vm.runInNewContext('('+fn.toString()+')(arg)',{document,arg}),
    waitForFunction:async(fn,arg)=>{if(!vm.runInNewContext('('+fn.toString()+')(arg)',{document,arg}))throw Error('synthetic_native_view_not_ready');},
    locator:selector=>{
      const kind=selector==='.chat-tool-wrap .tabs-wrap .d-tabs-header'?'profile':selector==='.sx-contact-item[data-key="Total-'+U+'"]'?'target':
        selector==='.contact-tab-wrap .d-tabs-header'?'all':selector==='.reply-box-wrap textarea.reply-textarea'?'input':selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller'?'scroller':null;
      assert(kind,'forbidden_or_unexpected_native_action_'+selector);
      return {nth(index){assert.equal(kind,'scroller');assert.equal(index,0);return this;},filter(filter){assert.equal(filter.visible,true);return this;},waitFor:async()=>{},count:async()=>{if(kind==='profile'&&options.cancelDuringProfileCount&&!m.cancelledAtProfileCount){m.cancelledAtProfileCount=true;await module.exports.run({page,runtime,cmd:{operation:'stop_reception_worker'}});}return 1;},inputValue:async()=> options.draft || '',evaluate:async fn=>{assert.equal(kind,'scroller');return fn({scrollTop:0});},
        click:async args=>{assert.equal(args.force,undefined);m.trace.push(kind);
          if(kind==='profile')m.profileVisible=true;if(kind==='target')m.uid=U;if(kind==='all'&&!m.blockAll)m.allActive=true;}};
    }};
  const worker=real(workerPath);
  await worker.start(page,{readSidebar:async()=>({rows:[{uid:U,time:'fixture',content:'UNCHANGED'}]}),selectAndRead:async()=>({}),processScope:async()=>({ok:true})});
  m.startedAt=worker.status(page).startedAt;
  const controller={status:()=>({running:worker.status(page).running,worker:{...worker.status(page),...(options.busy?{busy:true}:{})}}),
    stop:()=>{m.stops++;m.trace.push('stop');worker.stop(page);return controller.status();},
    start:async args=>{m.starts++;m.trace.push('start');assert.equal(m.allActive,true);
      const started=await worker.start(page,{resumeCursor:args.resumeCursor,readSidebar:async()=>({rows:[{uid:U,time:'fixture',content:'UNCHANGED'}]}),selectAndRead:async()=>({}),processScope:async()=>({ok:true})});
      return {running:started.running,worker:started};}};
  const client={diagnostics:()=>({pending_requests:m.pending}),request:async(method,params)=>{
    assert.equal(method,'status');assert([U,V].includes(params.conversation_id));m.trace.push('status');
    return {ok:true,result:{account_scope:A,conversations:[{account_id:A,conversation_id:U,state:m.conState}],outbox:[original,...(options.otherUnknown?[other]:[])]}};}};
  const sender={primeCardIdentity:()=>{throw Error('must_not_reprime_target_unknown');},receive:()=>{m.sends++;throw Error('send_forbidden');},reconcileAndComplete:async args=>{
    m.reconciles++;m.trace.push('reconcile');assert.equal(args.reconcileOnly,true);assert(Number.isSafeInteger(args.originalVerificationStartedAtMs)&&args.originalVerificationStartedAtMs>=m.startedAt&&args.originalVerificationStartedAtMs<=Date.now());assert.equal(args.expectedIntentId,original.intent_id);
    assert.equal(args.expectedNativeMessageId,original.evidence.native_message_id);assert.equal(args.expectedRawId,original.evidence.native_message_raw_id);
    assert.equal(args.uid,U);if(options.blockAllAfterReconcile){m.allActive=false;m.blockAll=true;}
    if(options.cancelDuringReconciliation)await module.exports.run({page,runtime,cmd:{operation:'stop_reception_worker'}});
    if(m.failReconciliation)throw Error('synthetic_strict_history_unconfirmed');
    if(options.modifyOtherDuringReconcile)other.evidence.changed=true;
    original.status='SENT';return {original_intent:original.intent_id,status:'SENT',customer_send_performed:false};}};
  const deps={'./ui_controller.cjs':controller,'./ui_worker.cjs':{...worker,captureCursor:p=>{m.captures++;m.trace.push('capture');return worker.captureCursor(p);}},
    './ui_engine.cjs':{getClient:()=>client},'./ui_sender.cjs':sender,'./ui_scope.cjs':{readScope:async()=>({scope_ready:true,account_scope_verified:true,conversation_scope_verified:true,
      profile_binding_source:'current_native_profile',account_id:A,conversation_id:m.uid,observed_at_utc:new Date().toISOString(),messages:[]})}};
  const sandbox={process,Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval,console};sandbox.global=sandbox;
  sandbox[Symbol.for('xhs_reception.ui_engine_client')]={runtime,accountId:A,client};
  const module={exports:{}},wrapped=vm.runInNewContext('(function(exports,require,module,__filename,__dirname){\n'+fs.readFileSync(file,'utf8')+'\n})',sandbox,{filename:file});
  wrapped(module.exports,name=>deps[name] || real(name),module,file,path.dirname(file));
  return {m,page,worker,run:extra=>module.exports.run({page,runtime,cmd:{operation:'reconcile_original_operation',uid:U,intent_id:original.intent_id,native_message_raw_id:'original-native',...extra}}),
    cleanup:async()=>{worker.stop(page);await delay(0);fs.rmSync(runtime,{recursive:true,force:true});}};
}
async function check(options,fn){const f=await fixture(options);try{await fn(f);}finally{await f.cleanup();}}
async function exactTextOrCardOnlyReconcilesOriginalAndResumesOpaqueCursor(){
  for(const operation of ['text','native_card'])await check({operation},async({m,page,worker,run})=>{
    const result=await run({reconcile_only:false});assert.equal(result.original_operation.status,'SENT');assert.equal(result.direct_send_performed,false);
    assert.equal(result.receiver_resumed,true);assert.equal(result.receiver_may_process_pending_entries,true);
    assert.equal(m.reconciles,1);assert.equal(m.sends,0);assert.equal(m.captures,1);assert.equal(m.stops,1);assert.equal(m.starts,1);
    assert.equal(worker.status(page).startedAt,m.startedAt);assert.equal(m.conState,'HUMAN');
  });
}
async function foreignOrChangedOriginalCannotBeginLease(){
  for(const extra of [{intent_id:'another-intent'},{native_message_raw_id:'later-human-card'},{uid:V}])await check({},async({m,run})=>{
    await assert.rejects(run(extra),/original_reconciliation_|idle_reconciliation_/);assert.equal(m.captures,0);assert.equal(m.sends,0);assert.equal(m.original.status,'UNKNOWN');
  });
  for(const mutate of [m=>m.original.account_id=V,m=>m.original.conversation_id=V,m=>m.original.status='SENT',m=>m.original.evidence.native_message_id='jarvis-msg-'+A+'.'+V+'.original-native'])
    await check({mutate},async({m,run})=>{await assert.rejects(run(),/original_reconciliation_/);assert.equal(m.captures,0);assert.equal(m.reconciles,0);});
}
async function pendingOrBusyCannotBorrowBrowser(){for(const options of [{busy:true},{pending:1}])await check(options,async({m,run})=>{
  await assert.rejects(run(),/idle_reconciliation_|idle_bound_engine_/);assert.equal(m.captures,0);assert.equal(m.stops,0);
});}
async function strictFailureKeepsUnknownButRestoresAllAndSameCursor(){await check({failReconciliation:true},async({m,page,worker,run})=>{
  await assert.rejects(run(),/synthetic_strict_history_unconfirmed/);assert.equal(m.original.status,'UNKNOWN');assert.equal(m.sends,0);assert.equal(m.starts,1);
  assert.equal(worker.status(page).running,true);assert.equal(worker.status(page).startedAt,m.startedAt);assert.equal(m.allActive,true);
});}
async function intakeRestoreFailureCanOnlyResumeTheSameLeaseWithoutReconciliationReplay(){await check({blockAllAfterReconcile:true},async({m,page,worker,run})=>{
  await assert.rejects(run(),/native_all_conversations_view_not_confirmed/);assert.equal(m.reconciles,1);assert.equal(m.captures,1);assert.equal(m.starts,0);
  await assert.rejects(run({native_message_raw_id:'later-human-card'}),/original_reconciliation_lease_binding_mismatch/);
  m.blockAll=false;const result=await run();assert.equal(result.receiver_resumed,true);assert.equal(m.reconciles,1);assert.equal(m.captures,1);
  assert.equal(m.sends,0);assert.equal(worker.status(page).startedAt,m.startedAt);assert.equal(worker.status(page).running,true);
});}
async function explicitStopCancelsLeaseWithoutResumingOrLosingItsHold(){await check({cancelDuringReconciliation:true,failReconciliation:true},async({m,run,worker,page})=>{
  await assert.rejects(run(),/original_reconciliation_lease_cancelled/);assert.equal(m.starts,0);assert.equal(m.original.status,'UNKNOWN');assert.equal(m.sends,0);
  assert.equal(worker.status(page).running,false);await assert.rejects(run(),/original_reconciliation_lease_not_resumable/);assert.equal(m.captures,1);
});}

async function stopDuringNativeSelectionCannotClickAfterLeaseCancellation(){await check({cancelDuringProfileCount:true},async({m,run})=>{
  await assert.rejects(run(),/original_reconciliation_lease_cancelled|reception_round_cancelled/);
  assert(!m.trace.includes('profile'));assert(!m.trace.includes('target'));assert.equal(m.reconciles,0);assert.equal(m.sends,0);assert.equal(m.starts,0);
});}

async function exactMaintenanceTargetDoesNotResolveOrChangeAnotherUnknown(){await check({otherUnknown:true},async({m,run})=>{
  const old=JSON.stringify(m.other);assert.equal((await run()).original_operation.status,'SENT');
  assert.equal(m.reconciles,1);assert.equal(JSON.stringify(m.other),old);assert.equal(m.other.status,'UNKNOWN');assert.equal(m.sends,0);
});
  await check({otherUnknown:true,modifyOtherDuringReconcile:true},async({m,run})=>{
    await assert.rejects(run(),/reconciliation_other_outbox_changed/);assert.equal(m.starts,1);assert.equal(m.sends,0);
  });
}

(async()=>{const tests=[exactMaintenanceTargetDoesNotResolveOrChangeAnotherUnknown,exactTextOrCardOnlyReconcilesOriginalAndResumesOpaqueCursor,foreignOrChangedOriginalCannotBeginLease,pendingOrBusyCannotBorrowBrowser,
  strictFailureKeepsUnknownButRestoresAllAndSameCursor,intakeRestoreFailureCanOnlyResumeTheSameLeaseWithoutReconciliationReplay,explicitStopCancelsLeaseWithoutResumingOrLosingItsHold,stopDuringNativeSelectionCannotClickAfterLeaseCancellation];
  for(const test of tests){await test();console.log('PASS '+test.name);}console.log(tests.length+' isolated original-operation lease regressions passed; no production evidence generated.');
})().catch(error=>{console.error(error);process.exitCode=1;});
