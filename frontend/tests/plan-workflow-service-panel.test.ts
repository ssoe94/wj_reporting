import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as contract from '../src/domains/production/plan-workflow-service.ts';
import { materialRequirement } from '../src/domains/production/plan-workflow-form.ts';
import { serviceWorkflowFixture, serviceBomFixture, serviceUid, SERVICE_SCOPE } from './fixtures/plan-workflow-service.ts';
import type { WorkflowData } from '../src/domains/production/plan-workflow-api.ts';

// Execute the real editor with deferred network stubs. No browser/auth/MES is available.
const compiled = ts.transpileModule(readFileSync(new URL('../src/domains/production/components/PlanWorkflowPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText + '\nexports.WorkflowEditor = WorkflowEditor;';
const apiCompiled = ts.transpileModule(readFileSync(new URL('../src/domains/production/plan-workflow-service-api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const workflowApiCompiled = ts.transpileModule(readFileSync(new URL('../src/domains/production/plan-workflow-api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const bomCompiled = ts.transpileModule(readFileSync(new URL('../src/domains/production/components/PlanBomInputs.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : value?.props ? [value, ...nodes(value.props.children)] : [];
const deferred = () => {
  let resolve!: (value: any) => void, reject!: (error: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(initial = serviceWorkflowFixture(), attempts = new Set<string>(), fresh = true, deferredBom = false) {
  const hooks: any[] = [], effects: (() => void)[] = [];
  const calls: { action: string; uids: string[]; scope: unknown; reply: ReturnType<typeof deferred>; options: any }[] = [];
  const mutations: Record<string, unknown>[] = [];
  const bomReads: { params: any; reply: ReturnType<typeof deferred> }[] = [];
  let mutationOptions: any;
  let index = 0, pending = false, data = initial, language = 'ko', dirty = false, saving = false, invalidations = 0;
  let tree: Element | null = null;
  let updatedAt = 1, isFetchedAfterMount = fresh, isError = false, isFetching = false;
  let session = 'SYNTHETIC-WJ-CHUNK-OWNER';
  let date = SERVICE_SCOPE.start;
  const api: Record<string, any> = {};
  const apiDependencies: Record<string, any> = {
    '@/shared/api/http': { http: { get: (path: string, options: any) => {
      assert.equal(path, '/production/plan-workflow/'); assert.equal(options.params.action, 'bom');
      const entry = { params: options.params, reply: deferred() }; bomReads.push(entry);
      if (!deferredBom) entry.reply.resolve(serviceBomFixture(options.params.plan_id));
      return entry.reply.promise.then(data => ({ data }));
    }, post: (_path: string, body: any, options: any) => {
      const entry = { scope: { start:body.start, end:body.end, plan_type:body.plan_type },
        uids: body.action === 'send' ? body.request_uids : [body.request_uid], action:body.action, reply:deferred(), options };
      calls.push(entry); return entry.reply.promise.then(value => ({ data:body.action==='send' ? {results:value} : value }));
    } } },
    '@/domains/auth/auth-storage': { getAuthSessionSnapshot: () => ({id:session}) },
    '@/domains/auth/auth-transition': { assertAuthSessionCurrent: (owner: string) => { if(owner!==session) throw Error('SYNTHETIC session changed'); } },
    './plan-workflow-service': contract,
  };
  new Function('require','exports',apiCompiled)((name:string)=>{ assert.ok(name in apiDependencies,name); return apiDependencies[name]; },api);
  const workflowApi: Record<string, any> = {};
  new Function('require', 'exports', workflowApiCompiled)((name: string) => { assert.ok(name in apiDependencies, name); return apiDependencies[name]; }, workflowApi);
  const jsx = (type: unknown, props: any) => typeof type === 'function' ? type(props) : ({ type, props });
  const bom: Record<string, any> = {};
  new Function('require', 'exports', bomCompiled)((name: string) => {
    if (name === '../plan-workflow-form') return { materialRequirement };
    assert.equal(name, 'react/jsx-runtime'); return { jsx, jsxs: jsx };
  }, bom);
  const dependencies: Record<string, any> = {
    react: { Fragment: 'Fragment',
      useState: (initialValue: any) => { const slot = index++; if (!(slot in hooks)) hooks[slot] = typeof initialValue === 'function' ? initialValue() : initialValue;
        return [hooks[slot], (value: any) => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; pending = true; }]; },
      useRef: (value: any) => { const slot = index++; if (!(slot in hooks)) hooks[slot] = { current: value }; return hooks[slot]; },
      useEffect: (callback: () => void, deps: unknown[]) => { const slot = index++; if (!hooks[slot] || deps.some((value, i) => value !== hooks[slot][i])) {
        hooks[slot] = deps; effects.push(callback); } },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@tanstack/react-query': {
      useQuery: () => ({ data, isLoading: false, isError, isFetching, dataUpdatedAt: updatedAt, isFetchedAfterMount, refetch: async () => ({ data }) }),
      useQueryClient: () => ({ invalidateQueries: async () => { invalidations += 1; } }),
      useMutation: (options: any) => { mutationOptions = options; return { isPending: false, mutate: (body: Record<string, unknown>) => mutations.push(body) }; },
    },
    '../plan-workflow-api': workflowApi, './PlanBomInputs': bom,
    '../plan-workflow-form': { materialRequirement }, '../plan-workflow-service': contract,
    '../plan-workflow-service-api': api, './plan-workflow.css': {},
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports);
  const dirtyChanged = (value: boolean) => { dirty = value; }, pendingChanged = (value: boolean) => { saving = value; };
  const render = () => { index = 0; pending = false; tree = exports.WorkflowEditor({ date, language,
    onDirtyChange: dirtyChanged, onPendingChange: pendingChanged, sendAttempts: attempts }); effects.splice(0).forEach(effect => effect()); };
  const flush = async () => { for (let n = 0; n < 12; n += 1) { await Promise.resolve(); if (pending) render(); } };
  const button = (label: string) => { const found = nodes(tree).find(node => node.type === 'button' && node.props.children === label); assert.ok(found, label); return found; };
  const checkbox = (n = 0) => nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox' && String(node.props['aria-label'] || '').startsWith(language === 'ko' ? '선택 ' : '选择 '))[n];
  render();
  return { calls, attempts, mutations, bomReads, flush, button, checkbox,
    mutationError: async (status: number) => { mutationOptions.onError({ response: { status } }); await flush(); },
    date: async (next: string) => { date = next; render(); await flush(); },
    scopeType: async (next: string) => { nodes(tree).find(node => node.type === 'select' && node.props['aria-label'] === '공정')!.props.onChange({ target: { value: next } }); await flush(); },
    queue: async (stage: string) => { nodes(tree).find(node => node.type === 'button' && node.props['data-stage'] === stage)!.props.onClick(); await flush(); },
    expand: async (position = 0) => { nodes(tree).filter(node => node.type === 'button' && node.props.className === 'plan-workflow__expand')[position].props.onClick(); await flush(); },
    mesEvidence: () => nodes(tree).map(node => node.props['aria-description'] || '').join(' '),
    stages: () => nodes(tree).filter(node => node.type === 'button' && node.props['data-stage']).map(node => node.props['data-stage']),
    elements: () => nodes(tree),
    changeMaterial: async (position: number, key: string) => { nodes(tree).filter(node => node.type === 'select' && String(node.props['aria-label'] || '').startsWith('사용 원료 '))[position].props.onChange({ target: { value: key } }); await flush(); },
    select: async (n = 0) => { const box = checkbox(n); assert.equal(box.props.disabled, false); box.props.onChange({ target: { checked: true } }); await flush(); },
    text: () => nodes(tree).flatMap(node => typeof node.props.children === 'string' ? [node.props.children] : Array.isArray(node.props.children) ? node.props.children.filter((v: unknown) => typeof v === 'string') : []).join(' '),
    setData: async (next: WorkflowData) => { data = next; updatedAt += 1; isFetchedAfterMount = true; isError = false; isFetching = false; render(); await flush(); },
    failedGet: async () => { isError = true; isFetching = false; isFetchedAfterMount = true; render(); await flush(); },
    replaceSession: () => { session='SYNTHETIC-REPLACEMENT-OWNER'; },
    language: async (next: string) => { language = next; render(); await flush(); },
    edit: async (part = 'SYN-PART-1') => { const row = nodes(tree).find(node => node.type === 'tr' && node.props['data-group-key'] === `synthetic-${part.replace('SYN-PART-', '')}`); assert.ok(row); nodes(row).find(node => node.type === 'button' && node.props.className === 'plan-workflow__material-cell')!.props.onClick(); await flush(); },
    changeReason: async (value: string) => { nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === '확인 사유 / 근거')!.props.onChange({ target: { value } }); await flush(); },
    confirmMaterial: async () => { nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox' && !node.props['aria-label'])!.props.onChange({ target: { checked: true } }); await flush(); },
    saveMaterial: () => nodes(tree).find(node => node.type === 'form' && node.props.id === 'plan-material-draft')!.props.onSubmit({ preventDefault() {} }),
    reason: () => nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === '확인 사유 / 근거')?.props.value,
    state: () => ({ dirty, saving, invalidations }),
  };
}
test('business queue follows current approvals and preserves actual actor and time', async () => {
  const data = serviceWorkflowFixture(); data.rows[0].approval = null; data.preview[0].blockers = ['material_confirmation'];
  const f = fixture(data); await f.queue('materials'); assert.match(f.text(), /SYN-PART-1/); assert.doesNotMatch(f.text(), /SYN-PART-2/);
  await f.queue('issue'); assert.doesNotMatch(f.text(), /SYN-PART-1/); assert.match(f.text(), /SYN-PART-2/);
  await f.expand();
  assert.match(f.text(), /SYNTHETIC QA/); assert.match(f.text(), /2026-10-10 07:00/);
  assert.doesNotMatch(f.text(), /실제 확인: 韦凯/); assert.equal(f.calls.length, 0);
});
test('a refreshed approval cannot hide the active draft from its previous queue', async () => {
  const data = serviceWorkflowFixture(); data.rows[0].approval = null; data.preview[0].blockers = ['material_confirmation'];
  const f = fixture(data); await f.queue('materials'); await f.edit(); await f.changeReason('Keep draft across refresh');
  await f.setData(serviceWorkflowFixture());
  assert.equal(f.reason(), 'Keep draft across refresh'); assert.equal(f.state().dirty, true);
  assert.ok(f.button('취소')); assert.equal(f.calls.length, 0);
});
test('unversioned materials and absent mold can be explicitly approved while MES creation stays OFF', async () => {
  const data = serviceWorkflowFixture(); data.write_enabled = false;
  data.catalog.materials[0].material_version = '';
  data.rows[0].approval!.snapshot.inputs[0].material_version = '';
  data.rows[0].approval!.snapshot.output_version = '';
  data.rows[0].approval!.snapshot.mold_code = '';
  const f = fixture(data); await f.edit(); await f.changeReason('MES has no material version');
  assert.equal(f.button('저장').props.disabled, true);
  await f.confirmMaterial(); assert.equal(f.button('저장').props.disabled, false);
  f.saveMaterial();
  assert.equal(f.mutations[0].action, 'approve'); assert.equal(f.mutations[0].output_version, undefined);
  assert.equal(f.mutations[0].mold_code, '');
  assert.deepEqual(f.mutations[0].inputs, [{ source_row_id: 'SYN-ROW-1-RAW', material_code: 'SYN-ABS' }]);
  assert.equal(f.mutations[0].bom_hash, 'SYN-HASH-1-A');
  assert.equal(f.calls.length, 0); assert.equal(f.button('선택 工单 MES 생성').props.disabled, true);
});
test('one selected creation is explicit and double gestures are fenced before React renders', async () => {
  const f = fixture(); await f.flush(); assert.equal(f.calls.length, 0);
  await f.select(); const stale = f.button('선택 工单 MES 생성'); stale.props.onClick(); stale.props.onClick(); await f.flush();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].uids, [serviceUid(1)]); assert.deepEqual(f.calls[0].scope, SERVICE_SCOPE);
  assert.equal(f.state().saving, true); assert.equal(f.checkbox().props.disabled, true);
  f.calls[0].reply.resolve([{ uid: serviceUid(1), code: 'SYNTHETIC-WJ-1', state: 'created', mes_id: '12345678901234567', blockers: [] }]);
  await f.flush(); assert.match(f.text(), /생성 성공/); assert.match(f.mesEvidence(), /MES #12345678901234567/);
  assert.equal(f.checkbox().props.disabled, true); assert.equal(f.state().saving, false);
});
test('lost response remains uncertain across stale GET, language and remount; only explicit readback follows', async () => {
  const attempts = new Set<string>(), f = fixture(serviceWorkflowFixture(), attempts); await f.select();
  f.button('선택 工单 MES 생성').props.onClick(); f.calls[0].reply.reject(Error('SYNTHETIC timeout')); await f.flush();
  assert.match(f.text(), /결과 불확실/); assert.equal(f.checkbox().props.disabled, true);
  const next = serviceWorkflowFixture(); next.requests[0].can_recheck = true;
  await f.setData(next); await f.language('zh'); assert.match(f.text(), /结果不确定/); assert.equal(f.calls.length, 1);
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
  assert.ok(!f.elements().some(node => node.type === 'button' && node.props.children === 'MES 생성'));
  const tasks = f.elements().filter(node => node.props.className === 'plan-workflow__task');
  assert.ok(tasks.every(node => !JSON.stringify(node).includes('徐佳')));
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
const createdRows = (uids: string[]) => uids.map((uid,index)=>({uid,code:`SYNTHETIC-WJ-${index+1}`,state:'created',mes_id:`12345678901234${String(index+1).padStart(3,'0')}`,blockers:[]}));
test('seven selections use sequential 3/3/1 requests and immediately show rows and progress throughout one pending sequence', async () => {
  const f=fixture(serviceWorkflowFixture(Array(7).fill('disabled')));
  for(let index=0;index<7;index+=1) await f.select(index);
  const stale=f.button('선택 工单 MES 생성'); stale.props.onClick(); stale.props.onClick(); await f.flush();
  assert.deepEqual(f.calls.map(call=>call.uids),[[1,2,3].map(serviceUid)]);
  assert.deepEqual([...f.attempts],[1,2,3].map(serviceUid)); assert.equal(f.state().saving,true);
  f.calls[0].reply.resolve(createdRows(f.calls[0].uids)); await f.flush();
  assert.deepEqual(f.calls.map(call=>call.uids.length),[3,3]); assert.match(f.text(),/처리 3 \/ 7/);
  assert.match(f.mesEvidence(),/MES #12345678901234001/); assert.equal(f.state().saving,true);
  assert.equal(f.checkbox(6).props.checked,true); assert.equal(f.checkbox(6).props.disabled,true);
  f.calls[1].reply.resolve(f.calls[1].uids.map((uid,index)=>({uid,code:`SYNTHETIC-WJ-${index+4}`,state:index===0?'failed':index===1?'blocked':'created',mes_id:index===2?'12345678901234567':null,blockers:[]}))); await f.flush();
  assert.deepEqual(f.calls.map(call=>call.uids.length),[3,3,1]); assert.match(f.text(),/처리 6 \/ 7/);
  assert.match(f.text(),/생성 실패/); assert.match(f.text(),/생성 차단/); assert.equal(f.state().saving,true);
  f.calls[2].reply.resolve(createdRows(f.calls[2].uids)); await f.flush();
  assert.match(f.text(),/처리 7 \/ 7/); assert.equal(f.state().saving,false); assert.equal(f.calls.length,3);
  assert.ok(f.calls.every(call=>call.options.authSessionId==='SYNTHETIC-WJ-CHUNK-OWNER' && call.options.skipAuthRefresh===true));
});
test('second request timeout preserves first results, marks only that chunk uncertain and leaves the seventh selected without a latch', async () => {
  const f=fixture(serviceWorkflowFixture(Array(7).fill('disabled')));
  for(let index=0;index<7;index+=1) await f.select(index);
  f.button('선택 工单 MES 생성').props.onClick(); f.calls[0].reply.resolve(createdRows(f.calls[0].uids)); await f.flush();
  f.calls[1].reply.reject(Error('SYNTHETIC second request timeout')); await f.flush();
  assert.equal(f.calls.length,2); assert.equal(f.attempts.has(serviceUid(7)),false);
  assert.deepEqual([...f.attempts],[1,2,3,4,5,6].map(serviceUid)); assert.match(f.text(),/처리 3 \/ 7/);
  assert.match(f.text(),/미확인 3건 · 미전송 1건/); assert.match(f.mesEvidence(),/MES #12345678901234001/);
  assert.equal(f.checkbox(0).props.disabled,true); assert.equal(f.checkbox(3).props.disabled,true);
  assert.equal(f.checkbox(6).props.checked,true); assert.equal(f.checkbox(6).props.disabled,false);
  assert.equal(f.button('선택 工单 MES 생성').props.disabled,false); assert.equal(f.state().saving,false);
});
test('login replacement during the second request cannot send the remaining chunk using the replacement account', async () => {
  const f=fixture(serviceWorkflowFixture(Array(7).fill('disabled')));
  for(let index=0;index<7;index+=1) await f.select(index);
  f.button('선택 工单 MES 생성').props.onClick(); f.calls[0].reply.resolve(createdRows(f.calls[0].uids)); await f.flush();
  f.replaceSession(); f.calls[1].reply.resolve(createdRows(f.calls[1].uids)); await f.flush();
  assert.equal(f.calls.length,2); assert.equal(f.attempts.has(serviceUid(7)),false);
  assert.match(f.text(),/미확인 3건 · 미전송 1건/); assert.match(f.mesEvidence(),/MES #12345678901234001/);
  assert.equal(f.checkbox(6).props.checked,true); assert.equal(f.checkbox(6).props.disabled,false);
});

// The row action shares the batch write fence but only submits its own current request.
test('row creation ignores other selected rows and double gestures still dispatch once', async () => {
  const f = fixture(); await f.select(1);
  const rowAction = f.button('MES 생성'); rowAction.props.onClick(); rowAction.props.onClick(); await f.flush();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].uids, [serviceUid(1)]);
  assert.equal(f.checkbox(1).props.checked, true);
  f.calls[0].reply.resolve(createdRows([serviceUid(1)])); await f.flush();
  assert.equal(f.checkbox(0).props.disabled, true); assert.equal(f.checkbox(1).props.checked, true);
  assert.equal(f.calls.length, 1);
});
test('row creation cannot send while material editing owns the draft guard', async () => {
  const f = fixture(); await f.edit(); await f.changeReason('keep material draft');
  assert.equal(f.button('MES 생성').props.disabled, true);
  f.button('MES 생성').props.onClick(); await f.flush();
  assert.equal(f.calls.length, 0); assert.equal(f.reason(), 'keep material draft');
  assert.equal(f.state().dirty, true);
});
test('zero-count queues disappear while a refreshed draft remains reachable outside its former queue', async () => {
  const data = serviceWorkflowFixture(); data.rows[0].approval = null; data.preview[0].blockers = ['material_confirmation'];
  const f = fixture(data); assert.deepEqual(f.stages(), ['all', 'materials', 'issue']);
  await f.queue('materials'); await f.edit(); await f.changeReason('retained outside filter');
  await f.setData(serviceWorkflowFixture());
  assert.deepEqual(f.stages(), ['all', 'issue']); assert.equal(f.reason(), 'retained outside filter');
  assert.equal(f.button('저장').props.disabled, true); assert.equal(f.calls.length, 0);
});

function withSubstitute() {
  const data = serviceWorkflowFixture();
  const substitute = { ...data.catalog.materials[0], key: 'synthetic-substitute', material_id: '3003', material_code: 'SYN-ABS-B' };
  data.catalog.materials.push(substitute);
  return data;
}
function threeRowBom() {
  const source = serviceBomFixture();
  const metal = (index: number) => ({ ...source.inputs[0], source_row_id: `SYN-METAL-ROW-${index}`, seq: String(index),
    material_id: `SYN-METAL-ID-${index}`, material_code: `SYN-METAL-${index}`, material_name: `SYNTHETIC METAL ${index}`,
    unit_id: 'SYN-PIECE-UNIT', unit_name: '个', numerator: String(index + 1),
    category_code: 'CAT-FIXED', category_name: 'Hardware', replaceable: false });
  source.inputs = [metal(1), metal(2), { ...source.inputs[0], seq: '3' }];
  return source;
}
const rawSelects = (f: ReturnType<typeof fixture>) => f.elements().filter(node => node.type === 'select' && String(node.props['aria-label'] || '').startsWith('사용 원료 '));

test('opening an editor reads scoped BOM; replacing the third raw row preserves both fixed hardware rows', async () => {
  const data = withSubstitute(), source = threeRowBom(), f = fixture(data, new Set(), true, true);
  await f.edit();
  assert.deepEqual(f.bomReads.map(read => read.params), [{ ...SERVICE_SCOPE, action: 'bom', plan_id: 1 }]);
  assert.equal(rawSelects(f).length, 0); assert.equal(f.button('저장').props.disabled, true);
  assert.equal(f.elements().some(node => node.props.id === 'plan-material-draft'), false, 'no approval form before BOM read');
  f.bomReads[0].reply.resolve(source); await f.flush();
  assert.equal(f.button('저장').props.disabled, true, 'confirmation before the BOM read is not accepted');
  assert.equal(rawSelects(f).length, 1); assert.equal(rawSelects(f)[0].props['aria-label'], '사용 원료 3. SYN-ABS');
  assert.match(f.text(), /SYN-METAL-1/); assert.match(f.text(), /SYN-METAL-2/);
  assert.equal(f.elements().filter(node => node.type === 'button' && /추가|제거|삭제/.test(String(node.props.children))).length, 0);
  assert.equal(f.elements().filter(node => node.type === 'input' && /배합|분자|분모/.test(String(node.props['aria-label']))).length, 0);
  await f.changeMaterial(0, 'SYN-ABS-B'); await f.changeReason('Keep fixed hardware'); await f.confirmMaterial();
  assert.equal(f.button('저장').props.disabled, false); f.saveMaterial();
  assert.deepEqual(f.mutations[0], { action: 'approve', plan_id: 1, uid: data.rows[0].uid, version: 1,
    bom_hash: source.hash, bom_version: source.version, resource_code: 'SYN-INJ-01', mold_code: 'SYN-MOLD', reason: 'Keep fixed hardware',
    inputs: [{ source_row_id: 'SYN-METAL-ROW-1', material_code: 'SYN-METAL-1' },
      { source_row_id: 'SYN-METAL-ROW-2', material_code: 'SYN-METAL-2' }, { source_row_id: 'SYN-ROW-1-RAW', material_code: 'SYN-ABS-B' }] });
  assert.equal(f.calls.length, 0);
});

test('BOM failure has no legacy fallback; only explicit retry restores an approvable form', async () => {
  const f = fixture(serviceWorkflowFixture(), new Set(), true, true); await f.edit();
  f.bomReads[0].reply.reject(Error('SYNTHETIC BOM read denied')); await f.flush();
  assert.equal(f.elements().some(node => node.props.id === 'plan-material-draft'), false, 'BOM failure offers no fallback form');
  assert.equal(f.mutations.length, 0); assert.equal(rawSelects(f).length, 0);
  assert.match(f.text(), /BOM을 읽지 못했습니다/); assert.equal(f.button('저장').props.disabled, true);
  f.button('BOM 재조회').props.onClick(); await f.flush(); assert.equal(f.bomReads.length, 2);
  f.bomReads[1].reply.resolve(serviceBomFixture()); await f.flush();
  assert.equal(rawSelects(f).length, 1); await f.changeReason('After successful BOM read');
  assert.equal(f.button('저장').props.disabled, true, 'a retry must clear confirmation');
  await f.confirmMaterial(); assert.equal(f.button('저장').props.disabled, false);
  assert.equal(f.calls.length, 0); assert.equal(f.mutations.length, 0);
});

test('late BOM responses cannot replace a newer row draft or repopulate a changed scope', async () => {
  const f = fixture(withSubstitute(), new Set(), true, true); await f.edit(); await f.edit('SYN-PART-2');
  f.bomReads[1].reply.resolve(serviceBomFixture(2)); await f.flush();
  await f.changeMaterial(0, 'SYN-ABS-B'); await f.changeReason('Second row draft');
  f.bomReads[0].reply.resolve(threeRowBom()); await f.flush();
  assert.equal(f.reason(), 'Second row draft'); assert.equal(rawSelects(f)[0].props.value, 'SYN-ABS-B');
  assert.doesNotMatch(f.text(), /SYN-METAL-1/); await f.confirmMaterial(); f.saveMaterial();
  assert.equal(f.mutations[0].plan_id, 2); assert.equal(f.mutations[0].bom_hash, 'SYN-HASH-2-A');
  const g = fixture(serviceWorkflowFixture(), new Set(), true, true); await g.edit(); await g.scopeType('machining');
  g.bomReads[0].reply.resolve(threeRowBom()); await g.flush();
  assert.equal(rawSelects(g).length, 0); assert.equal(g.elements().some(node => node.props.id === 'plan-material-draft'), false);
  await g.edit(); assert.equal(g.bomReads[1].params.plan_type, 'machining');
});

test('legacy approvals never seed replacements; only an exact current BOM hash restores selected source rows', async () => {
  for (const match of ['legacy', 'changed', 'same']) {
    const data = withSubstitute(), source = serviceBomFixture();
    const snapshot = data.rows[0].approval!.snapshot;
    snapshot.inputs[0].material_code = 'SYN-ABS-B'; snapshot.inputs[0].source_row_id = 'SYN-ROW-1-RAW';
    if (match !== 'legacy') snapshot.bom_source = { ...source, hash: match === 'same' ? source.hash : 'OLD-HASH' };
    const f = fixture(data); await f.edit();
    assert.equal(rawSelects(f)[0].props.value, match === 'same' ? 'SYN-ABS-B' : 'SYN-ABS', match);
    assert.equal(f.button('저장').props.disabled, true, 'restoration never auto confirms');
  }
});

test('409 preserves substitutions and reason until explicit latest BOM review, then requires confirmation again', async () => {
  const f = fixture(withSubstitute(), new Set(), true, true); await f.edit();
  f.bomReads[0].reply.resolve(threeRowBom()); await f.flush(); await f.changeMaterial(0, 'SYN-ABS-B');
  await f.changeReason('Replacement draft'); await f.confirmMaterial(); f.saveMaterial();
  await f.mutationError(409);
  assert.equal(f.reason(), 'Replacement draft'); assert.equal(rawSelects(f)[0].props.value, 'SYN-ABS-B');
  assert.equal(rawSelects(f)[0].props.disabled, true); assert.equal(f.button('저장').props.disabled, true);
  assert.equal(f.bomReads.length, 1); f.saveMaterial(); assert.equal(f.mutations.length, 1);
  f.button('최신 계획 확인').props.onClick(); await f.flush(); assert.equal(f.bomReads.length, 2);
  const next = threeRowBom(); next.hash = 'SYN-UPDATED-HASH'; next.version = 'B'; next.setup.bom_version = 'B';
  next.inputs[0].numerator = '7';
  f.bomReads[1].reply.resolve(next); await f.flush();
  assert.equal(f.reason(), 'Replacement draft'); assert.equal(rawSelects(f)[0].props.value, 'SYN-ABS');
  assert.match(f.text(), /7\s+个\s+\/\s+1\s+个/); assert.equal(f.button('저장').props.disabled, true);
  await f.confirmMaterial(); f.saveMaterial(); assert.equal(f.mutations[1].bom_hash, 'SYN-UPDATED-HASH');
  assert.equal(f.mutations[1].bom_version, 'B'); assert.equal(f.calls.length, 0);
});

test('same-hash explicit review keeps the draft, and trusted setup fields remain readonly', async () => {
  const f = fixture(withSubstitute()); await f.edit(); await f.changeMaterial(0, 'SYN-ABS-B');
  await f.changeReason('Keep selection'); await f.mutationError(409);
  f.button('최신 계획 확인').props.onClick(); await f.flush();
  assert.equal(rawSelects(f)[0].props.value, 'SYN-ABS-B'); assert.equal(f.reason(), 'Keep selection');
  const settings = f.elements().find(node => node.props.className === 'plan-workflow__fields'); assert.ok(settings);
  const setupInputs = nodes(settings).filter(node => node.type === 'input');
  assert.equal(setupInputs.filter(node => node.props.readOnly).length, 7);
  assert.equal(setupInputs.filter(node => !node.props.readOnly).length, 2);
  assert.equal(f.button('저장').props.disabled, true);
});

test('invalid required quantities and a mismatched product BOM cannot be approved', async () => {
  for (const failure of ['invalid-ratio', 'wrong-product']) {
    const f = fixture(serviceWorkflowFixture(), new Set(), true, true); await f.edit();
    const source = serviceBomFixture();
    if (failure === 'invalid-ratio') source.inputs[0].denominator = '0'; else source.part_no = 'UNRELATED-PART';
    f.bomReads[0].reply.resolve(source); await f.flush();
    if (failure === 'invalid-ratio') { await f.changeReason('Invalid source'); await f.confirmMaterial(); f.saveMaterial(); }
    assert.equal(f.button('저장').props.disabled, true); assert.equal(f.mutations.length, 0);
    if (failure === 'wrong-product') assert.equal(rawSelects(f).length, 0);
  }
});


test('failed conflict reload hides approval controls and keeps the full draft for the explicit retry', async () => {
  const f = fixture(withSubstitute(), new Set(), true, true); await f.edit();
  f.bomReads[0].reply.resolve(threeRowBom()); await f.flush(); await f.changeMaterial(0, 'SYN-ABS-B');
  await f.changeReason('Keep draft through reload error'); await f.confirmMaterial(); await f.mutationError(409);
  f.button('최신 계획 확인').props.onClick(); await f.flush(); f.bomReads[1].reply.reject(Error('SYNTHETIC read failure')); await f.flush();
  assert.equal(f.elements().some(node => node.props.id === 'plan-material-draft'), false);
  assert.equal(rawSelects(f).length, 0); assert.equal(f.button('저장').props.disabled, true);
  f.button('BOM 재조회').props.onClick(); await f.flush(); f.bomReads[2].reply.resolve(threeRowBom()); await f.flush();
  assert.equal(f.reason(), 'Keep draft through reload error'); assert.equal(rawSelects(f)[0].props.value, 'SYN-ABS-B');
  assert.equal(f.button('저장').props.disabled, true); await f.confirmMaterial(); assert.equal(f.button('저장').props.disabled, false);
  assert.equal(f.mutations.length, 0); assert.equal(f.calls.length, 0);
});
