import React, { createContext, useContext, useState, useEffect } from 'react';
import api from '../lib/api';
import type { ReactNode } from 'react';

export interface UserPermissions {
  can_view_injection: boolean;
  can_edit_injection: boolean;
  can_view_machining: boolean;
  can_edit_machining: boolean;
  can_view_eco: boolean;
  can_edit_eco: boolean;
  can_view_inventory: boolean;
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
  isLoading: boolean;
  isAuthenticated: boolean;
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

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(sessionStorage.getItem('access_token'));
  const [isLoading, setIsLoading] = useState(true);

  // 토큰을 decode하여 exp 확인 (간단한 base64url decode)
  const isTokenExpired = (jwt: string): boolean => {
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
  };

  // 사용자 정보 가져오기
  const fetchUserInfo = async (): Promise<User | null> => {
    try {
      const response = await api.get('/user/me/');
      return response.data;
    } catch (error) {
      console.error('Failed to fetch user info:', error);
      return null;
    }
  };

  useEffect(() => {
    const initializeAuth = async () => {
      const storedToken = sessionStorage.getItem('access_token');
      if (storedToken && !isTokenExpired(storedToken)) {
        setToken(storedToken);
        // 사용자 정보 가져오기
        const userInfo = await fetchUserInfo();
        if (userInfo) {
          setUser(userInfo);
        } else {
          logout();
        }
      } else {
        logout();
      }
      setIsLoading(false);
    };

    initializeAuth();
  }, []);

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      const response = await api.post('/token/', { username, password });
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

      sessionStorage.setItem('access_token', access);
      sessionStorage.setItem('refresh_token', refresh);
      setToken(access);

      // 실제 사용자 정보 가져오기
      const userInfo = await fetchUserInfo();
      if (userInfo) {
        setUser(userInfo);
        return true;
      } else {
        logout();
        return false;
      }
    } catch (error) {
      console.error('Login error:', error);
      if (error instanceof Error) {
        console.error('Error message:', error.message);
      }
      return false;
    }
  };

  const logout = () => {
    sessionStorage.removeItem('access_token');
    sessionStorage.removeItem('refresh_token');
    setToken(null);
    setUser(null);
  };

  // 권한 확인 함수
  const hasPermission = (permission: keyof UserPermissions): boolean => {
    if (!user || !user.permissions) return false;
    return user.permissions[permission] || false;
  };

  // 라우트 접근 권한 확인
  const canAccessRoute = (route: string): boolean => {
    if (!user || !user.permissions) return false;

    // 스태프는 모든 권한
    if (user.is_staff) return true;

    // 해시/쿼리 제거하여 기본 경로만 검사
    const base = route.split('#')[0].split('?')[0];

    // 분석/루트는 모든 인증 사용자 허용
    if (base === '/' || base === '' || base === '/analysis') return true;

    // 관리자 전용 경로
    if (base.startsWith('/admin')) return false;

    // 섹션별 권한 매핑 (prefix 매칭)
    if (base.startsWith('/injection')) return hasPermission('can_view_injection');
    if (base.startsWith('/assembly')) return hasPermission('can_view_machining');
    // 품질 섹션은 가공 권한과 동일하게 접근 허용
    if (base.startsWith('/quality')) return hasPermission('can_view_machining');
    if (base.startsWith('/eco2') || base.startsWith('/eco') || base.startsWith('/models')) return hasPermission('can_view_eco');
    if (base.startsWith('/sales')) return hasPermission('can_view_inventory');

    return true;
  };

  const value: AuthContextType = {
    user,
    token,
    login,
    logout,
    isLoading,
    isAuthenticated: !!token,
    hasPermission,
    canAccessRoute,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}; 