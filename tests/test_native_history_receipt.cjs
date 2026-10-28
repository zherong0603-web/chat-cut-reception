"use strict";
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {performance}=require("node:perf_hooks");
const {attach}=require("../xhs_reception/native_history_receipt.cjs");
const A="aaaaaaaaaaaaaaaaaaaaaaaa",U="bbbbbbbbbbbbbbbbbbbbbbbb",V="cccccccccccccccccccccccc";
const text="pure mock exact text",delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=2700){const end=performance.now()+timeout;while(!predicate()){if(performance.now()>end)throw Error("mock_condition_timeout");await delay(3);}}
function row({account=A,uid=U,id="m1",time=Date.now()-2,type="TEXT",content=text}={}){return {
 sixin_message:{id:account+"."+uid+"."+id,sender_id:account,receiver_id:uid,content,created_at:time,message_type:type},
 message_extension:{customer_user_id:uid}};}
function envelope(rows){return {success:true,code:0,data:{messages:rows}};}
function req(data,{uid=U,query="customer_user_id="+uid,status=200,url,method="GET",responsePromise,bodyPromise}={}) {
 const response={body:()=>bodyPromise||Promise.resolve(Buffer.from(JSON.stringify(data))),status:()=>status};
 return {url:()=>url||"https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg?"+query,
 method:()=>method,response:()=>responsePromise||Promise.resolve(response)};
}
async function capture(page,api,data,opts={}){const n=api.records().length;const r=req(data,opts);page.emit("request",r);page.emit("requestfinished",r);await until(()=>api.records().length>n || (n===4 && api.records()[3].data===data));return r;}
async function singleCase(mutate,params={}) {
 const page=new EventEmitter(),api=attach(page),now=Date.now(),data=envelope([row({time:now-2})]);
 const options={};if(mutate)mutate(data,options);
 try {await capture(page,api,data,options);
 return api.verify({accountId:A,conversationId:U,messageId:"m1",operation:"text",expectedText:text,
 submittedAtMs:now-10,uiTimestampMs:now-2,...params});}finally{api.detach();}
}
async function exactTextAndScopeFailures(){
 assert.equal((await singleCase()).status,"server_history_confirmed");
 assert.equal((await singleCase(d=>d.data.messages[0].sixin_message.id=U+"."+A+".m1")).status,"server_history_confirmed");
 assert.equal((await singleCase(d=>d.data.messages[0].sixin_message.id=V+"."+A+".m1")).status,"unknown");
 assert.equal((await singleCase(d=>{const reverse=structuredClone(d.data.messages[0]);reverse.sixin_message.id=U+"."+A+".m1";d.data.messages.push(reverse);})).status,"unknown");
 assert.equal((await singleCase(null,{submittedAtMs:Date.now()-500+0.25})).status,"server_history_confirmed");
 assert.equal((await singleCase(d=>d.data.messages[0].sixin_message.content=JSON.stringify(text))).status,"server_history_confirmed");
 const mutations=[
  (_d,o)=>o.query="customer_user_id="+V,
  (_d,o)=>o.query="customer_user_id="+U+"&customer_user_id="+U,
  d=>d.data.messages[0].sixin_message.sender_id=V,
  d=>d.data.messages[0].sixin_message.receiver_id=V,
  d=>d.data.messages[0].sixin_message.id=A+"."+U+".other",
  d=>d.data.messages[0].message_extension.customer_user_id=V,
  d=>d.data.messages[0].sixin_message.content=text+" ",
  d=>d.data.messages[0].sixin_message.content=JSON.stringify({text}),
  d=>d.data.messages[0].sixin_message.created_at--,
  d=>d.data.messages[0].sixin_message.created_at=String(d.data.messages[0].sixin_message.created_at),
  d=>d.data.messages[0].sixin_message.message_type="CARD",
  d=>d.success="true",d=>d.code="0",(_d,o)=>o.status=201,
  d=>d.data.messages.push(structuredClone(d.data.messages[0])),
 ];
 for(const mutation of mutations)assert.equal((await singleCase(mutation)).status,"unknown");
 const proof=await singleCase();assert(!JSON.stringify(proof).includes(text));assert.equal(proof.read_verified,false);
}
async function oldRequestAndNoSettleAndDetach(){
 const page=new EventEmitter(),api=attach(page),old=req(envelope([]));page.emit("request",old);
 await delay(8);const submitted=Date.now(),when=submitted;
 old.response=async()=>({status:()=>200,body:async()=>Buffer.from(JSON.stringify(envelope([row({time:when})])))});
 page.emit("requestfinished",old);await until(()=>api.records().length===1);
 assert.equal(api.verify({accountId:A,conversationId:U,messageId:"m1",operation:"text",expectedText:text,submittedAtMs:submitted,uiTimestampMs:when}).status,"unknown");
 api.detach();
 const page2=new EventEmitter(),api2=attach(page2);let resolveResponse;
 const stalled=req(null,{responsePromise:new Promise(resolve=>{resolveResponse=resolve;})});
 const start=performance.now();page2.emit("request",stalled);page2.emit("requestfinished",stalled);
 await until(()=>api2.records().length===1);assert(performance.now()-start<2400);
 assert.equal(api2.snapshot()[0].error,"history_response_read_timeout");
 resolveResponse({status:()=>200,body:async()=>Buffer.from(JSON.stringify(envelope([row()])))});
 await delay(10);assert.equal(api2.records().length,1);assert.equal(api2.records()[0].data,undefined);api2.detach();
 const page3=new EventEmitter(),api3=attach(page3);let resolveBody;
 const late=req(null,{bodyPromise:new Promise(resolve=>{resolveBody=resolve;})});
 page3.emit("request",late);page3.emit("requestfinished",late);await delay(1);api3.detach();
 const newer=attach(page3);api3.detach();assert.equal(attach(page3),newer);
 resolveBody(Buffer.from(JSON.stringify(envelope([row()]))));await delay(10);
 assert.equal(api3.records().length,0);assert.equal(newer.records().length,0);assert.equal(page3.listenerCount("request"),1);
 newer.detach();
}
const card={id:"fixture-card",type:"business",contentType:"CARD",msgContentType:"CARD",title:"企业微信",
 name:"运去哪海外仓（企微）",inviteInfo:"邀请添加企业微信",corpName:"fixture-corp",cardType:"wecom",
 contactList:[{link:"https://example.invalid/private",dayIcon:"https://example.invalid/image",csaAccountNo:"ignored"}]};
