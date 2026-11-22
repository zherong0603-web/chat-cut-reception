import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNativeReceiptReader,openBrowser } from '../browser.mjs';

const accountId='aaaaaaaaaaaaaaaaaaaaaaaa',uid='bbbbbbbbbbbbbbbbbbbbbbbb';
const card={title:'企微_测试仓（企微）',visibleName:'测试仓（企微）',id:'card-123',csaAccountNo:'csa-456',corpName:'@测试公司'};
const historyUrl=`https://sxt.xiaohongshu.com/api-sxt/edith/chatline/msg?customer_user_id=${uid}&limit=20`;
const intent=kind=>({intentId:`test-${kind}`,accountId,conversationId:uid,kind,content:kind==='text'?'测试回复':null});
function nativeRow(kind,createdAt,id=kind){return {sixin_message:{id:`${accountId}.${uid}.${id}`,sender_id:accountId,receiver_id:uid,message_type:kind==='card'?'CARD':'TEXT',created_at:createdAt,content:kind==='card'?JSON.stringify({contentType:'COMMERCIAL_BUSINESS_CARD',id:card.id,csaAccountNo:card.csaAccountNo,name:card.visibleName,corpName:card.corpName}):'测试回复'},message_extension:{customer_user_id:uid}};}
const envelope=messages=>({success:true,code:0,data:{messages}});
function observedRecord(rows,base=Date.now()) {return {status:200,responseOk:true,queryUserIds:[uid],requestStartedAtMs:base-80,receivedAtMs:base-20,body:envelope(rows),request:{url:()=>historyUrl,method:()=>'GET',allHeaders:async()=>({})}};}
async function fixture(get=async()=>({status:()=>200,json:async()=>envelope([])})){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-receipt-test-')),modulePath=path.join(dir,'fake-playwright.mjs');
 const events=new Map(),requests=[];const locator={first(){return this;},waitFor:async()=>{},count:async()=>1};
 const page={on:()=>{},goto:async()=>{},locator:()=>locator,title:async()=>'测试账号-私信通',isClosed:()=>false};
 const context={pages:()=>[page],on:(name,fn)=>events.set(name,fn),close:async()=>events.get('close')?.(),request:{get:async(url,options)=>{requests.push({url,options,startedAtMs:Date.now()});return get(url,options,requests.length);}}};
 const globalKey=`__nativeReceiptFixture_${path.basename(dir).replaceAll('-','_')}`;globalThis[globalKey]=context;
 fs.writeFileSync(modulePath,`export const chromium={executablePath:()=>'/unused-offline-fixture',launchPersistentContext:async()=>globalThis[${JSON.stringify(globalKey)}]};`);
 const oldModule=process.env.XHS_PLAYWRIGHT_MODULE;process.env.XHS_PLAYWRIGHT_MODULE=modulePath;
 let browser;
 try{browser=await openBrowser({profileDir:path.join(dir,'profile'),accountId,accountName:'测试账号',card});}
 finally{if(oldModule===undefined)delete process.env.XHS_PLAYWRIGHT_MODULE;else process.env.XHS_PLAYWRIGHT_MODULE=oldModule;}
 const addTemplate=({url=historyUrl,method='GET',headers={accept:'application/json',':authority':'discard','Cookie':'discard','Host':'discard','content-length':'discard',connection:'discard','accept-encoding':'discard'}}={})=>{
  browser.nativeRecords.push({...observedRecord([],Date.now()-1000),request:{url:()=>url,method:()=>method,allHeaders:async()=>headers}});
 };
 return {browser,requests,addTemplate,close:async()=>{await browser.close();delete globalThis[globalKey];fs.rmSync(dir,{recursive:true,force:true});}};
}

