import test from 'node:test';
import assert from 'node:assert/strict';
import { readConversation, validateConversationScope } from '../scope.mjs';
const expected={accountId:'aaaaaaaaaaaaaaaaaaaaaaaa',accountName:'运去哪海外仓',conversationId:'bbbbbbbbbbbbbbbbbbbbbbbb'};
const base={origin:'https://sxt.xiaohongshu.com',pathname:'/im/multiCustomerService',title:'运去哪海外仓-私信通',activeKey:'Total-bbbbbbbbbbbbbbbbbbbbbbbb',
  profileUid:'bbbbbbbbbbbbbbbbbbbbbbbb',headerNickname:'客户甲',rowNickname:'客户甲',messages:[
    {nativeId:'jarvis-msg-bbbbbbbbbbbbbbbbbbbbbbbb.aaaaaaaaaaaaaaaaaaaaaaaa.m1',direction:'left',type:'TEXT',text:'报价',platformTimeMs:1000,ai:false,system:false},
    {nativeId:'jarvis-msg-bbbbbbbbbbbbbbbbbbbbbbbb.aaaaaaaaaaaaaaaaaaaaaaaa.m2',direction:'right',type:'TEXT',text:'您好',platformTimeMs:1100,ai:false,system:false},
  ]};
test('profile and message uid must match',()=>{assert.equal(validateConversationScope(base,expected).messages.length,2);});
test('scope may omit an unopened profile uid while contact reads stay fail closed',()=>{
  const value=validateConversationScope({...base,profileUid:null,headerNickname:'客户甲',rowNickname:'客户甲'},expected);
  assert.equal(value.conversationId,expected.conversationId);assert.equal(value.profileUid,null);
});
test('cached or foreign message is rejected',()=>{
  const bad=structuredClone(base);bad.messages[0].nativeId='jarvis-msg-cccccccccccccccccccccccc.aaaaaaaaaaaaaaaaaaaaaaaa.m1';
  assert.throws(()=>validateConversationScope(bad,expected),/native_message_scope_mismatch/);
});
test('header and profile must match active row',()=>{
  assert.throws(()=>validateConversationScope({...base,profileUid:'cccccccccccccccccccccccc'},expected),/profile_uid_mismatch/);
  assert.throws(()=>validateConversationScope({...base,headerNickname:'别人'},expected),/nickname_mismatch/);
});
test('source note hint is not customer speech',()=>{
  const value=validateConversationScope({...base,messages:[{nativeId:'jarvis-msg-bbbbbbbbbbbbbbbbbbbbbbbb.aaaaaaaaaaaaaaaaaaaaaaaa.m3',direction:'center',type:'RICH_HINT',text:'对方通过广告进入私信',platformTimeMs:900,ai:false,system:false}]},expected);
  assert.equal(value.messages[0].isCustomerText,false);
});
test('ai and system left text are never customer speech',()=>{
  for(const attribution of [{ai:true,system:false},{ai:false,system:true},{ai:true,system:true}]){
    const message={nativeId:'jarvis-msg-bbbbbbbbbbbbbbbbbbbbbbbb.aaaaaaaaaaaaaaaaaaaaaaaa.m9',direction:'left',type:'TEXT',text:'手机号是17300006725',platformTimeMs:1000,...attribution};
    const value=validateConversationScope({...base,messages:[message]},expected);
    assert.equal(value.messages[0].isCustomerText,false);
  }
});
test('conversation reader waits for hydrated message DOM under the exact uid',async()=>{
  let calls=0;const page={waitForTimeout:async()=>{},evaluate:async()=>{calls++;if(calls===1)return{...base,messages:[]};return base;}};
  const value=await readConversation(page,expected,expected.conversationId);assert.equal(calls,2);assert.equal(value.messages.length,2);
});

test('conversation scope accepts account B official title instead of hardcoded account A',()=>{
  const expectedB={accountId:'aaaaaaaaaaaaaaaaaaaaaaaa',accountName:'账号B',conversationId:'bbbbbbbbbbbbbbbbbbbbbbbb'};
  const snapshot={...base,title:'账号B-私信通'};
  assert.equal(validateConversationScope(snapshot,expectedB).conversationId,expectedB.conversationId);
  assert.throws(()=>validateConversationScope({...snapshot,title:'运去哪海外仓-私信通'},expectedB),/account_title_mismatch/);
});
