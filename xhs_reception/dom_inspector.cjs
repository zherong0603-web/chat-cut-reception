"use strict";

// Structural read only. Returned DOM strings are untrusted evidence candidates.
async function inspect(page, { selector, depth = 3, maxNodes = 100 } = {}) {
  if (!page || typeof page.evaluate !== "function") throw new TypeError("page_evaluate_required");
  if (typeof selector !== "string" || !selector.trim() || selector.length > 1000 || selector.includes("\0")) {
    throw new TypeError("invalid_inspector_selector");
  }
  if (!Number.isInteger(depth) || depth < 0 || depth > 5) throw new RangeError("inspector_depth_must_be_0_to_5");
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 150) throw new RangeError("inspector_max_nodes_must_be_1_to_150");

  return page.evaluate(({ selector, depth, maxNodes }) => {
    const excluded = new Set(["svg", "path", "script", "style"]);
    let nodeCount = 0;
    let truncated = false;
    const selected = new WeakSet();
    const roots = [];
    const permitted = element => element.namespaceURI !== "http://www.w3.org/2000/svg" &&
      !excluded.has(String(element.tagName || "").toLowerCase());

    function attributes(element) {
      const result = {};
      for (const attribute of Array.from(element.attributes || [])) {
        if (!/^(?:class|id|role|aria-[a-z0-9_-]+|data-[a-z0-9_-]+)$/i.test(attribute.name)) continue;
        const value = String(attribute.value || "");
        // Omit long values rather than suggesting a truncated ID is exact.
        if (value.length > 240 || /(?:^data:|^blob:|base64,|https?:\/\/)/i.test(value)) continue;
        result[attribute.name] = value;
      }
      return result;
    }

    function directText(element) {
      const pieces = [];
      let remaining = 120;
      for (const child of Array.from(element.childNodes || [])) {
        if (child.nodeType !== 3 || remaining <= 0) continue;
        const raw = String(child.nodeValue || "");
        if (/^\s*(?:data:|blob:)/i.test(raw) ||
            (raw.length > 240 && (/https?:\/\//i.test(raw.slice(0,512)) || !/\s/.test(raw.slice(0,512))))) continue;
        const text = raw.slice(0,512).replace(/\s+/g," ").trim().slice(0,remaining);
        if (text) {
          pieces.push(text);
          remaining -= text.length + 1;
        }
      }
      return pieces.join(" ").slice(0,120);
    }

    function rendered(element) {
      try {
        if (typeof element.checkVisibility === "function") {
          return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        }
        const style = getComputedStyle(element);
        return Boolean(element.getClientRects().length) && style.visibility !== "hidden" && style.display !== "none";
      } catch (_) { return false; }
    }

    function visit(element, level) {
      if (!permitted(element) || selected.has(element)) return null;
      if (nodeCount >= maxNodes) {
        truncated = true;
        return null;
      }
      selected.add(element);
      nodeCount++;
      const output = { tag: String(element.tagName).toLowerCase(), attributes: attributes(element),
        direct_text: directText(element), rendered: rendered(element), children: [] };
      const children = Array.from(element.children || []).filter(permitted);
      if (level >= depth) {
        if (children.length) truncated = true;
      } else {
        for (const child of children) {
          const inspected = visit(child, level + 1);
          if (inspected) output.children.push(inspected);
          if (nodeCount >= maxNodes) {
            if (child !== children[children.length - 1]) truncated = true;
            break;
          }
        }
      }
      return output;
    }

    for (const element of document.querySelectorAll(selector)) {
      const root = visit(element,0);
      if (root) roots.push(root);
      // Keep the combined output bounded even for a broad selector.
      if (nodeCount >= maxNodes) {
        truncated = true;
        break;
      }
    }
    return { classification: "unverified_readonly_dom_structure", selector, depth, max_nodes: maxNodes,
      node_count: nodeCount, truncated, roots };
  }, { selector, depth, maxNodes });
}

module.exports = { inspect };
