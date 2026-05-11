import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/domains/auth/auth-context";
import type { AppCapability } from "@/domains/auth/types";

type RequireCapabilitiesProps = {
  capabilities: AppCapability[];
  children: ReactNode;
};

export function RequireCapabilities({
  capabilities,
  children,
}: RequireCapabilitiesProps) {
  const { hasCapability } = useAuth();
  const allowed = capabilities.every((capability) => hasCapability(capability));

  if (!allowed) {
    return <Navigate to="/analysis" replace />;
  }

  return <>{children}</>;
}
