#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadAccountConfig } from './account-config.mjs';
import { openBrowser, openInteractiveLogin } from './browser.mjs';
import { openDatabase } from './db.mjs';
import { importLegacyUnknowns } from './legacy-blocklist.mjs';
import { createSender } from './sender.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { composeReply, validateFacts } from './responder.mjs';
import { createReplySchedule } from './reply-schedule.mjs';
import { readSidebar } from './sidebar.mjs';
import { readConversation } from './scope.mjs';
import { readContacts, revealMaskedContacts } from './contact.mjs';
import { createNotifierStore } from './notifier-store.mjs';
import { acquireRuntimeLock, createRuntime, doctor, markHealthStopped, processStartIdentity, readHealth, readLockOwner } from './runtime.mjs';

function startNotifier() {
  const binary=path.join(runtime,'reception-v2-notifier'),pidPath=path.join(runtime,'reception-v2-notifier.pid');
  if(!fs.existsSync(binary)) throw new Error('notifier_build_required');
  if(fs.existsSync(pidPath)){let existing=null;try{existing=JSON.parse(fs.readFileSync(pidPath,'utf8'));}catch{}
    if(existing?.pid&&existing.processIdentity===processStartIdentity(existing.pid))return existing.pid;
    try{fs.unlinkSync(pidPath);}catch{}}
  const log=fs.openSync(path.join(runtime,'reception-v2-notifier.log'),'a',0o600);
  const child=spawn(binary,['--runtime',runtime],{detached:true,stdio:['ignore',log,log]});
  child.unref();const identity=processStartIdentity(child.pid);if(!identity){try{child.kill('SIGTERM');}catch{}fs.closeSync(log);throw new Error('notifier_process_identity_required');}
  fs.writeFileSync(pidPath,JSON.stringify({pid:child.pid,processIdentity:identity,startedAt:new Date().toISOString()})+'\n',{encoding:'utf8',mode:0o600});fs.closeSync(log);return child.pid;
}

function readNotifierOwner() {
  try{const value=JSON.parse(fs.readFileSync(path.join(runtime,'reception-v2-notifier.pid'),'utf8'));
    return value?.processIdentity===processStartIdentity(value.pid)?value:null;}catch{return null;}
}

async function stopOwnedProcess(owner, timeoutMs=5000) {
  if(!owner)return false;
  try{process.kill(owner.pid,'SIGTERM');}catch{return false;}
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){if(processStartIdentity(owner.pid)!==owner.processIdentity)return true;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error('stop_not_confirmed');
}

async function stopNotifier() {
  const owner=readNotifierOwner();if(owner)await stopOwnedProcess(owner);
  try{fs.unlinkSync(path.join(runtime,'reception-v2-notifier.pid'));}catch{}
}

const account=loadAccountConfig({cwd:process.cwd(),env:process.env});
const replySchedule=createReplySchedule();
const runtime=account.runtimeDir,ACCOUNT_ID=account.accountId,ACCOUNT_NAME=account.accountName;
const args=process.argv.slice(2),command=args[0]||'status';
function valueAfter(flag,fallback=null){const index=args.indexOf(flag);return index>=0&&args[index+1]?args[index+1]:fallback;}
function facts(){const file=account.businessFactsPath;const value=JSON.parse(fs.readFileSync(file,'utf8'));return validateFacts({...value,account_name:ACCOUNT_NAME});}
function safeRuntimeStatus(status){const sweep=status?.last_sweep;const {last_sweep,...base}=status||{};return{...base,last_sweep:sweep?{processed:sweep.processed??null,successfulRead:sweep.successfulRead===true,
  failed:(sweep.failed||[]).map(item=>({uid:item.uid||null,error:String(item.error||'').slice(0,120)})),
  results:(sweep.results||[]).map(item=>({uid:item.uid||null,state:item.state||null,reason:item.reason||null,text_state:item.text?.state||null,card_state:item.card?.state||null})),
  takeover:sweep.takeover?{processed:sweep.takeover.processed??0,failed:(sweep.takeover.failed||[]).map(item=>({uid:item.uid||null,error:String(item.error||'').slice(0,120)}))}:null}:null};}
function assertLegacyReceptionStopped(){const result=spawnSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'});if(result.status!==0)throw new Error('legacy_process_scan_failed');
  const lines=String(result.stdout||'').split('\n').filter(Boolean).filter(line=>line!==`${process.pid} ${process.argv.join(' ')}`&&
    /(?:python[^ ]*.*-m\s+xhs_reception|xhs_reception\/browser_session\.cjs.*--start-reception-worker)/.test(line));
  if(lines.length)throw new Error('legacy_reception_running');}

