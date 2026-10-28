"use strict";

// Actual readSidebar callback against DOM-shaped fixtures only. No browser,
// production runtime, database, UI click, Engine action or external send.
const assert=require("node:assert/strict");
const {readSidebar}=require("../xhs_reception/ui_sidebar.cjs");
const UID="aaaaaaaaaaaaaaaaaaaaaaaa";
class Element {
  constructor({text="",classes="",key=null,visible=true,children={}}={}) {
    Object.assign(this,{innerText:text,classes,key,visible,children});
  }
  checkVisibility(){return this.visible;}
  getAttribute(name){return name==="class"?this.classes:name==="data-key"?this.key:null;}
  querySelector(selector){return this.children[selector] || null;}
  querySelectorAll(selector){if(selector==="[class]")return [];throw new Error("unexpected_fixture_selector");}
}
const tab=(text,active=false,options={})=>new Element({text,
  classes:"d-tabs-header d-clickable d-tabs-header-linear d-tabs-header-linear-small"+(active?" active":""),...options});
const row=(key,visible=true)=>new Element({key,visible,classes:"sx-contact-item",children:{
  ".nick-name":new Element({text:"fixture customer"}),".time":new Element({text:"12:34:56"}),
  ".content":new Element({text:"PRIVATE_CUSTOMER_PREVIEW"})}});
function fixture({origin="https://sxt.xiaohongshu.com",pathname="/im/multiCustomerService",
  tabs=[tab("当前会话"),tab("全部会话",true)],rows=[]}={}) {
  let clicks=0;
  const document={title:"fixture-account-私信通",querySelectorAll(selector){
    if(selector===".contact-tab-wrap .d-tabs-header")return tabs;
    if(selector===".sx-contact-item")return rows;
    throw new Error("unexpected_document_fixture_selector");
  }};
  const page={click(){clicks++;throw new Error("readonly_sidebar_must_not_click");},evaluate:async fn=>{
    const previous={document:global.document,location:global.location};
    global.document=document;global.location={origin,pathname};
    try{return fn();}finally{Object.assign(global,previous);}
  }};
  return {page,get clicks(){return clicks;}};
}
async function wrongNativeReceptionRouteIsNeverSuccessfulEmptyIntake() {
  for(const pathname of ["/im/login","/im/multiCustomerService/","/im/multiCustomerService-copy","/"]) {
    const f=fixture({pathname});await assert.rejects(readSidebar(f.page),{code:"unexpected_sidebar_route"});
    assert.equal(f.clicks,0);
  }
  const foreign=fixture({origin:"https://other.example"});
  await assert.rejects(readSidebar(foreign.page),/unexpected_sidebar_origin/);
}
async function currentConversationsWithHiddenTotalRowsFailsInsteadOfReturningEmpty() {
  const f=fixture({tabs:[tab("当前会话",true),tab("全部会话")],
    rows:[row("Active-"+UID),row("Total-"+UID,false)]});
  await assert.rejects(readSidebar(f.page),{code:"native_all_conversations_view_required"});
  assert.equal(f.clicks,0);
}
async function missingAmbiguousOrForgedActiveTabsCannotAuthorizeIntake() {
  for(const tabs of [[],[tab("当前会话",true)],[tab("当前会话"),tab("全部会话")],
    [tab("当前会话",true),tab("全部会话",true)],
    [tab("全部会话",true),tab("全部会话")],[tab("全部会话",true),tab("未知筛选",true)],
    [tab("全部会话",false,{classes:"d-tabs-header inactive"})],
    [tab("全部会话",false,{classes:"d-tabs-header not-active"})],
    [tab("全部会话",false,{classes:"d-tabs-header active-ish"})],
    [tab("全部会话",true,{visible:false}),tab("当前会话",true)],
    [tab("全部会话 PRIVATE_CUSTOMER_INSTRUCTION",true)]]) {
    const f=fixture({tabs,rows:[row("Total-"+UID)]});
    await assert.rejects(readSidebar(f.page),{code:"native_all_conversations_view_required"});
    assert.equal(f.clicks,0);
  }
}
async function genuineAllViewAllowsAnActuallyEmptyInbox() {
  const f=fixture();const result=await readSidebar(f.page);
  assert.deepEqual(result.rows,[]);assert.equal(result.truncated,false);
  assert.equal(result.business_events_created,false);assert.equal(f.clicks,0);
}
async function allActiveTabWithCurrentOrMalformedVisibleRowsCannotMasqueradeAsEmpty() {
  for(const rows of [[row("Active-"+UID),row("Total-"+UID,false)],
    [row("Active-"+UID),row("Total-"+UID)],[row("Total-invalid")],
    [row("Total-"+UID.toUpperCase())],[row("unrecognized-native-row")]]) {
    const f=fixture({rows});
    await assert.rejects(readSidebar(f.page),{code:"native_all_conversations_view_required"});
    assert.equal(f.clicks,0);
  }
}
async function uniqueVisibleAllActiveStillRequiresVisibleExactTotalUidRows() {
  const f=fixture({tabs:[tab("当前会话",true,{visible:false}),tab("当前会话"),tab("全部会话",true)],
    rows:[row("Active-"+UID,false),row("Total-bbbbbbbbbbbbbbbbbbbbbbbb",false),row("Total-invalid",false),row("Total-"+UID)]});
  const result=await readSidebar(f.page);
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].uid,UID);
  assert.equal(result.rows[0].key,"Total-"+UID);
  assert.equal(result.rows[0].content,"PRIVATE_CUSTOMER_PREVIEW");
  assert.equal(result.business_events_created,false);assert.equal(f.clicks,0);
}
(async()=>{
  const tests=[allActiveTabWithCurrentOrMalformedVisibleRowsCannotMasqueradeAsEmpty,
    currentConversationsWithHiddenTotalRowsFailsInsteadOfReturningEmpty,
    wrongNativeReceptionRouteIsNeverSuccessfulEmptyIntake,
    missingAmbiguousOrForgedActiveTabsCannotAuthorizeIntake,genuineAllViewAllowsAnActuallyEmptyInbox,
    uniqueVisibleAllActiveStillRequiresVisibleExactTotalUidRows];
  for(const test of tests){await test();console.log("PASS "+test.name);}
  console.log(tests.length+" readonly sidebar regressions passed; no browser or production access.");
})().catch(error=>{console.error(error);process.exitCode=1;});
