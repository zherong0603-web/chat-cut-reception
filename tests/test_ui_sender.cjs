"use strict";

// Executes the actual sender source with isolated protocol/UI fixtures. The
// locator fixture evaluates the sender's ID selectors against changing DOM data;
// it does not decide whether a send should be allowed. No browser or production
// database/profile is opened, and these tests are not real-send/SLA evidence.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const vm=require("node:vm");
const {EventEmitter}=require("node:events");
const {createRequire}=require("node:module");
const senderFile=path.resolve(__dirname,"../xhs_reception/ui_sender.cjs");
const source=fs.readFileSync(senderFile,"utf8");
const nativeRequire=createRequire(senderFile);
const ACCOUNT="aaaaaaaaaaaaaaaaaaaaaaaa",UID="bbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER="cccccccccccccccccccccccc",TEXT="SYNTHETIC_APPROVED_REPLY";

function message(id,direction,text,time=Date.now()-3600000) {
  const pair=ACCOUNT+"."+UID+".",native=pair+id;
  return {account_id:ACCOUNT,conversation_id:UID,message_id:id,
    message_pair_prefix:pair,native_scope_id:native,dom_id:"id_"+native,
    native_dom_id:"jarvis-msg-"+native,raw_timestamp:String(time),raw_type:"TEXT",
    direction,raw_text:text,native_error_class_candidates:[],native_business_card_candidate:false};
}

// A small DOM-shaped tree, independent of the sender's mode verdict. The real
// evaluate callback traverses visible wrappers, actual buttons and overlays.
class DomNode {
  constructor(tag,attrs={},children=[],text="") {
    this.tagName=tag.toUpperCase();this.attrs={...attrs};this.children=children;this.text=text;
    this.disabled=attrs.disabled===true;this.readOnly=attrs.readOnly===true;this.visible=attrs.visible!==false;
    for(const child of children)child.parentElement=this;
  }
  getAttribute(name){if(name==="disabled")return this.disabled?"":null;return this.attrs[name]??null;}
  get innerText(){return this.text+this.children.map(child=>child.innerText).join("");}
  checkVisibility(){return this.visible&&(!this.parentElement||this.parentElement.checkVisibility());}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  querySelectorAll(selector){
    const descendants=[];const visit=node=>{for(const child of node.children){descendants.push(child);visit(child);}};visit(this);
    const simple=(node,part)=>{
      const attributes=Array.from(part.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g));
      if(attributes.some(match=>node.getAttribute(match[1])===null || match[2]!==undefined&&node.getAttribute(match[1])!==match[2]))return false;
      const bare=part.replace(/\[[^\]]+\]/g,"");const tag=bare.match(/^[A-Za-z][A-Za-z0-9-]*/)?.[0];
      if(tag&&node.tagName!==tag.toUpperCase())return false;
      const id=bare.match(/#([A-Za-z0-9_-]+)/)?.[1];if(id&&node.getAttribute("id")!==id)return false;
      const classes=(node.getAttribute("class")||"").split(/\s+/);
      return Array.from(bare.matchAll(/\.([A-Za-z0-9_-]+)/g),match=>match[1]).every(name=>classes.includes(name));
    };
    return descendants.filter(node=>selector.split(",").some(branch=>{
      const parts=branch.trim().split(/\s+/);if(!simple(node,parts.at(-1)))return false;
      let ancestor=node.parentElement;
      for(let index=parts.length-2;index>=0;index--){while(ancestor&&!simple(ancestor,parts[index]))ancestor=ancestor.parentElement;if(!ancestor)return false;ancestor=ancestor.parentElement;}
      return true;
    }));
  }
}
const dom=(tag,attrs,children,text)=>new DomNode(tag,attrs,children,text);

