import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as contract from '../src/domains/production/exact-draft-diagnostic.ts';
import { diagnosticRaw, DIAGNOSTIC_CLOCK, DIAGNOSTIC_UID } from './fixtures/exact-draft-diagnostic.ts';

// Real component, isolated hooks and deferred replies: no storage, auth or MES network.
const compiled = ts.transpileModule(readFileSync(new URL('../src/components/MesExactDraftDiagnosticDialog.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Element = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : value?.props ? [value, ...nodes(value.props.children)] : [];
function deferred() {
  let resolve!: (value: any) => void, reject!: (reason: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(language = 'ko', attempts = new Set<string>()) {
  const hooks: any[] = [], effects: (() => void)[] = [], cleanups: (() => void)[] = [];
  const subscriptions = new Set<() => void>(), timers = new Map<number, () => void>();
  const calls: { action: string; uid?: string | null; session: string; signal: AbortSignal; reply: ReturnType<typeof deferred> }[] = [];
  let index = 0, timer = 0, pending = false, active = true, lang = language;
  let session = 'SYNTHETIC-SESSION-A', loggingOut = false, closed = 0, clock = DIAGNOSTIC_CLOCK;
  let tree: Element | null = null;
  const reconnected: string[] = [];
  const same = (a: unknown[], b?: unknown[]) => Boolean(b && a.length === b.length && a.every((value, i) => value === b[i]));
  const call = (action: string, uid: string | null | undefined, current: string, signal: AbortSignal) => {
    const entry = { action, uid, session: current, signal, reply: deferred() }; calls.push(entry); return entry.reply.promise;
  };
  class Clock extends Date { static now() { return clock; } }
  const dependencies: Record<string, any> = {
    react: {
      useState: (initial: any) => { const slot = index++; if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
        return [hooks[slot], (value: any) => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; pending = true; }]; },
      useRef: (initial: any) => { const slot = index++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
      useCallback: (callback: any, deps: unknown[]) => { const slot = index++; if (!same(deps, hooks[slot]?.deps)) hooks[slot] = { callback, deps }; return hooks[slot].callback; },
      useEffect: (callback: () => (() => void) | void, deps: unknown[]) => { const slot = index++; if (!same(deps, hooks[slot]?.deps)) {
        const prior = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { prior?.(); const cleanup = callback();
          if (cleanup) { hooks[slot].cleanup = cleanup; cleanups.push(cleanup); } }); } },
    },
    'react/jsx-runtime': { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }) },
    '@headlessui/react': { Dialog: 'Dialog', DialogPanel: 'Panel', DialogTitle: 'Title' },
    '../i18n': { useLang: () => ({ lang }) },
    '../contexts/AuthContext': { useAuth: () => ({ user: { id: 18, is_superuser: true }, authSessionId: session, isLoggingOut: loggingOut }) },
    '../domains/auth/auth-storage': { getAuthSessionSnapshot: () => ({ id: session }), subscribeToAuthStorage: (callback: () => void) => {
      subscriptions.add(callback); return () => subscriptions.delete(callback); } },
    '../domains/auth/auth-transition': { assertAuthSessionCurrent: (expected: string) => { if (expected !== session || loggingOut) throw Error('SYNTHETIC session fenced'); } },
    '../domains/production/exact-draft-diagnostic': contract,
    '../domains/production/exact-draft-diagnostic-api': {
      getExactDraftDiagnostic: (current: string, signal: AbortSignal) => call('status', undefined, current, signal),
      postExactDraftDiagnostic: (action: string, uid: string | null, current: string, signal: AbortSignal) => call(action, uid, current, signal),
    },
    './MesExactDraftDiagnosticDialog.css': {},
  };
  const exports: Record<string, any> = {};
  new Function('require', 'exports', 'window', 'Date', compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected module ${name}`); return dependencies[name];
  }, exports, { setInterval: (callback: () => void) => { timers.set(++timer, callback); return timer; }, clearInterval: (id: number) => timers.delete(id) }, Clock);
  const unmount = () => { active = false; cleanups.forEach(cleanup => cleanup()); tree = null; };
  const props = { onClose: () => { closed += 1; unmount(); }, onReconnect: (uid: string) => reconnected.push(uid), sendAttempts: attempts };
  const render = () => { if (!active) return; index = 0; pending = false; tree = exports.default(props); effects.splice(0).forEach(effect => effect()); };
  const flush = async () => { for (let turn = 0; turn < 10; turn += 1) { await Promise.resolve(); if (pending) render(); } };
  const button = (label: string) => { const found = nodes(tree).find(node => node.type === 'button' && node.props.children === label); assert.ok(found, label); return found; };
  render();
  return {
    calls, attempts, reconnected, flush, unmount, button,
    click: (label: string) => { const found = button(label); assert.equal(Boolean(found.props.disabled), false, label); found.props.onClick(); },
    reply: async (data = diagnosticRaw()) => { calls.at(-1)!.reply.resolve(contract.parseExactDraftSnapshot(data)); await flush(); },
    text: () => nodes(tree).flatMap(node => typeof node.props.children === 'string' ? [node.props.children]
      : Array.isArray(node.props.children) ? node.props.children.filter((value: unknown) => typeof value === 'string') : []).join(' '),
    language: (value: string) => { lang = value; render(); },
    advance: (ms: number) => { clock += ms; timers.forEach(callback => callback()); render(); },
    replaceSession: () => { session = 'SYNTHETIC-SESSION-B'; subscriptions.forEach(callback => callback()); },
    logout: () => { loggingOut = true; render(); },
    closed: () => closed,
  };
}
const unprepared = () => { const raw = diagnosticRaw(); return { ...raw, state: 'unprepared', request_uid: null, can_prepare: true,
  can_send: false, can_reconnect: false, approval: { ...raw.approval, approved_at: null, expires_at: null, active: false },
  app_supply: { available: false, usable_for_seconds: 0, supply_mode: 'server' }, connection: { status: 'blocked', reason: 'app_missing' } }; };

test('open and language changes are pure GET; APPmissing permits explicit preparation only', async () => {
  const f = fixture(); assert.deepEqual(f.calls.map(call => call.action), ['status']); await f.reply(unprepared());
  assert.equal(f.button('승인된 단건 1회 전송').props.disabled, true);
  f.language('zh'); assert.equal(f.calls.length, 1); assert.match(f.text(), /单工单诊断/);
  f.click('准备许可 · 最长 30 分钟'); f.button('准备许可 · 最长 30 分钟').props.onClick();
  assert.deepEqual(f.calls.map(call => call.action), ['status', 'prepare']);
  await f.reply(diagnosticRaw({ can_send: false, app_supply: { available: false, usable_for_seconds: 0, supply_mode: 'server' }, connection: { status: 'reconnect_required', reason: null } }));
  f.click('使用此准备编号重新连接 MES'); f.button('使用此准备编号重新连接 MES').props.onClick();
  assert.deepEqual(f.reconnected, [DIAGNOSTIC_UID]); assert.equal(f.calls.length, 2); f.unmount();
});

test('one explicit send deduplicates gestures and uncertainty offers readback without retry', async () => {
  const f = fixture(); await f.reply(); f.click('승인된 단건 1회 전송'); f.button('승인된 단건 1회 전송').props.onClick();
  assert.deepEqual(f.calls.map(call => call.action), ['status', 'send']);
  await f.reply(diagnosticRaw({ state: 'uncertain', attempt: 1, can_send: false, can_reconnect: false, can_recheck: true }));
  assert.equal(f.button('승인된 단건 1회 전송').props.disabled, true);
  assert.equal(f.button('permit 준비 · 최대 30분').props.disabled, true);
  f.click('MES 재조회만'); await f.reply(diagnosticRaw({ state: 'review', attempt: 1, can_recheck: true, result: { review_required: false, work_order_id: '17000000000000001' } }));
  assert.match(f.text(), /17000000000000001/); assert.match(f.text(), /결과 검토 필요/);
  assert.deepEqual(f.calls.map(call => call.action), ['status', 'send', 'recheck']); f.unmount();
});

test('lost send response remains fenced through closing and reopening, even stale server attempt0', async () => {
  const attempts = new Set<string>(), f = fixture('ko', attempts); await f.reply(); f.click('승인된 단건 1회 전송');
  f.calls.at(-1)!.reply.reject(Error('SYNTHETIC timeout')); await f.flush();
  assert.equal(f.button('승인된 단건 1회 전송').props.disabled, true); f.unmount();
  const reopened = fixture('ko', attempts); await reopened.reply();
  assert.equal(reopened.button('승인된 단건 1회 전송').props.disabled, true);
  assert.equal(reopened.button('이 준비번호로 MES 재연결').props.disabled, true);
  assert.match(reopened.text(), /재전송 금지/); assert.deepEqual(reopened.calls.map(call => call.action), ['status']); reopened.unmount();
});

test('expiry and denied read fail closed without preparing or sending', async () => {
  const f = fixture(); await f.reply(); f.advance(1800000);
  assert.equal(f.button('승인된 단건 1회 전송').props.disabled, true);
  assert.equal(f.button('이 준비번호로 MES 재연결').props.disabled, true); assert.equal(f.calls.length, 1);
  f.click('읽기 상태 확인'); f.calls.at(-1)!.reply.reject({ response: { status: 403 } }); await f.flush();
  assert.equal(f.button('permit 준비 · 최대 30분').props.disabled, true); assert.match(f.text(), /권한/);
  assert.deepEqual(f.calls.map(call => call.action), ['status', 'status']); f.unmount();
});

test('replacement, logout and unmount fence pending replies and never trigger a POST', async () => {
  const replaced = fixture(); replaced.replaceSession(); assert.equal(replaced.calls[0].signal.aborted, true);
  await replaced.reply(); assert.equal(replaced.closed(), 1); assert.equal(replaced.calls.length, 1);
  const logout = fixture(); logout.logout(); await logout.reply(); assert.equal(logout.calls.length, 1);
  assert.equal(logout.button('승인된 단건 1회 전송').props.disabled, true); logout.unmount();
  const closed = fixture(); closed.unmount(); assert.equal(closed.calls[0].signal.aborted, true); await closed.reply(); assert.equal(closed.calls.length, 1);
});
