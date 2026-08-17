import axios from "axios";
import {
  getAuthSessionSnapshot,
  invalidateAuthSession,
  rotateTokenPair,
} from "@/domains/auth/auth-storage";
import { isDevSessionToken } from "@/domains/auth/dev-session";

const API_BASE_URL = import.meta.env.PROD
  ? "/api"
  : (import.meta.env.VITE_API_BASE_URL || "/api");
const AUTH_REFRESH_LOCK_NAME = "wj-auth-token-refresh";
const AUTH_REFRESH_LEASE_KEY = "wj-auth-token-refresh-lease-v1";
const ACCESS_EXPIRY_SKEW_SECONDS = 5;
const REFRESH_LEASE_DURATION_MS = 35_000;
const REFRESH_LEASE_WAIT_MS = 40_000;
const REFRESH_LEASE_SETTLE_MS = 40;
const REFRESH_LEASE_POLL_MS = 80;

type AuthLockManager = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

type NavigatorWithLocks = Navigator & {
  locks?: AuthLockManager;
};

type TokenRefreshResponse = {
  access?: unknown;
  refresh?: unknown;
};

type SimpleJwtErrorResponse = {
  code?: unknown;
};

type RefreshLease = {
  owner: string;
  expiresAt: number;
};

export class AuthRefreshError extends Error {
  constructor(
    message: string,
    readonly isDefinitive: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthRefreshError";
  }
}