function fixture(options={}) {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"xhs-sender-regression-"));
  const runtime=path.join(temporary,"synthetic-state");fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(temporary,"reception.json"),JSON.stringify({
    live_dispatch_enabled:true,browser:"isolated_playwright",account_id:ACCOUNT}));
  fs.writeFileSync(path.join(runtime,"connection.json"),"{}");
  fs.writeFileSync(path.join(runtime,"account_identity.json"),JSON.stringify({
    account_id:ACCOUNT,source:"platform_ui",staff_number:"SYNTHETIC_STAFF"}));
  const initial=message("source","left",options.initialQuestion || "SYNTHETIC_INITIAL_QUESTION",
    Date.now()-(options.sourceAgeMs ?? 3600000));
  const model={activeUID:UID,messages:[initial],draft:options.draft || "",scopeReads:0,
    clicks:[],rpc:[],confirmations:[],cardMenus:0,historyRefreshes:0,historyChecks:0,historyParams:[],nativeTextHistoryResults:[],
    fills:[],outbox:[],events:[],diagnosticArms:[],diagnosticBegins:[],diagnosticReports:0,diagnosticDetaches:0,
    current:true,trials:[],takeoverClicks:0,modeReads:0,historyAvailable:new Set(),
    aiOverlay:options.aiOverlay??false,headerDisabled:options.headerDisabled??false,
    takeoverVisible:options.takeoverVisible??Boolean(options.aiOverlay),inputDisabled:false,
    leadFields:options.leadFields ?? [
      {label:"名片",value:"企业微信 - 未添加企微"},
      {label:"留资卡",value:"无提交留资卡"}]};
  if(options.entryBeforeSource) {
    const entry=message("entry","center","对方通过合成笔记进入私信",Number(initial.raw_timestamp)-100);
    entry.raw_type="RICH_HINT";model.messages.unshift(entry);model.entry=entry;
  }
  if(options.refusal) model.messages.push(message("refusal","left",options.refusal,Number(initial.raw_timestamp)+1));
  if(options.historicalRefusal) model.messages.unshift(message("historical-refusal","left",options.historicalRefusal,Number(initial.raw_timestamp)-100));
  const conversation={state:"ACTIVE",needs_response:1,account_id:ACCOUNT,conversation_id:UID,
    latest_event_id:initial.dom_id,latest_event_at:Number(initial.raw_timestamp)/1000,
    last_sent_at:Date.now()/1000-7200};
  model.conversation=conversation;
  const client={request:async(method,params)=>{
    model.rpc.push({method,params});
    if(method==="status") {
      options.beforeStatus?.(model);
      return {ok:true,result:{account_scope:ACCOUNT,conversations:[conversation],outbox:model.outbox}};
    }
    if(method==="ingest") {
      if(["REFUSED","WECHAT_VERIFIED"].includes(params.event.type)) {
        conversation.state="STOPPED";conversation.stop_reason=params.event.type;
        for(const row of model.outbox) if(["PREPARED","CLAIMED"].includes(row.status)) row.status="CANCELLED";
      }
      return {ok:true,result:{conversation}};
    }
    if(method==="prepare") {
      const row={...params,intent_id:"synthetic-intent-"+(model.outbox.length+1),
        source_event_id:params.source_event_id,status:"PREPARED",submitted_at:null,expires_at:Date.now()/1000+10};
      model.outbox.push(row);return {ok:true,result:row};
    }
    const row=model.outbox.find(row=>row.intent_id===params.intent_id);
    if(method==="claim" && row) row.status="CLAIMED";
    if(method==="begin_submit") {
      if(row) {row.status="SUBMITTING";row.submitted_at=Date.now()/1000;}
      model.events.push("rpc.begin_submit:"+row?.payload.operation);
      options.beforeSubmit?.(model,row);
    }
    if(method==="confirm") {
      model.events.push("rpc.confirm:"+row?.payload.operation+":"+params.result);
      model.confirmations.push(params.result);
      if(row) {row.status=params.result.toUpperCase();row.evidence=params.evidence;}
      return {ok:true,result:{status:params.result.toUpperCase()}};
    }
    if(method==="reconcile") {
      assert.equal(row?.status,"UNKNOWN");row.status=params.result.toUpperCase();row.evidence=params.evidence;
      return {ok:true,result:{status:row.status}};
    }
    return {ok:true,result:{}};
  }};
  let nativeTextHistory;
  const dependencies={
    "./ui_engine.cjs":{getClient:()=>client,
      ingestObservedScope:async()=>({ok:true,conversation})},
    "./native_send_ack.cjs":{arm:()=>({wait:async()=>({status:"unknown"}),
      snapshot:()=>({status:"unknown"}),detach(){}})},
    "./native_history_receipt.cjs":{attach:()=>({
      cardIdentity:()=>({status:"native_card_identity_confirmed",verifier_version:7,
        cardIdentity:{synthetic:true,routing_hash:"a".repeat(64),
          ...(options.identityFullHash?{full_payload_hash:options.identityFullHash}:{})},reference:"synthetic"}),
      verify:async params=>{
        model.historyChecks++;model.historyParams.push(params);
        if(options.realNativeTextHistory && params.operation==='text') {
          nativeTextHistory ||= nativeRequire('./native_history_receipt.cjs').attach(page);
          const result=nativeTextHistory.verify(params);model.nativeTextHistoryResults.push(result);return result;
        }
        const confirmed=Object.hasOwn(options.historyByOperation || {},params.operation) ?
          options.historyByOperation[params.operation] : options.confirmHistory;
        return confirmed || model.historyAvailable.has(params.operation) ? {status:"server_history_confirmed",verifier_version:7,request_started_at_ms:Date.now(),operation:params.operation,
          observed_at_utc:new Date().toISOString()} : {status:"unknown",reason:"synthetic_unconfirmed_history"};
      },
    })},
    "./native_card_request_proof.cjs":{arm:(_page,params)=>{
      model.events.push("diagnostic.arm");model.diagnosticArms.push(params);
      assert.equal(params.accountId,ACCOUNT);assert.equal(params.conversationId,UID);
      assert.equal(params.staffNumber,"SYNTHETIC_STAFF");
      assert.equal(params.independentCardIdentity.routing_hash,"a".repeat(64));
      if(options.diagnosticArmThrows) throw new Error("synthetic_diagnostic_unavailable");
      let detached=false;
      return {
        beginSubmit:time=>{model.events.push("diagnostic.begin");model.diagnosticBegins.push(time);},
        bindingReport:()=>{
          model.events.push("diagnostic.report");model.diagnosticReports++;
          return options.diagnosticReport || {status:"unknown",phase:"diagnostic_schema_unverified",
            schema_verified:false,can_confirm_send:false,reason:"synthetic_diagnostic_only"};
        },
        detach:()=>{if(!detached) {detached=true;model.events.push("diagnostic.detach");model.diagnosticDetaches++;}},
      };
    }},
  };
  const module={exports:{}};
  function documentTree(){
    const fields=(options.cardPanelOmitsLeadFields&&model.cardMenus?[]:model.leadFields).map(field=>dom("div",{class:"info-item"},[
      dom("span",{class:"info-item-title"},[],field.label),dom("span",{class:"info-item-value-wrap"},[],field.value)]));
    const button=dom("button",{disabled:model.headerDisabled,class:model.headerDisabled?"disabled":""},
      model.headerDisabled?[dom("svg",{class:"ai-icon-disabled"},[])]:[],"人工转AI");
    const replyChildren=[dom("textarea",{class:"reply-textarea",disabled:model.inputDisabled},[],model.draft)];
    if(model.aiOverlay)replyChildren.push(dom("div",{class:"ai-overlay"},[
      dom("button",{class:"ai-overlay-button",visible:model.takeoverVisible},[],"人工接管")]));
    else if(model.takeoverVisible)replyChildren.push(dom("button",{class:"ai-overlay-button"},[],"人工接管"));
    const roots=[dom("div",{id:"walle-ad"},[
      dom("div",{class:"sx-contact-item active","data-key":"Total-"+model.activeUID},[]),
      dom("div",{class:"message-header"},[dom("div",{"data-track-click":JSON.stringify({attributes:{triggerKey:"人工转AI"}})},[button])]),
      dom("div",{class:"reply-box-wrap"},replyChildren),dom("div",{class:"information-source-wrap"},fields),
      dom("div",{class:"chat-tool-wrap"},[]),
    ])];
    if(options.unrelatedManualRoot)roots.push(dom("div",{id:"walle-ad"},[
      dom("div",{class:"sx-contact-item active","data-key":"Total-"+OTHER},[]),
      dom("div",{class:"message-header"},[dom("div",{"data-track-click":JSON.stringify({attributes:{triggerKey:"人工转AI"}})},[dom("button",{},[],"人工转AI")])]),
      dom("div",{class:"reply-box-wrap"},[dom("textarea",{class:"reply-textarea"},[])])]));
    return dom("document",{},roots);
  }
  const compiled=vm.runInNewContext("(function(exports,require,module,__filename,__dirname){\n"+source+"\n})",
    {process,Buffer,setTimeout,clearTimeout,console,document:{querySelectorAll:selector=>documentTree().querySelectorAll(selector)}},{filename:senderFile,timeout:1000});
  compiled(module.exports,name=>Object.hasOwn(dependencies,name) ? dependencies[name] : nativeRequire(name),
    module,senderFile,path.dirname(senderFile));

  // Only the CSS fragments used to bind the active customer and exclude new
  // messages are interpreted here. Removing either sender filter permits the
  // fixture click, which makes the corresponding regression fail.
  function selectorExists(selector) {
    if(selector.includes(".sx-contact-item.active")) {
      const keys=Array.from(selector.matchAll(/\[data-key="([^"]+)"\]/g),match=>match[1]);
      assert(keys.length,"active selector must carry an exact data-key");
      return keys.includes("Total-"+model.activeUID);
    }
    if(selector.includes(".im-msg-item")) {
      const prefixes=Array.from(selector.matchAll(/\[id\^="([^"]+)"\]/g),match=>match[1]);
      const excluded=new Set(Array.from(selector.matchAll(/:not\(\[id="([^"]+)"\]\)/g),match=>match[1]));
      assert(prefixes.length,"message selector must carry an exact native prefix");
      return model.messages.some(m=>prefixes.some(prefix=>m.dom_id.startsWith(prefix)) &&
        !excluded.has(m.dom_id) && (m.direction==="left" && m.raw_type==="TEXT" ||
          m.direction==="center" && m.raw_type==="RICH_HINT"));
    }
    if(selector.includes(".card-box__content-title")) {
      return selector.includes('[title="企微_运去哪海外仓（企微）"]');
    }
    throw new Error("unsupported_fixture_selector");
  }
  function locator(selector,predicates=[]) {
    const actionable=()=>predicates.every(predicate=>predicate());
    const takeoverNodes=()=>documentTree().querySelectorAll(selector).filter(node=>node.checkVisibility()&&node.innerText.trim()==="人工接管");
    const requireActionable=()=>{if(!actionable()) throw new Error("fixture_locator_not_actionable");};
    return {selector,
      locator:child=>locator(selector+" "+child,predicates),
      filter:filter=>locator(selector,[...predicates,
        ...(filter.has ? [()=>selectorExists(filter.has.selector)] : []),
        ...(filter.hasNot ? [()=>!selectorExists(filter.hasNot.selector)] : [])]),
      getByRole:()=>locator(selector+" button",predicates),
      count:async()=>!actionable()?0:options.domMode&&selector.includes(".ai-overlay-button")?takeoverNodes().length:1,
      inputValue:async()=>{requireActionable();return model.draft;},
      fill:async text=>{requireActionable();model.fills.push(text);model.draft=text;},
      hover:async()=>requireActionable(),isEnabled:async()=>actionable()&&
        (!options.domMode||!selector.includes(".ai-overlay-button")||takeoverNodes().length===1&&!takeoverNodes()[0].disabled),getAttribute:async()=>"",
      click:async args=>{
        requireActionable();const card=selector.includes(".card-box__content");
        if(selector.includes(".ai-overlay-button")){
          assert(!args?.trial);assert(model.takeoverVisible,"actual visible takeover required");model.takeoverClicks++;model.events.push("ui.takeover");
          if(!options.overlayPersists)model.aiOverlay=false;
          if(!options.takeoverPersists)model.takeoverVisible=false;
          if(!options.headerStaysDisabled)model.headerDisabled=false;
          return;
        }
        if(args?.trial){
          model.events.push("ui.trial:"+(card?"native_card":"text"));model.trials.push(card?"native_card":"text");
          options.beforeTrial?.(model);
          if(options.trialFails)throw new Error("synthetic_actionability_failed_before_submit");
          options.afterTrial?.(model);return;
        }
        model.events.push("ui.click:"+(card?"native_card":"text"));
        if(card && options.failCardClick) throw new Error("synthetic_card_click_timeout");
        model.clicks.push({uid:model.activeUID,text:model.draft,operation:card?"native_card":"text"});
        if(options.bubbleAfterClick) {
          const outbound=message("outbound-"+model.clicks.length,"right",
            card?"企业微信\n运去哪海外仓（企微）":TEXT,Date.now());
          if(card) {outbound.raw_type="CARD";outbound.native_business_card_candidate=true;}
          model.messages.push(outbound);
        }
      },
    };
  }
  const page=Object.assign(new EventEmitter(),{locator,waitForFunction:async()=>{},evaluate:async(fn,args)=>{
    model.modeReads++;options.beforeMode?.(model);
    return options.domMode?fn(args):({manual:true,input_ready:true,scope_ready:true,
      lead_fields:options.cardPanelOmitsLeadFields && model.cardMenus ? [] : model.leadFields,profile_text:""});
  }});
  async function currentScope() {
    model.scopeReads++;options.beforeScope?.(model);
    const observed=new Date().toISOString(),cached=model.cardMenus>0;
    if(!cached) model.profileObserved=observed;
    return {state:"ready",source:"platform_ui",classification:"readonly_ui_scope",
      scope_ready:true,account_scope_verified:true,conversation_scope_verified:true,
      account_id:ACCOUNT,account_display_name:"fixture-account",conversation_id:model.activeUID,observed_at_utc:observed,
      title:"fixture-account-私信通",url:"https://sxt.xiaohongshu.com/im/multiCustomerService",
      profile_binding_source:cached?"recent_native_profile_proof":"current_native_profile",
      profile_proof_observed_at_utc:model.profileObserved,
      conversation_ui:{active_data_key:"Total-"+model.activeUID,profile_uid:model.activeUID,row_nickname:"fixture",header_nickname:"fixture"},
      ...(!cached?{native_lead_fields:model.leadFields.map(field=>({...field}))}:{}),
      messages:model.messages.map(m=>({...m}))};
  }
  async function run(extra={}) {
    if(!options.skipPrimeCardIdentity)module.exports.primeCardIdentity(page,await currentScope());
    // Keep scenario read counts local to receive(), excluding identity priming.
    model.scopeReads=0;
    return module.exports.receive({page,runtime,uid:UID,text:TEXT,currentScope,
      openCardMenu:async()=>{model.cardMenus++;options.afterOpenCardMenu?.(model);},
      refreshHistory:async params=>{model.historyRefreshes++;
        assert.equal(params.uid,UID);assert.equal(params.accountId,ACCOUNT);
        if(options.historyAfterRefresh)model.historyAvailable.add(params.operation);
        return {action:'synthetic_native_reload',elapsed_ms:5000,confirms_send:false,customer_send_performed:false};
      },isCurrent:()=>model.current,
      ...(options.freshSources ? {freshSourceIds:new Set(model.messages.filter(m=>
        m.direction==="left" || m.direction==="center").map(m=>m.dom_id))} : {}),...extra});
  }
  async function reconcile({reconcileOnly=true,...expected}={}) {
    return module.exports.reconcileAndComplete({page,runtime,uid:UID,currentScope,reconcileOnly,...expected,
      refreshHistory:async()=>{model.historyRefreshes++;},openCardMenu:async()=>{model.cardMenus++;}});
  }
  function setConfig(patch) {
    const file=path.join(temporary,"reception.json");
    fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file,"utf8")),...patch}));
  }
  const takeOver=()=>module.exports.takeOverOnly({page,runtime,uid:UID,currentScope,isCurrent:()=>model.current});
  return {page,model,run,reconcile,takeOver,setConfig,cleanup:()=>{
    nativeTextHistory?.detach();fs.rmSync(temporary,{recursive:true,force:true});
  }};
}

