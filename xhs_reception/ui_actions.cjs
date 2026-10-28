"use strict";

// Read-only UI observation and narrowly scoped login QR renewal in the isolated session.
// Browser-derived strings are evidence candidates, never control instructions.
const fs = require("node:fs");
const path = require("node:path");
const {performance} = require("node:perf_hooks");
const key = Symbol.for("xhs_reception.readonly_observer");
const state = global[key] || (global[key] = {timer:null, busy:false, lastFingerprint:null, lastSavedAt:0});
const INTERVAL_MS=500;
const READ_BUDGET_MS=2000;
const HEARTBEAT_MS=30000;
state.generation=state.generation || 0;
state.operationId=state.operationId || 0;
state.running=Boolean(state.timer);
state.lastHealthAttemptAt=state.lastHealthAttemptAt || 0;
state.lastErrorAt=state.lastErrorAt || 0;
state.scopeProofs=state.scopeProofs || new WeakMap();
state.runtimeReloads=state.runtimeReloads || new WeakMap();
state.humanReleaseRechecks=state.humanReleaseRechecks || new WeakMap();

async function currentScope(page,runtime,{restoreProfile=true}={}) {
  const binding=JSON.parse(fs.readFileSync(path.join(runtime,'account_identity.json'),'utf8'));
  const read=()=>require('./ui_scope.cjs').readScope(page,{accountId:binding.account_id,
    accountDisplayName:binding.account_display_name,profileProof:state.scopeProofs.get(page)});
  let scope=await read();
  if(!scope.scope_ready && restoreProfile) {
    const tab=page.locator('.chat-tool-wrap .tabs-wrap .d-tabs-header').filter({hasText:/^客资标注$/,visible:true});
    if(await tab.count()===1) {
      await tab.click({timeout:3000});
      await page.locator('.user-id-row').filter({visible:true}).waitFor({state:'visible',timeout:3000});
      scope=await read();
    }
  }
  if(scope.scope_ready && scope.profile_binding_source==='current_native_profile') state.scopeProofs.set(page,scope);
  return scope;
}

function officialPage(page) {
  const current=new URL(page.url());
  if(current.origin !== "https://sxt.xiaohongshu.com") throw new Error("unexpected_page_origin");
  return current;
}

function nativeAllConversationsReady() {
  const visible=element=>element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const tabs=Array.from(document.querySelectorAll('.contact-tab-wrap .d-tabs-header')).filter(visible);
  const all=tabs.filter(element=>(element.innerText || element.textContent || '').trim()==='全部会话');
  const active=tabs.filter(element=>element.classList.contains('active'));
  if(all.length!==1 || active.length!==1 || active[0]!==all[0])return false;
  // An actually empty All list is valid. A Current-only list is not an empty
  // inbox: the sidebar collector deliberately accepts visible Total rows only.
  return Array.from(document.querySelectorAll('.sx-contact-item')).filter(visible)
    .every(element=>/^Total-[a-f0-9]{24}$/.test(element.getAttribute('data-key') || ''));
}

async function ensureNativeAllConversations(page,{isCurrent=()=>true}={}) {
  const current=officialPage(page);
  if(current.pathname!=='/im/multiCustomerService')throw new Error('authenticated_inbox_required');
  if(!isCurrent())throw new Error('reception_round_cancelled');
  const all=page.locator('.contact-tab-wrap .d-tabs-header').filter({hasText:/^全部会话$/,visible:true});
  await all.waitFor({state:'visible',timeout:5000});
  if(await all.count()!==1)throw new Error('unique_all_conversations_tab_required');
  if(await page.evaluate(nativeAllConversationsReady))return {view:'all_conversations',native_view_verified:true};
  if(!isCurrent())throw new Error('reception_round_cancelled');
  await all.click({timeout:1000});
  try{await page.waitForFunction(nativeAllConversationsReady,null,{timeout:3000});}
  catch(error){const failure=new Error('native_all_conversations_view_not_confirmed:'+String(error.message));failure.code='native_all_conversations_view_not_confirmed';throw failure;}
  if(!isCurrent())throw new Error('reception_round_cancelled');
  if(!await page.evaluate(nativeAllConversationsReady))throw new Error('native_all_conversations_view_not_confirmed');
  return {view:'all_conversations',native_view_verified:true};
}

function nativeTotalScrollerGeometry() {
  return Array.from(document.querySelectorAll('.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')).flatMap((element,index)=>{
    const rect=element.getBoundingClientRect();
    return element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&rect.width>0&&rect.height>0?
      [{index,scrollTop:element.scrollTop,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight}]:[];
  });
}

function nativeTotalScrollerAvailable() {
  // A mounted All tab can precede the virtual list's ready container. Only
  // nonzero native geometry is ready; ambiguity is rejected by the caller.
  return Array.from(document.querySelectorAll('.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')).some(element=>{
    const rect=element.getBoundingClientRect();
    return element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&rect.width>0&&rect.height>0;
  });
}

function nativeSelectionSnapshot() {
  const visible=element=>element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const rect=element=>{const value=element.getBoundingClientRect();return {x:value.x,y:value.y,width:value.width,height:value.height};};
  const classes=element=>String(element.className || '').slice(0,240);
  const labels=new Set(['当前会话','全部会话']);
  const tabs=Array.from(document.querySelectorAll('.contact-tab-wrap .d-tabs-header')).slice(0,8).map(element=>{
    const text=(element.innerText || element.textContent || '').trim();
    return {text:labels.has(text)?text:'unrecognized_native_tab',active:element.classList.contains('active'),visible:visible(element)};
  });
  const total_scrollers=Array.from(document.querySelectorAll('.total-chat .vue-recycle-scroller')).slice(0,8).map(element=>({
    classes:classes(element),ready_class:element.classList.contains('ready'),rect:rect(element),check_visible:visible(element),
    scroll_top:element.scrollTop,client_height:element.clientHeight,scroll_height:element.scrollHeight}));
  const visible_rows={total:0,active:0,other:0};
  for(const element of Array.from(document.querySelectorAll('.sx-contact-item')).filter(visible)){
    const key=element.getAttribute('data-key') || '';visible_rows[/^Total-[a-f0-9]{24}$/.test(key)?'total':/^Active-[a-f0-9]{24}$/.test(key)?'active':'other']++;
  }
  const loading_visible=Array.from(document.querySelectorAll('.total-chat .d-loading,.total-chat .d-spin,.total-chat .loading,.total-chat [aria-busy="true"]')).filter(visible).length;
  const allowedHints=new Set(['加载中','加载中...','暂无会话','暂无数据','暂无客户','没有更多了','数据加载失败','网络错误','重试']);
  const native_status_hints=Array.from(document.querySelectorAll('.total-chat .empty,.total-chat .empty-tip,.total-chat .loading-text')).filter(visible)
    .map(element=>(element.textContent || '').trim()).filter(text=>allowedHints.has(text)).slice(0,8);
  return {diagnostic_status:'native_controls_observed',ready_state:document.readyState,tabs,total_scrollers,visible_rows,loading_visible,native_status_hints};
}

async function nativeFailureDiagnostics(page) {
  let timer;
  try{return await Promise.race([page.evaluate(nativeSelectionSnapshot),new Promise(resolve=>{
    timer=setTimeout(()=>resolve({diagnostic_status:'native_diagnostics_timeout'}),200);
  })]);}
  catch{return {diagnostic_status:'native_diagnostics_unavailable'};}
  finally{clearTimeout(timer);}
}

async function restoreNativeIntakeView(page,{isCurrent=()=>true}={}) {
  await ensureNativeAllConversations(page,{isCurrent});
  const selector='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller';
  const geometries=await page.evaluate(nativeTotalScrollerGeometry),count=geometries.length;
  const scroller=count===1?page.locator(selector).nth(geometries[0].index):null;
  if(!isCurrent())throw new Error('reception_round_cancelled');
  if(count===0){
    const visibleRows=await page.evaluate(()=>Array.from(document.querySelectorAll('.sx-contact-item')).filter(element=>
      element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).length);
    if(!isCurrent())throw new Error('reception_round_cancelled');
    if(visibleRows===0)return {native_intake_view_verified:true,empty_native_list:true};
  }
  if(count!==1)throw new Error('unique_native_total_scroller_required');
  if(await scroller.evaluate(element=>element.scrollTop)!==0){
    if(!isCurrent())throw new Error('reception_round_cancelled');
    await scroller.evaluate(element=>element.scrollTo({top:0}));
  }
  try{await page.waitForFunction(()=>{
    const scrollers=Array.from(document.querySelectorAll('.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')).filter(element=>{
      const rect=element.getBoundingClientRect();
      return element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&rect.width>0&&rect.height>0;
    });
    return scrollers.length===1&&scrollers[0].scrollTop===0;
  },null,{timeout:1000});}
  catch(error){throw new Error('native_intake_top_not_confirmed:'+String(error.message));}
  if(!isCurrent())throw new Error('reception_round_cancelled');
  await ensureNativeAllConversations(page,{isCurrent});
  if(!isCurrent())throw new Error('reception_round_cancelled');
  return {native_intake_view_verified:true,native_total_scroll_top:0};
}

function nativeVirtualWindowReady({uid,snapshot=false,top,previousTop,previousKeys=[]}) {
  const visible=element=>element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const scrollers=Array.from(document.querySelectorAll('.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')).filter(element=>{
    const rect=element.getBoundingClientRect();return visible(element)&&rect.width>0&&rect.height>0;
  });
  const rows=Array.from(document.querySelectorAll('.sx-contact-item')).filter(visible);
  const targetRows=rows.filter(element=>element.getAttribute('data-key')==='Total-'+uid);
  const state={geometry_count:scrollers.length,dom_target_count:targetRows.length,clickable_target_count:0,keys:[]};
  if(scrollers.length!==1)return snapshot?state:true;
  const scroller=scrollers[0],box=scroller.getBoundingClientRect();
  const width=document.documentElement.clientWidth,height=document.documentElement.clientHeight;
  const left=Math.max(0,box.left??box.x),right=Math.min(width,(box.left??box.x)+box.width);
  const upper=Math.max(0,box.top??box.y),lower=Math.min(height,(box.top??box.y)+box.height);
  const clickable=element=>{
    const rect=element.getBoundingClientRect(),x=rect.left??rect.x,y=rect.top??rect.y;
    return scroller.contains(element)&&rect.width>0&&rect.height>0&&right>left&&lower>upper&&
      Math.min(right,x+rect.width)>Math.max(left,x)&&Math.min(lower,y+rect.height)>Math.max(upper,y);
  };
  const inView=rows.filter(clickable);state.keys=inView.map(element=>element.getAttribute('data-key'));
  state.clickable_target_count=inView.filter(element=>element.getAttribute('data-key')==='Total-'+uid).length;
  if(snapshot)return state;
  if(scroller.scrollTop!==top)return false;
  // Vue's recycled pool stays CSS-visible around y=-9999. Only a target with
  // native container AND browser viewport intersection can settle as a target.
  return state.clickable_target_count>0||previousTop===top||state.keys.join('|')!==previousKeys.join('|');
}

