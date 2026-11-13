/** Keep the usual range short while preserving valid historical/future URLs. */
export function hrMonthYears(month: string, now = new Date()): string[] {
  const selectedYear = Number(month.slice(0, 4));
  const currentYear = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(now));
  const first = Math.min(2020, selectedYear);
  const last = Math.max(currentYear + 1, selectedYear);
  return Array.from({ length: last - first + 1 }, (_, index) => String(first + index));
}
