import { useMemo, useState } from "react";
import {
  type InjectionDowntimeConfirmation,
  type InjectionDowntimeReasonCode,
  type InjectionDowntimeResolution,
  type SaveInjectionDowntimeConfirmationPayload,
} from "@/domains/production/api";
import {
  type InjectionTransitionAnalysis,
  type InjectionTransitionEvent,
  type InjectionTransitionEventType,
  type InjectionTransitionFlag,
} from "@/domains/production/injection-transition-analysis";
import { type AppLanguage } from "@/shared/i18n/language";

export type InjectionTransitionPanelCopy = {
  transitionEyebrow: string;
  transitionTitle: string;
  moldChangeEstimate: string;
  coreChangeEstimate: string;
  productionStopEstimate: string;
  tuningEstimate: string;
  requiresInjectionNote: string;
  noTransitionEvents: string;
  stableStart: string;
  fromTo: string;
  producedBeforeStop: string;
  targetWorkOrder: string;
  overproductionFlag: string;
  advanceProductionFlag: string;
  planDate: string;
  outputQty: string;
};

type PanelMode = "dashboard" | "review";
type ReviewFilter = "all" | "pending" | "confirmed";
type ConfirmationLoadState = "loading" | "ready" | "error";

type InjectionTransitionPanelProps = {
  analysis: InjectionTransitionAnalysis;
  copy: InjectionTransitionPanelCopy;
  language: AppLanguage;
  confirmations?: InjectionDowntimeConfirmation[];
  confirmationState?: ConfirmationLoadState;
  mode?: PanelMode;
  canConfirm?: boolean;
  machineKey?: string | number | null;
  compact?: boolean;
  onSaveConfirmation?: (payload: SaveInjectionDowntimeConfirmationPayload) => Promise<unknown>;
  onResetConfirmation?: (eventKey: string) => Promise<unknown>;
};

type TransitionDisplayRow = {
  eventKey: string;
  machineKey: string;
  machineLabel: string;
  type: InjectionTransitionEventType;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  event?: InjectionTransitionEvent;
  confirmation?: InjectionDowntimeConfirmation;
};

