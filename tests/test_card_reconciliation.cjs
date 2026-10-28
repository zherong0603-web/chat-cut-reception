"use strict";

// Actual action/sender source and actual worker cursor; isolated protocol and UI
// boundaries only. All files are /tmp fixtures. No browser or production DB.
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),vm=require("node:vm");
const {createRequire}=require("node:module");
const actionFile=path.resolve(__dirname,"../xhs_reception/ui_actions.cjs"),actionRequire=createRequire(actionFile);
const workerPath=actionRequire.resolve("./ui_worker.cjs");
const A="aaaaaaaaaaaaaaaaaaaaaaaa",U="bbbbbbbbbbbbbbbbbbbbbbbb",V="cccccccccccccccccccccccc";
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function until(predicate){const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw Error("fixture_timeout");await delay(5);}}
function card(raw,at){const native=A+"."+U+"."+raw;return {account_id:A,conversation_id:U,message_id:raw,
  dom_id:"id_"+native,native_dom_id:"jarvis-msg-"+native,raw_timestamp:String(at),raw_type:"CARD",direction:"right",
  raw_text:"企业微信\n运去哪海外仓（企微）",native_business_card_candidate:true};}
function compile(file,dependencies,sandbox={}){
  const real=createRequire(file),module={exports:{}};
  const wrapped=vm.runInNewContext("(function(exports,require,module,__filename,__dirname){\n"+fs.readFileSync(file,"utf8")+"\n})",
    {process,Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval,console,...sandbox},{filename:file,timeout:1000});
  const requireLocal=name=>Object.hasOwn(dependencies,name)?dependencies[name]:real(name);
  wrapped(module.exports,requireLocal,module,file,path.dirname(file));return module.exports;
}
async function actionFixture(options={}){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),"xhs-card-lease-"));
  fs.writeFileSync(path.join(runtime,"account_identity.json"),JSON.stringify({account_id:A,account_display_name:"SYNTHETIC"}));
  const submitted=Date.now()-10000,prior=card("prior-card",submitted-20000),target=card("target-card",submitted+1000);
  const reference={account_id:A,conversation_id:U,intent_id:"prior-intent",status:"SENT",confirmed_at:submitted/1000-10,
    payload:{operation:"native_card"},evidence:{native_wecom_card_confirmed:true,native_message_raw_id:prior.message_id,
      native_message_id:prior.native_dom_id,native_server_history:{status:"server_history_confirmed",native_message_id:prior.native_dom_id.slice(11),native_created_at_ms:Number(prior.raw_timestamp)}}};
  const unknown={account_id:A,conversation_id:U,intent_id:"original-unknown",status:"UNKNOWN",submitted_at:submitted/1000,
    payload:{operation:"native_card"},evidence:{native_message_raw_id:target.message_id,native_message_id:target.native_dom_id}};
  const m={rows:[{uid:U,time:"fixture",content:"unchanged preview"}],reference,unknown,messages:[prior,target],
    trace:[],deleted:[],primeScopes:[],reconciliations:[],captures:0,stops:0,starts:0,sends:0,
    statusWait:deferred(),selection:deferred(),selectionEntered:false,holdSelection:false};
  options.mutate?.(m);
  const nativeView={querySelectorAll:selector=>{
    if(selector==='.contact-tab-wrap .d-tabs-header')return [{innerText:'全部会话',checkVisibility:()=>true,classList:{contains:cls=>cls==='active'}}];
    if(selector==='.sx-contact-item')return [{checkVisibility:()=>true,getAttribute:()=> 'Total-'+U}];
    if(selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')return [{checkVisibility:()=>true,getBoundingClientRect:()=>({width:800,height:628}),scrollTop:0}];
    throw Error('unexpected_resume_native_selector_'+selector);
  }};
  const page={url:()=>"https://sxt.xiaohongshu.com/im/multiCustomerService",
    evaluate:async fn=>vm.runInNewContext('('+fn.toString()+')()',{document:nativeView}),
    waitForFunction:async fn=>{assert(vm.runInNewContext('('+fn.toString()+')()',{document:nativeView}));},
    locator:selector=>{assert(['.contact-tab-wrap .d-tabs-header','.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller'].includes(selector));
      return {nth(index){assert.equal(index,0);return this;},filter(){return this;},waitFor:async()=>{},count:async()=>1,evaluate:async fn=>fn({scrollTop:0}),click:()=>{throw Error('unexpected_resume_native_click');}};}};
  let worker=actionRequire(workerPath);
  await worker.start(page,{readSidebar:async()=>({rows:m.rows}),selectAndRead:async()=>{
    m.selectionEntered=true;if(m.holdSelection)await m.selection.promise;return {};},processScope:async()=>({ok:true})});
  m.startedAt=worker.status(page).startedAt;
  const controller={status:()=>{const status=worker.status(page);return {running:status.running,worker:{...status,...(options.busy?{busy:true}:{})}};},
    stop:()=>{m.trace.push("stop");m.stops++;worker.stop(page);return controller.status();},start:async args=>{
      m.trace.push("start");m.starts++;
      const started=await worker.start(page,{resumeCursor:args.resumeCursor,readSidebar:async()=>({rows:m.rows}),
        selectAndRead:async()=>({}),processScope:async()=>({ok:true})});return {running:started.running,worker:started};}};
  const client={request:async(method)=>{m.trace.push(method);assert.equal(method,"status");
    if(options.deferStatus)await m.statusWait.promise;return {ok:true,result:{account_scope:A,outbox:[reference,unknown]}};}};
  const native={version:options.observerVersion??7};
  const sender={primeCardIdentity:(_page,value)=>{m.trace.push("prime");m.primeScopes.push(value);
    if(options.primeError)throw Error("synthetic_prime_failed");return {native_wecom_identity_primed:true};},
    receive:async()=>{m.sends++;throw Error("send_forbidden");},reconcileAndComplete:async args=>{
      m.trace.push("reconcile");m.reconciliations.push(args);assert.equal(args.reconcileOnly,true);
      assert.equal(typeof args.currentScope,"function");
      if(options.reconcileError)throw Error("synthetic_original_still_unknown");
      unknown.status="SENT";return {original_intent:unknown.intent_id,status:"SENT",customer_send_performed:false};}};
  const cache=Object.create(null),factories={
    "./ui_controller.cjs":()=>controller,"./ui_engine.cjs":()=>({getClient:()=>client}),
    "./native_history_receipt.cjs":()=>({attach:()=>{m.trace.push("observer_v"+native.version);return native;}}),
    "./ui_sender.cjs":()=>sender,
    "./ui_scope.cjs":()=>({readScope:async()=>({scope_ready:true,account_scope_verified:true,conversation_scope_verified:true,
      profile_binding_source:"current_native_profile",account_id:options.scopeAccount || A,conversation_id:U,
      observed_at_utc:new Date().toISOString(),messages:m.messages.map(message=>({...message}))})}),
    "./ui_worker.cjs":()=>({...worker,captureCursor:targetPage=>{m.trace.push("capture");m.captures++;return worker.captureCursor(targetPage);}}),
  };
  for(const name of Object.keys(factories))cache[actionRequire.resolve(name)]={exports:factories[name]()};
  function requireLocal(name){if(!Object.hasOwn(factories,name))return actionRequire(name);
    const resolved=actionRequire.resolve(name);if(!cache[resolved])cache[resolved]={exports:factories[name]()};return cache[resolved].exports;}
  requireLocal.resolve=name=>actionRequire.resolve(name);
  requireLocal.cache=new Proxy(cache,{deleteProperty(target,key){m.deleted.push(path.basename(key));return delete target[key];}});
  const sandbox={process,Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval,console};sandbox.global=sandbox;
  const module={exports:{}},wrapped=vm.runInNewContext("(function(exports,require,module,__filename,__dirname){\n"+fs.readFileSync(actionFile,"utf8")+"\n})",sandbox,{filename:actionFile,timeout:1000});
  wrapped(module.exports,requireLocal,module,actionFile,path.dirname(actionFile));
  return {m,page,worker,run:extra=>module.exports.run({page,runtime,cmd:{operation:"upgrade_and_reconcile_original_card",uid:U,reference_intent_id:reference.intent_id,...extra}}),
    cleanup:async()=>{worker.stop(page);m.statusWait.resolve();m.selection.resolve();await delay(0);fs.rmSync(runtime,{recursive:true,force:true});}};
}
async function actionCheck(options,fn){const t=await actionFixture(options);try{await fn(t);}finally{await t.cleanup();}}

