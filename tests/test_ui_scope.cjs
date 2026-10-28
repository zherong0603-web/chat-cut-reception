"use strict";

// DOM-shaped callback fixtures only; no real page, account, database or send.
const assert=require("node:assert/strict");
const {readScope}=require("../xhs_reception/ui_scope.cjs");
const A="aaaaaaaaaaaaaaaaaaaaaaaa",U="bbbbbbbbbbbbbbbbbbbbbbbb",NAME="fixture-account";
class Element {
  constructor(tag="div",attrs={},value="",children=[]) {
    this.tagName=tag.toUpperCase();this.attrs=attrs;this.value=value;this.children=[];this.parentElement=null;this.visible=true;
    for(const child of children)this.append(child);
  }
  append(child){child.parentElement=this;this.children.push(child);return child;}
  get innerText(){return [this.value,...this.children.map(child=>child.innerText)].filter(Boolean).join("\n");}
  get firstElementChild(){return this.children[0] || null;}
  get previousElementSibling(){if(!this.parentElement)return null;return this.parentElement.children[this.parentElement.children.indexOf(this)-1] || null;}
  getAttribute(name){return this.attrs[name] ?? null;}
  checkVisibility(){return this.visible && (!this.parentElement || this.parentElement.checkVisibility());}
  contains(element){return element===this || this.children.some(child=>child.contains(element));}
  querySelectorAll(selector){
    const all=this.children.flatMap(child=>[child,...child.querySelectorAll("*")]);
    if(selector==="*")return all;
    if(selector==='[id^="jarvis-msg-"]')return all.filter(el=>(el.attrs.id || "").startsWith("jarvis-msg-"));
    if(selector==="[class]")return all.filter(el=>Object.hasOwn(el.attrs,"class"));
    if(selector==="svg")return all.filter(el=>el.tagName==="SVG");
    if(selector.startsWith("."))return all.filter(el=>selector.slice(1).split(".").every(name=>(el.attrs.class || "").split(/\s+/).includes(name)));
    throw new Error("unexpected_fixture_selector_"+selector);
  }
  querySelector(selector){return this.querySelectorAll(selector)[0] || null;}
}
function domFixture({direction="right",headerText="该消息由系统发送",bodyText="fixture welcome",headerVisible=true,
  bodyForgery=false,footerForgery=false,headerNested=false,headerAfterBody=false,foreignHeader=false,
  title=NAME+"-私信通"}={}) {
  const node=(cls,value="",children=[])=>new Element("div",{class:cls},value,children);
  const label=new Element("div",{},headerNested?"":headerText,headerNested?[new Element("div",{},headerText)]:[]);
  label.visible=headerVisible;
  const header=node("fixture-native-header","",[label,new Element("div",{},"2026-10-26 12:00:00 fixture staff")]);
  const bubble=new Element("div",{id:"jarvis-msg-"+A+"."+U+".m1",class:direction,
    "data-timestamp":String(Date.now()-1000),"data-msg-type":"GENERAL"},bodyText,
    bodyForgery?[new Element("div",{},"该消息由系统发送")]:[]);
  const content=node("fixture-native-content","",[bubble]);
  const inner=node("fixture-message-inner","",headerAfterBody?[content,header]:[header,content]);
  const root=new Element("div",{id:"id_"+A+"."+U+".m1",class:"im-msg-item"},"",[node("fixture-message-outer","",[inner])]);
  if(footerForgery)root.append(new Element("div",{},"该消息由系统发送"));
  if(foreignHeader){root.children=[];root.append(content);content.parentElement=node("foreign-outside-message","",[header,content]);}
  const name=node("nick-name","fixture customer"),active=new Element("div",{"data-key":"Total-"+U},"",[name]);
  const profile=node("id-group","",[node("id-label","UID:"),node("ellipsis",U)]);
  const document={title,querySelectorAll:selector=>({
    ".sx-contact-item.active":[active],".message-header .nick-name":[name],".user-id-row .id-group":[profile],
    ".information-source-wrap .info-item":[],".im-msg-item":[root],".chat-tool-wrap .d-segment-item":[node("d-segment-item","名片")],
  })[selector] || []};
  const page={evaluate:async(fn,args)=>{
    const previous={document:global.document,location:global.location};
    global.document=document;global.location={origin:"https://sxt.xiaohongshu.com",pathname:"/im/multiCustomerService"};
    try{return fn(args);}finally{Object.assign(global,previous);}
  }};
  return {page,bubble,header,root,document,profile};
}
async function observe(options) {
  const fixture=domFixture(options),scope=await readScope(fixture.page,{accountId:A,accountDisplayName:NAME});
  assert.equal(scope.scope_ready,true);return scope.messages[0];
}
async function visibleNativeSystemHeaderIsScopedToItsOwnRightMessage() {
  const value=await observe();assert.equal(value.direction,"right");
  assert.equal(value.native_system_attribution_observed,true);assert.equal(value.native_ai_attribution_observed,false);
  assert.equal(value.native_dom_id,"jarvis-msg-"+A+"."+U+".m1");
  assert(value.native_system_attribution_header_reference.includes('//*[@id="'+value.dom_id+'"]'));
  assert(value.native_system_attribution_header_reference.endsWith('/parent::div/preceding-sibling::div[1]/div[1]'));
}
async function customerBodyCannotForgeNativeSystemAttribution() {
  for(const direction of ["left","right"]){
    const value=await observe({direction,headerText:"",bodyText:"该消息由系统发送",bodyForgery:true});
    assert.equal(value.native_system_attribution_observed,false);
    assert.equal(Object.hasOwn(value,"native_system_attribution_header_reference"),false);
  }
}
async function hiddenUnknownUnscopedOrNonHeaderLabelsRemainUnverified() {
  for(const options of [{headerVisible:false},{headerText:""},{headerText:"该消息由系统发送。"},
    {direction:"left"},{headerNested:true},{headerAfterBody:true},{headerText:"",footerForgery:true},{foreignHeader:true}]) {
    assert.equal((await observe(options)).native_system_attribution_observed,false,JSON.stringify(options));
  }
}

