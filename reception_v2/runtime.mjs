import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LOCK='reception-v2.lock', HEALTH='reception-v2-health.json';
export const POLL_INTERVAL_MS=250;
function isNavigationRecoveryError(error){const text=String(error?.message||error||'');return /unexpected_sidebar_route|account_title_not_ready|account_title_mismatch/i.test(text);}
function isFatalBrowserError(error){const text=String(error?.message||error||'');return /Target crashed|Target page, context or browser has been closed|context or browser has been closed|browser has been closed|page has been closed|page_evaluate: Target closed/i.test(text);}
function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});try{fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}fs.chmodSync(file,0o600);}
function pidAlive(pid){if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch{return false;}}
export function processStartIdentity(pid=process.pid){const result=spawnSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'});if(result.status!==0)return null;return String(result.stdout||'').trim()||null;}

export function readLockOwner(runtimeDir,options={}){
  const isAlive=options.pidAlive||pidAlive, identityFor=options.processIdentity||processStartIdentity;
  try {
    const owner=JSON.parse(fs.readFileSync(path.join(runtimeDir,LOCK),'utf8'));
    if(!owner||!isAlive(owner.pid)||!owner.processIdentity||owner.processIdentity!==identityFor(owner.pid))return null;
    return owner;
  } catch { return null; }
}

export function acquireRuntimeLock(runtimeDir,pid=process.pid,options={}){
  const isAlive=options.pidAlive||pidAlive, identityFor=options.processIdentity||processStartIdentity;
  const cleanupTimeoutMs=Number.isFinite(options.cleanupTimeoutMs)?options.cleanupTimeoutMs:3000;
  const currentIdentity=identityFor(pid);if(!currentIdentity)throw new Error('reception_v2_process_identity_required');
  fs.mkdirSync(runtimeDir,{recursive:true,mode:0o700});const file=path.join(runtimeDir,LOCK),cleanup=file+'.cleanup';
  const nonce=crypto.randomUUID();let acquired=false,blockedSince=null;
  for(let attempt=0;attempt<200;attempt++){
    try{fs.writeFileSync(file,JSON.stringify({pid,startedAt:new Date().toISOString(),processIdentity:currentIdentity,nonce}),{encoding:'utf8',mode:0o600,flag:'wx'});acquired=true;break;}
    catch(error){if(error.code!=='EEXIST')throw error;}
    let existing;try{existing=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error('reception_v2_lock_unreadable');}
    if(existing&&isAlive(existing.pid)&&existing.processIdentity&&existing.processIdentity===identityFor(existing.pid))throw new Error('reception_v2_already_running');
    try{fs.mkdirSync(cleanup,{mode:0o700});}catch(error){
      if(error.code!=='EEXIST')throw error;
      blockedSince??=Date.now();
      try{if(Date.now()-fs.statSync(cleanup).mtimeMs>5000)fs.rmdirSync(cleanup);}catch{}
      if(Date.now()-blockedSince>=cleanupTimeoutMs)throw new Error('reception_v2_lock_cleanup_stuck');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);continue;
    }
    try{
      const latest=JSON.parse(fs.readFileSync(file,'utf8'));
      if(latest&&isAlive(latest.pid)&&latest.processIdentity&&latest.processIdentity===identityFor(latest.pid))throw new Error('reception_v2_already_running');
      fs.unlinkSync(file);
    }finally{try{fs.rmdirSync(cleanup);}catch{}}
  }
  if(!acquired)throw new Error('reception_v2_lock_not_acquired');
  let released=false;return()=>{if(released)return;released=true;try{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.pid===pid&&value.nonce===nonce)fs.unlinkSync(file);}catch{}};
}

export function readHealth(runtimeDir){try{return JSON.parse(fs.readFileSync(path.join(runtimeDir,HEALTH),'utf8'));}catch{return null;}}
export function markHealthStopped(runtimeDir){const current=readHealth(runtimeDir);if(!current)return null;const now=new Date().toISOString();
  const stopped={...current,running:false,send_state:'stopped',recorded_at_utc:now};atomicJson(path.join(runtimeDir,HEALTH),stopped);return stopped;}

