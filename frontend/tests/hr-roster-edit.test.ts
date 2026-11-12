import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import { filterRoster, rosterCounts, rosterHistoryChanges } from '../src/domains/hr/roster.ts';

const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/hr/HrRosterPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : value?.props ? [value, ...nodes(value.props.children)] : [];

function editor(lang: 'ko' | 'zh' = 'zh', beginEdit = true) {
  const state: unknown[] = [];
  let cursor = 0;
  const requests: unknown[][] = [];
  let responseError: unknown = null;
  let retries = 0;
  const dependencies: Record<string, unknown> = {
    'react/jsx-runtime': jsxRuntime,
    react: { Fragment: jsxRuntime.Fragment, useEffect: () => {}, useState(initial: unknown) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (next: unknown) => { state[index] = next; }];
    } },
    '../../i18n': { useLang: () => ({ lang }) },
    '../../domains/hr/api': { updateHrRoster: async (...args: unknown[]) => { requests.push(args); if (responseError) throw responseError; return []; } },
    './hrCommon': { isHrConflict: (error: any) => error?.response?.status === 409 },
    '../../domains/hr/roster': { filterRoster, rosterCounts, rosterHistoryChanges },
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => {
    assert.ok(name in dependencies, name); return dependencies[name];
  }, exports);
  const props = {
    month: '2026-11', entries: [{ id: 1, code: '90001', name: '测试甲', employment_type: 'contract',
      department: '测试部门', status: 'active', first_month: '2026-01', last_month: '2026-11',
      version: 4, previous_codes: [], in_month: true }],
    onUpdated: () => {}, error: false, onRetry: () => { retries += 1; }, disabled: false,
  };
  const render = () => { cursor = 0; return nodes(exports.default(props)); };
  const button = (label: string) => render().find((node) => node.type === 'button' && node.props.children === label)!;
  if (beginEdit) button(lang === 'ko' ? '편집' : '编辑').props.onClick();
  return { render, button, requests, props, exports, failWith: (error: unknown) => { responseError = error; }, retries: () => retries,
    code: () => render().find((node) => node.type === 'input' && node.props.maxLength === 64)!,
    status: () => render().find((node) => node.type === 'select' && node.props.value === 'active' && node.props['aria-label'] === (lang === 'ko' ? '상태' : '状态'))!,
    reason: () => render().find((node) => node.type === 'input' && node.props.maxLength === 500),
    submit: async () => {
      render().find((node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
      await setImmediate();
    },
  };
}

test('status-only change reveals required reason and blocks blank submission', async () => {
  const form = editor();
  assert.equal(form.reason(), undefined);
  form.status().props.onChange({ target: { value: 'departed' } });
  assert.equal(form.reason()!.props.required, true);
  assert.equal(form.button('保存').props.disabled, true);
  form.reason()!.props.onChange({ target: { value: '   ' } });
  await form.submit();
  assert.equal(form.requests.length, 0);
});

test('unchanged draft cannot submit a redundant update', async () => {
  const form = editor();
  assert.equal(form.button('保存').props.disabled, true);
  await form.submit();
  assert.equal(form.requests.length, 0);
});

test('status-only change sends the version and trimmed reason', async () => {
  const form = editor('ko');
  form.status().props.onChange({ target: { value: 'departed' } });
  form.reason()!.props.onChange({ target: { value: '  합성 상태 변경  ' } });
  assert.equal(form.button('저장').props.disabled, false);
  await form.submit();
  assert.deepEqual(form.requests, [['2026-11', 1, { version: 4, status: 'departed', reason: '합성 상태 변경' }]]);
});

test('combined code and status change sends one reason for the complete edit', async () => {
  const form = editor();
  form.code().props.onChange({ target: { value: '90002' } });
  form.status().props.onChange({ target: { value: 'departed' } });
  form.reason()!.props.onChange({ target: { value: '测试变更' } });
  await form.submit();
  assert.deepEqual(form.requests, [['2026-11', 1, { version: 4, status: 'departed', code: '90002', reason: '测试变更' }]]);
});

test('code-only change omits unchanged status', async () => {
  const form = editor();
  form.code().props.onChange({ target: { value: '90002' } });
  form.reason()!.props.onChange({ target: { value: '测试工号变更' } });
  await form.submit();
  assert.deepEqual(form.requests, [['2026-11', 1, { version: 4, code: '90002', reason: '测试工号变更' }]]);
});


test('summary filters select their counted population and reset unrelated filters', () => {
  const form = editor('ko', false);
  const base = form.props.entries[0];
  form.props.entries.push({ ...base, id: 2, code: '90002', name: '测试乙', status: 'departed', in_month: false });
  const summary = () => form.render().find((node) => node.props.className === 'hr-summary-strip hr-roster-summary')!;
  const cards = () => nodes(summary()).filter((node) => node.type === 'button');
  const names = () => form.render().filter((node) => node.type === 'td' && typeof node.props.children === 'string').map((node) => node.props.children);
  form.render().find((node) => node.type === 'input' && node.props.type === 'search')!.props.onChange({ target: { value: 'not-found' } });
  assert.ok(!names().includes('测试甲'));
  cards()[0].props.onClick();
  assert.ok(names().includes('测试甲')); assert.ok(!names().includes('测试乙'));
  cards()[1].props.onClick();
  assert.ok(!names().includes('测试甲')); assert.ok(names().includes('测试乙'));
  cards()[2].props.onClick();
  assert.ok(!names().includes('测试甲')); assert.ok(names().includes('测试乙'));
  form.button('초기화').props.onClick();
  assert.ok(names().includes('测试甲')); assert.ok(names().includes('测试乙'));
});

test('history expansion is accessible and renders only changed fields with actor and reason', () => {
  const form = editor('ko', false);
  const expand = () => form.render().find((node) => node.type === 'button' && node.props['aria-label'] === '90001 测试甲 변경 이력')!;
  assert.equal(expand().props['aria-expanded'], false);
  expand().props.onClick();
  assert.equal(expand().props['aria-expanded'], true);
  assert.ok(form.render().some((node) => node.props.id === 'hr-roster-history-1'));
  const history = [{ id: 4, created_at: '2026-11-12T01:00:00Z', actor_label: 'Synthetic admin', reason: 'Synthetic status correction',
    previous_code: '90001', new_code: '90002', previous_status: 'active', new_status: 'departed',
    previous_employment_type: 'contract', new_employment_type: 'contract', previous_department: 'Test', new_department: 'Test' }];
  const historyNodes = nodes(form.exports.HrRosterHistoryList({ history, ko: true }));
  const strongLabels = historyNodes.filter((node) => node.type === 'strong').map((node) => node.props.children);
  assert.deepEqual(strongLabels, ['사번', '상태', ['사유', ':']]);
  const rendered = JSON.stringify(historyNodes);
  assert.ok(rendered.includes('Synthetic admin')); assert.ok(rendered.includes('Synthetic status correction'));
  assert.ok(rendered.includes('2026-11-12T01:00:00Z')); assert.ok(rendered.includes('90002'));
});


test('409 keeps the original draft and prevents resubmission until explicit restart', async () => {
  const form = editor('ko');
  form.failWith({ response: { status: 409 } });
  form.code().props.onChange({ target: { value: '90009' } });
  form.reason()!.props.onChange({ target: { value: '합성 수정 사유' } });
  await form.submit();
  form.props.entries[0] = { ...form.props.entries[0], version: 5, code: '90008' };
  assert.equal(form.retries(), 1);
  assert.equal(form.code().props.value, '90009');
  assert.equal(form.reason()!.props.value, '합성 수정 사유');
  assert.equal(form.button('저장').props.disabled, true);
  await form.submit();
  assert.equal(form.requests.length, 1);
  assert.equal((form.requests[0][2] as { version: number }).version, 4);
  form.button('취소').props.onClick();
  form.button('편집').props.onClick();
  assert.equal(form.code().props.value, '90008');
});
