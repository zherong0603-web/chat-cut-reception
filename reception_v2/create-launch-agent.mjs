#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAccountConfig } from './account-config.mjs';

function xml(value) {
  return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
}
function argValue(args, flag, fallback = null) {
  const index=args.indexOf(flag);
  return index>=0 && args[index+1] ? args[index+1] : fallback;
}

export function buildLaunchAgent({ root, nodeBin, mainScript, configPath, label, runtimeDir, playwrightModule }) {
  if (!/^[A-Za-z0-9.-]+$/.test(String(label || ''))) throw new Error('invalid_launch_agent_label');
  for (const [name,value] of Object.entries({root,nodeBin,mainScript,runtimeDir,playwrightModule})) {
    if (!value) throw new Error(`missing_${name}`);
  }
  const environment = [
    ['PATH', `${path.dirname(nodeBin)}:/usr/bin:/bin:/usr/sbin:/sbin`],
    ['XHS_PLAYWRIGHT_MODULE', playwrightModule],
    ...(configPath ? [['XHS_ACCOUNT_CONFIG', configPath]] : []),
  ];
  const envXml=environment.map(([key,value])=>`      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeBin)}</string>
    <string>${xml(mainScript)}</string>
    <string>run</string>
    <string>--arm</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(runtimeDir,'reception-v2-launchd.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(runtimeDir,'reception-v2-launchd.log'))}</string>
</dict>
</plist>
`;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const args=process.argv.slice(2);
  const root=path.resolve(argValue(args,'--root',process.cwd()));
  const account=loadAccountConfig({cwd:root,env:process.env});
  const label=argValue(args,'--label',`com.chatcut.reception-v2.${account.accountId.slice(-6)}`);
  const playwrightModule=process.env.XHS_PLAYWRIGHT_MODULE;
  if (!playwrightModule) throw new Error('playwright_module_required');
  if (!fs.existsSync(playwrightModule)) throw new Error('playwright_module_not_found');
  const plist=buildLaunchAgent({root,nodeBin:process.execPath,mainScript:path.join(root,'reception_v2/main.mjs'),configPath:account.configPath,
    label,runtimeDir:account.runtimeDir,playwrightModule});
  const plistPath=path.join(os.homedir(),'Library','LaunchAgents',label+'.plist');
  if (args.includes('--write')) {
    fs.mkdirSync(path.dirname(plistPath),{recursive:true,mode:0o700});
    fs.mkdirSync(account.runtimeDir,{recursive:true,mode:0o700});
    fs.chmodSync(account.runtimeDir,0o700);
    fs.writeFileSync(plistPath,plist,{encoding:'utf8',mode:0o600});
  }
  console.log(JSON.stringify({ok:true,written:args.includes('--write'),plistPath,label,accountId:account.accountId,runtimeDir:account.runtimeDir,configPath:account.configPath},null,2));
}
