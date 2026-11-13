#!/usr/bin/env node
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadAccountConfig } from './account-config.mjs';

const DAY_MS=24*60*60*1000;
const EVENING_START_MS=18*60*60*1000;
// Historical outbox rows lack a purpose field. Match the exact orchestrator acknowledgment.
const CARD_CLICK_ACK_TEXT='看到您点击企微卡了，客服小姐姐会在企微里回复您，请留意消息～';
const SHANGHAI_OFFSET_MS=8*60*60*1000;

export function shanghaiDayRange(date) {
  const value=String(date||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('invalid_report_date');
  const startMs=Date.parse(`${value}T00:00:00+08:00`);
  if(!Number.isFinite(startMs)||new Date(startMs+SHANGHAI_OFFSET_MS).toISOString().slice(0,10)!==value)throw new Error('invalid_report_date');
  return {date:value,startMs,endMs:startMs+DAY_MS,startIso:new Date(startMs).toISOString(),endIso:new Date(startMs+DAY_MS).toISOString()};
}
export function previousShanghaiDate(nowMs=Date.now()) {
  const shifted=new Date(nowMs+SHANGHAI_OFFSET_MS);shifted.setUTCDate(shifted.getUTCDate()-1);return shifted.toISOString().slice(0,10);
}
function evidence(value) { try{return JSON.parse(value||'{}');}catch{return {};} }
function ratio(n,d) { return d>0?n/d:null; }
function displayRate(n,d) { return d>0?`${n}/${d}，${(n/d*100).toFixed(1)}%`:'0/0，无有效样本'; }
function unique(items,key='conversation_id'){return new Set(items.map(item=>item[key]).filter(Boolean));}
function platformTime(row){const receipt=evidence(row.evidence_json);return receipt?.verified===true&&Number.isFinite(receipt.platformTimeMs)?receipt.platformTimeMs:null;}
function earliestAfter(rows,uid,timestamp,endMs,turnIds=null){let best=null;for(const row of rows){if(row.conversation_id!==uid||row.kind!=='text'||row.content===CARD_CLICK_ACK_TEXT||row.state!=='sent'||(turnIds&&!turnIds.has(row.turn_id)))continue;const at=platformTime(row);if(at==null||at<timestamp||at>=endMs)continue;if(best==null||at<best)best=at;}return best;}

export function buildDailyReport(db,{accountId,date}) {
  if(!db||!accountId)throw new Error('report_database_and_account_required');
  const day=shanghaiDayRange(date);const startMs=day.startMs+EVENING_START_MS,endMs=day.endMs;
  const inboundRows=db.prepare("SELECT conversation_id,event_id,platform_time_ms FROM events WHERE account_id=? AND type='NEW_VISITOR' AND platform_time_ms>=? AND platform_time_ms<?").all(accountId,startMs,endMs);
  const inboundByCustomer=new Map();for(const row of inboundRows)inboundByCustomer.set(row.conversation_id,Math.min(inboundByCustomer.get(row.conversation_id)??Infinity,row.platform_time_ms));
  const inboundCustomers=unique(inboundRows);
  const customerMessageRows=db.prepare("SELECT conversation_id,event_id,platform_time_ms FROM events WHERE account_id=? AND type='CUSTOMER_MESSAGE' AND platform_time_ms>=? AND platform_time_ms<?").all(accountId,startMs,endMs);
  const cohortOpenedRows=customerMessageRows.filter(row=>row.platform_time_ms>=(inboundByCustomer.get(row.conversation_id)??Infinity));
  const openedByCustomer=new Map();
  for(const row of cohortOpenedRows.sort((a,b)=>a.platform_time_ms-b.platform_time_ms||a.event_id.localeCompare(b.event_id))){
    if(!openedByCustomer.has(row.conversation_id))openedByCustomer.set(row.conversation_id,row);
  }
  const openingTurns=db.prepare('SELECT turn_id FROM turn_inbound_events WHERE event_id=?');
  const cardClickRows=db.prepare("SELECT conversation_id,event_id,platform_time_ms FROM events WHERE account_id=? AND type='CARD_CLICK' AND platform_time_ms>=? AND platform_time_ms<?").all(accountId,startMs,endMs);
  const allContacts=db.prepare('SELECT conversation_id,kind,source,verified FROM contacts WHERE account_id=? AND verified=1').all(accountId).filter(row=>inboundCustomers.has(row.conversation_id));
  const contactKinds=new Map();for(const row of allContacts){const set=contactKinds.get(row.conversation_id)||new Set();set.add(row.kind);contactKinds.set(row.conversation_id,set);}
  const actualContacts=allContacts.filter(row=>row.kind==='wecom_added'||row.kind==='phone'||row.kind==='wechat'||(row.kind==='lead_submitted'&&row.source!=='sidebar'));
  const leadCustomers=unique(actualContacts),wecomCustomers=unique(allContacts.filter(row=>row.kind==='wecom_added')),leadSubmittedCustomers=unique(actualContacts.filter(row=>row.kind==='lead_submitted')),phoneWechatCustomers=unique(actualContacts.filter(row=>row.kind==='phone'||row.kind==='wechat'));
  const sidebarOnlyCustomers=new Set([...contactKinds].filter(([uid,kinds])=>kinds.has('lead_submitted')&&!leadCustomers.has(uid)).map(([uid])=>uid));
  const outboxRows=db.prepare(`SELECT o.intent_id,o.turn_id,o.conversation_id,o.kind,o.state,o.content,o.evidence_json,o.created_at
    FROM outbox o WHERE o.account_id=? AND o.created_at>=? AND o.created_at<? ORDER BY o.created_at,o.intent_id`).all(accountId,new Date(startMs).toISOString(),day.endIso).filter(row=>inboundCustomers.has(row.conversation_id));
  const states={sent:0,uncertain:0,failed:0,prepared:0,other:0};for(const row of outboxRows){if(Object.hasOwn(states,row.state))states[row.state]++;else states.other++;}
  const repliedAfterOpen=[],within3sAfterOpen=[],initialReplied=[],within3sInitial=[];const repliedTimes=[],initialTimes=[];
  for(const [uid,newAt] of inboundByCustomer){const initialAt=earliestAfter(outboxRows,uid,newAt,endMs);if(initialAt!=null){initialReplied.push(uid);initialTimes.push(initialAt-newAt);if(initialAt-newAt<=3000)within3sInitial.push(uid);}const opening=openedByCustomer.get(uid);if(!opening)continue;const openedAt=opening.platform_time_ms;const turnIds=unique(openingTurns.all(opening.event_id),'turn_id');const replyAt=earliestAfter(outboxRows,uid,openedAt,endMs,turnIds);if(replyAt!=null){repliedAfterOpen.push(uid);repliedTimes.push(replyAt-openedAt);if(replyAt-openedAt<=3000)within3sAfterOpen.push(uid);}}
  const uncertainCustomers=unique(outboxRows.filter(row=>row.state==='uncertain')),failedCustomers=unique(outboxRows.filter(row=>row.state==='failed')),confirmedCardCustomers=unique(outboxRows.filter(row=>row.kind==='card'&&row.state==='sent'));
  return {
    report_date:day.date,timezone:'Asia/Shanghai',window_local:'18:00:00-23:59:59',window_start_utc:new Date(startMs).toISOString(),window_end_utc:new Date(endMs).toISOString(),
    inbound:{events:inboundRows.length,customers:inboundCustomers.size},
    openings:{customers:openedByCustomer.size,messages:cohortOpenedRows.length,all_window_customers:unique(customerMessageRows).size},
    leads:{customers:leadCustomers.size,wecom_added_customers:wecomCustomers.size,lead_submitted_customers:leadSubmittedCustomers.size,phone_or_wechat_customers:phoneWechatCustomers.size,sidebar_tag_only_customers:sidebarOnlyCustomers.size},
    card_clicks:{customers:unique(cardClickRows.filter(row=>inboundCustomers.has(row.conversation_id))).size,events:cardClickRows.filter(row=>inboundCustomers.has(row.conversation_id)).length},
    replies:{outbox_items:outboxRows.length,states,sent_customers:unique(outboxRows.filter(row=>row.state==='sent')).size,sent:states.sent,uncertain:states.uncertain,failed:states.failed,
      confirmed_after_open_customers:repliedAfterOpen.length,within_3s_after_open_customers:within3sAfterOpen.length,within_3s_after_open_rate:ratio(within3sAfterOpen.length,openedByCustomer.size),median_after_open_ms:repliedTimes.length?[...repliedTimes].sort((a,b)=>a-b)[Math.ceil(repliedTimes.length*.5)-1]:null,
      confirmed_initial_customers:initialReplied.length,within_3s_initial_customers:within3sInitial.length,within_3s_initial_rate:ratio(within3sInitial.length,inboundCustomers.size),median_initial_ms:initialTimes.length?[...initialTimes].sort((a,b)=>a-b)[Math.ceil(initialTimes.length*.5)-1]:null,
      uncertain_customers:uncertainCustomers.size,failed_customers:failedCustomers.size,confirmed_card_customers:confirmedCardCustomers.size},
  };
}

export function renderDailyReport(report) {
  const r=report.replies;const openingRate=report.openings.customers>0?`${(r.confirmed_after_open_customers/report.openings.customers*100).toFixed(1)}%`:'无有效样本';
  return [
    `# 小红书晚间接待日报｜${report.report_date}`,
    '',
    `统计窗口：北京时间 ${report.window_local}。所有漏斗指标只统计该时段新进线客户。`,
    '',
    `- 晚间进线：${report.inbound.events} 次，${report.inbound.customers} 位客户`,
    `- 开口：${report.openings.customers}/${report.inbound.customers} 位进线客户，${report.openings.messages} 条真实客户消息`,
    `- 其他窗口内开口但非本批新进线：${Math.max(0,report.openings.all_window_customers-report.openings.customers)} 位，未计入本次漏斗`,
    `- 有效留资：${report.leads.customers} 位客户`,
    `- 已添加企微：${report.leads.wecom_added_customers} 位客户`,
    `- 已验证手机或微信：${report.leads.phone_or_wechat_customers} 位客户`,
    `- 已提交留资卡：${report.leads.lead_submitted_customers} 位客户`,
    `- 仅有侧栏留资标签但资料未核实：${report.leads.sidebar_tag_only_customers} 位客户`,
    `- 企微卡点击：${report.card_clicks.customers} 位客户`,
    '',
    `- 开口客户已确认回复：${r.confirmed_after_open_customers}/${report.openings.customers}，${openingRate}`,
    `- 开口后 3 秒内回复：${displayRate(r.within_3s_after_open_customers,report.openings.customers)}`,
    `- 开口后回复耗时中位数：${r.median_after_open_ms==null?'无有效样本':`${r.median_after_open_ms} ms`}`,
    `- 进线后 3 秒内首条回复：${displayRate(r.within_3s_initial_customers,report.inbound.customers)}`,
    `- 进线后首条回复耗时中位数：${r.median_initial_ms==null?'无有效样本':`${r.median_initial_ms} ms`}`,
    `- 待核实客户：${r.uncertain_customers} 位；失败客户：${r.failed_customers} 位`,
    `- 已确认发送（含名片）：${r.sent} 条；待核实发送：${r.uncertain} 条；失败发送：${r.failed} 条`,
    '',
    '口径：进线使用 NEW_VISITOR；开口只计算本批晚间进线 UID 在窗口内的 CUSTOMER_MESSAGE；留资以客户资料中已验证的已加企微、手机、微信或真实提交留资卡为准，仅有侧栏“留客资/留资客”标签不冒充有效留资。开口回复只统计与首条客户消息绑定的接待轮次。企微卡点击提示不计入两项回复时效。3 秒率以全体开口或进线客户为分母，耗时使用平台消息时间，中位数只统计已确认回复。企微添加为资料观察结果，未必发生在该统计窗口。',
  ].join('\n');
}

function argValue(args,flag,fallback=null){const i=args.indexOf(flag);return i>=0&&args[i+1]?args[i+1]:fallback;}
if(import.meta.url===new URL(process.argv[1],'file:').href){
  const args=process.argv.slice(2);const account=loadAccountConfig({cwd:process.cwd(),env:process.env});const dbPath=path.resolve(argValue(args,'--db',path.join(account.runtimeDir,'reception-v2.sqlite3')));const date=argValue(args,'--date',previousShanghaiDate());const db=new DatabaseSync(dbPath,{readOnly:true});
  try{const report=buildDailyReport(db,{accountId:account.accountId,date});console.log(args.includes('--json')?JSON.stringify(report,null,2):renderDailyReport(report));}finally{db.close();}
}
