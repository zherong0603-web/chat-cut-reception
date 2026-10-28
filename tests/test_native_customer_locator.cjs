"use strict";
// Actual action locator functions and DOM predicates; no browser, DB or send.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{performance}=require('node:perf_hooks');
const source=fs.readFileSync(path.resolve(__dirname,'../xhs_reception/ui_actions.cjs'),'utf8');
const begin=source.indexOf('function officialPage('),end=source.indexOf('// History reloads can preserve',begin);
const U='bbbbbbbbbbbbbbbbbbbbbbbb',V='cccccccccccccccccccccccc';
const api=vm.runInNewContext('(function(){'+source.slice(begin,end)+';return {locateNativeCustomerRow,nativeVirtualWindowReady};})()',{performance,URL,setTimeout,clearTimeout});
async function fixture(options={},check){
  const m={top:options.initialTop??2236,current:true,all:true,scrolls:[],waits:[],clicks:[],reads:0,ready:!options.hydrating};
  const visibleTarget=()=>options.alreadyVisible||m.top>=(options.targetTop??900)&&m.top<=(options.targetEnd??1500)&&!options.absent;
  const scrollers=()=>!m.ready?[]:Array.from({length:options.twoVisible||options.collapsed?2:1},(_,index)=>({checkVisibility:()=>true,
    getBoundingClientRect:()=>({x:0,y:options.containerOutsideViewport?900:178.5,width:360,height:options.collapsed&&index===0?0:628}),contains:()=>true,className:'vue-recycle-scroller ready direction-vertical scroller',classList:{contains:token=>token==='ready'},scrollTop:m.top,clientHeight:628,scrollHeight:options.scrollHeight??5515}));
  const rows=()=>[{checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:options.containerOutsideViewport?920:200,width:350,height:61}),getAttribute:()=> (m.all?'Total-':'Active-')+Math.floor(m.top/400).toString(16).padStart(24,'0')},...((visibleTarget()||options.pool)?Array.from({length:options.duplicate?2:1},()=>({checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:options.containerOutsideViewport?920:options.rowOutsideContainer?40:options.rowBeyondViewport?801:options.rowY??(!visibleTarget()?-9820.5:260),width:350,height:61}),getAttribute:()=> 'Total-'+U})):[])];
  const document={readyState:'complete',documentElement:{clientWidth:1280,clientHeight:800},querySelectorAll:selector=>selector==='.contact-tab-wrap .d-tabs-header'?['当前会话','全部会话'].map((text,index)=>({innerText:text,checkVisibility:()=>true,classList:{contains:cls=>cls==='active'&&(index===1?m.all:!m.all)}})):
    selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller'||selector==='.total-chat .vue-recycle-scroller'?scrollers():selector==='.sx-contact-item'?rows():selector.startsWith('.total-chat ')?[]:assert.fail('unexpected DOM selector '+selector)};
  const evaluate=(fn,arg)=>vm.runInNewContext('('+fn.toString()+')(arg)',{document,arg});
  const page={url:()=> 'https://sxt.xiaohongshu.com/im/multiCustomerService',evaluate:async(fn,arg)=>{m.reads++;return evaluate(fn,arg);},
    waitForFunction:async(fn,arg,args)=>{m.waits.push({name:fn.name,timeout:args.timeout});assert(args.timeout>0&&args.timeout<=3000);
      if(fn.name==='nativeTotalScrollerAvailable')m.ready=true;
      if(options.waitDelay)await new Promise(resolve=>setTimeout(resolve,Math.min(options.waitDelay,args.timeout)));
      if(options.cancelDuringWait)m.current=false;
      if(options.viewChangesDuringWait)m.all=false;
      if(!evaluate(fn,arg))throw Error('synthetic bounded native window did not settle');},
    locator:selector=>{
      const kind=selector==='.contact-tab-wrap .d-tabs-header'?'all':selector==='.sx-contact-item[data-key="Total-'+U+'"]'?'target':
        selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller'?'scroller':assert.fail('forbidden native selector '+selector);
      return {filter(){return this;},nth(index){assert.equal(kind,'scroller');assert.equal(index,options.collapsed?1:0);return this;},
        count:async()=>kind==='target'?((visibleTarget()||options.pool)?options.duplicate?2:1:0):1,waitFor:async()=>{},click:async()=>{m.clicks.push(kind);assert.equal(kind,'all');m.all=true;},
        evaluate:async(fn,arg)=>{assert.equal(kind,'scroller');return fn({get scrollTop(){return m.top;},clientHeight:628,scrollHeight:options.scrollHeight??5515,
          scrollTo:args=>{assert(args.top>=0);assert.equal(Object.keys(args).length,1);m.top=Math.min(args.top,(options.scrollHeight??5515)-628);m.scrolls.push(m.top);}},arg);}};
    }};
  const run=()=>api.locateNativeCustomerRow(page,{uid:U,isCurrent:()=>m.current,timeout:options.timeout??3000});
  await check({m,run,windowState:args=>evaluate(api.nativeVirtualWindowReady,args)});
}
async function recycledCssVisiblePoolRowMustBeScrolledIntoTheNativeViewport(){await fixture({pool:true},async({m,run})=>{
  await run();assert(m.scrolls.length>=3,'CSS-visible recycled row at y=-9820.5 cannot bypass native viewport search');
  assert(m.top>=900&&m.top<=1500);assert(m.scrolls.every(top=>top>=0));assert.deepEqual(m.clicks,[]);
});}
async function browserViewportAndNativeContainerBothClipTheClickableTarget(){for(const options of [{pool:true,rowOutsideContainer:true},{pool:true,containerOutsideViewport:true},{pool:true,rowBeyondViewport:true}])await fixture(options,async({m,run})=>{
  await assert.rejects(run(),/unique_visible_customer_row_required/);assert(m.scrolls.length<=10);assert.deepEqual(m.clicks,[]);
});}

