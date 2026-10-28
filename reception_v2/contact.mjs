const phonePattern = /(?<!\d)(1[3-9]\d(?:[\s-]?\d){8})(?!\d)/;
const maskedPattern = /[*＊]/;
const contactAddedPattern = /(?:^|[\s,，。.!！])(?:我)?(?:已经|已|刚)?(?:加(?:了|上|入)?|添加(?:了)?)(?:企微|企业微信)?(?:了)?(?:[\s,，。.!！]|$)/;

function cleanPhone(value) { return value.replace(/[\s-]/g, ''); }
function addContact(target, seen, accountId, conversationId, kind, value, source, verified = true) {
  if (!value) return;
  const key = kind + ':' + value;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({ accountId, conversationId, kind, value, source, verified });
}

export function extractContacts(expected, observation) {
  const activeKey=observation?.activeKey || '';
  if(/^Active-[a-f0-9]{24}$/.test(activeKey))throw new Error('contact_active_uid_mismatch');
  const activeMatch = /^Total-([a-f0-9]{24})$/.exec(activeKey);
  if (!activeMatch) return [];
  if (activeMatch[1] !== expected.conversationId) throw new Error('contact_active_uid_mismatch');
  if (!observation.profileUid) return [];
  if (observation.profileUid !== expected.conversationId) throw new Error('contact_profile_uid_mismatch');
  const result = [], seen = new Set();
  for (const field of observation?.profileFields || []) {
    if (field.visible === false || maskedPattern.test(field.value || '')) continue;
    const value = String(field.value || '').trim();
    if (field.label === '手机号码' && phonePattern.test(value)) addContact(result, seen, expected.accountId, expected.conversationId, 'phone', cleanPhone(value.match(phonePattern)[1]), 'profile');
    if (['微信号', '微信账号'].includes(field.label) && /^[A-Za-z][-_A-Za-z0-9]{5,31}$/.test(value)) addContact(result, seen, expected.accountId, expected.conversationId, 'wechat', value, 'profile');
    if (field.label === '名片' && /企业微信/.test(value) && /已添加企微/.test(value)) addContact(result, seen, expected.accountId, expected.conversationId, 'wecom_added', '已添加企微', 'profile');
    if (field.label === '留资卡' && /已提交/.test(value)) addContact(result, seen, expected.accountId, expected.conversationId, 'lead_submitted', '已提交留资卡', 'profile');
  }
  for (const message of observation?.customerMessages || []) {
    if (message.isCustomerText !== true || message.visible === false) continue;
    const text = String(message.text || message.value || '');
    if (contactAddedPattern.test(text)) addContact(result, seen, expected.accountId, expected.conversationId, 'wecom_added', '客户说已添加企微', 'customer_message');
    const phone = text.match(phonePattern);
    if (phone) addContact(result, seen, expected.accountId, expected.conversationId, 'phone', cleanPhone(phone[1]), 'customer_message',
      /(?:手机号|电话)(?:是|为|:|：)?\s*1[3-9]\d/.test(text));
    const wechat = text.match(/(?:微信号?|vx|wechat)\s*(?::|：|是|为)\s*([A-Za-z][-_A-Za-z0-9]{5,31})/i);
    if (wechat) addContact(result, seen, expected.accountId, expected.conversationId, 'wechat', wechat[1], 'customer_message');
    else {
      const candidate = text.trim().match(/(?:^|\s)([A-Za-z][-_A-Za-z0-9]{5,31})(?=$|\s)/);
      if (candidate && (/\d{4}/.test(candidate[1]) || candidate[1].includes('_')))
        addContact(result, seen, expected.accountId, expected.conversationId, 'wechat_candidate', candidate[1], 'customer_message', false);
    }
  }
  return result;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
    const text = el => String(el?.innerText || '').trim();
    const active = Array.from(document.querySelectorAll('.sx-contact-item.active')).filter(rendered);
    const root = active.length === 1 ? active[0].closest('#walle-ad') : null;
    const headers = root ? Array.from(root.querySelectorAll('.user-id-row .id-group')).filter(rendered) : [];
    return { activeKey: active.length === 1 ? active[0].getAttribute('data-key') : null,
      profileUid: headers.length === 1 ? text(headers[0].querySelector('.ellipsis')) : null,
      profileFields: root ? Array.from(root.querySelectorAll('.information-source-wrap .info-item, .customer-info-wrap .info-item')).filter(rendered).map(item => {
        const input=item.querySelector('.info-item-value-wrap input');
        const value=input ? String(input.value||input.getAttribute('placeholder')||'').trim() : text(item.querySelector('.info-item-value-wrap'));
        return { label: text(item.querySelector('.info-item-title')), value, visible: true, masked: /[*＊]/.test(value) };
      }) : [], customerMessages: [] };
  });
}

