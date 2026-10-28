"use strict";

// Actual ui_actions reload branch + actual worker/cursor, with protocol/controller
// boundaries isolated in a VM. All files are synthetic /tmp resources. No
// browser, browser profile, production SQLite or customer action is accessed.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const vm=require("node:vm");
const {createRequire}=require("node:module");
const filename=path.resolve(__dirname,"../xhs_reception/ui_actions.cjs");
const source=fs.readFileSync(filename,"utf8"),nativeRequire=createRequire(filename);
const workerPath=nativeRequire.resolve("./ui_worker.cjs");
const ACCOUNT="aaaaaaaaaaaaaaaaaaaaaaaa",UID="bbbbbbbbbbbbbbbbbbbbbbbb",NEW="cccccccccccccccccccccccc";
const singleton=Symbol.for("xhs_reception.ui_engine_client");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred() {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function until(predicate) {
  const deadline=Date.now()+1500;
  while(!predicate()) {if(Date.now()>deadline) throw new Error("fixture_timeout");await delay(5);}
}
const sidebarRow=uid=>({uid,time:"12:00:00",content:"SYNTHETIC_PREVIEW"});

async function fixture(options={}) {
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),"xhs-runtime-reload-"));
  fs.writeFileSync(path.join(runtime,"account_identity.json"),JSON.stringify({account_id:ACCOUNT,account_display_name:"SYNTHETIC"}));
  const model={rows:options.emptyList?[]:[sidebarRow(UID)],trace:[],deleted:[],oldRequests:[],newRequests:[],
    closeCalls:0,starts:0,receives:0,captures:0,stops:0,holdSelection:false,
    selectionStarted:false,selection:deferred(),preflight:deferred(),
    closeConfirmed:options.closeConfirmed ?? true,newStatusFailures:options.newStatusFailures || 0,
    allActive:!options.currentViewBlind,scrollerCount:options.twoVisibleScrollers?2:options.noScroller?0:1,scrollTop:options.midScroll ? 2236:0,blockTop:Boolean(options.blockTop),blockAllActivation:Boolean(options.blockAllActivation),
    oldHealth:{pending_requests:options.pending || 0,closed:false,transport_failed:false}};
  const viewDocument={querySelectorAll:selector=>{
    if(selector==='.contact-tab-wrap .d-tabs-header'){
      const tab=(text,active)=>({innerText:text,checkVisibility:()=>true,classList:{contains:cls=>cls==='active'&&active}});
      return [tab('当前会话',!model.allActive),tab('全部会话',model.allActive)];
    }
    if(selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')return options.noScroller?[]:[{checkVisibility:()=>true,getBoundingClientRect:()=>({width:800,height:628}),get scrollTop(){return model.scrollTop;}},...(options.collapsedScroller||options.twoVisibleScrollers?[{checkVisibility:()=>true,getBoundingClientRect:()=>({width:800,height:options.collapsedScroller?0:628}),scrollTop:0}]:[])];
    if(selector==='.sx-contact-item')return model.rows.map(row=>({checkVisibility:()=>true,
      getAttribute:()=> (model.allActive?'Total-':'Active-')+row.uid}));
    throw Error('unexpected_native_view_selector_'+selector);
  }};
  const readView=fn=>vm.runInNewContext('('+fn.toString()+')()',{document:viewDocument});
  const page={url:()=>"https://sxt.xiaohongshu.com/im/multiCustomerService",evaluate:async fn=>readView(fn),
    waitForFunction:async fn=>{if(!readView(fn))throw Error('synthetic_all_not_active');},
    locator:selector=>{if(selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')return {filter(){return this;},nth(index){assert.equal(index,0);return this;},count:async()=>model.scrollerCount,evaluate:async fn=>{if(options.stopDuringScrollerRead&&!model.stoppedDuringScrollerRead){model.stoppedDuringScrollerRead=true;await module.exports.run({page,runtime,cmd:{operation:'stop_reception_worker'}});}
        return fn({get scrollTop(){return model.scrollTop;},scrollTo:args=>{assert.equal(args.top,0);assert.equal(Object.keys(args).length,1);model.trace.push('intake_top');if(!model.blockTop)model.scrollTop=0;}});}};
      assert.equal(selector,'.contact-tab-wrap .d-tabs-header');return {
      filter(filter){assert.equal(filter.visible,true);assert(filter.hasText.test('全部会话'));return this;},
      waitFor:async()=>{},count:async()=>1,click:async args=>{
        assert.equal(args.force,undefined);model.trace.push('all_click');if(!model.blockAllActivation)model.allActive=true;
      }};}};
  const oldWorker=nativeRequire(workerPath);
  await oldWorker.start(page,{readSidebar:async()=>({rows:model.rows}),
    selectAndRead:async(_page,candidate)=>{
      if(model.holdSelection) {model.selectionStarted=true;await model.selection.promise;}
      return candidate;
    },processScope:async()=>({ok:true})});
  model.startedAt=oldWorker.status(page).startedAt;
  const sandbox={process,Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval,console};
  sandbox.global=sandbox;
  const oldClient={diagnostics:()=>({...model.oldHealth}),request:async(method)=>{
    model.trace.push("old_status");model.oldRequests.push(method);
    if(options.deferredPreflight) await model.preflight.promise;
    if(options.unknownPreflight) return {ok:false,error:{code:"transport_failed",outcome:"UNKNOWN"}};
    return {ok:true,result:{account_scope:ACCOUNT,outbox:[]}};
  },close:async()=>{
    model.trace.push("close");model.closeCalls++;
    if(!model.closeConfirmed) return {closed:false,timed_out:true};
    model.oldHealth.closed=true;
    if(options.gapEntry) model.rows=[sidebarRow(NEW),sidebarRow(UID)];
    return {closed:true};
  }};
  sandbox[singleton]={runtime,accountId:ACCOUNT,client:oldClient};
  const preserved=new Map();
  for(const name of ["xhs_reception.card_identities","xhs_reception.native_history_observers","xhs_reception.owned_drafts","xhs_reception.native_send_ack_collectors"]) {
    const value=new WeakMap();sandbox[Symbol.for(name)]=value;preserved.set(Symbol.for(name),value);
  }
  const cacheTarget=Object.create(null);
  const cache=new Proxy(cacheTarget,{deleteProperty(target,key){model.deleted.push(path.basename(key));return delete target[key];}});
  let latestWorker=oldWorker;
  const controller={status:()=>{
    const status=latestWorker.status(page);
    return {running:status.running,worker:{...status,...(options.reportBusy ? {busy:true} : {})}};
  },stop:()=>{
    model.trace.push("stop");model.stops++;oldWorker.stop(page);return controller.status();
  },start:async args=>{
    model.trace.push("start");model.starts++;
    assert.equal(model.allActive,true,'The unchanged cursor may resume only after the native All view is verified');
    assert.equal(model.scrollTop,0,'The native virtual intake must be at its top before the unchanged cursor resumes');
    if(options.resumeThrows) throw new Error("synthetic_resume_failure");
    const result=await latestWorker.start(page,{resumeCursor:args.resumeCursor,
      readSidebar:async()=>({rows:model.rows}),selectAndRead:async(_page,candidate)=>candidate,
      processScope:async(candidate,ctx)=>{
        await args.receive({uid:candidate.uid,text:"SYNTHETIC_REPLY",freshSourceIds:new Set(),isCurrent:ctx.isCurrent});
        return {ok:true};
      }});
    return {running:result.running,worker:result};
  }};
  const factories={
    "./ui_controller.cjs":()=>controller,
    "./ui_worker.cjs":()=>{
      delete require.cache[workerPath];latestWorker=nativeRequire(workerPath);
      return {...latestWorker,captureCursor:target=>{
        model.trace.push("capture");model.captures++;
        return latestWorker.captureCursor(target);
      }};
    },
    "./ui_scope.cjs":()=>({readScope:async()=>({scope_ready:true,account_id:ACCOUNT,
      conversation_id:NEW,observed_at_utc:new Date().toISOString(),messages:[]})}),
    "./ui_sender.cjs":()=>({receive:async()=>{model.receives++;return {state:"paused_unknown"};}}),
    "./ui_engine.cjs":()=>({getClient:()=>{
      if(sandbox[singleton]) return sandbox[singleton].client;
      model.trace.push("new_client");
      const client={diagnostics:()=>({closed:false,transport_failed:false,pending_requests:0}),request:async method=>{
        model.trace.push("new_status");model.newRequests.push(method);
        if(model.newStatusFailures>0) {model.newStatusFailures--;return {ok:false,error:{code:"synthetic_engine_failure"}};}
        return {ok:true,result:{account_scope:ACCOUNT,outbox:[]}};
      }};
      sandbox[singleton]={runtime,accountId:ACCOUNT,client};return client;
    }}),
  };
  for(const name of ["./engine_client.cjs","./ui_engine.cjs","./ui_controller.cjs","./ui_sender.cjs",
    "./ui_scope.cjs","./native_terminal_observer.cjs","./ui_worker.cjs","./native_history_receipt.cjs"]) {
    cacheTarget[nativeRequire.resolve(name)]={exports:name==="./ui_worker.cjs"?oldWorker:factories[name]?.() || {sentinel:true}};
  }
  function localRequire(name) {
    if(!Object.hasOwn(factories,name)) return nativeRequire(name);
    const resolved=nativeRequire.resolve(name);
    if(!cacheTarget[resolved]) cacheTarget[resolved]={exports:factories[name]()};
    return cacheTarget[resolved].exports;
  }
  localRequire.resolve=name=>nativeRequire.resolve(name);localRequire.cache=cache;
  const module={exports:{}};
  const compile=vm.runInNewContext("(function(exports,require,module,__filename,__dirname){\n"+source+"\n})",sandbox,{filename,timeout:1000});
  compile(module.exports,localRequire,module,filename,path.dirname(filename));
  const run=operation=>module.exports.run({page,runtime,cmd:{operation}});
  return {model,page,sandbox,preserved,oldWorker,run,
    cleanup:async()=>{latestWorker.stop(page);oldWorker.stop(page);model.preflight.resolve();model.selection.resolve();
      await delay(0);fs.rmSync(runtime,{recursive:true,force:true});}};
}

