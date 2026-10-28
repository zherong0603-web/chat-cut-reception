import fs from 'node:fs';
import path from 'node:path';
import { loadAccountConfig } from '../account-config.mjs';
import { openBrowser } from '../browser.mjs';
import { readSidebar } from '../sidebar.mjs';
const configured=loadAccountConfig({cwd:process.cwd(),env:process.env});
const account={id:configured.accountId,name:configured.accountName};
const runtime=configured.runtimeDir;
const browser=await openBrowser({profileDir:path.join(runtime,'isolated-browser-profile'),headless:true,accountId:account.id,accountName:account.name,card:configured.card});
try{
 const sidebar=await readSidebar(browser.page,account);
 const baseline={captured_at_utc:new Date().toISOString(),classification:'reception_v2_readonly_baseline',account_id:account.id,sends_performed:0,
   rows:sidebar.rows.map(row=>({uid:row.uid,nickname:row.nickname,status:row.statusText,needs_reply:row.needsReply,preview_length:row.preview.length}))};
 const target=path.join(runtime,'reception-v2-baseline.json');const temp=target+'.'+process.pid+'.tmp';
 fs.writeFileSync(temp,JSON.stringify(baseline,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});fs.renameSync(temp,target);
 console.log(JSON.stringify({ok:true,rows:baseline.rows.length,sends_performed:0,baseline:target}));
}finally{await browser.close();}
