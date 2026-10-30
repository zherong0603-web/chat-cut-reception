import path from 'node:path';
import { loadAccountConfig } from '../account-config.mjs';
import { openBrowser } from '../browser.mjs';
import { readSidebar } from '../sidebar.mjs';
import { readConversation } from '../scope.mjs';
const readOnly = process.argv.includes('--read-only');
if (!readOnly) throw new Error('live_smoke_is_read_only_only');
const configured = loadAccountConfig({ cwd: process.cwd(), env: process.env });
const expected = { id: configured.accountId, name: configured.accountName };
const runtime = configured.runtimeDir;
const browser = await openBrowser({ profileDir: path.join(runtime, 'isolated-browser-profile'), headless: false, accountId: expected.id, accountName: expected.name, card: configured.card });
try {
  const sidebar = await readSidebar(browser.page, expected);
  const row=sidebar.rows.find(value=>value.needsReply===true)||sidebar.rows[0];
  let scope=null;
  if(row){
    await browser.selectConversation({accountId:expected.id,conversationId:row.uid});
    scope=await readConversation(browser.page,{accountId:expected.id,accountName:expected.name},row.uid);
  }
  console.log(JSON.stringify({ ok: true, accountId: expected.id, visibleRows: sidebar.rows.length, selectedUid: row?.uid||null, customerMessages: scope?.messages.filter(message=>message.isCustomerText).length||0, sendsPerformed: 0 }));
} finally { await browser.close(); }
