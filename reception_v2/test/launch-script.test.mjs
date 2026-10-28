import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('launcher forwards pilot arguments and leaves notifier ownership to main', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reception-v2-launcher-'));
  const fake=path.join(dir,'node-stub');
  const record=path.join(dir,'args.json');
  fs.writeFileSync(fake,`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\n`,'utf8');
  fs.chmodSync(fake,0o700);
  try {
    const result=spawnSync(path.resolve('reception_v2/launch-reception-v2.sh'),['--pilot-one'],{encoding:'utf8',env:{...process.env,NODE_BIN:fake},cwd:path.resolve('.')});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(fs.readFileSync(record,'utf8').trim().split('\n'),['reception_v2/main.mjs','run','--arm','--pilot-one']);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
