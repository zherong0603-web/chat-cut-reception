"use strict";

// Local observation adapter only: no browser operations, intents or send receipts.
const fs=require("node:fs");
const path=require("node:path");
const {spawnSync}=require("node:child_process");
const {EngineClient}=require("./engine_client.cjs");
const singletonKey=Symbol.for("xhs_reception.ui_engine_client");
const uidPattern=/^[a-f0-9]{24}$/;
const isoPattern=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function failure(code) {const error=new Error(code);error.code=code;return error;}
function utcMilliseconds(value) {
  if(typeof value !== "string" || !isoPattern.test(value)) return null;
  const timestamp=Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
}

function getClient(runtime,{pythonExecutable="/usr/bin/python3"}={}) {
  if(typeof runtime !== "string" || !path.isAbsolute(runtime) ||
     typeof pythonExecutable !== "string" || !path.isAbsolute(pythonExecutable)) throw failure("invalid_engine_runtime");
  const requestedRuntime=path.resolve(runtime);
  const existing=globalThis[singletonKey];
  if(existing) {
    if(existing.runtime !== requestedRuntime || existing.pythonExecutable !== pythonExecutable) throw failure("engine_singleton_binding_mismatch");
    const health=existing.client.diagnostics();
    if(health.closed || health.transport_failed) throw failure("engine_client_unavailable");
    return existing.client;
  }
  const identityPath=path.join(requestedRuntime,"account_identity.json");
  const dbPath=path.join(requestedRuntime,"reception.sqlite3");
  let binding;
  try {
    if(!fs.statSync(requestedRuntime).isDirectory() || !fs.lstatSync(identityPath).isFile() ||
       fs.statSync(identityPath).size > 65536 || !fs.lstatSync(dbPath).isFile()) throw new Error();
    fs.accessSync(pythonExecutable,fs.constants.X_OK);
    binding=JSON.parse(fs.readFileSync(identityPath,"utf8"));
  } catch(_) {throw failure("existing_engine_resources_required");}
  if(!binding || typeof binding !== "object" || !uidPattern.test(binding.account_id || "") ||
     typeof binding.account_display_name !== "string" || !binding.account_display_name.trim() ||
     binding.source !== "platform_ui" || typeof binding.reference !== "string" ||
     !binding.reference.includes(".userInfo-popover") || !binding.reference.includes("主账号ID") ||
     utcMilliseconds(binding.observed_at_utc) === null ||
     binding.url !== "https://sxt.xiaohongshu.com/im/multiCustomerService" ||
     binding.title !== binding.account_display_name+"-私信通") throw failure("native_account_binding_required");
  // Read-only preflight prevents Engine's normal CREATE IF NOT EXISTS from
  // initializing an empty file or an unrelated SQLite database.
  const checked=spawnSync(pythonExecutable,["-c",[
    "import pathlib, sqlite3, sys",
    "con=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro', uri=True)",
    "con.execute('PRAGMA query_only=ON')",
    "required={",
    "'conversations': 'account_id conversation_id state resume_state stop_reason last_limit_at latest_event_id latest_event_at needs_response last_sent_at next_followup_at created_at updated_at',",
    "'events': 'account_id conversation_id event_id type timestamp detected_at timestamp_source evidence',",
    "'outbox': 'intent_id account_id conversation_id kind source_event_id payload status created_at expires_at owner claimed_at lease_until browser_session_id submitted_at confirmed_at evidence error',",
    "'audit_log': 'id at account_id conversation_id action detail'}",
    "valid=all(set(columns.split()) <= {row[1] for row in con.execute('PRAGMA table_info('+table+')')} for table,columns in required.items())",
    "valid=valid and con.execute(\"SELECT 1 FROM sqlite_master WHERE type='index' AND name='one_unsettled_per_conversation'\").fetchone() is not None",
    "con.close()",
    "sys.exit(0 if valid else 2)",
  ].join("\n"),dbPath],{stdio:["ignore","pipe","pipe"],encoding:"utf8",timeout:2000,maxBuffer:4096,windowsHide:true});
  if(checked.error || checked.status !== 0) throw failure("existing_engine_schema_required");
  const client=new EngineClient({pythonExecutable,dbPath,accountId:binding.account_id});
  globalThis[singletonKey]={runtime:requestedRuntime,pythonExecutable,client,
    accountId:binding.account_id,accountDisplayName:binding.account_display_name};
  return client;
}

