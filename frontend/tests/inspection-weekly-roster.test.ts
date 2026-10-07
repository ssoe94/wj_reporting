import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  WEEKLY_ROSTER_SLOTS, cleanWeeklyRosterName, currentWeeklyRosterWeek,
  normalizeWeeklyRosterName, weeklyRosterAddDays, weeklyRosterWeekFromInput,
  weeklyRosterWeekInput, weeklyRosterWeekStart, weeklyRosterWindow, weeklyRosterDraft,
  weeklyRosterPayload, parseWeeklyRosterSettings, weeklyRosterPersonLabel,
} from '../src/pages/quality/inspection-requests/weeklyRosterModel.ts';
import type { WeeklyRosterSettings } from '../src/pages/quality/inspection-requests/weeklyRosterModel.ts';

test('weekly cards have the requested fixed shift and area order', () => {
  assert.deepEqual(WEEKLY_ROSTER_SLOTS, [
    { shift: 'DAY', area: 'dimension' }, { shift: 'DAY', area: 'appearance' },
    { shift: 'NIGHT', area: 'dimension' }, { shift: 'NIGHT', area: 'appearance' },
  ]);
});
test('the default week changes at Shanghai Monday midnight independently of host timezone', () => {
  assert.equal(currentWeeklyRosterWeek(new Date('2026-10-11T15:59:59Z')), '2026-10-05');
  assert.equal(currentWeeklyRosterWeek(new Date('2026-10-11T16:00:00Z')), '2026-10-12');
  assert.equal(currentWeeklyRosterWeek(new Date('2026-10-07T06:00:00Z')), '2026-10-05');
});
test('week ranges preserve calendar dates over month, leap day and year boundaries', () => {
  assert.equal(weeklyRosterWeekStart('2026-11-01'), '2026-10-26');
  assert.equal(weeklyRosterAddDays('2026-10-26', 6), '2026-11-01');
  assert.equal(weeklyRosterWeekStart('2028-02-29'), '2028-02-28');
  assert.equal(weeklyRosterAddDays('2028-02-28', 7), '2028-03-06');
  assert.equal(weeklyRosterWeekStart('2027-01-01'), '2026-12-28');
  assert.equal(weeklyRosterAddDays('2026-12-28', 6), '2027-01-03');
});
test('ISO week input round trips including week 53 without accepting rollover', () => {
  for (const date of ['2026-10-05', '2026-12-28', '2027-01-04', '2028-02-28'])
    assert.equal(weeklyRosterWeekFromInput(weeklyRosterWeekInput(date)), date);
  assert.equal(weeklyRosterWeekInput('2026-12-28'), '2026-W53');
  assert.equal(weeklyRosterWeekFromInput('2027-W53'), null);
  for (const value of ['', '2026-W00', '2026-W54', '2026-W1', '2026-10-05', 'no-date'])
    assert.equal(weeklyRosterWeekFromInput(value), null, value);
  for (const value of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-1-01', '2026-10-05T00:00:00Z'])
    assert.throws(() => weeklyRosterWeekStart(value), /weekly_date_invalid/);
});
test('day clocks stay 08–20 and the shared week period includes Sunday night through next Monday 08:00', () => {
  assert.deepEqual(weeklyRosterWindow('2026-10-05', 'DAY'), {
    timezone: 'Asia/Shanghai', start_time: '08:00', end_time: '20:00',
    effective_from_local: '2026-10-05T08:00', effective_until_local: '2026-10-12T08:00',
  });
  assert.deepEqual(weeklyRosterWindow('2026-10-05', 'NIGHT'), {
    timezone: 'Asia/Shanghai', start_time: '20:00', end_time: '08:00',
    effective_from_local: '2026-10-05T20:00', effective_until_local: '2026-10-12T08:00',
  });
  assert.equal(weeklyRosterWindow('2026-12-28', 'NIGHT').effective_until_local, '2027-01-04T08:00');
  assert.throws(() => weeklyRosterWindow('2026-10-06', 'DAY'), /weekly_date_invalid/);
});
test('display names normalize width, whitespace and case without erasing name boundaries', () => {
  assert.equal(cleanWeeklyRosterName('  Ａｌｉｃｅ\u3000\t李  '), 'Alice 李');
  assert.equal(normalizeWeeklyRosterName(' ＡＬＩＣＥ  李 '), normalizeWeeklyRosterName('alice\t李'));
  assert.equal(normalizeWeeklyRosterName('  王\n小明 '), '王 小明');
  assert.equal(normalizeWeeklyRosterName('\u0085Alice\u0085李\u001e'), 'alice 李');
  assert.notEqual(normalizeWeeklyRosterName('王 小明'), normalizeWeeklyRosterName('王小明'));
  assert.equal(normalizeWeeklyRosterName('가'), normalizeWeeklyRosterName('가'));
  assert.equal(normalizeWeeklyRosterName('Straße'), normalizeWeeklyRosterName('STRASSE'));
  assert.equal(normalizeWeeklyRosterName('Σςσ'), 'σσσ');
  assert.notEqual(normalizeWeeklyRosterName('I'), normalizeWeeklyRosterName('ı'));
});

const settings = (): WeeklyRosterSettings => ({
  week_start: '2026-10-05', week_end: '2026-10-11', version: 2, can_configure: true,
  roster: [
    { id: 101, display_name: 'Alice 李', distinguishing_note: '', active: true },
    { id: 102, display_name: '张明', distinguishing_note: '二组', active: true },
    { id: 103, display_name: '张明', distinguishing_note: '一组', active: true },
    { id: 104, display_name: 'SYNTHETIC-INACTIVE', distinguishing_note: '', active: false },
  ], slots: WEEKLY_ROSTER_SLOTS.map((slot) => ({ ...slot, inspector_id: null })),
});
test('new display names reuse normalized existing names without account fields or new identity', () => {
  const data = settings(); const draft = weeklyRosterDraft(data);
  draft['DAY-dimension'] = { selection: 'new', display_name: '  ＡＬＩＣＥ\t李 ', distinguishing_note: '' };
  draft['DAY-appearance'] = { selection: 'new', display_name: '  赵丽  ', distinguishing_note: '' };
  assert.deepEqual(weeklyRosterPayload(data, draft), {
    week_start: '2026-10-05', version: 2,
    slots: [
      { shift: 'DAY', area: 'dimension', inspector_id: 101 },
      { shift: 'DAY', area: 'appearance', display_name: '赵丽', distinguishing_note: '' },
      { shift: 'NIGHT', area: 'dimension', inspector_id: null },
      { shift: 'NIGHT', area: 'appearance', inspector_id: null },
    ],
  });
  assert.equal(data.roster.length, 4);
});
test('same names require an explicit differentiator when stored names already have notes', () => {
  const data = settings(); const draft = weeklyRosterDraft(data);
  draft['DAY-dimension'] = { selection: 'new', display_name: '张明', distinguishing_note: '' };
  assert.throws(() => weeklyRosterPayload(data, draft), /weekly_homonym_note_required/);
  draft['DAY-dimension'].distinguishing_note = ' 二组 ';
  assert.deepEqual(weeklyRosterPayload(data, draft).slots[0], { shift: 'DAY', area: 'dimension', inspector_id: 102 });
  draft['DAY-dimension'].distinguishing_note = '三组';
  assert.deepEqual(weeklyRosterPayload(data, draft).slots[0], { shift: 'DAY', area: 'dimension', display_name: '张明', distinguishing_note: '三组' });
  assert.equal(weeklyRosterPersonLabel(data.roster[1]), '张明 · 二组');
});
test('one person cannot cover both areas of one shift via stored, duplicated new or normalized names', () => {
  const data = settings(); const draft = weeklyRosterDraft(data);
  draft['DAY-dimension'].selection = '101'; draft['DAY-appearance'].selection = '101';
  assert.throws(() => weeklyRosterPayload(data, draft), /weekly_same_person/);
  draft['DAY-appearance'] = { selection: 'new', display_name: 'ALICE 李', distinguishing_note: '' };
  assert.throws(() => weeklyRosterPayload(data, draft), /weekly_same_person/);
  draft['DAY-dimension'] = { selection: 'new', display_name: '  陈明 ', distinguishing_note: '' };
  draft['DAY-appearance'] = { selection: 'new', display_name: '陈明', distinguishing_note: '' };
  assert.throws(() => weeklyRosterPayload(data, draft), /weekly_same_person/);
  draft['DAY-appearance'].selection = '';
  draft['NIGHT-dimension'] = { ...draft['DAY-dimension'] };
  assert.equal(weeklyRosterPayload(data, draft).slots.length, 4);
});
test('drafts reject unavailable people and empty or excessive names while allowing blank slots', () => {
  const data = settings(); const draft = weeklyRosterDraft(data);
  assert.ok(weeklyRosterPayload(data, draft).slots.every((slot) => 'inspector_id' in slot && slot.inspector_id === null));
  for (const selection of ['104', '999', '1e2']) {
    draft['DAY-dimension'].selection = selection;
    assert.throws(() => weeklyRosterPayload(data, draft), /weekly_person_unavailable/);
  }
  for (const display_name of ['\u3000 ', 'X'.repeat(129)]) {
    draft['DAY-dimension'] = { selection: 'new', display_name, distinguishing_note: '' };
    assert.throws(() => weeklyRosterPayload(data, draft), /weekly_name_invalid/);
  }
});
test('weekly response binds exact requested week, complete distinct slots, and known roster identifiers', () => {
  const valid = settings(); assert.equal(parseWeeklyRosterSettings(valid, '2026-10-05'), valid);
  for (const mutate of [
    (data: WeeklyRosterSettings) => { data.week_start = '2026-10-12'; },
    (data: WeeklyRosterSettings) => { data.week_end = '2026-10-12'; },
    (data: WeeklyRosterSettings) => { data.version = -1; },
    (data: WeeklyRosterSettings) => { data.slots.pop(); },
    (data: WeeklyRosterSettings) => { data.slots[1] = data.slots[0]; },
    (data: WeeklyRosterSettings) => { data.slots[0].inspector_id = 999; },
    (data: WeeklyRosterSettings) => { data.roster.push(data.roster[0]); },
  ]) {
    const invalid = settings(); mutate(invalid);
    assert.throws(() => parseWeeklyRosterSettings(invalid, '2026-10-05'));
  }
});

const apiSource = ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/weeklyRosterApi.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function apiHarness() {
  let activeSession = 'synthetic-owner';
  const calls: { method: string; path: string; payload?: unknown; options: unknown }[] = [];
  let respond = async () => ({ status: 200, data: { ...settings(), version: 3, actor_id: 101 } });
  const http = {
    get: async (path: string, options: unknown) => { calls.push({ method: 'GET', path, options }); return respond(); },
    post: async (path: string, payload: unknown, options: unknown) => { calls.push({ method: 'POST', path, payload, options }); return respond(); },
  };
  const output: Record<string, unknown> = {};
  new Function('require', 'exports', apiSource)((name: string) => {
    if (name === '@/shared/api/http') return { http };
    if (name === '@/domains/auth/auth-transition') return { assertAuthSessionCurrent: (session: string) => { if (session !== activeSession) throw new Error('session_changed'); } };
    if (name === './weeklyRosterModel') return { parseWeeklyRosterSettings };
    throw new Error(`Unexpected weekly API dependency: ${name}`);
  }, output);
  return {
    api: output as typeof import('../src/pages/quality/inspection-requests/weeklyRosterApi.ts'), calls,
    setOwner: (value: string) => { activeSession = value; },
    setResponse: (value: Awaited<ReturnType<typeof respond>>) => { respond = async () => value; },
    respondAfter: (task: () => void) => { const previous = respond; respond = async () => { task(); return previous(); }; },
  };
}
test('weekly API binds the captured session on reads and idempotent saves without account payloads', async () => {
  const harness = apiHarness(); const data = settings(); const payload = weeklyRosterPayload(data, weeklyRosterDraft(data));
  await harness.api.getWeeklyInspectionRoleSettings(data.week_start, 'synthetic-owner');
  await harness.api.saveWeeklyInspectionRoleSettings(payload, 'same-synthetic-key', 'synthetic-owner', 101);
  assert.deepEqual(harness.calls, [
    { method: 'GET', path: '/quality/inspection-requests/weekly-role-settings/', options: { authSessionId: 'synthetic-owner', params: { week_start: '2026-10-05' } } },
    { method: 'POST', path: '/quality/inspection-requests/weekly-role-settings/', payload, options: { authSessionId: 'synthetic-owner', headers: { 'Idempotency-Key': 'same-synthetic-key' } } },
  ]);
});
test('stale sessions stop weekly requests before transport and suppress late responses', async () => {
  const harness = apiHarness(); const data = settings(); const payload = weeklyRosterPayload(data, weeklyRosterDraft(data));
  harness.setOwner('replacement-owner');
  await assert.rejects(harness.api.getWeeklyInspectionRoleSettings(data.week_start, 'synthetic-owner'), /session_changed/);
  await assert.rejects(harness.api.saveWeeklyInspectionRoleSettings(payload, 'key', 'synthetic-owner', 101), /session_changed/);
  assert.equal(harness.calls.length, 0);
  for (const action of ['read', 'save']) {
    const late = apiHarness(); late.respondAfter(() => late.setOwner('replacement-owner'));
    await assert.rejects(action === 'read'
      ? late.api.getWeeklyInspectionRoleSettings(data.week_start, 'synthetic-owner')
      : late.api.saveWeeklyInspectionRoleSettings(payload, 'key', 'synthetic-owner', 101), /session_changed/);
    assert.equal(late.calls.length, 1);
  }
});
test('weekly save requires exact actor, saved version, permission, week and a resolved response', async () => {
  const data = settings(); const payload = weeklyRosterPayload(data, weeklyRosterDraft(data));
  for (const patch of [{ actor_id: 999 }, { version: 2 }, { version: 4 }, { can_configure: false }, { week_start: '2026-10-12' }]) {
    const harness = apiHarness(); harness.setResponse({ status: 200, data: { ...data, version: 3, actor_id: 101, ...patch } });
    await assert.rejects(harness.api.saveWeeklyInspectionRoleSettings(payload, 'key', 'synthetic-owner', 101));
  }
  const pending = apiHarness(); pending.setResponse({ status: 202, data: { ...data, version: 3, actor_id: 101 } });
  await assert.rejects(pending.api.saveWeeklyInspectionRoleSettings(payload, 'key', 'synthetic-owner', 101), (error: unknown) => (error as { response: { status: number } }).response.status === 202);
  const badActor = apiHarness();
  await assert.rejects(badActor.api.saveWeeklyInspectionRoleSettings(payload, 'key', 'synthetic-owner', 0), /actor identity required/);
  assert.equal(badActor.calls.length, 0);
});
