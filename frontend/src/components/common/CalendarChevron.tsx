import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import type { ChevronProps } from 'react-day-picker';

const calendarChevronIcons = {
  down: ChevronDown,
  left: ChevronLeft,
  right: ChevronRight,
  up: ChevronUp,
} as const;

export function CalendarChevron({ className = '', disabled, orientation = 'right' }: ChevronProps) {
  const Icon = calendarChevronIcons[orientation];

  return (
    <Icon
      aria-hidden="true"
      className={`${className} calendar-nav-chevron`.trim()}
      data-disabled={disabled || undefined}
      size={16}
      strokeWidth={2}
    />
  );
}
