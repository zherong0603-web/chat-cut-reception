"use strict";

// Transport only. No browser, sockets, account discovery or business queue.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const methods = new Set(["ingest", "status", "prepare", "claim", "begin_submit", "confirm", "reconcile", "expire_unsubmitted", "review_reply_quality", "metrics"]);
const mutations = new Set(["ingest", "prepare", "claim", "begin_submit", "confirm", "reconcile", "expire_unsubmitted", "review_reply_quality"]);
const maxFrameChars = 2 * 1024 * 1024;
const terminationGraceMs = 300;

class EngineClient {
  #child;
  #pending = new Map();
  #counter = 0;
  #buffer = "";
  #stderrTail = "";
  #stderrBytes = 0;
  #unexpectedReplies = 0;
  #sentRequests = 0;
  #closed = false;
  #closing = false;
  #failed = false;
  #forceKillTimer;
  #exitPromise;
  #resolveExit;
  #requestTimeoutMs;

  constructor({ pythonExecutable, dbPath, accountId, requestTimeoutMs = 2000 }) {
    // Require explicit, existing resources. Never initialize a different DB.
    try {
      if (typeof pythonExecutable !== "string" || !path.isAbsolute(pythonExecutable) ||
          typeof dbPath !== "string" || !path.isAbsolute(dbPath) ||
          typeof accountId !== "string" || !accountId.trim() ||
          !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60000 ||
          !fs.statSync(pythonExecutable).isFile() || !fs.statSync(dbPath).isFile()) throw new Error();
      fs.accessSync(pythonExecutable, fs.constants.X_OK);
    } catch (_) {
      const error = new Error("Engine client requires an executable Python, existing absolute SQLite path, account scope and valid timeout");
      error.code = "invalid_configuration";
      throw error;
    }
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#exitPromise = new Promise(resolve => { this.#resolveExit = resolve; });
    this.#child = spawn(pythonExecutable, [
      "-u", "-m", "xhs_reception", "--db", dbPath, "--account", accountId, "rpc",
    ], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", chunk => this.#receive(chunk));
    this.#child.stderr.on("data", chunk => {
      this.#stderrBytes += chunk.length;
      this.#stderrTail = (this.#stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    this.#child.stdin.on("error", () => this.#transportFailure("pipe_error"));
    this.#child.on("error", () => this.#transportFailure("child_start_error"));
    this.#child.on("close", () => {
      this.#closed = true;
      clearTimeout(this.#forceKillTimer);
      this.#failPending("child_closed");
      this.#resolveExit({ closed: true });
    });
  }

  request(method, params = {}, { timeoutMs = this.#requestTimeoutMs } = {}) {
    const id = `${process.pid}:${++this.#counter}`;
    if (!methods.has(method) || !params || typeof params !== "object" || Array.isArray(params) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
      return Promise.resolve(this.#error(id, "invalid_request", "Request was not submitted", "NOT_SUBMITTED"));
    }
    if (this.#closed || this.#closing || this.#failed) {
      return Promise.resolve(this.#transportError(id, method, "transport_unavailable", false));
    }
    let line;
    try {
      line = JSON.stringify({ id, method, params }) + "\n";
      if (line.length > 1024 * 1024) throw new Error();
    } catch (_) {
      return Promise.resolve(this.#error(id, "invalid_request", "Request was not submitted", "NOT_SUBMITTED"));
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => this.#transportFailure("request_timeout"), timeoutMs);
      this.#pending.set(id, { method, resolve, timer });
      this.#sentRequests++;
      // A false return means Node is buffering bytes. Never write them twice.
      this.#child.stdin.write(line, error => {
        if (error) this.#transportFailure("pipe_error");
      });
    });
  }

  #receive(chunk) {
    if (this.#failed || this.#closed) return;
    this.#buffer += chunk;
    while (true) {
      const end = this.#buffer.indexOf("\n");
      if (end < 0) break;
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      if (line.length > maxFrameChars) return this.#transportFailure("protocol_error");
      let response;
      try {
        response = JSON.parse(line);
        if (!response || typeof response !== "object" || Array.isArray(response) ||
            typeof response.id !== "string" || typeof response.ok !== "boolean" ||
            (response.ok ? !("result" in response) || "error" in response :
              !response.error || typeof response.error !== "object" || "result" in response)) throw new Error();
      } catch (_) {
        return this.#transportFailure("protocol_error");
      }
      const pending = this.#pending.get(response.id);
      if (!pending) {
        this.#unexpectedReplies++;
        continue; // Late/duplicate IDs cannot resolve another request.
      }
      clearTimeout(pending.timer);
      this.#pending.delete(response.id);
      if (!response.ok) {
        // Do not surface arbitrary stderr or remote exception text that could
        // contain input values. Structured error codes are sufficient for control.
        const code = typeof response.error.code === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(response.error.code)
          ? response.error.code : "remote_error";
        pending.resolve(this.#error(response.id, code, "Engine rejected request"));
      } else {
        pending.resolve({ id: response.id, ok: true, result: response.result });
      }
    }
    if (this.#buffer.length > maxFrameChars) this.#transportFailure("protocol_error");
  }

  #error(id, code, message, outcome) {
    return { id, ok: false, error: { code, message, ...(outcome ? { outcome } : {}) } };
  }

  #transportError(id, method, reason, submitted = true) {
    const outcome = !submitted ? "NOT_SUBMITTED" : mutations.has(method) ? "UNKNOWN" : "UNAVAILABLE";
    return { id, ok: false, error: {
      code: "transport_error", reason, outcome,
      message: "Engine transport unavailable; no automatic retry",
    } };
  }

  #failPending(reason) {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve(this.#transportError(id, pending.method, reason));
    }
    this.#pending.clear();
  }

  #transportFailure(reason) {
    if (this.#failed || this.#closed) return;
    this.#failed = true;
    this.#failPending(reason);
    this.#terminateOwnChild();
  }

  #terminateOwnChild() {
    if (this.#closed) return;
    // A descendant may inherit these descriptors after our direct child exits.
    // Close only our pipe endpoints; never wait for or signal unknown processes.
    this.#child.stdin.destroy();
    this.#child.stdout.destroy();
    this.#child.stderr.destroy();
    this.#child.kill("SIGTERM");
    this.#forceKillTimer = setTimeout(() => {
      if (!this.#closed) this.#child.kill("SIGKILL");
    }, 250);
    this.#forceKillTimer.unref();
  }

  diagnostics() {
    // Counts only; raw stderr, account, DB path, params and responses are private.
    return { child_pid: this.#child.pid || null, closed: this.#closed,
      transport_failed: this.#failed, sent_requests: this.#sentRequests,
      pending_requests: this.#pending.size, unexpected_replies: this.#unexpectedReplies,
      stderr_bytes: this.#stderrBytes, stderr_retained_chars: this.#stderrTail.length };
  }

  async close({ timeoutMs = 1000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Invalid close timeout");
    if (this.#closed) return { closed: true };
    if (!this.#closing) {
      this.#closing = true;
      this.#child.stdin.end();
    }
    let timer;
    let graceTimer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        this.#transportFailure("close_timeout");
        // A process stuck beyond SIGKILL must not leave callers waiting forever.
        // Report the actual close observation rather than pretending it exited.
        graceTimer = setTimeout(() => resolve({ closed: this.#closed, timed_out: true }),
          terminationGraceMs);
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.#exitPromise, deadline]);
    } finally {
      clearTimeout(timer);
      clearTimeout(graceTimer);
    }
  }
}

// The caller must wait for an ok begin_submit response before any UI send.
// UNKNOWN never authorizes replay, reconnect, or a new browser action.
module.exports = { EngineClient };
