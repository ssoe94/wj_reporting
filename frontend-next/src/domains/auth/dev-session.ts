import { getAccessToken } from "@/domains/auth/auth-storage";
import type { CurrentUser, TokenPair } from "@/domains/auth/types";

const DEV_LOGIN_USERNAME = "admin";
const DEV_LOGIN_PASSWORD = "admin123";
const DEV_TOKEN_MARKER = "wj-next-local";
const ENABLE_DEV_LOGIN = import.meta.env.VITE_ENABLE_DEV_LOGIN !== "false";

function base64UrlEncode(value: string) {
  return window.btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodePayload(token: string) {
  try {
    const [, payload] = token.split(".");
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(window.atob(normalized));
  } catch {
    return null;
  }
}

function createDevJwt(kind: "access" | "refresh") {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const exp = Math.floor(Date.now() / 1000) + (kind === "access" ? 60 * 60 * 8 : 60 * 60 * 24 * 30);
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: "dev-admin",
      name: DEV_LOGIN_USERNAME,
      env: DEV_TOKEN_MARKER,
      token_kind: kind,
      exp,
    }),
  );
  return `${header}.${payload}.local-preview`;
}

export function canUseDevLogin(payload: { username: string; password: string }) {
  return ENABLE_DEV_LOGIN &&
    import.meta.env.DEV &&
    payload.username === DEV_LOGIN_USERNAME &&
    payload.password === DEV_LOGIN_PASSWORD;
}

export function createDevTokenPair(): TokenPair {
  return {
    access: createDevJwt("access"),
    refresh: createDevJwt("refresh"),
  };
}

export function isDevSessionToken(token?: string | null) {
  if (!token) return false;
  const payload = decodePayload(token);
  return payload?.env === DEV_TOKEN_MARKER;
}

export function isDevSessionActive() {
  return isDevSessionToken(getAccessToken());
}

export function getDevCurrentUser(): CurrentUser {
  return {
    id: 1,
    username: DEV_LOGIN_USERNAME,
    email: "admin@local.preview",
    is_staff: true,
    groups: ["local-preview"],
    department: "Production",
    permissions: {
      can_view_injection: true,
      can_view_assembly: true,
      can_view_quality: true,
      can_view_sales: true,
      can_view_development: true,
      can_edit_injection: true,
      can_edit_assembly: true,
      can_edit_quality: true,
      can_edit_sales: true,
      can_edit_development: true,
      is_admin: true,
      can_edit_machining: true,
      can_edit_eco: true,
      can_edit_inventory: true,
    },
  };
}

export const devLoginHint = {
  username: DEV_LOGIN_USERNAME,
  password: DEV_LOGIN_PASSWORD,
};
