"use strict";
// Exercise the real reception_once adapter with isolated native-UI fixtures.
// No real browser, network request, account or business database is opened.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const file=path.resolve(__dirname,'../xhs_reception/ui_actions.cjs');
const source=fs.readFileSync(file,'utf8'),nativeRequire=createRequire(file);
const A='aaaaaaaaaaaaaaaaaaaaaaaa',U='bbbbbbbbbbbbbbbbbbbbbbbb',V='cccccccccccccccccccccccc';

async function scenario(options={},check) {
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-current-history-'));
  fs.writeFileSync(path.join(runtime,'account_identity.json'),JSON.stringify({account_id:A,account_display_name:'fixture'}));
  const model={clicks:[],hovers:[],selectors:[],scopeReads:0,current:true,loaded:null,responses:[],listFresh:false,targetFresh:false,
    scrolls:[],draft:options.draft || '',filterFailed:false,scrollTop:2236,scrollerReady:!options.delayedScroller,geometryWaits:0,allVisible:false,profileVisible:!options.profileHidden,allNativeActive:Boolean(options.fast),waiters:[],requestListeners:new Set()};
  const allView=()=>({documentElement:{clientWidth:1280,clientHeight:800},querySelectorAll:selector=>{
    if(selector==='.contact-tab-wrap .d-tabs-header'){
      const tab=(text,active)=>({innerText:text,checkVisibility:()=>true,classList:{contains:cls=>cls==='active'&&active}});
      return [tab('当前会话',!model.allNativeActive),tab('全部会话',model.allNativeActive)];
    }
    if(selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')return !model.scrollerReady?[]:Array.from({length:options.collapsedScroller?2:options.scrollers ?? 1},(_,index)=>({checkVisibility:()=>true,scrollTop:model.scrollTop,clientHeight:628,scrollHeight:5515,getBoundingClientRect:()=>({x:0,y:178.5,width:360,height:options.collapsedScroller&&index===0?0:628}),contains:()=>true}));
    if(selector==='.user-id-row .id-group')return model.profileVisible?[{checkVisibility:()=>true,querySelector:selector=>({textContent:selector==='.id-label'?'UID:':(options.profileUID || U)})}]:[];
    if(selector==='.im-msg-item')return [{id:'id_'+A+'.'+(options.messageUID || U)+'.native-fixture',checkVisibility:()=>true}];
    if(selector==='.sx-contact-item.active')return [{checkVisibility:()=>true,getAttribute:()=> 'Total-'+U}];
    if(selector==='.sx-contact-item')return Array.from({length:options.rows ?? 1},()=>({
      checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:200,width:350,height:61}),getAttribute:()=> (model.allNativeActive?'Total-':'Active-')+U}));
    throw Error('unexpected_all_view_selector_'+selector);
  }});
  const evaluateAllView=(fn,arg)=>vm.runInNewContext('('+fn.toString()+')(arg)',{document:allView(),arg});
  const scope=()=>({scope_ready:true,account_scope_verified:true,conversation_scope_verified:true,
    account_id:A,conversation_id:options.filterClickScopeChange&&model.filterFailed?V:options.wrongScope || model.clicks.includes('target') && options.scopeChangesAfterClick ? V : U,
    observed_at_utc:new Date().toISOString(),profile_binding_source:model.profileVisible&&!options.cachedProofAfterRestore?'current_native_profile':'recent_native_profile_proof',messages:[],
    ...(options.fast?{conversation_ui:{active_data_key:'Total-'+U}}:{})});
  function response(url,{method='GET',onFinish}={}){const request={method:()=>method};
    return {url:()=>url,request:()=>request,finished:async()=>{
      if(options.hangingBody && (options.hangingBody==='list'?url.includes('/chat?'):url.includes('/msg?')))
        return new Promise(()=>{});
      onFinish?.();
    }};}
  function emit(result,{alreadyStarted=false}={}){model.responses.push(result.url());
    if(!alreadyStarted)for(const listener of model.requestListeners)listener(result.request());
    for(const waiter of model.waiters){
    if(!waiter.done&&waiter.predicate(result)){waiter.done=true;waiter.resolve(result);}
  }}
  function targetResponse(){
    // Foreign/paged/native-POST responses cannot satisfy the new target GET.
    emit(response('https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg?customer_user_id='+V));
    emit(response('https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg?customer_user_id='+U+'&ref_store_id=2'));
    emit(response('https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg?customer_user_id='+U,{method:'POST'}));
    emit(response('https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg?customer_user_id='+U,{onFinish:()=>{model.targetFresh=true;}}));
  }
  const page={url:()=> 'https://sxt.xiaohongshu.com/im/multiCustomerService',
    evaluate:async(fn,arg)=>{if(fn.name==='nativeTotalScrollerGeometry'&&options.cancelDuringScrollerCount)model.current=false;return evaluateAllView(fn,arg);},
    on:(event,listener)=>{assert.equal(event,'request');model.requestListeners.add(listener);},
    off:(event,listener)=>{assert.equal(event,'request');model.requestListeners.delete(listener);},
    waitForResponse:async(predicate,args)=>{assert([2500,3500].includes(args.timeout));
      return new Promise(resolve=>model.waiters.push({predicate,resolve,done:false}));},
    waitForEvent:async(event,args)=>{assert.equal(event,'domcontentloaded');assert.equal(args.timeout,8000);
      return new Promise(resolve=>{model.loaded=resolve;});},
    waitForFunction:async(_fn,uid,args)=>{if(_fn.name==='nativeTotalScrollerAvailable'){
      assert(args.timeout>0&&args.timeout<=3000);model.geometryWaits++;
      if(options.cancelDuringScrollerWait)model.current=false;
      if(options.delayedScroller)model.scrollerReady=true;
      if(!evaluateAllView(_fn))throw Error('synthetic_native_scroller_not_ready_timeout');return;
    }if(_fn.name==='nativeVirtualWindowReady'){assert(args.timeout>0&&args.timeout<=3000);if(!evaluateAllView(_fn,uid))throw Error('synthetic_native_virtual_window_not_ready');return;}if(uid===null){assert(evaluateAllView(_fn),'All must be active with native Total rows');return;}
      assert([1200,3000].includes(args.timeout));assert(model.clicks.includes('target'));
      assert.equal(typeof uid==='string'?uid:uid.uid,U);
      assert(vm.runInNewContext('('+_fn.toString()+')(args)',{document:allView(),args:uid}), 'native profile UID must become visible only after explicit profile restoration');},locator:selector=>{
    model.selectors.push(selector);
    // Native reload + All conversations + this exact original UID are the only
    // actions provided. A third-party row or customer-send control fails.
    const kind=selector==='.reply-box-wrap textarea.reply-textarea'?'input':
      selector==='.menu-item'?'refresh':selector==='.contact-tab-wrap .d-tabs-header'?'all':
      selector==='.search-user .search-top > button'?'filter':
      selector==='.chat-tool-wrap .tabs-wrap .d-tabs-header'?'profile':
      selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller'?'scroller':
      selector==='.d-option-content'?'reply':
      selector==='.d-dropdown:visible input[value="reply-all"]'?'allInput':
      selector==='.d-dropdown:visible .d-option-content'?'reply_all':
      selector==='.d-dropdown:visible input[value="reply-all"],.d-dropdown:visible input[value="reply-replied"],.d-dropdown:visible input[value="reply-unreplied"]'?'choices':
      selector==='.sx-contact-item[data-key="Total-'+U+'"]'?'target':null;
    assert(kind,'unexpected history refresh selector: '+selector);
    return {filter(filter){assert.equal(filter.visible,true);
      if(kind==='refresh')assert(filter.hasText.test('刷新')&&!filter.hasText.test('其他刷新'));
      if(kind==='all')assert(filter.hasText.test('全部会话')&&!filter.hasText.test('其他全部会话'));
      if(kind==='reply')assert(filter.hasText.test('回复状态')&&!filter.hasText.test('其他回复状态'));
      if(kind==='profile')assert(filter.hasText.test('客资标注')&&!filter.hasText.test('其他客资标注'));
      if(kind==='reply_all')assert(filter.hasText.test('全部')&&!filter.hasText.test('其他全部'));
      return this;},count:async()=>{if(kind==='scroller'&&options.cancelDuringScrollerCount)model.current=false;return kind==='target'?(options.virtualTarget&&model.scrolls.length===0?0:options.rows ?? 1):kind==='profile'?options.profileTabs ?? 1:kind==='scroller'?options.collapsedScroller?2:options.scrollers ?? 1:1;},
      nth(index){assert.equal(kind,'scroller');assert.equal(index,options.collapsedScroller?1:0);return this;},
      evaluate:async(fn,arg)=>{assert.equal(kind,'scroller');assert(model.allNativeActive);return fn({get scrollTop(){return model.scrollTop;},scrollTo:args=>{assert(args.top>=0);assert.equal(Object.keys(args).length,1);model.scrollTop=args.top;model.scrolls.push(args.top);}},arg);},
      inputValue:async()=>model.draft,
      hover:async args=>{assert(['filter','reply'].includes(kind));assert.equal(args.timeout,kind==='filter'?700:600);model.hovers.push(kind);},
      evaluateAll:async()=>{assert.equal(kind,'choices');assert(model.allVisible,'must await visible submenu, not attached hidden checkbox');
        return ['reply-all','reply-replied','reply-unreplied']
        .map(value=>({value,checked:value===options.replyChoice}));},
      waitFor:async args=>{assert(['visible','attached'].includes(args.state));assert(['all','target','reply','allInput','reply_all','profile'].includes(kind));
        if(kind==='reply_all'){assert.equal(args.state,'visible');model.allVisible=true;}
        if(kind==='profile'&&options.cancelDuringProfileWait)model.current=false;
        if(kind==='target'&&options.viewRevertsDuringTargetWait){
          model.allNativeActive=false;throw Error('synthetic_target_wait_failed_after_view_change');
        }
        if(kind==='target'&&model.clicks.includes('reply_all')&&!model.filterFailed){
          assert(model.listFresh,'must await new native list completion before target selection');
          if(options.cancelDuringTargetWait)model.current=false;
        }},
      click:async args=>{assert.equal(args.force,undefined);assert([700,1000,1200,3000].includes(args.timeout));
        model.clicks.push(kind);
        if(options.clickFails&&kind==='refresh')throw Error('synthetic_native_reload_blocked');
        if(kind==='refresh'){assert.equal(typeof model.loaded,'function');model.allNativeActive=false;model.loaded();}
        if(kind==='all')model.allNativeActive=true;
        if(kind==='profile')model.profileVisible=true;
        if(kind==='reply_all'){
          assert(options.fast);if(options.filterClickFails){model.filterFailed=true;if(options.cancelAfterFilterClick)model.current=false;if(options.draftAfterFilterClick)model.draft='preserve new operator draft';throw Error('synthetic_svg_path_intercepts_pointer_events');}
          emit(response('https://sxt.xiaohongshu.com/api-sxt/edith/chatline/chat?limit=80'),{alreadyStarted:true});
          emit(response('https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg?customer_user_id='+U),{alreadyStarted:true});
          emit(response('https://sxt.xiaohongshu.com/api-sxt/edith/chatline/chat?limit=80&is_active=true'));
          emit(response('https://sxt.xiaohongshu.com/api-sxt/edith/chatline/chat?limit=80&ref_update_time=123'));
          emit(response('https://sxt.xiaohongshu.com/api-sxt/edith/chatline/chat?limit=80',{onFinish:()=>{model.listFresh=true;}}));
          if(options.targetFirst)targetResponse();
        }
        if(kind==='target'&&model.clicks.includes('reply_all')&&!options.targetFirst)targetResponse();
      }};
  }};
  const deps={
    './ui_controller.cjs':{status:()=>({running:false})},
    './ui_scope.cjs':{readScope:async()=>{model.scopeReads++;return scope();}},
    './ui_sender.cjs':{receive:async args=>{
      if(options.cancelled)model.current=false;
      return args.refreshHistory({uid:options.refreshUID || U,accountId:options.accountId || A,
        isCurrent:()=>model.current,submittedAtMs:Date.now()});
    }},
  };
  const module={exports:{}};
  const compiled=vm.runInNewContext('(function(exports,require,module,__filename,__dirname){\n'+source+'\n})',
    {process,Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval,console,global:{}},{filename:file});
  compiled(module.exports,name=>deps[name] || nativeRequire(name),module,file,path.dirname(file));
  const run=()=>module.exports.run({page,runtime,cmd:{operation:'reception_once',uid:U,text:'synthetic approved reply'}});
  try {await check({model,run});} finally {fs.rmSync(runtime,{recursive:true,force:true});}
}

