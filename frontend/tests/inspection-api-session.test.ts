import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import type { InspectionAction, MutationAttempt } from '../src/pages/quality/inspection-requests/workflow.ts';
import { parseInspectionAccess } from '../src/domains/auth/inspection-beta-access.ts';
import { parseMesDetailPreview } from '../src/pages/quality/inspection-requests/mesDetailPreviewModel.ts';
import { parseInspectionRoleSettings } from '../src/pages/quality/inspection-requests/roleModel.ts';
import type { InspectionRoleAttempt } from '../src/pages/quality/inspection-requests/roleModel.ts';
import { previewFixture } from './fixtures/mes-detail-preview.ts';

const SESSION_A = 'SYNTHETIC-INSPECTION-SESSION-A';
const SESSION_B = 'SYNTHETIC-INSPECTION-SESSION-B';
const BASE = '/quality/inspection-requests/';
const DATE = '2026-10-04';
type SessionId = string | null | undefined;
type Response = { status: number; data: unknown };
type Config = { authSessionId?: SessionId; params?: Record<string, unknown>; headers?: Record<string, string>; signal?: AbortSignal };
type Call = { method: string; url: string; payload?: unknown; config?: Config };
type InspectionApi = {
  getInspectionRoleSettings: (sessionId: SessionId) => Promise<unknown>;
  saveInspectionRoleSetting: (id: number | null, payload: Record<string, unknown>, key: string, sessionId: SessionId, expectedActorId: number) => Promise<unknown>;
  mutateInspectionRole: (id: number, attempt: InspectionRoleAttempt, sessionId: SessionId) => Promise<unknown>;
  getMesDetailPreview: (sessionId: SessionId, signal?: AbortSignal) => Promise<unknown>;
  getInspectionCapabilities: (sessionId: SessionId) => Promise<unknown>;
  getInspectionRequests: (search: string, status: string, page: number, sessionId: SessionId) => Promise<unknown>;
  getInspectionKanban: (date: string, sessionId: SessionId) => Promise<unknown>;
  getInspectionRequest: (id: number, sessionId: SessionId) => Promise<unknown>;
  createIntegrationTrial: (attempt: MutationAttempt, sessionId: SessionId) => Promise<unknown>;
  mutateInspectionRequest: (id: number, attempt: MutationAttempt, sessionId: SessionId) => Promise<unknown>;
};

// Execute the production API body with injected dependencies. This does not import
// the browser HTTP client, read auth storage, or issue a real HTTP request.
const apiSource = stripTypeScriptTypes(readFileSync(new URL('../src/pages/quality/inspection-requests/api.ts', import.meta.url), 'utf8'))
  .replace(/^import\s[\s\S]*?;\s*/gm, '')
  .replace(/^export\s+\*\s+from\s+[^;]+;\s*/gm, '')
  .replace(/^export\s+/gm, '');
const instantiateApi = new Function('http', 'assertAuthSessionCurrent', 'validateInspectionKanban', 'parseInspectionAccess', 'parseMesDetailPreview', 'parseInspectionRoleSettings', `${apiSource}\nreturn {
  getMesDetailPreview, getInspectionRoleSettings, saveInspectionRoleSetting, mutateInspectionRole,
  getInspectionCapabilities, getInspectionRequests, getInspectionKanban,
  getInspectionRequest, mutateInspectionRequest, createIntegrationTrial,
};`);

function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function scenario(reply: () => Promise<Response>, currentSessionId: SessionId = SESSION_A) {
  const state = { sessionId: currentSessionId };
  const calls: Call[] = [];
  const assertions: SessionId[] = [];
  const validations: { data: unknown; date: string }[] = [];
  const staleSession = new Error('SYNTHETIC stale inspection session');
  const http = {
    get: (url: string, config?: Config) => { calls.push({ method: 'get', url, config }); return reply(); },
    post: (url: string, payload: unknown, config?: Config) => { calls.push({ method: 'post', url, payload, config }); return reply(); },
    patch: (url: string, payload: unknown, config?: Config) => { calls.push({ method: 'patch', url, payload, config }); return reply(); },
  };
  const api = instantiateApi(http, (sessionId: SessionId) => {
    assertions.push(sessionId);
    if (!sessionId || sessionId !== state.sessionId) throw staleSession;
  }, (data: unknown, date: string) => {
    validations.push({ data, date });
    return data;
  }, parseInspectionAccess, parseMesDetailPreview, parseInspectionRoleSettings) as InspectionApi;
  return { api, state, calls, assertions, validations, staleSession };
}

