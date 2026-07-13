import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/domains/auth/auth-context";

type RequireAuthProps = {
  children: ReactNode;
};

export function RequireAuth({ children }: RequireAuthProps) {
  const location = useLocation();
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <div className="screen-state">세션을 확인하는 중입니다.</div>;
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    const loginSearch = new URLSearchParams({ returnTo });
    return <Navigate to={`/login?${loginSearch.toString()}`} replace state={{ from: returnTo }} />;
  }

  return <>{children}</>;
}
