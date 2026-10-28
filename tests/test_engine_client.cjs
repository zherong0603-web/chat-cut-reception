"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EngineClient } = require("../xhs_reception/engine_client.cjs");

async function testBoundedCloseWithInheritedPipes(directory, dbPath) {
  const executable = path.join(directory, "inherited-pipes-worker");
  const descendantLifetimeMs = 1500;
  const source = [
    'const { spawn } = require("node:child_process");',
    'const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, ' + descendantLifetimeMs + ')"],',
    '  { stdio: ["ignore", 1, 2] });',
    'helper.unref();',
    'const reader = require("node:readline").createInterface({ input: process.stdin });',
    'reader.on("line", line => {',
    '  const request = JSON.parse(line);',
    '  if (request.method === "status")',
    '    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { ready: true } }) + "\\n");',
    '});',
    'reader.on("close", () => process.exit(0));',
  ].join("\n");
  fs.writeFileSync(executable, "#!" + process.execPath + "\n" + source, { mode: 0o700 });
  const inheritedClient = new EngineClient({
    pythonExecutable: executable, dbPath, accountId: "test-only-account",
  });
  try {
    assert.equal((await inheritedClient.request("status")).ok, true);
    // The stub never acknowledges this transport-only mutation. Closing must
    // settle it UNKNOWN without retrying, even while another process holds pipes.
    const pending = inheritedClient.request("expire_unsubmitted", { fixture: "transport-only" });
    const pendingReview = inheritedClient.request("review_reply_quality", { fixture: "transport-only" });
    const started = Date.now();
    await inheritedClient.close({ timeoutMs: 100 });
    const elapsed = Date.now() - started;
    assert(elapsed < 600, "close exceeded its deadline and termination grace: " + elapsed);
    assert.equal((await pending).error.outcome, "UNKNOWN");
    assert.equal((await pendingReview).error.outcome, "UNKNOWN");
    assert.equal(inheritedClient.diagnostics().closed, true);
    const sent = inheritedClient.diagnostics().sent_requests;
    assert.equal((await inheritedClient.request("prepare")).error.outcome, "NOT_SUBMITTED");
    assert.equal(inheritedClient.diagnostics().sent_requests, sent);
  } finally {
    await inheritedClient.close({ timeoutMs: 100 });
    // Our controlled helper exits itself. Do not signal or kill descendants.
    await new Promise(resolve => setTimeout(resolve, descendantLifetimeMs + 100));
  }
}

async function testIndependentReviewThroughActualNodeAndPythonBridge(directory,pythonExecutable) {
  const dbPath=path.join(directory,"quality-review.sqlite3"),sourceId="id_c1.a1.native-current-question";
  const initialized=spawnSync(pythonExecutable,["-B","-c",[
    "import json,sys,time",
    "from xhs_reception import Engine,Event,DispatchGate",
    "engine=Engine(sys.argv[1])",
    "source='id_c1.a1.native-current-question'",
    "observed=time.time()",
    "proof=dict(source='platform_ui',timestamp_source='platform_ui',account_id='a1',conversation_id='c1',reference=source,observed_at=observed,native_message_id='jarvis-msg-c1.a1.native-current-question',native_message_type='TEXT',native_direction='left',historical_baseline=False,untrusted_message_text='日本的有吗')",
    "engine.ingest_event(Event('a1','c1',source,'CUSTOMER_MESSAGE',timestamp=observed,detected_at=observed,evidence=proof))",
    "row=engine.prepare_intent('a1','c1','reply',dict(operation='text',text='可以添加企微咨询'))",
    "gate=DispatchGate(enabled=True,browser_connected=True,authenticated=True,account_id='a1',conversation_id='c1',browser_session_id='temp-quality-session',observed_at=time.time())",
    "engine.claim_intent(row['intent_id'],'original-fixture-worker',gate)",
    "engine.begin_submit(row['intent_id'],'original-fixture-worker',gate)",
    "receipt=dict(source='platform_ui',account_id='a1',conversation_id='c1',intent_id=row['intent_id'],reference='original-exact-native-receipt',observed_at=time.time(),native_message_id='jarvis-msg-a1.c1.native-original-text',native_message_raw_id='native-original-text',native_server_history=dict(status='server_history_confirmed',verifier_version=7,operation='text',native_message_id='a1.c1.native-original-text'),usefulness_verified=True,useful=True)",
    "sent=engine.confirm(row['intent_id'],'original-fixture-worker','sent',receipt)",
    "print(json.dumps(sent));engine.close()",
  ].join("\n"),dbPath],{cwd:path.resolve(__dirname,".."),encoding:"utf8",timeout:5000});
  assert.equal(initialized.status,0,initialized.stderr);const original=JSON.parse(initialized.stdout);
  const client=new EngineClient({pythonExecutable,dbPath,accountId:"a1"});
  try {
    const reviewed=await client.request("review_reply_quality",{account_id:"a1",conversation_id:"c1",intent_id:original.intent_id,source_event_id:sourceId,
      review:{source:"independent_audit",reviewer:"independent-fixture-reviewer",classification:"not_useful",reason_code:"question_not_answered",
        reference:"synthetic independent exact-source quality evidence",observed_at:Date.now()/1000,
        account_id:"a1",conversation_id:"c1",intent_id:original.intent_id,source_event_id:sourceId}});
    assert.equal(reviewed.ok,true,JSON.stringify(reviewed));
    const status=await client.request("status",{account_id:"a1",conversation_id:"c1"});assert(status.ok);
    const current=status.result.outbox[0];
    for(const key of ["status","submitted_at","confirmed_at","source_event_id","payload"])assert.deepEqual(current[key],original[key]);
    assert.deepEqual(current.evidence.native_server_history,original.evidence.native_server_history);
    assert.equal(current.evidence.usefulness_verified,true);assert.equal(current.evidence.useful,false);
    assert.equal(status.result.conversations[0].needs_response,1);assert.equal(status.result.conversations[0].correction_reply.eligible,true);
    assert.equal(status.result.latest_event.event_id,sourceId);
  }finally{await client.close();}
}

