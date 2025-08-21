import React, { createContext, useContext, useState, useEffect } from 'react';
import api from '../lib/api';
import type { ReactNode } from 'react';

interface User {
  id: number;
  username: string;
  email: string;
  is_staff: boolean;
  groups: string[];
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  isLoading: boolean;
  isAuthenticated: boolean;
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
  const [token, setToken] = useState<string | null>(localStorage.getItem('access_token'));
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

  useEffect(() => {
    const initializeAuth = async () => {
      const storedToken = localStorage.getItem('access_token');
      if (storedToken && !isTokenExpired(storedToken)) {
        setToken(storedToken);
        // 필요한 경우, 사용자 정보 API 호출로 user 세팅
        // setUser(await fetchUserInfo());
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

      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      setToken(access);

      const userInfo: User = {
        id: 1,
        username,
        email: `${username}@example.com`,
        is_staff: username === 'admin',
        groups: username === 'admin' ? ['admin'] : ['editor'],
      };
      setUser(userInfo);
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
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    setToken(null);
    setUser(null);
  };

  const value: AuthContextType = {
    user,
    token,
    login,
    logout,
    isLoading,
    isAuthenticated: !!token,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}; 