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
  const calls: PostCall[] = [], replies: ReturnType<typeof deferred>[] = [], fences: (string | null)[] = [];
  const exports: {
    sendPlanRequests: (scope: typeof SCOPE, uids: readonly string[]) => Promise<service.PlanServiceResult[]>;
    recheckPlanRequest: (scope: typeof SCOPE, uid: string) => Promise<service.PlanServiceResult>;
  } = {} as typeof exports;
  const modules: Record<string, unknown> = {
    '@/shared/api/http': { http: { post(path: string, body: unknown, options: PostOptions) {
      calls.push({ path, body, options });
      const reply = deferred(); replies.push(reply); return reply.promise;
    } } },
    '@/domains/auth/auth-storage': { getAuthSessionSnapshot: () => ({ id: snapshotSession === undefined ? currentSession : snapshotSession }) },
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
    replaceSession: () => { currentSession = 'SYNTHETIC-REPLACEMENT-SESSION'; },
    staleSnapshot: () => { snapshotSession = 'SYNTHETIC-STALE-SESSION'; },
    noSession: () => { currentSession = null; },
  };
}

function response(patch: Record<string, unknown> = {}) {
  return { results: [{ uid: UID, code: 'WJ-SYNTHETIC-PLAN', state: 'created', mes_id: MES_ID,
    blockers: [], ...patch }] };
}

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
  for (const selected of [[], [UID, UID], ['invalid'], Array.from({ length: 51 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)]) {
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