export function createRuntime({runtimeDir,accountId,armed=false,pilotOne=false,deps,initialRelease=null}){
  if(!runtimeDir||!accountId||!deps)throw new Error('runtime_configuration_required');
  if(pilotOne&&!armed)throw new Error('pilot_requires_armed_runtime');
  let release=initialRelease,browser=null,timer=null,startedAt=null,lastError=null,currentTick=null,lastSweep=null;
  const healthPath=path.join(runtimeDir,HEALTH);
  function writeHealth({successfulRead=false,candidates=null,activeUid=null,sendState='idle',error=null}={}){
    const previous=readHealth(runtimeDir);const now=new Date().toISOString();
    const record={version:1,account_id:accountId,armed,running:Boolean(release),started_at_utc:startedAt,
      last_tick_at_utc:now,last_successful_sidebar_read_at:successfulRead?now:(previous?.last_successful_sidebar_read_at||null),
      candidates,active_uid:activeUid,send_state:sendState,error:error?String(error).replace(/[^A-Za-z0-9_:-]/g,'_').slice(0,120):null,recorded_at_utc:now};
    atomicJson(healthPath,record);return record;
  }
  async function poll(){return armed&&deps.orchestrator?deps.orchestrator.pollOnce():deps.readSidebar();}
  async function ensureBrowser(){if(!browser)browser=await deps.launchBrowser();return browser;}
  async function recoverBrowser(){try{await deps.closeBrowserTransport?.();}catch{}browser=null;return ensureBrowser();}
  async function runTick(){
    if(!release)throw new Error('runtime_not_running');
    try{
      if(browser?.isTransportHealthy?.()===false)await recoverBrowser();else await ensureBrowser();let result;
      try{result=await poll();}
      catch(error){if(isNavigationRecoveryError(error)&&typeof deps.recoverBrowserNavigation==='function'){await deps.recoverBrowserNavigation();result=await poll();}else if(isFatalBrowserError(error)){await recoverBrowser();result=await poll();}else throw error;}
      if(armed&&deps.orchestrator){lastError=result?.failed?.length?result.failed[0].error:null;const health=writeHealth({successfulRead:result?.successfulRead===true,candidates:result?.processed??null,activeUid:result?.result?.uid||null,sendState:result?.failed?.length?'row_failed':'idle',error:lastError});await deps.afterTick?.();return health;}
      lastError=null;return writeHealth({successfulRead:true,candidates:result.rows?.length??0,sendState:'read_only'});
    }catch(error){lastError=error.message;return writeHealth({sendState:isFatalBrowserError(error)?'browser_recovery_failed':'idle',error:error.message});}
  }
  function tick(){if(currentTick)return currentTick;currentTick=runTick().finally(()=>{currentTick=null;});return currentTick;}
  async function start(){
    if(browser)return status();
    if(!release)release=acquireRuntimeLock(runtimeDir);startedAt=new Date().toISOString();
    try{
      browser=await deps.launchBrowser();if(!armed){try{const sidebar=await deps.readSidebar();writeHealth({successfulRead:true,candidates:sidebar.rows?.length??0,sendState:'read_only'});}catch(error){lastError=error.message;writeHealth({error:error.message,sendState:'read_only'});}}else if(deps.orchestrator){lastSweep=await deps.orchestrator.sweepVisibleOverdue(pilotOne?{maxRows:1,contactScan:false,processToday:true}:{processToday:true});writeHealth({successfulRead:lastSweep?.successfulRead===true,candidates:lastSweep?.processed??0,activeUid:lastSweep?.results?.[0]?.uid||null,sendState:'armed',error:lastSweep?.failed?.[0]?.error||null});if(pilotOne){await stop();return status();}}
      timer=setInterval(()=>{void tick().catch(()=>{});},POLL_INTERVAL_MS);timer.unref?.();return status();
    }catch(error){lastError=error.message;await deps.closeBrowser?.();release?.();release=null;writeHealth({error:error.message});throw error;}
  }
  async function stop(){if(timer){clearInterval(timer);timer=null;}if(currentTick){try{await currentTick;}catch{}}try{await deps.closeBrowser?.();}finally{release?.();release=null;writeHealth({sendState:'stopped'});}}
  function status(){return{...readHealth(runtimeDir),accountId,armed,pilotOne,running:Boolean(release),last_error:lastError,last_sweep:lastSweep};}
  return{start,tick,stop,status};
}

export function doctor({runtimeDir,nodeVersion=process.versions.node,playwrightConfigured=Boolean(process.env.XHS_PLAYWRIGHT_MODULE),requireBrowser=true}={}){
  const checks=[{name:'node',ok:Number(nodeVersion.split('.')[0])>=24,value:nodeVersion},{name:'runtime_dir',ok:fs.existsSync(runtimeDir),value:runtimeDir},...(requireBrowser?[{name:'playwright',ok:playwrightConfigured,value:playwrightConfigured?'configured':'missing'}]:[])];
  return{ok:checks.every(x=>x.ok),checks,sends_enabled:false};
}
