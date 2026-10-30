import path from 'node:path';
import { loadAccountConfig } from '../account-config.mjs';
import { activeConversationRootLocator, openBrowser, prepareWeComCardPanel } from '../browser.mjs';
import { readSidebar } from '../sidebar.mjs';

const configured = loadAccountConfig({ cwd: process.cwd(), env: process.env });
const account = { id: configured.accountId, name: configured.accountName };
const browser = await openBrowser({
  profileDir: path.join(configured.runtimeDir, 'isolated-browser-profile'),
  headless: true,
  accountId: account.id,
  accountName: account.name,
  card: configured.card,
});
try {
  const sidebar = await readSidebar(browser.page, account);
  let result = null;
  for (const row of sidebar.rows) {
    const mode = await browser.selectConversation({ accountId: account.id, conversationId: row.uid });
    if (!mode.manual) continue;
    const root = activeConversationRootLocator(browser.page, { accountId: account.id, conversationId: row.uid });
    if (await root.count() !== 1) continue;
    await prepareWeComCardPanel(root, configured.card);
    const title = root.locator('.chat-tool-wrap .card-box__content-title[title="' + configured.card.title + '"]').filter({ visible: true });
    const card = title.locator('..').locator('..');
    await card.hover({ timeout: 1000 });
    const send = card.getByRole('button', { name: '发送', exact: true });
    result = {
      title_count: await title.count(),
      card_count: await card.count(),
      send_control_count: await send.count(),
      send_control_enabled: await send.count() === 1 ? await send.isEnabled() : false,
    };
    break;
  }
  const ok = Boolean(result && result.title_count === 1 && result.card_count === 1 && result.send_control_count === 1 && result.send_control_enabled);
  console.log(JSON.stringify({ ok, visible_rows: sidebar.rows.length, result, card_send_clicks: 0, sends_performed: 0 }));
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
}
