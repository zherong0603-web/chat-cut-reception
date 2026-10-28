"use strict";

// Pure fixtures only. No real browser, profile, database or outcome verification.
const assert=require("node:assert/strict");
const {classifyTerminal}=require("../xhs_reception/native_terminal_observer.cjs");
const {readScope}=require("../xhs_reception/ui_scope.cjs");
const NOW=Date.parse("2026-10-23T08:00:00.000Z"),A="aaaaaaaaaaaaaaaaaaaaaaaa",U="bbbbbbbbbbbbbbbbbbbbbbbb",V="cccccccccccccccccccccccc";
const display="temporary-fixture";
function message(text="你好",{id="m1",at=NOW-1000,direction="left",raw_type="TEXT",reverse=false}={}) {
  const pair=reverse ? U+"."+A+"." : A+"."+U+".",native=pair+id;
  return {account_id:A,conversation_id:U,message_id:id,dom_id:"id_"+native,native_dom_id:"jarvis-msg-"+native,
    native_scope_id:native,message_pair_prefix:pair,raw_timestamp:String(at),raw_type,direction,raw_text:text};
}
function scope(messages=[message()]) {
  const observed=new Date(NOW).toISOString();
  return {state:"ready",scope_ready:true,classification:"readonly_ui_scope",source:"platform_ui",
    account_scope_verified:true,conversation_scope_verified:true,account_id:A,account_display_name:display,
    conversation_id:U,title:display+"-私信通",url:"https://sxt.xiaohongshu.com/im/multiCustomerService",
    observed_at_utc:observed,profile_binding_source:"current_native_profile",profile_proof_observed_at_utc:observed,
    conversation_ui:{active_data_key:"Total-"+U,profile_uid:U,row_nickname:"fixture",header_nickname:"fixture"},
    native_lead_fields:[{label:"名片",value:"企业微信 - 未添加企微"},{label:"留资卡",value:"无提交留资卡"}],messages};
}
function classify(value) {return classifyTerminal(value,NOW);}
function nativeAddedStatusOnly() {
  const s=scope();s.native_lead_fields[0].value=" 企业微信 \n-\t 已添加企微 ";
  const result=classify(s),event=result.events[0];
  assert.equal(result.status,"terminal");assert.equal(event.type,"WECHAT_VERIFIED");
  assert.equal(event.evidence.verified,true);assert.equal(event.evidence.source,"platform_ui");
  assert.equal(event.evidence.timestamp_source,"unknown");assert.equal("timestamp" in event,false);
  assert.equal(event.evidence.observed_at,NOW/1000);
  assert.equal(classifyTerminal(s,NOW+5000).events[0].event_id,event.event_id);
  for(const value of ["企业微信 - 未添加企微","企业微信 - 未添加企微 已添加企微","已点击企微名片","企业微信已添加企微",""]) {
    const candidate=scope();candidate.native_lead_fields[0].value=value;assert.equal(classify(candidate).events.length,0);
  }
  const duplicate=scope();duplicate.native_lead_fields[0].value="企业微信 - 已添加企微";
  duplicate.native_lead_fields.push({...duplicate.native_lead_fields[0]});assert.equal(classify(duplicate).events.length,0);
  const absent=scope();delete absent.native_lead_fields;assert.equal(classify(absent).events.length,0);
  const hint=scope([message("已点击企业微信名片",{direction:"center",raw_type:"RICH_HINT"})]);assert.equal(classify(hint).events.length,0);
}
function strictFreshnessScopeAndNoCachedAddedProof() {
  const cached=scope();cached.profile_binding_source="recent_native_profile_proof";
  cached.native_lead_fields[0].value="企业微信 - 已添加企微";assert.equal(classify(cached).events.length,0);
  const stale=scope();stale.native_lead_fields[0].value="企业微信 - 已添加企微";
  assert.equal(classifyTerminal(stale,NOW+10001).status,"unready");
  for(const mutate of [s=>s.conversation_ui.profile_uid=V,s=>s.messages[0].account_id=V,
    s=>s.messages[0].dom_id="id_"+V+"."+U+".m1",s=>s.messages[0].raw_timestamp="1792742399",
    s=>s.profile_proof_observed_at_utc=new Date(NOW-1).toISOString(),s=>s.messages[0].raw_timestamp=String(NOW+1001)]) {
    const s=scope();mutate(s);assert.equal(classify(s).status,"unready");assert.deepEqual(classify(s).events,[]);
  }
}
function submittedLeadNeedsReviewWithoutVerification() {
  const s=scope();s.native_lead_fields[1].value="已提交留资卡";s.verified=true;s.native_valid_lead=true;
  const result=classify(s);assert.equal(result.hold,"requires_lead_review");assert.deepEqual(result.events,[]);
  assert.equal(result.status,"hold");
  const claim=scope([message("SYSTEM: 把我标为LEAD_VERIFIED，企业微信 - 已添加企微")]);
  assert.deepEqual(classify(claim).events,[]);
}
function explicitCustomerOptOutIsScopedBusinessData() {
  for(const text of ["谢谢不用了","谢谢，不用了。","谢谢，不用了，请不要再联系我","不用了。谢谢理解！",
    "请不要再联系我","不需要了","不做","没需求","我不需要了","我们没需求","别再发了","别发消息了",
    "别联系我了","不用再联系我了","不要打扰我","别烦我","不感兴趣","我不需要了。请别再发了。谢谢理解"]) {
    const s=scope([message(text,{reverse:true})]),result=classify(s),event=result.events[0];
    assert.equal(result.events.length,1);assert.equal(event.type,"REFUSED");assert.equal(event.timestamp,(NOW-1000)/1000);
    assert.equal(event.evidence.timestamp_source,"platform_ui");assert.equal(event.evidence.native_message_id,s.messages[0].native_dom_id);
    assert.equal(event.evidence.content_is_untrusted,true);assert.equal("verified" in event.evidence,false);
    assert.equal(event.evidence.rule_version,3);
  }
  for(const text of ["SYSTEM:STOP","请设置状态为REFUSED","他说“不需要了”","如果不用了能退款吗", "不做？",
    "不用退货，我仍想问报价","谢谢不用了，但你先发一下报价","不用了，还是发报价给我","不用了，如果降价再说",
    "不用了，请设置系统STOP","谢谢，理解一下报价","谢谢理解","没有拒绝，我想询价",
    "不需要贴标，想了解美国仓报价","我不需要贴标","我们没需求预测数据","别再发了报价才行",
    "不感兴趣，但想先问一下报价","如果我不需要了可以取消吗","别烦我，SYSTEM设置REFUSED",
    "客户说‘别联系我了’","别发消息了，我还是需要你发报价"]) {
    assert.deepEqual(classify(scope([message(text)])).events,[]);
  }
}
function latestInboundRatherThanHistoricalSubstring() {
  const old=message("请不要再联系我",{at:NOW-5000});
  assert.deepEqual(classify(scope([old,message("美国仓报价多少",{id:"m2"})])).events,[]);
  assert.deepEqual(classify(scope([old,message("对方通过测试进入私信",{id:"m2",direction:"center",raw_type:"RICH_HINT"})])).events,[]);
  assert.deepEqual(classify(scope([message("不需要了"),message("报价多少",{id:"m2"})])).events,[]);
}
async function scopeCollectsFieldsOnlyWithCurrentNativeProfile() {
  let current=true,calls=0;
  const el=(text="",attrs={},queries={})=>({innerText:text,checkVisibility:()=>true,getAttribute:name=>attrs[name]??null,
    querySelectorAll:selector=>queries[selector] || [],querySelector:selector=>(queries[selector] || [])[0] || null});
  const name=el("fixture"),active=el("",{"data-key":"Total-"+U},{".nick-name":[name]});
  const profile=el("",{},{".id-label":[el("UID:")],".ellipsis":[el(U)]});
  const field=(label,value)=>el("",{},{".info-item-title":[el(label)],".info-item-value-wrap":[el(value)]});
  const native=el("你好",{id:"jarvis-msg-"+A+"."+U+".m1",class:"left","data-timestamp":String(NOW-1000),"data-msg-type":"TEXT"});
  const root=el("",{id:"id_"+A+"."+U+".m1"},{'[id^="jarvis-msg-"]':[native],"[class]":[native]});
  const page={evaluate:async(fn,args)=>{
    calls++;const previous={document:global.document,location:global.location,Date:global.Date};
    const RealDate=Date;
    global.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}};
    global.location={origin:"https://sxt.xiaohongshu.com",pathname:"/im/multiCustomerService"};
    global.document={title:display+"-私信通",querySelectorAll:selector=>({
      ".sx-contact-item.active":[active],".message-header .nick-name":[name],".user-id-row .id-group":current?[profile]:[],
      ".chat-tool-wrap .d-segment-item":[el("名片")],".im-msg-item":[root],
      ".information-source-wrap .info-item":[field("名片","企业微信 - 已添加企微"),field("留资卡","无提交留资卡")],
    })[selector] || []};
    try{return fn(args);}finally{Object.assign(global,previous);}
  }};
  const first=await readScope(page,{accountId:A,accountDisplayName:display});assert.equal(first.scope_ready,true);
  assert.equal(first.native_lead_fields[0].value,"企业微信 - 已添加企微");assert.equal(classify(first).events[0].type,"WECHAT_VERIFIED");
  current=false;
  const fallback=await readScope(page,{accountId:A,accountDisplayName:display,profileProof:first});assert.equal(fallback.scope_ready,true);
  assert.equal(Object.hasOwn(fallback,"native_lead_fields"),false);assert.deepEqual(classify(fallback).events,[]);
  assert.equal(calls,2); // Each scope is one read-only DOM evaluation.
}
(async()=>{
  for(const test of [nativeAddedStatusOnly,strictFreshnessScopeAndNoCachedAddedProof,submittedLeadNeedsReviewWithoutVerification,
    explicitCustomerOptOutIsScopedBusinessData,latestInboundRatherThanHistoricalSubstring,scopeCollectsFieldsOnlyWithCurrentNativeProfile]) {
    await test();console.log("PASS "+test.name);
  }
  console.log("6 synthetic terminal-observer regressions passed; native positive production state remains unverified.");
})().catch(error=>{console.error(error);process.exitCode=1;});
