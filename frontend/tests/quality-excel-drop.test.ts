import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Run the shipped component handlers with synthetic hooks; no DOM, API or files.
const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/quality/QualityExcelImport.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Node = { type: unknown; props: Record<string, any> };
function nodes(value: any): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children)];
}
function harness(allowed = true) {
  const hooks: any[] = [];
  const effects: (() => unknown)[] = [];
  const listeners = new Map<string, (event: any) => void>();
  const warnings: string[] = [];
  let cursor = 0;
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
  const dependencies: Record<string, any> = {
    react: {
      useState(initial: any) {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], (next: any) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
      },
      useRef(initial: any) { const index = cursor++; return hooks[index] ?? (hooks[index] = { current: initial }); },
      useEffect(callback: () => unknown) { const index = cursor++; if (!(index in hooks)) { hooks[index] = true; effects.push(callback); } },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    axios: {}, 'lucide-react': {},
    '@tanstack/react-query': { useQueryClient: () => ({}) },
    'react-toastify': { toast: { warning: (message: string) => warnings.push(message), error: (message: string) => warnings.push(message) } },
    '../../contexts/AuthContext': { useAuth: () => ({ user: { is_staff: allowed }, hasPermission: () => allowed }) },
    '../../i18n': { useLang: () => ({ lang: 'ko' }) },
    './importApi': {}, './QualityImportFailedRowEditor': {}, './QualityImportCompletionModal': {},
    './qualityWorkbookScanner': {}, './qualityDirectCloudinaryUpload': {}, './importResult': {},
    './qualityImportJobs': { loadQualityImportWorkflow: () => null },
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', 'window', compiled)(
    (name: string) => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; }, exports,
    { addEventListener: (name: string, callback: (event: any) => void) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) },
  );
  const render = () => { cursor = 0; return exports.default({ onPostProcess: () => assert.fail('Unexpected import') }); };
  render(); effects.forEach(effect => effect());
  const target = () => nodes(render()).find(node => node.type === 'button' && node.props.onDragEnter)!;
  return {
    target, warnings,
    active: () => target().props.className.includes('border-solid'),
    event: (handler: string, types = ['Files'], files: any[] = []) => {
      const event = { preventDefault: () => {}, dataTransfer: { types, files, dropEffect: 'none' } };
      target().props[handler](event); return event;
    },
    reset: (name: string, event = {}) => listeners.get(name)!(event),
  };
}

test('Excel target stays active through bubbled child transitions and clears after leaving', () => {
  const view = harness();
  assert.equal(view.active(), false);
  view.event('onDragEnter'); assert.equal(view.active(), true);
  view.event('onDragEnter'); view.event('onDragLeave'); assert.equal(view.active(), true);
  assert.equal(view.event('onDragOver').dataTransfer.dropEffect, 'copy');
  view.event('onDragLeave'); assert.equal(view.active(), false);
});

test('drop validates the file and resets depth; cancellation permits a fresh drag', () => {
  const view = harness();
  view.event('onDragEnter'); view.event('onDragEnter');
  view.event('onDrop', ['Files'], [{ name: 'invalid.txt', size: 1 }]);
  assert.equal(view.active(), false); assert.equal(view.warnings.length, 1);
  for (const [name, event] of [['dragend', {}], ['blur', {}], ['keydown', { key: 'Escape' }], ['drop', {}]] as const) {
    view.event('onDragEnter'); assert.equal(view.active(), true);
    view.reset(name, event); assert.equal(view.active(), false);
    view.event('onDragEnter'); view.event('onDragLeave'); assert.equal(view.active(), false);
  }
});

test('text and unauthorized file drags never advertise an accepted drop', () => {
  const text = harness();
  text.event('onDragEnter', ['text/plain']);
  assert.equal(text.event('onDragOver', ['text/plain']).dataTransfer.dropEffect, 'none');
  assert.equal(text.active(), false);
  const denied = harness(false);
  denied.event('onDragEnter'); assert.equal(denied.active(), false);
  assert.equal(denied.event('onDragOver').dataTransfer.dropEffect, 'none');
});
