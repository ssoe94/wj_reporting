import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { inspectionCopy } from '../src/pages/quality/inspection-requests/copy.ts';
import * as navigation from '../src/pages/quality/inspection-requests/navigation.ts';
import * as mesWorkflowResult from '../src/pages/quality/inspection-requests/mesWorkflowResult.ts';

// Execute the actual Page with deterministic hook/API adapters. No browser,
// auth storage, HTTP client, credentials or real timers are used.
const source = readFileSync(new URL('../src/pages/quality/inspection-requests/InspectionRequestsPage.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const SESSION = 'SYNTHETIC-PILOT-PAGE-SESSION';
const DATE = '2026-10-04';
const request = { id: 42, work_order_ref: 'SYNTHETIC-ASSIGNED-42', task_ref: 'SYNTHETIC-TASK', part_no: 'SYNTHETIC-PART', equipment_ref: 'SYNTHETIC-EQUIPMENT', target_quantity: '1', uom: 'EA', status: 'draft', assigned_to_name: 'SYNTHETIC-INSPECTOR' };
const pilot = { can_view: true, can_manage: false, can_submit: true, can_review: false, access_scope: 'assigned_only', can_view_kanban: false, data_mode: 'synthetic_preview', mes: { enabled: false, can_refresh: false, can_sync: false } };
const full = { ...pilot, can_manage: true, can_review: true, access_scope: 'all', can_view_kanban: true };
type Element = { type: unknown; props: Record<string, any> };
type Hook = { value?: any; deps?: unknown[]; cleanup?: () => void };
type Call = { kind: string; args: unknown[] };

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function elements(node: any): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  return [node, ...elements(node.props.children)];
}
function content(node: any): string {
  if (Array.isArray(node)) return node.map(content).join('');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  return typeof node === 'object' ? content(node.props?.children) : String(node);
}
function harness(initialReply = deferred()) {
  const hooks: Hook[] = [];
  const calls: Call[] = [];
  const invalidations: string[][] = [];
  const queryClient = { invalidateQueries: async ({ queryKey }: { queryKey: readonly string[] }) => { invalidations.push([...queryKey]); } };
  const timers = new Map<number, () => void>();
  const effects: (() => void)[] = [];
  let cursor = 0;
  let dirty = true;
  let tree: Element;
  let reply = initialReply;
  let intervalId = 0;
  let sessionCurrent = true;
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
  const react = {
    useState(initial: any) {
      const index = cursor++;
      const hook = hooks[index] ?? (hooks[index] = { value: typeof initial === 'function' ? initial() : initial });
      return [hook.value, (next: any) => { const value = typeof next === 'function' ? next(hook.value) : next; if (!Object.is(value, hook.value)) { hook.value = value; dirty = true; } }];
    },
    useRef(initial: any) { const index = cursor++; return (hooks[index] ?? (hooks[index] = { value: { current: initial } })).value; },
    useCallback(callback: any, deps: unknown[]) {
      const index = cursor++;
      const hook = hooks[index] ?? (hooks[index] = {});
      if (!same(hook.deps, deps)) { hook.value = callback; hook.deps = deps; }
      return hook.value;
    },
    useEffect(effect: () => (() => void) | void, deps: unknown[]) {
      const index = cursor++;
      const hook = hooks[index] ?? (hooks[index] = {});
      if (!same(hook.deps, deps)) {
        hook.deps = deps;
        effects.push(() => { hook.cleanup?.(); hook.cleanup = effect() || undefined; });
      }
    },
  };
  const api = {
    getInspectionCapabilities: (...args: unknown[]) => { calls.push({ kind: 'capabilities', args }); return reply.promise; },
    getInspectionRequests: async (...args: unknown[]) => { calls.push({ kind: 'list', args }); return { count: 1, next: null, previous: null, results: [request] }; },
    getInspectionKanban: async (...args: unknown[]) => { calls.push({ kind: 'kanban', args }); return { business_date: DATE }; },
    getInspectionRequest: async (...args: unknown[]) => { calls.push({ kind: 'detail', args }); return request; },
  };
  const dependencies: Record<string, unknown> = {
    react,
    '@tanstack/react-query': { useQueryClient: () => queryClient },
    'react/jsx-runtime': { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }), Fragment: 'Fragment' },
    'react-dom': { createPortal: (node: any) => node },
    'lucide-react': { AlertTriangle: 'Icon', ClipboardCheck: 'Icon', Plus: 'Icon', RefreshCw: 'Icon', Search: 'Icon' },
    '../../../contexts/AuthContext': { useAuth: () => ({ user: { id: 12, username: 'SYNTHETIC-INSPECTOR' }, authSessionId: SESSION, logout: async () => false, isLoggingOut: false, logoutError: false }) },
    '@/domains/auth/auth-storage': { subscribeToAuthStorage: () => () => {} },
    '@/domains/auth/auth-transition': { assertAuthSessionCurrent: (id: string) => { assert.ok(sessionCurrent && id === SESSION, 'Synthetic session changed'); }, isAuthSessionCurrent: (id: string) => sessionCurrent && id === SESSION, registerAuthTransitionGuard: () => () => {} },
    '../../../i18n': { useLang: () => ({ lang: 'ko' }) },
    './api': api,
    './copy': { inspectionCopy, inspectionDataSourceCopy: () => ({ notice: 'SYNTHETIC', hint: 'SYNTHETIC', requests: 'SYNTHETIC', plans: 'SYNTHETIC' }), inspectionRequestStatusLabels: { ko: { draft: '초안' } }, inspectionTime: () => 'SYNTHETIC' },
    './kanban': { inspectionBusinessDate: () => DATE },
    './workflow': { inspectionError: (_error: unknown, fallback: string) => ({ message: fallback }) },
    './navigation': navigation,
    './mesWorkflowResult': mesWorkflowResult,
    './useInspectionRouteLeaveGuard': { useInspectionRouteLeaveGuard: () => ({ blocked: false, canLeave: true, stay: () => {}, leave: () => {} }) },
    './InspectionKanban': { default: 'InspectionKanban' },
    './InspectionRequestDetail': { default: 'InspectionRequestDetail' },
    './NewInspectionRequest': { default: 'NewInspectionRequest' },
    './InspectionRequestsPage.css': {},
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in dependencies, `Unexpected module: ${name}`); return dependencies[name]; }, exports);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setInterval: (callback: () => void) => { const id = ++intervalId; timers.set(id, callback); return id; },
    clearInterval: (id: number) => timers.delete(id), confirm: () => true,
  } });
  function render() { dirty = false; cursor = 0; tree = exports.default(); for (const effect of effects.splice(0)) effect(); }
  async function settle() {
    for (let i = 0; i < 20; i += 1) { if (dirty) render(); await Promise.resolve(); }
    assert.equal(dirty, false, 'Page should settle without a rendering loop');
  }
  return {
    calls, invalidations, timers, reply: initialReply, settle,
    expireSession: () => { sessionCurrent = false; },
    nodes: () => elements(tree), text: () => content(tree),
    button: (label: string) => elements(tree).find((node) => node.type === 'button' && content(node) === label),
    replaceReply: () => { reply = deferred(); return reply; },
    cleanup: () => { hooks.forEach((hook) => hook.cleanup?.()); if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window'); },
  };
}

