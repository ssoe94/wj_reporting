import type { AppLanguage } from "@/shared/i18n/language";

export type LocalAiHistory = {
  last_analysis_completed_at?: string | null;
  last_analysis_llm_fallback?: boolean | null;
  last_analysis_fallback_code?: string | null;
  last_analysis_source?: string | null;
  last_successful_analysis_at?: string | null;
};

export type LocalAiAnalysisState = "unknown" | "none" | "fallback" | "success" | "unverified";

/** A responsive worker or a completed fallback is not proof of a successful model result. */
export function getLocalAiAnalysisState(history: LocalAiHistory | null | undefined): LocalAiAnalysisState {
  if (!history) return "unknown";
  if (!history.last_analysis_completed_at) return "none";
  if (history.last_analysis_llm_fallback === true) return "fallback";
  const latest = Date.parse(history.last_analysis_completed_at);
  return history.last_analysis_llm_fallback === false && Number.isFinite(latest)
    && history.last_analysis_source === "local_llm_rewrite"
    ? "success"
    : "unverified";
}

const STATE_LABELS: Record<AppLanguage, Record<LocalAiAnalysisState, string>> = {
  ko: {
    unknown: "최근 자동 브리핑 상태 확인 불가",
    none: "자동 브리핑 처리 기록 없음",
    fallback: "최근 자동 브리핑: 계산 결과로 대체",
    success: "최근 자동 브리핑: AI 설명 성공",
    unverified: "최근 자동 브리핑: AI 성공 확인 안 됨",
  },
  zh: {
    unknown: "无法确认最近自动简报状态",
    none: "暂无自动简报处理记录",
    fallback: "最近自动简报：使用计算结果替代",
    success: "最近自动简报：AI 说明成功",
    unverified: "最近自动简报：AI 成功状态未确认",
  },
};

const FALLBACK_REASONS: Record<AppLanguage, Record<string, string>> = {
  ko: {
    grounding_rejected: "수치 검증 실패", llm_disabled: "AI 사용 중지", model_unavailable: "모델 연결 불가",
    timeout: "AI 응답 시간 초과", invalid_response: "응답 형식 오류", model_error: "모델 처리 오류",
  },
  zh: {
    grounding_rejected: "数值校验失败", llm_disabled: "AI 已停用", model_unavailable: "无法连接模型",
    timeout: "AI 响应超时", invalid_response: "响应格式错误", model_error: "模型处理错误",
  },
};

export function describeLocalAiHistory(history: LocalAiHistory | null | undefined, language: AppLanguage) {
  const state = getLocalAiAnalysisState(history);
  const reason = state === "fallback" ? FALLBACK_REASONS[language][history?.last_analysis_fallback_code ?? ""] ?? "" : "";
  return { state, label: STATE_LABELS[language][state], reason };
}
