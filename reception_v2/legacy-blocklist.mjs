import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { contentHash } from './domain.mjs';

export function importLegacyUnknowns(db, legacyPath) {
  if (!fs.existsSync(legacyPath)) return 0;
  const legacy = new DatabaseSync(legacyPath, { readOnly: true });
  const rows = [];
  try {
    const table = legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox'").get();
    if (!table) return 0;
    for (const row of legacy.prepare("SELECT account_id,conversation_id,payload FROM outbox WHERE status='UNKNOWN'").all()) {
      let payload; try { payload = JSON.parse(row.payload); } catch { continue; }
      const content = typeof payload.text === 'string' ? payload.text : payload.card_name || payload.cardTitle || null;
      if (!content) continue;
      const hashes = new Set([contentHash(content)]);
      if (payload.operation === 'native_card' || typeof payload.card_name === 'string' || typeof payload.cardTitle === 'string')
        hashes.add(contentHash(JSON.stringify({ cardTitle: content })));
      for (const hash of hashes) rows.push({ accountId: row.account_id, conversationId: row.conversation_id, contentHash: hash });
    }
  } finally { legacy.close(); }
  return db.importLegacyUnknowns(rows);
}