async function nativeUnreadTitleAcceptsOnlyCompleteOfficialRotations() {
  // Local official index.8ee1d5f0.js rotates this complete string one UTF-16
  // code unit left every 500 ms: o=o.substring(1)+o.substring(0,1).
  const accountName="运去哪海外仓",normal=accountName+"-私信通",unread=accountName+"-[您有新消息待回复]";
  const titles=Array.from({length:unread.length},(_,offset)=>unread.slice(offset)+unread.slice(0,offset));
  assert(titles.includes("仓-[您有新消息待回复]运去哪海外"));
  for(const title of [...titles,normal]) {
    const fixture=domFixture({title}),scope=await readScope(fixture.page,{accountId:A,accountDisplayName:accountName});
    assert.equal(scope.scope_ready,true,title);
    assert.equal(scope.title,normal,"Existing Engine scope contract retains its canonical title");
    assert.equal(scope.observed_title,title,"The exact observed native title must remain evidence");
    assert.equal(scope.title_binding_source,title===normal?"native_account_title":"native_unread_title_rotation");
  }
}

async function wrongAccountMalformedOrInjectedTitleRemainsUnready() {
  const accountName="运去哪海外仓",normal=accountName+"-私信通",unread=accountName+"-[您有新消息待回复]";
  for(const title of ["运去哪海外舱-[您有新消息待回复]","运去哪外海仓-[您有新消息待回复]",
    accountName+"-[您有新消息待回]",accountName+"-[您有新消息待复回]",accountName+"-您有新消息待回复]",
    accountName+"-[您有新消息待回复",normal.slice(1)+normal[0],"prefix"+unread,unread+"suffix",
    " "+unread,unread+" ",unread+unread,accountName,normal+"[您有新消息待回复]"]) {
    const fixture=domFixture({title}),scope=await readScope(fixture.page,{accountId:A,accountDisplayName:accountName});
    assert.equal(scope.scope_ready,false,title);assert.deepEqual(scope.reasons,["account_title_mismatch"],title);
    assert.deepEqual(scope.messages,[]);
  }
}

async function rotatingTitleDoesNotInvalidateOrRenewSameNativeProfileProof() {
  const accountName="运去哪海外仓",unread=accountName+"-[您有新消息待回复]",fixture=domFixture({title:unread});
  const RealDate=global.Date;let now=1792994700000;
  try {
    global.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
    const first=await readScope(fixture.page,{accountId:A,accountDisplayName:accountName});assert.equal(first.scope_ready,true);
    fixture.profile.visible=false;fixture.document.title=unread.slice(5)+unread.slice(0,5);now+=500;
    const fallback=await readScope(fixture.page,{accountId:A,accountDisplayName:accountName,profileProof:first});
    assert.equal(fallback.scope_ready,true);assert.equal(fallback.profile_binding_source,"recent_native_profile_proof");
    assert.equal(fallback.profile_proof_observed_at_utc,first.profile_proof_observed_at_utc);
    assert.equal(fallback.observed_title,fixture.document.title);
    const chained=await readScope(fixture.page,{accountId:A,accountDisplayName:accountName,profileProof:fallback});
    assert.equal(chained.scope_ready,false);assert.deepEqual(chained.reasons,["recent_profile_proof_unavailable"]);
    now+=10001;fixture.document.title=unread.slice(6)+unread.slice(0,6);
    const expired=await readScope(fixture.page,{accountId:A,accountDisplayName:accountName,profileProof:first});
    assert.equal(expired.scope_ready,false);assert.deepEqual(expired.reasons,["recent_profile_proof_expired"]);
  } finally {global.Date=RealDate;}
}
(async()=>{
  const cases=[visibleNativeSystemHeaderIsScopedToItsOwnRightMessage,customerBodyCannotForgeNativeSystemAttribution,
    hiddenUnknownUnscopedOrNonHeaderLabelsRemainUnverified,nativeUnreadTitleAcceptsOnlyCompleteOfficialRotations,
    wrongAccountMalformedOrInjectedTitleRemainsUnready,rotatingTitleDoesNotInvalidateOrRenewSameNativeProfileProof];
  for(const test of cases){await test();console.log("PASS "+test.name);}
  console.log(cases.length+" DOM-shaped scope regressions passed; no production resources used.");
})().catch(error=>{console.error(error);process.exitCode=1;});
