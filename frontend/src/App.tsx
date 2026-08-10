import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LangProvider } from "./i18n";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { useLang } from "./i18n";
import { Button } from "./components/ui/button";
import { Menu as MenuIcon, X as XIcon, Home as HomeIcon, ChevronDown, ChevronRight } from "lucide-react";
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
  ShieldCheck,
  AlertTriangle,
  BarChart3,
  Factory,
  FileSpreadsheet,
} from "lucide-react";
import ModelsPage from './pages/models';
import Eco2Page from './pages/eco2';
import AnalysisPage from './pages/analysis';
import AssemblyPage from './pages/assembly';
import SalesInventoryPage from './pages/sales/Inventory';
import OverviewPage from './pages/overview';
import LoginPage from './pages/LoginPage';
import PrivateRoute from './components/PrivateRoute';
import InventoryStatusPage from './pages/sales/InventoryStatus';
import DailyReportPage from './pages/sales/DailyReport';
import UserApproval from './pages/admin/UserApproval';
import PasswordChangeModal from './components/PasswordChangeModal';
import PageTransition from './components/common/PageTransition';
import { NavigationTree } from './components/layout/NavigationTree';
import QualityPage from './pages/quality';
import DailyAttentionPage from './pages/quality/DailyAttention';
import AssemblyDashboardPage from './pages/assembly/Dashboard';
import InjectionDashboardPage from './pages/injection/Dashboard';
import InjectionMonitoringPage from './pages/injection/MonitoringPage';
import FieldLauncherPage from './pages/field/Launcher';
import FieldStationPage from './pages/field/Station';
import ProductionStatsPage from './pages/production/Stats';
import { parseFieldTerminalUser } from './lib/fieldTerminal';

const ProductionDashboardPage = lazy(() => import('./domains/production/pages/ProductionDashboardPage').then((module) => ({
  default: module.ProductionDashboardPage,
})));
const ProductionPlansPage = lazy(() => import('./domains/production/pages/ProductionPlansPage').then((module) => ({
  default: module.ProductionPlansPage,
})));
const InjectionBoardPage = lazy(() => import('./domains/production/pages/InjectionBoardPage').then((module) => ({
  default: module.InjectionBoardPage,
})));
const MesMonitoringPage = lazy(() => import('./domains/mes/pages/MesMonitoringPage').then((module) => ({
  default: module.MesMonitoringPage,
})));
const RawMaterialManagementPage = lazy(() => import('./domains/inventory/pages/RawMaterialManagementPage').then((module) => ({
  default: module.RawMaterialManagementPage,
})));
const MouldManagementPage = lazy(() => import('./domains/moulds/pages/MouldManagementPage').then((module) => ({
  default: module.MouldManagementPage,
})));
const BoardHubPage = lazy(() => import('./domains/boards/pages/BoardHubPage').then((module) => ({
  default: module.BoardHubPage,
})));
const EnergyBoardPage = lazy(() => import('./domains/boards/pages/EnergyBoardPage').then((module) => ({
  default: module.EnergyBoardPage,
})));
const OverviewBoardPage = lazy(() => import('./domains/boards/pages/OverviewBoardPage').then((module) => ({
  default: module.OverviewBoardPage,
})));

const queryClient = new QueryClient();

function isPublicRoutePath(pathname: string) {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return normalizedPath === '/login'
    || normalizedPath === '/boards'
    || normalizedPath === '/boards/injection'
    || normalizedPath === '/boards/moulds'
    || normalizedPath === '/boards/energy'
    || normalizedPath === '/production/injection-board'
    || normalizedPath === '/production/injection-board/index.html'
    || normalizedPath === '/injection/moulds'
    || normalizedPath === '/next/production/injection-board'
    || normalizedPath === '/next/production/injection-board/index.html';
}

function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={parseFieldTerminalUser(user?.username) ? "/field" : "/analysis"} replace />;
}

