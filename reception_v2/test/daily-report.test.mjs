import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildDailyReport, renderDailyReport, shanghaiDayRange } from '../daily-report.mjs';

function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE events(account_id TEXT,conversation_id TEXT,event_id TEXT,type TEXT,platform_time_ms INTEGER,detected_at_ms INTEGER,evidence_json TEXT);
    CREATE TABLE turns(turn_id TEXT PRIMARY KEY,account_id TEXT,conversation_id TEXT,opened_at_ms INTEGER);
    CREATE TABLE outbox(intent_id TEXT PRIMARY KEY,turn_id TEXT,account_id TEXT,conversation_id TEXT,kind TEXT,state TEXT,evidence_json TEXT,created_at TEXT,confirmed_at_ms INTEGER);
    CREATE TABLE turn_inbound_events(turn_id TEXT,event_id TEXT);
    CREATE TABLE contacts(account_id TEXT,conversation_id TEXT,kind TEXT,source TEXT,verified INTEGER,observed_at_ms INTEGER);
  `);
  const {startMs,endMs}=shanghaiDayRange('2026-11-10');
  const evening=startMs+18*3600_000;
  const insertEvent=db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)');
  const insertTurn=db.prepare('INSERT INTO turns VALUES(?,?,?,?)');
  const insertOutbox=db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?,?)');
  const insertContact=db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?)');
  const account='a'.repeat(24),c1='1'.repeat(24),c2='2'.repeat(24),old='3'.repeat(24);
  // c1 enters, opens, gets a confirmed text after 4s from entry and 2s from opening.
  insertEvent.run(account,c1,'n1','NEW_VISITOR',evening+10_000,evening+10_100,'{}');
  insertEvent.run(account,c1,'m1','CUSTOMER_MESSAGE',evening+12_000,evening+12_100,'{}');
  // c2 enters, opens, then gets a confirmed text and an uncertain card.
  insertEvent.run(account,c2,'n2','NEW_VISITOR',evening+20_000,evening+20_100,'{}');
  insertEvent.run(account,c2,'m2','CUSTOMER_MESSAGE',evening+22_000,evening+22_100,'{}');
  // Activity from an old conversation in the window must not become part of the new-visitor cohort.
  insertEvent.run(account,old,'old-open','CUSTOMER_MESSAGE',evening+30_000,evening+30_100,'{}');
  insertTurn.run('t1',account,c1,evening+12_000);
  insertTurn.run('t2',account,c2,evening+22_000);
  db.exec("INSERT INTO turn_inbound_events VALUES ('t1','m1'),('t2','m2')");
  const iso=ms=>new Date(ms).toISOString();
  insertOutbox.run('o1','t1',account,c1,'text','sent',JSON.stringify({verified:true,platformTimeMs:evening+14_000}),iso(evening+14_100),evening+14_100);
  insertOutbox.run('o2','t2',account,c2,'text','sent',JSON.stringify({verified:true,platformTimeMs:evening+24_000}),iso(evening+24_100),evening+24_100);
  insertOutbox.run('o3','t2',account,c2,'card','uncertain',JSON.stringify({verified:false}),iso(evening+24_200),null);
  // Latest verified profile facts belong to c1 and c2. The sidebar-only lead tag is not verified lead data.
  insertContact.run(account,c1,'wecom_added','profile',1,startMs+20*3600_000);
  insertContact.run(account,c2,'lead_submitted','sidebar',1,startMs+20*3600_000);
  // Morning contacts outside the cohort cannot make the evening funnel exceed inbound customers.
  insertContact.run(account,old,'wecom_added','profile',1,startMs+9*3600_000);
  return {db,evening,endMs};
}

test('Shanghai day range is exactly midnight to midnight in UTC',()=>{
  const range=shanghaiDayRange('2026-11-10');
  assert.equal(range.startMs,Date.parse('2026-11-09T16:00:00.000Z'));
  assert.equal(range.endMs,Date.parse('2026-11-10T16:00:00.000Z'));
});

test('evening report uses new-visitor cohort and verified profile lead state',()=>{
  const {db,evening}=fixture();
  try{
    const report=buildDailyReport(db,{accountId:'a'.repeat(24),date:'2026-11-10'});
    assert.deepEqual(report.inbound,{events:2,customers:2});
    assert.deepEqual(report.openings,{customers:2,messages:2,all_window_customers:3});
    assert.deepEqual(report.leads,{customers:1,wecom_added_customers:1,lead_submitted_customers:0,phone_or_wechat_customers:0,sidebar_tag_only_customers:1});
    assert.equal(report.replies.sent_customers,2);
    assert.equal(report.replies.confirmed_after_open_customers,2);
    assert.equal(report.replies.within_3s_after_open_customers,2);
    assert.equal(report.replies.confirmed_initial_customers,2);
    assert.equal(report.replies.within_3s_initial_customers,0);
    assert.equal(report.replies.uncertain_customers,1);
    const markdown=renderDailyReport(report);
    assert.match(markdown,/晚间进线：2 次，2 位客户/);
    assert.match(markdown,/开口：2\/2 位进线客户/);
    assert.match(markdown,/有效留资：1 位客户/);
    assert.match(markdown,/已添加企微：1 位客户/);
    assert.match(markdown,/开口后 3 秒内回复：2\/2，100\.0%/);
    assert.match(markdown,/进线后 3 秒内首条回复：0\/2，0\.0%/);
  }finally{db.close();}
});

test('a later unrelated text cannot satisfy the first customer opening',()=>{
  const {db}=fixture();
  try {
    db.exec("DELETE FROM turn_inbound_events WHERE turn_id='t1'");
    const report=buildDailyReport(db,{accountId:'a'.repeat(24),date:'2026-11-10'});
    assert.equal(report.replies.confirmed_after_open_customers,1);
    assert.equal(report.replies.within_3s_after_open_rate,0.5);
  } finally {db.close();}
});
