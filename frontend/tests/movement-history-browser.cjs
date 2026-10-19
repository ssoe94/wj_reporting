// Offline browser acceptance: built frontend + synthetic saved history only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(require.resolve('playwright', {paths:[fs.realpathSync(path.join(__dirname,'../node_modules'))]}));
const DIST = path.resolve(__dirname, '../dist');
const OUT = path.resolve(__dirname, '../../output/movement-history');
const ORIGIN = 'http://127.0.0.1:5379';
const HISTORY = '/api/inventory/finished-goods/history/';
const initial = '/sales/movement-history?start_date=2026-10-01&end_date=2026-10-19&direction=all&ordering=asc&search=';
const token = `e30.${Buffer.from(JSON.stringify({exp: Math.floor(Date.now()/1000)+3600})).toString('base64url')}.fixture`;
const row = id => ({id, business_date:'2026-10-18', material_code:`MODEL-${id}`, material_name:'검증 모델 / 验证型号', specification:'白色',
  warehouse_name:'成品仓库', unit:'EA', total_in:'100.1234',total_out:'20',net_change:'80.1234',identifier_count:2,missing_identifier_count:1,revision:1});
const details = [{qr_code:'WJ-7459',trolley_code:'',label_code:'',total_in:'89.1234',total_out:'20',first_at:'2026-10-18T09:00:00+08:00',last_at:'2026-10-18T19:00:00+08:00',
  events:[{id:'1',occurred_at:'2026-10-18T09:00:00+08:00',direction:'in',quantity:'89.1234',action_label:'入库',storage_location:'A',batch_no:''},
  {id:'2',occurred_at:'2026-10-18T19:00:00+08:00',direction:'out',quantity:'20',action_label:'出库',storage_location:'A',batch_no:''}]},
  {qr_code:'TT0940411',trolley_code:'',label_code:'',total_in:'10',total_out:'0',first_at:'2026-10-18T10:00:00+08:00',last_at:'2026-10-18T10:00:00+08:00',events:[{id:'3',occurred_at:'2026-10-18T10:00:00+08:00',direction:'in',quantity:'10',action_label:'入库',storage_location:'',batch_no:''}]},
  {qr_code:'',trolley_code:'',label_code:'',total_in:'1',total_out:'0',first_at:'2026-10-18T10:00:00+08:00',last_at:'2026-10-18T10:00:00+08:00',events:[{id:'4',occurred_at:'2026-10-18T10:00:00+08:00',direction:'in',quantity:'1',action_label:'入库',storage_location:'',batch_no:''}]}];