async function check(options,assertions) {
  const test=fixture(options);
  try {await assertions(test);} finally {test.cleanup();}
}

async function missingLeadStatusBlocks() {
  await check({leadFields:[]},async({model,run})=>{
    await assert.rejects(run(),/fresh_explicit_lead_status_required/);
    assert.equal(model.clicks.length,0);assert.equal(model.cardMenus,0);
  });
}

async function reviewedQualityCorrectionUsesOneTextAndNeverRepeatsTheCard() {
  await check({bubbleAfterClick:true,confirmHistory:true,skipPrimeCardIdentity:true},async({model,run})=>{
    const source=model.messages[0];
    model.conversation.correction_reply={eligible:true,source_event_id:source.dom_id,correction_of_intent_id:"original-reviewed-text"};
    const original={intent_id:"original-reviewed-text",status:"SENT",kind:"reply",source_event_id:source.dom_id,
      evidence:{usefulness_verified:true,useful:false,native_server_history:{status:"server_history_confirmed"}}};
    const card={intent_id:"original-confirmed-card",status:"SENT",kind:"card",source_event_id:source.dom_id};
    model.outbox.push(original,card);const originalSnapshot=JSON.stringify([original,card]);
    const result=await run({correctionOfIntentId:original.intent_id,sourceEventId:source.dom_id,freshSourceIds:new Set([source.dom_id])});
    assert.equal(result.state,"confirmed_correction_reply");assert.equal(result.card,null);
    assert.deepEqual(model.clicks.map(click=>click.operation),["text"]);assert.equal(model.cardMenus,0);
    const correction=model.outbox[2];assert.equal(correction.kind,"correction_reply");
    assert.equal(correction.payload.correction_of_intent_id,original.intent_id);
    assert.equal(correction.payload.source_message_text,source.raw_text);
    assert.equal(correction.evidence.usefulness_verified,undefined);assert.equal(correction.evidence.useful,undefined);
    assert.equal(correction.evidence.quality_assessment,"requires_independent_review");
    assert.equal(JSON.stringify([original,card]),originalSnapshot);
  });
}

async function qualityCorrectionRequiresExactEngineReviewSourceAndNoUnresolvedOutgoing() {
  for(const scenario of ["missing-review","wrong-original","wrong-source","unknown"]) {
    await check({bubbleAfterClick:true,confirmHistory:true,skipPrimeCardIdentity:true},async({model,run})=>{
      const source=model.messages[0];
      if(scenario!=="missing-review")model.conversation.correction_reply={eligible:true,source_event_id:source.dom_id,correction_of_intent_id:"original"};
      if(scenario==="unknown")model.outbox.push({intent_id:"original-card",status:"UNKNOWN"});
      await assert.rejects(run({correctionOfIntentId:scenario==="wrong-original"?"another":"original",
        sourceEventId:scenario==="wrong-source"?"another":source.dom_id,freshSourceIds:new Set([source.dom_id])}));
      assert.equal(model.clicks.length,0);assert.equal(model.cardMenus,0);
    });
  }
}

async function specialTextBindsTheEngineApprovedPriorCardUnknownAndPreservesIt() {
  for(const correction of [false,true]) {
    const options={bubbleAfterClick:true,confirmHistory:true,skipPrimeCardIdentity:true,
      leadFields:[{label:"名片",value:correction?"企业微信 - 未添加企微":"企业微信 - 已添加企微"},{label:"留资卡",value:"无提交留资卡"}]};
    await check(options,async({model,run})=>{
      const source=model.messages[0],prior={intent_id:"old-card-unknown",kind:"card",status:"UNKNOWN",payload:{operation:"native_card"}};
      model.outbox.push(prior);const snapshot=JSON.stringify(prior);
      Object.assign(model.conversation,{state:correction?"ACTIVE":"STOPPED",...(correction?{}:{stop_reason:"WECHAT_VERIFIED"}),
        [correction?"correction_reply":"service_reply"]:{eligible:true,source_event_id:source.dom_id,
          prior_unknown_hold_ids:[prior.intent_id],...(correction?{correction_of_intent_id:"reviewed-original"}:{})}});
      const result=await run({...(correction?{correctionOfIntentId:"reviewed-original"}:{textOnlyService:true}),
        sourceEventId:source.dom_id,freshSourceIds:new Set([source.dom_id])});
      assert.equal(result.card,null);assert.deepEqual(model.clicks.map(click=>click.operation),["text"]);
      assert.deepEqual(model.outbox[1].payload.prior_unknown_hold_ids,[prior.intent_id]);
      assert.equal(JSON.stringify(prior),snapshot);assert.equal(model.cardMenus,0);
    });
  }
}

async function activeCustomerQuestionUsesStrictTextServiceAndNeverOpensTheCardMenu() {
  await check({bubbleAfterClick:true,confirmHistory:true,skipPrimeCardIdentity:true},async({model,run})=>{
    const source=model.messages[0];
    model.conversation.service_reply={eligible:true,source_event_id:source.dom_id,prior_unknown_hold_ids:[]};
    const result=await run({textOnlyService:true,sourceEventId:source.dom_id,freshSourceIds:new Set([source.dom_id])});
    assert.equal(result.state,"confirmed_service_reply");assert.equal(result.card,null);
    assert.deepEqual(model.clicks.map(click=>click.operation),["text"]);assert.equal(model.cardMenus,0);
    assert.equal(model.outbox.length,1);assert.equal(model.outbox[0].kind,"service_reply");
    assert.equal(model.outbox[0].evidence.native_server_history.status,"server_history_confirmed");
    assert.equal(model.outbox[0].evidence.usefulness_verified,undefined);assert.equal(model.conversation.state,"ACTIVE");
  });
}

async function verifiedLeadServiceSendsOnlyItsExactCustomerQuestionText() {
  await check({bubbleAfterClick:true,confirmHistory:true,skipPrimeCardIdentity:true,
    leadFields:[{label:"名片",value:"企业微信 - 已添加企微"},{label:"留资卡",value:"无提交留资卡"}]},async({model,run})=>{
    const source=model.messages[0];
    Object.assign(model.conversation,{state:"STOPPED",stop_reason:"WECHAT_VERIFIED",
      service_reply:{eligible:true,source_event_id:source.dom_id}});
    const result=await run({textOnlyService:true,sourceEventId:source.dom_id,freshSourceIds:new Set([source.dom_id])});
    assert.equal(result.state,"confirmed_service_reply");assert.equal(result.card,null);
    assert.deepEqual(model.clicks.map(click=>click.operation),["text"]);assert.equal(model.cardMenus,0);
    assert.equal(model.outbox.length,1);assert.equal(model.outbox[0].kind,"service_reply");
    assert.equal(model.outbox[0].payload.text_only_service,true);
    assert.equal(model.outbox[0].payload.source_message_text,source.raw_text);
    assert.equal(model.outbox[0].evidence.reception_event_id,undefined);
    assert.equal(model.outbox[0].evidence.usefulness_verified,undefined);assert.equal(model.outbox[0].evidence.useful,undefined);
    assert.equal(model.conversation.state,"STOPPED");
  });
}

async function unknownServiceReconciliationNeverStartsACompanionCard() {
  const options={bubbleAfterClick:true,confirmHistory:false,skipPrimeCardIdentity:true,
    leadFields:[{label:"名片",value:"企业微信 - 已添加企微"},{label:"留资卡",value:"无提交留资卡"}]};
  await check(options,async({model,run,reconcile})=>{
    const source=model.messages[0];Object.assign(model.conversation,{state:"STOPPED",stop_reason:"WECHAT_VERIFIED",
      service_reply:{eligible:true,source_event_id:source.dom_id}});
    await run({textOnlyService:true,sourceEventId:source.dom_id,freshSourceIds:new Set([source.dom_id])});
    assert.equal(model.outbox[0].status,"UNKNOWN");options.confirmHistory=true;
    const result=await reconcile({reconcileOnly:false});
    assert.equal(result.status,"SENT");assert.equal(result.customer_send_performed,false);
    assert.equal(model.clicks.length,1);assert.equal(model.cardMenus,0);
    assert.equal(model.outbox[0].evidence.usefulness_verified,undefined);
  });
}

async function postLeadServiceCannotSkipUnknownOrChangeQuestionAfterClaim() {
  for(const scenario of ["unknown","source-mismatch","late-question-edit"]) {
    const options={bubbleAfterClick:true,confirmHistory:true,leadFields:[
      {label:"名片",value:"企业微信 - 已添加企微"},{label:"留资卡",value:"无提交留资卡"}],
      beforeScope:model=>{if(scenario==="late-question-edit"&&model.scopeReads===4)model.messages[0].raw_text="changed customer question";}};
    await check(options,async({model,run})=>{
      const source=model.messages[0];Object.assign(model.conversation,{state:"STOPPED",stop_reason:"WECHAT_VERIFIED",
        service_reply:{eligible:true,source_event_id:source.dom_id}});
      if(scenario==="unknown")model.outbox.push({intent_id:"original-unknown",status:"UNKNOWN"});
      await assert.rejects(run({textOnlyService:true,sourceEventId:scenario==="source-mismatch"?"other-source":source.dom_id,
        freshSourceIds:new Set([source.dom_id])}));
      assert.equal(model.clicks.length,0);assert.equal(model.cardMenus,0);
      if(scenario==="unknown")assert.equal(model.outbox[0].status,"UNKNOWN");
    });
  }
}