function observedEvents(client,scope,historicalBaseline) {
  const binding=globalThis[singletonKey];
  if(!binding || binding.client !== client || typeof client?.request !== "function") throw failure("bound_engine_client_required");
  if(typeof historicalBaseline !== "boolean") throw failure("invalid_historical_baseline");
  if(!scope || scope.scope_ready !== true || scope.state !== "ready" || scope.source !== "platform_ui" ||
     scope.classification !== "readonly_ui_scope" || scope.account_scope_verified !== true ||
     scope.conversation_scope_verified !== true || scope.account_id !== binding.accountId ||
     scope.account_display_name !== binding.accountDisplayName || !uidPattern.test(scope.conversation_id || "") ||
     scope.url !== "https://sxt.xiaohongshu.com/im/multiCustomerService" ||
     scope.title !== binding.accountDisplayName+"-私信通" ||
     !["current_native_profile","recent_native_profile_proof"].includes(scope.profile_binding_source)) throw failure("verified_ui_scope_required");
  const ui=scope.conversation_ui;
  const keyMatch=ui?.active_data_key?.match(/^(?:Total|Active)-([a-f0-9]{24})$/);
  if(!keyMatch || keyMatch[1] !== scope.conversation_id || ui.profile_uid !== scope.conversation_id ||
     typeof ui.row_nickname !== "string" || !ui.row_nickname.trim() || ui.header_nickname !== ui.row_nickname ||
     !Array.isArray(scope.messages) || !scope.messages.length) throw failure("current_conversation_binding_required");
  const observedMs=utcMilliseconds(scope.observed_at_utc);
  if(observedMs === null || observedMs > Date.now()+1000) throw failure("invalid_scope_utc_timestamp");
  const pairPrefixes=new Set([scope.account_id+"."+scope.conversation_id+".",
    scope.conversation_id+"."+scope.account_id+"."]);
  const seen=new Set(),events=[];
  let currentInbound=null;
  let skipped=0;
  for(const message of scope.messages) {
    if(!message || message.account_id !== scope.account_id || message.conversation_id !== scope.conversation_id ||
       typeof message.message_id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(message.message_id) ||
       !pairPrefixes.has(message.message_pair_prefix) ||
       message.native_scope_id !== message.message_pair_prefix+message.message_id ||
       message.dom_id !== "id_"+message.native_scope_id ||
       message.native_dom_id !== "jarvis-msg-"+message.native_scope_id ||
       seen.has(message.dom_id)) throw failure("native_message_scope_mismatch");
    seen.add(message.dom_id);
    if(typeof message.raw_timestamp !== "string" || !/^\d{13}$/.test(message.raw_timestamp) ||
       !Number.isSafeInteger(Number(message.raw_timestamp)) || String(Number(message.raw_timestamp)) !== message.raw_timestamp ||
       Number(message.raw_timestamp) > observedMs+1000 || typeof message.raw_type !== "string" ||
       typeof message.raw_text !== "string") throw failure("invalid_native_message_timestamp_or_text");
    let type;
    if(message.direction === "left" && message.raw_type === "TEXT") type="CUSTOMER_MESSAGE";
    else if(message.direction === "center" && message.raw_type === "RICH_HINT" &&
            message.raw_text.includes("对方通过") && message.raw_text.includes("进入私信")) type="NEW_VISITOR";
    else if(message.direction === "right") type="OUTBOUND_OBSERVED";
    else {skipped++;continue;}
    const systemHeaderReference='xpath=//*[@id="'+message.dom_id+'"]//*[@id="'+message.native_dom_id+
      '"]/parent::div/preceding-sibling::div[1]/div[1]';
    if(type==="OUTBOUND_OBSERVED" && message.native_system_attribution_observed===true &&
       message.native_system_attribution_header_reference!==systemHeaderReference) throw failure("native_system_header_reference_required");
    const timestamp=Number(message.raw_timestamp)/1000;
    if(type==="CUSTOMER_MESSAGE"||type==="NEW_VISITOR") currentInbound={eventId:message.dom_id,timestamp};
    const respondsToCurrentTurn=type==="OUTBOUND_OBSERVED"&&currentInbound&&timestamp>=currentInbound.timestamp&&
      message.native_ai_attribution_observed!==true&&message.native_system_attribution_observed!==true;
    events.push({account_id:scope.account_id,conversation_id:scope.conversation_id,
      event_id:type === "OUTBOUND_OBSERVED" ? "observed-outbound:"+message.dom_id : message.dom_id,
      type,timestamp,detected_at:observedMs/1000,
      evidence:{source:"platform_ui",timestamp_source:"platform_ui",observed_at:observedMs/1000,
        account_id:scope.account_id,conversation_id:scope.conversation_id,
        reference:message.dom_id,native_message_id:message.native_dom_id,
        historical_baseline:historicalBaseline,content_is_untrusted:true,
        untrusted_customer_display_name:Array.from(ui.row_nickname).slice(0,128).join(''),
        untrusted_message_text:message.raw_text,native_message_type:message.raw_type,
        native_direction:message.direction,
        ...(type==="OUTBOUND_OBSERVED" ? {
          native_ai_attribution_observed:message.native_ai_attribution_observed===true,
          native_system_attribution_observed:message.native_system_attribution_observed===true,
          ...(respondsToCurrentTurn ? {responds_to_event_id:currentInbound.eventId} : {}),
          ...(message.native_system_attribution_observed===true ?
            {native_system_attribution_header_reference:systemHeaderReference} : {}),
        } : {})},
    });
  }
  // Stable for equal native timestamps: preserve their observed DOM order.
  events.sort((a,b)=>a.timestamp-b.timestamp);
  return {events,skipped};
}

