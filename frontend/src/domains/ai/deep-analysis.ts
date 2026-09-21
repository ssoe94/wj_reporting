import type { AppLanguage } from "@/shared/i18n/language";
import { DEEP_ANALYSIS_MODEL_ID } from "./model-labels.ts";

// Stored kinds remain compatible with earlier weekly results.
export type DeepAnalysisKind = "production_weekly" | "quality_weekly";

export type DeepAnalysisSchedule = {
  cadence: "daily";
  hour: number;
  timezone: string;
  context_days: number;
  date_basis: "previous_completed_business_day";
};

export function latestDeepAnalysisPath(kind: DeepAnalysisKind, language: AppLanguage) {
  // No model filter: completed Claude history remains readable during cutover.
  return `/ai/jobs/latest/?job_type=deep_analysis&kind=${encodeURIComponent(kind)}&language=${encodeURIComponent(language)}`;
}

export function deepAnalysisRequestScope(kind: DeepAnalysisKind, language: AppLanguage, date?: string) {
  return { kind, language, model_id: DEEP_ANALYSIS_MODEL_ID, ...(date ? { date } : {}) };
}

/** Display only a schedule reported by the server; absent metadata is not proof of a running schedule. */
export function describeDeepAnalysisSchedule(schedule: DeepAnalysisSchedule | null | undefined, language: AppLanguage) {
  if (!schedule) return "";
  if (schedule.cadence !== "daily"
    || schedule.date_basis !== "previous_completed_business_day"
    || !Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23
    || !Number.isInteger(schedule.context_days) || schedule.context_days < 1
    || !schedule.timezone) return "";
  const time = `${String(schedule.hour).padStart(2, "0")}:00`;
  return language === "ko"
    ? `일일 분석 기준: ${time} (${schedule.timezone}) · 직전 완료 생산일 · 최근 ${schedule.context_days}일 비교`
    : `每日分析规则：${time}（${schedule.timezone}）· 上一已结束生产日 · 对比最近 ${schedule.context_days} 天`;
}