async function locateNativeCustomerRowImpl(page,{uid,isCurrent=()=>true,timeout=3000,failureCode='unique_visible_customer_row_required'}) {
  if(!/^[a-f0-9]{24}$/.test(uid || ''))throw new Error('invalid_customer_uid');
  await ensureNativeAllConversations(page,{isCurrent});
  const row=page.locator('.sx-contact-item[data-key="Total-'+uid+'"]').filter({visible:true});
  let count=await row.count();
  if(!isCurrent())throw new Error('reception_round_cancelled');
  if(count>1)throw new Error(failureCode);
  const initial=await page.evaluate(nativeVirtualWindowReady,{uid,snapshot:true});
  if(!isCurrent())throw new Error('reception_round_cancelled');
  if(initial.geometry_count>1)throw new Error('unique_native_total_scroller_required:geometry_count='+initial.geometry_count);
  if(initial.dom_target_count>1)throw new Error(failureCode);
  count=count===1?initial.clickable_target_count:0;
  const deadline=performance.now()+timeout;
  let pages=0,lastTop=0,maxScroll=0,rangeEnd=0,geometryCount=0;
  const failed=reason=>new Error(failureCode+':pages='+pages+':scroll_top='+lastTop+':max_scroll='+maxScroll+
    ':range_start=0:range_end='+rangeEnd+':geometry_count='+geometryCount+':'+reason);
  const guard=async()=>{
    if(!isCurrent())throw new Error('reception_round_cancelled');
    officialPage(page);
    if(!await page.evaluate(nativeAllConversationsReady))throw new Error('native_all_conversations_view_not_confirmed');
    if(!isCurrent())throw new Error('reception_round_cancelled');
  };
  const geometry=async()=>{
    let values=await page.evaluate(nativeTotalScrollerGeometry);geometryCount=values.length;
    if(!isCurrent())throw new Error('reception_round_cancelled');
    if(values.length===0){
      if(performance.now()>=deadline)throw failed('native_scroller_ready_timeout');
      try{await page.waitForFunction(nativeTotalScrollerAvailable,null,{timeout:Math.max(1,Math.ceil(deadline-performance.now()))});}
      catch(error){
        if(!isCurrent())throw new Error('reception_round_cancelled');
        throw new Error('unique_native_total_scroller_required:geometry_count=0:'+String(error.message));
      }
      if(!isCurrent())throw new Error('reception_round_cancelled');
      values=await page.evaluate(nativeTotalScrollerGeometry);geometryCount=values.length;
    }
    if(!isCurrent())throw new Error('reception_round_cancelled');
    if(values.length!==1)throw new Error('unique_native_total_scroller_required:geometry_count='+values.length);
    const value=values[0];lastTop=value.scrollTop;
    if(!Number.isFinite(value.scrollTop)||!Number.isFinite(value.clientHeight)||value.clientHeight<=0||
       !Number.isFinite(value.scrollHeight)||value.scrollHeight<value.clientHeight)throw failed('native_scroller_geometry_invalid');
    maxScroll=Math.max(0,value.scrollHeight-value.clientHeight);return value;
  };
  if(count===0){
    // Only this native All-list container is scrolled, with overlap. A target
    // outside the first virtual window is never replaced by another UID.
    // The existing timeout covers the complete search, capped at ten screens.
    for(let screen=0;screen<10&&count===0;screen++){
      if(performance.now()>=deadline)throw failed('native_target_search_timeout');
      await guard();
      const before=await geometry(),top=screen===0?0:Math.min(maxScroll,before.scrollTop+Math.max(1,Math.floor(before.clientHeight*.9)));
      if(screen>0&&top<=before.scrollTop)break;
      const previousWindow=await page.evaluate(nativeVirtualWindowReady,{uid,snapshot:true}),previousKeys=previousWindow.keys;
      await guard();
      if(performance.now()>=deadline)throw failed('native_target_search_timeout');
      const scroller=page.locator('.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller').nth(before.index);
      lastTop=await scroller.evaluate((element,top)=>{element.scrollTo({top});return element.scrollTop;},top);pages++;
      if(!Number.isFinite(lastTop))throw failed('native_scroll_top_not_observed');
      rangeEnd=Math.max(rangeEnd,lastTop);
      if(!isCurrent())throw new Error('reception_round_cancelled');
      const remaining=Math.ceil(deadline-performance.now());
      if(remaining<=0)throw failed('native_target_search_timeout');
      try{await page.waitForFunction(nativeVirtualWindowReady,{uid,top:lastTop,previousTop:before.scrollTop,previousKeys},{timeout:remaining});}
      catch(error){
        if(!isCurrent())throw new Error('reception_round_cancelled');
        throw failed('native_virtual_window_not_confirmed:'+String(error.message));
      }
      await guard();
      const after=await geometry();rangeEnd=Math.max(rangeEnd,after.scrollTop);
      const cssCount=await row.count(),windowState=await page.evaluate(nativeVirtualWindowReady,{uid,snapshot:true});
      if(!isCurrent())throw new Error('reception_round_cancelled');
      if(cssCount>1||windowState.dom_target_count>1||windowState.clickable_target_count>1)throw failed('ambiguous_exact_native_target');
      count=cssCount===1?windowState.clickable_target_count:0;
      if(after.scrollTop>=maxScroll&&count===0)break;
    }
    if(count!==1)throw failed('original_uid_not_in_bounded_native_windows');
  }
  const remaining=Math.ceil(deadline-performance.now());
  if(remaining<=0)throw failed('native_target_search_timeout');
  try{await row.waitFor({state:'visible',timeout:remaining});}
  catch(error){throw failed(String(error.message));}
  if(await row.count()!==1)throw failed('ambiguous_or_missing_exact_native_target');
  const finalWindow=await page.evaluate(nativeVirtualWindowReady,{uid,snapshot:true});
  if(finalWindow.geometry_count!==1||finalWindow.dom_target_count!==1||finalWindow.clickable_target_count!==1)
    throw failed('original_native_target_outside_clickable_viewport');
  if(!isCurrent())throw new Error('reception_round_cancelled');
  return row;
}

async function locateNativeCustomerRow(page,options) {
  try{return await locateNativeCustomerRowImpl(page,options);}
  catch(error){
    if(options.isCurrent&&!options.isCurrent())throw error;
    error.native_selection_diagnostics=await nativeFailureDiagnostics(page);
    error.message+=':native_selection_diagnostics='+JSON.stringify(error.native_selection_diagnostics);
    throw error;
  }
}

// History reloads can preserve the native lead-tools pane. Restore the
// profile explicitly before waiting for its UID; a hidden/cached profile cannot
// be the fresh identity proof for a send receipt.
async function restoreNativeCustomerProfile(page,{uid,accountId,isCurrent=()=>true,timeout=3000}) {
  officialPage(page);
  if(!/^[a-f0-9]{24}$/.test(uid || '') || !/^[a-f0-9]{24}$/.test(accountId || ''))throw new Error('native_profile_binding_required');
  if(!isCurrent())throw new Error('reception_round_cancelled');
  const tab=page.locator('.chat-tool-wrap .tabs-wrap .d-tabs-header').filter({hasText:/^客资标注$/,visible:true});
  await tab.waitFor({state:'visible',timeout});
  if(await tab.count()!==1)throw new Error('unique_native_customer_profile_tab_required');
  const input=page.locator('.reply-box-wrap textarea.reply-textarea').filter({visible:true});
  if(await input.count()!==1 || await input.inputValue()!=='')throw new Error('native_profile_nonempty_or_ambiguous_draft');
  if(!isCurrent())throw new Error('reception_round_cancelled');
  await tab.click({timeout:Math.min(timeout,1000)});
  await page.waitForFunction(({uid,accountId})=>{
    const visible=element=>element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    const selected=Array.from(document.querySelectorAll('.sx-contact-item.active')).filter(visible);
    const groups=Array.from(document.querySelectorAll('.user-id-row .id-group')).filter(element=>
      visible(element)&&element.querySelector('.id-label')?.textContent.trim()==='UID:');
    return selected.length===1&&['Total-'+uid,'Active-'+uid].includes(selected[0].getAttribute('data-key'))&&
      groups.length===1&&groups[0].querySelector('.ellipsis')?.textContent.trim()===uid&&
      Array.from(document.querySelectorAll('.im-msg-item')).filter(visible).some(element=>
        element.id.startsWith('id_'+accountId+'.'+uid+'.')||element.id.startsWith('id_'+uid+'.'+accountId+'.'));
  },{uid,accountId},{timeout});
  if(!isCurrent())throw new Error('reception_round_cancelled');
  if(await input.count()!==1 || await input.inputValue()!=='')throw new Error('native_profile_nonempty_or_ambiguous_draft');
}

async function openCardMenu(page) {
  officialPage(page);
  const segments=page.locator('.chat-tool-wrap .d-segment-item').filter({hasText:/^名片$/,visible:true});
  if(await segments.count() !== 1) {
    const existing=page.locator('.chat-tool-wrap .tabs-wrap .d-tabs-header').filter({hasText:/^获客工具$/,visible:true});
    if(await existing.count()===1) await existing.click({timeout:1500});
    else {
      const tool=page.locator('.reply-tools .tool-item:has(svg.servicePage-icon)').filter({visible:true});
      if(await tool.count()!==1) throw new Error('unique_native_lead_tools_control_required');
      await tool.click({timeout:1500});
    }
  }
  await segments.waitFor({state:'visible',timeout:1500});
  if(await segments.count()!==1) throw new Error('unique_native_card_tab_required');
  await segments.click({timeout:1500});
  await page.locator('.chat-tool-wrap .card-box__content-title[title="企微_运去哪海外仓（企微）"]')
    .filter({visible:true}).waitFor({state:'visible',timeout:2000});
}

async function probe(page) {
  const started=performance.now();
  officialPage(page);
  const candidate=await page.evaluate(() => {
    const rendered=el => el.checkVisibility
      ? el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})
      : Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
    const attributes=el => Object.fromEntries(Array.from(el.attributes).filter(a =>
      /^(id|class|aria-selected|aria-current|data-timestamp|data-self|data-validtype|data-normal|data-msg-type)$/.test(a.name)
    ).map(a => [a.name,a.value]));
    return {
      pathname:location.pathname,title:document.title,ready:document.readyState,body_present:Boolean(document.body),
      login_path_candidate:location.pathname === "/im/login",
      login_state_candidate:location.pathname === "/im/login"
        ? Array.from(document.querySelectorAll(".qrcode-container")).slice(0,4).map(container=>{
          const containerVisible=rendered(container);
          return {rendered:containerVisible,masks:Array.from(container.querySelectorAll(".mask")).slice(0,6).map(mask=>{
            const visible=containerVisible && rendered(mask);
            // Read only rendered status text, never the QR image/canvas or hidden success text.
            return {rendered:visible,text:visible ? (mask.innerText || "").slice(0,160) : null};
          })};
        }) : null,
      selection_candidates:Array.from(document.querySelectorAll("[aria-selected=true],[aria-current]"))
        .filter(rendered).slice(0,30).map(attributes),
      message_id_candidates:Array.from(document.querySelectorAll(".im-msg-item")).slice(-200).map(el => ({
        attributes:attributes(el),rendered:rendered(el),
        native_attributes:el.querySelector("[data-timestamp]") ? attributes(el.querySelector("[data-timestamp]")) : null,
        text_length:el.textContent?.length || 0,
      })),
    };
  });
  const current=officialPage(page);
  return {observed_at_utc:new Date().toISOString(),elapsed_ms:performance.now()-started,
    url:current.origin+current.pathname,classification:"unverified_readonly_ui_probe",
    authenticated_verified:false,account_scope_verified:false,conversation_scope_verified:false,...candidate};
}

async function collectFull(page) {
  const started = performance.now();
  officialPage(page);
  const dom = await page.evaluate(() => {
    const rendered = el => el.checkVisibility
      ? el.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})
      : Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
    const attrs = el => Object.fromEntries(Array.from(el.attributes).filter(a =>
      /^(id|class|role|aria-selected|aria-current|data-timestamp|data-self|data-validtype|data-normal|data-msg-type)$/.test(a.name)
    ).map(a => [a.name,a.value]));
    const describe = el => ({tag:el.tagName,attributes:attrs(el),rendered:rendered(el),text:(el.innerText || "").slice(0,2000)});
    const messages = Array.from(document.querySelectorAll(".im-msg-item")).slice(-200).map(el => {
      const details = el.querySelector("[data-timestamp]");
      return { ...describe(el), native_attributes:details ? attrs(details) : null,
        native_status_markup:el.innerHTML.slice(0,18000) };
    });
    return {
      title:document.title, ready:document.readyState,
      // Cached conversations can contribute to this text. Never use it as receipt.
      untrusted_context_text:(document.body?.innerText || "").slice(0,10000),
      heading_candidates:Array.from(document.querySelectorAll("h1,h2,h3,[role=heading]")).filter(rendered).map(describe),
      selection_candidates:Array.from(document.querySelectorAll("[aria-selected=true],[aria-current]")).filter(rendered).slice(0,30).map(describe),
      input_candidates:Array.from(document.querySelectorAll("textarea,input,[contenteditable=true]")).filter(rendered).map(el => ({...describe(el),placeholder:el.getAttribute("placeholder"),disabled:Boolean(el.disabled)})),
      visible_buttons:Array.from(document.querySelectorAll("button")).filter(rendered).slice(0,60).map(describe),
      message_candidates:messages,
      body_children:Array.from(document.body?.children || []).slice(0,20).map(el => ({tag:el.tagName,attributes:attrs(el)})),
    };
  });
  const current=officialPage(page);
  return {observed_at_utc:new Date().toISOString(),url:current.origin+current.pathname,
    elapsed_ms:performance.now()-started,authenticated_verified:false,
    account_scope_verified:false,conversation_scope_verified:false,
    classification:"unverified_readonly_ui_candidates",...dom};
}

function atomicJSON(file, value) {
  const tmp = file + ".observer-tmp";
  fs.writeFileSync(tmp,JSON.stringify(value,null,2)+"\n",{mode:0o600});
  fs.renameSync(tmp,file);
}

function errorText(error) {return String(error?.message || error).slice(0,300);}

function reportError(error) {
  const message=errorText(error),now=Date.now();
  if(message !== state.lastError || now-state.lastErrorAt>=HEARTBEAT_MS) {
    process.stdout.write(JSON.stringify({type:"observer_error",at:new Date().toISOString(),error:message})+"\n");
    state.lastError=message;state.lastErrorAt=now;
  }
}

function persistHealth(runtime,patch) {
  if(!runtime) return;
  state.lastHealthAttemptAt=Date.now();
  try {
    const file=path.join(runtime,"connection.json");
    const connection=JSON.parse(fs.readFileSync(file,"utf8"));
    if(!connection || typeof connection !== "object" || Array.isArray(connection)) throw new Error("invalid_connection_document");
    const previous=connection.readonly_observer || {};
    const next={...previous,
      running:Boolean(state.running),interval_ms:INTERVAL_MS,
      authenticated_verified:false,account_scope_verified:false,conversation_scope_verified:false,
      dispatch_enabled:false,live_reception_ready:false,...patch};
    if(Object.prototype.hasOwnProperty.call(patch,"login_state_candidate") &&
       JSON.stringify(previous.login_state_candidate) !== JSON.stringify(patch.login_state_candidate)) {
      const history=Array.isArray(previous.login_state_history) ? previous.login_state_history : [];
      next.login_state_history=history.slice(-19).concat({
        observed_at_utc:patch.login_state_observed_at_utc,url:patch.url,
        classification:"unverified_visible_login_state_candidate",candidate:patch.login_state_candidate,
      });
      next.login_state_changed_at_utc=patch.login_state_observed_at_utc;
    }
    connection.readonly_observer=next;
    atomicJSON(file,connection);
  } catch(error) {reportError(error);}
}

