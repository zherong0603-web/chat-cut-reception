import test from 'node:test';
import assert from 'node:assert/strict';
import { replyWindowState } from '../reply-schedule.mjs';

const at = value => Date.parse(value);

test('reply window is 19:00 through 23:59:29 Asia/Shanghai',()=>{
  assert.equal(replyWindowState(at('2026-10-30T18:59:59+08:00')).allowed,false);
  assert.equal(replyWindowState(at('2026-10-30T19:00:00+08:00')).allowed,true);
  assert.equal(replyWindowState(at('2026-10-30T23:59:29+08:00')).allowed,true);
  assert.equal(replyWindowState(at('2026-10-30T23:59:30+08:00')).allowed,false);
  assert.equal(replyWindowState(at('2026-10-31T00:00:00+08:00')).allowed,false);
  assert.equal(replyWindowState(at('2026-10-31T18:59:59+08:00')).allowed,false);
});

test('reply window state exposes stable operational fields',()=>{
  assert.deepEqual(replyWindowState(at('2026-10-30T20:15:00+08:00')),{
    allowed:true,
    timezone:'Asia/Shanghai',
    localDate:'2026-10-30',
    localTime:'20:15:00',
    reason:'open',
  });
});

test('sidebar clock times outside 19:00–23:59 are not eligible for startup replies',async()=>{
  const {sidebarTimeInReplyWindow}=await import('../reply-schedule.mjs');
  assert.equal(sidebarTimeInReplyWindow('18:59:59'),false);
  assert.equal(sidebarTimeInReplyWindow('19:00:00'),true);
  assert.equal(sidebarTimeInReplyWindow('23:59:00'),true);
  assert.equal(sidebarTimeInReplyWindow('10/30'),false);
});
