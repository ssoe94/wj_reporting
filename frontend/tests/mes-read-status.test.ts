import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { deriveMesReadStatus, isExistingMesWorkOrderCode, parseMesReadStatus } from '../src/domains/production/mes-read-status.ts';

const DAY = '2026-10-07';
const CODE = 'SYNTHETIC-EXISTING-WO';
const OBSERVED = '2026-10-07T03:00:00Z';
const NOW = Date.parse(OBSERVED) + 1_000;

function fixture() {
  return {
    schema_version: 'production-mes-read-status/v1', business_date: DAY,
    read_only: true, live_writes_enabled: false, state: 'partial',
    observed_at: OBSERVED, fresh_until: '2026-10-07T03:05:00Z',
    work_orders: [{
      id: '1791328202481787', code: CODE, material_code: 'SYNTHETIC-PART', resource_name: 'SYNTHETIC-RESOURCE',
      production_order: { state: 'in_progress', label: '진행 / 进行中' },
      production: { state: 'in_progress', label: '보고 확인 / 已确认报工', reported_quantity: '1.0000000001', unit_name: 'SYNTHETIC-UNIT' },
      inbound: { state: 'unknown', label: '미확인 / 待确认' },
      next_action: { code: 'check_inbound_in_mes', target: 'MES', label: 'MES에서 입고 상태 확인 / 在MES确认入库状态' },
    }],
  };
}

test('exact existing-work-order scope retains decimal quantities and IDs without rounding or inventing inbound quantity', () => {
  const data = parseMesReadStatus(fixture(), DAY, CODE);
  const view = deriveMesReadStatus(data, DAY, CODE, { nowMs: NOW });
  assert.equal(view.state, 'partial');
  assert.equal(view.row?.id, '1791328202481787');
  assert.equal(view.row?.production.reported_quantity, '1.0000000001');
  assert.equal(view.row?.inbound.quantity, undefined);
  assert.equal(view.row?.inbound.state, 'unknown');
  assert.equal(view.row?.next_action.target, 'MES');
});

test('provider payload, diagnostic detail and QC measurements never enter the selected display object', () => {
  const raw = fixture() as unknown as Record<string, unknown>;
  raw.detail = 'SYNTHETIC-PROVIDER-ERROR';
  raw.provider_payload = { access_token: 'SYNTHETIC-NONSECRET' };
  const row = (raw.work_orders as Array<Record<string, unknown>>)[0];
  row.measurements = [{ actual: 'SYNTHETIC-VALUE' }];
  row.next_action = { ...(row.next_action as Record<string, unknown>), url: 'https://example.invalid/write' };
  const result = JSON.stringify(parseMesReadStatus(raw, DAY, CODE));
  assert.doesNotMatch(result, /SYNTHETIC-PROVIDER|access_token|measurements|SYNTHETIC-VALUE|example\.invalid/);
});

test('failed, expired and future observations remove completion and next-action evidence', () => {
  const data = parseMesReadStatus(fixture(), DAY, CODE);
  for (const options of [
    { failed: true, nowMs: NOW }, { pending: true, nowMs: NOW },
    { nowMs: Date.parse('2026-10-07T03:05:00Z') }, { nowMs: Date.parse(OBSERVED) - 1 },
  ]) {
    const view = deriveMesReadStatus(data, DAY, CODE, options);
    assert.equal(view.row, null);
    assert.notEqual(view.state, 'partial');
  }
  assert.equal(deriveMesReadStatus(data, DAY, CODE, { failed: true, nowMs: NOW }).state, 'unavailable');
  assert.equal(deriveMesReadStatus(data, DAY, CODE, { nowMs: Date.parse('2026-10-07T03:05:00Z') }).state, 'stale');
});

test('permission failure stays unknown rather than indicating no production or zero inbound', () => {
  const raw = { ...fixture(), state: 'permission_required', observed_at: null, fresh_until: null, work_orders: [] };
  const result = parseMesReadStatus(raw, DAY, CODE);
  assert.equal(deriveMesReadStatus(result, DAY, CODE, { nowMs: NOW }).state, 'permission_required');
  assert.equal(deriveMesReadStatus(result, DAY, CODE, { nowMs: NOW }).row, null);
  assert.deepEqual(result.work_orders, []);
  assert.throws(() => parseMesReadStatus({ ...raw, work_orders: fixture().work_orders }, DAY, CODE));
});

test('permission guidance selects only official names and never presents a grant as already enabled', () => {
  const raw = { ...fixture(), state: 'permission_required', observed_at: null, fresh_until: null, work_orders: [],
    required_read_permissions: [{ name: 'SYNTHETIC-READ-API', state: 'unverified', route: '/SYNTHETIC-INTERNAL', doc_id: '123' }] };
  const result = parseMesReadStatus(raw, DAY, CODE);
  assert.deepEqual(result.required_read_permissions, [{ name: 'SYNTHETIC-READ-API', state: 'unverified' }]);
  assert.throws(() => parseMesReadStatus({ ...raw, required_read_permissions: [{ name: 'SYNTHETIC-READ-API', state: 'enabled' }] }, DAY, CODE));
});

