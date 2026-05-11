const ACCESS_TOKEN_KEY = "wj_next_access_token";
const REFRESH_TOKEN_KEY = "wj_next_refresh_token";

export function getAccessToken() {
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setAccessToken(value: string) {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, value);
}

export function getRefreshToken() {
  return window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setRefreshToken(value: string) {
  window.localStorage.setItem(REFRESH_TOKEN_KEY, value);
}

export function clearTokens() {
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
}