async function boundedRead({page,runtime,generation,task}) {
  if(state.busy) return {status:"busy",stalled:Boolean(state.stalled),readonly:true};
  const operationId=++state.operationId;
  state.busy=true;state.stalled=false;state.pendingOperation=operationId;
  let expired=false,watchdog;
  const started=performance.now();
  const finish=(error,value) => {
    clearTimeout(watchdog);
    const recoveryTransition=expired || state.stalled || generation !== state.generation;
    if(state.pendingOperation === operationId) {
      state.pendingOperation=null;state.busy=false;state.stalled=false;
      if(recoveryTransition) state.needHealthWrite=true;
    }
    if(generation !== state.generation) {
      if(!state.running && runtime === state.runtime) {
        persistHealth(runtime,{running:false,stalled:false,inflight_read:false,
          last_transition:"stopped_read_settled",last_read_finished_at_utc:new Date().toISOString()});
      }
      return {status:"cancelled",readonly:true};
    }
    if(expired) {
      persistHealth(runtime,{stalled:false,inflight_read:false,last_transition:"read_settled_after_stall",
        last_read_finished_at_utc:new Date().toISOString(),last_dom_read_ms:performance.now()-started,
        last_error:error ? errorText(error) : null});
      if(error) reportError(error);
      // The timed-out result is discarded; a later tick must observe afresh.
      return {status:"settled_after_stall",readonly:true};
    }
    if(error) {
      state.needHealthWrite=true;
      reportError(error);
      persistHealth(runtime,{stalled:false,inflight_read:false,last_transition:"read_error",last_error:errorText(error)});
      return {status:"error",error:errorText(error),readonly:true};
    }
    return {status:"ok",value};
  };
  const settled=Promise.resolve().then(task).then(value=>finish(null,value),error=>finish(error));
  const timeout=new Promise(resolve=>{
    watchdog=setTimeout(()=>{
      expired=true;state.stalled=true;
      if(generation === state.generation) {
        persistHealth(runtime,{stalled:true,inflight_read:true,last_transition:"read_stalled",
          read_budget_ms:READ_BUDGET_MS,stalled_at_utc:new Date().toISOString()});
        reportError(new Error("readonly_ui_read_stalled"));
      }
      // Keep busy latched until the actual read settles; never queue another evaluation.
      resolve({status:"stalled",readonly:true,read_budget_ms:READ_BUDGET_MS});
    },READ_BUDGET_MS);
  });
  return Promise.race([settled,timeout]);
}

async function observe(page,{runtime}={}) {
  if(runtime) state.runtime=runtime;
  const result=await boundedRead({page,runtime,generation:state.generation,task:()=>collectFull(page)});
  return result.status === "ok" ? result.value : result;
}

function loginDiagnostics(page,context) {
  const diagnostics=state.loginDiagnostics || (state.loginDiagnostics={events:[],pages:new WeakSet(),contexts:new WeakSet()});
  const safeURL=value => {
    try {const u=new URL(value);return {origin:u.origin,path:u.pathname};}
    catch {return {origin:null,path:null};}
  };
  const push=event => {
    diagnostics.events.push({at:new Date().toISOString(),...event});
    if(diagnostics.events.length>20) diagnostics.events.shift();
  };
  const attach=p => {
    if(diagnostics.pages.has(p)) return;
    diagnostics.pages.add(p);
    p.on("requestfailed",request=>{
      if(!request.isNavigationRequest()) return;
      const text=request.failure()?.errorText || "";
      const match=text.match(/(?:net::)?ERR_[A-Z_]+/);
      push({type:"navigation_request_failed",...safeURL(request.url()),failure:match ? match[0] : "request_failed"});
    });
    p.on("framenavigated",frame=>push({type:"frame_navigated",...safeURL(frame.url())}));
    p.on("pageerror",error=>push({type:"page_error",name:/^[A-Za-z]{1,40}Error$/.test(error.name) ? error.name : "Error"}));
  };
  for(const p of context ? context.pages() : [page]) attach(p);
  if(context && !diagnostics.contexts.has(context)) {
    diagnostics.contexts.add(context);context.on("page",attach);
  }
  return {diagnostics,safeURL};
}

function legacyOriginalTextAnchor(runtime,{accountId,uid,intentId,pythonExecutable='/usr/bin/python3'}) {
  const script=`import json,math,pathlib,re,sqlite3,sys

def fail(code): raise ValueError(code)
def obj(raw):
 value=json.loads(raw or '{}')
 if not isinstance(value,dict): fail('invalid_original_evidence')
 return value
con=None
try:
 con=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True,timeout=.5)
 con.row_factory=sqlite3.Row
 con.execute('PRAGMA query_only=ON')
 con.execute('BEGIN')
 account,uid,intent_id=sys.argv[2:]
 original=con.execute('SELECT * FROM outbox WHERE intent_id=?',(intent_id,)).fetchone()
 if original is None or original['account_id']!=account or original['conversation_id']!=uid or original['status']!='UNKNOWN': fail('original_intent_mismatch')
 payload,evidence=obj(original['payload']),obj(original['evidence'])
 submitted=original['submitted_at'];text=payload.get('text');observed=evidence.get('observed_at')
 if (payload.get('operation')!='text' or not isinstance(text,str) or not text or len(text)>4000 or
     not isinstance(submitted,(int,float)) or not math.isfinite(submitted) or
     evidence.get('native_message_raw_id') is not None or evidence.get('native_message_id') is not None or
     evidence.get('source')!='platform_ui' or evidence.get('account_id')!=account or evidence.get('conversation_id')!=uid or
     evidence.get('reference')!='one-ui-click-result-unknown' or not isinstance(observed,(int,float)) or not math.isfinite(observed)):
  fail('legacy_original_text_proof_required')
 source=con.execute('SELECT * FROM events WHERE account_id=? AND conversation_id=? AND event_id=?',(account,uid,original['source_event_id'])).fetchone()
 if source is None or source['type'] not in ('CUSTOMER_MESSAGE','NEW_VISITOR') or source['timestamp_source']!='platform_ui' or source['timestamp'] is None or source['timestamp']>submitted:
  fail('original_native_source_required')
 source_proof=obj(source['evidence'])
 if source_proof.get('source')!='platform_ui' or source_proof.get('account_id')!=account or source_proof.get('conversation_id')!=uid or source_proof.get('reference')!=source['event_id']:
  fail('original_native_source_required')
 matches=[]
 rows=con.execute("SELECT * FROM events WHERE account_id=? AND conversation_id=? AND type='OUTBOUND_OBSERVED' AND timestamp>=? AND timestamp<=? ORDER BY timestamp,event_id LIMIT 101",(account,uid,submitted,submitted+2.5)).fetchall()
 if len(rows)>100: fail('bounded_existing_outbound_event_required')
 for row in rows:
  proof=obj(row['evidence']);dom=proof.get('reference','');native=proof.get('native_message_id','');raw=None
  for prefix in ('id_'+account+'.'+uid+'.','id_'+uid+'.'+account+'.'):
   if dom.startswith(prefix) and re.fullmatch(r'[A-Za-z0-9_-]{1,256}',dom[len(prefix):]): raw=dom[len(prefix):]
  at=row['timestamp'];detected=row['detected_at']
  if (raw is None or row['event_id']!='observed-outbound:'+dom or native!='jarvis-msg-'+dom[3:] or
      row['timestamp_source']!='platform_ui' or proof.get('source')!='platform_ui' or proof.get('timestamp_source')!='platform_ui' or
      proof.get('account_id')!=account or proof.get('conversation_id')!=uid or proof.get('native_message_type')!='TEXT' or proof.get('native_direction')!='right' or
      proof.get('historical_baseline') is not False or proof.get('untrusted_message_text')!=text or
      not isinstance(at,(int,float)) or not math.isfinite(at) or at!=round(at*1000)/1000 or
      not isinstance(detected,(int,float)) or not math.isfinite(detected) or proof.get('observed_at')!=detected or detected<submitted or detected>observed+1): continue
  matches.append(dict(row=row,proof=proof,raw=raw,native=native,dom=dom,at=round(at*1000)))
 if len(matches)!=1: fail('unique_existing_outbound_event_required')
 match=matches[0]
 for other in con.execute('SELECT evidence FROM outbox WHERE account_id=? AND conversation_id=? AND intent_id!=?',(account,uid,intent_id)):
  proof=obj(other['evidence']);ids=proof.get('native_message_ids',[])
  if proof.get('native_message_id')==match['native'] or proof.get('native_message_raw_id')==match['raw'] or isinstance(ids,list) and match['native'] in ids:
   fail('native_candidate_bound_to_other_intent')
 result=dict(classification='existing_native_outbound_event',existing_outbound_event_verified=True,bound_to_other_intent=False,
   account_id=account,conversation_id=uid,original_intent_id=intent_id,original_source_event_id=original['source_event_id'],original_submitted_at=submitted,
   event_id=match['row']['event_id'],dom_id=match['dom'],native_message_id=match['native'],native_message_raw_id=match['raw'],
   type='OUTBOUND_OBSERVED',source='platform_ui',timestamp_source='platform_ui',native_message_type='TEXT',native_direction='right',historical_baseline=False,
   platform_timestamp_ms=match['at'],detected_at=match['row']['detected_at'],observed_at=match['proof']['observed_at'],text=text)
 print(json.dumps(dict(ok=True,anchor=result),ensure_ascii=False,allow_nan=False))
except ValueError as error:
 print(json.dumps(dict(ok=False,reason=str(error))))
except Exception:
 print(json.dumps(dict(ok=False,reason='readonly_original_anchor_unavailable')))
finally:
 if con is not None: con.close()
`;
  const checked=require('node:child_process').spawnSync(pythonExecutable,['-B','-c',script,path.join(runtime,'reception.sqlite3'),accountId,uid,intentId],
    {stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:2000,maxBuffer:32768,windowsHide:true});
  let result;try{result=JSON.parse(checked.stdout);}catch{}
  if(checked.error || checked.status!==0 || result?.ok!==true || !result.anchor)
    throw new Error('original_text_recovery_durable_anchor_required:'+String(result?.reason || 'readonly_original_anchor_unavailable'));
  return result.anchor;
}

async function currentUnansweredNativeSource(client,accountId,uid,sourceEventId,startedAt) {
  const reply=await client.request('status',{account_id:accountId,conversation_id:uid}),value=reply?.result;
  const con=value?.conversations?.[0],event=value?.latest_event,proof=event?.evidence;
  const prefix=['id_'+accountId+'.'+uid+'.','id_'+uid+'.'+accountId+'.'].find(value=>typeof sourceEventId==='string'&&sourceEventId.startsWith(value));
  if(!reply?.ok || value?.account_scope!==accountId || value.conversations?.length!==1 || !Array.isArray(value.outbox) ||
     [...value.outbox,...value.conversations].some(row=>row.account_id!==accountId || row.conversation_id!==uid) ||
     con.needs_response!==1 || con.latest_event_id!==sourceEventId || !prefix || !/^[A-Za-z0-9_-]{1,256}$/.test(sourceEventId.slice(prefix.length)) ||
     event?.account_id!==accountId || event?.conversation_id!==uid || event?.event_id!==sourceEventId || event?.type!=='CUSTOMER_MESSAGE' ||
     event.timestamp_source!=='platform_ui' || !Number.isFinite(event.timestamp) || !Number.isFinite(event.detected_at) ||
     event.timestamp!==con.latest_event_at || event.timestamp>event.detected_at+1 || event.detected_at>Date.now()/1000+1 ||
     !Number.isFinite(startedAt) || event.timestamp*1000<=startedAt ||
     proof?.source!=='platform_ui' || proof.timestamp_source!=='platform_ui' || proof.account_id!==accountId || proof.conversation_id!==uid ||
     proof.reference!==sourceEventId || proof.native_message_id!=='jarvis-msg-'+sourceEventId.slice(3) ||
     proof.native_message_type!=='TEXT' || proof.native_direction!=='left' || proof.historical_baseline!==false || proof.observed_at!==event.detected_at)
    throw new Error('current_unanswered_native_source_required');
  if(value.outbox.some(row=>row.source_event_id===sourceEventId && ['service_reply','correction_reply'].includes(row.kind) &&
    (Number.isFinite(row.submitted_at) || ['SUBMITTING','UNKNOWN','SENT'].includes(row.status))))throw new Error('source_reply_already_submitted');
  return value;
}

