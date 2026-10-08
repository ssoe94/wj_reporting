import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { useLang } from "@/i18n";
import type { InjectionDowntimeConfirmation, ProductionStatusResponse } from "@/domains/production/api";
import type { InjectionTransitionAnalysis } from "@/domains/production/injection-transition-analysis";
import type { RealtimeProgressRow, RealtimeProgressSummary } from "@/domains/production/realtime-progress";
import { getMesTaskReconciliation } from "@/domains/production/mes-task-reconciliation-api";
import { assessmentTone, reconciliationQueryOptions, type ReconciliationTask } from "@/domains/production/mes-task-reconciliation";
import {
  buildMachineBoardRows,
  INJECTION_MACHINE_COUNT,
  MACHINE_BOARD_GROUPS,
  type MachineBoardGroup,
  type MachineBoardRow,
  type MachineInspectionAttention,
} from "@/domains/production/injection-machine-board";
import {
  deriveInjectionQuality,
  reduceInjectionQuality,
  type ExpectedInjectionQualityScope,
  type InjectionQualityState,
  type InjectionQualityView,
  type QualityCheckStatus,
} from "@/domains/production/injection-quality-status";
import { injectionQualityAttention } from "@/domains/production/injection-quality-attention";
import { InjectionQualityStatus } from "@/domains/production/components/InjectionQualityStatus";
import { InjectionTransitionPanel, type InjectionTransitionPanelCopy } from "@/domains/production/components/InjectionTransitionPanel";
import type { AppLanguage } from "@/shared/i18n/language";
import "./injection-machine-board.css";

type BoardTab = "injection" | "machining";

type MachineQuality = {
  scope: ExpectedInjectionQualityScope;
  state: InjectionQualityState;
  view: InjectionQualityView;
};

const QUALITY_CLOCK_MS = 15_000;
const COLUMN_COUNT = 6;

type InjectionMachineBoardProps = {
  businessDate: string;
  language: AppLanguage;
  copy: Record<string, string> & InjectionTransitionPanelCopy;
  progress: RealtimeProgressSummary;
  analysis: InjectionTransitionAnalysis;
  confirmations?: InjectionDowntimeConfirmation[];
  confirmationState: "loading" | "ready" | "error";
  activityConfirmedKeys: ReadonlySet<string>;
  productionStatus?: ProductionStatusResponse;
  productionStatusError: boolean;
  renderTrack: (row: RealtimeProgressRow) => ReactNode;
  onOpenDetail: (row: RealtimeProgressRow) => void;
  onOpenActivity: (row: RealtimeProgressRow) => void;
  machiningSummary: ReactNode;
  machiningRows: ReactNode;
  onOpenBoard: () => void;
};

function formatNumber(value: number | null | undefined, language: AppLanguage) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString(language === "ko" ? "ko-KR" : "zh-CN");
}

