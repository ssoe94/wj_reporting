import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Factory, History } from "lucide-react";
import {
  getInjectionProductionMatrix,
  getInjectionProductionMatrixForDate,
  type InjectionProductionMatrix,
} from "@/domains/mes/api";
import { getProductionPlanSummary, getProductionStatus } from "@/domains/production/api";
import {
  buildRealtimeProgressSummary,
  type RealtimeProgressRow,
  type RealtimeProgressSummary,
} from "@/domains/production/realtime-progress";
import { setStoredLanguage, type AppLanguage, useStoredLanguage } from "@/shared/i18n/language";
import { addIsoDateDays, getShanghaiBusinessDateString } from "@/shared/utils/date";

const BOARD_REFRESH_INTERVAL_MS = 60_000;
const STALE_DATA_THRESHOLD_MS = 5 * 60_000;
const MACHINE_COUNT = 17;
const PREVIOUS_SUMMARY_CACHE_PREFIX = "injection-board:previous-summary:";

type PreviousSummaryCache = {
  businessDate: string;
  expiresAt: number;
  summary: RealtimeProgressSummary;
  timelines: Record<string, BoardTimelineSegment[]>;
};

type PreviousBoardSnapshot = Pick<PreviousSummaryCache, "summary" | "timelines">;

type BoardTimelineSegment = {
  startPct: number;
  widthPct: number;
};

type BoardTone = "running" | "warning" | "stopped" | "completed" | "unplanned" | "idle" | "stale";

type BoardMachine = {
  machineNumber: number;
  tonnage: string;
  row?: RealtimeProgressRow;
  tone: BoardTone;
  currentCycleTimeSec: number | null;
  activePart: string;
  activeModel: string;
  activeFamily: string;
  timelineSegments: BoardTimelineSegment[];
};

const boardCopy = {
  ko: {
    eyebrow: "INJECTION LIVE BOARD",
    title: "사출 실시간 현황판",
    subtitle: "계획, 생산 실적과 최근 60분 C/T를 1분마다 갱신합니다.",
    productionDate: "기준일",
    refreshed: "화면 갱신",
    dataTime: "MES 기준",
    autoRefresh: "1분 자동 갱신",
    previousSummary: "전일 생산 요약",
    previousSummaryTitle: "전일 사출 생산 요약",
    previousSummaryHint: "화면을 누르면 실시간 현황판으로 돌아갑니다.",
    previousPlanResult: "계획 달성률",
    previousTotalOutput: "총 생산수량",
    plannedOutputOnly: "계획 생산 실적 합계",
    operatedEquipment: "가동 설비",
    outsidePlanResult: "계획 외 가동",
    plannedMachinesLabel: "계획 설비",
    actualShots: "실제 형합수",
    productionQuantity: "생산수량",
    quantityPending: "수량 환산 대기",
    pieces: "개",
    actual: "실적",
    plan: "계획",
    machineSummary: "설비별 생산 결과",
    productionRecorded: "생산 실적",
    shortfall: "계획 미달",
    noProduction: "생산 없음",
    previousLoading: "전일 생산 이력을 불러오는 중입니다.",
    previousError: "전일 생산 이력을 불러오지 못했습니다.",
    fullscreen: "전체 화면",
    exitFullscreen: "전체 화면 종료",
    close: "닫기",
    korean: "한국어",
    chinese: "中文",
    overview: "전체 가동 현황",
    planProgress: "계획 생산 진도",
    actionRequired: "즉시 확인 필요",
    totalMachines: "전체 설비",
    managementRequired: "관리 필요",
    timeProgress: "시간 기준",
    progressGap: "진도 차이",
    noIssue: "이상 없음",
    running: "가동 중",
    plannedRunning: "정상 가동",
    plannedEquipment: "계획 설비",
    plannedMachines: "가동 계획",
    unplannedRunning: "계획 외 가동",
    warning: "진도 확인",
    stopped: "계획 설비 정지",
    completed: "생산 완료",
    stoppedMachines: "정지 설비",
    completedMachines: "완료 설비",
    idle: "비가동",
    stale: "데이터 지연",
    machines: "대",
    shots: "회",
    totalPlan: "계획",
    totalActual: "실적",
    completion: "완료율",
    plannedStops: "계획정지",
    ctWarnings: "C/T 주의",
    rateWarnings: "진도주의",
    unplanned: "계획없음",
    currentCt: "현재 C/T",
    recentCt: "최근 60분 기준",
    progress: "달성률",
    part: "생산 Part",
    model: "모델",
    noPart: "Part 확인 대기",
    noPlan: "계획없음",
    lastShot: "최근 형합",
    noShot: "형합 없음",
    remainingShots: "잔여 형합",
    loading: "사출 현황을 불러오는 중입니다.",
    error: "현황 데이터를 불러오지 못했습니다. 1분 후 다시 시도합니다.",
    staleBanner: "MES 데이터가 5분 이상 갱신되지 않았습니다. 현장 상태를 직접 확인해 주세요.",
  },
  zh: {
    eyebrow: "INJECTION LIVE BOARD",
    title: "注塑实时看板",
    subtitle: "计划、生产实绩与最近60分钟周期每分钟更新。",
    productionDate: "基准日",
    refreshed: "页面更新",
    dataTime: "MES基准",
    autoRefresh: "每分钟自动更新",
    previousSummary: "前日生产摘要",
    previousSummaryTitle: "前日注塑生产摘要",
    previousSummaryHint: "点击画面即可返回实时看板。",
    previousPlanResult: "计划完成率",
    previousTotalOutput: "总生产数量",
    plannedOutputOnly: "计划生产实绩合计",
    operatedEquipment: "运行设备",
    outsidePlanResult: "计划外运行",
    plannedMachinesLabel: "计划设备",
    actualShots: "实际模次",
    productionQuantity: "生产数量",
    quantityPending: "数量待换算",
    pieces: "件",
    actual: "实绩",
    plan: "计划",
    machineSummary: "设备生产结果",
    productionRecorded: "有生产实绩",
    shortfall: "未达计划",
    noProduction: "无生产",
    previousLoading: "正在读取前日生产记录。",
    previousError: "无法读取前日生产记录。",
    fullscreen: "全屏",
    exitFullscreen: "退出全屏",
    close: "关闭",
    korean: "한국어",
    chinese: "中文",
    overview: "设备运行总览",
    planProgress: "计划生产进度",
    actionRequired: "需要立即确认",
    totalMachines: "全部设备",
    managementRequired: "需要管理",
    timeProgress: "时间进度",
    progressGap: "进度差异",
    noIssue: "无异常",
    running: "运行中",
    plannedRunning: "按计划运行",
    plannedEquipment: "计划设备",
    plannedMachines: "运行计划",
    unplannedRunning: "计划外运行",
    warning: "进度待确认",
    stopped: "计划设备停机",
    completed: "生产完成",
    stoppedMachines: "停机设备",
    completedMachines: "完成设备",
    idle: "未运行",
    stale: "数据延迟",
    machines: "台",
    shots: "模次",
    totalPlan: "计划",
    totalActual: "实绩",
    completion: "完成率",
    plannedStops: "计划停机",
    ctWarnings: "周期注意",
    rateWarnings: "进度注意",
    unplanned: "无计划",
    currentCt: "当前周期",
    recentCt: "最近60分钟基准",
    progress: "完成率",
    part: "生产Part",
    model: "型号",
    noPart: "等待确认Part",
    noPlan: "无计划",
    lastShot: "最近合模",
    noShot: "无合模",
    remainingShots: "剩余模次",
    loading: "正在读取注塑运行状态。",
    error: "无法读取看板数据，将在1分钟后重试。",
    staleBanner: "MES数据已超过5分钟未更新，请直接确认现场状态。",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.max(0, value));
}

