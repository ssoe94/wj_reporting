#!/usr/bin/env node
// Entire-app browser checks with synthetic HR data only. No backend, proxy,
// project environment, real credentials, or payroll files are read by this tool.
// Build frontend/dist first, then run from the worktree root:
// node scripts/check-hr-roster-browser.cjs --screens /absolute/path/to/screens
// Optional: --playwright /absolute/path/to/playwright --port 4193 --dist <path>
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  assert.ok(['--screens', '--playwright', '--port', '--dist'].includes(name), `Unknown option: ${name}`);
  assert.ok(process.argv[i + 1], `Missing value: ${name}`);
  options[name.slice(2)] = process.argv[i + 1];
}
const repo = path.resolve(__dirname, '..');
const dist = path.resolve(options.dist || path.join(repo, 'frontend/dist'));
assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'Build frontend/dist before this browser check.');
const screens = path.resolve(options.screens || path.join(os.homedir(), 'Documents/Codex/2026-11-12/hr-roster/screens'));
assert.ok(!screens.startsWith(repo + path.sep), 'Keep screenshots outside the repository.');
fs.mkdirSync(screens, { recursive: true });
const playwrightPath = options.playwright || process.env.WJ_HR_PLAYWRIGHT;
let playwright;
if (playwrightPath) playwright = require(path.resolve(playwrightPath));
else {
  try { playwright = require('playwright'); }
  catch {
    // Reuse a previously installed runtime; never download packages or browsers.
    playwright = require(path.join(os.homedir(), '.npm/_npx/e41f203b7505f1fb/node_modules/playwright'));
  }
}
const port = Number(options.port || 4193);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Use an unprivileged loopback port.');
const origin = `http://127.0.0.1:${port}`;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const respond = (status, type, body) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.headers.host !== `127.0.0.1:${port}` || req.method !== 'GET') return respond(403, 'text/plain', 'Fixture only');
  const pathname = new URL(req.url, origin).pathname;
  if (pathname.startsWith('/api/')) return respond(404, 'application/json', '{"fixture_only":true}');
  let file;
  try { file = path.resolve(dist, '.' + decodeURIComponent(pathname)); }
  catch { return respond(400, 'text/plain', 'Invalid path'); }
  if (!file.startsWith(dist + path.sep)) file = path.join(dist, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (path.extname(pathname)) return respond(404, 'text/plain', 'Missing fixture asset');
    file = path.join(dist, 'index.html');
  }
  respond(200, mime[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
});

