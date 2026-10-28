import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCardText } from '../notifier-store.mjs';
test('renderer displays five fields and hides details by default',()=>{
  const text=renderCardText({kind:'ready_to_follow',fields:{'客户':'Kusu','想了解':'美国仓报价','联系方式':'手机号 17300006725','我已完成':'已发文字和企微卡','下一步':'联系客户'},details:{customer_text:'报价多少'}});
  for(const value of ['可以跟进','Kusu','美国仓报价','17300006725','联系客户'])assert.match(text,new RegExp(value));
  assert.doesNotMatch(text,/报价多少/);
});
