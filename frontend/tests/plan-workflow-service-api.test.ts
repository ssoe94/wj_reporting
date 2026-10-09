import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as service from '../src/domains/production/plan-workflow-service.ts';

const UID = '00000000-0000-4000-8000-000000000001';
const OTHER_UID = '00000000-0000-4000-8000-000000000002';
const MES_ID = '17000000000000001';
const SCOPE = { start: '2026-10-08', end: '2026-10-10', plan_type: 'injection' as const };
const INITIAL_SESSION = 'SYNTHETIC-SERVICE-PLAN-SESSION';
type PostOptions = { authSessionId: string | null; skipAuthRefresh: boolean };
type PostCall = { path: string; body: unknown; options: PostOptions };
type SelectionCallbacks = {
  beforeChunk?: (uids: readonly string[]) => void;
  onChunk?: (results: service.PlanServiceResult[], completed: number, total: number) => void;
};
type SelectionOutcome = { completed: number; total: number; attempted: number;
  uncertainUids: string[]; remainingUids: string[]; stopped: boolean };
function uid(index: number) { return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`; }
function tick() { return new Promise<void>(resolve => setImmediate(resolve)); }

function deferred() {
  let resolve!: (response: { data: unknown }) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ data: unknown }>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const compiled = ts.transpileModule(readFileSync(new URL('../src/domains/production/plan-workflow-service-api.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let currentSession: string | null = INITIAL_SESSION;
  let snapshotSession: string | null | undefined;
  let snapshotReads = 0;
  const calls: PostCall[] = [], replies: ReturnType<typeof deferred>[] = [], fences: (string | null)[] = [];
  const exports: {
    sendPlanRequests: (scope: typeof SCOPE, uids: readonly string[]) => Promise<service.PlanServiceResult[]>;
    sendPlanSelection: (scope: typeof SCOPE, uids: readonly string[], callbacks?: SelectionCallbacks) => Promise<SelectionOutcome>;
    recheckPlanRequest: (scope: typeof SCOPE, uid: string) => Promise<service.PlanServiceResult>;
  } = {} as typeof exports;
  const modules: Record<string, unknown> = {
    '@/shared/api/http': { http: { post(path: string, body: unknown, options: PostOptions) {
      calls.push({ path, body, options });
      const reply = deferred(); replies.push(reply); return reply.promise;
    } } },
    '@/domains/auth/auth-storage': { getAuthSessionSnapshot: () => {
      snapshotReads += 1;
      return { id: snapshotSession === undefined ? currentSession : snapshotSession };
    } },
    '@/domains/auth/auth-transition': { assertAuthSessionCurrent: (session: string | null) => {
      fences.push(session);
      if (!session || session !== currentSession) throw Error('SYNTHETIC authenticated session changed');
    } },
    './plan-workflow-service': service,
  };
  new Function('require', 'exports', compiled)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Only synthetic dependencies allowed: ${name}`);
    return modules[name];
  }, exports);
  return { api: exports, calls, replies, fences,
    get snapshotReads() { return snapshotReads; },
    replaceSession: () => { currentSession = 'SYNTHETIC-REPLACEMENT-SESSION'; },
    staleSnapshot: () => { snapshotSession = 'SYNTHETIC-STALE-SESSION'; },
    noSession: () => { currentSession = null; },
  };
}

function response(patch: Record<string, unknown> = {}) {
  return { results: [{ uid: UID, code: 'WJ-SYNTHETIC-PLAN', state: 'created', mes_id: MES_ID,
    blockers: [], ...patch }] };
}

function chunkResponse(uids: readonly string[], states: readonly string[] = []) {
  return { results: uids.map((requestUid, index) => {
    const state = states[index] ?? 'created';
    return { uid: requestUid, work_order_code: `WJ-SYNTHETIC-${requestUid.slice(-12)}`, state,
      mes_id: ['created', 'already_exists'].includes(state) ? MES_ID : '',
      blockers: state === 'failed' ? ['permission_required'] : state === 'blocked' ? ['material_confirmation'] : [] };
  }) };
}

