import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import * as daily from '../src/domains/hr/daily-work.ts';
import { laborDayLabel } from '../src/domains/hr/labor-standards.ts';
import { canAccessHr } from '../src/domains/auth/hr-access.ts';
import type { HrDailySheet, HrWork } from '../src/domains/hr/daily-work.ts';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture(): HrDailySheet {
  const work: HrWork = { attendance: 'present', regular_hours: '0', weekday_hours: '4', rest_hours: '0', holiday_hours: '0', personal_leave_hours: '0', sick_leave_hours: '0' };
  const summary = { headcount: 3, contract: 2, hourly: 1, present: 3, absent: 0, leave: 0, off: 0, overtime_hours: '8', overtime_partial: false, status: 'ready' as const, amount: '160.00', known_amount: '160.00' };
  return { date: '2026-11-12', day_type: 'workday', version: 2, status: 'draft', context: 'synthetic-context-v2', event_revision: 1, can_edit: true,
    rows: [1, 2, 3].map((id) => { const defaults = { ...work, regular_hours: id === 2 ? '8' : '0', weekday_hours: id === 3 ? '0' : '4' }; return {
      employee: { id, code: `9000${id}`, name: `测试员工${id}`, employment_type: id === 2 ? 'hourly' as const : 'contract' as const, department: '测试部门', title: id === 3 ? 'Synthetic senior' : 'Synthetic operator' },
      defaults, work: { ...defaults }, modified: [], estimate: { status: 'ready' as const, amount: '40.00', known_amount: '40.00', deduction_status: 'none' as const, basis: { weekday_exempt: id === 3 } },
    }; }), summary, departments: [{ department: '测试部门', ...summary }], days: [{ date: '2026-11-12', day_type: 'workday', status: 'draft' }], events: [], history: [] };
}

test('canonical overrides preserve missing values and ignore attendance-derived zeros', () => {
  const sheet = fixture(); sheet.rows[0].work = { ...sheet.rows[0].work, attendance: 'absent', weekday_hours: '0' }; sheet.rows[0].modified = ['attendance'];
  assert.deepEqual(daily.overridesFromSheet(sheet), { 1: { attendance: 'absent' } });
  assert.equal(daily.effectiveWork(sheet.rows[0], { 1: { attendance: 'absent' } }).weekday_hours, '0');
  assert.deepEqual(daily.setDailyWork(sheet, {}, 2, { weekday_hours: null }), { 2: { weekday_hours: null } });
  assert.deepEqual(daily.setDailyWork(sheet, {}, 2, { weekday_hours: '4.0000' }), {});
});

test('leave uses zero baseline while explicit regular hours equal normal defaults remain stored', () => {
  const sheet = fixture(); const leave = daily.setDailyWork(sheet, {}, 2, { attendance: 'sick_leave', sick_leave_hours: '2' });
  assert.equal(daily.effectiveWork(sheet.rows[1], leave).regular_hours, '0');
  const partial = daily.setDailyWork(sheet, leave, 2, { regular_hours: '8' });
  assert.equal(partial[2].regular_hours, '8');
  assert.equal(daily.effectiveWork(sheet.rows[1], partial).regular_hours, '8');
  assert.deepEqual(daily.setDailyWork(sheet, partial, 2, { attendance: 'off' }), { 2: { attendance: 'off' } });
});

test('department defaults and off bulk operations affect only the chosen department', () => {
  const sheet = fixture(); sheet.rows[2].employee.department = '测试其他';
  const raw = { 1: { weekday_hours: '2' }, 3: { weekday_hours: '1' } };
  assert.deepEqual(daily.dailyBulkDefaults(sheet, raw, '测试部门'), { 3: { weekday_hours: '1' } });
  const off = daily.dailyBulkOff(sheet, raw, '测试部门');
  assert.deepEqual(off[1], { attendance: 'off' }); assert.deepEqual(off[2], { attendance: 'off' }); assert.deepEqual(off[3], raw[3]);
});

test('selected overtime keeps absences and leave, skips excluded jobs and uses holiday category', () => {
  const sheet = fixture(); const raw = { 1: { attendance: 'absent' as const }, 2: { attendance: 'personal_leave' as const, personal_leave_hours: '2' } };
  const changed = daily.dailyBulkOvertime(sheet, raw, [1, 2, 3], '3');
  assert.equal(changed[1].attendance, 'absent'); assert.equal(changed[1].weekday_hours, undefined);
  assert.equal(changed[2].attendance, 'personal_leave'); assert.equal(changed[2].weekday_hours, '3'); assert.equal(changed[3], undefined);
  sheet.day_type = 'rest_day'; for (const row of sheet.rows) row.defaults = { ...row.defaults, attendance: 'off', regular_hours: '0', weekday_hours: '0' };
  const holiday = daily.dailyBulkOvertime(sheet, {}, [1], '6'); assert.deepEqual(holiday[1], { attendance: 'present', rest_hours: '6' });
});

