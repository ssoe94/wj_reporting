#!/usr/bin/env node
// Entire-app browser checks against a fresh loopback Django/SQLite fixture.
// Only synthetic identities, payroll snapshots and attendance are created. Project environment,
// production settings, real credentials, and payroll files are never read.
// Build frontend/dist first, then run from the worktree root:
// node scripts/check-hr-labor-forecast-browser.cjs --screens /absolute/path/to/screens
// Optional: --playwright <package> --python <venv-python> --port 4206
//           --backend-port 4207 --dist <path>
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  assert.ok(['--screens', '--playwright', '--port', '--dist', '--python', '--backend-port'].includes(name), `Unknown option: ${name}`);
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
const port = Number(options.port || 4206);
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
const EMPTY_MONTH = '2026-08';
const DAY = '2026-11-12';
const backendPort = Number(options['backend-port'] || port + 1);
assert.ok(Number.isInteger(backendPort) && backendPort >= 1024 && backendPort <= 65535 && backendPort !== port);
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const python = options.python || process.env.WJ_HR_PYTHON || path.join(path.dirname(repo), 'wj_reporting/backend/.venv/bin/python');
assert.ok(fs.existsSync(python), 'Provide the existing backend Python with --python; this script never installs dependencies.');
const work = path.join(repo, 'work'); fs.mkdirSync(work, { recursive: true });
const fixtureDirectory = fs.mkdtempSync(path.join(work, 'hr-007-fixture-'));
const backendLog = fs.createWriteStream(path.join(fixtureDirectory, 'backend.log'));
const pythonFixture = String.raw`
import sys, socket
from datetime import date
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import decouple
decouple.config = decouple.Config(decouple.RepositoryEmpty())
original_connect = socket.socket.connect
def loopback_connect(self, address):
    if isinstance(address, tuple) and address[0] not in ('127.0.0.1', '::1', 'localhost'):
        raise RuntimeError('External network is forbidden in synthetic HR fixture')
    return original_connect(self, address)
socket.socket.connect = loopback_connect
from django.conf import settings
settings.configure(
    SECRET_KEY='synthetic-hr-007-no-real-auth', DEBUG=False, USE_TZ=True, TIME_ZONE='Asia/Shanghai',
    ALLOWED_HOSTS=['127.0.0.1', 'localhost'],
    SILENCED_SYSTEM_CHECKS=['admin.E403','admin.E408','admin.E409','admin.E410'],
    CLOUDINARY_STORAGE={'CLOUD_NAME':'offline','API_KEY':'offline','API_SECRET':'offline'},
    INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','django.contrib.sessions','django.contrib.admin','django.contrib.messages','rest_framework','rest_framework_simplejwt','rest_framework_simplejwt.token_blacklist','django_filters','injection','assembly','sales','overview','inventory','quality','production','ai_core','lgent','analytics'],
    DATABASES={'default': {'ENGINE':'django.db.backends.sqlite3','NAME':sys.argv[3]}},
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', ROOT_URLCONF='analytics.hr_test_urls',
    REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': [], 'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'], 'DEFAULT_RENDERER_CLASSES':['rest_framework.renderers.JSONRenderer'], 'DEFAULT_PAGINATION_CLASS':'rest_framework.pagination.PageNumberPagination','PAGE_SIZE':100,'EXCEPTION_HANDLER':'config.exceptions.custom_exception_handler'},
    MIDDLEWARE=['config.middleware.NoCacheAPIMiddleware'],
)
import django
django.setup()
from django.core.management import call_command
call_command('migrate', verbosity=0, interactive=False)
from django.contrib.auth import get_user_model
from analytics.models import (
    HrAccessGrant, HrLaborActualPayment, HrLaborStandard, HrMonthWorkspace, HrRosterEmployee,
)
from analytics.hr_labor_rules import default_labor_rules
from analytics.hr_views import HrBaseView
from rest_framework.authentication import BaseAuthentication
User = get_user_model()
hr = User.objects.create(username='SYNTHETIC-HR-REVIEWER', is_active=True)
hr.set_unusable_password(); hr.save(update_fields=['password'])
denied = User.objects.create(username='SYNTHETIC-NO-HR', is_active=True)
denied.set_unusable_password(); denied.save(update_fields=['password'])
HrAccessGrant.objects.create(user=hr, enabled=True)
rules = default_labor_rules()
rules['hourly_rates']['company_default'] = {'amount': '25.00', 'confirmed': True}
for kind, config in rules['contributions'].items():
    config['applies_to'] = {'contract': True, 'hourly': True}
    config['base']['rule'] = 'gross'
    for item in config['items'].values():
        item.update(employer_rate='2.00' if kind == 'social_insurance' else '5.00', employee_rate='0.00')
HrLaborStandard.objects.create(month='2026-09', rules=rules, version=1, updated_by=hr)

people = [
    ('90001', '测试甲', 'contract', '注塑', 'injection'),
    ('90002', '测试乙', 'hourly', '注塑', 'injection'),
    ('90003', '测试丙', 'contract', '品质', 'quality'),
]
for code, name, kind, department, visual in people:
    HrRosterEmployee.objects.create(
        code=code, name=name, employment_type=kind, department=department,
        first_month='2026-09', last_month='2026-11',
    )
departments = [
    {'id': 'injection', 'name': '测试注塑组', 'parent_id': None},
    {'id': 'quality', 'name': '测试品质组', 'parent_id': None},
]
for month in ('2026-09', '2026-10', '2026-11'):
    current = month == '2026-11'
    rows = []
    for code, name, kind, department, visual in people:
        amount = {
            '90001': '4690.00' if current else '4230.00',
            '90002': '6100.00' if current else '5800.00',
            '90003': '5650.00' if current else '5340.00',
        }[code]
        row = dict(code=code, name=name, employment_type=kind, title='测试操作员',
                   amount=amount, source_department=department, department_id=visual)
        if kind == 'contract':
            first = code == '90001'
            row['payroll_components'] = dict(
                base_salary='3480.00' if first else '4350.00',
                fixed_overtime='200.00' if first else '150.00',
                weekday_overtime=('520.00' if first else '400.00') if current else ('200.00' if first else '150.00'),
                weekend_overtime=('100.00' if current else '50.00') if first else '0.00',
                holiday_overtime='0.00', personal_leave='20.00' if first else '0.00',
                sick_leave=('10.00' if current else '0.00') if first else ('0.00' if current else '10.00'),
                absence='0.00',
            )
        rows.append(row)
    HrMonthWorkspace.objects.create(
        month=month, currency='CNY', cost_basis='gross_salary', cost_basis_label='应发工资',
        employees=rows, departments=departments, version=1,
        source={'type': 'company_payroll', 'synthetic': True}, updated_by=hr,
    )
    HrLaborActualPayment.objects.create(month=month, payment={'amounts': {
        'social_insurance': {'total': '1200.00', 'contract': None, 'hourly': None},
        'housing_fund': {'total': '550.00', 'contract': None, 'hourly': None},
    }, 'evidence_memo': 'SYNTHETIC invoice'}, updated_by=hr)

class FixtureAuthentication(BaseAuthentication):
    def authenticate(self, request):
        return (denied if request.headers.get('X-Synthetic-HR-Role') == 'denied' else hr, None)
HrBaseView.authentication_classes = [FixtureAuthentication]
from django.core.wsgi import get_wsgi_application
from wsgiref.simple_server import make_server, WSGIRequestHandler
class QuietHandler(WSGIRequestHandler):
    def log_message(self, format, *args):
        pass
application = get_wsgi_application()
with (
    patch('analytics.hr_views.shanghai_today', return_value=date(2026, 11, 12)),
    make_server('127.0.0.1', int(sys.argv[2]), application, handler_class=QuietHandler) as server,
):
    print('SYNTHETIC_BACKEND_READY', flush=True)
    server.serve_forever()
`;
let backend, browser;
const checks = [], captures = [], errors = [];
async function startBackend() {
  backend = spawn(python, ['-u', '-c', pythonFixture, path.join(repo, 'backend'), String(backendPort), path.join(fixtureDirectory, 'synthetic.sqlite3')], {
    cwd: repo, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.pipe(backendLog, { end: false }); backend.stderr.pipe(backendLog, { end: false });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Synthetic backend did not start; see ${fixtureDirectory}/backend.log`)), 60000);
    backend.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('SYNTHETIC_BACKEND_READY')) { clearTimeout(timer); resolve(); } });
    backend.once('error', error => { clearTimeout(timer); reject(error); });
    backend.once('exit', code => { clearTimeout(timer); reject(new Error(`Synthetic backend exited (${code}); see ${fixtureDirectory}/backend.log`)); });
  });
}
async function backendRequest(pathname, { method = 'GET', body, role = 'hr' } = {}) {
  assert.ok(pathname.startsWith('/api/analytics/hr/'), 'Only HR fixture APIs may be called');
  const response = await fetch(backendOrigin + pathname, { method, headers: { 'Content-Type': 'application/json', 'X-Synthetic-HR-Role': role }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Non-JSON fixture response: ${method} ${pathname} (${response.status})`); }
  return { status: response.status, data, headers: response.headers };
}
const dailyPath = date => `/api/analytics/hr/daily-work/${date}/`;
async function sheet(date = DAY) { const result = await backendRequest(dailyPath(date)); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
const forecastPath = month => '/api/analytics/hr/labor-forecast/' + month + '/';
const forecastPage = month => '/hr/labor-forecast?month=' + month;
const byCode = (value, code) => value.rows.find(row => row.employee.code === code);

function token(kind) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'synthetic', typ: 'JWT' }),
    encode({ user_id: 90001, exp: Math.floor(Date.now() / 1000) + 86400, token_type: kind, fixture_only: true }),
    'SYNTHETIC-LOCAL-ONLY',
  ].join('.');
}
const pair = { access: token('access'), refresh: token('refresh') };