async function check(options,assertions) {const test=await fixture(options);try {await assertions(test);} finally {await test.cleanup();}}
async function idleReloadPreservesCursorAndPrivateEvidence() {
  await check({},async({model,run,sandbox,preserved})=>{
    const result=await run("reload_reception_runtime");
    assert.equal(result.runtime_reloaded,true);assert.equal(result.original_started_at,model.startedAt);
    assert.equal(result.reception.worker.startedAt,model.startedAt);
    assert.equal(result.direct_send_performed,false);assert.equal(result.receiver_may_process_pending_entries,true);
    assert.deepEqual(model.trace.slice(0,4),["old_status","capture","stop","close"]);
    assert(model.trace.indexOf("new_client")>model.trace.indexOf("close"));
    assert.equal(model.captures,1);assert.equal(model.stops,1);
    for(const file of ["ui_worker.cjs","engine_client.cjs","ui_engine.cjs","ui_controller.cjs","ui_sidebar.cjs","ui_sender.cjs","native_send_ack.cjs","ui_scope.cjs","native_terminal_observer.cjs"]) assert(model.deleted.includes(file));
    assert(!model.deleted.includes("native_history_receipt.cjs"));
    for(const [key,value] of preserved) assert.equal(sandbox[key],value);
    assert([...model.oldRequests,...model.newRequests].every(method=>method==="status"));
  });
}
async function busyWorkerCannotBeginReload() {
  await check({reportBusy:true},async({model,run})=>{
    await assert.rejects(run("reload_reception_runtime"),/idle_running_controller_required/);
    assert.equal(model.captures,0);assert.equal(model.closeCalls,0);assert.equal(model.oldRequests.length,0);
  });
}
async function pendingRPCCannotBeginReload() {
  await check({pending:1},async({model,run})=>{
    await assert.rejects(run("reload_reception_runtime"),/idle_bound_engine_required/);
    assert.equal(model.captures,0);assert.equal(model.closeCalls,0);
  });
}
async function unknownRPCPreflightCannotBeginReload() {
  await check({unknownPreflight:true},async({model,run})=>{
    await assert.rejects(run("reload_reception_runtime"),/engine_reload_preflight_failed/);
    assert.equal(model.captures,0);assert.equal(model.closeCalls,0);assert.equal(model.starts,0);
  });
}
async function busyAfterAwaitCannotBeCaptured() {
  await check({deferredPreflight:true},async({model,run,oldWorker,page})=>{
    const result=run("reload_reception_runtime");
    model.holdSelection=true;model.rows=[sidebarRow(NEW),sidebarRow(UID)];
    await until(()=>model.selectionStarted);assert.equal(oldWorker.status(page).busy,true);
    model.preflight.resolve();await assert.rejects(result,/idle_running_worker_cursor_required/);
    assert.equal(model.stops,0);assert.equal(model.closeCalls,0);
  });
}
async function unconfirmedCloseRetainsSingleCursorForRetry() {
  await check({closeConfirmed:false},async({model,run})=>{
    await assert.rejects(run("reload_reception_runtime"),/old_engine_close_unconfirmed/);
    assert.equal(model.captures,1);assert.equal(model.starts,0);
    await assert.rejects(run("start_reception_worker"),/pending_runtime_reload_requires_resume/);
    model.closeConfirmed=true;const result=await run("reload_reception_runtime");
    assert.equal(result.original_started_at,model.startedAt);assert.equal(model.captures,1);
    assert.equal(model.stops,1);assert.equal(model.closeCalls,2);
  });
}
async function newEngineFailureCannotRebaseline() {
  await check({newStatusFailures:1},async({model,run})=>{
    await assert.rejects(run("reload_reception_runtime"),/new_engine_preflight_failed/);
    await assert.rejects(run("start_reception_worker"),/pending_runtime_reload_requires_resume/);
    const result=await run("reload_reception_runtime");
    assert.equal(result.original_started_at,model.startedAt);assert.equal(model.captures,1);assert.equal(model.closeCalls,1);
  });
}
async function failedResumeStaysHeldAndCanBeStopped() {
  await check({resumeThrows:true},async({model,run})=>{
    await assert.rejects(run("reload_reception_runtime"),/synthetic_resume_failure/);
    await assert.rejects(run("reload_reception_runtime"),/runtime_resume_failed_preserved_hold/);
    await assert.rejects(run("start_reception_worker"),/pending_runtime_reload_requires_resume/);
    assert.equal((await run("stop_reception_worker")).running,false);assert.equal(model.starts,1);
  });
}
async function firstResumedTickMayProcessGapEntry() {
  await check({gapEntry:true},async({model,run})=>{
    const result=await run("reload_reception_runtime");
    assert.equal(result.runtime_reloaded,true);assert.equal(result.reception.worker.error,null);
    assert.equal(model.receives,1);assert.equal(result.receiver_may_process_pending_entries,true);
    assert.equal(result.direct_send_performed,false);
  });
}
async function currentTabRestoresAllBeforeResumingTheSameCursor() {
  await check({currentViewBlind:true},async({model,run})=>{
    const result=await run('reload_reception_runtime');
    assert.equal(result.original_started_at,model.startedAt);assert.equal(model.allActive,true);
    assert(model.trace.indexOf('all_click')>model.trace.indexOf('stop'));
    assert(model.trace.indexOf('all_click')<model.trace.indexOf('start'));
    assert.equal(model.captures,1);assert.equal(model.receives,0);
  });
}
async function failedNativeAllRestoreRetainsOneCursorForRetry() {
  await check({currentViewBlind:true,blockAllActivation:true},async({model,run})=>{
    await assert.rejects(run('reload_reception_runtime'),/native_all_conversations_view_not_confirmed/);
    assert.equal(model.captures,1);assert.equal(model.starts,0);assert.equal(model.stops,1);
    await assert.rejects(run('start_reception_worker'),/pending_runtime_reload_requires_resume/);
    model.blockAllActivation=false;
    const result=await run('reload_reception_runtime');
    assert.equal(result.original_started_at,model.startedAt);assert.equal(result.reception.worker.startedAt,model.startedAt);
    assert.equal(model.captures,1);assert.equal(model.stops,1);assert.equal(model.closeCalls,1);assert.equal(model.starts,1);
    assert.equal(model.receives,0);
  });
}

