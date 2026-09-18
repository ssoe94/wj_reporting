import { useEffect, useState } from "react";
import { isAxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchLatestDeepAnalysis,
  getAiJob,
  requestDeepAnalysis,
  type AiJob,
  type DeepAnalysisFinding,
  type DeepAnalysisKind,
  type DeepAnalysisResultPayload,
} from "@/domains/production/api";
import { describeAiModel, getAiTierLabel, withAiModelName } from "@/domains/ai/model-labels";
import type { AppLanguage } from "@/shared/i18n/language";

const DEEP_ANALYSIS_REFRESH_INTERVAL_MS = 60_000;
const DEEP_ANALYSIS_REQUEST_POLL_INTERVAL_MS = 5_000;
const ACTIVE_JOB_STATUSES = new Set<AiJob["status"]>(["pending", "claimed", "running"]);

const COPY = {
  ko: {
    eyebrow: "DEEP ANALYSIS",
    period: "분석 기간",
    generatedAt: "생성",
    model: "모델",
    summary: "요약",
    findings: "주요 발견",
    evidence: "근거",
    actions: "권장 조치",
    caveats: "해석 유의사항",
    none: "아직 생성된 심층 분석이 없습니다.",
    noneHint: "주간 심층 분석은 매주 첫 영업일에 자동으로 요청됩니다.",
    queued: "심층 분석 대기 중",
    queuedHint: "요청이 대기열에 등록되어 있습니다. 심층 분석 워커가 연결되면 처리되며, 완료되면 자동으로 표시됩니다.",
    generating: "심층 분석 생성 중",
    generatingHint: "분석 워커가 요청을 처리하고 있습니다. 완료되면 자동으로 표시됩니다.",
    loadFailed: "심층 분석 결과를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.",
    lastAttemptFailed: "최근 심층 분석 요청이 처리되지 못했습니다.",
    fallbackTitle: "심층 분석 검증 보류",
    fallbackHint: "AI 초안이 서버 검증을 통과하지 못해 표시하지 않습니다.",
    reason: "사유",
    request: "심층 분석 요청",
    requesting: "요청 중",
    requestAccepted: "심층 분석 요청을 등록했습니다.",
    requestRateLimited: "심층 분석 요청이 너무 잦습니다. 잠시 후 다시 요청해 주세요.",
    requestFailed: "심층 분석 요청을 등록하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    fallbackReasons: {
      grounding_rejected: "결과의 수치가 서버 근거와 일치하지 않음",
      input_too_large: "입력 데이터가 허용 범위를 초과함",
    } as Record<string, string>,
  },
  zh: {
    eyebrow: "DEEP ANALYSIS",
    period: "分析期间",
    generatedAt: "生成",
    model: "模型",
    summary: "摘要",
    findings: "主要发现",
    evidence: "依据",
    actions: "建议措施",
    caveats: "解读注意",
    none: "尚未生成深度分析。",
    noneHint: "每周深度分析会在每周第一个工作日自动请求。",
    queued: "深度分析排队中",
    queuedHint: "请求已进入队列，深度分析处理端连接后开始处理，完成后将自动显示。",
    generating: "深度分析生成中",
    generatingHint: "分析处理端正在处理请求，完成后将自动显示。",
    loadFailed: "无法读取深度分析结果，请稍后再试。",
    lastAttemptFailed: "最近一次深度分析请求未能处理。",
    fallbackTitle: "深度分析校验暂缓",
    fallbackHint: "AI 草稿未通过服务器校验，暂不显示。",
    reason: "原因",
    request: "请求深度分析",
    requesting: "请求中",
    requestAccepted: "已提交深度分析请求。",
    requestRateLimited: "深度分析请求过于频繁，请稍后再试。",
    requestFailed: "无法提交深度分析请求，请稍后重试。",
    fallbackReasons: {
      grounding_rejected: "结果数值与服务器依据不一致",
      input_too_large: "输入数据超出允许范围",
    } as Record<string, string>,
  },
} satisfies Record<AppLanguage, unknown>;

function formatDeepAnalysisTimestamp(value: string | null | undefined, language: AppLanguage) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readStringList(value: unknown) {
  return Array.isArray(value) ? value.map(readString).filter(Boolean) : [];
}

function readFindings(value: unknown): DeepAnalysisFinding[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        title: readString(record.title),
        statement: readString(record.statement),
        evidence_refs: readStringList(record.evidence_refs),
      };
    })
    .filter((finding) => finding.title || finding.statement);
}

function readPeriod(job: AiJob) {
  const result = job.result_payload as DeepAnalysisResultPayload;
  const period = result.period && typeof result.period === "object" ? result.period : {};
  const scope = job.scope ?? {};
  const start = readString(period.start) || readString(period.period_start) || readString(scope.period_start);
  const end = readString(period.end) || readString(period.period_end) || readString(scope.period_end);
  if (start && end) return `${start} ~ ${end}`;
  return start || end || "";
}

