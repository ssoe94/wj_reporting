import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { deriveCapabilities } from "@/domains/auth/capabilities";
import { fetchCurrentUser, requestLogin } from "@/domains/auth/auth-api";
import {
  clearTokens,
  getAccessToken,
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

function isTokenExpired(token: string) {
  try {
    const [, payload] = token.split(".");
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(window.atob(normalized));
    return typeof decoded.exp !== "number" || decoded.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

type AuthProviderProps = {
  children: ReactNode;
};

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function initialize() {
      const token = getAccessToken();
      if (!token || isTokenExpired(token)) {
        clearTokens();
        setIsLoading(false);
        return;
      }

      try {
        const currentUser = await fetchCurrentUser();
        setUser(currentUser);
      } catch {
        clearTokens();
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    }

    void initialize();
  }, []);

  async function login(username: string, password: string) {
    const tokens = await requestLogin({ username, password });
    setAccessToken(tokens.access);
    setRefreshToken(tokens.refresh);
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
