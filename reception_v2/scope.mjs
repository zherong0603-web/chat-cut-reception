const uidPattern = /^[a-f0-9]{24}$/;

function acceptsAccountTitle(title, accountName) {
  if (title === accountName + '-私信通') return true;
  const unread = accountName + '-[您有新消息待回复]';
  return title.length === unread.length && (unread + unread).includes(title);
}

export function validateConversationScope(snapshot, expected) {
  if (!snapshot || snapshot.origin !== 'https://sxt.xiaohongshu.com' || snapshot.pathname !== '/im/multiCustomerService')
    throw new Error('unexpected_scope_route');
  if (!expected.accountName || !acceptsAccountTitle(snapshot.title, expected.accountName)) throw new Error('account_title_mismatch');
  const keyMatch = typeof snapshot.activeKey === 'string' ? /^Total-([a-f0-9]{24})$/.exec(snapshot.activeKey) : null;
  if (!keyMatch || keyMatch[1] !== expected.conversationId) throw new Error('active_uid_mismatch');
  if (snapshot.profileUid !== undefined && snapshot.profileUid !== null && snapshot.profileUid !== expected.conversationId) throw new Error('profile_uid_mismatch');
  if (!snapshot.headerNickname || snapshot.headerNickname !== snapshot.rowNickname) throw new Error('nickname_mismatch');
  if (!Array.isArray(snapshot.messages)) throw new Error('invalid_scope_messages');
  const prefixes = ['jarvis-msg-' + expected.accountId + '.' + expected.conversationId + '.',
    'jarvis-msg-' + expected.conversationId + '.' + expected.accountId + '.'];
  const messages = snapshot.messages.map(message => {
    if (!prefixes.some(prefix => typeof message.nativeId === 'string' && message.nativeId.startsWith(prefix)))
      throw new Error('native_message_scope_mismatch');
    if (!Number.isFinite(message.platformTimeMs) || !['left', 'right', 'center'].includes(message.direction))
      throw new Error('invalid_native_message');
    return { ...message, isCustomerText: message.direction === 'left' && message.type === 'TEXT' && message.ai !== true && message.system !== true,
      isEntryHint: message.direction === 'center' && message.type === 'RICH_HINT' };
  });
  return { accountId: expected.accountId, conversationId: expected.conversationId, nickname: snapshot.rowNickname,
    activeKey: snapshot.activeKey, profileUid: snapshot.profileUid, headerNickname: snapshot.headerNickname,
    messages, profileFields: Array.isArray(snapshot.profileFields) ? snapshot.profileFields : [] };
}

export async function readConversation(page, expected, uid) {
  if (!page || typeof page.evaluate !== 'function') throw new TypeError('existing_page_required');
  let lastError;
  const hydrationDeadline=Date.now()+4000;
  for (let attempt = 0; attempt < 40; attempt++) {
  const snapshot = await page.evaluate(({ accountId, uid }) => {
    const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
    const text = el => String(el?.innerText || '').trim();
    const active = Array.from(document.querySelectorAll('.sx-contact-item.active')).filter(rendered);
    if (active.length !== 1) return { error: 'active_contact_not_unique' };
    const row = active[0], key = row.getAttribute('data-key');
    const headers = Array.from(document.querySelectorAll('.message-header .nick-name')).filter(rendered);
    const uidGroups = Array.from(document.querySelectorAll('.user-id-row .id-group')).filter(rendered).filter(group =>
      Array.from(group.querySelectorAll('.id-label')).some(label => text(label) === 'UID:'));
    let profileUid = null;
    if (uidGroups.length === 1) profileUid = text(uidGroups[0].querySelector('.ellipsis')) || null;
    const prefixes = ['id_' + accountId + '.' + uid + '.', 'id_' + uid + '.' + accountId + '.'];
    const messages = [];
    for (const root of Array.from(document.querySelectorAll('.im-msg-item')).filter(rendered)) {
      const id = root.getAttribute('id') || '';
      const prefix = prefixes.find(value => id.startsWith(value));
      if (!prefix) continue;
      const messageId = id.slice(prefix.length);
      const pair = prefix.slice(3) + messageId;
      const native = Array.from(root.querySelectorAll('[id^="jarvis-msg-"]')).find(el => el.id === 'jarvis-msg-' + pair);
      if (!native || !rendered(native)) continue;
      const directions = ['left', 'right', 'center'].filter(value => (native.getAttribute('class') || '').split(/\s+/).includes(value));
      const sourceHeader = native.parentElement?.previousElementSibling;
      const ai = Array.from(root.querySelectorAll('*')).filter(rendered).some(el => !native.contains(el) && text(el) === '该消息由AI小助手发送');
      const system = text(sourceHeader?.firstElementChild) === '该消息由系统发送';
      messages.push({ nativeId: native.id, direction: directions.length === 1 ? directions[0] : 'unknown',
        type: native.getAttribute('data-msg-type') || '', text: text(native), platformTimeMs: Number(native.getAttribute('data-timestamp')),
        ai, system });
    }
    return { origin: location.origin, pathname: location.pathname, title: document.title, activeKey: key,
      profileUid, headerNickname: headers.length === 1 ? text(headers[0]) : null,
      rowNickname: text(row.querySelector('.nick-name')) || null, messages,
      profileFields: Array.from(document.querySelectorAll('.information-source-wrap .info-item, .customer-info-wrap .info-item')).filter(rendered).map(item => {
        const input=item.querySelector('.info-item-value-wrap input');
        const value=input ? String(input.value||input.getAttribute('placeholder')||'').trim() : text(item.querySelector('.info-item-value-wrap'));
        return { label: text(item.querySelector('.info-item-title')), value, visible: true, masked: /[*＊]/.test(value) };
      }) };
  }, { accountId: expected.accountId, uid });
  if (snapshot?.error) throw new Error(snapshot.error);
  if(snapshot?.messages?.length===0&&snapshot.activeKey===`Total-${uid}`){
    lastError=new Error('conversation_messages_not_hydrated');
    if(Date.now()<hydrationDeadline){
      if(typeof page.waitForTimeout==='function')await page.waitForTimeout(50);
      else await new Promise(resolve=>setTimeout(resolve,50));
      continue;
    }
    throw new Error('conversation_messages_not_hydrated');
  }
  try { return validateConversationScope(snapshot, { ...expected, conversationId: uid }); }
  catch (error) {
    lastError = error;
    const activeMatch = /^(?:Total|Active)-([a-f0-9]{24})$/.exec(snapshot.activeKey || '');
    if (activeMatch?.[1] !== uid || !['profile_uid_mismatch','nickname_mismatch','account_title_mismatch'].includes(error.message)) throw error;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  }
  throw lastError || new Error('conversation_scope_not_ready');
}