async function middleVirtualScrollRestoresTopBeforeSameCursorResume(){await check({midScroll:true},async({model,run})=>{
  const result=await run('reload_reception_runtime');assert.equal(result.original_started_at,model.startedAt);assert.equal(model.scrollTop,0);
  assert(model.trace.indexOf('intake_top')>model.trace.indexOf('stop'));assert(model.trace.indexOf('intake_top')<model.trace.indexOf('start'));assert.equal(model.captures,1);
});}
async function failedVirtualTopPreservesUnconsumedCursorForRetry(){await check({midScroll:true,blockTop:true},async({model,run})=>{
  await assert.rejects(run('reload_reception_runtime'),/native_intake_top_not_confirmed/);assert.equal(model.starts,0);assert.equal(model.captures,1);
  model.blockTop=false;const result=await run('reload_reception_runtime');assert.equal(result.original_started_at,model.startedAt);assert.equal(model.starts,1);assert.equal(model.captures,1);
});}

async function actuallyEmptyAllListDoesNotRequireAnInventedScroller(){await check({emptyList:true,noScroller:true},async({model,run})=>{
  const result=await run('reload_reception_runtime');assert.equal(result.reception.worker.startedAt,model.startedAt);assert.equal(model.starts,1);assert.equal(model.captures,1);
});}

