import test from 'node:test';
import assert from 'node:assert/strict';
import { extractContacts, readContacts, revealMaskedContacts, redactContactLogs } from '../contact.mjs';
const expected={accountId:'aaaaaaaaaaaaaaaaaaaaaaaa',conversationId:'bbbbbbbbbbbbbbbbbbbbbbbb'};
const scoped={activeKey:'Total-'+expected.conversationId,profileUid:expected.conversationId};

test('current profile phone and wechat are extracted',()=>{
  const values=extractContacts(expected,{...scoped,profileFields:[{label:'手机号码',value:'17300006725',masked:false},{label:'微信账号',value:'sales_abc',masked:false}],customerMessages:[]});
  assert.deepEqual(values.map(x=>[x.kind,x.value]),[['phone','17300006725'],['wechat','sales_abc']]);
});
test('customer message contact requires explicit context',()=>{
  assert.equal(extractContacts(expected,{...scoped,profileFields:[],customerMessages:[{text:'17300006725',isCustomerText:true}]})[0].kind,'phone');
  assert.equal(extractContacts(expected,{...scoped,profileFields:[],customerMessages:[{text:'手机号是17300006725',isCustomerText:true}]})[0].value,'17300006725');
  assert.equal(extractContacts(expected,{...scoped,profileFields:[],customerMessages:[{text:'微信：abc_123',isCustomerText:true}]})[0].value,'abc_123');
  assert.equal(extractContacts(expected,{...scoped,profileFields:[],customerMessages:[{text:'手机号是17300006725'}]}).length,0);
});
test('ordinary prose is never a verified contact',()=>{
  assert.equal(extractContacts(expected,{...scoped,profileFields:[],customerMessages:[{text:'wechat verification is required',isCustomerText:true}]}).length,0);
  assert.equal(extractContacts(expected,{...scoped,profileFields:[],customerMessages:[{text:'wzp20160616',isCustomerText:true}]})[0].kind,'wechat_candidate');
  assert.equal(extractContacts(expected,{...scoped,profileFields:[],customerMessages:[{text:'wzp20160616',isCustomerText:true}]})[0].verified,false);
});
test('foreign hidden contact is ignored',()=>{
  assert.equal(extractContacts(expected,{...scoped,profileFields:[{label:'手机号码',value:'17300001111',visible:false}],customerMessages:[]}).length,0);
});
test('contact observation must belong to the checked active uid',()=>{
  assert.throws(()=>extractContacts(expected,{activeKey:'Active-cccccccccccccccccccccccc',profileFields:[{label:'手机号码',value:'17300006725'}],customerMessages:[]}),/contact_active_uid_mismatch/);
  assert.deepEqual(extractContacts(expected,{activeKey:null,profileUid:expected.conversationId,profileFields:[{label:'手机号码',value:'17300006725'}],customerMessages:[]}),[]);
  assert.deepEqual(extractContacts(expected,{activeKey:'Total-'+expected.conversationId,profileUid:null,profileFields:[{label:'手机号码',value:'17300006725'}],customerMessages:[]}),[]);
  assert.throws(()=>extractContacts(expected,{activeKey:'Total-'+expected.conversationId,profileUid:'cccccccccccccccccccccccc',profileFields:[{label:'手机号码',value:'17300006725'}],customerMessages:[]}),/contact_profile_uid_mismatch/);
});
test('native wecom added and submitted lead card stop acquisition',()=>{
  const values=extractContacts(expected,{...scoped,profileFields:[{label:'名片',value:'企业微信 - 已添加企微'},{label:'留资卡',value:'已提交留资卡'}],customerMessages:[]});
  assert.deepEqual(values.map(x=>x.kind),['wecom_added','lead_submitted']);
});
test('customer explicitly saying already added becomes an immediate terminal contact',()=>{
  for(const text of ['已加','加了','已经添加了','已加企微','已经添加企业微信','我已经加了','我加了','我已经添加企业微信了','我加上了']){
    const values=extractContacts(expected,{...scoped,profileFields:[],customerMessages:[{text,isCustomerText:true}]});
    assert.equal(values.some(value=>value.kind==='wecom_added'&&value.verified===true),true,text);
  }
  assert.equal(extractContacts(expected,{...scoped,profileFields:[],customerMessages:[{text:'我加了价格',isCustomerText:true}]}).some(value=>value.kind==='wecom_added'),false);
});
test('masked field uses only its adjacent eye',async()=>{
  let clickCount=0,openCount=0,reads=0;
  const page={evaluate:async(_fn,input)=>{
    if(input?.mode==='open-profile'){openCount++;return {opened:1,label:'客资标注'};}
    if(input?.mode==='click'){clickCount++;return {clicked:1,label:'手机号码'};}
    reads++;return {...scoped,profileFields:[{label:'手机号码',value:reads<=2?'173****6725':'17300006725',masked:reads<=2}],customerMessages:[]};
  },waitForTimeout:async()=>{}};
  const before=await readContacts(page,{...expected,profileFields:[]});
  assert.equal(before.length,0);
  const revealed=await revealMaskedContacts(page,{...expected,profileFields:[{label:'手机号码',value:'173****6725',masked:true}]});
  assert(openCount>=2);assert.equal(clickCount,1);assert.equal(revealed[0].value,'17300006725');
});
test('full contact is redacted from logs',()=>{
  const value=redactContactLogs('phone 17300006725 wechat abc_123');
  assert(!value.includes('17300006725'));assert(!value.includes('abc_123'));
});
