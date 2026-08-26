import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import type { ReactNode } from 'react';
import { parseFieldTerminalUser } from '../lib/fieldTerminal';
import { AuthRefreshError, refreshAccessToken } from '../domains/auth/auth-refresh';
import {
  clearTokens,
  getAuthSessionSnapshot,
  invalidateAuthSession,
  startAuthSession,
  subscribeToAuthStorage,
} from '../domains/auth/auth-storage';
import {
  canUseDevLogin,
  createDevTokenPair,
  getDevCurrentUser,
  isDevSessionToken,
} from '../domains/auth/dev-session';

export interface UserPermissions {
  // 조회 권한 (기본적으로 모든 사용자에게 부여)
  can_view_injection: boolean;
  can_view_assembly: boolean;
  can_view_quality: boolean;
  can_view_sales: boolean;
  can_view_development: boolean;

  // 편집 권한 (선택적으로 부여)
  can_edit_injection: boolean;
  can_edit_assembly: boolean;
  can_edit_quality: boolean;
  can_edit_sales: boolean;
  can_edit_development: boolean;
  can_confirm_moulds: boolean;

  // 관리자 권한
  is_admin: boolean;

  // 호환성을 위한 레거시 필드들
  can_edit_machining: boolean;
  can_edit_eco: boolean;
  can_edit_inventory: boolean;
}

interface User {
  id: number;
  username: string;
  email: string;
  is_staff: boolean;
  groups: string[];
  department?: string;
  is_using_temp_password?: boolean;
  password_reset_required?: boolean;
  permissions?: UserPermissions;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  retryAuth: () => void;
  isLoading: boolean;
  isAuthenticated: boolean;
  authRecoveryError: string | null;
  hasPermission: (permission: keyof UserPermissions) => boolean;
  canAccessRoute: (route: string) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

const AUTH_RETRY_DELAY_MS = 5_000;

function isTokenExpired(jwt: string): boolean {
  try {
    const [, payload] = jwt.split('.');
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(base64));
    if (decoded.exp && typeof decoded.exp === 'number') {
      return decoded.exp * 1000 < Date.now();
    }
    return true;
  } catch {
    return true;
  }
}

async function fetchUserInfo(): Promise<User> {
  const response = await api.get('/injection/user/me/');
  return response.data;
}

