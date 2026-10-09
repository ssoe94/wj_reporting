'use strict';

// Isolated synthetic diagnostics only. No existing browser/profile, production
// session, real authorization code, credential, HTTP server or provider is used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = '65e327eb0003ae241d3d93e9b0961d34f61d75fd';
const RELAY_ORIGIN = 'https://wj-reporting.onrender.com';
const BACKEND_ORIGIN = 'https://wj-reporting-backend.onrender.com';
const PROVIDER_ORIGIN = 'https://v3-ali.blacklake.cn';
const RELAY_PATH = '/integrations/blacklake/relay.html';
const CALLBACK_PATH = '/integrations/blacklake/callback/';
const LAUNCHER_PATH = '/__synthetic_relay_launcher__';
const RELAY = RELAY_ORIGIN + RELAY_PATH;
const CALLBACK = BACKEND_ORIGIN + CALLBACK_PATH;
const CODE = 'SYNTHETIC-DIAGNOSTIC-CODE';
const PLUS_CODE = 'SYNTHETIC+DIAGNOSTIC+CODE';
const FAILURE_STATES = new Set([
  'relay_script_unavailable', 'relay_url_invalid', 'relay_history_unavailable',
  'relay_framed', 'relay_scheme_invalid', 'relay_location_invalid',
  'relay_fragment_unexpected', 'relay_parameter_unexpected', 'relay_code_missing',
  'relay_parameter_duplicate',
  'relay_code_duplicate', 'relay_code_empty', 'relay_code_invalid',
  'relay_navigation_failed', 'relay_navigation_incomplete', 'relay_redirecting',
]);
const options = {
  revision: null,
  chrome: null,
  playwrightRoot: null,
};
let checks = 0;
let failures = 0;
let cases = 0;
let context;
let profile;
let launchAttempted = false;
let browserCloseConfirmed = false;
let watchdog;
let active;
let attemptedUnrouted = 0;
let providerApiAttempts = 0;
let interceptedRequests = 0;
let observedRequests = 0;
let consoleEvents = 0;
let consoleSensitive = false;
let pageErrors = 0;
let dialogEvents = 0;
let reportWritten = false;
const emit = object => process.stdout.write(JSON.stringify(object) + '\n');
const check = (condition, name) => {
  checks += 1;
  if (!condition) {
    const error = new Error('Synthetic fixture assertion failed.');
    error.fixtureCheck = name;
    throw error;
  }
};
const sensitive = value => {
  const s = String(value);
  return [CODE, PLUS_CODE, encodeURIComponent(CODE), encodeURIComponent(PLUS_CODE)]
    .some(marker => s.includes(marker));
};
const caseRun = async (name, fn) => {
  cases += 1;
  try {
    const evidence = await fn();
    emit({ case: name, ok: true, ...evidence });
  } catch (error) {
    failures += 1;
    emit({ case: name, ok: false, check: error.fixtureCheck || 'fixture_exception',
      error_type: ['Error', 'TimeoutError', 'TypeError'].includes(error.name) ? error.name : 'FixtureError' });
  }
};
const readSource = relative => options.revision === 'working'
  ? fs.readFileSync(path.join(ROOT, relative), 'utf8')
  : execFileSync('/usr/bin/git', ['-C', ROOT, '--no-optional-locks', 'show', BASE + ':' + relative],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 1024 * 1024 });

