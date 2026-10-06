import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as copy from '../src/pages/quality/inspection-requests/copy.ts';
import * as kanban from '../src/pages/quality/inspection-requests/kanban.ts';
import * as filters from '../src/pages/quality/inspection-requests/managementFilters.ts';
import { inspectionKanbanCopy } from '../src/pages/quality/inspection-requests/kanbanCopy.ts';

const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/InspectionKanban.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: unknown; props: Record<string, any> };
const elements = (node: any): Element[] => Array.isArray(node) ? node.flatMap(elements)
  : node && typeof node === 'object' && node.props ? [node, ...elements(node.props.children)] : [];
const content = (node: any): string => Array.isArray(node) ? node.map(content).join('')
  : node == null || typeof node === 'boolean' ? '' : typeof node === 'object' ? content(node.props?.children) : String(node);
function harness(lang: 'ko' | 'zh') {
  let state: unknown;
  const selected: number[] = [];
  const dependencies: Record<string, unknown> = {
    react: { useState: (initial: unknown) => [state ??= initial, (next: any) => { state = typeof next === 'function' ? next(state) : next; }] },
    'react/jsx-runtime': { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }), Fragment: 'Fragment' },
    './MesReadObservationCard': { default: 'MesReadObservationCard' },
    'lucide-react': { AlertTriangle: 'Icon', RefreshCw: 'Icon' },
    './copy': copy, './kanban': kanban, './kanbanCopy': { inspectionKanbanCopy }, './managementFilters': filters,
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  }, exports);
  const request = { id: 41, status: 'draft', sync_status: 'not_synced', mes_completion_status: 'not_completed', mes_checked_at: null,
    judgement: '', notes: '', measurements: [], evidence: [], inspected_quantity: '0', last_error_code: '',
    mes_state: { qc_status: null }, part_no: 'SYNTHETIC-PART', equipment_ref: 'imm01', task_ref: 'SYNTHETIC-TASK',
    work_order_ref: 'SYNTHETIC-WO', lot_ref: '', created_at: '2026-10-05T00:00:00Z', inspection_type: 'first', source_kind: 'local_manual' };
  const snapshot = { day_start: '2026-10-06T00:00:00Z', generated_at: '2026-10-06T01:00:00Z', plan_snapshot: { complete: true },
    machines: [{ machine_number: 1, requests: [request, { ...request, id: 42, notes: 'SYNTHETIC observation' }], plans: [], plan_status: 'missing', dry_run: { candidate: 'none' } }], unmapped_requests: [], unmapped_plans: [] };
  const render = () => exports.default({ snapshot, lang, date: '2026-10-06', now: new Date('2026-10-06T01:00:00Z'),
    loading: false, error: '', selectedId: null, onSelect: (id: number) => selected.push(id), onDate: () => {}, onCurrent: () => {}, onRefresh: () => {} });
  return { render, selected };
}

for (const lang of ['ko', 'zh'] as const) test(`${lang}: management controls filter actual WJ cards, preserve selection and reset locally`, () => {
  const fixture = harness(lang); const text = inspectionKanbanCopy[lang];
  let tree = fixture.render();
  const requestCards = () => elements(tree).filter(node => node.props.className === 'inspection-kanban-request');
  assert.equal(requestCards().length, 2);
  assert.match(content(tree), new RegExp(text.previousDayOpen));
  const progress = elements(tree).find(node => node.type === 'button' && node.props['data-stage'] === 'in_progress')!;
  progress.props.onClick(); tree = fixture.render();
  assert.equal(requestCards().length, 1);
  assert.match(content(requestCards()[0]), /#42/);
  requestCards()[0].props.onClick(); assert.deepEqual(fixture.selected, [42]);
  assert.equal(elements(tree).find(node => node.props['data-stage'] === 'in_progress' && node.type === 'button')?.props['aria-pressed'], true);
  const delayed = elements(tree).find(node => node.type === 'button' && node.props['aria-describedby'] === 'inspection-delay-unavailable')!;
  assert.equal(delayed.props.disabled, true); assert.equal(delayed.props.onClick, undefined);
  assert.ok(elements(tree).some(node => node.props.id === 'inspection-delay-unavailable' && content(node) === text.delayHint));
  elements(tree).find(node => node.type === 'button' && content(node) === text.clearFilters)!.props.onClick();
  tree = fixture.render(); assert.equal(requestCards().length, 2);
  elements(tree).find(node => node.type === 'input' && node.props.type === 'search')!.props.onChange({ target: { value: 'NOT-PRESENT-SYNTHETIC' } });
  tree = fixture.render(); assert.equal(requestCards().length, 0);
  assert.ok(elements(tree).some(node => node.props.role === 'status' && content(node) === text.noMatches));
});