async function recycledPoolKeyCannotSettleAnUnchangedNativeWindow(){await fixture({pool:true,initialTop:0},async({windowState})=>{
  const native=windowState({uid:U,snapshot:true});assert.equal(native.dom_target_count,1);assert.equal(native.clickable_target_count,0);
  assert(!native.keys.includes('Total-'+U));assert.equal(windowState({uid:U,top:0,previousTop:1,previousKeys:Array.from(native.keys)}),false);
});}
async function genuinePositiveViewportIntersectionCanUseTheExistingTargetWithoutScrolling(){await fixture({alreadyVisible:true,rowY:790},async({m,run})=>{await run();assert.deepEqual(m.scrolls,[]);assert.deepEqual(m.clicks,[]);});}

async function alreadyVisibleOriginalUidNeverScrollsOrWaitsForAnotherWindow(){await fixture({alreadyVisible:true},async({m,run})=>{await run();assert.deepEqual(m.scrolls,[]);assert.deepEqual(m.waits,[]);assert.deepEqual(m.clicks,[]);});}
async function originalUidBeyondFirstVirtualWindowIsFoundByNativeScreenSteps(){await fixture({},async({m,run})=>{await run();assert(m.scrolls.length>=3);assert.equal(m.scrolls[0],0);assert(m.scrolls.at(-1)>=900);assert(m.scrolls.every((top,index)=>index===0||top-m.scrolls[index-1]<=628));assert.deepEqual(m.clicks,[]);});}
async function tenthNativeWindowCanReachTheEndOfTheObserved5515pxList(){await fixture({targetTop:4800,targetEnd:6000},async({m,run})=>{await run();assert(m.scrolls.length<=10);assert.equal(m.scrolls.at(-1),5515-628);assert.deepEqual(m.clicks,[]);});}
async function missingOriginalUidIsBoundedAndKeepsExactNumericRangeDiagnostics(){for(const options of [{absent:true,scrollHeight:100000},{absent:true,scrollHeight:1300},{absent:true,waitDelay:20,timeout:45}])await fixture(options,async({m,run})=>{
  const began=performance.now();await assert.rejects(run(),/unique_visible_customer_row_required:.*pages=\d+.*scroll_top=\d+.*max_scroll=\d+.*geometry_count=1/);
  assert(m.scrolls.length<=10);assert(m.scrolls.length>=1);assert(performance.now()-began<250);assert.deepEqual(m.clicks,[]);
});}
async function ambiguousNativeGeometryOrExactTargetCannotBeChosen(){for(const options of [{twoVisible:true},{duplicate:true,alreadyVisible:true}])await fixture(options,async({m,run})=>{await assert.rejects(run(),/unique_native_total_scroller_required|unique_visible_customer_row_required/);assert.deepEqual(m.scrolls,[]);assert.deepEqual(m.clicks,[]);});}
async function collapsedNativeScrollerAndHydrationKeepTheSameStrictTarget(){for(const options of [{collapsed:true},{hydrating:true}])await fixture(options,async({m,run})=>{await run();assert(m.scrolls.at(-1)>=900);assert.deepEqual(m.clicks,[]);});}
async function failedSelectionCapturesTheCurrentViewBeforeItCanBeRestored(){await fixture({viewChangesDuringWait:true},async({m,run})=>{
  let failure;try{await run();}catch(error){failure=error;}assert(failure);assert.equal(m.all,false);
  const diagnostics=failure.native_selection_diagnostics;assert.equal(diagnostics.diagnostic_status,'native_controls_observed');
  assert.equal(diagnostics.tabs.find(tab=>tab.active).text,'当前会话');assert.equal(diagnostics.visible_rows.active,1);
  assert.equal(diagnostics.total_scrollers[0].rect.height,628);assert(failure.message.includes('native_selection_diagnostics='));
});}
async function cancelledOrChangedNativeViewCannotContinueScrolling(){for(const options of [{cancelDuringWait:true},{viewChangesDuringWait:true}])await fixture(options,async({m,run})=>{await assert.rejects(run(),/reception_round_cancelled|native_all_conversations_view_not_confirmed/);assert.equal(m.scrolls.length,1);assert.deepEqual(m.clicks,[]);});}
(async()=>{const tests=[recycledPoolKeyCannotSettleAnUnchangedNativeWindow,genuinePositiveViewportIntersectionCanUseTheExistingTargetWithoutScrolling,recycledCssVisiblePoolRowMustBeScrolledIntoTheNativeViewport,browserViewportAndNativeContainerBothClipTheClickableTarget,failedSelectionCapturesTheCurrentViewBeforeItCanBeRestored,tenthNativeWindowCanReachTheEndOfTheObserved5515pxList,originalUidBeyondFirstVirtualWindowIsFoundByNativeScreenSteps,alreadyVisibleOriginalUidNeverScrollsOrWaitsForAnotherWindow,missingOriginalUidIsBoundedAndKeepsExactNumericRangeDiagnostics,
  ambiguousNativeGeometryOrExactTargetCannotBeChosen,collapsedNativeScrollerAndHydrationKeepTheSameStrictTarget,cancelledOrChangedNativeViewCannotContinueScrolling];
for(const test of tests){await test();console.log('PASS '+test.name);}console.log(tests.length+' offline native virtual-list locator regressions; no production evidence.');})().catch(error=>{console.error(error);process.exitCode=1;});
