import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.mjs';
import { composeReply } from '../responder.mjs';
import { createSender } from '../sender.mjs';
import { createOrchestrator, isTodaySidebarTime, parseSidebarTimeToday } from '../orchestrator.mjs';
import { createReplySchedule } from '../reply-schedule.mjs';
const accountId='aaaaaaaaaaaaaaaaaaaaaaaa',u1='bbbbbbbbbbbbbbbbbbbbbbbb',u2='cccccccccccccccccccccccc';
const facts={approved:true,account_name:'运去哪海外仓',supported_regions:['美国','墨西哥'],unsupported_regions:['日本'],service_capabilities:['海外仓储','一件代发'],unsupported_services:['个人寄件'],qualification_fields:['货品']};
function browserWith(state){const calls=state.calls,b={state:{manual:true},mode:async()=>({manual:b.state.manual,inputReady:true,scopeReady:true,pageVisible:true,overlayVisible:!b.state.manual,takeoverVisible:!b.state.manual}),clickTakeover:async()=>{calls.push('takeover');b.state.manual=true},fillText:async(_s,text)=>{calls.push('fill:'+text)},clickTextSend:async()=>{calls.push('text-send')},sendCard:async()=>{calls.push('card-send')},waitForReceipt:async(intent)=>state.receiptFor(intent)};return b;}
function fixture({rows=[{uid:u1,nickname:'甲',needsReply:true}],scopes={},sourceTimeMs=1000}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reception-v2-orch-'));const store=openDatabase(path.join(dir,'db.sqlite3'));const state={calls:[],cards:[],rows};const fixtureClock={value:10000};
 state.receiptFor=intent=>({serverStatus:'confirmed',accountId,conversationId:intent.conversationId,content:intent.content,type:intent.kind==='card'?'CARD':'TEXT',cardTitle:intent.kind==='card'?'企微_运去哪海外仓（企微）':null,platformTimeMs:sourceTimeMs+1100,observedAtMs:sourceTimeMs+1200,visibleAtMs:sourceTimeMs+1200,
   senderId:accountId,receiverId:intent.conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${intent.conversationId}.${intent.intentId}`});
 const browser=browserWith(state),sender=createSender({store,browser,now:()=>sourceTimeMs+800});
 const scopeFor=uid=>scopes[uid]||{accountId,conversationId:uid,nickname:uid===u1?'甲':'乙',profileFields:[],messages:[{nativeId:'jarvis-msg-'+uid+'.'+accountId+'.m1',direction:'left',type:'TEXT',text:'你好',platformTimeMs:sourceTimeMs,isCustomerText:true}]};
 const deps={store,sender,composeReply:(args)=>composeReply({...args,facts}),facts,accountId,readSidebar:async()=>({rows}),selectConversation:async uid=>scopeFor(uid),readContacts:async()=>[],revealMaskedContacts:async()=>[],notifier:{enqueue:async card=>{state.cards.push(card)},notifyBlocked:async card=>{state.cards.push(card)}},now:()=>fixtureClock.value,sleep:async ms=>{fixtureClock.value+=ms;}};
 const orchestrator=createOrchestrator(deps);
 return {dir,store,state,browser,sender,orchestrator,scopeFor,facts};
}
test('new entry enters manual mode then sends text and card',async()=>{const f=fixture();try{f.browser.state.manual=false;const result=await f.orchestrator.processRow({uid:u1,nickname:'甲',needsReply:true});assert.equal(result.state,'waiting_contact');assert.equal(f.state.calls[0],'takeover');assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);assert.equal(f.state.calls.filter(x=>x==='card-send').length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('same uid second message is new turn not new person',async()=>{const f=fixture();let text='你好';const scopes={[u1]:{accountId,conversationId:u1,nickname:'甲',profileFields:[],messages:[{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m1',direction:'left',type:'TEXT',text:'你好',platformTimeMs:1000,isCustomerText:true}]}};const o=createOrchestrator({store:f.store,sender:f.sender,composeReply:a=>composeReply({...a,facts}),facts,accountId,readSidebar:async()=>({rows:[]}),selectConversation:async()=>scopes[u1],readContacts:async()=>[],revealMaskedContacts:async()=>[],notifier:{enqueue:async c=>f.state.cards.push(c),notifyBlocked:async c=>f.state.cards.push(c)},now:()=>10000,sleep:async()=>{}});try{await o.processRow({uid:u1,needsReply:true});scopes[u1]={...scopes[u1],messages:[...scopes[u1].messages,{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m2',direction:'left',type:'TEXT',text:'还在吗',platformTimeMs:2000,isCustomerText:true}]};o.setNow?.(3000);await o.processRow({uid:u1,needsReply:true});assert.equal(f.store.listTurns(accountId,u1).length,2);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('contact obtained stops acquisition',async()=>{const f=fixture();const contact={accountId,conversationId:u1,kind:'phone',value:'17300006725',source:'profile',verified:true};try{const o=createOrchestrator({...f.orchestrator.deps,readContacts:async()=>[contact],facts,composeReply:a=>composeReply({...a,facts})});const result=await o.processRow({uid:u1,needsReply:true});assert.equal(result.state,'contact_obtained');assert.equal(f.state.calls.length,0);assert.equal(f.state.cards[0].kind,'ready_to_follow');}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('lead badge still reveals and pushes the full contact',async()=>{
  const f=fixture();const contact={accountId,conversationId:u1,kind:'phone',value:'17300006725',source:'profile',verified:true};
  try{const o=createOrchestrator({...f.orchestrator.deps,revealMaskedContacts:async()=>[contact],readContacts:async()=>[]});const result=await o.processRow({uid:u1,nickname:'甲',needsReply:false,leadSignal:true});assert.equal(result.state,'contact_obtained');assert.equal(f.state.cards[0].contact,'手机号 17300006725');assert.deepEqual(f.state.cards[0].details.contacts.map(item=>item.kind),['phone']);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('native wecom-added or submitted lead stops all sends and uses plain labels',async()=>{const f=fixture();const contacts=[{accountId,conversationId:u1,kind:'wecom_added',value:'已添加企微',source:'profile',verified:true},{accountId,conversationId:u1,kind:'lead_submitted',value:'已提交留资卡',source:'profile',verified:true}];const o=createOrchestrator({...f.orchestrator.deps,readContacts:async()=>contacts,facts,composeReply:a=>composeReply({...a,facts})});try{const result=await o.processRow({uid:u1,needsReply:true});assert.equal(result.state,'contact_obtained');assert.equal(f.state.calls.length,0);assert.match(f.state.cards[0].contact,/已添加企微/);assert.match(f.state.cards[0].contact,/已提交留资卡/);assert.doesNotMatch(f.state.cards[0].contact,/微信号/);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('unverified contact candidate alerts operator but does not stop reception',async()=>{const f=fixture();const candidate={accountId,conversationId:u1,kind:'wechat_candidate',value:'SKU_ABC123',source:'customer_message',verified:false};const o=createOrchestrator({...f.orchestrator.deps,readContacts:async()=>[candidate],facts,composeReply:a=>composeReply({...a,facts})});try{const result=await o.processRow({uid:u1,needsReply:true});assert.notEqual(result.state,'contact_obtained');assert.equal(f.store.getConversation(accountId,u1).state,'waiting_contact');assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);assert.equal(f.state.cards[0].kind,'needs_operator');assert.match(f.state.cards[0].contact,/SKU_ABC123/);assert.doesNotMatch(f.state.cards.map(card=>card.kind).join(','),/ready_to_follow/);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('native 留资客 sidebar status stops acquisition without another contact scan',async()=>{const f=fixture();const o=createOrchestrator({...f.orchestrator.deps,readContacts:async()=>{throw new Error('should_not_scan')},revealMaskedContacts:async()=>{throw new Error('should_not_reveal')},facts,composeReply:a=>composeReply({...a,facts})});try{const result=await o.processRow({uid:u1,needsReply:true,leadSignal:true,statusTags:['留资客']});assert.equal(result.state,'contact_obtained');assert.equal(f.state.calls.length,0);assert.match(f.state.cards[0].contact,/已提交留资卡/);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('takeover happens before contact lookup or reply composition',async()=>{const f=fixture();f.browser.state.manual=false;const contact={accountId,conversationId:u1,kind:'phone',value:'17300006725',source:'profile',verified:true};const o=createOrchestrator({...f.orchestrator.deps,readContacts:async()=>{f.state.calls.push('read-contact');return [contact]},revealMaskedContacts:async()=>{f.state.calls.push('reveal-contact');return []},facts,composeReply:a=>{f.state.calls.push('compose');return composeReply({...a,facts})}});try{const result=await o.processRow({uid:u1,needsReply:true});assert.equal(result.state,'contact_obtained');assert.equal(f.state.calls[0],'takeover');assert.equal(f.state.calls.includes('compose'),false);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('refusal stops acquisition',async()=>{const f=fixture();try{const row={uid:u1,needsReply:true};const scope={accountId,conversationId:u1,nickname:'甲',profileFields:[],messages:[{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m1',direction:'left',type:'TEXT',text:'不用了，不要再联系我',platformTimeMs:1000,isCustomerText:true}]};const o=createOrchestrator({...f.orchestrator.deps,selectConversation:async()=>scope,facts,composeReply:a=>composeReply({...a,facts})});const result=await o.processRow(row);assert.equal(result.state,'stopped');assert.equal(f.state.calls.length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('startup sweeps visible overdue rows serially',async()=>{const f=fixture({rows:[{uid:u1,needsReply:true},{uid:u2,needsReply:true}]});let active=0,maxActive=0;const orig=f.orchestrator.processRow;const o=f.orchestrator;const rows=[];const select=async uid=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,5));active--;return f.scopeFor(uid)};o.deps.selectConversation=select;try{const result=await o.sweepVisibleOverdue();assert.equal(result.processed,2);assert.equal(maxActive,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('overdue time uses the platform sidebar clock instead of detection time',()=>{
  const now=new Date(2026,9,27,18,50,0).getTime();
  assert.equal(parseSidebarTimeToday('16:54:43',now),new Date(2026,9,27,16,54,43).getTime());
  assert.equal(parseSidebarTimeToday('19:10:00',new Date(2026,9,27,0,5,0).getTime()),new Date(2026,9,26,19,10,0).getTime());
  assert.equal(parseSidebarTimeToday('昨天',now),null);
});
test('startup can take over todays non-overdue reception rows but skips dated history',async()=>{
  const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:false,time:'00:00:09',preview:'你好'},{uid:u2,nickname:'乙',needsReply:false,time:'10/27',preview:'旧消息'}]});
  try{assert.equal(isTodaySidebarTime('00:00:09',10000),true);assert.equal(isTodaySidebarTime('10/27',10000),false);
    const result=await f.orchestrator.sweepVisibleOverdue({processToday:true,contactScan:false});assert.equal(result.processed,1);assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);assert.equal(f.store.listTurns(accountId,u1).length,1);assert.equal(f.store.listTurns(accountId,u2).length,0);
  }finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('startup replies to overdue rows before scanning other contacts',async()=>{const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:true},{uid:u2,nickname:'乙',needsReply:false}]});const selected=[];f.orchestrator.deps.selectConversation=async uid=>{selected.push(uid);return f.scopeFor(uid)};try{await f.orchestrator.sweepVisibleOverdue();assert.deepEqual(selected,[u1,u2]);assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('pilot sweep processes only one overdue customer and skips the contact scan',async()=>{const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:true},{uid:u2,nickname:'乙',needsReply:true}]});const selected=[];f.orchestrator.deps.selectConversation=async uid=>{selected.push(uid);return f.scopeFor(uid)};try{const result=await f.orchestrator.sweepVisibleOverdue({maxRows:1,contactScan:false});assert.equal(result.processed,1);assert.deepEqual(selected,[u1]);assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('pilot sweep skips an already held customer and processes the next overdue row',async()=>{const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:true},{uid:u2,nickname:'乙',needsReply:true}]});f.store.ingestInbound({accountId,conversationId:u1,eventId:'held',text:'',type:'SIDEBAR_OVERDUE',platformTimeMs:1});f.store.setConversationState(accountId,u1,'needs_human');const selected=[];f.orchestrator.deps.selectConversation=async uid=>{selected.push(uid);return f.scopeFor(uid)};try{const result=await f.orchestrator.sweepVisibleOverdue({maxRows:1,contactScan:false});assert.equal(result.processed,1);assert.deepEqual(selected,[u2]);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('unknown text blocks same text but not later new turn',async()=>{const f=fixture();f.browser.state.manual=true;f.state.receiptFor=intent=>intent.kind==='text'?{serverStatus:'pending',observedAtMs:1800}:{serverStatus:'confirmed',accountId,conversationId:intent.conversationId,type:'CARD',cardTitle:'企微_运去哪海外仓（企微）',platformTimeMs:2100,observedAtMs:2200,visibleAtMs:2200,senderId:accountId,receiverId:intent.conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${intent.conversationId}.${intent.intentId}`};try{const result=await f.orchestrator.processRow({uid:u1,needsReply:true});assert.equal(result.text.state,'uncertain');assert.equal(f.store.getConversation(accountId,u1).state,'needs_human');const turn=f.store.listTurns(accountId,u1)[0];assert.throws(()=>f.store.createIntent({turnId:turn.turnId,kind:'text',content:result.reply.text}),/duplicate_outbound_content/);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('uncertain card does not trigger an automatic solicitation fallback',async()=>{const f=fixture();f.browser.state.manual=true;f.state.receiptFor=intent=>intent.kind==='card'?{serverStatus:'pending',observedAtMs:2200,visibleAtMs:2200}:{serverStatus:'confirmed',accountId,conversationId:intent.conversationId,content:intent.content,type:'TEXT',platformTimeMs:2100,observedAtMs:2200,visibleAtMs:2200,senderId:accountId,receiverId:intent.conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${intent.conversationId}.${intent.intentId}`};try{const result=await f.orchestrator.processRow({uid:u1,needsReply:true});assert.equal(result.card.state,'uncertain');assert.equal(result.fallback,null);assert.equal(f.state.calls.filter(x=>x.startsWith('fill:')).length,1);assert.equal(f.store.listIntents(f.store.listTurns(accountId,u1)[0].turnId).some(i=>i.kind==='contact_fallback'),false);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});

test('platform blocked card ends acquisition and emits failure card',async()=>{const f=fixture();f.browser.state.manual=true;const originalCard=f.browser.sendCard;f.browser.sendCard=async()=>{throw Object.assign(new Error('platform_blocked'),{code:'platform_blocked'})};try{const result=await f.orchestrator.processRow({uid:u1,needsReply:true});assert.equal(result.state,'send_blocked');assert.equal(f.state.cards.at(-1).kind,'send_failed');assert.equal(f.store.getConversation(accountId,u1).state,'send_blocked');}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('single visible message waits only for one short continuation probe',async()=>{let now=1000;const f=fixture();const messages=[{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m1',direction:'left',type:'TEXT',text:'你好',platformTimeMs:1000,isCustomerText:true}];const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,sleep:async ms=>{now+=ms;},selectConversation:async()=>({accountId,conversationId:u1,nickname:'甲',profileFields:[],messages:[...messages]})});try{const result=await o.processRow({uid:u1,needsReply:true});assert.equal(result.state,'waiting_contact');assert.equal(now,1250);assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('continuation probe includes a message arriving after the first short check',async()=>{let now=1000;const f=fixture();const messages=[{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m1',direction:'left',type:'TEXT',text:'你好',platformTimeMs:1000,isCustomerText:true}];const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,sleep:async ms=>{now+=ms;if(now>=1250&&messages.length===1)messages.push({nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m2',direction:'left',type:'TEXT',text:'想问美国仓',platformTimeMs:1100,isCustomerText:true});},selectConversation:async()=>({accountId,conversationId:u1,nickname:'甲',profileFields:[],messages:[...messages]})});try{await o.processRow({uid:u1,needsReply:true});const turn=f.store.listTurns(accountId,u1)[0];assert.deepEqual(turn.inboundTexts,['你好','想问美国仓']);assert.equal(now,1500);assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('one failed customer does not abort overdue sweep',async()=>{const f=fixture({rows:[{uid:u1,needsReply:true},{uid:u2,needsReply:true}]});const original=f.orchestrator.deps.selectConversation;f.orchestrator.deps.selectConversation=async uid=>{if(uid===u1)throw new Error('bad_row');return original(uid)};try{const result=await f.orchestrator.sweepVisibleOverdue();assert.equal(result.processed,1);assert.equal(result.failed.length,1);assert.equal(f.store.listTurns(accountId,u2).length,1);assert.equal(f.state.cards.some(card=>card.kind==='needs_operator'&&card.conversationId===u1),true);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('completed turn is not resent on unchanged poll',async()=>{const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:true}]});try{const first=await f.orchestrator.pollOnce();assert.equal(first.processed,1);const second=await f.orchestrator.pollOnce();assert.equal(second.processed,0);assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('repeated identical generated reply escalates without failing the customer',async()=>{const f=fixture();let messages=[{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m1',direction:'left',type:'TEXT',text:'你好',platformTimeMs:1000,isCustomerText:true}];const o=createOrchestrator({...f.orchestrator.deps,selectConversation:async()=>({accountId,conversationId:u1,nickname:'甲',profileFields:[],messages:[...messages]}),composeReply:()=>({text:'固定回复',offerCard:false,needsHuman:false,nextState:'waiting_contact'})});try{await o.processRow({uid:u1,needsReply:true});messages=[...messages,{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m2',direction:'left',type:'TEXT',text:'还在吗',platformTimeMs:3000,isCustomerText:true}];const result=await o.processRow({uid:u1,needsReply:true});assert.equal(result.state,'needs_human');assert.equal(result.reason,'duplicate_generated_reply_prevented');assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);assert.equal(f.state.cards.at(-1).kind,'needs_operator');}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('identical visible preview with a new native event creates a new turn',async()=>{
  const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:true,statusText:'[超时未回复]',preview:'你好'}]});
  f.state.receiptFor=intent=>({serverStatus:'confirmed',accountId,conversationId:intent.conversationId,content:intent.content,type:intent.kind==='card'?'CARD':'TEXT',cardTitle:intent.kind==='card'?'企微_运去哪海外仓（企微）':null,platformTimeMs:1900,observedAtMs:1950,visibleAtMs:1950,senderId:accountId,receiverId:intent.conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${intent.conversationId}.${intent.intentId}`});
  let now=10000;let messages=[{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m1',direction:'left',type:'TEXT',text:'你好',platformTimeMs:1000,isCustomerText:true}];
  const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,selectConversation:async()=>({accountId,conversationId:u1,nickname:'甲',profileFields:[],messages:[...messages]})});
  try{
    const first=await o.pollOnce();assert.equal(first.processed,1);
    messages=[...messages,{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m2',direction:'left',type:'TEXT',text:'你好',platformTimeMs:1800,isCustomerText:true}];now=11000;
    const second=await o.pollOnce();assert.equal(second.processed,1,JSON.stringify(second));assert.equal(f.store.listTurns(accountId,u1).length,2);assert.equal(f.state.calls.filter(x=>x==='text-send').length,2,JSON.stringify(f.state.calls));
  }finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('existing native WeCom card is not sent again',async()=>{const f=fixture();const messages=[{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m1',direction:'left',type:'TEXT',text:'你好',platformTimeMs:1000,isCustomerText:true},{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.card1',direction:'right',type:'CARD',text:'企微_运去哪海外仓（企微）',platformTimeMs:1100,isCustomerText:false}];const o=createOrchestrator({...f.orchestrator.deps,selectConversation:async()=>({accountId,conversationId:u1,nickname:'甲',profileFields:[],messages})});try{const result=await o.processRow({uid:u1,needsReply:true});assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);assert.equal(f.state.calls.filter(x=>x==='card-send').length,0);assert.equal(result.card.state,'already_present_native_history');}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('unrelated native business card does not suppress the target WeCom card',async()=>{const f=fixture();const messages=[{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m1',direction:'left',type:'TEXT',text:'你好',platformTimeMs:1000,isCustomerText:true},{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.card1',direction:'right',type:'CARD',text:'产品资料卡',platformTimeMs:1100,isCustomerText:false}];const o=createOrchestrator({...f.orchestrator.deps,selectConversation:async()=>({accountId,conversationId:u1,nickname:'甲',profileFields:[],messages})});try{const result=await o.processRow({uid:u1,needsReply:true});assert.equal(f.state.calls.filter(x=>x==='card-send').length,1);assert.notEqual(result.card?.state,'already_present_native_history');}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('existing native outbound text is included in reply deduplication',async()=>{const f=fixture();const nativeText='您好，之前已经回复过';const messages=[{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m1',direction:'left',type:'TEXT',text:'你好',platformTimeMs:1000,isCustomerText:true},{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.m2',direction:'right',type:'TEXT',text:nativeText,platformTimeMs:1100,isCustomerText:false}];let seen=null;const o=createOrchestrator({...f.orchestrator.deps,selectConversation:async()=>({accountId,conversationId:u1,nickname:'甲',profileFields:[],messages}),composeReply:a=>{seen=a;return{text:'全新的回复',offerCard:false,needsHuman:false,nextState:'waiting_contact'}}});try{await o.processRow({uid:u1,needsReply:true});assert(seen.avoidTexts.includes(nativeText));}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('contact discovered during quiet window is pushed before any reply',async()=>{let now=1000,reads=0;const f=fixture();const contact={accountId,conversationId:u1,kind:'phone',value:'17300006725',source:'profile',verified:true};const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,sleep:async ms=>{now+=ms;},readContacts:async()=>{reads++;return reads>1?[contact]:[];}});try{const result=await o.processRow({uid:u1,needsReply:true});assert.equal(result.state,'contact_obtained');assert.equal(f.state.calls.length,0);assert.equal(f.state.cards[0].kind,'ready_to_follow');}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('new row without overdue badge is still processed after baseline',async()=>{const f=fixture({rows:[]});const sidebar={rows:[]};const o=createOrchestrator({...f.orchestrator.deps,readSidebar:async()=>sidebar});try{await o.pollOnce();sidebar.rows=[{uid:u1,nickname:'甲',needsReply:false,statusText:'',preview:'对方通过笔记进入私信',time:'10:00'}];const result=await o.pollOnce();assert.equal(result.processed,1);assert.equal(f.store.listTurns(accountId,u1).length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('overdue row without readable customer text gets a safe generic reply',async()=>{const f=fixture();f.browser.state.manual=true;f.state.receiptFor=intent=>({serverStatus:'confirmed',accountId,conversationId:intent.conversationId,content:intent.content,type:intent.kind==='card'?'CARD':'TEXT',cardTitle:intent.kind==='card'?'企微_运去哪海外仓（企微）':null,platformTimeMs:10000,observedAtMs:10600,visibleAtMs:10600,senderId:accountId,receiverId:intent.conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${intent.conversationId}.${intent.intentId}`});const o=createOrchestrator({...f.orchestrator.deps,selectConversation:async()=>({accountId,conversationId:u1,nickname:'甲',profileFields:[],messages:[{nativeId:'jarvis-msg-'+u1+'.'+accountId+'.sys',direction:'right',type:'GENERAL',text:'系统欢迎',platformTimeMs:1000,isCustomerText:false,ai:false,system:true}]})});const at=new Date(9000);const time=[at.getHours(),at.getMinutes(),at.getSeconds()].map(v=>String(v).padStart(2,'0')).join(':');try{const result=await o.processRow({uid:u1,needsReply:true,statusTags:['[超时未回复]'],preview:'[卡片]',time});assert.equal(result.state,'waiting_contact');assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);assert.equal(f.state.calls.filter(x=>x==='card-send').length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('startup scan pushes visible contact even without overdue badge',async()=>{const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:false,preview:'好的',time:'10:00'}]});const o=createOrchestrator({...f.orchestrator.deps,readContacts:async()=>[{accountId,conversationId:u1,kind:'phone',value:'17300006725',source:'profile',verified:true}],revealMaskedContacts:async()=>[]});try{const result=await o.sweepVisibleOverdue();assert.equal(result.results.length,1);assert.equal(result.results[0].state,'contact_obtained');assert.equal(f.state.cards[0].kind,'ready_to_follow');assert.equal(f.state.calls.length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}});
test('startup contact handoff is limited to today when processToday is enabled',async()=>{
  const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:false,leadSignal:true,time:'00:00:09'},{uid:u2,nickname:'乙',needsReply:false,leadSignal:true,time:'10/27'}]});
  const o=createOrchestrator({...f.orchestrator.deps,readContacts:async scope=>[{accountId,conversationId:scope.conversationId,kind:'wecom_added',value:'已添加企微',source:'profile',verified:true}],revealMaskedContacts:async()=>[]});
  try{const result=await o.sweepVisibleOverdue({processToday:true});assert.equal(result.processed,1);assert.equal(f.store.getConversation(accountId,u1).contactState,'obtained');assert.equal(f.store.getConversation(accountId,u2),null);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('unchanged lead rows are not reselected every poll',async()=>{
  const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:false,leadSignal:true,time:'10:00'}]});const o=createOrchestrator({...f.orchestrator.deps,readContacts:async()=>[{accountId,conversationId:u1,kind:'wecom_added',value:'已添加企微',source:'profile',verified:true}],revealMaskedContacts:async()=>[]});let selections=0;const original=o.deps.selectConversation;o.deps.selectConversation=async uid=>{selections++;return original(uid)};
  try{await o.pollOnce();const afterFirst=selections;const second=await o.pollOnce();assert.equal(second.processed,0);assert.equal(selections,afterFirst);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('contact scan skips a customer already handed off',async()=>{
  const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:false,time:'10:00'}]});f.store.ingestInbound({accountId,conversationId:u1,eventId:'handed-off',text:'',type:'SIDEBAR_OVERDUE',platformTimeMs:1});f.store.setConversationState(accountId,u1,'contact_obtained');let selections=0;const original=f.orchestrator.deps.selectConversation;f.orchestrator.deps.selectConversation=async uid=>{selections++;return original(uid)};
  try{const result=await f.orchestrator.processRow({uid:u1,nickname:'甲',needsReply:false,time:'10:00'},{contactOnly:true});assert.equal(result.state,'contact_obtained');assert.equal(selections,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('startup takeover checks only recent platform-AI conversations without sending messages',async()=>{
  const now=new Date(2026,9,28,10,0,0).getTime();
  const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:false,platformAiActive:true,statusTags:['接待中'],time:'10/27'},{uid:u2,nickname:'乙',needsReply:false,platformAiActive:false,time:'10/27'}]});
  const calls=[];const sender={enterHumanMode:async scope=>{calls.push(scope.conversationId);return{clicked:true}}};
  const o=createOrchestrator({...f.orchestrator.deps,sender,now:()=>now});
  try{const result=await o.takeoverVisiblePlatformAi();assert.equal(result.processed,1);assert.deepEqual(calls,[u1]);assert.equal(f.state.calls.length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('shutdown browser closure does not create a customer failure card',async()=>{
  const now=new Date(2026,9,28,10,0,0).getTime();
  const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:false,time:'10:00:00'}]});
  const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,isStopping:()=>true,selectConversation:async()=>{throw new Error('Target page, context or browser has been closed')}});
  try{await o.sweepVisibleOverdue({processToday:true});assert.equal(f.state.cards.length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('transient human takeover failure retries until success',async()=>{
  const now=new Date(2026,9,28,10,0,0).getTime();
  const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:false,platformAiActive:true,statusTags:['接待中'],time:'10:00:00'}]});
  let attempts=0;const sender={enterHumanMode:async()=>{attempts++;if(attempts<3)throw new Error('native_takeover_control_required');return{clicked:true};}};
  const o=createOrchestrator({...f.orchestrator.deps,sender,now:()=>now});
  try{const result=await o.takeoverVisiblePlatformAi();assert.equal(result.processed,1);assert.equal(attempts,3);assert.equal(f.state.cards.length,0);assert.equal(result.results[0].attempts,3);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('failed human takeover stays queued for a later retry',async()=>{
  let now=new Date(2026,9,28,10,0,0).getTime();
  const row={uid:u1,nickname:'甲',needsReply:false,platformAiActive:true,statusTags:['接待中'],time:'10:00:00'};
  const f=fixture({rows:[row]});
  let attempts=0;const sender={enterHumanMode:async()=>{attempts++;if(attempts<=3)throw new Error('native_takeover_control_required');return{clicked:true};}};
  const o=createOrchestrator({...f.orchestrator.deps,sender,now:()=>now});
  try{await o.pollOnce();now+=3000;const result=await o.pollOnce();assert.equal(attempts,4);assert.equal(result.processed,1);assert.equal(f.state.cards.length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('live takeover failure retries silently instead of creating a card',async()=>{
  let now=new Date(2026,9,28,10,0,0).getTime();
  const f=fixture({rows:[]});const sidebar={rows:[]};let attempts=0;const sender={enterHumanMode:async()=>{attempts++;if(attempts===1)throw new Error('native_takeover_control_required');return{clicked:true};}};
  const o=createOrchestrator({...f.orchestrator.deps,readSidebar:async()=>sidebar,sender,now:()=>now});
  try{await o.pollOnce();sidebar.rows=[{uid:u1,nickname:'甲',needsReply:true,platformAiActive:true,statusTags:['接待中'],time:'10:00:00'}];await o.pollOnce();assert.equal(f.state.cards.length,0);now+=3000;const retried=await o.pollOnce();assert.equal(attempts,2);assert.equal(retried.processed,1);assert.equal(f.state.cards.length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('uncertain text and card retain their original intents without any new send',async()=>{
  const f=fixture();f.state.receiptFor=()=>({serverStatus:'pending',observedAtMs:2200});
  try{const result=await f.orchestrator.processRow({uid:u1,nickname:'甲',needsReply:true});const intents=f.store.listIntents(result.turn.turnId);assert.equal(intents.length,2);assert.ok(intents.every(item=>item.state==='uncertain'));assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);assert.equal(f.state.calls.filter(x=>x==='card-send').length,1);assert.equal(result.state,'needs_human');await f.orchestrator.processRow({uid:u1,nickname:'甲',needsReply:true});assert.deepEqual(f.store.listIntents(result.turn.turnId).map(item=>item.intentId),intents.map(item=>item.intentId));assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('today card-click event gets one acknowledgement without another card',async()=>{
  const now=new Date(2026,9,28,10,0,0).getTime();const f=fixture();
  f.state.receiptFor=intent=>({serverStatus:'confirmed',accountId,conversationId:intent.conversationId,content:intent.content,type:intent.kind==='card'?'CARD':'TEXT',cardTitle:intent.kind==='card'?'企微_运去哪海外仓（企微）':null,platformTimeMs:now+100,observedAtMs:now+200,visibleAtMs:now+200,senderId:accountId,receiverId:intent.conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${intent.conversationId}.${intent.intentId}`});
  const row={uid:u1,nickname:'理性',needsReply:true,leadSignal:true,statusTags:['[超时未回复]','留客资'],preview:'对方已点击你的企业微信联系卡',time:'10:00:00'};
  const o=createOrchestrator({...f.orchestrator.deps,now:()=>now});
  try{const first=await o.processRow(row);assert.equal(first.state,'contact_obtained');assert.equal(f.state.calls.filter(x=>x.startsWith('fill:')).length,1);assert.match(f.state.calls.find(x=>x.startsWith('fill:')),/点击企微卡/);assert.equal(f.state.calls.filter(x=>x==='card-send').length,0);const second=await o.processRow(row);assert.equal(second.state,'contact_obtained');assert.equal(f.state.calls.filter(x=>x.startsWith('fill:')).length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('card intents use the configured native card title',async()=>{
  const f=fixture();const card={title:'企微_账号B（企微）',visibleName:'账号B（企微）',id:'100200300',csaAccountNo:'9988776655',corpName:'@账号B企业'};
  f.state.receiptFor=intent=>({serverStatus:'confirmed',accountId,conversationId:intent.conversationId,content:intent.content,type:intent.kind==='card'?'CARD':'TEXT',cardTitle:intent.kind==='card'?card.title:null,platformTimeMs:10000,observedAtMs:10600,visibleAtMs:10600,senderId:accountId,receiverId:intent.conversationId,direction:'OUTBOUND',nativeId:`id_${accountId}.${intent.conversationId}.${intent.intentId}`});
  const sender=createSender({store:f.store,browser:f.browser,card,now:()=>1800});const o=createOrchestrator({...f.orchestrator.deps,sender,card});
  try{const result=await o.processRow({uid:u1,nickname:'甲',needsReply:true});const cardIntent=f.store.listIntents(result.turn.turnId).find(intent=>intent.kind==='card');assert.equal(cardIntent.state,'sent');assert.equal(cardIntent.payload.cardTitle,card.title);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('a failed background contact scan backs off instead of blocking every poll',async()=>{
  let now=new Date(2026,9,28,10,0,0).getTime();
  const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:false,leadSignal:true,time:'10:00:00'}]});
  let selections=0;const o=createOrchestrator({...f.orchestrator.deps,selectConversation:async()=>{selections++;throw new Error('exact_visible_customer_row_required')},now:()=>now});
  try{await o.pollOnce();assert.equal(selections,1);now+=2000;await o.pollOnce();assert.equal(selections,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('outside reply hours reads health but creates no intent or conversation interaction',async()=>{
  const now=new Date(2026,9,28,18,30,0).getTime();const f=fixture();let selections=0;
  const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,replySchedule:{isAllowed:()=>false,state:()=>({allowed:false,reason:'closed'})},selectConversation:async uid=>{selections++;return f.scopeFor(uid)}});
  try{const result=await o.pollOnce();assert.equal(result.processed,0);assert.equal(result.reply_window.reason,'closed');assert.equal(selections,0);assert.equal(f.store.listTurns(accountId,u1).length,0);assert.equal(f.state.calls.length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('opening the reply window does not backfill off-hours rows',async()=>{
  let allowed=false;const rows=[{uid:u1,nickname:'甲',needsReply:true,preview:'旧消息',time:'17:59:00'}];
  const f=fixture({rows});const o=createOrchestrator({...f.orchestrator.deps,readSidebar:async()=>({rows}),replySchedule:{isAllowed:()=>allowed,state:()=>({allowed,reason:allowed?'open':'closed'})}});
  try{await o.pollOnce();allowed=true;const opened=await o.pollOnce();assert.equal(opened.processed,0);assert.equal(f.store.listTurns(accountId,u1).length,0);rows[0]={...rows[0],preview:'新消息',time:'18:01:00'};const fresh=await o.pollOnce();assert.equal(fresh.processed,1);assert.equal(f.store.listTurns(accountId,u1).length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('startup during reply hours ignores sidebar rows timestamped before 18:00',async()=>{
  const now=new Date(2026,9,28,20,0,0).getTime();const f=fixture({rows:[{uid:u1,nickname:'甲',needsReply:true,preview:'旧消息',time:'17:59:59'}]});let selections=0;
  const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,replySchedule:{isAllowed:()=>true,state:()=>({allowed:true,reason:'open'})},selectConversation:async uid=>{selections++;return f.scopeFor(uid)}});
  try{const result=await o.pollOnce();assert.equal(result.processed,0);assert.equal(selections,0);assert.equal(f.store.listTurns(accountId,u1).length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('silent peer-profile visitor receives no welcome, takeover, card, or contact scan',async()=>{
  const f=fixture();const scope={accountId,conversationId:u1,nickname:'chenyuanqing全美提柜卡派',profileFields:[],messages:[{nativeId:'hint',direction:'center',type:'RICH_HINT',text:'对方通过笔记进入私信',platformTimeMs:1000,isEntryHint:true,isCustomerText:false}]};
  const o=createOrchestrator({...f.orchestrator.deps,selectConversation:async()=>scope});
  try{const result=await o.processRow({uid:u1,nickname:scope.nickname,needsReply:false});assert.equal(result.state,'stopped');assert.equal(result.reason,'peer_profile_silent');assert.equal(f.state.calls.length,0);assert.equal(f.state.cards.filter(card=>card.kind==='ready_to_follow').length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('peer cooperation gets one refusal and never creates a contact lead or card',async()=>{
  const f=fixture();const text='你好！方便加个微信交流一下吗，我是做美线尾程提拆派服务，后期有资源可以合作一下';
  const scope={accountId,conversationId:u1,nickname:'chenyuanqing全美提柜卡派',profileFields:[],messages:[{nativeId:'m-peer',direction:'left',type:'TEXT',text,platformTimeMs:1000,isCustomerText:true}]};
  const o=createOrchestrator({...f.orchestrator.deps,selectConversation:async()=>scope,readContacts:async()=>[{accountId,conversationId:u1,kind:'phone',value:'17300006725',source:'profile',verified:true}]});
  try{const result=await o.processRow({uid:u1,nickname:scope.nickname,needsReply:true});assert.equal(result.state,'stopped');assert.equal(f.state.calls.filter(x=>x==='card-send').length,0);assert.equal(f.state.cards.filter(card=>card.kind==='ready_to_follow').length,0);assert.match(f.state.calls.find(x=>x.startsWith('fill:')),/同行|合作/);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('unsupported business gets one refusal without contact lead or card',async()=>{
  const f=fixture();const text='移仓换标你们能做吗';const scope={accountId,conversationId:u1,nickname:'卖家',profileFields:[],messages:[{nativeId:'m-blocked',direction:'left',type:'TEXT',text,platformTimeMs:1000,isCustomerText:true}]};
  const o=createOrchestrator({...f.orchestrator.deps,selectConversation:async()=>scope,readContacts:async()=>[{accountId,conversationId:u1,kind:'phone',value:'17300006725',source:'profile',verified:true}]});
  try{const result=await o.processRow({uid:u1,nickname:'卖家',needsReply:true});assert.equal(result.state,'stopped');assert.equal(f.state.calls.filter(x=>x==='card-send').length,0);assert.equal(f.state.cards.filter(card=>card.kind==='ready_to_follow').length,0);assert.match(f.state.calls.find(x=>x.startsWith('fill:')),/不接/);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('obvious peer profile cannot obtain a normal greeting or WeCom card',async()=>{
  const f=fixture();const scope={accountId,conversationId:u1,nickname:'全美提柜卡派服务商',profileFields:[],messages:[{nativeId:'m-peer-hi',direction:'left',type:'TEXT',text:'你好',platformTimeMs:1000,isCustomerText:true}]};
  const o=createOrchestrator({...f.orchestrator.deps,selectConversation:async()=>scope});
  try{const result=await o.processRow({uid:u1,nickname:scope.nickname,needsReply:true});assert.equal(result.state,'stopped');assert.equal(f.state.calls.filter(x=>x==='card-send').length,0);assert.match(f.state.calls.find(x=>x.startsWith('fill:')),/同行|合作/);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('a message change between closed polling and 18:00 is not backfilled',async()=>{
  let allowed=false;const rows=[{uid:u1,nickname:'甲',needsReply:true,preview:'18:30之前',time:'18:30:00'}];
  const f=fixture({rows});const o=createOrchestrator({...f.orchestrator.deps,readSidebar:async()=>({rows}),replySchedule:{isAllowed:()=>allowed,state:()=>({allowed,reason:allowed?'open':'closed'})}});
  try{await o.pollOnce();rows[0]={...rows[0],preview:'18:59新消息',time:'17:59:00'};allowed=true;const opening=await o.pollOnce();assert.equal(opening.processed,0);const next=await o.pollOnce();assert.equal(next.processed,0);assert.equal(f.store.listTurns(accountId,u1).length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('excluded refusal uncertainty never becomes a WeCom solicitation retry',async()=>{
  const f=fixture();const text='想和你们合作一下';const scope={accountId,conversationId:u1,nickname:'渠道方',profileFields:[],messages:[{nativeId:'collab',direction:'left',type:'TEXT',text,platformTimeMs:1000,isCustomerText:true}]};let sendCalls=0;
  const sender={enterHumanMode:async()=>({clicked:true}),sendText:async intentId=>{sendCalls++;return{state:'uncertain',intent:{...f.store.getIntent(intentId),state:'uncertain'}}},sendTextAndCard:async()=>{throw new Error('card_pair_must_not_run')},sendWeComCard:async()=>{throw new Error('card_retry_must_not_run')}};
  const o=createOrchestrator({...f.orchestrator.deps,sender,selectConversation:async()=>scope});
  try{const result=await o.processRow({uid:u1,nickname:'渠道方',needsReply:true});assert.equal(result.state,'needs_human');assert.equal(sendCalls,1);assert.equal(f.store.listConversationOutboundTexts(accountId,u1).length,1);const intents=f.store.listIntents(result.turn.turnId);assert.equal(intents.length,1);assert.doesNotMatch(intents[0].content,/加我企微/);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('closing reply window during send creates no retry intent',async()=>{
  let allowed=true;const f=fixture();const sender={enterHumanMode:async()=>({clicked:true}),sendTextAndCard:async(textId,cardId)=>{f.store.markSending(textId,2000);f.store.markUncertain(textId,{error:'mock_uncertain'});f.store.markSending(cardId,2000);f.store.markUncertain(cardId,{error:'mock_uncertain'});return{state:'uncertain',text:{state:'uncertain'},card:{state:'uncertain'},withinTwoSeconds:false,withinThreeSeconds:false}},sendText:async()=>{throw new Error('retry_must_not_run')},sendWeComCard:async()=>{throw new Error('retry_must_not_run')}};
  const o=createOrchestrator({...f.orchestrator.deps,sender,replySchedule:{isAllowed:()=>allowed,state:()=>({allowed,reason:allowed?'open':'closed'})}});
  try{const original=f.orchestrator.deps.sender;const pair=sender.sendTextAndCard;sender.sendTextAndCard=async(...args)=>{const result=await pair(...args);allowed=false;return result};const result=await o.processRow({uid:u1,nickname:'甲',needsReply:true});assert.equal(result.state,'needs_human');assert.equal(f.store.listIntents(result.turn.turnId).length,2);assert.equal(f.store.listIntents(result.turn.turnId).filter(i=>i.state==='prepared').length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('a genuinely new source may receive distinct qualified text while old uncertain intents stay held',async()=>{
  const f=fixture();let scope=f.scopeFor(u1);f.orchestrator.deps.selectConversation=async()=>scope;f.state.receiptFor=()=>({serverStatus:'pending',observedAtMs:2200});
  try{const first=await f.orchestrator.processRow({uid:u1,nickname:'甲',needsReply:true});const held=f.store.listIntents(first.turn.turnId);assert.equal(held.length,2);
    scope={...scope,messages:[...scope.messages,{nativeId:`jarvis-msg-${u1}.${accountId}.new-question`,direction:'left',type:'TEXT',text:'墨西哥卖家订单可以做吗',platformTimeMs:2000,isCustomerText:true}]};
    f.orchestrator.deps.sender=createSender({store:f.store,browser:f.browser,now:()=>2800});
    f.state.receiptFor=intent=>({serverStatus:'confirmed',accountId,conversationId:u1,content:intent.content,type:'TEXT',platformTimeMs:3000,observedAtMs:3200,senderId:accountId,receiverId:u1,direction:'OUTBOUND',nativeId:`id_${accountId}.${u1}.${intent.intentId}`});
    const next=await f.orchestrator.processRow({uid:u1,nickname:'甲',needsReply:true});assert.notEqual(next.turn.turnId,first.turn.turnId);assert.equal(next.text.state,'sent');assert.equal(f.store.listIntents(next.turn.turnId).length,1);assert.notEqual(next.reply.text,first.reply.text);assert.deepEqual(f.store.listIntents(first.turn.turnId).map(item=>[item.intentId,item.state]),held.map(item=>[item.intentId,'uncertain']));assert.equal(f.state.calls.filter(x=>x==='card-send').length,1);
  }finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('ambiguous native receipts do not authorize fresh text or card intents',async()=>{
 const f=fixture();f.state.receiptFor=()=>({serverStatus:'pending',reason:'native_receipt_ambiguous',observedAtMs:2200});
 try{const result=await f.orchestrator.processRow({uid:u1,nickname:'甲',needsReply:true});assert.equal(f.store.listIntents(result.turn.turnId).length,2);assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);assert.equal(f.state.calls.filter(x=>x==='card-send').length,1);assert.equal(result.state,'needs_human');}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('a possibly submitted text leaves its original unsubmitted card prepared and never creates retries',async()=>{
 const f=fixture();f.browser.clickTextSend=async()=>{f.state.calls.push('text-send');throw new Error('submit_transport_timeout');};
 try{const result=await f.orchestrator.processRow({uid:u1,nickname:'甲',needsReply:true});const intents=f.store.listIntents(result.turn.turnId);assert.equal(intents.length,2);assert.equal(intents.find(item=>item.kind==='text').state,'uncertain');assert.equal(intents.find(item=>item.kind==='card').state,'prepared');assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);assert.equal(f.state.calls.filter(x=>x==='card-send').length,0);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

for(const state of ['pending','ambiguous'])test(`an attempted ${state} outcome holds the original turn instead of claiming reception complete`,async()=>{
 const f=fixture();const sender={...f.sender,sendTextAndCard:async(textId,cardId)=>{for(const id of [textId,cardId]){f.store.markSending(id,1800);f.store.markUncertain(id,{reason:state});}return{state,text:{state},card:{state}};}};
 const o=createOrchestrator({...f.orchestrator.deps,sender});
 try{const result=await o.processRow({uid:u1,nickname:'甲',needsReply:true});assert.equal(result.state,'needs_human');assert.equal(f.store.listIntents(result.turn.turnId).length,2);assert.ok(f.store.listIntents(result.turn.turnId).every(item=>item.state==='uncertain'));}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});


test('sender outside-window result does not leave the turn waiting for contact',async()=>{
  const f=fixture();const sender={enterHumanMode:async()=>({clicked:true}),sendTextAndCard:async(textId,cardId)=>{f.store.markFailed(textId,'outside_reply_hours');f.store.markFailed(cardId,'outside_reply_hours');return{state:'outside_reply_hours',text:{state:'failed'},card:{state:'failed'}}},sendText:async()=>{throw new Error('unexpected')},sendWeComCard:async()=>{throw new Error('unexpected')}};
  const o=createOrchestrator({...f.orchestrator.deps,sender});
  try{const result=await o.processRow({uid:u1,nickname:'甲',needsReply:true});assert.equal(result.state,'needs_human');assert.equal(f.store.listIntents(result.turn.turnId).filter(i=>i.state==='prepared').length,0);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('all-day override allows ordinary morning rows and expires by schedule state',async()=>{
  const now=Date.parse('2026-11-02T10:00:00+08:00');const f=fixture({sourceTimeMs:now,rows:[{uid:u1,nickname:'真实卖家',needsReply:true,preview:'美国仓报价',time:'10:00:00'}]});
  const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,replySchedule:createReplySchedule({now:()=>now,overrideDates:['2026-11-02']})});
  try{const result=await o.pollOnce();assert.equal(result.processed,1);assert.equal(f.store.listTurns(accountId,u1).length,1);}finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('evening startup does not take over or reply to a morning conversation',async()=>{
 const {createReplySchedule}=await import('../reply-schedule.mjs');
 const now=Date.parse('2026-11-21T18:10:00+08:00');
 const f=fixture({rows:[{uid:u1,nickname:'测试客户',needsReply:true,preview:'早上的消息',time:'08:30:00'}]});let selections=0;
 const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,replySchedule:createReplySchedule({now:()=>now}),selectConversation:async uid=>{selections++;return f.scopeFor(uid)}});
 try{const result=await o.pollOnce();assert.equal(result.processed,0);assert.equal(selections,0);assert.equal(f.state.calls.length,0);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('new morning and 18:00 customer openings enter the existing reception path',async()=>{
 const {createReplySchedule}=await import('../reply-schedule.mjs');
 for(const time of ['07:10:00','18:10:00']){
  const now=Date.parse(`2026-11-21T${time}+08:00`);
  const f=fixture({sourceTimeMs:now,rows:[{uid:u1,nickname:'测试客户',needsReply:true,preview:'咨询美国仓',time}]});
  const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,replySchedule:createReplySchedule({now:()=>now})});
  try{const result=await o.pollOnce();assert.equal(result.processed,1,time);assert.equal(f.state.calls.filter(x=>x==='text-send').length,1,time);}
  finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
 }
});

test('second evening poll cannot submit an acknowledgment for a morning card click',async()=>{
 const {createReplySchedule}=await import('../reply-schedule.mjs');
 const now=Date.parse('2026-11-21T18:10:00+08:00');
 const rows=[{uid:u1,nickname:'测试客户',needsReply:false,preview:'对方已点击你的企业微信联系卡',time:'08:30:00'}];
 const f=fixture({rows});let selections=0;
 const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,replySchedule:createReplySchedule({now:()=>now}),selectConversation:async uid=>{selections++;return f.scopeFor(uid)}});
 try{await o.pollOnce();await o.pollOnce();assert.equal(selections,0);assert.equal(f.state.calls.length,0);assert.equal(f.store.listTurns(accountId,u1).length,0);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('the first open poll responds to a customer arriving exactly at 07:00 or 18:00',async()=>{
 const {createReplySchedule}=await import('../reply-schedule.mjs');
 for(const start of ['07:00:00','18:00:00']){
  let now=Date.parse(`2026-11-21T${start}+08:00`)-1000;let rows=[];
  const f=fixture({rows,sourceTimeMs:now+1000});const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,readSidebar:async()=>({rows}),replySchedule:createReplySchedule({now:()=>now})});
  try{await o.pollOnce();now+=1000;rows=[{uid:u1,nickname:'测试客户',needsReply:false,preview:'咨询美国仓',time:start}];const result=await o.pollOnce();assert.equal(result.processed,1,start);assert.equal(f.state.calls.filter(x=>x==='text-send').length,1,start);}
  finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
 }
});

function scheduledNativeFixture({now=Date.parse('2026-11-21T18:10:00+08:00'),sourceTime=now,entry=false,extraMessages=[],preview='客户咨询',platformAiActive=false}={}){
 const scope={accountId,conversationId:u1,nickname:'测试客户',profileFields:[],messages:[...extraMessages,{nativeId:`jarvis-msg-${u1}.${accountId}.current`,direction:entry?'center':'left',type:entry?'RICH_HINT':'TEXT',text:entry?'对方通过广告进入私信':'咨询美国仓',platformTimeMs:sourceTime,isCustomerText:!entry,isEntryHint:entry}]};
 const rows=[{uid:u1,nickname:'测试客户',needsReply:true,time:'18:10:00',preview,platformAiActive}];
 const f=fixture({rows,scopes:{[u1]:scope}});
 f.state.receiptFor=intent=>({serverStatus:'confirmed',accountId,conversationId:u1,content:intent.content,type:intent.kind==='card'?'CARD':'TEXT',cardTitle:intent.kind==='card'?'企微_运去哪海外仓（企微）':null,platformTimeMs:now+100,observedAtMs:now+200,senderId:accountId,receiverId:u1,direction:'OUTBOUND',nativeId:`id_${accountId}.${u1}.${intent.intentId}`});
 const o=createOrchestrator({...f.orchestrator.deps,now:()=>now,sleep:async()=>{},replySchedule:createReplySchedule({now:()=>now})});
 return {...f,o,scope,rows,now};
}

for(const [label,sourceTime] of [
 ['yesterday',Date.parse('2026-11-20T18:09:00+08:00')],
 ['this morning',Date.parse('2026-11-21T08:30:00+08:00')],
 ['before evening opening',Date.parse('2026-11-21T17:59:59+08:00')],
 ['in the future',Date.parse('2026-11-21T18:10:01+08:00')],
])test(`a current sidebar clock cannot authorize an inbound from ${label}`,async()=>{
 const f=scheduledNativeFixture({sourceTime});f.browser.state.manual=false;
 try{const result=await f.o.processRow(f.rows[0]);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);assert.equal(f.state.calls.length,0);assert.equal(result.skipped,true);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('startup takeover does not interrupt platform AI for an old native inbound',async()=>{
 const f=scheduledNativeFixture({sourceTime:Date.parse('2026-11-20T18:09:00+08:00'),platformAiActive:true});f.browser.state.manual=false;
 try{const result=await f.o.takeoverVisiblePlatformAi();assert.equal(result.processed,0);assert.equal(f.state.calls.length,0);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('a sidebar card-click clock cannot authorize an acknowledgment without a current native click',async()=>{
 const f=scheduledNativeFixture({sourceTime:Date.parse('2026-11-20T18:09:00+08:00'),preview:'对方已点击你的企业微信联系卡'});
 try{await f.o.processRow(f.rows[0],{contactOnly:true});assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);assert.equal(f.state.calls.length,0);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('a current native entry can trigger reception while old history remains context only',async()=>{
 const old={nativeId:`jarvis-msg-${u1}.${accountId}.old`,direction:'left',type:'TEXT',text:'昨天的问题',platformTimeMs:Date.parse('2026-11-20T18:09:00+08:00'),isCustomerText:true};
 const f=scheduledNativeFixture({entry:true,extraMessages:[old]});
 try{const result=await f.o.processRow(f.rows[0]);assert.equal(result.turn.sourceEventId,f.scope.messages.at(-1).nativeId);assert.equal(result.turn.openedAtMs,f.now);assert.equal(f.store.listTurns(accountId,u1).length,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM events').get().n,1);assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('contact-only profile collection remains available without a current message and sends nothing',async()=>{
 const f=scheduledNativeFixture({sourceTime:Date.parse('2026-11-20T18:09:00+08:00')});
 f.o.deps.readContacts=async()=>[{accountId,conversationId:u1,kind:'phone',value:'17300006725',source:'profile',verified:true}];
 try{const result=await f.o.processRow(f.rows[0],{contactOnly:true});assert.equal(result.state,'contact_obtained');assert.equal(f.state.calls.length,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('a fresh opening starts a new turn instead of inheriting an off-hours quiet window',async()=>{
 const now=Date.parse('2026-11-21T18:00:00.100+08:00');
 const f=scheduledNativeFixture({now});
 f.store.ingestInbound({accountId,conversationId:u1,eventId:'off-hours-original',text:'早一点的问题',platformTimeMs:Date.parse('2026-11-21T17:59:59.900+08:00')});
 try{const result=await f.o.processRow(f.rows[0]);assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);assert.equal(result.turn.openedAtMs,now);assert.equal(f.store.listTurns(accountId,u1).length,2);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('a current native card click receives one ack without creating a new visitor',async()=>{
 const f=scheduledNativeFixture({sourceTime:Date.parse('2026-11-20T18:09:00+08:00'),preview:'对方已点击你的企业微信联系卡'});
 f.scope.messages.push({nativeId:`jarvis-msg-${u1}.${accountId}.clicked`,direction:'center',type:'RICH_HINT',text:'对方已点击你的企业微信联系卡',platformTimeMs:f.now-500,isEntryHint:true});
 try{await f.o.processRow(f.rows[0],{contactOnly:true});assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);assert.deepEqual(f.store.db.prepare('SELECT type FROM events').all().map(row=>row.type),['CARD_CLICK']);assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='card'").get().n,0);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('a current system hint or right-side message does not create a new visitor or send eligibility',async()=>{
 const f=scheduledNativeFixture();
 f.scope.messages=[{nativeId:`jarvis-msg-${u1}.${accountId}.limit`,direction:'center',type:'RICH_HINT',text:'对方关注或回复你之前，24小时内最多只能发1条文字消息',platformTimeMs:f.now,isEntryHint:true},
 {nativeId:`jarvis-msg-${accountId}.${u1}.out`,direction:'right',type:'TEXT',text:'AI欢迎语',platformTimeMs:f.now,isCustomerText:false}];
 try{const result=await f.o.processRow(f.rows[0]);assert.equal(result.skipped,true);assert.equal(f.state.calls.length,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM events').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('an unchanged sidebar gets a bounded recheck when current native messages hydrate after an old snapshot',async()=>{
 let now=Date.parse('2026-11-21T18:10:00+08:00'),rows=[];let selections=0;
 const f=scheduledNativeFixture({now,sourceTime:Date.parse('2026-11-20T18:09:00+08:00')});
 const current={...f.scope,messages:[{...f.scope.messages[0],nativeId:`jarvis-msg-${u1}.${accountId}.hydrated`,platformTimeMs:now}]};
 const o=createOrchestrator({...f.o.deps,now:()=>now,readSidebar:async()=>({rows}),replySchedule:createReplySchedule({now:()=>now}),selectConversation:async()=>{selections++;return selections===1?f.scope:current}});
 try{
  await o.pollOnce();rows=[{...f.rows[0],needsReply:false}];await o.pollOnce();
  now+=250;await o.pollOnce();
  assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);
  assert.equal(f.store.db.prepare('SELECT event_id FROM events').get().event_id,current.messages[0].nativeId);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
 }
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('a genuinely old native conversation exhausts its recheck budget instead of being read every poll',async()=>{
 let now=Date.parse('2026-11-21T18:10:00+08:00'),selections=0;
 const f=scheduledNativeFixture({now,sourceTime:Date.parse('2026-11-20T18:09:00+08:00')});
 const o=createOrchestrator({...f.o.deps,now:()=>now,replySchedule:createReplySchedule({now:()=>now}),selectConversation:async()=>{selections++;return f.scope}});
 try{
  for(let i=0;i<40;i++){await o.pollOnce();now+=250;}
  assert.equal(selections,3);assert.equal(f.state.calls.length,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  f.rows[0]={...f.rows[0],preview:'新的一条美国仓问题'};f.scope.messages=[{...f.scope.messages[0],nativeId:`jarvis-msg-${u1}.${accountId}.new-question`,platformTimeMs:now}];
  const receipt=f.state.receiptFor;f.state.receiptFor=intent=>({...receipt(intent),platformTimeMs:now+100,observedAtMs:now+200});
  await o.pollOnce();assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);
 }
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('an existing native card click cannot reuse an off-hours turn to submit an ack',async()=>{
 const now=Date.parse('2026-11-21T18:00:00.100+08:00');
 const f=scheduledNativeFixture({now,sourceTime:Date.parse('2026-11-20T18:09:00+08:00'),preview:'对方已点击你的企业微信联系卡'});
 f.rows[0].time='18:00:00';
 const click={nativeId:`jarvis-msg-${u1}.${accountId}.existing-click`,direction:'center',type:'RICH_HINT',text:'对方已点击你的企业微信联系卡',platformTimeMs:now,isEntryHint:true};f.scope.messages.push(click);
 const old=f.store.ingestInbound({accountId,conversationId:u1,eventId:'off-hours-before-click',text:'旧消息',platformTimeMs:now-200});
 f.store.ingestInbound({accountId,conversationId:u1,eventId:click.nativeId,text:'',type:'CARD_CLICK',platformTimeMs:now});
 try{const result=await f.o.processRow(f.rows[0],{contactOnly:true});assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);assert.equal(result.skipped,true);assert.equal(f.store.db.prepare('SELECT opened_at_ms FROM turns WHERE turn_id=?').get(old.turnId).opened_at_ms,now-200);}
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('a slow native hydration can recover on the cooled-down read without a sidebar change',async()=>{
 let now=Date.parse('2026-11-21T18:10:00+08:00'),selections=0;
 const f=scheduledNativeFixture({now,sourceTime:Date.parse('2026-11-20T18:09:00+08:00')});
 const o=createOrchestrator({...f.o.deps,now:()=>now,replySchedule:createReplySchedule({now:()=>now}),selectConversation:async()=>{selections++;return f.scope}});
 try{
  for(let i=0;i<8;i++){await o.pollOnce();now+=250;}
  assert.equal(selections,3);
  f.scope.messages=[{...f.scope.messages[0],nativeId:`jarvis-msg-${u1}.${accountId}.slow-hydration`,platformTimeMs:now}];
  const receipt=f.state.receiptFor;f.state.receiptFor=intent=>({...receipt(intent),platformTimeMs:now+100,observedAtMs:now+200});
  now+=300_000;await o.pollOnce();assert.equal(f.state.calls.filter(x=>x==='text-send').length,1);
 }
 finally{f.store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
