"use strict";

// External-boundary fixture only. Reuses the DOM shape from test_ui_scope /
// test_ui_sender and the GET envelope from test_native_history_receipt.
// Production scope/controller/worker, adapter, RPC/SQLite, sender and
// native-history verifier are deliberately not replaced.
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {EventEmitter}=require("node:events");
const {execFileSync}=require("node:child_process");
const ROOT=path.resolve(__dirname,"../..");
const A="aaaaaaaaaaaaaaaaaaaaaaaa",U="bbbbbbbbbbbbbbbbbbbbbbbb",NAME="flow-fixture-account";
const QUOTA="对方关注或回复你之前，24小时内最多只能发1条文字消息";
const CARD={id:"flow-fixture-card",type:"business",contentType:"CARD",msgContentType:"CARD",
  title:"企业微信",name:"运去哪海外仓（企微）",inviteInfo:"邀请添加企业微信",corpName:"fixture-corp",cardType:"wecom",
  contactList:[{link:"https://example.invalid/fixture-only",dayIcon:"https://example.invalid/fixture-image"}]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

class Node {
  constructor(tag,attrs={},children=[],value="") {
    this.tagName=tag.toUpperCase();this.attrs=attrs;this.children=children;this.value=value;
    this.disabled=attrs.disabled===true;this.readOnly=attrs.readOnly===true;
    for(const child of children)child.parentElement=this;
  }
  get id(){return this.attrs.id || "";}
  get innerText(){return [this.value,...this.children.map(child=>child.innerText)].filter(Boolean).join("\n");}
  get textContent(){return this.innerText;}
  get firstElementChild(){return this.children[0] || null;}
  get previousElementSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)-1] || null;}
  get classList(){return {contains:value=>(this.attrs.class || "").split(/\s+/).includes(value)};}
  getAttribute(key){if(key==="disabled")return this.disabled?"":null;return this.attrs[key]??null;}
  checkVisibility(){return this.attrs.visible!==false && (!this.parentElement || this.parentElement.checkVisibility());}
  contains(node){return node===this || this.children.some(child=>child.contains(node));}
  querySelector(selector){return this.querySelectorAll(selector)[0] || null;}
  querySelectorAll(selector){
    const descendants=[];const visit=node=>{for(const child of node.children){descendants.push(child);visit(child);}};visit(this);
    const simple=(node,part)=>{
      const attrs=[...part.matchAll(/\[([^\]=^]+)(\^=|=)?(?:"([^"]*)")?\]/g)];
      if(attrs.some(([,key,op,value])=>node.getAttribute(key)===null ||
        op==="=" && node.getAttribute(key)!==value || op==="^=" && !String(node.getAttribute(key)).startsWith(value)))return false;
      const bare=part.replace(/\[[^\]]+\]/g,"").replace(/:visible/g,"");
      const tag=bare.match(/^[A-Za-z][A-Za-z0-9-]*/)?.[0];
      if(tag&&node.tagName!==tag.toUpperCase())return false;
      const id=bare.match(/#([A-Za-z0-9_-]+)/)?.[1];if(id&&node.id!==id)return false;
      return [...bare.matchAll(/\.([A-Za-z0-9_-]+)/g)].every(([,name])=>node.classList.contains(name)) &&
        (!part.includes(":visible") || node.checkVisibility());
    };
    return descendants.filter(node=>selector.split(",").some(branch=>{
      const parts=branch.trim().split(/\s+/);if(!simple(node,parts.at(-1)))return false;
      let ancestor=node.parentElement;
      for(let i=parts.length-2;i>=0;i--){while(ancestor&&!simple(ancestor,parts[i]))ancestor=ancestor.parentElement;
        if(!ancestor)return false;ancestor=ancestor.parentElement;}
      return true;
    }));
  }
}
const el=(tag,attrs={},children=[],text="")=>new Node(tag,attrs,children,text);
const div=(cls,children=[],text="")=>el("div",{class:cls},children,text);

