import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const compiled = compile('../src/domains/production/components/PlanMasterGapsModal.tsx');
type Element = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value?.props ? [value, ...nodes(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join(' ') : value?.props ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const source = { plan_id: 1, uid: 'SYNTHETIC', version: 1, plan_date: '2026-10-10', machine_name: 'SYN-IMM01', lot_no: '', model_name: '', part_spec: 'B/C' };
const row = (changes: Record<string, any> = {}) => ({ part_no: 'SYN-PART', sources: [source], source_specs: ['B/C'], source_spec_conflict: false,
  status: 'ok', issue: null, mes: { material_id: '17000000000000001', specification: null, category: null },
  spec_state: 'blank_candidate', spec_candidate: 'B/C', category_state: 'decision_required', category_candidate: null, confirmed_category: null, ...changes });
const data = (rows = [row()]) => ({ checked_at: '2026-10-10T17:00:00+08:00', rows });
function fixture(state: Record<string, any> = {}, language = 'ko') {
  let queryOptions: any, focusOptions: any, closed = 0, reads = 0, id = 0;
  const calls: { path: string; options: any }[] = [];
  let response: any = data();
  const dependencies: Record<string, any> = {
    react: { useId: () => `master-gap-${id++}` }, 'react-dom': { createPortal: (child: any) => child },
    'react/jsx-runtime': { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }) },
    '@tanstack/react-query': { useQuery: (options: any) => { queryOptions = options; return {
      data: undefined, isPending: false, isFetching: false, isError: false, refetch: () => { reads += 1; }, ...state,
    }; } },
    '@/shared/api/http': { http: { get: async (path: string, options: any) => { calls.push({ path, options }); return { data: response }; } } },
    '@/shared/hooks/useModalFocusTrap': { useModalFocusTrap: (options: any) => { focusOptions = options; return { current: null }; } },
    './plan-master-gaps.css': {},
  };
  const exports: Record<string, any> = {};
  // Portal target is injected lexically; the test has no browser, auth, MES, or write endpoint.
  new Function('require', 'exports', 'document', compiled)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports, { body: {} });
  const tree = exports.PlanMasterGapsModal({ date: '2026-10-10', language, onClose: () => { closed += 1; } });
  return { tree, calls, text: () => text(tree), nodes: () => nodes(tree), query: () => queryOptions,
    setResponse: (value: any) => { response = value; }, escape: () => focusOptions.onEscape(), closed: () => closed, reads: () => reads,
    button: (label: string) => { const button = nodes(tree).find(node => node.type === 'button' && node.props.children === label); assert.ok(button); return button; },
    cells: () => nodes(tree).filter(node => node.type === 'td').map(text) };
}

test('master comparison sends one scoped injection GET and exposes only close/reload actions', async () => {
  const f = fixture({ data: data() }); await f.query().queryFn();
  assert.deepEqual(f.calls, [{ path: '/production/plan-workflow/', options: { params: {
    action: 'master_gaps', start: '2026-10-10', end: '2026-10-10', plan_type: 'injection',
  } } }]);
  assert.deepEqual(f.query().queryKey, ['production', 'plan-master-gaps', '2026-10-10', 'injection']);
  assert.equal(f.query().retry, false); assert.equal(f.query().refetchOnWindowFocus, false);
  assert.deepEqual(f.nodes().filter(node => node.type === 'button').map(node => text(node)), ['닫기', '다시 조회']);
  assert.equal(f.nodes().some(node => ['input', 'select', 'textarea', 'form'].includes(String(node.type))), false);
  assert.match(f.text(), /가공 SUFFIX는 포함하지 않습니다/); f.button('다시 조회').props.onClick(); assert.equal(f.reads(), 1);
});

test('all saved SPEC sources remain visible and existing MES values are preserved despite different candidates', () => {
  const f = fixture({ data: data([row({ source_specs: ['B/C', 'B/C完'], source_spec_conflict: true,
    sources: [source, { ...source, plan_id: 2, part_spec: 'B/C完', machine_name: 'SYN-IMM02' }],
    mes: { material_id: '17000000000000001', specification: 'CURRENT MES SPEC', category: { code: 'KEEP', name: 'Existing category' } },
    spec_state: 'existing', category_state: 'existing', spec_candidate: 'DO NOT REPLACE',
    category_candidate: { code: 'CAT-000', name: 'OTHER', path: 'DO NOT APPLY', source: 'user_confirmed_2026-10-10' },
  })]) });
  assert.match(f.cells()[0], /B\/C.*B\/C完.*SPEC 확인 필요/);
  assert.match(f.cells()[1], /CURRENT MES SPEC.*기존값 유지/); assert.match(f.cells()[2], /Existing category.*KEEP.*기존값 유지/);
  assert.match(f.text(), /SYN-IMM01/); assert.match(f.text(), /SYN-IMM02/); assert.doesNotMatch(f.text(), /DO NOT REPLACE|DO NOT APPLY/);
});

test('blank SPEC candidates use saved source; classification is shown only as a prior server-confirmed candidate', () => {
  const confirmed = { code: 'CAT-000', name: '后盖板', path: '半成品 / 后盖板', source: 'user_confirmed_2026-10-10' };
  const f = fixture({ data: data([row({ part_no: 'ACQ30854202', category_state: 'blank_confirmed', category_candidate: confirmed }),
    row({ part_no: 'OTHER-B-C', source_specs: ['B/C完'], spec_candidate: 'B/C完' })]) });
  assert.match(f.cells()[1], /공란.*계획 후보\s*:.*B\/C/); assert.match(f.cells()[2], /기존 확인 후보\s*:.*半成品 \/ 后盖板.*CAT-000/);
  assert.match(f.cells()[5], /공란.*분류 결정 필요/); assert.doesNotMatch(f.cells()[5], /CAT-000|后盖板/);
});

