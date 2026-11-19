import test from 'node:test';
import assert from 'node:assert/strict';
import { reloginReception } from '../relogin-service.mjs';

function fixture({loaded=true,loginError=null}={}) {
  const calls=[];
  const deps={
    account:{accountId:'aaaaaaaaaaaaaaaaaaaaaaaa',accountName:'测试账号',runtimeDir:'/tmp/test-runtime'},
    service:{isLoaded:async()=>loaded,stop:async()=>calls.push('stop'),waitForStopped:async()=>calls.push('released'),start:async()=>calls.push('resume'),verify:async()=>{calls.push('verify');return {healthy:true};}},
    login:async options=>{calls.push('login');assert.equal(options.profileDir,'/tmp/test-runtime/isolated-browser-profile');assert.equal(options.accountName,'测试账号');assert.equal(options.visible,true);if(loginError)throw new Error(loginError);return{accountTitle:'测试账号-私信通'};},
  };
  return {deps,calls};
}
test('relogin releases the original profile then restores and verifies the same service',async()=>{
 const {deps,calls}=fixture();const result=await reloginReception(deps);
 assert.deepEqual(calls,['stop','released','login','resume','verify']);
 assert.equal(result.loginSucceeded,true);assert.equal(result.healthy,true);
});
test('failed login restores a previously loaded service and does not claim readiness',async()=>{
 const {deps,calls}=fixture({loginError:'interactive_login_timeout'});
 await assert.rejects(()=>reloginReception(deps),/interactive_login_timeout/);
 assert.deepEqual(calls,['stop','released','login','resume']);
});
test('relogin respects a service that was already intentionally unloaded',async()=>{
 const {deps,calls}=fixture({loaded:false});const result=await reloginReception(deps);
 assert.deepEqual(calls,['released','login']);assert.equal(result.serviceResumed,false);assert.equal(result.healthy,false);
});
test('profile release failure prevents launching a competing browser and restores service',async()=>{
 const {deps,calls}=fixture();deps.service.waitForStopped=async()=>{calls.push('released');throw new Error('profile_still_in_use');};
 await assert.rejects(()=>reloginReception(deps),/profile_still_in_use/);
 assert.deepEqual(calls,['stop','released','resume']);
});
test('successful login without successful message reads is not reported as ready',async()=>{
 const {deps,calls}=fixture();deps.service.verify=async()=>({healthy:false,error:'sidebar_not_reading'});
 const result=await reloginReception(deps);assert.equal(result.loginSucceeded,true);assert.equal(result.healthy,false);
});

test('readiness requires two fresh advancing successful reads for the exact account',async()=>{
 const {healthyReceptionPair}=await import('../relogin-service.mjs');
 const started=Date.parse('2026-11-19T10:30:00Z');
 const first={running:true,error:null,account_id:'a',last_tick_at_utc:'2026-11-19T10:30:05Z',last_successful_sidebar_read_at:'2026-11-19T10:30:05Z'};
 const second={...first,last_tick_at_utc:'2026-11-19T10:30:10Z',last_successful_sidebar_read_at:'2026-11-19T10:30:10Z'};
 assert.equal(healthyReceptionPair(first,second,'a',started),true);
 assert.equal(healthyReceptionPair(first,first,'a',started),false);
 assert.equal(healthyReceptionPair(first,{...second,error:'auth_required'},'a',started),false);
 assert.equal(healthyReceptionPair(first,{...second,account_id:'other'},'a',started),false);
 assert.equal(healthyReceptionPair(first,{...second,last_successful_sidebar_read_at:'2026-11-16T11:00:00Z'},'a',started),false);
 assert.equal(healthyReceptionPair(null,second,'a',started),false);
});

test('a stop operation that unloads then throws still attempts restoration',async()=>{
 const {deps,calls}=fixture();deps.service.stop=async()=>{calls.push('unloaded');throw new Error('stop_result_unavailable');};
 await assert.rejects(()=>reloginReception(deps),/stop_result_unavailable/);
 assert.deepEqual(calls,['unloaded','resume']);
});

test('closing the terminal cancels login and runs service restoration',async()=>{
 const {spawn}=await import('node:child_process');
 const program=`
 import {reloginReception,registerLoginCancellation} from './reception_v2/relogin-service.mjs';
 const controller=new AbortController();const dispose=registerLoginCancellation(controller);const keepAlive=setInterval(()=>{},1000);
 const service={isLoaded:async()=>true,stop:async()=>{},waitForStopped:async()=>{},start:async()=>console.log('RESTORED'),verify:async()=>({healthy:false})};
 try {await reloginReception({account:{runtimeDir:'/tmp/nonexistent-fixture',accountName:'test'},service,
 login:async()=>{console.log('READY');await new Promise((resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}});}
 catch(error){if(error.message!=='cancelled')throw error;}finally{clearInterval(keepAlive);dispose();}
 `;
 const child=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','pipe','pipe']});
 let output='',errors='',sent=false;
 child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('READY')&&!sent){sent=true;child.kill('SIGHUP');}});
 child.stderr.on('data',chunk=>errors+=chunk);
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 const result=await new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
 clearTimeout(timer);
 assert.equal(result.code,0,errors);assert.equal(result.signal,null);assert.match(output,/RESTORED/);
});
