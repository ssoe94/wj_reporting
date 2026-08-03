import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { refreshAccessToken } from "@/domains/auth/auth-refresh";
import { getAccessToken } from "@/domains/auth/auth-storage";
import { isDevSessionToken } from "@/domains/auth/dev-session";

const API_BASE_URL = import.meta.env.PROD
  ? "/api"
  : (import.meta.env.VITE_API_BASE_URL || "/api");

type RetriableRequest = InternalAxiosRequestConfig & {
  _retry?: boolean;
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
  if (config.skipAuth) {
    return config;
  }

  const token = getAccessToken();
  if (token && !isDevSessionToken(token)) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const request = error.config as RetriableRequest | undefined;
    if (!request || request.skipAuth || error.response?.status !== 401 || request._retry) {
      return Promise.reject(error);
    }

    const authorization = request.headers.Authorization;
    const failedAccess = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : getAccessToken();
    if (isDevSessionToken(failedAccess)) {
      return Promise.reject(error);
    }

    request._retry = true;

    try {
      const refreshedAccess = await refreshAccessToken(failedAccess);
      request.headers.Authorization = `Bearer ${refreshedAccess}`;
      return http(request);
    } catch (refreshError) {
      return Promise.reject(refreshError);
    }
  },
);