type Operation = {
  name: string;
  invoke: (api: InspectionApi, sessionId: SessionId) => Promise<unknown>;
  expected: Call;
  result: unknown; returned?: unknown;
};

function settingMutationResponse(id: number, version = 1, actorId = 101) {
  const setting = { id, version, code: 'SYNTHETIC-UNSET', label: 'SYNTHETIC-DRAFT', timezone: 'Asia/Shanghai', start_time: null, end_time: null, appearance_assignee: null, dimension_assignee: null, active: false, effective_from: null, effective_until: null, effective_from_local: null, effective_until_local: null };
  return { settings: [{ ...setting }], candidates: [{ id: 101, username: 'SYNTHETIC-ADMIN', name: 'SYNTHETIC-ADMIN', mes_user_id: null }], can_configure: true, setting, actor_id: actorId };
}
const reads: Operation[] = [
  { name: 'role settings', invoke: (api, sessionId) => api.getInspectionRoleSettings(sessionId), expected: { method: 'get', url: `${BASE}role-settings/`, config: { authSessionId: SESSION_A } }, result: { settings: [], candidates: [], can_configure: true } },
  { name: 'MES metadata preview', invoke: (api, sessionId) => api.getMesDetailPreview(sessionId),
    expected: { method: 'get', url: `${BASE}mes-detail-preview/`, config: { authSessionId: SESSION_A, signal: undefined } }, result: previewFixture() },
  { name: 'capabilities', invoke: (api, sessionId) => api.getInspectionCapabilities(sessionId),
    expected: { method: 'get', url: `${BASE}capabilities/`, config: { authSessionId: SESSION_A } }, result: { can_view: true, can_manage: true, can_submit: true, can_review: true, access_scope: 'all', can_view_kanban: true } },
  { name: 'request list', invoke: (api, sessionId) => api.getInspectionRequests('SYNTHETIC', 'draft', 3, sessionId),
    expected: { method: 'get', url: BASE, config: { params: { search: 'SYNTHETIC', status: 'draft', page: 3 }, authSessionId: SESSION_A } }, result: { count: 0, results: [] } },
  { name: 'kanban', invoke: (api, sessionId) => api.getInspectionKanban(DATE, sessionId),
    expected: { method: 'get', url: `${BASE}kanban/`, config: { params: { date: DATE }, authSessionId: SESSION_A } }, result: { synthetic: 'kanban' } },
  { name: 'request detail', invoke: (api, sessionId) => api.getInspectionRequest(42, sessionId),
    expected: { method: 'get', url: `${BASE}42/`, config: { authSessionId: SESSION_A } }, result: { id: 42, version: 3 } },
];
const actions: InspectionAction[] = ['create', 'save', 'submit', 'approve', 'reject', 'reinspect', 'refresh', 'sync', 'mes-save', 'mes-finish', 'mes-reconcile', 'review-failure'];
const mutations: Operation[] = actions.map((action) => {
  const attempt: MutationAttempt = { action, key: `SYNTHETIC-IDEMPOTENCY-${action}`, payload: { version: 3, notes: 'SYNTHETIC fixture' } };
  return {
    name: action,
    invoke: (api, sessionId) => api.mutateInspectionRequest(42, attempt, sessionId),
    expected: {
      method: action === 'save' ? 'patch' : 'post',
      url: action === 'create' ? BASE : action === 'save' ? `${BASE}42/` : `${BASE}42/${action}/`,
      payload: attempt.payload,
      config: { headers: { 'Idempotency-Key': attempt.key }, authSessionId: SESSION_A },
    },
    result: { id: action === 'create' || action === 'reinspect' ? 77 : 42, version: 4 },
  };
});
const trialAttempt: MutationAttempt = { action: 'create', key: 'SYNTHETIC-TRIAL-KEY', payload: { code: 'WJ-IT-SYNTHETIC-01', inspection_items: [] } };
mutations.push({ name: 'integration trial preparation', invoke: (api, sessionId) => api.createIntegrationTrial(trialAttempt, sessionId),
  expected: { method: 'post', url: `${BASE}integration-trial/`, payload: trialAttempt.payload,
    config: { authSessionId: SESSION_A, headers: { 'Idempotency-Key': trialAttempt.key } } }, result: { id: 77, source_kind: 'integration_test' } });
