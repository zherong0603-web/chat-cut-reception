"use strict";

// Pure callback fixtures: no browser, files, account, Engine or external sends.
const assert=require("node:assert/strict");
const worker=require("../xhs_reception/ui_worker.cjs");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const A="aaaaaaaaaaaaaaaaaaaaaaaa",B="bbbbbbbbbbbbbbbbbbbbbbbb";
const row=(uid,content)=>({uid,nickname:"fixture",time:"12:00:00",content,active:false,
  data_focus_time:null,indicator_class_candidates:[]});
async function until(predicate) {
  const deadline=Date.now()+2500;
  while(!predicate()) {
    if(Date.now()>deadline) throw new Error("fixture_condition_timeout");
    await delay(5);
  }
}

async function baselineOrderAndPreviewDeduplication() {
  const page={};let rows=[row(A,"baseline")],reads=0;
  const selected=[],contexts=[];
  const callbacks={clock:()=>1000000,readSidebar:async()=>{reads++;return {rows};},
    selectAndRead:async(_page,candidate)=>{selected.push(candidate.uid);return {fixture_uid:candidate.uid};},
    processScope:async(_scope,context)=>{contexts.push(context);return {ok:true};}};
  try {
    const started=await worker.start(page,callbacks);
    assert.equal(started.startedAt,1000000);assert.equal(started.processed,0);
    assert.equal((await worker.start(page,callbacks)).startedAt,started.startedAt);
    assert.equal(reads,1); // One instance, one initial baseline.
    rows=[{...rows[0],active:true,element_class:"active fixture",nickname:"renamed fixture",
      data_focus_time:"changed-by-selection",indicator_class_candidates:["read-indicator"]}];
    await delay(300);assert.deepEqual(selected,[]);
    rows=[row(B,"newly-visible"),row(A,"changed")];
    await until(()=>worker.status(page).processed===2);
    assert.deepEqual(selected,[B,A]);
    assert(contexts.every(context=>context.startedAt===1000000 && !("fresh" in context)));
    assert.equal(contexts[0].rowIsNew,true);
    await delay(550);assert.deepEqual(selected,[B,A]);
    assert.equal(worker.status(page).candidates,0);
    delete require.cache[require.resolve("../xhs_reception/ui_worker.cjs")];
    assert.equal(require("../xhs_reception/ui_worker.cjs").status(page).processed,2);
  } finally {worker.stop(page);}
}

async function failuresCoolDownButNewFingerprintCanRun() {
  const page={};let rows=[row(A,"baseline")],now=1000000,calls=0;
  try {
    await worker.start(page,{clock:()=>now,readSidebar:async()=>({rows}),
      selectAndRead:async(_page,candidate)=>({preview:candidate.row.content}),
      processScope:async scope=>{calls++;return scope.preview==="failed-preview" ? {ok:false,error:{code:"fixture_failure"}} : {ok:true};}});
    rows=[row(A,"failed-preview")];await until(()=>calls===1);
    await until(()=>!worker.status(page).busy);
    assert.equal(worker.status(page).error.code,"fixture_failure");
    now+=29999;await delay(300);assert.equal(calls,1);
    now++;await until(()=>calls===2);await until(()=>!worker.status(page).busy);
    rows=[row(A,"actually-changed-preview")];await until(()=>calls===3);
    assert.equal(worker.status(page).processed,1);
    await delay(550);assert.equal(calls,3);
  } finally {worker.stop(page);}
}

async function temporarilyInvisiblePendingChangeReturnsExactlyOnce() {
  const page={};let rows=[row(A,"baseline-a"),row(B,"baseline-b")],reads=0;
  const selected=[];
  try {
    await worker.start(page,{readSidebar:async()=>{reads++;return {rows};},
      selectAndRead:async(_page,candidate)=>{
        assert(rows.some(visible=>visible.uid===candidate.uid),"An invisible pending UID must never select another customer");
        selected.push(candidate.uid);
        if(candidate.uid===A) rows=[row(A,"changed-a")];
        return {};
      },processScope:async()=>({ok:true})});
    rows=[row(A,"changed-a"),row(B,"changed-b")];
    await until(()=>selected.length===1 && reads>=3);
    assert.deepEqual(selected,[A]);
    assert.deepEqual(worker.status(page).candidateUIDs,[B],"A temporarily invisible, unprocessed change must stay pending");
    await delay(300);assert.deepEqual(selected,[A]);
    rows=[row(A,"changed-a"),row(B,"changed-b")];
    await until(()=>selected.length===2);
    assert.deepEqual(selected,[A,B]);
    await delay(550);assert.deepEqual(selected,[A,B]);
    assert.equal(worker.status(page).processed,2);assert.equal(worker.status(page).candidates,0);
  } finally {worker.stop(page);}
}

