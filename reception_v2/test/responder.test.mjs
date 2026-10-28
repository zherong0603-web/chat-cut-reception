import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, composeReply, isRefusal, isIdentityQuestion, validateFacts } from '../responder.mjs';

const facts = {
  approved: true,
  account_name: '运去哪海外仓',
  supported_regions: ['美国', '墨西哥'],
  unsupported_regions: ['日本'],
  service_capabilities: ['海外仓储', '一件代发', '头程运输', '尾程配送', '转运'],
  unsupported_services: ['个人快递', '个人寄件', '个人邮寄', '个人包裹', '个人转运', '个人代购'],
  qualification_fields: ['目的国或仓库', '货品类型', '预计件量', '所需服务'],
};

test('price question sends a direct WeCom invitation', () => {
  const intent = classifyIntent({ customerText: '美国仓报价多少？', facts });
  assert.equal(intent.kind, 'price');
  const reply = composeReply({ customerText: '美国仓报价多少？', facts, conversationId: 'c1' });
  assert.match(reply.text, /加我企微/);
  assert.match(reply.text, /客服小姐姐/);
  assert.doesNotMatch(reply.text, /确认|核实|帮你问/);
  assert.equal(reply.offerCard, true);
  assert.equal(reply.needsHuman, false);
});

test('unsupported region is declined directly', () => {
  const reply = composeReply({ customerText: '日本仓多少钱，几天能到？', facts, conversationId: 'c2' });
  assert.doesNotMatch(reply.text, /确认|核实|日本有仓|保证.*天|一定可以/);
  assert.match(reply.text, /日本海外仓.*不做|不承接/);
  assert.equal(reply.needsHuman, false);
  assert.equal(reply.offerCard, false);
});

test('short Japan capability question is also declined directly', () => {
  const reply = composeReply({ customerText: '日本的有吗', facts, conversationId: 'c-jp' });
  assert.match(reply.text, /日本海外仓.*不做|不承接/);
  assert.doesNotMatch(reply.text, /确认|核实/);
});

test('direct contact request sends a direct WeCom invitation', () => {
  const intent = classifyIntent({ customerText: '联系我们', facts });
  assert.equal(intent.kind, 'contact');
  const reply = composeReply({ customerText: '联系我们', facts, conversationId: 'contact-request' });
  assert.match(reply.text, /加我企微/);
  assert.doesNotMatch(reply.text, /确认|核实/);
  assert.equal(reply.offerCard, true);
});

test('recognized service demand sends a direct WeCom invitation', () => {
  const intent = classifyIntent({ customerText: '转运', facts });
  assert.equal(intent.kind, 'service');
  const reply = composeReply({ customerText: '转运', facts, conversationId: 'transfer' });
  assert.match(reply.text, /加我企微/);
  assert.match(reply.text, /客服小姐姐/);
  assert.doesNotMatch(reply.text, /确认|核实|帮你问/);
  assert.equal(reply.offerCard, true);
});

test('personal purchase and parcel forwarding is declined directly', () => {
  const history=[{text:'我想在一个美国网站买东西但他不寄中国',isCustomerText:true}];
  const intent=classifyIntent({customerText:'你们可以操作吗',facts,history});
  assert.equal(intent.kind,'personal_shipping');
  const reply=composeReply({customerText:'你们可以操作吗',facts,history,conversationId:'personal-forwarding'});
  assert.match(reply.text,/个人快递|个人包裹|个人转运/);
  assert.match(reply.text,/不做/);
  assert.doesNotMatch(reply.text,/加我企微|帮你确认|核实/);
  assert.equal(reply.offerCard,false);
});

test('explicit personal express request is declined', () => {
  for(const text of ['个人快递能做吗','个人包裹寄回中国可以吗','帮我代购再转运到中国']){
    const reply=composeReply({customerText:text,facts,conversationId:'personal-'+text});
    assert.match(reply.text,/个人快递|个人包裹|个人转运/);assert.equal(reply.offerCard,false);
  }
});

