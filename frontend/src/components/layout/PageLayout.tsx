import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

type PageContainerProps = {
  children: ReactNode;
  className?: string;
};

type PageHeaderProps = {
  actions?: ReactNode;
  description?: string;
  eyebrow?: string;
  icon: LucideIcon;
  title: string;
};

export function PageContainer({ children, className = '' }: PageContainerProps) {
  return <div className={`app-page ${className}`.trim()}>{children}</div>;
}

export function PageHeader({ actions, description, eyebrow, icon: Icon, title }: PageHeaderProps) {
  return (
    <header className="app-page-header">
      <span className="app-page-header__icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="app-page-header__copy">
        {eyebrow ? <p className="app-page-header__eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="app-page-header__description">{description}</p> : null}
      </div>
      {actions ? <div className="app-page-header__actions">{actions}</div> : null}
    </header>
  );
}
