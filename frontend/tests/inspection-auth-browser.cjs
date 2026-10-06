'use strict';

// Real built App/AuthContext/inspection components; every response is synthetic.
// No server, provider, production data, existing browser profile or real TLS.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.dirname(ROOT);
const DIST = path.join(ROOT, 'dist');
const FRONT = 'https://wj-reporting.onrender.com';
const INSPECTION = '/quality/inspection-requests';
const pilotMode = process.argv[3] === '--pilot';
const reconnectMode = process.argv[3] === '--reconnect';
const API = '/api/quality/inspection-requests/';
const PLAYWRIGHT = '/Users/ssoe94/dev/mes-qc/wj_reporting-standard-20261003/node_modules/playwright';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CONTROL = 'wj-auth-session-control-v2';
const INVALIDATED = 'wj-auth-invalidated-session-v2:';
const COORDINATOR = 'wj-auth-commit-coordinator-v1';
const PASSWORD = 'SYNTHETIC-LOCAL-LOGIN-PASSWORD';
const NOTE_A = 'SYNTHETIC-PRIVATE-A-DRAFT';
const NOTE_B = 'SYNTHETIC-PRIVATE-B-DRAFT';
const LATE_NOTE = 'SYNTHETIC-LATE-B-RESPONSE';
const sourcePaths = [
  'src/App.tsx', 'src/contexts/AuthContext.tsx', 'src/pages/LoginPage.tsx',
  'src/components/LogoutFeedback.tsx', 'src/domains/auth/auth-storage.ts',
  'src/components/MesConnectionDialog.tsx', 'src/domains/auth/mes-connection.ts',
  'src/domains/auth/auth-transition.ts', 'src/domains/auth/auth-commit.ts', 'src/domains/auth/login-return.ts', 'src/domains/auth/server-logout.ts',
  'src/lib/api.ts', 'src/shared/api/http.ts',
  'src/domains/auth/inspection-beta-access.ts',
  ...['InspectionRequestsPage.tsx', 'InspectionRequestsPage.css', 'InspectionRequestDetail.tsx', 'NewInspectionRequest.tsx',
    'api.ts', 'workflow.ts', 'copy.ts', 'useInspectionRouteLeaveGuard.ts'].map(name => `src/pages/quality/inspection-requests/${name}`),
];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceManifest = () => Object.fromEntries(sourcePaths.map(name => [name, sha(fs.readFileSync(path.join(ROOT, name)))]));
const outputName = process.argv[2] || 'inspection-auth-react-browser-20261004.json';
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(outputName)) throw new Error('Use a log basename only.');
const output = path.join(REPO, 'output', outputName);
const index = fs.readFileSync(path.join(DIST, 'index.html'));
const entry = index.toString().match(/type="module" crossorigin src="(\/assets\/index-[^"]+\.js)"/)[1];
const artifact = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
  index_sha256: sha(index), entry_sha256: sha(fs.readFileSync(path.join(DIST, entry))),
  source_sha256: sourceManifest(), runner_sha256: sha(fs.readFileSync(__filename)),
  served_asset_sha256: {},
};
const payload = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const pair = actor => ({
  access: `${payload({ alg: 'synthetic', typ: 'JWT' })}.${payload({ user_id: actor === 'a' ? 101 : 202, exp: Math.floor(Date.now() / 1000) + 7200 })}.SYNTHETIC-${actor}-ACCESS`,
  refresh: `SYNTHETIC-${actor}-REFRESH`,
});
const pairs = { a: pair('a'), b: pair('b') };
const privateValues = [...Object.values(pairs).flatMap(item => [item.access, item.refresh]), PASSWORD, NOTE_A, NOTE_B, LATE_NOTE];
const sensitive = value => privateValues.some(item => String(value || '').includes(item));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const now = '2026-10-04T03:00:00.000Z';
function inspection() {
  return {
    id: 1, source_kind: 'local_manual', work_order_ref: 'SYNTHETIC-WO-1',
    task_ref: 'SYNTHETIC-TASK-1', part_no: 'SYNTHETIC-PART-1', equipment_ref: 'imm01',
    inspection_type: 'first', target_quantity: '10.000', uom: 'EA',
    warehouse_ref: 'SYNTHETIC-WAREHOUSE', lot_ref: 'SYNTHETIC-LOT',
    work_started_at: now, quantity_mode: 'not_recorded', judgement_policy: 'strict_items', require_evidence: false,
    inspection_items: [{ id: 'dimension', label: 'SYNTHETIC dimension', kind: 'number', unit: 'mm',
      minimum: '9.5', maximum: '10.5', required: true, evidence_required: false }],
    measurements: [{ item_id: 'dimension', value: '10.0', judgement: 'pass', evidence_url: '' }],
    evidence: [], inspected_quantity: '0.000', accepted_quantity: '0.000', rejected_quantity: '0.000',
    judgement: 'pass', notes: '', parent: null, assigned_to: 303, assigned_to_name: 'fixture-assigned-owner',
    status: 'draft', version: 2, submitted_by: null, submitted_at: null, reviewed_by: null, reviewed_at: null,
    review_reason: '', sync_status: 'not_synced', mes_completion_status: 'not_completed',
    injection_receipt_readiness: 'not_verified', mes_checked_at: null, external_result_id: '', last_error_code: '',
    mes_state: { task_status: null, qc_status: null, state_version: null, receipt_allowed: null },
    created_at: now, updated_at: now, audit: [], operations: [],
    capabilities: { can_edit: true, can_submit: true, can_review: false, can_reinspect: false, can_sync: false, can_refresh: false },
  };
}
function kanban(record, date) {
  return {
    schema_version: 'inspection-kanban.v1', business_date: date, day_start: `${date}T08:00:00+08:00`,
    day_end: `${date}T08:00:00+08:00`, generated_at: now,
    plan_snapshot: { source: 'ProductionPlan', version: 'SYNTHETIC-PLAN-VERSION', latest_changed_at: now,
      shift_stored: false, work_task_binding_available: false, complete: true, freshness_verified: false },
    machines: Array.from({ length: 17 }, (_, offset) => ({
      machine_number: offset + 1, station_id: `imm${String(offset + 1).padStart(2, '0')}`,
      mapping_status: 'mapped', plan_status: 'missing', plans: [], requests: offset ? [] : [record],
      request_count: offset ? 0 : 1, requests_truncated: false,
      dry_run: { enabled: false, mode: 'dry_run', candidate: 'none', recommendation: 'none',
        blocking_reasons: ['mes_disconnected'], plan_version: 'SYNTHETIC-PLAN-VERSION', requires_new_first_inspection_on_resume: 'unknown' },
    })),
    unmapped_requests: [], unmapped_plans: [], requests_truncated: false, plans_truncated: false, executions_truncated: false,
    counts: { requests_displayed: 1, plans_displayed: 0, unmapped_requests: 0, unmapped_plans: 0 },
  };
}

