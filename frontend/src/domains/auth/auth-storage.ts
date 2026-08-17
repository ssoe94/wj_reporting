const ACCESS_TOKEN_KEY = "wj_next_access_token";
const REFRESH_TOKEN_KEY = "wj_next_refresh_token";
const LEGACY_ACCESS_TOKEN_KEY = "access_token";
const LEGACY_REFRESH_TOKEN_KEY = "refresh_token";
const AUTH_STORAGE_CHANGED_EVENT = "wj-auth-storage-changed";
const AUTH_SESSION_REVISION_KEY = "wj-auth-session-revision-v1";
const AUTH_SESSION_CONTROL_KEY = "wj-auth-session-control-v2";
const AUTH_ROTATED_PAIR_KEY_PREFIX = "wj-auth-rotated-pair-v2:";
const AUTH_INVALIDATED_SESSION_KEY_PREFIX = "wj-auth-invalidated-session-v2:";

type SessionControl = {
  id: string | null;
  access?: string;
  refresh?: string;
};

type RotatedPair = {
  sessionId: string;
  access: string;
  refresh: string;
};

type InvalidatedSession = {
  sessionId: string;
};

export type AuthSessionSnapshot = {
  id: string | null;
  access: string | null;
  refresh: string | null;
};

function createSessionId() {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseStored<T>(key: string): T | null {
  const value = window.localStorage.getItem(key);
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function rotatedPairKey(sessionId: string) {
  return `${AUTH_ROTATED_PAIR_KEY_PREFIX}${sessionId}`;
}

function invalidatedSessionKey(sessionId: string) {
  return `${AUTH_INVALIDATED_SESSION_KEY_PREFIX}${sessionId}`;
}

function readSessionControl(): SessionControl {
  const storedValue = window.localStorage.getItem(AUTH_SESSION_CONTROL_KEY);
  if (storedValue !== null) {
    const parsed = parseStored<Partial<SessionControl>>(AUTH_SESSION_CONTROL_KEY);
    if (parsed?.id === null) return { id: null };
    if (
      typeof parsed?.id === "string"
      && typeof parsed.access === "string"
      && typeof parsed.refresh === "string"
    ) {
      return { id: parsed.id, access: parsed.access, refresh: parsed.refresh };
    }
    return { id: null };
  }

  // One-time compatibility migration. The new single control record becomes
  // authoritative, so later refresh/login/logout races cannot mix token pairs.
  const access = window.localStorage.getItem(LEGACY_ACCESS_TOKEN_KEY)
    || window.localStorage.getItem(ACCESS_TOKEN_KEY);
  const refresh = window.localStorage.getItem(LEGACY_REFRESH_TOKEN_KEY)
    || window.localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!access || !refresh) {
    const empty = { id: null } satisfies SessionControl;
    window.localStorage.setItem(AUTH_SESSION_CONTROL_KEY, JSON.stringify(empty));
    return empty;
  }
  const migrated = { id: createSessionId(), access, refresh } satisfies SessionControl;
  window.localStorage.setItem(AUTH_SESSION_CONTROL_KEY, JSON.stringify(migrated));
  return migrated;
}

function readEffectiveSession() {
  const control = readSessionControl();
  if (!control.id || !control.access || !control.refresh) return control;
  const invalidated = parseStored<Partial<InvalidatedSession>>(invalidatedSessionKey(control.id));
  if (invalidated?.sessionId === control.id) {
    return { id: null } satisfies SessionControl;
  }
  const rotated = parseStored<Partial<RotatedPair>>(rotatedPairKey(control.id));
  if (
    rotated?.sessionId === control.id
    && typeof rotated.access === "string"
    && typeof rotated.refresh === "string"
  ) {
    return { id: control.id, access: rotated.access, refresh: rotated.refresh };
  }
  return control;
}

function mirrorLegacyPair(access: string, refresh: string) {
  // These mirrors keep older tabs alive during a rolling frontend deploy. They
  // are never authoritative once AUTH_SESSION_CONTROL_KEY exists.
  window.localStorage.setItem(ACCESS_TOKEN_KEY, access);
  window.localStorage.setItem(LEGACY_ACCESS_TOKEN_KEY, access);
  window.localStorage.setItem(REFRESH_TOKEN_KEY, refresh);
  window.localStorage.setItem(LEGACY_REFRESH_TOKEN_KEY, refresh);
}

function notifyAuthStorageChanged() {
  window.localStorage.setItem(
    AUTH_SESSION_REVISION_KEY,
    `${Date.now()}-${window.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
  );
  window.dispatchEvent(new Event(AUTH_STORAGE_CHANGED_EVENT));
}

export function getAccessToken() {
  return getAuthSessionSnapshot().access;
}

export function getRefreshToken() {
  return getAuthSessionSnapshot().refresh;
}

export function getAuthSessionId() {
  return getAuthSessionSnapshot().id;
}

export function getAuthSessionSnapshot(): AuthSessionSnapshot {
  const session = readEffectiveSession();
  return {
    id: session.id || null,
    access: session.access || null,
    refresh: session.refresh || null,
  };
}

export function startAuthSession(access: string, refresh: string) {
  const session = { id: createSessionId(), access, refresh } satisfies SessionControl;
  window.localStorage.setItem(AUTH_SESSION_CONTROL_KEY, JSON.stringify(session));
  window.localStorage.removeItem(rotatedPairKey(session.id));
  window.localStorage.removeItem(invalidatedSessionKey(session.id));
  mirrorLegacyPair(access, refresh);
  notifyAuthStorageChanged();
  return session.id;
}

export function rotateTokenPair(access: string, refresh: string, expectedSessionId: string) {
  if (getAuthSessionSnapshot().id !== expectedSessionId) return false;
  const rotated = { sessionId: expectedSessionId, access, refresh } satisfies RotatedPair;
  window.localStorage.setItem(rotatedPairKey(expectedSessionId), JSON.stringify(rotated));
  // If an explicit login/logout won concurrently, the tagged rotation is now
  // ignored. Do not let its compatibility mirrors overwrite that new session.
  if (getAuthSessionSnapshot().id !== expectedSessionId) return false;
  mirrorLegacyPair(access, refresh);
  notifyAuthStorageChanged();
  return getAuthSessionSnapshot().id === expectedSessionId;
}

export function invalidateAuthSession(expectedSessionId: string | null) {
  if (!expectedSessionId) return false;

  // This is intentionally a tagged invalidation rather than a check followed
  // by clearTokens(). If another tab installs session B between those two
  // operations, a late failure from session A must not erase B.
  window.localStorage.setItem(
    invalidatedSessionKey(expectedSessionId),
    JSON.stringify({ sessionId: expectedSessionId } satisfies InvalidatedSession),
  );
  const invalidatedCurrentSession = readSessionControl().id === expectedSessionId;
  notifyAuthStorageChanged();
  return invalidatedCurrentSession;
}

export function clearTokens() {
  // Keep an explicit tombstone so an old tab can never migrate stale mirrors
  // back into an authenticated session after logout.
  const sessionId = readSessionControl().id;
  window.localStorage.setItem(
    AUTH_SESSION_CONTROL_KEY,
    JSON.stringify({ id: null } satisfies SessionControl),
  );
  if (sessionId) {
    window.localStorage.removeItem(rotatedPairKey(sessionId));
    window.localStorage.removeItem(invalidatedSessionKey(sessionId));
  }
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  window.localStorage.removeItem(LEGACY_ACCESS_TOKEN_KEY);
  window.localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
  notifyAuthStorageChanged();
}

export function subscribeToAuthStorage(listener: () => void) {
  let pendingTimer: number | null = null;
  const scheduleListener = () => {
    if (pendingTimer !== null) window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null;
      listener();
    }, 25);
  };

  const handleStorage = (event: StorageEvent) => {
    if (
      event.storageArea === window.localStorage
      && (
        event.key === AUTH_SESSION_CONTROL_KEY
        || event.key?.startsWith(AUTH_ROTATED_PAIR_KEY_PREFIX)
        || event.key?.startsWith(AUTH_INVALIDATED_SESSION_KEY_PREFIX)
        || event.key === AUTH_SESSION_REVISION_KEY
        || event.key === ACCESS_TOKEN_KEY
        || event.key === REFRESH_TOKEN_KEY
        || event.key === LEGACY_ACCESS_TOKEN_KEY
        || event.key === LEGACY_REFRESH_TOKEN_KEY
        || event.key === null
      )
    ) {
      scheduleListener();
    }
  };

  window.addEventListener(AUTH_STORAGE_CHANGED_EVENT, scheduleListener);
  window.addEventListener("storage", handleStorage);
  return () => {
    if (pendingTimer !== null) window.clearTimeout(pendingTimer);
    window.removeEventListener(AUTH_STORAGE_CHANGED_EVENT, scheduleListener);
    window.removeEventListener("storage", handleStorage);
  };
}
