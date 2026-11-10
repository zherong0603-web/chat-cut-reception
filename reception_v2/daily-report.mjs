#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadAccountConfig } from './account-config.mjs';

const DAY_MS=24*60*60*1000;
const SHANGHAI_OFFSET_MS=8*60*60*1000;

export function shanghaiDayRange(date) {
  const value=String(date||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('invalid_report_date');
  const startMs=Date.parse(`${value}T00:00:00+08:00`);
  if(!Number.isFinite(startMs)||new Date(startMs+SHANGHAI_OFFSET_MS).toISOString().slice(0,10)!==value)throw new Error('invalid_report_date');
  return {date:value,startMs,endMs:startMs+DAY_MS,startIso:new Date(startMs).toISOString(),endIso:new Date(startMs+DAY_MS).toISOString()};
}

export function previousShanghaiDate(nowMs=Date.now()) {
  const shifted=new Date(nowMs+SHANGHAI_OFFSET_MS);
  shifted.setUTCDate(shifted.getUTCDate()-1);
  return shifted.toISOString().slice(0,10);
}

function number(row,key='n') { return Number(row?.[key]||0); }
function evidence(value) { try{return JSON.parse(value||'{}');}catch{return {};} }
function ratio(n,d) { return d>0?n/d:null; }
function percentile(values,p) {
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*p)-1))];
}
function displayRate(n,d) { return d>0?`${n}/${d}，${(n/d*100).toFixed(1)}%`:`0/0，无有效样本`; }

export function buildDailyReport(db,{accountId,date}) {
  if(!db||!accountId)throw new Error('report_database_and_account_required');
  const range=shanghaiDayRange(date);
  const eventWhere='account_id=? AND platform_time_ms>=? AND platform_time_ms<?';
  const inbound=db.prepare(`SELECT COUNT(*) n,COUNT(DISTINCT conversation_id) customers FROM events WHERE ${eventWhere} AND type='NEW_VISITOR'`).get(accountId,range.startMs,range.endMs);
  const openings=db.prepare(`SELECT COUNT(*) messages,COUNT(DISTINCT conversation_id) customers FROM events WHERE ${eventWhere} AND type='CUSTOMER_MESSAGE'`).get(accountId,range.startMs,range.endMs);
  const leads=db.prepare(`SELECT COUNT(DISTINCT conversation_id) customers,
    COUNT(DISTINCT CASE WHEN kind='lead_submitted' THEN conversation_id END) lead_submitted_customers,
    COUNT(DISTINCT CASE WHEN kind='wecom_added' THEN conversation_id END) wecom_added_customers
    FROM contacts WHERE account_id=? AND verified=1 AND observed_at_ms>=? AND observed_at_ms<?`).get(accountId,range.startMs,range.endMs);
  const rows=db.prepare(`SELECT o.intent_id,o.turn_id,o.kind,o.state,o.evidence_json,o.created_at,o.confirmed_at_ms,t.opened_at_ms
    FROM outbox o JOIN turns t ON t.turn_id=o.turn_id
    WHERE o.account_id=? AND o.created_at>=? AND o.created_at<?
    ORDER BY o.created_at,o.intent_id`).all(accountId,range.startIso,range.endIso);
  const states={sent:0,uncertain:0,failed:0,prepared:0,other:0};
  const textLatencies=[];
  const sentTextTurns=new Set();
  const sentCardTurns=new Set();
  const sentTextPlatformByTurn=new Map();
  const sentCardPlatformByTurn=new Map();
  for(const row of rows){
    if(Object.hasOwn(states,row.state))states[row.state]++;else states.other++;
    if(row.state!=='sent')continue;
    const payload=evidence(row.evidence_json);
    const platformTime=Number(payload.platformTimeMs);
    if(row.kind==='text'){
      sentTextTurns.add(row.turn_id);
      if(Number.isFinite(platformTime)){
        const latency=platformTime-Number(row.opened_at_ms);
        if(Number.isFinite(latency)&&latency>=0){
          textLatencies.push(latency);
          sentTextPlatformByTurn.set(row.turn_id,Math.min(sentTextPlatformByTurn.get(row.turn_id)??Infinity,platformTime));
        }
      }
    }else if(row.kind==='card'&&Number.isFinite(platformTime)){
      sentCardTurns.add(row.turn_id);
      sentCardPlatformByTurn.set(row.turn_id,Math.min(sentCardPlatformByTurn.get(row.turn_id)??Infinity,platformTime));
    }
  }
  const openedByTurn=new Map(rows.map(row=>[row.turn_id,Number(row.opened_at_ms)]));
  const textWithin3s=textLatencies.filter(ms=>ms<=3000).length;
  const completedPairs=[...sentTextTurns].filter(turnId=>sentCardTurns.has(turnId));
  const pairWithin3s=completedPairs.filter(turnId=>{
    const opened=openedByTurn.get(turnId),textAt=sentTextPlatformByTurn.get(turnId),cardAt=sentCardPlatformByTurn.get(turnId);
    return Number.isFinite(opened)&&Number.isFinite(textAt)&&Number.isFinite(cardAt)&&Math.max(textAt,cardAt)-opened<=3000;
  }).length;
  const terminal=states.sent+states.uncertain+states.failed;
  return {
    report_date:range.date,timezone:'Asia/Shanghai',window_start_utc:range.startIso,window_end_utc:range.endIso,
    inbound:{events:number(inbound),customers:number(inbound,'customers')},
    openings:{customers:number(openings,'customers'),messages:number(openings,'messages')},
    leads:{customers:number(leads,'customers'),lead_submitted_customers:number(leads,'lead_submitted_customers'),wecom_added_customers:number(leads,'wecom_added_customers')},
    replies:{
      attempted:rows.length,states,sent:states.sent,uncertain:states.uncertain,failed:states.failed,
      confirmed_rate:ratio(states.sent,terminal),
      text_sent:textLatencies.length,text_within_3s:textWithin3s,text_within_3s_rate:ratio(textWithin3s,textLatencies.length),
      median_text_platform_ms:percentile(textLatencies,.5),p95_text_platform_ms:percentile(textLatencies,.95),
      pair_turns:sentTextTurns.size,pair_completed:completedPairs.length,pair_within_3s:pairWithin3s,pair_within_3s_rate:ratio(pairWithin3s,completedPairs.length),
    },
  };
}

