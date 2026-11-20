export const REPLY_TIME_ZONE='Asia/Shanghai';
export const REPLY_WINDOW_START='07:00:00';
export const REPLY_WINDOW_LAST_SEND='23:59:29';
export const REPLY_WINDOW_DESCRIPTION='每天07:00至09:00、18:00至24:00（23:59:30起停止提交新消息）';
const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:REPLY_TIME_ZONE,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});

function shanghaiParts(nowMs=Date.now()){
  const values=Object.fromEntries(formatter.formatToParts(new Date(nowMs)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return {year:values.year,month:values.month,day:values.day,hour:Number(values.hour),minute:Number(values.minute),second:Number(values.second)};
}

export function replyWindowState(nowMs=Date.now(),{overrideDates=[]}={}){
  const p=shanghaiParts(nowMs),localDate=`${p.year}-${p.month}-${p.day}`;
  const pad=n=>String(n).padStart(2,'0');
  const localTime=`${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
  const seconds=p.hour*3600+p.minute*60+p.second,cutoff=seconds>=24*3600-30;
  const override=overrideDates.includes(localDate);
  const allowed=override?!cutoff:replySegment(seconds)!==null;
  return {allowed,timezone:REPLY_TIME_ZONE,localDate,localTime,reason:override?(allowed?'date_override':'cutoff'):allowed?'open':cutoff?'cutoff':'closed',...(override?{allDay:true,overrideDate:localDate}:{})};
}

export function createReplySchedule({now=Date.now,overrideDates=[]}={}){
  return Object.freeze({isAllowed:()=>replyWindowState(now(),{overrideDates}).allowed,state:()=>replyWindowState(now(),{overrideDates})});
}

function replySegment(seconds){
  if(seconds>=7*3600&&seconds<9*3600)return 'morning';
  if(seconds>=18*3600&&seconds<24*3600-30)return 'evening';
  return null;
}

function clockSeconds(value){
  const match=/^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value||'').trim());
  if(!match)return null;
  const hour=Number(match[1]),minute=Number(match[2]),second=Number(match[3]||0);
  if(hour>23||minute>59||second>59)return null;
  return hour*3600+minute*60+second;
}

export function sidebarTimeInReplyWindow(value,currentLocalTime=null){
  const seconds=clockSeconds(value);
  if(seconds===null)return false;
  const segment=replySegment(seconds);
  if(segment===null)return false;
  if(currentLocalTime===null)return true;
  const currentSeconds=clockSeconds(currentLocalTime);
  return currentSeconds!==null&&replySegment(currentSeconds)===segment;
}

export function replyWindowStartMs(nowMs=Date.now(),options={}){
  if(!Number.isFinite(nowMs))return null;
  const current=replyWindowState(nowMs,options);
  if(!current.allowed)return null;
  const hour=current.allDay===true?'00':clockSeconds(current.localTime)<9*3600?'07':'18';
  return Date.parse(`${current.localDate}T${hour}:00:00+08:00`);
}

export function platformTimeInReplyWindow(platformTimeMs,nowMs=Date.now(),options={}){
  if(!Number.isFinite(platformTimeMs)||!Number.isFinite(nowMs)||platformTimeMs>nowMs)return false;
  const startMs=replyWindowStartMs(nowMs,options);
  return startMs!==null&&platformTimeMs>=startMs;
}

export function assertReplySourceWindow(replySchedule,platformTimeMs,nowMs=Date.now()){
  if(!replySchedule)return;
  if(replySchedule.isAllowed()!==true){const error=new Error('outside_reply_hours');error.code='outside_reply_hours';throw error;}
  const window=replySchedule.state?.()||{};
  if(!platformTimeInReplyWindow(platformTimeMs,nowMs,{overrideDates:window.allDay===true?[window.overrideDate]:[]})){
    const error=new Error('outside_reply_hours: outside_inbound_reply_window');error.code='outside_reply_hours';throw error;
  }
}
