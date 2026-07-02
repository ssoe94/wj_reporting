import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
} from "@/domains/auth/auth-storage";
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

    const access = getAccessToken();
    if (isDevSessionToken(access)) {
      return Promise.reject(error);
    }

    const refresh = getRefreshToken();
    if (!refresh) {
      clearTokens();
      return Promise.reject(error);
    }

    if (isDevSessionToken(refresh)) {
      return Promise.reject(error);
    }

    request._retry = true;

    try {
      const response = await axios.post(`${API_BASE_URL}/token/refresh/`, { refresh });
      const access = response.data?.access as string | undefined;

      if (!access) {
        clearTokens();
        return Promise.reject(error);
      }

      setAccessToken(access);
      request.headers.Authorization = `Bearer ${access}`;
      return http(request);
    } catch (refreshError) {
      clearTokens();
      return Promise.reject(refreshError);
    }
  },
);