for (const action of ['role-configure', 'area-save', 'area-complete', 'area-reopen', 'role-results'] as const) {
  const attempt: InspectionRoleAttempt = { action, key: `SYNTHETIC-${action}`, payload: { config_version: 1, area_version: 2 } };
  mutations.push({ name: action, invoke: (api, sessionId) => api.mutateInspectionRole(42, attempt, sessionId), expected: { method: 'post', url: `${BASE}42/${action}/`, payload: attempt.payload, config: { authSessionId: SESSION_A, headers: { 'Idempotency-Key': attempt.key } } }, result: { id: 42, role_workflow: { mode: 'roles' } } });
}
for (const id of [null, 9]) {
  const payload = { label: 'SYNTHETIC-DRAFT', active: false };
  const response = settingMutationResponse(id || 10, id === null ? 1 : 2);
  mutations.push({ name: `role setting ${id === null ? 'create' : 'update'}`, invoke: (api, sessionId) => api.saveInspectionRoleSetting(id, payload, 'SYNTHETIC-SETTING-KEY', sessionId, 101), expected: { method: id === null ? 'post' : 'patch', url: `${BASE}role-settings/${id === null ? '' : `${id}/`}`, payload, config: { authSessionId: SESSION_A, headers: { 'Idempotency-Key': 'SYNTHETIC-SETTING-KEY' } } }, result: response, returned: response.setting });
}
const operations = [...reads, ...mutations];

test('exact backend nested setting create/update responses return only the validated setting', async () => {
  for (const [id, status, version] of [[null, 201, 1], [9, 200, 2]] as const) {
    const response = settingMutationResponse(id || 10, version);
    const fixture = scenario(async () => ({ status, data: response }));
    const payload = id === null ? { code: 'SYNTHETIC-UNSET', label: 'SYNTHETIC-DRAFT' }
      : { version: 1, label: 'SYNTHETIC-DRAFT', reason: 'SYNTHETIC future setting only' };
    const result = await fixture.api.saveInspectionRoleSetting(id, payload, 'SYNTHETIC-NESTED-KEY', SESSION_A, 101);
    assert.equal(result, response.setting);
    assert.equal('actor_id' in (result as object), false);
    assert.equal('settings' in (result as object), false);
    assert.deepEqual(fixture.calls, [{ method: id === null ? 'post' : 'patch', url: `${BASE}role-settings/${id === null ? '' : `${id}/`}`,
      payload, config: { authSessionId: SESSION_A, headers: { 'Idempotency-Key': 'SYNTHETIC-NESTED-KEY' } } }]);
    assert.deepEqual(fixture.assertions, [SESSION_A, SESSION_A]);
  }
});
test('setting mutations require an explicit current actor before dispatch and reject a different response actor', async () => {
  for (const actor of [undefined, null, 0, -1, 101.5, '101']) {
    const fixture = scenario(async () => ({ status: 201, data: settingMutationResponse(10) }));
    await assert.rejects(fixture.api.saveInspectionRoleSetting(null, {}, 'SYNTHETIC-KEY', SESSION_A, actor as number), /actor identity required/);
    assert.equal(fixture.calls.length, 0);
  }
  for (const actor of [undefined, null, 0, 202, '101']) {
    const data = { ...settingMutationResponse(10), actor_id: actor };
    const fixture = scenario(async () => ({ status: 201, data }));
    await assert.rejects(fixture.api.saveInspectionRoleSetting(null, {}, 'SYNTHETIC-KEY', SESSION_A, 101), /mutation identity mismatch/);
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.assertions, [SESSION_A, SESSION_A]);
  }
});
test('setting mutations reject flat, wrong-target and inconsistent nested envelopes', async () => {
  const correct = settingMutationResponse(9, 2);
  for (const data of [correct.setting, { ...correct, can_configure: false }, { ...correct, setting: { ...correct.setting, id: 10 } },
    { ...correct, setting: { ...correct.setting, version: 0 } }, { ...correct, settings: [] },
    { ...correct, settings: [{ ...correct.setting, label: 'SYNTHETIC other saved version' }] }]) {
    const fixture = scenario(async () => ({ status: 200, data }));
    await assert.rejects(fixture.api.saveInspectionRoleSetting(9, { version: 1 }, 'SYNTHETIC-KEY', SESSION_A, 101), /mutation identity mismatch/);
    assert.equal(fixture.calls.length, 1);
  }
});
test('setting mutations validate and retain the exact effective period in the backend envelope', async () => {
  const correct = settingMutationResponse(9, 2);
  const period = { effective_from: '2026-10-07T12:00:00+00:00', effective_until: '2026-10-08T00:00:00+00:00', effective_from_local: '2026-10-07T20:00', effective_until_local: '2026-10-08T08:00' };
  const data = { ...correct, setting: { ...correct.setting, ...period }, settings: [{ ...correct.setting, ...period }] };
  const fixture = scenario(async () => ({ status: 200, data }));
  const result = await fixture.api.saveInspectionRoleSetting(9, { version: 1, ...period }, 'SYNTHETIC-PERIOD-KEY', SESSION_A, 101);
  assert.equal(result, data.setting);
  for (const field of Object.keys(period)) {
    for (const value of [undefined, 101, false]) {
      const malformed = scenario(async () => ({ status: 200, data: { ...data, setting: { ...data.setting, [field]: value } } }));
      await assert.rejects(malformed.api.saveInspectionRoleSetting(9, { version: 1 }, 'SYNTHETIC-KEY', SESSION_A, 101), /mutation identity mismatch/);
    }
    const mismatched = scenario(async () => ({ status: 200, data: { ...data, settings: [{ ...data.setting, [field]: null }] } }));
    await assert.rejects(mismatched.api.saveInspectionRoleSetting(9, { version: 1 }, 'SYNTHETIC-KEY', SESSION_A, 101), /mutation identity mismatch/);
  }
});

