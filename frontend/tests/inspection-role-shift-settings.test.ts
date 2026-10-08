import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as workflow from '../src/pages/quality/inspection-requests/workflow.ts';
import type { InspectionRoleSetting } from '../src/pages/quality/inspection-requests/roleModel.ts';

// Transpile the delivered helper to resolve its bundler-style workflow import,
// while preserving the real workflow dependency and avoiding application I/O.
const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/roleShiftSettingsModel.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports: Record<string, unknown> = {};
new Function('require', 'exports', compiled)((name: string) => {
  assert.equal(name, './workflow'); return workflow;
}, exports);
const {
  SHIFT_TIMEZONE,
  createRoleShiftDraft,
  roleShiftActorLabel,
  roleShiftDateCovered,
  roleShiftDraftError,
  roleShiftLocalDateTime,
  roleShiftLocalInstant,
  roleShiftPresetTimes,
  roleShiftSettingDraft,
  roleShiftSettingPayload,
} = exports as typeof import('../src/pages/quality/inspection-requests/roleShiftSettingsModel.ts');

const candidates = [
  { id: 101, name: 'SYNTHETIC-SAME-NAME', username: 'synthetic-appearance', mes_user_id: 'SYNTHETIC-MES-A' },
  { id: 102, name: 'SYNTHETIC-SAME-NAME', username: 'synthetic-dimension', mes_user_id: null },
];
let keySequence = 0;
const createKey = () => `00000000-0000-4000-8000-${String(++keySequence).padStart(12, '0')}`;
const now = new Date('2026-10-31T16:30:00Z');
const newDraft = () => createRoleShiftDraft(createKey, now);
const activeDraft = () => ({ ...newDraft(), label: 'SYNTHETIC-DAY', active: true,
  effective_from_local: '2026-10-31T08:00', appearance_assignee: '101', dimension_assignee: '102' });
function setting(overrides: Partial<InspectionRoleSetting> = {}): InspectionRoleSetting {
  return { id: 501, version: 7, code: 'SYNTHETIC-SHIFT', label: 'SYNTHETIC-DAY', timezone: 'Asia/Shanghai',
    start_time: '08:00:00', end_time: '20:00:00', appearance_assignee: 101, dimension_assignee: 102, active: true,
    effective_from: '2026-10-31T00:00:00Z', effective_until: '2026-10-31T12:00:00Z',
    effective_from_local: '2026-10-31T08:00', effective_until_local: '2026-10-31T20:00', ...overrides };
}

test('new shift drafts offer factory day times while leaving activation, period and identities explicit', () => {
  const first = newDraft(); const second = newDraft();
  assert.equal(SHIFT_TIMEZONE, 'Asia/Shanghai');
  assert.deepEqual(roleShiftPresetTimes('day'), { timezone: 'Asia/Shanghai', start_time: '08:00', end_time: '20:00' });
  assert.deepEqual(roleShiftPresetTimes('night'), { timezone: 'Asia/Shanghai', start_time: '20:00', end_time: '08:00' });
  assert.equal(first.timezone, 'Asia/Shanghai');
  assert.equal(first.start_time, '08:00'); assert.equal(first.end_time, '20:00');
  assert.equal(first.label, ''); assert.equal(first.active, false);
  assert.equal(first.appearance_assignee, ''); assert.equal(first.dimension_assignee, '');
  assert.equal(first.effective_from_local, ''); assert.equal(first.effective_until_local, ''); assert.equal(first.reason, '');
  assert.match(first.code, /^[A-Za-z0-9_-]{1,64}$/); assert.match(first.code, /^SHIFT-/);
  assert.notEqual(first.code, second.code);
  first.label = 'LOCAL-UNSAVED'; assert.equal(second.label, '');
});

test('inactive draft is valid without inferring any inspector or first effective shift', () => {
  const draft = { ...newDraft(), label: 'SYNTHETIC-UNASSIGNED' };
  assert.equal(roleShiftDraftError(draft, []), null);
  const payload = roleShiftSettingPayload(draft, null);
  assert.equal(payload.active, false); assert.equal(payload.appearance_assignee, null); assert.equal(payload.dimension_assignee, null);
  assert.equal(payload.effective_from_local, null); assert.equal(payload.effective_until_local, null);
});