test('previous-day copy matches ids and avoids copying ordinary work into a holiday', () => {
  const previous = fixture(); previous.rows[0].work.weekday_hours = '2'; previous.rows[1].work = { ...previous.rows[1].work, attendance: 'sick_leave', regular_hours: '0', weekday_hours: '0', sick_leave_hours: '8' };
  const current = fixture(); current.day_type = 'adjusted_workday';
  assert.equal(daily.copyPreviousDaily(previous, current, {}).overrides[1].weekday_hours, '2');
  current.day_type = 'public_holiday'; for (const row of current.rows) row.defaults = { ...row.defaults, attendance: 'off', regular_hours: '0', weekday_hours: '0' };
  const result = daily.copyPreviousDaily(previous, current, {});
  assert.equal(result.copied, 1); assert.equal(result.retained, 2); assert.equal(result.overrides[1], undefined); assert.equal(result.overrides[2].sick_leave_hours, '8');
});

test('conflict reapply merges explicit changes and retains independent latest hours', () => {
  const original = fixture(); original.rows[1].work = { ...original.rows[1].work, attendance: 'absent', regular_hours: '0', weekday_hours: '0' }; original.rows[1].modified = ['attendance'];
  const mine = daily.setDailyWork(original, daily.overridesFromSheet(original), 2, { attendance: 'present' });
  assert.deepEqual(daily.dailyLocalChanges(original, mine).map((change) => change.field), ['attendance']);
  const latest = fixture(); latest.rows[1].work.weekday_hours = '7'; latest.rows[1].modified = ['weekday_hours'];
  const merged = daily.reapplyDailyChanges(original, mine, latest);
  assert.equal(merged.overrides[2].weekday_hours, '7'); assert.equal(daily.effectiveWork(latest.rows[1], merged.overrides).attendance, 'present');
});

test('default reset reapplies latest defaults and reports employees removed from current roster', () => {
  const original = fixture(); original.rows[0].work.weekday_hours = '7'; original.rows[0].modified = ['weekday_hours'];
  const mine = daily.setDailyWork(original, daily.overridesFromSheet(original), 1, { weekday_hours: '4' });
  const latest = fixture(); latest.rows[0].defaults.weekday_hours = '5'; latest.rows[0].work.weekday_hours = '8'; latest.rows[0].modified = ['weekday_hours'];
  const result = daily.reapplyDailyChanges(original, mine, latest); assert.equal(result.overrides[1], undefined);
  assert.equal(daily.effectiveWork(latest.rows[0], result.overrides).weekday_hours, '5');
  latest.rows = latest.rows.filter((row) => row.employee.id !== 1);
  assert.deepEqual(daily.reapplyDailyChanges(original, mine, latest).removed, [1]);
});

test('date offset crosses months without local timezone drift', () => {
  assert.equal(daily.dailyDateOffset('2026-11-01', -1), '2026-10-31');
  assert.equal(daily.dailyDateOffset('2028-02-28', 1), '2028-02-29');
});