async function ingestObservedScope(client,scope,{historicalBaseline=true}={}) {
  // Validate the entire snapshot before making any RPC mutation.
  const {events,skipped}=observedEvents(client,scope,historicalBaseline);
  const counts={observed:scope.messages.length,recognized:events.length,skipped,inserted:0,duplicates:0,
    customer_messages:0,new_visitors:0,outbound_observed:0};
  const safeError=response=>({code:response?.error?.code || "invalid_engine_response",
    ...(response?.error?.outcome ? {outcome:response.error.outcome} : {})});
  for(const event of events) {
    const response=await client.request("ingest",{event});
    if(!response?.ok) return {ok:false,error:safeError(response),counts,conversation:null};
    if(response.result.duplicate) counts.duplicates++;
    else {
      counts.inserted++;
      counts[{CUSTOMER_MESSAGE:"customer_messages",NEW_VISITOR:"new_visitors",OUTBOUND_OBSERVED:"outbound_observed"}[event.type]]++;
    }
  }
  const status=await client.request("status",{account_id:scope.account_id,conversation_id:scope.conversation_id});
  if(!status?.ok) return {ok:false,error:safeError(status),counts,conversation:null};
  if(status.result.account_scope !== scope.account_id || !Array.isArray(status.result.conversations) ||
     status.result.conversations.length > 1 || status.result.conversations.some(con=>
       con.account_id !== scope.account_id || con.conversation_id !== scope.conversation_id)) throw failure("engine_status_scope_mismatch");
  const conversation=status.result.conversations[0] || null;
  return {ok:true,historical_baseline:historicalBaseline,counts,conversation,
    latest_event_id:conversation?.latest_event_id || null,
    performs_browser_actions:false,creates_send_intents:false,confirms_sends:false};
}

module.exports={getClient,ingestObservedScope};