async function createFixture({strictReceipt=true,existingHuman=false,verifiedLead=false,priorCardUnknown=false,activeQuestion=false,entryThenQuestion=false}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"xhs-reception-flow-"));
  const runtime=path.join(directory,"runtime");fs.mkdirSync(runtime);
  const db=path.join(runtime,"reception.sqlite3"),python=process.env.PYTHON || "/usr/bin/python3";
  fs.writeFileSync(path.join(directory,"reception.json"),JSON.stringify({live_dispatch_enabled:true,browser:"isolated_playwright",account_id:A}));
  fs.writeFileSync(path.join(runtime,"connection.json"),"{}");
  fs.writeFileSync(path.join(runtime,"account_identity.json"),JSON.stringify({account_id:A,account_display_name:NAME,
    source:"platform_ui",reference:".userInfo-popover 主账号ID",observed_at_utc:new Date().toISOString(),
    url:"https://sxt.xiaohongshu.com/im/multiCustomerService",title:NAME+"-私信通"}));
  execFileSync(python,["-B","-c","from xhs_reception import Engine; import sys; Engine(sys.argv[1]).close()",db],{cwd:ROOT});
  const engine=require(path.join(ROOT,"xhs_reception/ui_engine.cjs"));
  const controller=require(path.join(ROOT,"xhs_reception/ui_controller.cjs"));
  const worker=require(path.join(ROOT,"xhs_reception/ui_worker.cjs"));
  const {readScope}=require(path.join(ROOT,"xhs_reception/ui_scope.cjs"));
  const history=require(path.join(ROOT,"xhs_reception/native_history_receipt.cjs"));
  const sender=require(path.join(ROOT,"xhs_reception/ui_sender.cjs")),client=engine.getClient(runtime,{pythonExecutable:python});
  const model={messages:[],history:[],clicks:[],receives:[],errors:[],draft:"",ai:true,cardOpen:false,
    preview:"old fixture card",takeovers:0,refreshes:0};
  const page=new EventEmitter();page.url=()=>"https://sxt.xiaohongshu.com/im/multiCustomerService";
  const message=(id,direction,type,text,time=Date.now(),source=null)=>({id,direction,type,text,time,source});
  const pair=id=>A+"."+U+"."+id;
  const rootMessage=m=>{
    const header=div("native-header",[el("div",{},[],m.source==="SYSTEM"?"该消息由系统发送":
      m.source==="AI"?"该消息由AI小助手发送":""),el("div",{},[],"fixture native timestamp/staff")]);
    const body=el("div",{id:"jarvis-msg-"+pair(m.id),class:m.direction,"data-timestamp":String(m.time),"data-msg-type":m.type},
      m.type==="CARD"?[div("card_container businesscardmsg",[],m.text)]:[],m.type==="CARD"?"":m.text);
    return el("div",{class:"im-msg-item",id:"id_"+pair(m.id)},[
      div("native-outer",[div("native-inner",[header,div("native-content",[body])])])]);
  };
  const tree=()=>{
    const active=el("div",{class:"sx-contact-item active","data-key":"Total-"+U},[
      div("nick-name",[],"synthetic customer"),div("time",[],"fixture-time"),div("content",[],model.preview)]);
    const header=div("message-header",[div("nick-name",[],"synthetic customer"),
      el("div",{"data-track-click":JSON.stringify({attributes:{triggerKey:"人工转AI"}})},[
        el("button",{disabled:model.ai,class:model.ai?"disabled":""},[],"人工转AI")])]);
    const info=(label,value)=>div("info-item",[div("info-item-title",[],label),div("info-item-value-wrap",[],value)]);
    const cardRow=div("card-box__content",[
      el("div",{class:"card-box__content-title",title:"企微_运去哪海外仓（企微）"},[],"企微_运去哪海外仓（企微）"),
      el("span",{},[],"@运去哪物流科技集团"),el("button",{"data-fixture-action":"send-card"},[],"发送")]);
    cardRow.attrs.visible=model.cardOpen;
    const reply=[el("textarea",{class:"reply-textarea"},[],model.draft)];
    if(model.ai)reply.push(div("ai-overlay",[el("button",{class:"ai-overlay-button","data-fixture-action":"takeover"},[],"人工接管")]));
    const tabs=div("contact-tab-wrap",[
      div("d-tabs-header d-clickable d-tabs-header-linear d-tabs-header-linear-small",[],"当前会话"),
      div("d-tabs-header d-clickable d-tabs-header-linear d-tabs-header-linear-small active",[],"全部会话")]);
    return el("document",{},[el("div",{id:"walle-ad"},[tabs,active,header,
      div("user-id-row",[div("id-group",[div("id-label",[],"UID:"),div("ellipsis",[],U)])]),
      div("information-source-wrap",[info("名片",verifiedLead?"企业微信 - 已添加企微":"企业微信 - 未添加企微"),info("留资卡","无提交留资卡")]),
      div("chat-tool-wrap",[cardRow]),div("reply-box-wrap",reply),
      div("reply-bottom-bar",[el("button",{"data-fixture-action":"send-text"},[],"发送")]),
      ...model.messages.map(rootMessage)])]);
  };
  page.evaluate=async(fn,args)=>{
    const before={document:global.document,location:global.location};
    const document=tree();document.title=NAME+"-私信通";
    global.document=document;global.location={origin:"https://sxt.xiaohongshu.com",pathname:"/im/multiCustomerService"};
    try{return fn(args);}finally{Object.assign(global,before);}
  };
  page.waitForFunction=async(fn,args)=>{if(!await page.evaluate(fn,args))throw Error("synthetic_ui_condition_not_met");};
  const api=history.attach(page);
  async function publishHistory() {
    const data={success:true,code:0,data:{messages:model.history.map(m=>({
      sixin_message:{id:pair(m.id),sender_id:A,receiver_id:U,content:m.type==="CARD"?JSON.stringify(CARD):m.text,
        created_at:m.time,message_type:m.type},message_extension:{customer_user_id:U}}))}};
    const request={url:()=>"https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg?customer_user_id="+U,
      method:()=>"GET",response:async()=>({status:()=>200,body:async()=>Buffer.from(JSON.stringify(data))})};
    page.emit("request",request);page.emit("requestfinished",request);
    // Settle the real passive parser, not its receipt verdict.
    await delay(3);
  }
  function locator(selector,parent=null,filters=[]) {
    const resolve=(within)=>{
      const roots=parent?parent.resolve(within):[within || tree()];
      let found=roots.flatMap(root=>{
        if(selector.startsWith(".im-msg-item:is(")){
          const prefixes=[...selector.matchAll(/\[id\^="([^"]+)"\]/g)].map(m=>m[1]);
          const excluded=new Set([...selector.matchAll(/:not\(\[id="([^"]+)"\]\)/g)].map(m=>m[1]));
          return root.querySelectorAll(".im-msg-item").filter(node=>prefixes.some(p=>node.id.startsWith(p)) &&
            !excluded.has(node.id) && node.querySelectorAll('.left[data-msg-type="TEXT"],.center[data-msg-type="RICH_HINT"]').length);
        }
        return root.querySelectorAll(selector);
      });
      for(const filter of filters)found=found.filter(node=>
        (filter.visible!==true || node.checkVisibility()) &&
        (!filter.has || filter.has.resolve(node).length>0) &&
        (!filter.hasNot || filter.hasNot.resolve(node).length===0) &&
        (!filter.hasText || (typeof filter.hasText==="string"?node.innerText.includes(filter.hasText):filter.hasText.test(node.innerText))));
      return found;
    };
    const unique=()=>{const nodes=resolve();assert.equal(nodes.length,1,"unique external UI control: "+selector);return nodes[0];};
    const result={resolve,
      locator:child=>locator(child,result),filter:filter=>locator(selector,parent,[...filters,filter]),
      getByRole:(role,{name,exact}={})=>{assert.equal(role,"button");return locator("button",result,[{hasText:exact?new RegExp("^"+name+"$"):name}]);},
      count:async()=>resolve().length,inputValue:async()=>{unique();return model.draft;},
      fill:async text=>{unique();model.draft=text;},hover:async()=>{unique();},
      isEnabled:async()=>!unique().disabled,getAttribute:async key=>unique().getAttribute(key),
      click:async(options={})=>{
        const node=unique();if(options.trial)return;
        const action=node.getAttribute("data-fixture-action");
        if(action==="takeover"){model.takeovers++;model.ai=false;return;}
        assert(["send-text","send-card"].includes(action),"only native reception controls may click");
        const card=action==="send-card",m=message("agent-"+(model.clicks.length+1),"right",card?"CARD":"TEXT",
          card?"邀请您添加我的企业微信\n运去哪海外仓（企微）\n企业微信":model.draft);
        model.clicks.push(card?"native_card":"text");model.messages.push(m);model.draft="";
        if(strictReceipt)model.history.push(m);
        await publishHistory();
      },
    };
    return result;
  }
  page.locator=selector=>locator(selector);
  const currentScope=()=>readScope(page,{accountId:A,accountDisplayName:NAME});
  const old=message("independent-prior-card","right","CARD","运去哪海外仓（企微）\n邀请添加企业微信",Date.now()-3600000);
  model.messages.push(old);model.history.push(old);await publishHistory();
  sender.primeCardIdentity(page,await currentScope());
  if(priorCardUnknown){
    assert(verifiedLead||activeQuestion,"prior-card exception fixture requires explicit customer-question service policy");
    model.messages.push(message("prior-customer-source","left","TEXT","你好",Date.now()-1000));
    assert((await engine.ingestObservedScope(client,await currentScope(),{historicalBaseline:false})).ok);
    if(activeQuestion){
      const preparedText=await client.request("prepare",{account_id:A,conversation_id:U,kind:"reply",payload:{operation:"text",text:"之前接待消息"}});assert(preparedText.ok);
      const textGate={enabled:true,browser_connected:true,authenticated:true,account_id:A,conversation_id:U,
        browser_session_id:"fixture-prior-text-session",observed_at:Date.now()/1000};
      assert((await client.request("claim",{intent_id:preparedText.result.intent_id,owner:"fixture-prior-owner",gate:textGate})).ok);
      const submittedText=await client.request("begin_submit",{intent_id:preparedText.result.intent_id,owner:"fixture-prior-owner",gate:textGate});assert(submittedText.ok);
      // The real Python clock retains sub-millisecond precision. Start this
      // fixture GET after that durable submit instead of relaxing freshness.
      await delay(2);
      const priorText=message("prior-confirmed-text","right","TEXT","之前接待消息",Date.now());
      model.messages.push(priorText);model.history.push(priorText);await publishHistory();
      const receipt=api.verify({accountId:A,conversationId:U,messageId:priorText.id,operation:"text",expectedText:priorText.text,
        nativeMessageId:pair(priorText.id),submittedAtMs:submittedText.result.submitted_at*1000,uiTimestampMs:priorText.time});
      assert.equal(receipt.status,"server_history_confirmed",JSON.stringify(receipt));
      const confirmedText=await client.request("confirm",{intent_id:preparedText.result.intent_id,owner:"fixture-prior-owner",result:"sent",
        evidence:{source:"platform_ui",account_id:A,conversation_id:U,intent_id:preparedText.result.intent_id,
          observed_at:Date.now()/1000,reference:"fixture exact prior text history",native_message_raw_id:priorText.id,
          native_message_id:"jarvis-msg-"+pair(priorText.id),native_server_history:receipt}});
      assert(confirmedText.ok);model.priorConfirmedText=confirmedText.result;
    }
    const prepared=await client.request("prepare",{account_id:A,conversation_id:U,kind:"card",payload:{operation:"native_card"}});assert(prepared.ok);
    const gate={enabled:true,browser_connected:true,authenticated:true,account_id:A,conversation_id:U,
      browser_session_id:"fixture-prior-card-session",observed_at:Date.now()/1000};
    assert((await client.request("claim",{intent_id:prepared.result.intent_id,owner:"fixture-prior-owner",gate})).ok);
    assert((await client.request("begin_submit",{intent_id:prepared.result.intent_id,owner:"fixture-prior-owner",gate})).ok);
    model.messages.push(message("prior-unknown-card","right","CARD","运去哪海外仓（企微）",Date.now()));
    const unknown=await client.request("confirm",{intent_id:prepared.result.intent_id,owner:"fixture-prior-owner",result:"unknown",
      evidence:{source:"platform_ui",account_id:A,conversation_id:U,intent_id:prepared.result.intent_id,
        observed_at:Date.now()/1000,reference:"fixture exact original submitted card",
        native_message_raw_id:"prior-unknown-card",native_message_id:"jarvis-msg-"+pair("prior-unknown-card")}});
    assert(unknown.ok);model.originalUnknown=unknown.result;
  }
  if(verifiedLead){
    const observed=Date.now()/1000;
    const result=await client.request("ingest",{event:{account_id:A,conversation_id:U,
      event_id:"native-terminal:WECHAT_VERIFIED:"+A+":"+U,type:"WECHAT_VERIFIED",detected_at:observed,
      evidence:{source:"platform_ui",account_id:A,conversation_id:U,observed_at:observed,verified:true,
        reference:"fixture exact native added profile",timestamp_source:"unknown"}}});assert(result.ok);
  }
  if(existingHuman){
    const observed=Date.now()/1000;
    const result=await client.request("ingest",{event:{account_id:A,conversation_id:U,event_id:"existing-explicit-owner",type:"HUMAN_TAKEOVER",
      timestamp:observed,detected_at:observed,evidence:{source:"platform_ui",account_id:A,conversation_id:U,
        observed_at:observed,reference:"fixture prior human owner"}}});assert(result.ok);
  }
  async function start() {
    await controller.start({page,runtime,futureEntriesOnly:true,
      selectAndRead:async(_page,candidate,ctx)=>{assert.equal(candidate.uid,U);assert(ctx.isCurrent());return currentScope();},
      takeoverOnly:args=>sender.takeOverOnly({page,runtime,currentScope,...args}),
      receive:async args=>{
        try {
          const result=await sender.receive({page,runtime,currentScope,...args,
            // Actual native observation: this informational rule is HINT,
            // not RICH_HINT. Unknown RICH_HINTs retain their safety guard.
            openCardMenu:async()=>{model.cardOpen=true;model.messages.push(message("native-quota-rule","center","HINT",QUOTA));},
            refreshHistory:async()=>{model.refreshes++;await publishHistory();return {action:"synthetic_native_history_get",confirms_send:false};}});
          model.receives.push(result);return result;
        }catch(error){model.errors.push(error.message);throw error;}
      }});
    await delay(5);
    const now=Date.now();model.entry=message("fresh-entry","center","RICH_HINT","对方通过合成笔记进入私信",now);
    if(verifiedLead||activeQuestion){
      if(entryThenQuestion)model.messages.push(model.entry);
      model.messages.push(message(activeQuestion?"active-customer-question":"post-lead-question","left","TEXT","我想咨询一下报价",now+(entryThenQuestion?1:0)));
    }
    else model.messages.push(model.entry,message("native-system-welcome","right","GENERAL","synthetic welcome",now+1,"SYSTEM"),
      message("native-ai-welcome","right","TEXT","synthetic AI welcome",now+2,"AI"));
    model.preview="synthetic new entry";
    const deadline=Date.now()+6000;
    while(!worker.status(page).processed && !worker.status(page).error){
      if(Date.now()>deadline)throw Error("offline_flow_timeout:"+JSON.stringify(controller.status(page)));await delay(10);
    }
    while(worker.status(page).busy){if(Date.now()>deadline)throw Error("offline_flow_settle_timeout");await delay(5);}
    return controller.status(page);
  }
  const status=async()=>{const result=await client.request("status",{conversation_id:U});assert(result.ok);return result.result;};
  const audit=()=>JSON.parse(execFileSync(python,["-B","-m","xhs_reception","--db",db,"--account",A,"reception-audit","--limit","10"],
    {cwd:ROOT,encoding:"utf8"}));
  async function close(){controller.stop(page);api.detach();await client.close();
    const key=Symbol.for("xhs_reception.ui_engine_client");if(globalThis[key]?.client===client)delete globalThis[key];
    fs.rmSync(directory,{recursive:true,force:true});}
  return {model,start,status,audit,close,controllerStatus:()=>controller.status(page),workerStatus:()=>worker.status(page)};
}

module.exports={createFixture,A,U};
