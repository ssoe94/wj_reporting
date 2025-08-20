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
      "inline-flex items-center justify-center font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:pointer-events-none";
    const variants = {
      primary: "bg-blue-600 text-white hover:bg-blue-700",
      ghost: "bg-transparent text-gray-700 hover:bg-gray-100 hover:text-gray-900",
      secondary: "bg-gray-100 text-gray-800 hover:bg-gray-200",
      warning: "bg-yellow-100 text-yellow-800 hover:bg-yellow-200",
      danger: "bg-red-100 text-red-700 hover:bg-red-200",
      info: "bg-blue-100 text-blue-800 hover:bg-blue-200",
    } as const;
    const sizes = {
      sm: "px-3 py-1.5 text-sm rounded-lg",
      md: "px-4 py-2 text-base rounded-xl",
      lg: "px-6 py-3 text-lg rounded-2xl",
      icon: "p-2 rounded-full w-10 h-10 justify-center",
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