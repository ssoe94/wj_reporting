import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/hr/HrRosterPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : value?.props ? [value, ...nodes(value.props.children)] : [];

function editor(lang: 'ko' | 'zh' = 'zh') {
  const state: unknown[] = [];
  let cursor = 0;
  const requests: unknown[][] = [];
  const dependencies: Record<string, unknown> = {
    'react/jsx-runtime': jsxRuntime,
    react: { useState(initial: unknown) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (next: unknown) => { state[index] = next; }];
    } },
    '../../i18n': { useLang: () => ({ lang }) },
    '../../domains/hr/api': { updateHrRoster: async (...args: unknown[]) => { requests.push(args); return []; } },
    './hrCommon': { isHrConflict: () => false },
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => {
    assert.ok(name in dependencies, name); return dependencies[name];
  }, exports);
  const props = {
    month: '2026-11', entries: [{ id: 1, code: '90001', name: '测试甲', employment_type: 'contract',
      department: '测试部门', status: 'active', first_month: '2026-01', last_month: '2026-11',
      version: 4, previous_codes: [], in_month: true }],
    onUpdated: () => {}, error: false, onRetry: () => {}, disabled: false,
  };
  const render = () => { cursor = 0; return nodes(exports.default(props)); };
  const button = (label: string) => render().find((node) => node.type === 'button' && node.props.children === label)!;
  button(lang === 'ko' ? '편집' : '编辑').props.onClick();
  return { render, button, requests,
    code: () => render().find((node) => node.type === 'input' && node.props.maxLength === 64)!,
    status: () => render().find((node) => node.type === 'select' && node.props.value === 'active' && !node.props['aria-label'])!,
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
