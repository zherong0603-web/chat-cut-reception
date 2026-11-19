import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadAccountConfig } from './account-config.mjs';
import { openInteractiveLogin } from './browser.mjs';
import { acquireRuntimeLock, readHealth, readLockOwner } from './runtime.mjs';

export async function reloginReception({account, service, login = openInteractiveLogin, signal}) {
  const wasLoaded = await service.isLoaded();
  let result;
  try {
    if (wasLoaded) await service.stop();
    await service.waitForStopped();
    result = await login({profileDir: path.join(account.runtimeDir, 'isolated-browser-profile'), accountName: account.accountName, visible: true, signal});
  } finally {
    if (wasLoaded) await service.start();
  }
  const verified = wasLoaded ? await service.verify() : {healthy: false};
  return {loginSucceeded: true, accountTitle: result.accountTitle, serviceResumed: wasLoaded, ...verified};
}

export function healthyReceptionPair(first, second, accountId, resumedAtMs) {
  const healthy = value => value?.running === true && value.error === null && value.account_id === accountId
    && Date.parse(value.last_successful_sidebar_read_at) >= resumedAtMs && Date.parse(value.last_tick_at_utc) >= resumedAtMs;
  return healthy(first) && healthy(second)
    && Date.parse(second.last_successful_sidebar_read_at) > Date.parse(first.last_successful_sidebar_read_at)
    && Date.parse(second.last_tick_at_utc) > Date.parse(first.last_tick_at_utc);
}

export function registerLoginCancellation(controller, target = process) {
  const cancel = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) target.on(signal, cancel);
  return () => { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) target.off(signal, cancel); };
}

function command(binary, args, required = true) {
  const result = spawnSync(binary, args, {encoding: 'utf8'});
  if (required && result.status !== 0) throw new Error(`command_failed:${path.basename(binary)}:${String(result.stderr || result.error?.message || '').trim().slice(0, 200)}`);
  return result;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(root);
  const plistFile = process.env.XHS_RECEPTION_PLIST || path.join(os.homedir(), 'Library/LaunchAgents/com.chatcut.reception-v2.plist');
  const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistFile]).stdout);
  if (plist.Label !== 'com.chatcut.reception-v2' || path.resolve(plist.WorkingDirectory || '') !== root
    || path.resolve(plist.ProgramArguments?.[1] || '') !== path.join(root, 'reception_v2/main.mjs')
    || !plist.ProgramArguments.includes('run') || !plist.ProgramArguments.includes('--arm')) throw new Error('unexpected_reception_launch_agent');
  for (const [key, value] of Object.entries(plist.EnvironmentVariables || {})) if (key.startsWith('XHS_')) process.env[key] = String(value);
  const account = loadAccountConfig();
  const serviceName = `gui/${process.getuid()}/${plist.Label}`, domain = `gui/${process.getuid()}`;
  const isLoaded = () => command('/bin/launchctl', ['print', serviceName], false).status === 0;
  if (!process.argv.includes('--run')) {
    console.log(JSON.stringify({checkOnly: true, accountName: account.accountName, serviceLoaded: isLoaded(), profileDir: path.join(account.runtimeDir, 'isolated-browser-profile')}, null, 2));
    return;
  }
  if (!process.env.XHS_PLAYWRIGHT_MODULE || !fs.existsSync(process.env.XHS_PLAYWRIGHT_MODULE)) throw new Error('playwright_module_required');
  let release = null, resumedAtMs = null;
  const controller = new AbortController();
  const disposeCancellation = registerLoginCancellation(controller);
  const service = {
    isLoaded,
    stop: async () => { command('/bin/launchctl', ['bootout', serviceName]); },
    waitForStopped: async () => {
      const deadline = Date.now() + 10_000;
      while (readLockOwner(account.runtimeDir)) {
        if (Date.now() >= deadline) throw new Error('profile_still_in_use');
        await sleep(200);
      }
      release = acquireRuntimeLock(account.runtimeDir);
    },
    start: async () => {
      release?.(); release = null; resumedAtMs = Date.now();
      if (!isLoaded()) command('/bin/launchctl', ['bootstrap', domain, plistFile]);
    },
    verify: async () => {
      const deadline = Date.now() + 60_000;
      let previous = null;
      while (Date.now() < deadline) {
        const health = readHealth(account.runtimeDir);
        if (readLockOwner(account.runtimeDir) && healthyReceptionPair(previous, health, account.accountId, resumedAtMs)) return {healthy: true, health};
        previous = health;
        await sleep(5000);
      }
      return {healthy: false, error: readHealth(account.runtimeDir)?.error || 'successful_message_reads_not_verified'};
    },
  };
  console.log(`请在即将打开的专用浏览器中，扫码或用手机号登录“${account.accountName}”。请保留此窗口，完成后会自动检查接待。`);
  try {
    const result = await reloginReception({account, service, signal: controller.signal});
    if (result.healthy) console.log('重新登录成功，已确认接待程序连续读取消息。仍按原定 19:00 至 24:00 回复。');
    else if (!result.serviceResumed) console.log('登录已保存。原接待服务未启用，已保留原来的停止状态。');
    else { console.error('登录已保存，接待程序已恢复启动，但尚未验证连续读取成功。请把此结果告诉 Codex。'); process.exitCode = 2; }
  } finally {
    release?.(); disposeCancellation();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`重新登录未完成：${error.message}`); process.exitCode = 1; });
}