export function renderDailyReport(report) {
  const r=report.replies;
  const confirmedRate=r.confirmed_rate==null?'无有效样本':`${(r.confirmed_rate*100).toFixed(1)}%`;
  const median=r.median_text_platform_ms==null?'无':`${r.median_text_platform_ms} ms`;
  const p95=r.p95_text_platform_ms==null?'无':`${r.p95_text_platform_ms} ms`;
  return [
    `# 小红书接待日报｜${report.report_date}`,
    '',
    `统计时区：${report.timezone}；完整窗口：当日 00:00 至次日 00:00。`,
    '',
    `- 总进线：${report.inbound.events} 次，${report.inbound.customers} 位客户`,
    `- 开口：${report.openings.customers} 位客户，${report.openings.messages} 条真实客户消息`,
    `- 留资：${report.leads.customers} 位客户；留资卡 ${report.leads.lead_submitted_customers} 位；已加企微 ${report.leads.wecom_added_customers} 位`,
    `- 3 秒内文字回复：${displayRate(r.text_within_3s,r.text_sent)}`,
    `- 文字平台提交耗时：中位数 ${median}；P95 ${p95}`,
    `- 文字与企微卡同时 3 秒内：${displayRate(r.pair_within_3s,r.pair_completed)}`,
    `- 发送闭环率：${displayRate(r.sent,r.sent+r.uncertain+r.failed)}；确认率 ${confirmedRate}`,
    `- 发送状态：已确认 ${r.sent}，待核实 ${r.uncertain}，失败 ${r.failed}`,
    '',
    '口径：进线按 NEW_VISITOR 事件；开口按当天出现 CUSTOMER_MESSAGE 的去重客户；留资按当天 verified 联系人去重；3 秒率只统计已确认文字，并用平台提交时间减本轮首条客户消息时间计算。',
  ].join('\n');
}

function argValue(args,flag,fallback=null){const i=args.indexOf(flag);return i>=0&&args[i+1]?args[i+1]:fallback;}
if(import.meta.url===new URL(process.argv[1],'file:').href){
  const args=process.argv.slice(2);
  const account=loadAccountConfig({cwd:process.cwd(),env:process.env});
  const dbPath=path.resolve(argValue(args,'--db',path.join(account.runtimeDir,'reception-v2.sqlite3')));
  const date=argValue(args,'--date',previousShanghaiDate());
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const report=buildDailyReport(db,{accountId:account.accountId,date});
    console.log(args.includes('--json')?JSON.stringify(report,null,2):renderDailyReport(report));
  }finally{db.close();}
}
