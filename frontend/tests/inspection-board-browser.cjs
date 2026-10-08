'use strict';

// Built React only, public synthetic GET responses, isolated owned Chrome.
// No backend, authentication, real MES, production data, or external HTTP.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const REPO = path.dirname(ROOT);
const DIST = path.join(ROOT, 'dist');
const FRONT = 'https://wj-reporting.onrender.com';
const ROUTE = '/boards/inspection';
const PLAYWRIGHT = require.resolve('playwright', {paths: [ROOT, REPO]});
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outputName = process.argv[2] || 'inspection-board-browser-20261004.json';
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(outputName)) throw new Error('Use a log basename only.');
const output = path.join(REPO, 'output', outputName);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const NOW = Date.now();
const DAY = new Date(NOW).toISOString().slice(0, 10); // Shanghai 08:00 equals UTC 00:00.
const AT = new Date(NOW - 1000).toISOString();
const PLAN_VERSION = 'a'.repeat(64);
const paths = {plan: '/api/production/plan-summary/', status: '/api/production/status/', matrix: '/api/injection/production-matrix/'};
const planId = machine => 7000 + machine;

function quality(machine, mode) {
  const check = (kind, status) => ({kind, status, checked_at: AT, warnings: []});
  return {schema_version: 'injection-quality-status.v1', business_date: DAY, machine_number: machine,
    current_plan_id: planId(machine), plan_version: PLAN_VERSION, binding_generation: 1, read_generation: mode === 'fresh' ? 1 : 2,
    binding_status: 'verified', availability: 'ok', freshness: mode === 'stale' ? 'stale' : 'fresh',
    fresh_until: new Date(NOW + (mode === 'stale' ? -60000 : 3600000)).toISOString(),
    last_attempt_started_at: AT, last_attempt_completed_at: AT, last_success_at: AT, observed_at: AT,
    refresh_after_seconds: null, complete: true,
    first: {status: 'passed', last_known_status: 'passed', checks: [check('first', 'passed')]},
    periodic: machine === 8
      ? {status: 'in_progress', last_known_status: 'in_progress', checks: [{kind: 'periodic', status: 'in_progress', checked_at: null, warnings: []}],
        last_checked_at: null, last_result: 'unknown', next_due_at: null, schedule_status: 'unverified'}
      : {status: 'failed', last_known_status: 'failed', checks: [check('periodic', 'failed')],
        last_checked_at: AT, last_result: 'failed', next_due_at: null, schedule_status: 'unverified'},
    other_checks: [], warnings: []};
}

function fixtures(mode) {
  const machines = Array.from({length: 17}, (_, index) => index + 1);
  const records = machines.map(machine => ({id: planId(machine), machine_name: `850T-${machine}`,
    part_no: `SYNTHETIC-PART-${machine}`, model_name: `SYNTHETIC-MODEL-${machine}`,
    lot_no: 'SYNTHETIC-LOT', planned_quantity: 1000, sequence: 1, updated_at: AT, cavity: 1}));
  const injection = machines.map(machine => ({machine_number: machine, machine_name: `${machine}호기`,
    total_planned: 1000, total_actual: 200, progress: 20, shot_count: 200, recent_60m_shots: 60, is_running: true,
    transition: {phase: 'running', from_plan_id: null, to_plan_id: null, current_plan_id: planId(machine),
      stopped_at: null, estimated_start_at: null, confirmation_status: 'none', setup_shots: 0},
    parts: [{plan_id: planId(machine), part_no: `SYNTHETIC-PART-${machine}`, model_name: `SYNTHETIC-MODEL-${machine}`,
      planned_quantity: 1000, actual_quantity: 200, allocated_shots: 200, progress: 20, sequence: 1, cavity: 1}],
    inspection_scope: {business_date: DAY, machine_number: machine,
      current_plan_id: mode === 'wrong_plan' ? planId(machine) + 1000 : planId(machine),
      plan_version: PLAN_VERSION, plan_updated_at: AT},
    inspection_status: [7, 8].includes(machine) ? quality(machine, mode) : null}));
  const matrixRecord = values => Object.fromEntries(machines.map(machine => [String(machine), values]));
  const bucket = {records, machine_summary: [], model_summary: [], daily_totals: []};
  return {
    plan: {plan_date: DAY, latest_updated_at: AT, injection: bucket,
      machining: {records: [], machine_summary: [], model_summary: [], daily_totals: []}},
    status: {injection, machining: []},
    matrix: {timestamp: AT, generated_at: AT, source_latest_at: AT, interval_type: '2min', columns: 2,
      time_slots: [{hour_offset: 0, time: new Date(NOW - 121000).toISOString(), label: 'SYNTHETIC', interval_minutes: 2},
        {hour_offset: 0, time: AT, label: 'SYNTHETIC', interval_minutes: 2}],
      machines: machines.map(machine => ({machine_number: machine, machine_name: `${machine}호기`, tonnage: '850', display_name: `${machine}호기`})),
      cumulative_production_matrix: matrixRecord([198, 200]), actual_production_matrix: matrixRecord([1, 2]),
      oil_temperature_matrix: matrixRecord([0, 0]), capacity_observed_matrix: matrixRecord([true, true]),
      source_window: {start: `${DAY}T00:00:00Z`, end: AT, timezone: 'Asia/Shanghai'},
      machine_sources: Object.fromEntries(machines.map(machine => [String(machine), {status: 'ok', latest_capacity_at: AT,
        sample_count: 2, observed_slot_count: 2, total_slot_count: 2}])), mes_source: true},
  };
}

