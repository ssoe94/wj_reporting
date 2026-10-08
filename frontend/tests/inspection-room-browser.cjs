'use strict';

// Real built App, synthetic identities and API responses, isolated Chrome profile.
// Every request is intercepted. This runner starts no server and contacts no MES.
// First build: cd frontend && npm run build:inspection-fixture
// Browser execution requires --authorized-browser; screenshots always come from this current build.
// node frontend/tests/inspection-room-browser.cjs [output-basename] --authorized-browser
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const REPO = path.resolve(__dirname, '../..');
const DIST = path.resolve(process.env.WJ_INSPECTION_FIXTURE_DIST || path.join(REPO, 'output/inspection-fixture-dist'));
const ORIGIN = 'http://127.0.0.1:5193';
const ROUTE = '/quality/inspection-requests';
const API = '/api/quality/inspection-requests/';
const CONTROL = 'wj-auth-session-control-v2';
if (!process.argv.includes('--authorized-browser')) {
  process.stdout.write('Prepared synthetic browser checks only. Build the inspection fixture, then pass --authorized-browser to run the isolated browser checks.\n');
  process.exit(0);
}
const PLAYWRIGHT = require.resolve('playwright', { paths: [REPO, path.join(REPO, 'frontend'), '/Users/ssoe94/dev/mes-qc/wj_reporting-standard-20261003'] });
const CHROME = process.env.WJ_INSPECTION_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const machineCardsOnly = process.argv.includes('--machine-cards-only');
const basename = process.argv.slice(2).find(arg => !['--authorized-browser', '--machine-cards-only'].includes(arg)) || `inspection-room-browser-${Date.now()}`;
assert.match(basename, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const OUTPUT = path.join(REPO, 'output', basename);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const fixtures = require('./inspection-room-fixtures.cjs');
const kanban = fixtures.kanban;
const pair = fixtures.authPair();

(async () => {
  const { chromium } = require(PLAYWRIGHT);
  const index = fs.readFileSync(path.join(DIST, 'index.html'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wj-inspection-room-'));
  const report = { ok: false, fixture_only: true, source_kind: 'synthetic_contract_fixture', machine_cards_only: machineCardsOnly, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
    runner_sha256: sha(fs.readFileSync(__filename)), index_sha256: sha(index), layouts: [], screenshots: [], mutations: [], blocked: [], page_errors: [], checks: [] };
  let context, stage = 'launch';
  const verify = (condition, name) => { assert.ok(condition, name); report.checks.push(name); };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: CHROME, headless: true, serviceWorkers: 'block', viewport: { width: 1920, height: 1080 },
      proxy: { server: 'http://127.0.0.1:9' }, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--dns-prefetch-disable', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
    context.setDefaultTimeout(6000);
    await context.routeWebSocket('**/*', socket => { report.blocked.push('websocket'); socket.close(); });
    async function newPage(language, viewport, scenario = 'normal') {
      const page = await context.newPage();
      await page.setViewportSize(viewport);
      const records = fixtures.records();
      const weeklyRoster = fixtures.createWeeklyRosterStore();
      page.on('pageerror', error => report.page_errors.push(error.message));
      page.on('dialog', dialog => dialog.dismiss());
      await page.addInitScript(({ origin, pair, key, language }) => {
        if (location.origin !== origin) return;
        localStorage.clear(); sessionStorage.clear();
        localStorage.setItem(key, JSON.stringify({ id: 'synthetic-inspection-room', ...pair }));
        for (const [name, value] of Object.entries({ access_token: pair.access, wj_next_access_token: pair.access, refresh_token: pair.refresh, wj_next_refresh_token: pair.refresh, lang: language, wj_next_language: language })) localStorage.setItem(name, value);
      }, { origin: ORIGIN, pair, key: CONTROL, language });
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== ORIGIN) {
          if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
          if (url.hostname === 'fonts.gstatic.com') return route.abort('blockedbyclient');
          report.blocked.push(`${req.method()} ${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
        }
        if (url.pathname.startsWith('/api/')) {
          if (req.method() === 'GET' && url.pathname === '/api/injection/user/me/') return json(route, fixtures.currentUser());
          if (req.method() === 'POST' && url.pathname === '/api/auth/activity/') return json(route, fixtures.activityResponse(pair));
          if (req.method() === 'GET' && url.pathname === '/api/production/status/') return json(route, { injection: [], machining: [] });
          if (req.method() === 'GET' && url.pathname === `${API}capabilities/`) return json(route, fixtures.capabilities());
          if (req.method() === 'GET' && url.pathname === `${API}role-settings/`) return json(route, fixtures.roleSettings());
          if (req.method() === 'GET' && url.pathname === `${API}weekly-role-settings/`) return json(route, weeklyRoster.read(url.searchParams.get('week_start')));
          if (req.method() === 'POST' && url.pathname === `${API}weekly-role-settings/`) {
            const result = weeklyRoster.save(req.postDataJSON(), req.headers()['idempotency-key']);
            report.mutations.push({ action: 'weekly-role-settings', fixture_only: true, status: result.status });
            return json(route, result.body, result.status);
          }
          if (req.method() === 'GET' && url.pathname === `${API}kanban/`) {
            if (scenario === 'error') return json(route, { detail: 'SYNTHETIC fixture unavailable' }, 503);
            return json(route, kanban(scenario === 'empty' ? [] : records, url.searchParams.get('date')));
          }
          if (req.method() === 'GET' && url.pathname === API) return json(route, { count: scenario === 'empty' ? 0 : records.length, next: null, previous: null, results: scenario === 'empty' ? [] : records, work_groups: [], work_groups_truncated: false });
          const id = Number(url.pathname.slice(API.length).replace(/\/$/, ''));
          if (req.method() === 'GET' && records.some(row => row.id === id)) return json(route, records.find(row => row.id === id));
          const actionMatch = url.pathname.match(/\/7\/(area-save|area-complete|submit)\/$/);
          if (req.method() === 'POST' && actionMatch) {
            const body = req.postDataJSON(), row = records[1], action = actionMatch[1];
            verify(Boolean(req.headers()['idempotency-key']), `${action}_idempotency_key`);
            const result = fixtures.mutation(row, action, body);
            verify(result.status === 200, `${action}_synthetic_fixture_contract`);
            // Match the server audit action; the fixture remains entirely local.
            if (action.startsWith('area-')) {
              row.audit.at(-1).action = `role_${body.area}_${action === 'area-save' ? 'save' : 'complete'}`;
              result.body.audit = clone(row.audit);
            }
            report.mutations.push({ action, fixture_only: true });
            return json(route, result.body, result.status);
          }
          report.blocked.push(`${req.method()} ${url.pathname}`); return route.abort('blockedbyclient');
        }
        if (req.method() === 'GET' && [ROUTE, '/login'].includes(url.pathname)) return route.fulfill({ contentType: 'text/html', body: index });
        const file = path.resolve(DIST, '.' + url.pathname);
        if (req.method() === 'GET' && file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const mime = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
          return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
        }
        report.blocked.push(`${req.method()} ${url.pathname}`); return route.abort('blockedbyclient');
      });
      await page.goto(ORIGIN + ROUTE, { waitUntil: 'domcontentloaded' });
      await page.locator('.inspection-station-picker').waitFor();
      if (scenario !== 'error') await page.locator('.inspection-station-grid [data-machine]').first().waitFor();
      return page;
    }
    const capture = async (page, name) => {
      const file = `${OUTPUT}-${name}.png`, bytes = await page.screenshot({ fullPage: false, animations: 'disabled' });
      fs.writeFileSync(file, bytes, { mode: 0o600 }); report.screenshots.push({ name, path: file, sha256: sha(bytes) });
    };
    const layout = async (page, name) => {
      const bounds = await page.evaluate(() => ({ viewport: innerWidth, height: innerHeight, document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth, card_tops: [...document.querySelectorAll('.inspection-station-grid [data-machine]')].map(card => card.getBoundingClientRect().top) }));
      report.layouts.push({ name, ...bounds });
      verify(bounds.document <= bounds.viewport + 1 && bounds.body <= bounds.viewport + 1, `${name}_no_document_horizontal_overflow`);
      return bounds;
    };
    const openRequest = async (page, id) => {
      await page.locator(`.inspection-station-grid [data-machine="${id}"]`).click();
      await page.locator('#inspection-detail-title').filter({ hasText: id === 7 ? 'WJ-PART-027' : `SYNTHETIC-PART-${id}` }).waitFor();
    };


    stage = 'compact_list';
    const page = await newPage('ko', { width: 1680, height: 962 });
    await layout(page, stage);
    const machineRows = await page.locator('.inspection-station-tile').evaluateAll(nodes => {
      const rows = new Map();
      for (const node of nodes) { const top = Math.round(node.getBoundingClientRect().top); rows.set(top, [...(rows.get(top) || []), Number(node.dataset.machine)]); }
      return [...rows.values()];
    });
    verify(JSON.stringify(machineRows) === JSON.stringify([[1,2,3,4,5,6,7,8,9],[10,11,12,13,14,15,16,17]]), 'desktop_machine_cards_two_rows_nine_plus_eight');
    verify(await page.locator('.inspection-station-tile').count() === 17, 'all_machine_choices_preserved');
    verify(await page.locator('.inspection-station-part').count() === 17 && await page.locator('.inspection-station-production').count() === 17, 'each_machine_has_part_and_production_evidence');
    const fonts = await page.locator('.inspection-station-tile strong, .inspection-station-tile span').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)));
    verify(fonts.every(size => size >= 14), 'machine_card_text_at_least_14px');
    for (const [number, tone, wording] of [[1, 'requested', '초검 요청'], [2, 'needed', '순검 검사 필요'], [3, 'overdue', '순검 기한 초과'], [4, 'completed', '초검 완료'], [5, 'failed', '초검 불합격']]) {
      verify(await page.locator(`[data-machine="${number}"] .inspection-station-signal[data-tone="${tone}"]`).filter({ hasText: wording }).count() === 1, `machine_${number}_semantic_color_and_text`);
    }
    for (const number of [5,6,8,9,10,11,14,15,16]) verify(await page.locator(`[data-machine="${number}"] [data-tone="completed"]`).count() === 0, `machine_${number}_uncertain_or_failed_never_green`);
    verify(await page.locator('.inspection-station-source').textContent() === '합성 MES 예시 · 실제 MES 수신 아님', 'synthetic_mes_source_explicitly_visible');
    await capture(page, '02-list-synthetic');
    process.stdout.write('SCREENSHOT_READY ' + report.screenshots.at(-1).path + '\n');
    if (machineCardsOnly) {
      verify(report.page_errors.length === 0, 'no_uncaught_browser_errors');
      verify(report.blocked.length === 0, 'all_network_requests_fulfilled_by_local_fixtures');
      report.ok = true;
      return;
    }

    stage = 'assignment';
    await page.getByRole('button', { name: '담당자·교대 설정', exact: true }).click();
    await page.locator('.inspection-weekly-settings[aria-busy="false"]').waitFor();
    verify(await page.locator('.inspection-weekly-card').count() === 4, 'weekly_exactly_four_cards');
    const weeklySlots = ['DAY-dimension', 'DAY-appearance', 'NIGHT-dimension', 'NIGHT-appearance'];
    for (let index = 0; index < weeklySlots.length; index++) verify(await page.locator(`#inspection-weekly-${weeklySlots[index]}`).inputValue() === String(501 + index), `weekly_${weeklySlots[index]}_display_roster_loaded`);
    verify(await page.locator('.inspection-weekly-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-weekly-slot')).join(',')) === weeklySlots.join(','), 'weekly_card_order_day_dimension_day_appearance_night_dimension_night_appearance');
    await layout(page, 'weekly_assignment_desktop');
    verify(await page.locator('.inspection-weekly-card :is(input,select)').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height >= 44)), 'weekly_fields_touch_targets_44px');
    await page.evaluate(() => window.scrollTo(0, 0));
    verify(await page.locator('.inspection-weekly-advanced').getAttribute('open') === null, 'technical_settings_explanations_collapsed');
    await page.locator('.inspection-weekly-advanced > summary').focus();
    await page.keyboard.press('Enter');
    verify(await page.locator('.inspection-weekly-advanced').getAttribute('open') !== null, 'settings_explanation_keyboard_operable');
    await page.keyboard.press('Enter');
    const captureWeekly = async name => {
      const file = `${OUTPUT}-${name}.png`, bytes = await page.locator('.inspection-weekly-settings').screenshot({ animations: 'disabled' });
      fs.writeFileSync(file, bytes, { mode: 0o600 }); report.screenshots.push({ name, path: file, sha256: sha(bytes), region: 'current-built-app-weekly-settings' });
    };
    await captureWeekly('03-assignment-synthetic');
    process.stdout.write('SCREENSHOT_READY ' + report.screenshots.at(-1).path + '\n');
    await page.setViewportSize({ width: 390, height: 844 });
    await layout(page, 'weekly_assignment_mobile');
    verify(await page.locator('.inspection-weekly-card').evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().left))).size) === 1, 'weekly_mobile_single_column');
    await captureWeekly('03b-assignment-mobile-synthetic');
    await page.setViewportSize({ width: 1680, height: 962 });
    const originalWeek = await page.locator('#inspection-weekly-week').inputValue();
    await page.locator('#inspection-weekly-DAY-dimension').selectOption('new');
    await page.locator('#inspection-weekly-DAY-dimension-name').fill('SYNTHETIC 新姓名');
    await page.getByRole('button', { name: '다음 주', exact: true }).click();
    verify(await page.locator('#inspection-weekly-week').inputValue() === originalWeek && await page.locator('#inspection-weekly-DAY-dimension-name').inputValue() === 'SYNTHETIC 新姓名', 'weekly_unsaved_navigation_cancel_preserves_draft');
    await page.getByRole('button', { name: '이번 주 담당자 저장', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '주간 담당자를 저장했습니다.' }).waitFor();
    verify(await page.locator('#inspection-weekly-DAY-dimension').inputValue() === '505', 'weekly_saved_display_name_returns_roster_identity');
    await page.getByRole('button', { name: '다음 주', exact: true }).click();
    await page.locator('.inspection-weekly-settings[aria-busy="false"]').waitFor();
    await page.getByRole('button', { name: '이전 주', exact: true }).click();
    await page.locator('.inspection-weekly-settings[aria-busy="false"]').waitFor();
    verify(await page.locator('#inspection-weekly-week').inputValue() === originalWeek && await page.locator('#inspection-weekly-DAY-dimension').inputValue() === '505', 'weekly_saved_roster_survives_week_navigation');
    await page.locator('.inspection-weekly-settings > .inspection-detail-heading button').click();
    await openRequest(page, 7);
    stage = 'input_table';
    verify(await page.locator('.inspection-role-workspace table').count() === 1, 'one_semantic_inspection_input_table');
    verify(await page.locator('.inspection-role-workspace tbody[data-card-area]').evaluateAll(nodes => nodes.map(node => node.dataset.cardArea).join(',')) === 'dimension,appearance', 'one_table_preserves_dimension_appearance_groups');
    const record = fixtures.record(7, true);
    for (let index = 0; index < record.inspection_items.length; index++) {
      const item = record.inspection_items[index], control = page.locator(`#inspection-item-7-${index}-value`);
      if (item.kind === 'number') await control.fill(((Number(item.minimum) + Number(item.maximum)) / 2).toFixed(2));
      else await control.selectOption('合格');
    }
    verify(await page.locator('.inspection-role-row-state[data-state="unsaved"]').count() === 16, 'all_current_synthetic_values_show_unsaved');
    await page.locator('#inspection-item-7-0-value').focus();
    await page.locator('#inspection-item-7-0-value').press('Enter');
    verify(await page.locator('#inspection-item-7-1-value').evaluate(n => n === document.activeElement), 'enter_moves_to_next_input');
    await page.locator('#inspection-item-7-1-value').press('Tab');
    verify(await page.evaluate(() => document.activeElement?.id === 'inspection-item-7-2-value'), 'tab_uses_native_input_order');
    await page.locator('.inspection-save-help summary').focus();
    await page.keyboard.press('Enter');
    verify(await page.locator('.inspection-save-help').getAttribute('open') !== null, 'explanation_opens_with_keyboard');
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.scrollTo(0, 0));
    await capture(page, '04-input-table-synthetic');
    process.stdout.write('SCREENSHOT_READY ' + report.screenshots.at(-1).path + '\n');
    await page.setViewportSize({ width: 1680, height: 1440 });
    await page.locator('.inspection-role-sheet-scroll').evaluate(node => { node.scrollTop = 0; });
    const worksheetFile = `${OUTPUT}-04b-unified-worksheet-synthetic.png`;
    const worksheetBytes = await page.locator('.inspection-role-workspace').screenshot({ animations: 'disabled' });
    fs.writeFileSync(worksheetFile, worksheetBytes, { mode: 0o600 });
    report.screenshots.push({ name: '04b-unified-worksheet-synthetic', path: worksheetFile, sha256: sha(worksheetBytes), region: 'current-built-app-unified-worksheet', viewport: { width: 1680, height: 1440 } });
    await page.setViewportSize({ width: 1680, height: 962 });
    await page.locator('.inspection-role-area-control[data-inspection-area="dimension"] [data-area-action="save"]').click();
    await page.waitForFunction(() => document.querySelector('.inspection-role-detail')?.getAttribute('aria-busy') === 'false');
    verify(await page.locator('.inspection-role-row-state[data-state="unsaved"]').count() === 10, 'appearance_draft_preserved_after_dimension_save');
    await page.locator('.inspection-role-area-control[data-inspection-area="appearance"] [data-area-action="save"]').click();
    await page.locator('.inspection-final-dialog').waitFor();
    await capture(page, '05-completion-choice-synthetic');
    process.stdout.write('SCREENSHOT_READY ' + report.screenshots.at(-1).path + '\n');
    await page.keyboard.press('Tab');
    verify(await page.locator('.inspection-final-option[data-verdict="pass"]').evaluate(n => n === document.activeElement), 'final_dialog_keyboard_enters_first_option');
    await page.keyboard.press('Shift+Tab');
    verify(await page.locator('.inspection-final-dialog').evaluate(n => n.contains(document.activeElement)), 'final_dialog_focus_stays_inside');
    await page.locator('.inspection-final-option[data-verdict="pass"]').click();
    await page.getByRole('button', { name: '판정 저장·제출', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.inspection-final-dialog') && document.querySelector('.inspection-role-detail')?.getAttribute('aria-busy') === 'false');
    verify(await page.locator('.inspection-role-row-state[data-state="saved"]').count() === 16, 'all_values_saved_after_completion');
    verify(report.mutations.filter(row => row.action === 'area-complete').length === 2 && report.mutations.filter(row => row.action === 'submit').length === 1, 'separate_save_complete_submit_local_contract');
    await page.evaluate(() => window.scrollTo(0, 0));
    await capture(page, '06-completed-synthetic');
    process.stdout.write('SCREENSHOT_READY ' + report.screenshots.at(-1).path + '\n');
    await page.getByRole('button', { name: /처리 이력/ }).click();
    verify(await page.locator('.inspection-history-table tbody tr').count() === 5, 'short_history_time_actor_action_result');
    verify(await page.locator('.inspection-history-table tbody tr td:nth-child(3)').filter({ hasText: /^처리$/ }).count() === 0, 'history_uses_server_area_action_labels');
    await page.locator('.inspection-history-table').scrollIntoViewIfNeeded();
    await capture(page, '07-history-synthetic');
    await page.close();
    for (const [language, width] of [['ko', 390], ['zh', 1366]]) {
      stage = `${language}_${width}`;
      const other = await newPage(language, { width, height: width === 390 ? 844 : 768 });
      await openRequest(other, 7);
      await layout(other, stage);
      if (width === 390) {
        const heights = await other.locator('.inspection-station-tile, .inspection-area-card input, .inspection-area-card select').evaluateAll(nodes => nodes.filter(n => n.getBoundingClientRect().width > 0).map(n => n.getBoundingClientRect().height));
        verify(heights.every(h => h >= 44), 'narrow_screen_touch_targets_at_least_44');
      }
      await capture(other, `${stage}-synthetic`);
      await other.close();
    }
    for (const scenario of ['empty', 'error']) {
      stage = scenario;
      const other = await newPage('ko', { width: 1366, height: 768 }, scenario);
      if (scenario === 'error') { await other.locator('.inspection-station-picker [role="alert"]').waitFor(); verify(await other.locator('.inspection-station-picker [role="alert"]').isVisible(), 'error_remains_visible'); }
      await layout(other, stage); await capture(other, `${stage}-synthetic`); await other.close();
    }
    verify(report.page_errors.length === 0, 'no_uncaught_browser_errors');
    verify(report.blocked.length === 0, 'all_network_requests_fulfilled_by_local_fixtures');
    report.ok = true;
  } catch (error) { report.error = { stage, name: error.name, message: error.message }; process.exitCode = 1; }
  finally {
    if (context) await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(`${OUTPUT}.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: report.ok, stage, checks: report.checks.length, output: `${OUTPUT}.json`, error: report.error }) + '\n');
  }
})();
