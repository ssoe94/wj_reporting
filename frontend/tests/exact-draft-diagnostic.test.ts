import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as contract from '../src/domains/production/exact-draft-diagnostic.ts';
import { diagnosticRaw, DIAGNOSTIC_CLOCK, DIAGNOSTIC_UID } from './fixtures/exact-draft-diagnostic.ts';

test('exact utility visibility uses actor18 full-superuser hints; server remains the active/pilot authority', () => {
  const user = { id: 18, is_superuser: true };
  assert.equal(contract.canUseExactDraftDiagnostic(user), true, 'legacy user payload omits is_active');
  for (const candidate of [null, {}, { ...user, id: 19 }, { ...user, id: '18' }, { id: 18, is_staff: true },
    { ...user, is_superuser: 'true' }, { ...user, is_active: false }, { ...user, password_reset_required: true },
    { ...user, is_using_temp_password: true }, { ...user, groups: ['inspection-beta-pilot'] }]) {
    assert.equal(contract.canUseExactDraftDiagnostic(candidate as contract.ExactDraftActor), false);
  }
});

test('fixed scope rejects quantity, target, time, assignment and writer changes', () => {
  const raw = diagnosticRaw();
  for (const [key, value] of Object.entries({ material_code: '1', quantity: '2', unit_name: '-', status: 1,
    planned_start: '2026-10-09T08:00:00+08:00', planned_end: '2026-10-12T08:00:00+08:00',
    resource_assigned: true, inputs_assigned: true, processes_assigned: true })) {
    assert.throws(() => contract.parseExactDraftSnapshot({ ...raw, scope: { ...raw.scope, [key]: value } }));
  }
  for (const patch of [{ code: 'OTHER' }, { ordinary_writer_enabled: true }, { state: 'confirmed' },
    { attempt: 2 }, { attempt: '0' }, { can_send: 'true' }, { request_uid: Number('17000000000000001') },
    { approval: { ...raw.approval, max_attempts: 2 } }, { approval: { ...raw.approval, expires_at: 'invalid' } }]) {
    assert.throws(() => contract.parseExactDraftSnapshot({ ...raw, ...patch }));
  }
});

test('safe result preserves 17-digit strings, strips provider fields and rejects a different work order', () => {
  const result = { work_order_id: '17000000000000001', work_order_code: contract.EXACT_DRAFT_CODE,
    task_count: 0, inventory_change_count: 0, draft_snapshot_matches: true, access_token: 'SYNTHETIC_SECRET', raw: { token: 'SYNTHETIC_SECRET' } };
  const parsed = contract.parseExactDraftSnapshot(diagnosticRaw({ state: 'draft_observed', attempt: 1, result }));
  assert.equal(parsed.result!.work_order_id, result.work_order_id);
  assert.ok(!JSON.stringify(parsed).includes('SYNTHETIC_SECRET'));
  assert.throws(() => contract.parseExactDraftSnapshot(diagnosticRaw({ result: { ...result, work_order_id: Number('17000000000000001') } })));
  assert.throws(() => contract.parseExactDraftSnapshot(diagnosticRaw({ result: { ...result, work_order_code: 'OTHER' } })));
});

test('initial explicit prepare permits APPmissing and reconnect blockers, with fixed reference already visible', () => {
  const raw = diagnosticRaw();
  const unprepared = contract.parseExactDraftSnapshot({ ...raw, state: 'unprepared', request_uid: null,
    approval: { ...raw.approval, approved_at: null, expires_at: null, active: false },
    app_supply: { available: false, usable_for_seconds: 0, supply_mode: 'server' },
    connection: { status: 'blocked', reason: 'credential_binding_blocked' }, can_prepare: true, can_send: false });
  assert.equal(contract.exactDraftActions(unprepared, DIAGNOSTIC_CLOCK, false, true).prepare, true);
  assert.equal(contract.exactDraftActions(unprepared, DIAGNOSTIC_CLOCK, false, true).send, false);
  assert.equal(contract.exactDraftActions(unprepared, DIAGNOSTIC_CLOCK, false, true).reconnect, false);
  const prepared = contract.parseExactDraftSnapshot({ ...raw, app_supply: unprepared.app_supply,
    connection: unprepared.connection, can_send: false });
  assert.equal(contract.exactDraftActions(prepared, DIAGNOSTIC_CLOCK, false, true).reconnect, true);
  assert.equal(contract.exactDraftActions(prepared, DIAGNOSTIC_CLOCK, false, true).prepare, false);
});

