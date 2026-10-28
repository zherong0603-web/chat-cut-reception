"use strict";

// Actual ui_actions source and actual worker opaque cursor. Only the RPC,
// native UI controls and sender boundary are isolated. All writes are /tmp.
// No real page, profile, network or production database is accessed.
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),vm=require("node:vm");
const {createRequire}=require("node:module");
const file=path.resolve(__dirname,"../xhs_reception/ui_actions.cjs"),real=createRequire(file);
const worker=real("./ui_worker.cjs");
const A="aaaaaaaaaaaaaaaaaaaaaaaa",U="bbbbbbbbbbbbbbbbbbbbbbbb",V="cccccccccccccccccccccccc";
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function until(predicate){const deadline=Date.now()+1500;while(!predicate()){if(Date.now()>deadline)throw Error("fixture_timeout");await delay(5);}}
const clone=value=>JSON.parse(JSON.stringify(value));

async function fixture(options={}){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),"xhs-held-takeover-"));
  fs.writeFileSync(path.join(runtime,"account_identity.json"),JSON.stringify({account_id:A,account_display_name:"SYNTHETIC"}));
  const original={intent_id:"original-unknown",account_id:A,conversation_id:U,status:"UNKNOWN",kind:"followup",
    source_event_id:"old-native-source",payload:{operation:"text",text:"SYNTHETIC_NEVER_RESEND"},
    submitted_at:Date.now()/1000-10,evidence:{reference:"one-ui-click-result-unknown"}};
  const m={rows:[{uid:U,time:"12:00:00",content:"unchanged preview"}],outbox:[original],
    accountScope:A,conversation:{account_id:A,conversation_id:U,state:"ACTIVE"},
    trace:[],rpc:[],takeovers:0,takeoverClicks:0,receives:0,reconciles:0,captures:0,stops:0,starts:0,
    selected:null,selectionClicks:0,profileClicks:0,helperEntered:false,holdHelper:!!options.holdHelper,
    helper:deferred(),status:deferred(),selection:deferred(),holdSelection:false,selectionEntered:false};
  options.mutate?.(m);
  function locator(selector){
    const profile=selector===".chat-tool-wrap .tabs-wrap .d-tabs-header";
    const row=selector===`.sx-contact-item[data-key="Total-${U}"]`;
    const all=selector==='.contact-tab-wrap .d-tabs-header',scroller=selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller';
    if(!profile&&!row&&!all&&!scroller)throw Error("unexpected_ui_control:"+selector);
    const result={nth:index=>{assert(scroller);assert.equal(index,0);return result;},filter:()=>result,waitFor:async()=>{},evaluate:async fn=>{assert(scroller);return fn({scrollTop:0});},count:async()=>row&&options.duplicateRow?2:1,click:async()=>{
      if(all||scroller)throw Error('unexpected_intake_control_click');
      if(profile){m.profileClicks++;m.trace.push("profile");}
      else{m.selected=U;m.selectionClicks++;m.trace.push("select_uid");}
    }};return result;
  }
  const nativeView={documentElement:{clientWidth:1280,clientHeight:800},querySelectorAll:selector=>{
    if(selector==='.contact-tab-wrap .d-tabs-header')return [{innerText:'全部会话',checkVisibility:()=>true,classList:{contains:cls=>cls==='active'}}];
    if(selector==='.sx-contact-item')return [{checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:200,width:350,height:61}),getAttribute:()=> 'Total-'+U}];
    if(selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')return [{checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:178.5,width:360,height:628}),contains:()=>true,scrollTop:0}];
    throw Error('unexpected_native_intake_fixture_selector_'+selector);
  }};
  const page={url:()=>"https://sxt.xiaohongshu.com/im/multiCustomerService",locator,
    evaluate:async(fn,arg)=>vm.runInNewContext('('+fn.toString()+')(arg)',{document:nativeView,arg}),waitForFunction:async(_fn,args)=>{
      if(args===null){assert(vm.runInNewContext('('+_fn.toString()+')()',{document:nativeView}));return;}
      assert.deepEqual(clone(args),{uid:U,account:A});assert.equal(m.selected,U);
    }};
  await worker.start(page,{readSidebar:async()=>({rows:m.rows}),selectAndRead:async()=>{
    m.selectionEntered=true;if(m.holdSelection)await m.selection.promise;return {};},processScope:async()=>({ok:true})});
  m.startedAt=worker.status(page).startedAt;
  const controller={status:()=>{const s=worker.status(page);return {running:s.running,worker:{...s,...(options.reportBusy?{busy:true}:{})}};},
    stop:()=>{m.trace.push("stop");m.stops++;return worker.stop(page);},start:async args=>{
      m.trace.push("resume");m.starts++;m.startArgs=args;
      const result=await worker.start(page,{resumeCursor:options.forgeResume?{}:args.resumeCursor,
        readSidebar:async()=>({rows:m.rows}),selectAndRead:async()=>({}),processScope:async()=>({ok:true})});
      return {running:result.running,worker:result};}};
  const client={request:async(method,params)=>{
    m.trace.push("status");m.rpc.push({method,params:clone(params)});assert.equal(method,"status");
    assert.equal(params.conversation_id,U);
    if(options.deferStatus&&m.rpc.length===1)await m.status.promise;
    if(options.badRPC)return {ok:false,error:{outcome:"UNKNOWN"}};
    return {ok:true,result:clone({account_scope:m.accountScope,conversations:[m.conversation],outbox:m.outbox})};
  }};
  const sender={receive:async()=>{m.receives++;throw Error("send_forbidden");},
    reconcileAndComplete:async()=>{m.reconciles++;throw Error("reconcile_forbidden");},
    takeOverOnly:async args=>{
      m.trace.push("takeover");m.takeovers++;m.helperEntered=true;m.lease=args;
      assert.equal(args.uid,U);assert.equal((await args.currentScope()).conversation_id,U);
      if(m.holdHelper)await m.helper.promise;
      if(!args.isCurrent())throw Error("worker_cancelled");
      if(options.helperError)throw Error("synthetic_takeover_failed");
      m.takeoverClicks++;
      if(options.mutateOutbox)m.outbox[0].evidence.changed=true;
      return {manual:true,input_ready:true,ai_mask_visible:false,customer_send_performed:false};
    }};
  const dependencies={"./ui_controller.cjs":controller,"./ui_sender.cjs":sender,
    "./ui_engine.cjs":{getClient:()=>client},"./ui_worker.cjs":{...worker,captureCursor:p=>{
      m.trace.push("capture");m.captures++;return worker.captureCursor(p);}},
    "./ui_scope.cjs":{readScope:async()=>({scope_ready:true,account_scope_verified:true,conversation_scope_verified:true,
      account_id:A,conversation_id:m.selected,profile_binding_source:"current_native_profile",
      observed_at_utc:new Date().toISOString(),messages:[]})}};
  const localRequire=name=>Object.hasOwn(dependencies,name)?dependencies[name]:real(name);
  localRequire.resolve=name=>real.resolve(name);localRequire.cache={};
  const sandbox={process,Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval,console};sandbox.global=sandbox;
  const module={exports:{}};
  const wrapped=vm.runInNewContext("(function(exports,require,module,__filename,__dirname){\n"+fs.readFileSync(file,"utf8")+"\n})",sandbox,{filename:file,timeout:1000});
  wrapped(module.exports,localRequire,module,file,path.dirname(file));
  const run=(operation="take_over_held_conversation",extra={})=>module.exports.run({page,runtime,
    cmd:{operation,uid:U,intent_id:"original-unknown",...extra}});
  return {m,page,run,runtime,originalBytes:JSON.stringify(m.outbox),cleanup:async()=>{
    worker.stop(page);m.helper.resolve();m.status.resolve();m.selection.resolve();await delay(0);fs.rmSync(runtime,{recursive:true,force:true});}};
}
async function check(options,fn){const t=await fixture(options);try{await fn(t);}finally{await t.cleanup();}}