function getRequestError(error: unknown, language: AppLanguage) {
  const copy = COPY[language];
  if (isAxiosError(error)) {
    const status = error.response?.status ?? null;
    const data = error.response?.data;
    const code = data && typeof data === "object" ? readString((data as Record<string, unknown>).code) : "";
    if (status === 429 || code === "manual_ai_job_rate_limited") return copy.requestRateLimited;
  }
  return copy.requestFailed;
}

export type DeepAnalysisPanelProps = {
  kind: DeepAnalysisKind;
  language: AppLanguage;
  canRequest: boolean;
  /** Optional period end (YYYY-MM-DD) for a manual request; defaults to the previous full week. */
  date?: string;
};

/**
 * Shared "AI 심층 분석 / AI 深度分析" panel. Numbers come from server-owned facts; the panel only
 * displays the validated deep-analysis result and never computes production figures.
 */
export function DeepAnalysisPanel({ kind, language, canRequest, date }: DeepAnalysisPanelProps) {
  const copy = COPY[language];
  const queryClient = useQueryClient();
  const [requestedJobId, setRequestedJobId] = useState<number | null>(null);
  const [requestNotice, setRequestNotice] = useState<{ tone: "neutral" | "warning"; text: string } | null>(null);

  const latestQuery = useQuery({
    queryKey: ["ai-job", "deep-analysis", "latest", kind, language],
    queryFn: () => fetchLatestDeepAnalysis(kind, language),
    refetchInterval: DEEP_ANALYSIS_REFRESH_INTERVAL_MS,
    retry: 1,
  });
  const requestedJobQuery = useQuery({
    queryKey: ["ai-job", "deep-analysis", "requested", requestedJobId],
    queryFn: () => getAiJob(requestedJobId as number),
    enabled: requestedJobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && !ACTIVE_JOB_STATUSES.has(status) ? false : DEEP_ANALYSIS_REQUEST_POLL_INTERVAL_MS;
    },
    retry: 1,
  });
  const requestMutation = useMutation({
    mutationFn: () => requestDeepAnalysis(kind, language, date),
    onMutate: () => setRequestNotice(null),
    onSuccess: (job) => {
      setRequestedJobId(job.id);
      setRequestNotice({ tone: "neutral", text: copy.requestAccepted });
    },
    onError: (error) => setRequestNotice({ tone: "warning", text: getRequestError(error, language) }),
  });

  const requestedJobStatus = requestedJobQuery.data?.status ?? (requestedJobId !== null ? "pending" : null);
  const requestedJobFailedToLoad = requestedJobId !== null && requestedJobQuery.isError;
  useEffect(() => {
    if (requestedJobId === null) return;
    // Stop tracking once the job is terminal, or when it can no longer be read
    // (otherwise a persistent 403/404 would poll forever and keep the panel "generating").
    if (!requestedJobFailedToLoad && (!requestedJobStatus || ACTIVE_JOB_STATUSES.has(requestedJobStatus))) return;
    setRequestedJobId(null);
    void queryClient.invalidateQueries({ queryKey: ["ai-job", "deep-analysis", "latest", kind, language] });
  }, [kind, language, queryClient, requestedJobFailedToLoad, requestedJobId, requestedJobStatus]);

  useEffect(() => {
    setRequestedJobId(null);
    setRequestNotice(null);
  }, [kind, language]);

  const latestJob = latestQuery.data?.job ?? null;
  const pendingJob = latestQuery.data?.pendingJob ?? null;
  const failedJob = latestQuery.data?.failedJob ?? null;
  // "generating" means a worker has claimed the job; a merely pending job is
  // queued and may wait indefinitely while the deep-tier worker is offline, so
  // it must not be presented as work in progress nor block a staff request.
  const activeStatuses = [
    requestedJobId !== null ? requestedJobStatus : null,
    pendingJob?.status ?? null,
    latestJob?.status ?? null,
  ].filter((status): status is AiJob["status"] => Boolean(status && ACTIVE_JOB_STATUSES.has(status)));
  const isGenerating = activeStatuses.some((status) => status !== "pending");
  const isQueued = !isGenerating && activeStatuses.length > 0;
  const ownRequestActive = requestedJobId !== null && requestedJobStatus !== null && ACTIVE_JOB_STATUSES.has(requestedJobStatus);
  const completedJob = latestJob && latestJob.status === "completed" ? latestJob : null;
  const result = (completedJob?.result_payload ?? {}) as DeepAnalysisResultPayload;
  const modelDisplayName = completedJob
    ? describeAiModel({
      modelId: readString(result.model_id) || readString(completedJob.scope?.model_id),
      modelName: completedJob.model_name,
      modelDisplayName: completedJob.model_display_name,
    }).displayName
    : "";
  const tierLabel = getAiTierLabel("deep", language);
  const isFallback = completedJob !== null && result.llm_fallback === true;
  const fallbackCode = readString(result.llm_fallback_code);
  const fallbackReason = fallbackCode ? (copy.fallbackReasons[fallbackCode] ?? fallbackCode) : "";
  const summary = readString(result.summary);
  const findings = readFindings(result.findings);
  const actions = readStringList(result.actions);
  const caveats = readStringList(result.caveats);
  const period = completedJob ? readPeriod(completedJob) : "";
  const requestDisabled = requestMutation.isPending || isGenerating || ownRequestActive;
  const stateLabel = isGenerating ? copy.generating : isQueued ? copy.queued : isFallback ? copy.fallbackTitle : null;
  const stateClass = isGenerating || isQueued ? "" : " production-ai-worker-status__pill--llm-unavailable";

  return (
    <section aria-label={tierLabel} className="panel production-brief-panel deep-analysis-panel">
      <div className="production-brief-panel__header">
        <div>
          <p className="panel-card__eyebrow">{copy.eyebrow}</p>
          <h3 className="panel__title">{withAiModelName(tierLabel, modelDisplayName)}</h3>
        </div>
        <div className="production-ai-worker-status__states">
          {stateLabel ? (
            <span className={`production-ai-worker-status__pill${stateClass}`} role="status">
              {stateLabel}
            </span>
          ) : null}
          {canRequest ? (
            <button
              className="button button--ghost"
              disabled={requestDisabled}
              onClick={() => requestMutation.mutate()}
              type="button"
            >
              {requestMutation.isPending ? copy.requesting : copy.request}
            </button>
          ) : null}
        </div>
      </div>

      {requestNotice ? (
        <div className={`notice notice--${requestNotice.tone}`} role="status">{requestNotice.text}</div>
      ) : null}

      <div className="production-brief-panel__body">
        {isGenerating ? (
          <p>{copy.generatingHint}</p>
        ) : isQueued ? (
          <p>{copy.queuedHint}</p>
        ) : failedJob ? (
          <div className="notice notice--warning" role="status">
            {copy.lastAttemptFailed}
            {readString(failedJob.error_message) ? ` ${copy.reason}: ${readString(failedJob.error_message)}` : ""}
          </div>
        ) : null}

        {!completedJob && !isGenerating && !isQueued ? (
          latestQuery.isError ? (
            <div className="notice notice--warning">{copy.loadFailed}</div>
          ) : latestQuery.isLoading ? null : (
            <>
              <p>{copy.none}</p>
              <span className="deep-analysis-panel__hint">{copy.noneHint}</span>
            </>
          )
        ) : null}

        {completedJob ? (
          <article className={`production-ai-job production-ai-job--${isFallback ? "failed" : "completed"}`}>
            <div className="production-ai-job__header">
              <div>
                <strong>{isFallback ? copy.fallbackTitle : tierLabel}</strong>
                <span>
                  {period ? `${copy.period}: ${period} · ` : ""}
                  {copy.generatedAt}: {formatDeepAnalysisTimestamp(completedJob.completed_at, language)}
                  {modelDisplayName ? ` · ${copy.model}: ${modelDisplayName}` : ""}
                </span>
              </div>
            </div>

            {isFallback ? (
              <div className="notice notice--warning">
                {copy.fallbackHint}
                {fallbackReason ? ` ${copy.reason}: ${fallbackReason}` : ""}
              </div>
            ) : (
              <>
                {summary ? (
                  <div className="production-ai-job__result">
                    <strong>{copy.summary}</strong>
                    {summary.split("\n\n").map((paragraph, index) => (
                      <p key={`${paragraph.slice(0, 24)}-${index}`}>{paragraph}</p>
                    ))}
                  </div>
                ) : null}

                {findings.length ? (
                  <div className="production-ai-job__result">
                    <strong>{copy.findings}</strong>
                    <div className="production-ai-job__issues">
                      {findings.map((finding, index) => (
                        <article className="production-ai-job__issue" key={`${finding.title}-${index}`}>
                          <strong>{finding.title || `${index + 1}`}</strong>
                          {finding.statement ? <p>{finding.statement}</p> : null}
                          {finding.evidence_refs.length ? (
                            <div aria-label={copy.evidence} className="deep-analysis-panel__refs">
                              {finding.evidence_refs.map((ref) => <code key={ref} title={ref}>{ref}</code>)}
                            </div>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}

                {actions.length ? (
                  <div className="production-ai-job__result">
                    <strong>{copy.actions}</strong>
                    <ol className="deep-analysis-panel__list">
                      {actions.map((action, index) => <li key={`${action.slice(0, 24)}-${index}`}>{action}</li>)}
                    </ol>
                  </div>
                ) : null}

                {caveats.length ? (
                  <div className="notice notice--neutral">
                    <strong>{copy.caveats}</strong>
                    <ul className="deep-analysis-panel__list">
                      {caveats.map((caveat, index) => <li key={`${caveat.slice(0, 24)}-${index}`}>{caveat}</li>)}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </article>
        ) : null}
      </div>
    </section>
  );
}
