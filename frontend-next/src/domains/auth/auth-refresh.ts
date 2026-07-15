import axios from "axios";
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from "@/domains/auth/auth-storage";
import { isDevSessionToken } from "@/domains/auth/dev-session";

const API_BASE_URL = import.meta.env.PROD
  ? "/api"
  : (import.meta.env.VITE_API_BASE_URL || "/api");
const AUTH_REFRESH_LOCK_NAME = "wj-auth-token-refresh";
const ACCESS_EXPIRY_SKEW_SECONDS = 5;

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

let inFlightRefresh: Promise<string> | null = null;
let reloadPending = false;

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

function getReplacementAccessToken(failedAccessToken: string | null) {
  const currentAccess = getAccessToken();
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

function clearTokensIfRefreshIsCurrent(refreshUsed: string | null) {
  if (getRefreshToken() === refreshUsed) {
    clearTokens();
  }
}

async function performRefresh(failedAccessToken: string | null) {
  const replacementAccess = getReplacementAccessToken(failedAccessToken);
  if (replacementAccess) {
    return replacementAccess;
  }

  const refreshUsed = getRefreshToken();
  if (!refreshUsed) {
    clearTokensIfRefreshIsCurrent(null);
    throw new AuthRefreshError("A refresh token is not available", true);
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
    if (getRefreshToken() !== refreshUsed) {
      const currentAccess = getReplacementAccessToken(failedAccessToken);
      if (currentAccess) {
        return currentAccess;
      }
      throw new AuthRefreshError("The session changed while it was being refreshed", false);
    }

    if (!nextAccess) {
      clearTokensIfRefreshIsCurrent(refreshUsed);
      throw new AuthRefreshError("The refresh response did not include an access token", true);
    }

    // SimpleJWT rotates and blacklists refresh tokens. Persist the rotated token
    // before publishing its matching access token so a reload never sees a stale pair.
    if (nextRefresh) {
      setRefreshToken(nextRefresh);
    }
    setAccessToken(nextAccess);
    return nextAccess;
  } catch (error) {
    if (error instanceof AuthRefreshError) {
      throw error;
    }

    // A tab without Web Locks can lose a refresh race. Reuse the winner's pair
    // instead of clearing a session that another tab has just renewed.
    const replacementAfterFailure = getReplacementAccessToken(failedAccessToken);
    if (getRefreshToken() !== refreshUsed && replacementAfterFailure) {
      return replacementAfterFailure;
    }

    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const isDefinitive = status === 400 || status === 401 || status === 403;
    if (isDefinitive) {
      clearTokensIfRefreshIsCurrent(refreshUsed);
    }

    throw new AuthRefreshError(
      isDefinitive ? "The refresh token was rejected" : "The session could not be refreshed yet",
      isDefinitive,
      { cause: error },
    );
  }
}

async function performRefreshWithCrossTabLock(failedAccessToken: string | null) {
  const locks = (navigator as NavigatorWithLocks).locks;
  if (!locks) {
    return performRefresh(failedAccessToken);
  }

  return locks.request(AUTH_REFRESH_LOCK_NAME, () => performRefresh(failedAccessToken));
}

export function refreshAccessToken(failedAccessToken: string | null = getAccessToken()) {
  if (reloadPending) {
    return Promise.reject(new AuthRefreshError("A new application build is loading", false));
  }

  if (!inFlightRefresh) {
    inFlightRefresh = performRefreshWithCrossTabLock(failedAccessToken).finally(() => {
      inFlightRefresh = null;
    });
  }

  return inFlightRefresh;
}

export async function reloadAfterAuthRefreshSettles() {
  const activeRefresh = inFlightRefresh;
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
