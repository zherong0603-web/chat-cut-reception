"use strict";

// Passive responses caused by the native UI only. Never issue a request or act on a page.
const key=Symbol.for("xhs_reception.native_card_catalog_observers");
const pages=globalThis[key] || (globalThis[key]=new WeakMap());
const VERSION=1,MAX_RECORDS=8,MAX_BODY_BYTES=512*1024,READ_TIMEOUT_MS=2000,MAX_INFLIGHT=4;
const names=new Set(["企微_运去哪海外仓（企微）","运去哪海外仓（企微）"]);
const safeKey=value=>/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) && !/^[a-f0-9]{24}$/i.test(value) ? value : "<key>";
const type=value=>value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
function jsonSchema(value) {
  const result=[];
  function walk(value,path,depth) {
    if(result.length>=100 || depth>6) return;
    result.push({path,type:type(value)});
    if(Array.isArray(value)) {if(value.length) walk(value[0],path+"[]",depth+1);}
    else if(value && typeof value === "object") for(const key of Object.keys(value).slice(0,30)) walk(value[key],path+"."+safeKey(key),depth+1);
  }
  walk(value,"$",0);return result;
}
function attach(page) {
  if(!page || typeof page.on !== "function" || typeof page.off !== "function") throw new Error("existing_page_required");
  const existing=pages.get(page);if(existing?.api?.version === VERSION) return existing.api;
  existing?.api?.detach();
  const state={active:true,generation:0,requests:new WeakMap(),records:[],inflight:0};
  const append=record=>{state.records.push(record);if(state.records.length>MAX_RECORDS) state.records.shift();};
  const onRequest=request=>{
    if(!state.active) return;
    try {
      const url=new URL(request.url());
      if(url.origin !== "https://sxt.xiaohongshu.com" || request.method() !== "GET" ||
         !["xhr","fetch"].includes(request.resourceType()) || !/(card|tool|material)/i.test(url.pathname) ||
         /(history|profile|login|chatline\/msg)/i.test(url.pathname)) return;
      // Keep no query values, headers, credentials or request bodies.
      state.requests.set(request,{path:url.pathname,request_started_at_ms:Date.now(),generation:state.generation});
    } catch {}
  };
  const onFinished=request=>{void(async()=>{
    const info=state.requests.get(request);
    if(!state.active || !info || info.generation !== state.generation) return;
    state.requests.delete(request);
    if(state.inflight>=MAX_INFLIGHT) {append({path:info.path,http_status:null,schema:[],error:"catalog_read_capacity"});return;}
    state.inflight++;
    const generation=state.generation,current=()=>state.active && state.generation === generation;
    let timer;
    try {
      const read=(async()=>{
        const response=await request.response();if(!response) return {error:"catalog_response_unavailable"};
        const buffer=await response.body();
        if(buffer.byteLength>MAX_BODY_BYTES) return {http_status:response.status(),error:"catalog_body_too_large"};
        const data=JSON.parse(buffer.toString("utf8"));
        return {http_status:response.status(),data,schema:jsonSchema(data)};
      })().finally(()=>{state.inflight--;});
      // A timeout must not free a slot while the underlying read still exists.
      const result=await Promise.race([read,new Promise(resolve=>{timer=setTimeout(()=>resolve({error:"catalog_response_read_timeout"}),READ_TIMEOUT_MS);})]);
      if(current()) append({path:info.path,request_started_at_ms:info.request_started_at_ms,observed_at_utc:new Date().toISOString(),schema:[],...result});
    } catch {if(current()) append({path:info.path,http_status:null,schema:[],error:"catalog_json_unrecognized"});}
    finally {clearTimeout(timer);}
  })();};
  page.on("request",onRequest);page.on("requestfinished",onFinished);
  const api={version:VERSION,
    snapshot:()=>state.records.map(record=>({path:record.path,status:record.http_status ?? null,schema:record.schema || [],
      ...(record.error ? {error:record.error} : {})})),
    candidates:()=>{
      const result=[];
      for(const record of state.records) {
        let visited=0;
        function walk(value,path,depth) {
          if(result.length>=30 || ++visited>2000 || depth>12 || !value || typeof value !== "object") return;
          if(!Array.isArray(value) && (names.has(value.name) || names.has(value.title))) {
            result.push({classification:"unverified_native_catalog_candidate",path:record.path,status:record.http_status ?? null,
              json_path:path,keys:Array.from(new Set(Object.keys(value).slice(0,64).map(safeKey))),
              ...(names.has(value.name) ? {name:value.name} : {}),...(names.has(value.title) ? {title:value.title} : {})});
          }
          const keys=Object.keys(value).slice(0,200);
          for(const key of keys) walk(value[key],Array.isArray(value) ? path+"["+key+"]" : path+"."+safeKey(key),depth+1);
        }
        walk(record.data,"$",0);
      }
      return result;
    },
    // Trusted in-process binding only. Do not serialize these records to diagnostics.
    records:()=>state.records.slice(),
    detach:()=>{
      state.active=false;state.generation++;
      page.off("request",onRequest);page.off("requestfinished",onFinished);
      if(pages.get(page) === state) pages.delete(page);
    },
  };
  state.api=api;pages.set(page,state);return api;
}
module.exports={attach};