export async function openCustomerProfile(page, scope) {
  const result = await page.evaluate(({ conversationId }) => {
    const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
    const text = el => String(el?.innerText || '').trim();
    const active = Array.from(document.querySelectorAll('.sx-contact-item.active')).filter(rendered);
      if (active.length !== 1 || active[0].getAttribute('data-key') !== 'Total-' + conversationId)
      return { opened: 0, reason: 'contact_active_uid_mismatch' };
    const root = active[0].closest('#walle-ad');
    const tabs = Array.from(root.querySelectorAll('.chat-tool-wrap .tabs-wrap .d-tabs-header')).filter(rendered).filter(tab => text(tab) === '客资标注');
    if (tabs.length !== 1) return { opened: 0, reason: 'unique_native_customer_profile_tab_required' };
    tabs[0].click();
    return { opened: 1, label: '客资标注' };
  }, { mode: 'open-profile', conversationId: scope.conversationId });
  if (result.opened !== 1) throw new Error(result.reason || 'contact_profile_open_failed');
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(120);
  else await new Promise(resolve => setTimeout(resolve, 120));
}

export async function readContacts(page, scope) {
  await openCustomerProfile(page, scope);
  const observed = await snapshot(page);
  return extractContacts(scope, { ...observed, customerMessages: scope.messages || [] });
}

export async function revealMaskedContacts(page, scope) {
  await openCustomerProfile(page, scope);
  const initial = await snapshot(page);
  const masked = (initial.profileFields || []).filter(field => field.visible !== false && (field.masked || maskedPattern.test(field.value || '')));
  for (const field of masked) {
    const result = await page.evaluate(({ label, conversationId }) => {
      const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
      const text = el => String(el?.innerText || '').trim();
      const active = Array.from(document.querySelectorAll('.sx-contact-item.active')).filter(rendered);
      if (active.length !== 1 || active[0].getAttribute('data-key') !== 'Total-' + conversationId) return { clicked: 0, reason: 'contact_active_uid_mismatch' };
      const root = active[0].closest('#walle-ad');
      const items = Array.from(root.querySelectorAll('.information-source-wrap .info-item, .customer-info-wrap .info-item')).filter(rendered)
        .filter(item => text(item.querySelector('.info-item-title')) === label);
      if (items.length !== 1) return { clicked: 0 };
      const buttons = [item => item.querySelectorAll('button'), item => item.querySelectorAll('[role="button"]'),
        item => item.querySelectorAll('.d-input-suffix .d-icon'), item => item.querySelectorAll('.d-input-suffix svg')]
        .flatMap(read => Array.from(read(items[0]))).filter(rendered);
      const unique = Array.from(new Set(buttons)).filter(el => !buttons.some(other => other !== el && other.contains(el)));
      if (unique.length !== 1) return { clicked: 0 };
      unique[0].click();
      return { clicked: 1, label };
    }, { mode: 'click', label: field.label, conversationId: scope.conversationId });
    if (result.clicked !== 1) throw new Error('contact_reveal_control_not_unique');
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(100);
    else await new Promise(resolve => setTimeout(resolve, 100));
  }
  return extractContacts(scope, { ...(await snapshot(page)), customerMessages: scope.messages || [] });
}

export function redactContactLogs(value) {
  return String(value)
    .replace(/(1[3-9]\d)[\s-]?\d{4}[\s-]?(\d{4})/g, '$1****$2')
    .replace(/((?:微信号?|vx|wechat)\s*[:：是为]?\s*)[-_A-Za-z0-9]{6,32}/ig, '$1***');
}
