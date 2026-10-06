'use strict';

// Actual built React UI, synthetic accounts, intercepted HTTPS origins only.
// No server is started; no provider, production API, real TLS or existing Chrome
// profile is used. All page requests are fulfilled locally or aborted.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const REPO = path.dirname(ROOT);
const FRONT = 'https://wj-reporting.onrender.com';
const SUBMIT = 'https://wj-reporting-backend.onrender.com/integrations/blacklake/session/';
const PLAYWRIGHT = '/Users/ssoe94/dev/mes-qc/wj_reporting-standard-20261003/node_modules/playwright';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CONTROL = 'wj-auth-session-control-v2';
const outputName = process.argv[2] || 'mes-connection-react-browser-20261004.json';
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(outputName)) throw new Error('Use a log basename only.');
const output = path.join(REPO, 'output', outputName);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourcePaths = [
  'src/App.tsx', 'src/components/MesConnectionDialog.tsx', 'src/components/LogoutFeedback.tsx',
  'src/components/PasswordChangeModal.tsx', 'src/contexts/AuthContext.tsx',
  'src/domains/auth/auth-storage.ts', 'src/domains/auth/mes-connection.ts',
  'src/domains/auth/auth-transition.ts',
  'src/domains/auth/auth-commit.ts', 'src/domains/auth/inspection-beta-access.ts',
  'src/domains/auth/server-logout.ts', 'src/lib/api.ts', 'src/shared/api/http.ts',
  'src/pages/field/Station.tsx', 'src/pages/field/Launcher.tsx', 'src/pages/field/InjectionKanban.tsx',
];
const sourceManifest = () => Object.fromEntries(sourcePaths.map(name => [name, sha(fs.readFileSync(path.join(ROOT, name)))]));
const index = fs.readFileSync(path.join(DIST, 'index.html'));
const entry = index.toString().match(/type="module" crossorigin src="(\/assets\/index-[^"]+\.js)"/)[1];
const artifact = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
  index_sha256: sha(index), entry_sha256: sha(fs.readFileSync(path.join(DIST, entry))),
  source_sha256: sourceManifest(),
  runner_sha256: sha(fs.readFileSync(__filename)),
};
const payload = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const pair = actor => ({
  access: `${payload({ alg: 'synthetic', typ: 'JWT' })}.${payload({ user_id: actor === 'a' ? 101 : 202, exp: Math.floor(Date.now() / 1000) + 7200 })}.SYNTHETIC-${actor}-ACCESS`,
  refresh: `SYNTHETIC-${actor}-REFRESH`,
});
const pairs = { a: pair('a'), b: pair('b') };
const privateValues = new Set(Object.values(pairs).flatMap(value => [value.access, value.refresh]));
const sensitive = text => [...privateValues].some(value => String(text || '').includes(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const metadata = connected => ({
  enabled: true, status: connected ? 'connected' : 'disconnected', reason: 'synthetic_fixture',
  expires_at: null, can_connect: !connected, can_disconnect: connected,
  mode: 'identity_only', live_ready: false,
  login_hint: { factory_number: '12345678', account_name: 'fixture-mes-a', prefill_supported: false },
});

(async () => {
  const { chromium } = require(PLAYWRIGHT);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const log = fs.openSync(output, 'wx', 0o600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wj-react-mes-fixture-'));
  fs.chmodSync(profile, 0o700);
  const startedAt = new Date().toISOString();
  let context;
  let page;
  let stage = 'launch';
  let step = 'launch';
  let checks = 0;
  const cases = [];
  const counts = { intercepted: 0, fulfilled: 0, aborted: 0, provider: 0, refresh: 0,
    launch: 0, logout_a: 0, logout_b: 0, native_post: 0, canceled_response: 0,
    identity_read: 0, status_read: 0, console_errors: 0, page_errors: 0 };
  const errorCategories = new Set();
  const blockedPaths = { font_stylesheet: 0, unexpected_api: 0, unexpected_frontend_path: 0,
    unexpected_origin: 0, websocket: 0 };
  const consoleKinds = { blocked_resource: 0, mocked_http_500: 0, fixed_api_error: 0, other: 0 };
  const apiResponses = {};
  let domPresence = null;
  const dialogGeometry = [];
  const privacy = { url_sensitive: false, referer_sensitive: false, console_sensitive: false };
  const releases = [];
  let connected = false;
  let statusOverride = null;
  let pendingLaunch = null;
  let disconnectFails = false;
  let logoutFails = false;
  const pendingLogout = { a: null, b: null };
  let lastTicket = null;
  let launchTtl = 60;
  let nativeOrigin = 'absent';
  let timeout;
  let timedOut = false;
  let routeFailure = null;
  let closeTask;
  let rejectTimeout;
  const timeoutSignal = new Promise((_, reject) => { rejectTimeout = reject; });
  timeoutSignal.catch(() => {});
  let result;
  const verify = (condition, check) => {
    if (!condition) { const error = new Error('Synthetic UI assertion failed'); error.fixtureCheck = check; throw error; }
    checks += 1;
  };
  const finishCase = name => { cases.push(name); process.stdout.write(`${name}: pass\n`); };
  const routeVerify = (condition, check) => {
    if (!condition) routeFailure ||= check;
    else checks += 1;
  };
  const fulfill = async (route, response) => {
    try { await route.fulfill(response); counts.fulfilled += 1; }
    catch { counts.canceled_response += 1; }
  };
  const json = (route, body, status = 200) => {
    const pathname = new URL(route.request().url()).pathname;
    const known = ['/api/token/', '/api/token/refresh/', '/api/injection/user/me/',
      '/api/mes-connection/', '/api/mes-connection/launch/',
      '/api/mes-connection/disconnect/', '/api/mes-connection/logout/',
      '/api/quality/inspection-requests/capabilities/'];
    const key = `${known.includes(pathname) ? pathname : 'unexpected_api'}:${status}`;
    apiResponses[key] = (apiResponses[key] || 0) + 1;
    return fulfill(route, {
      status, contentType: 'application/json', body: JSON.stringify(body),
      headers: { 'Cache-Control': 'no-store' },
    });
  };
  const close = () => {
    if (!context) return Promise.resolve(true);
    if (!closeTask) {
      let closeTimer;
      closeTask = Promise.race([context.close().then(() => true, () => false),
        new Promise(resolve => { closeTimer = setTimeout(() => resolve(false), 5000); })])
        .finally(() => clearTimeout(closeTimer));
    }
    return closeTask;
  };
  try {
    timeout = setTimeout(() => {
      timedOut = true;
      rejectTimeout(new Error('Synthetic fixture timeout'));
      void close();
    }, 55000);
    context = await chromium.launchPersistentContext(profile, {
      executablePath: CHROME, headless: true, serviceWorkers: 'block',
      viewport: { width: 1360, height: 900 }, proxy: { server: 'http://127.0.0.1:9' },
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--dns-prefetch-disable', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
    });
    context.setDefaultTimeout(5000);
    context.on('page', page => {
      page.on('console', message => {
        privacy.console_sensitive ||= sensitive(message.text());
        if (message.type() === 'error') {
          counts.console_errors += 1;
          const text = message.text();
          if (text.includes('net::ERR_BLOCKED_BY_CLIENT')) consoleKinds.blocked_resource += 1;
          else if (text.includes('the server responded with a status of 500')) consoleKinds.mocked_http_500 += 1;
          else if (text.startsWith('[API Error]')) consoleKinds.fixed_api_error += 1;
          else consoleKinds.other += 1;
        }
      });
      page.on('pageerror', error => {
        privacy.console_sensitive ||= sensitive(error.message);
        counts.page_errors += 1;
        const text = error.message || '';
        errorCategories.add(text.includes('useBlocker') ? 'router_blocker'
          : text.includes('useNavigate') || text.includes('useLocation') ? 'router_context'
            : text.includes('useAuth') ? 'auth_context'
              : text.includes('Cannot read properties') ? 'property_read' : 'other_runtime_error');
      });
    });
    await context.route('**/*', async route => {
      counts.intercepted += 1;
      const request = route.request();
      const url = new URL(request.url());
      const headers = await request.allHeaders();
      privacy.url_sensitive ||= sensitive(request.url());
      privacy.referer_sensitive ||= sensitive(headers.referer);
      if (request.url() === SUBMIT && request.method() === 'POST') {
        counts.native_post += 1;
        const body = new URLSearchParams(request.postData() || '');
        nativeOrigin = headers.origin === FRONT ? 'same_frontend' : headers.origin === 'null' ? 'null' : headers.origin ? 'other' : 'absent';
        routeVerify(body.getAll('ticket').length === 1 && body.get('ticket') === lastTicket, 'native_body_exact_ticket');
        routeVerify([...body.keys()].length === 1, 'native_body_only_ticket');
        routeVerify(url.search === '' && url.hash === '', 'native_url_clean');
        return fulfill(route, { status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic session</title><p>Synthetic session form received.</p>' });
      }
      if (url.origin !== FRONT) {
        if (url.hostname.includes('blacklake.cn')) counts.provider += 1;
        if (url.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2') blockedPaths.font_stylesheet += 1;
        else blockedPaths.unexpected_origin += 1;
        counts.aborted += 1;
        return route.abort('blockedbyclient');
      }
      if (url.pathname.startsWith('/api/')) {
        const actor = headers.authorization === `Bearer ${pairs.a.access}` ? 'a'
          : headers.authorization === `Bearer ${pairs.b.access}` ? 'b' : null;
        if (url.pathname === '/api/token/' && request.method() === 'POST') {
          const body = request.postDataJSON();
          const selected = body.username === 'fixture-a' ? 'a' : body.username === 'fixture-b' ? 'b' : null;
          return json(route, selected ? pairs[selected] : { code: 'fixture_unknown_account' }, selected ? 200 : 401);
        }
        if (url.pathname === '/api/token/refresh/') { counts.refresh += 1; return json(route, { code: 'token_not_valid' }, 401); }
        if (!actor) return json(route, { code: 'fixture_missing_auth' }, 401);
        if (url.pathname === '/api/injection/user/me/') { counts.identity_read += 1; return json(route, {
          id: actor === 'a' ? 101 : 202, username: `fixture-${actor}`, email: '', groups: [],
          is_staff: true, is_superuser: true, password_reset_required: false,
          is_using_temp_password: false, permissions: { is_admin: true },
        }); }
        if (url.pathname === '/api/quality/inspection-requests/capabilities/' && request.method() === 'GET') {
          return json(route, { can_view: true, can_manage: true, can_submit: true, can_review: true,
            access_scope: 'all', can_view_kanban: true, data_mode: 'synthetic_preview',
            mes: { enabled: false, reason_code: 'synthetic_fixture', message: '', can_refresh: false, can_sync: false } });
        }
        if (url.pathname === '/api/mes-connection/' && request.method() === 'GET') {
          counts.status_read += 1; return json(route, { ...metadata(connected), ...statusOverride });
        }
        if (url.pathname === '/api/mes-connection/launch/' && request.method() === 'POST') {
          counts.launch += 1;
          const issued = `SYNTHETIC-ONE-USE-UI-TICKET-${counts.launch}`;
          privateValues.add(issued);
          lastTicket = issued;
          if (pendingLaunch) { pendingLaunch.started.resolve(); await pendingLaunch.reply.promise; }
          return json(route, { ticket: issued, submit_url: SUBMIT, expires_in: launchTtl });
        }
        if (url.pathname === '/api/mes-connection/disconnect/' && request.method() === 'POST') {
          if (disconnectFails) return json(route, { code: 'synthetic_unavailable' }, 500);
          connected = false;
          return json(route, { disconnected: true });
        }
        if (url.pathname === '/api/mes-connection/logout/' && request.method() === 'POST') {
          counts[`logout_${actor}`] += 1;
          routeVerify(request.postDataJSON().refresh === pairs[actor].refresh, 'logout_refresh_matches_actor');
          // Hold only the first logout. A second tab must independently obtain
          // a server acknowledgement before its real WJ login can replace A.
          const heldLogout = pendingLogout[actor];
          if (heldLogout && !heldLogout.used) {
            heldLogout.used = true;
            heldLogout.started.resolve();
            await heldLogout.reply.promise;
          }
          return json(route, logoutFails ? { code: 'synthetic_unavailable' } : { disconnected: true }, logoutFails ? 500 : 200);
        }
        counts.aborted += 1;
        blockedPaths.unexpected_api += 1;
        return route.abort('blockedbyclient');
      }
      if (request.method() === 'GET' && (url.pathname === '/__mes-fixture__/' || url.pathname === '/login')) {
        return fulfill(route, { status: 200, contentType: 'text/html', body: index });
      }
      const candidate = path.resolve(DIST, '.' + url.pathname);
      if (request.method() === 'GET' && candidate.startsWith(DIST + path.sep)
        && (url.pathname.startsWith('/assets/') || ['/logo.jpg', '/logo-transparent.png'].includes(url.pathname))
        && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const types = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
        return fulfill(route, { status: 200, contentType: types[path.extname(candidate)] || 'application/octet-stream', body: fs.readFileSync(candidate) });
      }
      counts.aborted += 1;
      blockedPaths.unexpected_frontend_path += 1;
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      counts.aborted += 1; blockedPaths.websocket += 1; socket.close();
    });
    await context.addInitScript(({ origin, controlKey, initialPair }) => {
      if (location.origin !== origin) return;
      if (localStorage.getItem(controlKey) === null) {
        localStorage.setItem(controlKey, JSON.stringify({ id: 'synthetic-initial-session-a', ...initialPair }));
      }
      localStorage.setItem('lang', 'ko');
    }, { origin: FRONT, controlKey: CONTROL, initialPair: pairs.a });
    page = await context.newPage();
    const userVisible = (target, actor) => target.locator('.main-user-menu__trigger').filter({ hasText: `fixture-${actor}` }).waitFor();
    const openDialog = async () => {
      step = 'open_user_menu';
      await page.locator('.main-user-menu__trigger').click();
      step = 'click_mes_menu';
      await page.getByRole('menuitem', { name: 'MES 연결', exact: true }).click();
      step = 'dialog_visible';
      const dialog = page.getByRole('dialog', { name: 'MES 연결', exact: true });
      await dialog.waitFor({ state: 'attached' });
      await dialog.getByRole('heading', { name: 'MES 연결', exact: true }).waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
      const geometry = await dialog.evaluate(element => {
        const wrapper = element.getBoundingClientRect();
        const panel = element.querySelector('h2')?.parentElement?.getBoundingClientRect();
        return { wrapper_has_area: wrapper.width > 0 && wrapper.height > 0,
          panel_has_area: Boolean(panel && panel.width > 0 && panel.height > 0),
          focus_inside: element.contains(document.activeElement),
          hidden_ancestor: Boolean(element.closest('[aria-hidden="true"], [inert]')) };
      });
      dialogGeometry.push(geometry);
      verify(geometry.panel_has_area && geometry.focus_inside && !geometry.hidden_ancestor, 'named_dialog_visible_panel_and_focus');
      step = 'status_button_visible';
      await page.getByRole('button', { name: '상태 확인', exact: true }).waitFor({ state: 'visible' });
      step = 'status_ready';
      await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === '상태 확인')?.disabled);
    };
    const closeDialog = () => page.getByRole('button', { name: '닫기', exact: true }).click();
    const noStoredTicket = async () => page.evaluate(() => {
      const values = store => Object.keys(store).map(key => store.getItem(key) || '');
      return [...values(localStorage), ...values(sessionStorage)].every(value => !value.includes('SYNTHETIC-ONE-USE-UI-TICKET-'));
    });
    const retains = actor => page.evaluate(({ key, expected }) => {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      const invalidated = JSON.parse(localStorage.getItem(`wj-auth-invalidated-session-v2:${value.id}`) || '{}');
      return Boolean(value.id) && invalidated.sessionId !== value.id && value.access === expected.access && value.refresh === expected.refresh;
    }, { key: CONTROL, expected: pairs[actor] });
    const cleared = () => page.evaluate(({ key }) => {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      const invalidated = JSON.parse(localStorage.getItem(`wj-auth-invalidated-session-v2:${value.id}`) || '{}');
      return value.id === null || Boolean(value.id && invalidated.sessionId === value.id);
    }, { key: CONTROL });
    const waitUntilCleared = () => page.waitForFunction(({ key }) => {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      const invalidated = JSON.parse(localStorage.getItem(`wj-auth-invalidated-session-v2:${value.id}`) || '{}');
      return value.id === null || Boolean(value.id && invalidated.sessionId === value.id);
    }, { key: CONTROL });
    const loginAs = async (actor, target) => {
      const tab = target || await context.newPage();
      await tab.goto(`${FRONT}/login?returnTo=/__mes-fixture__/`, { waitUntil: 'domcontentloaded' });
      await tab.locator('#username').fill(`fixture-${actor}`);
      await tab.locator('#password').fill('SYNTHETIC-LOCAL-LOGIN-PASSWORD');
      await tab.locator('form button[type="submit"]').first().click();
      await userVisible(tab, actor);
      return tab;
    };
    const logoutClick = async () => {
      await page.locator('.main-user-menu__trigger').click();
      await page.getByRole('menuitem', { name: '로그아웃', exact: true }).click();
    };

    stage = 'mount_and_native_post';
    step = 'navigate';
    await page.goto(`${FRONT}/__mes-fixture__/`, { waitUntil: 'domcontentloaded' });
    step = 'initial_user_visible';
    await userVisible(page, 'a');
    await openDialog();
    verify(await page.getByLabel('공장번호', { exact: true }).inputValue() === '12345678', 'server_factory_hint');
    verify(await page.getByLabel('MES 로그인 ID', { exact: true }).inputValue() === 'fixture-mes-a', 'server_account_hint');
    verify(await page.getByLabel('MES 로그인 ID', { exact: true }).getAttribute('readonly') !== null, 'hint_cannot_select_another_actor');
    verify(await page.locator('[role="dialog"] input[type="password"]').count() === 0, 'no_mes_password_field');
    await page.evaluate(() => { window.__mesFixtureCopies = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => window.__mesFixtureCopies.push(value) } });
    });
    await page.getByRole('button', { name: '공장번호 복사', exact: true }).click();
    await page.getByText('공장번호를 복사했습니다.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'ID 복사', exact: true }).click();
    await page.getByText('MES 로그인 ID를 복사했습니다.', { exact: true }).waitFor();
    verify(JSON.stringify(await page.evaluate(() => window.__mesFixtureCopies)) === JSON.stringify(['12345678', 'fixture-mes-a']), 'copy_only_server_hint_values');
    const originalLocation = page.url();
    await page.evaluate(() => sessionStorage.setItem('synthetic-original-inspection-draft', 'SYNTHETIC-DRAFT-NOT-MES-DATA'));
    await page.getByRole('button', { name: '연결 준비', exact: true }).click();
    const submitButton = page.getByRole('button', { name: 'MES 연결 화면 열기', exact: true });
    await submitButton.waitFor();
    verify(await noStoredTicket(), 'prepared_ticket_not_stored');
    const [popup] = await Promise.all([context.waitForEvent('page'), submitButton.click()]);
    await popup.waitForURL(SUBMIT);
    await popup.waitForLoadState('domcontentloaded');
    verify(await popup.evaluate(() => window.opener === null), 'native_popup_has_no_opener');
    verify(counts.native_post === 1 && nativeOrigin === 'same_frontend', 'native_post_preserves_origin');
    await page.locator('input[name="ticket"]').waitFor({ state: 'detached' });
    verify(await noStoredTicket(), 'submitted_ticket_not_stored');
    const beforeReturnRead = counts.status_read;
    connected = true;
    await popup.close();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByText('MES 계정이 연결되어 있습니다.', { exact: true }).waitFor();
    verify(counts.status_read > beforeReturnRead, 'return_rechecks_server_connection');
    verify(page.url() === originalLocation && await page.evaluate(() => sessionStorage.getItem('synthetic-original-inspection-draft')) === 'SYNTHETIC-DRAFT-NOT-MES-DATA', 'original_tab_context_and_draft_untouched');
    connected = false;
    await closeDialog();
    finishCase(stage);

    stage = 'unopened_or_canceled_window_can_prepare_again';
    await openDialog();
    await page.getByRole('button', { name: '연결 준비', exact: true }).click();
    await submitButton.waitFor();
    const postsBeforeBlocked = counts.native_post;
    const launchesBeforeBlocked = counts.launch;
    // Simulate a suppressed native navigation; do not claim browser popup
    // permission behavior was verified. React must not infer connection success.
    await page.evaluate(() => document.addEventListener('submit', event => event.preventDefault(), { capture: true, once: true }));
    await submitButton.click();
    await page.getByText(/창이 열리지 않거나 연결을 취소했다면/).waitFor();
    verify(counts.native_post === postsBeforeBlocked, 'suppressed_window_sends_nothing');
    verify(await page.getByText('MES 계정이 연결되어 있습니다.', { exact: true }).count() === 0, 'suppressed_window_not_connection_success');
    await page.getByRole('button', { name: '연결 준비', exact: true }).click();
    await submitButton.waitFor();
    verify(counts.launch === launchesBeforeBlocked + 1 && await noStoredTicket(), 'retry_uses_new_memory_only_ticket');
    await closeDialog();
    verify(await page.locator('input[name="ticket"]').count() === 0, 'cancel_clears_ticket');
    finishCase(stage);

    stage = 'clipboard_denial_and_untrusted_hint';
    await openDialog();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('synthetic-denial'); } } }));
    await page.getByRole('button', { name: 'ID 복사', exact: true }).click();
    await page.getByText('복사할 수 없습니다. 위 값을 선택해 직접 복사해 주세요.', { exact: true }).waitFor();
    verify(await page.getByLabel('MES 로그인 ID', { exact: true }).inputValue() === 'fixture-mes-a', 'denied_clipboard_retains_manual_copy_value');
    await closeDialog();
    statusOverride = { login_hint: { factory_number: '12345678', account_name: 'fixture-mes-a', prefill_supported: true } };
    await openDialog();
    verify(await page.getByLabel('MES 로그인 ID', { exact: true }).count() === 0, 'unsupported_prefill_hint_hidden');
    verify(await page.getByRole('button', { name: '연결 준비', exact: true }).isEnabled(), 'old_metadata_still_uses_reviewed_launch');
    statusOverride = null;
    await closeDialog();
    finishCase(stage);

    stage = 'ticket_expiry_clears_dom';
    launchTtl = 1;
    await openDialog();
    await page.getByRole('button', { name: '연결 준비', exact: true }).click();
    await submitButton.waitFor();
    await page.locator('input[name="ticket"]').waitFor({ state: 'detached' });
    launchTtl = 60;
    verify(await noStoredTicket() && counts.native_post === 1, 'expired_ticket_never_submitted_or_stored');
    await closeDialog();
    finishCase(stage);

    stage = 'disconnect_failure_is_not_success';
    connected = true;
    disconnectFails = true;
    await openDialog();
    await page.getByRole('button', { name: '연결 해제', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '요청 완료를 확인할 수 없습니다' }).waitFor();
    verify(await page.getByText('MES 연결을 해제했습니다.', { exact: true }).count() === 0, 'disconnect_failure_has_no_success_notice');
    disconnectFails = false;
    await page.getByRole('button', { name: '연결 해제', exact: true }).click();
    await page.getByText('MES 연결을 해제했습니다.', { exact: true }).waitFor();
    await closeDialog();
    finishCase(stage);

    stage = 'late_launch_after_real_account_switch';
    pendingLaunch = { started: deferred(), reply: deferred() };
    releases.push(pendingLaunch.reply.resolve);
    await openDialog();
    await page.getByRole('button', { name: '연결 준비', exact: true }).click();
    await Promise.race([pendingLaunch.started.promise, timeoutSignal]);
    const secondTab = await loginAs('b');
    await userVisible(page, 'b');
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    pendingLaunch.reply.resolve();
    pendingLaunch = null;
    verify(await page.locator('input[name="ticket"]').count() === 0 && await noStoredTicket(), 'old_launch_cannot_enter_new_account');
    verify(await retains('b'), 'account_switch_uses_real_login_storage_flow');
    await secondTab.close();
    finishCase(stage);

    stage = 'logout_failure_retains_credentials_then_retries';
    logoutFails = true;
    await logoutClick();
    await page.getByRole('alert').filter({ hasText: '로그아웃 완료를 확인할 수 없습니다' }).waitFor();
    verify(await retains('b'), 'failed_logout_preserves_current_auth');
    verify(counts.refresh === 0, 'failed_logout_does_not_refresh');
    logoutFails = false;
    await page.getByRole('button', { name: '로그아웃 다시 시도', exact: true }).click();
    // The other tab's earlier confirmed logout may already have routed this tab
    // to /login. Its visible form is not evidence of this acknowledgement.
    await waitUntilCleared();
    await page.locator('#username').waitFor();
    verify(await cleared(), 'confirmed_logout_clears_auth');
    finishCase(stage);

    stage = 'late_logout_cannot_finish_new_account_logout';
    await loginAs('a', page);
    pendingLogout.a = { started: deferred(), reply: deferred() };
    pendingLogout.b = { started: deferred(), reply: deferred() };
    releases.push(pendingLogout.a.reply.resolve, pendingLogout.b.reply.resolve);
    await logoutClick();
    await Promise.race([pendingLogout.a.started.promise, timeoutSignal]);
    const thirdTab = await loginAs('b');
    await userVisible(page, 'b');
    await logoutClick();
    await Promise.race([pendingLogout.b.started.promise, timeoutSignal]);
    pendingLogout.a.reply.resolve();
    verify(await retains('b'), 'late_a_logout_preserves_b_auth');
    verify(await page.locator('.main-mobile-header__logout').isDisabled(), 'late_a_finally_does_not_enable_b_pending_logout');
    pendingLogout.b.reply.resolve();
    await waitUntilCleared();
    await page.locator('#username').waitFor();
    verify(await cleared(), 'b_has_its_own_confirmed_logout');
    await thirdTab.close();
    finishCase(stage);

    stage = 'privacy_and_source';
    verify(counts.provider === 0 && counts.refresh === 0, 'no_provider_or_refresh_call');
    verify(blockedPaths.unexpected_api === 0 && blockedPaths.unexpected_frontend_path === 0
      && blockedPaths.unexpected_origin === 0 && blockedPaths.websocket === 0, 'no_unexpected_api_or_origin');
    verify(consoleKinds.other === 0 && counts.page_errors === 0, 'no_unexpected_console_or_runtime_error');
    verify(routeFailure === null, routeFailure || 'request_contract_checks');
    verify(!Object.values(privacy).some(Boolean), 'no_sensitive_urls_referers_or_console');
    verify(JSON.stringify(sourceManifest()) === JSON.stringify(artifact.source_sha256), 'runtime_source_unchanged_during_fixture');
    verify(!timedOut, 'bounded_runtime');
    result = { ok: true };
  } catch (error) {
    if (page && !page.isClosed()) {
      domPresence = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const labels = (dialog?.getAttribute('aria-labelledby') || '').split(' ').filter(Boolean);
        return {
          root_populated: Boolean(document.querySelector('#root')?.childElementCount),
          user_menu: Boolean(document.querySelector('.main-user-menu__trigger')),
          login_input: Boolean(document.querySelector('#username')),
          dialog: Boolean(dialog),
          dialog_has_label: labels.length > 0,
          dialog_label_resolves: labels.length > 0 && labels.every(id => Boolean(document.getElementById(id))),
          dialog_label_matches: labels.map(id => document.getElementById(id)?.textContent || '').join(' ').trim() === 'MES 연결',
          dialog_ancestor_hidden: Boolean(dialog?.closest('[aria-hidden="true"], [inert]')),
          dialog_displayed: Boolean(dialog && getComputedStyle(dialog).display !== 'none' && getComputedStyle(dialog).visibility !== 'hidden'),
          router_error: document.body.innerText.includes('Unexpected Application Error'),
        };
      }).catch(() => null);
    }
    result = { ok: false, stage, step, check: error.fixtureCheck || null,
      error: timedOut ? 'FixtureTimeout' : error.name === 'TimeoutError' ? 'FixtureStepTimeout' : 'FixtureFailure' };
  } finally {
    clearTimeout(timeout);
    releases.forEach(resolve => resolve());
    const closed = await close();
    if (closed) fs.rmSync(profile, { recursive: true, force: true });
    const report = { ...result, started_at: startedAt, finished_at: new Date().toISOString(),
      checks, cases, counts, privacy, native_origin: nativeOrigin, own_browser_closed: closed,
      blocked_paths: blockedPaths, api_responses: apiResponses, console_kinds: consoleKinds,
      dom_presence: domPresence, dialog_geometry: dialogGeometry,
      error_categories: [...errorCategories], artifact,
      limitations: ['intercepted origins; real TLS and provider not exercised', 'synthetic account metadata and mocked API responses'],
    };
    fs.writeSync(log, JSON.stringify(report, null, 2) + '\n');
    fs.closeSync(log);
    process.stdout.write(JSON.stringify({ ok: report.ok, cases: cases.length, checks, stage: report.ok ? 'complete' : stage }) + '\n');
    if (!report.ok) process.exitCode = 1;
  }
})();