async function fixture({ lang = 'ko', mobile = false, dark = false, denied = false, failOnce = false } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 930 } : { width: 1440, height: 1160 },
    locale: lang === 'ko' ? 'ko-KR' : 'zh-CN', timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const calls = [];
  await context.addInitScript(({ pair, lang, dark, origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('wj-auth-session-control-v2', JSON.stringify({ id: 'SYNTHETIC-HR-007', ...pair }));
    localStorage.setItem('lang', lang);
    localStorage.setItem('wj_next_language', lang);
    localStorage.setItem('wj:appearance:v1', dark ? 'dark' : 'light');
  }, { pair, lang, dark, origin });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const reply = (status, json, cache = 'private, no-store') => route.fulfill({
      status, contentType: 'application/json', headers: { 'Cache-Control': cache }, body: JSON.stringify(json),
    });
    if (url.pathname === '/api/injection/user/me/') return reply(200, {
      id: 90001, username: 'SYNTHETIC-HR-REVIEWER', email: 'synthetic@example.invalid',
      is_active: true, is_staff: false, is_superuser: false, can_access_hr: !denied,
      can_edit_hr_labor: !denied, groups: [], permissions: {},
    });
    if (url.pathname === '/api/quality/inspection-requests/capabilities/') return reply(200, {});
    if (url.pathname === '/api/auth/activity/') return reply(200, { ...pair, fixture_only: true });
    if (url.pathname.startsWith('/api/analytics/hr/')) {
      const method = route.request().method();
      const body = route.request().postDataJSON() ?? undefined;
      if (failOnce && url.pathname === forecastPath(MONTH)) {
        failOnce = false;
        calls.push({ method, pathname: url.pathname, status: 503 });
        return reply(503, { detail: 'Synthetic retry check' });
      }
      const result = await backendRequest(url.pathname + url.search, { method, body, role: denied ? 'denied' : 'hr' });
      calls.push({ method, pathname: url.pathname, body, status: result.status, result: result.data });
      return reply(result.status, result.data, result.headers.get('Cache-Control') || '');
    }
    return reply(404, { fixture_only: true, code: 'synthetic_endpoint_not_supported' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, calls };
}

async function capture(page, name) {
  const file = path.join(screens, '007-' + name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  captures.push(file);
}

async function until(check, description) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + description);
}

