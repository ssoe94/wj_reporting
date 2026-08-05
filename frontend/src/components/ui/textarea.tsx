import { forwardRef } from "react";
import type { TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = "", ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "ui-input ui-textarea block w-full px-3 py-2 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-200 transition min-h-[80px]",
          className
        )}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";