async function main() {
  const pythonFlag = process.argv.indexOf("--python");
  const pythonExecutable = pythonFlag >= 0 ? process.argv[pythonFlag + 1] : process.env.XHS_ENGINE_TEST_PYTHON;
  assert(pythonExecutable && path.isAbsolute(pythonExecutable), "pass --python /existing/python");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-engine-client-test-"));
  const dbPath = path.join(directory, "test.sqlite3");
  let client;
  try {
    const initialized = spawnSync(pythonExecutable, ["-m", "xhs_reception", "--db", dbPath, "init"], {
      cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 5000,
    });
    assert.equal(initialized.status, 0);
    client = new EngineClient({ pythonExecutable, dbPath, accountId: "test-only-account" });
    const [status, metrics] = await Promise.all([client.request("status"), client.request("metrics")]);
    assert.equal(status.ok, true);
    assert.equal(metrics.ok, true);
    assert.notEqual(status.id, metrics.id);
    assert.deepEqual(status.result.conversations, []);
    assert.equal(metrics.result.recorded_inbound_events, 0);
    const expiry=await client.request("expire_unsubmitted",{account_id:"test-only-account",conversation_id:"unobserved-fixture"});
    assert.equal(expiry.error.code,"NotEligible"); // Reached the real bound Engine, not a transport allowlist rejection.
    const rejected = await client.request("metrics", { account_id: "other-test-account" });
    assert.equal(rejected.error.code, "account_scope_mismatch");
    assert.equal(rejected.error.message, "Engine rejected request");
    const sentBefore = client.diagnostics().sent_requests;
    // Suspend only this library's own Python child to make timeout deterministic.
    // No browser, production DB, customer observation or fake sending is involved.
    process.kill(client.diagnostics().child_pid, "SIGSTOP");
    const unknown = await client.request("begin_submit", { intent_id: "test-only-no-such-intent", owner: "test-only-owner" }, { timeoutMs: 20 });
    assert.equal(unknown.error.code, "transport_error");
    assert.equal(unknown.error.outcome, "UNKNOWN");
    const afterFailure = await client.request("status");
    assert.equal(afterFailure.error.code, "transport_error");
    assert.equal(afterFailure.error.outcome, "NOT_SUBMITTED");
    assert.equal(client.diagnostics().sent_requests, sentBefore + 1);
    await client.close();
    assert.equal(client.diagnostics().closed, true);
    const checked = spawnSync(pythonExecutable, ["-m", "xhs_reception", "--db", dbPath, "status"], {
      cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 5000,
    });
    assert.equal(checked.status, 0);
    assert.deepEqual(JSON.parse(checked.stdout).conversations, []);
    assert.deepEqual(JSON.parse(checked.stdout).outbox, []);
    await testIndependentReviewThroughActualNodeAndPythonBridge(directory,pythonExecutable);
    await testBoundedCloseWithInheritedPipes(directory, dbPath);
    process.stdout.write("engine_client: real temporary SQLite/Python RPC, IDs, scoped errors, UNKNOWN/no retry and bounded close with inherited pipes verified\n");
  } finally {
    if (client) await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String(error.message) + "\n");
  process.exitCode = 1;
});
