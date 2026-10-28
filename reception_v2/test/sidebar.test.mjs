import test from 'node:test';
import assert from 'node:assert/strict';
import { readSidebar, validateSidebarSnapshot } from '../sidebar.mjs';
const expected={id:'aaaaaaaaaaaaaaaaaaaaaaaa',name:'运去哪海外仓'};
const valid={origin:'https://sxt.xiaohongshu.com',pathname:'/im/multiCustomerService',title:'运去哪海外仓-私信通',activeTab:'全部会话',rows:[
  {key:'Total-bbbbbbbbbbbbbbbbbbbbbbbb',nickname:'客户甲',preview:'问问',statusTags:['[超时未回复]'],visible:true},
]};

test('overdue status is actionable but does not prove new entry',()=>{
  const value=validateSidebarSnapshot(valid,expected);
  assert.equal(value.rows[0].needsReply,true);assert.equal(value.rows[0].isNewEntry,false);
});
test('wrong active view is rejected',()=>{
  assert.throws(()=>validateSidebarSnapshot({...valid,activeTab:'当前会话'},expected),/native_all_conversations_view_required/);
});
test('preview text cannot forge an overdue badge',()=>{
  const fake=structuredClone(valid);fake.rows[0].preview='客户说未回复';fake.rows[0].statusTags=[];
  assert.equal(validateSidebarSnapshot(fake,expected).rows[0].needsReply,false);
});
test('native 留资客 badge becomes a terminal lead signal',()=>{
  for(const label of ['留资客','留客资']){
    const lead=structuredClone(valid);lead.rows[0].statusTags=['[超时未回复]',label];
    const value=validateSidebarSnapshot(lead,expected).rows[0];assert.equal(value.leadSignal,true);assert.equal(value.needsReply,true);
  }
});
test('native platform-AI badge requests human takeover without creating a reply',()=>{
  const platformAi=structuredClone(valid);platformAi.rows[0].statusTags=['接待中'];
  const value=validateSidebarSnapshot(platformAi,expected).rows[0];
  assert.equal(value.platformAiActive,true);assert.equal(value.needsReply,false);
});
test('preview words cannot forge a native lead badge',()=>{
  const fake=structuredClone(valid);fake.rows[0].preview='留客资';fake.rows[0].statusTags=[];
  assert.equal(validateSidebarSnapshot(fake,expected).rows[0].leadSignal,false);
});
test('bad rows are rejected before reading',()=>{
  assert.throws(()=>validateSidebarSnapshot({...valid,rows:[{...valid.rows[0],key:'Other-bbbbbbbbbbbbbbbbbbbbbbbb'}]},expected),/invalid_sidebar_row/);
});
test('readSidebar only consumes browser snapshot',async()=>{
  const page={evaluate:async()=>valid};const value=await readSidebar(page,expected);assert.equal(value.rows[0].needsReply,true);
});
test('periodic sidebar reads reset the virtual list to the newest rows',async()=>{
  const calls=[];const page={evaluate:async()=>{calls.push('evaluate');return valid;},waitForTimeout:async()=>calls.push('wait')};
  const value=await readSidebar(page,expected);assert.equal(value.rows.length,1);assert.equal(calls[0],'evaluate');assert.equal(calls[1],'wait');
});
test('readSidebar waits for the all-conversation list to hydrate after switching views',async()=>{
  let calls=0;const current={...valid,activeTab:'当前会话',rows:valid.rows.map(row=>({...row,key:row.key.replace('Total-','Active-')}))};
  const page={evaluate:async()=>{calls++;if(calls===1)return undefined;if(calls===2)return current;if(calls===4)return{...valid,rows:[]};return valid;},waitForTimeout:async()=>{}};
  const value=await readSidebar(page,expected);assert.equal(value.rows.length,1);assert(calls>=4);
});
