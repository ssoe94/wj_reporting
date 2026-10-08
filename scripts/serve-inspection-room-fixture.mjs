// Loopback-only disposable preview. No proxy, external fetch, .env, or real credentials.
// Build first: cd frontend && npm run build:inspection-fixture
// Run from repo: node scripts/serve-inspection-room-fixture.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fixtures from '../frontend/tests/inspection-room-fixtures.cjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.env.WJ_INSPECTION_FIXTURE_DIST || resolve(repo, 'output/inspection-fixture-dist'));
const port = Number(process.env.WJ_INSPECTION_FIXTURE_PORT || '5193');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a local preview port from 1024–65535.');
const origin = `http://127.0.0.1:${port}`;
if (!existsSync(resolve(root, 'index.html'))) throw new Error('Fixture build missing. Run frontend npm run build:inspection-fixture first.');
const pair = fixtures.authPair();
let records = fixtures.records();
let weeklyRoster = fixtures.createWeeklyRosterStore();
const attempts = new Map();
const events = [];
if (process.env.WJ_INSPECTION_FIXTURE_STATE) {
  const file = resolve(process.env.WJ_INSPECTION_FIXTURE_STATE);
  if (!file.startsWith(resolve(repo, 'output') + sep)) throw new Error('Fixture snapshots must be inside output.');
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(snapshot.records) || snapshot.records.some(row => !fixtures.records().some(base => base.id === row.id && base.part_no === row.part_no && base.task_ref === row.task_ref))) throw new Error('Only synthetic preview records may be restored.');
  records = snapshot.records; events.push(...(snapshot.events || []));
}
const mime = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const headers = { 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'" };
const reply = (res, status, body) => { res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body, (_key, value) => value === '검사실 미리보기' ? 'QC-ROOM' : value)); };
const readBody = async req => {
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 128 * 1024) throw new Error('Synthetic body too large'); }
  return JSON.parse(body || '{}');
};
const bootstrap = language => `<script>if(location.origin===${JSON.stringify(origin)}){const pair=${JSON.stringify(pair)};const id='synthetic-inspection-room';localStorage.setItem('wj-auth-session-control-v2',JSON.stringify({id,...pair}));for(const [name,value]of Object.entries({access_token:pair.access,wj_next_access_token:pair.access,refresh_token:pair.refresh,wj_next_refresh_token:pair.refresh,lang:${JSON.stringify(language)},wj_next_language:${JSON.stringify(language)}}))localStorage.setItem(name,value)}</script>`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', origin);
    const scenario = req.headers.cookie?.match(/(?:^|; )wj_inspection_fixture_scenario=(empty|error|normal)(?:;|$)/)?.[1] || 'normal';
    // Bind loopback and also reject foreign Host headers.
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return reply(res, 403, { code: 'synthetic_loopback_only' });
    if (req.method === 'GET' && url.pathname === '/__fixture/status') return reply(res, 200, { fixture_only: true, records: records.length, served_from: root, api_proxy: false, events });
    if (req.method === 'POST' && url.pathname === '/__fixture/reset') { records = fixtures.records(); weeklyRoster = fixtures.createWeeklyRosterStore(); attempts.clear(); events.length = 0; return reply(res, 200, { fixture_only: true, reset: true }); }
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && url.pathname === '/api/injection/user/me/') return reply(res, 200, fixtures.currentUser());
      if (req.method === 'GET' && url.pathname === '/api/production/status/') return reply(res, 200, { injection: [], machining: [] });
      if (req.method === 'POST' && url.pathname === '/api/auth/activity/') {
        const body = await readBody(req);
        return body.refresh === pair.refresh ? reply(res, 200, fixtures.activityResponse(pair)) : reply(res, 401, { code: 'session_activity_rejected' });
      }
      if (req.method === 'GET' && url.pathname === `${fixtures.API}capabilities/`) return reply(res, 200, fixtures.capabilities());
      if (req.method === 'GET' && url.pathname === `${fixtures.API}role-settings/`) return reply(res, 200, fixtures.roleSettings());
      if (req.method === 'GET' && url.pathname === `${fixtures.API}weekly-role-settings/`) return reply(res, 200, weeklyRoster.read(url.searchParams.get('week_start')));
      if (req.method === 'POST' && url.pathname === `${fixtures.API}weekly-role-settings/`) {
        const result = weeklyRoster.save(await readBody(req), req.headers['idempotency-key']);
        return reply(res, result.status, result.body);
      }
      if (req.method === 'GET' && url.pathname === `${fixtures.API}kanban/`) return scenario === 'error'
        ? reply(res, 503, { detail: 'SYNTHETIC fixture unavailable' })
        : reply(res, 200, fixtures.kanban(scenario === 'empty' ? [] : records, url.searchParams.get('date') || new Date().toISOString().slice(0, 10)));
      if (req.method === 'GET' && url.pathname === fixtures.API) return reply(res, 200, { count: scenario === 'empty' ? 0 : records.length, next: null, previous: null, results: scenario === 'empty' ? [] : records, work_groups: [], work_groups_truncated: false });
      const match = url.pathname.match(/^\/api\/quality\/inspection-requests\/(\d+)\/(area-save\/|area-complete\/|draft\/|submit\/)?$/);
      const record = match && records.find(row => row.id === Number(match[1]));
      if (record && !match[2] && req.method === 'GET') return reply(res, 200, record);
      if (record && match[2] && req.method === 'POST') {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !key) return reply(res, 400, { code: 'synthetic_key_required' });
        const body = await readBody(req), action = match[2].slice(0, -1), identity = `${record.id}:${action}:${key}`;
        const serialized = JSON.stringify(body), previous = attempts.get(identity);
        if (previous && previous.payload !== serialized) return reply(res, 409, { code: 'synthetic_key_conflict' });
        const result = previous?.result || fixtures.mutation(record, action, body);
        attempts.set(identity, { payload: serialized, result });
        if (!previous) events.push({ action, request_id: record.id, area: body.area, inspector_id: body.inspector_id, recorded_by_id: 101,
          item_ids: body.measurements?.map(row => row.item_id) || [], status: result.status });
        return reply(res, result.status, result.body);
      }
      // All MES/auth/logout/unknown operations stop here. Nothing is proxied.
      return reply(res, 404, { code: 'synthetic_endpoint_not_supported', fixture_only: true });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { code: 'synthetic_method_not_supported' });
    const decoded = decodeURIComponent(url.pathname);
    const file = resolve(root, '.' + decoded);
    if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { ...headers, 'content-type': mime[extname(file)] || 'application/octet-stream' });
      return res.end(req.method === 'HEAD' ? '' : readFileSync(file));
    }
    if (['/', '/quality/inspection-requests', '/login'].includes(url.pathname)) {
      const language = url.searchParams.get('fixture_lang') === 'zh' ? 'zh' : 'ko';
      const requestedScenario = ['empty', 'error'].includes(url.searchParams.get('fixture_scenario')) ? url.searchParams.get('fixture_scenario') : 'normal';
      const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace('<head>', '<head>' + bootstrap(language));
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'Set-Cookie': `wj_inspection_fixture_scenario=${requestedScenario}; Path=/; SameSite=Strict; HttpOnly` }); return res.end(req.method === 'HEAD' ? '' : html);
    }
    return reply(res, 404, { code: 'synthetic_asset_not_found' });
  } catch { return reply(res, 400, { code: 'synthetic_request_invalid' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Synthetic inspection preview: ${origin}/quality/inspection-requests?fixture_lang=ko`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