test('single send requires fresh server flags, permit, APP and USER; static supply has no numeric expiry', () => {
  const data = contract.parseExactDraftSnapshot(diagnosticRaw());
  assert.equal(contract.exactDraftActions(data, DIAGNOSTIC_CLOCK, false, true).send, true);
  assert.equal(contract.exactDraftActions({ ...data, app_supply: { available: true, usable_for_seconds: 0, supply_mode: 'static' } }, DIAGNOSTIC_CLOCK, false, true).send, true);
  for (const candidate of [{ ...data, can_send: false }, { ...data, attempt: 1 as const },
    { ...data, app_supply: { ...data.app_supply, available: false } },
    { ...data, connection: { status: 'blocked' as const, reason: null } }]) {
    assert.equal(contract.exactDraftActions(candidate, DIAGNOSTIC_CLOCK, false, true).send, false);
  }
  assert.equal(contract.exactDraftActions(data, DIAGNOSTIC_CLOCK, true, true).send, false);
  assert.equal(contract.exactDraftActions(data, DIAGNOSTIC_CLOCK, false, false).send, false);
  assert.equal(contract.exactDraftActions(data, DIAGNOSTIC_CLOCK, true, true).reconnect, false);
});

test('30-minute approval never extends through expiry, future-start, excessive duration or APP-attempt exhaustion', () => {
  const data = contract.parseExactDraftSnapshot(diagnosticRaw());
  assert.equal(contract.exactDraftPermitUsable(data, DIAGNOSTIC_CLOCK + 1799999), true);
  assert.equal(contract.exactDraftPermitUsable(data, DIAGNOSTIC_CLOCK + 1800000), false);
  assert.equal(contract.exactDraftPermitUsable(data, DIAGNOSTIC_CLOCK - 1), false);
  for (const approval of [{ ...data.approval, expired: true }, { ...data.approval, active: false },
    { ...data.approval, expires_at: new Date(DIAGNOSTIC_CLOCK + 1800001).toISOString() }]) {
    assert.equal(contract.exactDraftActions({ ...data, approval }, DIAGNOSTIC_CLOCK, false, true).send, false);
  }
  assert.equal(contract.exactDraftActions({ ...data, approval: { ...data.approval, app_attempt: 1 } }, DIAGNOSTIC_CLOCK, false, true).reconnect, false);
});

test('after attempt1 unresolved outcomes permit readback only, including sticky review state', () => {
  const data = contract.parseExactDraftSnapshot(diagnosticRaw());
  for (const state of ['sending', 'uncertain', 'readback_pending', 'review'] as const) {
    const actions = contract.exactDraftActions({ ...data, state, attempt: 1, can_prepare: true, can_send: true, can_recheck: true }, DIAGNOSTIC_CLOCK, false, true);
    assert.deepEqual(actions, { prepare: false, send: false, recheck: true, reconnect: false });
  }
  assert.equal(contract.exactDraftActions(null, DIAGNOSTIC_CLOCK, false, true).send, false);
});

test('actual API client uses only exact actions, current session and no auth-refresh POST replay', async () => {
  const compiled = ts.transpileModule(readFileSync(new URL('../src/domains/production/exact-draft-diagnostic-api.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls: { method: string; path: string; body?: unknown; options: any }[] = [];
  const api = { get: async (path: string, options: any) => { calls.push({ method: 'GET', path, options }); return { data: diagnosticRaw() }; },
    post: async (path: string, body: unknown, options: any) => { calls.push({ method: 'POST', path, body, options }); return { data: diagnosticRaw() }; } };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => name === '../../lib/api' ? { default: api } : contract, exports);
  const signal = new AbortController().signal;
  await exports.getExactDraftDiagnostic('SYNTHETIC-SESSION', signal);
  for (const action of ['prepare', 'send', 'recheck']) await exports.postExactDraftDiagnostic(action, DIAGNOSTIC_UID, 'SYNTHETIC-SESSION', signal);
  assert.deepEqual(calls.map(call => call.body), [undefined, { action: 'prepare' }, { action: 'send', request_uid: DIAGNOSTIC_UID }, { action: 'recheck', request_uid: DIAGNOSTIC_UID }]);
  assert.ok(calls.every(call => call.path === '/production/mes-create-diagnostic/' && call.options.skipAuthRefresh === true && call.options.authSessionId === 'SYNTHETIC-SESSION' && call.options.signal === signal));
  await assert.rejects(exports.postExactDraftDiagnostic('delete', DIAGNOSTIC_UID, 'SYNTHETIC-SESSION', signal));
  await assert.rejects(exports.postExactDraftDiagnostic('send', 'invalid', 'SYNTHETIC-SESSION', signal));
  assert.equal(calls.length, 4);
});