test('a changed day or work-order selection discards earlier data, including successful empty responses', () => {
  const data = parseMesReadStatus(fixture(), DAY, CODE);
  assert.equal(deriveMesReadStatus(data, '2026-10-08', CODE, { nowMs: NOW }).state, 'not_queried');
  assert.equal(deriveMesReadStatus(data, DAY, 'SYNTHETIC-OTHER-WO', { nowMs: NOW }).row, null);
  const empty = parseMesReadStatus({ ...fixture(), state: 'verified', work_orders: [] }, DAY, CODE);
  assert.equal(deriveMesReadStatus(empty, DAY, 'SYNTHETIC-OTHER-WO', { nowMs: NOW }).state, 'not_queried');
  assert.equal(deriveMesReadStatus(empty, DAY, CODE, { nowMs: NOW }).state, 'verified');
  assert.throws(() => parseMesReadStatus(fixture(), DAY, 'SYNTHETIC-OTHER-WO'));
  assert.throws(() => parseMesReadStatus(fixture(), '2026-10-08', CODE));
});

test('malformed schema, unsafe states, numeric IDs/quantities and unknown-state quantities fail closed', () => {
  const changes = [
    (raw: Record<string, unknown>) => { raw.read_only = false; },
    (raw: Record<string, unknown>) => { raw.live_writes_enabled = true; },
    (raw: Record<string, unknown>) => { raw.schema_version = 'production-write/v1'; },
    (raw: Record<string, unknown>) => { raw.state = 'everything_completed'; },
    (raw: Record<string, unknown>) => { raw.fresh_until = '2026-10-07T04:00:00Z'; },
    (raw: Record<string, unknown>) => { raw.observed_at = '2026-10-07T03:00:00'; },
    (raw: Record<string, unknown>) => { raw.observed_at = '2026-02-30T03:00:00Z'; raw.fresh_until = '2026-02-30T03:05:00Z'; },
    (raw: Record<string, unknown>) => { raw.work_orders = [fixture().work_orders[0], fixture().work_orders[0]]; },
  ];
  for (const change of changes) {
    const raw = fixture() as unknown as Record<string, unknown>;
    change(raw);
    assert.throws(() => parseMesReadStatus(raw, DAY, CODE));
  }
  for (const patch of [{ id: 1791328202481787 }, { id: '01' }, { id: '9223372036854775808' },
    { production: { state: 'completed', label: '완료', reported_quantity: 1, unit_name: 'SYNTHETIC-UNIT' } },
    { inbound: { state: 'unknown', label: '미확인', quantity: '0', unit_name: 'SYNTHETIC-UNIT' } },
    { next_action: { code: 'start', target: 'WJ_PRODUCTION_WRITE', label: '시작' } },
    { production_order: { state: 'completed', label: 'synthetic\nunsafe' } }]) {
    const raw = fixture();
    raw.work_orders = [{ ...raw.work_orders[0], ...patch }] as typeof raw.work_orders;
    assert.throws(() => parseMesReadStatus(raw, DAY, CODE));
  }
});

test('existing-code input accepts an exact identifier and rejects blanks, control characters and excessive length', () => {
  assert.equal(isExistingMesWorkOrderCode(CODE), true);
  for (const code of ['', ' ', 'SYNTHETIC\nWO', 'x'.repeat(101), ' SYNTHETIC-WO ']) {
    assert.equal(isExistingMesWorkOrderCode(code), false);
  }
});

// Exercise the real API function with an inert HTTP dependency: no browser storage or MES request.
const apiSource = stripTypeScriptTypes(readFileSync(new URL('../src/domains/production/mes-read-status-api.ts', import.meta.url), 'utf8'))
  .replace(/^import\s[\s\S]*?;\s*/gm, '').replace(/^export\s+/gm, '');
const instantiateApi = new Function('http', 'isExistingMesWorkOrderCode', 'parseMesReadStatus', `${apiSource}\nreturn getMesReadStatus;`);

test('explicit status query issues one GET bound to the original session and exact existing work order', async () => {
  const calls: unknown[] = [];
  const getStatus = instantiateApi({ get: async (path: string, config: unknown) => {
    calls.push({ path, config });
    return { data: fixture() };
  } }, isExistingMesWorkOrderCode, parseMesReadStatus) as (date: string, code: string, session: string) => Promise<unknown>;
  assert.equal(calls.length, 0);
  const result = await getStatus(DAY, CODE, 'SYNTHETIC-ORIGINAL-SESSION');
  assert.deepEqual(calls, [{ path: '/production/mes-read-status/', config: {
    params: { business_date: DAY, work_order_code: CODE }, authSessionId: 'SYNTHETIC-ORIGINAL-SESSION',
  } }]);
  assert.equal((result as { read_only: boolean }).read_only, true);
});

test('invalid input and an unsuccessful read never dispatch a second API operation', async () => {
  let count = 0;
  const getStatus = instantiateApi({ get: async () => { count += 1; throw new Error('SYNTHETIC-READ-FAILURE'); } },
    isExistingMesWorkOrderCode, parseMesReadStatus) as (date: string, code: string, session: string) => Promise<unknown>;
  await assert.rejects(getStatus(DAY, '', 'SYNTHETIC-SESSION'));
  assert.equal(count, 0);
  await assert.rejects(getStatus(DAY, CODE, 'SYNTHETIC-SESSION'));
  assert.equal(count, 1);
});