test('pending capabilities send no list/detail/kanban request and create no polling timers', async () => {
  const fixture = harness();
  try {
    await fixture.settle();
    assert.deepEqual(fixture.calls, [{ kind: 'capabilities', args: [SESSION] }]);
    assert.deepEqual(fixture.invalidations, []);
    assert.equal(fixture.timers.size, 0);
    assert.match(fixture.text(), /접근 권한을 확인/);
    assert.equal(fixture.nodes().some((node) => ['InspectionKanban', 'InspectionRequestDetail', 'NewInspectionRequest'].includes(String(node.type))), false);
    assert.equal(fixture.nodes().some((node) => node.props.className?.includes('inspection-workspace')), false);
  } finally { fixture.cleanup(); }
});

test('denied or incomplete scope capabilities fail closed without business API requests', async () => {
  for (const capabilities of [{ ...full, can_view: false }, { ...full, access_scope: undefined }, { ...full, access_scope: 'unknown' }]) {
    const fixture = harness();
    try {
      fixture.reply.resolve(capabilities); await fixture.settle();
      assert.deepEqual(fixture.calls.map((call) => call.kind), ['capabilities']);
      assert.deepEqual(fixture.invalidations, []);
      assert.equal(fixture.timers.size, 0);
      assert.match(fixture.text(), /조회할 권한이 없습니다/);
      assert.equal(fixture.button(inspectionCopy.ko.create), undefined);
    } finally { fixture.cleanup(); }
  }
});

