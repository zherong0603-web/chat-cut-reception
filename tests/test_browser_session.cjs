"use strict";

// VM-only entrypoint checks. Fake Playwright, filesystem and stdin: no browser,
// profile, production runtime, process daemon or customer action is started.
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const filename=path.resolve(__dirname,"../xhs_reception/browser_session.cjs");
const source=fs.readFileSync(filename,"utf8");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(args) {
  const model={events:[],calls:[],launches:0,closed:0,handlers:{}};
  const page={setDefaultTimeout(){},setDefaultNavigationTimeout(){},
    goto:async url=>{model.calls.push({operation:"goto",url});return {status:()=>200};},
    locator:()=>({filter(){return this;},waitFor:async()=>{}}),
    evaluate:async()=>({ready:"complete",body:true}),screenshot:async()=>{}};
  const context={pages:()=>[page],route:async()=>{},close:async()=>{model.closed++;}};
  const process={argv:["node",filename,...args],env:{XHS_PLAYWRIGHT_MODULE:"/synthetic/playwright"},
    once:(name,handler)=>{model.handlers[name]=handler;},
    stdout:{write:line=>{
      const event=JSON.parse(line);model.events.push(event);
      if(event.type==="reception_worker_started")queueMicrotask(()=>model.handlers.SIGTERM());
    }}};
  const fakeFS={existsSync:()=>false,mkdirSync(){},chmodSync(){}};
  const fakeRequire=name=>{
    if(name==="node:fs")return fakeFS;
    if(name==="node:path")return path;
    if(name==="node:perf_hooks")return require(name);
    if(name==="node:readline")return {createInterface:()=>({close(){},async *[Symbol.asyncIterator](){}})};
    if(name==="/synthetic/playwright")return {chromium:{launchPersistentContext:async(_profile,options)=>{
      model.launches++;assert.equal(options.headless,true);return context;
    }}};
    if(name==="./ui_controller.cjs")return {stop(){}};
    if(name==="./ui_actions.cjs")return {run:async({cmd})=>{
      model.calls.push(cmd);return {running:true,reception_mode:cmd.future_entries_only ? "future_entries_only" : "new_entries_and_due_followups"};
    }};
    throw new Error("unexpected_fixture_dependency_"+name);
  };
  vm.runInNewContext(source,{require:fakeRequire,__dirname:path.dirname(filename),process,URL,queueMicrotask},
    {filename,timeout:1000});
  const deadline=Date.now()+1000;
  while(!model.closed && !model.events.some(event=>event.type==="fatal")) {
    if(Date.now()>deadline)throw new Error("synthetic_session_did_not_settle");await delay(1);
  }
  return model;
}
async function futureOnlyArgumentRequiresReceptionWorker() {
  const model=await fixture(["--allow-isolated-browser","--future-entries-only"]);
  assert.equal(model.launches,0);
  assert.equal(model.events.at(-1).error,"future_entries_only_requires_reception_worker");
}
async function daemonPropagatesExplicitFutureOnlyWithoutActivatingUI() {
  const model=await fixture(["--allow-isolated-browser","--start-reception-worker","--daemon","--future-entries-only"]);
  assert.equal(model.launches,1);assert.equal(model.closed,1);
  const bootstrap=model.calls.find(call=>call.operation==="bootstrap_reception");
  assert.equal(bootstrap.future_entries_only,true);
  const started=model.events.find(event=>event.type==="reception_worker_started");
  assert.equal(started.result.reception_mode,"future_entries_only");assert.equal(started.full_five_second_acceptance,false);
}
async function legacyAutostartRetainsExistingPolicy() {
  const model=await fixture(["--allow-isolated-browser","--start-reception-worker","--daemon"]);
  assert.equal(model.calls.find(call=>call.operation==="bootstrap_reception").future_entries_only,false);
  assert.equal(model.events.find(event=>event.type==="reception_worker_started").result.reception_mode,"new_entries_and_due_followups");
}
async function existingActionsPropagateFutureOnlyToController() {
  const actionsFile=path.resolve(__dirname,"../xhs_reception/ui_actions.cjs");
  const module={exports:{}},calls=[];
  const fakeRequire=name=>{
    if(["node:fs","node:path","node:perf_hooks"].includes(name))return require(name);
    if(name==="./ui_controller.cjs")return {status:()=>({running:false}),start:async args=>{
      calls.push(args);return {running:true,reception_mode:args.futureEntriesOnly ? "future_entries_only" : "new_entries_and_due_followups"};
    }};
    throw new Error("unexpected_actions_fixture_dependency_"+name);
  };
  const sandbox={require:fakeRequire,module,exports:module.exports,URL};sandbox.global=sandbox;
  vm.runInNewContext(fs.readFileSync(actionsFile,"utf8"),sandbox,{filename:actionsFile,timeout:1000});
  const nativeView={querySelectorAll:selector=>{
    if(selector==='.contact-tab-wrap .d-tabs-header')return [{innerText:'全部会话',checkVisibility:()=>true,classList:{contains:cls=>cls==='active'}}];
    if(selector==='.sx-contact-item')return [];
    if(selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')return [{checkVisibility:()=>true,getBoundingClientRect:()=>({width:800,height:628}),scrollTop:0}];
    throw Error('unexpected_native_intake_fixture_selector_'+selector);
  }};
  const page={url:()=>"https://sxt.xiaohongshu.com/im/multiCustomerService",
    evaluate:async fn=>vm.runInNewContext('('+fn.toString()+')()',{document:nativeView}),
    waitForFunction:async fn=>{assert(vm.runInNewContext('('+fn.toString()+')()',{document:nativeView}));},
    locator:selector=>{assert(['.contact-tab-wrap .d-tabs-header','.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller'].includes(selector));
      return {nth(index){assert.equal(index,0);return this;},filter(){return this;},waitFor:async()=>{},count:async()=>1,evaluate:async fn=>fn({scrollTop:0}),click:()=>{throw Error('unexpected_intake_click');}};}};
  const result=await module.exports.run({page,
    runtime:"/synthetic/runtime",cmd:{operation:"start_reception_worker",future_entries_only:true}});
  assert.equal(calls.length,1);assert.equal(calls[0].futureEntriesOnly,true);
  assert.equal(result.reception_mode,"future_entries_only");
}
(async()=>{
  const cases=[futureOnlyArgumentRequiresReceptionWorker,daemonPropagatesExplicitFutureOnlyWithoutActivatingUI,
    legacyAutostartRetainsExistingPolicy,existingActionsPropagateFutureOnlyToController];
  for(const test of cases){await test();console.log("PASS "+test.name);}
  console.log(cases.length+" synthetic browser entrypoint checks passed; no browser or production resources used.");
})().catch(error=>{console.error(error);process.exitCode=1;});