if(command==='login'){
  const profileDir=path.join(runtime,'isolated-browser-profile');
  console.log(JSON.stringify({action:'login_required',accountName:ACCOUNT_NAME,profileDir,message:'请在打开的隔离浏览器中登录指定账号；标题出现后命令会自动退出，不会开启接待或发送消息。'},null,2));
  const result=await openInteractiveLogin({profileDir,accountName:ACCOUNT_NAME});
  console.log(JSON.stringify({ok:true,accountId:ACCOUNT_ID,accountTitle:result.accountTitle,profileDir,sendsPerformed:0},null,2));
}else if(command==='account'){
  console.log(JSON.stringify({accountId:account.accountId,accountName:account.accountName,runtimeDir:account.runtimeDir,card:account.card,businessFactsPath:account.businessFactsPath,configPath:account.configPath,source:account.source},null,2));
}else if(command==='doctor'){
  const result=doctor({runtimeDir:runtime,requireBrowser:!args.includes('--no-browser')});console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:2;
}else if(command==='status'){
  const health=readHealth(runtime)||{running:false,account_id:ACCOUNT_ID};const owner=readLockOwner(runtime);
  console.log(JSON.stringify({...health,running:Boolean(owner),pid:owner?.pid||null,send_state:owner?health.send_state:'stopped',stale_health:Boolean(health.running&&!owner)},null,2));
}else if(command==='stop'){
  try{const owner=readLockOwner(runtime);const lockPath=path.join(runtime,'reception-v2.lock');if(owner){await stopOwnedProcess(owner);if(fs.existsSync(lockPath))throw new Error('stop_not_confirmed');}
    else if(fs.existsSync(lockPath)){try{fs.unlinkSync(lockPath);}catch(error){if(error?.code!=='ENOENT')throw error;}}
    await stopNotifier();markHealthStopped(runtime);console.log(JSON.stringify({ok:true,stopped_pid:owner?.pid||null,already_stopped:!owner}));
  }catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=2;}
}else if(command==='run'){
  const armed=args.includes('--arm');const profileDir=path.join(runtime,'isolated-browser-profile');const dbPath=path.join(runtime,'reception-v2.sqlite3');
  assertLegacyReceptionStopped();
  let lockRelease=null,store=null;try{lockRelease=acquireRuntimeLock(runtime);store=openDatabase(dbPath);importLegacyUnknowns(store,path.join(runtime,'reception.sqlite3'));}catch(error){lockRelease?.();throw error;}
  const notifier=createNotifierStore(runtime);const lifecycle={stopping:false};let browser=null;
  const closeBrowserTransport=async()=>{if(browser){const current=browser;browser=null;await current.close();}};
  const deps={launchBrowser:async()=>{browser=await openBrowser({profileDir,headless:true,accountId:ACCOUNT_ID,accountName:ACCOUNT_NAME,card:account.card,replySchedule});return browser;},
    closeBrowser:async()=>{await closeBrowserTransport();store.close();},closeBrowserTransport,recoverBrowserNavigation:async()=>browser?.recoverNavigation?.(),
    readSidebar:async options=>readSidebar(browser.page,{id:ACCOUNT_ID,name:ACCOUNT_NAME},options),isStopping:()=>lifecycle.stopping,orchestrator:null};
  let notifierPid=null;
  if(armed){
    try {
      const approvedFacts=facts();
      notifierPid=startNotifier();
      const sender=createSender({store,browser:new Proxy({}, {get(_t,key){return (...args)=>browser[key](...args);}}),card:account.card,replySchedule});
      deps.orchestrator=createOrchestrator({...deps,store,sender,facts:approvedFacts,accountId:ACCOUNT_ID,card:account.card,replySchedule,composeReply,
        selectConversation:async uid=>{await browser.selectConversation({accountId:ACCOUNT_ID,conversationId:uid});return readConversation(browser.page,{accountId:ACCOUNT_ID,accountName:ACCOUNT_NAME},uid);},
        readContacts:async scope=>readContacts(browser.page,scope),revealMaskedContacts:async scope=>revealMaskedContacts(browser.page,scope),notifier,now:Date.now});
    } catch(error) {
      try{if(notifierPid)process.kill(notifierPid,'SIGTERM');}catch{}
      try{store.close();}catch{}
      lockRelease?.();
      throw error;
    }
  }
  deps.afterTick=()=>notifier.flushAcknowledgements();
  const pilotOne=args.includes('--pilot-one');const daemon=createRuntime({runtimeDir:runtime,accountId:ACCOUNT_ID,armed,pilotOne,deps:{...deps,replySchedule},initialRelease:lockRelease});
  const shutdown=async()=>{lifecycle.stopping=true;await daemon.stop();await stopNotifier();process.exit(0);};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  try{await daemon.start();}catch(error){await stopNotifier();throw error;}
  if(pilotOne)await stopNotifier();
  console.log(JSON.stringify(safeRuntimeStatus(daemon.status()),null,2));
}else{throw new Error('unknown_command');}
