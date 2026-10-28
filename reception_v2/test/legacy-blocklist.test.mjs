import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db.mjs';
import { importLegacyUnknowns } from '../legacy-blocklist.mjs';
const accountId='aaaaaaaaaaaaaaaaaaaaaaaa',conversationId='bbbbbbbbbbbbbbbbbbbbbbbb';
test('legacy UNKNOWN content is imported and cannot be resent',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reception-v2-legacy-')),legacy=path.join(dir,'legacy.sqlite3'),v2=path.join(dir,'v2.sqlite3');
  const old=new DatabaseSync(legacy);old.exec('CREATE TABLE outbox(intent_id TEXT,account_id TEXT,conversation_id TEXT,kind TEXT,source_event_id TEXT,payload TEXT,status TEXT,created_at REAL,expires_at REAL,owner TEXT,claimed_at REAL,lease_until REAL,browser_session_id TEXT,submitted_at REAL,confirmed_at REAL,evidence TEXT,error TEXT)');
  old.prepare('INSERT INTO outbox(intent_id,account_id,conversation_id,kind,source_event_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run('i',accountId,conversationId,'reply','e',JSON.stringify({operation:'text',text:'旧消息'}),'UNKNOWN',1,2);old.close();
  const db=openDatabase(v2);try{const count=importLegacyUnknowns(db,legacy);assert.equal(count,1);const turn=db.ingestInbound({accountId,conversationId,eventId:'e2',text:'新问题',platformTimeMs:100});assert.throws(()=>db.createIntent({turnId:turn.turnId,kind:'text',content:'旧消息'}),/duplicate_outbound_content/);}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('legacy UNKNOWN WeCom card is blocked using the V2 card payload hash',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reception-v2-legacy-card-')),legacy=path.join(dir,'legacy.sqlite3'),v2=path.join(dir,'v2.sqlite3');
  const old=new DatabaseSync(legacy);old.exec('CREATE TABLE outbox(intent_id TEXT,account_id TEXT,conversation_id TEXT,kind TEXT,source_event_id TEXT,payload TEXT,status TEXT,created_at REAL,expires_at REAL,owner TEXT,claimed_at REAL,lease_until REAL,browser_session_id TEXT,submitted_at REAL,confirmed_at REAL,evidence TEXT,error TEXT)');
  old.prepare('INSERT INTO outbox(intent_id,account_id,conversation_id,kind,source_event_id,payload,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run('i',accountId,conversationId,'native_card','e',JSON.stringify({operation:'native_card',card_name:'企微_运去哪海外仓（企微）'}),'UNKNOWN',1,2);old.close();
  const db=openDatabase(v2);try{importLegacyUnknowns(db,legacy);const turn=db.ingestInbound({accountId,conversationId,eventId:'e2',text:'新问题',platformTimeMs:100});assert.throws(()=>db.createIntent({turnId:turn.turnId,kind:'card',payload:{cardTitle:'企微_运去哪海外仓（企微）'}}),/duplicate_outbound_content/);}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
