import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/components/MesConnectionDialog.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: unknown; props: Record<string, any> };
function nodes(value: any): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value?.props ? [value, ...nodes(value.props.children)] : [];
}

test('an already-rendered native MES submit observes the ending latch before React logout props update', () => {
  for (const boundary of ['current', 'ending', 'replaced'] as const) {
    const session = 'SYNTHETIC-SESSION-A';
    let current = session, ending = false, stateIndex = 0, refIndex = 0, scheduled = 0;
    const ticket = { ticket: 'SYNTHETIC-PREPARED-TICKET', expiresAt: Date.now() + 60_000, sessionId: session };
    const input = { value: ticket.ticket };
    const dependencies: Record<string, any> = {
      react: {
        useState: (initial: any) => {
          const index = stateIndex++;
          const value = index === 1 ? { status: 'disconnected', enabled: true, can_connect: true }
            : index === 2 ? ticket : typeof initial === 'function' ? initial() : initial;
          return [value, () => {}];
        },
        useRef: (initial: any) => { const index = refIndex++; return { current: index === 0 ? true : index === 3 ? ticket : index === 4 ? input : initial }; },
        useCallback: (callback: any) => callback, useEffect: () => {},
      },
      'react/jsx-runtime': { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }) },
      '@headlessui/react': { Dialog: 'Dialog', DialogPanel: 'Panel', DialogTitle: 'Title' },
      './ui/button': { Button: 'Button' }, '../i18n': { useLang: () => ({ lang: 'ko' }) },
      '../contexts/AuthContext': { useAuth: () => ({ isLoggingOut: false }) },
      '../lib/api': { default: { get: () => assert.fail('No status/network call in an already-prepared submit'), post: () => assert.fail('No automatic prepare') } },
      '../domains/auth/auth-storage': { getAuthSessionSnapshot: () => ({ id: current }), subscribeToAuthStorage: () => () => {} },
      '../domains/auth/auth-transition': { assertAuthSessionCurrent: (expected: string) => { if (expected !== current || ending) throw new Error('SYNTHETIC ending'); } },
      '../domains/auth/mes-connection': { MES_SESSION_SUBMIT_URL: 'https://synthetic.invalid/approved-form',
        isMesLaunchUsable: () => true, mesConnectionDiagnostic: () => null },
    };
    const exports: Record<string, any> = {};
    new Function('require', 'exports', 'window', compiled)((name: string) => {
      assert.ok(name in dependencies, `Unexpected module ${name}`); return dependencies[name];
    }, exports, { setTimeout: () => { scheduled += 1; return 1; }, clearTimeout: () => {} });
    const rendered = exports.default({ onClose: () => {} });
    const submit = nodes(rendered).find((node) => node.type === 'form')!.props.onSubmit;
    if (boundary === 'ending') ending = true;
    if (boundary === 'replaced') current = 'SYNTHETIC-SESSION-B';
    let prevented = false;
    const form = { action: 'SYNTHETIC-UNSUBMITTED' };
    submit({ currentTarget: form, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, boundary !== 'current');
    assert.equal(form.action, boundary === 'current' ? 'https://synthetic.invalid/approved-form' : 'SYNTHETIC-UNSUBMITTED');
    assert.equal(scheduled, boundary === 'current' ? 1 : 0);
    if (boundary !== 'current') assert.equal(input.value, '', 'the prepared ticket is cleared before native submission');
  }
});
