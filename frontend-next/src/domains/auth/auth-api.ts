import axios from "axios";
import { http } from "@/shared/api/http";
import {
  canUseDevLogin,
  createDevTokenPair,
  getDevCurrentUser,
  isDevSessionActive,
} from "@/domains/auth/dev-session";
import type { CurrentUser, LoginPayload, TokenPair } from "@/domains/auth/types";

export type LoginFailureReason =
  | "invalidCredentials"
  | "network"
  | "server"
  | "unknown";

export class LoginRequestError extends Error {
  constructor(
    readonly reason: LoginFailureReason,
    readonly status?: number,
  ) {
    super("Login request failed");
    this.name = "LoginRequestError";
  }
}

export function getLoginFailureReason(error: unknown): LoginFailureReason {
  if (error instanceof LoginRequestError) {
    return error.reason;
  }

  if (!axios.isAxiosError(error)) {
    return "unknown";
  }

  if (!error.response) {
    return "network";
  }

  if (error.response.status === 401) {
    return "invalidCredentials";
  }

  if (error.response.status === 500 && !error.response.data) {
    return "network";
  }

  if (error.response.status >= 500) {
    return "server";
  }

  return "unknown";
}

export async function requestLogin(payload: LoginPayload) {
  if (canUseDevLogin(payload)) {
    return createDevTokenPair();
  }

  try {
    const response = await http.post<TokenPair>("/token/", payload, { skipAuth: true });
    return response.data;
  } catch (error) {
    throw new LoginRequestError(
      getLoginFailureReason(error),
      axios.isAxiosError(error) ? error.response?.status : undefined,
    );
  }
}

export async function fetchCurrentUser() {
  if (isDevSessionActive()) {
    return getDevCurrentUser();
  }
  const response = await http.get<CurrentUser>("/injection/user/me/");
  return response.data;
}
