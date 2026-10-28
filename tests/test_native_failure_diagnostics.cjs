"use strict";
// Native control metadata only: actual snapshot and bounded read helper.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../xhs_reception/ui_actions.cjs'),'utf8');
const begin=source.indexOf('function nativeSelectionSnapshot('),end=source.indexOf('async function restoreNativeIntakeView(',begin);
assert(begin>=0&&end>begin,'native failure-time snapshot must exist');
const api=vm.runInNewContext('(function(){'+source.slice(begin,end)+';return {nativeSelectionSnapshot,nativeFailureDiagnostics};})()',{setTimeout,clearTimeout});
const secret='CUSTOMER_TEXT_AND_AUTH_MUST_NOT_APPEAR';
function documentFixture({current=false,unready=false}={}){
  const visible=(height=628)=>({checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:0,width:360,height}),scrollTop:123,clientHeight:height,scrollHeight:5515,
    className:'vue-recycle-scroller '+(!unready?'ready ':'')+'direction-vertical scroller',classList:{contains:token=>token==='ready'&&!unready},textContent:secret});
  return {readyState:'complete',querySelectorAll:selector=>{
    if(selector==='.contact-tab-wrap .d-tabs-header')return ['当前会话','全部会话'].map((text,index)=>({...visible(),innerText:text,classList:{contains:token=>token==='active'&&(index===0?current:!current)}}));
    if(selector==='.total-chat .vue-recycle-scroller')return [visible(0),visible()];
    if(selector==='.sx-contact-item')return [{...visible(),getAttribute:()=> (current?'Active-':'Total-')+'a'.repeat(24)}];
    if(selector==='.total-chat .d-loading,.total-chat .d-spin,.total-chat .loading,.total-chat [aria-busy="true"]')return [visible()];
    if(selector==='.total-chat .empty,.total-chat .empty-tip,.total-chat .loading-text')return [{...visible(),textContent:secret},{...visible(),textContent:'加载中'}];
    assert.fail('unknown diagnostic selector '+selector);
  }};
}
async function snapshotDistinguishesNativeViewAndCollapsedOrUnreadyGeometryWithoutCustomerText(){for(const current of [false,true]){
  const document=documentFixture({current,unready:true}),snapshot=vm.runInNewContext('('+api.nativeSelectionSnapshot.toString()+')()',{document});
  assert.equal(snapshot.tabs.filter(tab=>tab.active)[0].text,current?'当前会话':'全部会话');assert.equal(snapshot.total_scrollers.length,2);
  assert.equal(snapshot.total_scrollers[0].rect.height,0);assert.equal(snapshot.total_scrollers[1].rect.height,628);assert.equal(snapshot.total_scrollers[1].ready_class,false);
  assert.equal(snapshot.visible_rows[current?'active':'total'],1);assert.equal(snapshot.loading_visible,1);assert.deepEqual(Array.from(snapshot.native_status_hints),['加载中']);
  assert(!JSON.stringify(snapshot).includes(secret));
}}
async function failedNativeDiagnosticCannotHangTheSender(){const begin=Date.now();const result=await api.nativeFailureDiagnostics({evaluate:()=>new Promise(()=>{})});assert.equal(result.diagnostic_status,'native_diagnostics_timeout');assert(Date.now()-begin<350);}
async function diagnosticReadErrorsStayBoundedAndDoNotDumpErrorData(){const result=await api.nativeFailureDiagnostics({evaluate:()=>Promise.reject(Error(secret))});assert.equal(result.diagnostic_status,'native_diagnostics_unavailable');assert(!JSON.stringify(result).includes(secret));}
(async()=>{for(const test of [snapshotDistinguishesNativeViewAndCollapsedOrUnreadyGeometryWithoutCustomerText,failedNativeDiagnosticCannotHangTheSender,diagnosticReadErrorsStayBoundedAndDoNotDumpErrorData]){await test();console.log('PASS '+test.name);}console.log('3 bounded native-only diagnostic regressions; no live reads.');})().catch(error=>{console.error(error);process.exitCode=1;});
