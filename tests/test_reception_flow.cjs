"use strict";

// Offline integration, not real-browser, platform-permission or live-SLA proof.
// Real worker + scope + controller + UI adapter + Python RPC/temporary SQLite +
// sender + native history verifier + reception-audit CLI. Page/DOM/native GETs
// are external fixtures; ui_actions native-refresh controls are tested elsewhere.
const assert=require("node:assert/strict");
const {createFixture}=require("./helpers/reception_flow_fixture.cjs");

async function systemAndAiWelcomeThenNativeHintCompletesOneTextAndCard(){
  const f=await createFixture();try{
    await f.start();const saved=await f.status(),report=f.audit();
    console.log("FLOW_WITNESS "+JSON.stringify({scenario:"late-native-quota-hint",errors:f.model.errors,
      clicks:f.model.clicks,outbox:saved.outbox.map(x=>({operation:x.payload.operation,status:x.status})),
      worker_error:f.workerStatus().error}));
    assert.deepEqual(f.model.errors,[],"actual native HINT must not abandon the companion card");
    assert.deepEqual(f.model.clicks,["text","native_card"]);assert.equal(f.model.takeovers,1);
    assert.equal(saved.conversations[0].state,"ACTIVE");assert.equal(saved.outbox.length,2);
    for(const row of saved.outbox){
      assert.equal(row.status,"SENT");assert.equal(row.evidence.native_server_history.status,"server_history_confirmed");
      assert.equal(row.evidence.reception_event_id,"id_aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb.fresh-entry");
    }
    assert.equal(report.samples.length,1);assert.equal(report.samples[0].anchor_type,"platform_entry");
    assert.equal(report.samples[0].reply_attempts.length,2);
    // Two exact receipts do not replace the independent usefulness review.
    assert.equal(report.samples[0].full_bundle.complete,false);
    assert.equal(report.samples[0].reply_attempts.filter(x=>x.native_history_confirmed).length,2);
  }finally{await f.close();}
}
async function optimisticTextWithoutStrictHistoryPersistsUnknownAndNeverClicksCard(){
  const f=await createFixture({strictReceipt:false});try{
    await f.start();const saved=await f.status(),report=f.audit();
    assert.deepEqual(f.model.clicks,["text"]);assert.equal(saved.outbox.length,1);assert.equal(saved.outbox[0].status,"UNKNOWN");
    assert.equal(saved.outbox[0].evidence.native_server_history.status,"unknown");
    assert.equal(report.samples.length,1);assert.equal(report.samples[0].contains_unknown,true);
    assert.equal(report.samples[0].full_bundle.complete,false);
    const before=JSON.stringify(saved.outbox);
    // A real subsequent customer opening must be ingested without retrying the
    // uncertain original or attributing its optimistic bubble to another owner.
    f.model.messages.push({id:"customer-after-unknown",direction:"left",type:"TEXT",text:"synthetic new opening",time:Date.now()});
    f.model.preview="synthetic new opening after unknown";
    const deadline=Date.now()+2500;
    while(f.workerStatus().processed<2){
      if(Date.now()>deadline)throw Error("unknown follow-up candidate was not observed");
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    const after=await f.status();
    assert.equal(JSON.stringify(after.outbox),before);assert.deepEqual(f.model.clicks,["text"]);
    assert.equal(after.conversations[0].state,"ACTIVE");
    assert.equal(after.conversations[0].latest_event_id,"id_aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb.customer-after-unknown");
  }finally{await f.close();}
}
async function existingHumanOwnershipSurvivesFreshSystemWelcomeWithoutAnySend(){
  const f=await createFixture({existingHuman:true});try{
    await f.start();const saved=await f.status(),report=f.audit();
    assert.equal(saved.conversations[0].state,"HUMAN");assert.equal(saved.outbox.length,0);
    assert.equal(f.model.takeovers,0);assert.deepEqual(f.model.clicks,[]);
    assert.equal(report.samples.length,1);assert.equal(report.samples[0].reply_attempts.length,0);
    assert.equal(report.samples[0].full_bundle.complete,false);
  }finally{await f.close();}
}
async function verifiedLeadNewQuestionReceivesOneStrictTextWithoutCardOrReopening(){
  const f=await createFixture({verifiedLead:true});try{
    await f.start();const saved=await f.status();
    assert.deepEqual(f.model.errors,[]);assert.deepEqual(f.model.clicks,["text"]);assert.equal(f.model.cardOpen,false);
    assert.equal(saved.outbox.length,1);const reply=saved.outbox[0];
    assert.equal(reply.kind,"service_reply");assert.equal(reply.status,"SENT");
    assert.equal(reply.source_event_id,"id_aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb.post-lead-question");
    assert.equal(reply.evidence.native_server_history.status,"server_history_confirmed");
    assert.equal(reply.evidence.usefulness_verified,undefined);
    assert.equal(reply.evidence.reception_event_id,undefined);
    assert(reply.payload.text.includes("尺寸重量"));assert(!/添加|企微/.test(reply.payload.text));
    assert.equal(saved.conversations[0].state,"STOPPED");assert.equal(saved.conversations[0].stop_reason,"WECHAT_VERIFIED");
    assert.equal(saved.conversations[0].needs_response,0);assert.equal(saved.conversations[0].next_followup_at,null);
    assert.equal(f.controllerStatus().last_result.receive.text_only_service,true);
    assert.equal(f.controllerStatus().last_result.receive.card_status,"not_requested");
  }finally{await f.close();}
}
async function independentServiceQuestionCanReceiveOneStrictTextWhileOriginalCardRemainsUnknown(){
  const f=await createFixture({verifiedLead:true,priorCardUnknown:true});try{
    await f.start();const saved=await f.status();
    assert.deepEqual(f.model.errors,[]);assert.deepEqual(f.model.clicks,["text"]);
    const original=saved.outbox.find(row=>row.intent_id===f.model.originalUnknown.intent_id);
    assert.deepEqual(original,f.model.originalUnknown);assert.equal(original.status,"UNKNOWN");
    const service=saved.outbox.find(row=>row.kind==="service_reply");
    assert(service,"actual controller/Engine/sender chain must pass the qualified prior card hold");
    assert.equal(service.status,"SENT");assert.equal(service.evidence.native_server_history.status,"server_history_confirmed");
    assert.deepEqual(service.payload.prior_unknown_hold_ids,[original.intent_id]);
    assert.equal(saved.conversations[0].state,"STOPPED");assert.equal(saved.conversations[0].needs_response,0);
    assert.equal(f.model.cardOpen,false);assert.equal(service.evidence.usefulness_verified,undefined);
  }finally{await f.close();}
}
async function activeCustomerQuestionGetsContextualStrictTextWithoutCardOrProactiveFollowup(){
  const f=await createFixture({activeQuestion:true,priorCardUnknown:true});try{
    await f.start();const saved=await f.status();
    assert.deepEqual(f.model.errors,[]);assert.deepEqual(f.model.clicks,["text"]);
    const service=saved.outbox.find(row=>row.kind==="service_reply");assert(service);
    assert.equal(service.status,"SENT");assert.equal(service.source_event_id,"id_aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb.active-customer-question");
    assert.equal(service.evidence.native_server_history.status,"server_history_confirmed");
    assert.match(service.payload.text,/目的国或仓库.*货品类型.*预计件量.*尺寸重量/);
    assert.doesNotMatch(service.payload.text,/添加|企微/);assert.equal(service.evidence.usefulness_verified,undefined);
    assert.deepEqual(saved.outbox.find(row=>row.intent_id===f.model.originalUnknown.intent_id),f.model.originalUnknown);
    assert.equal(saved.conversations[0].state,"ACTIVE");assert.equal(saved.conversations[0].needs_response,0);
    assert.equal(saved.conversations[0].next_followup_at,null);assert.equal(f.model.cardOpen,false);
  }finally{await f.close();}
}
async function firstEntryThenImmediateCustomerQuestionStillGetsUsefulTextAndItsFirstCard(){
  const f=await createFixture({activeQuestion:true,entryThenQuestion:true});try{
    await f.start();const saved=await f.status();
    assert.deepEqual(f.model.errors,[]);assert.deepEqual(f.model.clicks,["text","native_card"]);
    assert.equal(saved.outbox.length,2);assert.equal(saved.outbox.some(row=>row.kind==="service_reply"),false);
    const text=saved.outbox.find(row=>row.payload.operation==="text");assert(text);
    assert.match(text.payload.text,/目的国或仓库.*货品类型.*预计件量.*尺寸重量/);
    assert.doesNotMatch(text.payload.text,/添加|企微/);
    assert.equal(text.status,"SENT");assert.equal(text.evidence.native_server_history.status,"server_history_confirmed");
    assert.equal(text.evidence.usefulness_verified,undefined);
    assert.equal(saved.outbox.find(row=>row.kind==="card").status,"SENT");
    assert.equal(text.evidence.reception_event_id,"id_aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb.fresh-entry");
  }finally{await f.close();}
}
(async()=>{
  let failed=0;
  for(const test of [firstEntryThenImmediateCustomerQuestionStillGetsUsefulTextAndItsFirstCard,
    activeCustomerQuestionGetsContextualStrictTextWithoutCardOrProactiveFollowup,
    independentServiceQuestionCanReceiveOneStrictTextWhileOriginalCardRemainsUnknown,
    verifiedLeadNewQuestionReceivesOneStrictTextWithoutCardOrReopening,systemAndAiWelcomeThenNativeHintCompletesOneTextAndCard,
    optimisticTextWithoutStrictHistoryPersistsUnknownAndNeverClicksCard,existingHumanOwnershipSurvivesFreshSystemWelcomeWithoutAnySend]){
    try{await test();console.log("PASS "+test.name);}catch(error){failed++;console.error("FAIL "+test.name,error.stack);}
  }
  console.log("7 offline reception-flow scenarios; failures="+failed+"; synthetic page/GETs are not live SLA evidence.");
  if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