test('capability failure stays closed until an explicit successful retry', async () => {
  const fixture = harness();
  try {
    await fixture.settle(); fixture.reply.reject(new Error('SYNTHETIC 403')); await fixture.settle();
    assert.deepEqual(fixture.calls.map((call) => call.kind), ['capabilities']);
    assert.equal(fixture.timers.size, 0);
    const retry = fixture.replaceReply(); fixture.button(inspectionCopy.ko.retry)!.props.onClick(); await fixture.settle();
    assert.deepEqual(fixture.calls.map((call) => call.kind), ['capabilities', 'capabilities']);
    retry.resolve(pilot); await fixture.settle();
    assert.deepEqual(fixture.calls.map((call) => call.kind), ['capabilities', 'capabilities', 'list']);
    assert.equal(fixture.timers.size, 0);
  } finally { fixture.cleanup(); }
});

test('assigned-only pilot has an always-visible assigned list and no kanban or create authority', async () => {
  const fixture = harness();
  try {
    fixture.reply.resolve(pilot); await fixture.settle();
    assert.deepEqual(fixture.calls, [{ kind: 'capabilities', args: [SESSION] }, { kind: 'list', args: ['', '', 1, SESSION] }]);
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.nodes().some((node) => node.type === 'InspectionKanban'), false);
    assert.equal(fixture.nodes().some((node) => node.type === 'details' && node.props.className?.includes('inspection-auxiliary')), false);
    assert.ok(fixture.nodes().some((node) => node.type === 'section' && node.props.className?.includes('inspection-assigned-workspace')));
    assert.match(fixture.text(), /내게 배정된 검사요청/);
    assert.match(fixture.text(), /SYNTHETIC-ASSIGNED-42/);
    assert.equal(fixture.button(inspectionCopy.ko.create), undefined);
    fixture.button(inspectionCopy.ko.refreshList)!.props.onClick(); await fixture.settle();
    assert.equal(fixture.calls.filter((call) => call.kind === 'list').length, 2);
    assert.equal(fixture.calls.some((call) => call.kind === 'kanban'), false);
  } finally { fixture.cleanup(); }
});

test('pilot detail and its post-save refresh remain session-bound and never fetch kanban', async () => {
  const fixture = harness();
  try {
    fixture.reply.resolve(pilot); await fixture.settle();
    fixture.nodes().find((node) => node.props.className === 'inspection-list-row')!.props.onClick(); await fixture.settle();
    assert.deepEqual(fixture.calls.find((call) => call.kind === 'detail')?.args, [42, SESSION]);
    const detail = fixture.nodes().find((node) => node.type === 'InspectionRequestDetail')!;
    assert.equal(detail.props.sessionId, SESSION);
    assert.equal(detail.props.userId, 12);
    assert.ok(fixture.button(inspectionCopy.ko.returnToList));
    assert.equal(fixture.button(inspectionCopy.ko.returnToKanban), undefined);
    detail.props.onChanged({ ...request, version: 2 }); await fixture.settle();
    assert.deepEqual(fixture.invalidations, [], 'a WJ-only save is not verified MES readback');
    assert.equal(fixture.calls.filter((call) => call.kind === 'list').length, 2);
    assert.equal(fixture.calls.some((call) => call.kind === 'kanban'), false);
    assert.equal(fixture.timers.size, 0);
  } finally { fixture.cleanup(); }
});

