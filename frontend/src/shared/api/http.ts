import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { AuthRefreshError, refreshAccessToken } from "@/domains/auth/auth-refresh";
import { getAuthSessionSnapshot } from "@/domains/auth/auth-storage";
import { isDevSessionToken } from "@/domains/auth/dev-session";

const API_BASE_URL = import.meta.env.PROD
  ? "/api"
  : (import.meta.env.VITE_API_BASE_URL || "/api");

type RetriableRequest = InternalAxiosRequestConfig & {
  _retry?: boolean;
  _authSessionId?: string | null;
};

declare module "axios" {
  export interface AxiosRequestConfig {
    skipAuth?: boolean;
  }
}

export const http = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
  headers: {
    "Content-Type": "application/json",
  },
});

http.interceptors.request.use((config) => {
  const request = config as RetriableRequest;
  if (config.skipAuth) {
    config.headers.delete("Authorization");
    request._authSessionId = null;
    return config;
  }

  const session = getAuthSessionSnapshot();
  if (request._authSessionId === undefined) {
    request._authSessionId = session.id;
  }
  if (request._authSessionId !== session.id) {
    return Promise.reject(new AuthRefreshError("The authenticated session changed", false));
  }
  const token = session.access;
  if (token && !isDevSessionToken(token)) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

http.interceptors.response.use(
  (response) => {
    const request = response.config as RetriableRequest;
    if (
      !request.skipAuth
      && request._authSessionId
      && request._authSessionId !== getAuthSessionSnapshot().id
    ) {
      return Promise.reject(new AuthRefreshError("The authenticated session changed", false));
    }
    return response;
  },
  async (error: AxiosError) => {
    const request = error.config as RetriableRequest | undefined;
    if (!request || request.skipAuth || error.response?.status !== 401 || request._retry) {
      return Promise.reject(error);
    }

    const authorization = request.headers.Authorization;
    const session = getAuthSessionSnapshot();
    const failedAccess = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : session.access;
    if (isDevSessionToken(failedAccess)) {
      return Promise.reject(error);
    }

    request._retry = true;

    const requestSessionId = request._authSessionId;
    if (!requestSessionId || requestSessionId !== session.id) {
      return Promise.reject(new AuthRefreshError("The authenticated session changed", false));
    }

    try {
      const refreshedAccess = await refreshAccessToken(failedAccess, requestSessionId);
      if (requestSessionId !== getAuthSessionSnapshot().id) {
        throw new AuthRefreshError("The authenticated session changed", false);
      }
      request.headers.Authorization = `Bearer ${refreshedAccess}`;
      return http(request);
    } catch (refreshError) {
      return Promise.reject(refreshError);
    }
  },
);