test('fresh observed native GET confirms text and card through one shared read',async()=>{
 const base=Date.now(),f=await fixture(async()=>({status:()=>200,json:async()=>envelope([nativeRow('text',base-30),nativeRow('card',base-20)])}));f.addTemplate();
 try{
  const [text,cardReceipt]=await Promise.all([f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:50,receiptGroupId:'pair-1'}),f.browser.waitForReceipt(intent('card'),{startedAtMs:base-80,timeoutMs:50,receiptGroupId:'pair-1'})]);
  assert.equal(text.serverStatus,'confirmed');assert.equal(cardReceipt.serverStatus,'confirmed');assert.equal(f.requests.length,1);
  assert.equal(cardReceipt.cardTitle,card.title);assert.ok(cardReceipt.observedAtMs>=f.requests[0].startedAtMs);
  assert.deepEqual(Object.keys(f.requests[0].options.headers),['accept']);assert.equal(f.requests[0].options.maxRedirects,0);assert.equal(f.requests[0].options.failOnStatusCode,false);assert.ok(f.requests[0].options.timeout<=50);
 }
 finally{await f.close();}
});

test('a same-group missing native receipt makes at most two bounded GETs',async()=>{
 const base=Date.now(),f=await fixture();f.addTemplate();
 try{
  const receipts=await Promise.all([f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:60,receiptGroupId:'pair-empty'}),f.browser.waitForReceipt(intent('card'),{startedAtMs:base-80,timeoutMs:60,receiptGroupId:'pair-empty'})]);
  assert.ok(f.requests.length>=1&&f.requests.length<=2);assert.ok(receipts.every(row=>row.serverStatus==='pending'));
 }
 finally{await f.close();}
});

test('strict cached duplicates retain the real first observation and need no GET',async()=>{
 const base=Date.now(),f=await fixture();f.addTemplate();
 f.browser.nativeRecords.push(observedRecord([nativeRow('text',base-50)],base),observedRecord([nativeRow('text',base-50)],base+10));
 try{const receipt=await f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:30});assert.equal(receipt.serverStatus,'confirmed');assert.equal(receipt.observedAtMs,base-20);assert.equal(f.requests.length,0);}
 finally{await f.close();}
});

test('two different matching native IDs remain ambiguous instead of choosing the first',async()=>{
 const base=Date.now(),f=await fixture();f.browser.nativeRecords.push(observedRecord([nativeRow('text',base-50,'first'),nativeRow('text',base-40,'second')],base));
 try{const receipt=await f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:30});assert.equal(receipt.serverStatus,'pending');}
 finally{await f.close();}
});

for(const kind of ['missing-observation','future-observation','bad-envelope'])test(`a cached ${kind} cannot become a confirmed receipt`,async()=>{
 const base=Date.now(),f=await fixture(),record=observedRecord([nativeRow('text',base-50)],base);
 if(kind==='missing-observation')delete record.receivedAtMs;
 if(kind==='future-observation')record.receivedAtMs=base+60_000;
 if(kind==='bad-envelope')record.body.success=false;
 f.browser.nativeRecords.push(record);
 try{const receipt=await f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:30});assert.equal(receipt.serverStatus,'pending');}
 finally{await f.close();}
});

test('a closed browser lifecycle cannot confirm a saved record',async()=>{
 const base=Date.now(),f=await fixture();f.browser.nativeRecords.push(observedRecord([nativeRow('text',base-50)],base));
 try{await f.browser.close();const receipt=await f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:30});assert.equal(receipt.serverStatus,'pending');}
 finally{await f.close();}
});

for(const [name,template] of [
 ['foreign origin',{url:historyUrl.replace('sxt.xiaohongshu.com','example.invalid')}],
 ['wrong native path',{url:historyUrl.replace('/chatline/msg','/chatline/send')}],
 ['duplicate customer id',{url:historyUrl+`&customer_user_id=${uid}`}],
 ['other customer',{url:historyUrl.replace(uid,'cccccccccccccccccccccccc')}],
 ['POST template',{method:'POST'}],
 ['credentialed URL',{url:historyUrl.replace('https://','https://user:password@')}],
 ['fragment URL',{url:historyUrl+'#fragment'}],
])test(`${name} does not authorize a history request`,async()=>{
 const base=Date.now(),f=await fixture();f.addTemplate(template);
 try{const receipt=await f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:30});assert.equal(f.requests.length,0);assert.equal(receipt.serverStatus,'pending');}
 finally{await f.close();}
});

