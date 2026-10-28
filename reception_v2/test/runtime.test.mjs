import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireRuntimeLock, createRuntime, readHealth, POLL_INTERVAL_MS } from '../runtime.mjs';
import { openDatabase } from '../db.mjs';
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'reception-v2-runtime-'));
test('second instance is rejected before browser launch',async()=>{
  const dir=root();let launched=0;const deps={launchBrowser:async()=>{launched++},closeBrowser:async()=>{},orchestrator:null,readSidebar:async()=>({rows:[]})};
  const a=createRuntime({runtimeDir:dir,accountId:'a',armed:false,deps});
  const b=createRuntime({runtimeDir:dir,accountId:'a',armed:false,deps});
  try{await a.start();await assert.rejects(()=>b.start(),/reception_v2_already_running/);assert.equal(launched,1);}finally{await a.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('read only mode never arms send or overdue sweep',async()=>{
  const dir=root();let sweeps=0;const deps={launchBrowser:async()=>({}),closeBrowser:async()=>{},orchestrator:{sweepVisibleOverdue:async()=>{sweeps++;},pollOnce:async()=>{sweeps++;}},readSidebar:async()=>({rows:[{uid:'b',needsReply:true}]})};
  const r=createRuntime({runtimeDir:dir,accountId:'a',armed:false,deps});try{await r.start();await r.tick();assert.equal(sweeps,0);assert.equal(r.status().armed,false);assert.equal(r.status().send_state,'read_only');}finally{await r.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('lock check does not treat dead pid as owner',()=>{
  const dir=root();try{fs.writeFileSync(path.join(dir,'reception-v2.lock'),JSON.stringify({pid:999999,startedAt:1}));const release=acquireRuntimeLock(dir,process.pid);release();assert.equal(fs.existsSync(path.join(dir,'reception-v2.lock')),false);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('healthy tick requires successful sidebar read',async()=>{
  const dir=root();let fail=true;const deps={launchBrowser:async()=>({}),closeBrowser:async()=>{},orchestrator:null,readSidebar:async()=>{if(fail)throw new Error('read_failed');return {rows:[{uid:'b'}]}}};
  const r=createRuntime({runtimeDir:dir,accountId:'a',armed:false,deps});try{await r.start();const first=readHealth(dir);assert.equal(first.last_successful_sidebar_read_at,null);fail=false;await r.tick();const second=readHealth(dir);assert(second.last_successful_sidebar_read_at);assert.equal(second.candidates,1);}finally{await r.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('shutdown preserves pending turns and contacts',async()=>{
  const dir=root(),dbPath=path.join(dir,'reception-v2.sqlite3');const store=openDatabase(dbPath);store.ingestInbound({accountId:'a',conversationId:'b',eventId:'e',text:'报价',platformTimeMs:1000});store.upsertContact({accountId:'a',conversationId:'b',kind:'phone',value:'17300006725',source:'profile'});store.close();const again=openDatabase(dbPath);assert.equal(again.listTurns('a','b').length,1);assert.equal(again.getConversation('a','b').contactState,'obtained');again.close();fs.rmSync(dir,{recursive:true,force:true});
});
test('doctor no-browser does not require playwright',async()=>{
  const dir=root();try{const {doctor}=await import('../runtime.mjs');const result=doctor({runtimeDir:dir,playwrightConfigured:false,requireBrowser:false});assert.equal(result.ok,true);assert.equal(result.sends_enabled,false);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('poll interval is 250ms',()=>{assert.equal(POLL_INTERVAL_MS,250);});

test('armed successful poll advances successful sidebar read timestamp',async()=>{
  const dir=root();const deps={launchBrowser:async()=>({}),closeBrowser:async()=>{},readSidebar:async()=>({rows:[]}),orchestrator:{sweepVisibleOverdue:async()=>({processed:0,successfulRead:true}),pollOnce:async()=>({processed:0,successfulRead:true})}};
  const r=createRuntime({runtimeDir:dir,accountId:'a',armed:true,deps});try{await r.start();await r.tick();const health=readHealth(dir);assert(health.last_successful_sidebar_read_at);assert.equal(health.error,null);}finally{await r.stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('stop waits for an in-flight tick before closing browser and database',async()=>{
  const dir=root();let resolvePoll,closed=0;const poll=new Promise(resolve=>{resolvePoll=resolve});
  const deps={launchBrowser:async()=>({}),closeBrowser:async()=>{closed++},readSidebar:async()=>({rows:[]}),orchestrator:{sweepVisibleOverdue:async()=>({processed:0,successfulRead:true}),pollOnce:async()=>poll}};
  const r=createRuntime({runtimeDir:dir,accountId:'a',armed:true,deps});try{await r.start();const inFlight=r.tick();await new Promise(resolve=>setTimeout(resolve,5));let stopped=false;const stopping=r.stop().then(()=>{stopped=true});
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(stopped,false);assert.equal(closed,0);resolvePoll({processed:0,successfulRead:true});await inFlight;await stopping;assert.equal(stopped,true);assert.equal(closed,1);
  }finally{resolvePoll?.({processed:0,successfulRead:true});fs.rmSync(dir,{recursive:true,force:true});}
});
test('pilot one performs one sweep then stops without starting polling',async()=>{
  const dir=root();let sweepOptions=null,closed=0;const deps={launchBrowser:async()=>({}),closeBrowser:async()=>{closed++},readSidebar:async()=>({rows:[]}),orchestrator:{sweepVisibleOverdue:async options=>{sweepOptions=options;return {processed:1,results:[{uid:'b'}],failed:[],successfulRead:true}},pollOnce:async()=>{throw new Error('pilot_polled')}}};
  const r=createRuntime({runtimeDir:dir,accountId:'a',armed:true,pilotOne:true,deps});try{await r.start();assert.deepEqual(sweepOptions,{maxRows:1,contactScan:false,processToday:true});assert.equal(r.status().running,false);assert.equal(r.status().last_sweep.processed,1);assert.equal(closed,1);}finally{await r.stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('concurrent stale-lock recovery admits only one process',async()=>{
  const dir=root();try{fs.writeFileSync(path.join(dir,'reception-v2.lock'),JSON.stringify({pid:999999,startedAt:1}));const runtimeUrl=pathToFileURL(path.resolve('reception_v2/runtime.mjs')).href;const code=`import { acquireRuntimeLock } from ${JSON.stringify(runtimeUrl)}; try { const release=acquireRuntimeLock(process.argv[1]); setTimeout(()=>{release();process.exit(0)},250); } catch { process.exit(1); }`;
    const run=()=>new Promise(resolve=>{const child=spawn(process.execPath,['--input-type=module','-e',code,dir]);let out='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>out+=c);child.on('exit',code=>resolve({code,out}));});
    const results=await Promise.all([run(),run()]);assert.equal(results.filter(x=>x.code===0).length,1);assert.equal(results.filter(x=>x.code===1).length,1);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('live reused pid with different process start identity is treated as stale',()=>{
  const dir=root();try{const lock=path.join(dir,'reception-v2.lock');
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,processIdentity:'previous-process-at-this-pid',nonce:'old'}));
    const release=acquireRuntimeLock(dir,process.pid,{processIdentity:()=> 'current-process-at-this-pid'});
    const current=JSON.parse(fs.readFileSync(lock,'utf8'));
    assert.equal(current.pid,process.pid);assert.equal(current.processIdentity,'current-process-at-this-pid');release();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('stuck cleanup marker never returns an unowned lock',()=>{
  const dir=root();try{const lock=path.join(dir,'reception-v2.lock'),cleanup=lock+'.cleanup';
    fs.writeFileSync(lock,JSON.stringify({pid:999999,startedAt:1}));fs.mkdirSync(cleanup);
    assert.throws(()=>acquireRuntimeLock(dir,process.pid,{cleanupTimeoutMs:0}),/reception_v2_lock_cleanup_stuck/);
    assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).pid,999999);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
