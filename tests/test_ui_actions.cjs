"use strict";

// Synthetic /tmp-only regression checks. No browser, profile, account or production
// connection file is opened, and these checks are not reception/SLA evidence.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const vm=require("node:vm");
const observer=require("../xhs_reception/ui_actions.cjs");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const loginURL="https://sxt.xiaohongshu.com/im/login";
const probeData=()=>({pathname:"/im/login",title:"synthetic fixture",ready:"complete",body_present:true,
  login_path_candidate:true,selection_candidates:[],message_id_candidates:[]});
const fullData=title=>({title:title || "synthetic fixture",ready:"complete",message_candidates:[],
  untrusted_context_text:"synthetic fixture"});

function temporaryRuntime() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"xhs-observer-test-"));
  fs.writeFileSync(path.join(dir,"connection.json"),JSON.stringify({hold:"UNKNOWN synthetic fixture",dispatch_enabled:false}),{mode:0o600});
  return dir;
}
function saved(dir) {return JSON.parse(fs.readFileSync(path.join(dir,"connection.json"),"utf8"));}
function run(page,dir,operation) {return observer.run({page,runtime:dir,cmd:{operation}});}
async function until(predicate) {
  const deadline=Date.now()+3000;
  while(!predicate()) {
    if(Date.now()>=deadline) throw new Error("synthetic condition did not settle within 3 seconds");
    await delay(10);
  }
}
async function cleanup(page,dir) {
  await run(page,dir,"stop_observer");
  fs.rmSync(dir,{recursive:true,force:true});
}

function nativeAllViewPage(options={}) {
  const model={allActive:false,clicks:0,waitReads:0,confirmed:false};
  const visibleRow=(prefix)=>({checkVisibility:()=>true,getAttribute:name=>name==='data-key'?prefix+'-aaaaaaaaaaaaaaaaaaaaaaaa':null});
  const document={querySelectorAll:selector=>{
    if(selector==='.contact-tab-wrap .d-tabs-header') {
      const tab=(text,active)=>({innerText:text,textContent:text,checkVisibility:()=>true,classList:{contains:value=>value==='active'&&active}});
      return [tab('当前会话',!model.allActive),tab('全部会话',model.allActive),...(options.duplicate?[tab('全部会话',false)]:[])];
    }
    if(selector==='.sx-contact-item')return options.empty?[]:[visibleRow(model.allActive&&!options.activeRowsOnly?'Total':'Active')];
    throw Error('unexpected_native_all_predicate_selector_'+selector);
  }};
  const execute=fn=>vm.runInNewContext('('+fn.toString()+')()',{document});
  const tab={filter(filter){assert.equal(filter.visible,true);assert(typeof filter.hasText==='string'?filter.hasText==='全部会话':filter.hasText.test('全部会话'));return this;},
    waitFor:async()=>{},count:async()=>options.duplicate?2:1,
    click:async args=>{assert.equal(args.force,undefined);model.clicks++;if(!options.noActivation&&!options.delayed)model.allActive=true;}};
  const page={url:()=>options.url||'https://sxt.xiaohongshu.com/im/multiCustomerService',
    locator:selector=>{assert.equal(selector,'.contact-tab-wrap .d-tabs-header');return tab;},
    waitForFunction:async fn=>{
      for(let frame=0;frame<3;frame++){
        model.waitReads++;if(options.delayed&&frame===1)model.allActive=true;
        if(execute(fn)){model.confirmed=true;return;}
      }
      throw Error('native_all_conversations_view_not_confirmed');
    },evaluate:async fn=>{if(options.revertAfterWait&&model.confirmed)model.allActive=false;return execute(fn);}};
  return {page,model};
}

