"use strict";

// Actual helper APIs with synthetic events only. No browser/network/DB or sends.
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {createHash}=require("node:crypto");
const history=require("../xhs_reception/native_history_receipt.cjs");
const {arm}=require("../xhs_reception/native_card_request_proof.cjs");
const A="aaaaaaaaaaaaaaaaaaaaaaaa",U="bbbbbbbbbbbbbbbbbbbbbbbb",V="cccccccccccccccccccccccc",STAFF="1234567890";
const card={id:"fixture-card",type:"business",contentType:"CARD",msgContentType:"CARD",title:"企业微信",name:"运去哪海外仓（企微）",
  inviteInfo:"邀请添加企业微信",corpName:"fixture-corp",cardType:"wecom",contactList:[{link:"https://example.invalid/route?customer="+U}]};
const sha=value=>createHash("sha256").update(value).digest("hex");
class Page extends EventEmitter {
  constructor(){super();this.frameObject={};}
  url(){return "https://sxt.xiaohongshu.com/im/multiCustomerService";}
  mainFrame(){return this.frameObject;}
}
function request(page,content=JSON.stringify(card),changes={},meta={}) {
  const payload={sender_porch_id:A,receiver_id:U,content,message_type:"CARD",uuid:"private-request-uuid",c_user_id:STAFF,platform:"fixture",...changes};
  const bytes=meta.bytes || Buffer.from(JSON.stringify(payload));
  let bodyReads=0;
  return {url:()=>meta.url || "https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg",method:()=>meta.method || "POST",
    resourceType:()=>meta.resourceType || "xhr",frame:()=>meta.frame || page.mainFrame(),postDataBuffer:()=>{bodyReads++;return bytes;},
    bodyReads:()=>bodyReads};
}
async function independentIdentity() {
  const page=new Page(),api=history.attach(page),at=Date.now()-5000,id=A+"."+V+".independent";
  const data={success:true,code:0,data:{messages:[{sixin_message:{id,sender_id:A,receiver_id:V,content:JSON.stringify(card),created_at:at,message_type:"CARD"},message_extension:{customer_user_id:V}}]}};
  const r={url:()=>"https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg?customer_user_id="+V,method:()=>"GET",
    response:async()=>({status:()=>200,body:async()=>Buffer.from(JSON.stringify(data))})};
  page.emit("request",r);page.emit("requestfinished",r);
  await new Promise(resolve=>setImmediate(resolve));
  const result=api.cardIdentity({scope_ready:true,account_scope_verified:true,conversation_scope_verified:true,classification:"readonly_ui_scope",source:"platform_ui",account_id:A,conversation_id:V,
    messages:[{account_id:A,conversation_id:V,message_id:"independent",dom_id:"id_"+id,native_dom_id:"jarvis-msg-"+id,
      direction:"right",raw_type:"CARD",raw_timestamp:String(at),native_business_card_candidate:true,raw_text:"运去哪海外仓（企微）\n企业微信"}]});
  api.detach();assert.equal(result.status,"native_card_identity_confirmed");return result.cardIdentity;
}
function unknown(report) {assert.equal(report.phase,"diagnostic_schema_unverified");assert.equal(report.status,"unknown");assert.equal(report.schema_verified,false);assert.equal(report.can_confirm_send,false);}
async function main() {
  const identity=await independentIdentity(),realNow=Date.now,base=realNow();let now=base;
  const options={accountId:A,conversationId:U,staffNumber:STAFF,independentCardIdentity:identity,intentId:"fixture-intent"};
  Date.now=()=>now;
  try {
    {
      const page=new Page(),beforeArm=request(page);page.emit("request",beforeArm);
      const collector=arm(page,options),beforeCommit=request(page);page.emit("request",beforeCommit);
      assert.equal(beforeArm.bodyReads(),0);assert.equal(beforeCommit.bodyReads(),0);assert.equal(collector.bindingReport().candidate_count,0);
      collector.beginSubmit(base);const r=request(page);page.emit("request",r);
      const report=collector.bindingReport();unknown(report);assert.equal(report.unique_request,true);assert.equal(report.reason,"native_field_semantics_unverified");
      const candidate=report.candidates[0];assert.equal(candidate.fields.sender_porch_id.equals_account_id,true);
      assert.equal(candidate.fields.receiver_id.equals_customer_uid,true);assert.equal(candidate.fields.c_user_id.equals_staff_number,true);
      assert(candidate.stable_identity_fields.every(field=>field.equal));assert.equal(candidate.raw_content_sha256,sha(JSON.stringify(card)));
      assert.match(candidate.canonical_content_sha256,/^[a-f0-9]{64}$/);
      const safe=JSON.stringify(report);for(const value of [A,U,V,STAFF,card.name,"example.invalid","private-request-uuid"])assert(!safe.includes(value));
      assert.deepEqual(Object.keys(collector).sort(),["beginSubmit","bindingReport","detach"]);
      assert.throws(()=>collector.beginSubmit(base+1),/begin_submit_already_bound/);
      assert.throws(()=>arm(page,options),/collector_already_armed/);
      collector.detach();page.emit("request",request(page));assert.equal(collector.bindingReport().candidate_count,1);
      console.log("PASS no-arm/no-commit gate, diagnostic-only exact comparisons, hashes, redaction and detach");
    }
    {
      const page=new Page();assert.throws(()=>arm(page,{...options,independentCardIdentity:{...identity}}),/independent_native_card_identity_required/);
      assert.throws(()=>arm(page,{...options,accountId:V}),/independent_native_card_identity_required/);assert.equal(page.listenerCount("request"),0);
      const collector=arm(page,options);collector.beginSubmit(base);
      page.emit("request",request(page,JSON.stringify(card),{receiver_id:V}));
      const report=collector.bindingReport();unknown(report);assert.equal(report.reason,"receiver_not_expected_customer");
      assert.equal(report.candidates[0].fields.receiver_id.equals_customer_uid,false);collector.detach();
      console.log("PASS independent identity clone/wrong-account and wrong-recipient negatives");
    }
    {
      const page=new Page(),collector=arm(page,options);collector.beginSubmit(base);
      const one=request(page),two=request(page);page.emit("request",one);page.emit("request",two);page.emit("request",one);
      const report=collector.bindingReport();unknown(report);assert.equal(report.candidate_count,2);assert.equal(report.unique_request,false);
      assert.equal(report.reason,"ambiguous_native_requests");collector.detach();
      const latePage=new Page(),late=arm(latePage,options);late.beginSubmit(base);now=base+2501;
      const r=request(latePage);latePage.emit("request",r);assert.equal(r.bodyReads(),0);assert.equal(late.bindingReport().candidate_count,0);
      assert.equal(late.bindingReport().rejected.outside_submit_window,1);late.detach();now=base;
      console.log("PASS duplicate actual request ambiguity and expired commit window");
    }
    {
      const page=new Page(),collector=arm(page,options);collector.beginSubmit(base);
      page.emit("request",request(page,undefined,{}, {bytes:Buffer.alloc(65537)}));
      page.emit("request",request(page,undefined,{}, {url:"https://example.invalid/api-sxt/edith/chatline/msg"}));
      page.emit("request",request(page,undefined,{}, {method:"GET"}));
      page.emit("request",request(page,undefined,{}, {frame:{}}));
      page.emit("request",request(page,undefined,{message_type:"TEXT"}));
      const report=collector.bindingReport();unknown(report);assert.equal(report.candidate_count,0);
      for(const key of ["body_too_large","unexpected_endpoint","not_native_post","unexpected_ui_frame","not_exact_card_type"])assert.equal(report.rejected[key],1);
      collector.detach();console.log("PASS body bound, origin/method/frame and exact CARD gates");
    }
    {
      function capture(content) {const page=new Page(),collector=arm(page,options);collector.beginSubmit(base);page.emit("request",request(page,content));const result=collector.bindingReport();collector.detach();return result;}
      const original=capture(JSON.stringify(card)),reordered=capture(JSON.stringify(Object.fromEntries(Object.entries(card).reverse())));
      assert.notEqual(original.candidates[0].raw_content_sha256,reordered.candidates[0].raw_content_sha256);
      assert.equal(original.candidates[0].canonical_content_sha256,reordered.candidates[0].canonical_content_sha256);
      const routed={...card,contactList:[{link:"https://example.invalid/route?customer="+V}]},dynamic=capture(JSON.stringify(routed));
      unknown(dynamic);assert(dynamic.candidates[0].stable_identity_fields.every(field=>field.equal));
      assert.notEqual(original.candidates[0].canonical_content_sha256,dynamic.candidates[0].canonical_content_sha256);
      const wrong=capture(JSON.stringify({...card,id:"wrong-card"}));assert.equal(wrong.reason,"independent_card_identity_mismatch");
      console.log("PASS complete content hash covers dynamic routing and independent nine-field identity remains exact");
    }
  } finally {Date.now=realNow;}
  console.log("5 synthetic native-card-request groups passed; no native field semantics or send confirmation granted.");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
