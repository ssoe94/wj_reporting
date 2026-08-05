import type { ReactNode } from "react";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`ui-card ${className ?? ""}`.trim()}>{children}</div>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`ui-card__header ${className ?? ""}`.trim()}>{children}</div>;
}

export function CardContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`ui-card__content ${className ?? ""}`.trim()}>{children}</div>;
}
