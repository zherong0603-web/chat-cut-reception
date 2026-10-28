import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAccountConfig } from '../account-config.mjs';

const defaultAccount='66879fef000000001c002839';
const cardB={title:'企微_账号B（企微）',visibleName:'账号B（企微）',id:'100200300',csaAccountNo:'9988776655',corpName:'@账号B企业'};

test('account configuration keeps the current account compatible by default',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reception-account-'));try{const value=loadAccountConfig({cwd:dir,env:{}});assert.equal(value.accountId,defaultAccount);assert.equal(value.accountName,'运去哪海外仓');assert.equal(value.runtimeDir,path.join(dir,'.runtime'));assert.deepEqual(value.card,{title:'企微_运去哪海外仓（企微）',visibleName:'运去哪海外仓（企微）',id:'2779776',csaAccountNo:'8694696952',corpName:'@运去哪物流科技集团'});}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('local account file selects account B and its isolated runtime',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reception-account-'));try{const config=path.join(dir,'account.json');fs.writeFileSync(config,JSON.stringify({accountId:'bbbbbbbbbbbbbbbbbbbbbbbb',accountName:'账号B',runtimeDir:'runtime-b',card:cardB}));const value=loadAccountConfig({cwd:dir,env:{XHS_ACCOUNT_CONFIG:config}});assert.equal(value.accountId,'bbbbbbbbbbbbbbbbbbbbbbbb');assert.equal(value.accountName,'账号B');assert.equal(value.runtimeDir,path.join(dir,'runtime-b'));assert.deepEqual(value.card,cardB);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('environment overrides compatible file values and rejects malformed ids',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reception-account-'));try{const config=path.join(dir,'account.json');fs.writeFileSync(config,JSON.stringify({accountId:'bbbbbbbbbbbbbbbbbbbbbbbb',accountName:'账号B',runtimeDir:'runtime-b',card:cardB}));const value=loadAccountConfig({cwd:dir,env:{XHS_ACCOUNT_CONFIG:config,XHS_ACCOUNT_ID:'bbbbbbbbbbbbbbbbbbbbbbbb',XHS_ACCOUNT_NAME:'账号C',XHS_RUNTIME_DIR:'runtime-c'}});assert.equal(value.accountId,'bbbbbbbbbbbbbbbbbbbbbbbb');assert.equal(value.accountName,'账号C');assert.equal(value.runtimeDir,path.join(dir,'runtime-c'));assert.throws(()=>loadAccountConfig({cwd:dir,env:{XHS_ACCOUNT_ID:'bad'}}),/invalid_account_id/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a different account cannot silently inherit account A card identity',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reception-account-'));try{
    assert.throws(()=>loadAccountConfig({cwd:dir,env:{XHS_ACCOUNT_ID:'bbbbbbbbbbbbbbbbbbbbbbbb',XHS_ACCOUNT_NAME:'账号B'}}),/card_config_required/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('account.local.json is discovered without an environment variable',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reception-account-'));try{
    const configDir=path.join(dir,'reception_v2','config');fs.mkdirSync(configDir,{recursive:true});
    fs.writeFileSync(path.join(configDir,'account.local.json'),JSON.stringify({accountId:'bbbbbbbbbbbbbbbbbbbbbbbb',accountName:'账号B',runtimeDir:'.runtime-b',card:cardB}));
    const value=loadAccountConfig({cwd:dir,env:{}});
    assert.equal(value.accountId,'bbbbbbbbbbbbbbbbbbbbbbbb');assert.equal(value.runtimeDir,path.join(dir,'.runtime-b'));assert.deepEqual(value.card,cardB);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('an explicit account config path must exist',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reception-account-'));try{
    assert.throws(()=>loadAccountConfig({cwd:dir,env:{XHS_ACCOUNT_CONFIG:'missing.json'}}),/account_config_not_found/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
