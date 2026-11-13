#!/usr/bin/env node
// Entire-app browser checks against a fresh loopback Django/SQLite fixture.
// Only synthetic identities and hire events are created. Project environment,
// production settings, real credentials, and payroll files are never read.
// Build frontend/dist first, then run from the worktree root:
// node scripts/check-hr-daily-work-browser.cjs --screens /absolute/path/to/screens
// Optional: --playwright <package> --python <venv-python> --port 4196
//           --backend-port 4197 --dist <path>
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
const port = Number(options.port || 4196);
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
const DAY = '2026-11-12';
const backendPort = Number(options['backend-port'] || port + 1);
assert.ok(Number.isInteger(backendPort) && backendPort >= 1024 && backendPort <= 65535 && backendPort !== port);
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const python = options.python || process.env.WJ_HR_PYTHON || path.join(path.dirname(repo), 'wj_reporting/backend/.venv/bin/python');
assert.ok(fs.existsSync(python), 'Provide the existing backend Python with --python; this script never installs dependencies.');
const work = path.join(repo, 'work'); fs.mkdirSync(work, { recursive: true });
const fixtureDirectory = fs.mkdtempSync(path.join(work, 'hr-006-fixture-'));
const backendLog = fs.createWriteStream(path.join(fixtureDirectory, 'backend.log'));
const pythonFixture = String.raw`
import sys, socket
from pathlib import Path
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
    SECRET_KEY='synthetic-hr-006-no-real-auth', DEBUG=False, USE_TZ=True, TIME_ZONE='Asia/Shanghai',
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
from analytics.models import HrAccessGrant, HrLaborStandard
from analytics.hr_labor_rules import default_labor_rules
from analytics.hr_views import HrBaseView
from rest_framework.authentication import BaseAuthentication
User = get_user_model()
hr = User.objects.create(username='SYNTHETIC-HR-REVIEWER', is_active=True)
hr.set_unusable_password(); hr.save(update_fields=['password'])
denied = User.objects.create(username='SYNTHETIC-NO-HR', is_active=True)
denied.set_unusable_password(); denied.save(update_fields=['password'])
HrAccessGrant.objects.create(user=hr, enabled=True)
HrLaborStandard.objects.create(month='2026-11', rules=default_labor_rules(), version=1, updated_by=hr)
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
with make_server('127.0.0.1', int(sys.argv[2]), application, handler_class=QuietHandler) as server:
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
async function seed() {
  const hires = [
    { code: '90001', name: '测试甲', employment_type: 'contract', department: '注塑', title: '测试操作员', base_salary: '3000.00', fixed_overtime: '0.00' },
    { code: '90002', name: '测试乙', employment_type: 'hourly', department: '注塑', title: '测试操作员', hourly_rate: '30.00' },
    { code: '90003', name: '测试丙', employment_type: 'contract', department: '管理部', title: '测试事务员', base_salary: '4000.00', fixed_overtime: '0.00' },
    { code: '90004', name: '测试丁', employment_type: 'contract', department: '注塑', title: 'Part長', base_salary: '5000.00', fixed_overtime: '500.00' },
  ];
  let current = await sheet('2026-11-01');
  for (const changes of hires) {
    const result = await backendRequest(`${dailyPath('2026-11-01')}events/`, { method: 'POST', body: { revision: current.event_revision, kind: 'hire', reason: 'SYNTHETIC initial fixture hire', changes } });
    assert.equal(result.status, 201, JSON.stringify(result.data)); current = result.data;
  }
  return sheet();
}
function token(kind) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'synthetic', typ: 'JWT' })}.${encode({ user_id: 90001, exp: Math.floor(Date.now() / 1000) + 86400, token_type: kind, fixture_only: true })}.SYNTHETIC-LOCAL-ONLY`;
}
const pair = { access: token('access'), refresh: token('refresh') };
async function fixture({ lang = 'ko', mobile = false, denied = false } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 843 } : { width: 1920, height: 1200 }, locale: lang === 'ko' ? 'ko-KR' : 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const state = { calls: [], previews: [], saves: [], events: [], externalBlocked: 0 };
  await context.addInitScript(({ pair, lang, origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('wj-auth-session-control-v2', JSON.stringify({ id: 'SYNTHETIC-HR-006', ...pair }));
    localStorage.setItem('lang', lang); localStorage.setItem('wj_next_language', lang);
  }, { pair, lang, origin });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { state.externalBlocked += 1; return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const reply = (status, json, cache = 'private, no-store') => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': cache }, body: JSON.stringify(json) });
    if (url.pathname === '/api/injection/user/me/') return reply(200, { id: 90001, username: 'SYNTHETIC-HR-REVIEWER', email: 'synthetic@example.invalid', is_active: true, is_staff: false, is_superuser: false, can_access_hr: !denied, can_edit_hr_labor: !denied, groups: [], permissions: {} });
    if (url.pathname === '/api/quality/inspection-requests/capabilities/') return reply(200, {});
    if (url.pathname === '/api/auth/activity/') return reply(200, { ...pair, fixture_only: true });
    if (url.pathname.startsWith('/api/analytics/hr/')) {
      const method = route.request().method(); const body = route.request().postDataJSON() ?? undefined;
      const result = await backendRequest(url.pathname + url.search, { method, body, role: denied ? 'denied' : 'hr' });
      const record = { method, pathname: url.pathname, body, status: result.status, result: result.data };
      state.calls.push(record);
      if (url.pathname.endsWith('/preview/')) state.previews.push(record);
      else if (url.pathname.endsWith('/events/')) state.events.push(record);
      else if (method === 'PUT') state.saves.push(record);
      return reply(result.status, result.data, result.headers.get('Cache-Control') || '');
    }
    return reply(404, { fixture_only: true, code: 'synthetic_endpoint_not_supported' });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  return { context, page, state };
}
async function openDay(page, date = DAY) {
  await page.goto(`${origin}/hr/daily-work?date=${date}&month=${date.slice(0, 7)}`);
  await page.locator('.hr-daily-editor').waitFor();
}
async function capture(page, name) { const file = path.join(screens, `006-${name}.png`); await page.screenshot({ path: file, fullPage: false }); captures.push(file); }
async function until(check, description) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${description}`);
}
const byCode = (value, code) => value.rows.find(row => row.employee.code === code);
async function previewAfter(view, action, predicate) {
  const start = view.state.previews.length; await action();
  const result = await until(() => view.state.previews.slice(start).find(record => record.status === 200 && predicate(record.result)), 'live calculation response');
  await view.page.locator('.hr-daily-preview-state').waitFor({ state: 'hidden' });
  return result.result;
}
async function saveDraft(view) {
  const start = view.state.saves.length;
  await view.page.getByRole('button', { name: '입력 중으로 저장', exact: true }).click();
  const record = await until(() => view.state.saves[start], 'draft save');
  if (record.status === 200) await until(async () => (await view.page.locator('.hr-daily-state').innerText()).includes(`v${record.result.version}`), 'saved sheet version');
  return record;
}
async function eventAfter(view, action, kind) {
  const start = view.state.events.length; await action();
  const record = await until(() => view.state.events.slice(start).find(value => value.body.kind === kind), `${kind} event response`);
  assert.equal(record.status, 201, JSON.stringify(record.result));
  await until(async () => await view.page.locator('.hr-daily-event-list > li').count() === record.result.events.length, 'visible event history');
  return record.result;
}
async function writeFixture(value, rows, reason) {
  const result = await backendRequest(dailyPath(value.date), { method: 'PUT', body: { version: value.version, context: value.context, rows, status: 'draft', reason } });
  assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
}

(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await startBackend();
  const initial = await seed();
  assert.equal(initial.rows.length, 4); assert.equal(initial.status, 'estimated'); assert.equal(initial.version, 0);
  assert.equal(initial.summary.known_amount, '523.45'); assert.equal(initial.summary.amount, null);
  assert.equal(byCode(initial, '90002').estimate.amount, '420.00');
  const employeeId = code => byCode(initial, code).employee.id;
  await writeFixture(await sheet('2026-11-11'), [{ employee_id: employeeId('90001'), work: { weekday_hours: '1' } }], 'SYNTHETIC previous-day copy source');
  browser = await playwright.chromium.launch({ headless: true });
  const ko = await fixture(); await openDay(ko.page);
  const field = (code, label) => ko.page.getByLabel(`${code} ${label}`, { exact: true });
  const row = code => ko.page.locator(`.hr-daily-row[data-employee-id="${employeeId(code)}"]`);
  const department = ko.page.locator('.hr-daily-department').filter({ has: ko.page.getByRole('heading', { name: '注塑', exact: true }) });
  assert.equal(await ko.page.locator('.hr-daily-row').count(), 4);
  assert.equal(await field('90001', '평일 야근').inputValue(), '4');
  assert.equal(await field('90002', '정규 시간').inputValue(), '8');
  assert.equal(await field('90003', '평일 야근').inputValue(), '');
  assert.equal(await field('90004', '평일 야근').inputValue(), '0');
  assert.equal(await field('90004', '평일 야근').isDisabled(), true);
  assert.match(await field('90001', '평일 야근').getAttribute('class'), /is-default/);
  assert.match(await row('90001').locator('.hr-daily-estimate > strong').innerText(), /103\.45/);
  assert.match(await ko.page.locator('.hr-daily-summary').innerText(), /일부 미입력/);
  await capture(ko.page, 'weekday');
  checks.push('Real Django defaults: weekday department hours, hourly 8h and explicit rate, excluded title 0, missing department is partial; GET remains unsaved v0');

  const changed = await previewAfter(ko, () => field('90001', '평일 야근').fill('2'), value => byCode(value, '90001').work.weekday_hours === '2');
  assert.equal(changed.summary.known_amount, '471.72');
  assert.equal(changed.summary.amount, null); assert.equal(ko.state.saves.length, 0);
  assert.equal((await sheet()).version, 0, 'Preview must not persist a sheet');
  assert.match(await row('90001').locator('.hr-daily-estimate > strong').innerText(), /51\.72/);
  assert.match(await ko.page.locator('.hr-daily-summary').innerText(), /471\.72/);
  assert.match(await field('90001', '평일 야근').getAttribute('class'), /is-edited/);
  assert.match(await field('90002', '평일 야근').getAttribute('class'), /is-default/);
  const weight = await field('90001', '평일 야근').evaluate(element => getComputedStyle(element).fontWeight);
  assert.ok(Number(weight) >= 600, 'Edited values must be visually bold');
  await ko.page.evaluate(() => window.scrollTo(0, 0)); await capture(ko.page, 'edited');
  await field('90001', '평일 야근').focus(); await ko.page.keyboard.press('Enter');
  assert.equal(await field('90002', '선택').evaluate(element => document.activeElement === element), true, 'Enter advances to the next enabled field');
  await ko.page.keyboard.press('Tab');
  assert.equal(await field('90002', '출근 상태').evaluate(element => document.activeElement === element), true);
  checks.push('Unsaved edit calls real preview, changes row/summary money to server values without writes, marks bold fields; Enter/Tab advance enabled controls');

  const off = await previewAfter(ko, () => department.getByRole('button', { name: '부서 전체 휴무', exact: true }).click(), value => value.summary.off === 3);
  assert.equal(off.summary.present, 1);
  assert.equal(await field('90001', '평일 야근').inputValue(), '0');
  await department.getByRole('button', { name: '부서 기본값 적용', exact: true }).click();
  await until(async () => await field('90001', '평일 야근').inputValue() === '4', 'department defaults restored');
  await field('90001', '선택').check(); await field('90002', '선택').check(); await field('90004', '선택').check();
  await ko.page.getByLabel('선택 직원 야근 시간', { exact: true }).fill('1.5');
  const bulk = await previewAfter(ko, () => ko.page.getByRole('button', { name: '3명에 적용', exact: true }).click(), value => byCode(value, '90002').work.weekday_hours === '1.5');
  assert.equal(byCode(bulk, '90001').work.weekday_hours, '1.5'); assert.equal(byCode(bulk, '90004').work.weekday_hours, '0');
  ko.page.once('dialog', dialog => dialog.accept());
  await previewAfter(ko, () => ko.page.getByRole('button', { name: '전날 복사', exact: true }).click(), value => byCode(value, '90001').work.weekday_hours === '1' && byCode(value, '90002').work.weekday_hours === '4');
  const saved = await saveDraft(ko); assert.equal(saved.status, 200); assert.equal(saved.result.status, 'draft');
  assert.equal(saved.result.history[0].actor_label, 'SYNTHETIC-HR-REVIEWER');
  assert.equal((await sheet()).version, 1);
  checks.push('Department off/defaults, selected employee overtime with excluded-title protection, and previous-day copy all recalculate then persist through real APIs');

  await previewAfter(ko, () => field('90001', '평일 야근').fill('3'), value => byCode(value, '90001').work.weekday_hours === '3');
  await ko.page.getByLabel('근무표 변경 사유 (확정 시 필수)', { exact: true }).fill('SYNTHETIC conflict draft retained');
  await writeFixture(await sheet(), [{ employee_id: employeeId('90001'), work: { weekday_hours: '2' } }], 'SYNTHETIC concurrent reviewer');
  const conflict = await saveDraft(ko); assert.equal(conflict.status, 409);
  const conflictPanel = ko.page.locator('.hr-daily-conflict'); await conflictPanel.waitFor();
  await conflictPanel.getByRole('button', { name: '내 변경을 최신에 다시 적용', exact: true }).waitFor();
  assert.equal(await field('90001', '평일 야근').inputValue(), '3');
  assert.equal(await ko.page.getByLabel('근무표 변경 사유 (확정 시 필수)', { exact: true }).inputValue(), 'SYNTHETIC conflict draft retained');
  assert.match(await conflictPanel.innerText(), /90001[\s\S]*3[\s\S]*2/);
  assert.equal(await ko.page.getByRole('button', { name: '입력 중으로 저장', exact: true }).isDisabled(), true);
  await previewAfter(ko, () => conflictPanel.getByRole('button', { name: '내 변경을 최신에 다시 적용', exact: true }).click(), value => value.version === 2 && byCode(value, '90001').work.weekday_hours === '3');
  const reconciled = await saveDraft(ko); assert.equal(reconciled.status, 200); assert.equal(reconciled.result.version, 3);
  assert.equal(byCode(reconciled.result, '90001').work.weekday_hours, '3');
  const confirm = ko.page.getByRole('button', { name: '근무표 확정', exact: true });
  assert.equal(await confirm.isDisabled(), true, 'Confirmation needs a reason');
  await ko.page.getByLabel('근무표 변경 사유 (확정 시 필수)', { exact: true }).fill('SYNTHETIC reviewed daily attendance');
  const saveIndex = ko.state.saves.length; await confirm.click();
  const confirmed = await until(() => ko.state.saves[saveIndex], 'confirmed save');
  assert.equal(confirmed.status, 200); assert.equal(confirmed.result.status, 'confirmed');
  await until(async () => (await ko.page.locator('.hr-daily-state').innerText()).includes('확정 · v4'), 'confirmed status');
  await ko.page.locator('.hr-daily-history > summary').click();
  assert.match(await ko.page.locator('.hr-daily-history').innerText(), /SYNTHETIC reviewed daily attendance/);
  checks.push('Actual concurrent save returns 409; draft/reason survive, latest comparison shows both values, explicit reapply and reasoned confirmation create actor history');

  const leave = await previewAfter(ko, () => field('90001', '출근 상태').selectOption('personal_leave'), value => byCode(value, '90001').work.attendance === 'personal_leave');
  assert.equal(byCode(leave, '90001').estimate.deduction_status, 'unconfirmed');
  assert.equal(byCode(leave, '90001').estimate.amount, null);
  await previewAfter(ko, () => field('90001', '개인 휴가 시간').fill('4'), value => byCode(value, '90001').work.personal_leave_hours === '4');
  assert.match(await row('90001').locator('.hr-daily-estimate').innerText(), /공제 산식 미확정/);
  ko.page.once('dialog', dialog => dialog.accept()); await ko.page.getByRole('button', { name: '근무 초안 되돌리기', exact: true }).click();
  await until(async () => await field('90001', '출근 상태').inputValue() === 'present', 'leave draft discarded');
  checks.push('Personal leave hours preview as unconfirmed deduction with null amount, never an invented zero deduction');
  await ko.context.close();

  const events = await fixture(); await openDay(events.page, '2026-11-13');
  const eventForm = events.page.locator('.hr-daily-event-form');
  await eventForm.getByLabel('신규 사번', { exact: true }).fill('90005');
  await eventForm.getByLabel('신규 이름', { exact: true }).fill('测试戊');
  await eventForm.getByLabel('변경 부서', { exact: true }).fill('注塑');
  await eventForm.getByLabel('변경 직무', { exact: true }).fill('测试操作员');
  await eventForm.getByLabel('기본급 (CNY)', { exact: true }).fill('3500');
  await eventForm.getByLabel('고정 연장수당 (CNY)', { exact: true }).fill('0');
  const register = eventForm.getByRole('button', { name: '변동 등록', exact: true });
  assert.equal(await register.isDisabled(), true, 'Personnel event reason is mandatory');
  await eventForm.getByLabel('인원 변동 사유', { exact: true }).fill('SYNTHETIC 006 new hire');
  const hired = await eventAfter(events, () => register.click(), 'hire');
  assert.equal(hired.summary.headcount, 5); assert.equal((await sheet()).rows.length, 4, 'Future hire is not active before effective date');
  await eventForm.getByLabel('변동 종류', { exact: true }).selectOption('terminate');
  await eventForm.getByLabel('변동 직원', { exact: true }).selectOption(String(employeeId('90001')));
  await eventForm.getByLabel('인원 변동 사유', { exact: true }).fill('SYNTHETIC 006 final work day');
  const terminated = await eventAfter(events, () => register.click(), 'terminate');
  assert.equal(terminated.summary.headcount, 5, 'Last working day remains active');
  assert.equal(byCode(await sheet('2026-11-14'), '90001'), undefined, 'Terminated employee is excluded next day');
  assert.ok(terminated.events.every(event => event.actor_label === 'SYNTHETIC-HR-REVIEWER'));
  await events.page.locator('.hr-daily-events').scrollIntoViewIfNeeded(); await capture(events.page, 'events');
  const termination = terminated.events.find(event => event.kind === 'terminate');
  await events.page.locator(`[data-event-id="${termination.id}"]`).getByRole('button', { name: '취소 이벤트 작성', exact: true }).click();
  await eventForm.getByLabel('인원 변동 사유', { exact: true }).fill('SYNTHETIC cancel incorrect termination');
  const cancelled = await eventAfter(events, () => register.click(), 'cancel');
  assert.equal(cancelled.events.find(event => event.id === termination.id).cancelled, true);
  assert.ok(byCode(await sheet('2026-11-14'), '90001'));
  assert.match(await events.page.locator('.hr-daily-event-list').innerText(), /취소됨/);
  checks.push('UI hire/termination/cancellation call real append-only API, preserve mandatory reasons and actor, honor hire start and inclusive final day');
  await events.context.close();

  const holiday = await fixture(); await openDay(holiday.page, '2026-11-14');
  const holidaySheet = await sheet('2026-11-14');
  assert.equal(holidaySheet.day_type, 'rest_day'); assert.equal(holidaySheet.summary.off, 5); assert.equal(holidaySheet.summary.amount, '0.00');
  assert.ok(holidaySheet.rows.every(value => value.work.attendance === 'off' && value.work.rest_hours === '0'));
  assert.equal(await holiday.page.getByLabel('90002 정규 시간', { exact: true }).inputValue(), '0');
  await capture(holiday.page, 'holiday'); checks.push('Weekend renders off/zero-hour defaults for every active employee without writing a sheet');
  await holiday.context.close();

  const mobile = await fixture({ mobile: true }); await openDay(mobile.page);
  const sizes = await mobile.page.evaluate(() => ({ width: innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, row: getComputedStyle(document.querySelector('.hr-daily-row')).display }));
  assert.ok(sizes.doc <= sizes.width && sizes.body <= sizes.width, `Mobile document overflow: ${JSON.stringify(sizes)}`);
  assert.equal(sizes.row, 'grid', '390px employee rows become cards');
  const small = await mobile.page.locator('.hr-page button, .hr-page input:not([type=checkbox]), .hr-page select, .hr-daily-check').evaluateAll(elements => elements.filter(element => !element.closest('[hidden]') && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0).map(element => ({ text: element.getAttribute('aria-label') || element.textContent.trim(), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })).filter(box => box.width < 44 || box.height < 44));
  assert.deepEqual(small, [], 'Mobile controls and checkbox labels must have 44px targets');
  const mobileCard = mobile.page.locator('.hr-daily-row').first();
  await mobileCard.scrollIntoViewIfNeeded();
  await mobileCard.evaluate(element => {
    const headerBottom = document.querySelector('.main-topbar').getBoundingClientRect().bottom;
    window.scrollBy({ top: element.getBoundingClientRect().top - headerBottom - 12, behavior: 'instant' });
  });
  const cardPlacement = await mobileCard.evaluate(element => ({ top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, header: document.querySelector('.main-topbar').getBoundingClientRect().bottom, viewport: innerHeight }));
  assert.ok(cardPlacement.top >= cardPlacement.header + 8 && cardPlacement.bottom <= cardPlacement.viewport, `Capture must show the full first card below the sticky header: ${JSON.stringify(cardPlacement)}`);
  await capture(mobile.page, 'mobile');
  checks.push('390px mobile renders employee cards, keeps document within viewport and all daily controls at least 44px');
  await mobile.context.close();

  const zh = await fixture({ lang: 'zh' }); await openDay(zh.page);
  assert.equal(await zh.page.getByLabel('90002 正常工时', { exact: true }).inputValue(), '8');
  assert.match(await zh.page.locator('.hr-daily-summary').innerText(), /在职人数/);
  assert.match(await zh.page.locator('.hr-daily-summary').innerText(), /部分未填写/);
  assert.equal(/[가-힣]/.test(await zh.page.locator('.hr-page').innerText()), false, 'Chinese HR screen must not contain Korean UI labels');
  await capture(zh.page, 'zh'); checks.push('Chinese daily screen, estimates, event inputs and status labels render without Korean UI text');
  await zh.context.close();

  const denied = await fixture({ denied: true }); await denied.page.goto(`${origin}/hr/daily-work?date=${DAY}`);
  await denied.page.waitForURL(url => !url.pathname.startsWith('/hr'));
  assert.equal(await denied.page.locator('a[href*="/hr/daily-work"]').count(), 0);
  assert.equal(denied.state.calls.length, 0, 'Denied frontend must not request HR records');
  const forbidden = await backendRequest(dailyPath(DAY), { role: 'denied' }); assert.equal(forbidden.status, 403);
  assert.match(forbidden.headers.get('Cache-Control'), /private/); assert.match(forbidden.headers.get('Cache-Control'), /no-store/);
  const allowed = await backendRequest(dailyPath(DAY)); assert.match(allowed.headers.get('Cache-Control'), /private/); assert.match(allowed.headers.get('Cache-Control'), /no-store/);
  await denied.context.close();
  checks.push('Denied account has neither daily route/tab nor HR requests; actual backend returns 403 and private,no-store headers');
  assert.deepEqual(errors, [], 'No uncaught browser errors'); assert.equal(captures.length, 6);
  console.log(JSON.stringify({ result: 'PASS', real_backend: true, fixtureDirectory, checks, screenshots: captures, uncaughtBrowserErrors: errors.length }, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (backend && backend.exitCode === null) { backend.kill('SIGTERM'); await new Promise(resolve => backend.once('exit', resolve)); }
  backendLog.end();
});
