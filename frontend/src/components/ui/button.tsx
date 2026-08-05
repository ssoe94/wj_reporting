import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "warning" | "secondary" | "info";
  size?: "sm" | "md" | "lg" | "icon";
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className = "", variant = "primary", size = "md", children, ...props },
    ref
  ) => {
    const base =
      "ui-button inline-flex items-center justify-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:pointer-events-none";
    const variants = {
      primary: "ui-button--primary",
      ghost: "ui-button--ghost",
      secondary: "ui-button--secondary",
      warning: "ui-button--warning",
      danger: "ui-button--danger",
      info: "ui-button--info",
    } as const;
    const sizes = {
      sm: "ui-button--sm",
      md: "ui-button--md",
      lg: "ui-button--lg",
      icon: "ui-button--icon",
    };
    return (
      <button
        ref={ref}
        className={cn(base, variants[variant], sizes[size], className)}
        {...props}
      >
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";
