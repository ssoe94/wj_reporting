type PageHeaderProps = {
  eyebrow: string;
  icon?: PageHeaderIconName;
  title: string;
  description: string;
};

export type PageHeaderIconName = "analysis" | "inventory" | "mes" | "plan" | "production";

function getDefaultIcon(eyebrow: string): PageHeaderIconName {
  const normalized = eyebrow.trim().toLowerCase();
  if (normalized === "analysis") return "analysis";
  if (normalized === "inventory") return "inventory";
  if (normalized === "mes" || normalized === "mes monitoring") return "mes";
  if (normalized === "생산관리" || normalized === "生产管理") return "plan";
  return "production";
}

function IconShape({ icon }: { icon: PageHeaderIconName }) {
  if (icon === "analysis") {
    return (
      <>
        <path d="M4 18.5h16" />
        <path d="M6 15l3.2-3.2 3.1 2.1L18 7" />
        <path d="M15.5 7H18v2.5" />
      </>
    );
  }

  if (icon === "inventory") {
    return (
      <>
        <path d="M5 8.5l7-4 7 4-7 4-7-4Z" />
        <path d="M5 8.5v7l7 4 7-4v-7" />
        <path d="M12 12.5v7" />
      </>
    );
  }

  if (icon === "mes") {
    return (
      <>
        <rect x="4" y="5" width="16" height="12" rx="2.5" />
        <path d="M8 20h8" />
        <path d="M12 17v3" />
        <path d="M7 11h3l1.4-2.5 2.4 5L15 11h2" />
      </>
    );
  }

  if (icon === "plan") {
    return (
      <>
        <path d="M7 4.5h10A2.5 2.5 0 0 1 19.5 7v11A2.5 2.5 0 0 1 17 20.5H7A2.5 2.5 0 0 1 4.5 18V7A2.5 2.5 0 0 1 7 4.5Z" />
        <path d="M8 9h8" />
        <path d="M8 13h5" />
        <path d="M8 17h7" />
        <path d="M15.5 3.5v3" />
        <path d="M8.5 3.5v3" />
      </>
    );
  }

  return (
    <>
      <path d="M4.5 18.5V9.2l7.5-4.7 7.5 4.7v9.3" />
      <path d="M8 18.5v-6h8v6" />
      <path d="M7 9.5h10" />
      <path d="M10 15.5h4" />
    </>
  );
}

export function PageHeaderIcon({ icon }: { icon: PageHeaderIconName }) {
  return (
    <div className="page-header__mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img">
        <IconShape icon={icon} />
      </svg>
    </div>
  );
}

export function PageHeader({ eyebrow, icon, title, description }: PageHeaderProps) {
  return (
    <header className="page-header">
      <PageHeaderIcon icon={icon ?? getDefaultIcon(eyebrow)} />
      <div className="page-header__content">
        <h1 className="page-header__title">{title}</h1>
        <p className="page-header__description">{description}</p>
      </div>
    </header>
  );
}
