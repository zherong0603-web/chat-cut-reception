"use strict";

// Diagnostic passive capture only. This module never sends, reads a response,
// authorizes an Engine confirmation, or assigns semantics to unknown fields.
const {createHash}=require("node:crypto");
const key=Symbol.for("xhs_reception.native_card_request_collectors");
const collectors=globalThis[key] || (globalThis[key]=new WeakMap());
const archiveKey=Symbol.for("xhs_reception.native_card_request_archives");
const archives=globalThis[archiveKey] || (globalThis[archiveKey]=new WeakMap());
const identityKey=Symbol.for("xhs_reception.native_card_identities");
const ENDPOINT="https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg";
const WINDOW_MS=2500,MAX_BODY_BYTES=64*1024;
const identityFields=["id","type","contentType","msgContentType","title","name","inviteInfo","corpName","cardType"];
const uidPattern=/^[a-f0-9]{24}$/;
const identifier=value=>typeof value === "string" && value.length>0 && value.length<=128 && !/[\s\x00-\x1f]/.test(value);
const type=value=>value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const hash=value=>createHash("sha256").update(value).digest("hex");
function canonicalJSON(value,depth=0) {
  if(depth>32) throw new Error("canonical_depth_exceeded");
  if(Array.isArray(value)) return "["+value.map(child=>canonicalJSON(child,depth+1)).join(",")+"]";
  if(value && typeof value === "object") return "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonicalJSON(value[key],depth+1)).join(",")+"}";
  return JSON.stringify(value);
}
function safeKeys(value) {
  return Object.keys(value).slice(0,30).map(key=>/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) && !uidPattern.test(key) ? key : "<key>");
}
function arm(page,{accountId,conversationId,staffNumber,independentCardIdentity,intentId}={}) {
  if(!page || typeof page.on !== "function" || typeof page.off !== "function" || typeof page.url !== "function" ||
     typeof page.mainFrame !== "function") throw new Error("existing_native_page_required");
  const pageURL=new URL(page.url());
  if(pageURL.origin !== "https://sxt.xiaohongshu.com" || pageURL.pathname !== "/im/multiCustomerService") throw new Error("native_inbox_required");
  if(typeof accountId !== "string" || !uidPattern.test(accountId) ||
     typeof conversationId !== "string" || !uidPattern.test(conversationId) ||
     !identifier(staffNumber) || !identifier(intentId)) throw new Error("invalid_request_proof_scope");
  const identityProof=independentCardIdentity && typeof independentCardIdentity === "object" ?
    globalThis[identityKey]?.get(independentCardIdentity) : null;
  if(!identityProof || identityProof.accountId !== accountId || identityProof.identity !== independentCardIdentity ||
     !/^[a-f0-9]{64}$/.test(independentCardIdentity.routing_hash || "") ||
     !identityFields.every(field=>Object.hasOwn(independentCardIdentity,field))) throw new Error("independent_native_card_identity_required");
  const previous=collectors.get(page);
  if(previous && !previous.detached) throw new Error("card_request_collector_already_armed");
  const state={detached:false,submittedAtMs:null,requests:[],candidateCount:0,seen:new WeakSet(),rejected:{},
    intentId,accountId,conversationId,staffNumber,independentCardIdentity,mainFrame:page.mainFrame()};
  const reject=reason=>{state.rejected[reason]=(state.rejected[reason] || 0)+1;};
  const onRequest=request=>{
    if(state.detached || !request || typeof request !== "object" || state.seen.has(request)) return;
    state.seen.add(request);
    if(state.submittedAtMs === null) {reject("before_begin_submit");return;}
    const observedAtMs=Date.now();
    if(observedAtMs<state.submittedAtMs || observedAtMs>state.submittedAtMs+WINDOW_MS) {reject("outside_submit_window");return;}
    try {
      const url=new URL(request.url());
      if(url.origin+url.pathname !== ENDPOINT) {reject("unexpected_endpoint");return;}
      if(request.method() !== "POST" || !["xhr","fetch"].includes(request.resourceType())) {reject("not_native_post");return;}
      if(typeof request.frame !== "function" || request.frame() !== state.mainFrame) {reject("unexpected_ui_frame");return;}
      const body=request.postDataBuffer();
      if(!(body instanceof Uint8Array)) {reject("body_unavailable");return;}
      if(body.byteLength>MAX_BODY_BYTES) {reject("body_too_large");return;}
      const rawBody=Buffer.from(body),parsed=JSON.parse(rawBody.toString("utf8"));
      if(!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {reject("body_not_object");return;}
      if(parsed.message_type !== "CARD") {reject("not_exact_card_type");return;}
      // More than one actual POST cannot establish one intent, even if identical.
      state.candidateCount++;
      if(state.requests.length>=2) return;
      let card=null,rawContentHash=null,canonicalContentHash=null;
      if(typeof parsed.content === "string") {
        rawContentHash=hash(Buffer.from(parsed.content,"utf8"));
        try {
          const content=JSON.parse(parsed.content);
          if(content && typeof content === "object" && !Array.isArray(content)) {
            card=content;canonicalContentHash=hash(canonicalJSON(content));
          }
        } catch { /* Retain the complete bounded original only in private memory. */ }
      }
      state.requests.push({observedAtMs,rawBody,parsed,card,rawContentHash,canonicalContentHash});
    } catch {reject("request_schema_unrecognized");}
  };
  page.on("request",onRequest);
  const fieldReport=value=>({type:type(value),equals_account_id:value === accountId,
    equals_customer_uid:value === conversationId,equals_staff_number:value === staffNumber});
  function bindingReport() {
    const reports=state.requests.map(record=>({
      endpoint:ENDPOINT,request_observed_at_ms:record.observedAtMs,top_level_keys:safeKeys(record.parsed),
      fields:Object.fromEntries(["sender_porch_id","c_user_id","receiver_id"].map(key=>[key,fieldReport(record.parsed[key])])),
      message_type:{type:type(record.parsed.message_type),equals_CARD:record.parsed.message_type === "CARD"},
      uuid_type:type(record.parsed.uuid),platform_type:type(record.parsed.platform),content_type:type(record.parsed.content),
      stable_identity_fields:identityFields.map(field=>({field,expected_type:type(independentCardIdentity[field]),
        actual_type:type(record.card?.[field]),equal:record.card !== null && Object.hasOwn(record.card,field) && record.card[field] === independentCardIdentity[field]})),
      raw_content_sha256:record.rawContentHash,canonical_content_sha256:record.canonicalContentHash,
    }));
    let reason="native_field_semantics_unverified";
    if(state.submittedAtMs === null) reason="submission_not_begun";
    else if(!state.candidateCount) reason="no_candidate_in_submit_window";
    else if(state.candidateCount !== 1) reason="ambiguous_native_requests";
    else if(!reports[0].fields.receiver_id.equals_customer_uid) reason="receiver_not_expected_customer";
    else if(!reports[0].canonical_content_sha256) reason="complete_card_content_unrecognized";
    else if(reports[0].stable_identity_fields.some(field=>!field.equal)) reason="independent_card_identity_mismatch";
    return {phase:"diagnostic_schema_unverified",status:"unknown",schema_verified:false,can_confirm_send:false,reason,
      detached:state.detached,begin_submit_bound:state.submittedAtMs !== null,submitted_at_ms:state.submittedAtMs,
      window_ms:WINDOW_MS,candidate_count:state.candidateCount,unique_request:state.candidateCount === 1,
      independent_identity_branded:true,rejected:{...state.rejected},candidates:reports};
  }
  const api={
    beginSubmit:atMs=>{
      if(state.detached) throw new Error("card_request_collector_detached");
      if(state.submittedAtMs !== null) throw new Error("begin_submit_already_bound");
      if(typeof atMs !== "number" || !Number.isFinite(atMs) || atMs<1000000000000 || atMs>Date.now()+1000 ||
         Date.now()-atMs>WINDOW_MS) throw new Error("invalid_begin_submit_time");
      state.submittedAtMs=atMs;return bindingReport();
    },
    bindingReport,
    detach:()=>{
      if(state.detached) return;
      state.detached=true;page.off("request",onRequest);
      if(collectors.get(page) === state) collectors.delete(page);
    },
  };
  // A later schema-specific trusted verifier can access this opaque collector's
  // original data. No current API returns raw bodies, contents, links or UUIDs.
  archives.set(api,state);collectors.set(page,state);return Object.freeze(api);
}
module.exports={arm};
