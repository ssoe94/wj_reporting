import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/app/layout/AppShell";
import { AnalysisPage } from "@/domains/analysis/pages/AnalysisPage";
import { RequireAuth } from "@/domains/auth/RequireAuth";
import { RequireCapabilities } from "@/domains/auth/RequireCapabilities";
import { LoginPage } from "@/domains/auth/pages/LoginPage";
import { InventoryPage } from "@/domains/inventory/pages/InventoryPage";
import { MesMonitoringPage } from "@/domains/mes/pages/MesMonitoringPage";
import { ProductionDashboardPage } from "@/domains/production/pages/ProductionDashboardPage";
import { ProductionPlansPage } from "@/domains/production/pages/ProductionPlansPage";

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/production" replace />} />
        <Route
          path="analysis"
          element={
            <RequireCapabilities capabilities={["analysis.read"]}>
              <AnalysisPage />
            </RequireCapabilities>
          }
        />
        <Route
          path="production"
          element={
            <RequireCapabilities capabilities={["production.read"]}>
              <ProductionDashboardPage />
            </RequireCapabilities>
          }
        />
        <Route
          path="mes/monitoring"
          element={
            <RequireCapabilities capabilities={["production.read"]}>
              <MesMonitoringPage />
            </RequireCapabilities>
          }
        />
        <Route
          path="production/plans"
          element={
            <RequireCapabilities capabilities={["production.read"]}>
              <ProductionPlansPage />
            </RequireCapabilities>
          }
        />
        <Route
          path="inventory"
          element={
            <RequireCapabilities capabilities={["inventory.read"]}>
              <InventoryPage />
            </RequireCapabilities>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
