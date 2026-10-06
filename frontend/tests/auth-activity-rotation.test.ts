import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Execute production refresh/activity coordination with isolated module instances,
// one shared Web Lock and deterministic storage/HTTP adapters. No real I/O or timers.
const source = readFileSync(new URL('../src/domains/auth/auth-refresh.ts', import.meta.url), 'utf8')
  .replaceAll('import.meta.env.PROD', 'true')
  .replaceAll('import.meta.env.VITE_API_BASE_URL', 'undefined');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const NOW = Date.UTC(2026, 9, 7, 8, 0, 0);
const SECONDS = NOW / 1000;
const SESSION_A = 'SYNTHETIC-LOCAL-SESSION-A';
const SESSION_B = 'SYNTHETIC-LOCAL-SESSION-B';
const SID_A = 'A'.repeat(43);
const SID_B = 'B'.repeat(43);
type Pair = { access: string; refresh: string };
type Snapshot = { id: string | null; access: string | null; refresh: string | null };
type Activity = { signal: AbortSignal; isFresh: () => boolean };
type AuthModule = {
  AuthRefreshError: new (...args: any[]) => Error & { isDefinitive: boolean };
  refreshAccessToken: (failedAccess?: string | null, sessionId?: string | null) => Promise<string>;
  recordAuthActivity: (sessionId: string, activity: Activity) => Promise<void>;
  abortAuthActivity: (sessionId: string | null) => void;
  isDefinitiveSessionRejection: (status: unknown, code: unknown) => boolean;
};
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function jwt(claims: Record<string, unknown>) {
  return `${Buffer.from('{"alg":"SYNTHETIC"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
}
function pair(label: string, version?: number, options: { expired?: boolean; user?: number; sid?: string } = {}): Pair {
  const claims = { mes_sid: options.sid ?? SID_A, mes_login_exp: SECONDS + 86_400,
    user_id: options.user ?? 18, ...(version === undefined ? {} : { mes_session_v: version }) };
  return {
    access: jwt({ ...claims, token_type: 'access', exp: SECONDS + (options.expired ? -60 : 300), jti: `${label}-access` }),
    refresh: jwt({ ...claims, token_type: 'refresh', exp: SECONDS + 86_400, jti: `${label}-refresh` }),
  };
}
function changeClaims(token: string, patch: Record<string, unknown>) {
  return jwt({ ...JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')), ...patch });
}
function activityResponse(next: Pair) {
  return { ...next, session_last_activity_at: new Date(NOW).toISOString(),
    session_idle_expires_at: new Date(NOW + 86_400_000).toISOString() };
}
function request() {
  const controller = new AbortController(); let fresh = true;
  return { controller, activity: { signal: controller.signal, isFresh: () => fresh }, expire: () => { fresh = false; } };
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}
async function flush() { for (let i = 0; i < 24; i += 1) await Promise.resolve(); }
function httpFailure(code: string, status = 401) { return { syntheticAxios: true, response: { status, data: { code } } }; }
function harness(initial = pair('initial'), options: { webLocks?: boolean; storageFailure?: 'get' | 'set' } = {}) {
  let current: Snapshot = { id: SESSION_A, ...initial };
  let clock = NOW; let timerSequence = 0; let leaseSequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const leases = new Map<string, string>();
  const useWebLocks = options.webLocks !== false;
  let lockTail: Promise<unknown> = Promise.resolve(); let activeLocks = 0;
  const lockNames: string[] = [];
  const ending = new Set<string>();
  const rotations: { access: string; refresh: string; id: string }[] = [];
  const invalidations: (string | null)[] = [];
  const calls: { url: string; body: any; config: any; reply: ReturnType<typeof deferred<any>> }[] = [];
  const locks = {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      assert.equal(name, 'wj-auth-token-refresh'); lockNames.push(name);
      const pending = lockTail.then(async () => {
        activeLocks += 1; assert.equal(activeLocks, 1, 'Refresh and activity share one exclusive lock');
        try { return await callback(); } finally { activeLocks -= 1; }
      });
      lockTail = pending.then(() => undefined, () => undefined);
      return pending;
    },
  };
  const axios = {
    post(url: string, body: unknown, config: unknown) {
      const reply = deferred<any>(); calls.push({ url, body, config, reply }); return reply.promise;
    },
    isAxiosError: (error: any) => error?.syntheticAxios === true,
  };
  const dependencies: Record<string, unknown> = {
    axios: { default: axios },
    '@/domains/auth/auth-storage': {
      getAuthSessionSnapshot: () => ({ ...current }),
      rotateTokenPair(access: string, refresh: string, id: string) {
        if (id !== current.id) return false;
        rotations.push({ access, refresh, id }); current = { id, access, refresh }; return true;
      },
      invalidateAuthSession(id: string | null) {
        invalidations.push(id);
        if (!id || id !== current.id) return false;
        current = { id: null, access: null, refresh: null }; return true;
      },
    },
    '@/domains/auth/dev-session': { isDevSessionToken: () => false },
    '@/domains/auth/auth-transition': { assertAuthSessionCurrent(id: string | null) {
      if (!id || id !== current.id || ending.has(id)) throw new Error('SYNTHETIC session changed or ending');
    } },
  };
  const storage = {
    getItem(key: string) {
      assert.equal(useWebLocks, false, 'Web Lock scenarios must not access storage leases');
      assert.equal(key, 'wj-auth-token-refresh-lease-v1');
      if (options.storageFailure === 'get') throw new Error('SYNTHETIC storage unavailable');
      return leases.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      assert.equal(useWebLocks, false); assert.equal(key, 'wj-auth-token-refresh-lease-v1');
      if (options.storageFailure === 'set') throw new Error('SYNTHETIC storage unavailable');
      assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ['expiresAt', 'owner'], 'Coordination must not store token pairs');
      leases.set(key, value);
    },
    removeItem(key: string) { assert.equal(useWebLocks, false); leases.delete(key); },
  };
  class FixedDate extends Date { static now() { return clock; } }
  function module(): AuthModule {
    const exports: Record<string, any> = {};
    new Function('require', 'exports', 'window', 'navigator', 'Date', compiled)(
      (name: string) => { assert.ok(name in dependencies, `Unexpected module: ${name}`); return dependencies[name]; }, exports,
      { atob: (encoded: string) => Buffer.from(encoded, 'base64').toString('binary'),
        setTimeout: (callback: () => void, delay: number) => {
          assert.equal(useWebLocks, false, 'Web Lock scenarios must not start lease timers');
          assert.ok(Number.isFinite(delay) && delay >= 0);
          const id = ++timerSequence; timers.set(id, { at: clock + delay, callback }); return id;
        },
        localStorage: storage, crypto: { randomUUID: () => `SYNTHETIC-LEASE-${++leaseSequence}` },
        location: { reload: () => { assert.fail('Activity must not reload the document'); } } },
      useWebLocks ? { locks } : {}, FixedDate,
    );
    return exports as unknown as AuthModule;
  }
  async function expectCalls(count: number) {
    await flush(); assert.equal(calls.length, count, 'Expected deterministic HTTP progress without a nested-lock deadlock');
  }
  async function advance(milliseconds: number) {
    const until = clock + milliseconds;
    for (let steps = 0; ; steps += 1) {
      assert.ok(steps < 1000, 'Lease timer advancement must remain bounded');
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
    }
    clock = until; await flush();
  }
  return { module, calls, lockNames, locks, ending, rotations, invalidations, expectCalls, advance, leases,
    snapshot: () => ({ ...current }), replace: (next: Snapshot) => { current = { ...next }; } };
}
function nonDefinitive(result: Awaited<ReturnType<typeof outcome>>, api: AuthModule) {
  assert.equal(result.ok, false);
  if (!result.ok) { assert.ok(result.error instanceof api.AuthRefreshError); assert.equal(result.error.isDefinitive, false); }
}

test('refresh then activity uses the rotated pair across tabs and sends exactly one activity POST', async () => {
  const initial = pair('initial'); const fixture = harness(initial);
  const refreshTab = fixture.module(); const activityTab = fixture.module();
  const refreshed = pair('refreshed', 2); const active = pair('active', 2);
  const refreshDone = outcome(refreshTab.refreshAccessToken(initial.access, SESSION_A));
  await fixture.expectCalls(1);
  assert.deepEqual(fixture.calls[0].body, { refresh: initial.refresh });
  const event = request(); const activityDone = outcome(activityTab.recordAuthActivity(SESSION_A, event.activity));
  await fixture.expectCalls(1);
  assert.equal(fixture.lockNames.length, 2);
  fixture.calls[0].reply.resolve({ data: refreshed });
  await fixture.expectCalls(2);
  const activityCall = fixture.calls[1];
  assert.equal(activityCall.url, '/api/auth/activity/');
  assert.deepEqual(activityCall.body, { refresh: refreshed.refresh });
  assert.deepEqual(activityCall.config.headers, { Authorization: `Bearer ${refreshed.access}` });
  assert.equal(activityCall.config.signal.aborted, false);
  activityCall.reply.resolve({ data: activityResponse(active) });
  assert.deepEqual(await refreshDone, { ok: true, value: refreshed.access });
  assert.deepEqual(await activityDone, { ok: true, value: undefined });
  assert.deepEqual(fixture.snapshot(), { id: SESSION_A, ...active });
  assert.equal(fixture.rotations.length, 2);
  assert.equal(fixture.calls.filter(call => call.url === '/api/auth/activity/').length, 1);
  assert.deepEqual(fixture.invalidations, []);
});

test('activity then refresh reuses the activity replacement without rotating its used refresh again', async () => {
  const initial = pair('initial'); const fixture = harness(initial);
  const activityTab = fixture.module(); const refreshTab = fixture.module(); const active = pair('activity-winner', 2);
  const event = request(); const activityDone = outcome(activityTab.recordAuthActivity(SESSION_A, event.activity));
  await fixture.expectCalls(1);
  const refreshDone = outcome(refreshTab.refreshAccessToken(initial.access, SESSION_A));
  await fixture.expectCalls(1);
  fixture.calls[0].reply.resolve({ data: activityResponse(active) });
  assert.deepEqual(await activityDone, { ok: true, value: undefined });
  assert.deepEqual(await refreshDone, { ok: true, value: active.access });
  assert.deepEqual(fixture.calls.map(call => call.url), ['/api/auth/activity/']);
  assert.equal(fixture.lockNames.length, 2);
  assert.deepEqual(fixture.rotations, [{ id: SESSION_A, ...active }]);
});

test('shared storage lease serializes refresh and activity in either order without Web Locks', async () => {
  for (const first of ['refresh', 'activity'] as const) {
    const initial = pair('initial'); const fixture = harness(initial, { webLocks: false });
    const refreshTab = fixture.module(); const activityTab = fixture.module(); const event = request();
    const firstPair = pair('lease-first', 2); const finalPair = pair('lease-second', 2);
    const firstDone = outcome(first === 'refresh'
      ? refreshTab.refreshAccessToken(initial.access, SESSION_A)
      : activityTab.recordAuthActivity(SESSION_A, event.activity));
    await fixture.expectCalls(0);
    await fixture.advance(40); await fixture.expectCalls(1);
    const secondDone = outcome(first === 'refresh'
      ? activityTab.recordAuthActivity(SESSION_A, event.activity)
      : refreshTab.refreshAccessToken(initial.access, SESSION_A));
    await fixture.expectCalls(1);
    assert.equal(fixture.leases.size, 1);
    fixture.calls[0].reply.resolve({ data: first === 'refresh' ? firstPair : activityResponse(firstPair) });
    assert.equal((await firstDone).ok, true);
    await fixture.advance(80);
    if (first === 'refresh') {
      await fixture.expectCalls(1); // The waiting activity still settles its new lease.
      await fixture.advance(40); await fixture.expectCalls(2);
      assert.equal(fixture.calls[1].url, '/api/auth/activity/');
      assert.deepEqual(fixture.calls[1].body, { refresh: firstPair.refresh });
      assert.deepEqual(fixture.calls[1].config.headers, { Authorization: `Bearer ${firstPair.access}` });
      fixture.calls[1].reply.resolve({ data: activityResponse(finalPair) });
      assert.deepEqual(await secondDone, { ok: true, value: undefined });
      assert.deepEqual(fixture.snapshot(), { id: SESSION_A, ...finalPair });
    } else {
      assert.deepEqual(await secondDone, { ok: true, value: firstPair.access });
      assert.deepEqual(fixture.calls.map(call => call.url), ['/api/auth/activity/']);
      assert.deepEqual(fixture.snapshot(), { id: SESSION_A, ...firstPair });
    }
    assert.equal(fixture.calls.filter(call => call.url === '/api/auth/activity/').length, 1);
    assert.deepEqual(fixture.lockNames, []);
    assert.equal(fixture.leases.size, 0, 'The completed owner releases its lease');
    assert.deepEqual(fixture.invalidations, []);
  }
});

test('unavailable shared storage stops refresh and activity without an unlocked POST', async () => {
  for (const storageFailure of ['get', 'set'] as const) for (const operation of ['refresh', 'activity'] as const) {
    const initial = pair('initial'); const fixture = harness(initial, { webLocks: false, storageFailure });
    const api = fixture.module(); const before = fixture.snapshot();
    const done = outcome(operation === 'refresh' ? api.refreshAccessToken(initial.access, SESSION_A)
      : api.recordAuthActivity(SESSION_A, request().activity));
    nonDefinitive(await done, api);
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(fixture.rotations, []); assert.deepEqual(fixture.invalidations, []);
    assert.deepEqual(fixture.snapshot(), before);
    assert.equal(fixture.leases.size, 0);
  }
});

test('expired access is refreshed inside the activity lock without recursively acquiring it', async () => {
  const initial = pair('expired', undefined, { expired: true }); const fixture = harness(initial); const api = fixture.module();
  const refreshed = pair('internal-refresh', 2); const active = pair('internal-activity', 2);
  const done = outcome(api.recordAuthActivity(SESSION_A, request().activity));
  await fixture.expectCalls(1);
  assert.equal(fixture.calls[0].url, '/api/token/refresh/');
  fixture.calls[0].reply.resolve({ data: refreshed });
  await fixture.expectCalls(2);
  assert.equal(fixture.lockNames.length, 1, 'Internal refresh must not enqueue behind its own activity lock');
  assert.deepEqual(fixture.calls[1].body, { refresh: refreshed.refresh });
  assert.deepEqual(fixture.calls[1].config.headers, { Authorization: `Bearer ${refreshed.access}` });
  fixture.calls[1].reply.resolve({ data: activityResponse(active) });
  assert.deepEqual(await done, { ok: true, value: undefined });
  assert.deepEqual(fixture.snapshot(), { id: SESSION_A, ...active });
});

test('aborting an internal activity refresh rejects its late reply without adopting tokens or posting activity', async () => {
  for (const response of ['success', 'rejection'] as const) {
    const fixture = harness(pair('expired', undefined, { expired: true }));
    const api = fixture.module(); const event = request(); const before = fixture.snapshot();
    const done = outcome(api.recordAuthActivity(SESSION_A, event.activity));
    await fixture.expectCalls(1);
    assert.equal(fixture.calls[0].url, '/api/token/refresh/');
    event.controller.abort();
    assert.equal(fixture.calls[0].config.signal.aborted, true);
    if (response === 'success') fixture.calls[0].reply.resolve({ data: pair('cancelled-refresh', 2) });
    else fixture.calls[0].reply.reject(httpFailure('session_idle_expired'));
    nonDefinitive(await done, api);
    assert.deepEqual(fixture.snapshot(), before);
    assert.equal(fixture.calls.length, 1, 'Cancelled refresh cannot dispatch the activity POST');
    assert.deepEqual(fixture.rotations, []); assert.deepEqual(fixture.invalidations, []);
  }
});

test('late refresh and activity successes or definitive failures cannot overwrite another session, pair or ending session', async () => {
  for (const operation of ['refresh', 'activity'] as const) for (const boundary of ['account', 'pair', 'ending'] as const) for (const response of ['success', 'rejection'] as const) {
    const initial = pair('initial'); const fixture = harness(initial); const api = fixture.module();
    const done = outcome(operation === 'refresh'
      ? api.refreshAccessToken(initial.access, SESSION_A)
      : api.recordAuthActivity(SESSION_A, request().activity));
    await fixture.expectCalls(1);
    if (boundary === 'account') fixture.replace({ id: SESSION_B, ...pair('account-b', 2, { user: 19, sid: SID_B }) });
    if (boundary === 'pair') fixture.replace({ id: SESSION_A, ...pair('other-tab-winner', 2) });
    if (boundary === 'ending') fixture.ending.add(SESSION_A);
    const protectedSnapshot = fixture.snapshot();
    if (response === 'success') fixture.calls[0].reply.resolve({ data: operation === 'activity'
      ? activityResponse(pair('late', 2)) : pair('late', 2) });
    else fixture.calls[0].reply.reject(httpFailure('session_idle_expired'));
    const result = await done;
    if (boundary === 'pair') {
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value, operation === 'refresh' ? protectedSnapshot.access : undefined);
    } else nonDefinitive(result, api);
    assert.deepEqual(fixture.snapshot(), protectedSnapshot, `${operation}/${boundary}/${response}`);
    assert.deepEqual(fixture.rotations, []);
    assert.deepEqual(fixture.invalidations, []);
    assert.equal(fixture.calls.length, 1);
  }
});

test('activity abort is owner-scoped and blocks adoption even when the transport still replies', async () => {
  for (const origin of ['owner', 'signal'] as const) for (const response of ['success', 'rejection'] as const) {
    const fixture = harness(); const api = fixture.module(); const event = request(); const before = fixture.snapshot();
    const done = outcome(api.recordAuthActivity(SESSION_A, event.activity));
    await fixture.expectCalls(1);
    api.abortAuthActivity(SESSION_B);
    assert.equal(fixture.calls[0].config.signal.aborted, false, 'Another actor cannot cancel the owner activity');
    if (origin === 'owner') api.abortAuthActivity(SESSION_A); else event.controller.abort();
    assert.equal(fixture.calls[0].config.signal.aborted, true);
    if (response === 'success') fixture.calls[0].reply.resolve({ data: activityResponse(pair('too-late', 2)) });
    else fixture.calls[0].reply.reject(httpFailure('session_idle_expired'));
    assert.deepEqual(await done, { ok: true, value: undefined });
    assert.deepEqual(fixture.snapshot(), before);
    assert.deepEqual(fixture.rotations, []); assert.deepEqual(fixture.invalidations, []);
  }
});

test('activity that becomes stale, aborted or ending while queued sends no HTTP', async () => {
  for (const boundary of ['stale', 'abort', 'ending'] as const) {
    const fixture = harness(); const api = fixture.module(); const gate = deferred<void>(); const event = request();
    const owner = fixture.locks.request('wj-auth-token-refresh', () => gate.promise);
    await flush();
    const done = outcome(api.recordAuthActivity(SESSION_A, event.activity));
    await fixture.expectCalls(0);
    if (boundary === 'stale') event.expire();
    if (boundary === 'abort') event.controller.abort();
    if (boundary === 'ending') fixture.ending.add(SESSION_A);
    gate.resolve(); await owner;
    nonDefinitive(await done, api);
    assert.equal(fixture.calls.length, 0);
    assert.deepEqual(fixture.rotations, []); assert.deepEqual(fixture.invalidations, []);
  }
});

test('legacy activity migration keeps the local session ID and immutable JWT owner and login anchors', async () => {
  const initial = pair('legacy'); const fixture = harness(initial); const api = fixture.module(); const next = pair('v2', 2);
  const event = request(); const done = outcome(api.recordAuthActivity(SESSION_A, event.activity));
  await fixture.expectCalls(1);
  // Duplicate activity in this tab must not create another rotation or replace the first owner.
  await api.recordAuthActivity(SESSION_A, request().activity);
  assert.equal(fixture.calls.length, 1);
  fixture.calls[0].reply.resolve({ data: activityResponse(next) });
  assert.deepEqual(await done, { ok: true, value: undefined });
  assert.deepEqual(fixture.snapshot(), { id: SESSION_A, ...next });
  assert.deepEqual(fixture.rotations, [{ id: SESSION_A, ...next }]);
  assert.deepEqual(fixture.invalidations, []);
});

test('invalid activity token bindings or idle metadata never rotate or clear the retained WJ pair', async () => {
  const next = pair('v2', 2); const valid = activityResponse(next);
  const invalid = [
    { ...valid, access: '' }, { ...valid, refresh: null },
    { ...valid, access: changeClaims(next.access, { mes_sid: SID_B }) },
    { ...valid, refresh: changeClaims(next.refresh, { mes_sid: SID_B }) },
    { ...valid, access: changeClaims(next.access, { user_id: 19 }) },
    { ...valid, refresh: changeClaims(next.refresh, { user_id: '18' }) },
    { ...valid, access: changeClaims(next.access, { mes_login_exp: SECONDS + 86_401 }) },
    { ...valid, refresh: changeClaims(next.refresh, { mes_login_exp: SECONDS + 86_401 }) },
    { ...valid, access: changeClaims(next.access, { mes_session_v: 1 }) },
    { ...valid, refresh: changeClaims(next.refresh, { mes_session_v: undefined }) },
    { ...valid, access: changeClaims(next.access, { exp: SECONDS }) },
    { ...valid, refresh: changeClaims(next.refresh, { exp: SECONDS }) },
    { ...valid, access: changeClaims(next.access, { token_type: 'refresh' }) },
    { ...valid, refresh: changeClaims(next.refresh, { token_type: 'access' }) },
    { ...valid, session_last_activity_at: undefined },
    { ...valid, session_idle_expires_at: 'not-a-date' },
    { ...valid, session_idle_expires_at: valid.session_last_activity_at },
    { ...valid, session_idle_expires_at: new Date(NOW + 86_400_001).toISOString() },
  ];
  for (const response of invalid) {
    const fixture = harness(); const api = fixture.module(); const before = fixture.snapshot();
    const done = outcome(api.recordAuthActivity(SESSION_A, request().activity));
    await fixture.expectCalls(1); fixture.calls[0].reply.resolve({ data: response });
    nonDefinitive(await done, api);
    assert.deepEqual(fixture.snapshot(), before);
    assert.deepEqual(fixture.rotations, []); assert.deepEqual(fixture.invalidations, []);
  }
});

test('only a definitive current-session rejection invalidates auth; generic activity refusal retains it', async () => {
  for (const operation of ['refresh', 'activity'] as const) for (const code of ['session_idle_expired', 'session_activity_rejected']) {
    const initial = pair('initial'); const fixture = harness(initial); const api = fixture.module(); const before = fixture.snapshot();
    const done = outcome(operation === 'refresh' ? api.refreshAccessToken(initial.access, SESSION_A)
      : api.recordAuthActivity(SESSION_A, request().activity));
    await fixture.expectCalls(1); fixture.calls[0].reply.reject(httpFailure(code));
    const result = await done;
    assert.equal(result.ok, false);
    if (!result.ok) { assert.ok(result.error instanceof api.AuthRefreshError); assert.equal(result.error.isDefinitive, code === 'session_idle_expired'); }
    assert.deepEqual(fixture.invalidations, code === 'session_idle_expired' ? [SESSION_A] : []);
    assert.deepEqual(fixture.snapshot(), code === 'session_idle_expired' ? { id: null, access: null, refresh: null } : before);
    assert.deepEqual(fixture.rotations, []);
    assert.equal(api.isDefinitiveSessionRejection(401, 'session_idle_expired'), true);
    assert.equal(api.isDefinitiveSessionRejection(401, 'session_activity_rejected'), false);
    assert.equal(api.isDefinitiveSessionRejection(403, 'session_idle_expired'), false);
    assert.equal(api.isDefinitiveSessionRejection(503, 'session_idle_expired'), false);
  }
});