async function failedNativeFilterClickUsesOnlyOneGuardedNativeReload(){
  await scenario({fast:true,filterClickFails:true},async({model,run})=>{
    const result=await run();assert.equal(result.action,'native_page_reload_restore_original_conversation');
    assert.equal(result.native_filter_click_failure.control,'native_reply_all');assert.equal(result.native_filter_click_failure.pointer_interception_observed,true);
    assert.deepEqual(model.clicks,['reply_all','refresh','all','target','profile']);assert.equal(model.requestListeners.size,0);
    assert.equal(result.customer_send_performed,false);assert.equal(result.confirms_send,false);
  });
}
async function failedFilterClickCannotReloadAfterCancelScopeChangeOrNewDraft(){
  for(const options of [{cancelAfterFilterClick:true},{filterClickScopeChange:true},{draftAfterFilterClick:true}])await scenario({fast:true,filterClickFails:true,...options},async({model,run})=>{
    await assert.rejects(run(),/reception_round_cancelled|native_history_refresh_scope_changed|native_history_refresh_nonempty_or_ambiguous_draft/);
    assert.deepEqual(model.clicks,['reply_all']);assert.equal(model.requestListeners.size,0);
  });
}

async function nativeReloadRestoresOnlyOriginalNativeConversation() {
  await scenario({},async({model,run})=>{
    const result=await run();assert.deepEqual(model.clicks,['refresh','all','target','profile']);
    assert.equal(result.conversation_id,U);assert.equal(result.account_id,A);
    assert.equal(result.confirms_send,false);assert.equal(result.customer_send_performed,false);
    assert(model.scopeReads>=3);assert.equal(result.action,'native_page_reload_restore_original_conversation');
    assert(Number.isFinite(result.elapsed_ms));
  });
}
async function invalidScopeOrCancellationCannotClickAnotherConversation() {
  for(const options of [{wrongScope:true},{refreshUID:V},{accountId:V},{cancelled:true},{draft:'preserve actual operator draft'}]) {
    await scenario(options,async({model,run})=>{
      await assert.rejects(run(),/native_history_refresh_|reception_round_cancelled/);
      assert.deepEqual(model.clicks,[]);
    });
  }
}
async function failedReloadOrScopeRestoreNeverChoosesAThirdPartyFallback() {
  for(const options of [{clickFails:true},{scopeChangesAfterClick:true}]) {
    await scenario(options,async({model,run})=>{
      await assert.rejects(run(),/synthetic_native_reload_blocked|native_history_refresh_scope_changed/);
      assert.deepEqual(model.clicks,options.clickFails?['refresh','all']:['refresh','all','target','profile']);
    });
  }
}
async function missingOriginalRowCannotClickAnotherCustomer() {
  for(const rows of [0,2])await scenario({rows},async({model,run})=>{
    await assert.rejects(run(),/unique_original_native_history_row_required/);
    assert.deepEqual(model.clicks,['refresh','all']);
  });
}
async function nativeAllFilterRefreshHandlesUncheckedAndAlreadyAllAndTargetPositions() {
  for(const replyChoice of [undefined,'reply-all'])for(const targetFirst of [false,true]){
    await scenario({fast:true,replyChoice,targetFirst},async({model,run})=>{
      const result=await run();assert.deepEqual(model.hovers,['filter','reply']);assert.deepEqual(model.clicks,['reply_all','target','profile']);
      assert.equal(result.action,'native_reply_all_reset_restore_original_conversation');
      assert.equal(result.reply_filter_preserved,true);assert.equal(result.confirms_send,false);
      assert(model.listFresh&&model.targetFresh);assert(model.waiters.every(waiter=>waiter.done));
      assert.equal(model.requestListeners.size,0);
      assert(!model.clicks.includes('refresh'));
    });
  }
}
async function restrictedReplyFiltersAreNeverChangedForAReceipt() {
  for(const replyChoice of ['reply-replied','reply-unreplied'])await scenario({fast:true,replyChoice},async({model,run})=>{
    const result=await run();assert.deepEqual(model.hovers,['filter','reply']);assert.deepEqual(model.clicks,['refresh','all','target','profile']);
    assert.equal(result.action,'native_page_reload_restore_original_conversation');
    assert.equal(model.responses.length,0);assert(!model.clicks.includes('reply_all'));
  });
}
async function hangingNativeResponseBodiesAreBoundedAndReleaseListener() {
  for(const hangingBody of ['list','target'])await scenario({fast:true,hangingBody},async({model,run})=>{
    const began=Date.now();await assert.rejects(run(),/native_(?:list|target_history)_body_timeout/);
    assert(Date.now()-began>=1400&&Date.now()-began<2300);
    assert.equal(model.requestListeners.size,0);assert.equal(model.clicks.filter(kind=>kind==='reply_all').length,1);
    assert(!model.clicks.includes('refresh'),'a failed fast reset cannot automatically retry via another refresh');
  });
}
async function cancelledDuringNativeTargetWaitCannotClickOriginalRow() {
  await scenario({fast:true,cancelDuringTargetWait:true},async({model,run})=>{
    await assert.rejects(run(),/reception_round_cancelled/);
    assert.deepEqual(model.clicks,['reply_all']);assert.equal(model.requestListeners.size,0);
    assert(!model.clicks.includes('target'));
  });
}
async function failedOriginalRowRestoreRepairsOnlyTheNativeIntakeView() {
  await scenario({viewRevertsDuringTargetWait:true},async({model,run})=>{
    await assert.rejects(run(),/synthetic_target_wait_failed_after_view_change/);
    assert.equal(model.allNativeActive,true,'A failed receipt refresh must not leave a Current-only intake blind spot');
    assert.deepEqual(model.clicks,['refresh','all','all']);
    assert.equal(model.clicks.filter(kind=>kind==='refresh').length,1);
    assert(!model.clicks.includes('target'));
  });
}

