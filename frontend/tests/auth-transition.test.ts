import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAuthSessionCurrent, beginAuthSessionEnd, createLoginAttemptGate, isAuthSessionCurrent, registerAuthTransitionGuard } from '../src/domains/auth/auth-transition.ts';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
} });
const session = (id: string | null) => values.set('wj-auth-session-control-v2', JSON.stringify(id ? { id, access: 'synthetic-access', refresh: 'synthetic-refresh' } : { id }));

test('pending or declined draft guard prevents logout and leaves mutation ownership intact', () => {
  session('actor-a');
  let pending = true;
  let allowDraft = false;
  const remove = registerAuthTransitionGuard('actor-a', () => !pending && allowDraft);
  try {
    assert.equal(beginAuthSessionEnd('actor-a'), null);
    assert.doesNotThrow(() => assertAuthSessionCurrent('actor-a'));
    pending = false;
    assert.equal(beginAuthSessionEnd('actor-a'), null);
    allowDraft = true;
    const finish = beginAuthSessionEnd('actor-a');
    assert.equal(typeof finish, 'function');
    assert.throws(() => assertAuthSessionCurrent('actor-a'));
    assert.equal(beginAuthSessionEnd('actor-a'), null);
    finish!();
    assert.doesNotThrow(() => assertAuthSessionCurrent('actor-a'));
  } finally { remove(); }
});

test('guard exceptions fail closed; unmount removes only its own guard', () => {
  session('actor-a');
  const first = registerAuthTransitionGuard('actor-a', () => { throw new Error('synthetic'); });
  const second = registerAuthTransitionGuard('actor-a', () => false);
  assert.equal(beginAuthSessionEnd('actor-a'), null);
  first();
  assert.equal(beginAuthSessionEnd('actor-a'), null);
  second();
  const finish = beginAuthSessionEnd('actor-a');
  assert.ok(finish);
  finish();
});

test('external account replacement blocks stale writes and ignores previous-account guards', () => {
  session('actor-a');
  const remove = registerAuthTransitionGuard('actor-a', () => false);
  try {
    session('actor-b');
    assert.equal(isAuthSessionCurrent('actor-a'), false);
    assert.throws(() => assertAuthSessionCurrent('actor-a'));
    assert.equal(beginAuthSessionEnd('actor-a'), null);
    const finish = beginAuthSessionEnd('actor-b');
    assert.ok(finish);
    finish();
  } finally { remove(); }
});

test('account change during confirmation cannot acquire old logout ownership', () => {
  session('actor-a');
  const remove = registerAuthTransitionGuard('actor-a', () => { session('actor-b'); return true; });
  try { assert.equal(beginAuthSessionEnd('actor-a'), null); }
  finally { remove(); }
});

test('late completion of A logout cannot reopen B while its own logout is pending', () => {
  session('actor-a');
  const finishA = beginAuthSessionEnd('actor-a');
  assert.ok(finishA);
  session('actor-b');
  const finishB = beginAuthSessionEnd('actor-b');
  assert.ok(finishB);
  finishA();
  assert.throws(() => assertAuthSessionCurrent('actor-b'));
  finishB();
  assert.doesNotThrow(() => assertAuthSessionCurrent('actor-b'));
});

test('same-session token rotation retains editor ownership', () => {
  session('actor-a');
  values.set('wj-auth-rotated-pair-v2:actor-a', JSON.stringify({ sessionId: 'actor-a', access: 'synthetic-rotated', refresh: 'synthetic-new-refresh' }));
  try { assert.doesNotThrow(() => assertAuthSessionCurrent('actor-a')); }
  finally { values.delete('wj-auth-rotated-pair-v2:actor-a'); }
});

test('missing owner and same-account new session are never considered the captured session', () => {
  session('actor-a-new-login');
  for (const owner of [null, '', 'actor-a-old-login']) {
    assert.equal(isAuthSessionCurrent(owner), false);
    assert.throws(() => assertAuthSessionCurrent(owner));
    assert.equal(beginAuthSessionEnd(owner), null);
  }
});

test('late login response cannot overwrite a newer attempt or another tab session', () => {
  let id: string | null = null;
  const gate = createLoginAttemptGate(() => id);
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  id = 'actor-b';
  assert.equal(gate.isCurrent(second), false);
});

test('logout or observed account change invalidates pending login even after return to logged out', () => {
  let id: string | null = null;
  const gate = createLoginAttemptGate(() => id);
  const attempt = gate.begin();
  id = 'actor-b'; gate.invalidate();
  id = null; gate.invalidate();
  assert.equal(gate.isCurrent(attempt), false);
  assert.equal(gate.isCurrent(gate.begin()), true);
});