test('unknown rows ignore candidates and never claim a MES blank', () => {
  const f = fixture({ data: data([row({ status: 'unknown', mes: null, issue: 'material_not_returned',
    spec_candidate: 'UNTRUSTED-CANDIDATE', category_state: 'blank_confirmed',
    category_candidate: { code: 'CAT-000', name: 'NO', path: 'NO', source: 'user_confirmed_2026-10-10' } })]) });
  assert.equal(f.cells()[1], '미확인'); assert.equal(f.cells()[2], '미확인');
  assert.doesNotMatch(f.cells().slice(1).join(' '), /공란|UNTRUSTED|CAT-000/);
});

test('read errors and pending refreshes hide old results, and malformed successful reads fail closed', async () => {
  const old = data([row({ part_no: 'STALE-PART' })]);
  for (const state of [{ isError: true }, { isFetching: true }]) {
    const f = fixture({ data: old, ...state }); assert.doesNotMatch(f.text(), /STALE-PART/);
    assert.equal(f.nodes().some(node => node.type === 'table'), false);
  }
  const error = fixture({ data: old, isError: true }); assert.match(error.text(), /조회 실패.*미확인/);
  for (const invalid of [{ rows: null }, data([row({ status: 'ok', mes: {} })]), data([row({ source_specs: 'B/C' })])]) {
    const f = fixture(); f.setResponse(invalid); await assert.rejects(f.query().queryFn(), /Invalid master comparison response/);
  }
});

test('empty saved injection scope and Chinese unknown states remain distinct from blank master values', () => {
  const empty = fixture({ data: data([]) }, 'zh'); assert.match(empty.text(), /所选基准日没有已保存的注塑计划/);
  assert.equal(empty.nodes().some(node => node.type === 'table'), false);
  const unknown = fixture({ data: data([row({ status: 'unknown', mes: null })]) }, 'zh');
  assert.equal(unknown.cells()[1], '待核实'); assert.equal(unknown.cells()[2], '待核实');
});

test('dialog labels, keyboard-scroll region, Close and Escape are wired to the existing focus trap', () => {
  const f = fixture({ data: data() });
  const dialog = f.nodes().find(node => node.props.role === 'dialog')!;
  assert.equal(dialog.props['aria-modal'], 'true'); assert.ok(dialog.props['aria-labelledby']); assert.ok(dialog.props['aria-describedby']);
  const region = f.nodes().find(node => node.props.role === 'region')!; assert.equal(region.props.tabIndex, 0); assert.ok(region.props['aria-label']);
  assert.equal(f.button('닫기').props['data-modal-initial-focus'], true);
  f.button('닫기').props.onClick(); f.escape(); assert.equal(f.closed(), 2);
});

test('shared modal trap focuses Close, wraps keyboard navigation, handles Escape and restores the launcher', () => {
  const compiledHook = compile('../src/shared/hooks/useModalFocusTrap.ts');
  const effects: (() => void | (() => void))[] = [], listeners = new Map<string, (event: any) => void>();
  let fakeDocument: any, closed = 0;
  class FakeElement {
    tabIndex = 0; isConnected = true; dataset: Record<string, string> = {}; style = { overflow: 'auto' };
    focus() { fakeDocument.activeElement = this; }
    getAttribute() { return null; }
  }
  const launcher = new FakeElement(), close = new FakeElement(), reload = new FakeElement(), region = new FakeElement();
  const container = Object.assign(new FakeElement(), { querySelector: () => close, querySelectorAll: () => [close, reload, region], contains: (element: any) => [close, reload, region].includes(element) });
  fakeDocument = { activeElement: launcher, body: new FakeElement(), querySelectorAll: () => [container],
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener), removeEventListener: (name: string) => listeners.delete(name) };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', 'document', 'window', 'HTMLElement', compiledHook)(() => ({
    useRef: (value: any) => ({ current: value }), useEffect: (effect: () => void) => effects.push(effect),
  }), exports, fakeDocument, { requestAnimationFrame: (callback: () => void) => { callback(); return 1; }, cancelAnimationFrame() {} }, FakeElement);
  const ref = exports.useModalFocusTrap({ onEscape: () => { closed += 1; } }); ref.current = container;
  const cleanup = effects.map(effect => effect()).filter(Boolean) as (() => void)[];
  assert.equal(fakeDocument.activeElement, close); assert.equal(fakeDocument.body.style.overflow, 'hidden');
  fakeDocument.activeElement = region; listeners.get('keydown')!({ key: 'Tab', shiftKey: false, preventDefault() {} }); assert.equal(fakeDocument.activeElement, close);
  listeners.get('keydown')!({ key: 'Tab', shiftKey: true, preventDefault() {} }); assert.equal(fakeDocument.activeElement, region);
  listeners.get('keydown')!({ key: 'Escape', preventDefault() {} }); assert.equal(closed, 1);
  cleanup.forEach(dispose => dispose()); assert.equal(fakeDocument.activeElement, launcher); assert.equal(fakeDocument.body.style.overflow, 'auto'); assert.equal(listeners.size, 0);
});