test('selection sends 3/3/1 strictly in sequence under one initial session and preserves each completed callback', async () => {
  const f = fixture(), selected = Array.from({ length: 7 }, (_, index) => uid(index + 1));
  const original = [...selected], scope = { ...SCOPE };
  const dispatched: string[][] = [], completed: { rows: service.PlanServiceResult[]; count: number; total: number }[] = [];
  const pending = f.api.sendPlanSelection(scope, selected, {
    beforeChunk: chunk => {
      assert.equal(f.calls.length, dispatched.length, 'dispatch hook runs immediately before its own POST');
      dispatched.push([...chunk]);
      (chunk as string[])[0] = uid(99);
    },
    onChunk: (rows, count, total) => completed.push({ rows, count, total }),
  });
  assert.equal(f.calls.length, 1, 'later requests wait for the current response');
  assert.deepEqual(dispatched, [original.slice(0, 3)]);
  selected[0] = OTHER_UID; scope.start = '2026-12-31';
  f.replies[0].resolve({ data: chunkResponse(original.slice(0, 3), ['created', 'already_exists', 'failed']) });
  await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].rows.map(row => row.state), ['created', 'already_exists', 'failed']);
  assert.equal(completed[0].rows[0].mes_id, MES_ID);
  f.replies[1].resolve({ data: chunkResponse(original.slice(3, 6), ['blocked', 'failed', 'created']) });
  await tick();
  assert.equal(f.calls.length, 3, 'valid HTTP 200 failed and blocked rows do not abort independent later requests');
  f.replies[2].resolve({ data: chunkResponse(original.slice(6)) });
  const outcome = await pending;
  assert.deepEqual(outcome, { completed: 7, total: 7, attempted: 7,
    uncertainUids: [], remainingUids: [], stopped: false });
  assert.deepEqual(completed.map(chunk => [chunk.count, chunk.total]), [[3, 7], [6, 7], [7, 7]]);
  assert.deepEqual(completed.flatMap(chunk => chunk.rows.map(row => row.uid)), original);
  assert.deepEqual(dispatched, [original.slice(0, 3), original.slice(3, 6), original.slice(6)]);
  assert.deepEqual(f.calls.map(call => call.body), [original.slice(0, 3), original.slice(3, 6), original.slice(6)]
    .map(request_uids => ({ ...SCOPE, action: 'send', request_uids })));
  f.calls.forEach(call => assert.deepEqual(call.options, { authSessionId: INITIAL_SESSION, skipAuthRefresh: true }));
  assert.equal(f.snapshotReads, 1, 'the orchestrator never adopts a replacement owner between chunks');
});

test('a fifty-item selection sends seventeen bounded requests while fifty-one and cross-chunk duplicates cause zero HTTP', async () => {
  const selected = Array.from({ length: 50 }, (_, index) => uid(index + 1)), chunks = service.splitPlanSelection(selected);
  const f = fixture(), progress: number[] = [];
  const pending = f.api.sendPlanSelection(SCOPE, selected, { onChunk: (_rows, count) => progress.push(count) });
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(f.calls.length, index + 1, 'only one request is in flight at a time');
    assert.deepEqual((f.calls[index].body as { request_uids: string[] }).request_uids, chunk);
    f.replies[index].resolve({ data: chunkResponse(chunk) });
    await tick();
  }
  assert.deepEqual(await pending, { completed: 50, total: 50, attempted: 50,
    uncertainUids: [], remainingUids: [], stopped: false });
  assert.equal(f.calls.length, 17);
  assert.equal(progress.at(-1), 50);
  assert.equal(f.snapshotReads, 1);
  const alphaUid = 'abcdef00-0000-4000-8000-000000000001';
  for (const selection of [[], ['invalid'], [UID, UID], [UID, OTHER_UID, uid(3), UID],
    [alphaUid, alphaUid.toUpperCase()], Array.from({ length: 51 }, (_, index) => uid(index + 1))]) {
    const invalid = fixture(); let hooks = 0;
    await assert.rejects(invalid.api.sendPlanSelection(SCOPE, selection, {
      beforeChunk: () => { hooks += 1; }, onChunk: () => { hooks += 1; },
    }));
    assert.equal(invalid.calls.length, 0); assert.equal(invalid.snapshotReads, 0); assert.equal(hooks, 0);
  }
});

test('a second timeout, 401 or malformed response retains first results and leaves the third chunk completely unattempted', async () => {
  const selected = Array.from({ length: 7 }, (_, index) => uid(index + 1));
  const cases = [
    { error: Error('SYNTHETIC timeout') }, { error: { response: { status: 401 } } },
    { error: { response: { status: 504 } } }, { data: null },
    { data: chunkResponse([uid(4), uid(5)]) },
    { data: chunkResponse([uid(4), uid(4), uid(6)]) },
    { data: chunkResponse([uid(4), uid(5), uid(99)]) },
    { data: { results: chunkResponse(selected.slice(3, 6)).results.map(row => ({ ...row, mes_id: Number(MES_ID) })) } },
  ];
  for (const failure of cases) {
    const f = fixture(), dispatched: string[][] = [], completed: service.PlanServiceResult[][] = [];
    const pending = f.api.sendPlanSelection(SCOPE, selected, {
      beforeChunk: chunk => dispatched.push([...chunk]), onChunk: rows => completed.push(rows),
    });
    f.replies[0].resolve({ data: chunkResponse(selected.slice(0, 3)) });
    await tick();
    if ('error' in failure) f.replies[1].reject(failure.error);
    else f.replies[1].resolve({ data: failure.data });
    const outcome = await pending;
    assert.deepEqual(outcome, { completed: 3, total: 7, attempted: 6,
      uncertainUids: selected.slice(3, 6), remainingUids: selected.slice(6), stopped: true });
    assert.equal(f.calls.length, 2, 'neither an ambiguous chunk nor the remainder is automatically replayed');
    assert.deepEqual(dispatched, [selected.slice(0, 3), selected.slice(3, 6)]);
    assert.deepEqual(completed.flatMap(rows => rows.map(row => row.uid)), selected.slice(0, 3));
    assert.equal(f.snapshotReads, 1);
    f.calls.forEach(call => assert.equal(call.options.skipAuthRefresh, true));
  }
});

