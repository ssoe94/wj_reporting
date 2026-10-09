import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as contract from '../src/domains/production/plan-workflow-service.ts';
import { materialRequirement } from '../src/domains/production/plan-workflow-form.ts';
import { serviceWorkflowFixture, serviceUid, SERVICE_SCOPE } from './fixtures/plan-workflow-service.ts';
import type { WorkflowData } from '../src/domains/production/plan-workflow-api.ts';

// Execute the real editor with deferred network stubs. No browser/auth/MES is available.
const compiled = ts.transpileModule(readFileSync(new URL('../src/domains/production/components/PlanWorkflowPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText + '\nexports.WorkflowEditor = WorkflowEditor;';
type Element = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : value?.props ? [value, ...nodes(value.props.children)] : [];
const deferred = () => {
  let resolve!: (value: any) => void, reject!: (error: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(initial = serviceWorkflowFixture(), attempts = new Set<string>(), fresh = true) {
  const hooks: any[] = [], effects: (() => void)[] = [];
  const calls: { action: string; uids: string[]; scope: unknown; reply: ReturnType<typeof deferred> }[] = [];
  const mutations: Record<string, unknown>[] = [];
  let index = 0, pending = false, data = initial, language = 'ko', dirty = false, saving = false, invalidations = 0;
  let tree: Element | null = null;
  let updatedAt = 1, isFetchedAfterMount = fresh, isError = false, isFetching = false;
  const dependencies: Record<string, any> = {
    react: { Fragment: 'Fragment',
      useState: (initialValue: any) => { const slot = index++; if (!(slot in hooks)) hooks[slot] = typeof initialValue === 'function' ? initialValue() : initialValue;
        return [hooks[slot], (value: any) => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; pending = true; }]; },
      useRef: (value: any) => { const slot = index++; if (!(slot in hooks)) hooks[slot] = { current: value }; return hooks[slot]; },
      useEffect: (callback: () => void, deps: unknown[]) => { const slot = index++; if (!hooks[slot] || deps.some((value, i) => value !== hooks[slot][i])) {
        hooks[slot] = deps; effects.push(callback); } },
    },
    'react/jsx-runtime': { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }) },
    '@tanstack/react-query': {
      useQuery: () => ({ data, isLoading: false, isError, isFetching, dataUpdatedAt: updatedAt, isFetchedAfterMount, refetch: async () => ({ data }) }),
      useQueryClient: () => ({ invalidateQueries: async () => { invalidations += 1; } }),
      useMutation: () => ({ isPending: false, mutate: (body: Record<string, unknown>) => mutations.push(body) }),
    },
    '../plan-workflow-api': { workflowLabels: { created: ['생성 성공', '创建成功'], already_exists: ['기존 工单 확인됨', '已确认现有工单'],
      uncertain: ['결과 불확실 · 재조회', '结果不确定 · 需复查'], checking: ['생성 전 조회 중 · 재전송 금지', '创建前查询中 · 禁止重发'],
      plan_quantity_review: ['계획수량 범위·소수 정밀도 확인 필요', '需确认计划量范围及小数精度'],
      failed: ['생성 실패 · 결과 확인 필요', '创建失败 · 需核对结果'] } },
    '../plan-workflow-form': { materialRequirement }, '../plan-workflow-service': contract,
    '../plan-workflow-service-api': {
      sendPlanRequests: (scope: unknown, uids: string[]) => { const entry = { scope, uids, action: 'send', reply: deferred() }; calls.push(entry); return entry.reply.promise; },
      recheckPlanRequest: (scope: unknown, uid: string) => { const entry = { scope, uids: [uid], action: 'recheck', reply: deferred() }; calls.push(entry); return entry.reply.promise; },
    }, './plan-workflow.css': {},
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports);
  const dirtyChanged = (value: boolean) => { dirty = value; }, pendingChanged = (value: boolean) => { saving = value; };
  const render = () => { index = 0; pending = false; tree = exports.WorkflowEditor({ date: SERVICE_SCOPE.start, language,
    onDirtyChange: dirtyChanged, onPendingChange: pendingChanged, sendAttempts: attempts }); effects.splice(0).forEach(effect => effect()); };
  const flush = async () => { for (let n = 0; n < 12; n += 1) { await Promise.resolve(); if (pending) render(); } };
  const button = (label: string) => { const found = nodes(tree).find(node => node.type === 'button' && node.props.children === label); assert.ok(found, label); return found; };
  const checkbox = (n = 0) => nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox' && String(node.props['aria-label'] || '').startsWith(language === 'ko' ? '선택 ' : '选择 '))[n];
  render();
  return { calls, attempts, mutations, flush, button, checkbox,
    select: async (n = 0) => { const box = checkbox(n); assert.equal(box.props.disabled, false); box.props.onChange({ target: { checked: true } }); await flush(); },
    text: () => nodes(tree).flatMap(node => typeof node.props.children === 'string' ? [node.props.children] : Array.isArray(node.props.children) ? node.props.children.filter((v: unknown) => typeof v === 'string') : []).join(' '),
    setData: async (next: WorkflowData) => { data = next; updatedAt += 1; isFetchedAfterMount = true; isError = false; isFetching = false; render(); await flush(); },
    failedGet: async () => { isError = true; isFetching = false; isFetchedAfterMount = true; render(); await flush(); },
    language: async (next: string) => { language = next; render(); await flush(); },
    edit: async () => { nodes(tree).find(node => node.type === 'button' && node.props.className === 'plan-workflow__material-cell')!.props.onClick(); await flush(); },
    changeReason: async (value: string) => { nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === '확인 사유 / 근거')!.props.onChange({ target: { value } }); await flush(); },
    reason: () => nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === '확인 사유 / 근거')?.props.value,
    state: () => ({ dirty, saving, invalidations }),
  };
}
test('one selected creation is explicit and double gestures are fenced before React renders', async () => {
  const f = fixture(); await f.flush(); assert.equal(f.calls.length, 0);
  await f.select(); const stale = f.button('선택 工单 MES 생성'); stale.props.onClick(); stale.props.onClick(); await f.flush();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].uids, [serviceUid(1)]); assert.deepEqual(f.calls[0].scope, SERVICE_SCOPE);
  assert.equal(f.state().saving, true); assert.equal(f.checkbox().props.disabled, true);
  f.calls[0].reply.resolve([{ uid: serviceUid(1), code: 'SYNTHETIC-WJ-1', state: 'created', mes_id: '12345678901234567', blockers: [] }]);
  await f.flush(); assert.match(f.text(), /생성 성공/); assert.match(f.text(), /MES #12345678901234567/);
  assert.equal(f.checkbox().props.disabled, true); assert.equal(f.state().saving, false);
});
test('lost response remains uncertain across stale GET, language and remount; only explicit readback follows', async () => {
  const attempts = new Set<string>(), f = fixture(serviceWorkflowFixture(), attempts); await f.select();
  f.button('선택 工单 MES 생성').props.onClick(); f.calls[0].reply.reject(Error('SYNTHETIC timeout')); await f.flush();
  assert.match(f.text(), /결과 불확실/); assert.match(f.text(), /MES 생성 여부 확인 필요/); assert.equal(f.checkbox().props.disabled, true);
  const next = serviceWorkflowFixture(); next.requests[0].can_recheck = true;
  await f.setData(next); await f.language('zh'); assert.match(f.text(), /结果不确定/); assert.match(f.text(), /MES创建状态待核对/); assert.equal(f.calls.length, 1);
  f.button('复查MES').props.onClick(); f.button('复查MES').props.onClick(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].action, 'recheck'); f.calls[1].reply.resolve({ uid:serviceUid(1), code:'', state: 'review', mes_id:null, blockers:[] }); await f.flush();
  assert.equal(f.checkbox().props.disabled, true);
  const remount = fixture(next, attempts); assert.equal(remount.checkbox().props.disabled, true); assert.equal(remount.calls.length, 0);
});
test('a concurrent preflight checking result is shown as pending and never offers a second send', async () => {
  const f = fixture(); await f.select(); f.button('선택 工单 MES 생성').props.onClick();
  f.calls[0].reply.resolve([{ uid:serviceUid(1), code:'SYNTHETIC-WJ-1', state:'checking', mes_id:null, blockers:[] }]); await f.flush();
  assert.match(f.text(), /생성 전 조회 중/); assert.equal(f.checkbox().props.disabled,true);
  const data=serviceWorkflowFixture(['checking']); data.requests[0].attempt=0; data.requests[0].can_recheck=true;
  await f.setData(data); assert.equal(f.checkbox().props.disabled,true); assert.equal(f.button('MES 재조회').props.disabled,false);
  assert.equal(f.calls.length,1);
});
test('OFF preserves the plan and material draft while disabling creation', async () => {
  const data = serviceWorkflowFixture(); data.write_enabled = false; const f = fixture(data);
  assert.match(f.text(), /MES 생성 OFF/); assert.match(f.text(), /SYN-PART-1/); assert.equal(f.checkbox().props.disabled, true);
  await f.edit(); await f.changeReason('SYNTHETIC approval draft'); assert.equal(f.state().dirty, true);
  await f.language('zh'); assert.equal(f.reason(), undefined); // Korean label changed, the same input value remains.
  await f.language('ko'); assert.equal(f.reason(), 'SYNTHETIC approval draft');
  assert.equal(f.button('선택 工单 MES 생성').props.disabled, true); assert.equal(f.calls.length, 0); assert.equal(f.mutations.length, 0);
});
test('partial results keep each row state and a later authoritative GET resolves uncertainty', async () => {
  const f = fixture(); await f.select(0); await f.select(1); f.button('선택 工单 MES 생성').props.onClick();
  f.calls[0].reply.resolve([{ uid: serviceUid(1), code: 'SYNTHETIC-WJ-1', state: 'already_exists', mes_id: '12345678901234567', blockers: [] },
    { uid: serviceUid(2), code: 'SYNTHETIC-WJ-2', state: 'uncertain', mes_id: null, blockers: ['readback_required'] }]); await f.flush();
  assert.match(f.text(), /기존 工单 확인됨/); assert.match(f.text(), /결과 불확실/);
  await f.setData(serviceWorkflowFixture(['already_exists', 'created'])); assert.match(f.text(), /생성 성공/); assert.doesNotMatch(f.text(), /결과 불확실/);
  assert.equal(f.calls.length, 1);
});
test('only server-confirmed failed preflight at attempt zero releases the latch for an explicit selection', async () => {
  const f = fixture(); await f.select(); f.button('선택 工单 MES 생성').props.onClick();
  f.calls[0].reply.reject(Error('SYNTHETIC lost preflight response')); await f.flush();
  for (const state of ['checking', 'uncertain', 'failed']) {
    const data = serviceWorkflowFixture([state]); data.requests[0].attempt = state === 'failed' ? 1 : 0;
    data.requests[0].can_send = true; await f.setData(data); assert.equal(f.checkbox().props.disabled, true);
  }
  const aborted = serviceWorkflowFixture(['failed']); aborted.requests[0].attempt = 0; aborted.requests[0].can_send = true;
  await f.setData(aborted); assert.equal(f.checkbox().props.disabled, false); assert.equal(f.calls.length, 1);
  assert.equal(f.button('선택 工单 MES 생성').props.disabled, true);
  await f.select(); f.button('선택 工单 MES 생성').props.onClick(); assert.equal(f.calls.length, 2);
  f.calls[1].reply.resolve([{ uid: serviceUid(1), code: 'SYNTHETIC-WJ-1', state: 'created', mes_id: '12345678901234567', blockers: [] }]);
  await f.flush(); assert.equal(f.checkbox().props.disabled, true);
});
test('a cached failed0 snapshot cannot release ambiguity after remount or a failed GET', async () => {
  const data=serviceWorkflowFixture(['failed']); data.requests[0].attempt=0; data.requests[0].can_send=true;
  const attempts=new Set<string>(), f=fixture(data,attempts); await f.select();
  f.button('선택 工单 MES 생성').props.onClick(); f.calls[0].reply.reject(Error('SYNTHETIC lost response')); await f.flush();
  assert.equal(f.checkbox().props.disabled,true, 'an unchanged prior successful read is not a new GET');
  assert.match(f.text(),/결과 불확실/, 'old failed0 cache cannot hide the newly ambiguous send');
  const reopened=fixture(data,attempts,false); await reopened.flush(); assert.equal(reopened.checkbox().props.disabled,true);
  await reopened.failedGet(); assert.equal(reopened.checkbox().props.disabled,true); assert.equal(reopened.calls.length,0);
  await reopened.setData(data); assert.equal(reopened.checkbox().props.disabled,false);
  assert.equal(reopened.button('선택 工单 MES 생성').props.disabled,true, 'new successful GET permits only explicit reselection');
});
test('MES creation outcome does not hide a new quantity approval blocker', async () => {
  const data=serviceWorkflowFixture(['created']); data.preview[0].blockers=['plan_quantity_review'];
  const f=fixture(data); assert.match(f.text(),/생성 성공/); assert.match(f.text(),/계획수량 범위·소수 정밀도 확인 필요/);
  assert.equal(f.checkbox().props.disabled,true); await f.language('zh');
  assert.match(f.text(),/需确认计划量范围及小数精度/); assert.equal(f.calls.length,0);
});
