"use strict";
// Execute the actual action's read-only SQLite anchor reader against temporary
// native-event/outbox fixtures. This is not live receipt/reconciliation proof.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const source=fs.readFileSync(path.resolve(__dirname,'../xhs_reception/ui_actions.cjs'),'utf8');
const start=source.indexOf('function legacyOriginalTextAnchor('),end=source.indexOf('async function currentUnansweredNativeSource(',start);
const read=vm.runInNewContext('('+source.slice(start,end)+')',{require,path});
const A='aaaaaaaaaaaaaaaaaaaaaaaa',U='bbbbbbbbbbbbbbbbbbbbbbbb',I='original-intent',T='SYNTHETIC_ORIGINAL_TEXT';
const ms=Date.now()-60000,submitted=ms/1000,dom='id_'+U+'.'+A+'.original-native',question='id_'+U+'.'+A+'.old-question';
function data(){return {outbox:[{intent_id:I,account_id:A,conversation_id:U,source_event_id:question,status:'UNKNOWN',submitted_at:submitted,payload:{operation:'text',text:T},
  evidence:{source:'platform_ui',account_id:A,conversation_id:U,reference:'one-ui-click-result-unknown',observed_at:submitted+3.257}}],events:[
  {account_id:A,conversation_id:U,event_id:question,type:'CUSTOMER_MESSAGE',timestamp:submitted-.1,detected_at:submitted-.05,timestamp_source:'platform_ui',evidence:{source:'platform_ui',account_id:A,conversation_id:U,reference:question}},
  {account_id:A,conversation_id:U,event_id:'observed-outbound:'+dom,type:'OUTBOUND_OBSERVED',timestamp:(ms+322)/1000,detected_at:submitted+3.46,timestamp_source:'platform_ui',
    evidence:{source:'platform_ui',timestamp_source:'platform_ui',account_id:A,conversation_id:U,reference:dom,native_message_id:'jarvis-msg-'+dom.slice(3),historical_baseline:false,
      native_message_type:'TEXT',native_direction:'right',untrusted_message_text:T,observed_at:submitted+3.46}}]};}
function fixture(mutate,check){const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-readonly-original-')),db=path.join(runtime,'reception.sqlite3'),m=data();mutate?.(m);
  const script=`import sqlite3,json,sys
m=json.loads(sys.argv[2]);con=sqlite3.connect(sys.argv[1])
con.execute('CREATE TABLE outbox(intent_id TEXT,account_id TEXT,conversation_id TEXT,source_event_id TEXT,status TEXT,submitted_at REAL,payload TEXT,evidence TEXT)')
con.execute('CREATE TABLE events(account_id TEXT,conversation_id TEXT,event_id TEXT,type TEXT,timestamp REAL,detected_at REAL,timestamp_source TEXT,evidence TEXT)')
for row in m['outbox']:
 con.execute('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?)',tuple(json.dumps(row[k]) if k in ('payload','evidence') else row[k] for k in ('intent_id','account_id','conversation_id','source_event_id','status','submitted_at','payload','evidence')))
for row in m['events']:
 con.execute('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)',tuple(json.dumps(row[k]) if k=='evidence' else row[k] for k in ('account_id','conversation_id','event_id','type','timestamp','detected_at','timestamp_source','evidence')))
con.commit();con.close()`;
  try{execFileSync('/usr/bin/python3',['-B','-c',script,db,JSON.stringify(m)]);const hash=()=>createHash('sha256').update(fs.readFileSync(db)).digest('hex'),before=hash();
    check(()=>read(runtime,{accountId:A,uid:U,intentId:I}),m);assert.equal(hash(),before,'The original business-shaped SQLite must remain byte-for-byte unchanged');
  }finally{fs.rmSync(runtime,{recursive:true,force:true});}}
function exactPriorNativeEventIsReadWithoutChangingAnyDatabaseByte(){fixture(null,run=>{const anchor=run();assert.equal(anchor.existing_outbound_event_verified,true);assert.equal(anchor.original_source_event_id,question);
  assert.equal(anchor.event_id,'observed-outbound:'+dom);assert.equal(anchor.native_message_id,'jarvis-msg-'+dom.slice(3));assert.equal(anchor.platform_timestamp_ms,ms+322);});}
function missingAmbiguousOrAlreadyBoundDurableEventsCannotBecomeAnchors(){
  for(const mutate of [m=>m.events.pop(),m=>m.events[1].evidence.native_direction='left',m=>m.events[1].evidence.historical_baseline=true,m=>m.events[1].evidence.untrusted_message_text='another text',
    m=>m.events[1].evidence.native_message_id='jarvis-msg-'+A+'.'+U+'.different',m=>m.events[1].detected_at+=60,
    m=>{const other=JSON.parse(JSON.stringify(m.events[1]));other.event_id+='-second';other.evidence.reference+='-second';other.evidence.native_message_id+='-second';m.events.push(other);},
    m=>{for(let i=0;i<101;i++)m.events.push({...m.events[1],event_id:'untrusted-duplicate-'+i});},
    m=>m.outbox.push({...m.outbox[0],intent_id:'other-intent',evidence:{native_message_id:'jarvis-msg-'+dom.slice(3)}})])
    fixture(mutate,run=>assert.throws(run,/original_text_recovery_durable_anchor_required/));
}
function legacyOriginalMustStillBeUnknownTextWithBothIdsMissing(){for(const mutate of [m=>m.outbox[0].status='SENT',m=>m.outbox[0].payload.operation='native_card',m=>m.outbox[0].evidence.native_message_raw_id='already-known',
  m=>m.outbox[0].evidence.native_message_id='already-known',m=>m.events.shift()])fixture(mutate,run=>assert.throws(run,/original_text_recovery_durable_anchor_required/));}
for(const test of [exactPriorNativeEventIsReadWithoutChangingAnyDatabaseByte,missingAmbiguousOrAlreadyBoundDurableEventsCannotBecomeAnchors,legacyOriginalMustStillBeUnknownTextWithBothIdsMissing]){test();console.log('PASS '+test.name);}
console.log('3 read-only original native event anchor regressions passed; only temporary SQLite fixtures.');