async function reconciliationLeaseCannotBindAnotherUnknownIntentOrNativeId() {
  for(const expected of [{expectedIntentId:"another-intent"},{expectedNativeMessageId:"jarvis-msg-other-pair"},
    {expectedRawId:"another-raw-id"}]) {
    const options={bubbleAfterClick:true,historyByOperation:{text:true,native_card:false}};
    await check(options,async({model,run,reconcile})=>{
      await run();const card=model.outbox.find(row=>row.payload.operation==="native_card");
      const refreshes=model.historyRefreshes;options.historyByOperation.native_card=true;
      await assert.rejects(reconcile(expected),/original_reconciliation_intent_mismatch/);
      assert.equal(card.status,"UNKNOWN");assert.equal(model.historyRefreshes,refreshes);
      assert.equal(model.rpc.filter(call=>call.method==="reconcile").length,0);
    });
  }
}
async function convertedLeadBlocks() {
  await check({leadFields:[{label:"名片",value:"企业微信 - 已添加企微"},
    {label:"留资卡",value:"无提交留资卡"}]},async({model,run})=>{
    await assert.rejects(run(),/terminal_stopped/);
    assert.equal(model.clicks.length,0);assert.equal(model.conversation.stop_reason,"WECHAT_VERIFIED");
  });
}
async function politeRefusalBlocks() {
  await check({refusal:"谢谢，不用了，请不要再联系我"},async({model,run})=>{
    await assert.rejects(run(),/terminal_stopped/);
    assert.equal(model.clicks.length,0);assert.equal(model.cardMenus,0);assert.equal(model.conversation.stop_reason,"REFUSED");
  });
}
async function businessNeedDescriptionIsNotARefusal() {
  await check({initialQuestion:"不需要贴标，想了解美国仓的报价",bubbleAfterClick:true},async({model,run})=>{
    assert.equal((await run()).state,"paused_unknown");assert.equal(model.clicks.length,1);
    assert.equal(model.rpc.filter(call=>call.method==="ingest" && call.params.event.type==="REFUSED").length,0);
    assert.equal(model.conversation.state,"ACTIVE");
  });
}
async function supersededHistoricalRefusalDoesNotBlockCurrentQuestion() {
  await check({historicalRefusal:"不用了",initialQuestion:"现在想再了解海外仓报价",bubbleAfterClick:true},async({model,run})=>{
    assert.equal((await run()).state,"paused_unknown");assert.equal(model.clicks.length,1);
    assert.equal(model.rpc.filter(call=>call.method==="ingest" && call.params.event.type==="REFUSED").length,0);
  });
}
async function lateRefusalPersistsBeforeBeginSubmit() {
  await check({beforeScope:model=>{if(model.scopeReads===4) model.messages.push(message("late-refusal","left","请不要再联系我",Date.now()));}},async({model,run})=>{
    await assert.rejects(run(),/terminal_stopped/);assert.equal(model.conversation.stop_reason,"REFUSED");
    assert.equal(model.clicks.length,0);assert.equal(model.rpc.filter(call=>call.method==="begin_submit").length,0);
    assert.equal(model.outbox.length,1);assert.equal(model.outbox[0].status,"CANCELLED");
    assert.deepEqual(model.confirmations,[]);
  });
}
async function lateNativeAddedStatusPersistsBeforeBeginSubmit() {
  await check({beforeScope:model=>{if(model.scopeReads===4) model.leadFields[0].value="企业微信 - 已添加企微";}},async({model,run})=>{
    await assert.rejects(run(),/terminal_stopped/);assert.equal(model.conversation.stop_reason,"WECHAT_VERIFIED");
    assert.equal(model.clicks.length,0);assert.equal(model.rpc.filter(call=>call.method==="begin_submit").length,0);
    assert.equal(model.outbox[0].status,"CANCELLED");assert.deepEqual(model.confirmations,[]);
  });
}
async function submittedLeadRequiresReviewWithoutInventingVerifiedLead() {
  await check({leadFields:[{label:"名片",value:"企业微信 - 未添加企微"},{label:"留资卡",value:"已提交留资卡"}]},async({model,run})=>{
    await assert.rejects(run(),/requires_lead_review/);assert.equal(model.clicks.length,0);
    assert.equal(model.rpc.filter(call=>call.method==="prepare" || call.method==="ingest").length,0);
    assert.equal(model.conversation.state,"ACTIVE");
  });
}
async function terminalDoesNotClearOriginalUnknown() {
  await check({refusal:"谢谢，不用了，请不要再联系我"},async({model,run})=>{
    const original={intent_id:"original-unknown",status:"UNKNOWN",submitted_at:Date.now()/1000-10,payload:{operation:"text"}};
    model.outbox.push(original);
    await assert.rejects(run(),/terminal_stopped/);assert.equal(model.conversation.state,"STOPPED");
    assert.equal(original.status,"UNKNOWN");assert.equal(model.clicks.length,0);assert.deepEqual(model.confirmations,[]);
  });
}
async function cardPanelRetainsFreshExactNegativeLeadProof() {
  await check({bubbleAfterClick:true,confirmHistory:true,cardPanelOmitsLeadFields:true},async({model,run})=>{
    assert.equal((await run()).state,"confirmed");assert.equal(model.cardMenus,1);
    assert.deepEqual(model.clicks.map(click=>click.operation),["text","native_card"]);
    assert.deepEqual(model.confirmations,["sent","sent"]);
  });
}
async function newlyObservedInboundBlocks() {
  await check({beforeScope:model=>{
    if(model.scopeReads===3) model.messages.push(message("new-question","left","SYNTHETIC_NEW_QUESTION",Date.now()));
  }},async({model,run})=>{
    await assert.rejects(run(),/new_customer_context_requires_new_round/);
    assert.equal(model.clicks.length,0);
  });
}
async function changedUIDAtSubmissionBlocks() {
  await check({beforeSubmit:model=>{model.activeUID=OTHER;}},async({model,run})=>{
    await assert.rejects(run(),/fixture_locator_not_actionable/);
    assert.equal(model.clicks.length,0);assert.deepEqual(model.confirmations,["unknown"]);
  });
}
async function inboundAtSubmissionBlocks() {
  await check({beforeSubmit:model=>{
    model.messages.push(message("racing-question","left","SYNTHETIC_NEW_QUESTION",Date.now()));
  }},async({model,run})=>{
    await assert.rejects(run(),/fixture_locator_not_actionable/);
    assert.equal(model.clicks.length,0);assert.deepEqual(model.confirmations,["unknown"]);
  });
}
async function cancellationAfterBeginBlocks() {
  await check({beforeSubmit:model=>{model.current=false;}},async({model,run})=>{
    await assert.rejects(run(),/reception_round_cancelled/);
    assert.equal(model.clicks.length,0);assert.deepEqual(model.confirmations,["unknown"]);
  });
}
async function optimisticBubbleWithoutHistoryStopsCard() {
  await check({bubbleAfterClick:true},async({model,run})=>{
    let result;
    try {result=await run();}
    finally {assert.equal(model.cardMenus,0,"UNKNOWN must stop before opening the card menu");}
    assert.equal(model.clicks.length,1);assert.equal(model.clicks[0].uid,UID);
    assert(model.historyChecks>=2);assert.equal(model.historyRefreshes,1);
    assert.deepEqual(model.confirmations,["unknown"]);
    assert.equal(result.state,"paused_unknown");assert.equal(result.text.status,"UNKNOWN");
    assert.equal(result.card,null);
  });
}

async function existingFreshHistorySkipsRefreshAndConfirmsBothOperations() {
  await check({bubbleAfterClick:true,confirmHistory:true},async({model,run})=>{
    const result=await run({refreshHistory:async()=>{throw Error('must_not_refresh_existing_exact_history');}});
    assert.equal(result.state,'confirmed');assert.deepEqual(model.confirmations,['sent','sent']);
    assert.equal(model.historyRefreshes,0);assert.equal(model.historyChecks,2);
    assert.deepEqual(model.clicks.map(row=>row.operation),['text','native_card']);
  });
}

async function failedRefreshKeepsMatchedNativeIdAndFullFailureWithoutRetry() {
  await check({bubbleAfterClick:true},async({model,run})=>{
    const detail='synthetic native refresh timeout: '+ 'x'.repeat(350)+' exact obstruction retained';
    let refreshes=0;
    await assert.rejects(run({refreshHistory:async params=>{
      refreshes++;assert.equal(params.uid,UID);assert.equal(params.accountId,ACCOUNT);
      assert.equal(params.operation,'text');throw Error(detail);
    }}),/synthetic native refresh timeout/);
    const row=model.outbox[0],outbound=model.messages.find(message=>message.message_id==='outbound-1');
    assert.equal(refreshes,1);assert.equal(model.clicks.length,1);assert.equal(model.outbox.length,1);
    assert.equal(row.status,'UNKNOWN');assert.deepEqual(model.confirmations,['unknown']);
    assert.equal(model.cardMenus,0);assert.equal(row.evidence.native_message_id,outbound.native_dom_id);
    assert.equal(row.evidence.native_message_raw_id,outbound.message_id);
    assert.equal(row.evidence.confirmation_phase,'refresh_current_native_history');
    assert.equal(row.evidence.reason,detail);assert.equal(row.evidence.native_ack.status,'unknown');
    assert.equal(row.evidence.native_server_history.status,'unknown');
    assert.equal(row.evidence.usefulness_verified,undefined);assert.equal(row.evidence.native_wecom_card_confirmed,undefined);
  });
}

