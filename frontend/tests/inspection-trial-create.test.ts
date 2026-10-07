import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as model from '../src/pages/quality/inspection-requests/model.ts';
import * as roleModel from '../src/pages/quality/inspection-requests/roleModel.ts';
import * as copy from '../src/pages/quality/inspection-requests/copy.ts';
import { inspectionRoleCopy } from '../src/pages/quality/inspection-requests/roleCopy.ts';
import * as workflow from '../src/pages/quality/inspection-requests/workflow.ts';
const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/NewInspectionRequest.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: unknown; props: Record<string, any> };
const elements = (node: any): Element[] => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === 'object' && node.props ? [node, ...elements(node.props.children)] : [];
const content = (node: any): string => Array.isArray(node) ? node.map(content).join('') : node == null || typeof node === 'boolean' ? '' : typeof node === 'object' ? content(node.props?.children) : String(node);
function harness(allowed: boolean | undefined) {
  const states: any[] = []; let cursor = 0; let key = 0;
  const calls: { endpoint: string; attempt: workflow.MutationAttempt; sessionId: string }[] = [];
  const created: unknown[] = []; let failOnce = true;
  const dependencies: Record<string, unknown> = {
    react: { useState: (initial: any) => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], (next: any) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; }, useRef: (value: any) => { const index = cursor++; return states[index] ??= { current: value }; }, useCallback: (fn: unknown) => fn, useEffect: () => {} },
    'react/jsx-runtime': { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }) },
    '@/domains/auth/auth-transition': { assertAuthSessionCurrent: (session: string) => assert.equal(session, 'fixture-session') },
    'lucide-react': { Plus: 'Icon' }, './copy': copy, './roleCopy': { inspectionRoleCopy }, './workflow': { ...workflow, createInspectionKey: () => `fixture-${++key}` },
    './roleModel': roleModel,
    './api': { ...model,
      createIntegrationTrial: async (attempt: workflow.MutationAttempt, sessionId: string) => { calls.push({ endpoint: 'trial', attempt, sessionId }); if (failOnce) { failOnce = false; throw new Error('network'); } return { id: 42, source_kind: 'integration_test' }; },
      mutateInspectionRequest: async (_id: number, attempt: workflow.MutationAttempt, sessionId: string) => { calls.push({ endpoint: 'production', attempt, sessionId }); return { id: 43 }; },
    },
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports);
  const render = () => { cursor = 0; return exports.default({ userId: 1, sessionId: 'fixture-session', lang: 'ko', dataMode: 'wj_local_beta', canPrepareIntegrationTrial: allowed, onCreated: (item: unknown) => created.push(item), onCancel: () => {}, onDirty: () => {}, onLocked: () => {} }); };
  return { render, calls, created, revoke: () => { allowed = false; } };
}
test('missing or false trial capability keeps ordinary production form and hides trial mode', () => {
  for (const allowed of [undefined, false]) {
    const tree = harness(allowed).render();
    assert.equal(elements(tree).some(node => node.type === 'select' && node.props.value === 'production'), false);
    assert.ok(elements(tree).some(node => node.type === 'input' && node.props.type === 'datetime-local'));
  }
});
test('area-split opt-in requires a second item without dispatching a one-area request', () => {
  const fixture = harness(false);
  let tree = fixture.render();
  const label = elements(tree).find(node => node.type === 'label' && content(node).includes(inspectionRoleCopy.ko.optIn))!;
  elements(label).find(node => node.type === 'input' && node.props.type === 'checkbox')!.props.onChange({ target: { checked: true } });
  tree = fixture.render();
  const initialItems = elements(tree).filter(node => node.type === 'fieldset' && node.props.className === 'inspection-item' && content(elements(node).find(child => child.type === 'legend')).startsWith(`${copy.inspectionCopy.ko.itemName} `));
  assert.equal(initialItems.length, 2, 'Production preparation starts with dimension and appearance items');
  elements(initialItems[1]).find(node => node.type === 'button' && node.props['aria-label'] === `${copy.inspectionCopy.ko.remove}: ${copy.inspectionCopy.ko.itemName} 2`)!.props.onClick();
  tree = fixture.render();
  assert.equal(elements(tree).find(node => node.type === 'button' && node.props.type === 'submit')!.props.disabled, true);
  const item = elements(tree).find(node => node.type === 'fieldset' && content(node).includes(`${copy.inspectionCopy.ko.itemName} 1`))!;
  elements(item).find(node => node.type === 'input' && node.props.maxLength === 128)!.props.onChange({ target: { value: 'SYNTHETIC-ONE-ITEM' } });
  tree = fixture.render();
  elements(tree).find(node => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
  assert.equal(fixture.calls.length, 0);
  assert.match(content(fixture.render()), /각각 하나 이상/);
});
function prepare(fixture: ReturnType<typeof harness>) {
  let tree = fixture.render();
  elements(tree).find(node => node.type === 'select' && node.props.value === 'production')!.props.onChange({ target: { value: 'integration_trial' } });
  tree = fixture.render();
  assert.ok(content(tree).includes('실측 아님')); assert.ok(content(tree).includes('아직 MES 검사를 생성하거나 완료하지 않습니다.'));
  assert.equal(elements(tree).some(node => node.type === 'input' && node.props.type === 'datetime-local'), false);
  elements(tree).find(node => node.type === 'input' && node.props.maxLength === 54)!.props.onChange({ target: { value: 'WJ-IT-SYNTHETIC-01' } });
  tree = fixture.render();
  elements(tree).find(node => node.type === 'input' && node.props.maxLength === 128)!.props.onChange({ target: { value: 'Trial appearance' } });
}
test('trial form sends only code/items and retries the original attempt with original session', async () => {
  const fixture = harness(true); prepare(fixture);
  elements(fixture.render()).find(node => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0].endpoint, 'trial');
  assert.deepEqual(Object.keys(fixture.calls[0].attempt.payload).sort(), ['code', 'inspection_items']);
  assert.equal(fixture.calls[0].sessionId, 'fixture-session');
  elements(fixture.render()).find(node => node.type === 'button' && content(node) === copy.inspectionCopy.ko.retryOperation)!.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.calls[1], fixture.calls[0]); assert.equal(fixture.created.length, 1);
});
test('lost trial capability blocks an already populated draft without falling through to production creation', () => {
  const fixture = harness(true); prepare(fixture); fixture.revoke();
  elements(fixture.render()).find(node => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
  assert.equal(fixture.calls.length, 0);
});
test('trial payload strips production and actor metadata and rejects invalid codes', () => {
  const draft = { trial_code: 'WJ-IT-SYNTHETIC-01', inspection_items: [{ id: 'a', label: ' Trial ', kind: 'text' as const, unit: '', required: true, evidence_required: false, actor: 99 }], work_order_ref: 'must not send', assigned_to: 99 };
  assert.deepEqual(model.integrationTrialCreatePayload(draft), { code: draft.trial_code, inspection_items: [{ id: 'a', label: 'Trial', kind: 'text', unit: '', required: true, evidence_required: false }] });
  for (const code of ['WJ-IT-', 'WJ-IT-lower', 'QC-PROD', 'WJ-IT-A/B', 'WJ-IT-' + 'A'.repeat(49)]) assert.throws(() => model.integrationTrialCreatePayload({ ...draft, trial_code: code }), /integration_trial_code_invalid/);
});