test('an owner change between chunks stops before the next dispatch hook without adopting the replacement login', async () => {
  const f = fixture(), selected = Array.from({ length: 7 }, (_, index) => uid(index + 1));
  const dispatched: string[][] = [], completed: service.PlanServiceResult[][] = [];
  const pending = f.api.sendPlanSelection(SCOPE, selected, {
    beforeChunk: chunk => dispatched.push([...chunk]),
    onChunk: rows => { completed.push(rows); f.replaceSession(); },
  });
  f.replies[0].resolve({ data: chunkResponse(selected.slice(0, 3)) });
  assert.deepEqual(await pending, { completed: 3, total: 7, attempted: 3,
    uncertainUids: [], remainingUids: selected.slice(3), stopped: true });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(dispatched, [selected.slice(0, 3)]);
  assert.deepEqual(completed[0].map(row => row.uid), selected.slice(0, 3));
  assert.equal(f.snapshotReads, 1);
});

test('a replacement session during either response makes only that dispatched chunk uncertain and preserves earlier callbacks', async () => {
  const selected = Array.from({ length: 7 }, (_, index) => uid(index + 1));
  for (const replacementChunk of [0, 1]) {
    const f = fixture(), completed: service.PlanServiceResult[][] = [], dispatched: string[][] = [];
    const pending = f.api.sendPlanSelection(SCOPE, selected, {
      beforeChunk: chunk => dispatched.push([...chunk]), onChunk: rows => completed.push(rows),
    });
    if (replacementChunk === 1) {
      f.replies[0].resolve({ data: chunkResponse(selected.slice(0, 3)) });
      await tick();
    }
    f.replaceSession();
    const start = replacementChunk * 3;
    f.replies[replacementChunk].resolve({ data: chunkResponse(selected.slice(start, start + 3)) });
    assert.deepEqual(await pending, { completed: start, total: 7, attempted: start + 3,
      uncertainUids: selected.slice(start, start + 3), remainingUids: selected.slice(start + 3), stopped: true });
    assert.equal(f.calls.length, replacementChunk + 1);
    assert.equal(dispatched.length, replacementChunk + 1);
    assert.equal(completed.length, replacementChunk);
    assert.deepEqual(completed.flatMap(rows => rows.map(row => row.uid)), selected.slice(0, start));
    assert.equal(f.snapshotReads, 1);
  }
});

test('missing or stale initial ownership stops a valid selection before all dispatch hooks and HTTP calls', async () => {
  const selected = Array.from({ length: 7 }, (_, index) => uid(index + 1));
  for (const mutation of ['staleSnapshot', 'noSession'] as const) {
    const f = fixture(); f[mutation](); let hooks = 0;
    const outcome = await f.api.sendPlanSelection(SCOPE, selected, {
      beforeChunk: () => { hooks += 1; }, onChunk: () => { hooks += 1; },
    });
    assert.deepEqual(outcome, { completed: 0, total: 7, attempted: 0,
      uncertainUids: [], remainingUids: selected, stopped: true });
    assert.equal(f.calls.length, 0); assert.equal(hooks, 0); assert.equal(f.snapshotReads, 1);
  }
});

test('send POST binds the selected request snapshot to its captured WJ session and disables auth-refresh replay', async () => {
  const f = fixture(), selected = [UID];
  const pending = f.api.sendPlanRequests(SCOPE, selected);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { path: '/production/plan-workflow/',
    body: { ...SCOPE, action: 'send', request_uids: [UID] },
    options: { authSessionId: INITIAL_SESSION, skipAuthRefresh: true } });
  f.replies[0].resolve({ data: response({ work_order_code: 'WJ-SYNTHETIC-CANONICAL',
    access_token: 'SYNTHETIC_APP_SECRET', raw: { token: 'SYNTHETIC_APP_SECRET' } }) });
  const rows = await pending;
  assert.equal(rows[0].mes_id, MES_ID);
  assert.equal(rows[0].state, 'created');
  assert.equal(rows[0].code, 'WJ-SYNTHETIC-CANONICAL');
  assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_APP_SECRET'));
  assert.deepEqual(f.fences, [INITIAL_SESSION, INITIAL_SESSION]);
});