(async () => {
  const { chromium } = require(PLAYWRIGHT);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const log = fs.openSync(output, 'wx', 0o600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wj-inspection-auth-fixture-'));
  fs.chmodSync(profile, 0o700);
  const startedAt = new Date().toISOString();
  const counts = { intercepted: 0, fulfilled: 0, aborted: 0, canceled_response: 0,
    login_a: 0, login_b: 0, login_reply_a: 0, login_reply_b: 0, logout_a: 0, logout_b: 0, identity_a: 0, identity_b: 0,
    mutation_a: 0, mutation_b: 0, detail_read_a: 0, detail_read_b: 0, list_read: 0, kanban_read: 0, refresh: 0, provider: 0, mes_write: 0,
    confirm_accepted: 0, confirm_dismissed: 0, console_errors: 0, page_errors: 0 };
  const blocked = { font_stylesheet: 0, unexpected_api: 0, unexpected_frontend_path: 0, unexpected_origin: 0, websocket: 0 };
  const consoleKinds = { blocked_resource: 0, mocked_http_error: 0, fixed_api_error: 0, expected_coordination_failure: 0, other: 0 };
  const privacy = { url_sensitive: false, referer_sensitive: false, console_sensitive: false };
  const cases = [];
  const apiResponses = {};
  const releases = [];
  const coordinatorObservations = [];
  let context; let page; let closeTask; let timer; let timedOut = false;
  let stage = 'launch'; let step = 'launch'; let checks = 0; let result; let domPresence = null; let notesLabelObservation = null;
  let routeFailure = null; let logoutFails = false; let pendingMutation = null; let pendingLogin = null; let pendingIdentity = null;
  let confirmAnswer = false;
  let expectCoordinationFailure = false;
  let capabilityMode = 'allowed'; let pendingCapability = null;
  let mesConnected = false;
  const stageAttempts = [];
  const records = { a: inspection(), b: inspection() };
  if (reconnectMode) {
    records.a.notes = NOTE_A;
    records.a.status = 'approved';
    records.a.mes_workflow = { phase: 'ready', enabled: true, test_label: 'SYNTHETIC-ONLY', last_verified_at: null, can_save: true, can_finish: false, can_reconcile: false };
  }
  if (pilotMode) {
    records.a.assigned_to = 101; records.a.assigned_to_name = 'fixture-a';
    records.b.assigned_to = 202; records.b.assigned_to_name = 'fixture-b';
  }
  const verify = (condition, name) => {
    if (!condition) { const error = new Error('Synthetic assertion failed'); error.fixtureCheck = name; throw error; }
    checks += 1;
  };
  const routeVerify = (condition, name) => { if (!condition) routeFailure ||= name; else checks += 1; };
  const finish = name => { cases.push(name); process.stdout.write(`${name}: pass\n`); };
  const fulfill = async (route, response) => {
    try { await route.fulfill(response); counts.fulfilled += 1; } catch { counts.canceled_response += 1; }
  };
  const json = (route, body, status = 200) => {
    const pathname = new URL(route.request().url()).pathname;
    const key = `${pathname.startsWith(API) ? 'inspection' : pathname}:${status}`;
    apiResponses[key] = (apiResponses[key] || 0) + 1;
    return fulfill(route, { status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Cache-Control': 'no-store' } });
  };
  let rejectTimeout;
  const timeoutSignal = new Promise((_, reject) => { rejectTimeout = reject; });
  timeoutSignal.catch(() => {});
  const close = () => {
    if (!context) return Promise.resolve(true);
    if (!closeTask) {
      let closeTimer;
      closeTask = Promise.race([context.close().then(() => true, () => false), new Promise(resolve => { closeTimer = setTimeout(() => resolve(false), 4000); })])
        .finally(() => clearTimeout(closeTimer));
    }
    return closeTask;
  };
  try {
    timer = setTimeout(() => { timedOut = true; rejectTimeout(new Error('Synthetic fixture timeout')); void close(); }, 55000);
    context = await chromium.launchPersistentContext(profile, {
      executablePath: CHROME, headless: true, serviceWorkers: 'block',
      viewport: { width: 1360, height: 900 }, proxy: { server: 'http://127.0.0.1:9' },
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--dns-prefetch-disable', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
    });
    context.setDefaultTimeout(5000);
    context.on('page', target => {
      target.on('dialog', async dialog => {
        if (dialog.type() === 'confirm') {
          counts[confirmAnswer ? 'confirm_accepted' : 'confirm_dismissed'] += 1;
          await (confirmAnswer ? dialog.accept() : dialog.dismiss());
        } else await dialog.dismiss();
      });
      target.on('console', message => {
        privacy.console_sensitive ||= sensitive(message.text());
        if (message.type() !== 'error') return;
        counts.console_errors += 1;
        const value = message.text();
        if (value.includes('net::ERR_BLOCKED_BY_CLIENT')) consoleKinds.blocked_resource += 1;
        else if (/the server responded with a status of (403|500|503|504)/.test(value)) consoleKinds.mocked_http_error += 1;
        else if (value.startsWith('[API Error]')) consoleKinds.fixed_api_error += 1;
        else if (value === 'Login failed' && expectCoordinationFailure) consoleKinds.expected_coordination_failure += 1;
        else consoleKinds.other += 1;
      });
      target.on('pageerror', error => { privacy.console_sensitive ||= sensitive(error.message); counts.page_errors += 1; });
    });
    await context.route('**/*', async route => {
      counts.intercepted += 1;
      const request = route.request(); const url = new URL(request.url()); const headers = await request.allHeaders();
      privacy.url_sensitive ||= sensitive(request.url()); privacy.referer_sensitive ||= sensitive(headers.referer);
      if (url.origin !== FRONT) {
        if (url.hostname.includes('blacklake.cn')) counts.provider += 1;
        if (url.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2') blocked.font_stylesheet += 1;
        else blocked.unexpected_origin += 1;
        counts.aborted += 1; return route.abort('blockedbyclient');
      }
      if (url.pathname.startsWith('/api/')) {
        const actor = headers.authorization === `Bearer ${pairs.a.access}` ? 'a' : headers.authorization === `Bearer ${pairs.b.access}` ? 'b' : null;
        if (url.pathname === '/api/token/' && request.method() === 'POST') {
          const body = request.postDataJSON();
          const selected = body.username === 'fixture-a' ? 'a' : body.username === 'fixture-b' ? 'b' : null;
          routeVerify(Boolean(selected) && body.password === PASSWORD, 'real_login_form_synthetic_identity');
          if (!selected) return json(route, { code: 'synthetic_account_missing' }, 401);
          counts[`login_${selected}`] += 1;
          const hold = pendingLogin;
          if (hold && hold.actor === selected) { pendingLogin = null; hold.started.resolve(); await hold.reply.promise; }
          await json(route, pairs[selected]);
          counts[`login_reply_${selected}`] += 1;
          return;
        }
        if (url.pathname === '/api/token/refresh/') { counts.refresh += 1; return json(route, { code: 'token_not_valid' }, 401); }
        if (!actor) { routeFailure ||= 'authenticated_api_has_actor'; return json(route, { code: 'synthetic_missing_auth' }, 401); }
        if (url.pathname === '/api/injection/user/me/' && request.method() === 'GET') {
          counts[`identity_${actor}`] += 1;
          const hold = pendingIdentity?.actor === actor ? pendingIdentity : null;
          if (hold) { pendingIdentity = null; hold.started.resolve(); await hold.reply.promise; }
          await json(route, { id: actor === 'a' ? 101 : 202, username: `fixture-${actor}`, email: '',
            department: 'synthetic-only', groups: [], is_active: true, is_staff: !pilotMode, is_superuser: !pilotMode,
            password_reset_required: false, is_using_temp_password: false, permissions: { is_admin: !pilotMode, can_view_quality: true, can_edit_quality: true } });
          hold?.settled.resolve();
          return;
        }
        if (url.pathname === '/api/mes-connection/logout/' && request.method() === 'POST') {
          counts[`logout_${actor}`] += 1;
          routeVerify(request.postDataJSON().refresh === pairs[actor].refresh, 'logout_refresh_matches_authenticated_actor');
          return json(route, logoutFails ? { code: 'synthetic_unavailable' } : { disconnected: true }, logoutFails ? 500 : 200);
        }
        if (reconnectMode && url.pathname === '/api/mes-connection/' && request.method() === 'GET') {
          return json(route, { enabled: true, status: mesConnected ? 'connected' : 'reconnect_required', reason: 'synthetic_expiry', expires_at: null,
            can_connect: !mesConnected, can_disconnect: false, mode: 'stored_identity', live_ready: false,
            login_hint: { factory_number: '12345678', account_name: 'fixture-mes-a', prefill_supported: false } });
        }
        if (url.pathname === '/api/production/status/' && request.method() === 'GET') return json(route, { injection: [], machining: [] });
        if (url.pathname.startsWith(API)) {
          if (request.method() === 'GET') {
            if (url.pathname === `${API}capabilities/`) {
              const hold = pendingCapability;
              if (hold) { pendingCapability = null; hold.started.resolve(); await hold.reply.promise; }
              if (capabilityMode !== 'allowed') return json(route, { detail: 'Synthetic capability unavailable' }, capabilityMode === 'denied' ? 403 : 500);
              return json(route, { data_mode: 'wj_local_beta', can_view: true, can_manage: !pilotMode, can_submit: true, can_review: false,
                access_scope: pilotMode ? 'assigned_only' : 'all', can_view_kanban: !pilotMode,
                mes: { enabled: false, reason_code: 'mes_contract_unverified', message: 'Synthetic disconnected adapter', can_refresh: false, can_sync: false } });
            }
            if (url.pathname === `${API}kanban/`) { counts.kanban_read += 1; return json(route, kanban(records[actor], url.searchParams.get('date'))); }
            if (url.pathname === API) { counts.list_read += 1; return json(route, { count: 1, next: null, previous: null, results: [records[actor]], work_groups: [], work_groups_truncated: false }); }
            if (url.pathname === `${API}1/`) { counts[`detail_read_${actor}`] += 1; return json(route, records[actor]); }
          }
          if (request.method() === 'PATCH' && url.pathname === `${API}1/`) {
            counts[`mutation_${actor}`] += 1;
            const body = request.postDataJSON();
            routeVerify(Boolean(headers['idempotency-key']), 'mutation_has_idempotency_key');
            routeVerify(body.notes === (actor === 'a' ? NOTE_A : NOTE_B), 'mutation_draft_matches_authenticated_actor');
            const hold = pendingMutation;
            if (hold) {
              pendingMutation = null;
              routeVerify(hold.actor === actor, 'deferred_mutation_matches_owner');
              hold.started.resolve(); await hold.reply.promise;
              if (hold.unknown) return json(route, { detail: 'Synthetic gateway timeout' }, 504);
              await json(route, { ...records[actor], notes: LATE_NOTE, version: 99 });
              hold.settled.resolve();
              return;
            }
            records[actor] = { ...records[actor], ...body, version: records[actor].version + 1 };
            return json(route, records[actor]);
          }
          if (reconnectMode && request.method() === 'POST' && [`${API}1/mes-save/`, `${API}1/mes-finish/`].includes(url.pathname)) {
            const action = url.pathname.endsWith('/mes-save/') ? 'mes-save' : 'mes-finish';
            const body = request.postDataJSON();
            routeVerify(body.version === records.a.version && Boolean(headers['idempotency-key']), 'stage_uses_current_version_and_key');
            stageAttempts.push({ action, version: body.version, key: headers['idempotency-key'] });
            const current = records.a;
            records.a = { ...current, version: current.version + 2, last_error_code: mesConnected ? '' : 'mes_connection_required' };
            if (!mesConnected) return json(route, { code: 'mes_connection_required', operation_id: stageAttempts.length, request: records.a }, 503);
            if (action === 'mes-save') {
              records.a.sync_status = 'succeeded';
              records.a.mes_workflow = { ...current.mes_workflow, phase: 'saved', can_save: false, can_finish: true, can_reconcile: true };
              return json(route, records.a);
            }
            records.a.sync_status = 'unknown'; records.a.last_error_code = 'mes_outcome_unknown';
            records.a.mes_workflow = { ...current.mes_workflow, phase: 'finish_unknown', can_save: false, can_finish: false, can_reconcile: true };
            return json(route, { code: 'mes_outcome_unknown', operation_id: stageAttempts.length, request: records.a }, 503);
          }
          if (/\/(?:mes-save|mes-finish|mes-reconcile|sync|refresh)\/$/.test(url.pathname)) counts.mes_write += 1;
        }
        blocked.unexpected_api += 1; counts.aborted += 1; return route.abort('blockedbyclient');
      }
      if (request.method() === 'GET' && [INSPECTION, '/login'].includes(url.pathname)) return fulfill(route, { status: 200, contentType: 'text/html', body: index });
      const candidate = path.resolve(DIST, '.' + url.pathname);
      if (request.method() === 'GET' && candidate.startsWith(DIST + path.sep)
        && (url.pathname.startsWith('/assets/') || ['/logo.jpg', '/logo-transparent.png'].includes(url.pathname))
        && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const types = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
        const body = fs.readFileSync(candidate);
        const previous = artifact.served_asset_sha256[url.pathname];
        routeVerify(!previous || previous === sha(body), 'served_asset_stable_across_requests');
        artifact.served_asset_sha256[url.pathname] = sha(body);
        return fulfill(route, { status: 200, contentType: types[path.extname(candidate)] || 'application/octet-stream', body });
      }
      blocked.unexpected_frontend_path += 1; counts.aborted += 1; return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => { blocked.websocket += 1; counts.aborted += 1; socket.close(); });
    await context.addInitScript(({ origin, key, initialPair }) => {
      if (location.origin !== origin) return;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ id: 'synthetic-inspection-initial-a', ...initialPair }));
      localStorage.setItem('lang', 'ko'); localStorage.setItem('wj_next_language', 'ko');
    }, { origin: FRONT, key: CONTROL, initialPair: pairs.a });
    page = await context.newPage();
    const userVisible = (target, actor) => target.locator('.main-user-menu__trigger').filter({ hasText: `fixture-${actor}` }).waitFor();
    const inspectorVisible = async (target, actor) => {
      await target.getByRole('heading', { name: '검사요청관리', exact: true }).waitFor();
      await target.locator('.inspection-inspector strong').filter({ hasText: `fixture-${actor}` }).waitFor();
    };
    const openRequest = async target => {
      await target.locator('.inspection-kanban-request').filter({ hasText: 'SYNTHETIC-WO-1' }).click();
      await target.getByRole('heading', { name: 'SYNTHETIC-WO-1', exact: true }).waitFor();
    };
    const retained = (target, actor) => target.evaluate(({ key, invalidated, pair }) => {
      const stored = JSON.parse(localStorage.getItem(key) || '{}');
      const tag = stored.id ? JSON.parse(localStorage.getItem(invalidated + stored.id) || 'null') : null;
      return Boolean(stored.id) && tag?.sessionId !== stored.id && stored.access === pair.access && stored.refresh === pair.refresh;
    }, { key: CONTROL, invalidated: INVALIDATED, pair: pairs[actor] });
    const effectivelyLoggedOut = target => target.evaluate(({ key, invalidated }) => {
      const stored = JSON.parse(localStorage.getItem(key) || '{}');
      const tag = stored.id ? JSON.parse(localStorage.getItem(invalidated + stored.id) || 'null') : null;
      return stored.id === null || (typeof stored.id === 'string' && tag?.sessionId === stored.id);
    }, { key: CONTROL, invalidated: INVALIDATED });
    const recovery = (target, actor, expected) => target.evaluate(({ actor, expected }) => {
      const owner = actor === 'a' ? 101 : 202;
      const item = JSON.parse(sessionStorage.getItem(`wj-inspection-draft:v1:${owner}:1`) || 'null');
      return Boolean(item && item.user_id === owner && item.request_id === 1 && item.draft.notes === expected && item.attempt && item.attempt.key && item.attempt.payload.notes === expected);
    }, { actor, expected });
    const login = async (target, actor, wait = true, navigate = true) => {
      if (navigate) await target.goto(`${FRONT}/login?returnTo=${INSPECTION}`, { waitUntil: 'domcontentloaded' });
      await target.locator('#username').fill(`fixture-${actor}`); await target.locator('#password').fill(PASSWORD);
      await target.locator('form button[type="submit"]').first().click();
      if (wait) { await userVisible(target, actor); await inspectorVisible(target, actor); }
    };
    const logoutMenu = async target => {
      await target.locator('.main-user-menu__trigger').click();
      await target.getByRole('menuitem', { name: '로그아웃', exact: true }).click();
    };
    const observeCommitTransactions = target => target.evaluate(databaseName => {
      const native = IDBDatabase.prototype.transaction;
      window.__fixtureCommitTransactions = 0;
      window.__restoreFixtureCommitObserver = () => { IDBDatabase.prototype.transaction = native; };
      IDBDatabase.prototype.transaction = function (...args) {
        if (this.name === databaseName && args[1] === 'readwrite') window.__fixtureCommitTransactions += 1;
        return Reflect.apply(native, this, args);
      };
    }, COORDINATOR);
    // The test lock uses real IndexedDB scheduling and never writes a record.
    // The watchdog bounds it even if an assertion fails before explicit release.
    const holdCoordinator = target => target.evaluate(({ databaseName, control }) => new Promise((resolve, reject) => {
      if (window.__fixtureCoordinator?.listener) window.removeEventListener('storage', window.__fixtureCoordinator.listener);
      const state = { release: false, completed: false, installations: 0, listener: null };
      state.listener = event => { if (event.key === control) state.installations += 1; };
      window.addEventListener('storage', state.listener);
      window.__fixtureCoordinator = state;
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('commit')) request.result.createObjectStore('commit');
      };
      request.onerror = () => reject(new Error('Fixture coordinator open failed'));
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('commit', 'readwrite');
        const store = transaction.objectStore('commit');
        const watchdog = setTimeout(() => { state.release = true; }, 12000);
        transaction.oncomplete = () => { clearTimeout(watchdog); state.completed = true; database.close(); };
        transaction.onerror = transaction.onabort = () => { clearTimeout(watchdog); database.close(); reject(new Error('Fixture coordinator hold failed')); };
        let announced = false;
        const keepAlive = () => {
          const read = store.get('coordinator');
          read.onsuccess = () => {
            if (!announced) { announced = true; resolve(true); }
            if (!state.release) keepAlive();
          };
        };
        keepAlive();
      };
    }), { databaseName: COORDINATOR, control: CONTROL });
    const releaseCoordinator = async target => {
      await target.evaluate(() => { window.__fixtureCoordinator.release = true; });
      await target.waitForFunction(() => window.__fixtureCoordinator.completed);
    };
    const inspectCoordinator = target => target.evaluate(({ databaseName, privateValues }) => new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onerror = () => reject(new Error('Fixture coordinator inspection failed'));
      request.onsuccess = () => {
        const database = request.result;
        const storeCount = database.objectStoreNames.length;
        const transaction = database.transaction('commit', 'readonly');
        const read = transaction.objectStore('commit').getAll();
        read.onsuccess = () => {
          const contents = JSON.stringify(read.result);
          resolve({ store_count: storeCount, record_count: read.result.length,
            token_or_draft_present: privateValues.some(value => contents.includes(value)) });
        };
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => { database.close(); reject(new Error('Fixture coordinator read failed')); };
      };
    }), { databaseName: COORDINATOR, privateValues });

    if (reconnectMode) {
      stage = 'save_before_dispatch_reconnect_keeps_request_and_requires_explicit_retry'; step = 'open_request';
      await page.goto(FRONT + INSPECTION, { waitUntil: 'domcontentloaded' });
      await userVisible(page, 'a'); await inspectorVisible(page, 'a'); await openRequest(page);
      await page.getByText('MES 검사 완료 상태', { exact: true }).click();
      const save = page.getByRole('button', { name: 'MES 검사값 저장', exact: true });
      const finishButton = page.getByRole('button', { name: 'QC 검사 완료', exact: true });
      step = 'first_save';
      await save.click();
      const dialog = page.getByRole('dialog', { name: 'MES 연결', exact: true });
      step = 'first_connection_dialog';
      await dialog.waitFor({ state: 'attached' });
      await dialog.getByRole('heading', { name: 'MES 연결', exact: true }).waitFor();
      step = 'first_connection_status';
      await dialog.getByText('MES 계정을 다시 연결해 주세요.', { exact: true }).waitFor();
      verify(stageAttempts.length === 1 && records.a.mes_workflow.phase === 'ready', 'pre_dispatch_failure_keeps_ready_stage');
      verify(await page.getByRole('button', { name: '동일 요청 결과 확인·재시도', exact: true }).count() === 0, 'known_no_dispatch_clears_pending_attempt');
      const recoveryAfterFailure = await page.evaluate(() => JSON.parse(sessionStorage.getItem('wj-inspection-draft:v1:101:1') || 'null'));
      verify(recoveryAfterFailure?.attempt === null && recoveryAfterFailure?.version === 4 && recoveryAfterFailure?.draft.notes === NOTE_A, 'new_version_and_original_draft_persisted');
      step = 'cancel_connection';
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      verify(await save.isEnabled() && new URL(page.url()).pathname === INSPECTION, 'cancel_returns_to_same_request');
      verify(await page.locator('.inspection-detail label').filter({ hasText: '검사 메모' }).locator('textarea').inputValue() === NOTE_A, 'cancel_preserves_notes');
      step = 'second_save';
      await save.click();
      await dialog.waitFor({ state: 'attached' });
      await dialog.getByRole('heading', { name: 'MES 연결', exact: true }).waitFor();
      await dialog.getByText('MES 계정을 다시 연결해 주세요.', { exact: true }).waitFor();
      verify(stageAttempts.length === 2 && stageAttempts[1].version === 4 && stageAttempts[1].key !== stageAttempts[0].key, 'manual_retry_gets_new_key_and_updated_version');
      mesConnected = true;
      step = 'connection_status_recheck';
      await dialog.getByRole('button', { name: '상태 확인', exact: true }).click();
      await dialog.getByText('MES 계정이 연결되어 있습니다.', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      verify(stageAttempts.length === 2, 'connection_success_does_not_replay_write');
      await save.click();
      await finishButton.waitFor({ state: 'visible' });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'QC 검사 완료' && !button.disabled));
      verify(stageAttempts.length === 3 && stageAttempts[2].version === 6 && records.a.mes_workflow.phase === 'saved', 'explicit_save_after_reconnect_uses_new_version');
      finish(stage);

      stage = 'finish_reconnect_preserves_saved_phase_unknown_result_requires_reconciliation'; step = 'expire_before_finish';
      mesConnected = false; confirmAnswer = true;
      await finishButton.click(); await dialog.waitFor({ state: 'attached' });
      await dialog.getByRole('heading', { name: 'MES 연결', exact: true }).waitFor();
      await dialog.getByText('MES 계정을 다시 연결해 주세요.', { exact: true }).waitFor();
      verify(records.a.sync_status === 'succeeded' && records.a.mes_workflow.phase === 'saved', 'finish_credential_failure_preserves_saved_values');
      mesConnected = true;
      await dialog.getByRole('button', { name: '상태 확인', exact: true }).click();
      await dialog.getByText('MES 계정이 연결되어 있습니다.', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      verify(stageAttempts.length === 4 && await finishButton.isEnabled(), 'finish_requires_explicit_retry_after_reconnect');
      await finishButton.click();
      await page.getByText(/^MES 처리 결과가 미확정입니다\. 입력·제출/).waitFor();
      verify(stageAttempts.length === 5 && stageAttempts[4].version === 10 && stageAttempts[4].key !== stageAttempts[3].key, 'finish_retry_uses_fresh_key_and_version');
      verify(await dialog.count() === 0 && await finishButton.isDisabled() && await save.isDisabled(), 'post_write_unknown_does_not_open_reconnect_or_enable_write');
      verify(await page.getByRole('button', { name: '동일 요청 결과 확인·재시도', exact: true }).count() === 0, 'unknown_result_has_no_generic_write_retry');
      verify(await page.getByRole('button', { name: 'MES 상태 재조회', exact: true }).isEnabled(), 'unknown_result_offers_scoped_readback');
      finish(stage);
    } else if (pilotMode) {
      stage = 'pilot_waits_for_server_capability'; step = 'pending_capability';
      const hold = { started: deferred(), reply: deferred() };
      pendingCapability = hold; releases.push(hold.reply.resolve);
      await page.goto(FRONT + INSPECTION, { waitUntil: 'domcontentloaded' });
      await Promise.race([hold.started.promise, timeoutSignal]);
      verify(await page.locator('.inspection-inspector, .inspection-detail').count() === 0, 'pending_capability_has_no_inspection_editor');
      verify(counts.list_read === 0 && counts.kanban_read === 0 && counts.detail_read_a === 0, 'pending_capability_sends_no_record_queries');
      hold.reply.resolve();
      await userVisible(page, 'a'); await inspectorVisible(page, 'a');
      await page.locator('.inspection-assigned-workspace').waitFor();
      verify(await page.locator(`.main-sidebar--desktop a[href="${INSPECTION}"]`).count() === 1, 'server_capability_exposes_pilot_navigation');
      verify(await page.locator('.inspection-page-actions button').count() === 0, 'ungranted_pilot_cannot_create_requests');
      verify(counts.kanban_read === 0 && counts.list_read > 0, 'assigned_only_pilot_reads_list_without_kanban');
      await page.locator('.inspection-list-row').filter({ hasText: 'SYNTHETIC-WO-1' }).click();
      await page.getByRole('heading', { name: 'SYNTHETIC-WO-1', exact: true }).waitFor();
      verify(counts.detail_read_a === 1 && counts.kanban_read === 0, 'assigned_pilot_opens_detail_without_all_account_board');
      finish(stage);

      for (const mode of ['denied', 'failed']) {
        stage = `pilot_capability_${mode}_defaults_to_denied`; step = 'relogin_without_inspection_grant';
        await logoutMenu(page); await page.locator('#username').waitFor();
        capabilityMode = mode;
        const before = { list: counts.list_read, detail: counts.detail_read_a, kanban: counts.kanban_read };
        await page.goto(`${FRONT}/login?returnTo=/__mes-fixture__/`, { waitUntil: 'domcontentloaded' });
        await page.locator('#username').fill('fixture-a'); await page.locator('#password').fill(PASSWORD);
        await page.locator('form button[type="submit"]').first().click();
        await userVisible(page, 'a');
        verify(await page.locator(`.main-sidebar--desktop a[href="${INSPECTION}"]`).count() === 0, `${mode}_capability_hides_inspection_navigation`);
        verify(await page.locator('.inspection-inspector, .inspection-detail').count() === 0, `${mode}_capability_has_no_inspection_editor`);
        verify(counts.list_read === before.list && counts.detail_read_a === before.detail && counts.kanban_read === before.kanban, `${mode}_capability_sends_no_record_queries`);
        verify(await retained(page, 'a'), `${mode}_inspection_capability_does_not_falsely_log_out_other_app_access`);
        finish(stage);
      }
    } else {
    stage = 'current_inspector_and_dirty_switch_cancel'; step = 'mount';
    await page.goto(FRONT + INSPECTION, { waitUntil: 'domcontentloaded' });
    await userVisible(page, 'a'); await inspectorVisible(page, 'a'); await openRequest(page);
    verify(await page.locator('.inspection-inspector input, .inspection-inspector select').count() === 0, 'inspector_identity_is_not_name_picker');
    step = 'edit_and_cancel_switch';
    await page.locator('.inspection-detail label').filter({ hasText: '검사 메모' }).locator('textarea').fill(NOTE_A);
    await page.getByRole('button', { name: '검사자 전환', exact: true }).click();
    verify(counts.confirm_dismissed === 1 && counts.logout_a === 0, 'dirty_switch_cancel_never_revokes');
    step = 'verify_draft_after_cancel';
    verify(await page.locator('.inspection-detail label').filter({ hasText: '검사 메모' }).locator('textarea').inputValue() === NOTE_A && await retained(page, 'a'), 'cancel_retains_actor_and_draft');
    notesLabelObservation = {
      role_exact_count: await page.getByRole('textbox', { name: '검사 메모', exact: true }).count(),
      label_exact_count: await page.getByLabel('검사 메모', { exact: true }).count(),
      ...await page.locator('.inspection-detail label').filter({ hasText: '검사 메모' }).locator('textarea').evaluate((element, note) => ({
        associated_label_present: Boolean(element.labels?.length),
        associated_label_includes_draft: Boolean(element.labels?.[0]?.textContent?.includes(note)),
        associated_label_equals_caption: element.labels?.[0]?.textContent?.trim() === '검사 메모',
      }), NOTE_A),
    };
    finish(stage);

    stage = 'failed_logout_preserves_actor_and_draft'; step = 'accept_switch_with_failed_revoke';
    confirmAnswer = true; logoutFails = true;
    await page.getByRole('button', { name: '검사자 전환', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '로그아웃 완료를 확인할 수 없습니다' }).first().waitFor();
    verify(counts.logout_a === 1 && counts.login_b === 0, 'failed_revoke_has_no_new_login');
    verify(await retained(page, 'a') && await page.locator('.inspection-detail label').filter({ hasText: '검사 메모' }).locator('textarea').inputValue() === NOTE_A, 'failed_revoke_preserves_editor');
    logoutFails = false; finish(stage);

    stage = 'pending_save_blocks_local_logout'; step = 'start_deferred_save';
    const firstMutation = { actor: 'a', unknown: true, started: deferred(), reply: deferred() };
    pendingMutation = firstMutation; releases.push(firstMutation.reply.resolve);
    await page.getByRole('button', { name: '초안 저장', exact: true }).click();
    await Promise.race([firstMutation.started.promise, timeoutSignal]);
    step = 'attempt_header_logout';
    const priorLogout = counts.logout_a;
    await logoutMenu(page);
    await page.getByText('진행 중인 요청의 응답을 기다린 뒤 검사자를 전환하세요.', { exact: true }).waitFor();
    verify(counts.logout_a === priorLogout && await retained(page, 'a'), 'pending_request_blocks_server_revoke');
    verify(await recovery(page, 'a', NOTE_A), 'pending_attempt_persisted_for_owner');
    finish(stage);

    stage = 'unknown_outcome_allows_logout_and_preserves_owner_recovery'; step = 'release_timeout';
    firstMutation.reply.resolve();
    await page.getByRole('button', { name: '동일 요청 결과 확인·재시도', exact: true }).waitFor();
    verify(await recovery(page, 'a', NOTE_A), 'unknown_outcome_retains_original_body_and_key');
    step = 'switch_after_outcome_unknown';
    await page.getByRole('button', { name: '검사자 전환', exact: true }).click();
    await page.locator('#username').waitFor();
    verify(await recovery(page, 'a', NOTE_A), 'confirmed_logout_preserves_unresolved_recovery');
    verify(await effectivelyLoggedOut(page), 'confirmed_logout_invalidates_effective_session');
    verify(await page.locator('.inspection-detail, .inspection-inspector, .main-user-menu__trigger').count() === 0, 'logged_out_identity_and_inspection_actions_unavailable');
    finish(stage);

    stage = 'new_inspector_cannot_restore_prior_inspector_draft'; step = 'login_b';
    await login(page, 'b', true, false); await openRequest(page);
    verify(await page.locator('.inspection-detail label').filter({ hasText: '검사 메모' }).locator('textarea').inputValue() === '', 'b_editor_does_not_inherit_a_draft');
    verify(await page.getByRole('button', { name: '입력 복구', exact: true }).count() === 0, 'b_has_no_a_recovery_button');
    verify(await recovery(page, 'a', NOTE_A) && await retained(page, 'b'), 'a_recovery_retained_b_authenticated');
    finish(stage);

    stage = 'external_account_switch_ignores_late_mutation'; step = 'pending_b_save';
    await page.locator('.inspection-detail label').filter({ hasText: '검사 메모' }).locator('textarea').fill(NOTE_B);
    const secondMutation = { actor: 'b', unknown: false, started: deferred(), reply: deferred(), settled: deferred() };
    pendingMutation = secondMutation; releases.push(secondMutation.reply.resolve);
    await page.getByRole('button', { name: '초안 저장', exact: true }).click();
    await Promise.race([secondMutation.started.promise, timeoutSignal]);
    step = 'other_tab_real_login_a';
    const secondTab = await context.newPage(); await login(secondTab, 'a');
    await userVisible(page, 'a');
    // A confirmed logout in another tab can route this tab to LoginPage.
    // Re-enter via the real client navigation, keeping the old request alive.
    if (new URL(page.url()).pathname !== INSPECTION) {
      await page.locator(`.main-sidebar--desktop a[href="${INSPECTION}"]`).click();
    }
    await inspectorVisible(page, 'a');
    secondMutation.reply.resolve();
    step = 'verify_new_actor_after_late_response';
    await Promise.race([secondMutation.settled.promise, timeoutSignal]);
    const priorARead = counts.detail_read_a;
    await openRequest(page);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    verify(await page.locator('.inspection-detail label').filter({ hasText: '검사 메모' }).locator('textarea').inputValue() === '', 'late_b_response_not_adopted_by_a');
    verify(await recovery(page, 'b', NOTE_B) && await recovery(page, 'a', NOTE_A), 'external_switch_preserves_separate_owner_attempts');
    verify(counts.mutation_a === 1 && counts.mutation_b === 1, 'account_switch_never_replays_mutation');
    await page.getByRole('button', { name: '입력 복구', exact: true }).click();
    verify(counts.detail_read_a === priorARead + 1, 'owner_reentry_fetches_fresh_server_detail');
    verify(await page.locator('.inspection-detail label').filter({ hasText: '검사 메모' }).locator('textarea').inputValue() === NOTE_A, 'explicit_restore_only_restores_authenticated_owner');
    verify(counts.mutation_a === 1 && counts.mutation_b === 1, 'explicit_restore_never_automatically_resends_attempt');
    await secondTab.close(); finish(stage);

    stage = 'older_login_response_cannot_replace_newer_session'; step = 'logout_to_login';
    await logoutMenu(page); await page.locator('#username').waitFor();
    const oldLogin = { actor: 'b', started: deferred(), reply: deferred() };
    pendingLogin = oldLogin; releases.push(oldLogin.reply.resolve);
    step = 'hold_old_login';
    await login(page, 'b', false); await Promise.race([oldLogin.started.promise, timeoutSignal]);
    step = 'newer_login_in_other_tab';
    const thirdTab = await context.newPage(); await login(thirdTab, 'a');
    oldLogin.reply.resolve();
    await page.getByText('로그인에 실패했습니다. 아이디와 비밀번호를 확인하세요.', { exact: true }).waitFor();
    verify(await retained(page, 'a') && await retained(thirdTab, 'a'), 'older_login_cannot_replace_new_session');
    verify(counts.login_b === 2 && counts.login_a === 2, 'login_race_used_actual_form_requests');
    await thirdTab.close(); finish(stage);

    stage = 'late_identity_response_cannot_rebind_new_inspector'; step = 'hold_a_identity_initialization';
    const oldIdentity = { actor: 'a', started: deferred(), reply: deferred(), settled: deferred() };
    pendingIdentity = oldIdentity; releases.push(oldIdentity.reply.resolve);
    await page.goto(FRONT + INSPECTION, { waitUntil: 'domcontentloaded' });
    await Promise.race([oldIdentity.started.promise, timeoutSignal]);
    verify(await page.locator('.inspection-inspector, .inspection-detail').count() === 0, 'identity_loading_cannot_expose_previous_inspector_editor');
    const logoutBeforeIdentitySwitch = counts.logout_a;
    const loginBeforeIdentitySwitch = counts.login_b;
    const fourthTab = await context.newPage();
    step = 'login_b_while_old_a_identity_is_pending';
    await login(fourthTab, 'b');
    await userVisible(page, 'b');
    if (new URL(page.url()).pathname !== INSPECTION) {
      await page.locator(`.main-sidebar--desktop a[href="${INSPECTION}"]`).click();
    }
    await inspectorVisible(page, 'b');
    verify(counts.logout_a === logoutBeforeIdentitySwitch + 1 && counts.login_b === loginBeforeIdentitySwitch + 1, 'identity_race_uses_confirmed_revoke_and_real_login');
    step = 'release_stale_a_identity';
    oldIdentity.reply.resolve();
    await Promise.race([oldIdentity.settled.promise, timeoutSignal]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await userVisible(page, 'b'); await inspectorVisible(page, 'b'); await openRequest(page);
    verify(await retained(page, 'b'), 'old_identity_response_cannot_change_effective_b_session');
    verify(await page.locator('.inspection-inspector strong').filter({ hasText: 'fixture-a' }).count() === 0, 'old_a_identity_cannot_label_b_editor');
    verify(await page.locator('.inspection-detail label').filter({ hasText: '검사 메모' }).locator('textarea').inputValue() === '', 'late_identity_does_not_adopt_either_private_draft');
    await page.getByRole('button', { name: '입력 복구', exact: true }).click();
    verify(await page.locator('.inspection-detail label').filter({ hasText: '검사 메모' }).locator('textarea').inputValue() === NOTE_B, 'new_identity_restores_only_b_owned_draft');
    verify(await recovery(page, 'a', NOTE_A) && await recovery(page, 'b', NOTE_B), 'late_identity_preserves_isolated_owner_recoveries');
    verify(counts.mutation_a === 1 && counts.mutation_b === 1, 'identity_race_does_not_replay_any_mutation');
    await fourthTab.close(); finish(stage);

    stage = 'concurrent_login_commits_are_serialized'; step = 'logout_before_commit_race';
    await logoutMenu(page); await page.locator('#username').waitFor();
    verify(await effectivelyLoggedOut(page), 'commit_race_starts_without_effective_session');
    const witnessTab = await context.newPage();
    await witnessTab.goto(`${FRONT}/login?returnTo=${INSPECTION}`, { waitUntil: 'domcontentloaded' });
    await witnessTab.locator('#username').waitFor();
    await holdCoordinator(witnessTab);
    await observeCommitTransactions(page);
    const competingTab = await context.newPage();
    await competingTab.goto(`${FRONT}/login?returnTo=${INSPECTION}`, { waitUntil: 'domcontentloaded' });
    await competingTab.locator('#username').waitFor();
    await observeCommitTransactions(competingTab);
    const repliesBeforeRace = { a: counts.login_reply_a, b: counts.login_reply_b };
    step = 'queue_two_actual_login_commits';
    await login(page, 'a', false, false);
    await page.waitForFunction(() => window.__fixtureCommitTransactions === 1);
    await login(competingTab, 'b', false, false);
    await competingTab.waitForFunction(() => window.__fixtureCommitTransactions === 1);
    verify(counts.login_reply_a === repliesBeforeRace.a + 1 && counts.login_reply_b === repliesBeforeRace.b + 1, 'both_real_login_replies_arrive_before_commit_release');
    verify(await effectivelyLoggedOut(page) && await effectivelyLoggedOut(competingTab), 'blocked_commit_cannot_install_auth_early');
    verify(await witnessTab.evaluate(() => window.__fixtureCoordinator.installations) === 0, 'no_control_installation_while_coordinator_locked');
    step = 'release_real_indexeddb_commit_lock';
    await releaseCoordinator(witnessTab);
    await page.waitForFunction(({ key, invalidated }) => {
      const stored = JSON.parse(localStorage.getItem(key) || '{}');
      return Boolean(stored.id) && JSON.parse(localStorage.getItem(invalidated + stored.id) || 'null')?.sessionId !== stored.id;
    }, { key: CONTROL, invalidated: INVALIDATED });
    const winningActor = await retained(page, 'a') ? 'a' : await retained(page, 'b') ? 'b' : null;
    verify(Boolean(winningActor), 'serialized_commit_has_one_valid_actor');
    const winningTab = winningActor === 'a' ? page : competingTab;
    const losingTab = winningActor === 'a' ? competingTab : page;
    await inspectorVisible(winningTab, winningActor);
    await userVisible(losingTab, winningActor);
    await losingTab.getByText('로그인에 실패했습니다. 아이디와 비밀번호를 확인하세요.', { exact: true }).waitFor();
    verify(await witnessTab.evaluate(() => window.__fixtureCoordinator.installations) === 1, 'only_one_concurrent_login_installs_control_record');
    verify(await retained(page, winningActor) && await retained(competingTab, winningActor), 'losing_login_cannot_overwrite_winning_actor');
    const queuedObservation = await inspectCoordinator(witnessTab);
    coordinatorObservations.push({ case: 'concurrent_login', ...queuedObservation });
    verify(queuedObservation.store_count === 1 && queuedObservation.record_count === 0 && !queuedObservation.token_or_draft_present, 'coordinator_contains_no_token_identity_or_draft_records');
    await page.evaluate(() => window.__restoreFixtureCommitObserver());
    await competingTab.evaluate(() => window.__restoreFixtureCommitObserver());
    await competingTab.close(); finish(stage);

    stage = 'coordination_failure_and_timeout_fail_closed'; step = 'logout_before_coordination_faults';
    await logoutMenu(page); await page.locator('#username').waitFor();
    verify(await effectivelyLoggedOut(page), 'coordination_faults_start_without_effective_session');
    expectCoordinationFailure = true;
    const failuresBeforeFault = consoleKinds.expected_coordination_failure;
    const installationsBeforeFault = await witnessTab.evaluate(() => window.__fixtureCoordinator.installations);
    step = 'synthetic_indexeddb_open_denied';
    await page.evaluate(() => {
      const native = IDBFactory.prototype.open;
      window.__restoreFixtureOpen = () => { IDBFactory.prototype.open = native; };
      IDBFactory.prototype.open = () => { throw new DOMException('Synthetic storage denied', 'SecurityError'); };
    });
    await login(page, 'a', false, false);
    await page.getByText('로그인에 실패했습니다. 아이디와 비밀번호를 확인하세요.', { exact: true }).waitFor();
    verify(consoleKinds.expected_coordination_failure === failuresBeforeFault + 1 && await effectivelyLoggedOut(page), 'denied_coordinator_fails_closed_with_fixed_login_error');
    verify(await witnessTab.evaluate(() => window.__fixtureCoordinator.installations) === installationsBeforeFault, 'denied_coordinator_does_not_install_session');
    await page.evaluate(() => window.__restoreFixtureOpen());
    step = 'real_coordinator_lock_exceeds_login_timeout';
    await holdCoordinator(witnessTab);
    await observeCommitTransactions(page);
    await login(page, 'a', false, false);
    await page.waitForFunction(() => window.__fixtureCommitTransactions === 1);
    verify(await effectivelyLoggedOut(page), 'timed_commit_is_logged_out_while_waiting');
    await page.getByText('로그인에 실패했습니다. 아이디와 비밀번호를 확인하세요.', { exact: true }).waitFor({ timeout: 11000 });
    verify(consoleKinds.expected_coordination_failure === failuresBeforeFault + 2 && await effectivelyLoggedOut(page), 'coordinator_timeout_fails_closed_with_fixed_login_error');
    step = 'release_after_timeout_does_not_install_late_session';
    await releaseCoordinator(witnessTab);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    verify(await effectivelyLoggedOut(page) && await witnessTab.evaluate(() => window.__fixtureCoordinator.installations) === 0, 'aborted_timed_out_commit_cannot_install_late_session');
    verify(await page.locator('.inspection-inspector, .inspection-detail, .main-user-menu__trigger').count() === 0, 'coordination_failure_keeps_authenticated_actions_unavailable');
    const failureObservation = await inspectCoordinator(witnessTab);
    coordinatorObservations.push({ case: 'coordination_failures', ...failureObservation });
    verify(failureObservation.record_count === 0 && !failureObservation.token_or_draft_present, 'failed_coordination_does_not_store_tokens_or_drafts');
    await page.evaluate(() => window.__restoreFixtureCommitObserver());
    expectCoordinationFailure = false;
    await witnessTab.close(); finish(stage);
    }

    stage = 'privacy_and_integrity'; step = 'final_checks';
    verify(counts.provider === 0 && counts.mes_write === 0 && counts.refresh === 0, 'no_provider_mes_write_or_refresh');
    verify(blocked.unexpected_api === 0 && blocked.unexpected_frontend_path === 0 && blocked.unexpected_origin === 0 && blocked.websocket === 0, 'all_requests_match_local_fixture');
    verify(counts.page_errors === 0 && consoleKinds.other === 0, 'no_unexpected_runtime_errors');
    verify(routeFailure === null, routeFailure || 'request_actor_contracts');
    verify(!Object.values(privacy).some(Boolean), 'no_sensitive_url_referrer_console');
    verify(JSON.stringify(sourceManifest()) === JSON.stringify(artifact.source_sha256), 'runtime_source_unchanged_during_fixture');
    verify(sha(fs.readFileSync(path.join(DIST, entry))) === artifact.entry_sha256, 'built_entry_unchanged_during_fixture');
    verify(Object.entries(artifact.served_asset_sha256).every(([name, digest]) => sha(fs.readFileSync(path.join(DIST, name))) === digest), 'all_served_assets_unchanged_during_fixture');
    verify(!timedOut, 'bounded_fixture_runtime');
    result = { ok: true };
  } catch (error) {
    if (page && !page.isClosed()) domPresence = await page.evaluate(() => ({
      root_populated: Boolean(document.querySelector('#root')?.childElementCount),
      user_menu: Boolean(document.querySelector('.main-user-menu__trigger')), login_input: Boolean(document.querySelector('#username')),
      inspection_page: Boolean(document.querySelector('.inspection-requests-page')),
      inspector_label: Boolean(document.querySelector('.inspection-inspector')),
      inspection_detail: Boolean(document.querySelector('.inspection-detail')),
      notes_textarea_count: [...document.querySelectorAll('.inspection-detail label')].filter(label => label.textContent.includes('검사 메모')).flatMap(label => [...label.querySelectorAll('textarea')]).length,
      route_dialog: Boolean(document.querySelector('.inspection-route-dialog')),
      mes_dialogs: [...document.querySelectorAll('[role="dialog"]')].map(element => {
        const label = element.getAttribute('aria-labelledby');
        const heading = label ? document.getElementById(label) : null;
        const rect = element.getBoundingClientRect();
        return { label_present: Boolean(label), label_resolves: Boolean(heading),
          label_matches: heading?.textContent === 'MES 연결', hidden_ancestor: Boolean(element.closest('[aria-hidden="true"], [inert]')),
          has_area: rect.width > 0 && rect.height > 0, display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility };
      }),
      router_error: document.body.innerText.includes('Unexpected Application Error'),
    })).catch(() => null);
    result = { ok: false, stage, step, check: error.fixtureCheck || null,
      error: timedOut ? 'FixtureTimeout' : error.name === 'TimeoutError' ? 'FixtureStepTimeout' : 'FixtureFailure' };
  } finally {
    clearTimeout(timer); releases.forEach(resolve => resolve());
    const closed = await close(); if (closed) fs.rmSync(profile, { recursive: true, force: true });
    const report = { ...result, started_at: startedAt, finished_at: new Date().toISOString(),
      cases, checks, counts, blocked, console_kinds: consoleKinds, api_responses: apiResponses, mode: reconnectMode ? 'mes_stage_reconnect' : pilotMode ? 'assigned_pilot' : 'shared_pc_races',
      privacy, dom_presence: domPresence, notes_label_observation: notesLabelObservation,
      coordinator_observations: coordinatorObservations, own_browser_closed: closed, artifact,
      limitations: ['all origins intercepted; real TLS and provider not exercised', 'synthetic identities and inspection records; no real MES or production writes', 'owner-specific recovery is browser session storage, not a secure vault'],
    };
    fs.writeSync(log, JSON.stringify(report, null, 2) + '\n'); fs.closeSync(log);
    process.stdout.write(JSON.stringify({ ok: report.ok, cases: cases.length, checks, stage: report.ok ? 'complete' : stage }) + '\n');
    if (!report.ok) process.exitCode = 1;
  }
})();
