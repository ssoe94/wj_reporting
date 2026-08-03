import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import axios from "axios";
import { deriveCapabilities } from "@/domains/auth/capabilities";
import { fetchCurrentUser, requestLogin } from "@/domains/auth/auth-api";
import {
  AuthRefreshError,
  isAccessTokenExpired,
  refreshAccessToken,
} from "@/domains/auth/auth-refresh";
import { getDevCurrentUser, isDevSessionToken } from "@/domains/auth/dev-session";
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from "@/domains/auth/auth-storage";
import type { AppCapability, CurrentUser } from "@/domains/auth/types";

type AuthContextValue = {
  user: CurrentUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  capabilities: AppCapability[];
  hasCapability: (capability: AppCapability) => boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function isDefinitiveAuthFailure(error: unknown) {
  if (error instanceof AuthRefreshError) {
    return error.isDefinitive;
  }

  if (!axios.isAxiosError(error)) {
    return false;
  }

  return error.response?.status === 401 || error.response?.status === 403;
}

function clearRejectedSessionIfCurrent(error: unknown) {
  // The refresh helper already clears only when the rejected refresh token is
  // still current. Clearing again here could erase a newer pair from another tab.
  if (error instanceof AuthRefreshError || !axios.isAxiosError(error)) {
    return;
  }

  const authorization = error.config?.headers?.Authorization;
  const rejectedAccess = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
  if (!rejectedAccess || getAccessToken() === rejectedAccess) {
    clearTokens();
  }
}

type AuthProviderProps = {
  children: ReactNode;
};

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isActive = true;
    let retryTimer: number | undefined;

    async function initialize() {
      const token = getAccessToken();
      const refresh = getRefreshToken();
      if (!token && !refresh) {
        if (!isActive) return;
        setUser(null);
        setIsLoading(false);
        return;
      }

      if (isDevSessionToken(token)) {
        if (!isActive) return;
        setUser(getDevCurrentUser());
        setIsLoading(false);
        return;
      }

      try {
        if (!token || isAccessTokenExpired(token)) {
          await refreshAccessToken(token);
        }
        const currentUser = await fetchCurrentUser();
        if (!isActive) return;
        setUser(currentUser);
        setIsLoading(false);
      } catch (error) {
        if (!isActive) return;
        if (isDevSessionToken(getAccessToken())) {
          setUser(getDevCurrentUser());
          setIsLoading(false);
        } else if (
          isDefinitiveAuthFailure(error) ||
          (!getAccessToken() && !getRefreshToken())
        ) {
          clearRejectedSessionIfCurrent(error);
          setUser(null);
          setIsLoading(false);
        } else {
          // Render may briefly return a network/5xx response while a service is
          // deploying. Keep the stored session and retry without sending the board
          // to the login page.
          setIsLoading(true);
          retryTimer = window.setTimeout(() => void initialize(), 5_000);
        }
      }
    }

    void initialize();

    return () => {
      isActive = false;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  async function login(username: string, password: string) {
    const tokens = await requestLogin({ username, password });
    setRefreshToken(tokens.refresh);
    setAccessToken(tokens.access);
    const currentUser = await fetchCurrentUser();
    setUser(currentUser);
  }

  function logout() {
    clearTokens();
    setUser(null);
  }

  const capabilities = deriveCapabilities(user);

  const value: AuthContextValue = {
    user,
    isLoading,
    isAuthenticated: Boolean(user && getAccessToken()),
    capabilities,
    hasCapability: (capability) => capabilities.includes(capability),
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return value;
}
