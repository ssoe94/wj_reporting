import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Exercise the real request and normalization code without credentials or network.
const source = readFileSync(new URL('../src/domains/mes/api.ts', import.meta.url), 'utf8')
  .replace('import { http } from "@/shared/api/http";', '')
  .replaceAll('import.meta.env.VITE_MES_API_BASE_URL', 'undefined')
  .replaceAll('import.meta.env.DEV', 'false');
const code = stripTypeScriptTypes(source).replaceAll('export ', '');

const evidence = {
  timestamp: '2026-09-04T10:00:00+08:00',
  generated_at: '2026-09-04T10:00:00+08:00',
  source_latest_at: '2026-09-04T09:59:00+08:00',
  source_window: { start: '2026-09-03T10:00:00+08:00', end: '2026-09-04T10:02:00+08:00', timezone: 'Asia/Shanghai' },
  time_slots: [{ time: '2026-09-04T09:58:00+08:00', hour_offset: 0, label: '09:58', interval_minutes: 2 }],
  machines: [{ machine_number: 1, machine_name: '1호기', tonnage: '850T', display_name: '1호기 - 850T' }],
  cumulative_production_matrix: { '1': [114] },
  actual_production_matrix: { '1': [14] },
  capacity_observed_matrix: { '1': [true] },
  machine_sources: { '1': { status: 'ok', latest_capacity_at: '2026-09-04T09:59:00+08:00', sample_count: 1, observed_slot_count: 1, total_slot_count: 1 } },
  counter_policy: 'reset-aware-v1', warnings: [], mes_source: true,
};

function harness(failFirst = false, legacyBackend = false) {
  const requests: URL[] = [];
  const http = { get: async (path: string, options: { skipAuth: boolean }) => {
    assert.equal(options.skipAuth, true);
    const url = new URL(path, 'https://example.test');
    requests.push(url);
    if (failFirst && requests.length === 1) throw new Error('primary unavailable');
    const slim = url.searchParams.get('profile') === 'injection-board' && !legacyBackend;
    return { data: { ...evidence, ...(slim ? {} : {
      oil_temperature_matrix: { '1': [45] }, power_kwh_matrix: { '1': [100] }, power_usage_matrix: { '1': [2] },
    }) } };
  } };
  const api = new Function('http', `${code}\nreturn { getInjectionBoardMatrix, getInjectionProductionMatrix, getInjectionProductionMatrixForDate, getInjectionEnergyMatrix };`)(http);
  return { api, requests };
}

test('board current/history and fallback requests retain their time windows with the slim profile', async () => {
  for (const date of [undefined, '2026-09-03']) {
    for (const fallback of [false, true]) {
      const h = harness(fallback);
      const result = await h.api.getInjectionBoardMatrix(date);
      assert.equal(h.requests.length, fallback ? 2 : 1);
      for (const [index, request] of h.requests.entries()) {
        assert.equal(request.pathname, '/injection/production-matrix/');
        assert.equal(request.searchParams.get('profile'), 'injection-board');
        assert.equal(request.searchParams.get('date'), date ?? null);
        assert.equal(request.searchParams.get('interval'), date ? (index ? '30min' : '10min') : (index ? '10min' : '2min'));
        assert.equal(request.searchParams.get('columns'), date ? (index ? '49' : '145') : (index ? '144' : '721'));
      }
      for (const [key, value] of Object.entries(evidence)) assert.deepEqual(result[key], value);
      assert.deepEqual(result.oil_temperature_matrix, {});
      assert.equal(result.power_kwh_matrix, undefined);
      assert.equal(result.power_usage_matrix, undefined);
    }
  }
});

test('existing full-matrix and energy consumers continue receiving telemetry', async () => {
  const h = harness();
  for (const result of [
    await h.api.getInjectionProductionMatrix(3),
    await h.api.getInjectionProductionMatrixForDate('2026-09-03'),
    await h.api.getInjectionEnergyMatrix(),
  ]) {
    assert.deepEqual(result.oil_temperature_matrix, { '1': [45] });
    assert.deepEqual(result.power_usage_matrix, { '1': [2] });
  }
  assert.ok(h.requests.every(request => !request.searchParams.has('profile')));
  assert.equal(h.requests[0].searchParams.get('machine_number'), '3');
});

test('board remains compatible with a backend that still returns the full payload during rollout', async () => {
  const h = harness(false, true);
  const result = await h.api.getInjectionBoardMatrix();
  for (const [key, value] of Object.entries(evidence)) assert.deepEqual(result[key], value);
});

test('only injection board opts in, keeping its one-minute live polling and separate history query', () => {
  const board = readFileSync(new URL('../src/domains/production/pages/InjectionBoardPage.tsx', import.meta.url), 'utf8');
  assert.match(board, /const BOARD_REFRESH_INTERVAL_MS = 60_000/);
  assert.match(board, /queryFn: \(\) => getInjectionBoardMatrix\(\),\s*refetchInterval: BOARD_REFRESH_INTERVAL_MS/);
  assert.match(board, /queryFn: \(\) => getInjectionBoardMatrix\(previousBusinessDate\)/);
  assert.doesNotMatch(board, /getInjectionProductionMatrix/);
});
