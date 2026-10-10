import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as model from '../src/domains/quality/action-result-translation.ts';
import type { ActionResultTranslation } from '../src/domains/quality/action-result-translation.ts';

// Synthetic fixtures only. No API, production records or local model calls.
const original = '已返工 20 件\n待确认 PART-A';
const translated: ActionResultTranslation = {
  language: 'ko', text: '20개 재작업 완료\nPART-A 확인 대기', status: 'translated',
  translated_at: '2026-10-10T01:00:00Z', model_name: 'Qwen3.8', prompt_version: 'synthetic.v1',
};

test('Korean uses accepted translation while Chinese preserves the original text', () => {
  const before = JSON.stringify(translated);
  assert.deepEqual(model.getActionResultDisplay(original, translated, 'ko'), {
    original, text: translated.text, translated: true, status: null,
  });
  assert.deepEqual(model.getActionResultDisplay(original, translated, 'zh'), {
    original, text: original, translated: false, status: null,
  });
  assert.equal(JSON.stringify(translated), before);
});

test('pending and failed results never display an old translation', () => {
  for (const status of ['pending', 'failed'] as const) {
    const translation = { ...translated, status };
    assert.deepEqual(model.getActionResultDisplay(original, translation, 'ko'), {
      original, text: original, translated: false, status,
    });
    assert.equal(model.getActionResultDisplay(original, translation, 'zh').status, null);
  }
  assert.equal(model.getActionResultDisplay(original, { ...translated, status: 'not_required' }, 'ko').text, original);
  assert.equal(model.getActionResultDisplay(original, { ...translated, text: '  ' }, 'ko').text, original);
  assert.equal(model.getActionResultDisplay(original, undefined, 'ko').text, original);
  assert.equal(model.getActionResultDisplay('', translated, 'ko').text, '');
});

type Element = { type: unknown; props: Record<string, any> };
function nodes(node: any): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return node?.props ? [node, ...nodes(node.props.children)] : [];
}
function text(node: any): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  return node?.props ? text(node.props.children) : String(node);
}

function harness(lang: 'ko' | 'zh', canEdit: boolean, translation = translated) {
  const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/quality/QualityActionResult.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const element = (type: unknown, props: any) => ({ type, props });
  const dependencies: Record<string, unknown> = {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'lucide-react': { Save: 'icon' },
    '../../components/ui/button': { Button: 'button' },
    '../../components/ui/textarea': { Textarea: 'textarea' },
    '../../i18n': { useLang: () => ({ lang, t: (key: string) => key }) },
    '../../domains/quality/action-result-translation': model,
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected module: ${name}`);
    return dependencies[name];
  }, exports);
  let props = {
    source: original, translation, editorId: 'synthetic-original', contextLabel: '2026-10-10 · MODEL-A',
    canEdit, editing: false, sourceDraft: original, saving: false, disabled: false,
    onStartEditing: () => { props = { ...props, editing: true }; },
    onSourceChange: (source: string) => { props = { ...props, sourceDraft: source }; },
    onSave: () => { updates.push(model.actionResultSourceUpdate(props.sourceDraft)); },
    onCancel: () => { props = { ...props, editing: false }; },
  };
  const updates: { action_result: string }[] = [];
  const render = () => exports.default(props);
  return {
    render, updates,
    setProps: (patch: Partial<typeof props>) => { props = { ...props, ...patch }; },
  };
}

test('translation is default text with a closed original disclosure and no editor for viewers', () => {
  const view = harness('ko', false); const tree = view.render();
  assert.equal(text(nodes(tree).find((node) => node.type === 'p')), translated.text);
  const disclosure = nodes(tree).find((node) => node.type === 'details')!;
  assert.ok(!disclosure.props.open);
  assert.equal(text(nodes(disclosure).find((node) => node.type === 'summary')), '중국어 원문 보기');
  assert.equal(text(nodes(disclosure).find((node) => node.type === 'p')), original);
  assert.equal(nodes(tree).some((node) => node.type === 'textarea' || node.type === 'button'), false);

  const chinese = harness('zh', false).render();
  assert.equal(text(nodes(chinese).find((node) => node.type === 'p')), original);
  assert.equal(nodes(chinese).some((node) => node.type === 'details'), false);
});

test('an explicit original edit retains Chinese in the editor and submits only the source draft', () => {
  const view = harness('ko', true);
  let tree = view.render();
  assert.equal(nodes(tree).some((node) => node.type === 'textarea'), false);
  const edit = nodes(tree).find((node) => node.type === 'button' && text(node) === '원문 수정')!;
  edit.props.onClick();
  tree = view.render();
  const editor = nodes(tree).find((node) => node.type === 'textarea')!;
  assert.equal(editor.props.value, original);
  assert.equal(editor.props.id, 'synthetic-original');
  assert.match(editor.props['aria-label'], /원문 수정 · 2026-10-10 · MODEL-A/);
  editor.props.onChange({ target: { value: '  已返工 21 件\n待确认 PART-A  ' } });
  tree = view.render();
  nodes(tree).find((node) => node.type === 'button' && text(node).includes('quality.save_action'))!.props.onClick();
  assert.deepEqual(view.updates, [{ action_result: '  已返工 21 件\n待确认 PART-A  ' }]);
  assert.equal(JSON.stringify(view.updates).includes(translated.text), false);
});

test('pending and failed fallback retain the source without exposing model internals', () => {
  for (const status of ['pending', 'failed'] as const) {
    const view = harness('ko', false, { ...translated, status });
    const tree = view.render();
    assert.equal(text(nodes(tree).find((node) => node.type === 'p')), original);
    assert.equal(nodes(tree).filter((node) => node.props.role === 'status').length, 1);
    assert.equal(nodes(tree).some((node) => node.type === 'details'), false);
    assert.equal(text(tree).includes(translated.model_name), false);
    assert.equal(text(tree).includes(translated.prompt_version), false);
  }
});