async function sidebarReadFailureRecoversWithShortBackoff() {
  const page={};let now=1000000,rows=[row(A,"baseline")],reads=0,failNext=false;
  const selected=[];
  try {
    await worker.start(page,{clock:()=>now,readSidebar:async()=>{
      reads++;if(failNext) {failNext=false;throw new Error("transient_sidebar_fixture");}
      return {rows};
    },selectAndRead:async(_page,candidate)=>{selected.push(candidate.uid);return {};},
    processScope:async()=>({ok:true})});
    rows=[row(A,"new customer preview")];failNext=true;
    await until(()=>worker.status(page).error?.stage==="readSidebar");
    const failedReads=reads;assert.deepEqual(selected,[]);
    now+=499;await delay(300);assert.equal(reads,failedReads);
    now++;await until(()=>worker.status(page).processed===1);
    assert.deepEqual(selected,[A]);assert.equal(worker.status(page).error,null);
    assert.equal(worker.status(page).startedAt,1000000);
    await delay(300);assert.deepEqual(selected,[A]);
  } finally {worker.stop(page);}
}

async function sidebarHealthCountsOnlyValidatedCompletedReads() {
  const page={};let now=1000000,mode="invalid",releaseRead;
  try {
    await worker.start(page,{clock:()=>now,readSidebar:async()=>{
      if(mode==="pending") return new Promise(resolve=>{releaseRead=resolve;});
      return {rows:mode==="invalid" ? [{uid:"not-a-native-uid",content:"PRIVATE_CUSTOMER_PREVIEW"}] : []};
    },selectAndRead:async()=>{throw new Error("health_fixture_must_not_select");},processScope:async()=>({ok:true})});
    assert.equal(worker.status(page).last_successful_sidebar_read_at,null);
    assert.equal(worker.status(page).last_tick,1000000);
    mode="valid";now=1000500;
    await until(()=>worker.status(page).error===null);
    assert.equal(worker.status(page).last_successful_sidebar_read_at,1000500);
    assert.equal(worker.status(page).read_inflight,false);assert.equal(worker.status(page).dispatch_inflight,false);
    mode="pending";now=1000750;await until(()=>Boolean(releaseRead));
    assert.equal(worker.status(page).read_inflight,true);assert.equal(worker.status(page).dispatch_inflight,false);
    assert.equal(worker.status(page).last_tick,1000750);
    assert.equal(worker.status(page).last_successful_sidebar_read_at,1000500);
    now=1000900;releaseRead({rows:[]});await until(()=>!worker.status(page).read_inflight);
    assert.equal(worker.status(page).last_successful_sidebar_read_at,1000900);
    assert(!JSON.stringify(worker.status(page)).includes("PRIVATE_CUSTOMER_PREVIEW"));
  } finally {releaseRead?.({rows:[]});worker.stop(page);}
}

async function cursorRetainsSuccessfulReadTimeUntilNewValidatedRead() {
  const page={};let now=1000000,invalid=false;
  const callbacks={clock:()=>now,readSidebar:async()=>({rows:invalid ? [{uid:"invalid"}] : []}),
    selectAndRead:async()=>{throw new Error("health_fixture_must_not_select");},processScope:async()=>({ok:true})};
  try {
    await worker.start(page,callbacks);const token=worker.captureCursor(page);worker.stop(page);
    invalid=true;now=1000100;await worker.start(page,{...callbacks,resumeCursor:token});
    assert.equal(worker.status(page).startedAt,1000000);
    assert.equal(worker.status(page).last_successful_sidebar_read_at,1000000);
    assert.equal(worker.status(page).last_tick,1000100);
    invalid=false;now=1000600;await until(()=>worker.status(page).error===null);
    assert.equal(worker.status(page).last_successful_sidebar_read_at,1000600);
    assert.equal(worker.status(page).startedAt,1000000);
  } finally {worker.stop(page);}
}

