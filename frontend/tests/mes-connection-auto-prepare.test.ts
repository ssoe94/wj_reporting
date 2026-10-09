import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as contract from '../src/domains/auth/mes-connection.ts';

// Execute the real component with isolated hooks and deferred API replies.
// No browser storage, provider, credentials or network is available here.
const compiled = ts.transpileModule(readFileSync(new URL('../src/components/MesConnectionDialog.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : value?.props ? [value, ...nodes(value.props.children)] : [];
const deferred = () => {
  let resolve!: (value: any) => void, reject!: (reason: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const metadata = (patch: Record<string, unknown> = {}) => ({ enabled: true, status: 'disconnected',
  reason: 'connection_missing', expires_at: null, can_connect: true, can_disconnect: false,
  mode: 'stored_identity', live_ready: false, ...patch });

function fixture(lang = 'ko', diagnosticRequestUid?: string) {
  const hooks: any[] = [], effects: (() => void)[] = [], cleanups: (() => void)[] = [];
  const listeners = new Map<string, Set<() => void>>(), subscriptions = new Set<() => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const calls: { method: string; path: string; options: any; body?: unknown; reply: ReturnType<typeof deferred> }[] = [];
  let index = 0, timer = 0, renderPending = false, active = true;
  let current: string | null = 'SYNTHETIC-WJ-SESSION-A', ending = false, loggingOut = false, closed = 0;
  let tree: Element | null = null;
  const same = (a: unknown[], b?: unknown[]) => Boolean(b && a.length === b.length && a.every((value, i) => value === b[i]));
  const eventTarget = {
    addEventListener: (name: string, callback: () => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(callback); },
    removeEventListener: (name: string, callback: () => void) => { listeners.get(name)?.delete(callback); },
  };
  const apiCall = (method: string, path: string, options: any, body?: unknown) => {
    assert.ok(['/mes-connection/', '/mes-connection/launch/', '/mes-connection/disconnect/'].includes(path), 'only existing WJ bridge APIs');
    const call = { method, path, options, body, reply: deferred() }; calls.push(call); return call.reply.promise;
  };
  const dependencies: Record<string, any> = {
    react: {
      useState: (initial: any) => {
        const slot = index++;
        if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
        return [hooks[slot], (value: any) => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; renderPending = true; }];
      },
      useRef: (initial: any) => { const slot = index++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
      useCallback: (callback: any, deps: unknown[]) => {
        const slot = index++; if (!same(deps, hooks[slot]?.deps)) hooks[slot] = { callback, deps }; return hooks[slot].callback;
      },
      useEffect: (callback: () => (() => void) | void, deps: unknown[]) => {
        const slot = index++;
        if (!same(deps, hooks[slot]?.deps)) {
          const prior = hooks[slot]?.cleanup;
          hooks[slot] = { deps };
          effects.push(() => { prior?.(); const cleanup = callback(); if (cleanup) { hooks[slot].cleanup = cleanup; cleanups.push(cleanup); } });
        }
      },
    },
    'react/jsx-runtime': { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }) },
    '@headlessui/react': { Dialog: 'Dialog', DialogPanel: 'Panel', DialogTitle: 'Title' },
    './ui/button': { Button: 'Button' }, '../i18n': { useLang: () => ({ lang }) },
    '../contexts/AuthContext': { useAuth: () => ({ isLoggingOut: loggingOut }) },
    '../lib/api': { default: { get: (path: string, options: any) => apiCall('GET', path, options), post: (path: string, body: unknown, options: any) => apiCall('POST', path, options, body) } },
    '../domains/auth/auth-storage': { getAuthSessionSnapshot: () => ({ id: current }), subscribeToAuthStorage: (callback: () => void) => { subscriptions.add(callback); return () => subscriptions.delete(callback); } },
    '../domains/auth/auth-transition': { assertAuthSessionCurrent: (expected: string) => { if (!expected || current !== expected || ending) throw new Error('SYNTHETIC session unavailable'); } },
    '../domains/auth/mes-connection': contract,
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', 'window', 'document', compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected module ${name}`); return dependencies[name];
  }, exports, { ...eventTarget, setTimeout: (callback: () => void, delay: number) => { timers.set(++timer, { callback, delay }); return timer; }, clearTimeout: (id: number) => timers.delete(id) }, { ...eventTarget, visibilityState: 'visible' });
  const unmount = () => { active = false; cleanups.forEach(cleanup => cleanup()); tree = null; };
  const render = () => {
    if (!active) return;
    index = 0; renderPending = false;
    tree = exports.default({ onClose: () => { closed += 1; unmount(); }, diagnosticRequestUid });
    effects.splice(0).forEach(effect => effect());
  };
  const flush = async () => { for (let turn = 0; turn < 8; turn += 1) { await Promise.resolve(); if (renderPending) render(); } };
  render();
  return {
    calls, timers, flush, unmount,
    buttons: () => nodes(tree).filter(node => node.type === 'Button'),
    form: () => nodes(tree).find(node => node.type === 'form'),
    text: () => nodes(tree).flatMap(node => typeof node.props.children === 'string' ? [node.props.children] : Array.isArray(node.props.children) ? node.props.children.filter((value: unknown) => typeof value === 'string') : []).join(' '),
    click: (label: string) => { const button = nodes(tree).find(node => node.type === 'Button' && node.props.children === label); assert.ok(button, label); assert.equal(Boolean(button.props.disabled), false, `${label} is available`); button.props.onClick(); },
    status: async (data: Record<string, unknown>) => { const call = [...calls].reverse().find(call => call.method === 'GET')!; call.reply.resolve({ data }); await flush(); },
    launch: async () => { const call = [...calls].reverse().find(call => call.path === '/mes-connection/launch/')!; call.reply.resolve({ data: { ticket: 'SYNTHETIC-ONE-USE-TICKET', submit_url: contract.MES_SESSION_SUBMIT_URL, expires_in: 60 } }); await flush(); },
    fireTimers: async (expired: boolean) => { for (const [id, entry] of [...timers]) if ((entry.delay > 0) === expired) { timers.delete(id); entry.callback(); } await flush(); },
    focus: () => listeners.get('focus')?.forEach(callback => callback()),
    changeSession: () => { current = 'SYNTHETIC-WJ-SESSION-B'; subscriptions.forEach(callback => callback()); },
    endSession: () => { ending = true; loggingOut = true; render(); },
    resumeSession: () => { ending = false; loggingOut = false; render(); },
    closed: () => closed,
  };
}

test('current disconnected status prepares one memory ticket; one native gesture opens MES', async () => {
  const f = fixture();
  assert.deepEqual(f.calls.map(call => call.path), ['/mes-connection/']);
  await f.status(metadata());
  assert.deepEqual(f.calls.map(call => call.path), ['/mes-connection/', '/mes-connection/launch/']);
  assert.deepEqual(f.calls[1].body, {});
  assert.equal(f.calls[1].options.authSessionId, 'SYNTHETIC-WJ-SESSION-A');
  await f.launch();
  const form = f.form()!;
  assert.equal(form.props.method, 'post'); assert.equal(form.props.target, '_blank'); assert.equal(form.props.rel, 'noopener');
  assert.equal(form.props.action, contract.MES_SESSION_SUBMIT_URL);
  assert.ok(f.buttons().some(button => button.props.type === 'submit' && button.props.children === 'MES 연결'));
  let prevented = false;
  form.props.onSubmit({ currentTarget: { action: '' }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  await f.fireTimers(false);
  assert.equal(f.form(), undefined, 'submitted ticket leaves the DOM');
  assert.equal(f.calls.length, 2, 'the component does not submit a provider request or navigate automatically');
  f.unmount();
});

test('a valid connected identity is reused without issuing another bridge ticket', async () => {
  const f = fixture();
  await f.status(metadata({ status: 'connected', reason: 'metadata_valid', can_connect: true, can_disconnect: true, expires_at: '2026-10-08T13:59:01Z' }));
  assert.equal(f.calls.length, 1, 'even contradictory can_connect cannot override connected status');
  assert.equal(f.form(), undefined);
  assert.match(f.text(), /유효한 MES 연결을 자동으로 재사용/);
  assert.match(f.text(), /21:59/);
  assert.ok(!f.buttons().some(button => button.props.children === 'MES 연결'));
  f.unmount();
});

test('explicit diagnostic reconnect pins the exact UID without changing ordinary connected reuse', async () => {
  const uid = '00000000-0000-4000-8000-000000000018';
  for (const lang of ['ko', 'zh']) {
    const f = fixture(lang, uid);
    await f.status(metadata({ status: 'connected', reason: 'metadata_valid', can_connect: true, can_disconnect: true }));
    assert.deepEqual(f.calls.map(call => call.path), ['/mes-connection/', '/mes-connection/launch/']);
    assert.deepEqual(f.calls[1].body, { diagnostic_request_uid: uid });
    assert.equal(f.calls[1].options.skipAuthRefresh, true);
    await f.launch(); assert.ok(f.form());
    assert.match(f.text(), /00000000-0000-4000-8000-000000000018/);
    f.focus(); await f.status(metadata({ status: 'connected', can_connect: true }));
    assert.equal(f.calls.filter(call => call.path.endsWith('/launch/')).length, 1, 'status refresh cannot consume another APP grant');
    f.unmount();
  }
  for (const patch of [{ can_connect: false, status: 'connected' }, { status: 'blocked' }, { enabled: false }]) {
    const f = fixture('ko', uid); await f.status(metadata(patch)); assert.equal(f.calls.length, 1); f.unmount();
  }
});

test('disabled, blocked and server-denied statuses never prepare; failed status reads cannot grant connection', async () => {
  for (const patch of [{ enabled: false }, { status: 'blocked' }, { status: 'disabled' }, { can_connect: false }]) {
    const f = fixture(); await f.status(metadata(patch));
    assert.equal(f.calls.length, 1);
    assert.equal(f.form(), undefined);
    f.unmount();
  }
  const f = fixture(); f.calls[0].reply.reject(new Error('SYNTHETIC unavailable')); await f.flush();
  assert.equal(f.calls.length, 1); assert.equal(f.form(), undefined); f.unmount();
});

test('reconnect metadata uses the bilingual single native connection button', async () => {
  for (const [lang, label] of [['ko', 'MES 다시 연결'], ['zh', '重新连接 MES']]) {
    const f = fixture(lang); await f.status(metadata({ status: 'reconnect_required', reason: 'provider_token_expired' })); await f.launch();
    assert.ok(f.buttons().some(button => button.props.type === 'submit' && button.props.children === label));
    f.unmount();
  }
});

test('a failed preparation requires an explicit retry; status refresh does not loop', async () => {
  const f = fixture(); await f.status(metadata());
  f.calls[1].reply.reject(new Error('SYNTHETIC unavailable')); await f.flush();
  assert.equal(f.form(), undefined);
  f.click('상태 확인'); await f.status(metadata());
  assert.equal(f.calls.filter(call => call.path.endsWith('/launch/')).length, 1);
  f.click('다시 연결 준비');
  assert.equal(f.calls.filter(call => call.path.endsWith('/launch/')).length, 2);
  await f.launch(); assert.ok(f.form()); f.unmount();
});

test('expiry removes the ticket and cannot automatically reissue it', async () => {
  const f = fixture(); await f.status(metadata()); await f.launch(); await f.fireTimers(true);
  assert.equal(f.form(), undefined);
  f.click('상태 확인'); await f.status(metadata());
  assert.equal(f.calls.filter(call => call.path.endsWith('/launch/')).length, 1);
  assert.ok(f.buttons().some(button => button.props.children === '다시 연결 준비' && !button.props.disabled));
  f.unmount();
});

test('rapid returns deduplicate server reads and never reissue a submitted ticket', async () => {
  const f = fixture(); await f.status(metadata()); await f.launch();
  f.form()!.props.onSubmit({ currentTarget: { action: '' }, preventDefault: () => assert.fail('fresh form') });
  await f.fireTimers(false);
  f.focus(); f.focus(); f.focus();
  assert.equal(f.calls.filter(call => call.method === 'GET').length, 2);
  await f.status(metadata()); f.focus(); f.focus();
  assert.equal(f.calls.filter(call => call.path.endsWith('/launch/')).length, 1);
  assert.equal(f.calls.filter(call => call.method === 'GET').length, 3);
  f.unmount();
});

test('account replacement aborts pending preparation and its late response cannot publish a ticket', async () => {
  const f = fixture(); await f.status(metadata());
  const pending = f.calls[1]; f.changeSession();
  assert.equal(pending.options.signal.aborted, true);
  assert.equal(f.closed(), 1);
  await f.launch();
  assert.equal(f.form(), undefined); assert.equal(f.timers.size, 0);
});

test('ending the current login fences both a late status and a late preparation response', async () => {
  const first = fixture(); first.endSession(); await first.status(metadata());
  assert.equal(first.calls.length, 1); assert.equal(first.form(), undefined); first.unmount();
  const second = fixture(); await second.status(metadata()); second.endSession(); await second.launch();
  assert.equal(second.form(), undefined); assert.equal(second.timers.size, 0); second.unmount();
});

test('an unconfirmed logout retains the login and leaves an explicit connection retry usable', async () => {
  const f = fixture(); await f.status(metadata()); f.endSession(); await f.launch();
  assert.equal(f.form(), undefined, 'a response during logout does not publish a ticket');
  f.resumeSession(); f.click('다시 연결 준비');
  assert.equal(f.calls.filter(call => call.path.endsWith('/launch/')).length, 2);
  await f.launch(); assert.ok(f.form()); f.unmount();
});

test('explicit disconnect does not immediately prepare another connection', async () => {
  const f = fixture(); await f.status(metadata({ status: 'connected', reason: 'metadata_valid', can_connect: false, can_disconnect: true }));
  f.click('연결 해제'); f.calls[1].reply.resolve({ data: { disconnected: true } }); await f.flush();
  await f.status(metadata());
  assert.deepEqual(f.calls.map(call => call.path), ['/mes-connection/', '/mes-connection/disconnect/', '/mes-connection/']);
  assert.equal(f.form(), undefined); f.unmount();
});