type Element = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value?.props ? [value, ...nodes(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value?.props ? text(value.props.children) : value == null || typeof value === 'boolean' ? '' : String(value);
function editor(options: { canEdit?: boolean; ko?: boolean } = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/hr/DailyWorkPage.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const hooks: any[] = []; let cursor = 0; let pending: { index: number; effect: () => any }[] = [];
  const timerCallbacks = new Map<number, () => void>(); let timerId = 0;
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout(callback: () => void) { const id = ++timerId; timerCallbacks.set(id, callback); return id; }, clearTimeout(id: number) { timerCallbacks.delete(id); }, confirm: () => true } });
  const previews: { payload: any; signal: AbortSignal; resolve: (value: HrDailySheet) => void; reject: (value: unknown) => void }[] = [];
  const saves: any[] = []; let saveFailure: unknown = null; let latest = fixture();
  const dependencies: Record<string, unknown> = {
    'react/jsx-runtime': jsxRuntime,
    react: {
      useState(initial: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [hooks[index], (next: any) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }]; },
      useRef(initial: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
      useEffect(effect: () => any, deps: any[]) { const index = cursor++; const previous = hooks[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) { hooks[index] = { deps, cleanup: previous?.cleanup }; pending.push({ index, effect }); } },
    },
    'react-router-dom': { useLocation: () => ({ pathname: '/hr/daily-work', search: '' }), useNavigate: () => () => {} },
    '../../contexts/AuthContext': { useAuth: () => ({ user: { id: 1, is_active: true, can_access_hr: true } }) },
    '../../domains/auth/hr-access': { canAccessHr }, '../../i18n': { useLang: () => ({ lang: options.ko === false ? 'zh' : 'ko' }) },
    '../../domains/hr/daily-work': daily, '../../domains/hr/labor-standards': { laborDayLabel },
    '../../domains/hr/daily-work-api': {
      previewHrDailyWork: (_: string, payload: any, signal: AbortSignal) => new Promise<HrDailySheet>((resolve, reject) => previews.push({ payload: clone(payload), signal, resolve, reject })),
      getHrDailyWork: async () => clone(latest),
      saveHrDailyWork: async (_: string, payload: any) => { saves.push(clone(payload)); if (saveFailure) throw saveFailure; return clone(latest); },
      createHrDailyEvent: async () => clone(latest),
    },
    './hrCommon': { currentHrMonth: () => '2026-11', HrLoadState: 'HrLoadState', HrShell: 'HrShell', isHrConflict: (value: any) => value?.response?.status === 409 },
    './HrDailyEvents': { default: 'HrDailyEvents' },
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports);
  const initial = fixture(); initial.can_edit = options.canEdit ?? true;
  const props = { initial, ko: options.ko !== false, onActivity: () => {}, onSheet: () => {} };
  const render = () => { if (pending.length) effects(); cursor = 0; pending = []; return nodes(exports.DailySheetEditor(props)); };
  const effects = () => { for (const item of pending) { hooks[item.index].cleanup?.(); hooks[item.index].cleanup = item.effect(); } pending = []; };
  const aria = (label: string) => { const node = render().find((node) => node.props['aria-label'] === label); assert.ok(node, label); return node; };
  const button = (label: string) => { const node = render().find((node) => node.type === 'button' && text(node) === label); assert.ok(node, label); return node; };
  const summary = () => text(render().find((node) => node.props.className === 'hr-daily-summary'));
  return { render, effects, aria, button, summary, previews, saves, timerCount: () => timerCallbacks.size, timers: () => { const callbacks = [...timerCallbacks.values()]; timerCallbacks.clear(); for (const callback of callbacks) callback(); }, setLatest: (value: HrDailySheet) => { latest = value; }, failSave: (error: unknown) => { saveFailure = error; },
    close: () => { for (const hook of hooks) hook?.cleanup?.(); Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow }); },
  };
}

test('editing is immediate while preview totals come only from the newest server response', async () => {
  const form = editor(); try {
    form.render(); form.effects();
    form.aria('90002 평일 야근').props.onChange({ target: { value: '3' } });
    assert.equal(form.aria('90002 평일 야근').props.value, '3'); assert.equal(form.aria('90002 평일 야근').props.className, 'is-edited');
    form.render(); form.effects(); assert.equal(form.timerCount(), 1); assert.ok(form.summary().includes('…')); form.timers();
    assert.equal(form.previews.length, 1); assert.deepEqual(form.previews[0].payload.rows, [{ employee_id: 2, work: { weekday_hours: '3' } }]);
    form.aria('90002 평일 야근').props.onChange({ target: { value: '2' } }); form.render(); form.effects(); form.timers();
    assert.equal(form.previews[0].signal.aborted, true);
    const newest = fixture(); newest.summary.amount = '88.00'; form.previews[1].resolve(newest); await setImmediate();
    assert.match(form.summary(), /88\.00/);
    const old = fixture(); old.summary.amount = '999.00'; form.previews[0].resolve(old); await setImmediate();
    assert.match(form.summary(), /88\.00/); assert.ok(!form.summary().includes('999.00'));
  } finally { form.close(); }
});

