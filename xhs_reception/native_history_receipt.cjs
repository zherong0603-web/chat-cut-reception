"use strict";
// Passive native UI history reads only. No requests, route hooks or page actions.
const {createHash}=require("node:crypto");
const VERSION=7;
const key=Symbol.for("xhs_reception.native_history_observers");
const all=globalThis[key] || (globalThis[key]=new WeakMap());
const identityKey=Symbol.for("xhs_reception.native_card_identities");
const identities=globalThis[identityKey] || (globalThis[identityKey]=new WeakMap());
const uidPattern=/^[a-f0-9]{24}$/;
const messagePattern=/^[A-Za-z0-9_-]{1,256}$/;
const cardName="运去哪海外仓（企微）";
const identityFields=["id","type","contentType","msgContentType","title","name","inviteInfo","corpName","cardType"];
const endpoint="https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg";
const unknown=reason=>({status:"unknown",reason,reference:null,native_message_id:null,observed_at_utc:null});
const utcMs=value=>Number.isSafeInteger(value) && value>=1000000000000 && value<10000000000000;
const submittedMs=value=>typeof value === "number" && Number.isFinite(value) && value>=1000000000000 && value<10000000000000;
const object=value=>value && typeof value === "object" && !Array.isArray(value);
function schema(value) {
  const result=[];
  function walk(v,p,d) {
    if(result.length>=100 || d>5) return;
    result.push({path:p,type:Array.isArray(v)?"array":v===null?"null":typeof v});
    if(Array.isArray(v)) {if(v.length) walk(v[0],p+"[]",d+1);}
    else if(object(v)) for(const k of Object.keys(v).slice(0,30)) if(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) walk(v[k],p+"."+k,d+1);
  }
  walk(value,"$",0);return result;
}
function successful(record,conversationId) {
  const customers=record.query?.filter(q=>q.key === "customer_user_id");
  return customers?.length === 1 && customers[0].value === conversationId && record.http_status === 200 &&
    record.data?.success === true && record.data?.code === 0 && Array.isArray(record.data?.data?.messages);
}
function canonicalJSON(value) {
  if(Array.isArray(value)) return "["+value.map(canonicalJSON).join(",")+"]";
  if(object(value)) return "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonicalJSON(value[key])).join(",")+"}";
  return JSON.stringify(value);
}
const hashJSON=value=>createHash("sha256").update(canonicalJSON(value),"utf8").digest("hex");
function displayFanCount(value) {
  // The only observed non-routing variation: an unsigned 32-bit decimal display
  // count. Keep malformed/missing values in the exact payload comparison.
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,9})$/.test(value) && Number(value)<=4294967295;
}
function parseCard(content) {
  if(typeof content !== "string") return null;
  let card;try {card=JSON.parse(content);} catch {return null;}
  if(!object(card) || card.name !== cardName) return null;
  const identity={};
  for(const field of identityFields) {
    if(!Object.hasOwn(card,field)) return null;
    const value=card[field];
    if(value !== null && typeof value !== "string" && typeof value !== "boolean" &&
       !(typeof value === "number" && Number.isFinite(value))) return null;
    if(typeof value === "string" && /(?:https?:\/\/|data:|(?:xhs|weixin|wxwork):\/\/)/i.test(value)) return null;
    identity[field]=value;
  }
  // Preserve the full payload for audit. Comparison excludes only the one
  // observed display count, and only with the exact bounded string shape.
  const excluded=Object.hasOwn(card,"userFansCount") && displayFanCount(card.userFansCount) ? ["userFansCount"] : [];
  const payload={...card};if(excluded.length) delete payload.userFansCount;
  identity.full_payload_hash=hashJSON(card);
  // The wrapper binds presence/type qualification, preventing present/missing
  // collisions while every other key remains part of the canonical payload.
  identity.routing_hash=hashJSON({comparison_version:VERSION,excluded_display_fields:excluded,payload});
  identity.excluded_display_fields=Object.freeze(excluded);
  return identity;
}
function sameIdentity(a,b) {
  return typeof a.routing_hash === "string" && /^[a-f0-9]{64}$/.test(a.routing_hash) && a.routing_hash === b.routing_hash &&
    typeof a.full_payload_hash === "string" && /^[a-f0-9]{64}$/.test(a.full_payload_hash) &&
    typeof b.full_payload_hash === "string" && /^[a-f0-9]{64}$/.test(b.full_payload_hash) &&
    canonicalJSON(a.excluded_display_fields) === canonicalJSON(b.excluded_display_fields) &&
    identityFields.every(field=>Object.hasOwn(a,field) && Object.hasOwn(b,field) && a[field] === b[field]);
}
function exactText(content,expected) {
  if(typeof content !== "string") return false;
  if(content === expected) return true;
  try {const parsed=JSON.parse(content);return typeof parsed === "string" && parsed === expected;} catch {return false;}
}
function compositeIds(accountId,conversationId,messageId) {
  return new Set([accountId+"."+conversationId+"."+messageId,conversationId+"."+accountId+"."+messageId]);
}
function exactRecord(record,accountId,conversationId,id,timestamp,type) {
  const message=record?.sixin_message;
  const parts=typeof id === "string" ? id.split(".") : [];
  return parts.length === 3 && messagePattern.test(parts[2]) && compositeIds(accountId,conversationId,parts[2]).has(id) &&
    object(message) && message.id === id && message.sender_id === accountId && message.receiver_id === conversationId &&
    record.message_extension?.customer_user_id === conversationId && message.message_type === type &&
    utcMs(message.created_at) && message.created_at === timestamp;
}
function reference(id) {return endpoint+"#"+id;}
const diagnosticType=value=>value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const safeKey=key=>/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(key) && !uidPattern.test(key) ? key : "<key>";
function diagnosticDifferences(source,target) {
  const missing=Symbol("missing"),differences=[];let truncated=false;
  const type=value=>value === missing ? "missing" : diagnosticType(value);
  function diff(left,right,path,depth) {
    if(Object.is(left,right)) return;
    if(differences.length>=100) {truncated=true;return;}
    const leftType=type(left),rightType=type(right);
    if(leftType !== rightType || !["object","array"].includes(leftType) || depth>=12) {
      differences.push({path,source_type:leftType,target_type:rightType});
      if(depth>=12) truncated=true;
      return;
    }
    const keys=leftType === "array" ? Array.from({length:Math.max(left.length,right.length)},(_,index)=>index) :
      Array.from(new Set([...Object.keys(left),...Object.keys(right)])).sort();
    for(const key of keys) {
      const child=leftType === "array" ? path+"["+key+"]" : path+"."+safeKey(key);
      diff(Object.hasOwn(left,key)?left[key]:missing,Object.hasOwn(right,key)?right[key]:missing,child,depth+1);
      if(differences.length>=100) {truncated=true;break;}
    }
  }
  diff(source,target,"$",0);return {differences,truncated};
}
function parsedLink(value) {
  if(typeof value !== "string") return {format:"not_string"};
  let input=value,encoding="";
  if(/^(?:[A-Za-z][A-Za-z0-9+.-]*%3a|%7b|%5b|%22)/i.test(input)) {
    try {input=decodeURIComponent(input);encoding="encoded_";} catch {return {format:"unrecognized_encoding"};}
  }
  const absolute=string=>/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(string);
  if(absolute(input)) {try {return {format:encoding+"absolute_url",url:new URL(input)};} catch {}}
  try {
    const json=JSON.parse(input);
    if(typeof json === "string" && absolute(json)) return {format:encoding+"json_string_url",url:new URL(json)};
    return {format:encoding+"json",json};
  } catch {return {format:encoding+"unrecognized"};}
}
function identityFlags(value,known) {
  return {equals_source_uid:value === known.sourceConversationId,equals_target_uid:value === known.targetConversationId,
    equals_account:value === known.accountId,equals_card_identity_id:known.cardIdentityId != null && value === known.cardIdentityId};
}
function channelEnum(value,key,known) {
  if(key !== "customer_channel" || typeof value !== "string" || value.length>32 || !/^[A-Za-z_ -]+$/.test(value)) return {};
  if(uidPattern.test(value.toLowerCase()) || [known.sourceConversationId,known.targetConversationId,known.accountId,known.cardIdentityId].includes(value)) return {};
  const normalized=value.trim().replace(/[_ -]+/g,"_").replace(/^_+|_+$/g,"").toLowerCase();
  return normalized ? {normalized_enum:normalized} : {};
}
function queryJSON(value,known) {
  if(typeof value !== "string" || Buffer.byteLength(value,"utf8")>16384) return null;
  let parsed;try {parsed=JSON.parse(value);} catch {return null;}
  const shape=[],leaves=[];let truncated=false;
  function walk(value,path,depth,leafKey) {
    if(shape.length>=100) {truncated=true;return;}
    const type=diagnosticType(value);shape.push({path,type});
    if(!["object","array"].includes(type)) {
      leaves.push({path,type,...identityFlags(value,known),...channelEnum(value,leafKey,known)});return;
    }
    if(depth>=8) {truncated=true;return;}
    const keys=Object.keys(value);
    if(keys.length>30) truncated=true;
    for(const key of keys.slice(0,30)) walk(value[key],type === "array" ? path+"["+key+"]" : path+"."+safeKey(key),depth+1,key);
  }
  walk(parsed,"$",0,null);
  return {parsed,diagnostic:{shape,leaves,truncated}};
}
function routeDifference(source,target,known,depth=0) {
  const left=parsedLink(source),right=parsedLink(target);
  const out={source_type:diagnosticType(source),target_type:diagnosticType(target),source_format:left.format,target_format:right.format};
  if(left.url && right.url) {
    const sourceKeys=Array.from(new Set(left.url.searchParams.keys())),targetKeys=Array.from(new Set(right.url.searchParams.keys()));
    const added=targetKeys.filter(key=>!sourceKeys.includes(key)),removed=sourceKeys.filter(key=>!targetKeys.includes(key));
    const changed=sourceKeys.filter(key=>targetKeys.includes(key) &&
      JSON.stringify(left.url.searchParams.getAll(key)) !== JSON.stringify(right.url.searchParams.getAll(key)));
    const changedKeys=Array.from(new Set([...changed,...added,...removed])).sort();
    Object.assign(out,{scheme_equal:left.url.protocol === right.url.protocol,host_equal:left.url.host === right.url.host,
      pathname_equal:left.url.pathname === right.url.pathname,fragment_equal:left.url.hash === right.url.hash,
      changed_query_keys:changed.map(safeKey).sort(),added_query_keys:added.map(safeKey).sort(),removed_query_keys:removed.map(safeKey).sort(),
      changed_query_values:changedKeys.slice(0,100).map(key=>{
        const a=left.url.searchParams.getAll(key),b=right.url.searchParams.getAll(key);
        const flags=(value,index)=>({index,...identityFlags(value,known),...channelEnum(value,key,known)});
        const detail={key:safeKey(key),source:a.slice(0,16).map(flags),target:b.slice(0,16).map(flags)};
        const sourceJSON=a.slice(0,16).map(value=>queryJSON(value,known)),targetJSON=b.slice(0,16).map(value=>queryJSON(value,known));
        if(sourceJSON.some(Boolean) || targetJSON.some(Boolean)) {
          detail.source_json=sourceJSON.flatMap((value,index)=>value ? [{index,...value.diagnostic}] : []);
          detail.target_json=targetJSON.flatMap((value,index)=>value ? [{index,...value.diagnostic}] : []);
          detail.json_differences=sourceJSON.flatMap((value,index)=>value && targetJSON[index] ?
            [{index,...diagnosticDifferences(value.parsed,targetJSON[index].parsed)}] : []);
        }
        if(depth<1 && a.length === 1 && b.length === 1 && parsedLink(a[0]).url && parsedLink(b[0]).url)
          detail.nested_route=routeDifference(a[0],b[0],known,depth+1);
        if(a.length>16 || b.length>16) detail.truncated=true;
        return detail;
      }),truncated:changedKeys.length>100});
  } else if(Object.hasOwn(left,"json") && Object.hasOwn(right,"json")) {
    const outer=value=>object(value) ? Object.keys(value).slice(0,30).map(key=>({key:safeKey(key),type:diagnosticType(value[key])})) : [];
    const diff=diagnosticDifferences(left.json,right.json);
    Object.assign(out,{outer_source_keys:outer(left.json),outer_target_keys:outer(right.json),changed_paths:diff.differences,truncated:diff.truncated});
  }
  return out;
}

