"use strict";

// Passive observation of one native UI response. This module never fetches,
// replays, intercepts or changes requests, and never grants send permission.
const registryKey = Symbol.for("xhs_reception.native_eligibility");
const registry = globalThis[registryKey] || (globalThis[registryKey] = new WeakMap());
const officialOrigin = "https://sxt.xiaohongshu.com";
const endpoint = "/api-sxt/edith/chatline/common_check/list";
const maxRecords = 10;
const maxBodyBytes = 64 * 1024;
const maxConcurrentReads = 4;
const readTimeoutMs = 2000;
const sensitiveName = /token|secret|cookie|authorization|authentication|password|passcode|credential|ticket|session|nonce|signature|captcha|(?:^|_)otp(?:_|$)/i;
const identifier = /^[a-f0-9]{24}$/i;
const enumValues = new Set([
  "0", "1", "2", "-1", "true", "false", "yes", "no", "on", "off",
  "allow", "allowed", "deny", "denied", "enable", "enabled", "disable", "disabled",
  "unknown", "pending", "limited", "unlimited", "blocked", "restricted",
  "open", "closed", "available", "unavailable", "valid", "invalid",
  "ok", "success", "failure", "failed", "error", "none",
]);

function safeName(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) &&
    !/^[a-f0-9]{16,}$/i.test(value) && !["__proto__", "prototype", "constructor"].includes(value);
}

function queryMetadata(url) {
  const keys = [];
  const ids = [];
  for (const key of url.searchParams.keys()) {
    if (!safeName(key) || keys.includes(key) || keys.length >= 20) continue;
    keys.push(key);
    if (sensitiveName.test(key)) continue;
    // Only entire 24-hex values qualify; do not mine identifiers out of free
    // text, JSON, credentials or arbitrary compound query values.
    const values = [...new Set(url.searchParams.getAll(key).filter(value => identifier.test(value)))].slice(0,10);
    if (values.length && ids.length < 10) ids.push({ key, values });
  }
  return { query_keys: keys, query_24hex_id_candidates: ids };
}

function valueType(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function permissionCandidate(value) {
  let remaining = 80;
  let truncated = false;
  let omitted = 0;
  function visit(item, depth) {
    if (remaining-- <= 0 || depth > 3) {
      truncated = true;
      return { observation: "omitted_structure_limit" };
    }
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (Number.isFinite(item) && Math.abs(item) <= 1e9) return item;
      omitted++;
      return { observation: "omitted_numeric_range" };
    }
    if (typeof item === "string") {
      if (item.length <= 24 && enumValues.has(item.toLowerCase())) return item;
      omitted++;
      return { observation: "omitted_non_enum_string" };
    }
    if (Array.isArray(item)) {
      if (item.length > 5) truncated = true;
      return item.slice(0,5).map(child => visit(child,depth+1));
    }
    if (!item || typeof item !== "object") {
      omitted++;
      return { observation: "omitted_unexpected_type" };
    }
    const result = Object.create(null);
    let count = 0;
    for (const key of Object.keys(item)) {
      if ((!safeName(key) && !identifier.test(key)) || sensitiveName.test(key) ||
          /^(phone|mobile|email|address|contact)$/i.test(key)) {
        omitted++;
        continue;
      }
      if (count >= 20 || remaining <= 0) {
        truncated = true;
        break;
      }
      result[key] = visit(item[key],depth+1);
      count++;
    }
    return result;
  }
  return { structure: visit(value,0), truncated, omitted_fields_or_values: omitted };
}

function businessCode(value) {
  if (Number.isSafeInteger(value) && Math.abs(value) <= 1e9) return value;
  if (typeof value === "string" && value.length <= 24 &&
      (/^-?\d{1,9}$/.test(value) || enumValues.has(value.toLowerCase()))) return value;
  return null;
}