function isDefinitiveIdentityError(error: unknown) {
  if (error instanceof AuthRefreshError) return error.isDefinitive;
  if (!axios.isAxiosError<{ code?: unknown }>(error) || error.response?.status !== 401) {
    return false;
  }
  return new Set(['token_not_valid', 'user_not_found', 'user_inactive', 'password_changed'])
    .has(String(error.response.data?.code || ''));
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const queryClient = useQueryClient();
  const initialSessionRef = useRef(getAuthSessionSnapshot());
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(initialSessionRef.current.access);
  const [isLoading, setIsLoading] = useState(true);
  const [authRecoveryError, setAuthRecoveryError] = useState<string | null>(null);
  const [sessionRevision, setSessionRevision] = useState(0);
  const sessionIdRef = useRef<string | null>(initialSessionRef.current.id);

  useEffect(() => subscribeToAuthStorage(() => {
    const session = getAuthSessionSnapshot();
    if (session.id && session.id === sessionIdRef.current) {
      // Same-session access-token rotation must not unmount protected pages or
      // discard unsaved form state. API retries already use the new token.
      setToken(session.access);
      return;
    }
    // Cached server data belongs to the authenticated principal that fetched
    // it. Remove it synchronously before a different account can render.
    void queryClient.cancelQueries();
    queryClient.clear();
    setToken(session.access);
    sessionIdRef.current = session.id;
    setUser(null);
    setAuthRecoveryError(null);
    setIsLoading(true);
    setSessionRevision((current) => current + 1);
  }), [queryClient]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;

    const retainSessionAndRetry = (error: unknown, expectedSessionId: string | null) => {
      if (cancelled) return;
      const currentSession = getAuthSessionSnapshot();
      if (currentSession.id !== expectedSessionId) return;
      console.error('Authentication temporarily unavailable:', error);
      setToken(currentSession.access);
      setUser(null);
      setAuthRecoveryError('서버 연결이 불안정합니다. 로그인 정보는 유지되며 자동으로 다시 연결합니다.');
      setIsLoading(false);
      retryTimer = window.setTimeout(() => {
        setSessionRevision((current) => current + 1);
      }, AUTH_RETRY_DELAY_MS);
    };

    const initializeAuth = async () => {
      if (!cancelled) {
        setIsLoading(true);
      }

      const sessionAtStartSnapshot = getAuthSessionSnapshot();
      let activeToken = sessionAtStartSnapshot.access;
      const storedRefresh = sessionAtStartSnapshot.refresh;
      const sessionAtStart = sessionAtStartSnapshot.id;

      const clearSessionIfCurrent = () => {
        if (cancelled || !invalidateAuthSession(sessionAtStart)) return;
        setToken(null);
        setUser(null);
        setAuthRecoveryError(null);
        setIsLoading(false);
      };

      if (!activeToken && !storedRefresh) {
        if (!cancelled) {
          setToken(null);
          setUser(null);
          setAuthRecoveryError(null);
          setIsLoading(false);
        }
        return;
      }

      if ((!activeToken || isTokenExpired(activeToken)) && storedRefresh) {
        try {
          activeToken = await refreshAccessToken(activeToken, sessionAtStart);
        } catch (error) {
          if (isDefinitiveIdentityError(error)) {
            clearSessionIfCurrent();
          } else {
            retainSessionAndRetry(error, sessionAtStart);
          }
          return;
        }
      }

      if (activeToken && !isTokenExpired(activeToken)) {
        try {
          const userInfo = import.meta.env.DEV && isDevSessionToken(activeToken)
            ? getDevCurrentUser() as User
            : await fetchUserInfo();
          if (cancelled) return;
          setToken(activeToken);
          setUser(userInfo);
          setAuthRecoveryError(null);
          setIsLoading(false);
        } catch (error) {
          if (isDefinitiveIdentityError(error)) {
            clearSessionIfCurrent();
          } else {
            retainSessionAndRetry(error, sessionAtStart);
          }
        }
      } else {
        clearSessionIfCurrent();
      }
    };

    void initializeAuth();
    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [sessionRevision]);

  const login = async (username: string, password: string): Promise<boolean> => {
    if (canUseDevLogin({ username, password })) {
      const { access, refresh } = createDevTokenPair();
      startAuthSession(access, refresh);
      setToken(access);
      setUser(null);
      setAuthRecoveryError(null);
      setIsLoading(true);
      return true;
    }

    try {
      const response = await api.post('/token/', { username, password }, { skipAuth: true });
      console.log('Login response:', response);
      
      // 응답이 있는지 확인
      if (!response || !response.data) {
        console.error('No response data received');
        return false;
      }
      
      const { access, refresh } = response.data;
      if (!access || !refresh) {
        console.error('Missing tokens in response:', response.data);
        return false;
      }

      startAuthSession(access, refresh);
      setToken(access);
      setUser(null);
      setAuthRecoveryError(null);
      setIsLoading(true);
      return true;
    } catch (error) {
      console.error('Login error:', error);
      if (error instanceof Error) {
        console.error('Error message:', error.message);
      }
      return false;
    }
  };

  const logout = () => {
    void queryClient.cancelQueries();
    queryClient.clear();
    clearTokens();
    setToken(null);
    setUser(null);
    setAuthRecoveryError(null);
    setIsLoading(false);
  };

  const retryAuth = () => {
    setSessionRevision((current) => current + 1);
  };

  // 권한 확인 함수
  const hasPermission = (permission: keyof UserPermissions): boolean => {
    if (!user || !user.permissions) return false;
    return Boolean(user.permissions[permission]);
  };

  // 라우트 접근 권한 확인
  const canAccessRoute = (route: string): boolean => {
    if (!user) return false;
    if (user.is_staff || hasPermission('is_admin')) return true;

    const base = route.split('#')[0].split('?')[0];
    const fieldTerminalUser = parseFieldTerminalUser(user.username);
    if (fieldTerminalUser) {
      return base === '/field' || base.startsWith('/field/');
    }

    if (base === '/' || base === '' || base === '/analysis') return true;

    if (base.startsWith('/admin')) return false;

    if (base.startsWith('/development/field-materials')) {
      return hasPermission('can_view_development');
    }

    if (base.startsWith('/injection')) return true;
    if (base.startsWith('/assembly')) return true;
    if (base.startsWith('/quality')) return hasPermission('can_view_quality');
    if (base.startsWith('/sales')) return true;
    if (base.startsWith('/eco2') || base.startsWith('/eco') || base.startsWith('/models')) return true;

    return true;
  };

  const value: AuthContextType = {
    user,
    token,
    login,
    logout,
    retryAuth,
    isLoading,
    isAuthenticated: !!token,
    authRecoveryError,
    hasPermission,
    canAccessRoute,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}; 