async function startReception(page,context,runtime,resumeCursor,futureEntriesOnly) {
  return require('./ui_controller.cjs').start({page,runtime,
    ...(resumeCursor!==undefined?{resumeCursor}:{}),
    ...(futureEntriesOnly!==undefined?{futureEntriesOnly}:{}),
    selectAndRead:async(_,candidate,ctx)=>{
      if(!ctx.isCurrent()) throw new Error('worker_cancelled');
      await run({page,context,runtime,workerContext:ctx,cmd:{operation:'select_conversation',uid:candidate.uid}});
      const scope=await currentScope(page,runtime,{restoreProfile:false});
      if(ctx.reason==='unanswered_recheck'){
        const account=JSON.parse(fs.readFileSync(path.join(runtime,'account_identity.json'),'utf8')).account_id;
        const client=require('./ui_engine.cjs').getClient(runtime);
        await currentUnansweredNativeSource(client,account,candidate.uid,ctx.sourceEventId,ctx.startedAt);
        if(!ctx.isCurrent())throw new Error('reception_round_cancelled');
        const source=scope.messages?.filter(message=>message.dom_id===ctx.sourceEventId &&
          message.native_dom_id==='jarvis-msg-'+ctx.sourceEventId.slice(3) && message.direction==='left'&&message.raw_type==='TEXT');
        if(!scope.scope_ready || scope.account_id!==account || scope.conversation_id!==candidate.uid || source?.length!==1)
          throw new Error('current_unanswered_native_source_required');
      }
      return scope;
    },
    receive:args=>run({page,context,runtime,workerContext:args,cmd:{operation:'reception_once',uid:args.uid,text:args.text}}),
    takeoverOnly:args=>require('./ui_sender.cjs').takeOverOnly({page,runtime,uid:args.uid,
      currentScope:()=>currentScope(page,runtime,{restoreProfile:false}),isCurrent:args.isCurrent}),
  });
}