function RouteLoading() {
  return (
    <div className="flex min-h-64 items-center justify-center" role="status">
      <div className="h-12 w-12 animate-spin rounded-full border-4 border-blue-100 border-b-blue-600" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

function InjectionLegacyRedirect() {
  const location = useLocation();
  const targetHash = location.hash === '#new' ? '#new' : '#records';
  return <Navigate to={`/injection/dashboard${targetHash}`} replace />;
}

function useNavItems() {
  const { lang, t } = useLang();
  const { user, hasPermission } = useAuth();

  // Staff users see the full navigation tree.
  if (user?.is_staff) {
    return [
      {
        label: t('nav_overview'),
        icon: FileChartPie,
        children: [
          { to: "/analysis", label: t('nav_dashboard'), icon: ChartPie },
          { to: "/boards", label: lang === 'ko' ? '현황판' : '看板中心', icon: Monitor },
        ],
      },
      {
        label: t('nav_production'),
        icon: Factory,
        children: [
          { to: "/production", label: t('nav_production_dashboard'), icon: BarChart3 },
          { to: "/production/plan", label: t('nav_production_plan'), icon: FileSpreadsheet },
          { to: "/production/stats", label: t('nav_production_stats'), icon: BarChart3 },
        ],
      }, {
        label: t('nav_injection'),
        icon: Monitor,
        children: [
          { to: "/injection/dashboard", label: t('nav_injection_dashboard'), icon: BarChart3 },
          { to: "/mes/monitoring", label: t('monitoring.title'), icon: BarChart3 },
        ],
      },
      {
        label: t('nav_machining'),
        icon: Wrench,
        children: [
          { to: "/assembly/dashboard", label: t('nav_machining_dashboard'), icon: BarChart3 },
          { to: "/assembly#top", label: t('nav_machining_summary'), icon: ChartNoAxesCombined },
          { to: "/assembly#records", label: t('nav_machining_records'), icon: ClipboardList },
          { to: "/assembly#new", label: t('nav_machining_new'), icon: PlusSquare },
        ],
      },
      {
        label: t('nav_quality'),
        icon: ShieldCheck,
        children: [
          { to: "/quality/daily-attention", label: t('nav_quality_daily_attention'), icon: ClipboardCheck },
          { to: "/quality#report", label: t('nav_quality_report'), icon: AlertTriangle },
          { to: "/quality#stats", label: t('nav_quality_stats'), icon: BarChart3 },
        ],
      },
      {
        label: t('nav_sales'),
        icon: Truck,
        children: [
          { to: "/sales/inventory", label: t('nav_inventory_analysis'), icon: PackageSearch },
          { to: "/sales/daily-report", label: t('nav_daily_report'), icon: ClipboardList },
          { to: "/sales/inventory-status", label: t('nav_inventory_status'), icon: Boxes },
          { to: "/sales/raw-materials", label: t('nav_raw_material_management'), icon: Boxes },
        ],
      },
      {
        label: t('nav_development'),
        icon: DraftingIcon,
        children: [
          { to: "/eco2", label: t('nav_eco_management'), icon: ClipboardCheck },
          { to: "/models", label: t('nav_model_management'), icon: PackageSearch },
        ],
      },
      {
        label: t('nav_admin'),
        icon: Monitor,
        children: [
          {
            to: "/admin/user-management",
            label: t('nav_user_mgmt'),
            icon: ClipboardCheck,
          },
        ],
      },
    ];
  }

  // Regular users get the same sections, trimmed by permission-aware links.
  const navItems = [];

  navItems.push({
    label: t('nav_overview'),
    icon: FileChartPie,
    children: [
      { to: "/analysis", label: t('nav_dashboard'), icon: ChartPie },
      { to: "/boards", label: lang === 'ko' ? '현황판' : '看板中心', icon: Monitor },
    ],
  });

  navItems.push({
    label: t('nav_production'),
    icon: Factory,
    children: [
      { to: "/production", label: t('nav_production_dashboard'), icon: BarChart3 },
      { to: "/production/plan", label: t('nav_production_plan'), icon: FileSpreadsheet },
      { to: "/production/stats", label: t('nav_production_stats'), icon: BarChart3 },
    ],
  });

  navItems.push({
    label: t('nav_injection'),
    icon: Monitor,
    children: [
      { to: "/injection/dashboard", label: t('nav_injection_dashboard'), icon: BarChart3 },
      { to: "/mes/monitoring", label: t('monitoring.title'), icon: BarChart3 },
    ],
  });
  navItems.push({
    label: t('nav_machining'),
    icon: Wrench,
    children: [
      { to: "/assembly/dashboard", label: t('nav_machining_dashboard'), icon: BarChart3 },
      { to: "/assembly#top", label: t('nav_machining_summary'), icon: ChartNoAxesCombined },
      { to: "/assembly#records", label: t('nav_machining_records'), icon: ClipboardList },
      { to: "/assembly#new", label: t('nav_machining_new'), icon: PlusSquare },
    ],
  });
  navItems.push({
    label: t('nav_quality'),
    icon: ShieldCheck,
    children: [
      { to: "/quality/daily-attention", label: t('nav_quality_daily_attention'), icon: ClipboardCheck },
      { to: "/quality#report", label: t('nav_quality_report'), icon: AlertTriangle },
      { to: "/quality#stats", label: t('nav_quality_stats'), icon: BarChart3 },
    ],
  });
  navItems.push({
    label: t('nav_sales'),
    icon: Truck,
    children: [
      { to: "/sales/inventory", label: t('nav_inventory_analysis'), icon: PackageSearch },
      { to: "/sales/daily-report", label: t('nav_daily_report'), icon: ClipboardList },
      { to: "/sales/inventory-status", label: t('nav_inventory_status'), icon: Boxes },
      { to: "/sales/raw-materials", label: t('nav_raw_material_management'), icon: Boxes },
    ],
  });
  navItems.push({
    label: t('nav_development'),
    icon: DraftingIcon,
    children: [
      { to: "/eco2", label: t('nav_eco_management'), icon: ClipboardCheck },
      { to: "/models", label: t('nav_model_management'), icon: PackageSearch },
    ],
  });
  if (hasPermission('is_admin')) {
    navItems.push({
      label: t('nav_admin'),
      icon: Monitor,
      children: [
        {
          to: "/admin/user-management",
          label: t('nav_user_mgmt'),
          icon: ClipboardCheck,
        },
      ],
    });
  }

  return navItems;
}

function AppContent() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [isLiteMode, setIsLiteMode] = useState(() =>
    typeof window !== 'undefined' && localStorage.getItem('lite') === '1'
  );
  const { lang, setLang, t } = useLang();
  const { user, logout, isAuthenticated, isLoading } = useAuth();
  const routerLocation = useLocation();
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavigationRef = useRef<HTMLElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const fieldTerminalUser = parseFieldTerminalUser(user?.username);
  const isFieldTerminal = Boolean(fieldTerminalUser);

  const locationKey = routerLocation.pathname;

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    if (!sidebarOpen) return;

    const previousOverflow = document.body.style.overflow;
    const navigation = mobileNavigationRef.current;
    const menuButton = mobileMenuButtonRef.current;
    const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

    document.body.style.overflow = 'hidden';
    navigation?.querySelector<HTMLElement>('[data-mobile-nav-close]')?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebarOpen(false);
        return;
      }

      if (event.key !== 'Tab' || !navigation) return;
      const focusable = Array.from(navigation.querySelectorAll(focusableSelector)) as HTMLElement[];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      menuButton?.focus();
    };
  }, [sidebarOpen]);

  // Force password change when a temporary password is in use.
  useEffect(() => {
    if (user && user.is_using_temp_password) {
      setPasswordModalOpen(true);
    }
  }, [user]);

  // Toggle lite mode on the document root.
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

  // Close the user dropdown when clicking outside.
  useEffect(() => {
    const handleClickOutside = () => {
      if (userDropdownOpen) {
        setUserDropdownOpen(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [userDropdownOpen]);

  useEffect(() => {
    if (!userDropdownOpen) return;

    const menu = userMenuRef.current;
    const trigger = userMenuTriggerRef.current;
    const items = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    items[0]?.focus();

    const handleMenuKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setUserDropdownOpen(false);
        requestAnimationFrame(() => trigger?.focus());
        return;
      }

      if (event.key === 'Tab') {
        const currentIndex = items.indexOf(document.activeElement as HTMLElement);
        const leavingBackward = event.shiftKey && currentIndex === 0;
        const leavingForward = !event.shiftKey && currentIndex === items.length - 1;
        if (!leavingBackward && !leavingForward) {
          event.preventDefault();
          const nextItemIndex = currentIndex + (event.shiftKey ? -1 : 1);
          items[nextItemIndex]?.focus();
          return;
        }

        event.preventDefault();
        const pageFocusable = Array.from(document.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter((element) => !menu?.contains(element));
        const triggerIndex = trigger ? pageFocusable.indexOf(trigger) : -1;
        const nextOutside = pageFocusable[triggerIndex + 1] ?? pageFocusable[0];

        setUserDropdownOpen(false);
        requestAnimationFrame(() => {
          if (leavingBackward) trigger?.focus();
          else nextOutside?.focus();
        });
        return;
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (currentIndex + step + items.length) % items.length;
      items[nextIndex]?.focus();
    };

    menu?.addEventListener('keydown', handleMenuKeyDown);
    return () => menu?.removeEventListener('keydown', handleMenuKeyDown);
  }, [userDropdownOpen]);

  const navItems = useNavItems();
  const pathname = routerLocation.pathname;
  const isInjectionBoardRoute = pathname === '/production/injection-board'
    || pathname === '/production/injection-board/'
    || pathname === '/production/injection-board/index.html'
    || pathname === '/boards/injection'
    || pathname === '/boards/injection/';
  const isMouldRoute = pathname === '/injection/moulds'
    || pathname === '/injection/moulds/'
    || pathname === '/boards/moulds'
    || pathname === '/boards/moulds/';
  const isEnergyBoardRoute = pathname === '/boards/energy'
    || pathname === '/boards/energy/';
  const isOverviewBoardRoute = pathname === '/boards/overview'
    || pathname === '/boards/overview/';
  const isStandaloneBoardRoute = isInjectionBoardRoute || isMouldRoute || isEnergyBoardRoute || isOverviewBoardRoute;
  let breadcrumbLabel = t('brand');
  if (pathname.startsWith('/assembly/dashboard')) breadcrumbLabel = t('nav_machining_dashboard');
  else if (pathname.startsWith('/assembly')) breadcrumbLabel = t('brand_machining');
  else if (pathname.startsWith('/boards')) breadcrumbLabel = lang === 'ko' ? '현황판' : '看板中心';
  else if (pathname.startsWith('/production')) breadcrumbLabel = t('nav_production');
  else if (pathname.startsWith('/injection/moulds')) breadcrumbLabel = lang === 'ko' ? '금형 현황' : '模具现状';
  else if (pathname.startsWith('/injection/dashboard')) breadcrumbLabel = t('nav_injection_dashboard');
  else if (pathname.startsWith('/injection')) breadcrumbLabel = t('brand');
  else if (pathname.startsWith('/analysis')) breadcrumbLabel = t('nav_dashboard');
  else if (pathname.startsWith('/sales/raw-materials')) breadcrumbLabel = t('nav_raw_material_management');
  else if (pathname.startsWith('/sales')) breadcrumbLabel = t('nav_sales');
  else if (pathname.startsWith('/eco2')) breadcrumbLabel = t('nav_eco_management');
  else if (pathname.startsWith('/eco')) breadcrumbLabel = t('nav_eco_management');
  else if (pathname.startsWith('/quality')) breadcrumbLabel = t('brand_quality');
  else if (pathname.startsWith('/models')) breadcrumbLabel = t('nav_model_management');

  // Global auth loading state.
  if (isLoading && !isPublicRoutePath(pathname)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // Redirect anonymous users to login.
  if (!isAuthenticated && !isPublicRoutePath(pathname)) {
    const returnTo = `${routerLocation.pathname}${routerLocation.search}${routerLocation.hash}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }

  return (
    <div className="main-app-shell">
      {/* Header */}
      {isAuthenticated && !isFieldTerminal && !isStandaloneBoardRoute && (
        <header className="main-mobile-header md:hidden">
          <div className="main-mobile-header__inner">
            <Link to="/" className="main-mobile-header__brand main-brand-lockup main-brand-lockup--compact">
              <span className="main-brand-lockup__mark" aria-hidden="true">
                <img src="/logo-transparent.png" alt="" />
              </span>
              <span className="main-brand-lockup__copy">
                <strong>WJ DATA CENTER</strong>
                <small>{t('brand_full')}</small>
              </span>
            </Link>
            <div className="main-mobile-header__actions">
              <div className="main-language-switch" aria-label={lang === 'ko' ? '언어' : '语言'}>
                <button
                  aria-pressed={lang === 'ko'}
                  onClick={() => setLang('ko')}
                  className={`main-language-switch__button${lang === 'ko' ? ' is-active' : ''}`}
                >
                  KOR
                </button>
                <button
                  aria-pressed={lang === 'zh'}
                  onClick={() => setLang('zh')}
                  className={`main-language-switch__button${lang === 'zh' ? ' is-active' : ''}`}
                >
                  中文
                </button>
              </div>
              {user && (
                <Button className="main-mobile-header__logout" variant="ghost" size="sm" onClick={logout}>
                  {t('logout')}
                </Button>
              )}
              <Button
                ref={mobileMenuButtonRef}
                aria-controls="main-mobile-navigation"
                aria-expanded={sidebarOpen}
                aria-label={lang === 'ko' ? '메뉴 열기' : '打开菜单'}
                className="main-mobile-header__menu"
                variant="ghost"
                size="icon"
                onClick={() => setSidebarOpen(true)}
              >
                <MenuIcon className="h-6 w-6" />
              </Button>
            </div>
          </div>
        </header>
      )}

      {/* Breadcrumb */}
      {isAuthenticated && !isFieldTerminal && !isStandaloneBoardRoute && (
        <div className="main-topbar">
          <Link aria-label={lang === 'ko' ? '홈' : '首页'} className="main-topbar__home" to="/">
            <HomeIcon aria-hidden="true" />
          </Link>
          <ChevronRight aria-hidden="true" className="main-topbar__separator" />
          <span className="main-topbar__title">{breadcrumbLabel}</span>
          {user && (
            <div className="main-user-menu">
              <button
                ref={userMenuTriggerRef}
                aria-controls="main-user-menu"
                aria-expanded={userDropdownOpen}
                aria-haspopup="menu"
                onClick={(e) => {
                  e.stopPropagation();
                  setUserDropdownOpen(!userDropdownOpen);
                }}
                className="main-user-menu__trigger"
              >
                {user.username}{user.department ? ` (${user.department})` : ''}
                <ChevronDown aria-hidden="true" className={userDropdownOpen ? 'is-open' : ''} />
              </button>
              {userDropdownOpen && (
                <div ref={userMenuRef} id="main-user-menu" className="main-user-menu__popover" role="menu">
                  <button
                    onClick={() => {
                      setPasswordModalOpen(true);
                      setUserDropdownOpen(false);
                    }}
                    role="menuitem"
                  >
                    {t('password_change')}
                  </button>
                  <button
                    onClick={() => {
                      logout();
                      setUserDropdownOpen(false);
                    }}
                    role="menuitem"
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
      {isAuthenticated && !isFieldTerminal && !isStandaloneBoardRoute && (
        <aside className="main-sidebar main-sidebar--desktop hidden md:flex">
          {/* Top logo/title */}
          <div className="main-sidebar__brand">
            <Link to="/" className="main-brand-lockup">
              <span className="main-brand-lockup__mark" aria-hidden="true">
                <img src="/logo-transparent.png" alt="" />
              </span>
              <span className="main-brand-lockup__copy">
                <strong>WJ DATA CENTER</strong>
                <small>{t('brand_full')}</small>
              </span>
            </Link>
          </div>
          {/* Menu */}
          <nav aria-label={lang === 'ko' ? '주요 메뉴' : '主菜单'} className="main-navigation">
            <NavigationTree
              currentHash={routerLocation.hash}
              currentPath={pathname}
              groups={navItems}
            />
          </nav>
          {/* language selector bottom */}
          <div className="main-sidebar__footer">
            <div className="main-language-switch" aria-label={lang === 'ko' ? '언어' : '语言'}>
                <button
                  aria-pressed={lang === 'ko'}
                  onClick={() => setLang('ko')}
                  className={`main-language-switch__button${lang === 'ko' ? ' is-active' : ''}`}
                >
                  KOR
                </button>
                <button
                  aria-pressed={lang === 'zh'}
                  onClick={() => setLang('zh')}
                  className={`main-language-switch__button${lang === 'zh' ? ' is-active' : ''}`}
                >
                  中文
                </button>
            </div>
            <div className="main-lite-mode">
              <label>
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
      {isAuthenticated && !isFieldTerminal && !isStandaloneBoardRoute && (
        <AnimatePresence>
          {sidebarOpen && (
            <motion.div
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="main-mobile-nav-backdrop"
              onClick={() => setSidebarOpen(false)}
            />
          )}
        </AnimatePresence>
      )}

      {isAuthenticated && !isFieldTerminal && !isStandaloneBoardRoute && (
        <AnimatePresence>
          {sidebarOpen && (
            <motion.aside
              ref={mobileNavigationRef}
              id="main-mobile-navigation"
              role="dialog"
              aria-modal="true"
              aria-label={lang === 'ko' ? '모바일 주요 메뉴' : '移动主菜单'}
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              className="main-sidebar main-sidebar--mobile"
            >
              <div className="main-sidebar__brand main-sidebar__brand--mobile">
                <Link to="/" className="main-brand-lockup" onClick={() => setSidebarOpen(false)}>
                  <span className="main-brand-lockup__mark" aria-hidden="true">
                    <img src="/logo-transparent.png" alt="" />
                  </span>
                  <span className="main-brand-lockup__copy">
                    <strong>WJ DATA CENTER</strong>
                    <small>{t('brand_full')}</small>
                  </span>
                </Link>
                <Button data-mobile-nav-close aria-label={lang === 'ko' ? '메뉴 닫기' : '关闭菜单'} variant="ghost" size="icon" onClick={() => setSidebarOpen(false)}>
                  <XIcon className="h-6 w-6" />
                </Button>
              </div>
              <nav aria-label={lang === 'ko' ? '주요 메뉴' : '主菜单'} className="main-navigation">
                <NavigationTree
                  currentHash={routerLocation.hash}
                  currentPath={pathname}
                  groups={navItems}
                  onNavigate={() => setSidebarOpen(false)}
                />
              </nav>
              <div className="main-sidebar__footer main-sidebar__footer--mobile">
                <div className="main-language-switch" aria-label={lang === 'ko' ? '언어' : '语言'}>
                  <button
                    aria-pressed={lang === 'ko'}
                    onClick={() => setLang('ko')}
                    className={`main-language-switch__button${lang === 'ko' ? ' is-active' : ''}`}
                  >
                    KOR
                  </button>
                  <button
                    aria-pressed={lang === 'zh'}
                    onClick={() => setLang('zh')}
                    className={`main-language-switch__button${lang === 'zh' ? ' is-active' : ''}`}
                  >
                    中文
                  </button>
                </div>
                <div className="main-lite-mode">
                  <label>
                    <input
                      type="checkbox"
                      checked={isLiteMode}
                      onChange={toggleLiteMode}
                    />
                    {t('lite_mode')}
                  </label>
                </div>
                {user ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSidebarOpen(false);
                      logout();
                    }}
                  >
                    {t('logout')}
                  </Button>
                ) : null}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      )}

      {/* Main content */}
      <main className={isAuthenticated && !isFieldTerminal && !isStandaloneBoardRoute ? "main-workspace" : "main-workspace main-workspace--standalone"}>
        <AnimatePresence mode="wait">
          <Routes location={routerLocation} key={locationKey}>
            {/* Public routes */}
            <Route path="/login" element={<PageTransition><LoginPage /></PageTransition>} />
            <Route path="/boards" element={<Suspense fallback={<RouteLoading />}><BoardHubPage /></Suspense>} />
            <Route path="/boards/injection" element={<Suspense fallback={<RouteLoading />}><InjectionBoardPage /></Suspense>} />
            <Route path="/boards/moulds" element={<Suspense fallback={<RouteLoading />}><MouldManagementPage /></Suspense>} />
            <Route path="/boards/energy" element={<Suspense fallback={<RouteLoading />}><EnergyBoardPage /></Suspense>} />
            <Route path="/boards/overview" element={<PrivateRoute><Suspense fallback={<RouteLoading />}><OverviewBoardPage /></Suspense></PrivateRoute>} />
            {/* Private routes */}
            <Route path="/" element={<PrivateRoute><PageTransition><HomeRedirect /></PageTransition></PrivateRoute>} />
            <Route path="/next/login" element={<Navigate to="/login" replace />} />
            <Route path="/next/production" element={<Navigate to="/production" replace />} />
            <Route path="/next/production/plans" element={<Navigate to="/production/plan" replace />} />
            <Route path="/next/production/injection-board" element={<Navigate to="/boards/injection" replace />} />
            <Route path="/next/production/injection-board/index.html" element={<Navigate to="/boards/injection" replace />} />
            <Route path="/next/mes/monitoring" element={<Navigate to="/mes/monitoring" replace />} />
            <Route path="/next/inventory/raw-materials" element={<Navigate to="/sales/raw-materials" replace />} />
            <Route path="/field" element={<PrivateRoute><PageTransition><FieldLauncherPage /></PageTransition></PrivateRoute>} />
            <Route path="/field/:stationId" element={<PrivateRoute><PageTransition><FieldStationPage /></PageTransition></PrivateRoute>} />
            <Route path="/models" element={<PrivateRoute><PageTransition><ModelsPage /></PageTransition></PrivateRoute>} />
            <Route path="/eco" element={<Navigate to="/eco2" replace />} />
            <Route path="/eco2" element={<PrivateRoute><PageTransition><Eco2Page /></PageTransition></PrivateRoute>} />
            <Route path="/analysis" element={<PrivateRoute><PageTransition><AnalysisPage /></PageTransition></PrivateRoute>} />

            {/* Injection page (single) */}
            <Route path="/injection/dashboard" element={<PrivateRoute><PageTransition><InjectionDashboardPage /></PageTransition></PrivateRoute>} />
            <Route path="/injection/moulds" element={<Suspense fallback={<RouteLoading />}><MouldManagementPage /></Suspense>} />
            <Route path="/injection" element={<PrivateRoute><InjectionLegacyRedirect /></PrivateRoute>} />
            <Route path="/injection/setup" element={<PrivateRoute><Navigate to="/injection/dashboard#cycle-time" replace /></PrivateRoute>} />
            <Route path="/injection/monitoring" element={<PrivateRoute><PageTransition><InjectionMonitoringPage /></PageTransition></PrivateRoute>} />
            <Route path="/mes/monitoring" element={<PrivateRoute><PageTransition><Suspense fallback={<RouteLoading />}><MesMonitoringPage /></Suspense></PageTransition></PrivateRoute>} />

            {/* Production */}
            <Route path="/production" element={<PrivateRoute><PageTransition><Suspense fallback={<RouteLoading />}><ProductionDashboardPage /></Suspense></PageTransition></PrivateRoute>} />
            <Route path="/production/plans" element={<Navigate to="/production/plan" replace />} />
            <Route path="/production/injection-board" element={<Suspense fallback={<RouteLoading />}><InjectionBoardPage /></Suspense>} />
            <Route path="/production/injection-board/" element={<Suspense fallback={<RouteLoading />}><InjectionBoardPage /></Suspense>} />
            <Route path="/production/injection-board/index.html" element={<Suspense fallback={<RouteLoading />}><InjectionBoardPage /></Suspense>} />
            <Route path="/production/plan" element={<PrivateRoute><PageTransition><Suspense fallback={<RouteLoading />}><ProductionPlansPage /></Suspense></PageTransition></PrivateRoute>} />
            <Route path="/production/stats" element={<PrivateRoute><PageTransition><ProductionStatsPage /></PageTransition></PrivateRoute>} />

            {/* Assembly single page */}
            <Route path="/assembly/dashboard" element={<PrivateRoute><PageTransition><AssemblyDashboardPage /></PageTransition></PrivateRoute>} />
            <Route path="/assembly" element={<PrivateRoute><PageTransition><AssemblyPage /></PageTransition></PrivateRoute>} />

            {/* Quality single page */}
            <Route path="/quality" element={<PrivateRoute><PageTransition><QualityPage /></PageTransition></PrivateRoute>} />
            <Route path="/quality/daily-attention" element={<PrivateRoute><PageTransition><DailyAttentionPage /></PageTransition></PrivateRoute>} />

            {/* Sales */}
            <Route path="/sales/inventory" element={<PrivateRoute><PageTransition><SalesInventoryPage /></PageTransition></PrivateRoute>} />
            {/* Inventory status */}
            <Route path="/sales/daily-report" element={<PrivateRoute><PageTransition><DailyReportPage /></PageTransition></PrivateRoute>} />
            <Route path="/sales/inventory-status" element={<PrivateRoute><PageTransition><InventoryStatusPage /></PageTransition></PrivateRoute>} />
            <Route path="/sales/raw-materials" element={<PrivateRoute><PageTransition><Suspense fallback={<RouteLoading />}><RawMaterialManagementPage /></Suspense></PageTransition></PrivateRoute>} />
            <Route path="/inventory/raw-materials" element={<Navigate to="/sales/raw-materials" replace />} />

            {/* Admin routes */}
            <Route path="/admin/user-management" element={<PrivateRoute><PageTransition><UserApproval /></PageTransition></PrivateRoute>} />
            <Route path="/admin/user-approval" element={<PrivateRoute><PageTransition><UserApproval /></PageTransition></PrivateRoute>} /> {/* Legacy URL compatibility */}

            {/* Existing placeholders */}
            <Route path="/overview" element={<PrivateRoute><PageTransition><OverviewPage /></PageTransition></PrivateRoute>} />
            <Route path="/sales" element={<PrivateRoute><PageTransition><SalesInventoryPage /></PageTransition></PrivateRoute>} />
          </Routes>
        </AnimatePresence>
      </main>

      {/* Password change modal */}
      <PasswordChangeModal
        isOpen={passwordModalOpen}
        onClose={() => setPasswordModalOpen(false)}
        isRequired={user?.is_using_temp_password || false}
        onSuccess={() => {
          // Refresh user info after a successful password change.
          window.location.reload();
        }}
      />

      <ToastContainer position="bottom-right" />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LangProvider>
        <AuthProvider>
          <BrowserRouter basename="/">
            <AppContent />
          </BrowserRouter>
        </AuthProvider>
      </LangProvider>
    </QueryClientProvider>
  );
}