test('pilot projection invalidation requires verified MES readback and the owning session', async () => {
  const fixture = harness();
  try {
    fixture.reply.resolve(pilot); await fixture.settle();
    fixture.nodes().find((node) => node.props.className === 'inspection-list-row')!.props.onClick(); await fixture.settle();
    const detail = fixture.nodes().find((node) => node.type === 'InspectionRequestDetail')!;
    const observedAt = '2026-10-06T10:00:00Z';
    const observed = { ...request, version: 2, sync_status: 'succeeded', mes_completion_status: 'not_completed',
      mes_checked_at: observedAt, last_error_code: '', mes_workflow: { phase: 'saved', last_verified_at: observedAt } };
    for (const unverified of [
      { ...observed, sync_status: 'unknown' },
      { ...observed, last_error_code: 'mes_outcome_unknown' },
      { ...observed, mes_workflow: { ...observed.mes_workflow, phase: 'ready' } },
      { ...observed, mes_workflow: { ...observed.mes_workflow, last_verified_at: null } },
    ]) {
      detail.props.onChanged(unverified); await fixture.settle();
      assert.deepEqual(fixture.invalidations, [], 'unconfirmed MES state cannot refresh successful projections');
    }
    detail.props.onChanged(observed); await fixture.settle();
    assert.deepEqual(fixture.invalidations, [['production-status'], ['inspection-overview']]);
    detail.props.onChanged({ ...observed, version: 3, mes_completion_status: 'completed',
      mes_workflow: { ...observed.mes_workflow, phase: 'completed' } }); await fixture.settle();
    assert.deepEqual(fixture.invalidations, [['production-status'], ['inspection-overview'], ['production-status'], ['inspection-overview']]);
    assert.equal(fixture.calls.some((call) => call.kind === 'kanban'), false);
    assert.ok(fixture.calls.every((call) => ['capabilities', 'list', 'detail'].includes(call.kind) && call.args.at(-1) === SESSION));
    assert.equal(fixture.timers.size, 0);
    const callCount = fixture.calls.length;
    fixture.expireSession(); detail.props.onChanged(observed); await fixture.settle();
    assert.equal(fixture.calls.length, callCount, 'a stale inspector cannot refetch scoped business data');
    assert.equal(fixture.invalidations.length, 4, 'a stale inspector cannot invalidate the new session projections');
  } finally { fixture.cleanup(); }
});

test('pilot creation is exposed only by explicit can_manage and still does not fetch kanban', async () => {
  const fixture = harness();
  try {
    fixture.reply.resolve({ ...pilot, can_manage: true }); await fixture.settle();
    fixture.button(inspectionCopy.ko.create)!.props.onClick(); await fixture.settle();
    const editor = fixture.nodes().find((node) => node.type === 'NewInspectionRequest')!;
    assert.equal(editor.props.sessionId, SESSION);
    editor.props.onCreated(request); await fixture.settle();
    assert.equal(fixture.calls.some((call) => call.kind === 'kanban'), false);
    assert.equal(fixture.timers.size, 0);
  } finally { fixture.cleanup(); }
});

test('full scope preserves kanban, collapsed auxiliary list and kanban polling', async () => {
  const fixture = harness();
  try {
    fixture.reply.resolve(full); await fixture.settle();
    assert.deepEqual(fixture.calls.map((call) => call.kind), ['capabilities', 'kanban', 'list']);
    assert.ok(fixture.nodes().some((node) => node.type === 'InspectionKanban'));
    const auxiliary = fixture.nodes().find((node) => node.type === 'details' && node.props.className?.includes('inspection-auxiliary'))!;
    assert.equal(auxiliary.props.open, undefined);
    assert.equal(fixture.nodes().some((node) => node.props.className?.includes('inspection-assigned-workspace')), false);
    assert.equal(fixture.timers.size, 2);
    for (const tick of [...fixture.timers.values()]) tick(); await fixture.settle();
    assert.equal(fixture.calls.filter((call) => call.kind === 'kanban').length, 2);
    fixture.nodes().find((node) => node.props.className === 'inspection-list-row')!.props.onClick(); await fixture.settle();
    assert.ok(fixture.button(inspectionCopy.ko.returnToKanban));
  } finally { fixture.cleanup(); }
});