async function nativeHistoryRefreshRestoresHiddenProfileBeforeCheckingItsUID() {
  for(const fast of [false,true])await scenario({fast,profileHidden:true},async({model,run})=>{
    const result=await run();assert.equal(result.conversation_id,U);
    assert.equal(model.clicks.filter(kind=>kind==='profile').length,1);
    assert(model.clicks.indexOf('profile')>model.clicks.indexOf('target'));
    assert.equal(model.requestListeners.size,0);assert.equal(result.confirms_send,false);
  });
}

async function restoredProfileMustBeUniqueFreshScopedAndCancellable() {
  for(const options of [{profileTabs:0},{profileTabs:2},{profileUID:V},{messageUID:V},{cancelDuringProfileWait:true},{cachedProofAfterRestore:true}])
    await scenario({fast:true,profileHidden:true,...options},async({model,run})=>{
      await assert.rejects(run(),/unique_native_customer_profile_tab_required|native profile UID|reception_round_cancelled|native_history_refresh_scope_changed/);
      assert.equal(model.requestListeners.size,0);assert.equal(model.allNativeActive,true);
      assert.equal(model.clicks.filter(kind=>kind==='reply_all').length,1);
      assert(!model.clicks.includes('refresh'),'profile verification cannot retry the send/history reset');
      if(options.profileTabs!==undefined || options.cancelDuringProfileWait)assert(!model.clicks.includes('profile'));
    });
}