function getPreviousSummaryCacheKey(businessDate: string) {
  return `${PREVIOUS_SUMMARY_CACHE_PREFIX}${businessDate}`;
}

function getPreviousSummaryCacheExpiry(activeBusinessDate: string) {
  return new Date(`${addIsoDateDays(activeBusinessDate, 1)}T08:00:00+08:00`).getTime();
}

function readPreviousSummaryCache(businessDate: string): PreviousBoardSnapshot | null {
  if (typeof window === "undefined") return null;
  const cacheKey = getPreviousSummaryCacheKey(businessDate);
  try {
    const rawValue = window.localStorage.getItem(cacheKey);
    if (!rawValue) return null;
    const cached = JSON.parse(rawValue) as PreviousSummaryCache;
    if (
      cached.businessDate !== businessDate
      || cached.expiresAt <= Date.now()
      || !Array.isArray(cached.summary?.rows)
      || !cached.timelines
    ) {
      window.localStorage.removeItem(cacheKey);
      return null;
    }
    return { summary: cached.summary, timelines: cached.timelines };
  } catch {
    window.localStorage.removeItem(cacheKey);
    return null;
  }
}

function writePreviousSummaryCache(
  businessDate: string,
  activeBusinessDate: string,
  snapshot: PreviousBoardSnapshot,
) {
  if (typeof window === "undefined") return;
  const cached: PreviousSummaryCache = {
    businessDate,
    expiresAt: getPreviousSummaryCacheExpiry(activeBusinessDate),
    ...snapshot,
  };
  try {
    window.localStorage.setItem(getPreviousSummaryCacheKey(businessDate), JSON.stringify(cached));
  } catch {
    // The live query remains available if browser storage is disabled or full.
  }
}

function prunePreviousSummaryCaches(activeBusinessDate: string) {
  if (typeof window === "undefined") return;
  const activeKey = getPreviousSummaryCacheKey(addIsoDateDays(activeBusinessDate, -1));
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(PREVIOUS_SUMMARY_CACHE_PREFIX) && key !== activeKey) {
      window.localStorage.removeItem(key);
    }
  }
}