async function busyProcessingStillCollectsWithOneDispatcher() {
  const page={};let rows=[row(A,"baseline-a"),row(B,"baseline-b")],reads=0,releaseProcess;
  let entered=0,active=0,maxActive=0;const selected=[],contexts=[];
  try {
    await worker.start(page,{clock:()=>1000000,readSidebar:async()=>{reads++;return {rows};},
      selectAndRead:async(_page,candidate)=>{selected.push({uid:candidate.uid,preview:candidate.row.content});return candidate;},
      processScope:async(candidate,ctx)=>{
        contexts.push(ctx);entered++;active++;maxActive=Math.max(maxActive,active);
        if(candidate.uid===A) await new Promise(resolve=>{releaseProcess=resolve;});
        active--;return {ok:true};
      }});
    rows=[row(A,"changed-a"),row(B,"baseline-b")];await until(()=>entered===1);
    const busyReads=reads;
    rows=[row(A,"changed-a"),row(B,"changed-b")];
    await until(()=>reads>busyReads && worker.status(page).candidateUIDs.includes(B));
    assert.equal(entered,1);assert.deepEqual(selected.map(item=>item.uid),[A]);
    assert.throws(()=>worker.captureCursor(page),/idle_running_worker_cursor_required/);
    rows=[row(A,"changed-a"),row(B,"latest-b")];await delay(300);
    assert.equal(entered,1);assert.equal(maxActive,1);
    releaseProcess();await until(()=>worker.status(page).processed===2);
    assert.deepEqual(selected,[{uid:A,preview:"changed-a"},{uid:B,preview:"latest-b"}]);
    assert.equal(maxActive,1);assert(contexts.every(ctx=>ctx.startedAt===1000000));
    await delay(300);assert.equal(entered,2);assert.equal(worker.status(page).candidates,0);
  } finally {releaseProcess?.();worker.stop(page);}
}

async function busyRetryCannotQueueItsActiveFingerprintAgain() {
  const page={};let now=1000000,rows=[row(A,"baseline")],calls=0,reads=0,releaseRetry;
  try {
    await worker.start(page,{clock:()=>now,readSidebar:async()=>{reads++;return {rows};},
      selectAndRead:async()=>({}),processScope:async()=>{
        calls++;if(calls===1) return {ok:false,error:{code:"fixture_failure"}};
        if(calls===2) await new Promise(resolve=>{releaseRetry=resolve;});
        return {ok:true};
      }});
    rows=[row(A,"failed then retried")];await until(()=>worker.status(page).error?.code==="fixture_failure");
    now+=30000;await until(()=>calls===2);const retryReads=reads;
    await until(()=>reads>retryReads);
    assert.deepEqual(worker.status(page).candidateUIDs,[A]);
    releaseRetry();await until(()=>worker.status(page).processed===1);
    await delay(550);assert.equal(calls,2);assert.equal(worker.status(page).candidates,0);
  } finally {releaseRetry?.();worker.stop(page);}
}

async function pendingCollectorPreventsCursorAndDiscardsStoppedRead() {
  const page={};let reads=0,newReads=0,releaseRead,readContext,block=false,rows=[row(A,"baseline")];
  const selected=[];
  try {
    await worker.start(page,{readSidebar:async(_page,ctx)=>{
      reads++;if(block) {readContext=ctx;return new Promise(resolve=>{releaseRead=resolve;});}
      return {rows};
    },selectAndRead:async()=>{throw new Error("old_selection_must_not_run");},processScope:async()=>({ok:true})});
    block=true;await until(()=>Boolean(releaseRead));
    assert.throws(()=>worker.captureCursor(page),/idle_running_worker_cursor_required/);
    await delay(300);assert.equal(reads,2,"Only one read may be in flight");
    worker.stop(page);rows=[row(B,"new baseline")];
    await worker.start(page,{readSidebar:async()=>{newReads++;return {rows};},
      selectAndRead:async(_page,candidate)=>{selected.push(candidate.uid);return {};},processScope:async()=>({ok:true})});
    await delay(300);assert.equal(newReads,0,"A stopped generation must release its read before another begins");
    assert.equal(readContext.isCurrent(),false);assert.equal(readContext.signal.aborted,true);
    releaseRead({rows:[row(B,"obsolete pending read")]});
    await until(()=>newReads===1);assert.deepEqual(selected,[]);assert.equal(worker.status(page).processed,0);
    rows=[row(B,"new change")];await until(()=>worker.status(page).processed===1);assert.deepEqual(selected,[B]);
  } finally {releaseRead?.({rows:[]});worker.stop(page);}
}

