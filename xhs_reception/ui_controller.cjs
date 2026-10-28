"use strict";

// One local observer/controller. UI actions belong only to injected callbacks.
const fs=require("node:fs");
const path=require("node:path");
const worker=require("./ui_worker.cjs");
const engine=require("./ui_engine.cjs");
const {readSidebar}=require("./ui_sidebar.cjs");
const {classifyTerminal}=require("./native_terminal_observer.cjs");
const key=Symbol.for("xhs_reception.ui_controllers");
const controllers=globalThis[key] || (globalThis[key]=new WeakMap());
const unresolved=new Set(["PREPARED","CLAIMED","SUBMITTING","UNKNOWN"]);
const priceReply="你问的报价需要顾问结合具体需求核对。可以添加企微，把目的国、产品和发货需求发过去，方便继续沟通。";
const genericReply="可以添加我们的企业微信顾问，把目的国、产品和发货需求发过去，方便继续对接。";
const followupReply="你这边还在看海外仓吗？可以添加企微顾问，把目的国、产品和发货需求发过去，方便继续沟通。";
const uidPattern=/^[a-f0-9]{24}$/;
const HEALTH_INTERVAL_MS=5000;

function fail(code) {const error=new Error(code);error.code=code;return error;}
function code(error) {
  const value=error?.code || error?.error?.code || error?.message;
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(value) ? value : "controller_callback_failed";
}
function pageArg(value) {return value?.page || value;}
function utc(value) {
  if(!Number.isFinite(value)) return null;
  const date=new Date(value);return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function workerHealth(value={}) {
  const count=value=>Number.isSafeInteger(value) && value>=0 ? value : null;
  const stage=value=>typeof value==="string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) ? value : "worker_callback";
  return {running:value.running===true,busy:value.busy===true,
    last_tick_at_utc:utc(value.last_tick),last_successful_sidebar_read_at_utc:utc(value.last_successful_sidebar_read_at),
    read_inflight:value.read_inflight===true,dispatch_inflight:value.dispatch_inflight===true,
    candidates:count(value.candidates),processed:count(value.processed),
    error:value.error ? {stage:stage(value.error.stage),code:code(value.error),at_utc:utc(value.error.at)} : null};
}
function clearHealthTimer(state) {clearInterval(state.healthTimer);state.healthTimer=null;}
function status(value) {
  const page=pageArg(value),state=controllers.get(page);
  if(!state) return {running:false,classification:"local_ui_controller",last_result:null};
  const currentWorker=worker.status(page);
  return {running:state.running,classification:"local_ui_controller",worker:currentWorker,
    startedAt:currentWorker.startedAt,held_conversations:state.holds.size,
    reception_mode:state.futureEntriesOnly ? "future_entries_only" : "new_entries_and_due_followups",
    historical_followups_enabled:!state.futureEntriesOnly,
    reception_epoch_started_at_utc:Number.isFinite(currentWorker.startedAt) ? new Date(currentWorker.startedAt).toISOString() : null,
    cursor_restoration:state.cursorRestoration,
    processed_scopes:state.processed,last_result:state.lastResult ? {...state.lastResult} : null,
    health_write_error:state.healthWriteError ? {...state.healthWriteError} : null};
}
function publish(state,result,force=false) {
  if(controllers.get(state.page)!==state || !state.running && result?.state!=="stopped") return;
  if(result) state.lastResult=result;
  const health=status(state.page);
  // Intake timestamps are distinct from this file's write time. Only bounded
  // scheduler fields enter health; previews and callback bodies stay excluded.
  const record={classification:"local_ui_controller_health",running:health.running,
    started_at_utc:Number.isFinite(health.startedAt) ? new Date(health.startedAt).toISOString() : null,
    reception_mode:health.reception_mode,historical_followups_enabled:health.historical_followups_enabled,
    reception_epoch_started_at_utc:health.reception_epoch_started_at_utc,cursor_restoration:health.cursor_restoration,
    processed_scopes:state.processed,held_conversations:state.holds.size,last_result:state.lastResult,
    worker:workerHealth(health.worker),previous_health_write_error:state.healthWriteError};
  const signature=JSON.stringify(record);
  if(!force && signature===state.healthSignature) return;
  const destination=path.join(state.runtime,"worker-status.json");
  const temporary=destination+"."+process.pid+".tmp";
  try {
    if(fs.existsSync(destination) && !fs.lstatSync(destination).isFile()) throw fail("unsafe_worker_status_path");
    fs.writeFileSync(temporary,JSON.stringify({...record,recorded_at_utc:new Date().toISOString()},null,2)+"\n",
      {encoding:"utf8",mode:0o600,flag:"wx"});
    try {fs.renameSync(temporary,destination);} finally {if(fs.existsSync(temporary)) fs.unlinkSync(temporary);}
    state.healthSignature=signature;state.healthWriteError=null;
  } catch(error) {state.healthWriteError={code:code(error),at_utc:new Date().toISOString()};throw error;}
}
function legacyProbe(runtime) {
  const file=path.join(runtime,"connection.json");
  if(!fs.lstatSync(file).isFile() || fs.statSync(file).size>1024*1024) throw fail("connection_health_unavailable");
  let connection;
  try {connection=JSON.parse(fs.readFileSync(file,"utf8"));} catch(_) {throw fail("connection_health_unavailable");}
  return connection?.card_probe;
}
function legacyHeld(runtime,uid,probe=legacyProbe(runtime)) {
  return probe?.conversation_uid===uid && (probe.retry_allowed===false || /unknown/i.test(probe.status || ""));
}
function due(conversation,now) {
  return conversation?.state==="ACTIVE" && conversation.needs_response===0 &&
    typeof conversation.latest_event_id==="string" && Boolean(conversation.latest_event_id) &&
    Number.isFinite(conversation.next_followup_at) && conversation.next_followup_at<=now &&
    Number.isFinite(conversation.last_sent_at) && now-conversation.last_sent_at>=1800;
}
async function expireKnownUnsubmitted(client,accountId,uid,outbox) {
  if(!outbox.some(row=>row.account_id===accountId && row.conversation_id===uid &&
    ["PREPARED","CLAIMED"].includes(row.status) && Number.isFinite(row.expires_at) && row.expires_at<=Date.now()/1000)) return false;
  const response=await client.request("expire_unsubmitted",{account_id:accountId,conversation_id:uid});
  if(!response?.ok || response.result?.account_id!==accountId || response.result?.conversation_id!==uid ||
    !Array.isArray(response.result?.expired_intent_ids)) throw fail("unsubmitted_expiry_unconfirmed");
  return true;
}
async function readDueCandidates(state,rows,ctx) {
  if(state.futureEntriesOnly || !state.running || !ctx.isCurrent()) return [];
  const client=engine.getClient(state.runtime);
  const read=async()=>{
    const response=await client.request("status",{}),value=response?.result;
    if(!response?.ok || !uidPattern.test(value?.account_scope || "") || !Array.isArray(value?.conversations) ||
       !Array.isArray(value?.outbox) || [...value.conversations,...value.outbox].some(row=>
         row.account_id!==value.account_scope || !uidPattern.test(row.conversation_id || ""))) throw fail("engine_due_status_unavailable");
    return value;
  };
  let value=await read();
  if(!state.running || !ctx.isCurrent()) return [];
  const visible=new Set(rows.map(row=>row.uid));let cleaned=false;
  for(const con of value.conversations) {
    if(!state.running || !ctx.isCurrent()) return [];
    if(visible.has(con.conversation_id) && due(con,Date.now()/1000)) cleaned=await expireKnownUnsubmitted(client,
      value.account_scope,con.conversation_id,value.outbox) || cleaned;
  }
  if(cleaned) value=await read();
  if(!state.running || !ctx.isCurrent()) return [];
  const blocked=new Set(value.outbox.filter(row=>unresolved.has(row.status)).map(row=>row.conversation_id));
  const probe=legacyProbe(state.runtime),now=Date.now()/1000;
  return value.conversations.filter(con=>visible.has(con.conversation_id) && !blocked.has(con.conversation_id) &&
    !legacyHeld(state.runtime,con.conversation_id,probe) && due(con,now)).map(con=>({uid:con.conversation_id,
      source_event_id:con.latest_event_id,last_sent_at:con.last_sent_at}));
}
async function readStatus(client,scope) {
  const response=await client.request("status",{account_id:scope.account_id,conversation_id:scope.conversation_id});
  const value=response?.result;
  if(!response?.ok || value?.account_scope!==scope.account_id || !Array.isArray(value?.outbox) ||
    !Array.isArray(value?.conversations) || value.conversations.length>1 ||
    [...value.outbox,...value.conversations].some(row=>row.account_id!==scope.account_id ||
      row.conversation_id!==scope.conversation_id)) throw fail("engine_scope_status_unavailable");
  return value;
}
function nativeTime(message) {
  if(typeof message?.raw_timestamp!=="string" || !/^\d{13}$/.test(message.raw_timestamp)) throw fail("invalid_native_timestamp");
  const value=Number(message.raw_timestamp);
  if(!Number.isSafeInteger(value)) throw fail("invalid_native_timestamp");
  return value;
}
function inbound(message) {
  return message.direction==="left" && message.raw_type==="TEXT" ||
    message.direction==="center" && message.raw_type==="RICH_HINT" &&
      message.raw_text.includes("对方通过") && message.raw_text.includes("进入私信");
}
function trustedOriginalSource(event,scope,conversation) {
  if(!event || event.account_id!==scope.account_id || event.conversation_id!==scope.conversation_id ||
     event.event_id!==conversation.latest_event_id || event.timestamp_source!=="platform_ui" ||
     !Number.isFinite(event.timestamp) || !Number.isFinite(event.detected_at) ||
     event.timestamp>event.detected_at+1 || event.detected_at>Date.now()/1000+1 ||
     event.timestamp!==conversation.latest_event_at || event.timestamp>conversation.last_sent_at) return false;
  const proof=event.evidence;
  if(!proof || proof.source!=="platform_ui" || proof.timestamp_source!=="platform_ui" ||
     proof.account_id!==scope.account_id || proof.conversation_id!==scope.conversation_id ||
     proof.reference!==event.event_id || !Number.isFinite(proof.observed_at) || proof.observed_at!==event.detected_at ||
     typeof proof.historical_baseline!=="boolean") return false;
  const prefix=["id_"+scope.account_id+"."+scope.conversation_id+".",
    "id_"+scope.conversation_id+"."+scope.account_id+"."].find(value=>typeof event.event_id==="string" && event.event_id.startsWith(value));
  if(!prefix || !/^[A-Za-z0-9_-]{1,256}$/.test(event.event_id.slice(prefix.length)) ||
     proof.native_message_id!=="jarvis-msg-"+event.event_id.slice(3)) return false;
  return event.type==="CUSTOMER_MESSAGE" && proof.native_message_type==="TEXT" && proof.native_direction==="left" ||
    event.type==="NEW_VISITOR" && proof.native_message_type==="RICH_HINT" && proof.native_direction==="center";
}
function publicWechat(runtime,accountId) {
  try {
    const file=path.join(runtime,"..","reception.json");
    if(!fs.lstatSync(file).isFile() || fs.statSync(file).size>65536) return null;
    const value=JSON.parse(fs.readFileSync(file,"utf8")),proof=value.public_contact_wechat_evidence;
    return value.account_id===accountId && typeof value.public_contact_wechat==="string" &&
      /^[A-Za-z][A-Za-z0-9_-]{5,19}$/.test(value.public_contact_wechat) && proof?.account_id===accountId &&
      proof.source==="platform_ui" && proof.verified===true && typeof proof.reference==="string" && proof.reference.length>0 && proof.reference.length<=2048 ?
      value.public_contact_wechat : null;
  } catch(_) {return null;}
}
function directQuestionReply(latest,wechat) {
  if(/(?:微信|企微).*(?:多少|号码|号|联系|哪里|怎么)|(?:怎么|哪里).*(?:微信|企微)|联系方式/.test(latest)) {
    return wechat ? "我们的客服微信是 "+wechat+"。你可以把货品和发货需求发过去继续对接。" :
      "我先核对当前可用的客服微信，避免给你错误的联系方式。";
  }
  if(/日本/.test(latest) && !/报价|价格|费用|多少钱|收费|运费|价钱/.test(latest)) {
    return "日本方向能否承接，需要先核实仓储和服务资源。你这边是什么货品、预计多少货量，需要一件代发吗？";
  }
  return null;
}
function replyFor(messages,wechat) {
  const latest=messages.map((message,index)=>({message,index})).filter(({message})=>
    message.direction==="left" && message.raw_type==="TEXT").sort((a,b)=>
      nativeTime(b.message)-nativeTime(a.message) || b.index-a.index)[0]?.message.raw_text.trim() || "";
  const direct=directQuestionReply(latest,wechat);if(direct) return direct;
  const reply=/(?:报价|价格|费用|多少钱|收费|运费|价钱)/.test(latest) ? priceReply : genericReply;
  return /^(?:hi|hello|hey|你好|您好|在吗|在不在|有人吗|哈[喽啰]|嗨)[?？!！。.，,\s]*$/i.test(latest) ? "在的。"+reply : reply;
}
function replyForCurrentRound(freshInbound,sourceEventId,wechat) {
  const ordered=freshInbound.map((message,index)=>({message,index,at:nativeTime(message)}))
    .sort((a,b)=>a.at-b.at || a.index-b.index);
  const sourceIndex=ordered.findIndex(({message})=>message.dom_id===sourceEventId);
  if(sourceIndex<0) throw fail("fresh_native_reply_source_required");
  // A later entry starts a new conversation round even within this worker epoch.
  // Fence at the exact current source so neither earlier rounds nor later events supply its words.
  let start=0;
  for(let index=0;index<=sourceIndex;index++) {
    const message=ordered[index].message;
    if(message.direction==="center" && message.raw_type==="RICH_HINT" && inbound(message)) start=index;
  }
  return replyFor(ordered.slice(start,sourceIndex+1).map(({message})=>message),wechat);
}
function serviceReplyFor(messages,sourceEventId,wechat) {
  const source=messages.find(message=>message.dom_id===sourceEventId && message.direction==="left" && message.raw_type==="TEXT");
  if(!source) throw fail("service_customer_source_required");
  const direct=directQuestionReply(source.raw_text,wechat);if(direct) return direct;
  if(/^(?:hi|hello|hey|你好|您好|在吗|在不在|有人吗|哈[喽啰]|嗨)[?？!！。.，,\s]*$/i.test(source.raw_text.trim()))
    return "在的。请问你这次想了解哪个方向的海外仓服务？";
  const ordered=messages.map((message,index)=>({message,index,at:nativeTime(message)})).sort((a,b)=>a.at-b.at || a.index-b.index);
  const sourceIndex=ordered.findIndex(({message})=>message===source);
  let start=0;
  for(let index=0;index<=sourceIndex;index++){
    const message=ordered[index].message;
    if(message.direction==="center" && message.raw_type==="RICH_HINT" && inbound(message))start=index;
  }
  // A short supplement can complete the preceding question. Keep only real
  // left TEXT in this entry round, stopping at the exact source, even on ties.
  const context=ordered.slice(start,sourceIndex+1).map(({message})=>message)
    .filter(message=>message.direction==="left" && message.raw_type==="TEXT")
    .slice(-12).map(message=>message.raw_text.slice(0,1000)).join("\n");
  if(/报价|价格|费用|多少钱|收费|运费|价钱/.test(context)) {
    if(/衣服|衣物|服装/.test(context) && /寄|转运/.test(context))
      return "衣服报价要先确认发货方案。你是个人寄件，还是店铺备货或订单发货？从哪里发到哪个国家，预计多少件、总重量多少？";
    const missing=[];
    if(!/美国|美区|墨西哥|英国|德国|法国|加拿大|澳大利亚|日本|西班牙|意大利|荷兰|波兰|\b(?:USA|UK|US|EU)\b/i.test(context)) missing.push("目的国或仓库");
    if(!/(?:货品|产品|品类|SKU)[：:是为]\s*\S{1,80}/i.test(context)) missing.push("货品类型");
    if(!/\d+\s*(?:件|箱|托盘|托|方|CBM|个SKU)/i.test(context)) missing.push("预计件量");
    if(!/(?:尺寸|箱规|长宽高)[：:为是]?\s*\d|\d+\s*[*x×]\s*\d/i.test(context) ||
       !/(?:重量|单箱重|毛重|净重)[：:为是]?\s*\d|\d+\s*(?:kg|公斤|千克|克)\b/i.test(context)) missing.push("货品尺寸重量");
    if(!/仓储|入库|出库|一件代发|换标|移仓|退货/.test(context)) missing.push("所需服务（如仓储或一件代发）");
    return missing.length ? "报价需要按具体需求核对。请补充"+missing.join("、")+"，我先把核价信息确认齐。" :
      "你提供的核价信息收到。具体费用需要按目的国、货品、件量和服务项目核对，以确认后的正式报价为准。";
  }
  return "我接着帮你确认这项需求。请把这次需要了解的具体问题和相关货品信息发我，方便按当前问题继续对接。";
}
function safeReceiveResult(result) {
  const allowed=value=>typeof value==="string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) ? value : "unknown";
  return {state:allowed(result?.state),
    text_status:allowed(result?.text?.status),card_status:allowed(result?.card?.status),
    ...(result?.text_only_service===true ? {text_only_service:true,card_status:"not_requested"} : {}),
    ...(result?.text_only_correction===true ? {text_only_correction:true,card_status:"not_requested"} : {}),
    ...(Number.isFinite(result?.elapsed_ms) ? {elapsed_ms:result.elapsed_ms} : {}),
    ...(Number.isFinite(result?.platform_entry_to_all_confirmed_ms) ?
      {platform_entry_to_all_confirmed_ms:result.platform_entry_to_all_confirmed_ms} : {}),
    full_five_second_acceptance:result?.full_five_second_acceptance===true};
}
function confirmedTakeover(result,scope) {
  const native=result?.after_mode;
  return result?.state==="native_manual_mode_confirmed" && result.taken_over===true &&
    result.account_id===scope.account_id && result.conversation_id===scope.conversation_id &&
    typeof result.takeover_clicked==="boolean" && result.customer_send_performed===false &&
    result.full_five_second_acceptance===false && native?.scope_ready===true &&
    native.manual===true && native.input_ready===true && native.manual_switch_enabled===true &&
    native.overlay_visible===false && native.takeover_visible===false;
}
async function processScope(state,scope,ctx) {
  const current=()=>state.running && ctx.isCurrent();
  if(!current()) return {ok:true,state:"cancelled"};
  if(!Number.isFinite(ctx.startedAt) || !scope || scope.scope_ready!==true ||
     scope.conversation_id!==ctx.candidateUID || !Array.isArray(scope.messages) || !scope.messages.length) {
    throw fail("candidate_native_scope_required");
  }
  const uid=scope.conversation_id;
  const hasTextService=con=>(con?.state==="ACTIVE" || con?.state==="STOPPED" &&
    ["WECHAT_VERIFIED","LEAD_VERIFIED"].includes(con.stop_reason)) && con.service_reply?.eligible===true &&
    con.service_reply.source_event_id===con.latest_event_id;
  const boundedUnknownPolicy=value=>{
    const con=value.conversations[0];
    const capability=ctx.reason==="unanswered_recheck" && ctx.sourceEventId===con?.latest_event_id && con?.correction_reply?.eligible===true ?
      con.correction_reply : hasTextService(con) ? con.service_reply : null;
    const ids=capability?.prior_unknown_hold_ids;
    if(capability?.eligible!==true || capability.source_event_id!==con?.latest_event_id || !Array.isArray(ids) ||
       new Set(ids).size!==ids.length || ids.some(id=>typeof id!=="string")) return false;
    const live=value.outbox.filter(row=>unresolved.has(row.status));
    return live.length===ids.length && live.every(row=>row.status==="UNKNOWN" && row.kind==="card" && ids.includes(row.intent_id));
  };
  const client=engine.getClient(state.runtime);
  let before=await readStatus(client,scope);
  if(current() && await expireKnownUnsubmitted(client,scope.account_id,uid,before.outbox)) before=await readStatus(client,scope);
  if(!current()) return {ok:true,state:"cancelled"};
  const known=new Set();
  for(const row of before.outbox) {
    if(typeof row.evidence?.native_message_id==="string") known.add(row.evidence.native_message_id);
    if(Array.isArray(row.evidence?.native_message_ids)) for(const id of row.evidence.native_message_ids) if(typeof id==="string") known.add(id);
  }
  const old=[],recent=[];
  for(const message of scope.messages) (nativeTime(message)>ctx.startedAt ? recent : old).push(message);
  for(const [messages,historicalBaseline] of [[old,true],[recent,false]]) {
    if(!messages.length) continue;
    if(!current()) return {ok:true,state:"cancelled"};
    const ingested=await engine.ingestObservedScope(client,{...scope,messages},{historicalBaseline});
    if(!ingested?.ok) throw fail("native_scope_ingest_failed");
  }
  state.processed++;
  const finish=(stateName,extra={})=>{
    const result={state:stateName,uid,reason:ctx.reason || "sidebar_change",historical_messages:old.length,recent_messages:recent.length,...extra};
    publish(state,result);return {ok:true,...result};
  };
  if(!current()) return finish("cancelled");
  const terminal=classifyTerminal(scope,Date.now());
  if(terminal.status==="unready") return finish("terminal_observation_unready");
  for(const event of terminal.events) {
    if(!current()) return finish("cancelled");
    const response=await client.request("ingest",{event});
    if(!response?.ok || response.result?.conversation?.account_id!==scope.account_id ||
       response.result?.conversation?.conversation_id!==uid || response.result.conversation.state!=="STOPPED") {
      throw fail("native_terminal_persistence_unconfirmed");
    }
  }
  if(terminal.events.some(event=>event.type==="REFUSED")) return finish("terminal_stopped",{terminal_events:terminal.events.map(event=>event.type)});
  if(legacyHeld(state.runtime,uid)) return finish("legacy_unknown_hold");
  // Native inbound ingestion may have cancelled a never-submitted old draft.
  // Submission uncertainty survives ingestion and must still block below.
  before=await readStatus(client,scope);
  if(!current()) return finish("cancelled");
  // An original submission may have reached the UI without its native ID.
  // Resolve that operation before attributing any visible right-side message.
  if(before.outbox.some(row=>unresolved.has(row.status)) && !boundedUnknownPolicy(before)) return finish("unresolved_engine_hold");
  // A right-side message without a trustworthy operator label is an observed
  // outbound only. Missing attribution cannot prove a continuing human
  // takeover, and must not block the next customer turn.
  const after=await readStatus(client,scope);
  if(!current()) return finish("cancelled");
  if(after.outbox.some(row=>unresolved.has(row.status)) && !boundedUnknownPolicy(after)) return finish("unresolved_engine_hold");
  const conversation=after.conversations[0];
  if(conversation?.state==="HUMAN") {
    state.holds.add(uid);return finish("external_operator_ownership_hold");
  }
  state.holds.delete(uid);
  const service=hasTextService(conversation);
  const correction=conversation?.state==="ACTIVE" && conversation.correction_reply?.eligible===true &&
    conversation.correction_reply.source_event_id===conversation.latest_event_id && ctx.reason==="unanswered_recheck" &&
    ctx.sourceEventId===conversation.latest_event_id && typeof conversation.correction_reply.correction_of_intent_id==="string";
  if(conversation?.correction_reply?.correction_of_intent_id && !correction) return finish("independent_quality_correction_hold");
  if(terminal.hold==="requires_lead_review" && !service) return finish("requires_lead_review");
  if(!conversation || conversation.state!=="ACTIVE" && !service) return finish(terminal.events.length ? "terminal_stopped" : "conversation_not_active");
  const now=Date.now();
  const aiActivity=recent.some(message=>message.direction==="right" &&
    message.native_ai_attribution_observed===true && nativeTime(message)<=now);
  let takeover=null;
  if(aiActivity && typeof state.takeoverOnly==="function") {
    if(!current()) return finish("cancelled");
    takeover=await state.takeoverOnly({uid,isCurrent:current,startedAt:ctx.startedAt});
    if(!current()) return finish("cancelled_after_takeover");
    if(!confirmedTakeover(takeover,scope)) throw fail("native_takeover_confirmation_required");
  }
  const runtimeInbound=recent.filter(message=>inbound(message) && nativeTime(message)<=now);
  let freshSourceIds=new Set();
  let text,isCurrent;
  if(conversation.needs_response===1 && runtimeInbound.length) {
    freshSourceIds=new Set(runtimeInbound.map(message=>message.dom_id));
    if(!freshSourceIds.has(conversation.latest_event_id)) return finish("fresh_native_source_not_current");
    if(service && !runtimeInbound.some(message=>message.dom_id===conversation.latest_event_id && message.direction==="left" && message.raw_type==="TEXT")) {
      return finish("service_customer_source_required");
    }
    const wechat=publicWechat(state.runtime,scope.account_id);
    text=runtimeInbound.some(message=>message.dom_id===conversation.latest_event_id && message.direction==="left" && message.raw_type==="TEXT") ?
      serviceReplyFor(scope.messages,conversation.latest_event_id,wechat) : replyForCurrentRound(runtimeInbound,conversation.latest_event_id,wechat);
    // Latency targets are measurements, never a deadline for abandoning a lead.
    // The sender/Engine still recheck the current native context before submit.
    isCurrent=current;
  } else if(ctx.reason==="followup_due") {
    if(state.futureEntriesOnly) return finish("historical_followups_disabled");
    if(!due(conversation,now/1000) || conversation.latest_event_id!==ctx.sourceEventId ||
       conversation.last_sent_at!==ctx.lastSentAt) return finish("followup_no_longer_due");
    if(!trustedOriginalSource(after.latest_event,scope,conversation)) return finish("followup_original_source_unverified");
    text=followupReply;isCurrent=current;
  } else if(takeover) return finish("ai_reception_taken_over_only",{
    native_manual_mode_confirmed:true,takeover_clicked:takeover.takeover_clicked,
    customer_send_performed:false,full_five_second_acceptance:false});
  else return finish("no_unanswered_runtime_inbound");
  if(!isCurrent()) return finish("cancelled");
  const received=await state.receive({uid,text,freshSourceIds,isCurrent,startedAt:ctx.startedAt,
    ...(service ? {textOnlyService:true,sourceEventId:conversation.latest_event_id} : {}),
    ...(correction ? {correctionOfIntentId:conversation.correction_reply.correction_of_intent_id,sourceEventId:conversation.latest_event_id} : {})});
  if(!current()) return finish("cancelled_after_callback");
  return finish("receive_returned",{receive:safeReceiveResult(received)});
}
async function start({page,runtime,selectAndRead,receive,takeoverOnly,resumeCursor,futureEntriesOnly}={}) {
  if(!page || typeof page.evaluate!=="function" || typeof runtime!=="string" || !path.isAbsolute(runtime) ||
    typeof selectAndRead!=="function" || typeof receive!=="function" ||
    takeoverOnly!==undefined && typeof takeoverOnly!=="function" ||
    futureEntriesOnly!==undefined && typeof futureEntriesOnly!=="boolean") throw fail("controller_callbacks_and_runtime_required");
  const resolved=path.resolve(runtime);
  if(!fs.lstatSync(resolved).isDirectory()) throw fail("existing_runtime_required");
  let state=controllers.get(page);
  // Same-process reloads/leases retain the selected policy. A process restart
  // creates a fresh native-sidebar baseline; it does not recover a lost cursor.
  const futureOnly=futureEntriesOnly ?? state?.futureEntriesOnly ?? false;
  if(state?.running) {
    if(state.runtime!==resolved) throw fail("controller_runtime_mismatch");
    if(Boolean(state.futureEntriesOnly)!==futureOnly) throw fail("controller_reception_mode_mismatch");
    if(resumeCursor!==undefined) throw fail("controller_already_running_with_cursor");
    return status(page);
  }
  if(worker.status(page).running) throw fail("another_worker_already_owns_page");
  if(state) clearHealthTimer(state);
  state={page,runtime:resolved,receive,takeoverOnly,running:true,processed:0,holds:new Set(),lastResult:null,healthSignature:null,
    healthTimer:null,healthWriteError:null,
    futureEntriesOnly:futureOnly,cursorRestoration:resumeCursor!==undefined ? "same_process_cursor_resumed" : "not_restored_new_epoch_baseline"};
  controllers.set(page,state);
  const guarded=callback=>async(...args)=>{
    try {return await callback(...args);} catch(error) {
      if(state.running) publish(state,{state:"callback_error",code:code(error),
        ...(args[2]?.candidateUID ? {uid:args[2].candidateUID} : {})});
      throw fail(code(error));
    }
  };
  try {
    state.healthTimer=setInterval(()=>{
      if(controllers.get(page)!==state || !state.running) {clearHealthTimer(state);return;}
      try {publish(state,null,true);} catch(_) { /* Visible through status(); never crash the receiver for a health write. */ }
    },HEALTH_INTERVAL_MS);
    state.healthTimer.unref?.();
    const initial=await worker.start(page,{readSidebar:guarded(readSidebar),selectAndRead:guarded(selectAndRead),
      ...(!state.futureEntriesOnly ? {readDueCandidates:guarded((_page,rows,ctx)=>readDueCandidates(state,rows,ctx))} : {}),
      ...(resumeCursor!==undefined ? {resumeCursor} : {}),
      processScope:guarded((scope,ctx)=>processScope(state,scope,ctx))});
    publish(state,initial.error ? {state:"worker_error",code:initial.error.code} : {state:"started"});
    return status(page);
  } catch(error) {state.running=false;clearHealthTimer(state);worker.stop(page);throw error;}
}
function stop(value) {
  const page=pageArg(value),state=controllers.get(page);
  if(state) {state.running=false;clearHealthTimer(state);worker.stop(page);publish(state,{state:"stopped"});}
  return status(page);
}

module.exports={start,stop,status};