const MONTH = '2026-11';
const employees = () => Array.from({ length: 24 }, (_, index) => ({
  id: index + 1, code: String(90001 + index), name: index === 0 ? '测试甲' : `测试员工${String(index + 1).padStart(2, '0')}`,
  employment_type: index % 2 ? 'hourly' : 'contract', department: index % 2 ? '测试部门乙' : '测试部门甲',
  status: index < 18 ? 'active' : 'departed', first_month: '2026-01', last_month: MONTH,
  version: 4, previous_codes: index === 0 ? ['80001'] : [], in_month: index % 5 !== 0,
}));
const history = () => [{
  id: 2, created_at: '2026-11-12T05:00:00Z', actor_label: 'SYNTHETIC-REVIEWER', reason: 'SYNTHETIC status correction',
  previous_code: '90001', new_code: '90001', previous_status: 'departed', new_status: 'active',
  previous_employment_type: 'contract', new_employment_type: 'contract', previous_department: '测试部门甲', new_department: '测试部门甲',
}, {
  id: 1, created_at: '2026-11-11T04:00:00Z', actor_label: 'SYNTHETIC-IMPORTER', reason: 'SYNTHETIC code confirmation',
  previous_code: '80001', new_code: '90001', previous_status: 'active', new_status: 'active',
  previous_employment_type: 'contract', new_employment_type: 'contract', previous_department: '测试部门甲', new_department: '测试部门甲',
}];
const workspace = month => ({
  company_structure: { classification: { version: 'synthetic-003', nodes: [], leaders: [], groups: [] }, organization: { nodes: [], edges: [] } },
  month, currency: 'CNY', cost_basis: 'gross_salary', cost_basis_label: '', version: 1,
  departments: [], employees: [], source: null,
  summary: { total: '0.00', known_total: '0.00', known_cost_count: 0, missing_cost_count: 0, cost_complete: true, assigned_total: '0.00', unassigned_total: '0.00', employee_count: 0, assigned_count: 0, unassigned_count: 0, departments: [] },
  updated_at: null, history: [],
});
function token(kind) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'synthetic', typ: 'JWT' })}.${encode({ user_id: 90001, exp: Math.floor(Date.now() / 1000) + 86400, token_type: kind, fixture_only: true })}.SYNTHETIC-LOCAL-ONLY`;
}
const pair = { access: token('access'), refresh: token('refresh') };
const checks = [], captures = [], errors = [];
let browser;

async function fixture({ lang = 'ko', mobile = false, denied = false, scenario = 'normal' } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 843 } : { width: 1920, height: 1200 }, locale: lang === 'ko' ? 'ko-KR' : 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const state = { scenario, entries: employees(), rosterCalls: 0, historyCalls: 0, patches: [], blockedExternal: 0 };
  await context.addInitScript(({ pair, lang, origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('wj-auth-session-control-v2', JSON.stringify({ id: 'SYNTHETIC-HR-003', ...pair }));
    localStorage.setItem('lang', lang); localStorage.setItem('wj_next_language', lang);
  }, { pair, lang, origin });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { state.blockedExternal += 1; return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const reply = (status, json) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(json) });
    if (url.pathname === '/api/injection/user/me/') return reply(200, { id: 90001, username: 'SYNTHETIC-HR-REVIEWER', email: 'synthetic@example.invalid', is_staff: false, is_superuser: false, is_active: true, can_access_hr: !denied, groups: [], permissions: {} });
    if (url.pathname === '/api/quality/inspection-requests/capabilities/') return reply(200, {});
    if (url.pathname === '/api/auth/activity/') return reply(200, { ...pair, fixture_only: true });
    if (url.pathname === '/api/analytics/hr/workspaces/') return reply(200, { months: [{ month: MONTH, currency: 'CNY', version: 1 }] });
    const workspaceMatch = url.pathname.match(/^\/api\/analytics\/hr\/workspaces\/(\d{4}-\d{2})\/$/);
    if (workspaceMatch) return reply(200, workspace(workspaceMatch[1]));
    const rosterMatch = url.pathname.match(/^\/api\/analytics\/hr\/roster\/(\d{4}-\d{2})\/(?:(\d+)\/)?$/);
    if (rosterMatch) {
      state.rosterCalls += 1;
      if (denied) return reply(403, { detail: 'SYNTHETIC access denied' });
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON(); state.patches.push(body);
        if (state.scenario === 'conflict') { state.entries[0].version += 1; return reply(409, { detail: 'SYNTHETIC stale version' }); }
        state.entries = state.entries.map(entry => entry.id === Number(rosterMatch[2]) ? { ...entry, ...body, version: entry.version + 1 } : entry);
        return reply(200, { employees: state.entries });
      }
      if (rosterMatch[2]) {
        state.historyCalls += 1;
        if (state.scenario === 'history-error') return reply(503, { detail: 'SYNTHETIC history unavailable' });
        return reply(200, { history: Number(rosterMatch[2]) === 1 ? history() : [] });
      }
      if (state.scenario === 'error') return reply(503, { detail: 'SYNTHETIC roster unavailable' });
      return reply(200, { employees: state.scenario === 'empty' ? [] : state.entries });
    }
    return reply(404, { fixture_only: true, code: 'synthetic_endpoint_not_supported' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, state };
}
const rowCount = page => page.locator('.hr-roster-table > table > tbody > tr:not([id])').count();
async function waitRows(page, count) { await page.waitForFunction(expected => document.querySelectorAll('.hr-roster-table > table > tbody > tr:not([id])').length === expected, count); }
async function roster(page) { await page.goto(`${origin}/hr/roster?month=${MONTH}`); await page.locator('.hr-roster-page-panel').waitFor(); }
async function capture(page, name) { const file = path.join(screens, `003-${name}.png`); await page.screenshot({ path: file, fullPage: false }); captures.push(file); }
async function reset(page, ko = true) { await page.getByRole('button', { name: ko ? '초기화' : '重置', exact: true }).click(); await waitRows(page, 24); }

(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  browser = await playwright.chromium.launch({ headless: true });
  const ko = await fixture();
  await roster(ko.page); await waitRows(ko.page, 24);
  assert.equal(await ko.page.locator('.hr-tabs a').count(), 3);
  assert.equal(await ko.page.locator('.hr-tabs a[aria-current="page"]').getAttribute('href'), `/hr/roster?month=${MONTH}`);
  assert.deepEqual(await ko.page.locator('.hr-roster-summary strong').allTextContents(), ['18명', '6명', '5명']);
  await capture(ko.page, 'desktop-ko');
  for (const [index, count] of [[0, 18], [1, 6], [2, 5]]) {
    await ko.page.locator('.hr-roster-summary button').nth(index).click(); await waitRows(ko.page, count);
    assert.equal(await ko.page.locator('.hr-roster-summary button').nth(index).getAttribute('aria-pressed'), 'true');
  }
  checks.push('Summary buttons filter active, departed and missing-month employees');
  await reset(ko.page);
  const search = ko.page.getByRole('searchbox', { name: '사번·이름·이전 사번 검색' });
  for (const query of ['测试甲', '80001', '90001']) { await search.fill(query); await waitRows(ko.page, 1); assert.match(await ko.page.locator('.hr-roster-table tbody').innerText(), /测试甲/); }
  checks.push('Search matches name, current code and previous code');
  await reset(ko.page);
  await ko.page.getByLabel('고용형태', { exact: true }).selectOption('hourly'); await waitRows(ko.page, 12);
  await ko.page.getByLabel('재직 상태', { exact: true }).selectOption('departed'); await waitRows(ko.page, 3);
  await ko.page.getByLabel('이번 달 미포함만', { exact: true }).check(); await waitRows(ko.page, 0);
  checks.push('Employment, status and absence filters compose');
  await reset(ko.page);
  const scroller = ko.page.locator('.hr-roster-table');
  const before = await scroller.locator('thead th').first().boundingBox();
  await scroller.evaluate(el => { el.scrollTop = 250; });
  const after = await scroller.locator('thead th').first().boundingBox();
  assert.ok(before && after && Math.abs(before.y - after.y) < 2, 'Roster header remains fixed while the table scrolls');
  await scroller.evaluate(el => { el.scrollTop = 0; });
  checks.push('Roster table header stays fixed while scrolling');
  await ko.page.getByRole('button', { name: '90001 测试甲 변경 이력', exact: true }).click();
  const historyList = ko.page.locator('.hr-roster-history-list'); await historyList.waitFor();
  const historyRows = historyList.locator(':scope > li');
  assert.equal(await historyRows.count(), 2);
  assert.match(await historyRows.nth(0).innerText(), /SYNTHETIC-REVIEWER[\s\S]*SYNTHETIC status correction/);
  assert.deepEqual(await historyRows.nth(0).locator('ul strong').allTextContents(), ['상태']);
  assert.deepEqual(await historyRows.nth(1).locator('ul strong').allTextContents(), ['사번']);
  assert.ok((await historyRows.nth(0).locator('time').getAttribute('datetime')) > (await historyRows.nth(1).locator('time').getAttribute('datetime')));
  assert.match(await historyRows.nth(0).innerText(), /퇴사 → 재직/);
  await capture(ko.page, 'history');
  checks.push('Expanded history shows actor, reason, latest-first time and only changed fields');
  await ko.page.getByRole('button', { name: '90001 测试甲 변경 이력', exact: true }).click();
  await search.fill('90001'); await waitRows(ko.page, 1);
  await ko.page.getByRole('button', { name: '편집', exact: true }).click();
  const editor = ko.page.locator('.hr-roster-editor');
  await editor.getByLabel('상태', { exact: true }).selectOption('departed');
  assert.equal(await editor.getByRole('button', { name: '저장', exact: true }).isDisabled(), true);
  await editor.getByLabel('변경 사유', { exact: true }).fill('SYNTHETIC review reason');
  await capture(ko.page, 'editing');
  ko.state.scenario = 'conflict';
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  await ko.page.getByText(/초안은 유지됩니다/).waitFor();
  assert.equal(await editor.getByLabel('변경 사유', { exact: true }).inputValue(), 'SYNTHETIC review reason');
  assert.equal(await editor.getByLabel('상태', { exact: true }).inputValue(), 'departed');
  assert.equal(await editor.getByRole('button', { name: '저장', exact: true }).isDisabled(), true);
  assert.deepEqual(ko.state.patches, [{ version: 4, reason: 'SYNTHETIC review reason', status: 'departed' }]);
  checks.push('Status edit requires a reason; 409 preserves the draft and blocks stale resubmission');
  await editor.getByRole('button', { name: '취소', exact: true }).click();
  await ko.page.goto(`${origin}/hr/personnel?month=${MONTH}`);
  const shortcut = ko.page.getByRole('link', { name: /명부 보기/ }); await shortcut.waitFor();
  assert.equal(await shortcut.getAttribute('href'), `/hr/roster?month=${MONTH}`);
  assert.equal(await ko.page.locator('.hr-roster-page-panel').count(), 0);
  await shortcut.click(); await ko.page.locator('.hr-roster-page-panel').waitFor();
  checks.push('Personnel header opens the same-month roster; the former collapsed roster is absent');
  await ko.context.close();

  const zh = await fixture({ lang: 'zh' }); await roster(zh.page); await waitRows(zh.page, 24);
  assert.ok(!/[가-힣]/.test(await zh.page.locator('.hr-page').innerText()), 'Chinese roster does not show Korean labels');
  await capture(zh.page, 'desktop-zh'); await zh.context.close();
  const mobile = await fixture({ lang: 'zh', mobile: true }); await roster(mobile.page); await waitRows(mobile.page, 24);
  const dimensions = await mobile.page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scrollWidth <= dimensions.width, `Mobile page overflows: ${JSON.stringify(dimensions)}`);
  const tooSmall = await mobile.page.locator('.hr-page button, .hr-page select, .hr-page input:not([type="checkbox"]), .hr-tabs a, .hr-roster-absent').evaluateAll(elements => elements.filter(el => {
    const box = el.getBoundingClientRect(); return box.width && box.height && (box.height < 43.9 || box.width < 43.9);
  }).map(el => ({ tag: el.tagName, label: el.getAttribute('aria-label') || el.textContent, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
  assert.deepEqual(tooSmall, [], 'Mobile roster touch targets are at least 44 × 44 px');
  await capture(mobile.page, 'mobile'); checks.push('Chinese labels, 390px page containment and 44px mobile touch targets'); await mobile.context.close();

  const empty = await fixture({ scenario: 'empty' }); await roster(empty.page);
  await empty.page.getByText('등록된 직원이 없습니다.', { exact: true }).waitFor();
  assert.equal(await rowCount(empty.page), 0); await capture(empty.page, 'empty'); await empty.context.close();
  const failure = await fixture({ scenario: 'error' }); await failure.page.goto(`${origin}/hr/roster?month=${MONTH}`);
  await failure.page.getByRole('alert').filter({ hasText: /명부|인사/ }).first().waitFor();
  await capture(failure.page, 'error'); failure.state.scenario = 'normal';
  await failure.page.getByRole('button', { name: /다시 시도|다시 불러오기/ }).click(); await waitRows(failure.page, 24);
  checks.push('Empty state and error retry recover without fabricated zero values'); await failure.context.close();
  const historyFailure = await fixture({ scenario: 'history-error' }); await roster(historyFailure.page); await waitRows(historyFailure.page, 24);
  await historyFailure.page.getByRole('button', { name: '90001 测试甲 변경 이력', exact: true }).click();
  await historyFailure.page.locator('.hr-roster-history').getByText('이력을 불러오지 못했습니다.', { exact: false }).waitFor();
  historyFailure.state.scenario = 'normal'; await historyFailure.page.locator('.hr-roster-history').getByRole('button', { name: '다시 시도' }).click();
  await historyFailure.page.locator('.hr-roster-history-list').waitFor(); checks.push('History error retries independently'); await historyFailure.context.close();
  const denied = await fixture({ denied: true }); await denied.page.goto(`${origin}/hr/roster?month=${MONTH}`);
  await denied.page.waitForURL('**/dashboard');
  assert.equal(await denied.page.locator('.hr-roster-page-panel, .hr-tabs').count(), 0);
  assert.equal(await denied.page.locator('a[href^="/hr/"]').count(), 0);
  assert.equal(denied.state.rosterCalls, 0);
  checks.push('Unauthorized user cannot open the roster route, see HR links or request roster data'); await denied.context.close();
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log(JSON.stringify({ fixture_only: true, checks_passed: checks.length, checks, screenshots: captures }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});
