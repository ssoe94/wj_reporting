import assert from 'node:assert/strict';
import test from 'node:test';
import { commitAuthSession, withAuthCommitLock } from '../src/domains/auth/auth-commit.ts';
import { getAuthSessionGeneration, getAuthSessionSnapshot, invalidateAuthSession, startAuthSession } from '../src/domains/auth/auth-storage.ts';
import { createLoginAttemptGate } from '../src/domains/auth/auth-transition.ts';

// Model IDB's documented read/write transaction queue; production coordinator
// code, storage writes and login gates run unchanged. Real IDB is also covered
// by the intercepted Chrome fixture.
function coordinator(mode: 'normal' | 'abort' | 'timeout' | 'blocked' = 'normal') {
  let active = false;
  const queue: (() => void)[] = [];
  const observations = { reads: [] as string[], writes: 0, closed: 0, transactionModes: [] as string[] };
  const pump = () => {
    if (active || !queue.length) return;
    active = true;
    queueMicrotask(() => { queue.shift()!(); active = false; pump(); });
  };
  const factory = { open: () => {
    const request: Record<string, unknown> = {};
    queueMicrotask(() => {
      if (mode === 'blocked') { (request.onblocked as () => void)(); return; }
      request.result = {
        close: () => { observations.closed += 1; },
        transaction: (_store: string, transactionMode: string) => {
          observations.transactionModes.push(transactionMode);
          let aborted = false;
          const transaction: Record<string, unknown> = {
            abort: () => { aborted = true; queueMicrotask(() => (transaction.onabort as () => void)?.()); },
            objectStore: () => ({ get: (key: string) => {
              observations.reads.push(key);
              const read: Record<string, unknown> = {};
              if (mode !== 'timeout') {
                queue.push(() => {
                  if (mode === 'abort' || aborted) { (transaction.onabort as () => void)(); return; }
                  (read.onsuccess as () => void)();
                  if (!aborted) (transaction.oncomplete as () => void)();
                });
                pump();
              }
              return read;
            }, put: () => { observations.writes += 1; throw new Error('No identity data may be written'); } }),
          };
          return transaction;
        },
      };
      (request.onsuccess as () => void)();
    });
    return request;
  } } as unknown as IDBFactory;
  return { factory, observations };
}

const storage = new Map<string, string>();
let beforeWrite: ((key: string) => void) | null = null;
let sequence = 0;
const browser = {
  indexedDB: undefined as IDBFactory | undefined,
  setTimeout, clearTimeout, crypto: { randomUUID: () => `synthetic-commit-${++sequence}` },
  dispatchEvent: () => true,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { beforeWrite?.(key); storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
};
Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
function setup() {
  storage.clear(); beforeWrite = null;
  const fixture = coordinator(); browser.indexedDB = fixture.factory;
  return fixture;
}
const gate = () => createLoginAttemptGate(() => getAuthSessionSnapshot().id, getAuthSessionGeneration);

test('two tabs with the same starting generation cannot both commit a login', async () => {
  const fixture = setup();
  const gateA = gate(); const gateB = gate();
  const attemptA = gateA.begin(); const attemptB = gateB.begin();
  const [first, second] = await Promise.all([
    commitAuthSession('synthetic-a-access', 'synthetic-a-refresh', () => gateA.isCurrent(attemptA)),
    commitAuthSession('synthetic-b-access', 'synthetic-b-refresh', () => gateB.isCurrent(attemptB)),
  ]);
  assert.ok(first); assert.equal(second, null);
  assert.equal(getAuthSessionSnapshot().id, first);
  assert.deepEqual(fixture.observations.transactionModes, ['readwrite', 'readwrite']);
  assert.deepEqual(fixture.observations.reads, ['coordinator', 'coordinator']);
  assert.equal(fixture.observations.writes, 0);
});

test('login queued at the first login control-write boundary cannot overwrite the committed winner', async () => {
  setup();
  const gateA = gate(); const gateB = gate();
  const attemptA = gateA.begin(); const attemptB = gateB.begin();
  let second: Promise<string | null> | undefined;
  beforeWrite = key => {
    if (key !== 'wj-auth-session-control-v2') return;
    beforeWrite = null;
    second = commitAuthSession('synthetic-b-access', 'synthetic-b-refresh', () => gateB.isCurrent(attemptB));
  };
  const first = await commitAuthSession('synthetic-a-access', 'synthetic-a-refresh', () => gateA.isCurrent(attemptA));
  assert.ok(first); assert.ok(second); assert.equal(await second, null);
  assert.equal(getAuthSessionSnapshot().access, 'synthetic-a-access');
});

test('a login+logout in another tab invalidates an old null-session attempt even before storage events', async () => {
  setup();
  const localGate = gate(); const attempt = localGate.begin();
  const newer = startAuthSession('synthetic-b-access', 'synthetic-b-refresh');
  invalidateAuthSession(newer);
  assert.equal(getAuthSessionSnapshot().id, null);
  assert.equal(await commitAuthSession('synthetic-a-access', 'synthetic-a-refresh', () => localGate.isCurrent(attempt)), null);
  assert.equal(getAuthSessionGeneration(), newer);
});

for (const mode of ['abort', 'timeout', 'blocked'] as const) {
  test(`coordinator ${mode} never invokes the login write`, async () => {
    const fixture = coordinator(mode);
    let committed = false;
    await assert.rejects(withAuthCommitLock(() => { committed = true; }, fixture.factory, 10), /coordination unavailable/);
    assert.equal(committed, false);
    assert.equal(fixture.observations.writes, 0);
  });
}

test('missing or throwing IDB fails closed without changing the current session', async () => {
  setup();
  const current = startAuthSession('synthetic-current', 'synthetic-refresh');
  for (const factory of [undefined, { open: () => { throw new Error('Synthetic access denied'); } } as unknown as IDBFactory]) {
    browser.indexedDB = factory;
    await assert.rejects(commitAuthSession('synthetic-new', 'synthetic-refresh', () => true), /coordination unavailable/);
    assert.equal(getAuthSessionSnapshot().id, current);
  }
});

test('a failed commit callback aborts its own transaction and returns a fixed error', async () => {
  const fixture = coordinator();
  await assert.rejects(withAuthCommitLock(() => { throw new Error('Synthetic callback failure'); }, fixture.factory), /coordination unavailable/);
  assert.equal(fixture.observations.closed, 1);
});

test('compatibility mirror failure cannot turn an installed authoritative login into failure', async () => {
  setup();
  const localGate = gate(); const attempt = localGate.begin();
  beforeWrite = key => {
    if (key !== 'wj-auth-session-control-v2') throw new Error('Synthetic quota exhausted after control commit');
  };
  try {
    const sessionId = await commitAuthSession('synthetic-access', 'synthetic-refresh', () => localGate.isCurrent(attempt));
    assert.ok(sessionId);
    assert.deepEqual(getAuthSessionSnapshot(), { id: sessionId, access: 'synthetic-access', refresh: 'synthetic-refresh' });
  } finally { beforeWrite = null; }
});