function formatProductFamily(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toUpperCase().replaceAll("/", "");
  if (normalized === "BC") return "B/C";
  if (normalized === "CA") return "C/A";
  if (normalized === "GP") return "G/P";
  return String(value ?? "").trim();
}

function formatTime(value: Date | string | null | undefined) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function getMachineNumber(value: string | null | undefined) {
  const text = String(value ?? "");
  const suffix = text.match(/-(\d+)\s*$/);
  if (suffix) return Number(suffix[1]);
  const leading = text.match(/^(\d+)\s*(?:호기|号机)/);
  if (leading) return Number(leading[1]);
  return Number.NaN;
}

function getTonnage(value: string | null | undefined) {
  const match = String(value ?? "").match(/(\d+)\s*T?/i);
  return match ? match[1] : "-";
}

function getLatestMesTime(data: InjectionProductionMatrix | undefined) {
  const slotTime = data?.time_slots?.at(-1)?.time;
  const candidate = slotTime ?? data?.timestamp;
  if (!candidate) return null;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getMachineProductionValues(data: InjectionProductionMatrix, machineNumber: number) {
  const machine = data.machines.find((item) => item.machine_number === machineNumber);
  const candidateKeys = [
    String(machineNumber),
    machine?.machine_name,
    machine?.display_name,
    `${machineNumber}호기`,
  ].filter((value): value is string => Boolean(value));

  for (const key of candidateKeys) {
    const values = data.actual_production_matrix[key];
    if (values) return values;
  }
  return [];
}

function getTimelineSlotMinutes(data: InjectionProductionMatrix, index: number) {
  const explicit = Number(data.time_slots[index]?.interval_minutes ?? 0);
  if (explicit > 0) return explicit;
  const current = new Date(data.time_slots[index]?.time ?? 0);
  const next = new Date(data.time_slots[index + 1]?.time ?? 0);
  const inferred = (next.getTime() - current.getTime()) / 60_000;
  return Number.isFinite(inferred) && inferred > 0 ? inferred : 2;
}

function buildMachineTimeline(
  businessDate: string,
  data: InjectionProductionMatrix | undefined,
  machineNumber: number,
  expectedCycleTimeSec: number | null | undefined,
) {
  if (!data?.time_slots?.length) return [];
  const businessStart = new Date(`${businessDate}T08:00:00+08:00`);
  const businessEnd = new Date(businessStart.getTime() + 24 * 60 * 60 * 1000);
  const values = getMachineProductionValues(data, machineNumber);
  const intervals: Array<{ startMs: number; endMs: number }> = [];

  data.time_slots.forEach((slot, index) => {
    if (Number(values[index] ?? 0) <= 0) return;
    const slotStart = new Date(slot.time);
    if (Number.isNaN(slotStart.getTime()) || slotStart < businessStart || slotStart >= businessEnd) return;
    const slotMinutes = getTimelineSlotMinutes(data, index);
    intervals.push({
      startMs: slotStart.getTime(),
      endMs: Math.min(businessEnd.getTime(), slotStart.getTime() + slotMinutes * 60_000),
    });
  });

  if (!intervals.length) return [];
  const bridgeMinutes = Math.min(15, Math.max(4, ((expectedCycleTimeSec ?? 120) * 3) / 60));
  const merged: Array<{ startMs: number; endMs: number }> = [];
  intervals.forEach((interval) => {
    const previous = merged.at(-1);
    if (previous && interval.startMs - previous.endMs <= bridgeMinutes * 60_000) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
      return;
    }
    merged.push({ ...interval });
  });

  const durationMs = businessEnd.getTime() - businessStart.getTime();
  return merged.map((interval) => {
    const startPct = Math.max(0, Math.min(100, ((interval.startMs - businessStart.getTime()) / durationMs) * 100));
    const widthPct = Math.max(0.25, Math.min(100 - startPct, ((interval.endMs - interval.startMs) / durationMs) * 100));
    return { startPct, widthPct };
  });
}

function buildBoardTimelines(
  businessDate: string,
  data: InjectionProductionMatrix | undefined,
  summary: RealtimeProgressSummary,
) {
  const rowsByMachine = new Map<number, RealtimeProgressRow>();
  summary.rows.forEach((row) => {
    const machineNumber = getMachineNumber(row.label) || Number(row.key);
    if (Number.isFinite(machineNumber)) rowsByMachine.set(machineNumber, row);
  });
  return Object.fromEntries(Array.from({ length: MACHINE_COUNT }, (_, index) => {
    const machineNumber = index + 1;
    return [String(machineNumber), buildMachineTimeline(
      businessDate,
      data,
      machineNumber,
      rowsByMachine.get(machineNumber)?.expectedCycleTimeSec,
    )];
  }));
}

