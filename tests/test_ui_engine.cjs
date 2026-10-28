"use strict";

// Local adapter fixtures only: no browser, RPC child, database or external send.
const assert=require("node:assert/strict");
const {ingestObservedScope}=require("../xhs_reception/ui_engine.cjs");
const A="aaaaaaaaaaaaaaaaaaaaaaaa",U="bbbbbbbbbbbbbbbbbbbbbbbb",NAME="fixture-account";
const singleton=Symbol.for("xhs_reception.ui_engine_client");
function fixture({system=true,ai=false,header=true,direction="right"}={}) {
  const at=Date.now()-1000,observed=new Date().toISOString(),native=A+"."+U+".m1";
  const message={account_id:A,conversation_id:U,message_id:"m1",message_pair_prefix:A+"."+U+".",native_scope_id:native,
    dom_id:"id_"+native,native_dom_id:"jarvis-msg-"+native,raw_timestamp:String(at),raw_type:"GENERAL",raw_text:"fixture content",
    direction,native_ai_attribution_observed:ai,native_system_attribution_observed:system};
  if(header)message.native_system_attribution_header_reference='xpath=//*[@id="'+message.dom_id+'"]//*[@id="'+message.native_dom_id+
    '"]/parent::div/preceding-sibling::div[1]/div[1]';
  const scope={scope_ready:true,state:"ready",source:"platform_ui",classification:"readonly_ui_scope",
    account_scope_verified:true,conversation_scope_verified:true,account_id:A,account_display_name:NAME,conversation_id:U,
    url:"https://sxt.xiaohongshu.com/im/multiCustomerService",title:NAME+"-私信通",profile_binding_source:"current_native_profile",
    conversation_ui:{active_data_key:"Total-"+U,profile_uid:U,row_nickname:"fixture",header_nickname:"fixture"},
    observed_at_utc:observed,messages:[message]};
  const events=[],client={request:async(method,params)=>{
    if(method==="ingest"){events.push(params.event);return {ok:true,result:{duplicate:false}};}
    return {ok:true,result:{account_scope:A,outbox:[],conversations:[]}};
  }};
  return {scope,events,client,message};
}
async function run(f,fn) {
  const previous=globalThis[singleton];globalThis[singleton]={client:f.client,accountId:A,accountDisplayName:NAME};
  try{return await fn();}finally{if(previous)globalThis[singleton]=previous;else delete globalThis[singleton];}
}
async function nativeSourceObservationSurvivesAdapterForIndependentAudit() {
  const f=fixture();await run(f,async()=>{
    assert.equal((await ingestObservedScope(f.client,f.scope,{historicalBaseline:false})).ok,true);
    const event=f.events[0];assert.equal(event.type,"OUTBOUND_OBSERVED");
    assert.equal(event.evidence.native_system_attribution_observed,true);
    assert.equal(event.evidence.native_ai_attribution_observed,false);
    assert.equal(event.evidence.native_system_attribution_header_reference,f.message.native_system_attribution_header_reference);
    assert.equal(event.evidence.historical_baseline,false);
  });
}
async function missingOrFalseSystemProofCannotPersistHeaderAttribution() {
  for(const system of [false,undefined,"true"]){
    const f=fixture({system,header:true});if(system===undefined)delete f.message.native_system_attribution_observed;
    await run(f,async()=>{
      assert.equal((await ingestObservedScope(f.client,f.scope,{historicalBaseline:false})).ok,true);
      assert.equal(f.events[0].evidence.native_system_attribution_observed,false);
      assert.equal(Object.hasOwn(f.events[0].evidence,"native_system_attribution_header_reference"),false);
    });
  }
}
async function wrongOrMissingSystemHeaderReferenceFailsBeforeAnyIngest() {
  for(const header of [undefined,"customer-body-claim",'xpath=//*[@id="foreign-message"]']){
    const f=fixture({header:false});if(header!==undefined)f.message.native_system_attribution_header_reference=header;
    await run(f,async()=>{
      await assert.rejects(ingestObservedScope(f.client,f.scope,{historicalBaseline:false}),/native_system_header_reference_required/);
      assert.equal(f.events.length,0);
    });
  }
}

async function onlyUnattributedOutboundLinksToTheCurrentCustomerTurn() {
  for(const attribution of ["unattributed","ai","system"]){
    const f=fixture({system:false,header:true,direction:"left"});
    const customer=f.message;customer.raw_type="TEXT";
    const native=A+"."+U+".m2";
    const reply={...customer,message_id:"m2",native_scope_id:native,dom_id:"id_"+native,native_dom_id:"jarvis-msg-"+native,
      raw_timestamp:String(Number(customer.raw_timestamp)+100),raw_type:"TEXT",raw_text:"fixture reply",direction:"right",
      native_ai_attribution_observed:attribution==="ai",native_system_attribution_observed:attribution==="system"};
    if(attribution==="system")reply.native_system_attribution_header_reference='xpath=//*[@id="'+reply.dom_id+
      '"]//*[@id="'+reply.native_dom_id+'"]/parent::div/preceding-sibling::div[1]/div[1]';
    f.scope.messages=[customer,reply];
    await run(f,async()=>{
      assert.equal((await ingestObservedScope(f.client,f.scope,{historicalBaseline:false})).ok,true);
      const outbound=f.events.find(event=>event.type==="OUTBOUND_OBSERVED");
      if(attribution==="unattributed")assert.equal(outbound.evidence.responds_to_event_id,customer.dom_id);
      else assert.equal(Object.hasOwn(outbound.evidence,"responds_to_event_id"),false);
    });
  }
}
(async()=>{
  const cases=[nativeSourceObservationSurvivesAdapterForIndependentAudit,missingOrFalseSystemProofCannotPersistHeaderAttribution,
    wrongOrMissingSystemHeaderReferenceFailsBeforeAnyIngest,onlyUnattributedOutboundLinksToTheCurrentCustomerTurn];
  for(const test of cases){await test();console.log("PASS "+test.name);}
  console.log(cases.length+" observation adapter regressions passed; no production resources used.");
})().catch(error=>{console.error(error);process.exitCode=1;});
