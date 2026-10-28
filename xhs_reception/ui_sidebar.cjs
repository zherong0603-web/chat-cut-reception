"use strict";

// Candidate observation only. A sidebar row is not a platform entry event.
async function readSidebar(page) {
  if (!page || typeof page.evaluate !== "function") throw new TypeError("existing_page_required");
  const snapshot = await page.evaluate(() => {
    if (location.origin !== "https://sxt.xiaohongshu.com") return {error_code:"unexpected_sidebar_origin"};
    if (location.pathname !== "/im/multiCustomerService") return {error_code:"unexpected_sidebar_route"};
    const limit = 100;
    const rows = [];
    const short = (value, length) => String(value || "").replace(/\s+/g," ").trim().slice(0,length);
    const visible = element => {
      try {
        if (typeof element.checkVisibility === "function") {
          return element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
        }
        const style = getComputedStyle(element);
        return Boolean(element.getClientRects().length) && style.display !== "none" && style.visibility !== "hidden";
      } catch (_) { return false; }
    };
    const tabs = Array.from(document.querySelectorAll(".contact-tab-wrap .d-tabs-header")).filter(visible);
    const allTabs = tabs.filter(element => String(element.innerText || "").trim() === "全部会话");
    const activeTabs = tabs.filter(element => String(element.getAttribute("class") || "").split(/\s+/).includes("active"));
    // Active-* rows belong to another native view. Never call that view's
    // hidden Total-* list a successful empty inbox, and never switch tabs here.
    if (allTabs.length !== 1 || activeTabs.length !== 1 || activeTabs[0] !== allTabs[0]) {
      return {error_code:"native_all_conversations_view_required"};
    }
    const visibleRows = Array.from(document.querySelectorAll(".sx-contact-item")).filter(visible);
    // Tab activation can precede list hydration. Match the action boundary's
    // native All-view contract while allowing a genuinely empty visible list.
    if (visibleRows.some(element => !/^Total-[a-f0-9]{24}$/.test(element.getAttribute("data-key") || ""))) {
      return {error_code:"native_all_conversations_view_required"};
    }
    const text = (element, selector, length) => {
      const child = element.querySelector(selector);
      return child ? short(child.innerText, length) : null;
    };
    const indicator = /(?:unread|reply|badge|red.?dot|robot|assistant|(?:^|[\s_-])ai(?:$|[\s_-]))/i;
    let truncated = false;
    for (const element of visibleRows) {
      const key = element.getAttribute("data-key") || "";
      const match = /^Total-([0-9a-fA-F]{24})$/.exec(key);
      if (!match || !visible(element)) continue;
      if (rows.length >= limit) { truncated = true; break; }
      const elementClass = short(element.getAttribute("class"),400);
      const candidates = new Set();
      for (const child of element.querySelectorAll("[class]")) {
        const value = short(child.getAttribute("class"),240);
        if (indicator.test(value)) candidates.add(value);
        if (candidates.size >= 12) break;
      }
      const focus = element.getAttribute("data-focus-time");
      rows.push({
        uid: match[1].toLowerCase(), key,
        nickname: text(element,".nick-name",80),
        time: text(element,".time",60),
        content: text(element,".content",160),
        active: /(?:^|[\s_-])active(?:$|[\s_-])/.test(elementClass) || element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-current") === "true",
        data_focus_time: focus && focus.length <= 80 ? focus : null,
        element_class: elementClass,
        indicator_class_candidates: Array.from(candidates),
      });
    }
    return {
      classification: "unverified_sidebar_candidates", observed_at_utc: new Date().toISOString(),
      route: location.origin + location.pathname, title: short(document.title,200),
      limit, truncated, rows, business_events_created: false,
      interpretation: "首次基线、列表重排或虚拟列表旧行出现均不能认定新进线；须选中会话后核实原生事件标识和平台时间。",
    };
  });
  // A fixed local error code survives Playwright's wrapping of evaluate errors.
  // Native/customer text never supplies diagnostic wording.
  if (["unexpected_sidebar_origin","unexpected_sidebar_route","native_all_conversations_view_required"].includes(snapshot?.error_code)) {
    const error = new Error(snapshot.error_code);error.code = snapshot.error_code;throw error;
  }
  return snapshot;
}

module.exports = { readSidebar };