test('eligible explicit assignments can be saved in an inactive draft without activating their period', () => {
  const draft = { ...activeDraft(), active: false, effective_from_local: '', effective_until_local: '2026-11-01T12:15' };
  assert.equal(roleShiftDraftError(draft, candidates), null);
  assert.equal(roleShiftDraftError({ ...draft, effective_from_local: '2026-10-31T07:13' }, candidates), null);
  assert.notEqual(roleShiftDraftError({ ...draft, appearance_assignee: '999' }, candidates), null);
});

test('activation requires an explicit first shift start and two distinct eligible existing actors', () => {
  const draft = activeDraft(); assert.equal(roleShiftDraftError(draft, candidates), null);
  for (const patch of [
    { effective_from_local: '' }, { effective_from_local: '2026-10-31T07:59' },
    { appearance_assignee: '' }, { dimension_assignee: '' }, { dimension_assignee: '101' },
    { appearance_assignee: '999' }, { dimension_assignee: '102.5' }, { appearance_assignee: '1e2' },
    { timezone: 'UTC' },
  ]) assert.notEqual(roleShiftDraftError({ ...draft, ...patch }, candidates), null, JSON.stringify(patch));
});

test('local effective dates reject rollover, non-minute precision and timezone-bearing input', () => {
  const draft = activeDraft();
  for (const value of ['2026-02-30T08:00', '2026-04-31T08:00', '2026-02-29T08:00',
    '2026-10-31T24:00', '2026-10-31T08:60', '2026-10-31T08:00:00',
    '2026-10-31T08:00Z', '2026-10-31T08:00+08:00', '2026-1-01T08:00', '9999-12-31T08:00']) {
    assert.notEqual(roleShiftDraftError({ ...draft, effective_from_local: value }, candidates), null, value);
    assert.notEqual(roleShiftDraftError({ ...draft, active: false, effective_from_local: '', effective_until_local: value }, candidates), null, value);
  }
  assert.equal(roleShiftDraftError({ ...draft, effective_from_local: '2028-02-29T08:00' }, candidates), null);
});

test('active end remains optional but must be later and on an exact start or end boundary', () => {
  const draft = activeDraft();
  for (const until of ['', '2026-10-31T20:00', '2026-11-01T08:00'])
    assert.equal(roleShiftDraftError({ ...draft, effective_until_local: until }, candidates), null, until);
  for (const until of ['2026-10-31T08:00', '2026-10-30T20:00', '2026-10-31T12:00', '2026-11-01T08:01'])
    assert.notEqual(roleShiftDraftError({ ...draft, effective_until_local: until }, candidates), null, until);
  assert.notEqual(roleShiftDraftError({ ...draft, active: false, effective_until_local: draft.effective_from_local }, candidates), null);
});

test('night activation accepts a next-calendar-day end at the factory boundary', () => {
  const draft = { ...activeDraft(), ...roleShiftPresetTimes('night'), effective_from_local: '2026-10-31T20:00', effective_until_local: '2026-11-01T08:00' };
  assert.equal(roleShiftDraftError(draft, candidates), null);
  assert.notEqual(roleShiftDraftError({ ...draft, effective_until_local: '2026-10-31T08:00' }, candidates), null);
});

test('explicit custom minute boundaries remain available without being replaced by a preset', () => {
  const draft = { ...activeDraft(), start_time: '06:30', end_time: '14:15', effective_from_local: '2026-10-31T06:30', effective_until_local: '2026-10-31T14:15' };
  assert.equal(roleShiftDraftError(draft, candidates), null);
  const payload = roleShiftSettingPayload(draft, null);
  assert.equal(payload.start_time, '06:30'); assert.equal(payload.end_time, '14:15');
  const custom = setting({ start_time: '06:30:00', end_time: '14:15:00', effective_from: '2026-10-30T22:30:00Z', effective_until: '2026-10-31T06:15:00Z' });
  assert.equal(roleShiftDateCovered(custom, '2026-10-31'), true);
  assert.equal(roleShiftDateCovered({ ...custom, effective_until: '2026-10-31T06:14:59Z' }, '2026-10-31'), false);
});

test('active shift clocks cannot be missing, malformed, offset-bearing or equal', () => {
  const draft = activeDraft();
  for (const patch of [{ start_time: '' }, { end_time: '' }, { start_time: '24:00' },
    { end_time: '20:60' }, { start_time: '08:00+08:00' }, { end_time: '08:00' }])
    assert.notEqual(roleShiftDraftError({ ...draft, ...patch }, candidates), null, JSON.stringify(patch));
});