async function currentConversationRefreshStillRequiresExactHistoryForEachOperation() {
  await check({bubbleAfterClick:true,historyAfterRefresh:true},async({model,run})=>{
    const result=await run();assert.equal(result.state,'confirmed');
    assert.equal(model.historyRefreshes,2);assert.deepEqual(model.confirmations,['sent','sent']);
    assert.deepEqual(model.clicks.map(row=>row.operation),['text','native_card']);
    for(const row of model.outbox){
      assert.equal(row.evidence.native_server_history.status,'server_history_confirmed');
      assert.equal(row.evidence.native_history_refresh.elapsed_ms,5000);
      assert.equal(row.evidence.native_history_refresh.confirms_send,false);
    }
  });
}

// This is an explicit synthetic timing hypothesis, not a captured production
// failure. Text confirmation uses the real passive history parser/verifier;
// only the surrounding browser/Engine and companion-card boundary are fixtures.
async function nativeTextHistoryAfterRefresh(timestampCorrectionMs,{mutateUI,mutateServer,expectedError,expectUnknown=false}={}) {
  await check({bubbleAfterClick:true,realNativeTextHistory:true,historyByOperation:{native_card:true}},
    async({page,model,run})=>{
      let refreshedTimestamp,originalTimestamp,originalNativeId;
      const execute=()=>run({refreshHistory:async params=>{
        assert.equal(params.operation,'text');
        const outbound=model.messages.find(message=>message.message_id==='outbound-1');
        originalTimestamp=Number(outbound.raw_timestamp);originalNativeId=outbound.native_dom_id;
        refreshedTimestamp=originalTimestamp+timestampCorrectionMs;
        outbound.raw_timestamp=String(refreshedTimestamp);
        const api=nativeRequire('./native_history_receipt.cjs').attach(page),before=api.records().length;
        const data={success:true,code:0,data:{messages:[{
          sixin_message:{id:originalNativeId.slice('jarvis-msg-'.length),sender_id:ACCOUNT,receiver_id:UID,
            content:TEXT,created_at:refreshedTimestamp,message_type:'TEXT'},
          message_extension:{customer_user_id:UID}}]}};
        mutateUI?.(outbound,model);mutateServer?.(data.data.messages[0]);
        const request={url:()=>`https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg?customer_user_id=${UID}`,
          method:()=>'GET',response:async()=>({status:()=>200,body:async()=>Buffer.from(JSON.stringify(data))})};
        page.emit('request',request);page.emit('requestfinished',request);
        const deadline=Date.now()+500;
        while(api.records().length===before){assert(Date.now()<deadline,'native history fixture did not finish');await new Promise(resolve=>setTimeout(resolve,2));}
        assert.equal(api.records().at(-1).data.data.messages[0].sixin_message.id,originalNativeId.slice('jarvis-msg-'.length));
        return {action:'synthetic_same_uid_history_refresh',confirms_send:false,customer_send_performed:false};
      }});
      if(expectedError) {
        await assert.rejects(execute(),expectedError);
        assert.equal(model.outbox[0].status,'UNKNOWN');assert.deepEqual(model.confirmations,['unknown']);
        assert.equal(model.clicks.length,1);assert.equal(model.cardMenus,0);assert.equal(model.outbox.length,1);
        return;
      }
      const result=await execute();
      assert.equal(model.historyParams[0].uiTimestampMs,originalTimestamp);
      assert.equal(model.messages.find(message=>message.message_id==='outbound-1').native_dom_id,originalNativeId);
      if(expectUnknown) {
        assert.equal(result.text.status,'UNKNOWN');assert.deepEqual(model.confirmations,['unknown']);
        assert.equal(model.nativeTextHistoryResults.at(-1).status,'unknown');
        assert.equal(model.clicks.length,1);assert.equal(model.cardMenus,0);assert.equal(model.outbox.length,1);
        assert.equal(model.outbox[0].evidence.usefulness_verified,undefined);
        return;
      }
      assert.equal(result.text.status,'SENT',JSON.stringify(model.nativeTextHistoryResults.at(-1)));
      assert.equal(model.historyParams.filter(params=>params.operation==='text').at(-1).uiTimestampMs,refreshedTimestamp,
        'After a native refresh, strict verification must use the same native message timestamp from the refreshed scope');
      assert.equal(model.nativeTextHistoryResults.at(-1).status,'server_history_confirmed');
      assert.equal(model.outbox[0].evidence.native_server_history.status,'server_history_confirmed');
      assert.equal(model.outbox[0].evidence.original_ui_timestamp_ms,originalTimestamp);
      assert.equal(model.outbox[0].evidence.current_ui_timestamp_ms,refreshedTimestamp);
      assert.equal(model.clicks.filter(click=>click.operation==='text').length,1);
    });
}
async function realNativeTextHistoryWithStableTimestampConfirmsAfterRefresh() {
  await nativeTextHistoryAfterRefresh(0);
}
async function realNativeTextHistoryWithCorrectedTimestampUsesRefreshedSameId() {
  await nativeTextHistoryAfterRefresh(35);
}
async function refreshedNativeIdOrScopeCannotSubstituteForOriginalText() {
  await nativeTextHistoryAfterRefresh(35,{mutateUI:message=>{message.native_dom_id+='-different';},
    expectedError:/submitted_message_missing_after_native_history_refresh/});
  await nativeTextHistoryAfterRefresh(35,{mutateUI:(_message,model)=>{model.activeUID=OTHER;},
    expectedError:/fresh_customer_scope_required/});
}
async function refreshedNativeTextTypeOrContentChangeStaysUnknown() {
  for(const mutateUI of [message=>{message.raw_type='CARD';},message=>{message.raw_text=TEXT+' different';}])
    await nativeTextHistoryAfterRefresh(35,{mutateUI,expectedError:/submitted_message_changed_after_native_history_refresh/});
}
async function correctedUiTimestampStillRequiresExactNativeHistoryScopeTypeContentAndTime() {
  for(const mutateServer of [
    row=>{row.sixin_message.sender_id=OTHER;},row=>{row.sixin_message.receiver_id=OTHER;},
    row=>{row.message_extension.customer_user_id=OTHER;},row=>{row.sixin_message.message_type='CARD';},
    row=>{row.sixin_message.content=TEXT+' different';},row=>{row.sixin_message.created_at--;},
  ])await nativeTextHistoryAfterRefresh(35,{mutateServer,expectUnknown:true});
}

async function exactHistorySuccessDoesNotInventEntry() {
  await check({bubbleAfterClick:true,confirmHistory:true},async({model,run})=>{
    const result=await run();
    assert.equal(result.state,"confirmed");assert.deepEqual(model.confirmations,["sent","sent"]);
    assert.deepEqual(model.clicks.map(click=>click.operation),["text","native_card"]);
    assert.equal(model.historyChecks,2);assert.equal(result.full_five_second_acceptance,false);
    assert.equal(result.platform_entry_to_all_confirmed_ms,null);
    assert(model.rpc.filter(call=>call.method==="confirm").every(call=>
      !Object.hasOwn(call.params.evidence,"reception_event_id")));
  });
}

async function latestCustomerMessageLinksFreshPriorEntry() {
  await check({bubbleAfterClick:true,confirmHistory:true,entryBeforeSource:true,
    sourceAgeMs:100,freshSources:true},async({model,run})=>{
    const result=await run(),source=model.conversation.latest_event_id;
    const takeovers=model.rpc.filter(call=>call.method==="ingest" && call.params.event.type==="PLATFORM_TAKEOVER_CONFIRMED");
    assert.equal(takeovers.length,1);
    assert.equal(takeovers[0].params.event.evidence.source_event_id,model.entry.dom_id);
    const prepares=model.rpc.filter(call=>call.method==="prepare");
    assert.equal(prepares.length,2);assert(prepares.every(call=>call.params.source_event_id===source));
    assert.equal(prepares[0].params.kind,"reply");assert.equal(prepares[1].params.kind,"card");
    const confirmations=model.rpc.filter(call=>call.method==="confirm");
    assert.equal(confirmations.length,2);
    assert(confirmations.every(call=>call.params.evidence.reception_event_id===model.entry.dom_id));
    assert.equal(confirmations[1].params.evidence.expected_card_proof.expected_full_card_hash,"a".repeat(64));
    assert.equal(result.state,"confirmed");assert.equal(result.full_five_second_acceptance,true);
    assert(result.platform_entry_to_all_confirmed_ms>=0 && result.platform_entry_to_all_confirmed_ms<=5000);
  });
}

async function unobservedHistoricalEntryCannotEarnFreshCredit() {
  await check({bubbleAfterClick:true,confirmHistory:true,entryBeforeSource:true,
    sourceAgeMs:100},async({model,run})=>{
    const result=await run({freshSourceIds:new Set([model.conversation.latest_event_id])});
    assert.equal(result.state,"confirmed");assert.equal(result.full_five_second_acceptance,false);
    assert.equal(model.rpc.filter(call=>call.method==="ingest").length,0);
    assert(model.rpc.filter(call=>call.method==="confirm").every(call=>
      !Object.hasOwn(call.params.evidence,"reception_event_id")));
  });
}

async function futureClockCannotEarnNegativeLatencyCredit() {
  await check({bubbleAfterClick:true,confirmHistory:true,entryBeforeSource:true,
    sourceAgeMs:-400,freshSources:true},async({run})=>{
    const result=await run();
    assert.equal(result.state,"confirmed");assert.equal(result.full_five_second_acceptance,false);
  });
}

