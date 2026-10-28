import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.mjs';

const accountId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const conversationId = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reception-v2-db-'));
  const dbPath = path.join(dir, 'state.sqlite3');
  return { dir, dbPath, db: openDatabase(dbPath) };
}

test('merges messages inside 800ms into one turn', () => {
  const f = fixture();
  try {
    const first = f.db.ingestInbound({ accountId, conversationId, eventId: 'event-1', text: '在吗', platformTimeMs: 100_000 });
    const second = f.db.ingestInbound({ accountId, conversationId, eventId: 'event-2', text: '想问报价', platformTimeMs: 100_799 });
    assert.equal(second.turnId, first.turnId);
    assert.equal(f.db.listTurns(accountId, conversationId).length, 1);
    assert.deepEqual(f.db.getTurn(first.turnId).inboundTexts, ['在吗', '想问报价']);
  } finally { f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('new message after 800ms creates new turn', () => {
  const f = fixture();
  try {
    const first = f.db.ingestInbound({ accountId, conversationId, eventId: 'event-1', text: '在吗', platformTimeMs: 100_000 });
    const second = f.db.ingestInbound({ accountId, conversationId, eventId: 'event-2', text: '还在吗', platformTimeMs: 100_800 });
    assert.notEqual(second.turnId, first.turnId);
    assert.equal(f.db.listTurns(accountId, conversationId).length, 2);
  } finally { f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('rejects same content twice in one conversation', () => {
  const f = fixture();
  try {
    const turn = f.db.ingestInbound({ accountId, conversationId, eventId: 'event-1', text: '报价', platformTimeMs: 100_000 });
    f.db.createIntent({ turnId: turn.turnId, kind: 'text', content: '你好，想了解哪个国家？' });
    assert.throws(() => f.db.createIntent({ turnId: turn.turnId, kind: 'text', content: ' 你好， 想了解哪个国家？ ' }), /duplicate_outbound_content/);
  } finally { f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('message inside rolling 800ms window extends the same turn', () => {
  const f = fixture();
  try {
    const first=f.db.ingestInbound({accountId,conversationId,eventId:'event-1',text:'一',platformTimeMs:1000});
    const second=f.db.ingestInbound({accountId,conversationId,eventId:'event-2',text:'二',platformTimeMs:1700});
    const third=f.db.ingestInbound({accountId,conversationId,eventId:'event-3',text:'三',platformTimeMs:2400});
    assert.equal(second.turnId,first.turnId);assert.equal(third.turnId,first.turnId);assert.equal(f.db.getTurn(first.turnId).quietUntilMs,3200);
  } finally {f.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('reopening converts an in-flight send to uncertain without retry',()=>{
  const f=fixture();const turn=f.db.ingestInbound({accountId,conversationId,eventId:'event-x',text:'报价',platformTimeMs:1000});const intent=f.db.createIntent({turnId:turn.turnId,kind:'text',content:'正在发送'});f.db.markSending(intent.intentId,1100);f.db.close();f.db=openDatabase(f.dbPath);try{assert.equal(f.db.getIntent(intent.intentId).state,'uncertain');assert.equal(f.db.getIntent(intent.intentId).payload.recovered_on_startup,true);}finally{f.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('uncertain intent becomes sent only through exact-history reconciliation',()=>{
  const f=fixture();try{const turn=f.db.ingestInbound({accountId,conversationId,eventId:'event-r',text:'报价',platformTimeMs:1000});const intent=f.db.createIntent({turnId:turn.turnId,kind:'text',content:'已经核验'});f.db.markSending(intent.intentId,1100);f.db.markUncertain(intent.intentId,{reason:'pending'});const sent=f.db.markReconciledSent(intent.intentId,{nativeId:'id_exact',verified:true,reconciled:true});assert.equal(sent.state,'sent');assert.equal(sent.payload.reconciled,true);assert.throws(()=>f.db.markReconciledSent(intent.intentId,{nativeId:'second'}),/invalid_intent_transition/);}finally{f.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('confirmed-absent uncertain intent is retired before a new retry intent',()=>{
  const f=fixture();try{const turn=f.db.ingestInbound({accountId,conversationId,eventId:'event-a',text:'报价',platformTimeMs:1000});const intent=f.db.createIntent({turnId:turn.turnId,kind:'text',content:'缺失内容'});f.db.markSending(intent.intentId,1100);f.db.markUncertain(intent.intentId,{reason:'pending'});const retired=f.db.markReconciledAbsent(intent.intentId,{nativeHistoryAbsent:true,passes:5});assert.equal(retired.state,'failed');assert.equal(retired.payload.nativeHistoryAbsent,true);}finally{f.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('explicit confirmed-missing retry can create a bounded extra attempt',()=>{
  const f=fixture();try{const turn=f.db.ingestInbound({accountId,conversationId,eventId:'event-limit',text:'价格',platformTimeMs:1000});for(let i=0;i<3;i++)f.db.createIntent({turnId:turn.turnId,kind:'text',content:`尝试${i}`});assert.throws(()=>f.db.createIntent({turnId:turn.turnId,kind:'card',payload:{cardTitle:'企微_运去哪海外仓（企微）'}}),/turn_attempt_limit_reached/);const retry=f.db.createIntent({turnId:turn.turnId,kind:'card',payload:{cardTitle:'企微_运去哪海外仓（企微）',retryAttempt:1},maxAttempts:6});assert.equal(retry.kind,'card');assert.equal(f.db.getTurn(turn.turnId).attemptCount,4);}finally{f.db.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
