import assert from 'node:assert/strict';
import test from 'node:test';
import { getAuthSessionSnapshot, invalidateAuthSession, startAuthSession } from '../src/domains/auth/auth-storage.ts';
import { finishServerLogout } from '../src/domains/auth/server-logout.ts';

const values = new Map<string, string>();
let beforeWrite: ((key: string) => void) | null = null;
let onNotification: (() => void) | null = null;
let sequence = 0;
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { beforeWrite?.(key); values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
};
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  localStorage: storage,
  crypto: { randomUUID: () => `synthetic-session-${++sequence}` },
  dispatchEvent: () => { onNotification?.(); return true; },
} });
const pairA = { access: 'synthetic-access-a', refresh: 'synthetic-refresh-a' };
const pairB = { access: 'synthetic-access-b', refresh: 'synthetic-refresh-b' };

function begin() {
  values.clear(); beforeWrite = null; onNotification = null;
  return startAuthSession(pairA.access, pairA.refresh);
}
function finish(sessionId: string) {
  return finishServerLogout(sessionId, {
    revoke: async () => ({ disconnected: true }),
    currentSessionId: () => getAuthSessionSnapshot().id,
    invalidateLocal: invalidateAuthSession,
  });
}

test('production storage invalidates only A when B logs in at the invalidation write boundary', async () => {
  const sessionA = begin();
  let sessionB: string | null = null;
  beforeWrite = key => {
    if (key !== `wj-auth-invalidated-session-v2:${sessionA}`) return;
    beforeWrite = null;
    // Deterministically model another tab installing B after the last A check,
    // immediately before A's storage write. Use the real login-storage path.
    sessionB = startAuthSession(pairB.access, pairB.refresh);
  };
  assert.equal(await finish(sessionA), false);
  assert.deepEqual(getAuthSessionSnapshot(), { id: sessionB, ...pairB });
  assert.equal(JSON.parse(values.get(`wj-auth-invalidated-session-v2:${sessionA}`)!).sessionId, sessionA);
  assert.equal(values.has(`wj-auth-invalidated-session-v2:${sessionB}`), false);
  for (const key of ['access_token', 'wj_next_access_token']) assert.equal(values.get(key), pairB.access);
  for (const key of ['refresh_token', 'wj_next_refresh_token']) assert.equal(values.get(key), pairB.refresh);
});

test('production storage preserves B installed during A invalidation notification', async () => {
  const sessionA = begin();
  let sessionB: string | null = null;
  onNotification = () => {
    onNotification = null;
    sessionB = startAuthSession(pairB.access, pairB.refresh);
  };
  assert.equal(await finish(sessionA), false);
  assert.deepEqual(getAuthSessionSnapshot(), { id: sessionB, ...pairB });
});

test('confirmed logout leaves no effective credentials and later login has an independent session', async () => {
  const sessionA = begin();
  assert.equal(await finish(sessionA), true);
  assert.deepEqual(getAuthSessionSnapshot(), { id: null, access: null, refresh: null });
  const sessionB = startAuthSession(pairB.access, pairB.refresh);
  assert.notEqual(sessionA, sessionB);
  assert.deepEqual(getAuthSessionSnapshot(), { id: sessionB, ...pairB });
  assert.equal(invalidateAuthSession(sessionA), false);
  assert.deepEqual(getAuthSessionSnapshot(), { id: sessionB, ...pairB });
});
