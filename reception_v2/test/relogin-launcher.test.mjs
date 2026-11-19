import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

for(const exitCode of [0,17])test(`user launcher selects the installed Node runtime and preserves exit ${exitCode}`,()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relogin launcher '));
 try{
  const stub=path.join(dir,'installed node');const record=path.join(dir,'args');const plist=path.join(dir,'service.plist');
  fs.writeFileSync(stub,`#!/bin/sh\nprintf '%s\\n' "$@" > "$RECEPTION_TEST_RECORD"\nexit ${exitCode}\n`,{mode:0o700});
  const xml=stub.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  fs.writeFileSync(plist,`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>ProgramArguments</key><array><string>${xml}</string></array></dict></plist>`);
  const result=spawnSync('/bin/zsh',[path.resolve('重新登录小红书.command')],{cwd:dir,input:'\n',encoding:'utf8',env:{...process.env,XHS_RECEPTION_PLIST:plist,RECEPTION_TEST_RECORD:record}});
  assert.equal(result.status,exitCode,result.stderr);
  assert.deepEqual(fs.readFileSync(record,'utf8').trim().split('\n'),['reception_v2/relogin-service.mjs','--run']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
