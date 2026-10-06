import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import type { ReactNode } from 'react';
import { parseFieldTerminalUser } from '../lib/fieldTerminal';
import { canManageDevelopmentTasks, isDevelopmentTaskRoute } from '../domains/auth/development-task-access';
import { canUseInspectionBeta, isInspectionBetaRoute, parseInspectionAccess } from '../domains/auth/inspection-beta-access';
import type { InspectionAccess } from '../domains/auth/inspection-beta-access';
import { AuthRefreshError, refreshAccessToken } from '../domains/auth/auth-refresh';
import { finishServerLogout } from '../domains/auth/server-logout';
import { beginAuthSessionEnd, createLoginAttemptGate } from '../domains/auth/auth-transition';
import { commitAuthSession } from '../domains/auth/auth-commit';
import {
  getAuthSessionSnapshot,
  getAuthSessionGeneration,
  invalidateAuthSession,
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
  is_superuser?: boolean;
  groups: string[];
  department?: string;
  is_using_temp_password?: boolean;
  password_reset_required?: boolean;
  permissions?: UserPermissions;
}

interface AuthContextType {
  user: User | null;
  authSessionId: string | null;
  canAccessInspection: boolean;
  token: string | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<boolean>;
  isLoggingOut: boolean;
  logoutError: boolean;
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

async function fetchUserInfo(sessionId: string): Promise<User> {
  if (getAuthSessionSnapshot().id !== sessionId) throw new Error('Authentication session changed');
  const response = await api.get('/injection/user/me/', { authSessionId: sessionId });
  if (getAuthSessionSnapshot().id !== sessionId) throw new Error('Authentication session changed');
  return response.data;
}

function isDefinitiveIdentityError(error: unknown) {
  if (error instanceof AuthRefreshError) return error.isDefinitive;
  if (!axios.isAxiosError<{ code?: unknown }>(error)) {
    return false;
  }
  if (
    error.response?.status === 403
    && String(error.response.data?.code || '') === 'user_profile_required'
  ) {
    return true;
  }
  if (error.response?.status !== 401) return false;
  return new Set(['token_not_valid', 'user_not_found', 'user_inactive', 'password_changed'])
    .has(String(error.response.data?.code || ''));
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const queryClient = useQueryClient();
  const initialSessionRef = useRef(getAuthSessionSnapshot());
  const [identity, setIdentity] = useState<{ sessionId: string; user: User } | null>(null);
  const [inspectionAccess, setInspectionAccess] = useState<{ sessionId: string; value: InspectionAccess } | null>(null);
  const user = identity?.sessionId === getAuthSessionSnapshot().id ? identity?.user ?? null : null;
  const [token, setToken] = useState<string | null>(initialSessionRef.current.access);
  const [isLoading, setIsLoading] = useState(true);
  const [authRecoveryError, setAuthRecoveryError] = useState<string | null>(null);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const logoutInFlight = useRef<{ sessionId: string | null; promise: Promise<boolean> } | null>(null);
  const sessionIdRef = useRef<string | null>(initialSessionRef.current.id);
  const loginGate = useRef(createLoginAttemptGate(() => getAuthSessionSnapshot().id, getAuthSessionGeneration));

  useEffect(() => {
    const gate = loginGate.current;
    return () => { gate.invalidate(); };
  }, []);

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
    loginGate.current.invalidate();
    void queryClient.cancelQueries();
    queryClient.clear();
    setToken(session.access);
    sessionIdRef.current = session.id;
    setIdentity(null);
    setInspectionAccess(null);
    setAuthRecoveryError(null);
    setLogoutError(false);
    if (logoutInFlight.current?.sessionId !== session.id) setIsLoggingOut(false);
    setIsLoading(true);
    setSessionRevision((current) => current + 1);
  }, true), [queryClient]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;

    const retainSessionAndRetry = (_error: unknown, expectedSessionId: string | null) => {
      if (cancelled) return;
      const currentSession = getAuthSessionSnapshot();
      if (currentSession.id !== expectedSessionId) return;
      console.error('Authentication temporarily unavailable');
      setToken(currentSession.access);
      setIdentity(null);
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
      const isCurrent = () => !cancelled && getAuthSessionSnapshot().id === sessionAtStart;

      const clearSessionIfCurrent = () => {
        if (!isCurrent()) return;
        // The immediate storage subscriber reads whichever session is current;
        // a late failure for A must not manually clear B's React state.
        invalidateAuthSession(sessionAtStart);
      };

      if (!activeToken && !storedRefresh) {
        if (isCurrent()) {
          setToken(null);
          setIdentity(null);
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

      if (!isCurrent()) return;
      if (sessionAtStart && activeToken && !isTokenExpired(activeToken)) {
        try {
          const userInfo = import.meta.env.DEV && isDevSessionToken(activeToken)
            ? getDevCurrentUser() as User
            : await fetchUserInfo(sessionAtStart);
          if (!isCurrent()) return;
          let access: InspectionAccess | null = null;
          try {
            const response = await api.get('/quality/inspection-requests/capabilities/', { authSessionId: sessionAtStart });
            if (isCurrent()) access = parseInspectionAccess(response.data);
          } catch { /* Capabilities are optional to login, but inspection access defaults to denied. */ }
          if (!isCurrent()) return;
          setToken(getAuthSessionSnapshot().access);
          setIdentity({ sessionId: sessionAtStart, user: userInfo });
          setInspectionAccess(access ? { sessionId: sessionAtStart, value: access } : null);
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
    // Visiting /login directly must not bypass server revocation or a pending
    // inspection guard. A failed/blocked logout leaves the existing draft intact.
    if (getAuthSessionSnapshot().id && !await logout()) return false;
    if (getAuthSessionSnapshot().id) return false;
    const attempt = loginGate.current.begin();
    if (canUseDevLogin({ username, password })) {
      const { access, refresh } = createDevTokenPair();
      try { return Boolean(await commitAuthSession(access, refresh, () => loginGate.current.isCurrent(attempt))); }
      catch { return false; }
    }

    try {
      const response = await api.post('/token/', { username, password }, { skipAuth: true });
      
      // 응답이 있는지 확인
      if (!response || !response.data) {
        console.error('No response data received');
        return false;
      }
      
      const { access, refresh } = response.data;
      if (!access || !refresh) {
        console.error('Missing tokens in login response');
        return false;
      }

      return Boolean(await commitAuthSession(access, refresh, () => loginGate.current.isCurrent(attempt)));
    } catch {
      console.error('Login failed');
      return false;
    }
  };

  const logout = (): Promise<boolean> => {
    const snapshot = getAuthSessionSnapshot();
    if (logoutInFlight.current?.sessionId === snapshot.id) return logoutInFlight.current.promise;
    loginGate.current.invalidate();
    const releaseSession = beginAuthSessionEnd(snapshot.id);
    if (!releaseSession) return Promise.resolve(false);
    setIsLoggingOut(true);
    setLogoutError(false);
    const operation = finishServerLogout(snapshot.id, {
      currentSessionId: () => getAuthSessionSnapshot().id,
      revoke: async () => {
        const response = await api.post('/mes-connection/logout/',
          snapshot.refresh ? { refresh: snapshot.refresh } : {},
          { skipAuthRefresh: true, authSessionId: snapshot.id });
        return response.data;
      },
      invalidateLocal: invalidateAuthSession,
    }).then((success) => {
      if (!success && getAuthSessionSnapshot().id === snapshot.id) setLogoutError(true);
      return success;
    }).finally(() => {
      releaseSession();
      if (logoutInFlight.current?.promise === operation) {
        logoutInFlight.current = null;
        setIsLoggingOut(false);
      }
    });
    logoutInFlight.current = { sessionId: snapshot.id, promise: operation };
    return operation;
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
  const canAccessInspection = canUseInspectionBeta(user,
    inspectionAccess?.sessionId === identity?.sessionId ? inspectionAccess?.value ?? null : null);
  const canAccessRoute = (route: string): boolean => {
    if (!user) return false;
    if (isInspectionBetaRoute(route)) return canAccessInspection;
    if (isDevelopmentTaskRoute(route)) return canManageDevelopmentTasks(user);
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
    authSessionId: user ? identity!.sessionId : null,
    canAccessInspection,
    token,
    login,
    logout,
    isLoggingOut,
    logoutError,
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