async function busyWorkerIsRejectedBeforeAnyLease(){await actionCheck({busy:true},async({m,run})=>{
  await assert.rejects(run(),/idle_reconciliation_lease_required/);assert.equal(m.captures,0);assert.equal(m.stops,0);assert.equal(m.reconciliations.length,0);
});}
async function nonCardUnknownAndTargetReferenceAreRejected(){
  for(const options of [{mutate:m=>m.unknown.payload.operation="text"},{}])await actionCheck(options,async({m,run})=>{
    await assert.rejects(run(options.mutate?{}:{reference_intent_id:m.unknown.intent_id}),/independent_prior_card_reference_required/);
    assert.equal(m.captures,0);assert.equal(m.unknown.status,"UNKNOWN");
  });
}
async function referenceAfterTargetIsRejected(){for(const delta of [0,1])await actionCheck({mutate:m=>m.reference.confirmed_at=m.unknown.submitted_at+delta},async({m,run})=>{
  await assert.rejects(run(),/independent_prior_card_reference_required/);assert.equal(m.captures,0);assert.equal(m.unknown.status,"UNKNOWN");
});}
async function missingOrForeignReferenceIdentityIsRejected(){
  for(const mutate of [m=>delete m.reference.account_id,m=>m.reference.account_id=V,m=>delete m.reference.conversation_id,m=>m.reference.conversation_id=V,
    m=>delete m.reference.evidence.native_message_raw_id,m=>delete m.reference.evidence.native_server_history.native_created_at_ms,m=>m.reference.evidence.native_message_id="jarvis-msg-"+A+"."+V+".prior-card",
    m=>m.reference.evidence.native_server_history.native_message_id=V+"."+U+".prior-card"]){
    await actionCheck({mutate},async({m,run})=>{await assert.rejects(run(),/independent_(?:prior_card_reference|reference_native_id)_required/);
      assert.equal(m.captures,0);assert.equal(m.unknown.status,"UNKNOWN");});
  }
}
async function oneLeaseOnlyPrimesPriorCardAndReconcilesWithoutSend(){await actionCheck({},async({m,run,worker,page})=>{
  m.trace.length=0;const result=await run();
  assert.deepEqual(m.trace,["status","capture","stop","observer_v7","prime","reconcile","start"]);assert.equal(m.captures,1);assert.equal(m.stops,1);assert.equal(m.starts,1);
  assert(m.deleted.includes("native_history_receipt.cjs"));assert(m.deleted.includes("ui_sender.cjs"));
  assert.equal(m.primeScopes.length,1);assert.deepEqual(m.primeScopes[0].messages.map(message=>message.message_id),["prior-card"]);
  assert.equal(m.reconciliations.length,1);assert.equal(m.reconciliations[0].reconcileOnly,true);assert.equal(m.sends,0);
  assert.equal(result.direct_send_performed,false);assert.equal(result.receiver_may_process_pending_entries,true);assert.equal(result.receiver_resumed,true);
  assert.equal(worker.status(page).running,true);assert.equal(worker.status(page).startedAt,m.startedAt);
});}
async function failuresRestoreCursorAndNeverClearUnknown(){
  for(const options of [{primeError:true},{reconcileError:true},{observerVersion:6},{scopeAccount:V}])await actionCheck(options,async({m,run,worker,page})=>{
    await assert.rejects(run(),/synthetic_|audited_native_verifier_v7_required|independent_prior_card_not_in_current_native_scope/);
    assert.equal(m.unknown.status,"UNKNOWN");assert.equal(m.sends,0);assert.equal(m.captures,1);assert.equal(m.stops,1);assert.equal(m.starts,1);
    assert.equal(worker.status(page).running,true);assert.equal(worker.status(page).startedAt,m.startedAt);
  });
}
async function busyAfterStatusAwaitCannotCapture(){await actionCheck({deferStatus:true},async({m,run})=>{
  const pending=run();m.holdSelection=true;m.rows=[{uid:U,time:"changed",content:"new genuine preview candidate"}];
  await until(()=>m.selectionEntered);m.statusWait.resolve();await assert.rejects(pending,/idle_running_worker_cursor_required/);
  assert.equal(m.stops,0);assert.equal(m.starts,0);assert.equal(m.unknown.status,"UNKNOWN");
});}

