import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LangProvider } from "./i18n";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { useLang } from "./i18n";
import { Button } from "./components/ui/button";
import { Menu as MenuIcon, X as XIcon, Home as HomeIcon, ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import {
  ClipboardList,
  PlusSquare,
  PackageSearch,
  ClipboardCheck,
  Monitor,
  Wrench,
  PenTool as DraftingIcon,
  Truck,
  FileChartPie,
  ChartPie,
  ChartNoAxesCombined,
  Boxes,
} from "lucide-react";
// 실제 Summary 페이지 컴포넌트
import SummaryPage from "./pages/summary";
// 실제 페이지 컴포넌트 임포트
import ModelsPage from './pages/models';
import EcoPage from './pages/eco';
import AnalysisPage from './pages/analysis';
import AssemblyPage from './pages/assembly';
import SalesInventoryPage from './pages/sales/Inventory';
import OverviewPage from './pages/overview';
import LoginPage from './pages/LoginPage';
import PrivateRoute from './components/PrivateRoute';
import InventoryStatusPage from './pages/sales/InventoryStatus';
import DailyReportPage from './pages/sales/DailyReport';
import UserApproval from './pages/admin/UserApproval';

const queryClient = new QueryClient();

// navItems를 함수로 생성 (언어별)
export function useNavItems() {
  const { t } = useLang();
  
  return [
    {
      label: t('nav_overview'),
      icon: FileChartPie,
      children: [
        { to: "/analysis", label: t('nav_dashboard'), icon: ChartPie },
      ],
    },
    {
      label: t('nav_injection'),
      icon: Monitor,
      children: [
        { to: "/injection#top", label: t('nav_injection_summary'), icon: ChartNoAxesCombined },
        { to: "/injection#records", label: t('nav_injection_records'), icon: ClipboardList },
        { to: "/injection#new", label: t('nav_injection_new'), icon: PlusSquare },
      ],
    },
    {
      label: t('nav_machining'),
      icon: Wrench,
      children: [
        { to: "/assembly#top", label: t('nav_machining_summary'), icon: ChartNoAxesCombined },
        { to: "/assembly#records", label: t('nav_machining_records'), icon: ClipboardList },
        { to: "/assembly#new", label: t('nav_machining_new'), icon: PlusSquare },
      ],
    },
    {
      label: t('nav_sales'),
      icon: Truck,
      children: [
        { to: "/sales/inventory", label: t('nav_inventory_analysis'), icon: PackageSearch },
        { to: "/sales/daily-report", label: t('nav_daily_report'), icon: ClipboardList },
        { to: "/sales/inventory-status", label: t('nav_inventory_status'), icon: Boxes },
      ],
    },
    {
      label: t('nav_development'),
      icon: DraftingIcon,
      children: [
        { to: "/eco", label: t('nav_eco_management'), icon: ClipboardCheck },
        { to: "/models", label: t('nav_model_management'), icon: PackageSearch },
      ],
    },
    {
      label: '관리자',
      icon: Monitor,
      children: [
        { to: "/admin/user-approval", label: '가입 승인', icon: ClipboardCheck },
      ],
    },
  ];
}

function AppContent() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [isLiteMode, setIsLiteMode] = useState(() => 
    typeof window !== 'undefined' && localStorage.getItem('lite') === '1'
  );
  const { lang, setLang, t } = useLang();
  const { user, logout, isAuthenticated, isLoading } = useAuth();
  const routerLocation = useLocation();
  
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  
  // 라이트 모드 적용
  useEffect(() => {
    if (isLiteMode) {
      document.documentElement.classList.add('lite-mode');
    } else {
      document.documentElement.classList.remove('lite-mode');
    }
  }, [isLiteMode]);
  
  const toggleLiteMode = () => {
    const newLiteMode = !isLiteMode;
    setIsLiteMode(newLiteMode);
    if (newLiteMode) {
      localStorage.setItem('lite', '1');
    } else {
      localStorage.removeItem('lite');
    }
  };
  
  // 드롭다운 외부 클릭 시 닫기
  useEffect(() => {
    const handleClickOutside = () => {
      if (userDropdownOpen) {
        setUserDropdownOpen(false);
      }
    };
    
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [userDropdownOpen]);
  
  const navItems = useNavItems();
  const pathname = routerLocation.pathname;
  let breadcrumbLabel = t('brand');
  if (pathname.startsWith('/assembly')) breadcrumbLabel = t('brand_machining');
  else if (pathname.startsWith('/injection')) breadcrumbLabel = t('brand');
  else if (pathname.startsWith('/analysis')) breadcrumbLabel = t('nav_dashboard');
  else if (pathname.startsWith('/sales')) breadcrumbLabel = t('nav_sales');
  else if (pathname.startsWith('/eco')) breadcrumbLabel = t('nav_eco_management');
  else if (pathname.startsWith('/models')) breadcrumbLabel = t('nav_model_management');

  // 인증 로딩 중 스피너 표시
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // 인증되지 않았고 /login 이 아니라면 로그인 페이지로 이동
  if (!isAuthenticated && routerLocation.pathname !== "/login") {
    return <Navigate to="/login" state={{ from: routerLocation }} replace />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      {isAuthenticated && (
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur shadow-xs md:hidden">
        <div className="flex items-center justify-between px-4 py-2">
          <Link to="/" className="flex items-center">
            <img src="/logo.jpg" alt="logo" className="h-8 w-8 rounded-full" />
          </Link>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded border border-gray-300 bg-white">
              <button
                onClick={() => setLang('ko')}
                className={`px-2 py-0.5 text-xs font-medium transition-colors ${
                  lang === 'ko'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                KOR
              </button>
              <button
                onClick={() => setLang('zh')}
                className={`px-2 py-0.5 text-xs font-medium transition-colors ${
                  lang === 'zh'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                中文
              </button>
            </div>
            {user && (
              <Button variant="ghost" size="sm" onClick={logout}>
                {t('logout')}
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)}>
              <MenuIcon className="h-6 w-6" />
            </Button>
          </div>
        </div>
      </header>
      )}

      {/* Breadcrumb */}
      {isAuthenticated && (
      <div className="sticky top-14 md:top-0 z-10 bg-white/80 backdrop-blur border-b border-gray-200 h-14 px-4 flex items-center gap-2 md:ml-56">
        <Link to="/">
          <HomeIcon className="w-4 h-4 text-gray-500" />
        </Link>
        <ChevronRight className="w-4 h-4 text-gray-400" />
        <span className="text-sm font-medium text-gray-700">{breadcrumbLabel}</span>
        {user && (
          <div className="ml-auto relative">
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setUserDropdownOpen(!userDropdownOpen);
              }}
              className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
            >
              {user.username} ({user.groups.join(', ')})
              <span className={`text-xs transition-transform ${userDropdownOpen ? 'rotate-180' : ''}`}>▼</span>
            </button>
            {userDropdownOpen && (
              <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-50 min-w-[120px]">
                <button
                  onClick={() => {
                    logout();
                    setUserDropdownOpen(false);
                  }}
                  className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  {t('logout')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* Sidebar (Desktop) */}
      {isAuthenticated && (
      <aside className="fixed left-0 top-0 hidden h-screen w-56 overflow-y-auto border-r border-gray-200 bg-white shadow-md md:flex flex-col">
        {/* Top logo/title */}
        <div className="h-14 flex items-center justify-center gap-2 px-4 border-b border-gray-200">
          <Link to="/" className="flex items-center gap-2">
            <img src="/logo.jpg" alt="logo" className="h-8 w-8 rounded-full" />
            <span className="font-semibold text-blue-700">{t('brand')}</span>
          </Link>
        </div>
        {/* Menu */}
        <nav className="flex-1 py-4 px-2 flex flex-col gap-1">
          {navItems.map((group) => {
            const GroupIcon = group.icon as any;
            return (
              <div key={group.label} className="mb-2">
                <div className="px-3 py-2 flex items-center gap-2 text-lg font-semibold text-gray-500 uppercase">
                  {GroupIcon && <GroupIcon className="w-4 h-4" />} {group.label}
                </div>
                {group.children.map((child) => {
                  const ChildIcon = child.icon as any;
                  return (
                    <Link key={child.to} to={child.to} className="ml-4 flex items-center gap-2 px-3 py-2 rounded-lg text-base text-gray-700 hover:bg-blue-50 hover:text-blue-600 font-medium">
                      {ChildIcon && <ChildIcon className="w-4 h-4" />} {child.label}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
        {/* language selector bottom */}
        <div className="mt-auto border-t border-gray-200 px-4 py-3 flex flex-col gap-2">
          <div className="flex justify-center">
            <div className="inline-flex rounded-lg border border-gray-300 bg-white p-1">
              <button
                onClick={() => setLang('ko')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  lang === 'ko'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-700 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                한국어
              </button>
              <button
                onClick={() => setLang('zh')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  lang === 'zh'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-700 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                中文
              </button>
            </div>
          </div>
          <div className="flex justify-center">
            <label className="flex items-center gap-1 text-xs cursor-pointer select-none">
              <input 
                type="checkbox" 
                checked={isLiteMode} 
                onChange={toggleLiteMode} 
              /> 
              {t('lite_mode')}
            </label>
          </div>
        </div>
      </aside>
      )}

      {/* Sidebar (Mobile) */}
      {isAuthenticated && (
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setSidebarOpen(false)}
          />
        )}
      </AnimatePresence>
      )}

      {isAuthenticated && (
      <AnimatePresence>
        {sidebarOpen && (
          <motion.aside
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            className="fixed left-0 top-0 z-50 h-screen w-64 bg-white shadow-xl"
          >
            <div className="flex items-center justify-between p-4 border-b">
              <Link to="/" className="flex items-center gap-2" onClick={() => setSidebarOpen(false)}>
                <img src="/logo.jpg" alt="logo" className="h-8 w-8 rounded-full" />
                <span className="font-semibold text-blue-700">{t('brand')}</span>
              </Link>
              <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(false)}>
                <XIcon className="h-6 w-6" />
              </Button>
            </div>
            <nav className="py-4 px-2 flex flex-col gap-1">
              {navItems.map((group) => {
                const GroupIcon = group.icon as any;
                return (
                  <div key={group.label} className="mb-2">
                    <div className="px-3 py-2 flex items-center gap-2 text-lg font-semibold text-gray-500 uppercase">
                      {GroupIcon && <GroupIcon className="w-4 h-4" />} {group.label}
                    </div>
                    {group.children.map((child) => {
                      const ChildIcon = child.icon as any;
                      return (
                        <Link
                          key={child.to}
                          to={child.to}
                          className="ml-4 flex items-center gap-2 px-3 py-2 rounded-lg text-base text-gray-700 hover:bg-blue-50 hover:text-blue-600 font-medium"
                          onClick={() => setSidebarOpen(false)}
                        >
                          {ChildIcon && <ChildIcon className="w-4 h-4" />} {child.label}
                        </Link>
                      );
                    })}
                  </div>
                );
              })}
            </nav>
          </motion.aside>
        )}
      </AnimatePresence>
      )}

      {/* Main content */}
      <main className={isAuthenticated ? "md:ml-56" : ""}>
        <Routes>
          {/* 로그인 라우트 */}
          <Route path="/login" element={<LoginPage />} />
          {/* 보호된 라우트 */}
          <Route path="/" element={<PrivateRoute><AnalysisPage /></PrivateRoute>} />
          <Route path="/models" element={<PrivateRoute><ModelsPage /></PrivateRoute>} />
          <Route path="/eco" element={<PrivateRoute><EcoPage /></PrivateRoute>} />
          <Route path="/analysis" element={<PrivateRoute><AnalysisPage /></PrivateRoute>} />

          {/* Injection page (single) */}
          <Route path="/injection" element={<PrivateRoute><SummaryPage /></PrivateRoute>} />

          {/* Assembly single page */}
          <Route path="/assembly" element={<PrivateRoute><AssemblyPage /></PrivateRoute>} />

          {/* Sales */}
          <Route path="/sales/inventory" element={<PrivateRoute><SalesInventoryPage /></PrivateRoute>} />
          {/* Inventory status */}
          <Route path="/sales/daily-report" element={<PrivateRoute><DailyReportPage /></PrivateRoute>} />
            <Route path="/sales/inventory-status" element={<PrivateRoute><InventoryStatusPage /></PrivateRoute>} />

          {/* Admin routes */}
          <Route path="/admin/user-approval" element={<PrivateRoute><UserApproval /></PrivateRoute>} />
          
          {/* Existing placeholders */}
          <Route path="/overview" element={<PrivateRoute><OverviewPage /></PrivateRoute>} />
          <Route path="/sales" element={<PrivateRoute><SalesInventoryPage /></PrivateRoute>} />
        </Routes>
      </main>
      <ToastContainer position="bottom-right" />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LangProvider>
        <AuthProvider>
          <BrowserRouter>
            <AppContent />
          </BrowserRouter>
        </AuthProvider>
      </LangProvider>
    </QueryClientProvider>
  );
}