function formatTime(value: string | null | undefined, language: AppLanguage, withDate = false) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return parsed.toLocaleString(language === "ko" ? "ko-KR" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    ...(withDate ? { month: "2-digit", day: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatMinutes(minutes: number, language: AppLanguage) {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return language === "ko" ? `${rounded}분` : `${rounded}分钟`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return language === "ko" ? `${hours}시간 ${rest}분` : `${hours}小时${rest}分`;
}

export function InjectionMachineBoard({
  businessDate,
  language,
  copy,
  progress,
  analysis,
  confirmations,
  confirmationState,
  activityConfirmedKeys,
  productionStatus,
  productionStatusError,
  renderTrack,
  onOpenDetail,
  onOpenActivity,
  machiningSummary,
  machiningRows,
  onOpenBoard,
}: InjectionMachineBoardProps) {
  const { t } = useLang();
  const text = (key: string) => t(`machineBoard.${key}`);
  const mesText = (key: string) => t(`mesTasks.${key}`);
  const [tab, setTab] = useState<BoardTab>("injection");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const reconciliationQuery = useQuery({
    ...reconciliationQueryOptions(businessDate),
    queryFn: ({ signal }) => getMesTaskReconciliation(businessDate, signal),
  });
  const reconciliation = reconciliationQuery.data;
  const reconciliationFailed = reconciliationQuery.isError;
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<MachineBoardGroup>>(new Set(["inactive"]));
  const qualityGenerations = useRef(new Map<number, InjectionQualityState>());
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), QUALITY_CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);
  // Same current-plan scope rules as the inspection overview: a payload for a
  // different plan or a duplicated machine row never reads as the current result.
  const quality = useMemo(() => {
    const result = new Map<string, MachineQuality>();
    for (let number = 1; number <= INJECTION_MACHINE_COUNT; number += 1) {
      const matches = productionStatus?.injection.filter((row) => row.machine_number === number) ?? [];
      const row = matches.length === 1 ? matches[0] : undefined;
      const input = row?.inspection_scope;
      const valid = input?.business_date === businessDate && input.machine_number === number
        && input.current_plan_id !== null
        && row?.parts.filter((part) => part.plan_id === input.current_plan_id).length === 1;
      const scope: ExpectedInjectionQualityScope = {
        businessDate,
        machineNumber: number,
        currentPlanId: valid ? input.current_plan_id : null,
        planVersion: valid ? input.plan_version : "0".repeat(64),
      };
      const state = reduceInjectionQuality(qualityGenerations.current.get(number) ?? null, valid ? row?.inspection_status : null, scope);
      qualityGenerations.current.set(number, state);
      const view = deriveInjectionQuality(state, scope, nowMs, { transportError: productionStatusError });
      result.set(String(number), { scope, state, view });
    }
    return result;
  }, [businessDate, nowMs, productionStatus, productionStatusError]);
  const inspectionAttention = useMemo(() => new Map<string, MachineInspectionAttention>(
    [...quality].map(([key, item]) => {
      const attention = injectionQualityAttention(item.view);
      return [key, { failed: attention.failed, overdue: attention.overdue }];
    }),
  ), [quality]);
  const rows = useMemo(() => buildMachineBoardRows({
    progressRows: progress.rows,
    analysis,
    confirmations,
    confirmationsReady: confirmationState === "ready",
    reconciliation,
    reconciliationFailed,
    activityConfirmedKeys,
    inspection: inspectionAttention,
  }), [activityConfirmedKeys, analysis, confirmationState, confirmations, inspectionAttention, progress.rows, reconciliation, reconciliationFailed]);
  const visibleRows = attentionOnly ? rows.filter((row) => row.needsAttention) : rows;

  const counts = useMemo(() => {
    const byGroup = Object.fromEntries(MACHINE_BOARD_GROUPS.map((group) => [group, rows.filter((row) => row.group === group).length])) as Record<MachineBoardGroup, number>;
    const stopPending = confirmationState === "ready"
      ? rows.reduce((sum, row) => sum + (row.stop.pending ?? 0), 0)
      : null;
    const mesReady = rows.filter((row) => row.mes.state === "ready");
    const mesAvailable = Boolean(reconciliation) && !reconciliationFailed;
    const sum = (pick: (row: MachineBoardRow) => number) => (mesAvailable ? mesReady.reduce((total, row) => total + pick(row), 0) : null);
    const inspectionKnown = [...inspectionAttention.values()].filter((item) => item.failed !== null);
    return {
      byGroup,
      stopPending,
      pauseReview: sum((row) => (row.mes.state === "ready" ? row.mes.pauseReview : 0)),
      linkReview: sum((row) => (row.mes.state === "ready" ? row.mes.linkReview : 0)),
      startNeeded: sum((row) => (row.mes.state === "ready" ? row.mes.startNeeded : 0)),
      noTask: sum((row) => (row.mes.state === "ready" ? row.mes.noTask : 0)),
      inspectionFailed: inspectionKnown.length ? inspectionKnown.filter((item) => item.failed).length : null,
      inspectionOverdue: inspectionKnown.length ? inspectionKnown.filter((item) => item.overdue).length : null,
      attention: rows.filter((row) => row.needsAttention).length,
    };
  }, [confirmationState, inspectionAttention, reconciliation, reconciliationFailed, rows]);

  function toggleGroup(group: MachineBoardGroup) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderState(row: MachineBoardRow) {
    const item = row.progress;
    if (row.hadProduction && item && !item.hasPlan) {
      return activityConfirmedKeys.has(row.key)
        ? <em className="production-progress-status production-progress-status--confirmed">{copy.activityConfirmed}</em>
        : <em className="production-progress-status production-progress-status--review">{text("unplanned")}</em>;
    }
    if (row.group === "running") return <em className="production-progress-status production-progress-status--running">{copy.running}</em>;
    if (row.group === "stopped_after_run") return <em className="production-progress-status production-progress-status--paused">{text("stopped")}</em>;
    if (row.group === "planned_idle") return <em className="production-progress-status">{text("notStarted")}</em>;
    return null;
  }

  function renderProduction(row: MachineBoardRow) {
    // Sporadic shots without a plan read as no activity.
    const item = row.progress && (row.progress.hasPlan || row.hadProduction) ? row.progress : null;
    if (!item) {
      const todayPlans = row.mesMachine?.plans.filter((plan) => plan.plan_date === businessDate) ?? [];
      if (!todayPlans.length) return <span className="machine-board__muted">{text("noPlanNoShot")}</span>;
      return (
        <div className="machine-board__production-head">
          <strong>{todayPlans.map((plan) => plan.part_no || "—").join(" · ")}</strong>
          <span>{text("planNoShot")} · {formatNumber(todayPlans.reduce((sum, plan) => sum + plan.planned_quantity, 0), language)}</span>
        </div>
      );
    }
    if (!item.hasPlan) {
      return (
        <div className="machine-board__review">
          <span>{copy.noPlan} · {copy.shotCount} {formatNumber(item.shotCount, language)}</span>
          <button className="machine-board__link" onClick={() => onOpenActivity(item)} type="button">
            {activityConfirmedKeys.has(row.key) ? copy.activityEdit : item.equipmentState === "unplanned_running" ? copy.productInputAction : copy.activityCheckAction}
          </button>
        </div>
      );
    }
    const current = item.segments.find((segment) => segment.status === "in_progress");
    return (
      <div className="machine-board__production">
        <div className="machine-board__production-head">
          <strong>
            {current?.partNo
              ?? item.segments.find((segment) => segment.status === "pending")?.partNo
              ?? item.segments.at(-1)?.partNo
              ?? "—"}
          </strong>
          <span>
            {formatNumber(item.estimatedQty, language)} / {formatNumber(item.plannedQty, language)}
            <b>{Math.round(item.progressRate)}%</b>
          </span>
        </div>
        {renderTrack(item)}
      </div>
    );
  }

  function renderStops(row: MachineBoardRow) {
    const pausedMinutes = row.group === "stopped_after_run" && row.progress?.idleMinutes != null ? row.progress.idleMinutes : null;
    if (!row.stop.eventCount && pausedMinutes === null) return <span className="machine-board__muted">—</span>;
    return (
      <div className="machine-board__stack">
        {pausedMinutes !== null ? (
          <span className="machine-board__warn">{copy.noClampDuration} {formatMinutes(pausedMinutes ?? 0, language)}</span>
        ) : null}
        {row.stop.eventCount ? (
          <span>{text("stopEvents")} {row.stop.eventCount} · {formatMinutes(row.stop.minutes, language)}</span>
        ) : null}
        {row.stop.pending ? <span className="machine-board__badge machine-board__badge--warning">{text("confirmPending")} {row.stop.pending}</span> : null}
      </div>
    );
  }

  function inspectionLabel(status: QualityCheckStatus) {
    return text(`inspectionStatus.${status}`);
  }

  function renderInspection(row: MachineBoardRow) {
    const item = quality.get(row.key);
    if (!item) return <span className="machine-board__muted">—</span>;
    const { view } = item;
    if (!view.data) {
      return <span className="machine-board__muted">{view.availability === "error" ? text("inspectionError") : text("inspectionUnlinked")}</span>;
    }
    const periodic = view.data.periodic;
    return (
      <div className="machine-board__stack">
        <span>
          {text("inspectionFirst")}{" "}
          <span className={`machine-board__badge${view.firstStatus === "failed" ? " machine-board__badge--warning" : view.firstStatus === "passed" ? " machine-board__badge--ok" : ""}`}>
            {inspectionLabel(view.firstStatus)}
          </span>
        </span>
        <span>
          {text("inspectionPeriodic")} {formatTime(periodic.last_checked_at, language)}
          {view.scheduleStatus === "overdue" ? (
            <span className="machine-board__badge machine-board__badge--warning">{text("inspectionOverdue")}</span>
          ) : view.scheduleStatus === "scheduled" && periodic.next_due_at ? (
            <span className="machine-board__muted"> · {text("inspectionNext")} {formatTime(periodic.next_due_at, language)}</span>
          ) : null}
          {view.periodicStatus === "failed" ? <span className="machine-board__badge machine-board__badge--warning">{inspectionLabel("failed")}</span> : null}
        </span>
        {view.historical ? <span className="machine-board__muted">{text("inspectionStale")}</span> : null}
      </div>
    );
  }

  function renderMes(row: MachineBoardRow) {
    if (reconciliationQuery.isPending) return <span className="machine-board__muted">{mesText("loading")}</span>;
    if (row.mes.state !== "ready") return <span className="machine-board__muted">{text("mesUnavailable")}</span>;
    const mes = row.mes;
    const open = mes.running + mes.paused + mes.waiting;
    return (
      <div className="machine-board__stack">
        <span>
          {open
            ? [
              mes.running ? `${text("mesRunning")} ${mes.running}` : "",
              mes.paused ? `${text("mesPaused")} ${mes.paused}` : "",
              mes.waiting ? `${text("mesWaiting")} ${mes.waiting}` : "",
            ].filter(Boolean).join(" · ")
            : text("mesNoOpen")}
        </span>
        <span className="machine-board__badges">
          {mes.pauseReview ? <span className="machine-board__badge machine-board__badge--warning">{text("pauseReview")} {mes.pauseReview}</span> : null}
          {mes.linkReview ? <span className="machine-board__badge machine-board__badge--warning">{text("linkReview")} {mes.linkReview}</span> : null}
          {mes.startNeeded ? <span className="machine-board__badge">{text("startNeeded")} {mes.startNeeded}</span> : null}
          {mes.noTask ? <span className="machine-board__badge">{text("noTask")} {mes.noTask}</span> : null}
          {mes.held ? <span className="machine-board__badge">{text("held")}</span> : null}
        </span>
      </div>
    );
  }

  function renderTask(task: ReconciliationTask) {
    return (
      <tr key={task.task_id}>
        <td>
          <strong>{task.part_no || "—"}</strong>
          <small>{task.task_code || task.task_id} · {task.work_order_code || "—"}</small>
        </td>
        <td><span className="machine-board__badge">{mesText(`status.${task.status}`)}</span></td>
        <td className="machine-board__num">
          {formatNumber(task.planned_quantity, language)} / {formatNumber(task.reported_quantity, language)} / {formatNumber(task.inbound_quantity, language)}
        </td>
        <td>{formatTime(task.actual_start, language, true)}</td>
        <td>
          <span className={`machine-board__badge${assessmentTone(task.assessment) === "warning" ? " machine-board__badge--warning" : ""}`}>
            {mesText(`assessment.${task.assessment}`)}
          </span>
          {task.reasons.length ? (
            <ul className="machine-board__reasons">
              {task.reasons.map((reason) => <li key={reason}>{mesText(`reason.${reason}`)}</li>)}
            </ul>
          ) : null}
        </td>
      </tr>
    );
  }

  function renderDetail(row: MachineBoardRow) {
    const item = row.progress;
    const machine = row.mesMachine;
    return (
      <div className="machine-board__detail">
        <section>
          <header>
            <strong>{text("plansTitle")}</strong>
            {item?.hasPlan ? <button className="machine-board__link" onClick={() => onOpenDetail(item)} type="button">{copy.detail}</button> : null}
          </header>
          {machine?.plans.length ? (
            <ul className="machine-board__plans">
              {machine.plans.map((plan) => (
                <li key={plan.plan_id}>
                  <span>{plan.plan_date.slice(5)} · {mesText("sequence")} {plan.sequence}</span>
                  <strong>{plan.part_no || "—"}</strong>
                  <span>{formatNumber(plan.planned_quantity, language)} · LOT {plan.lot_no || "—"}</span>
                  <span className={`machine-board__badge${assessmentTone(plan.assessment) === "warning" ? " machine-board__badge--warning" : ""}`}>
                    {mesText(`assessment.${plan.assessment}`)}
                  </span>
                  {plan.parallel_parts.length > 1 ? <small>{mesText("parallel")} {plan.parallel_parts.join(" + ")}</small> : null}
                  {plan.group_incomplete ? <small>{mesText("groupIncomplete")}</small> : null}
                </li>
              ))}
            </ul>
          ) : item?.segments.length ? (
            <ul className="machine-board__plans">
              {item.segments.map((segment) => (
                <li key={segment.key}>
                  <span>{mesText("sequence")} {segment.sequence}</span>
                  <strong>{segment.partNo || "—"}</strong>
                  <span>{formatNumber(segment.estimatedQty, language)} / {formatNumber(segment.plannedQty, language)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="machine-board__muted">{text("noPlans")}</p>}
          {machine?.plan_scope === "incomplete" ? <p className="machine-board__muted">{mesText("planIncomplete")}</p> : null}
        </section>
        <section>
          <header>
            <strong>{text("mesTitle")}</strong>
            {machine ? <span className="machine-board__muted">{mesText(`observation.${machine.observation.state}`)}</span> : null}
          </header>
          {row.mes.state !== "ready" ? (
            <p className="machine-board__muted">{text("mesUnavailable")}</p>
          ) : machine?.tasks.length ? (
            <div className="machine-board__table-wrap">
              <table className="machine-board__tasks">
                <thead>
                  <tr>
                    <th scope="col">{text("taskPart")}</th>
                    <th scope="col">{text("taskStatus")}</th>
                    <th scope="col">{mesText("quantities")}</th>
                    <th scope="col">{mesText("opened")}</th>
                    <th scope="col">{text("taskAssessment")}</th>
                  </tr>
                </thead>
                <tbody>{machine.tasks.map(renderTask)}</tbody>
              </table>
            </div>
          ) : (
            <p className="machine-board__muted">
              {reconciliation?.data_freshness.assignment_complete ? mesText("emptyTasks") : mesText("unknownTasks")}
            </p>
          )}
        </section>
        {quality.get(row.key)?.view.data ? (
          <section className="machine-board__detail-wide">
            <InjectionQualityStatus
              expectedScope={quality.get(row.key)!.scope}
              language={language}
              nowMs={nowMs}
              state={quality.get(row.key)!.state}
              transportError={productionStatusError}
            />
          </section>
        ) : null}
        {row.events.length ? (
          <section className="machine-board__detail-wide">
            <InjectionTransitionPanel
              analysis={analysis}
              compact
              confirmationState={confirmationState}
              confirmations={confirmations}
              copy={copy}
              embedded
              language={language}
              machineKey={row.key}
              mode="dashboard"
            />
          </section>
        ) : null}
      </div>
    );
  }

  const summaryItems: Array<[string, number | null, string?]> = [
    [text("stopPendingChip"), counts.stopPending, counts.stopPending ? "review" : undefined],
    [text("pauseReview"), counts.pauseReview, counts.pauseReview ? "review" : undefined],
    [text("linkReview"), counts.linkReview, counts.linkReview ? "review" : undefined],
    [text("startNeeded"), counts.startNeeded],
    [text("noTask"), counts.noTask],
    [text("inspectionOverdueChip"), counts.inspectionOverdue, counts.inspectionOverdue ? "review" : undefined],
    [text("inspectionFailedChip"), counts.inspectionFailed, counts.inspectionFailed ? "review" : undefined],
  ];

  function renderRow(row: MachineBoardRow) {
    const isOpen = expanded.has(row.key);
    const label = row.machineNumber ? `${row.machineNumber}${mesText("machineUnit")}` : row.progress?.label ?? row.key;
    return (
      <Fragment key={row.key}>
        <tr className={`machine-board__row${row.needsAttention ? " machine-board__row--attention" : ""}${isOpen ? " is-open" : ""}`}>
          <th scope="row">
            <div className="machine-board__machine">
              <strong>{label}</strong>
              {renderState(row)}
            </div>
            {row.hadProduction && row.progress?.lastShotAt ? (
              <small className="machine-board__muted">{text("lastShot")} {formatTime(row.progress.lastShotAt, language)}</small>
            ) : null}
          </th>
          <td>{renderProduction(row)}</td>
          <td>{renderStops(row)}</td>
          <td>{renderMes(row)}</td>
          <td>{renderInspection(row)}</td>
          <td className="machine-board__toggle-cell">
            <button
              aria-expanded={isOpen}
              aria-label={`${label} ${text("colDetail")}`}
              className="machine-board__icon-button"
              onClick={() => toggle(row.key)}
              type="button"
            >
              {isOpen ? <ChevronDown aria-hidden="true" size={16} /> : <ChevronRight aria-hidden="true" size={16} />}
            </button>
          </td>
        </tr>
        {isOpen ? (
          <tr className="machine-board__detail-row">
            <td colSpan={COLUMN_COUNT}>{renderDetail(row)}</td>
          </tr>
        ) : null}
      </Fragment>
    );
  }

  return (
    <section className="panel machine-board" aria-labelledby="machine-board-title">
      <header className="machine-board__header">
        <div className="machine-board__title">
          <h3 className="panel__title" id="machine-board-title">{text("title")}</h3>
          <div className="machine-board__tabs" role="tablist" aria-label={text("title")}>
            {(["injection", "machining"] as const).map((value) => (
              <button
                aria-selected={tab === value}
                className={tab === value ? "is-active" : ""}
                key={value}
                onClick={() => setTab(value)}
                role="tab"
                type="button"
              >
                {value === "injection" ? text("tabInjection") : text("tabMachining")}
              </button>
            ))}
          </div>
        </div>
        <div className="machine-board__actions">
          {tab === "injection" ? (
            <>
              <span className="machine-board__muted">
                MES {formatTime(reconciliation?.data_freshness.queried_at, language)}
                {reconciliation?.data_freshness.list_may_lag ? ` · ${text("mesLag")}` : ""}
              </span>
              <button
                aria-label={mesText("refresh")}
                className="machine-board__icon-button"
                disabled={reconciliationQuery.isFetching}
                onClick={() => void reconciliationQuery.refetch()}
                title={mesText("refresh")}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={15} className={reconciliationQuery.isFetching ? "is-spinning" : ""} />
              </button>
            </>
          ) : null}
          <button className="machine-board__link" onClick={onOpenBoard} type="button">
            {copy.openInjectionBoard} <ExternalLink aria-hidden="true" size={13} />
          </button>
        </div>
      </header>

      {tab === "injection" ? (
        <>
          <div className="machine-board__summary">
            <div className="machine-board__total">
              <strong>{Math.round(progress.progressRate)}%</strong>
              <span>{formatNumber(progress.estimatedQty, language)} / {formatNumber(progress.plannedQty, language)}</span>
            </div>
            <div className="machine-board__groups-summary">
              {MACHINE_BOARD_GROUPS.map((group) => (
                <span className={`machine-board__group-count machine-board__group-count--${group}`} key={group}>
                  {text(`group.${group}`)} <b>{counts.byGroup[group]}</b>
                </span>
              ))}
            </div>
            <div className="machine-board__chips" aria-live="polite">
              {summaryItems.map(([label, value, tone]) => (
                <span className={`production-progress-chip${tone ? ` production-progress-chip--${tone === "running" ? "completed" : tone}` : ""}`} key={label}>
                  {label} {value === null ? "—" : formatNumber(value, language)}
                </span>
              ))}
            </div>
            <label className="machine-board__filter">
              <input checked={attentionOnly} onChange={(event) => setAttentionOnly(event.target.checked)} type="checkbox" />
              {text("attentionOnly")} ({counts.attention})
            </label>
          </div>

          {reconciliationFailed ? <p className="machine-board__notice" role="alert">{mesText("failed")}</p> : null}
          {reconciliation?.warnings.length ? (
            <p className="machine-board__notice" role="status">
              {reconciliation.warnings.map((warning) => mesText(`warning.${warning}`)).join(" · ")}
            </p>
          ) : null}

          <div className="machine-board__table-wrap" role="region" aria-label={text("title")} tabIndex={0}>
            <table className="machine-board__table">
              <thead>
                <tr>
                  <th scope="col">{text("colMachine")}</th>
                  <th scope="col">{text("colProduction")}</th>
                  <th scope="col">{text("colStops")}</th>
                  <th scope="col">{text("colMes")}</th>
                  <th scope="col">{text("colInspection")}</th>
                  <th scope="col"><span className="sr-only">{text("colDetail")}</span></th>
                </tr>
              </thead>
              {MACHINE_BOARD_GROUPS.map((group) => {
                const groupRows = visibleRows.filter((row) => row.group === group);
                if (!groupRows.length) return null;
                const collapsed = collapsedGroups.has(group);
                return (
                  <tbody className={`machine-board__group machine-board__group--${group}`} key={group}>
                    <tr className="machine-board__group-row">
                      <th colSpan={COLUMN_COUNT} scope="rowgroup">
                        <button aria-expanded={!collapsed} onClick={() => toggleGroup(group)} type="button">
                          {collapsed ? <ChevronRight aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}
                          <strong>{text(`group.${group}`)}</strong>
                          <span>{groupRows.length}{text("machineCount")}</span>
                          <small>{text(`groupHint.${group}`)}</small>
                        </button>
                      </th>
                    </tr>
                    {collapsed ? null : groupRows.map(renderRow)}
                  </tbody>
                );
              })}
              {!visibleRows.length ? (
                <tbody>
                  <tr><td colSpan={COLUMN_COUNT} className="machine-board__muted">{text("noAttention")}</td></tr>
                </tbody>
              ) : null}
            </table>
          </div>

          <details className="machine-board__more">
            <summary>{text("allStops")} · {formatNumber(analysis.events.length, language)}</summary>
            <InjectionTransitionPanel
              analysis={analysis}
              confirmationState={confirmationState}
              confirmations={confirmations}
              copy={copy}
              embedded
              language={language}
              mode="dashboard"
            />
          </details>
          {reconciliation?.unmapped_tasks.length ? (
            <details className="machine-board__more">
              <summary>{mesText("unmapped")} · {reconciliation.unmapped_tasks.length}</summary>
              <div className="machine-board__table-wrap">
                <table className="machine-board__tasks">
                  <tbody>{reconciliation.unmapped_tasks.map(renderTask)}</tbody>
                </table>
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <div className="machine-board__machining">
          {machiningSummary}
          <div className="production-progress-list">{machiningRows}</div>
        </div>
      )}
    </section>
  );
}
