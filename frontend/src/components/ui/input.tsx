import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "ui-input block w-full px-3 py-2 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all",
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";