test('reply is friendly and asks at most one question', () => {
  const reply = composeReply({ customerText: '你好', facts, conversationId: 'c3' });
  assert.match(reply.text, /^你好|您好/);
  assert.equal((reply.text.match(/[？?]/g) || []).length <= 1, true);
  assert.equal(reply.offerCard, true);
});

test('identity question says smart reception', () => {
  assert.equal(isIdentityQuestion('你是机器人吗？'), true);
  const reply = composeReply({ customerText: '你是机器人吗？', facts, conversationId: 'c4' });
  assert.match(reply.text, /智能接待/);
  assert.doesNotMatch(reply.text, /我是真人/);
});

test('refusal stops acquisition', () => {
  assert.equal(isRefusal('不用了，不要再联系我'), true);
  const reply = composeReply({ customerText: '不用了，不要再联系我', facts, conversationId: 'c5' });
  assert.equal(reply.nextState, 'stopped');
  assert.equal(reply.offerCard, false);
  assert.equal(reply.text, '');
});
test('already-added statements are classified as terminal acquisition success', () => {
  for(const text of ['已加','加了','加过','加过了','已经加过了','已经添加了','加过企微','已加企微','已经添加企业微信','我已经加了','我加了','我已经添加企业微信了','我加上了']) {
    assert.equal(classifyIntent({customerText:text,facts}).kind,'contact_added');
  }
  assert.notEqual(classifyIntent({customerText:'我加了价格',facts}).kind,'contact_added');
});

test('same conversation varies opening without changing facts', () => {
  const a = composeReply({ customerText: '你好', facts, conversationId: 'stable-a' });
  const b = composeReply({ customerText: '你好', facts, conversationId: 'stable-b' });
  assert.notEqual(a.text, b.text);
  assert.equal((a.text.match(/[？?]/g) || []).length <= 1, true);
  assert.equal((b.text.match(/[？?]/g) || []).length <= 1, true);
});

test('unapproved or malformed facts cannot power live replies', () => {
  assert.throws(() => validateFacts({ ...facts, approved: false }), /facts_not_approved/);
  assert.throws(() => validateFacts({ ...facts, supported_regions: '美国' }), /invalid_facts/);
});

test('unknown request sends a direct card instead of asking for confirmation',()=>{
  const reply=composeReply({customerText:'你们能帮我处理墨西哥税务吗',facts,conversationId:'c6'});
  assert.equal(reply.needsHuman,false);assert.equal(reply.nextState,'waiting_contact');
  assert.match(reply.text,/加我企微/);assert.doesNotMatch(reply.text,/确认|核实|帮你问/);assert.equal(reply.offerCard,true);
});

test('later turn avoids repeating earlier reply',()=>{
  const first=composeReply({customerText:'你好',facts,conversationId:'same'});
  const second=composeReply({customerText:'你好',facts,conversationId:'same',avoidTexts:[first.text]});
  assert.notEqual(second.text,first.text);assert.equal((second.text.match(/[？?]/g)||[]).length<=1,true);
});
test('rejecting only wecom falls back to phone instead of stopping',()=>{
  for(const text of ['企微不用了，直接电话联系我','不用了发卡片，直接报美国仓价格']){
    const reply=composeReply({customerText:text,facts,conversationId:'fallback'});
    assert.notEqual(reply.nextState,'stopped');assert.notEqual(reply.text,'');
  }
});
test('approved regions control every reply without hard-coded extras',()=>{
  const onlyUS={...facts,supported_regions:['美国']};
  const greeting=composeReply({customerText:'你好',facts:onlyUS,conversationId:'us-only'});
  assert.match(greeting.text,/美国/);assert.doesNotMatch(greeting.text,/墨西哥/);
  const empty={...facts,supported_regions:[],service_capabilities:[]};
  const open=composeReply({customerText:'你好',facts:empty,conversationId:'empty'});
  assert.doesNotMatch(open.text,/美国|墨西哥/);assert.match(open.text,/服务/);
});