async function collapsedZeroHeightScrollerCannotBlockTheOneVisibleIntake(){await check({collapsedScroller:true},async({model,run})=>{
  const result=await run('reload_reception_runtime');assert.equal(result.reception.worker.startedAt,model.startedAt);assert.equal(model.starts,1);assert.equal(model.captures,1);
});}

async function twoActuallyVisibleScrollersCannotResumeOrWeakenTheGuard(){await check({twoVisibleScrollers:true},async({model,run})=>{
  await assert.rejects(run('reload_reception_runtime'),/unique_native_total_scroller_required/);assert.equal(model.starts,0);assert.equal(model.captures,1);
});}
async function explicitStopDuringIntakeReadCannotResumeTheCancelledCursor(){await check({stopDuringScrollerRead:true},async({model,run})=>{
  await assert.rejects(run('reload_reception_runtime'),/reception_round_cancelled/);assert.equal(model.starts,0);assert.equal(model.captures,1);
  await assert.rejects(run('reload_reception_runtime'),/runtime_resume_failed_preserved_hold/);assert.equal(model.starts,0);
});}

(async()=>{
  const cases=[twoActuallyVisibleScrollersCannotResumeOrWeakenTheGuard,explicitStopDuringIntakeReadCannotResumeTheCancelledCursor,collapsedZeroHeightScrollerCannotBlockTheOneVisibleIntake,actuallyEmptyAllListDoesNotRequireAnInventedScroller,middleVirtualScrollRestoresTopBeforeSameCursorResume,failedVirtualTopPreservesUnconsumedCursorForRetry,idleReloadPreservesCursorAndPrivateEvidence,busyWorkerCannotBeginReload,pendingRPCCannotBeginReload,
    unknownRPCPreflightCannotBeginReload,busyAfterAwaitCannotBeCaptured,unconfirmedCloseRetainsSingleCursorForRetry,
    newEngineFailureCannotRebaseline,failedResumeStaysHeldAndCanBeStopped,firstResumedTickMayProcessGapEntry,
    currentTabRestoresAllBeforeResumingTheSameCursor,failedNativeAllRestoreRetainsOneCursorForRetry];
  for(const test of cases) {await test();console.log("PASS "+test.name);}
  console.log(cases.length+" isolated runtime reload regressions passed; no browser or production resources used.");
})().catch(error=>{console.error(error);process.exitCode=1;});