async function clickReturnCannotPretendNativeAllViewIsReady() {
  const dir=temporaryRuntime(),{page,model}=nativeAllViewPage({noActivation:true});
  try{await assert.rejects(run(page,dir,'open_all_conversations'),/native_all_conversations_view_not_confirmed/);
    assert.equal(model.clicks,1);assert.equal(model.allActive,false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
async function nativeAllViewWaitsForHydrationAndAcceptsAnActuallyEmptyList() {
  for(const options of [{delayed:true},{empty:true}]){
    const dir=temporaryRuntime(),{page,model}=nativeAllViewPage(options);
    try{assert.equal((await run(page,dir,'open_all_conversations')).view,'all_conversations');
      assert(model.confirmed);assert.equal(model.allActive,true);assert.equal(model.clicks,1);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
}
async function nativeAllViewRejectsActiveRowsAmbiguityAndLateViewChanges() {
  for(const options of [{activeRowsOnly:true},{duplicate:true},{revertAfterWait:true}]){
    const dir=temporaryRuntime(),{page,model}=nativeAllViewPage(options);
    try{await assert.rejects(run(page,dir,'open_all_conversations'),/native_all_conversations_view_not_confirmed|unique_all_conversations_tab_required/);
      assert.equal(model.clicks,options.duplicate?0:1);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
}

async function stopDiscardsLateRead() {
  const dir=temporaryRuntime();let release,calls=0;
  const page={url:()=>loginURL,evaluate:()=>{calls++;return new Promise(resolve=>{release=resolve;});}};
  try {
    const starting=run(page,dir,"start_observer");
    await delay(600);assert.equal(calls,1);
    await run(page,dir,"stop_observer");
    release(probeData());
    assert.equal((await starting).running,false);
    assert.equal(calls,1); // The stopped probe must not start the full DOM read.
    assert.equal(saved(dir).readonly_observer.running,false);
    assert.equal(saved(dir).readonly_observer.inflight_read,false);
    assert.equal(saved(dir).hold,"UNKNOWN synthetic fixture");
  } finally {await cleanup(page,dir);}
}

async function stalledReadCannotOverlap() {
  const dir=temporaryRuntime();let release,calls=0;
  const page={url:()=>loginURL,evaluate:()=>{calls++;return new Promise(resolve=>{release=resolve;});}};
  try {
    const result=await run(page,dir,"start_observer");
    assert.equal(result.stalled,true);
    assert.equal(saved(dir).readonly_observer.stalled,true);
    await delay(550);assert.equal(calls,1);
    release(probeData());await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1); // Discard the expired probe, including its full-read phase.
    assert.equal(saved(dir).readonly_observer.stalled,false);
    assert.equal(saved(dir).readonly_observer.last_transition,"read_settled_after_stall");
    await run(page,dir,"stop_observer");
    assert.equal(saved(dir).readonly_observer.running,false);
    assert.equal(saved(dir).hold,"UNKNOWN synthetic fixture");
  } finally {await cleanup(page,dir);}
}

async function restartUsesOnlyNewGeneration() {
  const dir=temporaryRuntime();let release,oldCalls=0,newCalls=0;
  const oldPage={url:()=>loginURL,evaluate:()=>{oldCalls++;return new Promise(resolve=>{release=resolve;});}};
  const newPage={url:()=>loginURL,evaluate:async fn=>{
    newCalls++;
    return fn.toString().includes("login_path_candidate") ? probeData() : fullData("new generation fixture");
  }};
  try {
    const oldStart=run(oldPage,dir,"start_observer");await delay(20);
    await run(oldPage,dir,"stop_observer");await run(newPage,dir,"start_observer");
    assert.equal(newCalls,0); // Keep the old in-flight evaluation latched until it settles.
    release(probeData());assert.equal((await oldStart).running,false);
    await until(()=>newCalls>=2);assert.equal(oldCalls,1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"ui-observation.json"),"utf8")).title,"new generation fixture");
    await run(newPage,dir,"stop_observer");
    assert.equal(saved(dir).readonly_observer.running,false);
  } finally {await cleanup(newPage,dir);}
}

async function unchangedProbeAvoidsFullDOMAndHealthRewrite() {
  const dir=temporaryRuntime();let probes=0,full=0,version=0;
  const page={url:()=>loginURL,evaluate:async fn=>{
    if(fn.toString().includes("login_path_candidate")) {
      probes++;return {...probeData(),message_id_candidates:[{id:"synthetic-"+version}]};
    }
    full++;return fullData();
  }};
  try {
    await run(page,dir,"start_observer");
    const firstHealthWrite=fs.statSync(path.join(dir,"connection.json")).mtimeMs;
    await until(()=>probes>=3);assert.equal(full,1);
    assert.equal(fs.statSync(path.join(dir,"connection.json")).mtimeMs,firstHealthWrite);
    version++;await until(()=>full===2);
    assert.equal(saved(dir).hold,"UNKNOWN synthetic fixture");
    assert.equal(saved(dir).readonly_observer.dispatch_enabled,false);
    assert.equal(saved(dir).readonly_observer.authenticated_verified,false);
  } finally {await cleanup(page,dir);}
}

function identityPage({closeFails=false,targetCount=1}={}) {
  const events=[],state={visible:false},nativeView=nativeAllViewPage();
  const popup={waitFor:async({state:expected})=>{
    events.push("wait_"+expected);
    if(expected==="hidden" && (closeFails || state.visible))throw new Error("synthetic_popover_not_hidden");
    if(expected==="visible" && !state.visible)throw new Error("synthetic_popover_not_visible");
  },innerText:async()=>{events.push("read_identity");return "运去哪海外仓\n主账号ID：aaaaaaaaaaaaaaaaaaaaaaaa\n客服编号：1234";}};
  const neutral={filter(){return this;},count:async()=>targetCount,hover:async options=>{
    assert.equal(options.force,undefined);assert.equal(options.position,undefined);
    events.push("hover_body_center");if(!closeFails)state.visible=false;
  }};
  const page={url:()=>"https://sxt.xiaohongshu.com/im/multiCustomerService",title:async()=>"运去哪海外仓-私信通",
    evaluate:nativeView.page.evaluate,waitForFunction:nativeView.page.waitForFunction,
    locator:selector=>{
      if(selector===".root-menu-box .portrait")return {hover:async()=>{events.push("hover_portrait");state.visible=true;}};
      if(selector===".userInfo-popover")return popup;
      if(selector==="body")return neutral;
      if(selector===".contact-tab-wrap .d-tabs-header"){
        const nativeTab=nativeView.page.locator(selector),click=nativeTab.click;
        nativeTab.click=async options=>{assert.equal(state.visible,false);events.push('click_all_conversations');await click(options);};
        return nativeTab;
      }
      throw new Error("unexpected_identity_fixture_selector_"+selector);
    }};
  return {page,events,state};
}

async function identityPopoverClosesBeforeSavingAndNextBootstrapAction() {
  const dir=temporaryRuntime(),fixture=identityPage();
  try {
    const result=await run(fixture.page,dir,"read_account_identity");
    assert.equal(result.account_id,"aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(fixture.state.visible,false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"account_identity.json"),"utf8")).account_id,result.account_id);
    await run(fixture.page,dir,"open_all_conversations");
    assert.deepEqual(fixture.events,["hover_portrait","wait_visible","read_identity","hover_body_center",
      "wait_hidden","click_all_conversations"]);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}

async function failedPopoverDismissalCannotPersistIdentityOrContinue() {
  for(const options of [{closeFails:true},{targetCount:0},{targetCount:2}]) {
    const dir=temporaryRuntime(),fixture=identityPage(options),identityFile=path.join(dir,"account_identity.json");
    const original="{\"previous_account_binding\":\"unchanged\"}\n";fs.writeFileSync(identityFile,original);
    try {
      await assert.rejects(run(fixture.page,dir,"read_account_identity"),
        options.closeFails ? /synthetic_popover_not_hidden/ : /unique_native_body_hover_target_required/);
      assert.equal(fs.readFileSync(identityFile,"utf8"),original);
      assert(!fixture.events.includes("click_all_conversations"));assert.equal(fixture.state.visible,true);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
}

(async()=>{
  const tests=[clickReturnCannotPretendNativeAllViewIsReady,nativeAllViewWaitsForHydrationAndAcceptsAnActuallyEmptyList,
    nativeAllViewRejectsActiveRowsAmbiguityAndLateViewChanges,
    stopDiscardsLateRead,stalledReadCannotOverlap,restartUsesOnlyNewGeneration,unchangedProbeAvoidsFullDOMAndHealthRewrite,
    identityPopoverClosesBeforeSavingAndNextBootstrapAction,failedPopoverDismissalCannotPersistIdentityOrContinue];
  for(const test of tests) {
    await test();console.log("PASS "+test.name);
  }
  console.log(tests.length+" synthetic observer/identity regressions passed; no production evidence generated.");
})().catch(error=>{console.error(error);process.exitCode=1;});