(async () => {
  const {chromium} = require(PLAYWRIGHT);
  const index = fs.readFileSync(path.join(DIST, 'index.html'));
  const entry = index.toString().match(/type="module" crossorigin src="(\/assets\/index-[^"]+\.js)"/)[1];
  const sourcePaths = ['src/App.tsx', 'src/domains/production/pages/InspectionBoardPage.tsx',
    'src/domains/production/pages/InspectionBoardPage.css', 'src/domains/production/inspection-board-model.ts',
    'src/domains/production/injection-quality-binding.ts', 'src/domains/production/injection-quality-status.ts'];
  const sourceManifest = () => Object.fromEntries(sourcePaths.map(name => [name, sha(fs.readFileSync(path.join(ROOT, name)))]));
  const artifact = {head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: REPO, encoding: 'utf8'}).trim(),
    index_sha256: sha(index), entry_sha256: sha(fs.readFileSync(path.join(DIST, entry))),
    runner_sha256: sha(fs.readFileSync(__filename)), source_sha256: sourceManifest(), served_asset_sha256: {}};
  const log = fs.openSync(output, 'wx', 0o600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wj-inspection-board-fixture-'));
  fs.chmodSync(profile, 0o700);
  const started = new Date().toISOString();
  const counts = {non_get: 0, auth: 0, provider: 0, public_get: 0, page_errors: 0};
  const blocked = {font: 0, unexpected_origin: 0, unexpected_path: 0, websocket: 0};
  const consoleKinds = {blocked_resource: 0, expected_503: 0, fixed_api_error: 0, other: 0};
  const cases = [], screenshots = [], apiResponses = {}, layout = [], layoutIssues = [], pageErrors = [];
  const pageModes = new WeakMap();
  let context, page, timer, closeTask, stage = 'launch', checks = 0, result, routeFailure = null;
  const verify = (condition, name) => { if (!condition) {const error = new Error('Synthetic assertion failed'); error.check = name; throw error;} checks++; };
  const finish = name => {cases.push(name); process.stdout.write(`${name}: pass\n`);};
  const close = () => {
    if (!context) return Promise.resolve(true);
    if (!closeTask) {let deadline; closeTask = Promise.race([context.close().then(() => true, () => false),
      new Promise(resolve => {deadline = setTimeout(() => resolve(false), 3000);})]).finally(() => clearTimeout(deadline));}
    return closeTask;
  };
  try {
    timer = setTimeout(async () => {result = {ok: false, stage, error: 'FixtureTimeout'}; await close(); process.exit(2);}, 55000);
    context = await chromium.launchPersistentContext(profile, {executablePath: CHROME, headless: true,
      serviceWorkers: 'block', viewport: {width: 1672, height: 941}, proxy: {server: 'http://127.0.0.1:9'},
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--dns-prefetch-disable', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost']});
    context.setDefaultTimeout(5000);
    context.on('page', target => {
      target.on('pageerror', error => {
        counts.page_errors++;
        pageErrors.push({name: error.name,
          kind: /ResizeObserver loop/.test(error.message) ? 'resize_observer_loop'
            : /Maximum update depth/.test(error.message) ? 'react_update_depth'
              : /ChunkLoadError|Failed to fetch dynamically imported module/.test(error.message) ? 'dynamic_import'
                : 'unclassified', message: error.message.slice(0, 240)});
      });
      target.on('console', message => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (text.includes('net::ERR_BLOCKED_BY_CLIENT')) consoleKinds.blocked_resource++;
        else if (/the server responded with a status of 503/.test(text)) consoleKinds.expected_503++;
        else if (/^\[(API|HTTP) Error\]/.test(text) && pageModes.get(target) === 'error') consoleKinds.fixed_api_error++;
        else consoleKinds.other++;
      });
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') {counts.non_get++; return route.abort('blockedbyclient');}
      if (url.origin !== FRONT) {
        if (url.hostname.endsWith('blacklake.cn')) counts.provider++;
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) blocked.font++;
        else blocked.unexpected_origin++;
        return route.abort('blockedbyclient');
      }
      if (url.pathname.startsWith('/api/')) {
        const headers = await request.allHeaders();
        if (headers.authorization || /token|user\/me|mes-connection/.test(url.pathname)) counts.auth++;
        const type = Object.keys(paths).find(key => paths[key] === url.pathname);
        if (!type) {blocked.unexpected_path++; return route.fulfill({status: 404, body: ''});}
        const mode = pageModes.get(request.frame().page()) || 'fresh';
        counts.public_get++;
        const status = type === 'status' && mode === 'error' ? 503 : 200;
        apiResponses[`${mode}:${type}:${status}`] = (apiResponses[`${mode}:${type}:${status}`] || 0) + 1;
        return route.fulfill({status, contentType: 'application/json', body: JSON.stringify(status === 503 ? {detail: 'SYNTHETIC-UNAVAILABLE'} : fixtures(mode)[type])});
      }
      if ([ROUTE, '/login'].includes(url.pathname)) return route.fulfill({status: 200, contentType: 'text/html', body: index});
      const file = path.resolve(DIST, '.' + url.pathname);
      if (file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const bytes = fs.readFileSync(file);
        artifact.served_asset_sha256[url.pathname] = sha(bytes);
        const types = {'.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'};
        return route.fulfill({status: 200, contentType: types[path.extname(file)] || 'application/octet-stream', body: bytes});
      }
      blocked.unexpected_path++; await route.fulfill({status: 404, body: ''});
    });
    await context.routeWebSocket('**/*', socket => {blocked.websocket++; socket.close();});
    await context.addInitScript(origin => {
      if (location.origin !== origin) return; // An initial about:blank document has an opaque origin.
      localStorage.setItem('lang', 'ko'); localStorage.setItem('wj_next_language', 'ko');
    }, FRONT);
    const load = async (mode, reducedMotion = 'no-preference') => {
      if (page) await page.close();
      page = await context.newPage(); pageModes.set(page, mode);
      await page.emulateMedia({reducedMotion});
      const statusReply = page.waitForResponse(response => new URL(response.url()).pathname === paths.status);
      await page.goto(FRONT + ROUTE);
      await statusReply;
      await page.getByTestId('inspection-board-page').waitFor();
      await page.locator('[data-machine-card="7"]').click();
      await page.getByTestId('inspection-board-detail').waitFor();
    };
    const card = number => page.locator(`[data-machine-card="${number}"]`);
    const summary = kind => card(7).locator(`[data-inspection-kind="${kind}"] [data-status]`);
    const detail = () => page.getByTestId('inspection-board-detail');
    const noOverflow = async (name, width, height) => {
      await page.setViewportSize({width, height});
      await page.evaluate(() => window.scrollTo(0, 0));
      const bounds = await page.evaluate(() => ({viewport: innerWidth, document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth, page: document.querySelector('[data-testid="inspection-board-page"]').getBoundingClientRect().width,
        viewport_height: innerHeight, document_height: document.documentElement.scrollHeight, body_height: document.body.scrollHeight}));
      layout.push({name, ...bounds});
      await capture(`${name}-ko`);
      if (bounds.document > width + 1 || bounds.body > width + 1 || bounds.page > width + 1) layoutIssues.push(`${name}_horizontal_overflow`);
      else verify(true, `${name}_no_horizontal_overflow`);
      if (width > 900) {
        if (bounds.document_height > height + 1 || bounds.body_height > height + 1) layoutIssues.push(`${name}_vertical_scroll`);
        else verify(true, `${name}_no_vertical_scroll`);
      }
    };
    const capture = async name => {
      const file = path.join(REPO, 'output', `${path.basename(outputName, '.json')}-${name}.png`);
      const bytes = await page.screenshot({fullPage: page.viewportSize().width < 900, animations: 'disabled'});
      fs.writeFileSync(file, bytes, {mode: 0o600, flag: 'wx'});
      screenshots.push({name, file: path.basename(file), sha256: sha(bytes)});
    };

    stage = 'desktop_selection_and_independent_status';
    await load('fresh');
    await page.waitForFunction(() => document.querySelector('[data-machine-card="7"] [data-inspection-kind="first"] [data-status]')?.getAttribute('data-status') === 'passed');
    verify(await card(7).count() === 1 && await page.locator('[data-machine-card]').count() === 17, 'exactly_seventeen_machine_controls');
    for (let machine = 1; machine <= 17; machine++) {
      await card(machine).click();
      await page.waitForFunction(number => document.querySelector('[data-testid="inspection-board-detail"]')?.getAttribute('data-machine-detail') === String(number), machine);
      verify(await card(machine).getAttribute('aria-pressed') === 'true', `machine_${machine}_selection`);
    }
    await card(7).click();
    verify((await detail().innerText()).includes('SYNTHETIC-PART-7'), 'selected_current_plan_product');
    verify(await summary('first').getAttribute('data-status') === 'passed' && await summary('periodic').getAttribute('data-status') === 'failed', 'first_and_periodic_are_independent');
    const saveStatus = detail().locator('.inspection-board-actions > div').filter({has: page.getByText('MES 저장', {exact: true})}).locator('strong');
    const quantity = detail().locator('.inspection-board-quantities > div').filter({has: page.getByText('검사수량', {exact: true})}).locator('strong');
    verify((await saveStatus.innerText()).trim() === '요청 상세에서 확인', 'unverified_mes_save_is_explicit');
    verify((await quantity.innerText()).trim() === '미확인', 'inspection_quantity_is_not_inferred');
    verify(/불량조치|특채|폐기|재작업/.test(await detail().innerText()), 'disposition_separate_from_qc_result');
    await noOverflow('desktop_1672', 1672, 941);
    const rows = await page.locator('[data-machine-card]').evaluateAll(cards => {
      const groups = new Map();
      for (const card of cards) {const top = Math.round(card.getBoundingClientRect().top); groups.set(top, [...(groups.get(top) || []), Number(card.dataset.machineCard)]);}
      return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, numbers]) => numbers);
    });
    verify(JSON.stringify(rows) === JSON.stringify([[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12], [13, 14, 15, 16, 17]]), 'three_ordered_machine_rows');
    await noOverflow('desktop_1920', 1920, 1080);
    finish(stage);

    stage = 'history_and_existing_dialog';
    verify(await page.getByTestId('inspection-history').getAttribute('href') === '/quality/inspection-requests', 'history_targets_existing_request_route');
    await detail().locator('.injection-quality__summary').click();
    const dialog = page.locator('.injection-quality-dialog[open]');
    await dialog.waitFor();
    verify(await dialog.locator('.injection-quality__checks .injection-quality__state--failed').count() === 1, 'history_retains_individual_failure');
    verify((await dialog.innerText()).includes('검사 완료는 불량조치 종료를 의미하지 않습니다.'), 'history_does_not_close_disposition');
    await dialog.getByRole('button', {name: '닫기', exact: true}).click();
    await page.getByTestId('inspection-history').click();
    await page.waitForURL(url => url.pathname === '/login');
    await page.locator('#username').waitFor();
    verify(await page.locator('#username').isVisible() && counts.auth === 0, 'history_requires_login_without_auto_auth');
    await page.goBack();
    await card(7).click();
    finish(stage);

    stage = 'language_mobile_and_motion';
    await page.getByRole('button', {name: '中文', exact: true}).click();
    verify((await detail().innerText()).includes('首检') && (await detail().innerText()).includes('巡检'), 'chinese_quality_terms');
    await capture('desktop-1920-zh');
    await page.getByRole('button', {name: /^(KOR|한국어)$/}).click();
    await noOverflow('mobile_390', 390, 844);
    await card(8).click();
    await page.locator('.inspection-board-scene[data-animate="true"]').waitFor();
    verify(await detail().locator('.inspection-board-scene-inspector').evaluate(node => getComputedStyle(node).animationName !== 'none'), 'fresh_in_progress_has_real_motion');
    const motion = page.getByTestId('inspection-motion-toggle');
    await motion.click();
    verify(await page.getByTestId('inspection-board-page').getAttribute('data-motion') === 'off', 'motion_can_be_disabled');
    verify(await detail().locator('.inspection-board-scene-inspector').evaluate(node => getComputedStyle(node).animationName === 'none'), 'disabled_motion_stops_inspector');
    await motion.click();
    verify(await page.getByTestId('inspection-board-page').getAttribute('data-motion') === 'on', 'motion_can_be_reenabled');
    finish(stage);

    for (const mode of ['stale', 'error', 'wrong_plan']) {
      stage = `${mode}_cannot_be_current_pass`;
      await load('fresh');
      await page.waitForFunction(() => document.querySelector('[data-machine-card="7"] [data-inspection-kind="first"] [data-status]')?.getAttribute('data-status') === 'passed');
      pageModes.set(page, mode);
      const changedResponse = page.waitForResponse(response => new URL(response.url()).pathname === paths.status);
      await page.getByTestId('inspection-refresh').click();
      await changedResponse;
      await page.waitForFunction(() => document.querySelector('[data-machine-card="7"] [data-inspection-kind="first"] [data-status]')?.getAttribute('data-status') === 'unknown', {}, {timeout: 12000});
      verify(await summary('first').getAttribute('data-status') !== 'passed' && await summary('periodic').getAttribute('data-status') !== 'passed', `${mode}_no_green_aggregate`);
      verify(apiResponses[`${mode}:status:${mode === 'error' ? 503 : 200}`] > 0, `${mode}_response_exercised`);
      const freshness = detail().locator('.injection-quality');
      if (mode === 'stale') verify(await freshness.getAttribute('data-quality-freshness') === 'stale', 'stale_source_consumed');
      if (mode === 'error') verify(await freshness.locator('.injection-quality__freshness--error').count() === 1, 'error_source_consumed');
      if (mode === 'wrong_plan') verify(await freshness.getAttribute('data-quality-freshness') === 'unavailable', 'wrong_plan_source_discarded');
      await card(8).click();
      verify(await detail().locator('.inspection-board-scene').getAttribute('data-animate') === 'false'
        && await detail().locator('.inspection-board-scene-inspector').evaluate(node => getComputedStyle(node).animationName === 'none'), `${mode}_cannot_animate_old_inspection`);
      finish(stage);
    }
    stage = 'system_reduced_motion';
    await page.evaluate(() => localStorage.clear());
    await load('fresh', 'reduce');
    await card(8).click();
    verify(await page.getByTestId('inspection-board-page').getAttribute('data-motion') === 'off', 'system_reduced_motion_respected');
    verify(await page.getByTestId('inspection-board-page').locator('*').evaluateAll(nodes => nodes.every(node => {
      const css = getComputedStyle(node);
      return css.animationName === 'none' || css.animationPlayState === 'paused'
        || css.animationDuration.split(',').every(value => parseFloat(value) <= 0.001);
    })), 'reduced_motion_has_no_active_animation');
    finish(stage);
    stage = 'read_only_and_build_integrity';
    verify(counts.non_get === 0 && counts.auth === 0 && counts.provider === 0, 'no_auth_mutation_or_provider_request');
    verify(blocked.unexpected_origin === 0 && blocked.unexpected_path === 0 && blocked.websocket === 0, 'no_unexpected_egress_or_endpoint');
    verify(counts.page_errors === 0 && consoleKinds.other === 0 && routeFailure === null, 'no_unexpected_runtime_error');
    verify(sha(fs.readFileSync(path.join(DIST, entry))) === artifact.entry_sha256, 'built_entry_unchanged');
    verify(JSON.stringify(sourceManifest()) === JSON.stringify(artifact.source_sha256), 'runtime_source_unchanged');
    verify(Object.entries(artifact.served_asset_sha256).every(([name, digest]) => sha(fs.readFileSync(path.join(DIST, name))) === digest), 'served_assets_unchanged');
    verify(layoutIssues.length === 0, layoutIssues[0] || 'all_layouts_fit');
    finish(stage); result = {ok: true};
  } catch (error) {
    result = {ok: false, stage, check: error.check || null, error: error.name === 'TimeoutError' ? 'FixtureStepTimeout' : 'FixtureFailure'};
  } finally {
    clearTimeout(timer);
    const closed = await close(); if (closed) fs.rmSync(profile, {recursive: true, force: true});
    const report = {...result, started_at: started, finished_at: new Date().toISOString(), checks, cases, counts, blocked,
      console_kinds: consoleKinds, page_errors: pageErrors, api_responses: apiResponses, layout, layout_issues: layoutIssues, screenshots, artifact, own_browser_closed: closed,
      limitations: ['synthetic public GET fixtures only; no backend or real MES acceptance', 'all origins intercepted; no real HTTP/TLS or existing browser profile']};
    fs.writeSync(log, JSON.stringify(report, null, 2) + '\n'); fs.closeSync(log);
    process.stdout.write(JSON.stringify({ok: report.ok, cases: cases.length, checks, stage: report.ok ? 'complete' : stage}) + '\n');
    process.exit(report.ok ? 0 : 1);
  }
})();