async function run({page,context,cmd,runtime,workerContext,operatorAuthorization}) {
  const controller=require('./ui_controller.cjs');
  if(state.runtimeReloads.has(page) && !workerContext && !['reload_reception_runtime','reception_worker_status','persist_existing_card_proof','stop_reception_worker','reconcile_original_operation','release_human_to_automation'].includes(cmd.operation)) throw new Error('pending_runtime_reload_requires_resume');
  if(controller.status(page).running && !workerContext &&
     !['reception_worker_status','stop_reception_worker','persist_existing_card_proof','reload_sender','reload_reception_runtime','read_native_eligibility','attach_native_eligibility','reconsider_due_followup','compare_existing_native_cards','upgrade_and_reconcile_original_card','take_over_held_conversation','reconcile_original_operation','release_human_to_automation','recheck_current_customer'].includes(cmd.operation)) throw new Error('worker_owns_browser_stop_before_manual_operation');
  if(cmd.operation === 'recheck_current_customer') {
    const current=controller.status(page),uid=cmd.uid,source=cmd.source_event_id;
    if(!current.running || current.worker?.busy || !/^[a-f0-9]{24}$/.test(uid || ''))throw new Error('idle_running_customer_recheck_required');
    const account=JSON.parse(fs.readFileSync(path.join(runtime,'account_identity.json'),'utf8')).account_id;
    const slot=globalThis[Symbol.for('xhs_reception.ui_engine_client')];
    if(!slot || slot.runtime!==path.resolve(runtime) || slot.accountId!==account || slot.client.diagnostics().pending_requests!==0)
      throw new Error('idle_bound_engine_required');
    await currentUnansweredNativeSource(slot.client,account,uid,source,current.worker.startedAt);
    const remembered=state.humanReleaseRechecks.get(page)?.get(uid);
    const revision=remembered?.accountId===account&&remembered.sourceEventId===source?remembered:null;
    if(revision?.consumed)throw new Error('human_release_recheck_already_used');
    const result=require('./ui_worker.cjs').reconsiderUnanswered(page,{uid,source_event_id:source,
      ...(revision?{recheck_authorization_id:revision.eventId}:{})});
    if(revision)revision.consumed=true;
    return result;
  }
  if(cmd.operation === 'release_human_to_automation') {
    const uid=cmd.uid,reference=cmd.authorization_reference;
    const account=JSON.parse(fs.readFileSync(path.join(runtime,'account_identity.json'),'utf8')).account_id;
    // Only the trusted local executor can provide this top-level context. The
    // browser-session command JSON and all customer text cannot manufacture it.
    if(!/^[a-f0-9]{24}$/.test(uid || '') || typeof reference!=='string' || !reference.trim() || reference.length>1024 ||
       operatorAuthorization?.source!=='direct_human_instruction' || operatorAuthorization.explicit_release!==true ||
       operatorAuthorization.reference!==reference || operatorAuthorization.account_id!==account || operatorAuthorization.conversation_id!==uid)
      throw new Error('trusted_human_release_authorization_required');
    let transaction=state.runtimeReloads.get(page);
    const resume=async()=>{
      if(transaction.cancelled)throw new Error('human_release_lease_cancelled');
      if(transaction.phase==='resuming')throw new Error('runtime_resume_failed_preserved_hold');
      await restoreNativeIntakeView(page,{isCurrent:()=>state.runtimeReloads.get(page)===transaction&&!transaction.cancelled});
      transaction.phase='resuming';const result=await startReception(page,context,runtime,transaction.cursor);
      if(!result.running || result.worker?.startedAt!==transaction.startedAt)throw new Error('human_release_cursor_resume_unconfirmed');
      state.runtimeReloads.delete(page);
      return {...transaction.result,receiver_resumed:true,original_started_at:result.worker.startedAt,
        direct_send_performed:false,receiver_may_process_pending_entries:true};
    };
    if(transaction){
      if(transaction.kind!=='human_release' || transaction.runtime!==path.resolve(runtime) || transaction.uid!==uid ||
         transaction.accountId!==account || transaction.reference!==reference)throw new Error('human_release_lease_binding_mismatch');
      if(transaction.phase!=='restoring_intake')throw new Error('human_release_lease_not_resumable');
      const result=await resume();if(transaction.failure)throw transaction.failure;return result;
    }
    const before=controller.status(page),slot=globalThis[Symbol.for('xhs_reception.ui_engine_client')];
    if(!before.running || before.worker?.busy)throw new Error('idle_human_release_lease_required');
    if(!slot || slot.runtime!==path.resolve(runtime) || slot.accountId!==account || slot.client.diagnostics().pending_requests!==0)
      throw new Error('idle_bound_engine_required');
    const read=async()=>{
      const reply=await slot.client.request('status',{account_id:account,conversation_id:uid}),value=reply?.result;
      if(!reply?.ok || value?.account_scope!==account || value.conversations?.length!==1 || !Array.isArray(value.outbox) ||
         [...value.conversations,...value.outbox].some(row=>row.account_id!==account || row.conversation_id!==uid))
        throw new Error('human_release_engine_scope_required');
      return value;
    };
    const initial=await read(),initialCon={...initial.conversations[0]},originalOutbox=JSON.stringify(initial.outbox);
    const cursor=require('./ui_worker.cjs').captureCursor(page);controller.stop(page);
    transaction={kind:'human_release',runtime:path.resolve(runtime),accountId:account,uid,reference,cursor,
      startedAt:before.worker.startedAt,phase:'releasing',cancelled:false};state.runtimeReloads.set(page,transaction);
    const lease={isCurrent:()=>state.runtimeReloads.get(page)===transaction&&!transaction.cancelled};
    let result;
    try{
      await ensureNativeAllConversations(page,{isCurrent:lease.isCurrent});
      await run({page,context,runtime,workerContext:lease,cmd:{operation:'select_conversation',uid}});
      const draft=page.locator('.reply-box-wrap textarea.reply-textarea').filter({visible:true});
      if(await draft.count()!==1 || await draft.inputValue()!=='')throw new Error('human_release_nonempty_or_ambiguous_draft');
      if(!lease.isCurrent())throw new Error('human_release_lease_cancelled');
      const native=await require('./ui_sender.cjs').takeOverOnly({page,runtime,uid,isCurrent:lease.isCurrent,
        currentScope:()=>currentScope(page,runtime,{restoreProfile:false})});
      const scope=await currentScope(page,runtime,{restoreProfile:false});
      const mode=native?.after_mode,scopeAge=Date.now()-Date.parse(scope.observed_at_utc);
      if(!lease.isCurrent())throw new Error('human_release_lease_cancelled');
      if(!scope.scope_ready || !scope.account_scope_verified || !scope.conversation_scope_verified || scope.account_id!==account || scope.conversation_id!==uid ||
         scope.profile_binding_source!=='current_native_profile' || !Number.isFinite(scopeAge) || scopeAge<0 || scopeAge>=1000 ||
         native?.state!=='native_manual_mode_confirmed' || native.taken_over!==true || native.account_id!==account || native.conversation_id!==uid ||
         native.customer_send_performed!==false || mode?.manual!==true || mode.input_ready!==true || mode.scope_ready!==true ||
         mode.manual_switch_enabled!==true || mode.overlay_visible!==false || mode.takeover_visible!==false)
        throw new Error('native_manual_mode_not_confirmed');
      if(await draft.count()!==1 || await draft.inputValue()!=='')throw new Error('human_release_nonempty_or_ambiguous_draft');
      if(!lease.isCurrent())throw new Error('human_release_lease_cancelled');
      const observed=Date.now()/1000,eventId='human-release:'+uid+':'+Date.now();
      const reply=await slot.client.request('ingest',{event:{account_id:account,conversation_id:uid,
        event_id:eventId,type:'HUMAN_RELEASE',detected_at:observed,
        evidence:{source:'platform_ui',account_id:account,conversation_id:uid,observed_at:observed,
          reference:'.message-header triggerKey=人工转AI + empty editable textarea + exact native profile UID',
          explicit_release:true,authorization_source:'direct_human_instruction',authorization_reference:reference,native_manual_mode:mode}}});
      if(!reply?.ok || reply.result?.conversation?.account_id!==account || reply.result.conversation.conversation_id!==uid)
        throw new Error('human_release_persistence_unconfirmed');
      const after=await read(),afterCon=after.conversations[0];
      const expectedState=initialCon.state==='HUMAN'?(initialCon.resume_state || 'ACTIVE'):initialCon.state;
      if(JSON.stringify(after.outbox)!==originalOutbox || afterCon.state!==expectedState ||
         initialCon.state==='STOPPED'&&afterCon.stop_reason!==initialCon.stop_reason)throw new Error('human_release_must_preserve_terminal_and_outbox');
      if(afterCon.needs_response===1&&typeof afterCon.latest_event_id==='string'){
        let revisions=state.humanReleaseRechecks.get(page);
        if(!revisions){revisions=new Map();state.humanReleaseRechecks.set(page,revisions);}
        revisions.set(uid,{accountId:account,sourceEventId:afterCon.latest_event_id,eventId,consumed:false});
      }
      transaction.result={human_release_recorded:true,human_release_event_id:eventId,conversation_state:afterCon.state,authorization_reference:reference,
        native_manual_mode_confirmed:true,customer_send_performed:false};
    }catch(error){transaction.failure=error;}
    finally{
      if(transaction.cancelled)throw new Error('human_release_lease_cancelled');
      transaction.phase='restoring_intake';result=await resume();
    }
    if(transaction.failure)throw transaction.failure;return result;
  }
  if(cmd.operation === 'reconcile_original_operation') {
    const uid=cmd.uid,intentId=cmd.intent_id,recover=cmd.recover_missing_text_id===true,rawId=cmd.native_message_raw_id??null;
    if(!/^[a-f0-9]{24}$/.test(uid || '') || typeof intentId!=='string' || !intentId ||
       (recover?rawId!==null:!/^[A-Za-z0-9_-]{1,256}$/.test(rawId || '')))throw new Error('original_reconciliation_binding_required');
    let transaction=state.runtimeReloads.get(page);
    const resume=async()=>{
      if(transaction.cancelled)throw new Error('original_reconciliation_lease_cancelled');
      if(transaction.phase==='resuming')throw new Error('runtime_resume_failed_preserved_hold');
      await restoreNativeIntakeView(page,{isCurrent:()=>state.runtimeReloads.get(page)===transaction&&!transaction.cancelled});
      transaction.phase='resuming';
      const result=await startReception(page,context,runtime,transaction.cursor);
      if(!result.running || result.worker?.startedAt!==transaction.startedAt)throw new Error('reconciliation_cursor_resume_unconfirmed');
      state.runtimeReloads.delete(page);
      return {original_operation:transaction.result,receiver_resumed:true,original_started_at:result.worker.startedAt,
        direct_send_performed:false,receiver_may_process_pending_entries:true};
    };
    if(transaction){
      if(transaction.kind!=='original_reconciliation' || transaction.runtime!==path.resolve(runtime) ||
         transaction.uid!==uid || transaction.intentId!==intentId || transaction.rawId!==rawId || Boolean(transaction.recover)!==recover)
        throw new Error('original_reconciliation_lease_binding_mismatch');
      if(transaction.phase!=='restoring_intake')throw new Error('original_reconciliation_lease_not_resumable');
      // A failed intake restoration retries only restoration/resume. It must
      // never repeat the reconciliation or manufacture a new worker baseline.
      const result=await resume();if(transaction.failure)throw transaction.failure;return result;
    }
    const before=controller.status(page);
    if(!before.running || before.worker?.busy)throw new Error('idle_reconciliation_lease_required');
    const account=JSON.parse(fs.readFileSync(path.join(runtime,'account_identity.json'),'utf8')).account_id;
    const slot=globalThis[Symbol.for('xhs_reception.ui_engine_client')];
    if(!/^[a-f0-9]{24}$/.test(account || '') || !slot || slot.runtime!==path.resolve(runtime) ||
       slot.accountId!==account || slot.client.diagnostics().pending_requests!==0)throw new Error('idle_bound_engine_required');
    const reply=await slot.client.request('status',{conversation_id:uid}),status=reply?.result;
    const unknown=Array.isArray(status?.outbox)?status.outbox.filter(row=>row.status==='UNKNOWN'&&row.intent_id===intentId):[];
    if(!reply?.ok || status?.account_scope!==account || status.conversations?.length!==1 ||
       status.conversations[0].account_id!==account || status.conversations[0].conversation_id!==uid ||
       !Array.isArray(status.outbox) || status.outbox.some(row=>row.account_id!==account || row.conversation_id!==uid || ['PREPARED','CLAIMED','SUBMITTING'].includes(row.status)) ||
       unknown?.length!==1 || unknown[0].intent_id!==intentId || !Number.isFinite(unknown[0].submitted_at) ||
       !['text','native_card'].includes(unknown[0].payload?.operation) || (unknown[0].evidence?.native_message_raw_id??null)!==rawId)
      throw new Error('original_reconciliation_intent_mismatch');
    const otherOutbox=JSON.stringify(status.outbox.filter(row=>row.intent_id!==intentId));
    const nativeId=unknown[0].evidence?.native_message_id??null;
    let recoveryAnchor=null;
    if(recover){
      if(unknown[0].payload.operation!=='text' || nativeId!==null)throw new Error('original_text_recovery_legacy_missing_ids_required');
      recoveryAnchor=legacyOriginalTextAnchor(runtime,{accountId:account,uid,intentId,pythonExecutable:slot.pythonExecutable || '/usr/bin/python3'});
      if(recoveryAnchor.original_submitted_at!==unknown[0].submitted_at || recoveryAnchor.text!==unknown[0].payload.text ||
         recoveryAnchor.original_source_event_id!==unknown[0].source_event_id)throw new Error('original_text_recovery_intent_mismatch');
    }else if(!['jarvis-msg-'+account+'.'+uid+'.'+rawId,'jarvis-msg-'+uid+'.'+account+'.'+rawId].includes(nativeId))
      throw new Error('original_reconciliation_native_id_mismatch');
    // Capture and stop are synchronous; an intervening worker dispatch cannot
    // borrow the browser or consume the preserved opaque intake cursor.
    const cursor=require('./ui_worker.cjs').captureCursor(page);controller.stop(page);
    transaction={kind:'original_reconciliation',runtime:path.resolve(runtime),cursor,startedAt:before.worker.startedAt,
      accountId:account,uid,intentId,rawId,nativeId,recover,verificationStartedAtMs:Date.now(),phase:'reconciling',cancelled:false};
    state.runtimeReloads.set(page,transaction);
    const lease={isCurrent:()=>state.runtimeReloads.get(page)===transaction&&!transaction.cancelled,
      originalReconciliation:{intentId,rawId,nativeId,verificationStartedAtMs:transaction.verificationStartedAtMs,allowOriginalTextIdRecovery:recover,originalTextRecoveryAnchor:recoveryAnchor}};
    let result;
    try{
      await ensureNativeAllConversations(page,{isCurrent:lease.isCurrent});
      await run({page,context,runtime,workerContext:lease,cmd:{operation:'select_conversation',uid}});
      if(!lease.isCurrent())throw new Error('original_reconciliation_lease_cancelled');
      transaction.result=await run({page,context,runtime,workerContext:lease,
        cmd:{operation:'reconcile_and_complete',uid,reconcile_only:true}});
      const after=await slot.client.request('status',{conversation_id:uid});
      if(!after?.ok || after.result?.account_scope!==account || !Array.isArray(after.result.outbox) ||
         JSON.stringify(after.result.outbox.filter(row=>row.intent_id!==intentId))!==otherOutbox)throw new Error('reconciliation_other_outbox_changed');
    }catch(error){transaction.failure=error;}
    finally{
      if(transaction.cancelled)throw new Error('original_reconciliation_lease_cancelled');
      transaction.phase='restoring_intake';result=await resume();
    }
    if(transaction.failure)throw transaction.failure;
    return result;
  }
  if(cmd.operation === 'take_over_held_conversation') {
    const before=controller.status(page);
    if(!before.running || before.worker?.busy || !/^[a-f0-9]{24}$/.test(cmd.uid || '') ||
       typeof cmd.intent_id!=='string') throw new Error('idle_takeover_lease_required');
    const expectedAccount=JSON.parse(fs.readFileSync(path.join(runtime,'account_identity.json'),'utf8')).account_id;
    if(!/^[a-f0-9]{24}$/.test(expectedAccount || '')) throw new Error('native_account_binding_required');
    const client=require('./ui_engine.cjs').getClient(runtime);
    const read=async()=>{
      const reply=await client.request('status',{conversation_id:cmd.uid});
      const value=reply?.result,con=value?.conversations?.[0];
      if(!reply?.ok || value?.account_scope!==expectedAccount || value.conversations?.length!==1 || !Array.isArray(value.outbox) ||
         con.account_id!==value.account_scope || con.conversation_id!==cmd.uid || con.state!=='ACTIVE' ||
         value.outbox.some(row=>row.account_id!==value.account_scope || row.conversation_id!==cmd.uid)) {
        throw new Error('held_takeover_scope_unavailable');
      }
      const original=value.outbox.find(row=>row.intent_id===cmd.intent_id);
      if(!original || original.status!=='UNKNOWN') throw new Error('original_unknown_hold_required');
      return {value,original};
    };
    const initial=await read();
    const cursor=require('./ui_worker.cjs').captureCursor(page);
    controller.stop(page);
    const transaction={runtime:path.resolve(runtime),cursor,startedAt:before.worker.startedAt,
      accountId:initial.value.account_scope,phase:'resuming',kind:'held_takeover',cancelled:false};
    state.runtimeReloads.set(page,transaction);
    let result,resumed;
    const lease={isCurrent:()=>state.runtimeReloads.get(page)===transaction&&!transaction.cancelled};
    try {
      await run({page,context,runtime,workerContext:lease,cmd:{operation:'select_conversation',uid:cmd.uid}});
      if(!lease.isCurrent()) throw new Error('takeover_lease_cancelled');
      result=await require('./ui_sender.cjs').takeOverOnly({page,runtime,uid:cmd.uid,
        currentScope:()=>currentScope(page,runtime,{restoreProfile:false}),isCurrent:lease.isCurrent});
      const after=await read();
      if(JSON.stringify(after.value.outbox)!==JSON.stringify(initial.value.outbox)) throw new Error('takeover_must_preserve_original_outbox');
      atomicJSON(path.join(runtime,'held-conversation-takeover.json'),{
        observed_at_utc:new Date().toISOString(),account_id:initial.value.account_scope,conversation_id:cmd.uid,
        original_intent_id:cmd.intent_id,original_status:after.original.status,
        manual_takeover:result,customer_send_performed:false,five_second_acceptance:false,
      });
    } finally {
      if(transaction.cancelled) throw new Error('takeover_lease_cancelled');
      await restoreNativeIntakeView(page);
      resumed=await startReception(page,context,runtime,cursor);
      if(!resumed.running || resumed.worker?.startedAt!==before.worker.startedAt) throw new Error('takeover_cursor_resume_unconfirmed');
      state.runtimeReloads.delete(page);
    }
    return {takeover:result,receiver_resumed:true,original_started_at:resumed.worker.startedAt,
      original_unknown_preserved:true,customer_send_performed:false,full_five_second_acceptance:false};
  }
  if(cmd.operation === 'upgrade_and_reconcile_original_card') {
    const before=controller.status(page);
    if(!before.running || before.worker?.busy || !/^[a-f0-9]{24}$/.test(cmd.uid || '')) throw new Error('idle_reconciliation_lease_required');
    const client=require('./ui_engine.cjs').getClient(runtime);
    const reply=await client.request('status',{conversation_id:cmd.uid});
    if(!reply?.ok || !Array.isArray(reply.result?.outbox)) throw new Error('reconciliation_status_unavailable');
    const unknown=reply.result.outbox.filter(row=>row.status==='UNKNOWN');
    const reference=reply.result.outbox.find(row=>row.intent_id===cmd.reference_intent_id);
    if(unknown.length!==1 || unknown[0].payload?.operation!=='native_card' ||
       !Number.isFinite(unknown[0].submitted_at) || !reference || reference.status!=='SENT' ||
       reference.payload?.operation!=='native_card' || reference.evidence?.native_wecom_card_confirmed!==true ||
       reference.account_id!==reply.result.account_scope || reference.conversation_id!==cmd.uid ||
       !Number.isFinite(reference.confirmed_at) || reference.confirmed_at>=unknown[0].submitted_at ||
       !Number.isFinite(reference.evidence?.native_server_history?.native_created_at_ms) ||
       reference.evidence.native_server_history.native_created_at_ms>=unknown[0].submitted_at*1000 ||
       reference.evidence?.native_server_history?.status!=='server_history_confirmed') throw new Error('independent_prior_card_reference_required');
    const raw=reference.evidence?.native_message_raw_id;
    const targetRaw=unknown[0].evidence?.native_message_raw_id;
    const nativeIds=[reference.account_id+'.'+cmd.uid+'.'+raw,cmd.uid+'.'+reference.account_id+'.'+raw];
    if(typeof raw!=='string' || !/^[A-Za-z0-9_-]{1,256}$/.test(raw) ||
       raw===targetRaw || reference.evidence.native_message_id===unknown[0].evidence?.native_message_id ||
       !nativeIds.some(id=>reference.evidence.native_message_id==='jarvis-msg-'+id &&
         reference.evidence.native_server_history.native_message_id===id)) throw new Error('independent_reference_native_id_required');
    const cursor=require('./ui_worker.cjs').captureCursor(page);
    controller.stop(page);
    state.runtimeReloads.set(page,{runtime:path.resolve(runtime),cursor,startedAt:before.worker.startedAt,
      accountId:reference.account_id,phase:'resuming'});
    const lease={isCurrent:()=>true};
    let result,resumed;
    try {
      delete require.cache[require.resolve('./native_history_receipt.cjs')];
      const native=require('./native_history_receipt.cjs').attach(page);
      if(native.version!==7) throw new Error('audited_native_verifier_v7_required');
      delete require.cache[require.resolve('./ui_sender.cjs')];
      const scope=await currentScope(page,runtime,{restoreProfile:false});
      const messages=scope.messages?.filter(message=>message.message_id===raw && message.raw_type==='CARD' &&
        Number(message.raw_timestamp)===reference.evidence.native_server_history.native_created_at_ms);
      if(!scope.scope_ready || scope.account_id!==reference.account_id || scope.conversation_id!==cmd.uid ||
         messages?.length!==1) throw new Error('independent_prior_card_not_in_current_native_scope');
      require('./ui_sender.cjs').primeCardIdentity(page,{...scope,messages});
      result=await run({page,context,runtime,workerContext:lease,
        cmd:{operation:'reconcile_and_complete',uid:cmd.uid,reconcile_only:true}});
    } finally {
      await restoreNativeIntakeView(page);
      resumed=await startReception(page,context,runtime,cursor);
      if(!resumed.running || resumed.worker?.startedAt!==before.worker.startedAt) throw new Error('reconciliation_cursor_resume_unconfirmed');
      state.runtimeReloads.delete(page);
    }
    return {original_operation:result,receiver_resumed:true,original_started_at:resumed.worker.startedAt,
      direct_send_performed:false,receiver_may_process_pending_entries:true};
  }
  if(cmd.operation === 'compare_existing_native_cards') {
    const accountId=JSON.parse(fs.readFileSync(path.join(runtime,'account_identity.json'),'utf8')).account_id;
    const params={accountId,sourceConversationId:cmd.source_uid,sourceMessageId:cmd.source_message_id,
      targetConversationId:cmd.target_uid,targetMessageId:cmd.target_message_id};
    const native=require('./native_history_receipt.cjs').attach(page);
    const differences=native.cardDifferences(params),routes=native.cardRouteDifferences(params);
    if(cmd.persist_private===true && differences.status==='compared') {
      const rows=[];
      for(const [uid,raw] of [[params.sourceConversationId,params.sourceMessageId],[params.targetConversationId,params.targetMessageId]]) {
        const ids=[accountId+'.'+uid+'.'+raw,uid+'.'+accountId+'.'+raw];
        const matches=native.records().filter(r=>r.http_status===200&&r.data?.success===true&&r.data?.code===0&&
          r.query?.filter(q=>q.key==='customer_user_id'&&q.value===uid).length===1)
          .flatMap(r=>(r.data?.data?.messages||[]).filter(m=>ids.includes(m.sixin_message?.id)).map(m=>({
            request_started_at:r.at,finished_at:r.finished_at,reference:'https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg#'+m.sixin_message.id,
            sixin_message:m.sixin_message,message_extension:m.message_extension})));
        if(!matches.length) throw new Error('existing_native_card_record_unavailable');
        rows.push(matches.at(-1));
      }
      atomicJSON(path.join(runtime,'card-followup-proof-2026-10-23.json'),{classification:'private_original_native_card_comparison',
        captured_at_utc:new Date().toISOString(),customer_send_performed:false,rows});
    }
    return {differences,routes,customer_send_performed:false};
  }
  if(cmd.operation === 'persist_existing_card_proof') {
    const expected='66879fef000000001c002839.678b1d02000000000a03f368.1eadad6ac55c59a';
    const submitted='66879fef000000001c002839.678b1d02000000000a03f368.1eadae10628d14e';
    const records=require('./native_history_receipt.cjs').attach(page).records();
    const rows=[];
    for(const id of [expected,submitted]){
      const matches=records.filter(r=>r.http_status===200&&r.data?.success===true&&r.data?.code===0&&
        r.query?.filter(q=>q.key==='customer_user_id'&&q.value==='678b1d02000000000a03f368').length===1)
        .flatMap(r=>(r.data?.data?.messages||[]).filter(m=>m.sixin_message?.id===id).map(m=>({
          request_started_at:r.at,finished_at:r.finished_at,reference:'https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg#'+id,
          sixin_message:m.sixin_message,message_extension:m.message_extension})));
      if(!matches.length) throw new Error('exact_existing_card_record_not_retained');
      rows.push(matches.at(-1));
    }
    const file=path.join(runtime,'card-proof-2026-10-23.json');
    atomicJSON(file,{classification:'private_original_native_card_history_for_independent_audit',expected_source:expected,
      original_single_submission:submitted,customer_send_performed:false,captured_at_utc:new Date().toISOString(),rows});
    return {private_proof_path:file,records:rows.length,customer_send_performed:false};
  }
  if(cmd.operation === 'reception_worker_status') return controller.status(page);
  if(cmd.operation === 'reconsider_due_followup') {
    const current=controller.status(page);
    if(current.historical_followups_enabled===false) throw new Error('historical_followups_disabled');
    if(!current.running || current.worker?.busy || !/^[a-f0-9]{24}$/.test(cmd.uid || '')) throw new Error('idle_running_customer_recheck_required');
    const engine=require('./ui_engine.cjs').getClient(runtime);
    const value=await engine.request('status',{conversation_id:cmd.uid});
    const con=value?.result?.conversations?.[0];
    if(!value?.ok || value.result.conversations.length!==1 || con.account_id!==value.result.account_scope ||
       con.conversation_id!==cmd.uid || con.state!=='ACTIVE' || con.needs_response!==0 ||
       !Number.isFinite(con.next_followup_at) || con.next_followup_at>Date.now()/1000 ||
       !Number.isFinite(con.last_sent_at) || Date.now()/1000-con.last_sent_at<1800 ||
       value.result.outbox.some(row=>['PREPARED','CLAIMED','SUBMITTING','UNKNOWN'].includes(row.status))) throw new Error('current_followup_not_eligible_for_recheck');
    return require('./ui_worker.cjs').reconsiderDue(page,{uid:cmd.uid,source_event_id:con.latest_event_id,last_sent_at:con.last_sent_at});
  }
  if(cmd.operation === 'stop_reception_worker') {
    const pending=state.runtimeReloads.get(page);
    if(pending) {
      pending.phase='resuming'; // An explicit stop invalidates continuation; never rebaseline silently.
      if(['held_takeover','original_reconciliation','human_release'].includes(pending.kind)) pending.cancelled=true;
    }
    return controller.stop(page);
  }
  if(cmd.operation === 'reload_reception_runtime') {
    let pending=state.runtimeReloads.get(page);
    if(pending?.kind==='human_release')throw new Error('human_release_requires_bound_resume');
    if(pending?.kind==='original_reconciliation')throw new Error('original_reconciliation_requires_bound_resume');
    if(pending && pending.runtime!==path.resolve(runtime)) throw new Error('reload_runtime_binding_mismatch');
    if(!pending) {
      const before=controller.status(page);
      if(!before.running || before.worker?.busy) throw new Error('idle_running_controller_required');
      const slot=globalThis[Symbol.for('xhs_reception.ui_engine_client')];
      if(!slot || slot.runtime!==path.resolve(runtime) || slot.client.diagnostics().pending_requests!==0) throw new Error('idle_bound_engine_required');
      const status=await slot.client.request('status',{});
      if(!status?.ok || status.result?.account_scope!==slot.accountId || !Array.isArray(status.result?.outbox)) throw new Error('engine_reload_preflight_failed');
      // No callback can begin between synchronous capture and stop.
      delete require.cache[require.resolve('./ui_worker.cjs')];
      const cursor=require('./ui_worker.cjs').captureCursor(page);
      controller.stop(page);
      pending={runtime:path.resolve(runtime),cursor,startedAt:before.worker.startedAt,
        accountId:slot.accountId,oldClient:slot.client,phase:'stopped'};
      state.runtimeReloads.set(page,pending);
    }
    if(pending.phase==='resuming') throw new Error('runtime_resume_failed_preserved_hold');
    if(pending.phase==='stopped') {
      const closed=await pending.oldClient.close({timeoutMs:1000});
      if(!closed?.closed) throw new Error('old_engine_close_unconfirmed');
      delete globalThis[Symbol.for('xhs_reception.ui_engine_client')];
      for(const file of ['./engine_client.cjs','./ui_engine.cjs','./ui_controller.cjs','./ui_sidebar.cjs','./ui_sender.cjs','./native_send_ack.cjs','./ui_scope.cjs','./native_terminal_observer.cjs']) {
        delete require.cache[require.resolve(file)];
      }
      state.scopeProofs=new WeakMap();
      pending.phase='restarting_engine';
    }
    const engine=require('./ui_engine.cjs').getClient(runtime);
    const check=await engine.request('status',{});
    if(!check?.ok || check.result?.account_scope!==pending.accountId) throw new Error('new_engine_preflight_failed');
    // Keep the opaque cursor retryable until the native intake view is proved.
    // A click returning during hydration is not proof of an active All view.
    await restoreNativeIntakeView(page,{isCurrent:()=>state.runtimeReloads.get(page)===pending&&pending.phase!=='resuming'});
    pending.phase='resuming';
    const result=await startReception(page,context,runtime,pending.cursor);
    if(!result.running || result.worker?.startedAt!==pending.startedAt) throw new Error('worker_cursor_resume_unconfirmed');
    state.runtimeReloads.delete(page);
    return {runtime_reloaded:true,login_session_preserved:true,original_started_at:pending.startedAt,
      engine:engine.diagnostics(),reception:result,direct_send_performed:false,receiver_may_process_pending_entries:true};
  }
  if(cmd.operation === 'bootstrap_reception') {
    const config=JSON.parse(fs.readFileSync(path.join(runtime,'..','reception.json'),'utf8'));
    if(config.live_dispatch_enabled!==true) throw new Error('live_dispatch_disabled');
    const identity=await run({page,context,runtime,cmd:{operation:'read_account_identity'}});
    if(identity.account_id!==config.account_id) throw new Error('native_account_differs_from_config');
    const connection=JSON.parse(fs.readFileSync(path.join(runtime,'connection.json'),'utf8'));
    const reference=connection.native_card_reference;
    if(!reference||!/^[a-f0-9]{24}$/.test(reference.conversation_uid||'')||
      !/^[A-Za-z0-9_-]+$/.test(reference.message_id||'')||!Number.isSafeInteger(reference.platform_timestamp_ms)) throw new Error('audited_native_card_reference_required');
    require('./native_history_receipt.cjs').attach(page);
    await run({page,context,runtime,cmd:{operation:'open_all_conversations'}});
    await run({page,context,runtime,cmd:{operation:'select_conversation',uid:reference.conversation_uid}});
    const scope=await currentScope(page,runtime);
    const messages=scope.messages.filter(m=>m.message_id===reference.message_id&&m.raw_type==='CARD'&&
      Number(m.raw_timestamp)===reference.platform_timestamp_ms);
    if(messages.length!==1) throw new Error('audited_card_reference_not_visible');
    require('./ui_sender.cjs').primeCardIdentity(page,{...scope,messages});
    return run({page,context,runtime,cmd:{operation:'start_reception_worker',future_entries_only:cmd.future_entries_only}});
  }
  if(cmd.operation === 'reload_idle_controller') {
    if(controller.status(page).running) throw new Error('stop_worker_before_reload');
    delete require.cache[require.resolve('./ui_controller.cjs')];
    delete require.cache[require.resolve('./ui_engine.cjs')];
    return {idle_controller_reloaded:true,customer_send_performed:false};
  }
  if(cmd.operation === 'attach_card_catalog') return require('./native_card_catalog.cjs').attach(page).snapshot();
  if(cmd.operation === 'read_card_catalog') return require('./native_card_catalog.cjs').attach(page).snapshot();
  if(cmd.operation === 'card_catalog_candidates') return require('./native_card_catalog.cjs').attach(page).candidates();
  if(cmd.operation === 'compare_current_native_card_config') {
    const catalog=require('./native_card_catalog.cjs').attach(page).records().filter(r=>r.path==='/api-sxt/edith/chatline/business_card/list'&&r.http_status===200&&r.data?.success===true&&r.data?.code===0).at(-1);
    const selected=catalog?.data?.data?.list?.filter(c=>c.title==='企微_运去哪海外仓（企微）'&&c.name==='运去哪海外仓（企微）');
    if(selected?.length!==1) throw new Error('unique_current_native_catalog_item_required');
    const expected=selected[0];
    const history=require('./native_history_receipt.cjs').attach(page).records();
    const row=history.flatMap(r=>r.data?.data?.messages||[]).find(r=>r.sixin_message?.id==='66879fef000000001c002839.678b1d02000000000a03f368.1eadae10628d14e');
    if(!row) throw new Error('original_card_history_record_required');
    const actual=JSON.parse(row.sixin_message.content);
    const fields=['id','title','name','cardType','inviteInfo','consultationInfo','corpName','image'];
    return {fields:fields.map(field=>({field,matches:field==='id'?String(expected[field])===actual[field]:expected[field]===actual[field],expected_type:typeof expected[field],actual_type:typeof actual[field]})),
      visible_text_fields:['title','inviteInfo','consultationInfo','corpName'].map(field=>({field,
        catalog_empty:expected[field]==='',history_empty:actual[field]==='',
        catalog_visible_text:typeof expected[field]==='string'&&expected[field].length<=120&&/^[\u3400-\u9fff\s@（）()，。！？、\-]+$/.test(expected[field])?expected[field]:null,
        history_visible_text:typeof actual[field]==='string'&&actual[field].length<=120&&/^[\u3400-\u9fff\s@（）()，。！？、\-]+$/.test(actual[field])?actual[field]:null})),
      contactList:(actual.contactList||[]).map(c=>Object.keys(c).map(field=>({field,match_to_catalog:Object.hasOwn(expected,field)?expected[field]===c[field]:null,type:typeof c[field]}))),
      csa_matches_verified_staff:actual.csaAccountNo===JSON.parse(fs.readFileSync(path.join(runtime,'account_identity.json'),'utf8')).staff_number,
      confirms_send:false};
  }
  if(cmd.operation === 'reload_inbox') {
    officialPage(page);
    if(new URL(page.url()).pathname!=='/im/multiCustomerService') throw new Error('authenticated_inbox_required');
    await page.reload({waitUntil:'domcontentloaded',timeout:10000});
    await restoreNativeIntakeView(page);
    return {inbox_reloaded:true,customer_send_performed:false};
  }
  if(cmd.operation === 'start_reception_worker') {
    officialPage(page);
    await restoreNativeIntakeView(page);
    return startReception(page,context,runtime,undefined,cmd.future_entries_only);
  }
  if(cmd.operation === 'reload_observation_adapter') {
    delete require.cache[require.resolve('./ui_engine.cjs')];
    delete require.cache[require.resolve('./ui_sender.cjs')];
    return {adapter_reloaded:true,customer_send_performed:false};
  }
  if(cmd.operation === 'reload_sender') {
    if(controller.status(page).worker?.busy) throw new Error('active_reception_blocks_sender_reload');
    delete require.cache[require.resolve('./ui_sender.cjs')];
    return {sender_reloaded:true,customer_send_performed:false};
  }
  if(cmd.operation === 'restart_idle_engine') {
    const slot=globalThis[Symbol.for('xhs_reception.ui_engine_client')];
    if(slot){
      const status=await slot.client.request('status',{});
      if(!status.ok || status.result.outbox.some(row=>['PREPARED','CLAIMED','SUBMITTING','UNKNOWN'].includes(row.status))) throw new Error('unresolved_engine_work_blocks_restart');
      await slot.client.close();
      delete globalThis[Symbol.for('xhs_reception.ui_engine_client')];
    }
    return {engine_restarted:true,client:require('./ui_engine.cjs').getClient(runtime).diagnostics(),customer_send_performed:false};
  }
  if(cmd.operation === 'prime_native_card_identity') return require('./ui_sender.cjs').primeCardIdentity(page,await currentScope(page,runtime));
  if(cmd.operation === 'prime_recent_independent_card') {
    const scope=await currentScope(page,runtime);
    if(scope.conversation_id!=='678b1d02000000000a03f368') throw new Error('independent_card_reference_customer_required');
    const messages=scope.messages.filter(m=>m.message_id==='1eadad6ac55c59a'&&m.raw_type==='CARD'&&
      Number(m.raw_timestamp)===1792726700866);
    if(messages.length!==1) throw new Error('independent_preexisting_native_card_required');
    return require('./ui_sender.cjs').primeCardIdentity(page,{...scope,messages});
  }
  if(cmd.operation === 'reload_native_history') {
    delete require.cache[require.resolve('./native_history_receipt.cjs')];
    return {attached:!!require('./native_history_receipt.cjs').attach(page)};
  }
  if(cmd.operation === 'card_differences') return require('./native_history_receipt.cjs').attach(page).cardDifferences({
    accountId:'66879fef000000001c002839',sourceConversationId:'6a5aea22000000000e03b800',sourceMessageId:'1ead98099283179',
    targetConversationId:'678b1d02000000000a03f368',targetMessageId:'1eadae10628d14e'});
  if(cmd.operation === 'card_route_differences') return require('./native_history_receipt.cjs').attach(page).cardRouteDifferences({
    accountId:'66879fef000000001c002839',sourceConversationId:'6a5aea22000000000e03b800',sourceMessageId:'1ead98099283179',
    targetConversationId:'678b1d02000000000a03f368',targetMessageId:'1eadae10628d14e'});
  if(cmd.operation === 'attach_native_history') return require('./native_history_receipt.cjs').attach(page).snapshot();
  if(cmd.operation === 'read_native_history_schema') return require('./native_history_receipt.cjs').attach(page).snapshot();
  if(cmd.operation === 'read_native_history_bindings') return require('./native_history_receipt.cjs').attach(page).bindings(await currentScope(page,runtime));
  if(cmd.operation === 'ingest_scope') {
    const scope=await currentScope(page,runtime);
    const engine=require('./ui_engine.cjs');
    return engine.ingestObservedScope(engine.getClient(runtime),scope,{historicalBaseline:true});
  }
  if(cmd.operation === 'reception_once' || cmd.operation === 'reconcile_and_complete') {
    await currentScope(page,runtime);
    const sender=require('./ui_sender.cjs');
    return sender[cmd.operation==='reception_once'?'receive':'reconcileAndComplete']({page,runtime,uid:cmd.uid,
      text:cmd.text,currentScope:()=>currentScope(page,runtime,{restoreProfile:false}),
      textOnlyService:cmd.operation==='reception_once'&&workerContext?.textOnlyService===true,
      sourceEventId:cmd.operation==='reception_once'&&(workerContext?.textOnlyService===true || typeof workerContext?.correctionOfIntentId==='string'&&workerContext.correctionOfIntentId.length>0)?workerContext.sourceEventId:undefined,
      correctionOfIntentId:cmd.operation==='reception_once'&&typeof workerContext?.correctionOfIntentId==='string'&&workerContext.correctionOfIntentId.length>0?workerContext.correctionOfIntentId:undefined,
      reconcileOnly:cmd.reconcile_only===true,
      expectedIntentId:workerContext?.originalReconciliation?.intentId,
      expectedNativeMessageId:workerContext?.originalReconciliation?.nativeId,
      expectedRawId:workerContext?.originalReconciliation?.rawId,
      originalVerificationStartedAtMs:workerContext?.originalReconciliation?.verificationStartedAtMs,
      allowOriginalTextIdRecovery:workerContext?.originalReconciliation?.allowOriginalTextIdRecovery===true,
      originalTextRecoveryAnchor:workerContext?.originalReconciliation?.originalTextRecoveryAnchor,
      freshSourceIds:workerContext?.freshSourceIds || new Set(),isCurrent:workerContext?.isCurrent || (()=>true),
      refreshHistory:async({uid=cmd.uid,accountId,isCurrent=workerContext?.isCurrent || (()=>true)}={})=>{
        officialPage(page);
        if(uid!==cmd.uid || !/^[a-f0-9]{24}$/.test(uid || '')) throw new Error('native_history_refresh_uid_mismatch');
        const verified=scope=>scope?.scope_ready===true && scope.account_scope_verified===true &&
          scope.conversation_scope_verified===true && scope.conversation_id===uid &&
          (!accountId || scope.account_id===accountId) && Date.now()-Date.parse(scope.observed_at_utc)<1000;
        if(!isCurrent()) throw new Error('reception_round_cancelled');
        const before=await currentScope(page,runtime,{restoreProfile:false});
        if(!verified(before)) throw new Error('native_history_refresh_current_scope_required');
        const input=page.locator('.reply-box-wrap textarea.reply-textarea').filter({visible:true});
        if(await input.count()!==1 || await input.inputValue()!=='') throw new Error('native_history_refresh_nonempty_or_ambiguous_draft');
        // Re-clicking an active row is a native no-op. Native "reply: all"
        // re-applies the same unrestricted reply filter and resets the site's
        // list/history store, even when already checked. The restricted native
        // choices must never be changed merely to obtain a receipt.
        let stage='locate_native_history_refresh',filterClickFailure=null;const began=performance.now();
        try{
          if(before.conversation_ui?.active_data_key==='Total-'+uid){
            const filter=page.locator('.search-user .search-top > button').filter({visible:true});
            if(await filter.count()===1){
              if(!isCurrent()) throw new Error('reception_round_cancelled');
              stage='open_native_reply_filter';
              await filter.hover({timeout:700});
              const reply=page.locator('.d-option-content').filter({hasText:/^回复状态$/,visible:true});
              await reply.waitFor({state:'visible',timeout:600}).catch(()=>{});
              if(await reply.count()===1){
                await reply.hover({timeout:600});
                const all=page.locator('.d-dropdown:visible .d-option-content').filter({hasText:/^全部$/,visible:true});
                // The checkbox subtree is pre-rendered while the submenu is
                // still hidden. Its attachment cannot prove the hover finished.
                await all.waitFor({state:'visible',timeout:800}).catch(()=>{});
                const allInput=page.locator('.d-dropdown:visible input[value="reply-all"]');
                const choices=await page.locator('.d-dropdown:visible input[value="reply-all"],'+
                  '.d-dropdown:visible input[value="reply-replied"],.d-dropdown:visible input[value="reply-unreplied"]')
                  .evaluateAll(inputs=>inputs.map(input=>({value:input.value,checked:input.checked})));
                const expected=['reply-all','reply-replied','reply-unreplied'];
                const unrestricted=choices.length===3&&expected.every(value=>choices.filter(row=>row.value===value).length===1)&&
                  choices.filter(row=>row.checked).every(row=>row.value==='reply-all');
                if(unrestricted && await allInput.count()===1 && await all.count()===1){
                  if(!isCurrent()) throw new Error('reception_round_cancelled');
                  stage='native_reply_all_reset';
                  const startedRequests=new WeakSet(),onRequest=request=>startedRequests.add(request);
                  page.on('request',onRequest);
                  try{
                  const finished=async(response,label)=>{
                    let timer;
                    try{
                      const result=await Promise.race([response.finished(),new Promise((_,reject)=>{
                        timer=setTimeout(()=>reject(new Error(label+'_body_timeout')),1500);
                      })]);
                      if(result)throw new Error(label+'_body_failed:'+String(result.message || result));
                    }finally{clearTimeout(timer);}
                  };
                  const nativeGet=(response,pathname)=>{
                    try{const url=new URL(response.url());return startedRequests.has(response.request())&&response.request().method()==='GET'&&
                      url.origin==='https://sxt.xiaohongshu.com'&&url.pathname===pathname?url:null;}catch{return null;}
                  };
                  const list=page.waitForResponse(response=>{
                    const url=nativeGet(response,'/api-sxt/edith/chatline/chat');
                    if(!url || url.searchParams.get('limit')!=='80')return false;
                    const keys=Array.from(url.searchParams.keys()).map(key=>key.replace(/_/g,'').toLowerCase());
                    return !keys.some(key=>['refupdatetime','isactive','isfavorite'].includes(key));
                  },{timeout:2500});
                  const target=page.waitForResponse(response=>{
                    const url=nativeGet(response,'/api-sxt/edith/chatline/msg');
                    return Boolean(url&&url.searchParams.get('customer_user_id')===uid&&!url.searchParams.has('ref_store_id'));
                  },{timeout:3500});
                  list.catch(()=>{});target.catch(()=>{});
                  try{await all.click({timeout:700});}
                  catch(error){
                    if(!isCurrent())throw new Error('reception_round_cancelled');
                    filterClickFailure={control:'native_reply_all',timeout_ms:700,
                      pointer_interception_observed:/intercepts(?:_| )pointer(?:_| )events/.test(String(error.message)),
                      native_selection_diagnostics:await nativeFailureDiagnostics(page)};
                    const current=await currentScope(page,runtime,{restoreProfile:false});
                    if(!isCurrent())throw new Error('reception_round_cancelled');
                    if(!verified(current)||current.account_id!==before.account_id)throw new Error('native_history_refresh_scope_changed');
                    if(await input.count()!==1||await input.inputValue()!=='')throw new Error('native_history_refresh_nonempty_or_ambiguous_draft');
                  }
                  if(!filterClickFailure){
                  const listResponse=await list;await finished(listResponse,'native_list');
                  if(!isCurrent()) throw new Error('reception_round_cancelled');
                  stage='restore_original_after_native_filter_reset';
                  await ensureNativeAllConversations(page,{isCurrent});
                  const row=await locateNativeCustomerRow(page,{uid,isCurrent,timeout:1200,failureCode:'unique_original_native_history_row_required'});
                  if(!isCurrent()) throw new Error('reception_round_cancelled');
                  await row.click({timeout:700});
                  const targetResponse=await target;await finished(targetResponse,'native_target_history');
                  if(!isCurrent()) throw new Error('reception_round_cancelled');
                  stage='restore_original_native_profile';
                  await restoreNativeCustomerProfile(page,{uid,accountId:before.account_id,isCurrent,timeout:1200});
                  const after=await currentScope(page,runtime,{restoreProfile:false});
                  if(!isCurrent()) throw new Error('reception_round_cancelled');
                  if(!verified(after) || after.account_id!==before.account_id || after.profile_binding_source!=='current_native_profile') throw new Error('native_history_refresh_scope_changed');
                  return {action:'native_reply_all_reset_restore_original_conversation',account_id:after.account_id,conversation_id:uid,
                    elapsed_ms:performance.now()-began,reply_filter_preserved:true,confirms_send:false,customer_send_performed:false};
                  }
                  }finally{page.off('request',onRequest);}
                }
              }
            }
          }
          // Missing/ambiguous native controls or a restricted reply filter keep
          // the previously verified native page-reload fallback. No filter
          // choice is clicked on this branch. Its latency is recorded honestly.
          stage='locate_native_reload';
          if(await input.count()!==1 || await input.inputValue()!=='') throw new Error('native_history_refresh_nonempty_or_ambiguous_draft');
          const refresh=page.locator('.menu-item').filter({hasText:/^刷新$/,visible:true});
          if(await refresh.count()!==1) throw new Error('unique_native_reload_required');
          if(!isCurrent()) throw new Error('reception_round_cancelled');
          stage='native_reload';
          const loaded=page.waitForEvent('domcontentloaded',{timeout:8000});
          // Observe the rejection immediately even if the native click fails.
          loaded.catch(()=>{});
          await refresh.click({timeout:1000});await loaded;
          if(!isCurrent()) throw new Error('reception_round_cancelled');
          officialPage(page);
          stage='restore_all_conversations';
          await ensureNativeAllConversations(page,{isCurrent});
          stage='restore_original_native_conversation';
          const row=await locateNativeCustomerRow(page,{uid,isCurrent,timeout:3000,failureCode:'unique_original_native_history_row_required'});
          if(!isCurrent()) throw new Error('reception_round_cancelled');
          await row.click({timeout:1000});
          stage='restore_original_native_profile';
          await restoreNativeCustomerProfile(page,{uid,accountId:before.account_id,isCurrent,timeout:3000});
          if(!isCurrent()) throw new Error('reception_round_cancelled');
          stage='verify_restored_native_scope';
          const after=await currentScope(page,runtime,{restoreProfile:false});
          if(!verified(after) || after.account_id!==before.account_id || after.profile_binding_source!=='current_native_profile') throw new Error('native_history_refresh_scope_changed');
          return {action:'native_page_reload_restore_original_conversation',account_id:after.account_id,conversation_id:uid,
            elapsed_ms:performance.now()-began,...(filterClickFailure?{native_filter_click_failure:filterClickFailure}:{}),confirms_send:false,customer_send_performed:false};
        }catch(error){
          // Restore observation after a failed receipt refresh, without retrying
          // the filter reset, selecting another customer, or sending anything.
          let intakeFailure='',failureDiagnostics='';
          // Capture the failed view before finally-style All restoration can
          // mask a late Current-tab flip, absent ready class or collapsed list.
          if(isCurrent()&&!error.native_selection_diagnostics)failureDiagnostics=':native_selection_diagnostics='+JSON.stringify(await nativeFailureDiagnostics(page));
          if(isCurrent())try{await ensureNativeAllConversations(page,{isCurrent});}
          catch(restoreError){intakeFailure=';intake_view_restore:'+String(restoreError.message);}
          throw new Error('native_history_refresh:'+stage+':'+String(error.message)+(filterClickFailure?':native_filter_click_failure='+JSON.stringify(filterClickFailure):'')+failureDiagnostics+intakeFailure);
        }
      },
      openCardMenu:()=>openCardMenu(page)});
  }
  if(cmd.operation === "reload_scope_module") {
    delete require.cache[require.resolve('./ui_scope.cjs')];
    state.scopeProofs=new WeakMap();
    return {scope_module_reloaded:true,customer_send_performed:false};
  }
  if(cmd.operation === "attach_native_eligibility") {
    officialPage(page);
    return require('./native_eligibility.cjs').attach(page).snapshot();
  }
  if(cmd.operation === "read_native_eligibility") {
    officialPage(page);
    return require('./native_eligibility.cjs').snapshot(page);
  }
  if(cmd.operation === "open_native_card_menu") {
    officialPage(page);
    await openCardMenu(page);
    return {card_menu_opened:true,customer_send_performed:false};
  }
  if(cmd.operation === "read_sidebar") {
    officialPage(page);
    return require('./ui_sidebar.cjs').readSidebar(page);
  }
  if(cmd.operation === "open_lead_tools") {
    officialPage(page);
    const scope=await currentScope(page,runtime);
    if(!scope.scope_ready || scope.conversation_id !== cmd.uid) throw new Error('current_customer_scope_unready');
    await openCardMenu(page);
    return {opened:true,customer_send_performed:false,conversation_id:scope.conversation_id};
  }
  if(cmd.operation === "read_scope") {
    officialPage(page);
    return currentScope(page,runtime);
  }
  if(cmd.operation === "attach_passive_receipt_metadata") {
    officialPage(page);
    return require('./passive_ui_receipts.cjs').attach(page).snapshot();
  }
  if(cmd.operation === "read_passive_receipt_metadata") {
    officialPage(page);
    return require('./passive_ui_receipts.cjs').snapshot(page);
  }
  if(cmd.operation === "read_account_identity") {
    const current=officialPage(page);
    if(current.pathname !== '/im/multiCustomerService') throw new Error('not_on_reception_page');
    await page.locator('.root-menu-box .portrait').hover({timeout:3000});
    const popup=page.locator('.userInfo-popover');
    await popup.waitFor({state:'visible',timeout:3000});
    const text=await popup.innerText();
    const id=text.match(/主账号ID[：:]\s*([a-f0-9]{24})/);
    const staff=text.match(/客服编号[：:]\s*(\d+)/);
    if(!id || !staff || !text.includes('运去哪海外仓')) throw new Error('expected_native_account_identity_not_observed');
    // Move only this isolated page's virtual pointer off the portrait. The
    // account popover otherwise covers the conversation tabs used by bootstrap.
    const neutral=page.locator('body').filter({visible:true});
    if(await neutral.count()!==1) throw new Error('unique_native_body_hover_target_required');
    await neutral.hover({timeout:1500});
    await popup.waitFor({state:'hidden',timeout:1500});
    const result={account_id:id[1],account_display_name:'运去哪海外仓',staff_number:staff[1],
      source:'platform_ui',reference:'.userInfo-popover 主账号ID',observed_at_utc:new Date().toISOString(),
      url:current.origin+current.pathname,title:await page.title()};
    atomicJSON(path.join(runtime,'account_identity.json'),result);
    return result;
  }
  if(cmd.operation === "select_conversation") {
    officialPage(page);
    if(typeof cmd.uid !== 'string' || !/^[a-f0-9]{24}$/.test(cmd.uid)) throw new Error('invalid_customer_uid');
    const isCurrent=workerContext?.isCurrent || (()=>true);
    if(!isCurrent())throw new Error('reception_round_cancelled');
    const profileTab=page.locator('.chat-tool-wrap .tabs-wrap .d-tabs-header').filter({hasText:/^客资标注$/,visible:true});
    const profileCount=await profileTab.count();
    if(!isCurrent())throw new Error('reception_round_cancelled');
    if(profileCount===1) await profileTab.click({timeout:3000});
    if(!isCurrent())throw new Error('reception_round_cancelled');
    const row=await locateNativeCustomerRow(page,{uid:cmd.uid,isCurrent});
    if(!isCurrent())throw new Error('reception_round_cancelled');
    await row.click({timeout:3000});
    if(!isCurrent())throw new Error('reception_round_cancelled');
    const account=JSON.parse(fs.readFileSync(path.join(runtime,'account_identity.json'),'utf8')).account_id;
    await page.waitForFunction(({uid,account})=>{
      const group=Array.from(document.querySelectorAll('.user-id-row .id-group')).find(el=>el.checkVisibility() && el.querySelector('.id-label')?.textContent.trim()==='UID:');
      return group?.querySelector('.ellipsis')?.textContent.trim()===uid
        && Array.from(document.querySelectorAll('.im-msg-item')).some(el=>el.id.startsWith('id_'+account+'.'+uid+'.')||el.id.startsWith('id_'+uid+'.'+account+'.'));
    },{uid:cmd.uid,account},{timeout:3000});
    if(!isCurrent())throw new Error('reception_round_cancelled');
    const scope=await currentScope(page,runtime);
    if(!isCurrent())throw new Error('reception_round_cancelled');
    if(!scope.scope_ready || scope.conversation_id!==cmd.uid) throw new Error('selected_native_scope_not_verified');
    return {selected_uid:cmd.uid,scope_ready:true,customer_send_performed:false};
  }
  if(cmd.operation === "open_all_conversations") {
    return {...await ensureNativeAllConversations(page),customer_actions_performed:false};
  }
  if(cmd.operation === "inspect_structure") {
    officialPage(page);
    return require('./dom_inspector.cjs').inspect(page,cmd);
  }
  if(cmd.operation === "hover_readonly") {
    officialPage(page);
    if(typeof cmd.selector !== "string" || cmd.selector.length>1000) throw new Error("invalid_selector");
    const target=page.locator(cmd.selector).filter({visible:true});
    if(await target.count() !== 1) throw new Error("unique_visible_hover_target_required");
    await target.hover({timeout:3000});
    return {hovered:true,customer_actions_performed:false};
  }
  if(cmd.operation === "dismiss_onboarding") {
    officialPage(page);
    const dismissed=[];
    for(const selector of [".step-guide-button",".ai-intro-popover button"]) {
      const control=page.locator(selector).filter({visible:true});
      if(await control.count() === 1) {
        if((await control.innerText()).trim() !== "我知道了") continue;
        await control.click({timeout:3000});dismissed.push(selector);
      }
    }
    return {dismissed,customer_actions_performed:false};
  }
  if(cmd.operation === "capture_login_qr") {
    const current=officialPage(page);
    if(current.pathname !== "/im/login") throw new Error("not_on_official_login_page");
    await page.waitForFunction(() => {
      const container=Array.from(document.querySelectorAll(".qrcode-container")).find(el=>el.checkVisibility());
      const qr=container?.querySelector(".qrcode");
      return qr && getComputedStyle(qr).backgroundImage.startsWith('url("data:image/png;')
        && !Array.from(container.querySelectorAll(".mask")).some(el=>el.checkVisibility());
    },null,{timeout:10000});
    const qr=page.locator(".qrcode-container .qrcode-wrapper");
    if(await qr.count() !== 1 || !(await qr.isVisible())) throw new Error("unique_visible_qr_required");
    const name=cmd.name;
    if(typeof name !== "string" || !/^[a-zA-Z0-9_-]+\.png$/.test(name)) throw new Error("invalid_screenshot_name");
    const file=path.join(runtime,name);
    await qr.screenshot({path:file,timeout:3000});
    return {qr_screenshot:file,observed_at_utc:new Date().toISOString(),authenticated_verified:false};
  }
  if(cmd.operation === "reload_login_result") {
    const current=officialPage(page);
    if(current.pathname !== "/im/login") throw new Error("not_on_official_login_page");
    await page.reload({waitUntil:"domcontentloaded",timeout:15000});
    const after=officialPage(page);
    return {url:after.origin+after.pathname,title:(await page.title()).slice(0,200),
      customer_actions_performed:false,live_reception_ready:false};
  }
  if(cmd.operation === "diagnose_login") {
    officialPage(page);
    const {diagnostics,safeURL}=loginDiagnostics(page,context);
    const result=await boundedRead({page,runtime,generation:state.generation,task:async()=>{
      const pages=await Promise.all((context ? context.pages() : [page]).slice(0,10).map(async p=>({
        ...safeURL(p.url()),title:(await p.title()).slice(0,200),
      })));
      const qr=await page.locator(".qrcode-container").evaluateAll(nodes=>{
        const rendered=el=>el.checkVisibility ? el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})
          : Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
        return nodes.slice(0,4).map(el=>({rendered:rendered(el),text:(el.innerText || "").slice(0,1000),
          masks:Array.from(el.querySelectorAll(".mask")).slice(0,6).map(mask=>({rendered:rendered(mask),text:(mask.innerText || "").slice(0,500)})),
        }));
      });
      return {pages,qr};
    }});
    return {readonly:true,classification:"unverified_login_diagnostics",navigation_events:diagnostics.events.slice(),
      ...(result.status === "ok" ? result.value : {read_status:result.status}),live_reception_ready:false};
  }
  if(cmd.operation === "renew_login_qr") {
    const started=performance.now();
    const onLoginPage=() => {
      const current=new URL(page.url());
      return current.origin === "https://sxt.xiaohongshu.com" && current.pathname === "/im/login";
    };
    if(!onLoginPage()) throw new Error("not_on_official_login_page");
    await page.reload({waitUntil:"domcontentloaded",timeout:15000});
    if(!onLoginPage()) throw new Error("not_on_official_login_page_after_reload");
    await page.getByText("手机登录",{exact:true}).waitFor({state:"visible",timeout:3000});
    const buttons=page.locator("button.logo-btn");
    if(await buttons.count() !== 2) throw new Error("login_controls_changed");
    await buttons.nth(1).click({timeout:3000});
    await page.getByRole("heading",{name:"扫码登录",exact:true}).waitFor({state:"visible",timeout:3000});
    return {login_qr_ready:true,customer_actions_performed:false,
      live_reception_ready:false,elapsed_ms:performance.now()-started};
  }
  if(cmd.operation === "observe") return observe(page,{runtime});
  if(cmd.operation === "start_observer") {
    if(state.timer) return {running:true,already_running:true,readonly:true,stalled:Boolean(state.stalled)};
    const generation=++state.generation;
    state.running=true;state.runtime=runtime;state.lastFingerprint=null;state.needHealthWrite=true;
    const tick = async () => {
      if(state.busy || generation !== state.generation || !state.running) return;
      try {
        const result=await boundedRead({page,runtime,generation,task:async()=>{
          const candidate=await probe(page);
          if(generation !== state.generation || !state.running || state.stalled) return {cancelled:true};
          const {observed_at_utc,elapsed_ms,...semantic}=candidate;
          const fingerprint=JSON.stringify(semantic);
          const changed=fingerprint !== state.lastFingerprint;
          return {candidate,fingerprint,full:changed ? await collectFull(page) : null};
        }});
        if(result.status !== "ok" || generation !== state.generation || !state.running) return;
        const {candidate,fingerprint,full}=result.value;
        const now=Date.now();
        if(full) {
          full.login_state_probe={observed_at_utc:candidate.observed_at_utc,
            classification:"unverified_visible_login_state_candidate",candidate:candidate.login_state_candidate};
          atomicJSON(path.join(runtime,"ui-observation.json"),full);
          state.lastFingerprint=fingerprint;
          state.lastSavedAt=now;
        }
        if(full || state.needHealthWrite || now-state.lastHealthAttemptAt>=HEARTBEAT_MS) {
          persistHealth(runtime,{running:true,stalled:false,inflight_read:false,last_transition:"observing",
            last_observed_at_utc:candidate.observed_at_utc,last_dom_read_ms:candidate.elapsed_ms,
            url:candidate.url,login_page:candidate.login_path_candidate,last_error:null,
            login_state_candidate:candidate.login_state_candidate,login_state_observed_at_utc:candidate.observed_at_utc,
            last_full_observed_at_utc:full?.observed_at_utc || state.lastFullObservedAt || null,
            observation_file:path.join(runtime,"ui-observation.json")});
          state.needHealthWrite=false;
        }
        if(full) state.lastFullObservedAt=full.observed_at_utc;
      } catch(error) {
        if(generation === state.generation && state.running) reportError(error);
      }
    };
    state.timer=setInterval(tick,INTERVAL_MS);
    await tick();
    return {running:generation === state.generation && state.running,readonly:true,
      stalled:Boolean(state.stalled),interval_ms:INTERVAL_MS,live_reception_ready:false};
  }
  if(cmd.operation === "stop_observer") {
    ++state.generation;state.running=false;
    clearInterval(state.timer);state.timer=null;
    persistHealth(runtime,{running:false,stalled:Boolean(state.stalled),inflight_read:Boolean(state.busy),
      last_transition:"stopped",stopped_at_utc:new Date().toISOString()});
    return {running:false,readonly:true};
  }
  throw new Error("unsupported_readonly_ui_operation");
}

module.exports={run,observe};