test('historical setting edit copies server local period without changing the immutable snapshot or version', () => {
  const source = Object.freeze(setting({ effective_from_local: '2026-09-30T08:00', effective_until_local: '2026-10-01T20:00' }));
  const draft = roleShiftSettingDraft(source);
  assert.equal(draft.effective_from_local, '2026-09-30T08:00'); assert.equal(draft.effective_until_local, '2026-10-01T20:00');
  assert.equal(draft.start_time, '08:00'); assert.equal(draft.end_time, '20:00');
  assert.equal(draft.appearance_assignee, '101'); assert.equal(draft.dimension_assignee, '102');
  assert.equal(draft.reason, ''); assert.equal('version' in draft, false);
  draft.effective_from_local = '2026-11-01T08:00'; draft.appearance_assignee = '102';
  assert.equal(source.version, 7); assert.equal(source.appearance_assignee, 101);
  assert.equal(source.effective_from_local, '2026-09-30T08:00');
});

test('legacy unset period remains blank rather than deriving a date from server UTC or today', () => {
  const draft = roleShiftSettingDraft(setting({ effective_from_local: null, effective_until_local: null, effective_from: null, effective_until: null }));
  assert.equal(draft.effective_from_local, ''); assert.equal(draft.effective_until_local, '');
});

test('local instant and UTC display agree on factory timezone independently of host timezone', () => {
  assert.equal(roleShiftLocalInstant('2026-11-01T00:30'), Date.parse('2026-10-31T16:30:00Z'));
  assert.equal(roleShiftLocalDateTime('2026-10-31T16:30:00Z'), '2026-11-01T00:30');
  assert.equal(roleShiftLocalInstant('2028-02-29T08:00'), Date.parse('2028-02-29T00:00:00Z'));
  assert.equal(roleShiftLocalDateTime(null), ''); assert.equal(roleShiftLocalDateTime('invalid'), '');
});

test('historical daylight-saving gap and overlap are both rejected like the server contract', () => {
  // ZoneInfo Asia/Shanghai has a missing 02:30 on Apr 14 and two possible
  // 01:30 instants on Sep 15, 1991. The backend requires an unambiguous wall time.
  assert.equal(roleShiftLocalInstant('1991-04-14T02:30'), null);
  assert.equal(roleShiftLocalInstant('1991-09-15T01:30'), null);
  assert.equal(roleShiftLocalInstant('1991-09-15T02:30'), Date.parse('1991-09-14T18:30:00Z'));
});

test('create payload sends only explicit local period, preserving the server actor and timezone interpretation', () => {
  const draft = { ...activeDraft(), label: '  SYNTHETIC-DAY  ', effective_until_local: '2026-11-01T08:00' };
  const payload = roleShiftSettingPayload(draft, null);
  assert.equal(payload.code, draft.code); assert.equal(payload.label, 'SYNTHETIC-DAY');
  assert.equal(payload.timezone, 'Asia/Shanghai'); assert.equal(payload.appearance_assignee, 101); assert.equal(payload.dimension_assignee, 102);
  assert.equal(payload.effective_from_local, '2026-10-31T08:00'); assert.equal(payload.effective_until_local, '2026-11-01T08:00');
  for (const key of ['id', 'version', 'actor', 'actor_id', 'user_id', 'effective_from', 'effective_until', 'created_at', 'updated_at'])
    assert.equal(key in payload, false, key);
});

test('update payload preserves the selected original version and reason without changing immutable code', () => {
  const selected = setting(); const draft = { ...roleShiftSettingDraft(selected), code: 'UNSAVED-CODE-CHANGE', reason: '  SYNTHETIC explicit period revision  ' };
  const payload = roleShiftSettingPayload(draft, selected);
  assert.equal(payload.version, 7); assert.equal(payload.reason, 'SYNTHETIC explicit period revision');
  assert.equal('code' in payload, false); assert.equal(selected.code, 'SYNTHETIC-SHIFT'); assert.equal(selected.version, 7);
  assert.equal('effective_from' in payload, false); assert.equal('actor_id' in payload, false);
});