async function readCandidate(response) {
  // Do not inspect request headers, cookies or authentication response headers.
  const [type, lengthHeader, encoding] = await Promise.all([
    response.headerValue("content-type"), response.headerValue("content-length"),
    response.headerValue("content-encoding"),
  ]);
  if (!/^application\/json(?:\s*;|\s*$)/i.test(type || "")) return { body_status: "skipped_non_json" };
  if (encoding && encoding.trim().toLowerCase() !== "identity") return { body_status: "skipped_compressed" };
  if (!/^\d+$/.test(lengthHeader || "")) return { body_status: "skipped_unknown_length" };
  const length = Number(lengthHeader);
  if (!Number.isSafeInteger(length) || length > maxBodyBytes) return { body_status: "skipped_declared_size" };
  const bytes = await response.body();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBodyBytes) return { body_status: "skipped_actual_size" };
  let body;
  try { body = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch (_) { return { body_status: "skipped_invalid_json" }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body_status: "json_observed", schema_status: "unverified_unexpected_envelope" };
  }
  const result = {
    body_status: "json_observed", schema_status: "unverified",
    business_code: businessCode(body.code),
    business_code_observed_type: valueType(body.code),
    business_success: typeof body.success === "boolean" ? body.success : null,
    business_success_observed_type: valueType(body.success),
  };
  // The native msg field is deliberately not retained.
  const map = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data.permission_map : undefined;
  result.permission_map_observed_type = valueType(map);
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    result.schema_status = "unverified_unexpected_permission_map";
    return result;
  }
  result.permission_map_candidate = permissionCandidate(map);
  return result;
}

function snapshot(page) {
  const state = registry.get(page);
  return {
    attached: Boolean(state && state.attached),
    classification: "unverified_native_eligibility_observations",
    endpoint, capacity: maxRecords,
    active_reads: state ? state.activeReads : 0,
    max_concurrent_reads: maxConcurrentReads,
    read_timeout_ms: readTimeoutMs,
    engine_events_emitted: 0,
    interpretation: "native_candidates_only_not_a_send_permission_verdict",
    records: state ? JSON.parse(JSON.stringify(state.records)) : [],
  };
}

function attach(page) {
  if (!page || typeof page.on !== "function" || typeof page.off !== "function" ||
      typeof page.url !== "function") throw new TypeError("existing_page_required");
  const prior = registry.get(page);
  if (prior && prior.attached) return prior.control;
  const state = { attached: true, records: [], activeReads: 0, sequence: 0,
    seen: new WeakSet(), control: null };
  registry.set(page,state);
  const remember = record => {
    if (!state.attached) return;
    record.recorded_at_utc = new Date().toISOString();
    state.records.push(record);
    if (state.records.length > maxRecords) state.records.shift();
  };
  const observe = async response => {
    if (!state.attached || !response || state.seen.has(response)) return;
    state.seen.add(response);
    let url, request, requestURL;
    try {
      if (new URL(page.url()).origin !== officialOrigin) return;
      url = new URL(response.url());
      if (url.origin !== officialOrigin || url.pathname !== endpoint) return;
      request = response.request();
      if (request.method() !== "GET") return;
      requestURL = new URL(request.url());
      if (requestURL.origin !== officialOrigin || requestURL.pathname !== endpoint) return;
    } catch (_) { return; }
    const status = response.status();
    const record = {
      sequence: ++state.sequence, response_observed_at_utc: new Date().toISOString(),
      classification: "unverified_native_eligibility_observation",
      origin: officialOrigin, pathname: endpoint, request_method: "GET",
      http_status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      ...queryMetadata(requestURL),
    };
    if (state.activeReads >= maxConcurrentReads) {
      remember({ ...record, body_status: "skipped_read_budget_busy" });
      return;
    }
    state.activeReads++;
    let timer;
    // Keep the budget occupied until the actual SDK read settles, even after
    // the observation timeout. Late results are discarded, never reclassified.
    const reading = Promise.resolve().then(() => readCandidate(response))
      .catch(() => ({ body_status: "skipped_read_error" }))
      .finally(() => { state.activeReads--; });
    const result = await Promise.race([
      reading,
      new Promise(resolve => { timer = setTimeout(() => resolve({ body_status: "skipped_read_timeout" }),readTimeoutMs); }),
    ]);
    clearTimeout(timer);
    remember({ ...record, ...result });
  };
  const onResponse = response => { void observe(response).catch(() => {}); };
  page.on("response",onResponse);
  state.control = Object.freeze({
    snapshot: () => snapshot(page),
    detach: () => {
      if (!state.attached) return;
      state.attached = false;
      page.off("response",onResponse);
    },
  });
  return state.control;
}

module.exports = { attach, snapshot };