for (const operation of operations) {
  test(`${operation.name} binds the original session and preserves its request contract`, async () => {
    const response = deferred();
    const fixture = scenario(() => response.promise);
    const pending = operation.invoke(fixture.api, SESSION_A);
    assert.deepEqual(fixture.calls, [operation.expected]);
    assert.deepEqual(fixture.assertions, [SESSION_A], 'the session must be checked before HTTP starts');
    assert.equal(fixture.validations.length, 0);
    response.resolve({ status: 200, data: operation.result });
    if (operation.name === 'MES metadata preview') assert.deepEqual(await pending, operation.result);
    else assert.equal(await pending, operation.returned ?? operation.result);
    assert.deepEqual(fixture.assertions, [SESSION_A, SESSION_A], 'a successful response requires the original session again');
    assert.deepEqual(fixture.validations, operation.name === 'kanban' ? [{ data: operation.result, date: DATE }] : []);
    assert.deepEqual(fixture.calls, [operation.expected], 'no retry or unbound follow-up request');
  });

  test(`${operation.name} rejects missing or stale sessions without issuing HTTP`, async () => {
    const sessions: [SessionId, SessionId][] = [
      [null, SESSION_A], [undefined, SESSION_A], ['', SESSION_A],
      [SESSION_A, SESSION_B], [SESSION_A, null], [null, null],
    ];
    for (const [requested, current] of sessions) {
      const fixture = scenario(async () => ({ status: 200, data: operation.result }), current);
      await assert.rejects(operation.invoke(fixture.api, requested), (error) => error === fixture.staleSession);
      assert.equal(fixture.calls.length, 0);
      assert.equal(fixture.validations.length, 0);
    }
  });

  test(`${operation.name} rejects a late success after an account switch or logout`, async () => {
    for (const nextSessionId of [SESSION_B, null]) {
      const response = deferred();
      const fixture = scenario(() => response.promise);
      const pending = operation.invoke(fixture.api, SESSION_A);
      assert.equal(fixture.calls.length, 1);
      fixture.state.sessionId = nextSessionId;
      response.resolve({ status: 200, data: operation.result });
      await assert.rejects(pending, (error) => error === fixture.staleSession);
      assert.deepEqual(fixture.calls, [operation.expected], 'the original request cannot be rebound to the new session');
      assert.deepEqual(fixture.assertions, [SESSION_A, SESSION_A]);
      assert.equal(fixture.validations.length, 0, 'stale kanban data is rejected before validation or adoption');
    }
  });
}

