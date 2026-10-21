import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { parseFieldTerminalUser } from '../lib/fieldTerminal';

interface PrivateRouteProps {
  children: React.ReactNode;
}

export default function PrivateRoute({ children }: PrivateRouteProps) {
  const {
    isAuthenticated,
    isLoading,
    authRecoveryError,
    retryAuth,
    canAccessRoute,
    user,
  } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-[var(--wj-accent)]"></div>
      </div>
    );
  }

  if (authRecoveryError || (isAuthenticated && !user)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--wj-surface-solid)] px-6">
        <div className="max-w-md rounded-2xl border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-[var(--wj-text)]">서버에 다시 연결하고 있습니다</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--wj-muted)]">
            {authRecoveryError || '로그인 정보는 유지되고 있습니다. 잠시 후 다시 시도해 주세요.'}
          </p>
          <button
            type="button"
            onClick={retryAuth}
            className="mt-5 rounded-lg bg-[var(--wj-accent-strong)] px-4 py-2 text-sm font-semibold text-[var(--wj-on-accent)] hover:bg-[var(--wj-accent-strong)]"
          >
            지금 다시 연결
          </button>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // 경로별 권한 검사: 접근 불가 시 대시보드로 이동
  if (!canAccessRoute(location.pathname)) {
    return <Navigate to={parseFieldTerminalUser(user?.username) ? '/field' : '/analysis'} replace />;
  }

  return <>{children}</>;
} 