(async () => {
  fs.mkdirSync(OUT, {recursive:true});
  const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true});
  try {
    const context = await browser.newContext({viewport:{width:1280,height:720}, reducedMotion:'reduce', serviceWorkers:'block'});
    let mode = 'ok';
    const requests = [], detailRequests = [], errors = [];
    await context.addInitScript(({token, lang}) => {
      localStorage.setItem('access_token', token); localStorage.setItem('refresh_token', token);
      localStorage.setItem('lang', lang); localStorage.setItem('wj_next_language', lang);
    }, {token, lang:'ko'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/auth/activity/') return route.fulfill({status:503,contentType:'application/json',body:'{}'});
        assert.equal(request.method(), 'GET', 'history browsing must not write');
        let body = {};
        if (url.pathname.endsWith('/user/me/')) body = {id:1,username:'history-fixture',is_staff:false,is_active:true,groups:[],permissions:{can_view_sales:true}};
        if (url.pathname === HISTORY) {
          requests.push(Object.fromEntries(url.searchParams));
          if (mode === 'error') return route.fulfill({status:503,contentType:'application/json',body:'{}'});
          const page = Number(url.searchParams.get('page') || 1);
          const empty = url.searchParams.get('search') === 'missing';
          body = {count:empty ? 0 : 51,page,page_size:50,
            totals:empty ? [] : [{unit:'EA',total_in:'5106.2934',total_out:'1020.0000',net_change:'4086.2934'}],
            snapshot_token:'a'.repeat(32),source:{fetched_at:'2026-10-19T00:10:00Z',missing_dates:['2026-10-01'],pending_dates:['2026-10-19'],business_day:'08:00'},
            results:empty ? [] : (page === 1 ? Array.from({length:50},(_,i)=>row(i+1)) : [row(51)])};
        }
        if (url.pathname.startsWith(HISTORY) && url.pathname !== HISTORY) {
          detailRequests.push(url.pathname);
          if (mode === 'detail-error') return route.fulfill({status:503,contentType:'application/json',body:'{}'});
          body = {id:1,results:details};
        }
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
      }
      const target = path.resolve(DIST, '.' + url.pathname);
      const file = target.startsWith(DIST + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(DIST,'index.html');
      const type = {'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[path.extname(file)] || 'text/html';
      return route.fulfill({contentType:type,body:fs.readFileSync(file)});
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(ORIGIN + initial);
    await page.getByRole('heading',{name:'입·출고 이력',exact:true}).waitFor();
    await page.getByText('MODEL-50',{exact:true}).waitFor();
    assert.equal(detailRequests.length, 0, 'details are fetched only when expanded');
    await page.getByText('미수집 날짜: 1', {exact:true}).waitFor();
    await page.getByText('마감 전 날짜: 1', {exact:true}).waitFor();
    mode = 'detail-error';
    await page.getByRole('button',{name:'번호별 보기 2026-10-18 MODEL-1',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'불러오지 못했습니다'}).waitFor();
    mode = 'ok';
    await page.getByRole('button',{name:'다시 시도',exact:true}).click();
    await page.getByText('WJ-7459',{exact:true}).waitFor();
    await page.locator('summary').filter({hasText:'WJ-7459'}).click();
    const expanded = page.getByTestId('identifier-details');
    await expanded.getByText('2026-10-18 09:00:00',{exact:true}).waitFor();
    await expanded.getByText('2026-10-18 19:00:00',{exact:true}).waitFor();
    await expanded.getByText('번호 없음',{exact:true}).waitFor();
    await expanded.scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(OUT,'desktop-expanded-ko.png'),fullPage:false});
    await page.getByRole('button',{name:'접기 2026-10-18 MODEL-1',exact:true}).click();
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:path.join(OUT,'desktop-ko.png'),fullPage:false});
    await page.getByRole('button',{name:'이어서 보기',exact:true}).click();
    await page.getByText('MODEL-51',{exact:true}).waitFor();
    assert.equal(await page.getByTestId('daily-row').count(),51);
    assert.equal(requests.at(-1).snapshot_token,'a'.repeat(32));
    await page.getByLabel('입출고 구분',{exact:true}).selectOption('out');
    await page.getByLabel('모델 검색',{exact:true}).fill('MODEL');
    await page.getByRole('button',{name:'조회',exact:true}).click();
    await page.waitForURL(/direction=out/);
    await page.getByText('MODEL-50',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="daily-row"]').length===50);
    assert.equal(await page.getByTestId('daily-row').count(),50, 'filter changes reset appended rows');
    assert.equal(requests.at(-1).search,'MODEL');
    assert.equal(requests.at(-1).page,'1');
    await page.goBack();
    assert.equal(await page.getByLabel('입출고 구분',{exact:true}).inputValue(),'all');
    await page.getByLabel('모델 검색',{exact:true}).fill('missing');
    await page.getByRole('button',{name:'조회',exact:true}).click();
    await page.getByText('조건에 맞는 입출고 이력이 없습니다.',{exact:true}).waitFor();
    await page.getByLabel('시작일',{exact:true}).fill('2026-10-20');
    await page.getByRole('button',{name:'조회',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'유효한 날짜'}).waitFor();
    // A new filter with unavailable data must display retry rather than stale rows.
    mode = 'error';
    await page.goto(ORIGIN + initial.replace('search=', 'search=error'));
    await page.getByRole('alert').filter({hasText:'불러오지 못했습니다'}).waitFor({timeout:30000});
    mode = 'ok';
    await page.getByRole('button',{name:'다시 시도',exact:true}).click();
    await page.getByText('MODEL-50',{exact:true}).waitFor();
    await page.goto(ORIGIN + initial);
    await page.getByText('MODEL-50',{exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:path.join(OUT,'mobile-layout-check.png'),fullPage:false});
    const overflow = await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,items:[...document.querySelectorAll('main,form,label,input,select,section')].map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})).filter(e=>e.right>innerWidth+1)}));
    assert.ok(overflow.scroll <= overflow.width+1,JSON.stringify(overflow));
    await page.getByRole('button',{name:'번호별 보기 2026-10-18 MODEL-1',exact:true}).click();
    await page.getByText('WJ-7459',{exact:true}).waitFor();
    await page.getByText('WJ-7459',{exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(OUT,'mobile-ko.png'),fullPage:false});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1), 'expanded mobile layout');
    await context.addInitScript(()=>{ localStorage.setItem('lang','zh'); localStorage.setItem('wj_next_language','zh'); });
    await page.reload();
    await page.getByRole('heading',{name:'出入库履历',exact:true}).waitFor();
    await page.getByText('MODEL-50',{exact:true}).waitFor();
    await page.screenshot({path:path.join(OUT,'mobile-zh.png'),fullPage:false});
    await page.setViewportSize({width:1280,height:720});
    await page.getByRole('button',{name:'查看编号 2026-10-18 MODEL-1',exact:true}).click();
    await page.getByText('TT0940411',{exact:true}).waitFor();
    await page.screenshot({path:path.join(OUT,'desktop-zh.png'),fullPage:false});
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(OUT,'acceptance.json'),JSON.stringify({ok:true,requests,detailRequests,screens:['desktop-ko','mobile-ko','mobile-zh','desktop-zh'],checks:['lazy detail loading','detail error/retry','same number inbound/outbound','identifier event expansion','missing/pending dates','pagination','filter reset','URL/back','empty','invalid range','error/retry','mobile overflow','bilingual','no writes'],pageErrors:errors},null,2));
    console.log('Movement history browser acceptance passed; synthetic fixtures only.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
