import { useEffect } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "@/app/layout/AppShell";
import { AnalysisPage } from "@/domains/analysis/pages/AnalysisPage";
import { RequireAuth } from "@/domains/auth/RequireAuth";
import { RequireCapabilities } from "@/domains/auth/RequireCapabilities";
import { LoginPage } from "@/domains/auth/pages/LoginPage";
import { InventoryPage } from "@/domains/inventory/pages/InventoryPage";
import { MesMonitoringPage } from "@/domains/mes/pages/MesMonitoringPage";
import { InjectionBoardPage } from "@/domains/production/pages/InjectionBoardPage";
import { ProductionDashboardPage } from "@/domains/production/pages/ProductionDashboardPage";
import { ProductionPlansPage } from "@/domains/production/pages/ProductionPlansPage";

function useIsEmbedded() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  return params.get("embed") === "1";
}

function EmbeddedLayout() {
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const frameId = params.get("frameId") ?? "";

    function getDocumentHeight() {
      return Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        document.documentElement.offsetHeight,
        document.body.offsetHeight,
      );
    }

    function postHeight() {
      window.parent.postMessage({
        type: "wj-next-embed-height",
        frameId,
        height: getDocumentHeight(),
      }, window.location.origin);
    }

    document.documentElement.classList.add("is-embedded-next");
    postHeight();

    const resizeObserver = new ResizeObserver(postHeight);
    resizeObserver.observe(document.documentElement);
    resizeObserver.observe(document.body);
    window.addEventListener("load", postHeight);
    window.addEventListener("resize", postHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("load", postHeight);
      window.removeEventListener("resize", postHeight);
      document.documentElement.classList.remove("is-embedded-next");
    };
  }, [location.search]);

  return (
    <main className="embedded-app__main">
      <Outlet />
    </main>
  );
}

function AuthenticatedLayout() {
  const isEmbedded = useIsEmbedded();
  return isEmbedded ? <EmbeddedLayout /> : <AppShell />;
}

function QueryViewPage() {
  const location = useLocation();
  const view = new URLSearchParams(location.search).get("view");

  if (view === "production") {
    return <ProductionDashboardPage />;
  }

  if (view === "mes-monitoring") {
    return <MesMonitoringPage />;
  }

  return <Navigate to="/production" replace />;
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/production/injection-board"
        element={
          <RequireAuth>
            <InjectionBoardPage />
          </RequireAuth>
        }
      />
      <Route
        path="/"
        element={
          <RequireAuth>
            <AuthenticatedLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/production" replace />} />
        <Route path="index.html" element={<QueryViewPage />} />
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
          element={<ProductionDashboardPage />}
        />
        <Route
          path="mes/monitoring"
          element={<MesMonitoringPage />}
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
