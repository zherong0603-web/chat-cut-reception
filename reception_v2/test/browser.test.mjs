import test from 'node:test';
import assert from 'node:assert/strict';
import { activeConversationRootLocator, modeMatchesScope, nativeMessageBelongsToIntent, nativeMessageMatchesOutboundIntent, selectVisibleConversation } from '../browser.mjs';
const scope={accountId:'aaaaaaaaaaaaaaaaaaaaaaaa',conversationId:'bbbbbbbbbbbbbbbbbbbbbbbb'};
test('mode must match exact active uid',()=>{
  assert.equal(modeMatchesScope({scopeReady:true,conversationId:scope.conversationId,activeKey:'Total-'+scope.conversationId},scope),true);
  assert.equal(modeMatchesScope({scopeReady:true,conversationId:scope.conversationId,activeKey:'Active-'+scope.conversationId},scope),false);
  assert.equal(modeMatchesScope({scopeReady:true,conversationId:scope.conversationId},scope),false);
  assert.equal(modeMatchesScope({scopeReady:true,conversationId:'cccccccccccccccccccccccc'},scope),false);
  assert.equal(modeMatchesScope({scopeReady:false,conversationId:scope.conversationId},scope),false);
});
test('selection clicks exact row and waits for matching active uid',async()=>{
  let calls=0;const page={evaluate:async()=>{calls++;return true;},waitForTimeout:async()=>{}};
  const mode=async()=>calls===1?{scopeReady:false}:{scopeReady:true,conversationId:scope.conversationId,activeKey:'Total-'+scope.conversationId};
  const selected=await selectVisibleConversation(page,scope,mode);assert.equal(selected.conversationId,scope.conversationId);
});
test('virtual-list selection waits for rows rendered after scrolling',async()=>{
  let waits=0;const page={evaluate:async()=>waits>0,waitForTimeout:async()=>{waits++;}};
  const mode=async()=>({scopeReady:true,conversationId:scope.conversationId,activeKey:'Total-'+scope.conversationId});
  const selected=await selectVisibleConversation(page,scope,mode);assert.equal(selected.conversationId,scope.conversationId);assert.ok(waits>=1);
});
test('native receipt id must use the exact account and uid pairing',()=>{
  const intent={accountId:scope.accountId,conversationId:scope.conversationId};
  assert.equal(nativeMessageBelongsToIntent(`${scope.accountId}.${scope.conversationId}.m1`,intent),true);
  assert.equal(nativeMessageBelongsToIntent(`${scope.conversationId}.${scope.accountId}.m1`,intent),true);
  assert.equal(nativeMessageBelongsToIntent(`prefix.${scope.accountId}.${scope.conversationId}.m1`,intent),false);
  assert.equal(nativeMessageBelongsToIntent(`${scope.accountId}.${scope.conversationId}.`,intent),false);
  assert.equal(nativeMessageBelongsToIntent(`${scope.accountId}.cccccccccccccccccccccccc.m1`,intent),false);
});
test('interaction root is scoped by the exact active uid',()=>{
  const selectors=[],active={kind:'active'},root={kind:'root'};
  const page={locator(selector){selectors.push(selector);if(selector.includes('.sx-contact-item.active'))return active;
    return {filter({has}){selectors.push(has);return root;}};}};
  assert.equal(activeConversationRootLocator(page,scope),root);
  assert.deepEqual(selectors,['.sx-contact-item.active'+`[data-key="Total-${scope.conversationId}"]`, '#walle-ad', active]);
});
test('native receipt requires exact outbound account, receiver, type and submit time',()=>{
  const intent={...scope,kind:'text',content:'你好'};
  const message={id:`${scope.accountId}.${scope.conversationId}.m1`,sender_id:scope.accountId,receiver_id:scope.conversationId,
    message_type:'TEXT',content:'你好',created_at:2100};
  const row={sixin_message:message,message_extension:{customer_user_id:scope.conversationId}};
  assert.equal(nativeMessageMatchesOutboundIntent(row,intent,2000),true);
  assert.equal(nativeMessageMatchesOutboundIntent({sixin_message:{...message,sender_id:scope.conversationId}},intent,2000),false);
  assert.equal(nativeMessageMatchesOutboundIntent({sixin_message:{...message,receiver_id:scope.accountId}},intent,2000),false);
  assert.equal(nativeMessageMatchesOutboundIntent({sixin_message:{...message,message_type:'CARD'}},intent,2000),false);
  assert.equal(nativeMessageMatchesOutboundIntent({sixin_message:{...message,content:'你好呀'}},intent,2000),false);
  assert.equal(nativeMessageMatchesOutboundIntent({sixin_message:{...message,created_at:1999}},intent,2000),false);
  assert.equal(nativeMessageMatchesOutboundIntent({...row,message_extension:{customer_user_id:'cccccccccccccccccccccccc'}},intent,2000),false);
  const cardIntent={...scope,kind:'card',content:null};
  const cardContent=JSON.stringify({contentType:'COMMERCIAL_BUSINESS_CARD',csaAccountNo:'8694696952',type:'commercialBusinessCard',id:'2779776',name:'运去哪海外仓（企微）',corpName:'@运去哪物流科技集团'});
  const cardMessage={...message,message_type:'CARD',content:cardContent};
  assert.equal(nativeMessageMatchesOutboundIntent({sixin_message:cardMessage,message_extension:{customer_user_id:scope.conversationId}},cardIntent,2000),true);
  assert.equal(nativeMessageMatchesOutboundIntent({sixin_message:{...cardMessage,content:JSON.stringify({contentType:'OTHER_CARD',csaAccountNo:'8694696952',id:'2779776',name:'运去哪海外仓（企微）'})},message_extension:{customer_user_id:scope.conversationId}},cardIntent,2000),false);
  assert.equal(nativeMessageMatchesOutboundIntent({sixin_message:{...cardMessage,content:JSON.stringify({contentType:'COMMERCIAL_BUSINESS_CARD',csaAccountNo:'wrong',id:'2779776',name:'运去哪海外仓（企微）'})},message_extension:{customer_user_id:scope.conversationId}},cardIntent,2000),false);
});