test('409 preserves draft and requires explicit merge before using the latest version', async () => {
  const form = editor(); try {
    form.render(); form.effects(); form.aria('90002 평일 야근').props.onChange({ target: { value: '3' } });
    form.failSave({ response: { status: 409 } }); form.button('입력 중으로 저장').props.onClick(); await setImmediate();
    const latest = fixture(); latest.version = 9; latest.context = 'synthetic-context-v9'; latest.rows[1].work.regular_hours = '6'; latest.rows[1].modified = ['regular_hours']; form.setLatest(latest);
    form.render(); form.effects(); await setImmediate();
    assert.equal(form.aria('90002 평일 야근').props.value, '3'); assert.equal(form.button('입력 중으로 저장').props.disabled, true);
    form.button('내 변경을 최신에 다시 적용').props.onClick();
    assert.equal(form.aria('90002 정규 시간').props.value, '6'); assert.equal(form.aria('90002 평일 야근').props.value, '3');
    form.failSave(null); form.button('입력 중으로 저장').props.onClick(); await setImmediate();
    assert.equal(form.saves[1].version, 9); assert.equal(form.saves[1].context, 'synthetic-context-v9');
    assert.deepEqual(form.saves[1].rows, [{ employee_id: 2, work: { regular_hours: '6', weekday_hours: '3' } }]);
  } finally { form.close(); }
});

test('read-only sheet and non-applicable hour fields stay disabled with Chinese labels', () => {
  const form = editor({ canEdit: false, ko: false }); try {
    assert.equal(form.aria('90002 平日加班').props.disabled, true); assert.equal(form.button('保存为填写中').props.disabled, true);
    assert.equal(/[가-힣]/.test(form.summary()), false);
  } finally { form.close(); }
  const writable = editor(); try { assert.equal(writable.aria('90003 평일 야근').props.disabled, true); assert.equal(writable.aria('90001 정규 시간').props.disabled, true); } finally { writable.close(); }
});

function eventForm(blocked = false) {
  const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/hr/HrDailyEvents.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const values: any[] = []; let cursor = 0; const requests: any[] = [];
  const dependencies: Record<string, unknown> = {
    'react/jsx-runtime': jsxRuntime,
    react: { useEffect() {}, useState(initial: unknown) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], (next: unknown) => { values[index] = next; }]; } },
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports);
  const render = () => { cursor = 0; return nodes(exports.default({ sheet: fixture(), ko: true, busy: false, blocked, onDraft: () => {}, onSubmit: async (value: any) => { requests.push(clone(value)); return true; } })); };
  const labelText = (value: any): string => Array.isArray(value) ? value.map(labelText).join('') : value?.props ? (['input', 'select', 'textarea'].includes(String(value.type)) ? '' : labelText(value.props.children)) : value == null || typeof value === 'boolean' ? '' : String(value);
  const field = (label: string) => { const wrapper = render().find((node) => node.type === 'label' && labelText(node) === label); assert.ok(wrapper, label); const control = nodes(wrapper).find((node) => ['input', 'select', 'textarea'].includes(String(node.type))); assert.ok(control, label); return control; };
  return { requests, render, change: (label: string, value: string) => field(label).props.onChange({ target: { value } }),
    submit: async () => { render().find((node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} }); await setImmediate(); } };
}

test('contract hire requires explicit base salary and fixed overtime, including a confirmed zero', async () => {
  const form = eventForm();
  form.change('신규 사번', '90009'); form.change('신규 이름', '测试新员工'); form.change('변경 부서', '测试部门'); form.change('변경 직무', 'Synthetic operator'); form.change('인원 변동 사유', 'Synthetic hire');
  await form.submit(); assert.equal(form.requests.length, 0);
  form.change('기본급 (CNY)', '3000'); form.change('고정 연장수당 (CNY)', '0');
  await form.submit(); assert.equal(form.requests.length, 1);
  assert.equal(form.requests[0].changes.base_salary, '3000'); assert.equal(form.requests[0].changes.fixed_overtime, '0');
});

test('employment change omits hidden contract amounts when switching to hourly', async () => {
  const form = eventForm(); form.change('변동 종류', 'employment_change'); form.change('변동 직원', '1');
  form.change('기본급 (CNY)', '3000'); form.change('고정 연장수당 (CNY)', '50'); form.change('변경 고용형태', 'hourly'); form.change('시급 예외 (선택)', '25'); form.change('인원 변동 사유', 'Synthetic type conversion');
  await form.submit(); assert.deepEqual(form.requests[0].changes, { employment_type: 'hourly', hourly_rate: '25' });
});

test('unsaved work blocks personnel events without discarding event input', async () => {
  const form = eventForm(true); form.change('변동 종류', 'terminate'); form.change('변동 직원', '1'); form.change('인원 변동 사유', 'Synthetic termination');
  await form.submit(); assert.equal(form.requests.length, 0);
  assert.ok(form.render().some((node) => node.type === 'input' && node.props.value === 'Synthetic termination'));
});
