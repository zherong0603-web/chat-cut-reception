"use strict";
// Only the controller's trusted receive context can request service text mode.
// All dependencies are /tmp-only fixtures, with no browser/network/business DB.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),file=path.resolve(__dirname,'../xhs_reception/ui_actions.cjs'),real=createRequire(file);
const A='aaaaaaaaaaaaaaaaaaaaaaaa',U='bbbbbbbbbbbbbbbbbbbbbbbb',sourceId='jarvis-msg-'+U+'.'+A+'.native-customer-question';
async function fixture(check){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-trusted-service-'));
  fs.writeFileSync(path.join(runtime,'account_identity.json'),JSON.stringify({account_id:A,account_display_name:'SYNTHETIC'}));
  let callbacks;const received=[];
  const deps={'./ui_controller.cjs':{status:()=>({running:false}),start:async args=>{callbacks=args;return {running:true};}},
    './ui_scope.cjs':{readScope:async()=>({scope_ready:true,profile_binding_source:'current_native_profile',account_id:A,conversation_id:U})},
    './ui_sender.cjs':{receive:async args=>{received.push(args);return {fixture:true};}}};
  const nativeView={querySelectorAll:selector=>{
    if(selector==='.contact-tab-wrap .d-tabs-header')return [{innerText:'全部会话',checkVisibility:()=>true,classList:{contains:cls=>cls==='active'}}];
    if(selector==='.sx-contact-item')return [{checkVisibility:()=>true,getAttribute:()=> 'Total-'+U}];
    if(selector==='.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller')return [{checkVisibility:()=>true,getBoundingClientRect:()=>({width:800,height:628}),scrollTop:0}];throw Error('unexpected_fixture_native_selector');}};
  const page={url:()=> 'https://sxt.xiaohongshu.com/im/multiCustomerService',evaluate:async fn=>vm.runInNewContext('('+fn.toString()+')()',{document:nativeView}),
    waitForFunction:async fn=>{assert(vm.runInNewContext('('+fn.toString()+')()',{document:nativeView}));},locator:selector=>{
      assert(['.contact-tab-wrap .d-tabs-header','.total-chat .vue-recycle-scroller.ready.direction-vertical.scroller'].includes(selector));
      return {nth(index){assert.equal(index,0);return this;},filter(){return this;},waitFor:async()=>{},count:async()=>1,evaluate:async fn=>fn({scrollTop:0}),click:()=>{throw Error('unexpected_native_click');}};}},module={exports:{}};
  const wrapped=vm.runInNewContext('(function(exports,require,module,__filename,__dirname){\n'+fs.readFileSync(file,'utf8')+'\n})',
    {process,Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval,console,global:{}},{filename:file});
  wrapped(module.exports,name=>deps[name] || real(name),module,file,path.dirname(file));
  const run=cmd=>module.exports.run({page,runtime,cmd});
  try{await run({operation:'start_reception_worker'});await check({callbacks,received,run});}
  finally{fs.rmSync(runtime,{recursive:true,force:true});}
}
async function controllerServiceModeAndExactNativeSourceReachSender(){await fixture(async({callbacks,received})=>{
  await callbacks.receive({uid:U,text:'SYNTHETIC service answer',textOnlyService:true,sourceEventId:sourceId,freshSourceIds:new Set([sourceId]),isCurrent:()=>true});
  assert.equal(received[0].textOnlyService,true);assert.equal(received[0].sourceEventId,sourceId);assert.equal(received[0].freshSourceIds.has(sourceId),true);
});}
async function externalCommandCannotForgeServiceModeOrNativeSource(){await fixture(async({run,received,callbacks})=>{
  await run({operation:'reception_once',uid:U,text:'SYNTHETIC',text_only_service:true,textOnlyService:true,source_event_id:sourceId,sourceEventId:sourceId});
  assert.equal(received[0].textOnlyService,false);assert.equal(received[0].sourceEventId,undefined);
  await callbacks.receive({uid:U,text:'SYNTHETIC',textOnlyService:false,sourceEventId:sourceId,isCurrent:()=>true});
  assert.equal(received[1].textOnlyService,false);assert.equal(received[1].sourceEventId,undefined);
});}
async function controllerCorrectionCapabilityReachesSenderWithoutExternalSpoofing(){await fixture(async({callbacks,received,run})=>{
  await callbacks.receive({uid:U,text:'SYNTHETIC verified correction',correctionOfIntentId:'prior-exact-intent',sourceEventId:sourceId,isCurrent:()=>true});
  assert.equal(received[0].correctionOfIntentId,'prior-exact-intent');assert.equal(received[0].sourceEventId,sourceId);assert.equal(received[0].textOnlyService,false);
  await run({operation:'reception_once',uid:U,text:'SYNTHETIC',correctionOfIntentId:'spoofed-intent',sourceEventId:sourceId});
  assert.equal(received[1].correctionOfIntentId,undefined);assert.equal(received[1].sourceEventId,undefined);
});}

(async()=>{for(const test of [controllerServiceModeAndExactNativeSourceReachSender,externalCommandCannotForgeServiceModeOrNativeSource,controllerCorrectionCapabilityReachesSenderWithoutExternalSpoofing]){
  await test();console.log('PASS '+test.name);}console.log('3 isolated trusted service action regressions passed; no production evidence generated.');
})().catch(error=>{console.error(error);process.exitCode=1;});