function draftInterruptedByNewMessage() {
  return fixture({bubbleAfterClick:true,beforeScope:model=>{
    if(model.interruptDraft && model.scopeReads===4) {
      model.interruptDraft=false;
      model.messages.push(message("superseding-question","left","SYNTHETIC_NEW_QUESTION",Date.now()));
    }
  },beforeStatus:model=>{if(model.changeUIDDuringStatus) model.activeUID=OTHER;}});
}
async function interruptAndAdvanceSource(test) {
  const {model,run}=test;model.interruptDraft=true;
  await assert.rejects(run(),/new_customer_context_requires_new_round/);
  assert.equal(model.draft,TEXT);assert.equal(model.outbox[0].submitted_at,null);
  assert.equal(model.clicks.length,0);
  const source=model.messages.find(m=>m.message_id==="superseding-question");
  model.conversation.latest_event_id=source.dom_id;
  model.conversation.latest_event_at=Number(source.raw_timestamp)/1000;
  model.outbox[0].status="CANCELLED";
}

async function exactNeverSubmittedOwnDraftCanBeReplaced() {
  const test=draftInterruptedByNewMessage();
  try {
    await interruptAndAdvanceSource(test);
    const result=await test.run();
    assert.equal(result.state,"paused_unknown");assert.deepEqual(test.model.fills,[TEXT,"",TEXT]);
    assert.equal(test.model.clicks.length,1);assert.equal(test.model.outbox[0].submitted_at,null);
  } finally {test.cleanup();}
}

async function humanEditedOwnDraftIsPreserved() {
  const test=draftInterruptedByNewMessage();
  try {
    await interruptAndAdvanceSource(test);test.model.draft="SYNTHETIC_HUMAN_EDIT";
    await assert.rejects(test.run(),/existing_operator_draft_preserved/);
    assert.equal(test.model.draft,"SYNTHETIC_HUMAN_EDIT");
    assert.deepEqual(test.model.fills,[TEXT]);assert.equal(test.model.clicks.length,0);
  } finally {test.cleanup();}
}

async function switchedCustomerDraftCannotBeCleared() {
  const test=draftInterruptedByNewMessage();
  try {
    await interruptAndAdvanceSource(test);test.model.changeUIDDuringStatus=true;
    await assert.rejects(test.run());
    assert.equal(test.model.draft,TEXT);assert.deepEqual(test.model.fills,[TEXT]);
    assert.equal(test.model.clicks.length,0);
  } finally {test.cleanup();}
}

async function submittedOwnDraftIsNeverCleared() {
  await check({beforeSubmit:model=>{if(model.cancelAtSubmit) model.current=false;}},async({model,run})=>{
    model.cancelAtSubmit=true;
    await assert.rejects(run(),/reception_round_cancelled/);
    assert.equal(model.outbox[0].status,"UNKNOWN");assert(model.outbox[0].submitted_at!==null);
    model.current=true;model.cancelAtSubmit=false;
    const next=message("after-unknown","left","SYNTHETIC_NEW_QUESTION",Date.now());model.messages.push(next);
    model.conversation.latest_event_id=next.dom_id;model.conversation.latest_event_at=Number(next.raw_timestamp)/1000;
    await assert.rejects(run(),/existing_operator_draft_preserved/);
    assert.equal(model.draft,TEXT);assert.deepEqual(model.fills,[TEXT]);assert.equal(model.clicks.length,0);
  });
}

async function expiredNeverSubmittedOwnDraftCanBeReplaced() {
  await check({bubbleAfterClick:true,beforeScope:model=>{
    if(model.cancelBeforeBegin && model.scopeReads===4) {model.current=false;model.cancelBeforeBegin=false;}
  }},async({model,run})=>{
    model.cancelBeforeBegin=true;
    await assert.rejects(run(),/reception_round_cancelled/);
    assert.equal(model.outbox[0].submitted_at,null);model.outbox[0].expires_at=Date.now()/1000-1;
    model.current=true;
    const result=await run();assert.equal(result.state,"paused_unknown");
    assert.deepEqual(model.fills,[TEXT,"",TEXT]);assert.equal(model.clicks.length,1);
  });
}

async function effectiveCardDiagnosticIsBoundPersistedAndDetached() {
  await check({bubbleAfterClick:true,confirmHistory:true},async({model,run})=>{
    const result=await run(),card=model.outbox.find(row=>row.payload.operation==="native_card");
    assert.equal(result.card.status,"SENT");assert.equal(model.diagnosticArms.length,1);
    assert.equal(model.diagnosticArms[0].intentId,card.intent_id);
    assert.equal(model.diagnosticBegins.length,1);
    assert.equal(model.diagnosticBegins[0],Date.parse(result.card.clicked_at_utc));
    assert.equal(card.evidence.native_card_request_diagnostics.status,"unknown");
    assert.equal(card.evidence.native_card_request_diagnostics.can_confirm_send,false);
    assert.equal(card.evidence.native_server_history.status,"server_history_confirmed");
    assert.equal(card.evidence.expected_card_proof.expected_full_card_hash,"a".repeat(64));
    const ordered=["diagnostic.arm","rpc.begin_submit:native_card","diagnostic.begin",
      "ui.click:native_card","diagnostic.report","rpc.confirm:native_card:sent","diagnostic.detach"];
    const indexes=ordered.map(event=>model.events.indexOf(event));
    assert(indexes.every((index,i)=>index>=0 && (!i || index>indexes[i-1])));
    assert.equal(model.diagnosticDetaches,1);
  });
}

async function diagnosticSchemaNeverReplacesUnknownHistory() {
  for(const diagnosticReport of [
    {status:"unknown",schema_verified:false,can_confirm_send:false,reason:"wrong_native_schema"},
    // Even an accidentally overconfident diagnostic dependency has no authority.
    {status:"server_history_confirmed",schema_verified:true,can_confirm_send:true},
  ]) {
    await check({bubbleAfterClick:true,historyByOperation:{text:true,native_card:false},diagnosticReport},async({model,run})=>{
      const result=await run(),card=model.outbox.find(row=>row.payload.operation==="native_card");
      assert.equal(result.state,"paused_unknown");assert.equal(result.card.status,"UNKNOWN");
      assert.equal(card.evidence.native_server_history.status,"unknown");
      assert.equal(card.evidence.native_card_request_diagnostics.status,diagnosticReport.status);
      assert.equal(card.evidence.native_wecom_card_confirmed,undefined);
      assert.deepEqual(model.confirmations,["sent","unknown"]);
      assert.equal(model.clicks.length,2);assert.equal(model.outbox.length,2);
      assert.equal(model.diagnosticDetaches,1);
    });
  }
}

async function diagnosticDetachesOnPostSubmitCancellation() {
  await check({bubbleAfterClick:true,confirmHistory:true,beforeSubmit:(model,row)=>{
    if(row.payload.operation==="native_card") model.current=false;
  }},async({model,run})=>{
    await assert.rejects(run(),/reception_round_cancelled/);
    const card=model.outbox.find(row=>row.payload.operation==="native_card");
    assert.equal(card.status,"UNKNOWN");assert.equal(model.clicks.length,1);
    assert.equal(model.diagnosticArms.length,1);assert.equal(model.diagnosticBegins.length,0);
    assert.equal(card.evidence.native_card_request_diagnostics.can_confirm_send,false);
    assert.equal(model.diagnosticDetaches,1);
  });
}

async function diagnosticDetachesAndPersistsOnClickFailure() {
  await check({bubbleAfterClick:true,confirmHistory:true,failCardClick:true},async({model,run})=>{
    await assert.rejects(run(),/synthetic_card_click_timeout/);
    const card=model.outbox.find(row=>row.payload.operation==="native_card");
    assert.equal(card.status,"UNKNOWN");assert.deepEqual(model.confirmations,["sent","unknown"]);
    assert.equal(model.diagnosticBegins.length,1);assert.equal(model.diagnosticDetaches,1);
    assert.equal(card.evidence.native_card_request_diagnostics.status,"unknown");
    assert.equal(model.events.filter(event=>event==="ui.click:native_card").length,1);
  });
}

async function unavailableDiagnosticStillRequiresExactHistory() {
  await check({bubbleAfterClick:true,confirmHistory:true,diagnosticArmThrows:true},async({model,run})=>{
    const result=await run(),card=model.outbox.find(row=>row.payload.operation==="native_card");
    assert.equal(result.card.status,"SENT");assert.equal(model.diagnosticArms.length,1);
    assert.equal(card.evidence.native_card_request_diagnostics.phase,"diagnostic_unavailable");
    assert.equal(card.evidence.native_card_request_diagnostics.can_confirm_send,false);
    assert.equal(card.evidence.native_server_history.status,"server_history_confirmed");
  });
}

async function reconcileUsesOnlyKnownOriginalWithoutSending() {
  const options={bubbleAfterClick:true,entryBeforeSource:true,freshSources:true,historyByOperation:{text:true,native_card:false},identityFullHash:"b".repeat(64)};
  await check(options,async({model,run,reconcile})=>{
    await run();const card=model.outbox.find(row=>row.payload.operation==="native_card");
    const raw=card.evidence.native_message_raw_id,native=card.evidence.native_message_id;
    const diagnostic=card.evidence.native_card_request_diagnostics;
    assert.equal(card.status,"UNKNOWN");
    const later=message("another-card","right","企业微信\n运去哪海外仓（企微）",Date.now());
    later.raw_type="CARD";later.native_business_card_candidate=true;model.messages.push(later);
    const clicks=model.clicks.length,prepares=model.rpc.filter(call=>call.method==="prepare").length;
    options.historyByOperation.native_card=true;
    const result=await reconcile();
    assert.equal(result.status,"SENT");assert.equal(result.customer_send_performed,false);
    assert.equal(card.evidence.native_message_raw_id,raw);assert.equal(card.evidence.native_message_id,native);
    assert.equal(card.evidence.reception_event_id,model.entry.dom_id);
    assert.deepEqual(card.evidence.native_card_request_diagnostics,diagnostic);
    assert.equal(card.evidence.expected_card_proof.expected_full_card_hash,"b".repeat(64));
    assert.equal(card.evidence.expected_card_proof.comparison_hash,"a".repeat(64));
    assert.equal(model.historyParams.at(-1).messageId,raw);
    assert.equal(model.historyParams.at(-1).nativeMessageId,native.slice("jarvis-msg-".length));
    assert.equal(model.clicks.length,clicks);assert.equal(model.rpc.filter(call=>call.method==="prepare").length,prepares);
    assert.equal(model.rpc.filter(call=>call.method==="reconcile").length,1);
  });
}