function attach(page) {
  const previous=all.get(page);
  if(previous?.api?.version === VERSION && previous.api.verify && previous.api.cardIdentity) return previous.api;
  const earlier=previous?.records?.slice(-4) || [];
  previous?.api?.detach(); // Upgrade a prior passive listener without duplicate hooks.
  const state={records:earlier,requests:new WeakMap(),attached:true,generation:0};
  const append=record=>{state.records.push(record);if(state.records.length>4) state.records.shift();};
  const onRequest=request=>{
    if(!state.attached) return;
    try {
      const u=new URL(request.url());
      if(u.origin !== "https://sxt.xiaohongshu.com" || u.pathname !== "/api-sxt/edith/chatline/msg" || request.method() !== "GET") return;
      state.requests.set(request,{at:Date.now(),query:Array.from(u.searchParams).map(([key,value])=>({key,value})),generation:state.generation});
    } catch {}
  };
  const onFinished=request=>{void(async()=>{
    const info=state.requests.get(request);
    if(!state.attached || !info || info.generation !== state.generation) return;
    state.requests.delete(request);
    const generation=state.generation;
    const current=()=>state.attached && state.generation === generation;
    let timer;
    try {
      // Bound the whole read, including request.response(), rather than only body().
      const result=await Promise.race([(async()=>{
        const response=await request.response();if(!response) return {error:"history_response_unavailable"};
        const buffer=await response.body();
        if(buffer.byteLength>512*1024) return {error:"history_body_too_large"};
        const data=JSON.parse(buffer.toString("utf8"));
        return {http_status:response.status(),schema:schema(data),data};
      })(),new Promise(resolve=>{timer=setTimeout(()=>resolve({error:"history_response_read_timeout"}),2000);})]);
      if(current()) append({at:info.at,query:info.query,finished_at:Date.now(),...result});
    } catch {if(current()) append({at:info.at,query:info.query,finished_at:Date.now(),error:"history_body_unrecognized"});}
    finally {clearTimeout(timer);}
  })();};
  page.on("request",onRequest);page.on("requestfinished",onFinished);

  function verify({accountId,conversationId,messageId,nativeMessageId,operation,expectedText,cardIdentity,submittedAtMs,uiTimestampMs}={}) {
    if(!state.attached) return unknown("observer_detached");
    if(typeof accountId !== "string" || !uidPattern.test(accountId) || typeof conversationId !== "string" || !uidPattern.test(conversationId) ||
       typeof messageId !== "string" || !messagePattern.test(messageId) || !["text","native_card"].includes(operation) ||
       !submittedMs(submittedAtMs) || !utcMs(uiTimestampMs) || uiTimestampMs<submittedAtMs-1000 ||
       uiTimestampMs>Date.now()+1000 || submittedAtMs>Date.now()+1000) return unknown("invalid_verification_scope_or_time");
    let expectedIdentity;
    if(operation === "text") {if(typeof expectedText !== "string") return unknown("expected_text_required");}
    else {
      const proof=object(cardIdentity) ? identities.get(cardIdentity) : null;
      if(!proof || proof.verifierVersion !== VERSION || proof.accountId !== accountId ||
         !/^[a-f0-9]{64}$/.test(proof.identity.routing_hash || "")) return unknown("confirmed_native_card_identity_required");
      expectedIdentity=proof.identity;
    }
    const ids=compositeIds(accountId,conversationId,messageId),type=operation === "text" ? "TEXT" : "CARD";
    if(nativeMessageId !== undefined && !ids.has(nativeMessageId)) return unknown("native_message_id_scope_mismatch");
    const matches=[];
    for(const record of state.records) {
      if(!successful(record,conversationId) || !utcMs(record.at) || record.at<submittedAtMs ||
         !utcMs(record.finished_at) || record.finished_at<record.at || record.finished_at>Date.now()+1000) continue;
      const rows=record.data.data.messages.filter(row=>ids.has(row?.sixin_message?.id));
      if(rows.length>1) return unknown("ambiguous_native_message");
      if(!rows.length) continue;
      const row=rows[0],message=row.sixin_message,id=message.id;
      if(nativeMessageId !== undefined && id !== nativeMessageId) return unknown("native_message_id_mismatch");
      if(!exactRecord(row,accountId,conversationId,id,uiTimestampMs,type)) return unknown("native_message_scope_type_or_time_mismatch");
      const identity=operation === "native_card" ? parseCard(message.content) : null;
      const contentMatches=operation === "text" ? exactText(message.content,expectedText) :
        identity && sameIdentity(identity,expectedIdentity);
      if(!contentMatches) return unknown("native_message_content_mismatch");
      matches.push({record,id,identity});
    }
    if(!matches.length) return unknown("no_fresh_exact_native_history_record");
    if(new Set(matches.map(match=>match.id)).size !== 1) return unknown("ambiguous_native_message");
    // The same native ID in successive refresh responses is one record, not ambiguity.
    const match=matches.reduce((a,b)=>a.record.finished_at>=b.record.finished_at?a:b),latest=match.record,id=match.id;
    return {status:"server_history_confirmed",verifier_version:VERSION,reference:reference(id),native_message_id:id,
      observed_at_utc:new Date(latest.finished_at).toISOString(),request_started_at_ms:latest.at,
      native_created_at_ms:uiTimestampMs,operation,delivery_verified:false,read_verified:false,wecom_added_verified:false,
      ...(operation === "native_card" ? {full_payload_hash:match.identity.full_payload_hash,
        expected_full_payload_hash:expectedIdentity.full_payload_hash,
        excluded_display_fields:match.identity.excluded_display_fields.slice()} : {})};
  }
  function cardIdentity(scope) {
    if(!state.attached) return unknown("observer_detached");
    if(!scope || scope.scope_ready !== true || scope.account_scope_verified !== true || scope.conversation_scope_verified !== true ||
       scope.source !== "platform_ui" || scope.classification !== "readonly_ui_scope" ||
       typeof scope.account_id !== "string" || !uidPattern.test(scope.account_id) ||
       typeof scope.conversation_id !== "string" || !uidPattern.test(scope.conversation_id) || !Array.isArray(scope.messages)) return unknown("verified_card_ui_scope_required");
    const matches=[];
    for(const ui of scope.messages) {
      if(ui?.native_business_card_candidate !== true || ui.direction !== "right" || ui.raw_type !== "CARD" ||
         ui.account_id !== scope.account_id || ui.conversation_id !== scope.conversation_id ||
         typeof ui.message_id !== "string" || !messagePattern.test(ui.message_id)) continue;
      const ids=compositeIds(scope.account_id,scope.conversation_id,ui.message_id);
      const id=typeof ui.dom_id === "string" && ui.dom_id.startsWith("id_") ? ui.dom_id.slice(3) : null;
      if(!ids.has(id) || ui.native_dom_id !== "jarvis-msg-"+id ||
         typeof ui.raw_timestamp !== "string" || !/^\d{13}$/.test(ui.raw_timestamp) ||
         String(Number(ui.raw_timestamp)) !== ui.raw_timestamp || !utcMs(Number(ui.raw_timestamp))) continue;
      const nameMatches=ui.native_card_name === cardName || (typeof ui.raw_text === "string" &&
        ui.raw_text.split(/\r?\n/).some(line=>line.trim() === cardName));
      if(!nameMatches || typeof ui.raw_text !== "string" || !ui.raw_text.includes("企业微信")) continue;
      for(const record of state.records) {
        if(!successful(record,scope.conversation_id)) continue;
        const rows=record.data.data.messages.filter(row=>ids.has(row?.sixin_message?.id));
        if(rows.length>1) return unknown("ambiguous_native_card_record");
        if(!rows.length) continue;
        if(rows[0].sixin_message.id !== id) return unknown("native_card_id_mismatch");
        if(!exactRecord(rows[0],scope.account_id,scope.conversation_id,id,Number(ui.raw_timestamp),"CARD")) return unknown("native_card_scope_type_or_time_mismatch");
        const identity=parseCard(rows[0].sixin_message.content);
        if(!identity) return unknown("native_card_identity_unrecognized");
        matches.push({identity,id,record});
      }
    }
    if(!matches.length) return unknown("no_confirmed_native_card_identity");
    if(matches.some(match=>!sameIdentity(match.identity,matches[0].identity))) return unknown("ambiguous_native_card_identity");
    const identity=Object.freeze({...matches[0].identity});
    identities.set(identity,{accountId:scope.account_id,identity,verifierVersion:VERSION});
    const record=matches[0].record;
    return {status:"native_card_identity_confirmed",verifier_version:VERSION,cardIdentity:identity,reference:reference(matches[0].id),
      native_message_id:matches[0].id,observed_at_utc:new Date(record.finished_at || Date.now()).toISOString(),
      excluded_display_fields:identity.excluded_display_fields.slice()};
  }
  function observedCard(accountId,conversationId,messageId) {
      const ids=compositeIds(accountId,conversationId,messageId),matches=new Map();
      for(const record of state.records) {
        if(!successful(record,conversationId)) continue;
        const rows=record.data.data.messages.filter(row=>ids.has(row?.sixin_message?.id));
        if(rows.length>1) return {error:"ambiguous_card_record"};
        if(!rows.length) continue;
        const row=rows[0],message=row.sixin_message;
        if(!exactRecord(row,accountId,conversationId,message.id,message.created_at,"CARD")) return {error:"card_record_scope_mismatch"};
        try {
          const card=JSON.parse(message.content);
          if(!object(card) || card.name !== cardName) return {error:"native_card_json_unrecognized"};
          const hash=createHash("sha256").update(canonicalJSON(card),"utf8").digest("hex");
          matches.set(message.id+":"+hash,card);
        } catch {return {error:"native_card_json_unrecognized"};}
      }
      if(matches.size !== 1) return {error:matches.size ? "ambiguous_card_payload" : "card_not_observed"};
      return {card:matches.values().next().value};
  }
  function cardPair({sourceConversationId,sourceMessageId,targetConversationId,targetMessageId,accountId}={}) {
    if(!state.attached) return {error:"observer_detached"};
    if(![accountId,sourceConversationId,targetConversationId].every(value=>typeof value === "string" && uidPattern.test(value)) ||
       ![sourceMessageId,targetMessageId].every(value=>typeof value === "string" && messagePattern.test(value))) return {error:"invalid_card_difference_scope"};
    const source=observedCard(accountId,sourceConversationId,sourceMessageId),target=observedCard(accountId,targetConversationId,targetMessageId);
    return {source,target};
  }
  function cardDifferences(params={}) {
    const unavailable=reason=>({status:"unknown",reason,differences:[],send_confirmation:false});
    const pair=cardPair(params);if(pair.error) return unavailable(pair.error);
    const {source,target}=pair;
    if(source.error || target.error) return unavailable((source.error ? "source_"+source.error : "target_"+target.error));
    return {status:"compared",classification:"readonly_native_card_keypath_differences",...diagnosticDifferences(source.card,target.card),send_confirmation:false};
  }
  function cardRouteDifferences(params={}) {
    const unavailable=reason=>({status:"unknown",reason,routes:[],send_confirmation:false});
    const pair=cardPair(params);if(pair.error) return unavailable(pair.error);
    const {source,target}=pair;
    if(source.error || target.error) return unavailable(source.error ? "source_"+source.error : "target_"+target.error);
    const paths=[["link"],["contactList",0,"link"],["contactList",0,"linkV2"]];
    const at=(value,parts)=>parts.reduce((current,key)=>current?.[key],value);
    const path=parts=>"$"+parts.map(key=>typeof key === "number" ? "["+key+"]" : "."+key).join("");
    return {status:"compared",classification:"readonly_native_card_route_differences",routes:paths.flatMap(parts=>{
      const a=at(source.card,parts),b=at(target.card,parts);
      return Object.is(a,b) ? [] : [{path:path(parts),...routeDifference(a,b,{...params,cardIdentityId:source.card.id})}];
    }),send_confirmation:false};
  }
  const api={
    version:VERSION,
    snapshot:()=>state.records.map(({query,data,...r})=>({...r,query:query.map(({key,value})=>({key,is_uid:uidPattern.test(value)}))})),
    bindings:scope=>state.records.filter(r=>r.query?.some(q=>q.key === "customer_user_id" && q.value === scope.conversation_id))
      .map(r=>({request_started_at:r.at,success:r.data?.success === true,code_zero:r.data?.code === 0,
        messages:(Array.isArray(r.data?.data?.messages)?r.data.data.messages:[]).slice(0,100).flatMap(record=>{
          const m=record?.sixin_message;if(!m) return [];
          const ui=scope.messages.find(x=>m.id === x.message_id || m.id === x.native_dom_id || m.id === x.dom_id ||
            compositeIds(scope.account_id,scope.conversation_id,x.message_id).has(m.id));
          if(!ui) return [];
          let content;try {content=JSON.parse(m.content);} catch {content=m.content;}
          return [{native_ui_message_id:ui.message_id,id_form:m.id === ui.message_id?"message_id":m.id === ui.native_dom_id?"native_dom_id":m.id === ui.dom_id?"dom_id":"composite",
            sender_matches_account:m.sender_id === scope.account_id,receiver_matches_customer:m.receiver_id === scope.conversation_id,
            customer_extension_matches:record.message_extension?.customer_user_id === scope.conversation_id,
            platform_type:m.message_type,created_at:m.created_at,ui_timestamp:Number(ui.raw_timestamp),
            content_schema:schema(content),content_string_equals_ui:typeof content === "string" && content.trim() === ui.raw_text.trim(),
            content_text_equals_ui:object(content) && typeof content.text === "string" && content.text.trim() === ui.raw_text.trim()}];
        })})),
    verify,cardIdentity,cardDifferences,cardRouteDifferences,
    // Raw records and card identities are for the trusted in-process sender only.
    records:()=>state.records.slice(),
    detach:()=>{
      state.attached=false;state.generation++;
      page.off("request",onRequest);page.off("requestfinished",onFinished);
      if(all.get(page) === state) all.delete(page);
    },
  };
  state.api=api;all.set(page,state);return api;
}
module.exports={attach};