const workflowCopy = {
  ko: {
    source: "MES 10분 이상 무형합 자동 후보 · 사출 담당자/과장 현장 확정 기준",
    detected: "자동 감지",
    confirmed: "현장 확정",
    pending: "확인 대기",
    dismissed: "정지 아님",
    confirmedDowntime: "확정 정지시간",
    ongoingIncluded: "진행 중 포함",
    pendingStatus: "확인 대기 중",
    confirmedStatus: "확정",
    dismissedStatus: "제외",
    queueTitle: "정지 원인 검토",
    dashboardTitle: "확정 원인 및 확인 대기",
    latestConfirmation: "최근 확정",
    all: "전체",
    pendingOnly: "확인 대기",
    confirmedOnly: "처리 완료",
    status: "상태",
    machineTime: "설비 · 구간",
    automaticDecision: "자동 판정",
    workContext: "생산 맥락",
    fieldConfirmation: "현장 확인",
    action: "처리",
    automaticEstimate: "자동 추정",
    ongoing: "감지 진행 중",
    confidenceHigh: "근거 높음",
    confidenceMedium: "근거 보통",
    confidenceLow: "근거 낮음",
    review: "확인",
    edit: "수정",
    noPermission: "조회 전용",
    reviewTitle: "정지 원인 확정",
    resolution: "판정",
    confirmedDowntimeChoice: "정지 원인 확정",
    dismissedChoice: "정지 아님",
    reason: "확정 원인",
    note: "확인 메모",
    notePlaceholder: "현장 확인 내용 또는 조치 사항",
    save: "확정 저장",
    saving: "저장 중",
    reset: "확정 취소",
    cancel: "닫기",
    saveError: "확정 기록을 저장하지 못했습니다.",
    loadingConfirmations: "현장 확정 기록을 불러오는 중입니다.",
    confirmationsUnavailable: "현장 확정 기록을 불러오지 못했습니다. 자동 후보를 미확정으로 집계하지 않습니다.",
    otherNoteRequired: "기타 원인은 확인 메모가 필요합니다.",
    confirmedBy: "확정",
    showAll: "전체 보기",
    collapse: "접기",
    operationalFlags: "추가 운영 확인",
    noReasonSummary: "확정된 정지 원인이 없습니다.",
  },
  zh: {
    source: "MES 10分钟以上无合模自动候选 · 注塑负责人/主管现场确认口径",
    detected: "自动识别",
    confirmed: "现场确认",
    pending: "待确认",
    dismissed: "非停机",
    confirmedDowntime: "已确认停机时间",
    ongoingIncluded: "含进行中",
    pendingStatus: "等待确认",
    confirmedStatus: "已确认",
    dismissedStatus: "已排除",
    queueTitle: "停机原因审核",
    dashboardTitle: "确认原因与待确认事项",
    latestConfirmation: "最近确认",
    all: "全部",
    pendingOnly: "待确认",
    confirmedOnly: "已处理",
    status: "状态",
    machineTime: "设备 · 时段",
    automaticDecision: "自动判断",
    workContext: "生产信息",
    fieldConfirmation: "现场确认",
    action: "处理",
    automaticEstimate: "自动推定",
    ongoing: "识别进行中",
    confidenceHigh: "依据较强",
    confidenceMedium: "依据一般",
    confidenceLow: "依据较弱",
    review: "确认",
    edit: "修改",
    noPermission: "只读",
    reviewTitle: "确认停机原因",
    resolution: "判断",
    confirmedDowntimeChoice: "确认停机原因",
    dismissedChoice: "非停机",
    reason: "确认原因",
    note: "确认备注",
    notePlaceholder: "现场确认内容或处理事项",
    save: "保存确认",
    saving: "保存中",
    reset: "取消确认",
    cancel: "关闭",
    saveError: "无法保存确认记录。",
    loadingConfirmations: "正在加载现场确认记录。",
    confirmationsUnavailable: "无法加载现场确认记录。自动候选不会计入待确认。",
    otherNoteRequired: "选择其他原因时必须填写确认备注。",
    confirmedBy: "确认",
    showAll: "查看全部",
    collapse: "收起",
    operationalFlags: "其他运营确认",
    noReasonSummary: "暂无已确认停机原因。",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

const reasonLabels: Record<InjectionDowntimeReasonCode, Record<AppLanguage, string>> = {
  mold_change: { ko: "금형 교체", zh: "换模" },
  core_change: { ko: "코어 교체", zh: "更换镶块" },
  tuning: { ko: "사출 조건 조정", zh: "调机" },
  mechanical_failure: { ko: "설비 고장", zh: "设备故障" },
  mold_issue: { ko: "금형 이상", zh: "模具异常" },
  material_wait: { ko: "원재료 대기", zh: "待料" },
  quality_check: { ko: "품질 확인", zh: "品质确认" },
  planned_stop: { ko: "계획 정지", zh: "计划停机" },
  staffing: { ko: "작업자·교대", zh: "人员·交接" },
  other: { ko: "기타", zh: "其他" },
  not_stop: { ko: "정지 아님", zh: "非停机" },
};

const selectableReasonCodes = Object.keys(reasonLabels).filter(
  (reason): reason is Exclude<InjectionDowntimeReasonCode, "not_stop"> => reason !== "not_stop",
);

function formatNumber(value: number) {
  return Math.round(value).toLocaleString();
}

function formatMachineLabel(value: string, language: AppLanguage) {
  if (language !== "zh") return value;
  return value.replace(/호기/g, "号机");
}

function formatDuration(minutes: number, language: AppLanguage) {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;
  if (language === "zh") {
    if (hours > 0 && remainingMinutes > 0) return `${hours}小时 ${remainingMinutes}分`;
    if (hours > 0) return `${hours}小时`;
    return `${remainingMinutes}分`;
  }
  if (hours > 0 && remainingMinutes > 0) return `${hours}시간 ${remainingMinutes}분`;
  if (hours > 0) return `${hours}시간`;
  return `${remainingMinutes}분`;
}

function formatTime(value: string, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatTimeRange(row: TransitionDisplayRow, language: AppLanguage) {
  return `${formatTime(row.startTime, language)} ~ ${formatTime(row.endTime, language)}`;
}

function formatConfirmationTime(value: string, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function getPartLabel(record: InjectionTransitionEvent["targetRecord"]) {
  if (!record) return "-";
  const partNo = record.part_no || record.model_name || record.part_spec || "-";
  const model = record.model_name && record.model_name !== partNo ? ` · ${record.model_name}` : "";
  return `${partNo}${model}`;
}

function getEventLabel(type: InjectionTransitionEventType, copy: InjectionTransitionPanelCopy) {
  if (type === "mold_change") return copy.moldChangeEstimate;
  if (type === "core_change") return copy.coreChangeEstimate;
  if (type === "tuning") return copy.tuningEstimate;
  return copy.productionStopEstimate;
}

function getEventEvidence(event: InjectionTransitionEvent, copy: InjectionTransitionPanelCopy, language: AppLanguage) {
  if (event.type === "mold_change" || event.type === "core_change") {
    return `${copy.producedBeforeStop} ${formatNumber(event.evidence.cumulativeQtyAtStop)} / ${formatNumber(event.evidence.completedPlanQty ?? 0)}`;
  }
  if (event.type === "tuning") {
    return event.stableStartTime
      ? `${copy.stableStart} ${formatTime(event.stableStartTime, language)}`
      : copy.requiresInjectionNote;
  }
  return `${copy.producedBeforeStop} ${formatNumber(event.evidence.producedForTargetQty ?? event.evidence.runOutputQty)} / ${formatNumber(event.evidence.targetPlanQty ?? 0)}`;
}

function getEventTarget(event: InjectionTransitionEvent, copy: InjectionTransitionPanelCopy) {
  if (event.fromRecord || event.toRecord) {
    return `${copy.fromTo} ${getPartLabel(event.fromRecord)} → ${getPartLabel(event.toRecord)}`;
  }
  return `${copy.targetWorkOrder} ${getPartLabel(event.targetRecord)}`;
}

function getStoredTarget(confirmation: InjectionDowntimeConfirmation, copy: InjectionTransitionPanelCopy) {
  const fromPartNo = String(confirmation.evidence.from_part_no ?? "");
  const toPartNo = String(confirmation.evidence.to_part_no ?? "");
  const targetPartNo = String(confirmation.evidence.target_part_no ?? "");
  if (fromPartNo || toPartNo) return `${copy.fromTo} ${fromPartNo || "-"} → ${toPartNo || "-"}`;
  return `${copy.targetWorkOrder} ${targetPartNo || "-"}`;
}

function getFlagLabel(flag: InjectionTransitionFlag, copy: InjectionTransitionPanelCopy) {
  if (flag.type === "overproduction_check") {
    const produced = formatNumber(flag.evidence.producedQty ?? 0);
    const planned = formatNumber(flag.evidence.plannedQty ?? 0);
    return `${copy.overproductionFlag} ${produced} / ${planned}`;
  }

  const planDate = flag.planDate ? ` · ${copy.planDate} ${flag.planDate}` : "";
  const outputQty = flag.evidence.outputQty ? ` · ${copy.outputQty} ${formatNumber(flag.evidence.outputQty)}` : "";
  return `${copy.advanceProductionFlag}${planDate}${outputQty}`;
}

function getDefaultReason(type: InjectionTransitionEventType): InjectionDowntimeReasonCode {
  if (type === "mold_change") return "mold_change";
  if (type === "core_change") return "core_change";
  if (type === "tuning") return "tuning";
  return "mechanical_failure";
}

function getRowStatus(row: TransitionDisplayRow) {
  if (row.confirmation?.resolution === "confirmed") return "confirmed" as const;
  if (row.confirmation?.resolution === "dismissed") return "dismissed" as const;
  return "pending" as const;
}

function buildConfirmationEvidence(row: TransitionDisplayRow) {
  if (!row.event) return row.confirmation?.evidence ?? {};
  return {
    ...row.event.evidence,
    from_part_no: row.event.fromRecord?.part_no ?? "",
    to_part_no: row.event.toRecord?.part_no ?? "",
    target_part_no: row.event.targetRecord?.part_no ?? "",
    confidence: row.event.confidence,
    auto_status: row.event.status,
  };
}

export function InjectionTransitionPanel({
  analysis,
  copy,
  language,
  confirmations = [],
  confirmationState = "ready",
  mode = "dashboard",
  canConfirm = false,
  machineKey,
  compact = false,
  onSaveConfirmation,
  onResetConfirmation,
}: InjectionTransitionPanelProps) {
  const workflow = workflowCopy[language];
  const selectedMachineKey = machineKey === undefined || machineKey === null ? null : String(machineKey);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const [selectedRow, setSelectedRow] = useState<TransitionDisplayRow | null>(null);
  const [resolution, setResolution] = useState<InjectionDowntimeResolution>("confirmed");
  const [reasonCode, setReasonCode] = useState<InjectionDowntimeReasonCode>("mechanical_failure");
  const [note, setNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const confirmationReady = confirmationState === "ready";

  const visibleEvents = useMemo(
    () => analysis.events.filter((event) => !selectedMachineKey || event.machineKey === selectedMachineKey),
    [analysis.events, selectedMachineKey],
  );
  const visibleConfirmations = useMemo(
    () => confirmations.filter((confirmation) => !selectedMachineKey || confirmation.machine_key === selectedMachineKey),
    [confirmations, selectedMachineKey],
  );
  const rows = useMemo(() => {
    const confirmationMap = new Map(visibleConfirmations.map((confirmation) => [confirmation.event_key, confirmation]));
    const eventKeys = new Set(visibleEvents.map((event) => event.eventKey));
    const nextRows: TransitionDisplayRow[] = visibleEvents.map((event) => ({
      eventKey: event.eventKey,
      machineKey: event.machineKey,
      machineLabel: event.machineLabel,
      type: event.type,
      startTime: event.startTime,
      endTime: event.endTime,
      durationMinutes: event.durationMinutes,
      event,
      confirmation: confirmationMap.get(event.eventKey),
    }));

    visibleConfirmations.forEach((confirmation) => {
      if (eventKeys.has(confirmation.event_key)) return;
      nextRows.push({
        eventKey: confirmation.event_key,
        machineKey: confirmation.machine_key,
        machineLabel: confirmation.machine_label,
        type: confirmation.detected_type,
        startTime: confirmation.detected_start,
        endTime: confirmation.detected_end,
        durationMinutes: confirmation.duration_minutes,
        confirmation,
      });
    });

    const statusRank = mode === "review"
      ? { pending: 0, confirmed: 1, dismissed: 2 }
      : { confirmed: 0, pending: 1, dismissed: 2 };
    return nextRows.sort((left, right) => {
      const rankDiff = statusRank[getRowStatus(left)] - statusRank[getRowStatus(right)];
      if (rankDiff !== 0) return rankDiff;
      return new Date(right.startTime).getTime() - new Date(left.startTime).getTime();
    });
  }, [mode, visibleConfirmations, visibleEvents]);

  const confirmedRows = rows.filter((row) => getRowStatus(row) === "confirmed");
  const dismissedRows = rows.filter((row) => getRowStatus(row) === "dismissed");
  const pendingRows = rows.filter((row) => getRowStatus(row) === "pending");
  const confirmedMinutes = confirmedRows.reduce((sum, row) => sum + row.durationMinutes, 0);
  const confirmedOngoingCount = confirmedRows.filter((row) => row.event?.status === "ongoing").length;
  const latestConfirmation = visibleConfirmations
    .map((confirmation) => confirmation.confirmed_at)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];
  const reasonSummary = (() => {
    const summary = new Map<InjectionDowntimeReasonCode, { count: number; minutes: number }>();
    confirmedRows.forEach((row) => {
      const reason = row.confirmation?.reason_code;
      if (!reason || reason === "not_stop") return;
      const current = summary.get(reason) ?? { count: 0, minutes: 0 };
      current.count += 1;
      current.minutes += row.durationMinutes;
      summary.set(reason, current);
    });
    return [...summary.entries()].sort((left, right) => right[1].minutes - left[1].minutes);
  })();
  const visibleFlags = analysis.machines
    .filter((machine) => !selectedMachineKey || machine.machineKey === selectedMachineKey)
    .flatMap((machine) => machine.flags);
  const filteredRows = rows.filter((row) => {
    if (mode === "dashboard" && getRowStatus(row) === "dismissed") return false;
    if (!confirmationReady) return true;
    if (reviewFilter === "pending") return getRowStatus(row) === "pending";
    if (reviewFilter === "confirmed") return getRowStatus(row) !== "pending";
    return true;
  });
  const rowLimit = compact ? 6 : 10;
  const renderedRows = showAll ? filteredRows : filteredRows.slice(0, rowLimit);

  function openReview(row: TransitionDisplayRow) {
    const existing = row.confirmation;
    setSelectedRow(row);
    setResolution(existing?.resolution ?? "confirmed");
    setReasonCode(existing?.reason_code && existing.reason_code !== "not_stop" ? existing.reason_code : getDefaultReason(row.type));
    setNote(existing?.note ?? "");
    setSaveError(null);
  }

  async function submitReview() {
    if (!selectedRow || !onSaveConfirmation) return;
    if (resolution === "confirmed" && reasonCode === "other" && !note.trim()) {
      setSaveError(workflow.otherNoteRequired);
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSaveConfirmation({
        business_date: analysis.businessDate,
        event_key: selectedRow.eventKey,
        machine_key: selectedRow.machineKey,
        machine_label: selectedRow.machineLabel,
        detected_type: selectedRow.type,
        detected_start: selectedRow.startTime,
        detected_end: selectedRow.endTime,
        duration_minutes: Math.max(0, Math.round(selectedRow.durationMinutes)),
        resolution,
        reason_code: resolution === "dismissed" ? "not_stop" : reasonCode,
        note: note.trim(),
        evidence: buildConfirmationEvidence(selectedRow),
      });
      setSelectedRow(null);
    } catch {
      setSaveError(workflow.saveError);
    } finally {
      setIsSaving(false);
    }
  }

  async function resetReview() {
    if (!selectedRow?.confirmation || !onResetConfirmation) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await onResetConfirmation(selectedRow.eventKey);
      setSelectedRow(null);
    } catch {
      setSaveError(workflow.saveError);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className={`panel injection-transition-panel injection-transition-panel--${mode}${compact ? " injection-transition-panel--compact" : ""}`}>
      <div className="injection-transition-panel__header">
        <div>
          <p className="panel-card__eyebrow">{copy.transitionEyebrow}</p>
          <h3 className="panel__title">{copy.transitionTitle}</h3>
          <p>{workflow.source}</p>
        </div>
        {latestConfirmation ? (
          <span className="injection-transition-panel__freshness">
            {workflow.latestConfirmation} {formatConfirmationTime(latestConfirmation, language)}
          </span>
        ) : null}
      </div>

      {confirmationState !== "ready" ? (
        <div className={`injection-transition-data-state injection-transition-data-state--${confirmationState}`}>
          {confirmationState === "loading" ? workflow.loadingConfirmations : workflow.confirmationsUnavailable}
        </div>
      ) : null}

      <div className="injection-transition-summary">
        <div>
          <span>{workflow.detected}</span>
          <strong>{formatNumber(rows.length)}</strong>
        </div>
        <div className="injection-transition-summary__confirmed">
          <span>{workflow.confirmed}</span>
          <strong>{confirmationReady ? formatNumber(confirmedRows.length) : "-"}</strong>
        </div>
        <div className="injection-transition-summary__pending">
          <span>{workflow.pending}</span>
          <strong>{confirmationReady ? formatNumber(pendingRows.length) : "-"}</strong>
        </div>
        <div>
          <span>
            {workflow.confirmedDowntime}
            {confirmationReady && confirmedOngoingCount ? ` · ${workflow.ongoingIncluded} ${confirmedOngoingCount}` : ""}
          </span>
          <strong>{confirmationReady ? formatDuration(confirmedMinutes, language) : "-"}</strong>
        </div>
      </div>

      <div className="injection-transition-reason-strip" aria-label={workflow.confirmedDowntime}>
        {!confirmationReady ? (
          <small>{confirmationState === "loading" ? workflow.loadingConfirmations : workflow.confirmationsUnavailable}</small>
        ) : reasonSummary.length ? reasonSummary.map(([reason, summary]) => (
          <span key={reason}>
            <i />
            <strong>{reasonLabels[reason][language]}</strong>
            {summary.count} · {formatDuration(summary.minutes, language)}
          </span>
        )) : <small>{workflow.noReasonSummary}</small>}
        {dismissedRows.length ? <span className="injection-transition-reason-strip__dismissed">{workflow.dismissed} {dismissedRows.length}</span> : null}
      </div>

      <div className="injection-transition-toolbar">
        <div>
          <strong>{mode === "review" ? workflow.queueTitle : workflow.dashboardTitle}</strong>
          <span>
            {confirmationReady
              ? `${workflow.pending} ${pendingRows.length} · ${workflow.confirmed} ${confirmedRows.length}`
              : (confirmationState === "loading" ? workflow.loadingConfirmations : workflow.confirmationsUnavailable)}
          </span>
        </div>
        {mode === "review" ? (
          <div className="injection-transition-filter" role="group" aria-label={workflow.status}>
            {([
              ["all", workflow.all],
              ["pending", workflow.pendingOnly],
              ["confirmed", workflow.confirmedOnly],
            ] as Array<[ReviewFilter, string]>).map(([value, label]) => (
              <button
                className={reviewFilter === value ? "is-active" : ""}
                disabled={!confirmationReady}
                key={value}
                onClick={() => {
                  setReviewFilter(value);
                  setShowAll(false);
                }}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {renderedRows.length ? (
        <div className={`injection-transition-table${mode === "review" ? " injection-transition-table--review" : ""}`}>
          <div className="injection-transition-table__head" aria-hidden="true">
            <span>{workflow.status}</span>
            <span>{workflow.machineTime}</span>
            <span>{workflow.automaticDecision}</span>
            <span>{workflow.workContext}</span>
            <span>{workflow.fieldConfirmation}</span>
            {mode === "review" ? <span>{workflow.action}</span> : null}
          </div>
          <div className="injection-transition-table__body">
            {renderedRows.map((row) => {
              const status = row.confirmation
                ? getRowStatus(row)
                : confirmationReady
                  ? "pending"
                  : "unavailable";
              const confidenceLabel = row.event?.confidence === "high"
                ? workflow.confidenceHigh
                : row.event?.confidence === "low"
                  ? workflow.confidenceLow
                  : workflow.confidenceMedium;
              return (
                <div className={`injection-transition-row injection-transition-row--${status}`} key={row.eventKey}>
                  <div>
                    <span className={`injection-transition-status injection-transition-status--${status}`}>
                      {status === "confirmed" ? workflow.confirmedStatus : status === "dismissed" ? workflow.dismissedStatus : workflow.pendingStatus}
                    </span>
                  </div>
                  <div className="injection-transition-row__machine">
                    <strong>{formatMachineLabel(row.machineLabel, language)}</strong>
                    <span>{formatTimeRange(row, language)} · {formatDuration(row.durationMinutes, language)}</span>
                  </div>
                  <div className="injection-transition-row__decision">
                    <strong>{workflow.automaticEstimate} · {getEventLabel(row.type, copy)}</strong>
                    <span>{row.event?.status === "ongoing" ? workflow.ongoing : confidenceLabel}</span>
                    {row.event ? <small>{getEventEvidence(row.event, copy, language)}</small> : null}
                  </div>
                  <div className="injection-transition-row__context">
                    {row.event ? getEventTarget(row.event, copy) : row.confirmation ? getStoredTarget(row.confirmation, copy) : "-"}
                  </div>
                  <div className="injection-transition-row__confirmation">
                    {row.confirmation ? (
                      <>
                        <strong>{reasonLabels[row.confirmation.reason_code][language]}</strong>
                        {row.confirmation.note ? <span>{row.confirmation.note}</span> : null}
                        <small>
                          {workflow.confirmedBy} {row.confirmation.confirmed_by_name || "-"} · {formatConfirmationTime(row.confirmation.confirmed_at, language)}
                        </small>
                      </>
                    ) : confirmationReady ? (
                      <strong className="injection-transition-row__pending-text">{workflow.pendingStatus}</strong>
                    ) : (
                      <strong className="injection-transition-row__unavailable-text">
                        {confirmationState === "loading" ? workflow.loadingConfirmations : workflow.confirmationsUnavailable}
                      </strong>
                    )}
                  </div>
                  {mode === "review" ? (
                    <div className="injection-transition-row__action">
                      {!confirmationReady ? (
                        <span>{confirmationState === "loading" ? workflow.loadingConfirmations : workflow.confirmationsUnavailable}</span>
                      ) : canConfirm && onSaveConfirmation ? (
                        <button className="button button--ghost" onClick={() => openReview(row)} type="button">
                          {row.confirmation ? workflow.edit : workflow.review}
                        </button>
                      ) : <span>{workflow.noPermission}</span>}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {filteredRows.length > rowLimit ? (
            <button className="injection-transition-more" onClick={() => setShowAll((value) => !value)} type="button">
              {showAll ? workflow.collapse : `${workflow.showAll} ${filteredRows.length}`}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="injection-transition-empty">{copy.noTransitionEvents}</div>
      )}

      {visibleFlags.length ? (
        <div className="injection-transition-operational-flags">
          <strong>{workflow.operationalFlags}</strong>
          <div>
            {visibleFlags.map((flag) => (
              <span className={`injection-transition-flag injection-transition-flag--${flag.type}`} key={flag.id}>
                <b>{formatMachineLabel(flag.machineLabel, language)}</b>
                {getFlagLabel(flag, copy)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {selectedRow ? (
        <div className="modal-backdrop" role="presentation" onClick={() => !isSaving && setSelectedRow(null)}>
          <section
            aria-modal="true"
            className="modal-card injection-transition-review-modal"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="panel-card__eyebrow">{workflow.queueTitle}</p>
                <h3 className="panel__title">{workflow.reviewTitle}</h3>
                <p>{formatMachineLabel(selectedRow.machineLabel, language)} · {formatTimeRange(selectedRow, language)} · {formatDuration(selectedRow.durationMinutes, language)}</p>
              </div>
              <button className="button button--ghost" disabled={isSaving} onClick={() => setSelectedRow(null)} type="button">
                {workflow.cancel}
              </button>
            </div>

            <div className="injection-transition-review-context">
              <div>
                <span>{workflow.automaticDecision}</span>
                <strong>{getEventLabel(selectedRow.type, copy)}</strong>
              </div>
              <div>
                <span>{workflow.workContext}</span>
                <strong>{selectedRow.event ? getEventTarget(selectedRow.event, copy) : selectedRow.confirmation ? getStoredTarget(selectedRow.confirmation, copy) : "-"}</strong>
              </div>
            </div>

            <div className="field-group">
              <span>{workflow.resolution}</span>
              <div className="injection-transition-resolution" role="group" aria-label={workflow.resolution}>
                <button
                  className={resolution === "confirmed" ? "is-active" : ""}
                  onClick={() => setResolution("confirmed")}
                  type="button"
                >
                  {workflow.confirmedDowntimeChoice}
                </button>
                <button
                  className={resolution === "dismissed" ? "is-active" : ""}
                  onClick={() => setResolution("dismissed")}
                  type="button"
                >
                  {workflow.dismissedChoice}
                </button>
              </div>
            </div>

            {resolution === "confirmed" ? (
              <label className="field-group">
                <span>{workflow.reason}</span>
                <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as InjectionDowntimeReasonCode)}>
                  {selectableReasonCodes.map((reason) => (
                    <option key={reason} value={reason}>{reasonLabels[reason][language]}</option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="field-group">
              <span>{workflow.note}</span>
              <textarea
                onChange={(event) => setNote(event.target.value)}
                placeholder={workflow.notePlaceholder}
                rows={3}
                value={note}
              />
            </label>
            {saveError ? <div className="notice notice--error">{saveError}</div> : null}

            <div className="injection-transition-review-modal__actions">
              {selectedRow.confirmation && onResetConfirmation ? (
                <button className="button button--ghost" disabled={isSaving} onClick={() => void resetReview()} type="button">
                  {workflow.reset}
                </button>
              ) : <span />}
              <button className="button button--primary" disabled={isSaving} onClick={() => void submitReview()} type="button">
                {isSaving ? workflow.saving : workflow.save}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