async function virtualizedOriginalTargetRestoresOnlyTheNativeTotalListTop(){
  for(const fast of [false,true])await scenario({fast,virtualTarget:true},async({model,run})=>{
    const result=await run();assert.equal(result.conversation_id,U);assert.deepEqual(model.scrolls,[0]);
    assert.equal(model.clicks.filter(kind=>kind==='target').length,1);assert.equal(model.clicks.filter(kind=>kind==='profile').length,1);
    assert.equal(model.requestListeners.size,0);assert.equal(result.confirms_send,false);
  });
}

async function virtualRestoreCannotUseAmbiguousOrCancelledScroller(){
  for(const options of [{scrollers:0},{scrollers:2},{cancelDuringScrollerCount:true}])await scenario({fast:true,virtualTarget:true,...options},async({model,run})=>{
    await assert.rejects(run(),/unique_native_total_scroller_required|reception_round_cancelled/);
    assert.deepEqual(model.scrolls,[]);assert(!model.clicks.includes('target'));assert(!model.clicks.includes('refresh'));
    assert.equal(model.requestListeners.size,0);
  });
}

async function targetRestoreWaitsForNativeReadyScrollerWithoutChangingScope(){
  await scenario({fast:true,virtualTarget:true,delayedScroller:true},async({model,run})=>{
    assert.equal((await run()).conversation_id,U);assert.equal(model.geometryWaits,1);
    assert.deepEqual(model.scrolls,[0]);assert.equal(model.clicks.filter(kind=>kind==='target').length,1);
    assert.equal(model.requestListeners.size,0);
  });
}
async function targetScrollerWaitRejectsAmbiguityTimeoutAndCancellation(){
  for(const options of [{scrollers:0},{scrollers:2},{delayedScroller:true,scrollers:2},{delayedScroller:true,cancelDuringScrollerWait:true}])
    await scenario({fast:true,virtualTarget:true,...options},async({model,run})=>{
      await assert.rejects(run(),options.cancelDuringScrollerWait?/reception_round_cancelled/:/unique_native_total_scroller_required:geometry_count=[02]/);
      assert.equal(model.geometryWaits,options.scrollers===2&&!options.delayedScroller?0:1);
      assert.deepEqual(model.scrolls,[]);assert(!model.clicks.includes('target'));assert(!model.clicks.includes('refresh'));
      assert.equal(model.requestListeners.size,0);
    });
}