async function reconcileCannotGuessMissingOriginalId() {
  const options={bubbleAfterClick:true,historyByOperation:{text:true,native_card:false}};
  await check(options,async({model,run,reconcile})=>{
    await run();const card=model.outbox.find(row=>row.payload.operation==="native_card");
    delete card.evidence.native_message_raw_id;
    options.historyByOperation.native_card=true;
    await assert.rejects(reconcile(),/original_native_message_id_required_for_reconciliation/);
    assert.equal(card.status,"UNKNOWN");assert.equal(model.clicks.length,2);
    assert.equal(model.rpc.filter(call=>call.method==="reconcile").length,0);
  });
}

async function reconcileCannotUseLaterSimilarCard() {
  const options={bubbleAfterClick:true,historyByOperation:{text:true,native_card:false}};
  await check(options,async({model,run,reconcile})=>{
    await run();const card=model.outbox.find(row=>row.payload.operation==="native_card");
    model.messages=model.messages.filter(m=>m.message_id!==card.evidence.native_message_raw_id);
    const later=message("later-card","right","企业微信\n运去哪海外仓（企微）",Date.now());
    later.raw_type="CARD";later.native_business_card_candidate=true;model.messages.push(later);
    options.historyByOperation.native_card=true;
    await assert.rejects(reconcile(),/unique_original_text_message_required/);
    assert.equal(card.status,"UNKNOWN");assert.equal(model.rpc.filter(call=>call.method==="reconcile").length,0);
    assert.equal(model.clicks.length,2);
  });
}

async function reconcileCannotSwapPairForSameRawId() {
  const options={bubbleAfterClick:true,historyByOperation:{text:true,native_card:false}};
  await check(options,async({model,run,reconcile})=>{
    await run();const card=model.outbox.find(row=>row.payload.operation==="native_card");
    const original=model.messages.find(m=>m.message_id===card.evidence.native_message_raw_id);
    original.message_pair_prefix=UID+"."+ACCOUNT+".";
    original.native_scope_id=original.message_pair_prefix+original.message_id;
    original.dom_id="id_"+original.native_scope_id;original.native_dom_id="jarvis-msg-"+original.native_scope_id;
    options.historyByOperation.native_card=true;
    await assert.rejects(reconcile(),/unique_original_text_message_required/);
    assert.equal(card.status,"UNKNOWN");assert.equal(model.rpc.filter(call=>call.method==="reconcile").length,0);
    assert.equal(model.clicks.length,2);
  });
}
async function reconcileCompanionRespectsCurrentDispatchConfiguration() {
  for(const patch of [{live_dispatch_enabled:false},{browser:"iab"},{account_id:OTHER}]) {
    const options={bubbleAfterClick:true,entryBeforeSource:true,freshSources:true,
      historyByOperation:{text:false,native_card:false}};
    await check(options,async({model,run,reconcile,setConfig})=>{
      const result=await run();assert.equal(result.text.status,"UNKNOWN");
      const original=model.outbox[0],clicks=model.clicks.length;
      const prepares=model.rpc.filter(call=>call.method==="prepare").length;
      setConfig(patch);options.historyByOperation.text=true;
      await assert.rejects(reconcile({reconcileOnly:false}),/live_dispatch_disabled|configured_account_mismatch/);
      assert.equal(original.status,"SENT","readonly original history reconciliation remains available");
      assert.equal(original.evidence.reception_event_id,model.entry.dom_id);
      assert.equal(model.rpc.filter(call=>call.method==="reconcile").length,1);
      assert.equal(model.rpc.filter(call=>call.method==="prepare").length,prepares);
      assert.equal(model.clicks.length,clicks);assert.equal(model.outbox.length,1);
    });
  }
}
async function readOnlyReconcileIgnoresDisabledDispatchWithoutSending() {
  const options={bubbleAfterClick:true,entryBeforeSource:true,freshSources:true,
    historyByOperation:{text:false,native_card:false}};
  await check(options,async({model,run,reconcile,setConfig})=>{
    await run();const original=model.outbox[0],clicks=model.clicks.length;
    setConfig({live_dispatch_enabled:false,browser:"iab",account_id:OTHER});
    options.historyByOperation.text=true;
    const result=await reconcile({reconcileOnly:true});
    assert.equal(result.status,"SENT");assert.equal(result.customer_send_performed,false);
    assert.equal(original.evidence.reception_event_id,model.entry.dom_id);
    assert.equal(model.clicks.length,clicks);assert.equal(model.cardMenus,0);
    assert.equal(model.outbox.length,1);
  });
}

async function realDomAiOverlayAndDisabledTrackedParentRequireOneTakeoverBeforeSend() {
  await check({domMode:true,aiOverlay:true,headerDisabled:true,unrelatedManualRoot:true,
    bubbleAfterClick:true,confirmHistory:true},async({model,run})=>{
    const result=await run();
    assert.equal(result.state,"confirmed");assert.equal(model.takeoverClicks,1);
    assert.deepEqual(model.clicks.map(item=>item.operation),["text","native_card"]);
    assert(model.events.indexOf("ui.takeover")<model.events.indexOf("rpc.begin_submit:text"));
    assert(model.events.indexOf("ui.trial:text")<model.events.indexOf("rpc.begin_submit:text"));
    assert(model.events.indexOf("ui.trial:native_card")<model.events.indexOf("rpc.begin_submit:native_card"));
  });
}
async function takeOverOnlyPreservesOriginalUnknownAndDraftWithoutCreatingBusinessEvents() {
  await check({domMode:true,aiOverlay:true,headerDisabled:true,draft:TEXT},async({model,takeOver})=>{
    const original={intent_id:"existing-original-unknown",status:"UNKNOWN",submitted_at:1};model.outbox.push(original);
    const result=await takeOver();
    assert.equal(result.state,"native_manual_mode_confirmed");assert.equal(result.taken_over,true);
    assert.equal(result.account_id,ACCOUNT);assert.equal(result.conversation_id,UID);
    assert.equal(result.before_mode.manual,false);assert.equal(result.before_mode.input_ready,true);
    assert.equal(result.before_mode.overlay_visible,true);assert.equal(result.before_mode.manual_switch_enabled,false);
    assert.equal(result.after_mode.manual,true);assert.equal(result.after_mode.overlay_visible,false);
    assert.equal(result.after_mode.manual_switch_enabled,true);assert.equal(result.customer_send_performed,false);
    assert.equal(result.full_five_second_acceptance,false);assert.equal(model.takeoverClicks,1);
    assert.equal(model.draft,TEXT);assert.equal(original.status,"UNKNOWN");assert.equal(model.outbox.length,1);
    assert.equal(model.rpc.length,0);assert.equal(model.clicks.length,0);assert.equal(model.fills.length,0);
    assert(!JSON.stringify(result).includes(TEXT));
  });
}
async function takeOverOnlyAlreadyManualDoesNotClickAndCancellationCannotTakeOver() {
  await check({domMode:true},async({model,takeOver})=>{
    assert.equal((await takeOver()).takeover_clicked,false);assert.equal(model.takeoverClicks,0);
    model.aiOverlay=true;model.headerDisabled=true;model.takeoverVisible=true;model.current=false;
    await assert.rejects(takeOver(),/reception_round_cancelled/);
    assert.equal(model.takeoverClicks,0);assert.equal(model.rpc.length,0);
  });
}
async function disabledActualHeaderButtonCannotBeProvedManualByItsVisibleTrackingDiv() {
  await check({domMode:true,headerDisabled:true},async({model,run})=>{
    await assert.rejects(run(),/explicit_native_takeover_required/);
    assert.equal(model.takeoverClicks,0);assert.equal(model.outbox.length,0);assert.equal(model.clicks.length,0);
  });
}
async function overlayOrTakeoverEntryLeftVisibleCannotPassAfterOneTakeoverClick() {
  for(const options of [{overlayPersists:true},{takeoverPersists:true},{headerStaysDisabled:true}]){
    await check({domMode:true,aiOverlay:true,headerDisabled:true,...options},async({model,run})=>{
      await assert.rejects(run(),/native_manual_mode_not_confirmed/);
      assert.equal(model.takeoverClicks,1);assert.equal(model.outbox.length,0);assert.equal(model.clicks.length,0);
      assert.equal(model.rpc.filter(item=>item.method==="begin_submit").length,0);
    });
  }
}
async function aiReturnAfterFillStopsBeforeDurableSubmission() {
  await check({domMode:true,beforeMode:model=>{if(model.fills.length){model.aiOverlay=true;model.takeoverVisible=true;model.headerDisabled=true;}}},
    async({model,run})=>{
      await assert.rejects(run(),/native_manual_mode_not_confirmed/);
      assert.equal(model.draft,TEXT);assert.equal(model.outbox[0].status,"CLAIMED");
      assert.equal(model.outbox[0].submitted_at,null);assert.equal(model.clicks.length,0);assert.equal(model.takeoverClicks,0);
      assert.equal(model.rpc.filter(item=>item.method==="begin_submit"||item.method==="confirm").length,0);
    });
}
async function actionabilityFailureAndAiReturnDuringTrialNeverBecomeSubmittingOrUnknown() {
  for(const options of [{trialFails:true},{afterTrial:model=>{model.aiOverlay=true;model.headerDisabled=true;model.takeoverVisible=true;}}]){
    await check({domMode:true,...options},async({model,run})=>{
      await assert.rejects(run(),/synthetic_actionability_failed_before_submit|native_manual_mode_not_confirmed/);
      assert.deepEqual(model.trials,["text"]);assert.equal(model.outbox[0].status,"CLAIMED");
      assert.equal(model.outbox[0].submitted_at,null);assert.equal(model.clicks.length,0);
      assert.equal(model.rpc.filter(item=>item.method==="begin_submit"||item.method==="confirm").length,0);
    });
  }
}
async function newInboundDuringTrialCannotSubmitAnOldDraft() {
  await check({domMode:true,afterTrial:model=>model.messages.push(message("new-during-trial","left","new actual context",Date.now()))},
    async({model,run})=>{
      await assert.rejects(run(),/new_customer_context_requires_new_round/);
      assert.equal(model.outbox[0].status,"CLAIMED");assert.equal(model.outbox[0].submitted_at,null);
      assert.equal(model.clicks.length,0);assert.equal(model.rpc.filter(item=>item.method==="begin_submit").length,0);
    });
}

