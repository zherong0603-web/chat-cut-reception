const uidPattern = /^[a-f0-9]{24}$/;
const actionablePattern = /超时未回复|未回复|待回复/;

export function acceptsAccountTitle(title, name) {
  if (title === name + '-私信通') return true;
  const unread = name + '-[您有新消息待回复]';
  return title.length === unread.length && (unread + unread).includes(title);
}

export function validateSidebarSnapshot(snapshot, expected) {
  if (!snapshot || snapshot.origin !== 'https://sxt.xiaohongshu.com' || snapshot.pathname !== '/im/multiCustomerService')
    throw new Error('unexpected_sidebar_route');
  if (!acceptsAccountTitle(snapshot.title, expected.name)) throw new Error('account_title_mismatch');
  if (snapshot.activeTab !== '全部会话') throw new Error('native_all_conversations_view_required');
  if (!Array.isArray(snapshot.rows)) throw new Error('invalid_sidebar_snapshot');
  const seen = new Set();
  const rows = snapshot.rows.map(row => {
    const match = typeof row?.key === 'string' ? /^(Total|Active)-([a-f0-9]{24})$/.exec(row.key) : null;
    if (!match || seen.has(match[2]) || row.visible !== true) throw new Error('invalid_sidebar_row');
    seen.add(match[2]);
    const statusTags = Array.isArray(row.statusTags) ? row.statusTags.filter(value => typeof value === 'string').slice(0, 8) : [];
    const statusText = statusTags.join(' ');
    return { view: match[1], uid: match[2], nickname: typeof row.nickname === 'string' ? row.nickname : null,
      preview: typeof row.preview === 'string' ? row.preview : '', time: typeof row.time === 'string' ? row.time : null,
      statusTags, statusText, needsReply: statusTags.some(value => actionablePattern.test(value)), leadSignal: statusTags.includes('留资客')||statusTags.includes('留客资'), platformAiActive: statusTags.includes('接待中'), isNewEntry: false };
  });
  return { classification: 'readonly_sidebar_candidates', rows };
}