function getActiveProduct(row: RealtimeProgressRow | undefined, fallback: string, noPlan: string) {
  if (!row?.segments.length) {
    return { part: row?.isRunning ? fallback : noPlan, model: "", family: "" };
  }
  const activeSegment = row.segments.find((segment) => segment.status === "in_progress")
    ?? row.segments.find((segment) => segment.status === "pending")
    ?? row.segments.at(-1);
  if (!activeSegment) return { part: fallback, model: "", family: "" };

  const paired = activeSegment.shotGroupKey
    ? row.segments.filter((segment) => segment.shotGroupKey === activeSegment.shotGroupKey)
    : [activeSegment];
  return {
    part: paired.map((segment) => segment.partNo).filter(Boolean).join(" + ") || fallback,
    model: [...new Set(paired.map((segment) => segment.modelName).filter((value) => value && value !== "-"))].join(" + "),
    family: [...new Set(paired.map((segment) => formatProductFamily(segment.productFamilyCode)).filter(Boolean))].join(" + "),
  };
}

function getTone(
  row: RealtimeProgressRow | undefined,
  elapsedRate: number,
  isStale: boolean,
): BoardTone {
  if (isStale) return "stale";
  if (!row) return "idle";
  if (!row.hasPlan) return row.isRunning ? "unplanned" : "idle";
  if (row.progressRate >= 99.9) return "completed";
  if (!row.isRunning) return "stopped";
  if (row.progressRate + 5 < elapsedRate) return "warning";
  return "running";
}

function getStatusLabel(tone: BoardTone, copy: typeof boardCopy.ko) {
  return {
    running: copy.plannedRunning,
    warning: copy.warning,
    stopped: copy.stopped,
    completed: copy.completed,
    unplanned: copy.unplannedRunning,
    idle: copy.idle,
    stale: copy.stale,
  }[tone];
}

function buildBoardMachines(
  businessDate: string,
  summary: RealtimeProgressSummary,
  mesData: InjectionProductionMatrix | undefined,
  elapsedRate: number,
  isStale: boolean,
  noPartText: string,
  noPlanText: string,
) {
  const rowsByMachine = new Map<number, RealtimeProgressRow>();
  summary.rows.forEach((row) => {
    const machineNumber = getMachineNumber(row.label) || Number(row.key);
    if (Number.isFinite(machineNumber)) rowsByMachine.set(machineNumber, row);
  });
  const mesMachines = new Map((mesData?.machines ?? []).map((machine) => [machine.machine_number, machine]));

  return Array.from({ length: MACHINE_COUNT }, (_, index): BoardMachine => {
    const machineNumber = index + 1;
    const row = rowsByMachine.get(machineNumber);
    const mesMachine = mesMachines.get(machineNumber);
    const currentCycleTimeSec = row?.expectedCycleTimeSec ?? null;
    const activeProduct = getActiveProduct(row, noPartText, noPlanText);
    return {
      machineNumber,
      tonnage: getTonnage(mesMachine?.tonnage || row?.label || mesMachine?.display_name),
      row,
      tone: getTone(row, elapsedRate, isStale),
      currentCycleTimeSec,
      activePart: activeProduct.part,
      activeModel: activeProduct.model,
      activeFamily: activeProduct.family,
      timelineSegments: buildMachineTimeline(
        businessDate,
        mesData,
        machineNumber,
        row?.expectedCycleTimeSec,
      ),
    };
  });
}

function MachineBoardCard({ machine, language }: { machine: BoardMachine; language: AppLanguage }) {
  const copy = boardCopy[language];
  const row = machine.row;

  return (
    <article className={`injection-board-card injection-board-card--${machine.tone}`} data-machine={machine.machineNumber}>
      <header className="injection-board-card__header">
        <div>
          <strong>{machine.machineNumber}{language === "ko" ? "호기" : "号机"}</strong>
          <span>{machine.tonnage === "-" ? "-" : `${machine.tonnage}T`}</span>
        </div>
        <em>{getStatusLabel(machine.tone, copy)}</em>
      </header>

      <div
        className="injection-board-card__part"
        title={[machine.activePart, machine.activeModel, machine.activeFamily].filter(Boolean).join(" · ")}
      >
        <strong>{machine.activePart}</strong>
        {machine.activeModel ? <span>{machine.activeModel}</span> : null}
        {machine.activeFamily ? <em>{machine.activeFamily}</em> : null}
      </div>

      <div className="injection-board-card__metrics">
        <div>
          <span>{copy.currentCt}</span>
          <strong>{machine.currentCycleTimeSec === null ? "-" : `${machine.currentCycleTimeSec.toFixed(1)}s`}</strong>
          <small>{copy.recentCt}</small>
        </div>
        <div>
          <span>{copy.progress}</span>
          <strong>{row?.hasPlan ? `${row.progressRate.toFixed(1)}%` : row?.shotCount ? `${formatNumber(row.shotCount)}${copy.shots}` : "-"}</strong>
          <small>{row?.hasPlan ? `${formatNumber(row.estimatedQty)} / ${formatNumber(row.plannedQty)}` : copy.unplanned}</small>
        </div>
      </div>

      <div className="injection-board-card__track injection-board-card__timeline" aria-hidden="true">
        {machine.timelineSegments.map((segment, index) => (
          <span
            key={`${machine.machineNumber}-${index}`}
            style={{ left: `${segment.startPct}%`, width: `${segment.widthPct}%` }}
          />
        ))}
      </div>
      <footer>
        <span>{copy.lastShot}</span>
        <strong>{row?.lastShotAt ? formatTime(row.lastShotAt) : copy.noShot}</strong>
      </footer>
    </article>
  );
}

