'use strict';
// Every API response is real isolated Django; only built assets are served here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const input = readline.createInterface({input: process.stdin});
const pending = new Map();
let initialize, sequence = 0;
const ready = new Promise(resolve => { initialize = resolve; });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'init') initialize(message);
  else if (message.type === 'response') { const resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message); } }
});
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const rpc = request => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); send({type: 'request', id, ...request}); });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

(async () => {
  const config = await ready;
  const {chromium} = require(config.playwright);
  const inspection = '/quality/inspection-requests';
  const api = '/api/quality/inspection-requests/' + config.requestId + '/';
  const secrets = [...config.sensitive, config.password];
  let context, stage = 'launch', checks = 0, unexpected = 0, fontsBlocked = 0;
  let sensitiveConsole = false, privacyViolation = false, result, dialogs = 0;
  const apiCalls = [], phases = [], served = {}, screenshots = {};
  const index = fs.readFileSync(path.join(config.dist, 'index.html'));
  const sensitive = value => secrets.some(secret => String(value || '').includes(secret));
  const verify = (condition, check) => { if (!condition) { const error = new Error('Synthetic fixture assertion failed.'); error.check = check; throw error; } checks++; };
  const capture = async (name, locator) => {
    if (!config.screenshotsDir) return;
    verify(!sensitive(await locator.innerText()), 'screenshot_has_no_password_or_token');
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const file = path.join(config.screenshotsDir, `inspection-live-browser-${name}-${stamp}.png`);
    const bytes = await locator.screenshot({animations: 'disabled'});
    fs.writeFileSync(file, bytes, {mode: 0o600, flag: 'wx'});
    screenshots[name] = {file: path.basename(file), sha256: sha(bytes)};
  };
  const close = async () => {
    if (!context) return;
    // The installed Playwright owns the detached Chrome group and kills it in
    // its process-exit handler. Bound graceful close so that handler can run.
    let timer;
    try { await Promise.race([context.close().catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timer); }
  };
  process.on('SIGTERM', async () => { await close(); process.exit(143); });
  const timeout = setTimeout(async () => { send({type: 'result', ok: false, stage, error: 'FixtureTimeout', checks}); await close(); process.exit(1); }, 45000);
  try {
    context = await chromium.launchPersistentContext(config.profile, {
      executablePath: config.chrome, headless: true, serviceWorkers: 'block', viewport: {width: 1360, height: 1000},
      proxy: {server: 'http://127.0.0.1:9'}, args: ['--disable-background-networking', '--disable-component-update',
        '--disable-sync', '--dns-prefetch-disable', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
    });
    context.setDefaultTimeout(10000);
    context.on('page', page => {
      page.on('console', message => { sensitiveConsole ||= sensitive(message.text()); });
      page.on('pageerror', error => { sensitiveConsole ||= sensitive(error.message); });
      page.on('dialog', async dialog => { if (dialog.type() === 'confirm') { dialogs++; await dialog.accept(); } else await dialog.dismiss(); });
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      const headers = await request.allHeaders();
      privacyViolation ||= sensitive(request.url()) || sensitive(headers.referer);
      if (url.origin !== config.origin) {
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) fontsBlocked++;
        else unexpected++;
        await route.abort('blockedbyclient'); return;
      }
      if (url.pathname.startsWith('/api/')) {
        apiCalls.push({path: url.pathname, method: request.method()});
        const response = await rpc({url: request.url(), method: request.method(), headers,
          body: (request.postDataBuffer() || Buffer.alloc(0)).toString('base64')});
        const bytes = Buffer.from(response.body, 'base64');
        if (url.pathname === '/api/token/' && response.status === 200) {
          const pair = JSON.parse(bytes); secrets.push(pair.access, pair.refresh);
        }
        if (['mes-save', 'mes-finish', 'mes-reconcile'].some(action => url.pathname === api + action + '/')) {
          const body = JSON.parse(bytes);
          phases.push({path: url.pathname, status: response.status, phase: (body.mes_workflow || body.request?.mes_workflow)?.phase});
        }
        await route.fulfill({status: response.status, headers: response.headers, body: bytes}); return;
      }
      if (request.method() === 'GET' && ['/login', inspection, '/boards/injection'].includes(url.pathname)) {
        await route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: index}); return;
      }
      const file = path.resolve(config.dist, '.' + url.pathname);
      if (file.startsWith(path.resolve(config.dist) + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const body = fs.readFileSync(file);
        served[url.pathname] = sha(body);
        const types = {'.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
          '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.html': 'text/html'};
        await route.fulfill({status: 200, contentType: types[path.extname(file)] || 'application/octet-stream', body}); return;
      }
      await route.fulfill({status: 404, body: ''});
    });
    await context.routeWebSocket('**/*', socket => { unexpected++; socket.close(); });
    await context.addInitScript(() => { localStorage.setItem('lang', 'ko'); localStorage.setItem('wj_next_language', 'ko'); });
    const page = await context.newPage();
    stage = 'real_login';
    await page.goto(config.origin + '/login?returnTo=' + inspection);
    await page.locator('#username').fill(config.username);
    await page.locator('#password').fill(config.password);
    await page.locator('form button[type=submit]').first().click();
    await page.locator('.inspection-inspector').waitFor();
    verify((await page.locator('.inspection-inspector').innerText()).includes(config.username), 'actual_login_identity');
    const openRequest = async () => {
      const details = page.locator('details.inspection-auxiliary');
      if (await details.count() && !await details.evaluate(node => node.open)) await details.locator('summary').click();
      await page.locator('.inspection-list-row').filter({hasText: '#' + config.requestId + ' ·'}).click();
      await page.locator('.inspection-detail').waitFor({state: 'attached'});
      const mes = page.locator('details.inspection-section').filter({has: page.getByRole('button', {name: 'MES 검사값 저장', exact: true, includeHidden: true})});
      if (!await mes.evaluate(node => node.open)) await mes.locator('summary').click();
      await page.getByRole('button', {name: 'MES 검사값 저장', exact: true}).waitFor();
    };
    stage = 'actual_request_card';
    await openRequest();
    const save = page.getByRole('button', {name: 'MES 검사값 저장', exact: true});
    const finish = page.getByRole('button', {name: 'QC 검사 완료', exact: true});
    verify(await save.isEnabled() && !await finish.isEnabled(), 'reviewed_ready_controls');
    const beforeNotes = await page.locator('.inspection-form-full textarea').first().inputValue();
    stage = 'one_mes_save';
    await Promise.all([page.waitForResponse(r => r.url().endsWith(api + 'mes-save/') && r.request().method() === 'POST'), save.click()]);
    if (config.mode === 'complete') {
      await page.getByText('저장된 검사값과 시험표기를 MES 재조회로 확인했습니다.', {exact: true}).waitFor();
      verify(phases.at(-1).phase === 'saved' && await finish.isEnabled(), 'independent_saved_readback');
      verify(await page.locator('.inspection-form-full textarea').first().inputValue() === beforeNotes, 'same_tab_context_preserved');
      stage = 'explicit_confirmed_finish';
      await Promise.all([page.waitForResponse(r => r.url().endsWith(api + 'mes-finish/') && r.request().method() === 'POST'), finish.click()]);
      await page.getByText('개별 QC 검사 완료 상태를 재조회로 확인했습니다.', {exact: true}).waitFor();
      verify(phases.at(-1).phase === 'completed' && dialogs === 1, 'finish_requires_confirmation_and_readback');
      verify(!await save.isEnabled() && !await finish.isEnabled(), 'completed_write_controls_disabled');
      await capture('completed', page.locator('.inspection-detail-workspace'));
      stage = 'public_projection_and_real_board_component';
      const board = await context.newPage();
      await board.goto(config.origin + '/boards/injection');
      await board.locator('.injection-quality__summary').first().click();
      const dialog = board.locator('.injection-quality-dialog[open]');
      await dialog.waitFor();
      verify((await dialog.innerText()).includes('검사 목록 확인이 완료되지 않았습니다.'), 'whole_list_completion_remains_false');
      verify(await dialog.locator('.injection-quality__checks .injection-quality__state--passed').count() === 1, 'actual_persisted_qc_check_passed');
      verify(Boolean(await dialog.locator('.injection-quality__checks time').getAttribute('datetime')), 'actual_completion_time_rendered');
      await capture('board', dialog);
    } else {
      stage = 'unknown_remote_write_keeps_context_and_blocks_resend';
      await page.locator('.inspection-message.is-error').waitFor();
      verify(phases.at(-1).status === 503 && phases.at(-1).phase === 'save_unknown', 'real_unknown_write_response');
      verify(!await save.isEnabled() && !await finish.isEnabled(), 'unknown_state_blocks_writes');
      verify(await page.locator('.inspection-form-full textarea').first().inputValue() === beforeNotes, 'unknown_context_preserved');
      verify(await page.evaluate(({actor, id}) => {
        const recovery = JSON.parse(sessionStorage.getItem(`wj-inspection-draft:v1:${actor}:${id}`) || 'null');
        return Boolean(recovery && recovery.user_id === actor && recovery.request_id === id && recovery.reconciliation_required);
      }, {actor: config.actorId, id: config.requestId}), 'owner_scoped_reconciliation_recovery');
      stage = 'explicit_read_only_reconcile_without_resend';
      await Promise.all([page.waitForResponse(r => r.url().endsWith(api + 'mes-reconcile/') && r.request().method() === 'POST'),
        page.getByRole('button', {name: 'MES 상태 재조회', exact: true}).click()]);
      verify(phases.at(-1).phase === 'saved', 'reconciliation_observed_committed_save');
      verify(apiCalls.filter(call => call.path === api + 'mes-save/').length === 1, 'no_automatic_or_reconcile_resend');
      verify(apiCalls.filter(call => call.path === api + 'mes-finish/').length === 0, 'reconcile_does_not_finish');
    }
    verify(apiCalls.filter(call => call.path === '/api/token/' && call.method === 'POST').length === 1, 'one_real_login');
    verify(apiCalls.filter(call => call.path === api + 'mes-save/').length === 1, 'one_real_save_request');
    verify(!privacyViolation && !sensitiveConsole && unexpected === 0, 'no_secret_url_console_or_egress');
    result = {type: 'result', ok: true, checks, browser_version: context.browser().version(),
      unexpected_external: unexpected, external_fonts_blocked: fontsBlocked, sensitive_console: sensitiveConsole,
      index_sha256: sha(index), served_asset_sha256: served, screenshots, phases};
  } catch (error) {
    result = {type: 'result', ok: false, stage, checks, error: error.name, failed_check: error.check || null,
      api_calls: apiCalls, phases, unexpected_external: unexpected, sensitive_console: sensitiveConsole};
  } finally { clearTimeout(timeout); await close(); }
  send(result); input.close(); process.exit(result.ok ? 0 : 1);
})().catch(error => { send({type: 'result', ok: false, stage: 'bootstrap', error: error.name,
  code: /^[A-Z_]+$/.test(error.code || '') ? error.code : null}); input.close(); process.exit(1); });
