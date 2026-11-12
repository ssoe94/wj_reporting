import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import * as labor from '../src/domains/hr/labor-standards.ts';
import { canAccessHr } from '../src/domains/auth/hr-access.ts';
import type { HrLaborCalendar, HrLaborRules, HrLaborStandards } from '../src/domains/hr/labor-standards.ts';

type Element = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : value?.props ? [value, ...nodes(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('')
  : value?.props ? (['input', 'select', 'textarea'].includes(String(value.type)) ? '' : text(value.props.children)) : value == null || typeof value === 'boolean' ? '' : String(value);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function rulesFixture(): HrLaborRules {
  const missing = { rate_percent: null, base: null, fixed_amount: null };
  return {
    multipliers: { workday: '1.5', rest_day: '2', public_holiday: '3' },
    contract: { days_per_month: '21.75', hours_per_day: '8' },
    hourly_premium: { enabled: false, confirmed: false },
    department_overtime: { '测试部门甲': '4', '测试部门乙': null },
    weekday_excluded_titles: { titles: [], confirmed: false },
    department_hours_include_fixed_overtime: null,
    employer_contributions: {
      social_insurance: { contract: { ...missing }, hourly: { ...missing } },
      housing_fund: { contract: { ...missing }, hourly: { ...missing } },
    },
  };
}
function standardsFixture(): HrLaborStandards {
  return { month: '2026-11', version: 4, source_month: '2026-11', source_version: 4,
    rules: rulesFixture(), periods: [{ month: '2026-11', version: 4 }], history: [] };
}
function calendarFixture(): HrLaborCalendar {
  return { month: '2026-11', version: 2, days: {}, history: [] };
}

function harness(kind: 'rules' | 'calendar' | 'page' = 'rules', options: { ko?: boolean; initial?: HrLaborStandards | HrLaborCalendar; user?: unknown } = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/hr/LaborStandardsPage.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const state: unknown[] = []; let cursor = 0; let error: unknown = null; let restarts = 0;
  let effects: (() => unknown)[] = [];
  const requests: { kind: string; month: string; payload: Record<string, unknown> }[] = [];
  const initial = clone(options.initial ?? (kind === 'calendar' ? calendarFixture() : standardsFixture()));
  const getRequests: string[] = [];
  const dependencies: Record<string, unknown> = {
    'react/jsx-runtime': jsxRuntime,
    react: { useEffect: (callback: () => unknown) => { effects.push(callback); }, useState(value: unknown) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof value === 'function' ? (value as () => unknown)() : value;
      return [state[index], (next: unknown) => { state[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(state[index]) : next; }];
    } },
    '../../contexts/AuthContext': { useAuth: () => ({ user: options.user ?? null }) },
    '../../domains/auth/hr-access': { canAccessHr },
    '../../i18n': { useLang: () => ({ lang: options.ko === false ? 'zh' : 'ko' }) },
    '../../domains/hr/labor-standards': labor,
    '../../domains/hr/labor-standards-api': {
      getHrLaborStandards: async () => { getRequests.push('standards'); return standardsFixture(); },
      getHrLaborCalendar: async () => { getRequests.push('calendar'); return calendarFixture(); },
      saveHrLaborStandards: async (month: string, payload: Record<string, unknown>) => {
        requests.push({ kind: 'rules', month, payload: clone(payload) }); if (error) throw error;
        return { ...standardsFixture(), month, version: Number(payload.version) + 1, rules: clone(payload.rules), history: [] };
      },
      saveHrLaborCalendar: async (month: string, payload: Record<string, unknown>) => {
        requests.push({ kind: 'calendar', month, payload: clone(payload) }); if (error) throw error;
        return { ...calendarFixture(), month, version: Number(payload.version) + 1, days: clone(payload.days), history: [] };
      },
    },
    './hrCommon': { currentHrMonth: () => '2026-11', HrShell: 'HrShell', HrLoadState: 'HrLoadState', isHrConflict: (failure: any) => failure?.response?.status === 409 },
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports);
  const props = { initial, ko: options.ko !== false, onActivity: () => {}, restart: () => { restarts += 1; } };
  const render = () => { cursor = 0; effects = []; return nodes(kind === 'page' ? exports.default() : (kind === 'rules' ? exports.LaborRulesForm(props) : exports.LaborCalendarForm(props))); };
  const field = (label: string) => {
    const node = render().find((node) => node.type === 'label' && text(node) === label);
    assert.ok(node, `Missing label ${label}`);
    const input = nodes(node).find((node) => ['input', 'select', 'textarea'].includes(String(node.type)));
    assert.ok(input, `Missing input ${label}`); return input;
  };
  const button = (label: string) => {
    const node = render().find((node) => node.type === 'button' && text(node) === label);
    assert.ok(node, `Missing button ${label}`); return node;
  };
  return { render, field, button, requests, getRequests, props, exports, restarts: () => restarts, runEffects: () => { for (const effect of effects) effect(); },
    failWith: (failure: unknown) => { error = failure; },
    change: (label: string, value: string) => field(label).props.onChange({ target: { value } }),
    submit: async () => { render().find((node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} }); await setImmediate(); },
  };
}

test('pending standards distinguish unknown values from confirmed zero and false', () => {
  const missing = rulesFixture();
  const pending = labor.pendingLaborItems(missing, true);
  assert.equal(pending.length, 8);
  assert.ok(pending.includes('测试部门乙 야근 시간 미입력'));
  const confirmed = clone(missing);
  confirmed.hourly_premium.confirmed = true;
  confirmed.weekday_excluded_titles.confirmed = true;
  confirmed.department_hours_include_fixed_overtime = false;
  confirmed.department_overtime['测试部门乙'] = '0';
  for (const fund of Object.values(confirmed.employer_contributions)) for (const item of Object.values(fund)) {
    item.rate_percent = '0'; item.base = 'fixed'; item.fixed_amount = '0';
  }
  assert.deepEqual(labor.pendingLaborItems(confirmed, true), []);
  confirmed.employer_contributions.social_insurance.contract.fixed_amount = null;
  assert.deepEqual(labor.pendingLaborItems(confirmed, true), ['사회보험 · 계약직 미입력']);
});

test('Chinese unknown labels contain no Korean and remain distinct from zero', () => {
  const pending = labor.pendingLaborItems(rulesFixture(), false);
  assert.equal(pending.length, 8); assert.ok(pending.some((item) => item.includes('未确认')));
  assert.ok(pending.some((item) => item.includes('未填写')));
  assert.equal(/[가-힣]/.test(pending.join(' ')), false);
});

test('calendar enumerates real month dates and applies weekend defaults without holidays', () => {
  assert.equal(labor.laborCalendarDates('2026-11').length, 30);
  assert.equal(labor.laborCalendarDates('2028-02').length, 29);
  assert.equal(labor.laborCalendarDates('2027-02').length, 28);
  assert.equal(labor.laborDefaultDay('2026-11-14'), 'rest_day');
  assert.equal(labor.laborDefaultDay('2026-11-15'), 'rest_day');
  assert.equal(labor.laborDefaultDay('2026-11-16'), 'workday');
  assert.ok(labor.laborCalendarDates('2026-11').every((day) => ['workday', 'rest_day'].includes(labor.laborDefaultDay(day))));
});

test('history lists nested changes, additions and removals while preserving zero and false', () => {
  assert.deepEqual(labor.laborHistoryChanges({ multipliers: { workday: '1.5', rest_day: '2' }, value: null, confirmed: null, deleted: 'old' },
    { multipliers: { workday: '1.75', rest_day: '2' }, value: '0', confirmed: false, titles: ['Synthetic title'] }), [
    { path: 'multipliers.workday', before: '1.5', after: '1.75' },
    { path: 'value', before: null, after: '0' },
    { path: 'confirmed', before: null, after: false },
    { path: 'deleted', before: 'old', after: undefined },
    { path: 'titles', before: undefined, after: ['Synthetic title'] },
  ]);
  assert.deepEqual(labor.laborHistoryChanges(null, { rate: null }), [{ path: 'rate', before: undefined, after: null }]);
});

test('standards form requires a reason and submits exact current version with edited rules', async () => {
  const form = harness();
  form.change('근무일 배수', '1.75');
  assert.equal(form.button('기준 저장').props.disabled, true);
  form.change('기준 변경 사유', '  '); await form.submit();
  assert.equal(form.requests.length, 0);
  form.change('기준 변경 사유', '  Synthetic multiplier update  ');
  assert.equal(form.button('기준 저장').props.disabled, false);
  await form.submit();
  assert.equal(form.requests.length, 1);
  const request = form.requests[0];
  assert.equal(request.month, '2026-11'); assert.equal(request.payload.version, 4);
  assert.equal(request.payload.reason, 'Synthetic multiplier update');
  assert.equal((request.payload.rules as HrLaborRules).multipliers.workday, '1.75');
  assert.equal(form.field('기준 변경 사유').props.value, '');
  assert.equal(form.button('기준 저장').props.disabled, true);
});

test('standards 409 preserves rule and reason draft and prevents an implicit retry', async () => {
  const form = harness(); form.failWith({ response: { status: 409 } });
  form.change('근무일 배수', '1.75'); form.change('기준 변경 사유', 'Synthetic conflict draft');
  await form.submit();
  assert.equal(form.field('근무일 배수').props.value, '1.75');
  assert.equal(form.field('기준 변경 사유').props.value, 'Synthetic conflict draft');
  assert.equal(form.button('기준 저장').props.disabled, true);
  assert.equal(form.restarts(), 0);
  const feedback = form.render().find((node) => typeof node.type === 'function' && node.type.name === 'SaveFeedback');
  assert.equal(feedback?.props.conflict, true);
  await form.submit(); assert.equal(form.requests.length, 1);
  assert.equal(form.requests[0].payload.version, 4);
});

test('new effective month can persist its inherited unchanged draft only with an explicit reason', async () => {
  const initial = standardsFixture(); initial.version = 0; initial.source_month = '2026-10'; initial.source_version = 3;
  const form = harness('rules', { initial });
  assert.ok(form.render().some((node) => node.props.role === 'status' && text(node).includes('미저장 초안')));
  await form.submit(); assert.equal(form.requests.length, 0);
  form.change('기준 변경 사유', 'Synthetic new effective month'); await form.submit();
  assert.equal(form.requests[0].payload.version, 0);
  assert.deepEqual(form.requests[0].payload.rules, initial.rules);
});

test('standards rejects empty or duplicate department labels without losing the draft', async () => {
  const form = harness();
  const row = form.render().find((node) => node.type === 'input' && node.props['aria-label'] === '부서 원본 라벨 2')!;
  row.props.onChange({ target: { value: '测试部门甲' } });
  form.change('기준 변경 사유', 'Synthetic duplicate label');
  assert.equal(form.button('기준 저장').props.disabled, true);
  await form.submit(); assert.equal(form.requests.length, 0);
  assert.ok(form.render().some((node) => node.props.role === 'alert' && text(node).includes('중복')));
});

test('conflict restart requires the user to explicitly discard the preserved draft', async () => {
  const form = harness(); form.failWith({ response: { status: 409 } });
  form.change('근무일 배수', '1.75'); form.change('기준 변경 사유', 'Synthetic conflict draft');
  await form.submit();
  const feedback = form.render().find((node) => typeof node.type === 'function' && node.type.name === 'SaveFeedback')!;
  const controls = nodes((feedback.type as (props: any) => unknown)(feedback.props));
  const restart = controls.find((node) => node.type === 'button')!;
  const previous = (globalThis as any).window;
  try {
    (globalThis as any).window = { confirm: () => false };
    restart.props.onClick(); assert.equal(form.restarts(), 0);
    assert.equal(form.field('근무일 배수').props.value, '1.75');
    (globalThis as any).window = { confirm: () => true };
    restart.props.onClick(); assert.equal(form.restarts(), 1);
  } finally {
    if (previous === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previous;
  }
});

test('calendar saves reviewed overrides with a trimmed reason and its independent version', async () => {
  const form = harness('calendar');
  const day = (date: string) => form.render().find((node) => node.type === 'button' && node.props['data-date'] === date)!;
  assert.equal(day('2026-11-14').props['data-day-type'], 'rest_day');
  assert.equal(day('2026-11-15').props['data-day-type'], 'rest_day');
  day('2026-11-14').props.onClick(); form.change('선택 날짜 유형', 'adjusted_workday');
  assert.equal(day('2026-11-14').props['data-day-type'], 'adjusted_workday');
  day('2026-11-16').props.onClick(); form.change('선택 날짜 유형', 'public_holiday');
  assert.equal(form.button('달력 저장').props.disabled, true);
  await form.submit(); assert.equal(form.requests.length, 0);
  form.change('달력 변경 사유', '  Synthetic calendar review  '); await form.submit();
  assert.deepEqual(form.requests, [{ kind: 'calendar', month: '2026-11', payload: {
    version: 2, reason: 'Synthetic calendar review', days: { '2026-11-14': 'adjusted_workday', '2026-11-16': 'public_holiday' },
  } }]);
  assert.equal(form.field('달력 변경 사유').props.value, '');
  assert.equal(form.button('달력 저장').props.disabled, true);
});

test('calendar 409 retains the selected override and reason without rebasing the version', async () => {
  const form = harness('calendar'); form.failWith({ response: { status: 409 } });
  form.render().find((node) => node.type === 'button' && node.props['data-date'] === '2026-11-14')!.props.onClick();
  form.change('선택 날짜 유형', 'adjusted_workday'); form.change('달력 변경 사유', 'Synthetic calendar conflict');
  await form.submit();
  assert.equal(form.field('선택 날짜 유형').props.value, 'adjusted_workday');
  assert.equal(form.field('달력 변경 사유').props.value, 'Synthetic calendar conflict');
  assert.equal(form.button('달력 저장').props.disabled, true);
  assert.equal(form.restarts(), 0);
  await form.submit(); assert.equal(form.requests.length, 1);
  assert.equal(form.requests[0].payload.version, 2);
});

test('restoring weekday defaults removes only the override from the save payload', async () => {
  const initial = calendarFixture(); initial.days = { '2026-11-14': 'adjusted_workday', '2026-11-16': 'public_holiday' };
  const form = harness('calendar', { initial });
  form.render().find((node) => node.type === 'button' && node.props['data-date'] === '2026-11-14')!.props.onClick();
  form.change('선택 날짜 유형', '');
  const restored = form.render().find((node) => node.type === 'button' && node.props['data-date'] === '2026-11-14')!;
  assert.equal(restored.props['data-day-type'], 'rest_day'); assert.equal(restored.props['data-override'], false);
  form.change('달력 변경 사유', 'Synthetic restore default'); await form.submit();
  assert.deepEqual(form.requests[0].payload.days, { '2026-11-16': 'public_holiday' });
});

test('standards page denies ungranted and inactive accounts before fetching private data', () => {
  for (const user of [null, { id: 1, is_active: true, is_staff: true }, { id: 2, is_active: false, is_superuser: true }]) {
    const page = harness('page', { user });
    const output = page.render(); page.runEffects();
    assert.ok(output.some((node) => node.type === 'HrLoadState' && node.props.allowed === false));
    assert.equal(output.some((node) => node.type === 'HrShell'), false);
    assert.deepEqual(page.getRequests, []);
  }
  const allowed = harness('page', { user: { id: 3, is_active: true, can_access_hr: true } });
  assert.ok(allowed.render().some((node) => node.type === 'HrShell' && node.props.page === 'labor-standards'));
  allowed.runEffects(); assert.deepEqual(allowed.getRequests, ['standards', 'calendar']);
});