async function closeOwned() {
  if (context) {
    const owned = context;
    context = null;
    let timer;
    try {
      await Promise.race([
        owned.close(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CloseTimeout')), 5000); }),
      ]);
      browserCloseConfirmed = true;
    } finally { clearTimeout(timer); }
  }
  if (profile && (!launchAttempted || browserCloseConfirmed)) {
    fs.rmSync(profile, { recursive: true, force: true });
    profile = null;
  }
}

async function main() {
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    check(Boolean(value), 'argument_value_required');
    if (key === '--revision') options.revision = value;
    else if (key === '--chrome') options.chrome = value;
    else if (key === '--playwright-root') options.playwrightRoot = value;
    else check(false, 'unknown_argument');
  }
  check(['65e3', BASE, 'working'].includes(options.revision), 'fixed_revision_required');
  const baseline = options.revision !== 'working';
  check(typeof options.chrome === 'string' && typeof options.playwrightRoot === 'string',
    'explicit_chrome_and_playwright_paths_required');
  check(path.isAbsolute(options.chrome) && fs.statSync(options.chrome).isFile(), 'existing_chrome_required');
  check(path.isAbsolute(options.playwrightRoot) &&
    fs.statSync(path.join(options.playwrightRoot, 'index.js')).isFile(), 'existing_playwright_required');
  const html = readSource('frontend/public/integrations/blacklake/relay.html');
  const manifest = JSON.parse(readSource('deploy/mes-oauth-relay-headers.json'));
  const matches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  check(matches.length === 1, 'one_inline_script');
  const script = matches[0][1];
  const digest = crypto.createHash('sha256').update(script).digest('base64');
  const hashToken = "'sha256-" + digest + "'";
  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  check(meta && meta[1].includes(hashToken), 'html_csp_hash_matches_script');
  check(manifest.headers['Content-Security-Policy'].includes(hashToken), 'http_csp_hash_matches_script');
  check(manifest.path === RELAY_PATH, 'fixed_relay_manifest_path');
  check(manifest.headers['Referrer-Policy'] === 'no-referrer', 'relay_referrer_policy_preserved');
  check(manifest.headers['X-Frame-Options'] === 'DENY' &&
    manifest.headers['Content-Security-Policy'].includes("frame-ancestors 'none'"), 'frame_protection_preserved');
  emit({ check: 'source_and_manifest', ok: true, baseline, hashes_match: true });

  const { chromium } = require(path.join(options.playwrightRoot, 'index.js'));
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wj-relay-diagnostics-'));
  fs.chmodSync(profile, 0o700);
  launchAttempted = true;
  context = await chromium.launchPersistentContext(profile, {
    executablePath: options.chrome, headless: true, serviceWorkers: 'block',
    proxy: { server: 'http://127.0.0.1:9' },
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--dns-prefetch-disable', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
  });
  context.setDefaultTimeout(5000);
  context.setDefaultNavigationTimeout(5000);
  context.on('request', () => { observedRequests += 1; });
  context.on('page', page => {
    page.on('console', message => {
      consoleEvents += 1;
      consoleSensitive ||= sensitive(message.text());
    });
    page.on('pageerror', () => { pageErrors += 1; });
    page.on('dialog', async dialog => { dialogEvents += 1; await dialog.dismiss(); });
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    interceptedRequests += 1;
    if (url.pathname.includes('/openapi/') || url.pathname.includes('_get_user_')) providerApiAttempts += 1;
    const headers = await request.allHeaders();
    if (request.method() !== 'GET') {
      attemptedUnrouted += 1;
      await route.abort('blockedbyclient');
      return;
    }
    if (url.origin === PROVIDER_ORIGIN && url.pathname === LAUNCHER_PATH) {
      const target = RELAY + '?code=' + encodeURIComponent(CODE);
      const body = active.kind === 'frame'
        ? '<!doctype html><iframe src="' + target + '"></iframe>'
        : '<!doctype html><a id="launch" target="_blank" rel="' + active.rel + '" href="' + target + '">Synthetic launch</a>';
      await route.fulfill({ status: 200, contentType: 'text/html',
        headers: { 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': 'no-store' }, body });
      return;
    }
    if (url.origin === RELAY_ORIGIN && url.pathname === RELAY_PATH) {
      active.relayRequests += 1;
      active.relayReferrer = headers.referer || '';
      const responseHeaders = { ...manifest.headers };
      if (active.kind === 'csp_mismatch') {
        responseHeaders['Content-Security-Policy'] = responseHeaders['Content-Security-Policy']
          .replace(/'sha256-[^']+'/g, "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='");
      }
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
        headers: responseHeaders, body: html });
      return;
    }
    if (url.origin === BACKEND_ORIGIN && url.pathname === CALLBACK_PATH) {
      active.callbacks += 1;
      active.callbackReferrerAbsent = !headers.referer;
      active.callbackHttpUrlClean = !url.search && !url.hash && !sensitive(request.url());
      await route.fulfill({ status: 200, contentType: 'text/html',
        headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' },
        body: '<!doctype html><title>Synthetic callback</title><p>Mock callback only.</p>' });
      return;
    }
    attemptedUnrouted += 1;
    await route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => { attemptedUnrouted += 1; socket.close(); });
  await context.addInitScript(() => {
    window.__fixtureCspViolation = false;
    document.addEventListener('securitypolicyviolation', () => { window.__fixtureCspViolation = true; });
  });

  const begin = kind => {
    active = { kind, rel: '', relayRequests: 0, callbacks: 0, relayReferrer: '',
      callbackReferrerAbsent: false, callbackHttpUrlClean: false };
    return active;
  };
  const stateOf = async page => {
    const element = page.locator('#relay-status');
    if (!await element.count()) return 'baseline_generic_stall';
    const value = await element.getAttribute('data-relay-status');
    check(FAILURE_STATES.has(value), 'fixed_status_enum_only');
    return value;
  };
  const noStorage = async page => {
    check(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0),
      'no_browser_storage');
    check((await context.cookies()).length === 0, 'no_cookies_created');
  };
  const invalid = [
    ['missing', '', 'relay_code_missing'],
    ['empty_query', '?', 'relay_code_missing'],
    ['empty_code', '?code=', 'relay_code_empty'],
    ['duplicate', '?code=' + CODE + '&code=' + CODE, 'relay_code_duplicate'],
    ['extra_parameter', '?code=' + CODE + '&state=SYNTHETIC', 'relay_parameter_unexpected'],
    ['duplicate_random', '?code=' + CODE + '&random=SYNTHETIC-A&random=SYNTHETIC-B', 'relay_parameter_duplicate'],
    ['duplicate_lang', '?code=' + CODE + '&lang=zh&lang=ko', 'relay_parameter_duplicate'],
    ['metadata_unknown_state', '?code=' + CODE + '&random=SYNTHETIC&lang=zh&state=SYNTHETIC',
      'relay_parameter_unexpected'],
    ['random_without_code', '?random=SYNTHETIC', 'relay_code_missing'],
    ['lang_without_code', '?lang=zh', 'relay_code_missing'],
    ['initial_fragment', '?code=' + CODE + '#SYNTHETIC', 'relay_fragment_unexpected'],
    ['fragment_only', '#code=' + CODE, 'relay_fragment_unexpected'],
    ['raw_plus', '?code=' + PLUS_CODE, 'relay_code_invalid'],
    ['unicode', '?code=%EA%B0%80', 'relay_code_invalid'],
    ['space', '?code=SYNTHETIC%20INVALID', 'relay_code_invalid'],
    ['oversized', '?code=' + 'X'.repeat(4097), 'relay_code_invalid'],
    ['malformed_encoding', '?code=%E0%A4%A', 'relay_code_invalid'],
  ];
  for (const [name, suffix, expected] of invalid) {
    await caseRun(name, async () => {
      const evidence = begin('invalid');
      const page = await context.newPage();
      try {
        await page.goto(RELAY + suffix, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(80);
        const state = await stateOf(page);
        check(state === (baseline ? 'baseline_generic_stall' : expected), 'expected_rejection_state');
        check(page.url() === RELAY, 'query_and_fragment_scrubbed');
        check(evidence.callbacks === 0, 'rejection_has_no_callback');
        check(!await page.evaluate(() => window.__fixtureCspViolation), 'valid_csp_allows_guard');
        await noStorage(page);
        let initialNavigationMetadataRetained;
        if (name === 'extra_parameter') {
          // Only fixed booleans/counts leave the browser. Never return entry.name,
          // query values, the synthetic code, or even arbitrary parameter names.
          const metadata = await page.evaluate(() => {
            const entry = performance.getEntriesByType('navigation')[0];
            if (!entry) return { present: false };
            const initial = new URL(entry.name);
            const keys = Array.from(initial.searchParams.keys());
            return { present: true, codeKeyCount: keys.filter(key => key === 'code').length,
              unexpectedParameter: keys.some(key => key !== 'code'), fragmentPresent: Boolean(initial.hash) };
          });
          initialNavigationMetadataRetained = metadata.present && metadata.codeKeyCount === 1 &&
            metadata.unexpectedParameter === true && metadata.fragmentPresent === false;
          check(initialNavigationMetadataRetained, 'initial_navigation_key_metadata_survives_history_scrub');
        }
        return { state, url_scrubbed: true, callback_requests: 0,
          ...(initialNavigationMetadataRetained === undefined ? {} :
            { initial_navigation_metadata_retained: initialNavigationMetadataRetained }) };
      } finally { await page.close(); }
    });
  }
  for (const [name, code] of [['normal_code', CODE], ['encoded_plus', PLUS_CODE]]) {
    await caseRun(name, async () => {
      const evidence = begin('valid');
      const page = await context.newPage();
      try {
        await page.goto(RELAY + '?code=' + encodeURIComponent(code), { waitUntil: 'commit' });
        await page.waitForURL(url => url.origin === BACKEND_ORIGIN && url.pathname === CALLBACK_PATH,
          { waitUntil: 'domcontentloaded' });
        const target = new URL(page.url());
        const fragment = new URLSearchParams(target.hash.slice(1));
        check(!target.search && fragment.getAll('code').length === 1 &&
          [...fragment.keys()].length === 1 && fragment.get('code') === code, 'synthetic_code_preserved');
        check(evidence.callbacks === 1 && evidence.callbackHttpUrlClean, 'single_clean_mock_callback');
        check(evidence.callbackReferrerAbsent, 'callback_has_no_relay_referrer');
        await noStorage(page);
        return { callback_requests: 1, synthetic_code_preserved: true, provider_requests: 0 };
      } finally { await page.close(); }
    });
  }
  const metadataCases = [
    ['observed_metadata_contract', '&random=SYNTHETIC-RANDOM&lang=zh'],
    ['metadata_random_only', '&random=SYNTHETIC-RANDOM'],
    ['metadata_lang_only', '&lang=zh'],
    ['metadata_empty_values', '&random=&lang='],
    ['metadata_redirect_url', '&random=' + encodeURIComponent('https://synthetic-attacker.invalid/redirect') + '&lang=zh'],
    ['metadata_script_value', '&random=SYNTHETIC-RANDOM&lang=' +
      encodeURIComponent('<script>throw new Error("SYNTHETIC-METADATA-MUST-NOT-EXECUTE")</script>')],
    ['metadata_url_and_script', '&random=' + encodeURIComponent('javascript:alert("SYNTHETIC-METADATA")') +
      '&lang=' + encodeURIComponent('<img src="https://synthetic-attacker.invalid/pixel">')],
  ];
  for (const [name, suffix] of metadataCases) {
    await caseRun(name, async () => {
      const evidence = begin('metadata');
      const page = await context.newPage();
      const errorBaseline = pageErrors;
      const dialogBaseline = dialogEvents;
      try {
        await page.goto(RELAY + '?code=' + CODE + suffix, { waitUntil: 'commit' });
        if (baseline) {
          await page.waitForLoadState('domcontentloaded');
          await page.waitForTimeout(80);
          check(await stateOf(page) === 'baseline_generic_stall', 'baseline_metadata_contract_stalls');
          check(page.url() === RELAY && evidence.callbacks === 0, 'baseline_metadata_scrubbed_without_callback');
          await noStorage(page);
          return { state: 'baseline_generic_stall', url_scrubbed: true,
            callback_requests: 0, metadata_forwarded: false };
        }
        await page.waitForURL(url => url.origin === BACKEND_ORIGIN && url.pathname === CALLBACK_PATH,
          { waitUntil: 'domcontentloaded' });
        const target = new URL(page.url());
        const fragment = new URLSearchParams(target.hash.slice(1));
        check(!target.search && fragment.getAll('code').length === 1 &&
          [...fragment.keys()].length === 1 && fragment.get('code') === CODE,
        'metadata_discarded_only_original_code_forwarded');
        check(evidence.callbacks === 1 && evidence.callbackHttpUrlClean &&
          evidence.callbackReferrerAbsent, 'metadata_single_clean_mock_callback');
        check(pageErrors === errorBaseline && dialogEvents === dialogBaseline,
          'metadata_does_not_execute_script_or_dialog');
        check(attemptedUnrouted === 0, 'metadata_does_not_trigger_redirect_or_asset_requests');
        await noStorage(page);
        return { callback_requests: 1, synthetic_code_preserved: true,
          metadata_forwarded: false, metadata_execution: false, provider_requests: 0 };
      } finally { await page.close(); }
    });
  }
  for (const [name, rel, absent] of [
    ['popup_opener_requested', 'opener', false],
    ['popup_noopener', 'noopener', false],
    ['popup_noreferrer', 'noopener noreferrer', true],
  ]) {
    await caseRun(name, async () => {
      const evidence = begin('popup'); evidence.rel = rel;
      const launcher = await context.newPage();
      let popup;
      try {
        await launcher.goto(PROVIDER_ORIGIN + LAUNCHER_PATH, { waitUntil: 'domcontentloaded' });
        [popup] = await Promise.all([context.waitForEvent('page'), launcher.locator('#launch').click()]);
        await popup.waitForURL(url => url.origin === BACKEND_ORIGIN && url.pathname === CALLBACK_PATH,
          { waitUntil: 'domcontentloaded' });
        check(new URLSearchParams(new URL(popup.url()).hash.slice(1)).get('code') === CODE,
          'popup_code_preserved');
        check(evidence.relayReferrer === (absent ? '' : PROVIDER_ORIGIN + '/'),
          'popup_expected_provider_referrer');
        check(evidence.callbacks === 1 && evidence.callbackHttpUrlClean &&
          evidence.callbackReferrerAbsent, 'popup_single_private_mock_callback');
        const openerAbsent = await popup.evaluate(() => window.opener === null);
        check(openerAbsent, 'noopener_or_coop_severs_opener');
        await noStorage(popup);
        return { callback_requests: 1, new_tab: true, opener_absent: openerAbsent,
          relay_referrer: absent ? 'absent' : 'provider_origin_only' };
      } finally {
        if (popup) await popup.close();
        await launcher.close();
      }
    });
  }
  await caseRun('iframe_headers_block', async () => {
    const evidence = begin('frame');
    const page = await context.newPage();
    try {
      await page.goto(PROVIDER_ORIGIN + LAUNCHER_PATH, { waitUntil: 'load' });
      await page.waitForTimeout(100);
      check(evidence.relayRequests === 1 && evidence.callbacks === 0, 'frame_cannot_reach_callback');
      return { iframe_relay_requested: true, callback_requests: 0 };
    } finally { await page.close(); }
  });
  await caseRun('intentional_csp_mismatch', async () => {
    const evidence = begin('csp_mismatch');
    const page = await context.newPage();
    try {
      await page.goto(RELAY + '?code=' + CODE, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(80);
      const state = await stateOf(page);
      check(state === (baseline ? 'baseline_generic_stall' : 'relay_script_unavailable'),
        'csp_failure_static_fallback');
      check(Boolean(new URL(page.url()).search) && evidence.callbacks === 0, 'blocked_script_cannot_scrub_or_redirect');
      check(await page.evaluate(() => window.__fixtureCspViolation), 'csp_violation_observed');
      return { state, script_blocked: true, url_scrubbed: false, callback_requests: 0 };
    } finally { await page.close(); }
  });
  await caseRun('browser_history_throw', async () => {
    const evidence = begin('history_throw');
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        history.replaceState = () => { throw new Error('SyntheticHistoryFailure'); };
      });
      await page.goto(RELAY + '?code=' + CODE, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(80);
      const state = await stateOf(page);
      check(state === (baseline ? 'baseline_generic_stall' : 'relay_history_unavailable'),
        'history_failure_visible');
      check(evidence.callbacks === 0 && Boolean(new URL(page.url()).search), 'history_failure_has_no_navigation');
      return { state, callback_requests: 0 };
    } finally { await page.close(); }
  });

  const vmCases = [
    ['vm_url_throw', 'relay_url_invalid', { urlThrow: true }],
    ['vm_history_throw', 'relay_history_unavailable', { historyThrow: true }],
    ['vm_framed', 'relay_framed', { framed: true }],
    ['vm_scheme', 'relay_scheme_invalid', { href: RELAY.replace('https:', 'http:') + '?code=' + CODE }],
    ['vm_location', 'relay_location_invalid', { href: RELAY_ORIGIN + '/invalid-relay?code=' + CODE }],
    ['vm_navigation_throw', 'relay_navigation_failed', { navigationThrow: true }],
    ['vm_navigation_incomplete', 'relay_navigation_incomplete', { runTimer: true }],
  ];
  for (const [name, expected, settings] of vmCases) {
    await caseRun(name, async () => {
      const status = { dataset: { relayStatus: 'relay_script_unavailable' }, textContent: '' };
      let href = settings.href || RELAY + '?code=' + CODE;
      let navigationCalls = 0;
      let historyCalls = 0;
      let networkCalls = 0;
      let thrown = false;
      const timers = [];
      const location = {
        get href() { return href; },
        get pathname() { return new URL(href).pathname; },
        replace(value) {
          navigationCalls += 1;
          check(new URL(value).origin === BACKEND_ORIGIN &&
            new URL(value).pathname === CALLBACK_PATH, 'vm_navigation_fixed_destination');
          if (settings.navigationThrow) throw new Error('SyntheticNavigationFailure');
        },
      };
      const blockNetwork = () => { networkCalls += 1; throw new Error('SyntheticNetworkBlocked'); };
      const sandbox = {
        URL: settings.urlThrow ? class { constructor() { throw new Error('SyntheticUrlFailure'); } } : URL,
        URLSearchParams, encodeURIComponent, location,
        document: { getElementById: id => id === 'relay-status' ? status : null },
        history: { replaceState(_state, _title, value) {
          historyCalls += 1;
          if (settings.historyThrow) throw new Error('SyntheticHistoryFailure');
          href = new URL(value, href).href;
        } },
        setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
        clearTimeout: () => {},
        fetch: blockNetwork, XMLHttpRequest: blockNetwork, WebSocket: blockNetwork,
        navigator: { sendBeacon: blockNetwork }, console: { log() {}, error() {}, warn() {} },
      };
      sandbox.window = sandbox;
      sandbox.self = sandbox;
      sandbox.top = settings.framed ? {} : sandbox;
      try { vm.runInNewContext(script, sandbox, { timeout: 1000, displayErrors: false }); }
      catch (_) { thrown = true; }
      if (settings.runTimer && !baseline) {
        check(status.dataset.relayStatus === 'relay_redirecting', 'navigation_starts_redirecting');
        check(timers.length === 1 && timers[0].delay === 4000, 'incomplete_timeout_is_four_seconds');
        timers[0].fn();
      }
      if (baseline) {
        check(status.dataset.relayStatus === 'relay_script_unavailable', 'baseline_has_no_diagnostic_update');
      } else {
        check(!thrown, 'diagnostic_handles_exception');
        check(status.dataset.relayStatus === expected, 'expected_vm_diagnostic');
        check(!sensitive(status.textContent), 'diagnostic_does_not_echo_code');
      }
      check(networkCalls === 0, 'vm_has_no_network');
      check(navigationCalls === (settings.navigationThrow || settings.runTimer ? 1 : 0),
        'vm_navigation_at_most_once');
      check(historyCalls === (settings.urlThrow ? 0 : 1), 'vm_history_attempt_count');
      return { state: baseline ? 'baseline_generic_stall' : status.dataset.relayStatus,
        exception_unhandled: thrown, navigation_attempts: navigationCalls, provider_requests: 0 };
    });
  }
  check(providerApiAttempts === 0, 'no_provider_api_attempts');
  check(attemptedUnrouted === 0, 'no_unexpected_outgoing_attempts');
  check(observedRequests === interceptedRequests, 'all_observed_http_requests_intercepted');
  emit({ summary: true, ok: failures === 0, baseline, cases, checks, failed_cases: failures,
    real_provider_requests: 0, provider_api_attempts: providerApiAttempts,
    all_http_requests_intercepted: observedRequests === interceptedRequests,
    observed_requests: observedRequests, intercepted_requests: interceptedRequests,
    blocked_unexpected_requests: attemptedUnrouted, console_events: consoleEvents,
    console_sensitive: consoleSensitive, page_error_events: pageErrors, dialog_events: dialogEvents,
    temporary_profile_only: true });
  reportWritten = true;
  return failures === 0 ? 0 : 1;
}

watchdog = setTimeout(async () => {
  emit({ summary: true, ok: false, check: 'owned_fixture_deadline', cases, checks });
  try { await closeOwned(); } catch (_) {}
  process.exit(1);
}, 60000);
main().then(async code => {
  clearTimeout(watchdog);
  try { await closeOwned(); }
  catch (_) { emit({ cleanup: true, ok: false, check: 'owned_browser_cleanup' }); code = 1; }
  process.exitCode = code;
}).catch(async error => {
  clearTimeout(watchdog);
  if (!reportWritten) emit({ summary: true, ok: false, check: error.fixtureCheck || 'fixture_exception',
    error_type: ['Error', 'TimeoutError', 'TypeError'].includes(error.name) ? error.name : 'FixtureError' });
  try { await closeOwned(); } catch (_) { emit({ cleanup: true, ok: false }); }
  process.exitCode = 1;
});
