#!/usr/bin/env node
// Entire-app browser checks with synthetic HR data only. No backend, proxy,
// project environment, real credentials, or payroll files are read by this tool.
// Build frontend/dist first, then run from the worktree root:
// node scripts/check-hr-labor-standards-browser.cjs --screens /absolute/path/to/screens
// Optional: --playwright /absolute/path/to/playwright --port 4194 --dist <path>
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
const port = Number(options.port || 4194);
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
  const contribution = () => ({ rate_percent: null, base: null, fixed_amount: null });
  return {
    multipliers: { workday: '1.5', rest_day: '2', public_holiday: '3' },
    contract: { days_per_month: '21.75', hours_per_day: '8' },
    hourly_premium: { enabled: false, confirmed: false },
    department_overtime: { 注塑: '4', 模具: '4', 公务: '4', 品质: '4', 加工: '2.5', 营业: '2.5', 资材: '2.5', 开发: '1', 管理部: null, 总经办: null },
    weekday_excluded_titles: { titles: [], confirmed: false },
    department_hours_include_fixed_overtime: null,
    employer_contributions: {
      social_insurance: { contract: contribution(), hourly: contribution() },
      housing_fund: { contract: contribution(), hourly: contribution() },
    },
  };
}
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
  const state = { scenario, standardCalls: 0, calendarCalls: 0, standardWrites: [], calendarWrites: [], blockedExternal: 0,
    standards: { month: MONTH, version: 4, source_month: MONTH, source_version: 4, rules,
      periods: [{ month: MONTH, version: 4 }], history: [historyEntry(4, rules, rules, 'SYNTHETIC standard initialized')] },
    calendar: { month: MONTH, version: 2, days: {}, history: [historyEntry(2, {}, {}, 'SYNTHETIC calendar initialized')] },
  };
  await context.addInitScript(({ pair, lang, origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('wj-auth-session-control-v2', JSON.stringify({ id: 'SYNTHETIC-HR-004', ...pair }));
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
  const file = path.join(screens, `004-${name}.png`);
  await page.screenshot({ path: file, fullPage: false }); captures.push(file);
}
async function standards(page) {
  await page.goto(`${origin}/hr/labor-standards?month=${MONTH}`);
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

(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  browser = await playwright.chromium.launch({ headless: true });
  const ko = await fixture(); await standards(ko.page);
  assert.equal(await ko.page.locator('.hr-tabs a[href^="/hr/labor-forecast?month="]').count(), 1);
  assert.equal(await ko.page.locator('.hr-tabs a[aria-current="page"]').getAttribute('href'), `/hr/labor-standards?month=${MONTH}`);
  const rulesForm = ko.page.locator('.hr-labor-rules-form');
  assert.equal(await rulesForm.getByLabel('근무일 배수', { exact: true }).inputValue(), '1.5');
  assert.equal(await rulesForm.getByLabel('휴일 배수', { exact: true }).inputValue(), '2');
  assert.equal(await rulesForm.getByLabel('법정 공휴일 배수', { exact: true }).inputValue(), '3');
  assert.equal(await rulesForm.getByLabel('월 환산 일수', { exact: true }).inputValue(), '21.75');
  assert.equal(await rulesForm.getByLabel('하루 기준 시간', { exact: true }).inputValue(), '8');
  await capture(ko.page, 'desktop-ko');
  assert.equal(await rulesForm.getByLabel('管理部 기본 야근 시간', { exact: true }).inputValue(), '');
  assert.equal(await rulesForm.getByLabel('总经办 기본 야근 시간', { exact: true }).inputValue(), '');
  assert.equal(await rulesForm.getByLabel('사회보험 계약직 요율', { exact: true }).inputValue(), '');
  assert.equal(await rulesForm.getByLabel('공적금 시급직 요율', { exact: true }).inputValue(), '');
  assert.equal(await rulesForm.getByRole('checkbox', { name: /시급직 할증 규칙 확정/ }).isChecked(), false);
  assert.equal(await rulesForm.getByLabel('시급직 할증', { exact: true }).inputValue(), 'no');
  await rulesForm.locator('.hr-labor-pending > summary').click();
  const pending = rulesForm.locator('.hr-labor-pending');
  assert.match(await pending.innerText(), /管理部 야근 시간 미입력/);
  assert.match(await pending.innerText(), /시급직 할증 미확정/);
  assert.match(await pending.innerText(), /고정 연장수당 포함 여부 미확정/);
  assert.match(await pending.innerText(), /사회보험 · 계약직 미입력/);
  await pending.scrollIntoViewIfNeeded(); await capture(ko.page, 'missing');
  checks.push('Defaults display selected multipliers; missing values remain blank and uncertainties remain unconfirmed');
  await rulesForm.getByLabel('근무일 배수', { exact: true }).fill('1.6');
  const saveStandard = rulesForm.getByRole('button', { name: '기준 저장', exact: true });
  assert.equal(await saveStandard.isDisabled(), true, 'A changed standard still requires a reason');
  await rulesForm.getByLabel('기준 변경 사유', { exact: true }).fill('SYNTHETIC standard review');
  await saveStandard.click();
  await ko.page.waitForFunction(() => document.querySelector('.hr-labor-rules-form .hr-section-heading')?.textContent.includes('v5'));
  assert.equal(ko.state.standardWrites.length, 1);
  assert.equal(ko.state.standardWrites[0].version, 4);
  assert.equal(ko.state.standardWrites[0].reason, 'SYNTHETIC standard review');
  assert.equal(ko.state.standardWrites[0].rules.multipliers.workday, '1.6');
  await rulesForm.locator('.hr-labor-history > summary').click();
  const standardHistory = rulesForm.locator('.hr-labor-history > ol > li').first();
  assert.match(await standardHistory.innerText(), /SYNTHETIC-HR-REVIEWER/);
  assert.match(await standardHistory.innerText(), /SYNTHETIC standard review/);
  assert.match(await standardHistory.innerText(), /1\.5 → 1\.6/);
  assert.equal(await standardHistory.locator(':scope > ul > li').count(), 1, 'History contains only the changed rule');
  checks.push('Standard save sends version and reason, then displays actor and before/after history');
  ko.state.scenario = 'conflict';
  await rulesForm.getByLabel('근무일 배수', { exact: true }).fill('1.7');
  await rulesForm.getByLabel('기준 변경 사유', { exact: true }).fill('SYNTHETIC preserved draft');
  await saveStandard.click();
  await rulesForm.getByText(/초안을 유지했습니다/).waitFor();
  assert.equal(await rulesForm.getByLabel('근무일 배수', { exact: true }).inputValue(), '1.7');
  assert.equal(await rulesForm.getByLabel('기준 변경 사유', { exact: true }).inputValue(), 'SYNTHETIC preserved draft');
  assert.equal(await saveStandard.isDisabled(), true);
  assert.equal(ko.state.standardWrites[1].version, 5);
  checks.push('Standard 409 preserves edited values and reason and prevents stale resubmission');
  await ko.context.close();

  const calendar = await fixture(); await standards(calendar.page);
  const calendarForm = calendar.page.locator('.hr-labor-calendar-form'); await calendarForm.waitFor();
  assert.equal(await calendarForm.locator('[data-date]').count(), 30);
  assert.equal(await calendarForm.locator('[data-date="2026-11-14"]').getAttribute('data-day-type'), 'rest_day');
  assert.equal(await calendarForm.locator('[data-date="2026-11-15"]').getAttribute('data-day-type'), 'rest_day');
  assert.equal(await calendarForm.locator('[data-date="2026-11-16"]').getAttribute('data-day-type'), 'workday');
  assert.equal(await calendarForm.locator('[data-day-type="public_holiday"]').count(), 0, 'No official holiday is guessed');
  assert.equal(await calendarForm.locator('[data-day-type="rest_day"]').count(), 9);
  assert.equal(await calendarForm.locator('[data-day-type="workday"]').count(), 21);
  checks.push('November calendar defaults to 21 weekdays and 9 weekend rest days, without guessed holidays');
  await calendarForm.locator('[data-date="2026-11-14"]').click();
  await calendarForm.getByLabel('선택 날짜 유형', { exact: true }).selectOption('adjusted_workday');
  await calendarForm.locator('[data-date="2026-11-16"]').click();
  await calendarForm.getByLabel('선택 날짜 유형', { exact: true }).selectOption('public_holiday');
  const saveCalendar = calendarForm.getByRole('button', { name: '달력 저장', exact: true });
  assert.equal(await saveCalendar.isDisabled(), true, 'Calendar changes require a reason');
  await calendarForm.getByLabel('달력 변경 사유', { exact: true }).fill('SYNTHETIC calendar review');
  await saveCalendar.click();
  await calendar.page.waitForFunction(() => document.querySelector('.hr-labor-calendar-form .hr-section-heading')?.textContent.includes('v3'));
  assert.deepEqual(calendar.state.calendarWrites, [{ version: 2, reason: 'SYNTHETIC calendar review', days: { '2026-11-14': 'adjusted_workday', '2026-11-16': 'public_holiday' } }]);
  assert.equal(await calendarForm.locator('[data-date="2026-11-14"]').getAttribute('data-day-type'), 'adjusted_workday');
  assert.equal(await calendarForm.locator('[data-date="2026-11-16"]').getAttribute('data-day-type'), 'public_holiday');
  await calendarForm.locator('.hr-labor-history > summary').click();
  const calendarHistory = calendarForm.locator('.hr-labor-history > ol > li').first();
  assert.match(await calendarHistory.innerText(), /SYNTHETIC-HR-REVIEWER/);
  assert.match(await calendarHistory.innerText(), /SYNTHETIC calendar review/);
  assert.match(await calendarHistory.innerText(), /2026-11-14[\s\S]*조정 근무일/);
  assert.match(await calendarHistory.innerText(), /요일 기본값 \(휴일\) → 조정 근무일/);
  assert.match(await calendarHistory.innerText(), /2026-11-16[\s\S]*법정 공휴일/);
  assert.equal(await calendarHistory.locator(':scope > ul > li').count(), 2);
  await calendarForm.scrollIntoViewIfNeeded(); await capture(calendar.page, 'calendar');
  checks.push('Calendar changes send two explicit overrides with version/reason and show server actor history');
  calendar.state.scenario = 'calendar-conflict';
  await calendarForm.locator('[data-date="2026-11-15"]').click();
  await calendarForm.getByLabel('선택 날짜 유형', { exact: true }).selectOption('workday');
  await calendarForm.getByLabel('달력 변경 사유', { exact: true }).fill('SYNTHETIC preserved calendar');
  await saveCalendar.click();
  await calendarForm.getByText(/초안을 유지했습니다/).waitFor();
  assert.equal(await calendarForm.getByLabel('선택 날짜 유형', { exact: true }).inputValue(), 'workday');
  assert.equal(await calendarForm.getByLabel('달력 변경 사유', { exact: true }).inputValue(), 'SYNTHETIC preserved calendar');
  assert.equal(await saveCalendar.isDisabled(), true);
  checks.push('Calendar 409 preserves date override and reason and blocks stale resubmission');
  await calendar.context.close();

  const zh = await fixture({ lang: 'zh' }); await standards(zh.page); await zh.page.locator('.hr-labor-calendar-form').waitFor();
  assert.ok(!/[가-힣]/.test(await zh.page.locator('.hr-page').innerText()), 'Chinese labor-standard page has no Korean labels');
  await capture(zh.page, 'desktop-zh'); await zh.context.close();
  const mobile = await fixture({ lang: 'zh', mobile: true }); await standards(mobile.page); await mobile.page.locator('.hr-labor-calendar-form').waitFor();
  await mobileContainment(mobile.page);
  await capture(mobile.page, 'mobile');
  await mobile.page.locator('.hr-labor-calendar-form').scrollIntoViewIfNeeded();
  await mobileContainment(mobile.page);
  checks.push('Chinese labels and 390px mobile layout preserve page width and at least 44px touch targets');
  await mobile.context.close();

  const failure = await fixture({ scenario: 'error' }); await failure.page.goto(`${origin}/hr/labor-standards?month=${MONTH}`);
  await failure.page.getByText('인건비 기준을 불러오지 못했습니다.', { exact: true }).waitFor();
  assert.equal(await failure.page.locator('.hr-labor-rules-form').count(), 0);
  failure.state.scenario = 'normal';
  await failure.page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await failure.page.locator('.hr-labor-rules-form').waitFor();
  checks.push('Failed standard loading is explicit and retry restores the form');
  await failure.context.close();
  const denied = await fixture({ denied: true }); await denied.page.goto(`${origin}/hr/labor-standards?month=${MONTH}`);
  await denied.page.waitForURL('**/dashboard');
  assert.equal(await denied.page.locator('.hr-labor-rules-form, .hr-labor-calendar-form, .hr-tabs').count(), 0);
  assert.equal(await denied.page.locator('a[href^="/hr/"]').count(), 0);
  assert.equal(denied.state.standardCalls, 0); assert.equal(denied.state.calendarCalls, 0);
  checks.push('Unauthorized users cannot open the route, see HR tabs or request standards/calendar data');
  await denied.context.close();
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log(JSON.stringify({ fixture_only: true, checks_passed: checks.length, checks, screenshots: captures }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});
