import type { ReactNode } from "react";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl shadow-lg ${className ?? ""}`}>{children}</div>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`px-6 pt-6 pb-2 text-lg font-semibold ${className ?? ""}`}>{children}</div>;
}

export function CardContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`px-6 pb-6 ${className ?? ""}`}>{children}</div>;
} 