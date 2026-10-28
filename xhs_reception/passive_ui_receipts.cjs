"use strict";

// Observe completed requests initiated by the existing page. Never initiate,
// replay, intercept or modify requests, page actions, cookies or authorization.
const symbol = Symbol.for("xhs_reception.passive_ui_receipts");
const registry = globalThis[symbol] || (globalThis[symbol] = new WeakMap());
const maxRecords = 30;
const maxResponseBytes = 64 * 1024;
const maxRequestBytes = 256 * 1024;
const loginPath = /(?:login|sign[-_]?in|oauth|authentication|authorization|captcha|qr[-_]?code|sso|(?:^|\/)auth(?:\/|$))/i;

function safePathname(pathname) {
  if (pathname.length > 400) return "/[long-path-omitted]";
  return pathname.split("/").map(part =>
    part.length > 64 || /^[a-f0-9]{16,}$/i.test(part) || /^\d{6,}$/.test(part)
      ? "[identifier-omitted]" : part
  ).join("/");
}

function safeKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) &&
    !/^[a-f0-9]{16,}$/i.test(key) && !["__proto__", "prototype", "constructor"].includes(key);
}

function keyMetadata(value) {
  const shape = Object.create(null);
  let remaining = 20;
  const keys = candidate => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const selected = [];
    for (const key of Object.keys(candidate)) {
      if (!safeKey(key) || remaining <= 0) continue;
      remaining--;
      selected.push(key);
    }
    return selected;
  };
  const top = keys(value);
  for (const key of top) {
    const child = value[key];
    if (Array.isArray(child)) {
      const children = new Set();
      for (const item of child.slice(0,3)) for (const childKey of keys(item)) children.add(childKey);
      shape[key] = Array.from(children);
    } else {
      shape[key] = keys(child);
    }
  }
  return { top_level_keys: top, key_structure: shape };
}

function requestKeys(request) {
  try {
    // Playwright already holds this request body; no header or stream reads.
    const body = request.postDataBuffer();
    if (body === null || body === undefined) return { top_level_keys: [], status: "no_cached_json_body" };
    if (!(body instanceof Uint8Array) || body.byteLength > maxRequestBytes) {
      return { top_level_keys: [], status: "cached_body_too_large_or_unavailable" };
    }
    const value = JSON.parse(Buffer.from(body).toString("utf8"));
    return { top_level_keys: keyMetadata(value).top_level_keys, status: "json_keys_only" };
  } catch (_) {
    return { top_level_keys: [], status: "non_json_or_unavailable" };
  }
}

async function responseKeys(response) {
  // These are the only allowed response headers; values are used locally for
  // size/type checks and are never retained in the ring or snapshot.
  const [contentType, contentLength, encoding] = await Promise.all([
    response.headerValue("content-type"), response.headerValue("content-length"),
    response.headerValue("content-encoding"),
  ]);
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType || "")) return { status: "skipped_non_json" };
  if (encoding && encoding.trim().toLowerCase() !== "identity") return { status: "skipped_compressed" };
  if (!/^\d+$/.test(contentLength || "")) return { status: "skipped_unknown_length" };
  const length = Number(contentLength);
  if (!Number.isSafeInteger(length) || length > maxResponseBytes) return { status: "skipped_declared_size" };
  const bytes = await response.body();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxResponseBytes) return { status: "skipped_actual_size" };
  try {
    return { ...keyMetadata(JSON.parse(Buffer.from(bytes).toString("utf8"))), status: "json_keys_only" };
  } catch (_) { return { status: "skipped_non_json_body" }; }
}

function snapshot(page) {
  const state = registry.get(page);
  if (!state) return { attached: false, classification: "unverified_passive_ui_metadata", records: [] };
  // Records contain schema keys and transport metadata only, never body values.
  return { attached: state.attached, classification: "unverified_passive_ui_metadata",
    capacity: maxRecords, records: JSON.parse(JSON.stringify(state.records)) };
}

function attach(page) {
  if (!page || typeof page.on !== "function" || typeof page.url !== "function") throw new TypeError("existing_page_required");
  const previous = registry.get(page);
  if (previous && previous.attached) return previous.control;
  const state = { attached: true, records: [], loginRequests: new WeakSet(),
    seen: new WeakSet(), activeReads: 0, control: null };
  registry.set(page,state);
  const onRequest = request => {
    try {
      if (loginPath.test(new URL(request.url()).pathname) || loginPath.test(new URL(page.url()).pathname)) state.loginRequests.add(request);
    } catch (_) { state.loginRequests.add(request); }
  };
  const finished = async request => {
    if (!state.attached || state.seen.has(request) || state.loginRequests.has(request)) return;
    state.seen.add(request);
    let url;
    let resourceType;
    try {
      url = new URL(request.url());
      resourceType = request.resourceType();
      if (!["xhr", "fetch"].includes(resourceType) || !["http:", "https:"].includes(url.protocol) ||
          loginPath.test(url.pathname) || loginPath.test(new URL(page.url()).pathname)) return;
    } catch (_) { return; }
    const requested = requestKeys(request);
    const method = String(request.method()).toUpperCase();
    const record = { origin: url.origin, pathname: safePathname(url.pathname),
      http_status: null, request_method: /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(method) ? method : "OTHER",
      resource_type: resourceType, request_json_top_level_keys: requested.top_level_keys,
      request_json_status: requested.status, response_json_top_level_keys: [],
      response_json_key_structure: {}, response_json_status: "unavailable" };
    let timer;
    let observedStatus = null;
    try {
      const read = async () => {
        const response = await request.response();
        if (!response) return { status: "no_response" };
        const status = response.status();
        const httpStatus = Number.isInteger(status) ? status : null;
        observedStatus = httpStatus;
        if (state.activeReads >= 4) return { status: "skipped_read_budget_busy", http_status: httpStatus };
        state.activeReads++;
        try { return { ...await responseKeys(response), http_status: httpStatus }; }
        finally { state.activeReads--; } // Retain budget until the real read settles.
      };
      const result = await Promise.race([
        read(), new Promise(resolve => { timer = setTimeout(() => resolve({ status: "skipped_read_timeout" }),2000); }),
      ]);
      record.http_status = result.http_status === undefined ? observedStatus : result.http_status;
      record.response_json_status = result.status;
      record.response_json_top_level_keys = result.top_level_keys || [];
      record.response_json_key_structure = result.key_structure || {};
    } catch (_) { record.response_json_status = "skipped_read_error"; }
    finally {
      clearTimeout(timer);
    }
    if (!state.attached) return;
    state.records.push(record);
    if (state.records.length > maxRecords) state.records.shift();
  };
  const onFinished = request => { void finished(request).catch(() => {}); };
  page.on("request",onRequest);
  page.on("requestfinished",onFinished);
  state.control = Object.freeze({
    snapshot: () => snapshot(page),
    detach: () => {
      if (!state.attached) return;
      state.attached = false;
      page.off("request",onRequest);
      page.off("requestfinished",onFinished);
    },
  });
  return state.control;
}

module.exports = { attach, snapshot };