export async function readSidebar(page, expected, {fullScan=false}={}) {
  if (!page || typeof page.evaluate !== 'function') throw new TypeError('existing_page_required');
  if(!fullScan){
    await page.evaluate(() => {
      const rendered=el=>el?.checkVisibility?el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}):Boolean(el?.getClientRects?.().length);
      const scroller=Array.from(document.querySelectorAll('.vue-recycle-scroller.scroller')).filter(rendered)
        .filter(el=>el.scrollHeight>el.clientHeight).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0];
      if(scroller)scroller.scrollTop=0;
    });
    if(typeof page.waitForTimeout==='function')await page.waitForTimeout(40);
    else await new Promise(resolve=>setTimeout(resolve,40));
  }
  const snapshot = await page.evaluate(() => {
    const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
    const text = el => String(el?.innerText || '').trim();
    const tabs = Array.from(document.querySelectorAll('.contact-tab-wrap .d-tabs-header')).filter(rendered);
    const active = tabs.filter(el => String(el.getAttribute('class') || '').split(/\s+/).includes('active'));
    return { origin: location.origin, pathname: location.pathname, title: document.title,
      activeTab: active.length === 1 ? text(active[0]) : null,
      rows: Array.from(document.querySelectorAll('.sx-contact-item')).filter(rendered).map(row => ({
        key: row.getAttribute('data-key'), visible: true,
        nickname: text(row.querySelector('.nick-name')) || null,
        preview: text(row.querySelector('.content')),
        time: text(row.querySelector('.time')) || null,
        statusTags: [...new Set(Array.from(row.querySelectorAll('.item-bottom .d-tag')).filter(rendered).map(text).filter(value => /^(?:\[(?:超时未回复|未回复|待回复)\]|留资客|留客资|接待中)$/.test(value)))],
      })) };
  });
  let currentSnapshot=snapshot;
  if (snapshot.activeTab === '当前会话') {
    await page.evaluate(() => {
      const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
      const all = Array.from(document.querySelectorAll('.contact-tab-wrap .d-tabs-header')).filter(rendered).find(el => String(el.innerText || '').trim() === '全部会话');
      if (!all) throw new Error('native_all_conversations_tab_required');
      all.click();
    });
    let refreshed = null;
    for(let attempt=0;attempt<40;attempt++){
      refreshed = await page.evaluate(() => {
        const rendered = el => el?.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Boolean(el?.getClientRects?.().length);
        const text = el => String(el?.innerText || '').trim();
        const tabs = Array.from(document.querySelectorAll('.contact-tab-wrap .d-tabs-header')).filter(rendered);
        const active = tabs.filter(el => String(el.getAttribute('class') || '').split(/\s+/).includes('active'));
        return { origin: location.origin, pathname: location.pathname, title: document.title,
          activeTab: active.length === 1 ? text(active[0]) : null,
          rows: Array.from(document.querySelectorAll('.sx-contact-item')).filter(rendered).map(row => ({ key: row.getAttribute('data-key'), visible: true,
            nickname: text(row.querySelector('.nick-name')) || null, preview: text(row.querySelector('.content')), time: text(row.querySelector('.time')) || null,
            statusTags: [...new Set(Array.from(row.querySelectorAll('.item-bottom .d-tag')).filter(rendered).map(text).filter(value => /^(?:\[(?:超时未回复|未回复|待回复)\]|留资客|留客资|接待中)$/.test(value)))] })) };
      });
      if(refreshed.activeTab==='全部会话'&&refreshed.rows.length>0)break;
      if(typeof page.waitForTimeout==='function')await page.waitForTimeout(100);
      else await new Promise(resolve=>setTimeout(resolve,100));
    }
    currentSnapshot=refreshed;
    if(!fullScan)return validateSidebarSnapshot(refreshed, expected);
  }
  if(fullScan){
    const bounds=await page.evaluate(()=>{const rendered=el=>el?.checkVisibility?el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}):Boolean(el?.getClientRects?.().length);
      const scroller=Array.from(document.querySelectorAll('.vue-recycle-scroller.scroller')).filter(rendered).filter(el=>el.scrollHeight>el.clientHeight)
        .sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0];
      return scroller?{scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight}:null;});
    if(bounds&&bounds.scrollHeight>bounds.clientHeight){
      const rowsByKey=new Map();let base=null;
      for(let top=0;top<=bounds.scrollHeight-bounds.clientHeight;top+=Math.max(100,Math.floor(bounds.clientHeight*0.7))){
        await page.evaluate(value=>{const rendered=el=>el?.checkVisibility?el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}):Boolean(el?.getClientRects?.().length);
          const scroller=Array.from(document.querySelectorAll('.vue-recycle-scroller.scroller')).filter(rendered).filter(el=>el.scrollHeight>el.clientHeight)
            .sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0];
          if(scroller)scroller.scrollTop=value;},top);
        if(typeof page.waitForTimeout==='function')await page.waitForTimeout(80);else await new Promise(resolve=>setTimeout(resolve,80));
        const part=await page.evaluate(()=>{
          const rendered=el=>el?.checkVisibility?el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}):Boolean(el?.getClientRects?.().length);
          const text=el=>String(el?.innerText||'').trim();
          const tabs=Array.from(document.querySelectorAll('.contact-tab-wrap .d-tabs-header')).filter(rendered);
          const active=tabs.filter(el=>String(el.getAttribute('class')||'').split(/\s+/).includes('active'));
          return{origin:location.origin,pathname:location.pathname,title:document.title,activeTab:active.length===1?text(active[0]):null,
            rows:Array.from(document.querySelectorAll('.sx-contact-item')).filter(rendered).map(row=>({key:row.getAttribute('data-key'),visible:true,
              nickname:text(row.querySelector('.nick-name'))||null,preview:text(row.querySelector('.content')),time:text(row.querySelector('.time'))||null,
              statusTags:[...new Set(Array.from(row.querySelectorAll('.item-bottom .d-tag')).filter(rendered).map(text).filter(value=>/^(?:\[(?:超时未回复|未回复|待回复)\]|留资客|留客资|接待中)$/.test(value)))]}))};
        });
        base ??= part;for(const row of part.rows)if(!rowsByKey.has(row.key))rowsByKey.set(row.key,row);
      }
      await page.evaluate(()=>{const rendered=el=>el?.checkVisibility?el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}):Boolean(el?.getClientRects?.().length);
        const scroller=Array.from(document.querySelectorAll('.vue-recycle-scroller.scroller')).filter(rendered).filter(el=>el.scrollHeight>el.clientHeight)
          .sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0];
        if(scroller)scroller.scrollTop=0;});
      if(typeof page.waitForTimeout==='function')await page.waitForTimeout(80);else await new Promise(resolve=>setTimeout(resolve,80));
      return validateSidebarSnapshot({...base,activeTab:'全部会话',rows:[...rowsByKey.values()]},expected);
    }
  }
  return validateSidebarSnapshot(currentSnapshot, expected);
}