async function restartRetainsSingleFlightAndDiscardsOldResult() {
  const page={};let releaseOld,oldReads=0,newReads=0,processed=0;
  let rows=[row(B,"new-baseline")],releaseSelection,selections=0;
  try {
    const oldStart=worker.start(page,{readSidebar:()=>{oldReads++;return new Promise(resolve=>{releaseOld=resolve;});},
      selectAndRead:async()=>{throw new Error("old_selection_must_not_run");},processScope:async()=>{processed++;}});
    assert.equal(oldReads,1);
    worker.stop(page);
    const restarted=await worker.start(page,{readSidebar:async()=>{newReads++;return {rows};},
      selectAndRead:()=>{selections++;return new Promise(resolve=>{releaseSelection=resolve;});},
      processScope:async()=>{processed++;}});
    assert.equal(restarted.busy,true);await delay(300);assert.equal(newReads,0);
    releaseOld({rows:[row(A,"obsolete")]});assert.equal((await oldStart).superseded,true);
    await until(()=>newReads>=1);assert.equal(processed,0);
    rows=[row(B,"new-change")];await until(()=>selections===1);
    worker.stop(page);releaseSelection({fixture:true});await until(()=>!worker.status(page).busy);
    assert.equal(processed,0);assert.equal(worker.status(page).running,false);
    assert.equal(worker.status(page).processed,0);
  } finally {worker.stop(page);}
}

async function stoppedProcessingCannotPublishLateFailure() {
  const page={};let rows=[row(A,"baseline")],reads=0,entered=0,rejectProcess,callbackContext;
  try {
    await worker.start(page,{readSidebar:async()=>{reads++;return {rows};},
      selectAndRead:async()=>({fixture:true}),
      processScope:(_scope,context)=>{entered++;callbackContext=context;return new Promise((_resolve,reject)=>{rejectProcess=reject;});}});
    rows=[row(A,"changed")];await until(()=>entered===1);
    await delay(300);assert(reads>=3); // Read-only collection continues while the dispatcher is occupied.
    const stopped=worker.stop(page);assert.equal(stopped.busy,true);
    assert.equal(callbackContext.signal.aborted,true);assert.equal(callbackContext.isCurrent(),false);
    rejectProcess(new Error("untrusted body must not enter status"));await until(()=>!worker.status(page).busy);
    assert.equal(worker.status(page).processed,0);assert.equal(worker.status(page).error,null);
    assert.equal(worker.status(page).running,false);
  } finally {worker.stop(page);}
}

async function duePollingUsesRealRowsAndResumesAfterIneligibility() {
  const page={};let now=1000000,reads=0,due=[{uid:A,source_event_id:"native-source",last_sent_at:10}];
  const rows=[row(A,"unchanged actual preview")],selected=[],contexts=[];
  try {
    await worker.start(page,{clock:()=>now,readSidebar:async()=>({rows}),
      readDueCandidates:async(_page,visible)=>{reads++;assert.deepEqual(visible,rows);return due;},
      selectAndRead:async(_page,candidate)=>{selected.push(candidate);return {};},
      processScope:async(_scope,ctx)=>{contexts.push(ctx);return {ok:true};}});
    await until(()=>selected.length===1);
    assert.equal(selected[0].reason,"followup_due");assert.deepEqual(selected[0].row,rows[0]);
    assert.equal(contexts[0].sourceEventId,"native-source");assert.equal(contexts[0].lastSentAt,10);
    assert.equal(contexts[0].reason,"followup_due");assert.equal(reads,1);
    now+=4999;await delay(300);assert.equal(reads,1);
    now++;await until(()=>reads===2);assert.equal(selected.length,1); // Same continuously due round is not replayed.
    due=[];now+=5000;await until(()=>reads===3);
    due=[{uid:A,source_event_id:"native-source",last_sent_at:10}];now+=5000;await until(()=>selected.length===2);
    due=[{uid:A,source_event_id:"native-source",last_sent_at:1810}];now+=1800000;await until(()=>selected.length===3);
    assert.notEqual(selected[1].fingerprint,selected[2].fingerprint);
  } finally {worker.stop(page);}
}