test('an unfiltered request list keeps pagination and an explicit session binding', async () => {
  const result = { count: 0, results: [] };
  const fixture = scenario(async () => ({ status: 200, data: result }));
  assert.equal(await fixture.api.getInspectionRequests('', '', 1, SESSION_A), result);
  assert.deepEqual(fixture.calls, [{ method: 'get', url: BASE, config: {
    params: { search: undefined, status: undefined, page: 1 }, authSessionId: SESSION_A,
  } }]);
});

test('MES metadata preview forwards cancellation and rejects off-scope data without a follow-up request', async () => {
  const controller = new AbortController();
  const raw = { ...previewFixture(), qc_id: '90099' };
  const fixture = scenario(async () => ({ status: 200, data: raw }));
  await assert.rejects(fixture.api.getMesDetailPreview(SESSION_A, controller.signal), /Invalid MES detail preview response/);
  assert.deepEqual(fixture.calls, [{ method: 'get', url: `${BASE}mes-detail-preview/`, config: { authSessionId: SESSION_A, signal: controller.signal } }]);
});

test('HTTP rejection remains a failure without an automatic retry for every operation', async () => {
  for (const operation of operations) {
    const response = deferred();
    const fixture = scenario(() => response.promise);
    const failure = new Error('SYNTHETIC transport failure');
    const pending = operation.invoke(fixture.api, SESSION_A);
    response.reject(failure);
    await assert.rejects(pending, (error) => error === failure);
    assert.deepEqual(fixture.calls, [operation.expected]);
    assert.equal(fixture.validations.length, 0);
  }
});

test('same-session detail and mutation identity checks remain enforced', async () => {
  const detail = scenario(async () => ({ status: 200, data: { id: 99 } }));
  await assert.rejects(detail.api.getInspectionRequest(42, SESSION_A), /Inspection request identity mismatch/);
  for (const action of actions) {
    const badIds = action === 'create' || action === 'reinspect' ? [0, -1, 1.5, '42'] : [0, -1, 1.5, '42', 99];
    for (const id of badIds) {
      const fixture = scenario(async () => ({ status: 200, data: { id } }));
      await assert.rejects(fixture.api.mutateInspectionRequest(42, { action, key: 'SYNTHETIC-KEY', payload: {} }, SESSION_A), /Inspection mutation identity mismatch/);
    }
  }
});

test('same-session HTTP 202 mutations retain their pending response instead of reporting success', async () => {
  for (const operation of mutations) {
    const data = { code: 'operation_pending', request: { id: 42 } };
    const fixture = scenario(async () => ({ status: 202, data }));
    await assert.rejects(operation.invoke(fixture.api, SESSION_A), (error) => {
      assert.deepEqual(error, { response: { status: 202, data } });
      return true;
    });
    assert.deepEqual(fixture.calls, [operation.expected]);
  }
});

test('late pending mutation responses are rejected by session before returning their payload', async () => {
  for (const operation of mutations) {
    const response = deferred();
    const fixture = scenario(() => response.promise);
    const pending = operation.invoke(fixture.api, SESSION_A);
    fixture.state.sessionId = SESSION_B;
    response.resolve({ status: 202, data: { code: 'operation_pending', request: { id: 42 } } });
    await assert.rejects(pending, (error) => error === fixture.staleSession);
    assert.deepEqual(fixture.calls, [operation.expected]);
  }
});

test('trial preparation rejects broader payloads and wrong response classification', async () => {
  for (const payload of [{ ...trialAttempt.payload, work_order_ref: 'WO' }, { ...trialAttempt.payload, code: 'production' }]) {
    const fixture = scenario(async () => ({ status: 201, data: { id: 77, source_kind: 'integration_test' } }));
    await assert.rejects(fixture.api.createIntegrationTrial({ ...trialAttempt, payload }, SESSION_A), /Invalid integration trial/);
    assert.equal(fixture.calls.length, 0);
  }
  const fixture = scenario(async () => ({ status: 201, data: { id: 77, source_kind: 'manual' } }));
  await assert.rejects(fixture.api.createIntegrationTrial(trialAttempt, SESSION_A), /Integration trial identity mismatch/);
});
