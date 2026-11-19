import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCardText } from '../notifier-store.mjs';
test('renderer displays five fields and hides details by default',()=>{
  const text=renderCardText({kind:'ready_to_follow',fields:{'客户':'Kusu','想了解':'美国仓报价','联系方式':'手机号 17300006725','我已完成':'已发文字和企微卡','下一步':'联系客户'},details:{customer_text:'报价多少'}});
  for(const value of ['可以跟进','Kusu','美国仓报价','17300006725','联系客户'])assert.match(text,new RegExp(value));
  assert.doesNotMatch(text,/报价多少/);
});
test('receipt timeline includes exact customer time and distinguishes uncertain sends',async()=>{
 const {buildReceptionTimeline}=await import('../notifier-store.mjs');
 const db={prepare:sql=>({all:()=>sql.includes('FROM events')?[{text:'报价',platform_time_ms:Date.parse('2026-11-18T11:23:45Z'),evidence_json:'{"text":"报价"}'}]:[
 {kind:'text',state:'sent',content:'请加企微',evidence_json:'{"verified":true,"platformTimeMs":1795001040000}'},
 {kind:'card',state:'uncertain',content:null,evidence_json:'{}'}
 ]})};
 const t=buildReceptionTimeline(db,'a','u');
 assert.match(t.openedAt,/2026-11-18 19:23:45/);
 assert.match(t.sentMessages,/请加企微/);
 assert.match(t.sentMessages,/尚不能确认发出：企业微信名片/);
});

test('saved customer quote survives an empty database timeline',async()=>{
 const {buildReceptionTimeline}=await import('../notifier-store.mjs');
 const db={prepare:()=>({all:()=>[]})};
 const t=buildReceptionTimeline(db,'a','u',{customerText:'想了解仓储服务'});
 assert.equal(t.customerText,'想了解仓储服务');
 assert.equal(t.openedAt,'开口时间未留存');
 assert.equal(t.messages.length,1);
 assert.equal(t.messages[0].role,'customer');
 assert.equal(t.messages[0].timeMs,null);
});

test('fresh saved speech keeps its own text/time and history is chronological', async()=>{
 const {buildReceptionTimeline}=await import('../notifier-store.mjs');
 const db={prepare:sql=>({all:()=>sql.includes('FROM events')?[
  {event_id:'old-customer',text:'旧问题',platform_time_ms:2000},
  {event_id:'older-customer',text:'更旧的问题',platform_time_ms:1000}
 ]:[{kind:'text',state:'sent',content:'旧回复',evidence_json:'{"verified":true,"platformTimeMs":3000}'}]})};
 const t=buildReceptionTimeline(db,'a','u',{customerText:'新问题',customerMessageTimeMs:5000,customerNativeId:'new-customer'});
 assert.equal(t.customerText,'新问题');
 assert.deepEqual(t.messages.map(m=>m.text),['更旧的问题','旧问题','旧回复','新问题']);
 assert.equal(t.messages.find(m=>m.text==='旧回复').isAfterLatestCustomer,false);
 assert.equal(t.messages.at(-1).timeMs,5000);
});

test('saved quote with no timestamp never borrows an older event timestamp', async()=>{
 const {buildReceptionTimeline}=await import('../notifier-store.mjs');
 const db={prepare:sql=>({all:()=>sql.includes('FROM events')?[{event_id:'old',text:'',platform_time_ms:2000}]:[]})};
 const t=buildReceptionTimeline(db,'a','u',{customerText:'只有原话的新观察'});
 assert.equal(t.openedAt,'开口时间未留存');
 assert.equal(t.messages[0].timeMs,null);
});

test('independent saved speech without time prevents old reply from claiming the new question', async()=>{
 const {buildReceptionTimeline}=await import('../notifier-store.mjs');
 const db={prepare:sql=>({all:()=>sql.includes('FROM events')?[{event_id:'old',text:'旧问题',platform_time_ms:2000}]:[
  {kind:'text',state:'sent',content:'旧回复',submitted_at_ms:2500,source_event_ids_json:'["old"]',evidence_json:'{"verified":true,"platformTimeMs":3000}'}]})};
 const t=buildReceptionTimeline(db,'a','u',{customerText:'没有时间的新问题',customerNativeId:'new'});
 assert.equal(t.customerText,'没有时间的新问题');
 assert.equal(t.openedAt,'开口时间未留存');
 assert.equal(t.messages.find(m=>m.text==='旧回复').isAfterLatestCustomer,false);
});

test('late confirmation of an old intent cannot count as a reply to a new question', async()=>{
 const {buildReceptionTimeline}=await import('../notifier-store.mjs');
 const db={prepare:sql=>({all:()=>sql.includes('FROM events')?[{event_id:'new',text:'新问题',platform_time_ms:5000}]:[
  {kind:'text',state:'sent',content:'旧操作晚确认',submitted_at_ms:1000,source_event_ids_json:'["old"]',evidence_json:'{"verified":true,"platformTimeMs":6000}'},
  {kind:'text',state:'sent',content:'新问题的回复',submitted_at_ms:7000,source_event_ids_json:'["new"]',evidence_json:'{"verified":true,"platformTimeMs":8000}'}]})};
 const t=buildReceptionTimeline(db,'a','u');
 assert.equal(t.messages.find(m=>m.text==='旧操作晚确认').isAfterLatestCustomer,false);
 assert.equal(t.messages.find(m=>m.text==='新问题的回复').isAfterLatestCustomer,true);
});

test('identical speech with a new native ID remains an independent untimed customer question', async()=>{
 const {buildReceptionTimeline}=await import('../notifier-store.mjs');
 const db={prepare:sql=>({all:()=>sql.includes('FROM events')?[{event_id:'old',text:'报价',platform_time_ms:2000}]:[
  {kind:'text',state:'sent',content:'针对旧问题',submitted_at_ms:2500,source_event_ids_json:'["old"]',evidence_json:'{"verified":true,"platformTimeMs":3000}'}]})};
 const t=buildReceptionTimeline(db,'a','u',{customerText:'报价',customerNativeId:'new'});
 assert.equal(t.openedAt,'开口时间未留存');
 assert.equal(t.messages.filter(m=>m.role==='customer').length,2);
 assert.equal(t.messages.find(m=>m.nativeId==='new').timeMs,null);
 assert.equal(t.messages.find(m=>m.role==='our').isAfterLatestCustomer,false);
});