test('native card history uses the configured account card identity',()=>{
  const card={title:'企微_账号B（企微）',visibleName:'账号B（企微）',id:'100200300',csaAccountNo:'9988776655',corpName:'@账号B企业'};
  const intent={...scope,kind:'card',content:null};
  const message={id:`${scope.accountId}.${scope.conversationId}.m2`,sender_id:scope.accountId,receiver_id:scope.conversationId,message_type:'CARD',created_at:2100,
    content:JSON.stringify({contentType:'COMMERCIAL_BUSINESS_CARD',csaAccountNo:card.csaAccountNo,type:'commercialBusinessCard',id:card.id,name:card.visibleName,corpName:card.corpName})};
  const row={sixin_message:message,message_extension:{customer_user_id:scope.conversationId}};
  assert.equal(nativeMessageMatchesOutboundIntent(row,intent,2000,card),true);
  assert.equal(nativeMessageMatchesOutboundIntent(row,intent,2000),false);
});

test('configured card sender has no config shadowing and clicks the exact native card button',async()=>{
  const cardConfig={title:'企微_账号B（企微）',visibleName:'账号B（企微）',id:'100200300',csaAccountNo:'9988776655',corpName:'@账号B企业'};
  const calls=[];const button={count:async()=>1,isEnabled:async()=>true,click:async()=>calls.push('send')};
  const cardLocator={locator(){return this},count:async()=>1,hover:async()=>calls.push('hover'),getByRole:()=>button};
  const title={filter(){return this},waitFor:async()=>calls.push('title-visible'),count:async()=>1,locator(selector){calls.push('title-locator:'+selector);return cardLocator;}};
  const segment={filter(){return this},count:async()=>1,waitFor:async()=>{},click:async()=>calls.push('tab')};
  const root={count:async()=>1,locator(selector){if(selector.includes('.d-segment-item'))return segment;if(selector.includes('.card-box__content-title')){assert.match(selector,/企微_账号B/);return title;}throw new Error('unexpected_locator:'+selector);}};
  const active={};const page={locator(selector){if(selector.includes('.sx-contact-item.active'))return active;if(selector==='#walle-ad')return{filter:()=>root};throw new Error('unexpected_page_locator:'+selector);}};
  const {sendConfiguredWeComCard}=await import('../browser.mjs');
  await sendConfiguredWeComCard({page,scope,cardConfig,assertActive:async()=>calls.push('active')});
  assert.deepEqual(calls.filter(x=>['active','title-visible','tab','hover','send'].includes(x)),['active','tab','title-visible','active','hover','send','active']);
});
