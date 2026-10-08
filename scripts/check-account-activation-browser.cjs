'use strict';
// All HTTPS page traffic is intercepted to the isolated Django Client over
// stdin/stdout. The proxy and resolver prohibit fallback to real services.
const readline = require('node:readline');
const input = readline.createInterface({input: process.stdin});
const pending = new Map();
let initialize;
const ready = new Promise(resolve => { initialize = resolve; });
let sequence = 0;
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'init') initialize(message);
  else if (message.type === 'response') {
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  }
});
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const rpc = request => new Promise(resolve => {
  const id = ++sequence;
  pending.set(id, resolve);
  send({type: 'request', id, ...request});
});

(async () => {
  const config = await ready;
  const {chromium} = require(config.playwright);
  const activation = '/accounts/activate/';
  const issue = '/admin/account_activation/activationgrant/issue/';
  let context, stage = 'launch', checks = 0, token = '', sensitiveConsole = false;
  let unexpected = 0, privacyViolation = false, result;
  const sensitive = value => String(value || '').includes(config.password)
    || Boolean(token && String(value || '').includes(token));
  const verify = (condition, check) => {
    if (!condition) { const error = new Error('Synthetic fixture assertion failed.'); error.check = check; throw error; }
    checks++;
  };
  const close = async () => {
    if (context) await context.close();
  };
  process.on('SIGTERM', async () => { await close(); process.exit(143); });
  const timeout = setTimeout(async () => {
    send({type: 'result', ok: false, stage, error: 'FixtureTimeout', checks});
    await close(); process.exit(1);
  }, 45000);
  try {
    context = await chromium.launchPersistentContext(config.profile, {
      executablePath: config.chrome, headless: true, serviceWorkers: 'block',
      proxy: {server: 'http://127.0.0.1:9'},
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--dns-prefetch-disable', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
    });
    context.on('page', page => {
      page.on('console', message => { sensitiveConsole ||= sensitive(message.text()); });
      page.on('pageerror', error => { sensitiveConsole ||= sensitive(error.message); });
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== config.origin) { unexpected++; await route.abort('blockedbyclient'); return; }
      if (!(url.pathname === issue || url.pathname === activation || url.pathname === '/api/token/'
            || [activation + 'assets/activate.js', activation + 'assets/issue.js', activation + 'assets/activation.css'].includes(url.pathname))) {
        await route.fulfill({status: 404, body: ''}); return;
      }
      const headers = await request.allHeaders();
      privacyViolation ||= Boolean(url.search || url.hash || sensitive(request.url()) || sensitive(headers.referer));
      const response = await rpc({url: request.url(), method: request.method(), headers,
        body: (request.postDataBuffer() || Buffer.alloc(0)).toString('base64')});
      await route.fulfill({status: response.status, headers: response.headers,
                          body: Buffer.from(response.body, 'base64')});
    });
    await context.routeWebSocket('**/*', socket => { unexpected++; socket.close(); });
    await context.addInitScript(() => {
      window.__activationCspViolations = [];
      document.addEventListener('securitypolicyviolation', event => {
        window.__activationCspViolations.push(event.violatedDirective);
      });
    });
    await context.addCookies(config.cookies);
    const admin = await context.newPage();
    admin.setDefaultTimeout(8000);
    stage = 'administrator_issues_link';
    await admin.goto(config.origin + issue);
    await admin.locator('#target').selectOption(config.target);
    await admin.locator('[name=confirmed]').check();
    await admin.locator('button[value=issue]').click();
    const link = await admin.locator('#activation-link').inputValue();
    token = link.split('#')[1];
    verify(Boolean(token && /^[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/.test(token)), 'one_use_link');
    await context.clearCookies();
    const owner = await context.newPage();
    owner.setDefaultTimeout(8000);
    stage = 'owner_opens_fragment';
    await owner.goto(link);
    await owner.locator('#activation-form').waitFor({state: 'visible'});
    verify(owner.url() === config.origin + activation, 'fragment_stripped');
    verify(await owner.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'storage_empty');
    verify((await owner.evaluate(() => window.__activationCspViolations)).length === 0, 'csp_allows_fixed_assets');
    const replay = await context.newPage();
    replay.setDefaultTimeout(8000);
    await replay.goto(link);
    await replay.locator('#activation-form').waitFor({state: 'visible'});
    async function submit(page) {
      await page.locator('#password').fill(config.password);
      await page.locator('#confirmation').fill(config.password);
      const [response] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === activation),
        page.locator('button[type=submit]').click(),
      ]);
      return response;
    }
    stage = 'owner_self_sets';
    const activated = await submit(owner);
    verify(activated.status() === 200 && (await activated.json()).status === 'activated', 'activation_success');
    await owner.locator('#done').waitFor({state: 'visible'});
    verify(await owner.locator('#password').inputValue() === '', 'password_input_cleared');
    verify(await owner.locator('#confirmation').inputValue() === '', 'confirmation_input_cleared');
    stage = 'replay_is_rejected';
    verify((await submit(replay)).status() === 400, 'replay_rejected');
    stage = 'ordinary_password_login';
    const login = await owner.evaluate(async ({username, password}) => {
      const response = await fetch('/api/token/', {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username, password})});
      const data = await response.json();
      return {status: response.status, hasAccess: typeof data.access === 'string', hasRefresh: typeof data.refresh === 'string'};
    }, {username: config.username, password: config.password});
    verify(login.status === 200 && login.hasAccess && login.hasRefresh, 'ordinary_login_success');
    verify(await owner.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'tokens_not_stored_by_fixture');
    verify(!privacyViolation && !sensitiveConsole && unexpected === 0, 'private_requests_and_no_external_calls');
    result = {type: 'result', ok: true, checks, browser_version: context.browser().version(),
      external_requests: unexpected, sensitive_console: sensitiveConsole, request_privacy_violation: privacyViolation};
  } catch (error) {
    result = {type: 'result', ok: false, stage, checks, error: error.name, failed_check: error.check || null};
  } finally {
    clearTimeout(timeout);
    await close();
  }
  send(result); input.close(); process.exit(result.ok ? 0 : 1);
})().catch(error => {
  send({type: 'result', ok: false, stage: 'bootstrap', error: error.name});
  input.close(); process.exit(1);
});
