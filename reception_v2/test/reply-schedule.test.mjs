import test from 'node:test';
import assert from 'node:assert/strict';
import { replyWindowState, sidebarTimeInReplyWindow } from '../reply-schedule.mjs';
const at=value=>Date.parse(value);

test('daily reply windows are 07:00-09:00 and 18:00-24:00 Shanghai, retaining the midnight submit guard',()=>{
 for(const [time,allowed] of [
  ['06:59:59',false],['07:00:00',true],['08:59:59',true],['09:00:00',false],
  ['17:59:59',false],['18:00:00',true],['23:59:29',true],['23:59:30',false],['00:00:00',false],
 ])assert.equal(replyWindowState(at(`2026-11-21T${time}+08:00`)).allowed,allowed,time);
 assert.equal(replyWindowState(at('2026-11-21T09:00:00Z')).allowed,false,'17:00 Shanghai is closed');
 assert.equal(replyWindowState(at('2026-11-20T23:00:00Z')).allowed,true,'07:00 Shanghai is open');
});

test('reply window state retains stable operational fields',()=>{
 assert.deepEqual(replyWindowState(at('2026-11-21T20:15:00+08:00')),{
  allowed:true,timezone:'Asia/Shanghai',localDate:'2026-11-21',localTime:'20:15:00',reason:'open',
 });
});

test('sidebar eligibility validates clocks and matches the currently active segment',()=>{
 for(const value of ['07:00','08:59:59','18:00:00','23:59:00'])assert.equal(sidebarTimeInReplyWindow(value),true,value);
 for(const value of ['06:59:59','09:00:00','17:59:59','23:59:30','24:01:00','18:99:00','18:00:60','10/30'])assert.equal(sidebarTimeInReplyWindow(value),false,value);
 assert.equal(sidebarTimeInReplyWindow('08:30:00','18:10:00'),false,'evening must not revive morning history');
 assert.equal(sidebarTimeInReplyWindow('18:01:00','18:10:00'),true);
 assert.equal(sidebarTimeInReplyWindow('07:01:00','07:10:00'),true);
 assert.equal(sidebarTimeInReplyWindow('23:00:00','07:10:00'),false,'morning must not revive prior evening history');
});

test('historical all-day override remains bounded by its configured date and midnight guard',()=>{
 const options={overrideDates:['2026-11-02']};
 const extra=replyWindowState(at('2026-11-02T11:00:00+08:00'),options);
 assert.equal(extra.allowed,true);assert.equal(extra.reason,'date_override');assert.equal(extra.allDay,true);
 assert.equal(replyWindowState(at('2026-11-02T23:59:30+08:00'),options).allowed,false);
 assert.equal(replyWindowState(at('2026-11-03T00:00:00+08:00'),options).allowed,false);
 assert.equal(replyWindowState(at('2026-11-03T11:00:00+08:00'),options).allowed,false);
 assert.equal(replyWindowState(at('2026-11-03T07:30:00+08:00'),options).allowed,true);
 assert.equal(replyWindowState(at('2026-11-03T18:30:00+08:00'),options).allowed,true);
});
