'use strict';

// Minimal native form fixture, not the React application. A loopback HTTPS
// server and an allowlisted local CONNECT proxy carry real browser requests,
// including the genuine automatic POST -> 302 -> GET transition. Only a newly
// generated synthetic certificate is trusted via its SPKI exception. This does
// not validate production TLS or contact either named production service.
// All recorded output is fixed diagnostics, booleans or counts.
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
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
  let unexpectedPageRequests = 0;
  let backendRequests = 0;
  let consoleCount = 0;
  let consoleSensitive = false;
  let privacyViolation = false;
  let bridgePosts = 0;
  let automaticRedirectVerified = false;
  let tlsServer;
  let proxyServer;
  let allowedTunnels = 0;
  let rejectedTunnels = 0;
  let proxyHttpRequests = 0;
  let fixtureTransportErrors = 0;
  let tlsRequests = 0;
  let automaticStartGets = 0;
  let relayRequests = 0;
  let loopbackUpstreams = 0;
  let nonloopbackUpstreams = 0;
  const sockets = new Set();
  const requestFailures = [];
  let result;
  const sensitive = [config.code, config.token, config.jwt, config.malformedJwt, config.mismatchedJwt];
  const containsSensitive = value => sensitive.some(item => value.includes(item));
  const verify = (condition, label) => {
    if (!condition) {
      const error = new Error('Synthetic browser assertion failed.');
      error.fixtureCheck = label;
      throw error;
    }
    checks += 1;
  };
  const close = async () => {
    let browserClosed = true;
    let timer;
    if (context) {
      try {
        browserClosed = await Promise.race([context.close().then(() => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
      } catch { browserClosed = false; }
      finally { clearTimeout(timer); }
    }
    for (const socket of sockets) socket.destroy();
    await Promise.all([tlsServer, proxyServer].filter(Boolean).map(server => new Promise(resolve => {
      if (!server.listening) { resolve(); return; }
      server.close(resolve);
    })));
    return browserClosed;
  };
  const track = socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || address.address !== '127.0.0.1') {
        reject(new Error('Synthetic listener must use loopback.')); return;
      }
      resolve(address.port);
    });
  });
  process.on('SIGTERM', async () => { await close(); process.exit(143); });
  process.on('unhandledRejection', async error => {
    clearTimeout(timeout);
    await close();
    send({ type: 'result', ok: false, stage, asynchronous_fixture_error: true,
      navigation_frame_unavailable: Boolean(error && /Frame for this navigation request/.test(error.message)),
      checks });
    process.exit(1);
  });
  const timeout = setTimeout(async () => {
    await close();
    send({ type: 'result', ok: false, stage, error: 'FixtureTimeout', checks });
    process.exit(1);
  }, 45000);
  try {
    const certificate = fs.readFileSync(config.certificate);
    const key = fs.readFileSync(config.certificateKey);
    const publicKey = crypto.createPublicKey(certificate).export({ type: 'spki', format: 'der' });
    const pin = crypto.createHash('sha256').update(publicKey).digest('base64');
    const allowedHosts = new Set([new URL(config.origin).hostname, new URL(config.frontend).hostname]);
    const sendResponse = (response, status, headers, body) => {
      const normalized = Object.fromEntries(Object.entries(headers).map(([name, value]) =>
        [name, name.toLowerCase() === 'set-cookie' ? value.split('\n') : value]));
      response.writeHead(status, normalized);
      response.end(body);
    };
    const sendHtml = (response, status, body, headers = {}) => sendResponse(response, status,
      { 'Content-Type': 'text/html; charset=utf-8', ...headers }, Buffer.from(body));
    const handleHttp = async (request, response) => {
      tlsRequests += 1;
      const hostname = request.headers.host || '';
      if (!request.socket.encrypted || !allowedHosts.has(hostname) || request.socket.servername !== hostname
        || !request.url.startsWith('/') || request.url.startsWith('//')) {
        privacyViolation = true;
        sendHtml(response, 403, ''); return;
      }
      const url = new URL('https://' + hostname + request.url);
      const headers = request.headers;
      if (containsSensitive(headers.referer || '')) privacyViolation = true;
      if (url.origin === config.frontend) {
        if (url.pathname === '/__synthetic-mes-session__' && !url.search && request.method === 'GET') {
          sendHtml(response, 200, '<!doctype html><title>Synthetic native MES form</title>' +
            '<form method="post" action="' + config.origin + config.bridge +
            '" target="_blank" rel="noopener"><input type="hidden" name="ticket" autocomplete="off">' +
            '<button type="submit">Open synthetic MES session</button></form>',
            { 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin' });
          return;
        }
        if (url.pathname === config.relayPath && request.method === 'GET') {
          relayRequests += 1;
          sendHtml(response, 200, config.relayHtml, config.relayHeaders); return;
        }
        if (url.pathname !== '/favicon.ico') privacyViolation = true;
        sendHtml(response, 404, ''); return;
      }
      if (url.search || url.hash || containsSensitive(url.href)) privacyViolation = true;
      if (![config.launch, config.bridge, config.start, config.callback, '/admin/'].includes(url.pathname)) {
        if (url.pathname !== '/favicon.ico') privacyViolation = true;
        sendHtml(response, 404, ''); return;
      }
      if (url.pathname === config.bridge) {
        bridgePosts += 1;
        if (request.method !== 'POST' || headers.origin !== config.frontend || headers.authorization)
          privacyViolation = true;
      }
      if (url.pathname === config.start && request.method === 'GET') automaticStartGets += 1;
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 16384) throw new Error('Synthetic request exceeded its bound.');
        chunks.push(chunk);
      }
      backendRequests += 1;
      const reply = await rpc({ url: url.href, method: request.method, headers,
        body: Buffer.concat(chunks).toString('base64'), loopback_tls: true });
      if (url.pathname === config.bridge && reply.status === 302)
        verify(Object.entries(reply.headers).some(([name, value]) =>
          name.toLowerCase() === 'location' && value === config.start), 'bridge_redirect_location');
      sendResponse(response, reply.status, reply.headers, Buffer.from(reply.body, 'base64'));
    };
    tlsServer = https.createServer({ key, cert: certificate, minVersion: 'TLSv1.2' }, (request, response) => {
      handleHttp(request, response).catch(() => {
        fixtureTransportErrors += 1;
        if (!response.headersSent) sendHtml(response, 500, ''); else response.destroy();
      });
    });
    tlsServer.on('connection', track);
    tlsServer.on('tlsClientError', () => { fixtureTransportErrors += 1; });
    tlsServer.on('upgrade', (request, socket) => { blockedExternal += 1; socket.destroy(); });
    const tlsPort = await listen(tlsServer);
    proxyServer = http.createServer((request, response) => {
      proxyHttpRequests += 1;
      response.writeHead(403, { Connection: 'close' }); response.end();
    });
    proxyServer.on('connection', track);
    proxyServer.on('connect', (request, client, head) => {
      if (![...allowedHosts].some(host => request.url === host + ':443')) {
        rejectedTunnels += 1;
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      allowedTunnels += 1;
      // The request's hostname is never resolved or used as a connect target.
      const upstream = net.connect({ host: '127.0.0.1', port: tlsPort });
      track(upstream);
      upstream.once('connect', () => {
        if (upstream.remoteAddress !== '127.0.0.1') {
          nonloopbackUpstreams += 1;
          client.destroy(); upstream.destroy(); return;
        }
        loopbackUpstreams += 1;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => { fixtureTransportErrors += 1; client.destroy(); });
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    const proxyPort = await listen(proxyServer);
    context = await chromium.launchPersistentContext(config.profile, {
      executablePath: config.chrome, headless: true, serviceWorkers: 'block', ignoreHTTPSErrors: false,
      proxy: { server: 'http://127.0.0.1:' + proxyPort, bypass: '<-loopback>' },
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--dns-prefetch-disable', '--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--ignore-certificate-errors-spki-list=' + pin],
    });
    context.on('page', page => {
      page.on('console', message => {
        consoleCount += 1;
        consoleSensitive ||= containsSensitive(message.text());
      });
      page.on('pageerror', error => {
        consoleCount += 1;
        consoleSensitive ||= containsSensitive(error.message);
      });
    });
    context.on('request', request => {
      // Chrome can attempt its own background services in a fresh profile.
      // The proxy rejects all unlisted destinations and records the count.
      // Any unlisted request from a tested page is independently a failure.
      if (![config.origin, config.frontend].includes(new URL(request.url()).origin))
        unexpectedPageRequests += 1;
    });
    context.on('requestfailed', request => {
      const failure = (request.failure() || {}).errorText || '';
      requestFailures.push((failure.match(/net::ERR_[A-Z_]+/) || ['unknown_failure'])[0]);
    });
    await context.routeWebSocket('**/*', socket => { blockedExternal += 1; socket.close(); });
    await context.addInitScript(() => {
      window.__syntheticCspViolations = [];
      document.addEventListener('securitypolicyviolation', event => {
        window.__syntheticCspViolations.push(event.violatedDirective);
      });
    });
    verify((await context.cookies()).length === 0, 'no_seeded_browser_cookies');
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(config.frontend + '/__synthetic-mes-session__', { waitUntil: 'domcontentloaded' });
    const requestLaunch = async jwt => page.evaluate(async args => {
      const response = await fetch(args.url, {
        method: 'POST', credentials: 'omit', redirect: 'error',
        headers: { Authorization: 'Bearer ' + args.jwt, 'Content-Type': 'application/json' },
        body: '{}',
      });
      return { status: response.status, body: await response.json() };
    }, { url: config.origin + config.launch, jwt });
    stage = 'malformed_login_claim_denied';
    let launched = await requestLaunch(config.malformedJwt);
    verify(launched.status === 403 && !('ticket' in launched.body), 'malformed_sid_denied');
    stage = 'jwt_ticket_launch';
    launched = await requestLaunch(config.jwt);
    verify(launched.status === 200, 'jwt_launch_succeeded');
    verify(launched.body.submit_url === config.origin + config.bridge && launched.body.expires_in === 60,
      'launch_fixed_destination_and_ttl');
    verify(typeof launched.body.ticket === 'string' && /^[A-Za-z0-9_-]{43}$/.test(launched.body.ticket),
      'single_use_ticket_shape');
    const ticket = launched.body.ticket;
    sensitive.push(ticket);
    stage = 'mismatched_account_login_denied';
    const mismatched = await requestLaunch(config.mismatchedJwt);
    verify(mismatched.status === 403 && !('ticket' in mismatched.body), 'sid_cannot_cross_account');
    await page.locator('input[name="ticket"]').evaluate((input, value) => { input.value = value; }, ticket);
    const form = page.locator('form');
    verify(await form.getAttribute('method') === 'post', 'native_post_method');
    verify(await form.getAttribute('target') === '_blank', 'native_new_window_target');
    verify(await form.getAttribute('rel') === 'noopener', 'noopener_without_noreferrer');
    verify(page.url() === config.frontend + '/__synthetic-mes-session__', 'frontend_url_has_no_ticket');
    stage = 'native_ticket_post';
    const nextPage = context.waitForEvent('page');
    const automaticStartResponse = context.waitForEvent('response', {
      predicate: response => response.url() === config.origin + config.start && response.request().method() === 'GET',
    });
    const bridgeResponse = context.waitForEvent('response', {
      predicate: response => response.url() === config.origin + config.bridge && response.request().method() === 'POST',
    });
    await form.locator('button').click();
    const popup = await nextPage;
    popup.setDefaultTimeout(10000);
    const accepted = await bridgeResponse;
    verify(accepted.status() === 302, 'ticket_post_redirects_to_start');
    await popup.waitForURL(config.origin + config.start, { waitUntil: 'domcontentloaded' });
    const startResponse = await automaticStartResponse;
    verify(startResponse.status() === 200, 'automatic_redirect_get_succeeded');
    const previous = startResponse.request().redirectedFrom();
    verify(Boolean(previous && previous.method() === 'POST' && previous.url() === config.origin + config.bridge),
      'chrome_request_chain_is_native_post_redirect_get');
    verify(automaticStartGets === 1, 'exactly_one_automatic_start_get');
    automaticRedirectVerified = true;
    const session = (await context.cookies(config.origin)).find(cookie => cookie.name === config.sessionCookie);
    verify(Boolean(session && session.secure && session.httpOnly && session.sameSite === 'Lax'
      && session.path === '/' && session.domain === new URL(config.origin).hostname), 'browser_accepted_host_only_session');
    verify(await popup.evaluate(() => window.opener === null), 'new_window_has_no_opener');
    verify((await popup.locator('input[name="csrfmiddlewaretoken"]').inputValue()).length > 0,
      'bridge_start_has_csrf_form');
    verify(!(await context.cookies(config.frontend)).some(cookie =>
      [config.sessionCookie, config.csrfCookie, config.nonceCookie].includes(cookie.name)),
      'backend_cookies_absent_from_frontend');
    stage = 'ticket_replay_denied';
    const replayPage = context.waitForEvent('page');
    const replayResponse = context.waitForEvent('response', {
      predicate: response => response.url() === config.origin + config.bridge && response.request().method() === 'POST',
    });
    await form.locator('button').click();
    const replay = await replayPage;
    verify((await replayResponse).status() === 403, 'same_ticket_replay_denied');
    await replay.close();
    await page.locator('input[name="ticket"]').evaluate(input => { input.value = ''; });
    stage = 'bridge_admin_forbidden';
    const admin = await context.newPage();
    const denied = await admin.goto(config.origin + '/admin/', { waitUntil: 'domcontentloaded' });
    verify(denied.status() === 403, 'mes_bridge_session_cannot_enter_admin');
    await admin.close();
    stage = 'native_start_csrf_post';
    let [response] = await Promise.all([
      popup.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === config.start),
      popup.locator('button[type="submit"]').click(),
    ]);
    verify(response.status() === 200, 'native_start_csrf_accepted');
    const nonce = (await context.cookies(config.origin)).find(cookie => cookie.name === config.nonceCookie);
    verify(Boolean(nonce && nonce.secure && nonce.httpOnly && nonce.sameSite === 'Lax'), 'host_nonce_accepted');
    stage = 'virtual_relay_callback';
    const callbackUrl = config.origin + config.callback;
    [response] = await Promise.all([
      popup.waitForResponse(r => r.request().method() === 'GET' && r.url() === callbackUrl),
      popup.goto(config.frontend + config.relayPath + '?code=' + encodeURIComponent(config.code), { waitUntil: 'commit' }),
    ]);
    await popup.waitForURL(callbackUrl, { waitUntil: 'domcontentloaded' });
    verify(response.status() === 200, 'relay_callback_get_accepted');
    verify(popup.url() === callbackUrl, 'callback_fragment_cleaned');
    verify(await popup.locator('input[name="code"]').inputValue() === config.code, 'fragment_code_in_form_only');
    verify((await popup.evaluate(() => window.__syntheticCspViolations)).length === 0, 'callback_script_allowed_by_csp');
    stage = 'native_callback_csrf_post';
    [response] = await Promise.all([
      popup.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === config.callback),
      popup.locator('button[type="submit"]').click(),
    ]);
    verify(response.status() === 200, 'native_callback_csrf_accepted');
    const payload = await response.json();
    verify(payload.identity_verified === true && payload.expiry_verified === false
      && payload.live_ready === false && !payload.credential_stored, 'identity_only_result');
    verify(!(await context.cookies(config.origin)).some(cookie => cookie.name === config.nonceCookie), 'nonce_deleted');
    verify(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'frontend_storage_empty');
    verify(await popup.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'backend_storage_empty');
    verify(bridgePosts === 2, 'exactly_initial_and_replay_bridge_posts');
    verify(requestFailures.length === 0, 'no_browser_transport_failures');
    verify(fixtureTransportErrors === 0 && nonloopbackUpstreams === 0
      && loopbackUpstreams === allowedTunnels, 'all_proxy_upstreams_are_owned_loopback');
    verify(allowedTunnels > 0 && tlsRequests > backendRequests && relayRequests === 1,
      'two_origins_used_loopback_https');
    verify(blockedExternal === 0 && unexpectedPageRequests === 0, 'no_unexpected_external_page_requests');
    verify(!privacyViolation, 'no_ticket_code_jwt_in_backend_url_or_referer');
    verify(!consoleSensitive, 'no_sensitive_console_output');
    result = { type: 'result', ok: true, checks, backend_requests: backendRequests,
      bridge_posts: bridgePosts, blocked_external_requests: blockedExternal,
      automatic_redirect_verified: automaticRedirectVerified, driver_navigation_after_302: false,
      loopback_tls_requests: tlsRequests, allowed_proxy_tunnels: allowedTunnels,
      rejected_proxy_tunnels: rejectedTunnels, plain_http_proxy_requests: proxyHttpRequests,
      fixture_transport_errors: fixtureTransportErrors, automatic_start_gets: automaticStartGets,
      loopback_upstreams: loopbackUpstreams, nonloopback_upstreams: nonloopbackUpstreams,
      unexpected_page_requests: unexpectedPageRequests,
      console_events: consoleCount, console_sensitive: consoleSensitive, privacy_violation: privacyViolation };
  } catch (error) {
    result = { type: 'result', ok: false, checks, stage,
      failed_check: error.fixtureCheck || null, browser_exception: true,
      browser_error_kind: ['TimeoutError', 'TargetClosedError', 'Error'].includes(error.name) ? error.name : 'Other',
      request_failure_categories: requestFailures,
      page_url_categories: context ? context.pages().map(page => {
        const value = page.url();
        if (value.startsWith('chrome-error:')) return 'chrome_error';
        if (value === 'about:blank') return 'blank';
        if (value === config.origin + config.start) return 'start';
        if (value === config.origin + config.bridge) return 'bridge';
        if (value === config.frontend + '/__synthetic-mes-session__') return 'frontend_fixture';
        return 'other';
      }) : [],
      browser_error_flags: {
        navigation_frame_unavailable: /Frame for this navigation request/.test(error.message),
        target_closed: /Target .*closed|Target closed/.test(error.message),
        proxy_connection_failed: /ERR_PROXY_CONNECTION_FAILED/.test(error.message),
        blocked_by_client: /ERR_BLOCKED_BY_CLIENT/.test(error.message),
        invalid_header: /header/i.test(error.message),
        redirect_failed: /redirect/i.test(error.message),
        request_interception: /interception|Fetch\./.test(error.message),
      },
      backend_requests: backendRequests, bridge_posts: bridgePosts,
      automatic_redirect_verified: automaticRedirectVerified, driver_navigation_after_302: false,
      loopback_tls_requests: tlsRequests, allowed_proxy_tunnels: allowedTunnels,
      rejected_proxy_tunnels: rejectedTunnels, plain_http_proxy_requests: proxyHttpRequests,
      fixture_transport_errors: fixtureTransportErrors, automatic_start_gets: automaticStartGets,
      loopback_upstreams: loopbackUpstreams, nonloopback_upstreams: nonloopbackUpstreams,
      unexpected_page_requests: unexpectedPageRequests,
      blocked_external_requests: blockedExternal, console_events: consoleCount,
      console_sensitive: consoleSensitive, privacy_violation: privacyViolation };
  } finally {
    clearTimeout(timeout);
    if (!await close()) result = { type: 'result', ok: false, checks, stage: 'cleanup', close_timeout: true };
  }
  send(result);
  input.close();
  process.exit(result.ok ? 0 : 1);
})().catch(() => {
  send({ type: 'result', ok: false, stage: 'bootstrap', browser_exception: true });
  input.close();
  process.exit(1);
});
