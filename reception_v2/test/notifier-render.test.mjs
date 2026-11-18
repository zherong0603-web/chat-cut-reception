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
 const db={prepare:sql=>({all:()=>sql.includes('FROM events')?[{platform_time_ms:Date.parse('2026-11-18T11:23:45Z'),evidence_json:'{"text":"报价"}'}]:[
 {kind:'text',state:'sent',content:'请加企微',evidence_json:'{"verified":true,"platformTimeMs":1795001040000}'},
 {kind:'card',state:'uncertain',content:null,evidence_json:'{}'}
 ]})};
 const t=buildReceptionTimeline(db,'a','u');
 assert.match(t.openedAt,/2026-11-18 19:23:45/);
 assert.match(t.sentMessages,/请加企微/);
 assert.match(t.sentMessages,/尚不能确认发出：企业微信名片/);
});