function useReloadOnNewBuild() {
  useEffect(() => {
    let active = true;
    let loadedCommit: string | null = null;

    async function checkBuild() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}build-info.json?t=${Date.now()}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const build = await response.json() as { commit?: string };
        const commit = String(build.commit ?? "").trim();
        if (!active || !commit || commit === "local") return;
        if (loadedCommit && loadedCommit !== commit) {
          window.location.reload();
          return;
        }
        loadedCommit = commit;
      } catch {
        // A transient network failure should not interrupt the operations board.
      }
    }

    void checkBuild();
    const timer = window.setInterval(checkBuild, BOARD_REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
}

type PreviousDaySummaryProps = {
  businessDate: string;
  language: AppLanguage;
  summary: RealtimeProgressSummary;
  timelines: Record<string, BoardTimelineSegment[]>;
  isLoading: boolean;
  isError: boolean;
  onClose: () => void;
};

function PreviousDaySummary({
  businessDate,
  language,
  summary,
  timelines,
  isLoading,
  isError,
  onClose,
}: PreviousDaySummaryProps) {
  const copy = boardCopy[language];
  const rowsByMachine = new Map<number, RealtimeProgressRow>();
  summary.rows.forEach((row) => {
    const machineNumber = getMachineNumber(row.label) || Number(row.key);
    if (Number.isFinite(machineNumber)) rowsByMachine.set(machineNumber, row);
  });
  const machineRows = Array.from({ length: MACHINE_COUNT }, (_, index) => ({
    machineNumber: index + 1,
    row: rowsByMachine.get(index + 1),
  }));
  const plannedMachines = machineRows.filter(({ row }) => row?.hasPlan).length;
  const plannedOperatedMachines = machineRows.filter(({ row }) => row?.hasPlan && Number(row.shotCount) > 0).length;
  const operatedMachines = machineRows.filter(({ row }) => Number(row?.shotCount ?? 0) > 0).length;
  const outsidePlanMachines = machineRows.filter(({ row }) => !row?.hasPlan && Number(row?.shotCount ?? 0) > 0);
  const outsidePlanShots = Math.round(outsidePlanMachines.reduce((total, { row }) => total + Number(row?.shotCount ?? 0), 0));
  const completionRate = summary.plannedQty > 0 ? (summary.estimatedQty / summary.plannedQty) * 100 : 0;

  return (
    <div
      aria-label={copy.previousSummaryTitle}
      className="injection-board-history"
      onClick={onClose}
      role="button"
      tabIndex={0}
    >
      <section aria-modal="true" className="injection-board-history__panel" role="dialog">
        <header className="injection-board-history__header">
          <div>
            <History aria-hidden="true" />
            <span>{copy.previousSummaryTitle}</span>
            <strong>{businessDate}</strong>
          </div>
          <p>{copy.previousSummaryHint}</p>
        </header>

        {isLoading ? <div className="injection-board-history__state">{copy.previousLoading}</div> : null}
        {isError ? <div className="injection-board-history__state injection-board-history__state--error">{copy.previousError}</div> : null}

        {!isLoading && !isError ? (
          <>
            <div className="injection-board-history__kpis">
              <article className="injection-board-history__kpi injection-board-history__kpi--rate">
                <span>{copy.previousPlanResult}</span>
                <strong>{completionRate.toFixed(1)}%</strong>
                <small>{copy.plannedMachinesLabel} {plannedMachines}{copy.machines}</small>
              </article>
              <article className="injection-board-history__kpi injection-board-history__kpi--output">
                <span>{copy.previousTotalOutput}</span>
                <strong>{formatNumber(summary.estimatedQty)}{copy.pieces}</strong>
                <small>{copy.plan} {formatNumber(summary.plannedQty)}{copy.pieces} · {copy.plannedOutputOnly}</small>
              </article>
              <article className="injection-board-history__kpi injection-board-history__kpi--machines">
                <span>{copy.operatedEquipment}</span>
                <strong>{operatedMachines} / {MACHINE_COUNT}{copy.machines}</strong>
                <small>{copy.plannedMachinesLabel} {plannedOperatedMachines}{copy.machines} · {copy.outsidePlanResult} {outsidePlanMachines.length}{copy.machines}</small>
              </article>
              <article className="injection-board-history__kpi injection-board-history__kpi--outside">
                <span>{copy.outsidePlanResult}</span>
                <strong>{formatNumber(outsidePlanShots)}{copy.shots} / {outsidePlanMachines.length}{copy.machines}</strong>
                <small>{outsidePlanMachines.map(({ machineNumber }) => `${machineNumber}${language === "ko" ? "호기" : "号机"}`).join(", ") || copy.noIssue}</small>
              </article>
            </div>

            <div className="injection-board-history__section-title">{copy.machineSummary}</div>
            <div className="injection-board-history__machines">
              {machineRows.map(({ machineNumber, row }) => {
                const hasOutput = Number(row?.shotCount ?? 0) > 0;
                const product = getActiveProduct(row, copy.noPart, copy.noPlan);
                const resultTone = row?.hasPlan
                  ? row.progressRate >= 99.9 ? "complete" : "shortfall"
                  : hasOutput ? "outside" : "idle";
                const resultLabel = row?.hasPlan
                  ? row.progressRate >= 99.9 ? copy.completed : copy.shortfall
                  : hasOutput ? copy.outsidePlanResult : copy.noProduction;
                return (
                  <article
                    className={`injection-board-history-card injection-board-history-card--${resultTone}`}
                    data-machine={machineNumber}
                    key={machineNumber}
                  >
                    <header>
                      <strong>{machineNumber}{language === "ko" ? "호기" : "号机"}</strong>
                      <em>{resultLabel}</em>
                    </header>
                    <div className="injection-board-history-card__part" title={product.part}>{product.part}</div>
                    <div className="injection-board-history-card__timeline" aria-hidden="true">
                      {(timelines[String(machineNumber)] ?? []).map((segment, index) => (
                        <span
                          key={`${machineNumber}-history-${index}`}
                          style={{ left: `${segment.startPct}%`, width: `${segment.widthPct}%` }}
                        />
                      ))}
                    </div>
                    <div className="injection-board-history-card__metrics">
                      <div>
                        <span>{copy.completion}</span>
                        <strong>{row?.hasPlan ? `${row.progressRate.toFixed(1)}%` : "-"}</strong>
                      </div>
                      <div className="injection-board-history-card__shots">
                        <span>{copy.actualShots}</span>
                        <strong>{hasOutput ? `${formatNumber(row?.shotCount ?? 0)}${copy.shots}` : `0${copy.shots}`}</strong>
                      </div>
                      <div>
                        <span>{copy.productionQuantity}</span>
                        <strong>
                          {row?.hasPlan
                            ? `${formatNumber(row.estimatedQty)} / ${formatNumber(row.plannedQty)}`
                            : hasOutput ? copy.quantityPending : copy.noPlan}
                        </strong>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

export function InjectionBoardPage() {
  const [language, setLanguage] = useStoredLanguage();
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));
  const [businessDate, setBusinessDate] = useState(() => getShanghaiBusinessDateString());
  const previousBusinessDate = addIsoDateDays(businessDate, -1);
  const [isPreviousSummaryOpen, setIsPreviousSummaryOpen] = useState(false);
  const [cachedPreviousSnapshot, setCachedPreviousSnapshot] = useState<PreviousBoardSnapshot | null>(
    () => readPreviousSummaryCache(previousBusinessDate),
  );
  const copy = boardCopy[language];
  useReloadOnNewBuild();
  const planQuery = useQuery({
    queryKey: ["production-plan-summary", businessDate, "injection-board"],
    queryFn: () => getProductionPlanSummary(businessDate),
    refetchInterval: BOARD_REFRESH_INTERVAL_MS,
  });
  const statusQuery = useQuery({
    queryKey: ["production-status", businessDate, "injection-board"],
    queryFn: () => getProductionStatus(businessDate),
    refetchInterval: BOARD_REFRESH_INTERVAL_MS,
  });
  const mesQuery = useQuery({
    queryKey: ["mes", "injection-board-matrix", businessDate],
    queryFn: getInjectionProductionMatrix,
    refetchInterval: BOARD_REFRESH_INTERVAL_MS,
  });
  const previousPlanQuery = useQuery({
    queryKey: ["production-plan-summary", previousBusinessDate, "injection-board-history"],
    queryFn: () => getProductionPlanSummary(previousBusinessDate),
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
  const previousStatusQuery = useQuery({
    queryKey: ["production-status", previousBusinessDate, "injection-board-history"],
    queryFn: () => getProductionStatus(previousBusinessDate),
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
  const previousMesQuery = useQuery({
    queryKey: ["mes", "injection-board-history", previousBusinessDate],
    queryFn: () => getInjectionProductionMatrixForDate(previousBusinessDate),
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
  const summary = useMemo(
    () => buildRealtimeProgressSummary(planQuery.data, mesQuery.data, statusQuery.data, businessDate),
    [businessDate, mesQuery.data, planQuery.data, statusQuery.data],
  );
  const previousSummary = useMemo(
    () => buildRealtimeProgressSummary(
      previousPlanQuery.data,
      previousMesQuery.data,
      previousStatusQuery.data,
      previousBusinessDate,
    ),
    [previousBusinessDate, previousMesQuery.data, previousPlanQuery.data, previousStatusQuery.data],
  );
  const previousTimelines = useMemo(
    () => buildBoardTimelines(previousBusinessDate, previousMesQuery.data, previousSummary),
    [previousBusinessDate, previousMesQuery.data, previousSummary],
  );
  const previousQueriesReady = previousPlanQuery.isSuccess && previousStatusQuery.isSuccess && previousMesQuery.isSuccess;
  const visiblePreviousSnapshot = previousQueriesReady
    ? { summary: previousSummary, timelines: previousTimelines }
    : cachedPreviousSnapshot ?? { summary: previousSummary, timelines: previousTimelines };
  const previousSummaryIsLoading = !cachedPreviousSnapshot && !previousQueriesReady
    && (previousPlanQuery.isPending || previousStatusQuery.isPending || previousMesQuery.isPending);
  const previousSummaryIsError = !cachedPreviousSnapshot && !previousQueriesReady
    && (previousPlanQuery.isError || previousStatusQuery.isError || previousMesQuery.isError);
  const latestMesTime = getLatestMesTime(mesQuery.data);
  const isStale = Boolean(latestMesTime && Date.now() - latestMesTime.getTime() > STALE_DATA_THRESHOLD_MS);
  const businessStart = new Date(`${businessDate}T08:00:00+08:00`);
  const businessEnd = new Date(businessStart.getTime() + 24 * 60 * 60 * 1000);
  const elapsedRate = latestMesTime
    ? Math.max(0, Math.min(100, ((latestMesTime.getTime() - businessStart.getTime()) / (businessEnd.getTime() - businessStart.getTime())) * 100))
    : 0;
  const machines = useMemo(
    () => buildBoardMachines(businessDate, summary, mesQuery.data, elapsedRate, isStale, copy.noPart, copy.noPlan),
    [businessDate, copy.noPart, copy.noPlan, elapsedRate, isStale, mesQuery.data, summary],
  );
  const plannedRunningCount = machines.filter((machine) => machine.row?.hasPlan && machine.row.isRunning).length;
  const unplannedRunningCount = machines.filter((machine) => !machine.row?.hasPlan && machine.row?.isRunning).length;
  const totalRunningCount = plannedRunningCount + unplannedRunningCount;
  const idleMachineCount = Math.max(0, MACHINE_COUNT - totalRunningCount);
  const stoppedCount = machines.filter((machine) => machine.tone === "stopped").length;
  const warningCount = machines.filter((machine) => machine.tone === "warning").length;
  const plannedMachineCount = machines.filter((machine) => machine.row?.hasPlan).length;
  const stoppedMachineLabels = machines
    .filter((machine) => machine.tone === "stopped")
    .map((machine) => `${machine.machineNumber}${language === "ko" ? "호기" : "号机"}`)
    .join(", ");
  const unplannedMachineLabels = machines
    .filter((machine) => machine.tone === "unplanned")
    .map((machine) => `${machine.machineNumber}${language === "ko" ? "호기" : "号机"}`)
    .join(", ");
  const completionRate = summary.plannedQty > 0 ? (summary.estimatedQty / summary.plannedQty) * 100 : 0;
  const isLoading = planQuery.isPending || statusQuery.isPending || mesQuery.isPending;
  const isError = planQuery.isError || statusQuery.isError || mesQuery.isError;
  const refreshedAt = Math.max(planQuery.dataUpdatedAt, statusQuery.dataUpdatedAt, mesQuery.dataUpdatedAt);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    const syncBusinessDate = () => {
      const nextBusinessDate = getShanghaiBusinessDateString();
      setBusinessDate((current) => current === nextBusinessDate ? current : nextBusinessDate);
    };
    const timer = window.setInterval(syncBusinessDate, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    prunePreviousSummaryCaches(businessDate);
    setCachedPreviousSnapshot(readPreviousSummaryCache(previousBusinessDate));
    const expiresAt = getPreviousSummaryCacheExpiry(businessDate);
    const timer = window.setTimeout(() => {
      window.localStorage.removeItem(getPreviousSummaryCacheKey(previousBusinessDate));
      setCachedPreviousSnapshot(null);
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [businessDate, previousBusinessDate]);

  useEffect(() => {
    if (!previousQueriesReady) return;
    const snapshot = { summary: previousSummary, timelines: previousTimelines };
    writePreviousSummaryCache(previousBusinessDate, businessDate, snapshot);
    setCachedPreviousSnapshot(snapshot);
  }, [businessDate, previousBusinessDate, previousQueriesReady, previousSummary, previousTimelines]);

  useEffect(() => {
    if (!isPreviousSummaryOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
        setIsPreviousSummaryOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPreviousSummaryOpen]);

  function changeLanguage(nextLanguage: AppLanguage) {
    setLanguage(nextLanguage);
    setStoredLanguage(nextLanguage);
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  }

  return (
    <main className="injection-board">
      <header className="injection-board__topbar">
        <div className="injection-board__title">
          <span aria-hidden="true"><Factory /></span>
          <div>
            <h1>{copy.title}</h1>
          </div>
        </div>
        <div className="injection-board__meta">
          <div><span>{copy.productionDate}</span><strong>{businessDate}</strong></div>
          <div><span>{copy.dataTime}</span><strong>{formatTime(latestMesTime)}</strong></div>
          <div><span>{copy.refreshed}</span><strong>{refreshedAt ? formatTime(new Date(refreshedAt)) : "-"}</strong></div>
          <button
            className="injection-board__history-button"
            onClick={() => setIsPreviousSummaryOpen(true)}
            type="button"
          >
            <History aria-hidden="true" />
            {copy.previousSummary}
          </button>
          <span className="injection-board__refresh-badge">{copy.autoRefresh}</span>
          <div className="injection-board__language" aria-label="Language">
            <button className={language === "ko" ? "is-active" : ""} onClick={() => changeLanguage("ko")} type="button">KOR</button>
            <button className={language === "zh" ? "is-active" : ""} onClick={() => changeLanguage("zh")} type="button">中文</button>
          </div>
          <button
            aria-label={isFullscreen ? copy.exitFullscreen : copy.fullscreen}
            className="injection-board__action"
            onClick={toggleFullscreen}
            title={isFullscreen ? copy.exitFullscreen : copy.fullscreen}
            type="button"
          >
            ⛶
          </button>
          <button className="injection-board__action" onClick={() => window.close()} title={copy.close} type="button">×</button>
        </div>
      </header>

      {isStale ? <div className="injection-board__stale-banner">{copy.staleBanner}</div> : null}
      {isError ? <div className="injection-board__error">{copy.error}</div> : null}

      <section className="injection-board__grid" aria-busy={isLoading}>
        <article className="injection-board-summary injection-board-summary--overview">
          <header>
            <div><span>01</span><strong>{copy.overview}</strong></div>
            <em>{copy.totalMachines} {MACHINE_COUNT}{copy.machines}</em>
          </header>
          <div className="injection-board-summary__hero">
            <strong>{totalRunningCount} / {MACHINE_COUNT}</strong><span>{copy.running}</span>
          </div>
          <div className="injection-board-summary__metrics">
            <span>{copy.plannedEquipment}<strong>{plannedRunningCount} / {plannedMachineCount}{copy.machines}</strong></span>
            <span>{copy.unplannedRunning}<strong>{unplannedRunningCount}{copy.machines}</strong></span>
            <span>{copy.idle}<strong>{idleMachineCount}{copy.machines}</strong></span>
          </div>
          <footer><span>{copy.stoppedMachines}</span><strong>{stoppedMachineLabels || copy.noIssue}</strong></footer>
        </article>

        <article className="injection-board-summary injection-board-summary--plan">
          <header>
            <div><span>02</span><strong>{copy.planProgress}</strong></div>
            <em>{copy.timeProgress} {elapsedRate.toFixed(1)}%</em>
          </header>
          <div className="injection-board-summary__hero">
            <strong>{completionRate.toFixed(1)}%</strong><span>{copy.completion}</span>
          </div>
          <div className="injection-board-summary__metrics">
            <span>{copy.totalActual}<strong>{formatNumber(summary.estimatedQty)}</strong></span>
            <span>{copy.totalPlan}<strong>{formatNumber(summary.plannedQty)}</strong></span>
            <span>{copy.timeProgress}<strong>{elapsedRate.toFixed(1)}%</strong></span>
          </div>
          <footer>
            <span>{copy.progressGap}</span>
            <strong>{completionRate - elapsedRate >= 0 ? "+" : ""}{(completionRate - elapsedRate).toFixed(1)}%p</strong>
          </footer>
        </article>

        <article className="injection-board-summary injection-board-summary--alerts">
          <header>
            <div><span>03</span><strong>{copy.actionRequired}</strong></div>
            <em>{copy.managementRequired}</em>
          </header>
          <div className="injection-board-summary__hero">
            <strong>{stoppedCount + warningCount + unplannedRunningCount}{copy.machines}</strong><span>{copy.managementRequired}</span>
          </div>
          <div className="injection-board-summary__metrics">
            <span>{copy.plannedStops}<strong>{stoppedCount}{copy.machines}</strong></span>
            <span>{copy.rateWarnings}<strong>{warningCount}{copy.machines}</strong></span>
            <span>{copy.unplanned}<strong>{unplannedRunningCount}{copy.machines}</strong></span>
          </div>
          <footer>
            <span>{copy.unplannedRunning}</span>
            <strong>{unplannedMachineLabels || copy.noIssue}</strong>
          </footer>
        </article>

        {machines.map((machine) => <MachineBoardCard key={machine.machineNumber} language={language} machine={machine} />)}
      </section>

      {isLoading ? <div className="injection-board__loading">{copy.loading}</div> : null}
      {isPreviousSummaryOpen ? (
        <PreviousDaySummary
          businessDate={previousBusinessDate}
          isError={previousSummaryIsError}
          isLoading={previousSummaryIsLoading}
          language={language}
          onClose={() => setIsPreviousSummaryOpen(false)}
          summary={visiblePreviousSnapshot.summary}
          timelines={visiblePreviousSnapshot.timelines}
        />
      ) : null}
    </main>
  );
}
