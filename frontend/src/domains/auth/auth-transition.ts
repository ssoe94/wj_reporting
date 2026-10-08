import { getAuthSessionSnapshot } from './auth-storage.ts';

// Guards protect explicit local logout. A different tab can replace shared
// storage at any time, so request admission also checks the captured owner.
const guards = new Map<symbol, { sessionId: string | null; allow: () => boolean }>();
const ending = new Set<string>();

export function registerAuthTransitionGuard(sessionId: string | null, allow: () => boolean) {
  const key = Symbol('auth-transition');
  guards.set(key, { sessionId, allow });
  return () => { guards.delete(key); };
}

export function isAuthSessionCurrent(sessionId: string | null): boolean {
  try { return Boolean(sessionId && getAuthSessionSnapshot().id === sessionId); }
  catch { return false; }
}

export function assertAuthSessionCurrent(sessionId: string | null): void {
  if (!isAuthSessionCurrent(sessionId) || (sessionId && ending.has(sessionId))) {
    throw new Error('Authentication session changed or is ending');
  }
}

export function beginAuthSessionEnd(sessionId: string | null): (() => void) | null {
  if (!isAuthSessionCurrent(sessionId) || !sessionId || ending.has(sessionId)) return null;
  try {
    for (const guard of guards.values()) {
      if (guard.sessionId === sessionId && !guard.allow()) return null;
    }
  } catch { return null; }
  // A confirmation dialog or guard can allow another tab to change storage.
  if (!isAuthSessionCurrent(sessionId)) return null;
  ending.add(sessionId);
  return () => { ending.delete(sessionId); };
}

export function createLoginAttemptGate(currentSessionId: () => string | null, currentControlGeneration = currentSessionId) {
  let generation = 0;
  return {
    begin: () => ({ generation: ++generation, sessionId: currentSessionId(), controlGeneration: currentControlGeneration() }),
    invalidate: () => { generation += 1; },
    isCurrent: (attempt: { generation: number; sessionId: string | null; controlGeneration: string | null }) =>
      attempt.generation === generation && attempt.sessionId === currentSessionId()
      && attempt.controlGeneration === currentControlGeneration(),
  };
}