async function freshChangesPrecedeDueAndDueFailureDoesNotStopFresh() {
  const page={};let now=1000000,rows=[row(B,"baseline"),row(A,"baseline")],reads=0,failDue=false;
  const selected=[],contexts=[];
  try {
    await worker.start(page,{clock:()=>now,readSidebar:async()=>({rows}),
      readDueCandidates:async()=>{reads++;if(failDue) throw new Error("due_fixture_failed");
        return [{uid:B,source_event_id:"source-b",last_sent_at:10}];},
      selectAndRead:async(_page,candidate)=>{selected.push(candidate.uid);return {};},
      processScope:async(_scope,ctx)=>{contexts.push(ctx);return {ok:true};}});
    rows=[row(B,"baseline"),row(A,"fresh preview")];
    await until(()=>selected.length>=1);assert.equal(selected[0],A);assert.equal(contexts[0].reason,"sidebar_change");
    await until(()=>selected.length===2);assert.equal(selected[1],B);assert.equal(contexts[1].reason,"followup_due");
    failDue=true;now+=5000;await until(()=>reads===2);await until(()=>!worker.status(page).busy);
    assert.equal(worker.status(page).error.stage,"readDueCandidates");
    rows=[row(B,"baseline"),row(A,"another fresh preview")];await until(()=>selected.length===3);
    assert.equal(selected[2],A);assert.equal(reads,2); // Due cooldown does not throttle sidebar polling.
  } finally {worker.stop(page);}
}

async function invisibleDueAndLateStoppedDueCannotSelect() {
  const page={};let reads=0,release;
  try {
    await worker.start(page,{readSidebar:async()=>({rows:[row(A,"baseline")]}),
      readDueCandidates:async()=>[{uid:B,source_event_id:"foreign-visible-row",last_sent_at:10}],
      selectAndRead:async()=>{reads++;return {};},processScope:async()=>({ok:true})});
    await until(()=>worker.status(page).error?.stage==="readDueCandidates");assert.equal(reads,0);
    worker.stop(page);
    await worker.start(page,{readSidebar:async()=>({rows:[row(A,"baseline")]}),
      readDueCandidates:()=>new Promise(resolve=>{release=resolve;}),
      selectAndRead:async()=>{reads++;return {};},processScope:async()=>({ok:true})});
    await until(()=>Boolean(release));worker.stop(page);
    release([{uid:A,source_event_id:"old-generation",last_sent_at:10}]);
    await until(()=>!worker.status(page).busy);assert.equal(reads,0);assert.equal(worker.status(page).candidates,0);
  } finally {worker.stop(page);}
}

