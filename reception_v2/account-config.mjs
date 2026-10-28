import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_ACCOUNT_ID = '66879fef000000001c002839';
const LEGACY_ACCOUNT_NAME = '运去哪海外仓';
export const DEFAULT_CARD = Object.freeze({
  title: '企微_运去哪海外仓（企微）',
  visibleName: '运去哪海外仓（企微）',
  id: '2779776',
  csaAccountNo: '8694696952',
  corpName: '@运去哪物流科技集团',
});
export const DEFAULT_RUNTIME_DIR = '.runtime';
export const DEFAULT_BUSINESS_FACTS = 'reception_v2/config/business-facts.json';
export const LOCAL_ACCOUNT_CONFIG = 'reception_v2/config/account.local.json';

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`invalid_${field}`);
  return text;
}

function validateAccountId(value) {
  const accountId = requiredText(value, 'account_id').toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(accountId)) throw new Error('invalid_account_id');
  return accountId;
}

function normalizeCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_card_config');
  return Object.freeze({
    title: requiredText(value.title ?? value.cardTitle, 'card_title'),
    visibleName: requiredText(value.visibleName ?? value.cardVisibleName, 'card_visible_name'),
    id: requiredText(value.id ?? value.cardId, 'card_id'),
    csaAccountNo: requiredText(value.csaAccountNo ?? value.cardCsaAccountNo, 'card_csa_account_no'),
    corpName: requiredText(value.corpName ?? value.cardCorpName, 'card_corp_name'),
  });
}

function resolveFrom(cwd, value) {
  return path.resolve(cwd, String(value));
}

export function loadAccountConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const root = path.resolve(cwd);
  const defaultConfigPath = path.join(root, LOCAL_ACCOUNT_CONFIG);
  const explicitConfigPath = String(env.XHS_ACCOUNT_CONFIG || '').trim();
  const configPath = explicitConfigPath ? resolveFrom(root, explicitConfigPath) : defaultConfigPath;
  const found = fs.existsSync(configPath);
  if (explicitConfigPath && !found) throw new Error('account_config_not_found');
  let fileConfig = {};
  if (found) {
    try { fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (error) { throw new Error(`invalid_account_config_json:${error?.message || 'parse_error'}`); }
    if (!fileConfig || typeof fileConfig !== 'object' || Array.isArray(fileConfig)) throw new Error('invalid_account_config');
  }

  const fileAccountId = fileConfig.accountId == null ? null : validateAccountId(fileConfig.accountId);
  const requestedAccountId = env.XHS_ACCOUNT_ID == null ? (fileAccountId || DEFAULT_ACCOUNT_ID) : validateAccountId(env.XHS_ACCOUNT_ID);
  if (fileAccountId && requestedAccountId !== fileAccountId) throw new Error('account_id_override_conflicts_with_card');
  if (!fileAccountId && requestedAccountId !== DEFAULT_ACCOUNT_ID) throw new Error('card_config_required');

  const accountName = requiredText(env.XHS_ACCOUNT_NAME ?? fileConfig.accountName ?? LEGACY_ACCOUNT_NAME, 'account_name');
  const runtimeDir = resolveFrom(root, env.XHS_RUNTIME_DIR ?? fileConfig.runtimeDir ?? DEFAULT_RUNTIME_DIR);
  const cardValue = fileConfig.card ?? (fileConfig.cardTitle ? {
    title: fileConfig.cardTitle,
    visibleName: fileConfig.cardVisibleName,
    id: fileConfig.cardId,
    csaAccountNo: fileConfig.cardCsaAccountNo,
    corpName: fileConfig.cardCorpName,
  } : null);
  if (cardValue == null && requestedAccountId !== DEFAULT_ACCOUNT_ID) throw new Error('card_config_required');
  const card = cardValue == null ? DEFAULT_CARD : normalizeCard(cardValue);
  const businessFactsPath = resolveFrom(root, env.XHS_BUSINESS_FACTS ?? fileConfig.businessFacts ?? DEFAULT_BUSINESS_FACTS);

  return Object.freeze({
    accountId: requestedAccountId,
    accountName,
    runtimeDir,
    card,
    businessFactsPath,
    configPath: found ? configPath : null,
    source: found ? 'file' : 'default',
  });
}