function senderFixture({raw="target-card",full=true,visibleTarget=true,laterHuman=true,otherUnknown=false,otherStatus="UNKNOWN"}={}){
  const file=path.resolve(__dirname,"../xhs_reception/ui_sender.cjs"),submitted=Date.now()-10000;
  const prior=card("prior-card",submitted-20000),target=card("target-card",submitted+1000),human=card("later-human-card",submitted+2000);
  const intent={account_id:A,conversation_id:U,intent_id:"original-unknown",status:"UNKNOWN",submitted_at:submitted/1000,
    payload:{operation:"native_card"},evidence:{...(raw!==null?{native_message_raw_id:raw}:{}),
      ...(full?{native_message_id:"jarvis-msg-"+A+"."+U+"."+(raw || "target-card")}:{})}};
  const other={intent_id:"untouched-old-unknown",account_id:A,conversation_id:U,status:otherStatus,payload:{operation:"text",text:"do not send"},evidence:{native_message_raw_id:"other-native"}};
  const m={other,history:[],reconciles:[],menus:0,refreshes:0,scope:[...(visibleTarget?[target]:[]),...(laterHuman?[human]:[])]};
  const token={routing_hash:"a".repeat(64),full_payload_hash:"b".repeat(64)};
  const receiver=compile(file,{"./ui_engine.cjs":{getClient:()=>({request:async(method,params)=>{
      if(method==="status")return {ok:true,result:{outbox:[intent,...(otherUnknown?[other]:[])]}};
      assert.equal(method,"reconcile");m.reconciles.push(params);intent.status="SENT";return {ok:true,result:{status:"SENT"}};
    }})},"./native_history_receipt.cjs":{attach:()=>({cardIdentity:()=>({status:"native_card_identity_confirmed",verifier_version:7,
      cardIdentity:token,reference:"prior-reference",native_message_id:prior.native_dom_id.slice(11),excluded_display_fields:["buttons"],observed_at_utc:new Date().toISOString()}),
      verify:async params=>{m.history.push(params);assert.equal(params.messageId,"target-card");assert.equal(params.cardIdentity,token);
        return {status:"server_history_confirmed",verifier_version:7,request_started_at_ms:Date.now(),operation:"native_card",native_message_id:target.native_dom_id.slice(11),
          full_payload_hash:"c".repeat(64),expected_full_payload_hash:"b".repeat(64),excluded_display_fields:["buttons"]};}})}});
  const page={},scope=messages=>({scope_ready:true,account_scope_verified:true,conversation_scope_verified:true,
    account_id:A,conversation_id:U,observed_at_utc:new Date().toISOString(),messages});
  receiver.primeCardIdentity(page,scope([prior]));
  return {m,intent,run:(extra={})=>receiver.reconcileAndComplete({page,runtime:"unused-fixture",uid:U,currentScope:async()=>scope(m.scope),
    refreshHistory:async()=>{m.refreshes++;},openCardMenu:async()=>{m.menus++;},reconcileOnly:true,...extra})};
}
async function missingOriginalIdNeverAdoptsLaterHumanCard(){for(const options of [{raw:null},{full:false},{visibleTarget:false}]){
  const {m,intent,run}=senderFixture(options);await assert.rejects(run(),/original_native_message_id_required_for_reconciliation|unique_original_text_message_required/);
  assert.equal(intent.status,"UNKNOWN");assert.equal(m.reconciles.length,0);assert.equal(m.history.length,0);assert.equal(m.menus,0);
}}
async function exactOriginalRawIdAndHashMetadataStaySeparate(){const {m,intent,run}=senderFixture();
  const result=await run();assert.equal(result.status,"SENT");assert.equal(result.customer_send_performed,false);assert.equal(m.menus,0);
  assert.equal(m.history.length,1);assert.equal(m.reconciles.length,1);assert.equal(intent.status,"SENT");
  const proof=m.reconciles[0].evidence;
  assert.equal(proof.native_message_raw_id,"target-card");assert.equal(proof.expected_card_proof.expected_full_card_hash,"b".repeat(64));
  assert.equal(proof.expected_card_proof.comparison_hash,"a".repeat(64));assert.equal(proof.native_server_history.full_payload_hash,"c".repeat(64));
  assert.equal(proof.native_server_history.expected_full_payload_hash,"b".repeat(64));
}
async function referenceNativeTimeMustPrecedeTargetSubmission(){for(const delta of [0,1])await actionCheck({mutate:m=>{
  const nativeAt=m.unknown.submitted_at*1000+delta;
  m.reference.evidence.native_server_history.native_created_at_ms=nativeAt;
  m.messages[0].raw_timestamp=String(nativeAt);
}},async({m,run})=>{await assert.rejects(run(),/independent_prior_card_reference_required|independent_reference_native_id_required/);
  assert.equal(m.unknown.status,"UNKNOWN");assert.equal(m.primeScopes.length,0);assert.equal(m.captures,0);
});}
async function sameNativeTargetCannotBeUsedAsItsOwnPrimeReference(){await actionCheck({mutate:m=>{
  m.reference.evidence.native_message_raw_id=m.unknown.evidence.native_message_raw_id;
  m.reference.evidence.native_message_id=m.unknown.evidence.native_message_id;
  m.reference.evidence.native_server_history.native_message_id=m.unknown.evidence.native_message_id.slice(11);
  m.reference.evidence.native_server_history.native_created_at_ms=Number(m.messages[1].raw_timestamp);
  m.messages=[m.messages[1]];
}},async({m,run})=>{await assert.rejects(run(),/independent_prior_card_reference_required|independent_reference_native_id_required/);
  assert.equal(m.unknown.status,"UNKNOWN");assert.equal(m.primeScopes.length,0);
});}