async function opaqueCursorRetainsCutoffAndDetectsRestartGapRows() {
  const page={};let now=1000000,rows=[row(A,"original baseline")],obsolete=0;
  const selected=[],contexts=[];
  const callbacks={clock:()=>now,readSidebar:async()=>({rows}),
    selectAndRead:async()=>{obsolete++;return {};},processScope:async()=>{obsolete++;}};
  let reloaded=worker;
  try {
    await worker.start(page,callbacks);const token=worker.captureCursor(page);
    assert.throws(()=>JSON.stringify(token),/worker_cursor_not_serializable/);
    await assert.rejects(worker.start({}, {...callbacks,resumeCursor:token}),/invalid_worker_resume_cursor/);
    worker.stop(page);now+=40;
    rows=[row(B,"new row during deployment"),row(A,"customer preview changed during deployment")];
    delete require.cache[require.resolve("../xhs_reception/ui_worker.cjs")];
    reloaded=require("../xhs_reception/ui_worker.cjs");
    await reloaded.start(page,{clock:()=>now,readSidebar:async()=>({rows}),resumeCursor:token,
      selectAndRead:async(_page,candidate)=>{selected.push(candidate.uid);return {};},
      processScope:async(_scope,ctx)=>{contexts.push(ctx);return {ok:true};}});
    await until(()=>selected.length===2);
    assert.deepEqual(selected,[B,A]);assert.equal(obsolete,0);
    assert(contexts.every(ctx=>ctx.startedAt===1000000));
    assert.equal(contexts[0].rowIsNew,true);assert.equal(contexts[1].rowIsNew,false);
    await assert.rejects(reloaded.start(page,{...callbacks,resumeCursor:{}}),/invalid_worker_resume_cursor/);
    await assert.rejects(reloaded.start(page,{...callbacks,resumeCursor:token}),/invalid_worker_resume_cursor/);
  } finally {reloaded.stop(page);}
}

async function exactDueTupleCanBeReconsideredOnceWithoutInventingRows() {
  const page={};let now=1000000,selected=0;
  const tuple={uid:A,source_event_id:"original-native-source",last_sent_at:10};
  try {
    await worker.start(page,{clock:()=>now,readSidebar:async()=>({rows:[row(A,"unchanged actual sidebar")]}),
      readDueCandidates:async()=>[tuple],selectAndRead:async(_page,candidate)=>{
        selected++;assert.equal(candidate.row.content,"unchanged actual sidebar");return {};},processScope:async()=>({ok:true})});
    await until(()=>selected===1);await until(()=>!worker.status(page).busy);
    assert.throws(()=>worker.reconsiderDue(page,{...tuple,source_event_id:"different-source"}),/exact_processed_due_required/);
    assert.equal(worker.reconsiderDue(page,tuple).reconsidered,true);
    assert.throws(()=>worker.reconsiderDue(page,tuple),/due_reconsideration_already_used/);
    await until(()=>selected===2);await until(()=>!worker.status(page).busy);
    assert.throws(()=>worker.reconsiderDue(page,tuple),/due_reconsideration_already_used/);
    now+=5000;await delay(300);assert.equal(selected,2);
  } finally {worker.stop(page);}
}

async function exactUnansweredSourceRecheckReusesFingerprintAndOriginalEpochOnce() {
  const page={};let now=1000000,rows=[row(A,"baseline")],calls=0;const contexts=[],selected=[];
  try {
    await worker.start(page,{clock:()=>now,readSidebar:async()=>({rows}),
      selectAndRead:async(_page,candidate)=>{selected.push({uid:candidate.uid,fingerprint:candidate.fingerprint});return {};},
      processScope:async(_scope,ctx)=>{contexts.push(ctx);calls++;return {ok:true};}});
    rows=[row(A,"same unanswered preview")];await until(()=>calls===1);await until(()=>!worker.status(page).busy);
    const originalFingerprint=selected[0].fingerprint;now+=9000;
    const tuple={uid:A,source_event_id:"id_native-account."+A+".unanswered-one"};
    const rechecked=worker.reconsiderUnanswered(page,tuple);
    assert.equal(rechecked.reconsidered,true);assert.equal(rechecked.source_event_id,tuple.source_event_id);
    assert.throws(()=>worker.reconsiderUnanswered(page,tuple),/unanswered_recheck_already_used/);
    await until(()=>calls===2);await until(()=>!worker.status(page).busy);
    assert.equal(selected[1].fingerprint,originalFingerprint);assert.equal(selected[1].uid,A);
    assert.equal(contexts[1].reason,"unanswered_recheck");assert.equal(contexts[1].sourceEventId,tuple.source_event_id);
    assert.equal(contexts[1].startedAt,1000000);assert.equal(worker.status(page).startedAt,1000000);
    await delay(300);assert.equal(calls,2);
    assert.throws(()=>worker.reconsiderUnanswered(page,tuple),/unanswered_recheck_already_used/);
  } finally {worker.stop(page);}
}