let inFlightRefresh: { sessionId: string | null; promise: Promise<string> } | null = null;
let reloadPending = false;

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function createRefreshLeaseOwner() {
  if (typeof window.crypto?.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readRefreshLease(): RefreshLease | null {
  const stored = window.localStorage.getItem(AUTH_REFRESH_LEASE_KEY);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored) as Partial<RefreshLease>;
    if (typeof parsed.owner !== "string" || typeof parsed.expiresAt !== "number") {
      return null;
    }
    return { owner: parsed.owner, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function releaseRefreshLease(owner: string) {
  if (readRefreshLease()?.owner === owner) {
    window.localStorage.removeItem(AUTH_REFRESH_LEASE_KEY);
  }
}

function decodeJwtPayload(token: string) {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("JWT payload is missing");
  }

  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(window.atob(padded)) as { exp?: unknown };
}

export function isAccessTokenExpired(
  token?: string | null,
  skewSeconds = ACCESS_EXPIRY_SKEW_SECONDS,
) {
  if (!token) return true;

  try {
    const payload = decodeJwtPayload(token);
    return typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now() + skewSeconds * 1000;
  } catch {
    return true;
  }
}

function getReplacementAccessToken(
  failedAccessToken: string | null,
  expectedSessionId: string | null,
) {
  const session = getAuthSessionSnapshot();
  if (!expectedSessionId || session.id !== expectedSessionId) return null;
  const currentAccess = session.access;
  if (
    currentAccess &&
    currentAccess !== failedAccessToken &&
    !isDevSessionToken(currentAccess) &&
    !isAccessTokenExpired(currentAccess)
  ) {
    return currentAccess;
  }
  return null;
}

function clearTokensIfRefreshIsCurrent(
  refreshUsed: string | null,
  expectedSessionId: string | null,
) {
  const session = getAuthSessionSnapshot();
  if (session.refresh === refreshUsed && session.id === expectedSessionId) {
    invalidateAuthSession(expectedSessionId);
  }
}

async function waitForReplacementAccessToken(
  failedAccessToken: string | null,
  refreshUsed: string,
  expectedSessionId: string,
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const replacement = getReplacementAccessToken(failedAccessToken, expectedSessionId);
    if (replacement) return replacement;
    const session = getAuthSessionSnapshot();
    if (session.refresh === refreshUsed || session.id !== expectedSessionId) return null;
    await delay(REFRESH_LEASE_SETTLE_MS);
  }
  return getReplacementAccessToken(failedAccessToken, expectedSessionId);
}

async function performRefresh(
  failedAccessToken: string | null,
  sessionUsed: string | null,
) {
  const sessionAtStart = getAuthSessionSnapshot();
  if (sessionAtStart.id !== sessionUsed) {
    throw new AuthRefreshError("The session changed before it could be refreshed", false);
  }
  const replacementAccess = getReplacementAccessToken(failedAccessToken, sessionUsed);
  if (replacementAccess) {
    return replacementAccess;
  }

  const refreshUsed = sessionAtStart.refresh;
  if (!refreshUsed) {
    clearTokensIfRefreshIsCurrent(null, sessionUsed);
    throw new AuthRefreshError("A refresh token is not available", true);
  }
  if (!sessionUsed) {
    throw new AuthRefreshError("An authenticated session is not available", true);
  }

  if (isDevSessionToken(refreshUsed)) {
    throw new AuthRefreshError("Development sessions are not refreshed", true);
  }

  try {
    const response = await axios.post<TokenRefreshResponse>(
      `${API_BASE_URL}/token/refresh/`,
      { refresh: refreshUsed },
      { timeout: 30_000 },
    );
    const nextAccess = typeof response.data?.access === "string" ? response.data.access : "";
    const nextRefresh = typeof response.data?.refresh === "string" ? response.data.refresh : "";

    // Logout, a new login, or another tab may replace the session while this
    // request is in flight. Never let the older response resurrect or overwrite it.
    const currentSession = getAuthSessionSnapshot();
    if (currentSession.refresh !== refreshUsed || currentSession.id !== sessionUsed) {
      const currentAccess = getReplacementAccessToken(failedAccessToken, sessionUsed);
      if (currentAccess) {
        return currentAccess;
      }
      throw new AuthRefreshError("The session changed while it was being refreshed", false);
    }

    if (!nextAccess) {
      throw new AuthRefreshError("The refresh response did not include an access token", false);
    }

    // SimpleJWT rotates and blacklists refresh tokens. Persist the rotated token
    // before publishing its matching access token so a reload never sees a stale pair.
    if (!rotateTokenPair(nextAccess, nextRefresh || refreshUsed, sessionUsed)) {
      throw new AuthRefreshError("The session changed while it was being refreshed", false);
    }
    return nextAccess;
  } catch (error) {
    if (error instanceof AuthRefreshError) {
      throw error;
    }

    // A tab without Web Locks can lose a refresh race. Reuse the winner's pair
    // instead of clearing a session that another tab has just renewed.
    const currentSession = getAuthSessionSnapshot();
    if (currentSession.refresh !== refreshUsed || currentSession.id !== sessionUsed) {
      const replacementAfterFailure = await waitForReplacementAccessToken(
        failedAccessToken,
        refreshUsed,
        sessionUsed,
      );
      if (replacementAfterFailure) {
        return replacementAfterFailure;
      }
      throw new AuthRefreshError("The session changed while it was being refreshed", false, {
        cause: error,
      });
    }

    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const responseData = axios.isAxiosError<SimpleJwtErrorResponse>(error)
      ? error.response?.data
      : undefined;
    const isDefinitive = status === 401 && responseData?.code === "token_not_valid";
    if (isDefinitive) {
      clearTokensIfRefreshIsCurrent(refreshUsed, sessionUsed);
    }

    throw new AuthRefreshError(
      isDefinitive ? "The refresh token was rejected" : "The session could not be refreshed yet",
      isDefinitive,
      { cause: error },
    );
  }
}

async function performRefreshWithCrossTabLock(
  failedAccessToken: string | null,
  expectedSessionId: string | null,
) {
  const locks = (navigator as NavigatorWithLocks).locks;
  if (locks) {
    return locks.request(
      AUTH_REFRESH_LOCK_NAME,
      () => performRefresh(failedAccessToken, expectedSessionId),
    );
  }

  // Some embedded browsers do not expose Web Locks. Use a short-lived,
  // token-free localStorage lease so only one tab rotates the refresh token.
  // The settle delay makes concurrent writes deterministic: the last writer
  // owns the lease and every other tab waits for its access token.
  const owner = createRefreshLeaseOwner();
  const waitUntil = Date.now() + REFRESH_LEASE_WAIT_MS;

  try {
    while (Date.now() < waitUntil) {
      if (getAuthSessionSnapshot().id !== expectedSessionId) {
        throw new AuthRefreshError("The session changed while waiting to refresh", false);
      }
      const replacementAccess = getReplacementAccessToken(failedAccessToken, expectedSessionId);
      if (replacementAccess) {
        return replacementAccess;
      }

      const now = Date.now();
      const lease = readRefreshLease();
      if (!lease || lease.expiresAt <= now) {
        window.localStorage.setItem(AUTH_REFRESH_LEASE_KEY, JSON.stringify({
          owner,
          expiresAt: now + REFRESH_LEASE_DURATION_MS,
        } satisfies RefreshLease));
        await delay(REFRESH_LEASE_SETTLE_MS);

        if (readRefreshLease()?.owner === owner) {
          try {
            return await performRefresh(failedAccessToken, expectedSessionId);
          } finally {
            releaseRefreshLease(owner);
          }
        }
      }

      await delay(REFRESH_LEASE_POLL_MS);
    }
  } catch (error) {
    // localStorage can be unavailable in privacy-restricted contexts. Keep the
    // existing race-safe response handling as the final compatibility path.
    if (error instanceof AuthRefreshError) {
      throw error;
    }
    return performRefresh(failedAccessToken, expectedSessionId);
  }

  const replacementAccess = getReplacementAccessToken(failedAccessToken, expectedSessionId);
  if (replacementAccess) {
    return replacementAccess;
  }
  throw new AuthRefreshError("Timed out waiting for another tab to refresh the session", false);
}

export function refreshAccessToken(
  failedAccessToken?: string | null,
  expectedSessionId?: string | null,
) {
  if (reloadPending) {
    return Promise.reject(new AuthRefreshError("A new application build is loading", false));
  }

  const session = getAuthSessionSnapshot();
  const requestedSessionId = expectedSessionId === undefined ? session.id : expectedSessionId;
  const requestedFailedAccess = failedAccessToken === undefined ? session.access : failedAccessToken;
  if (inFlightRefresh && inFlightRefresh.sessionId !== requestedSessionId) {
    return Promise.reject(new AuthRefreshError("The authenticated session changed", false));
  }

  if (!inFlightRefresh) {
    const promise = performRefreshWithCrossTabLock(
      requestedFailedAccess,
      requestedSessionId,
    ).finally(() => {
      if (inFlightRefresh?.promise === promise) {
        inFlightRefresh = null;
      }
    });
    inFlightRefresh = { sessionId: requestedSessionId, promise };
  }

  return inFlightRefresh.promise;
}

export async function reloadAfterAuthRefreshSettles() {
  const activeRefresh = inFlightRefresh?.promise;
  if (activeRefresh) {
    try {
      await activeRefresh;
    } catch {
      // The operation still needs to run. Bootstrap will either retry a
      // transient refresh failure or show login for a definitively expired pair.
    }
  }

  // Block any late 401 handler in this document from starting a token rotation
  // after reload begins. The new document gets a fresh module instance.
  reloadPending = true;
  const reload = () => window.location.reload();
  const locks = (navigator as NavigatorWithLocks).locks;
  if (!locks) {
    reload();
    return;
  }

  await locks.request(AUTH_REFRESH_LOCK_NAME, async () => reload());
}
