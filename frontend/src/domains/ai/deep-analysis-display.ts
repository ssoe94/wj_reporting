import type { AppLanguage } from "../../shared/i18n/language";

const ISO_DATE_TIME = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?\b/g;

function localizedDate(year: string, month: string, day: string, language: AppLanguage): string {
  const numericMonth = Number(month);
  const numericDay = Number(day);
  return language === "ko"
    ? `${year}년 ${numericMonth}월 ${numericDay}일`
    : `${year}年${numericMonth}月${numericDay}日`;
}

function shanghaiDateParts(value: string): { year: string; month: string; day: string; time: string } | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), time: `${get("hour")}:${get("minute")}` };
}

export function formatDeepAnalysisTimestamp(value: string | null | undefined, language: AppLanguage): string {
  if (!value) return "-";
  const parts = shanghaiDateParts(value);
  return parts ? `${localizedDate(parts.year, parts.month, parts.day, language)} ${parts.time}` : "-";
}

/** Format dates in validated AI prose for readers without changing the stored result. */
export function formatDeepAnalysisText(value: string, language: AppLanguage): string {
  return value.replace(ISO_DATE_TIME, (match) => {
    const datePart = match.slice(0, 10);
    const [year, month, day] = datePart.split("-");
    if (!year || !month || !day) return match;
    if (match.length === 10) return localizedDate(year, month, day, language);
    if (/(?:Z|[+-]\d{2}:\d{2})$/.test(match)) {
      const parts = shanghaiDateParts(match);
      return parts ? `${localizedDate(parts.year, parts.month, parts.day, language)} ${parts.time}` : match;
    }
    return `${localizedDate(year, month, day, language)} ${match.slice(11, 16)}`;
  });
}
