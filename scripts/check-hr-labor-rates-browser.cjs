#!/usr/bin/env node
// Entire-app browser checks with synthetic HR data only. No backend, proxy,
// project environment, real credentials, or payroll files are read by this tool.
// Build frontend/dist first, then run from the worktree root:
// node scripts/check-hr-labor-rates-browser.cjs --screens /absolute/path/to/screens
// Optional: --playwright /absolute/path/to/playwright --port 4195 --dist <path>
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
assert.ok(!screens.startsWith(repo + path.sep) || screens.startsWith(path.join(repo, 'work') + path.sep),
  'Keep screenshots outside tracked paths; use the ignored work directory for local regressions.');
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
const port = Number(options.port || 4195);
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
const clone = value => JSON.parse(JSON.stringify(value));
// These are user-selected company rule examples, never employee payroll data.
function rulesFixture() {
  const contribution = items => ({
    applies_to: { contract: null, hourly: null },
    base: { rule: null, common_amount: null, employee_amounts: {}, lower: null, upper: null },
    items: Object.fromEntries(items.map(item => [item, { employer_rate: null, employee_rate: null }])),
  });
  return {
    multipliers: { workday: '1.5', rest_day: '2', public_holiday: '3' },
    contract: { days_per_month: '21.75', hours_per_day: '8' },
    hourly_premium: { enabled: true, confirmed: true },
    department_overtime: { 注塑: '4', 模具: '4', 公务: '4', 品质: '4', 加工: '2.5', 营业: '2.5', 资材: '2.5', 开发: '1', 管理部: null, 总经办: null },
    weekday_excluded_titles: { titles: ['Part長', '部长', '财务部长兼办公室主任', '技术生产总经理'], confirmed: true },
    department_hours_include_fixed_overtime: false,
    hourly_rates: { company_default: { amount: '24.50', confirmed: false }, employee_overrides: [] },
    contributions: {
      social_insurance: contribution(['pension', 'medical', 'unemployment', 'work_injury', 'maternity']),
      housing_fund: contribution(['housing_fund']),
    },
  };
}
function rosterFixture() {
  return [
    { id: 1, code: '90001', name: '测试甲', employment_type: 'hourly', department: '测试部门', status: 'active', first_month: '2026-01', last_month: MONTH, version: 1, previous_codes: [], in_month: true },
    { id: 2, code: '90002', name: '测试乙', employment_type: 'contract', department: '测试部门', status: 'active', first_month: '2026-01', last_month: MONTH, version: 1, previous_codes: [], in_month: true },
  ];
}
const emptyAmounts = () => ({ social_insurance: { total: null, contract: null, hourly: null }, housing_fund: { total: null, contract: null, hourly: null } });
function historyEntry(version, before, after, reason) {
  return { id: version, version, before: clone(before), after: clone(after), reason,
    actor_label: 'SYNTHETIC-HR-REVIEWER', created_at: '2026-11-12T06:00:00Z' };
}
function token(kind) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'synthetic', typ: 'JWT' })}.${encode({ user_id: 90001, exp: Math.floor(Date.now() / 1000) + 86400, token_type: kind, fixture_only: true })}.SYNTHETIC-LOCAL-ONLY`;
}
const pair = { access: token('access'), refresh: token('refresh') };
const checks = [], captures = [], errors = [];
let browser;

async function fixture({ lang = 'ko', mobile = false, denied = false, scenario = 'normal' } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 843 } : { width: 1920, height: 1200 }, locale: lang === 'ko' ? 'ko-KR' : 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const rules = rulesFixture();
  const state = { scenario, standardCalls: 0, calendarCalls: 0, rosterCalls: 0, actualCalls: 0,
    standardWrites: [], calendarWrites: [], actualWrites: [], blockedExternal: 0,
    standards: { month: MONTH, version: 4, source_month: MONTH, source_version: 4, rules,
      periods: [{ month: MONTH, version: 4 }], history: [historyEntry(4, rules, rules, 'SYNTHETIC standard initialized')] },
    calendar: { month: MONTH, version: 2, days: {}, history: [historyEntry(2, {}, {}, 'SYNTHETIC calendar initialized')] },
    actual: { month: MONTH, version: 3, measurement: 'actual', amounts: emptyAmounts(), evidence_memo: '', history: [] },
  };
  await context.addInitScript(({ pair, lang, origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('wj-auth-session-control-v2', JSON.stringify({ id: 'SYNTHETIC-HR-005', ...pair }));
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
    if (/^\/api\/analytics\/hr\/roster\/\d{4}-\d{2}\/$/.test(url.pathname)) {
      state.rosterCalls += 1;
      return denied ? reply(403, { detail: 'SYNTHETIC access denied' }) : reply(200, { employees: rosterFixture() });
    }
    const actualMatch = url.pathname.match(/^\/api\/analytics\/hr\/labor-actual-payments\/(\d{4}-\d{2})\/$/);
    if (actualMatch) {
      state.actualCalls += 1;
      if (denied) return reply(403, { detail: 'SYNTHETIC access denied' });
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON(); state.actualWrites.push(body);
        if (state.scenario === 'actual-conflict') { state.actual.version += 1; return reply(409, { detail: 'SYNTHETIC stale actual payment' }); }
        if (!body.reason?.trim()) return reply(400, { detail: 'SYNTHETIC reason required' });
        const before = { amounts: state.actual.amounts, evidence_memo: state.actual.evidence_memo };
        const after = { amounts: clone(body.amounts), evidence_memo: body.evidence_memo };
        state.actual = { ...state.actual, ...after, month: actualMatch[1], version: state.actual.version + 1,
          history: [historyEntry(state.actual.version + 1, before, after, body.reason), ...state.actual.history] };
      }
      return reply(200, { ...state.actual, month: actualMatch[1] });
    }
    const standardMatch = url.pathname.match(/^\/api\/analytics\/hr\/labor-standards\/(\d{4}-\d{2})\/$/);
    if (standardMatch) {
      state.standardCalls += 1;
      if (denied) return reply(403, { detail: 'SYNTHETIC access denied' });
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON(); state.standardWrites.push(body);
        if (state.scenario === 'conflict') { state.standards.version += 1; return reply(409, { detail: 'SYNTHETIC stale standard' }); }
        if (!body.reason?.trim()) return reply(400, { detail: 'SYNTHETIC reason required' });
        const before = state.standards.rules;
        state.standards = { ...state.standards, month: standardMatch[1], version: state.standards.version + 1,
          source_month: standardMatch[1], source_version: state.standards.version + 1, rules: clone(body.rules),
          history: [historyEntry(state.standards.version + 1, before, body.rules, body.reason), ...state.standards.history] };
        state.standards.periods = [{ month: standardMatch[1], version: state.standards.version }];
      }
      if (state.scenario === 'error') return reply(503, { detail: 'SYNTHETIC standard unavailable' });
      return reply(200, { ...state.standards, month: standardMatch[1] });
    }
    const calendarMatch = url.pathname.match(/^\/api\/analytics\/hr\/labor-calendar\/(\d{4}-\d{2})\/$/);
    if (calendarMatch) {
      state.calendarCalls += 1;
      if (denied) return reply(403, { detail: 'SYNTHETIC access denied' });
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON(); state.calendarWrites.push(body);
        if (state.scenario === 'calendar-conflict') { state.calendar.version += 1; return reply(409, { detail: 'SYNTHETIC stale calendar' }); }
        if (!body.reason?.trim()) return reply(400, { detail: 'SYNTHETIC reason required' });
        const before = state.calendar.days;
        state.calendar = { month: calendarMatch[1], version: state.calendar.version + 1, days: clone(body.days),
          history: [historyEntry(state.calendar.version + 1, before, body.days, body.reason), ...state.calendar.history] };
      }
      return reply(200, { ...state.calendar, month: calendarMatch[1] });
    }
    return reply(404, { fixture_only: true, code: 'synthetic_endpoint_not_supported' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, state };
}
async function capture(page, name) {
  const file = path.join(screens, `005-${name}.png`);
  await page.screenshot({ path: file, fullPage: false }); captures.push(file);
}
async function standards(page) {
  await page.goto(`${origin}/hr/work?step=standards&month=${MONTH}`);
  await page.locator('.hr-labor-rules-form').waitFor();
}
async function mobileContainment(page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scrollWidth <= dimensions.width, `Mobile page overflows: ${JSON.stringify(dimensions)}`);
  const tooSmall = await page.locator('.hr-page button, .hr-page select, .hr-page textarea, .hr-page input:not([type="checkbox"]), .hr-tabs a, .hr-page .hr-checkbox, .hr-page details > summary').evaluateAll(elements => elements.filter(el => {
    const box = el.getBoundingClientRect(); return box.width && box.height && (box.height < 43.9 || box.width < 43.9);
  }).map(el => ({ tag: el.tagName, label: el.getAttribute('aria-label') || el.textContent, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
  assert.deepEqual(tooSmall, [], 'Mobile labor-standard touch targets are at least 44 × 44 px');
}

async function checkCalendar() {
  const view = await fixture(); await standards(view.page);
  const form = view.page.locator('.hr-labor-calendar-form'); await form.waitFor();
  assert.equal(await form.locator('[data-date]').count(), 30);
  assert.equal(await form.locator('[data-date="2026-11-14"]').getAttribute('data-day-type'), 'rest_day');
  assert.equal(await form.locator('[data-date="2026-11-16"]').getAttribute('data-day-type'), 'workday');
  assert.equal(await form.locator('[data-day-type="public_holiday"]').count(), 0);
  await form.locator('[data-date="2026-11-14"]').click();
  await form.getByLabel('선택 날짜 유형', { exact: true }).selectOption('adjusted_workday');
  await form.getByLabel('달력 변경 사유', { exact: true }).fill('SYNTHETIC calendar regression');
  await form.getByRole('button', { name: '달력 저장', exact: true }).click();
  await view.page.waitForFunction(() => document.querySelector('.hr-labor-calendar-form .hr-section-heading')?.textContent.includes('v3'));
  assert.deepEqual(view.state.calendarWrites, [{ version: 2, reason: 'SYNTHETIC calendar regression', days: { '2026-11-14': 'adjusted_workday' } }]);
  await form.getByLabel('선택 날짜 유형', { exact: true }).selectOption('');
  await form.getByLabel('달력 변경 사유', { exact: true }).fill('SYNTHETIC restore weekday default');
  await form.getByRole('button', { name: '달력 저장', exact: true }).click();
  await view.page.waitForFunction(() => document.querySelector('.hr-labor-calendar-form .hr-section-heading')?.textContent.includes('v4'));
  assert.deepEqual(view.state.calendarWrites[1].days, {});
  assert.equal(await form.locator('[data-date="2026-11-14"]').getAttribute('data-day-type'), 'rest_day');
  checks.push('Existing calendar keeps weekday defaults, versioned overrides and explicit restoration');
  await view.context.close();
}

(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  browser = await playwright.chromium.launch({ headless: true });
  const ko = await fixture(); await standards(ko.page);
  const overview = ko.page.locator('.hr-labor-overview'); await overview.waitFor();
  const summaryRow = id => overview.locator(`[data-summary-id="${id}"]`);
  assert.equal(await summaryRow('hours').locator('td').nth(1).innerText(), '확정');
  assert.equal(await summaryRow('hourly').locator('td').nth(1).innerText(), '미확정');
  assert.equal(await summaryRow('social_insurance.pension').locator('td').nth(1).innerText(), '미입력');
  assert.equal(await summaryRow('hourly').locator('td').last().innerText(), MONTH);
  assert.match(await summaryRow('hourly').innerText(), /24\.50/);
  await capture(ko.page, 'overview');
  checks.push('Overview distinguishes confirmed, unconfirmed and missing values with their effective month');
  const form = ko.page.locator('.hr-labor-rules-form');
  assert.equal(await form.getByLabel('시급직 할증', { exact: true }).inputValue(), 'yes');
  assert.equal(await form.getByRole('checkbox', { name: /시급직 할증 규칙 확정/ }).isChecked(), true);
  assert.equal(await form.getByLabel('고정 연장수당 포함 여부', { exact: true }).inputValue(), 'no');
  assert.equal(await form.getByLabel('管理部 기본 야근 시간', { exact: true }).inputValue(), '');
  const titles = form.getByRole('textbox', { name: /^평일 연장수당 제외 직무 \(한 줄에 하나\)/ });
  assert.deepEqual((await titles.inputValue()).split('\n'), ['Part長', '部长', '财务部长兼办公室主任', '技术生产总经理']);
  const engineer = form.getByRole('checkbox', { name: '工程师도 평일 실적 야근 제외', exact: true });
  assert.equal(await engineer.isChecked(), false); await engineer.check();
  assert.equal((await titles.inputValue()).split('\n').filter(value => value === '工程师').length, 1);
  checks.push('Confirmed overtime defaults preserve four excluded titles, allow Engineer opt-in and keep management hours missing');

  await form.getByLabel('기준 변경 사유', { exact: true }).fill('SYNTHETIC integrated rate review');
  const save = form.getByRole('button', { name: '기준 저장', exact: true });
  await form.getByRole('button', { name: '직원 시급 예외 추가', exact: true }).click();
  await form.getByLabel('시급 예외 직원 1', { exact: true }).selectOption('1');
  await form.getByLabel('시급 예외 시작 월 1', { exact: true }).fill(MONTH);
  await form.getByLabel('시급 예외 금액 1', { exact: true }).fill('27.25');
  assert.equal(await save.isDisabled(), true, 'An employee hourly exception also requires its own reason');
  await form.getByLabel('시급 예외 사유 1', { exact: true }).fill('SYNTHETIC hourly exception');
  await form.locator('.hr-hourly-rates').scrollIntoViewIfNeeded(); await capture(ko.page, 'hourly-exceptions');
  checks.push('Hourly exceptions select a roster identity and require effective month, amount and reason');

  const insurance = form.locator('[data-fund="social_insurance"]');
  await insurance.getByLabel('사회보험 계약직 적용', { exact: true }).selectOption('yes');
  await insurance.getByLabel('사회보험 시급직 적용', { exact: true }).selectOption('no');
  const itemLabels = ['양로', '의료', '실업', '공상', '생육'];
  for (const item of itemLabels) {
    await insurance.getByLabel(`사회보험 ${item} 회사 요율`, { exact: true }).fill(item === '생육' ? '0' : '7.25');
    await insurance.getByLabel(`사회보험 ${item} 직원 요율`, { exact: true }).fill(item === '생육' ? '0' : '3.5');
  }
  assert.equal(await insurance.getByLabel('사회보험 생육 회사 요율', { exact: true }).inputValue(), '0');
  assert.ok(!(await insurance.getByLabel('사회보험 생육 회사 요율', { exact: true }).getAttribute('class')).includes('is-pending'), 'Explicit zero is not missing');
  await insurance.getByLabel('사회보험 기준액 규칙', { exact: true }).selectOption('common');
  await insurance.getByLabel('사회보험 회사 공통 기준액', { exact: true }).fill('3000');
  await insurance.getByLabel('사회보험 기준액 하한', { exact: true }).fill('1000');
  await insurance.getByLabel('사회보험 기준액 상한', { exact: true }).fill('5000');
  await insurance.getByLabel('사회보험 기준액 규칙', { exact: true }).selectOption('employee');
  await insurance.getByLabel('사회보험 기준액 직원 선택', { exact: true }).selectOption('2');
  await insurance.getByLabel('사회보험 추가할 직원 기준액', { exact: true }).fill('3500');
  await insurance.getByRole('button', { name: '직원 기준액 추가', exact: true }).click();
  assert.equal(await insurance.getByLabel('사회보험 직원 기준액 2', { exact: true }).inputValue(), '3500');
  const fund = form.locator('[data-fund="housing_fund"]');
  await fund.getByLabel('공적금 계약직 적용', { exact: true }).selectOption('yes');
  await fund.getByLabel('공적금 시급직 적용', { exact: true }).selectOption('yes');
  await fund.getByLabel('공적금 공적금 회사 요율', { exact: true }).fill('5');
  await fund.getByLabel('공적금 공적금 직원 요율', { exact: true }).fill('5');
  await fund.getByLabel('공적금 기준액 규칙', { exact: true }).selectOption('gross');
  await insurance.scrollIntoViewIfNeeded(); await capture(ko.page, 'insurance');
  await save.click();
  await ko.page.waitForFunction(() => document.querySelector('.hr-labor-rules-form .hr-section-heading')?.textContent.includes('v5'));
  assert.equal(ko.state.standardWrites.length, 1);
  const firstWrite = ko.state.standardWrites[0];
  assert.equal(firstWrite.version, 4); assert.equal(firstWrite.reason, 'SYNTHETIC integrated rate review');
  assert.deepEqual(firstWrite.rules.hourly_rates.employee_overrides, [{ employee_id: 1, effective_month: MONTH, amount: '27.25', reason: 'SYNTHETIC hourly exception' }]);
  assert.equal(firstWrite.rules.contributions.social_insurance.items.maternity.employer_rate, '0');
  assert.equal(firstWrite.rules.contributions.social_insurance.items.pension.employee_rate, '3.5');
  assert.equal(firstWrite.rules.contributions.social_insurance.base.rule, 'employee');
  assert.deepEqual(firstWrite.rules.contributions.social_insurance.base.employee_amounts, { 2: '3500' });
  assert.equal(firstWrite.rules.contributions.social_insurance.base.lower, '1000');
  assert.equal(firstWrite.rules.contributions.social_insurance.base.upper, '5000');
  assert.deepEqual(firstWrite.rules.contributions.social_insurance.applies_to, { contract: true, hourly: false });
  assert.equal(firstWrite.rules.contributions.housing_fund.base.rule, 'gross');
  assert.equal(firstWrite.rules.weekday_excluded_titles.titles.includes('工程师'), true);
  await summaryRow('employee-1').waitFor();
  assert.match(await summaryRow('employee-1').innerText(), /90001 测试甲[\s\S]*27\.25/);
  assert.equal(await summaryRow('social_insurance.maternity').locator('td').nth(1).innerText(), '확정');
  await form.locator('.hr-labor-history > summary').click();
  assert.match(await form.locator('.hr-labor-history > ol > li').first().innerText(), /SYNTHETIC integrated rate review/);
  checks.push('One versioned save persists company/employee rates, explicit zero, applicability, individual basis and bounds; overview and history update');
  ko.state.scenario = 'conflict';
  await form.getByLabel('회사 기본 시급 (CNY)', { exact: true }).fill('25.25');
  await form.getByLabel('기준 변경 사유', { exact: true }).fill('SYNTHETIC rate conflict draft');
  await save.click(); await form.getByText(/초안을 유지했습니다/).waitFor();
  assert.equal(await form.getByLabel('회사 기본 시급 (CNY)', { exact: true }).inputValue(), '25.25');
  assert.equal(await form.getByLabel('기준 변경 사유', { exact: true }).inputValue(), 'SYNTHETIC rate conflict draft');
  assert.equal(await save.isDisabled(), true);
  checks.push('Rate-save 409 retains the changed hourly rate and reason and blocks stale resubmission');
  await ko.context.close();

  const actual = await fixture(); await standards(actual.page);
  const actualForm = actual.page.locator('.hr-labor-actual-form'); await actualForm.waitFor();
  assert.match(await actualForm.locator('.hr-section-heading').innerText(), /실제/);
  assert.equal(await actualForm.getByLabel('사회보험 회사 부담 총액', { exact: true }).inputValue(), '');
  assert.equal(await actualForm.getByLabel('공적금 회사 부담 총액', { exact: true }).inputValue(), '');
  await actualForm.getByLabel('실제 납부액 변경 사유', { exact: true }).fill('SYNTHETIC invoice review');
  const expectedAmounts = { social_insurance: { total: '500.00', contract: '350.00', hourly: '150.00' }, housing_fund: { total: '150.00', contract: '100.00', hourly: '50.00' } };
  for (const [fundKey, label] of [['social_insurance', '사회보험'], ['housing_fund', '공적금']]) {
    await actualForm.getByLabel(`${label} 회사 부담 총액`, { exact: true }).fill(expectedAmounts[fundKey].total);
    await actualForm.getByLabel(`${label} 계약직 (선택)`, { exact: true }).fill(expectedAmounts[fundKey].contract);
    await actualForm.getByLabel(`${label} 시급직 (선택)`, { exact: true }).fill(expectedAmounts[fundKey].hourly);
  }
  const saveActual = actualForm.getByRole('button', { name: '실제 납부액 저장', exact: true });
  assert.equal(await saveActual.isDisabled(), true, 'Actual amounts require evidence memo');
  await actualForm.getByRole('textbox', { name: /^납부 근거 메모/ }).fill('SYNTHETIC-INVOICE-005');
  await actualForm.getByLabel('사회보험 회사 부담 총액', { exact: true }).fill('550.00');
  assert.equal(await saveActual.isDisabled(), true, 'Actual total must agree with the complete employment breakdown');
  await actualForm.getByLabel('사회보험 회사 부담 총액', { exact: true }).fill('500.00');
  await saveActual.click();
  await actual.page.waitForFunction(() => document.querySelector('.hr-labor-actual-form .hr-section-heading')?.textContent.includes('v4'));
  assert.deepEqual(actual.state.actualWrites, [{ version: 3, reason: 'SYNTHETIC invoice review', amounts: expectedAmounts, evidence_memo: 'SYNTHETIC-INVOICE-005' }]);
  assert.equal(actual.state.actual.measurement, 'actual');
  await actualForm.locator('.hr-labor-history > summary').click();
  const actualHistory = actualForm.locator('.hr-labor-history > ol > li').first();
  assert.match(await actualHistory.innerText(), /SYNTHETIC-HR-REVIEWER/);
  assert.match(await actualHistory.innerText(), /SYNTHETIC invoice review/);
  assert.match(await actualHistory.innerText(), /SYNTHETIC-INVOICE-005/);
  await actualForm.scrollIntoViewIfNeeded(); await capture(actual.page, 'actual-payments');
  checks.push('Actual company payments remain distinct from estimates, require evidence, validate totals and display versioned actor history');
  actual.state.scenario = 'actual-conflict';
  await actualForm.getByRole('textbox', { name: /^납부 근거 메모/ }).fill('SYNTHETIC-INVOICE-005-REVIEW');
  await actualForm.getByLabel('실제 납부액 변경 사유', { exact: true }).fill('SYNTHETIC payment conflict draft');
  await saveActual.click(); await actualForm.getByText(/초안을 유지했습니다/).waitFor();
  assert.equal(await actualForm.getByRole('textbox', { name: /^납부 근거 메모/ }).inputValue(), 'SYNTHETIC-INVOICE-005-REVIEW');
  assert.equal(await actualForm.getByLabel('실제 납부액 변경 사유', { exact: true }).inputValue(), 'SYNTHETIC payment conflict draft');
  assert.equal(await actualForm.getByLabel('사회보험 회사 부담 총액', { exact: true }).inputValue(), '500.00');
  assert.equal(await saveActual.isDisabled(), true);
  assert.equal(actual.state.actualWrites[1].version, 4);
  checks.push('Actual-payment 409 preserves all amounts, evidence and reason, and blocks stale resubmission');
  await actual.context.close();
  await checkCalendar();

  const zh = await fixture({ lang: 'zh' }); await standards(zh.page); await zh.page.locator('.hr-labor-actual-form').waitFor();
  assert.ok(!/[가-힣]/.test(await zh.page.locator('.hr-page').innerText()), 'Chinese rate page has no Korean labels');
  await capture(zh.page, 'zh'); await zh.context.close();
  const mobile = await fixture({ lang: 'zh', mobile: true });
  mobile.state.standards.rules.hourly_rates.employee_overrides = [{ employee_id: 1, effective_month: MONTH, amount: '27.25', reason: 'SYNTHETIC mobile hourly exception' }];
  mobile.state.standards.rules.contributions.social_insurance.base.rule = 'employee';
  mobile.state.standards.rules.contributions.social_insurance.base.employee_amounts = { 2: '3500' };
  await standards(mobile.page); await mobile.page.locator('.hr-labor-actual-form').waitFor();
  await mobileContainment(mobile.page); await capture(mobile.page, 'mobile');
  await mobile.page.locator('.hr-hourly-rates').scrollIntoViewIfNeeded(); await mobileContainment(mobile.page);
  await mobile.page.locator('.hr-labor-actual-form').scrollIntoViewIfNeeded(); await mobileContainment(mobile.page);
  checks.push('Chinese labels and 390px mobile layout cover exception/base editors and actual payments without overflow or sub-44px targets');
  await mobile.context.close();
  const denied = await fixture({ denied: true }); await denied.page.goto(`${origin}/hr/work?step=standards&month=${MONTH}`);
  await denied.page.waitForURL('**/dashboard');
  assert.equal(await denied.page.locator('.hr-labor-overview, .hr-labor-rules-form, .hr-labor-actual-form, .hr-tabs').count(), 0);
  assert.equal(await denied.page.locator('a[href^="/hr/"]').count(), 0);
  assert.equal(denied.state.standardCalls, 0); assert.equal(denied.state.calendarCalls, 0);
  assert.equal(denied.state.rosterCalls, 0); assert.equal(denied.state.actualCalls, 0);
  checks.push('Unauthorized users cannot open the HR rate route or request standards, roster, calendar or actual-payment data');
  await denied.context.close();
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log(JSON.stringify({ fixture_only: true, checks_passed: checks.length, checks, screenshots: captures }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});
