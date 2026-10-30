export const REPLY_TIME_ZONE='Asia/Shanghai';
export const REPLY_WINDOW_START='19:00:00';
export const REPLY_WINDOW_LAST_SEND='23:59:29';
const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:REPLY_TIME_ZONE,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});

function shanghaiParts(nowMs=Date.now()){
  const values=Object.fromEntries(formatter.formatToParts(new Date(nowMs)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return {year:values.year,month:values.month,day:values.day,hour:Number(values.hour),minute:Number(values.minute),second:Number(values.second)};
}

export function replyWindowState(nowMs=Date.now()){
  const p=shanghaiParts(nowMs),localDate=`${p.year}-${p.month}-${p.day}`;
  const pad=n=>String(n).padStart(2,'0');
  const localTime=`${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
  const seconds=p.hour*3600+p.minute*60+p.second;
  const allowed=seconds>=19*3600&&seconds<24*3600-30;
  return {allowed,timezone:REPLY_TIME_ZONE,localDate,localTime,reason:allowed?'open':seconds>=24*3600-30?'cutoff':'closed'};
}

export function createReplySchedule({now=Date.now}={}){
  return Object.freeze({isAllowed:()=>replyWindowState(now()).allowed,state:()=>replyWindowState(now())});
}

export function sidebarTimeInReplyWindow(value){
  const match=/^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value||'').trim());
  if(!match)return false;
  const hour=Number(match[1]);return hour>=19&&hour<=23;
}
