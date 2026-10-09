import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import axios from 'axios';
import ts from 'typescript';

// Execute the real API and HTTP interceptors with an isolated Axios adapter.
// No browser storage, credentials or external requests are used.
function compile(path: string) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    .replaceAll('import.meta.env.PROD', 'true')
    .replaceAll('import.meta.env.VITE_API_BASE_URL', 'undefined')
    .replaceAll('import.meta.env.VITE_USE_REMOTE_PRODUCTION_API', '"true"');
  return ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
}
const httpCode = compile('../src/shared/api/http.ts');
const apiCode = compile('../src/domains/production/api.ts');

function harness() {
  let session = { id: 'SYNTHETIC-SESSION', access: 'SYNTHETIC-EXPIRED-ACCESS' };
  let refreshes = 0;
  let changeSession = false;
  const requests: { url: string; authorization: unknown }[] = [];
  class AuthRefreshError extends Error {}
  const modules: Record<string, unknown> = {
    axios,
    '@/domains/auth/auth-refresh': {
      AuthRefreshError,
      refreshAccessToken: async () => { refreshes++; throw new AuthRefreshError('expired session'); },
    },
    '@/domains/auth/auth-storage': { getAuthSessionSnapshot: () => session },
    '@/domains/auth/dev-session': { isDevSessionToken: () => false, isDevSessionActive: () => false },
    '@/domains/ai/deep-analysis': {},
    '@/domains/ai/model-labels': {},
  };
  const load = (code: string) => {
    const exports: Record<string, any> = {};
    new Function('require', 'exports', code)((name: string) => {
      assert.ok(name in modules, `Unexpected import ${name}`);
      return modules[name];
    }, exports);
    return exports;
  };
  const { http } = load(httpCode);
  http.defaults.adapter = async (config: any) => {
    const authorization = config.headers.get('Authorization');
    requests.push({ url: config.url, authorization });
    if (authorization) {
      throw new axios.AxiosError('expired token', 'ERR_BAD_REQUEST', config, undefined,
        { status: 401, statusText: 'Unauthorized', data: { code: 'token_not_valid' }, headers: {}, config });
    }
    if (changeSession) session = { id: 'SYNTHETIC-OTHER-SESSION', access: 'SYNTHETIC-OTHER-ACCESS' };
    return { status: 200, statusText: 'OK', headers: {}, config,
      data: { injection: [{ machine_number: 1, total_actual: 42, parts: null }], machining: [] } };
  };
  modules['@/shared/api/http'] = { http };
  const api = load(apiCode);
  return { api, requests, refreshes: () => refreshes, changeSession: () => { changeSession = true; } };
}

test('current and previous wallboard status load despite an expired stored login', async () => {
  const h = harness();
  for (const day of ['2026-10-08', '2026-10-07']) {
    const result = await h.api.getProductionStatus(day, { skipAuth: true });
    assert.equal(result.injection[0].total_actual, 42);
    assert.deepEqual(result.injection[0].parts, []);
    assert.deepEqual(result.machining, []);
  }
  assert.deepEqual(h.requests.map(row => row.url), [
    '/production/status/?date=2026-10-08', '/production/status/?date=2026-10-07',
  ]);
  assert.ok(h.requests.every(row => row.authorization === undefined));
  assert.equal(h.refreshes(), 0);
});

test('public wallboard refresh survives another tab changing the account', async () => {
  const h = harness();
  h.changeSession();
  const result = await h.api.getProductionStatus('2026-10-08', { skipAuth: true });
  assert.equal(result.injection[0].total_actual, 42);
  assert.equal(h.refreshes(), 0);
});

test('existing authenticated callers still receive session errors and refresh handling', async () => {
  const h = harness();
  await assert.rejects(h.api.getProductionStatus('2026-10-08'), /expired session/);
  assert.equal(h.requests[0].authorization, 'Bearer SYNTHETIC-EXPIRED-ACCESS');
  assert.equal(h.refreshes(), 1);
});