async function unansweredRecheckRequiresIdleExactVisibleSourceAndPreservesPendingUid() {
  const page={};let rows=[row(A,"unchanged actual preview")],reads=0,calls=0,releaseProcess;
  const selected=[];
  try {
    await worker.start(page,{readSidebar:async()=>{reads++;return {rows};},
      selectAndRead:async(_page,candidate)=>{selected.push(candidate.uid);return {};},
      processScope:async()=>{calls++;await new Promise(resolve=>{releaseProcess=resolve;});return {ok:true};}});
    const tuple={uid:A,source_event_id:"native-exact-unanswered"};
    for(const invalid of [{...tuple,uid:B},{...tuple,uid:"invalid"},{...tuple,source_event_id:""},
      {...tuple,source_event_id:"x".repeat(2049)}]) {
      assert.throws(()=>worker.reconsiderUnanswered(page,invalid),/idle_exact_visible_unanswered_required/);
    }
    worker.reconsiderUnanswered(page,tuple);rows=[];const before=reads;await until(()=>reads>before);
    assert.equal(calls,0);assert.deepEqual(worker.status(page).candidateUIDs,[A]);
    rows=[row(A,"unchanged actual preview")];await until(()=>calls===1);
    assert.throws(()=>worker.reconsiderUnanswered(page,{...tuple,source_event_id:"another-source"}),/idle_exact_visible_unanswered_required/);
    releaseProcess();await until(()=>!worker.status(page).busy);assert.deepEqual(selected,[A]);
    worker.stop(page);assert.throws(()=>worker.reconsiderUnanswered(page,tuple),/idle_exact_visible_unanswered_required/);
  } finally {releaseProcess?.();worker.stop(page);}
}

async function unansweredRecheckOncePerSourceSurvivesOpaqueCursorReload() {
  const page={};let now=1000000,calls=0;const contexts=[];let latest=worker;
  const callbacks={clock:()=>now,readSidebar:async()=>({rows:[row(A,"unchanged")]}),
    selectAndRead:async()=>({}),processScope:async(_scope,ctx)=>{calls++;contexts.push(ctx);return {ok:true};}};
  const tuple={uid:A,source_event_id:"native-source-one"};
  try {
    await worker.start(page,callbacks);worker.reconsiderUnanswered(page,tuple);
    await until(()=>calls===1);await until(()=>!worker.status(page).busy);
    const cursor=worker.captureCursor(page);worker.stop(page);now+=40;
    delete require.cache[require.resolve("../xhs_reception/ui_worker.cjs")];latest=require("../xhs_reception/ui_worker.cjs");
    await latest.start(page,{...callbacks,resumeCursor:cursor});
    assert.throws(()=>latest.reconsiderUnanswered(page,tuple),/unanswered_recheck_already_used/);
    latest.reconsiderUnanswered(page,{...tuple,source_event_id:"native-source-two"});
    await until(()=>calls===2);assert.equal(contexts[1].sourceEventId,"native-source-two");
    assert.equal(contexts[1].startedAt,1000000);assert.equal(latest.status(page).startedAt,1000000);
  } finally {latest.stop(page);}
}

