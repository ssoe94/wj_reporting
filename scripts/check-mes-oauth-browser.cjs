'use strict';

// Browser-only side of the isolated fixture. Every page request is intercepted;
// both production hostnames below are virtual, intercepted origins. No real
// service, provider, TLS server or existing browser profile is contacted.
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
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
  send({ type: 'request', id, ...request });
});

(async () => {
  const config = await ready;
  const { chromium } = require(config.playwright);
  let context;
  let checks = 0;
  let stage = 'launch';
  let blockedExternal = 0;
  let backendRequests = 0;
  let relayRequests = 0;
  let errorConsoleCount = 0;
  let errorConsoleSensitive = false;
  let requestPrivacyViolation = false;
  let invalidCases = 0;
  let frameBlocked = false;
  let result;
  const containsSensitive = value => value.includes(config.code) || value.includes(config.token);
  const hasCookie = (headers, name) => (headers.cookie || '').split(';')
    .some(item => item.trim().startsWith(name + '='));
  const verify = (condition, label) => {
    if (!condition) {
      const error = new Error('Synthetic browser assertion failed.');
      error.fixtureCheck = label;
      throw error;
    }
    checks += 1;
  };
  const close = async () => {
    if (!context) return true;
    let timer;
    try {
      return await Promise.race([
        context.close().then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  process.on('SIGTERM', async () => { await close(); process.exit(143); });
  const timeout = setTimeout(async () => {
    result = { type: 'result', ok: false, stage, error: 'FixtureTimeout', checks };
    await close();
    send(result);
    process.exit(1);
  }, 45000);
  try {
    context = await chromium.launchPersistentContext(config.profile, {
      executablePath: config.chrome, headless: true, serviceWorkers: 'block',
      proxy: { server: 'http://127.0.0.1:9' },
      args: ['--disable-background-networking', '--disable-component-update',
             '--disable-sync', '--dns-prefetch-disable',
             '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
    });
    context.on('page', page => {
      page.on('console', message => {
        if (message.type() === 'error') {
          errorConsoleCount += 1;
          errorConsoleSensitive ||= containsSensitive(message.text());
        }
      });
      page.on('pageerror', error => {
        errorConsoleCount += 1;
        errorConsoleSensitive ||= containsSensitive(error.message);
      });
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (![config.origin, config.relayOrigin].includes(url.origin)) {
        blockedExternal += 1;
        await route.abort('blockedbyclient');
        return;
      }
      const headers = await request.allHeaders();
      if (['fetch', 'xhr', 'eventsource'].includes(request.resourceType())) requestPrivacyViolation = true;
      if (containsSensitive(headers.referer || '')) requestPrivacyViolation = true;
      if (url.origin === config.relayOrigin) {
        if ([config.sessionCookie, config.csrfCookie, config.nonceCookie]
          .some(name => hasCookie(headers, name))) requestPrivacyViolation = true;
        if (url.pathname === '/__synthetic-relay-cookie__') {
          // A harmless, host-only test cookie proves isolation in the other
          // direction too. The actual relay response headers remain unchanged.
          await route.fulfill({ status: 200, contentType: 'text/html',
            headers: { 'set-cookie': config.relayCookie + '=1; Path=/; Secure; HttpOnly; SameSite=Lax' },
            body: '<!doctype html><title>Synthetic cookie fixture</title>' });
          return;
        }
        if (url.pathname === '/__synthetic-relay-frame__') {
          await route.fulfill({ status: 200, contentType: 'text/html',
            body: '<!doctype html><iframe src="' + config.relayOrigin + config.relayPath +
              '?code=' + encodeURIComponent(config.code) + '"></iframe>' });
          return;
        }
        if (url.pathname === config.relayPath) {
          relayRequests += 1;
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
            headers: config.relayHeaders, body: config.relayHtml });
          return;
        }
        await route.fulfill({ status: 404, body: '' });
        return;
      }
      if (url.search || url.hash || containsSensitive(request.url()) ||
          hasCookie(headers, config.relayCookie)) requestPrivacyViolation = true;
      if (![config.start, config.callback].includes(url.pathname)) {
        await route.fulfill({ status: 404, body: '' });
        return;
      }
      backendRequests += 1;
      const response = await rpc({
        url: request.url(), method: request.method(), headers,
        body: (request.postDataBuffer() || Buffer.alloc(0)).toString('base64'),
      });
      await route.fulfill({ status: response.status, headers: response.headers,
                            body: Buffer.from(response.body, 'base64') });
    });
    await context.routeWebSocket('**/*', socket => { blockedExternal += 1; socket.close(); });
    await context.addInitScript(() => {
      window.__syntheticCspViolations = [];
      document.addEventListener('securitypolicyviolation', event => {
        window.__syntheticCspViolations.push(event.violatedDirective);
      });
    });
    // This is the sole cookie injection: the initial backend login fixture.
    await context.addCookies(config.cookies);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const relayUrl = config.relayOrigin + config.relayPath;
    const callbackUrl = config.origin + config.callback;
    const visitRelay = async target => {
      const [response] = await Promise.all([
        target.waitForResponse(r => r.request().method() === 'GET' && r.url() === callbackUrl),
        target.goto(relayUrl + '?code=' + encodeURIComponent(config.code), { waitUntil: 'commit' }),
      ]);
      await target.waitForURL(callbackUrl, { waitUntil: 'domcontentloaded' });
      return response;
    };
    stage = 'relay_cookie_fixture';
    await page.goto(config.relayOrigin + '/__synthetic-relay-cookie__', { waitUntil: 'domcontentloaded' });
    verify((await context.cookies(config.relayOrigin)).some(cookie => cookie.name === config.relayCookie),
           'relay_fixture_cookie_accepted');
    stage = 'invalid_relay_inputs';
    const invalid = [
      ['missing', ''], ['empty', '?code='], ['malformed', '?code=%E0%A4%A'],
      ['duplicate', '?code=' + config.code + '&code=' + config.code],
      ['extra_parameter', '?code=' + config.code + '&state=SYNTHETIC'],
      ['fragment', '?code=' + config.code + '#SYNTHETIC'],
      ['space', '?code=SYNTHETIC%20INVALID'], ['oversized', '?code=' + 'X'.repeat(4097)],
    ];
    for (const [label, suffix] of invalid) {
      stage = 'invalid_relay_' + label;
      const before = backendRequests;
      const response = await page.goto(relayUrl + suffix, { waitUntil: 'domcontentloaded' });
      verify(response.status() === 200, 'invalid_relay_served');
      verify(page.url() === relayUrl, 'invalid_relay_history_cleaned');
      verify(backendRequests === before, 'invalid_relay_no_backend_request');
      verify((await page.evaluate(() => window.__syntheticCspViolations)).length === 0,
             'invalid_relay_hash_script_allowed');
      verify(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0),
             'invalid_relay_no_browser_storage');
      invalidCases += 1;
    }
    stage = 'relay_frame_block';
    const beforeFrame = backendRequests;
    const framePage = await context.newPage();
    await framePage.goto(config.relayOrigin + '/__synthetic-relay-frame__', { waitUntil: 'load' });
    frameBlocked = backendRequests === beforeFrame && !framePage.frames()
      .some(frame => frame.url().startsWith(callbackUrl));
    verify(frameBlocked, 'relay_frame_does_not_reach_backend');
    await framePage.close();
    stage = 'start_get';
    let response = await page.goto(config.origin + config.start, { waitUntil: 'domcontentloaded' });
    verify(response.status() === 200, 'start_get_status');
    verify((await page.locator('input[name="csrfmiddlewaretoken"]').inputValue()).length > 0, 'csrf_from_html');
    stage = 'start_real_form_post';
    [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === config.start),
      page.locator('button[type="submit"]').click(),
    ]);
    verify(response.status() === 200, 'start_post_status');
    const nonce = (await context.cookies(config.origin)).find(cookie => cookie.name === config.nonceCookie);
    verify(Boolean(nonce && nonce.secure && nonce.httpOnly && nonce.path === '/' && nonce.sameSite === 'Lax'), 'browser_accepted_host_nonce');
    stage = 'relay_to_callback_and_csp_scripts';
    response = await visitRelay(page);
    verify(response.status() === 200, 'callback_get_status');
    verify(page.url() === callbackUrl, 'fragment_removed_by_real_script');
    verify(await page.locator('input[name="code"]').inputValue() === config.code, 'hidden_code_from_real_script');
    verify(await page.locator('button[type="submit"]').isEnabled(), 'valid_fragment_enables_form');
    verify((await page.evaluate(() => window.__syntheticCspViolations)).length === 0, 'no_csp_violation');
    verify(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'no_browser_token_storage');
    // Keep a second real form open before consumption; its later submission
    // must use the browser's now-deleted nonce, not a Django Client cookie jar.
    const replay = await context.newPage();
    replay.setDefaultTimeout(10000);
    response = await visitRelay(replay);
    verify(response.status() === 200, 'second_real_form_prepared');
    stage = 'callback_real_form_post';
    [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === config.callback),
      page.locator('button[type="submit"]').click(),
    ]);
    verify(response.status() === 200, 'callback_post_status');
    const payload = await response.json();
    verify(payload.identity_verified === true && payload.expiry_verified === false && payload.live_ready === false,
           'identity_only_result');
    verify(!(await context.cookies(config.origin)).some(cookie => cookie.name === config.nonceCookie), 'nonce_deleted_by_response');
    stage = 'replay_real_form_post';
    [response] = await Promise.all([
      replay.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === config.callback),
      replay.locator('button[type="submit"]').click(),
    ]);
    verify(response.status() === 403, 'replay_denied');
    verify((await response.text()).includes('oauth_callback_unavailable'), 'replay_denied_by_oauth_gate');
    verify(blockedExternal === 0, 'no_unexpected_external_page_requests');
    verify(!requestPrivacyViolation, 'no_cross_host_cookie_or_sensitive_url_referer');
    verify(!(await context.cookies(config.relayOrigin)).some(cookie =>
      [config.sessionCookie, config.csrfCookie, config.nonceCookie].includes(cookie.name)),
      'backend_cookies_absent_from_relay');
    verify(!(await context.cookies(config.origin)).some(cookie => cookie.name === config.relayCookie),
      'relay_cookie_absent_from_backend');
    stage = 'relay_storage_after_success';
    await page.goto(relayUrl, { waitUntil: 'domcontentloaded' });
    verify(page.url() === relayUrl, 'post_flow_relay_url_clean');
    verify(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0),
           'successful_relay_left_no_browser_storage');
    verify(!errorConsoleSensitive, 'console_has_no_synthetic_code_or_token');
    result = { type: 'result', ok: true, checks, blocked_external_requests: blockedExternal,
               browser_version: context.browser().version(), invalid_relay_cases: invalidCases,
               frame_blocked: frameBlocked, relay_requests: relayRequests,
               error_console_count: errorConsoleCount, error_console_sensitive: errorConsoleSensitive,
               request_privacy_violation: requestPrivacyViolation };
  } catch (error) {
    result = { type: 'result', ok: false, checks, stage, error: error.name,
               failed_check: error.fixtureCheck || null,
               invalid_relay_cases: invalidCases, frame_blocked: frameBlocked,
               error_console_count: errorConsoleCount, error_console_sensitive: errorConsoleSensitive,
               request_privacy_violation: requestPrivacyViolation,
               blocked_external_requests: blockedExternal };
  } finally {
    clearTimeout(timeout);
    if (!await close()) {
      result = { type: 'result', ok: false, checks, stage: 'cleanup', error: 'CloseTimeout' };
    }
  }
  send(result);
  input.close();
  // Playwright's process-exit handler synchronously kills only browsers it
  // launched, including its own process groups if graceful close timed out.
  process.exit(result.ok ? 0 : 1);
})().catch(error => {
  send({ type: 'result', ok: false, stage: 'bootstrap', error: error.name });
  input.close();
  process.exit(1);
});
