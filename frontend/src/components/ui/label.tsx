import type { LabelHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type LabelProps = LabelHTMLAttributes<HTMLLabelElement>;

export function Label({ className = "", ...props }: LabelProps) {
  return (
    <label
      className={cn("block text-gray-700 font-medium mb-1", className)}
      {...props}
    />
  );
} 