async function getForecast(month = MONTH, role = 'hr') {
  const result = await backendRequest(forecastPath(month), { role });
  assert.equal(result.status, role === 'denied' ? 403 : 200, JSON.stringify(result.data));
  assert.match(result.headers.get('Cache-Control'), /private/);
  assert.match(result.headers.get('Cache-Control'), /no-store/);
  return result.data;
}

async function waitForForecast(view, month = MONTH) {
  await view.page.locator('.hr-forecast-summary').waitFor();
  return until(() => view.calls.findLast(call => call.pathname === forecastPath(month) && call.status === 200), 'real forecast response');
}

async function openForecast(view, month = MONTH) {
  await view.page.goto(origin + forecastPage(month));
  return waitForForecast(view, month);
}

async function writeFixture(day, overrides) {
  const value = await sheet(day);
  const result = await backendRequest(dailyPath(day), {
    method: 'PUT',
    body: { version: value.version, context: value.context, rows: overrides(value), status: 'confirmed', reason: 'SYNTHETIC November attendance' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
}

async function makePartial() {
  const value = await sheet(DAY);
  const result = await backendRequest(dailyPath(DAY) + 'events/', {
    method: 'POST',
    body: {
      revision: value.event_revision, kind: 'transfer', employee_id: byCode(value, '90003').employee.id,
      changes: { department: '管理部' }, reason: 'SYNTHETIC department without an overtime default',
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
}

async function scrollForCapture(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate(element => {
    const headerBottom = document.querySelector('.main-topbar')?.getBoundingClientRect().bottom ?? 0;
    window.scrollBy({ top: element.getBoundingClientRect().top - headerBottom - 14, behavior: 'instant' });
  });
}

(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await startBackend();
  await writeFixture('2026-11-11', value => [{
    employee_id: byCode(value, '90001').employee.id, work: { weekday_hours: '1' },
  }]);
  // Entered future work is stored, but must not become actual through the cut-off.
  await writeFixture('2026-11-13', value => [{
    employee_id: byCode(value, '90001').employee.id, work: { weekday_hours: '0' },
  }]);
  const before = await getForecast();
  assert.deepEqual(await getForecast(), before, 'Unchanged read-only inputs return the same values');
  await getForecast(MONTH, 'denied');
  assert.equal(before.as_of, DAY);
  assert.equal(before.days.entered, 1);
  assert.equal(before.days.remaining, 18);
  assert.equal(before.basis.workdays, 21);
  assert.equal(before.total.status, 'ready');
  assert.equal(Number(before.components.fixed_pay.amount), 9200);
  assert.equal(Number(before.components.overtime.amount), 5580);
  assert.equal(Number(before.components.hourly_work.amount), 7350);
  assert.equal(Number(before.total.amount), 23880);
  assert.equal(Number(before.components.social_insurance.amount), 1200);
  assert.equal(Number(before.components.social_insurance.estimate.amount), 2213);
  assert.equal(Number(before.components.housing_fund.amount), 550);
  assert.equal(Number(before.components.housing_fund.estimate.amount), 1106.50);
  assert.equal(before.daily.find(day => day.date === '2026-11-11').source, 'entered');
  assert.equal(before.daily.find(day => day.date === DAY).source, 'default');
  assert.equal(before.daily.find(day => day.date === '2026-11-13').source, 'default');
  assert.equal(Number(before.comparison.components.fixed_pay), -150);
  assert.equal(Number(before.comparison.actual.total.amount), 18190);
  assert.equal(Number(before.comparison.total_difference), 5690);
  assert.deepEqual(before.comparison.employees.map(employee => employee.code), ['90003', '90001', '90002']);
  assert.equal(before.previous.month, '2026-10');
  assert.equal(Number(before.previous.total_difference), 6760);
  checks.push('Real private/no-store GET, 403, deterministic output, fixed pay, variable pay, employer actual/estimate and prior payroll comparison');

  browser = await playwright.chromium.launch({ headless: true });
  const ko = await fixture();
  const first = await openForecast(ko);
  assert.equal(first.result.total.amount, before.total.amount);
  const summaryText = await ko.page.locator('.hr-forecast-summary').innerText();
  assert.match(summaryText, /23,880/);
  assert.match(summaryText, /1\s*\/\s*18/);
  assert.equal(await ko.page.locator('.hr-forecast-components [data-component]').count(), 5);
  const chart = ko.page.locator('.hr-forecast-chart');
  await chart.locator('.recharts-surface').first().waitFor();
  assert.match(await chart.innerText(), /입력 실적/);
  assert.match(await chart.innerText(), /기본값 예상/);
  await until(() => chart.locator('.recharts-area').count().then(count => count >= 2), 'two rendered chart series');
  await capture(ko.page, 'desktop-ko');
  checks.push('Korean forecast totals and five component cards render, with two chart series');

  const departments = ko.page.locator('.hr-forecast-departments');
  const department = departments.getByRole('button', { name: '注塑', exact: true });
  await department.click();
  const employees = departments.locator('.hr-forecast-employees');
  await employees.waitFor();
  assert.match(await employees.innerText(), /测试甲/);
  assert.match(await employees.innerText(), /测试乙/);
  await employees.locator('summary').filter({ hasText: '测试甲' }).click();
  const basis = employees.locator('details[open] .hr-forecast-basis');
  assert.match(await basis.innerText(), /2026-10/);
  assert.match(await basis.innerText(), /21.*21/);
  assert.match(await basis.innerText(), /양로보험.*2(?:\.00)?%/);
  await scrollForCapture(departments);
  await capture(ko.page, 'department');
  await departments.getByRole('button', { name: '시각화 부서', exact: true }).click();
  await departments.getByRole('button', { name: '测试注塑组', exact: true }).waitFor();
  const comparison = ko.page.locator('.hr-forecast-comparison');
  await comparison.waitFor();
  assert.match(await comparison.innerText(), /예상 대 실제/);
  assert.match(await comparison.innerText(), /9,350/);
  const fundRow = comparison.locator('tbody tr').filter({ hasText: '사회보험(회사)' }).first();
  assert.match(await fundRow.innerText(), /2,213.*1,200.*1,013/s);
  await scrollForCapture(comparison);
  await capture(ko.page, 'comparison');
  checks.push('Expanding a source department reveals employee detail, and comparison presents actual payroll by component');

  // Save from the real daily screen and return using the top forecast tab.
  await ko.page.goto(origin + '/hr/daily-work?date=' + DAY + '&month=' + MONTH);
  await ko.page.locator('.hr-daily-editor').waitFor();
  assert.equal(await ko.page.getByLabel('90001 개인 휴가 시간', { exact: true }).count(), 1);
  assert.doesNotMatch(await ko.page.locator('.hr-daily-editor').innerText(), /사假/);
  await ko.page.getByLabel('90001 평일 야근', { exact: true }).fill('2');
  const save = ko.page.getByRole('button', { name: '입력 중으로 저장', exact: true });
  await save.click();
  const saved = await until(() => ko.calls.find(call => call.method === 'PUT' && call.pathname === dailyPath(DAY)), 'daily save');
  assert.equal(saved.status, 200, JSON.stringify(saved.result));
  await ko.page.locator('.hr-daily-state').getByText('입력 중 · v1', { exact: false }).waitFor();
  const requestIndex = ko.calls.length;
  await ko.page.locator('.hr-tabs').getByRole('link', { name: '인건비 예상', exact: true }).click();
  await ko.page.locator('.hr-forecast-summary').waitFor();
  const refreshed = await until(() => ko.calls.slice(requestIndex).find(call => call.pathname === forecastPath(MONTH) && call.status === 200), 'fresh forecast after daily save');
  assert.equal(refreshed.result.days.entered, 2);
  assert.equal(Number(refreshed.result.total.amount), 23820);
  assert.match(await ko.page.locator('.hr-forecast-summary').innerText(), /23,820/);
  checks.push('Real daily edit and save are reflected on the returned forecast tab');
  await ko.context.close();

  const zh = await fixture({ lang: 'zh' });
  await openForecast(zh);
  assert.match(await zh.page.locator('.hr-forecast-summary').innerText(), /预计人工成本|人工成本预测|预测总额/);
  assert.match(await zh.page.locator('.hr-forecast-chart').innerText(), /录入实绩/);
  assert.match(await zh.page.locator('.hr-forecast-chart').innerText(), /默认预测/);
  assert.match(await zh.page.locator('.hr-forecast-comparison').innerText(), /预测与实际对比/);
  assert.equal(/[가-힣]/.test(await zh.page.locator('.hr-forecast').innerText()), false, 'Chinese forecast must not contain Korean UI text');
  await capture(zh.page, 'desktop-zh');
  await zh.context.close();
  checks.push('Chinese forecast and chart and comparison labels render');

  await makePartial();
  const partial = await fixture({ failOnce: true });
  await partial.page.goto(origin + forecastPage(MONTH));
  await partial.page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  const retried = await waitForForecast(partial);
  assert.deepEqual(partial.calls.filter(call => call.pathname === forecastPath(MONTH)).map(call => call.status), [503, 200]);
  assert.equal(retried.result.total.status, 'partial_missing');
  assert.equal(retried.result.total.amount, null);
  assert.ok(Number(retried.result.total.known_amount) > 0, 'Known subtotal remains visible for an incomplete month');
  assert.match(await partial.page.locator('.hr-forecast-summary').innerText(), /일부 미입력/);
  assert.match(await partial.page.locator('.hr-forecast-components').innerText(), /일부 미입력|미입력/);
  await capture(partial.page, 'partial');
  await partial.context.close();
  checks.push('A missing department default produces partial totals and retry restores actual endpoint data');

  const mobile = await fixture({ mobile: true, dark: true });
  await openForecast(mobile);
  const size = await mobile.page.evaluate(() => ({ viewport: innerWidth, root: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(size.root <= size.viewport && size.body <= size.viewport, 'Mobile document overflow: ' + JSON.stringify(size));
  assert.equal(await mobile.page.locator('html').getAttribute('data-app-theme'), 'dark');
  assert.equal(await mobile.page.locator('.hr-forecast-components [data-component]').count(), 5);
  const smallControls = await mobile.page.locator('.hr-forecast button, .hr-forecast summary').evaluateAll(elements =>
    elements.filter(element => element.getBoundingClientRect().height > 0 && element.getBoundingClientRect().height < 44)
      .map(element => element.textContent.trim()));
  assert.deepEqual(smallControls, [], 'Mobile forecast controls have 44px height');
  await scrollForCapture(mobile.page.locator('.hr-forecast-summary'));
  await capture(mobile.page, 'mobile');
  await mobile.context.close();
  checks.push('390px dark-mode forecast fits its viewport and renders all five cards with 44px controls');

  const empty = await fixture();
  const emptyForecast = await openForecast(empty, EMPTY_MONTH);
  assert.equal(emptyForecast.result.payroll.uploaded, false);
  assert.equal(emptyForecast.result.employees.length, 0);
  assert.equal(emptyForecast.result.comparison, null);
  await empty.page.locator('.hr-forecast-empty').waitFor();
  assert.equal(await empty.page.locator('.hr-forecast-comparison').count(), 0);
  assert.equal(await empty.page.locator('.hr-forecast-components, .hr-forecast-chart').count(), 0);
  await capture(empty.page, 'empty');
  await empty.context.close();
  checks.push('An empty month shows the payroll upload empty state');

  const denied = await fixture({ denied: true });
  await denied.page.goto(origin + forecastPage(MONTH));
  await denied.page.waitForURL(url => !url.pathname.startsWith('/hr'));
  assert.equal(await denied.page.locator('a[href*="/hr/labor-forecast"]').count(), 0);
  assert.equal(denied.calls.length, 0);
  await denied.context.close();
  checks.push('Unauthorized frontend exposes no forecast route or forecast requests');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  assert.equal(captures.length, 7);
  console.log(JSON.stringify({
    result: 'PASS', real_backend: true, fixtureDirectory, checks, screenshots: captures, uncaughtBrowserErrors: errors.length,
  }, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
    await new Promise(resolve => backend.once('exit', resolve));
  }
  backendLog.end();
});