async function observedNativeHintAfterConfirmedTextAllowsTheCardRound() {
  await check({bubbleAfterClick:true,confirmHistory:true,afterOpenCardMenu:model=>{
    const hint=message('quota-rule','center','对方关注或回复你之前，24小时内最多只能发1条文字消息',Date.now());
    hint.raw_type='HINT';model.messages.push(hint);
  }},async({model,run})=>{
    const result=await run();
    assert.equal(result.state,'confirmed');assert.deepEqual(model.confirmations,['sent','sent']);
    assert.deepEqual(model.clicks.map(row=>row.operation),['text','native_card']);
    assert.equal(model.outbox.length,2);assert.equal(model.outbox[1].kind,'card');
  });
}

async function actualNewCustomerContextStillStopsTheCardAfterConfirmedText() {
  const cases=[
    ['left','TEXT','对方关注或回复你之前，24小时内最多只能发1条文字消息'],
    // Synthetic unknown RICH_HINT with the same words must remain conservative;
    // the actually observed platform quota notice is typed HINT.
    ['center','RICH_HINT','对方关注或回复你之前，24小时内最多只能发1条文字消息'],
    ['center','RICH_HINT','对方通过「合成新笔记」进入私信，快去联系吧'],
    ['center','RICH_HINT','其他未识别的原生中心提示'],
  ];
  for(const [direction,type,text] of cases)await check({bubbleAfterClick:true,confirmHistory:true,afterOpenCardMenu:model=>{
    const next=message('new-context-after-text',direction,text,Date.now());next.raw_type=type;model.messages.push(next);
  }},async({model,run})=>{
    await assert.rejects(run(),/new_customer_context_requires_new_round/);
    assert.deepEqual(model.confirmations,['sent']);assert.equal(model.clicks.length,1);
    assert.equal(model.outbox.length,1);assert.equal(model.outbox[0].status,'SENT');
  });
}

async function observedNativeHintDuringCardTrialAllowsTheSingleCardClick() {
  await check({bubbleAfterClick:true,confirmHistory:true,afterTrial:model=>{
    if(model.cardMenus){
      const hint=message('quota-rule-during-trial','center','对方关注或回复你之前，24小时内最多只能发1条文字消息',Date.now());
      hint.raw_type='HINT';model.messages.push(hint);
    }
  }},async({model,run})=>{
    assert.equal((await run()).state,'confirmed');assert.deepEqual(model.confirmations,['sent','sent']);
    assert.deepEqual(model.clicks.map(row=>row.operation),['text','native_card']);
  });
}

async function nativeHintCannotGrantManualModeOrBypassItsNativeGate() {
  await check({domMode:true,bubbleAfterClick:true,confirmHistory:true,afterOpenCardMenu:model=>{
    const hint=message('quota-rule-blocked-mode','center','对方关注或回复你之前，24小时内最多只能发1条文字消息',Date.now());
    hint.raw_type='HINT';model.messages.push(hint);
    model.aiOverlay=true;model.takeoverVisible=true;model.headerDisabled=true;
  }},async({model,run})=>{
    await assert.rejects(run(),/native_manual_mode_not_confirmed/);
    assert.deepEqual(model.confirmations,['sent']);assert.equal(model.clicks.length,1);
    assert.equal(model.outbox.length,1);
  });
}

async function normalTextStillRequiresIndependentQualityReview(){await check({bubbleAfterClick:true,confirmHistory:true},async({model,run})=>{
  assert.equal((await run()).state,'confirmed');const row=model.outbox.find(value=>value.payload.operation==='text');
  assert.equal(row.evidence.usefulness_verified,undefined);assert.equal(row.evidence.useful,undefined);
  assert.equal(row.evidence.response_source_event_id,row.source_event_id);assert.equal(row.evidence.quality_assessment,'requires_independent_review');
});}

(async()=>{
  const cases=[normalTextStillRequiresIndependentQualityReview,activeCustomerQuestionUsesStrictTextServiceAndNeverOpensTheCardMenu,
    reviewedQualityCorrectionUsesOneTextAndNeverRepeatsTheCard,
    qualityCorrectionRequiresExactEngineReviewSourceAndNoUnresolvedOutgoing,
    specialTextBindsTheEngineApprovedPriorCardUnknownAndPreservesIt,
    verifiedLeadServiceSendsOnlyItsExactCustomerQuestionText,unknownServiceReconciliationNeverStartsACompanionCard,
    postLeadServiceCannotSkipUnknownOrChangeQuestionAfterClaim,reconciliationLeaseCannotBindAnotherUnknownIntentOrNativeId,
    missingLeadStatusBlocks,convertedLeadBlocks,politeRefusalBlocks,
    businessNeedDescriptionIsNotARefusal,supersededHistoricalRefusalDoesNotBlockCurrentQuestion,
    lateRefusalPersistsBeforeBeginSubmit,lateNativeAddedStatusPersistsBeforeBeginSubmit,
    submittedLeadRequiresReviewWithoutInventingVerifiedLead,terminalDoesNotClearOriginalUnknown,
    cardPanelRetainsFreshExactNegativeLeadProof,newlyObservedInboundBlocks,
    changedUIDAtSubmissionBlocks,inboundAtSubmissionBlocks,cancellationAfterBeginBlocks,
    optimisticBubbleWithoutHistoryStopsCard,existingFreshHistorySkipsRefreshAndConfirmsBothOperations,
    failedRefreshKeepsMatchedNativeIdAndFullFailureWithoutRetry,
    currentConversationRefreshStillRequiresExactHistoryForEachOperation,
    realNativeTextHistoryWithStableTimestampConfirmsAfterRefresh,
    refreshedNativeIdOrScopeCannotSubstituteForOriginalText,refreshedNativeTextTypeOrContentChangeStaysUnknown,
    correctedUiTimestampStillRequiresExactNativeHistoryScopeTypeContentAndTime,
    realNativeTextHistoryWithCorrectedTimestampUsesRefreshedSameId,
    exactHistorySuccessDoesNotInventEntry,
    latestCustomerMessageLinksFreshPriorEntry,unobservedHistoricalEntryCannotEarnFreshCredit,
    futureClockCannotEarnNegativeLatencyCredit,exactNeverSubmittedOwnDraftCanBeReplaced,
    humanEditedOwnDraftIsPreserved,switchedCustomerDraftCannotBeCleared,
    submittedOwnDraftIsNeverCleared,expiredNeverSubmittedOwnDraftCanBeReplaced,
    effectiveCardDiagnosticIsBoundPersistedAndDetached,diagnosticSchemaNeverReplacesUnknownHistory,
    diagnosticDetachesOnPostSubmitCancellation,diagnosticDetachesAndPersistsOnClickFailure,
    unavailableDiagnosticStillRequiresExactHistory,reconcileUsesOnlyKnownOriginalWithoutSending,
    reconcileCannotGuessMissingOriginalId,reconcileCannotUseLaterSimilarCard,reconcileCannotSwapPairForSameRawId,
    reconcileCompanionRespectsCurrentDispatchConfiguration,readOnlyReconcileIgnoresDisabledDispatchWithoutSending,
    realDomAiOverlayAndDisabledTrackedParentRequireOneTakeoverBeforeSend,
    takeOverOnlyPreservesOriginalUnknownAndDraftWithoutCreatingBusinessEvents,
    takeOverOnlyAlreadyManualDoesNotClickAndCancellationCannotTakeOver,
    disabledActualHeaderButtonCannotBeProvedManualByItsVisibleTrackingDiv,
    overlayOrTakeoverEntryLeftVisibleCannotPassAfterOneTakeoverClick,aiReturnAfterFillStopsBeforeDurableSubmission,
    actionabilityFailureAndAiReturnDuringTrialNeverBecomeSubmittingOrUnknown,newInboundDuringTrialCannotSubmitAnOldDraft,
    observedNativeHintAfterConfirmedTextAllowsTheCardRound,actualNewCustomerContextStillStopsTheCardAfterConfirmedText,
    observedNativeHintDuringCardTrialAllowsTheSingleCardClick,nativeHintCannotGrantManualModeOrBypassItsNativeGate];
  for(const test of cases) {await test();console.log("PASS "+test.name);}
  console.log(cases.length+" synthetic sender regressions passed; no browser or production evidence generated.");
})().catch(error=>{console.error(error);process.exitCode=1;});