test('day coverage requires the whole factory shift while accepting exact period boundaries', () => {
  const day = setting();
  assert.equal(roleShiftDateCovered(day, '2026-10-31'), true);
  assert.equal(roleShiftDateCovered(day, '2026-10-30'), false); assert.equal(roleShiftDateCovered(day, '2026-11-01'), false);
  assert.equal(roleShiftDateCovered({ ...day, effective_from: '2026-10-31T00:00:01Z' }, '2026-10-31'), false);
  assert.equal(roleShiftDateCovered({ ...day, effective_until: '2026-10-31T11:59:59Z' }, '2026-10-31'), false);
  assert.equal(roleShiftDateCovered({ ...day, effective_until: null }, '2026-11-01'), true);
});

test('night coverage carries the end through a month boundary instead of treating it as the same day', () => {
  const night = setting({ start_time: '20:00:00', end_time: '08:00:00', effective_from: '2026-10-31T12:00:00Z', effective_until: '2026-11-01T00:00:00Z' });
  assert.equal(roleShiftDateCovered(night, '2026-10-31'), true);
  assert.equal(roleShiftDateCovered({ ...night, effective_until: '2026-10-31T23:59:59Z' }, '2026-10-31'), false);
  assert.equal(roleShiftDateCovered(night, '2026-11-01'), false);
});

test('overnight coverage respects leap-day and year boundaries', () => {
  const night = setting({ start_time: '20:00', end_time: '08:00', effective_from: '2028-02-29T12:00:00Z', effective_until: '2028-03-01T00:00:00Z' });
  assert.equal(roleShiftDateCovered(night, '2028-02-29'), true);
  const yearEnd = { ...night, effective_from: '2026-12-31T12:00:00Z', effective_until: '2027-01-01T00:00:00Z' };
  assert.equal(roleShiftDateCovered(yearEnd, '2026-12-31'), true);
});

test('coverage rejects impossible explicit shift dates and unconfigured or unsupported windows', () => {
  const unbounded = setting({ effective_from: '2020-01-01T00:00:00Z', effective_until: null });
  for (const date of ['', '2026-02-30', '2026-02-29', '2026-10-31T00:00:00Z', '2026-1-01', '9999-12-31'])
    assert.equal(roleShiftDateCovered(unbounded, date), false, date);
  for (const patch of [{ effective_from: null }, { start_time: null }, { end_time: null },
    { start_time: '08:00', end_time: '08:00' }, { timezone: 'UTC' }, { active: false }, { effective_from: 'invalid' }, { effective_until: 'invalid' }])
    assert.equal(roleShiftDateCovered({ ...unbounded, ...patch }, '2026-10-31'), false, JSON.stringify(patch));
});

test('unknown or same endpoints cannot masquerade as a valid shift when the date otherwise fits', () => {
  const unbounded = setting({ effective_from: '2020-01-01T00:00:00Z', effective_until: null });
  for (const patch of [{ start_time: '24:00' }, { end_time: '20:60' }, { start_time: 'invalid' }, { end_time: '' }])
    assert.equal(roleShiftDateCovered({ ...unbounded, ...patch }, '2026-10-31'), false, JSON.stringify(patch));
});

test('same-name actors retain distinct WJ identity and disclose only the configured MES mapping', () => {
  const linked = roleShiftActorLabel(candidates[0], 'ko'); const unlinked = roleShiftActorLabel(candidates[1], 'ko');
  assert.notEqual(linked, unlinked);
  assert.ok(linked.includes(candidates[0].name)); assert.ok(linked.includes(candidates[0].username)); assert.ok(linked.includes('101'));
  assert.ok(linked.includes(candidates[0].mes_user_id)); assert.match(unlinked, /연결 미확인/);
  const chinese = roleShiftActorLabel(candidates[1], 'zh'); assert.match(chinese, /关联未确认/);
  assert.ok(chinese.includes(candidates[1].username)); assert.ok(chinese.includes('102'));
  for (const label of [linked, unlinked, chinese]) assert.doesNotMatch(label, /검사 실행자|执行者|executor|已授权/i);
});

test('legacy candidate missing username and MES mapping remains identifiable without inferred authority', () => {
  const legacy = { id: 103, name: 'SYNTHETIC-LEGACY' };
  const label = roleShiftActorLabel(legacy, 'ko');
  assert.ok(label.includes('SYNTHETIC-LEGACY')); assert.ok(label.includes('103'));
  assert.match(label, /계정 식별 미확인/); assert.match(label, /연결 미확인/);
});
