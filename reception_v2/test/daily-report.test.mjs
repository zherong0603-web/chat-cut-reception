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
    CREATE TABLE contacts(account_id TEXT,conversation_id TEXT,kind TEXT,verified INTEGER,observed_at_ms INTEGER);
  `);
  const {startMs}=shanghaiDayRange('2026-11-09');
  const insertEvent=db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)');
  const insertTurn=db.prepare('INSERT INTO turns VALUES(?,?,?,?)');
  const insertOutbox=db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?,?)');
  const insertContact=db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?)');
  const account='a'.repeat(24);
  const c1='1'.repeat(24), c2='2'.repeat(24);
  insertEvent.run(account,c1,'n1','NEW_VISITOR',startMs+1000,startMs+1100,'{}');
  insertEvent.run(account,c1,'m1','CUSTOMER_MESSAGE',startMs+1200,startMs+1300,'{}');
  insertEvent.run(account,c2,'n2','NEW_VISITOR',startMs+8000,startMs+8100,'{}');
  insertEvent.run(account,c2,'m2','CUSTOMER_MESSAGE',startMs+8200,startMs+8300,'{}');
  insertEvent.run(account,c2,'m3','CUSTOMER_MESSAGE',startMs+9000,startMs+9100,'{}');
  insertTurn.run('t1',account,c1,startMs+1000);
  insertTurn.run('t2',account,c2,startMs+8000);
  const iso=ms=>new Date(ms).toISOString();
  insertOutbox.run('o1','t1',account,c1,'text','sent',JSON.stringify({verified:true,withinThreeSeconds:true,platformTimeMs:startMs+2500}),iso(startMs+2600),startMs+2600);
  insertOutbox.run('o2','t2',account,c2,'text','sent',JSON.stringify({verified:true,withinThreeSeconds:false,platformTimeMs:startMs+12500}),iso(startMs+12600),startMs+12600);
  insertOutbox.run('o3','t2',account,c2,'card','uncertain',JSON.stringify({verified:false}),iso(startMs+12700),null);
  insertContact.run(account,c1,'lead_submitted',1,startMs+5000);
  return db;
}

test('Shanghai day range is exactly midnight to midnight in UTC',()=>{
  const range=shanghaiDayRange('2026-11-09');
  assert.equal(range.startMs,Date.parse('2026-11-08T16:00:00.000Z'));
  assert.equal(range.endMs,Date.parse('2026-11-09T16:00:00.000Z'));
});

test('daily report separates volume, people, contacts and strict three-second delivery',()=>{
  const db=fixture();
  try{
    const report=buildDailyReport(db,{accountId:'a'.repeat(24),date:'2026-11-09'});
    assert.deepEqual(report.inbound,{events:2,customers:2});
    assert.deepEqual(report.openings,{customers:2,messages:3});
    assert.deepEqual(report.leads,{customers:1,lead_submitted_customers:1,wecom_added_customers:0});
    assert.equal(report.replies.sent,2);
    assert.equal(report.replies.uncertain,1);
    assert.equal(report.replies.text_sent,2);
    assert.equal(report.replies.text_within_3s,1);
    assert.equal(report.replies.text_within_3s_rate,0.5);
    assert.equal(report.replies.confirmed_rate,2/3);
    const markdown=renderDailyReport(report);
    assert.match(markdown,/总进线：2 次，2 位客户/);
    assert.match(markdown,/3 秒内文字回复：1\/2，50\.0%/);
    assert.match(markdown,/发送闭环率：2\/3，66\.7%/);
  }finally{db.close();}
});
