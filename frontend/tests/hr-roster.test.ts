import assert from 'node:assert/strict';
import test from 'node:test';
import { filterRoster, rosterCounts, rosterHistoryChanges } from '../src/domains/hr/roster.ts';
import type { HrRosterEntry } from '../src/domains/hr/workbook-types.ts';
const entries: HrRosterEntry[] = [
  { id: 1, code: '90001', name: '测试甲', employment_type: 'contract', department: 'Test A', status: 'active', first_month: '2026-01', last_month: '2026-11', version: 3, previous_codes: ['OLD-01'], in_month: true },
  { id: 2, code: '90002', name: '测试乙', employment_type: 'hourly', department: 'Test B', status: 'active', first_month: '2026-01', last_month: '2026-10', version: 2, previous_codes: [], in_month: false },
  { id: 3, code: '90003', name: '测试丙', employment_type: 'contract', department: 'Test C', status: 'departed', first_month: '2026-01', last_month: '2026-09', version: 4, previous_codes: [], in_month: false },
];
const all = { search: '', kind: '', status: '', absent: false };

test('roster summaries count status and selected-month absence independently', () => {
  assert.deepEqual(rosterCounts(entries), { active: 2, departed: 1, absent: 2 });
  assert.deepEqual(rosterCounts([]), { active: 0, departed: 0, absent: 0 });
});

test('roster searches code, exact displayed name fragments and historical codes', () => {
  for (const [query, id] of [['90001', 1], ['测试乙', 2], [' old-01 ', 1]] as const) {
    assert.deepEqual(filterRoster(entries, { ...all, search: query }).map((item) => item.id), [id]);
  }
  assert.equal(filterRoster(entries, { ...all, search: 'unknown' }).length, 0);
});

test('roster combines employment, status and missing-month filters', () => {
  assert.deepEqual(filterRoster(entries, { ...all, kind: 'hourly', status: 'active', absent: true }).map((item) => item.id), [2]);
  assert.deepEqual(filterRoster(entries, { ...all, kind: 'contract', status: 'active', absent: true }), []);
  assert.equal(filterRoster(entries, all).length, 3);
});

test('history changes omit unchanged values and retain all four supported differences', () => {
  const history = { id: 1, created_at: '2026-11-12T01:00:00Z', actor_label: 'Synthetic admin', reason: 'Synthetic correction',
    previous_code: '90001', new_code: '90001', previous_status: 'active', new_status: 'active',
    previous_employment_type: 'hourly', new_employment_type: 'contract', previous_department: 'Test A', new_department: 'Test B' };
  assert.deepEqual(rosterHistoryChanges(history), [{ field: 'employment_type', before: 'hourly', after: 'contract' }, { field: 'department', before: 'Test A', after: 'Test B' }]);
  assert.deepEqual(rosterHistoryChanges({ ...history, new_code: '90004', new_status: 'departed' }).map((item) => item.field), ['code', 'status', 'employment_type', 'department']);
});