async function targetRestoreIgnoresCollapsedZeroHeightNativeScroller(){await scenario({fast:true,virtualTarget:true,collapsedScroller:true},async({model,run})=>{
  assert.equal((await run()).conversation_id,U);assert.deepEqual(model.scrolls,[0]);assert.equal(model.clicks.filter(kind=>kind==='target').length,1);
});}

(async()=>{
  const tests=[failedNativeFilterClickUsesOnlyOneGuardedNativeReload,failedFilterClickCannotReloadAfterCancelScopeChangeOrNewDraft,targetRestoreWaitsForNativeReadyScrollerWithoutChangingScope,targetScrollerWaitRejectsAmbiguityTimeoutAndCancellation,targetRestoreIgnoresCollapsedZeroHeightNativeScroller,virtualRestoreCannotUseAmbiguousOrCancelledScroller,virtualizedOriginalTargetRestoresOnlyTheNativeTotalListTop,restoredProfileMustBeUniqueFreshScopedAndCancellable,nativeHistoryRefreshRestoresHiddenProfileBeforeCheckingItsUID,nativeReloadRestoresOnlyOriginalNativeConversation,invalidScopeOrCancellationCannotClickAnotherConversation,
    failedReloadOrScopeRestoreNeverChoosesAThirdPartyFallback,missingOriginalRowCannotClickAnotherCustomer,
    nativeAllFilterRefreshHandlesUncheckedAndAlreadyAllAndTargetPositions,restrictedReplyFiltersAreNeverChangedForAReceipt,
    hangingNativeResponseBodiesAreBoundedAndReleaseListener,cancelledDuringNativeTargetWaitCannotClickOriginalRow,
    failedOriginalRowRestoreRepairsOnlyTheNativeIntakeView];
  for(const test of tests){await test();console.log('PASS '+test.name);}
  console.log(tests.length+' synthetic current-conversation history adapter regressions passed; no production evidence generated.');
})().catch(error=>{console.error(error);process.exitCode=1;});
