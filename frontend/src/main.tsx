import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LangProvider } from "./i18n";
import ModelsPage from "./pages/models";
import EcoPage from "./pages/eco";
import AnalysisPage from "./pages/analysis";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useEffect } from "react";

const queryClient = new QueryClient();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <LangProvider>
    <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<App />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/eco" element={<EcoPage />} />
            <Route path="/analysis" element={<AnalysisPage />} />
          </Routes>
        </BrowserRouter>
    </QueryClientProvider>
    </LangProvider>
  </StrictMode>
);