for(const field of ['content','sender_id','created_at'])test(`a conflicting ${field} for the same full native ID remains pending`,async()=>{
 const base=Date.now(),f=await fixture(),good=nativeRow('text',base-50),bad=structuredClone(good);
 bad.sixin_message[field]=field==='content'?'different text':field==='sender_id'?uid:base-51;
 f.browser.nativeRecords.push(observedRecord([good,bad],base));
 try{const receipt=await f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:30});assert.equal(receipt.serverStatus,'pending');}
 finally{await f.close();}
});

test('mutable non-identity card metadata does not create a false receipt conflict',async()=>{
 const base=Date.now(),f=await fixture(),first=nativeRow('card',base-50),second=structuredClone(first);
 first.sixin_message.content=JSON.stringify({...JSON.parse(first.sixin_message.content),clicked:false});
 second.sixin_message.content=JSON.stringify({...JSON.parse(second.sixin_message.content),clicked:true});
 f.browser.nativeRecords.push(observedRecord([first,second],base));
 try{const receipt=await f.browser.waitForReceipt(intent('card'),{startedAtMs:base-100,timeoutMs:30});assert.equal(receipt.serverStatus,'confirmed');}
 finally{await f.close();}
});

test('a matching passive body from another origin is not a native platform receipt',async()=>{
 const base=Date.now(),f=await fixture(),record=observedRecord([nativeRow('text',base-50)],base);
 record.request={url:()=>historyUrl.replace('sxt.xiaohongshu.com','example.invalid'),method:()=>'GET',allHeaders:async()=>({})};f.browser.nativeRecords.push(record);
 try{const receipt=await f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:30});assert.equal(receipt.serverStatus,'pending');}
 finally{await f.close();}
});

test('SDK read errors return only a bounded safe diagnostic',async()=>{
 const base=Date.now(),f=await fixture(async()=>{throw new Error('synthetic-private-header-value https://example.invalid/?token=synthetic-token');});f.addTemplate();
 try{const receipt=await f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:40});assert.equal(receipt.serverStatus,'pending');assert.ok(f.requests.length>=1&&f.requests.length<=2);assert.doesNotMatch(JSON.stringify(receipt),/synthetic-private-header-value|synthetic-token|example\.invalid/);}
 finally{await f.close();}
});

test('the second bounded GET waits for a delayed card inside the original two-second budget',async()=>{
 let clock=100_000;const calls=[];
 const records=[{...observedRecord([],clock-1000),request:{url:()=>historyUrl,method:()=>'GET',allHeaders:async()=>({})}}];
 const reader=createNativeReceiptReader({accountId,card,nativeRecords:records,now:()=>clock,sleep:async ms=>{clock+=ms;},request:{get:async()=>{
  calls.push(clock);return {status:()=>200,json:async()=>envelope([nativeRow('text',99_950),...(clock>=101_250?[nativeRow('card',101_250)]:[])])};
 }}});
 const [text,cardReceipt]=await Promise.all([reader.waitForReceipt(intent('text'),{startedAtMs:99_900,receiptGroupId:'delayed-pair'}),reader.waitForReceipt(intent('card'),{startedAtMs:99_950,receiptGroupId:'delayed-pair'})]);
 assert.equal(text.serverStatus,'confirmed');assert.equal(cardReceipt.serverStatus,'confirmed');assert.equal(calls.length,2);assert.ok(calls[1]>=101_250);assert.ok(cardReceipt.observedAtMs<=102_000);assert.equal(cardReceipt.platformTimeMs,101_250);
});

test('a later submission never reuses a history request started before that submission',async()=>{
 const base=Date.now();let releaseFirst,signalFirst,laterSubmit=base;
 const gate=new Promise(resolve=>{releaseFirst=resolve;}),started=new Promise(resolve=>{signalFirst=resolve;});
 const f=await fixture(async(_url,_options,n)=>{if(n===1)signalFirst();return {status:()=>200,json:async()=>{if(n===1)await gate;return envelope([nativeRow('text',base-30),nativeRow('card',laterSubmit)]);}};});f.addTemplate();
 const first=f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:200,receiptGroupId:'generation-1'});
 try{
  await started;await new Promise(resolve=>setTimeout(resolve,2));laterSubmit=Date.now();
  const later=f.browser.waitForReceipt(intent('card'),{startedAtMs:laterSubmit,timeoutMs:200,receiptGroupId:'generation-2'});releaseFirst();
  const [text,cardReceipt]=await Promise.all([first,later]);assert.equal(text.serverStatus,'confirmed');assert.equal(cardReceipt.serverStatus,'confirmed');assert.equal(f.requests.length,2);assert.ok(f.requests[0].startedAtMs<laterSubmit);assert.ok(f.requests[1].startedAtMs>=laterSubmit);
 }
 finally{releaseFirst();await first;await f.close();}
});

