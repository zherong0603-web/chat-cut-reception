import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.mjs';
import { createSender, verifyNativeHistory } from '../sender.mjs';

const accountId='aaaaaaaaaaaaaaaaaaaaaaaa', conversationId='bbbbbbbbbbbbbbbbbbbbbbbb';
function fixture(overrides={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reception-v2-sender-'));
  const store=openDatabase(path.join(dir,'db.sqlite3'));
  const turn=store.ingestInbound({accountId,conversationId,eventId:'event-1',text:'报价',platformTimeMs:1000});
  const scope={accountId,conversationId,nickname:'客户',messages:[{nativeId:'jarvis-msg-'+conversationId+'.'+accountId+'.m1',direction:'left',type:'TEXT',text:'报价',platformTimeMs:1000,isCustomerText:true}]};
  const calls=[];
  const browser={mode:async()=>({manual:browser.state.manual,inputReady:true,scopeReady:true,overlayVisible:!browser.state.manual,takeoverVisible:!browser.state.manual,pageVisible:true,conversationId:browser.state.activeConversation,activeKey:'Total-'+browser.state.activeConversation}),
    clickTakeover:async()=>{calls.push('takeover');browser.state.manual=true;return {clicked:true}},
    fillText:async(_s,text)=>{calls.push('fill:'+text)},
    clickTextSend:async()=>{calls.push('text');return {observedAtMs:2200}},
    sendCard:async()=>{calls.push('card');return {observedAtMs:2200}},
    waitForReceipt:async(intent)=>({serverStatus:'confirmed',accountId,conversationId,content:intent.content,type:intent.kind==='card'?'CARD':'TEXT',cardTitle:intent.kind==='card'?'企微_运去哪海外仓（企微）':null,platformTimeMs:2100,observedAtMs:2200,visibleAtMs:2200,
      senderId:accountId,receiverId:conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${conversationId}.${intent.kind}`,...(overrides.receipt||{})}),
    state:{manual:false,activeConversation:conversationId},calls};
  const sender=createSender({store,browser,now:()=>2000});
  return {dir,store,turn,scope,browser,sender};
}

test('clicks takeover once when overlay is present',async()=>{
  const f=fixture();try{const receipt=await f.sender.enterHumanMode(f.scope);assert.equal(receipt.clicked,true);assert.deepEqual(f.browser.calls,['takeover']);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('already manual mode does not click',async()=>{
  const f=fixture();f.browser.mode=async()=>({manual:true,inputReady:true,scopeReady:true,overlayVisible:false,takeoverVisible:false});try{const receipt=await f.sender.enterHumanMode(f.scope);assert.equal(receipt.clicked,false);assert.equal(f.browser.calls.length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('fills and submits text when empty and exact uid is active',async()=>{
  const f=fixture();f.browser.state.manual=true;const intent=f.store.createIntent({turnId:f.turn.turnId,kind:'text',content:'你好'});try{const result=await f.sender.sendText(intent.intentId,f.scope,1000);assert.equal(result.state,'sent');assert.deepEqual(f.browser.calls,['fill:你好','text']);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('refuses existing operator draft',async()=>{
  const f=fixture();f.browser.state.manual=true;const intent=f.store.createIntent({turnId:f.turn.turnId,kind:'text',content:'你好'});f.browser.prepareText=async()=>{throw new Error('existing_operator_draft_preserved')};f.browser.fillText=f.browser.prepareText;try{await assert.rejects(()=>f.sender.sendText(intent.intentId,f.scope,1000),/existing_operator_draft_preserved/);assert.equal(f.store.getIntent(intent.intentId).state,'prepared');}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('sends only unique approved wecom card',async()=>{
  const f=fixture();f.browser.state.manual=true;const intent=f.store.createIntent({turnId:f.turn.turnId,kind:'card',payload:{cardTitle:'企微_运去哪海外仓（企微）'}});try{const result=await f.sender.sendWeComCard(intent.intentId,f.scope,1000);assert.equal(result.state,'sent');assert.deepEqual(f.browser.calls,['card']);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('duplicate intent never reaches click',async()=>{
  const f=fixture();f.browser.state.manual=true;const intent=f.store.createIntent({turnId:f.turn.turnId,kind:'text',content:'你好'});try{await f.sender.sendText(intent.intentId,f.scope,1000);await assert.rejects(()=>f.sender.sendText(intent.intentId,f.scope,1000),/intent_not_prepared/);assert.deepEqual(f.browser.calls,['fill:你好','text']);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('http 200 without native match is not success',async()=>{
  const f=fixture({receipt:{serverStatus:'pending',httpStatus:200,businessCode:0,observedAtMs:1800}});f.browser.state.manual=true;const intent=f.store.createIntent({turnId:f.turn.turnId,kind:'text',content:'你好'});try{const result=await f.sender.sendText(intent.intentId,f.scope,1000);assert.equal(result.state,'uncertain');assert.equal(f.store.getIntent(intent.intentId).state,'uncertain');}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('pending receipt is rechecked in refreshed native history without resending',async()=>{
  const f=fixture();f.browser.state.manual=true;let calls=0;f.browser.waitForReceipt=async(intent)=>{calls++;if(calls===1)return{serverStatus:'pending',observedAtMs:2200};return{serverStatus:'confirmed',accountId,conversationId,content:intent.content,type:'TEXT',cardTitle:null,platformTimeMs:2100,observedAtMs:2600,visibleAtMs:2600,senderId:accountId,receiverId:conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${conversationId}.retry`}};f.browser.refreshConversation=async()=>{f.browser.calls.push('refresh');return{scopeReady:true,conversationId}};const intent=f.store.createIntent({turnId:f.turn.turnId,kind:'text',content:'你好'});try{const result=await f.sender.sendText(intent.intentId,f.scope,1000);assert.equal(result.state,'sent');assert.equal(calls,2);assert.equal(f.store.getIntent(intent.intentId).state,'sent');assert.deepEqual(f.browser.calls,['fill:你好','text','refresh']);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('platform block returns send blocked',async()=>{
  const f=fixture();f.browser.state.manual=true;const intent=f.store.createIntent({turnId:f.turn.turnId,kind:'text',content:'你好'});f.browser.fillText=async()=>{throw Object.assign(new Error('platform_blocked'),{code:'platform_blocked'})};try{const result=await f.sender.sendText(intent.intentId,f.scope,1000);assert.equal(result.state,'send_blocked');assert.equal(f.store.getIntent(intent.intentId).state,'failed');}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('collapsed or hidden page blocks send',async()=>{
  const f=fixture();const intent=f.store.createIntent({turnId:f.turn.turnId,kind:'text',content:'你好'});f.browser.mode=async()=>({manual:false,inputReady:false,scopeReady:false,overlayVisible:false,takeoverVisible:false,pageVisible:false});try{await assert.rejects(()=>f.sender.sendText(intent.intentId,f.scope,1000),/page_not_visible/);assert.equal(f.store.getIntent(intent.intentId).state,'prepared');}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('strict native history rejects pre-submit and mismatched records',()=>{
  const intent={accountId,conversationId,kind:'text',content:'你好',payload:{}};
  const good={serverStatus:'confirmed',accountId,conversationId,content:'你好',type:'TEXT',platformTimeMs:2100,observedAtMs:2200,visibleAtMs:2200,
    senderId:accountId,receiverId:conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${conversationId}.m1`};
  assert.equal(verifyNativeHistory(intent,good,1000,2000),true);
  assert.equal(verifyNativeHistory(intent,{...good,observedAtMs:1800},1000,2000),false);
  assert.equal(verifyNativeHistory(intent,{...good,platformTimeMs:999},1000,2000),false);
  assert.equal(verifyNativeHistory(intent,{...good,platformTimeMs:1900},1000,2000),false);
  assert.equal(verifyNativeHistory(intent,{...good,visibleAtMs:null},1000,2000),true);
  assert.equal(verifyNativeHistory(intent,{...good,senderId:conversationId},1000,2000),false);
  assert.equal(verifyNativeHistory(intent,{...good,receiverId:accountId},1000,2000),false);
  assert.equal(verifyNativeHistory(intent,{...good,direction:'INBOUND'},1000,2000),false);
  assert.equal(verifyNativeHistory(intent,{...good,nativeId:null},1000,2000),false);
});

test('active customer switch after mode check blocks text send',async()=>{
  const f=fixture();f.browser.state.manual=true;const original=f.browser.fillText;f.browser.fillText=async(...args)=>{await original(...args);f.browser.state.activeConversation='cccccccccccccccccccccccc';};const intent=f.store.createIntent({turnId:f.turn.turnId,kind:'text',content:'你好'});try{await assert.rejects(()=>f.sender.sendText(intent.intentId,f.scope,1000),/active_uid_changed_before_send/);assert.equal(f.store.getIntent(intent.intentId).state,'prepared');assert.equal(f.state?.manual,undefined);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('text and card receipts are awaited concurrently inside the same 2s window',async()=>{
  const f=fixture();f.browser.state.manual=true;
  const textIntent=f.store.createIntent({turnId:f.turn.turnId,kind:'text',content:'你好'});
  const cardIntent=f.store.createIntent({turnId:f.turn.turnId,kind:'card',payload:{cardTitle:'企微_运去哪海外仓（企微）'}});
  let activeWaits=0,maxWaits=0;
  f.browser.waitForReceipt=async(intent)=>{activeWaits++;maxWaits=Math.max(maxWaits,activeWaits);await new Promise(r=>setTimeout(r,10));activeWaits--;return {serverStatus:'confirmed',accountId,conversationId,content:intent.content,type:intent.kind==='card'?'CARD':'TEXT',cardTitle:intent.kind==='card'?'企微_运去哪海外仓（企微）':null,platformTimeMs:2100,observedAtMs:2200,visibleAtMs:2200,
    senderId:accountId,receiverId:conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${conversationId}.${intent.kind}`};};
  try{const result=await f.sender.sendTextAndCard(textIntent.intentId,cardIntent.intentId,f.scope,1000);assert.equal(maxWaits,2);assert.equal(result.state,'sent');assert.equal(result.withinTwoSeconds,true);assert.deepEqual(f.browser.calls,['fill:你好','text','card']);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('strict card history is verified against the configured card identity',()=>{
  const card={title:'企微_账号B（企微）',visibleName:'账号B（企微）',id:'100200300',csaAccountNo:'9988776655',corpName:'@账号B企业'};
  const intent={accountId,conversationId,kind:'card',payload:{cardTitle:card.title}};
  const receipt={serverStatus:'confirmed',accountId,conversationId,type:'CARD',cardTitle:card.title,platformTimeMs:2100,observedAtMs:2200,visibleAtMs:2200,
    senderId:accountId,receiverId:conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${conversationId}.card`};
  assert.equal(verifyNativeHistory(intent,receipt,1000,2000,card),true);
  assert.equal(verifyNativeHistory(intent,{...receipt,cardTitle:'企微_运去哪海外仓（企微）'},1000,2000,card),false);
});

test('card failure after text click never leaves text permanently sending',async()=>{
  const f=fixture();f.browser.state.manual=true;f.browser.sendCard=async()=>{f.browser.calls.push('card');throw new Error('card_send_dom_changed')};
  const textIntent=f.store.createIntent({turnId:f.turn.turnId,kind:'text',content:'你好'});
  const cardIntent=f.store.createIntent({turnId:f.turn.turnId,kind:'card',payload:{cardTitle:'企微_运去哪海外仓（企微）'}});
  try{const result=await f.sender.sendTextAndCard(textIntent.intentId,cardIntent.intentId,f.scope,1000);assert.equal(result.text.state,'uncertain');assert.equal(result.card.state,'uncertain');assert.equal(f.store.getIntent(textIntent.intentId).state,'uncertain');assert.equal(f.store.getIntent(cardIntent.intentId).state,'uncertain');}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});


test('server history controls reply speed while UI hydration does not block confirmation',()=>{
  const intent={accountId,conversationId,kind:'text',content:'你好',payload:{}};
  const serverOnly={serverStatus:'confirmed',accountId,conversationId,content:'你好',type:'TEXT',platformTimeMs:2500,observedAtMs:9000,visibleAtMs:null,
    senderId:accountId,receiverId:conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${conversationId}.m1`};
  assert.equal(verifyNativeHistory(intent,serverOnly,1000,2000),true);
});

test('three-second target uses platform post time rather than slow confirmation time',async()=>{
  const f=fixture({receipt:{platformTimeMs:3500,observedAtMs:9000,visibleAtMs:null}});f.browser.state.manual=true;
  const intent=f.store.createIntent({turnId:f.turn.turnId,kind:'text',content:'你好'});
  try{const result=await f.sender.sendText(intent.intentId,f.scope,1000);assert.equal(result.state,'sent');assert.equal(result.postedMs,2500);assert.equal(result.confirmedMs,8000);assert.equal(result.withinTwoSeconds,false);assert.equal(result.withinThreeSeconds,true);assert.equal(f.store.getIntent(intent.intentId).payload.withinThreeSeconds,true);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