async function busyLeaseNeverStartsUI(){await check({reportBusy:true},async({m,run})=>{
  await assert.rejects(run(),/idle_takeover_lease_required/);assert.equal(m.rpc.length,0);assert.equal(m.captures,0);assert.equal(m.selectionClicks,0);
});}
async function foreignOrOwnedOrResolvedStatusIsRejectedBeforeCapture(){
  const mutations=[m=>m.conversation.account_id=V,m=>{m.accountScope=V;m.conversation.account_id=V;m.outbox[0].account_id=V;},
    m=>m.conversation.conversation_id=V,m=>m.outbox[0].conversation_id=V,m=>m.conversation.state="HUMAN",
    m=>m.conversation.state="STOPPED",m=>m.outbox[0].status="SENT",m=>m.outbox=[],m=>m.outbox[0].intent_id="another-intent"];
  for(const mutate of mutations)await check({mutate},async({m,run})=>{
    await assert.rejects(run(),/held_takeover_scope_unavailable|original_unknown_hold_required/);
    assert.equal(m.captures,0);assert.equal(m.selectionClicks,0);assert.equal(m.takeovers,0);
  });
}
async function rpcUnknownNeverCreatesLease(){await check({badRPC:true},async({m,run})=>{
  await assert.rejects(run(),/held_takeover_scope_unavailable/);assert.equal(m.captures,0);assert.equal(m.stops,0);
});}
async function exactOnlyTakeoverKeepsOriginalUnknownBytesAndStartedAt(){await check({},async({m,run,page,runtime,originalBytes})=>{
  const result=await run();
  assert.deepEqual(m.trace,["status","capture","stop","profile","select_uid","takeover","status","resume"]);
  assert.equal(JSON.stringify(m.outbox),originalBytes);assert.equal(m.outbox[0].status,"UNKNOWN");
  assert.equal(m.takeoverClicks,1);assert.equal(m.receives,0);assert.equal(m.reconciles,0);
  assert.equal(m.selectionClicks,1);assert.equal(m.captures,1);assert.equal(m.starts,1);
  assert.equal(result.original_unknown_preserved,true);assert.equal(result.customer_send_performed,false);
  assert.equal(result.full_five_second_acceptance,false);assert.equal(worker.status(page).startedAt,m.startedAt);
  assert.equal(typeof m.startArgs.takeoverOnly,"function");
  const proof=JSON.parse(fs.readFileSync(path.join(runtime,"held-conversation-takeover.json"),"utf8"));
  assert.equal(proof.original_status,"UNKNOWN");assert.equal(proof.original_intent_id,m.outbox[0].intent_id);
  assert.equal(fs.statSync(path.join(runtime,"held-conversation-takeover.json")).mode&0o777,0o600);
});}
async function helperOrSelectionFailureStillRestoresOriginalCursor(){
  for(const options of [{helperError:true},{duplicateRow:true}])await check(options,async({m,run,page,originalBytes})=>{
    await assert.rejects(run(),/synthetic_takeover_failed|unique_visible_customer_row_required/);
    assert.equal(worker.status(page).running,true);assert.equal(worker.status(page).startedAt,m.startedAt);
    assert.equal(JSON.stringify(m.outbox),originalBytes);assert.equal(m.starts,1);assert.equal(m.receives,0);assert.equal(m.reconciles,0);
  });
}
async function changedOutboxCannotBeReportedAsPreserved(){await check({mutateOutbox:true},async({m,run,page,runtime})=>{
  await assert.rejects(run(),/takeover_must_preserve_original_outbox/);assert.equal(worker.status(page).running,true);
  assert.equal(m.outbox[0].status,"UNKNOWN");assert(!fs.existsSync(path.join(runtime,"held-conversation-takeover.json")));
});}
async function concurrentManualWriterIsRefusedWhileLeaseHeld(){await check({holdHelper:true},async({m,run})=>{
  const first=run();await until(()=>m.helperEntered);
  await assert.rejects(run("select_conversation"),/pending_runtime_reload_requires_resume/);
  await assert.rejects(run(),/pending_runtime_reload_requires_resume/);
  assert.equal(m.selectionClicks,1);m.helper.resolve();await first;
});}
async function workerBecomingBusyDuringRPCWaitCannotBeStopped(){await check({deferStatus:true},async({m,run})=>{
  const first=run();m.holdSelection=true;m.rows=[{uid:U,time:"changed",content:"new preview"}];
  await until(()=>m.selectionEntered);m.status.resolve();await assert.rejects(first,/idle_running_worker_cursor_required/);
  assert.equal(m.stops,0);assert.equal(m.takeovers,0);assert.equal(m.selectionClicks,0);
});}
async function forgedResumeTokenCannotRebaseline(){await check({forgeResume:true},async({m,run,page})=>{
  await assert.rejects(run(),/invalid_worker_resume_cursor/);assert.equal(worker.status(page).running,false);
  await assert.rejects(run("start_reception_worker"),/pending_runtime_reload_requires_resume/);
  assert.equal(m.outbox[0].status,"UNKNOWN");assert.equal(m.receives,0);
});}
async function explicitStopCancelsLeaseWithoutPostStopTakeover(){await check({holdHelper:true},async({m,run,page})=>{
  const first=run();await until(()=>m.helperEntered);await run("stop_reception_worker");
  const stillCurrent=m.lease.isCurrent();m.helper.resolve();
  await assert.rejects(first,/worker_cancelled|invalid_worker_resume_cursor|takeover_lease_cancelled/);
  assert.equal(stillCurrent,false);assert.equal(m.takeoverClicks,0);assert.equal(worker.status(page).running,false);
  assert.equal(m.outbox[0].status,"UNKNOWN");
});}

(async()=>{const cases=[busyLeaseNeverStartsUI,foreignOrOwnedOrResolvedStatusIsRejectedBeforeCapture,rpcUnknownNeverCreatesLease,
  exactOnlyTakeoverKeepsOriginalUnknownBytesAndStartedAt,helperOrSelectionFailureStillRestoresOriginalCursor,
  changedOutboxCannotBeReportedAsPreserved,concurrentManualWriterIsRefusedWhileLeaseHeld,workerBecomingBusyDuringRPCWaitCannotBeStopped,
  forgedResumeTokenCannotRebaseline,explicitStopCancelsLeaseWithoutPostStopTakeover];
  for(const test of cases){await test();console.log("PASS "+test.name);}
  console.log(cases.length+" isolated held-takeover lease regressions passed; no browser or production resources.");
})().catch(error=>{console.error(error);process.exitCode=1;});
