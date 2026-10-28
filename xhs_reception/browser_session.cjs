// Persistent isolated UI reception. Never opens daily browsers or desktop input.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const {performance} = require('node:perf_hooks');
const root = path.resolve(__dirname, "..");
const runtime = path.join(root, '.runtime');
const profile = path.join(runtime, 'isolated-browser-profile');
const origin = 'https://sxt.xiaohongshu.com';
const emit = data => process.stdout.write(JSON.stringify({at:new Date().toISOString(),...data})+'\n');
let context;
let input,shutdownRequested=false,shutdownResolve;
function shutdown(){shutdownRequested=true;input?.close();shutdownResolve?.();}
process.once('SIGTERM',shutdown);
process.once('SIGINT',shutdown);
async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--allow-isolated-browser')) {
    emit({type:'blocked',status:'BLOCKED_BY_HUMAN',reason:'explicit_isolated_browser_authorization_required',browser_started:false});
    process.exitCode=3;
    return;
  }
  if (args.some(value => !['--allow-isolated-browser','--start-reception-worker','--daemon','--future-entries-only'].includes(value))) throw new Error('unsupported_session_argument');
  const autostart=args.includes('--start-reception-worker');
  const futureEntriesOnly=args.includes('--future-entries-only');
  if(args.includes('--daemon')&&!autostart) throw new Error('daemon_requires_reception_worker');
  if(futureEntriesOnly&&!autostart) throw new Error('future_entries_only_requires_reception_worker');
  if (!process.env.XHS_PLAYWRIGHT_MODULE || !path.isAbsolute(process.env.XHS_PLAYWRIGHT_MODULE)) throw new Error('absolute_existing_playwright_module_required');
  for (const dir of [runtime, profile]) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('profile_symlink_rejected');
    fs.mkdirSync(dir, {recursive:true,mode:0o700});
    fs.chmodSync(dir,0o700);
  }
  const {chromium}=require(process.env.XHS_PLAYWRIGHT_MODULE);
  context=await chromium.launchPersistentContext(profile,{
    headless:true,chromiumSandbox:true,acceptDownloads:false,
    viewport:{width:1280,height:800}
  });
  await context.route('**/*',async route=>{
    const req=route.request();
    if(req.isNavigationRequest() && new URL(req.url()).origin!==origin) return route.abort('blockedbyclient');
    return route.continue();
  });
  const page=context.pages()[0]||await context.newPage();
  page.setDefaultTimeout(3000);
  page.setDefaultNavigationTimeout(15000);
  const navStarted=performance.now();
  const response=await page.goto(origin+(autostart?'/im/multiCustomerService':'/im/login'),{waitUntil:autostart?'commit':'domcontentloaded'});
  if(autostart) await page.locator('.contact-tab-wrap .d-tabs-header').filter({hasText:'全部会话',visible:true})
    .waitFor({state:'visible',timeout:30000});
  const navMs=performance.now()-navStarted;
  const samples=[];
  for(let i=0;i<5;i++) {
    const started=performance.now();
    const observed=await page.evaluate(()=>({ready:document.readyState,body:!!document.body}));
    samples.push({elapsed_ms:performance.now()-started,...observed});
  }
  const screenshot=path.join(runtime,'xhs-isolated-session-initial.png');
  await page.screenshot({path:screenshot,fullPage:false});
  emit({type:'ready',headless:true,isolated_profile:profile,http_status:response?.status(),navigation_ms:navMs,dom_samples:samples,screenshot,live_reception_ready:false});
  if(autostart){
    const result=await require('./ui_actions.cjs').run({page,context,
      cmd:{operation:'bootstrap_reception',future_entries_only:futureEntriesOnly},runtime});
    emit({type:'reception_worker_started',result,full_five_second_acceptance:false});
  }
  input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of input) {
    let cmd;
    try {
      cmd=JSON.parse(line);
      const started=performance.now();
      if(cmd.action==='state') {
        const url=new URL(page.url());
        emit({type:'state',request_id:cmd.request_id,url:url.origin+url.pathname,title:await page.title(),untrusted_context_text:await page.locator('body').innerText(),classification:'context_only_not_receipt',elapsed_ms:performance.now()-started});
      } else if(cmd.action==='measure') {
        const observed=await page.evaluate(()=>({title:document.title,ready:document.readyState,body:!!document.body}));
        emit({type:'measure',request_id:cmd.request_id,elapsed_ms:performance.now()-started,...observed});
      } else if(cmd.action==='screenshot') {
        const name=typeof cmd.name==='string'?cmd.name:'xhs-isolated-current.png';
        if(!/^[a-zA-Z0-9_-]+\.png$/.test(name)) throw new Error('invalid_screenshot_name');
        const file=path.join(runtime,name);
        await page.screenshot({path:file,fullPage:false});
        emit({type:'screenshot',request_id:cmd.request_id,path:file,elapsed_ms:performance.now()-started});
      } else if(cmd.action==='login_qr') {
        if(new URL(page.url()).pathname!=='/im/login') throw new Error('not_on_login_page');
        if(await page.getByText('手机登录',{exact:true}).count()!==1) throw new Error('phone_login_not_observed');
        const buttons=page.locator('button.logo-btn');
        if(await buttons.count()!==2) throw new Error('login_controls_changed');
        await buttons.nth(1).click();
        await page.getByRole('heading',{name:'扫码登录',exact:true}).waitFor({state:'visible'});
        emit({type:'login_qr',request_id:cmd.request_id,text:await page.locator('body').innerText(),elapsed_ms:performance.now()-started});
      } else if(cmd.action==='refresh_qr') {
        if(new URL(page.url()).pathname!=='/im/login') throw new Error('not_on_login_page');
        if(!(await page.locator('body').innerText()).includes('二维码已过期')) throw new Error('qr_not_observed_expired');
        await page.getByRole('button',{name:'刷新',exact:true}).click();
        await page.getByText('二维码已过期',{exact:true}).waitFor({state:'hidden'});
        emit({type:'refresh_qr',request_id:cmd.request_id,elapsed_ms:performance.now()-started});
      } else if(cmd.action==='inspect') {
        if(typeof cmd.selector!=='string' || cmd.selector.length>1000) throw new Error('invalid_selector');
        const rows=await page.locator(cmd.selector).evaluateAll(nodes=>nodes.slice(0,100).map(n=>({tag:n.tagName,html:n.outerHTML.slice(0,18000),visible:!!(n.getClientRects().length)})));
        emit({type:'inspect',request_id:cmd.request_id,selector:cmd.selector,rows,elapsed_ms:performance.now()-started});
      } else if(cmd.action==='module') {
        const moduleFile=path.join(root,'xhs_reception','ui_actions.cjs');
        delete require.cache[require.resolve(moduleFile)];
        const result=await require(moduleFile).run({page,context,cmd,runtime});
        emit({type:'module',request_id:cmd.request_id,result,elapsed_ms:performance.now()-started});
      } else if(cmd.action==='stop') {
        emit({type:'stopping',request_id:cmd.request_id});
        shutdownRequested=true;
        input.close();
        break;
      } else {
        throw new Error('read_only_session_unknown_command');
      }
    } catch(error) {
      emit({type:'command_error',request_id:cmd?.request_id,error:error.message});
    }
  }
  if(args.includes('--daemon')&&!shutdownRequested) await new Promise(resolve=>{shutdownResolve=resolve;});
}
main().catch(error=>{emit({type:'fatal',error:error.message});process.exitCode=1;}).finally(async()=>{
  if(context) {
    try { require('./ui_controller.cjs').stop(context.pages()[0]); } catch(_) {}
    try { await require('./ui_actions.cjs').run({page:context.pages()[0],context,cmd:{operation:'stop_observer'},runtime}); } catch(_) {}
    try { await globalThis[Symbol.for('xhs_reception.ui_engine_client')]?.client.close({timeoutMs:500}); } catch(_) {}
    await context.close();
  }
});