async function trustedReleaseRevisionAllowsOneFurtherReadAndSurvivesOpaqueReload() {
  const page={};let now=1000000,calls=0,latest=worker;const contexts=[];
  const callbacks={clock:()=>now,readSidebar:async()=>({rows:[row(A,"same exact unanswered preview")]}),
    selectAndRead:async()=>({}),processScope:async(_scope,ctx)=>{calls++;contexts.push(ctx);return {ok:true,state:"human_owned"};}};
  const tuple={uid:A,source_event_id:"native-source-after-lead"};
  const release={...tuple,recheck_authorization_id:"human-release:trusted-owner:2026-10-27T02:40:00.000Z"};
  try {
    await worker.start(page,callbacks);worker.reconsiderUnanswered(page,tuple);
    await until(()=>calls===1);await until(()=>!worker.status(page).busy);
    assert.throws(()=>worker.reconsiderUnanswered(page,tuple),/unanswered_recheck_already_used/);
    now+=30000;
    const result=worker.reconsiderUnanswered(page,release);
    assert.equal(result.reconsidered,true);assert.equal(result.recheck_authorization_id,release.recheck_authorization_id);
    assert.throws(()=>worker.reconsiderUnanswered(page,release),/unanswered_recheck_already_used/);
    assert.throws(()=>worker.reconsiderUnanswered(page,{...release,recheck_authorization_id:"another-trusted-release"}),/unanswered_recheck_already_pending/);
    await until(()=>calls===2);await until(()=>!worker.status(page).busy);
    assert.equal(contexts[1].sourceEventId,tuple.source_event_id);
    assert.equal(contexts[1].recheckAuthorizationId,release.recheck_authorization_id);
    assert.equal(contexts[1].startedAt,1000000);assert.equal(contexts[1].reason,"unanswered_recheck");
    const cursor=worker.captureCursor(page);worker.stop(page);now+=100;
    delete require.cache[require.resolve("../xhs_reception/ui_worker.cjs")];latest=require("../xhs_reception/ui_worker.cjs");
    await latest.start(page,{...callbacks,resumeCursor:cursor});
    assert.throws(()=>latest.reconsiderUnanswered(page,tuple),/unanswered_recheck_already_used/);
    assert.throws(()=>latest.reconsiderUnanswered(page,release),/unanswered_recheck_already_used/);
    const laterRelease={...release,recheck_authorization_id:"human-release:second-real-release"};
    latest.reconsiderUnanswered(page,laterRelease);
    await until(()=>calls===3);assert.equal(contexts[2].startedAt,1000000);
    assert.equal(contexts[2].recheckAuthorizationId,laterRelease.recheck_authorization_id);
  } finally {latest.stop(page);}
}

async function malformedReleaseRevisionCannotQueueOrConsumeAValidRecheck() {
  const page={};let calls=0;
  const tuple={uid:A,source_event_id:"same-current-source"};
  try {
    await worker.start(page,{readSidebar:async()=>({rows:[row(A,"unchanged")]}),
      selectAndRead:async()=>({}),processScope:async()=>{calls++;return {ok:true};}});
    for(const revision of [null,1,{},""," "," release ","x".repeat(2049),"release\0collision"])
      assert.throws(()=>worker.reconsiderUnanswered(page,{...tuple,recheck_authorization_id:revision}),/idle_exact_visible_unanswered_required/);
    assert.equal(worker.status(page).candidates,0);assert.equal(calls,0);
    worker.reconsiderUnanswered(page,tuple);await until(()=>calls===1);
  }finally{worker.stop(page);}
}

(async()=>{
  const tests=[trustedReleaseRevisionAllowsOneFurtherReadAndSurvivesOpaqueReload,malformedReleaseRevisionCannotQueueOrConsumeAValidRecheck,
    exactUnansweredSourceRecheckReusesFingerprintAndOriginalEpochOnce,
    unansweredRecheckRequiresIdleExactVisibleSourceAndPreservesPendingUid,unansweredRecheckOncePerSourceSurvivesOpaqueCursorReload,
    baselineOrderAndPreviewDeduplication,failuresCoolDownButNewFingerprintCanRun,
    temporarilyInvisiblePendingChangeReturnsExactlyOnce,
    sidebarReadFailureRecoversWithShortBackoff,
    sidebarHealthCountsOnlyValidatedCompletedReads,cursorRetainsSuccessfulReadTimeUntilNewValidatedRead,
    busyProcessingStillCollectsWithOneDispatcher,busyRetryCannotQueueItsActiveFingerprintAgain,
    pendingCollectorPreventsCursorAndDiscardsStoppedRead,
    restartRetainsSingleFlightAndDiscardsOldResult,stoppedProcessingCannotPublishLateFailure,
    duePollingUsesRealRowsAndResumesAfterIneligibility,freshChangesPrecedeDueAndDueFailureDoesNotStopFresh,
    invisibleDueAndLateStoppedDueCannotSelect,opaqueCursorRetainsCutoffAndDetectsRestartGapRows,
    exactDueTupleCanBeReconsideredOnceWithoutInventingRows];
  for(const test of tests) {
    await test();console.log("PASS "+test.name);
  }
  console.log(tests.length+" pure callback worker regressions passed; no production evidence generated.");
})().catch(error=>{console.error(error);process.exitCode=1;});
