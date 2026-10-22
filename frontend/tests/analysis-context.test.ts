import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { getContextEvidence } from '../src/domains/analysis/model.ts';
import * as presentation from '../src/domains/analysis/presentation.ts';
import type { OverviewBoardModel } from '../src/domains/boards/overview/types.ts';
function load(path: string, modules: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('import.meta.env.DEV', 'false');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, any> = {};
  new Function('require', 'exports', code)((name: string) => {
    assert.ok(name in modules, `Unexpected import ${name}`); return modules[name];
  }, exports);
  return exports;
}
const date = '2026-10-22';
let payload: any;
const api = load('../src/domains/boards/overview/api.ts', {
  '@/shared/api/http': { http: { get: async () => ({ data: payload }) } },
  './fallback': { createOverviewDemoModel: () => { throw new Error('Demo must never render'); } },
  '@/shared/utils/date': {},
});
const panels = load('../src/domains/analysis/ContextPanels.tsx', {
  'react/jsx-runtime': jsx,
  '@/components/common/PermissionLink': { default: ({ children }: any) => React.createElement('a', null, children) },
  './model': { getContextEvidence }, './presentation': presentation,
});
const closed = load('../src/domains/analysis/ClosedPeriodSummary.tsx', { 'react/jsx-runtime': jsx, './presentation': presentation });
const tx = (ko: string, _zh: string) => ko;
async function normalize(extra = {}) {
  payload = { schema_version: 'overview-board.v1', business_date: date, processes: {}, ...extra };
  return (await api.getOverviewBoard(date, 'ko', { allowDemo: false })).model as OverviewBoardModel;
}
function render(model: OverviewBoardModel, refreshFailed = false) {
  return renderToStaticMarkup(React.createElement(panels.ContextPanels, { model, refreshFailed, tx, lang: 'ko' }));
}
test('inventory snapshot and shipping dates survive independently of outbound freshness', async () => {
  const model = await normalize({ inventory: { snapshot_date: '2026-10-20', shipping: { snapshot_at: '2026-10-21T01:00:00Z' },
    finished_and_semifinished: { total_quantity: 1234, warehouses: [{ warehouse_name: 'SYNTHETIC', total_quantity: 1234 }] } } });
  assert.equal(model.inventory.snapshotDate, '2026-10-20');
  assert.equal(model.inventory.shippingSnapshotAt, '2026-10-21T01:00:00Z');
  assert.match(render(model), /2026-10-20 · 선택일과 다름/);
  assert.match(render(model), /1,234/);
});
test('failed/missing context cannot show legacy placeholders as measured stock, power or moulds', async () => {
  const model = await normalize({ freshness: { sources: { energy: { status: 'missing' }, moulds: { status: 'error' } } },
    energy: { usage_kwh: 987654 }, inventory: { finished_and_semifinished: { total_quantity: 987654 } }, moulds: { total: 987654 } });
  const html = render(model);
  assert.doesNotMatch(html, /987,654/);
  assert.match(html, /재고 스냅샷 없음/); assert.match(html, /시간별 전력 자료 없음/);
});
test('genuine zero stays zero, hourly null stays missing, and failed refresh labels retained values', async () => {
  const model = await normalize({ freshness: { sources: { energy: { status: 'ok', source_latest_at: date + 'T01:00:00Z' } } },
    energy: { usage_kwh: 0, hourly_trend: [{ timestamp: date + 'T00:00:00Z', label: '08:00', usage_kwh: 0 },
      { timestamp: date + 'T01:00:00Z', label: '09:00', usage_kwh: null }] } });
  const html = render(model, true);
  assert.match(html, /부분·지연·이전 자료/); assert.match(html, />0<small> kWh/);
  assert.match(html, /class="is-missing"/);
  assert.equal(getContextEvidence(model, 'energy', true).current, false);
  assert.equal(getContextEvidence(model, 'energy', true).available, true);
});
test('wrong-date secondary response is rejected before mixing with selected production', async () => {
  payload = { schema_version: 'overview-board.v1', business_date: '2026-10-21' };
  await assert.rejects(api.getOverviewBoard(date, 'ko', { allowDemo: false }), /business date/);
});
test('closed comparisons distinguish partial, no-plan and unavailable values; failure hides old comparisons', () => {
  const metric = { status: 'partial', actualQuantity: 20, plannedQuantity: 100, completionRate: 20 };
  const data = { previousDay: { businessDate: '2026-10-21', injection: metric, assembly: { status: 'no_plan' } },
    week: { startDate: '2026-10-19', endDate: '2026-10-21', closedDayCount: 3, unavailableDays: 1,
      injection: { status: 'unavailable' }, assembly: metric } };
  const html = renderToStaticMarkup(React.createElement(closed.ClosedPeriodSummary, { data, pending: false, failed: false, tx, lang: 'ko' }));
  assert.match(html, /부분 집계/); assert.match(html, /계획 없음/); assert.match(html, /자료 없음/);
  const failed = renderToStaticMarkup(React.createElement(closed.ClosedPeriodSummary, { data, pending: false, failed: true, tx, lang: 'ko' }));
  assert.doesNotMatch(failed, /20 \/ 100/); assert.match(failed, /조회 실패/);
});
