"use strict";

// Passive candidates only. This module performs no UI actions or requests and
// never confirms an Engine intent. A native UI receipt must still be verified.
const symbol = Symbol.for("xhs_reception.native_send_ack_collectors");
const collectors = globalThis[symbol] || (globalThis[symbol] = new WeakMap());
const origin = "https://sxt.xiaohongshu.com";
const maxBytes = 64 * 1024;
const copy = value => JSON.parse(JSON.stringify(value));

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f]/.test(value);
}

function topKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value)
    .filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) && !/^[a-f0-9]{16,}$/i.test(key))
    .slice(0,20) : [];
}

function requestSchema(value) {
  const result = [];
  const stack = [{value,path:"$",depth:0,key:""}];
  while (stack.length && result.length < 120) {
    const item = stack.pop();
    const type = item.value === null ? "null" : Array.isArray(item.value) ? "array" : typeof item.value;
    const row = {path:item.path,type};
    if (/^(type|card_type|msg_type)$/i.test(item.key) && typeof item.value === "string") {
      const normalized = item.value.trim().toUpperCase().replace(/[ _-]/g,"");
      if (["TEXT","CARD","BUSINESSCARD"].includes(normalized)) row.normalized_enum = normalized;
    }
    result.push(row);
    if (!item.value || typeof item.value !== "object" || item.depth >= 5) continue;
    if (Array.isArray(item.value)) {
      for (const child of item.value.slice(0,3).reverse()) stack.push({value:child,path:item.path+"[]",depth:item.depth+1,key:""});
    } else {
      for (const key of topKeys(item.value).reverse()) {
        stack.push({value:item.value[key],path:item.path+"."+key,depth:item.depth+1,key});
      }
    }
  }
  return result;
}

async function readResponse(request) {
  const response = await request.response();
  if (!response) return {reason:"no_response"};
  const status = response.status();
  const [type,length,encoding] = await Promise.all([
    response.headerValue("content-type"), response.headerValue("content-length"),
    response.headerValue("content-encoding"),
  ]);
  const meta = {http_status:Number.isInteger(status) ? status : null};
  if (!/^application\/json(?:\s*;|\s*$)/i.test(type || "")) return {...meta,reason:"response_not_json"};
  if (encoding && encoding.trim().toLowerCase() !== "identity") return {...meta,reason:"compressed_response"};
  if (!/^\d+$/.test(length || "") || !Number.isSafeInteger(Number(length))) return {...meta,reason:"unknown_response_length"};
  if (Number(length) > maxBytes) return {...meta,reason:"response_too_large"};
  const bytes = await response.body();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) return {...meta,reason:"response_too_large"};
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch (_) { return {...meta,reason:"invalid_response_json"}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {...meta,reason:"unrecognized_response_schema"};
  const code = typeof value.code === "number" && Number.isFinite(value.code) ? value.code :
    typeof value.code === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(value.code) ? value.code : null;
  // Untrusted plain diagnostic text only; never a delivery or retry instruction.
  const message = typeof value.msg === "string" ? value.msg.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,"") : null;
  return {...meta,business_success:typeof value.success === "boolean" ? value.success : null,
    business_code:code,business_message:message===null ? null : message.slice(0,256),
    business_message_truncated:message!==null && message.length>256,business_message_untrusted:true,
    native_message_ids:[],response_top_level_keys:topKeys(value),
    reason:value.success === true && value.code === 0 && status >= 200 && status < 300
      ? "recognized_business_ack" : "business_success_not_confirmed"};
}