for(const phase of ['headers','json'])test(`a stalled ${phase} phase cannot exceed the native-read budget indefinitely`,async()=>{
 const base=Date.now(),never=new Promise(()=>{}),f=await fixture(async()=>({status:()=>200,json:()=>never}));f.addTemplate();
 if(phase==='headers')f.browser.nativeRecords.at(-1).request.allHeaders=()=>never;
 let timer;
 try{const result=await Promise.race([f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:40}),new Promise(resolve=>{timer=setTimeout(()=>resolve('not_completed'),100);})]);assert.notEqual(result,'not_completed');assert.equal(result.serverStatus,'pending');}
 finally{clearTimeout(timer);await f.close();}
});

test('response disposal does not delay persistence of an already parsed strict receipt',async()=>{
 const base=Date.now();let releaseDispose;
 const disposed=new Promise(resolve=>{releaseDispose=resolve;});
 const f=await fixture(async()=>({status:()=>200,json:async()=>envelope([nativeRow('text',base-30)]),dispose:()=>disposed}));f.addTemplate();let timer;
 try{const result=await Promise.race([f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:40}),new Promise(resolve=>{timer=setTimeout(()=>resolve('disposal_blocked'),100);})]);assert.notEqual(result,'disposal_blocked');assert.equal(result.serverStatus,'confirmed');}
 finally{releaseDispose();clearTimeout(timer);await f.close();}
});

test('a message-shaped object nested inside a customer attachment is never native history',async()=>{
 const base=Date.now(),f=await fixture();f.browser.nativeRecords.push(observedRecord([{customer_attachment:{not_a_platform_message:nativeRow('text',base-50)}}],base));
 try{const receipt=await f.browser.waitForReceipt(intent('text'),{startedAtMs:base-100,timeoutMs:30});assert.equal(receipt.serverStatus,'pending');}
 finally{await f.close();}
});

for(const method of ['readNativeHistory','waitForReceipt'])for(const sameGroup of [false,true])test(`${method} honors each waiter's budget while preserving a longer shared GET (${sameGroup?'same':'different'} group)`,async()=>{
 const base=Date.now();let release,signal;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{signal=resolve;});
 const f=await fixture(async()=>{signal();return{status:()=>200,json:async()=>{await gate;return envelope([nativeRow('text',base-30)]);}};});f.addTemplate();
 const long=f.browser[method](intent('text'),{startedAtMs:base-100,timeoutMs:200,receiptGroupId:'long-group'});let timer,shortTimer;
 try{
  await started;timer=setTimeout(release,80);
  const short=await Promise.race([f.browser[method](intent('text'),{startedAtMs:base-80,timeoutMs:20,receiptGroupId:sameGroup?'long-group':'short-group'}),new Promise(resolve=>{shortTimer=setTimeout(()=>resolve('waiter_exceeded_budget'),55);})]);
  assert.notEqual(short,'waiter_exceeded_budget');clearTimeout(shortTimer);
  assert.equal(method==='waitForReceipt'?short.serverStatus:short.status,'pending');
  const completed=await long;assert.equal(method==='waitForReceipt'?completed.serverStatus:completed.status,method==='waitForReceipt'?'confirmed':'read');assert.equal(f.requests.length,1);
  assert.equal(f.browser.peekReceipt(intent('text'),{startedAtMs:base-100}).serverStatus,'confirmed');
 }
 finally{release();clearTimeout(timer);clearTimeout(shortTimer);await long;await f.close();}
});
