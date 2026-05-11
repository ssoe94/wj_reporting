import { http } from "@/shared/api/http";
import {
  canUseDevLogin,
  createDevTokenPair,
  getDevCurrentUser,
  isDevSessionActive,
} from "@/domains/auth/dev-session";
import type { CurrentUser, LoginPayload, TokenPair } from "@/domains/auth/types";

export async function requestLogin(payload: LoginPayload) {
  if (canUseDevLogin(payload)) {
    return createDevTokenPair();
  }
  const response = await http.post<TokenPair>("/token/", payload);
  return response.data;
}

export async function fetchCurrentUser() {
  if (isDevSessionActive()) {
    return getDevCurrentUser();
  }
  const response = await http.get<CurrentUser>("/injection/user/me/");
  return response.data;
}