async function identityAndCardMatching(){
 const page=new EventEmitter(),api=attach(page),when=Date.now()-20;
 const data=envelope([row({id:"card1",type:"CARD",time:when,content:JSON.stringify(card)})]);
 data.data.messages[0].sixin_message.id=U+"."+A+".card1";
 await capture(page,api,data);
 const id=U+"."+A+".card1",ui={account_id:A,conversation_id:U,message_id:"card1",dom_id:"id_"+id,native_dom_id:"jarvis-msg-"+id,
 direction:"right",raw_type:"CARD",raw_timestamp:String(when),native_business_card_candidate:true,
 raw_text:"运去哪海外仓（企微）\n邀请添加企业微信\n企业微信"};
 const scope={scope_ready:true,account_scope_verified:true,conversation_scope_verified:true,source:"platform_ui",
 classification:"readonly_ui_scope",account_id:A,conversation_id:U,messages:[ui]};
 const identity=api.cardIdentity(scope);assert.equal(identity.status,"native_card_identity_confirmed");
 assert.equal(api.cardIdentity({...scope,messages:[{...ui,dom_id:"id_"+V+"."+A+".card1",native_dom_id:"jarvis-msg-"+V+"."+A+".card1"}]}).status,"unknown");
 assert.equal(Object.keys(identity.cardIdentity).length,12);assert(!JSON.stringify(identity.cardIdentity).includes("https://"));
 assert.match(identity.cardIdentity.routing_hash,/^[a-f0-9]{64}$/);assert.equal(api.version,7);
 assert.match(identity.cardIdentity.full_payload_hash,/^[a-f0-9]{64}$/);
 assert.deepEqual(identity.cardIdentity.excluded_display_fields,[]);
 assert.equal(api.cardIdentity({...scope,messages:[{...ui,raw_text:"wrong name 企业微信"}]}).status,"unknown");
 const submitted=Date.now()-1,at=Date.now();
 await capture(page,api,envelope([row({uid:V,id:"card2",time:at,type:"CARD",content:JSON.stringify(card)})]),{uid:V});
 const params={accountId:A,conversationId:V,messageId:"card2",operation:"native_card",cardIdentity:identity.cardIdentity,submittedAtMs:submitted,uiTimestampMs:at};
 assert.equal(api.verify(params).status,"server_history_confirmed");
 assert.equal(api.verify({...params,cardIdentity:{...identity.cardIdentity}}).status,"unknown");
 assert.equal(api.verify({...params,accountId:U}).status,"unknown");
 const changed={...card,contactList:[{...card.contactList[0],link:"https://example.invalid/different-routing"}]};
 await capture(page,api,envelope([row({uid:V,id:"card2",time:at,type:"CARD",content:JSON.stringify(changed)})]),{uid:V});
 assert.equal(api.verify(params).status,"unknown");
 // The stored target ID above has contradictory payloads; compare must stay unknown.
 assert.equal(api.cardDifferences({accountId:A,sourceConversationId:U,sourceMessageId:"card1",targetConversationId:V,targetMessageId:"card2"}).status,"unknown");
 const snapshot=JSON.stringify(api.snapshot());assert(!snapshot.includes("example.invalid"));assert(!snapshot.includes(card.inviteInfo));
 api.detach();
 // The trusted identity object remains valid after a passive observer replacement.
 const again=attach(page),t2=Date.now(),submitted2=t2-1;
 await capture(page,again,envelope([row({uid:V,id:"card3",time:t2,type:"CARD",content:JSON.stringify(card)})]),{uid:V});
 assert.equal(again.verify({...params,messageId:"card3",submittedAtMs:submitted2,uiTimestampMs:t2}).status,"server_history_confirmed");
 await capture(page,again,envelope([row({uid:U,id:"card4",time:t2,type:"CARD",content:JSON.stringify(changed)})]));
 const differences=again.cardDifferences({accountId:A,sourceConversationId:V,sourceMessageId:"card3",targetConversationId:U,targetMessageId:"card4"});
 assert.equal(differences.status,"compared");assert.deepEqual(differences.differences,[{path:"$.contactList[0].link",source_type:"string",target_type:"string"}]);
 assert(!JSON.stringify(differences).includes("example.invalid"));assert.equal(differences.send_confirmation,false);
 again.detach();
}
async function compareCards(source,target,{clone=false,legacyBrand=false}={}) {
 const page=new EventEmitter(),api=attach(page),sourceAt=Date.now()-20;
 try {
  await capture(page,api,envelope([row({id:"independent-source",type:"CARD",time:sourceAt,content:JSON.stringify(source)})]));
  const id=A+"."+U+".independent-source";
  const proof=api.cardIdentity({scope_ready:true,account_scope_verified:true,conversation_scope_verified:true,
   source:"platform_ui",classification:"readonly_ui_scope",account_id:A,conversation_id:U,messages:[{
    account_id:A,conversation_id:U,message_id:"independent-source",dom_id:"id_"+id,native_dom_id:"jarvis-msg-"+id,
    direction:"right",raw_type:"CARD",raw_timestamp:String(sourceAt),native_business_card_candidate:true,
    raw_text:"运去哪海外仓（企微）\n邀请添加企业微信\n企业微信"}]});
  assert.equal(proof.status,"native_card_identity_confirmed");
  let identity=proof.cardIdentity;
  if(clone) identity={...identity};
  if(legacyBrand) {
   // Model an authentic old runtime brand: it has no v7 comparison semantics.
   identity=Object.freeze({...identity});
   globalThis[Symbol.for("xhs_reception.native_card_identities")].set(identity,{accountId:A,identity,verifierVersion:6});
  }
  const at=Date.now();
  await capture(page,api,envelope([row({id:"target",time:at,type:"CARD",content:JSON.stringify(target)})]));
  const result=api.verify({accountId:A,conversationId:U,messageId:"target",operation:"native_card",
   cardIdentity:identity,submittedAtMs:at-1,uiTimestampMs:at});
  return {result,sourceIdentity:proof.cardIdentity};
 } finally {api.detach();}
}
async function boundedDisplayCountExceptionKeepsRoutingExact() {
 const source={...card,userFansCount:"12",likeAndCollectCount:"5",link:"https://example.invalid/route",
  csaAccountNo:"fixture-staff",cardSource:"fixture-ui",contactList:[{...card.contactList[0],linkV2:"https://example.invalid/route-v2"}]};
 const target={...source,userFansCount:"13"};
 const {result,sourceIdentity}=await compareCards(source,target);
 assert.equal(result.status,"server_history_confirmed");
 assert.equal(result.verifier_version,7);assert.deepEqual(result.excluded_display_fields,["userFansCount"]);
 assert.equal(result.expected_full_payload_hash,sourceIdentity.full_payload_hash);
 assert.match(result.full_payload_hash,/^[a-f0-9]{64}$/);
 assert.notEqual(result.full_payload_hash,result.expected_full_payload_hash);
 assert(Object.isFrozen(sourceIdentity.excluded_display_fields));
 for(const next of ["0","4294967295"])
  assert.equal((await compareCards(source,{...source,userFansCount:next})).result.status,"server_history_confirmed");
 const invalid=[undefined,null,13,true,"-1","+1","01","1.0"," 13","1e3","4294967296","9".repeat(100)];
 for(const next of invalid) {
  const changed={...source,userFansCount:next};if(next===undefined)delete changed.userFansCount;
  assert.equal((await compareCards(source,changed)).result.status,"unknown");
 }
 const missing={...source};delete missing.userFansCount;
 assert.equal((await compareCards(missing,source)).result.status,"unknown");
 assert.equal((await compareCards(missing,missing)).result.status,"server_history_confirmed");
 // Malformed display values can only pass when the entire payload is exact.
 const malformed={...source,userFansCount:"-1"};
 const exactMalformed=(await compareCards(malformed,malformed)).result;
 assert.equal(exactMalformed.status,"server_history_confirmed");assert.deepEqual(exactMalformed.excluded_display_fields,[]);
 assert.equal(exactMalformed.full_payload_hash,exactMalformed.expected_full_payload_hash);
 for(const mutate of [
  c=>c.link="https://example.invalid/other-route",
  c=>c.contactList[0].link="https://example.invalid/other-contact-route",
  c=>c.contactList[0].linkV2="https://example.invalid/other-v2-route",
  c=>c.contactList[0].csaAccountNo="another-staff",
  c=>c.csaAccountNo="another-staff",c=>c.cardSource="another-source",
  c=>c.id="another-card",c=>c.inviteInfo="another-invite",c=>c.likeAndCollectCount="6",
 ]) {
  const changed=structuredClone(target);mutate(changed);
  assert.equal((await compareCards(source,changed)).result.status,"unknown");
 }
 assert.equal((await compareCards(source,target,{clone:true})).result.reason,"confirmed_native_card_identity_required");
 assert.equal((await compareCards(source,target,{legacyBrand:true})).result.reason,"confirmed_native_card_identity_required");
}
async function routeDiagnosticsDoNotExposeValues(){
 const page=new EventEmitter(),api=attach(page),time=Date.now()-10;
 const source={...card,link:"https://example.invalid/route?customer_user_id="+U+"&dialog_info="+encodeURIComponent(JSON.stringify({customer_user_id:U,card_id:card.id}))+"&old=fixture#frag",contactList:[{
  link:encodeURIComponent("weixin://work/route?uid="+U+"&customer_channel=NATIVE_WEB"),linkV2:JSON.stringify({route:"fixture-route",uid:U})}]};
 const target={...card,link:"https://example.invalid/route?customer_user_id="+V+"&dialog_info="+encodeURIComponent(JSON.stringify({customer_user_id:V,card_id:card.id}))+"&new=fixture#frag",contactList:[{
  link:encodeURIComponent("weixin://work/route?uid="+V+"&customer_channel=native app"),linkV2:JSON.stringify({route:"fixture-route",uid:V})}]};
 await capture(page,api,envelope([row({id:"source",time,type:"CARD",content:JSON.stringify(source)})]));
 await capture(page,api,envelope([row({uid:V,id:"target",time,type:"CARD",content:JSON.stringify(target)})]),{uid:V});
 const report=api.cardRouteDifferences({accountId:A,sourceConversationId:U,sourceMessageId:"source",targetConversationId:V,targetMessageId:"target"});
 assert.equal(report.status,"compared");assert.equal(report.routes.length,3);
 const main=report.routes.find(route=>route.path==="$.link");
 for(const key of ["scheme_equal","host_equal","pathname_equal","fragment_equal"])assert.equal(main[key],true);
 assert.deepEqual(main.changed_query_keys,["customer_user_id","dialog_info"]);assert.deepEqual(main.added_query_keys,["new"]);assert.deepEqual(main.removed_query_keys,["old"]);
 const uid=main.changed_query_values.find(value=>value.key==="customer_user_id");
 assert.equal(uid.source[0].equals_source_uid,true);assert.equal(uid.target[0].equals_target_uid,true);assert.equal(uid.source[0].equals_account,false);
 assert.equal(report.routes[1].source_format,"encoded_absolute_url");
 assert.equal(report.routes[1].changed_query_values.find(value=>value.key==="uid").target[0].equals_target_uid,true);
 assert.equal(report.routes[1].changed_query_values.find(value=>value.key==="customer_channel").source[0].normalized_enum,"native_web");
 const dialog=main.changed_query_values.find(value=>value.key==="dialog_info");
 assert.equal(dialog.source_json[0].leaves.find(value=>value.path==="$.customer_user_id").equals_source_uid,true);
 assert.equal(dialog.target_json[0].leaves.find(value=>value.path==="$.customer_user_id").equals_target_uid,true);
 assert.equal(dialog.target_json[0].leaves.find(value=>value.path==="$.card_id").equals_card_identity_id,true);
 assert.deepEqual(dialog.json_differences[0].differences,[{path:"$.customer_user_id",source_type:"string",target_type:"string"}]);
 assert.deepEqual(report.routes[2].changed_paths,[{path:"$.uid",source_type:"string",target_type:"string"}]);
 const safe=JSON.stringify(report);for(const value of [A,U,V,"example.invalid","fixture-route",card.id])assert(!safe.includes(value));
 assert.equal(report.send_confirmation,false);api.detach();
}
(async()=>{for(const test of [exactTextAndScopeFailures,oldRequestAndNoSettleAndDetach,identityAndCardMatching,boundedDisplayCountExceptionKeepsRoutingExact,routeDiagnosticsDoNotExposeValues]){await test();console.log("PASS "+test.name);}
 console.log("Pure mock native-history verification passed; no browser or production access.");})().catch(error=>{console.error(error);process.exitCode=1;});
