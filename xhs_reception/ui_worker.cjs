"use strict";

// Callback scheduler only. Sidebar changes are candidates, never entry events.
// Opaque callbacks own all UI/Engine work and must honor signal/isCurrent before
// any external action; stopping cannot undo work a callback already performed.
const key=Symbol.for("xhs_reception.ui_worker_pages");
const pages=globalThis[key] || (globalThis[key]=new WeakMap());
const cursorKey=Symbol.for("xhs_reception.ui_worker_cursors");
const cursors=globalThis[cursorKey] || (globalThis[cursorKey]=new WeakMap());
const POLL_MS=250,SIDEBAR_RETRY_MS=500,FAILURE_COOLDOWN_MS=30000,DUE_POLL_MS=5000;
const uidPattern=/^[a-f0-9]{24}$/;

function workerError(code) {const error=new Error(code);error.code=code;return error;}
function errorCode(error) {
  const value=error?.code || error?.error?.code || error?.message;
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) ? value : "callback_failed";
}
function fingerprint(row) {
  const string=value=>value == null ? null : typeof value === "string" ? value : (()=>{throw workerError("invalid_sidebar_row");})();
  // Focus, read badges, selection and nickname changes are not new previews.
  return JSON.stringify([row.uid,string(row.time),string(row.content)]);
}
function sidebarRows(snapshot) {
  if(!snapshot || !Array.isArray(snapshot.rows)) throw workerError("invalid_sidebar_snapshot");
  const seen=new Set();
  return snapshot.rows.map(row=>{
    if(!row || typeof row.uid !== "string" || !uidPattern.test(row.uid) || seen.has(row.uid)) throw workerError("invalid_sidebar_uid");
    seen.add(row.uid);
    return {uid:row.uid,fingerprint:fingerprint(row),row:{...row},rowIsNew:false};
  });
}
function attemptKey(candidate) {return candidate.uid+"\0"+(candidate.reason || "sidebar_change")+"\0"+candidate.fingerprint;}
function isBusy(state) {return Boolean(state.inflight || state.readInflight || state.dispatchInflight);}
function updateBusy(state) {state.busy=isBusy(state);}
function orderedCandidates(state) {
  const candidates=Array.from(state.queue.values()).sort((a,b)=>
    Number(a.reason==="followup_due")-Number(b.reason==="followup_due") || state.order.get(a.uid)-state.order.get(b.uid));
  if(state.activeCandidate && !candidates.some(candidate=>candidate.uid === state.activeCandidate.uid)) candidates.unshift(state.activeCandidate);
  return candidates;
}
function status(page) {
  const state=pages.get(page);
  if(!state) return {running:false,busy:false,last_tick:null,last_successful_sidebar_read_at:null,
    read_inflight:false,dispatch_inflight:false,candidates:0,processed:0,error:null,candidateUIDs:[],startedAt:null};
  const candidates=orderedCandidates(state);
  return {running:state.running,busy:isBusy(state),last_tick:state.last_tick,
    last_successful_sidebar_read_at:state.last_successful_sidebar_read_at ?? null,
    read_inflight:Boolean(state.readInflight),dispatch_inflight:Boolean(state.dispatchInflight),candidates:candidates.length,
    processed:state.processed,error:state.error ? {...state.error} : null,
    candidateUIDs:candidates.map(candidate=>candidate.uid),startedAt:state.startedAt};
}
function captureCursor(page) {
  const state=pages.get(page);
  if(!state?.running || isBusy(state) || !state.baselineReady || !Number.isFinite(state.startedAt)) throw workerError("idle_running_worker_cursor_required");
  let snapshot;
  try {
    snapshot=structuredClone({startedAt:state.startedAt,fingerprints:state.fingerprints,attempts:state.attempts,
      queue:state.queue,order:state.order,visibleRows:state.visibleRows,processed:state.processed,last_tick:state.last_tick,
      last_successful_sidebar_read_at:state.last_successful_sidebar_read_at ?? null,error:state.error,
      unansweredRechecks:state.unansweredRechecks ?? new Set(),
      sidebarRetryAt:state.sidebarRetryAt,nextDueReadAt:state.nextDueReadAt ?? 0});
  } catch(_) {throw workerError("worker_cursor_snapshot_failed");}
  const token=Object.freeze(Object.defineProperty(Object.create(null),"toJSON",{value:()=>{
    throw workerError("worker_cursor_not_serializable");
  }}));
  cursors.set(token,{page,source:state,generation:state.generation,snapshot});
  return token;
}
function reconsiderDue(page,{uid,source_event_id,last_sent_at}={}) {
  const state=pages.get(page);
  if(!state?.running || isBusy(state) || !state.baselineReady || !state.order.has(uid) ||
     !uidPattern.test(uid || "") || typeof source_event_id!=="string" || !source_event_id ||
     source_event_id.length>2048 || typeof last_sent_at!=="number" || !Number.isFinite(last_sent_at)) throw workerError("idle_exact_visible_due_required");
  const candidate={uid,reason:"followup_due",fingerprint:JSON.stringify([source_event_id,last_sent_at])};
  const attempt=state.attempts.get(attemptKey(candidate));
  if(attempt?.reconsideration_used) throw workerError("due_reconsideration_already_used");
  if(attempt?.outcome!=="processed" || attempt.reason!=="followup_due") throw workerError("exact_processed_due_required");
  state.attempts.set(attemptKey(candidate),{...attempt,outcome:"reconsider_pending",reconsideration_used:true});
  state.nextDueReadAt=0;
  return {reconsidered:true,reason:"exact_due_tuple_recheck_requested"};
}
function reconsiderUnanswered(page,{uid,source_event_id,recheck_authorization_id}={}) {
  const state=pages.get(page);
  const current=state?.visibleRows?.find(row=>row.uid===uid);
  if(!state?.running || isBusy(state) || !state.baselineReady || !state.order.has(uid) ||
     state.error?.stage==="readSidebar" || !uidPattern.test(uid || "") || !current ||
     current.fingerprint!==state.fingerprints.get(uid) || typeof source_event_id!=="string" ||
     !source_event_id.trim() || source_event_id.length>2048 || source_event_id.includes("\0") ||
     recheck_authorization_id!==undefined && (typeof recheck_authorization_id!=="string" ||
       !recheck_authorization_id || recheck_authorization_id.trim()!==recheck_authorization_id ||
       recheck_authorization_id.length>2048 || recheck_authorization_id.includes("\0"))) throw workerError("idle_exact_visible_unanswered_required");
  // The owner must first verify Engine's exact latest unanswered native source.
  // A revision must come from the owner's persisted HUMAN_RELEASE, never a
  // customer or external command. It authorizes one read, never an entry/send.
  state.unansweredRechecks ??= new Set();
  const tuple=uid+"\0"+source_event_id+(recheck_authorization_id===undefined?"":"\0"+recheck_authorization_id);
  if(state.unansweredRechecks.has(tuple)) throw workerError("unanswered_recheck_already_used");
  if(state.queue.has(uid)) throw workerError("unanswered_recheck_already_pending");
  state.unansweredRechecks.add(tuple);
  const pending=state.queue.get(uid),attempt=state.attempts.get(attemptKey(current));
  state.queue.set(uid,{...current,reason:"unanswered_recheck",source_event_id,recheck_authorization_id,
    first_seen_at:pending?.first_seen_at ?? attempt?.first_seen_at ?? null});
  return {reconsidered:true,reason:"exact_unanswered_source_recheck_requested",source_event_id,startedAt:state.startedAt,
    ...(recheck_authorization_id===undefined?{}:{recheck_authorization_id})};
}
function context(state,generation,signal,candidate) {
  return {startedAt:state.startedAt,generation,signal,
    isCurrent:()=>state.running && state.generation === generation && !signal.aborted,
    ...(candidate ? {candidateUID:candidate.uid,fingerprint:candidate.fingerprint,rowIsNew:candidate.rowIsNew,
      reason:candidate.reason || "sidebar_change",...(["followup_due","unanswered_recheck"].includes(candidate.reason) ?
        {sourceEventId:candidate.source_event_id,...(candidate.reason==="followup_due" ? {lastSentAt:candidate.last_sent_at} :
          candidate.recheck_authorization_id===undefined?{}:{recheckAuthorizationId:candidate.recheck_authorization_id})} : {})} : {})};
}
function dueRows(value,rows) {
  if(!Array.isArray(value)) throw workerError("invalid_due_candidates");
  const visible=new Map(rows.map(row=>[row.uid,row.row])),seen=new Set();
  return value.map(candidate=>{
    if(!candidate || !uidPattern.test(candidate.uid || "") || !visible.has(candidate.uid) || seen.has(candidate.uid) ||
      typeof candidate.source_event_id!=="string" || !candidate.source_event_id || candidate.source_event_id.length>2048 ||
      typeof candidate.last_sent_at!=="number" || !Number.isFinite(candidate.last_sent_at)) throw workerError("invalid_due_candidate");
    seen.add(candidate.uid);
    return {uid:candidate.uid,row:visible.get(candidate.uid),rowIsNew:false,reason:"followup_due",
      source_event_id:candidate.source_event_id,last_sent_at:candidate.last_sent_at,
      fingerprint:JSON.stringify([candidate.source_event_id,candidate.last_sent_at])};
  });
}
async function collectSidebar(page,state) {
  // Only read-only collection may overlap the current dispatcher. Old-generation
  // callbacks must finish before a replacement generation can access the page.
  if(!state.running || state.readInflight || state.inflight ||
     state.dispatchInflight && state.dispatchInflight.generation!==state.generation) return false;
  const now=state.clock();
  if(!Number.isFinite(now)) throw workerError("invalid_worker_clock");
  if(now < state.sidebarRetryAt) return false;
  const generation=state.generation,callbacks=state.callbacks,signal=state.controller.signal;
  const live=()=>state.running && state.generation === generation && !signal.aborted;
  const token={generation};state.readInflight=token;updateBusy(state);state.last_tick=now;
  try {
    const snapshot=await callbacks.readSidebar(page,context(state,generation,signal));
    if(!live()) return false;
    const rows=sidebarRows(snapshot);
    const currentTime=state.clock();
    if(!Number.isFinite(currentTime)) throw workerError("invalid_worker_clock");
    // A scheduler tick or an unresolved/invalid read is not successful intake.
    state.last_successful_sidebar_read_at=currentTime;
    state.visibleRows=rows;
    state.order=new Map(rows.map((row,index)=>[row.uid,index]));
    if(!state.baselineReady) {
      // Only this local cutoff is passed on; it is never a platform entry clock.
      state.startedAt=currentTime;state.baselineReady=true;
      for(const row of rows) {
        state.fingerprints.set(row.uid,row.fingerprint);
        state.attempts.set(attemptKey(row),{outcome:"baseline"});
      }
      if(state.error?.stage === "readSidebar") state.error=null;
      return false;
    }
    if(state.error?.stage === "readSidebar") state.error=null;
    // A list refresh can briefly hide a row without resolving its change.
    // Keep fresh work pending, but never dispatch a UID absent from this frame.
    for(const [uid,queued] of state.queue) if(!state.order.has(uid) && queued.reason==="followup_due") state.queue.delete(uid);
    for(const row of rows) {
      const previous=state.fingerprints.get(row.uid);
      state.fingerprints.set(row.uid,row.fingerprint);
      if(state.queue.get(row.uid)?.reason!=="followup_due" && state.queue.get(row.uid)?.fingerprint !== row.fingerprint) state.queue.delete(row.uid);
      const attempt=state.attempts.get(attemptKey(row));
      if(attempt?.outcome === "baseline" || attempt?.outcome === "processed") continue;
      if(attempt?.outcome === "failed" && currentTime < attempt.retryAt) continue;
      if(state.activeCandidate && attemptKey(state.activeCandidate)===attemptKey(row)) continue;
      if(previous !== row.fingerprint || attempt?.outcome === "failed") {
        state.queue.set(row.uid,{...row,reason:"sidebar_change",rowIsNew:previous === undefined,
          first_seen_at:attempt?.first_seen_at ?? currentTime});
      }
    }
    return true;
  } catch(error) {
    if(!live()) return false;
    const failedAt=state.clock();
    state.error={stage:"readSidebar",code:errorCode(error),at:failedAt};
    state.sidebarRetryAt=failedAt+SIDEBAR_RETRY_MS;
    return false;
  } finally {
    if(state.readInflight===token) state.readInflight=null;
    updateBusy(state);
  }
}
async function dispatchCandidate(page,state) {
  if(!state.running || !state.baselineReady || state.dispatchInflight || state.readInflight || state.inflight) return;
  const generation=state.generation,callbacks=state.callbacks,signal=state.controller.signal;
  const live=()=>state.running && state.generation===generation && !signal.aborted;
  const token={generation};state.dispatchInflight=token;updateBusy(state);
  let stage="readDueCandidates",candidate=null;
  try {
    const currentTime=state.clock(),rows=state.visibleRows;
    // A slow due reader must not delay a sidebar change already waiting here.
    if(callbacks.readDueCandidates && currentTime>=state.nextDueReadAt &&
       !Array.from(state.queue.values()).some(row=>row.reason!=="followup_due" && state.order.has(row.uid))) {
      state.nextDueReadAt=currentTime+DUE_POLL_MS;
      try {
        const due=dueRows(await callbacks.readDueCandidates(page,rows.map(row=>row.row),context(state,generation,signal)),rows);
        if(!live()) return;
        const eligible=new Set(due.map(attemptKey));
        for(const [key,attempt] of state.attempts) if(attempt.reason==="followup_due" && !eligible.has(key)) state.attempts.delete(key);
        for(const [uid,queued] of state.queue) if(queued.reason==="followup_due" && !eligible.has(attemptKey(queued))) state.queue.delete(uid);
        for(const row of due) {
          if(!state.order.has(row.uid)) continue;
          const attempt=state.attempts.get(attemptKey(row));
          if(attempt?.outcome==="processed" || attempt?.outcome==="failed" && currentTime<attempt.retryAt) continue;
          if(state.queue.get(row.uid)?.reason!=="sidebar_change") state.queue.set(row.uid,{...row,
            first_seen_at:attempt?.first_seen_at ?? currentTime});
        }
        if(state.error?.stage==="readDueCandidates") state.error=null;
      } catch(error) {
        if(!live()) return;
        state.nextDueReadAt=currentTime+FAILURE_COOLDOWN_MS;
        state.error={stage:"readDueCandidates",code:errorCode(error),at:currentTime};
        for(const [uid,queued] of state.queue) if(queued.reason==="followup_due") state.queue.delete(uid);
      }
    }
    candidate=orderedCandidates(state).find(row=>state.order.has(row.uid));
    if(!candidate) return;
    state.queue.delete(candidate.uid);state.activeCandidate=candidate;
    const callbackContext=context(state,generation,signal,candidate);
    stage="selectAndRead";
    const scope=await callbacks.selectAndRead(page,candidate,callbackContext);
    if(!live()) return;
    if(scope?.ok === false) throw workerError(errorCode(scope));
    stage="processScope";
    const result=await callbacks.processScope(scope,callbackContext);
    if(!live()) return;
    if(result === false || result?.ok === false) throw workerError(errorCode(result));
    state.attempts.set(attemptKey(candidate),{...state.attempts.get(attemptKey(candidate)),outcome:"processed",reason:candidate.reason});
    state.processed++;
    if(state.error?.candidateUID === candidate.uid) state.error=null;
  } catch(error) {
    if(!live()) return;
    const failedAt=state.clock();
    state.error={stage,code:errorCode(error),at:failedAt,...(candidate ? {candidateUID:candidate.uid} : {})};
    if(candidate) state.attempts.set(attemptKey(candidate),{...state.attempts.get(attemptKey(candidate)),outcome:"failed",reason:candidate.reason,retryAt:failedAt+FAILURE_COOLDOWN_MS,
      first_seen_at:candidate.first_seen_at});
    else state.nextDueReadAt=failedAt+FAILURE_COOLDOWN_MS;
  } finally {
    // An old generation may release only its own lock, never publish its result.
    if(state.dispatchInflight===token) state.dispatchInflight=null;
    updateBusy(state);
    if(state.generation === generation) state.activeCandidate=null;
  }
}
async function tick(page,state) {
  const generation=state.generation;
  if(await collectSidebar(page,state) && state.running && state.generation===generation) await dispatchCandidate(page,state);
}
async function start(page,{readSidebar,selectAndRead,processScope,readDueCandidates,resumeCursor,clock=Date.now}={}) {
  if(!page || (typeof page !== "object" && typeof page !== "function")) throw workerError("existing_page_required");
  if([readSidebar,selectAndRead,processScope,clock].some(callback=>typeof callback !== "function")) throw workerError("worker_callbacks_required");
  if(readDueCandidates!==undefined && typeof readDueCandidates!=="function") throw workerError("invalid_due_callback");
  let state=pages.get(page);
  const resume=resumeCursor!==undefined && resumeCursor!==null && typeof resumeCursor==="object" ? cursors.get(resumeCursor) : null;
  if(resumeCursor!==undefined && (!resume || resume.page!==page || resume.source!==state ||
    state?.generation!==resume.generation+1 || state.running)) throw workerError("invalid_worker_resume_cursor");
  if(state?.running) return status(page);
  if(!state) {state={generation:0,busy:false,inflight:null,readInflight:null,dispatchInflight:null};pages.set(page,state);}
  const generation=++state.generation;
  Object.assign(state,{running:true,clock,callbacks:{readSidebar,selectAndRead,processScope,readDueCandidates},controller:new AbortController(),
    startedAt:null,last_tick:null,last_successful_sidebar_read_at:null,baselineReady:false,fingerprints:new Map(),attempts:new Map(),
    queue:new Map(),order:new Map(),visibleRows:[],activeCandidate:null,unansweredRechecks:new Set(),processed:0,error:null,sidebarRetryAt:0,nextDueReadAt:0});
  if(resume) {
    Object.assign(state,resume.snapshot,{baselineReady:true});
    cursors.delete(resumeCursor);
  }
  state.timer=setInterval(()=>{void tick(page,state).catch(error=>{
    if(state.running && state.generation === generation) state.error={stage:"scheduler",code:errorCode(error),at:null};
  });},POLL_MS);
  state.timer.unref?.();
  await tick(page,state);
  return state.generation === generation ? status(page) : {...status(page),running:false,superseded:true};
}
function stop(page) {
  const state=pages.get(page);
  if(state) {
    state.running=false;state.generation++;
    clearInterval(state.timer);state.timer=null;state.controller?.abort();
    state.queue.clear();state.activeCandidate=null;
  }
  return status(page);
}

module.exports={start,stop,status,captureCursor,reconsiderDue,reconsiderUnanswered,startWorker:start,stopWorker:stop};
