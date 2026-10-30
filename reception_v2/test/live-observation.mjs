import fs from 'node:fs';
import path from 'node:path';
import { loadAccountConfig } from '../account-config.mjs';
import { activeConversationRootLocator, openBrowser, prepareWeComCardPanel } from '../browser.mjs';
import { readSidebar } from '../sidebar.mjs';
import { readConversation } from '../scope.mjs';
import { revealMaskedContacts } from '../contact.mjs';

const configured = loadAccountConfig({ cwd: process.cwd(), env: process.env });
const account = { id: configured.accountId, name: configured.accountName };
const runtime = configured.runtimeDir;
const browser = await openBrowser({
  profileDir: path.join(runtime, 'isolated-browser-profile'),
  headless: false,
  accountId: account.id,
  accountName: account.name,
  card: configured.card,
});
try {
  const sidebar = await readSidebar(browser.page, account);
  const rows = [];
  const failures = [];
  const contactKinds = {};
  let manual = 0, takeover = 0, customerTextConversations = 0;
  let cardPanel = null;
  const cardPanelFailures=[];
  for (const row of sidebar.rows) {
    try {
      const mode = await browser.selectConversation({ accountId: account.id, conversationId: row.uid });
      if (!mode.manual) continue;
      const root = activeConversationRootLocator(browser.page, { accountId: account.id, conversationId: row.uid });
      if (await root.count() !== 1) continue;
      await prepareWeComCardPanel(root, configured.card);
      const title = root.locator('.chat-tool-wrap .card-box__content-title[title="' + configured.card.title + '"]').filter({ visible: true });
      const card = title.locator('..').locator('..');
      await card.hover({ timeout: 1000 });
      const send = card.getByRole('button', { name: '发送', exact: true });
      cardPanel = {
        title_count: await title.count(), card_count: await card.count(), send_control_count: await send.count(),
        send_control_enabled: await send.count() === 1 ? await send.isEnabled() : false,
      };
      break;
    } catch(error) { cardPanelFailures.push({uid_prefix:row.uid.slice(0,6),error:String(error?.message||error).slice(0,120)}); continue; }
  }
  for (const row of sidebar.rows) {
    try {
      const mode = await browser.selectConversation({ accountId: account.id, conversationId: row.uid });
      if (mode.conversationId !== row.uid) throw new Error('uid_mismatch');
      const scope = await readConversation(browser.page, account, row.uid);
      const contacts = await revealMaskedContacts(browser.page, scope);
      if (mode.manual) manual++;
      if (mode.takeoverVisible) takeover++;
      if (scope.messages.some(message => message.isCustomerText)) customerTextConversations++;
      for (const contact of contacts) contactKinds[contact.kind] = (contactKinds[contact.kind] || 0) + 1;
      rows.push({ uid: row.uid, selected: true, contact_count: contacts.length, contact_kinds: contacts.map(contact => contact.kind) });
    } catch (error) {
      failures.push({ uid_prefix: row.uid.slice(0, 6), error: String(error?.message || error).slice(0, 120) });
    }
  }

  const observation = {
    version: 1,
    recorded_at_utc: new Date().toISOString(),
    classification: 'reception_v2_readonly_live_observation',
    account_id: account.id,
    visible_rows: sidebar.rows.length,
    selected_rows: rows.length,
    manual_mode_rows: manual,
    takeover_button_rows: takeover,
    customer_text_conversations: customerTextConversations,
    contact_kinds: contactKinds,
    rows,
    failures,
    card_panel: cardPanel,
    card_panel_failures: cardPanelFailures,
    card_send_clicks: 0,
    sends_performed: 0,
  };
  const target = path.join(runtime, 'reception-v2-readonly-observation.json');
  const temp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(observation, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, target);
  fs.chmodSync(target, 0o600);
  const ok = failures.length === 0 && rows.length === sidebar.rows.length && cardPanel?.send_control_count === 1;
  console.log(JSON.stringify({ ok, visible_rows: observation.visible_rows, selected_rows: observation.selected_rows, manual_mode_rows: manual,
    takeover_button_rows: takeover, contact_kinds: contactKinds, failures: failures.length, card_panel: cardPanel, card_panel_failures: cardPanelFailures,
    card_send_clicks: 0, sends_performed: 0, evidence: target }));
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
}
