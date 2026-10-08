import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTH_ACTIVITY_FRESH_MS, AUTH_ACTIVITY_INTERVAL_MS, createAuthActivityTracker, isUserAuthActivity, observeAuthActivity } from '../src/domains/auth/auth-activity.ts';
import type { AuthActivityRequest } from '../src/domains/auth/auth-activity.ts';

const trusted = (type = 'pointerdown') => ({ type, isTrusted: true });
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

test('only trusted foreground pointer/key/wheel input counts; repeat and synthetic/background events do not', () => {
  for (const type of ['pointerdown', 'keydown', 'wheel']) {
    assert.equal(isUserAuthActivity(trusted(type), true, true), true);
    assert.equal(isUserAuthActivity(trusted(type), false, true), false);
    assert.equal(isUserAuthActivity(trusted(type), true, false), false);
    assert.equal(isUserAuthActivity({ type, isTrusted: false }, true, true), false);
  }
  assert.equal(isUserAuthActivity({ ...trusted('keydown'), repeat: true }, true, true), false);
  for (const type of ['focus', 'visibilitychange', 'mousemove', 'load', 'poll', 'refresh', 'status', 'mes-read']) {
    assert.equal(isUserAuthActivity(trusted(type), true, true), false);
  }
});

test('25 hours of polling and focus changes produce no activity; real input alone starts a bounded request', async () => {
  let time = 0;
  const requests: AuthActivityRequest[] = [];
  const tracker = createAuthActivityTracker({ current: () => true, foreground: () => true, now: () => time,
    send: async (request) => { requests.push(request); } });
  assert.equal(requests.length, 0, 'mount/bootstrap is not user activity');
  for (let minute = 0; minute <= 25 * 60; minute += 1) {
    time = minute * 60_000;
    for (const type of ['poll', 'refresh', 'focus', 'visibilitychange', 'mes-read']) tracker.handle(trusted(type));
  }
  assert.equal(requests.length, 0);
  tracker.handle(trusted('keydown'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].isFresh(), true);
  assert.deepEqual(Object.keys(requests[0]).sort(), ['isFresh', 'signal'], 'input contents and client time are never passed to transport');
  tracker.handle(trusted('wheel')); await flush(); tracker.handle(trusted());
  assert.equal(requests.length, 1, 'pending and throttled events are dropped');
  time += AUTH_ACTIVITY_INTERVAL_MS;
  tracker.handle(trusted('wheel')); await flush();
  assert.equal(requests.length, 2);
  tracker.dispose();
});

test('blocked network/lock work cannot flush old activity after time, visibility, session or logout changes', async () => {
  for (const boundary of ['time', 'hidden', 'session', 'dispose'] as const) {
    let time = 100, foreground = true, current = true;
    let resolve!: () => void;
    const requests: AuthActivityRequest[] = [];
    const tracker = createAuthActivityTracker({ current: () => current, foreground: () => foreground, now: () => time,
      send: (request) => { requests.push(request); return new Promise<void>((done) => { resolve = done; }); } });
    tracker.handle(trusted());
    assert.equal(requests[0].isFresh(), true);
    if (boundary === 'time') time += AUTH_ACTIVITY_FRESH_MS + 1;
    if (boundary === 'hidden') foreground = false;
    if (boundary === 'session') current = false;
    if (boundary === 'dispose') tracker.dispose();
    assert.equal(requests[0].isFresh(), false, boundary);
    if (boundary === 'dispose') assert.equal(requests[0].signal.aborted, true);
    resolve(); await flush();
    foreground = true; current = true; time += AUTH_ACTIVITY_INTERVAL_MS;
    assert.equal(requests.length, 1, 'settlement/return creates no retry');
    tracker.dispose();
  }
});

test('transient failures wait for a new real event and never schedule a retry', async () => {
  let time = 0, calls = 0;
  const tracker = createAuthActivityTracker({ current: () => true, foreground: () => true, now: () => time,
    send: async () => { calls += 1; throw new Error('SYNTHETIC offline'); } });
  tracker.handle(trusted()); await flush();
  time += 25 * 60 * 60 * 1000; await flush();
  assert.equal(calls, 1);
  tracker.handle(trusted()); await flush();
  assert.equal(calls, 2);
  tracker.dispose(); tracker.handle(trusted());
  assert.equal(calls, 2);
});

test('observer installs only activity listeners and removes them while aborting its own pending request', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const installed = new Map<string, (event: Event) => void>();
  let request: AuthActivityRequest | undefined;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener: (name: string, callback: (event: Event) => void, options: unknown) => { assert.deepEqual(options, { capture: true, passive: true }); installed.set(name, callback); },
    removeEventListener: (name: string, callback: (event: Event) => void, capture: boolean) => { assert.equal(installed.get(name), callback); assert.equal(capture, true); installed.delete(name); },
  } });
  try {
    const stop = observeAuthActivity({ current: () => true, foreground: () => true, now: () => 1,
      send: (value) => { request = value; return new Promise<void>(() => {}); } });
    assert.deepEqual([...installed.keys()], ['pointerdown', 'keydown', 'wheel']);
    installed.get('pointerdown')!(trusted() as Event);
    assert.ok(request); stop();
    assert.equal(request.signal.aborted, true); assert.equal(installed.size, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window');
  }
});
