'use strict';

// One isolated browser run compares the actual builds before and after a local
// rebuild. All identities, API responses and saves are synthetic; no server runs.
// The runner captures BEFORE, then waits for output/<basename>.after-ready.
// node frontend/tests/inspection-weekly-compact-browser.cjs <basename> --authorized-browser
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fixtures = require('./inspection-room-fixtures.cjs');
const REPO = path.resolve(__dirname, '../..');
const DIST = path.join(REPO, 'output/inspection-fixture-dist');
const ORIGIN = 'http://127.0.0.1:5193';
const ROUTE = '/quality/inspection-requests';
const API = fixtures.API;
if (!process.argv.includes('--authorized-browser')) {
  process.stdout.write('Build the local inspection fixture and pass --authorized-browser for an isolated comparison.\n');
  process.exit(0);
}
const basename = process.argv.slice(2).find(value => value !== '--authorized-browser') || 'studio-weekly-compact';
assert.match(basename, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const OUTPUT = path.join(REPO, 'output', basename);
assert.ok(!fs.existsSync(OUTPUT + '.after-ready'), 'Use a fresh comparison basename');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const slots = ['DAY-dimension', 'DAY-appearance', 'NIGHT-dimension', 'NIGHT-appearance'];
const report = { ok: false, fixture_only: true, run_id: crypto.randomUUID(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(), captures: [], mutations: [], page_errors: [], blocked: [] };
const persist = () => fs.writeFileSync(OUTPUT + '.json', JSON.stringify(report, null, 2));

(async () => {
  const { chromium } = require(require.resolve('playwright', { paths: [REPO, path.join(REPO, 'frontend')] }));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wj-weekly-compare-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, serviceWorkers: 'block', proxy: { server: 'http://127.0.0.1:9' }, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--dns-prefetch-disable', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
    context.setDefaultTimeout(6000);
    await context.routeWebSocket('**/*', socket => { report.blocked.push('websocket'); socket.close(); });
    async function capture(phase, width, height, lang = 'ko') {
      const page = await context.newPage();
      await page.setViewportSize({ width, height });
      const roster = fixtures.createWeeklyRosterStore(), records = fixtures.records(), pair = fixtures.authPair();
      const index = fs.readFileSync(path.join(DIST, 'index.html'));
      page.on('pageerror', error => report.page_errors.push(error.message));
      page.on('dialog', dialog => dialog.dismiss());
      await page.addInitScript(({ origin, pair, lang }) => {
        if (location.origin !== origin) return;
        localStorage.clear(); sessionStorage.clear();
        localStorage.setItem('wj-auth-session-control-v2', JSON.stringify({ id: 'synthetic-weekly-compare', ...pair }));
        for (const [key, value] of Object.entries({ access_token: pair.access, wj_next_access_token: pair.access, refresh_token: pair.refresh, wj_next_refresh_token: pair.refresh, lang, wj_next_language: lang })) localStorage.setItem(key, value);
      }, { origin: ORIGIN, pair, lang });
      const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== ORIGIN) {
          if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
          if (url.hostname === 'fonts.gstatic.com') return route.abort('blockedbyclient');
          report.blocked.push(`${req.method()} ${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
        }
        if (url.pathname.startsWith('/api/')) {
          if (req.method() === 'GET' && url.pathname === '/api/injection/user/me/') return json(route, fixtures.currentUser());
          if (req.method() === 'POST' && url.pathname === '/api/auth/activity/') return json(route, fixtures.activityResponse(pair));
          if (req.method() === 'GET' && url.pathname === '/api/production/status/') return json(route, { injection: [], machining: [] });
          if (req.method() === 'GET' && url.pathname === `${API}capabilities/`) return json(route, fixtures.capabilities());
          if (req.method() === 'GET' && url.pathname === `${API}role-settings/`) return json(route, fixtures.roleSettings());
          if (req.method() === 'GET' && url.pathname === `${API}weekly-role-settings/`) return json(route, roster.read(url.searchParams.get('week_start')));
          if (req.method() === 'POST' && url.pathname === `${API}weekly-role-settings/`) {
            const result = roster.save(req.postDataJSON(), req.headers()['idempotency-key']);
            report.mutations.push({ phase, width, lang, fixture_only: true, action: 'weekly-role-settings', status: result.status });
            return json(route, result.body, result.status);
          }
          if (req.method() === 'GET' && url.pathname === `${API}kanban/`) return json(route, fixtures.kanban(records, url.searchParams.get('date')));
          if (req.method() === 'GET' && url.pathname === API) return json(route, { count: records.length, next: null, previous: null, results: records, work_groups: [], work_groups_truncated: false });
          report.blocked.push(`${req.method()} ${url.pathname}`); return route.abort('blockedbyclient');
        }
        if (req.method() === 'GET' && [ROUTE, '/login'].includes(url.pathname)) return route.fulfill({ contentType: 'text/html', body: index });
        const file = path.resolve(DIST, '.' + url.pathname);
        if (req.method() === 'GET' && file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const mime = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
          return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
        }
        report.blocked.push(`${req.method()} ${url.pathname}`); return route.abort('blockedbyclient');
      });
      await page.goto(ORIGIN + ROUTE, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: lang === 'ko' ? '담당자·교대 설정' : '负责人·班次设置', exact: true }).click();
      await page.locator('.inspection-weekly-settings[aria-busy="false"]').waitFor();
      // Test evidence overlay only; product layout/styles stay untouched.
      await page.evaluate(phase => {
        const mark = document.createElement('div'); mark.textContent = `SYNTHETIC · 합성 자료 · ${phase.toUpperCase()}`;
        mark.setAttribute('data-test-watermark', 'true');
        Object.assign(mark.style, { position: 'fixed', left: '8px', bottom: '5px', zIndex: '2147483647', pointerEvents: 'none', background: '#142b3d', color: '#fff', font: '12px sans-serif', padding: '3px 7px', borderRadius: '3px' });
        document.body.append(mark);
      }, phase);
      const measure = () => page.locator('.inspection-weekly-settings').evaluate(node => {
        const bounds = item => { const box = item.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height }; };
        return { viewport: { width: innerWidth, height: innerHeight }, scroll_y: scrollY, document_width: document.documentElement.scrollWidth,
          section: bounds(node), save: bounds(node.querySelector('[type="submit"]')), cards: [...node.querySelectorAll('.inspection-weekly-card')].map(bounds) };
      });
      assert.equal(await page.locator('.inspection-weekly-card').evaluateAll(nodes => nodes.map(node => node.dataset.weeklySlot).join(',')), slots.join(','));
      for (const [position, slot] of slots.entries()) assert.equal(await page.locator(`#inspection-weekly-${slot}`).inputValue(), String(501 + position));
      const screenshot = async suffix => {
        const file = `${OUTPUT}-${phase}-${width}x${height}-${lang}${suffix}.png`;
        const pixels = await page.screenshot({ fullPage: false, animations: 'disabled' }); fs.writeFileSync(file, pixels, { mode: 0o600 });
        const geometry = await measure();
        report.captures.push({ phase, width, height, lang, state: suffix || 'initial', path: file, sha256: sha(pixels), index_sha256: sha(index), ...geometry }); persist();
        process.stdout.write(`SCREENSHOT_READY ${file}\n`);
        return geometry;
      };
      const geometry = await screenshot('');
      assert.ok(geometry.document_width <= width + 1, 'No horizontal page overflow');
      if (phase === 'after' && width >= 1280) {
        assert.ok(geometry.section.top >= 0 && geometry.section.bottom <= height - 20, 'Entire weekly form and help fit the viewport');
        assert.ok(geometry.save.top >= 0 && geometry.save.bottom <= height - 20, 'Save is initially visible');
        assert.equal(new Set(geometry.cards.map(card => Math.round(card.top))).size, 1, 'Four desktop cards occupy one row');
        await page.locator('#inspection-weekly-DAY-dimension').selectOption('new');
        await page.locator('#inspection-weekly-DAY-dimension-name').fill('SYNTHETIC 新姓名');
        const edited = await screenshot('-new-name');
        assert.ok(edited.save.bottom <= height - 20, 'Save remains visible during name entry');
        await page.locator('.inspection-weekly-save button').click();
        await page.getByRole('status').filter({ hasText: lang === 'ko' ? '주간 담당자를 저장했습니다.' : '已保存本周人员。' }).waitFor();
        assert.equal(await page.locator('#inspection-weekly-DAY-dimension').inputValue(), '505');
        await screenshot('-saved');
      }
      await page.close();
    }
    for (const [width, height] of [[1366, 768], [1280, 720]]) await capture('before', width, height);
    process.stdout.write(`BEFORE_COMPLETE ${OUTPUT}.json\n`);
    const deadline = Date.now() + 20 * 60_000;
    while (!fs.existsSync(OUTPUT + '.after-ready')) { assert.ok(Date.now() < deadline, 'Timed out waiting for rebuilt fixture'); await new Promise(resolve => setTimeout(resolve, 500)); }
    for (const [width, height, lang] of [[1366, 768, 'ko'], [1280, 720, 'ko'], [1280, 720, 'zh'], [820, 900, 'ko'], [390, 844, 'ko']]) await capture('after', width, height, lang);
    assert.equal(report.page_errors.length, 0); assert.equal(report.blocked.length, 0);
    assert.ok(report.mutations.every(item => item.status === 200 && item.fixture_only === true));
    report.ok = true;
  } catch (error) { report.error = { name: error.name, message: error.message }; process.exitCode = 1; }
  finally { if (context) await context.close(); persist(); process.stdout.write(JSON.stringify({ ok: report.ok, captures: report.captures.length, mutations: report.mutations.length, report: OUTPUT + '.json', error: report.error }) + '\n'); }
})();
