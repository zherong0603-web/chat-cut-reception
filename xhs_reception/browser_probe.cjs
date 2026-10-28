"use strict";

// Default execution cannot import Playwright or launch any browser.
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const officialUrl = "https://sxt.xiaohongshu.com/im/login";
const result = {
  mode: "isolated_browser_dom_probe_only", url: officialUrl,
  browser_started: false, network_requested: false,
  live_reception_ready: false, five_second_reception_acceptance: "unverified",
  measurement_scope: "startup_minimal_dom_only_not_idle_stability",
  sends_or_takeovers: false,
};

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--allow-isolated-browser")) {
    return Object.assign(result, { status: "BLOCKED_BY_HUMAN", reason: "explicit_user_exception_to_iab_only_rule_required" });
  }
  let modulePath;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--allow-isolated-browser") continue;
    if (args[index] === "--playwright-module") modulePath = args[++index];
    else throw new Error("unsupported probe argument");
  }
  if (!modulePath || !path.isAbsolute(modulePath)) {
    return Object.assign(result, { status: "blocked", error: "missing_dependency_configuration" });
  }
  let chromium;
  try {
    ({ chromium } = require(modulePath));
    if (!chromium) throw new Error("configured module does not export chromium");
  } catch (error) {
    return Object.assign(result, { status: "blocked", error: "missing_dependency", detail: String(error.message).slice(0, 2000) });
  }
  const runtime = path.join(__dirname, "..", ".runtime");
  const profile = path.join(runtime, "isolated-browser-profile");
  for (const directory of [runtime, profile]) {
    try {
      if (fs.lstatSync(directory).isSymbolicLink()) {
        return Object.assign(result, { status: "blocked", error: "unsafe_profile_path" });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  fs.mkdirSync(profile, { mode: 0o700, recursive: true });
  fs.chmodSync(profile, 0o700);
  result.profile_directory = profile;
  result.started_at = Date.now() / 1000;
  result.samples = [];
  result.blocked_navigation_count = 0;
  let context;
  let timer;
  let stage = "launch_isolated_headless_chromium";
  const operation = async () => {
    // Bundled Chromium only: no channel, executable override, CDP attachment,
    // cookie copying, certificate bypasses, stealth or security-disabling args.
    context = await chromium.launchPersistentContext(profile, {
      headless: true, chromiumSandbox: true, acceptDownloads: false, timeout: 15000,
    });
    result.browser_started = true;
    await context.route("**/*", async route => {
      if (route.request().isNavigationRequest()) {
        const target = new URL(route.request().url());
        if (target.origin !== "https://sxt.xiaohongshu.com") {
          result.blocked_navigation_count++;
          return route.abort("blockedbyclient");
        }
      }
      return route.continue();
    });
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    for (const extra of pages.slice(1)) await extra.close();
    page.setDefaultTimeout(15000);
    stage = "navigate_official_login";
    result.network_requested = true;
    let started = performance.now();
    const response = await page.goto(officialUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    result.navigation_domcontentloaded_ms = performance.now() - started;
    result.http_status = response ? response.status() : null;
    if (new URL(page.url()).origin !== "https://sxt.xiaohongshu.com") throw new Error("page left official 私信通 origin");
    stage = "measure_minimal_dom";
    for (let index = 1; index <= 5; index++) {
      started = performance.now();
      // Read structural state only; no text, account scraping, inputs, or clicks.
      const observed = await page.evaluate(() => ({ ready_state: document.readyState, body_present: Boolean(document.body) }));
      result.samples.push({ index, observed_at: Date.now() / 1000, dom_evaluate_ms: performance.now() - started, ...observed });
    }
    result.status = "measured";
    result.stage = "complete";
    result.detail = "仅测启动后的最小 DOM；不证明登录、空闲稳定、持续检测或五秒三项接待。";
  };
  try {
    await Promise.race([
      operation(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("probe operation timed out after 45 seconds")), 45000); }),
    ]);
  } catch (error) {
    Object.assign(result, { status: "failed", error: "browser_probe_failed", stage, detail: String(error.message).slice(0, 2000) });
  } finally {
    clearTimeout(timer);
    if (context) {
      let closeTimer;
      try {
        await Promise.race([
          context.close(),
          new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error("isolated context close timed out")), 5000); }),
        ]);
      } catch (error) {
        Object.assign(result, { status: "failed", close_error: String(error.message).slice(0, 1000) });
      } finally {
        clearTimeout(closeTimer);
      }
    }
    result.finished_at = Date.now() / 1000;
  }
  return result;
}

main().then(observed => {
  process.stdout.write(JSON.stringify(observed) + "\n");
  process.exitCode = observed.status === "measured" ? 0 : 3;
}).catch(error => {
  Object.assign(result, { status: "failed", error: "probe_helper_failed", detail: String(error.message).slice(0, 2000) });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = 3;
});