async function multipleUnknownsNeedExactReadOnlyTargetAndPreserveEveryOtherRow(){
  const f=senderFixture({otherUnknown:true}),before=JSON.stringify(f.m.other);
  const exact={expectedIntentId:f.intent.intent_id,expectedNativeMessageId:f.intent.evidence.native_message_id,expectedRawId:f.intent.evidence.native_message_raw_id};
  await assert.rejects(f.run(),/one_exact_unknown_intent_required/);
  await assert.rejects(f.run({expectedIntentId:f.intent.intent_id}),/one_exact_unknown_intent_required/);
  await assert.rejects(f.run({...exact,reconcileOnly:false}),/one_exact_unknown_intent_required/);
  assert.equal((await f.run(exact)).status,'SENT');assert.equal(JSON.stringify(f.m.other),before);assert.equal(f.m.menus,0);assert.equal(f.m.reconciles.length,1);
  for(const otherStatus of ['PREPARED','CLAIMED','SUBMITTING']){
    const g=senderFixture({otherUnknown:true,otherStatus});
    await assert.rejects(g.run({expectedIntentId:g.intent.intent_id,expectedNativeMessageId:g.intent.evidence.native_message_id,expectedRawId:g.intent.evidence.native_message_raw_id}),/reconciliation_unsubmitted_work_present/);
    assert.equal(g.m.reconciles.length,0);assert.equal(g.intent.status,'UNKNOWN');
  }
}

(async()=>{const cases=[multipleUnknownsNeedExactReadOnlyTargetAndPreserveEveryOtherRow,busyWorkerIsRejectedBeforeAnyLease,nonCardUnknownAndTargetReferenceAreRejected,referenceAfterTargetIsRejected,
  missingOrForeignReferenceIdentityIsRejected,oneLeaseOnlyPrimesPriorCardAndReconcilesWithoutSend,failuresRestoreCursorAndNeverClearUnknown,
  busyAfterStatusAwaitCannotCapture,missingOriginalIdNeverAdoptsLaterHumanCard,exactOriginalRawIdAndHashMetadataStaySeparate,
  sameNativeTargetCannotBeUsedAsItsOwnPrimeReference,referenceNativeTimeMustPrecedeTargetSubmission];
  for(const test of cases){await test();console.log("PASS "+test.name);}
  console.log(cases.length+" isolated original-card reconciliation regressions passed; no browser or production data.");
})().catch(error=>{console.error(error);process.exitCode=1;});
