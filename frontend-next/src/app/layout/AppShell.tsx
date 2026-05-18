import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "@/domains/auth/auth-context";
import type { AppCapability } from "@/domains/auth/types";
import { setStoredLanguage, useStoredLanguage, type AppLanguage } from "@/shared/i18n/language";

type NavItem = {
  to: string;
  label: Record<AppLanguage, string>;
  capability: AppCapability;
  description: Record<AppLanguage, string>;
};

const navItems: NavItem[] = [
  {
    to: "/production",
    label: { ko: "생산 대시보드", zh: "生产看板" },
    capability: "production.read",
    description: { ko: "진행 현황과 병목 확인", zh: "查看进度和瓶颈" },
  },
  {
    to: "/production/plans",
    label: { ko: "생산 계획", zh: "生产计划" },
    capability: "production.read",
    description: { ko: "업로드 계획과 설비별 순서 확인", zh: "确认上传计划和设备顺序" },
  },
  {
    to: "/mes/monitoring",
    label: { ko: "MES 모니터링", zh: "MES 监控" },
    capability: "production.read",
    description: { ko: "사출 MES 수집과 공정 진행 추적", zh: "采集注塑 MES 并跟踪工序进度" },
  },
  {
    to: "/analysis",
    label: { ko: "분석", zh: "分析" },
    capability: "analysis.read",
    description: { ko: "종합 현황과 요약 지표", zh: "综合现况和汇总指标" },
  },
  {
    to: "/inventory",
    label: { ko: "재고", zh: "库存" },
    capability: "inventory.read",
    description: { ko: "현재고와 갱신 상태 확인", zh: "查看库存和更新状态" },
  },
];

const shellCopy = {
  ko: {
    brandTitle: "WJ DATA CENTER",
    language: "언어",
    staff: "staff account",
    user: "authenticated account",
    logout: "로그아웃",
  },
  zh: {
    brandTitle: "万佳数据中心",
    language: "语言",
    staff: "staff account",
    user: "authenticated account",
    logout: "退出",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

export function AppShell() {
  const { user, logout, hasCapability } = useAuth();
  const [language, setLanguage] = useStoredLanguage();
  const copy = shellCopy[language];
  const visibleItems = navItems.filter((item) => hasCapability(item.capability));

  function handleLanguageChange(nextLanguage: AppLanguage) {
    setLanguage(nextLanguage);
    setStoredLanguage(nextLanguage);
  }

  return (
    <div className="shell">
      <aside className="shell__sidebar">
        <div className="sidebar-main">
          <div className="brand">
            <img alt="WJ company logo" className="brand__logo" src="/wjlogo.png" />
            <h1 className={`brand__title brand__title--${language}`}>{copy.brandTitle}</h1>
          </div>

          <nav className="nav">
            {visibleItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `nav__item${isActive ? " nav__item--active" : ""}`}
              >
                <span className="nav__label">{item.label[language]}</span>
                <span className="nav__description">{item.description[language]}</span>
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="sidebar-controls">
          <div className="sidebar-user">
            <div>
              <strong>{user?.username ?? "anonymous"}</strong>
              <p>{user?.is_staff ? copy.staff : copy.user}</p>
            </div>
            <button className="button button--ghost sidebar-user__logout" onClick={logout} type="button">
              {copy.logout}
            </button>
          </div>

          <span className="sidebar-controls__label">{copy.language}</span>
          <div className="language-switch language-switch--sidebar" aria-label={copy.language}>
            <button
              className={language === "ko" ? "language-switch__item language-switch__item--active" : "language-switch__item"}
              onClick={() => handleLanguageChange("ko")}
              type="button"
            >
              한국어
            </button>
            <button
              className={language === "zh" ? "language-switch__item language-switch__item--active" : "language-switch__item"}
              onClick={() => handleLanguageChange("zh")}
              type="button"
            >
              中文
            </button>
          </div>
        </div>
      </aside>

      <div className="shell__content">
        <main className="shell__main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
