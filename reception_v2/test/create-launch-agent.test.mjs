import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunchAgent } from '../create-launch-agent.mjs';

test('launch agent uses the selected account config and isolated runtime',()=>{
  const plist=buildLaunchAgent({
    root:'/tmp/reception root',
    nodeBin:'/opt/node/bin/node',
    mainScript:'/tmp/reception root/reception_v2/main.mjs',
    configPath:'/tmp/reception root/reception_v2/config/account.local.json',
    label:'com.chatcut.reception-v2.bbbbbb',
    runtimeDir:'/tmp/reception root/.runtime-b',
    playwrightModule:'/opt/playwright/index.js',
  });
  assert.match(plist,/<string>com\.chatcut\.reception-v2\.bbbbbb<\/string>/);
  assert.match(plist,/<string>\/tmp\/reception root\/reception_v2\/main\.mjs<\/string>/);
  assert.match(plist,/<key>XHS_ACCOUNT_CONFIG<\/key>\s*<string>\/tmp\/reception root\/reception_v2\/config\/account\.local\.json<\/string>/);
  assert.match(plist,/<key>XHS_PLAYWRIGHT_MODULE<\/key>\s*<string>\/opt\/playwright\/index\.js<\/string>/);
  assert.match(plist,/<string>run<\/string>\s*<string>--arm<\/string>/);
  assert.doesNotMatch(plist,/66879fef000000001c002839/);
});

test('launch agent rejects unsafe labels',()=>{
  assert.throws(()=>buildLaunchAgent({root:'/tmp',nodeBin:'/node',mainScript:'/main',configPath:'/config',label:'bad label',runtimeDir:'/runtime',playwrightModule:'/pw'}),/invalid_launch_agent_label/);
});