test('recheck POST has a separate explicit action and the same no-replay session fencing', async () => {
  const f = fixture(), pending = f.api.recheckPlanRequest(SCOPE, UID);
  assert.deepEqual(f.calls[0], { path: '/production/plan-workflow/',
    body: { ...SCOPE, action: 'recheck', request_uid: UID },
    options: { authSessionId: INITIAL_SESSION, skipAuthRefresh: true } });
  const readback = { uid: UID, work_order_code: 'WJ-SYNTHETIC-PLAN', state: 'uncertain',
    mes_id: MES_ID, blockers: ['readback_required'], access_token: 'SYNTHETIC_READBACK_SECRET' };
  f.replies[0].resolve({ data: readback });
  const projected = await pending;
  assert.deepEqual(projected, { uid: UID, code: 'WJ-SYNTHETIC-PLAN', state: 'uncertain',
    mes_id: MES_ID, blockers: ['readback_required'] });
  assert.ok(!JSON.stringify(projected).includes('SYNTHETIC_READBACK_SECRET'));
  assert.deepEqual(f.fences, [INITIAL_SESSION, INITIAL_SESSION]);
  assert.equal(f.calls.length, 1);
});

test('invalid batch or UID and a stale or missing session are rejected before any HTTP request', async () => {
  const invalid = fixture();
  for (const selected of [[], [UID, UID], ['invalid'], Array.from({ length: 4 }, (_, index) => uid(index + 1))]) {
    await assert.rejects(invalid.api.sendPlanRequests(SCOPE, selected));
  }
  await assert.rejects(invalid.api.recheckPlanRequest(SCOPE, 'invalid'));
  assert.equal(invalid.calls.length, 0);
  for (const action of ['send', 'recheck']) {
    for (const mutation of ['staleSnapshot', 'noSession'] as const) {
      const f = fixture(); f[mutation]();
      await assert.rejects(action === 'send' ? f.api.sendPlanRequests(SCOPE, [UID]) : f.api.recheckPlanRequest(SCOPE, UID),
        /authenticated session changed/);
      assert.equal(f.calls.length, 0);
    }
  }
});

test('a replacement login fences a late send or readback response without accepting or replaying it', async () => {
  for (const action of ['send', 'recheck']) {
    const f = fixture();
    const pending = action === 'send' ? f.api.sendPlanRequests(SCOPE, [UID]) : f.api.recheckPlanRequest(SCOPE, UID);
    f.replaceSession();
    f.replies[0].resolve({ data: action === 'send' ? response() : {
      uid: UID, work_order_code: 'WJ-SYNTHETIC-PLAN', state: 'created', mes_id: MES_ID, blockers: [],
    } });
    await assert.rejects(pending, /authenticated session changed/);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.fences, [INITIAL_SESSION, INITIAL_SESSION]);
  }
});

test('401 and uncertain transport failures propagate after exactly one explicit POST', async () => {
  for (const action of ['send', 'recheck']) {
    for (const error of [{ response: { status: 401 } }, { response: { status: 504 } }, Error('SYNTHETIC timeout')]) {
      const f = fixture();
      const pending = action === 'send' ? f.api.sendPlanRequests(SCOPE, [UID]) : f.api.recheckPlanRequest(SCOPE, UID);
      f.replies[0].reject(error);
      await assert.rejects(pending, caught => caught === error);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].options.skipAuthRefresh, true);
    }
  }
});

test('a malformed or mismatched readback response cannot confirm another request or cause an automatic POST replay', async () => {
  const valid = { uid: UID, work_order_code: 'WJ-SYNTHETIC-PLAN', state: 'created', mes_id: MES_ID, blockers: [] };
  for (const data of [null, [], {}, { ...valid, uid: undefined }, { ...valid, uid: OTHER_UID },
    { ...valid, uid: 'invalid' }, { ...valid, state: 'finished' }, { ...valid, mes_id: Number(MES_ID) },
    { ...valid, blockers: undefined }, { ...valid, blockers: ['Raw provider secret'] }]) {
    const f = fixture(), pending = f.api.recheckPlanRequest(SCOPE, UID);
    f.replies[0].resolve({ data });
    await assert.rejects(pending);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.skipAuthRefresh, true);
  }
});

test('rounded identifiers, incomplete batches and unrelated partial outcomes reject without an automatic replacement send', async () => {
  for (const [selected, data] of [
    [[UID], response({ mes_id: Number(MES_ID) })],
    [[UID, OTHER_UID], response()],
    [[UID], response({ uid: OTHER_UID })],
  ] as const) {
    const f = fixture(), pending = f.api.sendPlanRequests(SCOPE, selected);
    f.replies[0].resolve({ data });
    await assert.rejects(pending);
    assert.equal(f.calls.length, 1);
  }
});
