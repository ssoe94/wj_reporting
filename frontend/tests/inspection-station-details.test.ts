import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as station from '../src/pages/quality/inspection-requests/stationPickerModel.ts';
import * as kanban from '../src/pages/quality/inspection-requests/kanban.ts';
import * as mesSignals from '../src/pages/quality/inspection-requests/mesInspectionSignal.ts';
import * as copy from '../src/pages/quality/inspection-requests/copy.ts';
import { inspectionKanbanCopy } from '../src/pages/quality/inspection-requests/kanbanCopy.ts';
import fixtures from './inspection-room-fixtures.cjs';
function nodes(node: any): any[] { if (Array.isArray(node)) return node.flatMap(nodes); return node?.props ? [node, ...nodes(node.props.children)] : []; }
function content(node: any): string { if (Array.isArray(node)) return node.map(content).join(''); return node?.props ? content(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function harness(lang: 'ko' | 'zh', selectedMachine: number, missing = false) {
  const snapshot = fixtures.kanban(fixtures.records(), '2026-10-07');
  if (missing) { const m = snapshot.machines.find((m: any) => m.machine_number === selectedMachine); m.plans = []; m.plan_status = 'unknown'; }
  let tree: any, cursor = 0; const selected: number[] = [], hooks: any[] = [];
  const runtime = { jsx: (type: any, props: any) => typeof type === 'function' ? type(props) : ({ type, props }), jsxs: (type: any, props: any) => typeof type === 'function' ? type(props) : ({ type, props }) };
  const dependencies: Record<string, any> = { 'react/jsx-runtime': runtime, react: { useState: (initial: any) => { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial; return [hooks[index], (next: any) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }]; }, useEffect: () => {} }, 'lucide-react': { ChevronUp: 'icon', ChevronDown: 'icon', RefreshCw: 'icon' }, './stationPickerModel': station, './kanban': kanban, './mesInspectionSignal': mesSignals, './copy': copy, './kanbanCopy': { inspectionKanbanCopy }, './MesReadObservationCard': { default: (props: any) => ({ type: 'observation', props }) } };
  for (const name of ['InspectionStationDetails', 'InspectionStationPicker']) {
    const module: any = {};
    const compiled = ts.transpileModule(readFileSync(new URL(`../src/pages/quality/inspection-requests/${name}.tsx`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    new Function('require', 'exports', compiled)((name: string) => { assert.ok(dependencies[name], `Known module: ${name}`); return dependencies[name]; }, module);
    dependencies[`./${name}`] = module;
  }
  const render = () => { cursor = 0; tree = dependencies['./InspectionStationPicker'].default({ snapshot, date: '2026-10-07', lang, loading: false, error: '', selectedMachine, selectedId: null, locked: false, onMachine() {}, onSelect(id: number) { selected.push(id); }, onDate() {}, onRefresh() {} }); };
  render();
  return { render, nodes: () => nodes(tree), text: () => content(tree), selected };
}
test('equipment disclosure expands only the chosen machine inside the top card and request selection remains explicit', () => {
  const view = harness('ko', 7);
  assert.equal(view.nodes().some(n => n.props.id === 'inspection-station-detail'), false);
  const toggle = view.nodes().find(n => n.type === 'button' && n.props['aria-controls'] === 'inspection-station-detail');
  assert.equal(toggle.props['aria-expanded'], false);
  toggle.props.onClick(); view.render();
  assert.equal(view.nodes().find(n => n.props.id === 'inspection-station-detail').props['aria-label'], '7호기 · WJ 생산계획');
  const requests = view.nodes().filter(n => n.props.className === 'inspection-station-detail-request');
  assert.equal(requests.length, 1); assert.match(content(requests[0]), /WJ-PART-027/);
  requests[0].props.onClick(); assert.deepEqual(view.selected, [7]);
});
test('Chinese equipment details contain localized controls and preserve unknown plan status', () => {
  const view = harness('zh', 7, true);
  view.nodes().find(n => n.props['aria-controls'] === 'inspection-station-detail').props.onClick(); view.render();
  const detail = view.nodes().find(n => n.props.id === 'inspection-station-detail');
  assert.match(content(detail), /计划映射·范围未确认/);
  assert.doesNotMatch(content(detail), /[가-힣]/);
  assert.equal(view.nodes().some(n => ['MES 저장', 'MES 完成'].includes(content(n))), false);
});
test('station cards label synthetic observation time and retain it on stale data without filling WJ-only cards', () => {
  for (const lang of ['ko', 'zh'] as const) {
    const view = harness(lang, 7);
    const cards = view.nodes().filter(n => n.props.className === 'inspection-station-tile');
    assert.equal(cards.length, 17);
    const stale = cards.find(n => n.props['data-machine'] === 8);
    assert.equal(stale.props['data-mes-state'], 'stale');
    const stamp = nodes(stale).find(n => n.type === 'time');
    assert.ok(stamp.props.dateTime);
    assert.match(stamp.props.title, /\d{2}:\d{2}/);
    assert.match(content(stale), lang === 'ko' ? /예시 관측/ : /示例观测/);
    assert.equal(nodes(cards.find(n => n.props['data-machine'] === 10)).some(n => n.type === 'time'), false);
  }
});