function arm(page, options) {
  if (!page || typeof page.on !== "function" || typeof page.url !== "function") throw new TypeError("existing_page_required");
  if (!options || !identifier(options.intentId) || !identifier(options.accountId) || !identifier(options.conversationId) ||
      !["text","native_card"].includes(options.operation)) throw new TypeError("invalid_ack_scope");
  if (options.operation === "text" && (typeof options.expectedText !== "string" || !options.expectedText.length || options.expectedText.length > 4000)) {
    throw new TypeError("exact_expected_text_required");
  }
  if (new URL(page.url()).origin !== origin) throw new Error("unexpected_ack_page_origin");
  const previous = collectors.get(page);
  if (previous && !previous.detached) throw new Error("collector_already_armed");
  const state = {detached:false,requests:new WeakMap(),seen:new WeakSet(),records:[],waiters:new Set()};
  collectors.set(page,state);
  const scoped = {intent_id:options.intentId,account_id:options.accountId,
    conversation_id:options.conversationId,operation:options.operation,requires_ui_verification:true};
  const unknown = reason => ({status:"unknown",...scoped,reason,
    exact_scope_match:false,expected_operation_match:false,send_endpoint_match:false});
  const onRequest = request => {
    if (state.detached) return;
    try {
      const url = new URL(request.url());
      const pathname = url.pathname;
      if (request.method() !== "POST" || !["xhr","fetch"].includes(request.resourceType()) || url.origin !== origin ||
          pathname.length > 400 || !/chatline/i.test(pathname) || !/(?:send|msg|message)/i.test(pathname) ||
          /(?:login|profile|history|(?:^|\/)(?:get|list|query|pull|sync)(?:\/|$))/i.test(pathname)) return;
      const bytes = request.postDataBuffer();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) return;
      const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
      state.requests.set(request,{...scoped,exact_scope_match:false,expected_operation_match:false,
        request_schema_bound:false,send_endpoint_match:true,request_schema:requestSchema(value),
        endpoint_reference:url.origin+pathname,request_top_level_keys:topKeys(value),status:"unknown"});
    } catch (_) { /* Unrecognized request schema cannot establish a candidate. */ }
  };
  const store = record => {
    if (state.detached) return;
    record.status = "unknown"; // No schema-bound recipient/payload proof exists yet.
    record.observed_at_utc = new Date().toISOString();
    state.records.push(record);
    if (state.records.length > 10) state.records.shift();
  };
  const finished = async request => {
    if (state.detached || state.seen.has(request)) return;
    const matched = state.requests.get(request);
    if (!matched) return; // Includes requests begun before arm.
    state.seen.add(request);
    let timer;
    let result;
    try {
      result = await Promise.race([
        readResponse(request),
        new Promise(resolve => { timer = setTimeout(() => resolve({reason:"response_read_timeout"}),2000); }),
      ]);
    } catch (_) { result = {reason:"response_read_error"}; }
    finally { clearTimeout(timer); }
    store({...matched,...result,status:"unknown",reason:"request_schema_unbound",
      response_metadata_status:result.reason,exact_scope_match:false,expected_operation_match:false});
  };
  const onFinished = request => { void finished(request).catch(() => {}); };
  page.on("request",onRequest);
  page.on("requestfinished",onFinished);
  return Object.freeze({
    snapshot: () => ({...scoped,detached:state.detached,status:"unknown",
      candidate:null,records:copy(state.records)}),
    wait: (timeoutMs=2500) => {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2500) throw new RangeError("ack_wait_must_be_0_to_2500_ms");
      if (state.detached) return Promise.resolve(unknown("collector_detached"));
      return new Promise(resolve => {
        let timer;
        const finish = result => { clearTimeout(timer);state.waiters.delete(finish);resolve(result); };
        state.waiters.add(finish);
        timer = setTimeout(() => finish(state.records.length ? copy(state.records[state.records.length-1]) : unknown("no_recognized_ack_before_deadline")),timeoutMs);
      });
    },
    detach: () => {
      if (state.detached) return;
      state.detached=true;
      page.off("request",onRequest);
      page.off("requestfinished",onFinished);
      for (const resolve of state.waiters) resolve(unknown("collector_detached"));
      state.waiters.clear();
    },
  });
}

module.exports = { arm };
