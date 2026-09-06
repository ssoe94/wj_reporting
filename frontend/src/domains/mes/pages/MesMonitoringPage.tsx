import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { buildInjectionLink, resolveInjectionScope } from "@/domains/injection/workspace";
import { useShanghaiBusinessDate } from "@/shared/hooks/useShanghaiBusinessDate";
import { getShanghaiBusinessDateString, getShanghaiDateString } from "@/shared/utils/date";
import { coversMonitoringWindow, hasObservedCapacityInWindow, isMonitoringSlotInWindow, trimMonitoringSlots, getMonitoringCoverage, getMonitoringState, hasMonitoringMatrix, type MonitoringState } from "@/domains/mes/monitoring-state";
import {
  type InjectionProductionMatrix,
  getInjectionMonitoringDates,
  getInjectionSnapshotUpdateStatus,
  getInjectionProductionMatrix,
  getInjectionProductionMatrixForDate,
  getInjectionUtilizationMatrix,
  requestInjectionSnapshotUpdate,
} from "@/domains/mes/api";
import {
  getInjectionDowntimeConfirmations,
  getProductionMesReportStats,
  getProductionPlanSummary,
  resetInjectionDowntimeConfirmation,
  saveInjectionDowntimeConfirmation,
  type ProductionMesReportStatsResponse,
} from "@/domains/production/api";
import { InjectionTransitionPanel } from "@/domains/production/components/InjectionTransitionPanel";
import { buildInjectionTransitionAnalysis } from "@/domains/production/injection-transition-analysis";
import { PageHeaderIcon } from "@/shared/components/PageHeader";
import { useAuth } from "@/domains/auth/auth-context";
import { isDevSessionActive } from "@/domains/auth/dev-session";
import { type AppLanguage, useStoredLanguage } from "@/shared/i18n/language";

type InjectionMachineRow = {
  machineNumber: number;
  name: string;
  tonnage: string;
  latestOutput: number;
  cumulativeOutput: number;
  oilTemperature: number | null;
  powerUsage: number | null;
  powerTotal: number | null;
  shiftOutput: number;
  recentOutput: number;
  status: "running" | "idle" | "warning";
};

type PeriodSummary = {
  output: number;
  power: number | null;
  oilTemperature: number | null;
};

type UtilizationSummary = {
  rate: number | null;
  runningMinutes: number;
  totalMinutes: number;
  output: number;
  activeMachines?: number;
};

type DailyUtilizationPoint = {
  date: string;
  label: string;
  activeMachines: number;
  utilizationRate: number | null;
  runningMinutes: number;
  totalMinutes: number;
};

type ProductionWindowSummary = {
  output: number;
  activeHours: number;
  startTime: Date | null;
  endTime: Date | null;
};

type HourlyTrendPoint = {
  label: string;
  dateLabel: string;
  startTime: Date;
  endTime: Date;
  hour: number;
  isDayBreak: boolean;
  output: number | null;
  power: number | null;
  oilTemperature: number | null;
};

type HourlyTrendScale = {
  powerMax: number;
  oilMax: number;
};

type MesInfoView = "production" | "inventory";

const pageCopy = {
  ko: {
    eyebrow: "MES MONITORING",
    title: "MES 데이터 모니터링",
    description: "MES에서 수집한 생산·설비 데이터를 저장하고 모니터링합니다.",
    availableData: "조회 가능 데이터",
    sourceDescriptionProduction: "사출기 모니터링과 가공 생산보고를 같은 기준일로 확인합니다.",
    sourceDescriptionInjection: "사출기의 생산량, 형합수, 오일온도, 전력 사용량을 확인할 수 있습니다.",
    sourceDescriptionMachining: "가공 생산 완료 보고를 연결해 계획 대비 진행률과 미보고 항목을 확인할 예정입니다.",
    sourceDescriptionInventory: "재고 API를 연결해 품번별 현재고, 부족 수량, 입출고 변동을 확인할 예정입니다.",
    selectHint: "현재 선택",
    injectionDate: "기준일",
    savedDateHint: "저장된 MES 스냅샷 기준일을 선택해 과거 데이터를 조회합니다.",
    latestLiveMode: "현재 기준일은 자동 갱신됩니다.",
    historicalSnapshotMode: "저장된 스냅샷 조회 중",
    productionInfo: "생산 정보",
    inventoryInfo: "재고 정보",
    injection: "사출기 정보",
    machining: "가공 생산보고 정보",
    inventory: "재고 정보",
    refresh: "최근 24시간 보강 수집",
    refreshing: "보강 수집 중",
    loadingData: "MES 데이터를 불러오는 중입니다.",
    backfillProgress: "보강 진행률",
    lastUpdated: "마지막 갱신",
    activeMachines: "최근 60분 형합 설비",
    todayOutput: "선택일 추정 생산 / 계획 (ea)",
    recentOutput60: "최근 60분 형합수",
    recentAvgOil60: "최근 60분 평균 오일온도",
    avgOil: "평균 오일온도",
    todayPowerUsage: "선택일 전력 참고값",
    fleetProductionEyebrow: "INJECTION TOTAL",
    fleetProductionTitle: "전체 설비 시간대 형합 참고",
    fleetProductionDescription: "원시 계측 구간의 형합 합계입니다. 일일 ea 실적과 품목 배분은 공통 생산 집계를 기준으로 확인합니다.",
    fleetPlanProgress: "계획 진행률",
    fleetPlanGap: "계획 대비",
    fleetMachineSpread: "설비별 생산 분포",
    fleetElapsedUph: "생산구간 형합/시간",
    fleetMachineTotal: "총",
    uph: "형합/h",
    planShortage: "계획 대비 부족",
    planReady: "계획 수량 기준",
    utilization24: "형합 기반 활동 비율 (24h)",
    utilizationModalTitle: "형합 활동 상세 분석",
    utilizationModalSubtitle: "날짜별 형합 설비 수와 활동 비율 · 근무 계획 미반영",
    utilizationPeriod: "분석 기간",
    utilizationStartDate: "시작일",
    utilizationEndDate: "종료일",
    recentTwoWeeks: "최근 2주",
    utilizationRate: "형합 기반 활동 비율",
    activeMachineCount: "형합 설비 수",
    utilizationSavedAt: "저장 갱신",
    close: "닫기",
    previous60: "직전 60분 대비",
    previousDay: "전일 동시간 대비",
    noCompareData: "비교 데이터 부족",
    injectionTitle: "사출기 시간대 신호",
    injectionHint: "1~17호기를 순서대로 확인하고, 선택한 호기의 24시간 추세를 분석합니다.",
    machineRailTitle: "설비 선택",
    machineRailHint: "호기를 선택하면 아래 요약과 추이 그래프가 해당 설비 기준으로 변경됩니다.",
    selectedMachine: "선택 설비",
    shiftSummary: "선택일 08:00 ~ 기준 시각",
    recentSummary: "최근 60분",
    trendTitle: "최근 24시간 추이",
    trendHint: "수집 구간을 정시간 단위로 집계합니다. 형합수는 관측 구간의 증가량이며 전력은 계기 누적값 차이에 따른 참고값입니다.",
    output: "형합수",
    cumulative: "누적",
    todayCumulative: "선택일 누적",
    oil: "오일온도",
    power: "전력",
    powerTotal: "누적 전력",
    totalOutput: "총 형합수",
    totalPower: "총 전력량",
    trendOutput: "정시간 형합수",
    trendPower: "전력 사용량",
    trendOil: "오일온도",
    running: "최근 형합 관측",
    idle: "최근 형합 미관측",
    warning: "확인 필요",
    noData: "데이터 없음",
    fetchError: "MES 데이터를 불러오지 못했습니다.",
    savedByBackend: "수집 시 백엔드 DB에 시간대별 기록으로 저장됩니다.",
    injectionReceiptTitle: "MES 입고 / 형합수 비교",
    injectionReceiptBody: "MES 입고 보고 수량을 같은 설비·품번의 형합수 기반 추정 생산량과 비교합니다.",
    injectionReceiptEstimated: "형합수 추정",
    injectionReceiptReported: "MES 입고",
    injectionReceiptGap: "MES-형합수",
    injectionReceiptIssue: "확인 필요",
    injectionReceiptMachine: "설비",
    injectionReceiptPartNo: "작업지시 Part No.",
    injectionReceiptSourcePartNo: "MES Part No.",
    injectionReceiptModel: "모델",
    injectionReceiptPlan: "계획",
    injectionReceiptStatus: "대사 상태",
    injectionReceiptLatest: "최신 MES",
    injectionReceiptMatched: "수량 일치",
    injectionReceiptShortage: "MES 입고 부족",
    injectionReceiptOver: "MES 입고 초과",
    injectionReceiptMissing: "MES 미입고",
    injectionReceiptOnly: "형합수 없음",
    injectionReceiptMatchBy: "매칭 기준",
    injectionReceiptDirectPartNo: "직접 Part No.",
    injectionReceiptModelCandidate: "모델/품번 후보",
    injectionReceiptEquipmentCorrected: "설비 보정",
    injectionReceiptUnmatched: "미매칭",
    injectionReceiptSourceMachine: "MES 설비",
    injectionReceiptEmpty: "비교할 MES 입고 또는 형합수 추정 실적이 없습니다.",
    machiningTitle: "가공 생산보고 모니터링",
    machiningBody: "Blacklake 报工记录列表의 JG/加工 보고를 생산 계획과 비교합니다.",
    machiningDate: "기준일",
    machiningTotalPlan: "가공 계획",
    machiningTotalMes: "MES 보고",
    machiningAchievement: "달성률",
    machiningGap: "계획 대비 차이",
    machiningUnreported: "미보고 항목",
    machiningLatest: "최신 보고",
    machiningTableTitle: "라인별 생산보고",
    machiningTableHint: "오전 08:00 ~ 익일 08:00 기준으로 报工数量을 Part No. 계획에 매칭합니다.",
    machiningLine: "라인",
    machiningPartNo: "Part No.",
    machiningModel: "모델",
    machiningPlanned: "계획",
    machiningReported: "보고",
    machiningReports: "보고 건수",
    machiningStatus: "상태",
    machiningMatched: "매칭",
    machiningPlanOnly: "미보고",
    machiningMesOnly: "계획 없음",
    machiningEmpty: "가공 계획 또는 MES 생산보고가 없습니다.",
    transitionEyebrow: "INJECTION STOP ANALYSIS",
    transitionTitle: "사출 정지/전환 분석",
    transitionDescription: "MES 형합수에서 10분 이상 무생산 구간을 찾고, 생산계획과 Part No를 비교해 금형 교체, 코어 교체, 사출조건준비(调机), 생산 중지 후보로 분류합니다. 계획이 없거나 작업지시 사이 장기 대기인 일반 정지는 제외합니다.",
    transitionEventCount: "정지 후보",
    moldChangeTime: "금형 교체",
    coreChangeTime: "코어 교체",
    tuningTime: "사출조건준비(调机)",
    productionStopTime: "생산 중지",
    moldChangeEstimate: "금형 교체 추정",
    coreChangeEstimate: "코어 교체 추정",
    productionStopEstimate: "생산 중지",
    tuningEstimate: "사출조건준비(调机)",
    requiresInjectionNote: "사출과 확인 필요",
    noTransitionEvents: "전체 사출기에서 10분 이상 정지 후보가 없습니다.",
    duration: "소요",
    stableStart: "양산 안정 시작",
    eventEvidence: "판정 근거",
    fromTo: "전환",
    producedBeforeStop: "정지 전 생산",
    targetWorkOrder: "작업지시",
    overproductionFlag: "초과 생산 확인 필요",
    advanceProductionFlag: "선행 생산 가능성",
    planDate: "계획일",
    outputQty: "형합수",
    inventoryTitle: "재고 정보 모니터링",
    inventoryBody: "재고 API 연결 후 품번별 현재고, 계획 대비 부족 수량, 입출고 변동을 같은 구조로 조회합니다.",
    readyStatus: "API 계약 준비",
  },
  zh: {
    eyebrow: "MES MONITORING",
    title: "MES 数据监控",
    description: "保存并监控 MES 采集的生产与设备数据。",
    availableData: "可查询数据",
    sourceDescriptionProduction: "按同一基准日查看注塑监控与加工生产报告。",
    sourceDescriptionInjection: "可查看注塑机合模数、油温和电力使用量。",
    sourceDescriptionMachining: "后续连接加工生产完成报告，用于查看计划对比进度和未报告项目。",
    sourceDescriptionInventory: "后续连接库存 API，用于查看品号当前库存、缺口数量和出入库变动。",
    selectHint: "当前选择",
    injectionDate: "基准日",
    savedDateHint: "选择已保存的 MES 快照基准日查看历史数据。",
    latestLiveMode: "当前基准日会自动刷新。",
    historicalSnapshotMode: "正在查看已保存快照",
    productionInfo: "生产信息",
    inventoryInfo: "库存信息",
    injection: "注塑机信息",
    machining: "加工生产报告",
    inventory: "库存信息",
    refresh: "补采最近 24 小时",
    refreshing: "补采中",
    loadingData: "正在读取 MES 数据。",
    backfillProgress: "补采进度",
    lastUpdated: "最后更新",
    activeMachines: "近60分钟有合模设备",
    todayOutput: "所选日估算产量 / 计划 (ea)",
    recentOutput60: "最近 60 分钟合模数",
    recentAvgOil60: "最近 60 分钟平均油温",
    avgOil: "平均油温",
    todayPowerUsage: "所选日电力参考值",
    fleetProductionEyebrow: "INJECTION TOTAL",
    fleetProductionTitle: "全部设备时段模次参考",
    fleetProductionDescription: "原始观测区间模次合计。日实绩 ea 与品号分配以统一生产汇总为准。",
    fleetPlanProgress: "计划进度",
    fleetPlanGap: "计划对比",
    fleetMachineSpread: "设备产量分布",
    fleetElapsedUph: "生产区间模次/小时",
    fleetMachineTotal: "总",
    uph: "模次/h",
    planShortage: "计划差额",
    planReady: "按计划数量",
    utilization24: "合模活动比例 (24h)",
    utilizationModalTitle: "合模活动详细分析",
    utilizationModalSubtitle: "每日合模设备数与活动比例 · 未纳入工作计划",
    utilizationPeriod: "分析期间",
    utilizationStartDate: "开始日",
    utilizationEndDate: "结束日",
    recentTwoWeeks: "最近2周",
    utilizationRate: "合模活动比例",
    activeMachineCount: "合模设备数",
    utilizationSavedAt: "保存更新",
    close: "关闭",
    previous60: "较前 60 分钟",
    previousDay: "较昨日同时段",
    noCompareData: "比较数据不足",
    injectionTitle: "注塑机时段信号",
    injectionHint: "按 1~17 号设备顺序查看，并分析所选设备的 24 小时趋势。",
    machineRailTitle: "设备选择",
    machineRailHint: "选择设备后，下方摘要和趋势图会按该设备更新。",
    selectedMachine: "所选设备",
    shiftSummary: "所选日 08:00 ~ 参考时间",
    recentSummary: "最近 60 分钟",
    trendTitle: "最近 24 小时趋势",
    trendHint: "按整点汇总采集区间。模次为观测区间增量，电力为电表累计值差额的参考值。",
    output: "合模数",
    cumulative: "累计",
    todayCumulative: "所选日累计",
    oil: "油温",
    power: "电力",
    powerTotal: "累计电力",
    totalOutput: "总合模数",
    totalPower: "总电量",
    trendOutput: "整点合模数",
    trendPower: "电力使用量",
    trendOil: "油温",
    running: "近期观测到合模",
    idle: "近期未观测到合模",
    warning: "需确认",
    noData: "无数据",
    fetchError: "无法读取 MES 数据。",
    savedByBackend: "采集时会按时间段保存到后端数据库。",
    injectionReceiptTitle: "MES 入库 / 合模数对比",
    injectionReceiptBody: "将 MES 入库报工数量与同一设备、品号的合模数推定生产量进行对账。",
    injectionReceiptEstimated: "合模数推定",
    injectionReceiptReported: "MES 入库",
    injectionReceiptGap: "MES-合模数",
    injectionReceiptIssue: "需确认",
    injectionReceiptMachine: "设备",
    injectionReceiptPartNo: "工单 Part No.",
    injectionReceiptSourcePartNo: "MES Part No.",
    injectionReceiptModel: "型号",
    injectionReceiptPlan: "计划",
    injectionReceiptStatus: "对账状态",
    injectionReceiptLatest: "最新 MES",
    injectionReceiptMatched: "数量一致",
    injectionReceiptShortage: "MES 入库不足",
    injectionReceiptOver: "MES 入库超出",
    injectionReceiptMissing: "未入 MES",
    injectionReceiptOnly: "无合模数",
    injectionReceiptMatchBy: "匹配依据",
    injectionReceiptDirectPartNo: "直接 Part No.",
    injectionReceiptModelCandidate: "型号/品号候选",
    injectionReceiptEquipmentCorrected: "设备校正",
    injectionReceiptUnmatched: "未匹配",
    injectionReceiptSourceMachine: "MES 设备",
    injectionReceiptEmpty: "暂无可比较的 MES 入库或合模数推定实绩。",
    machiningTitle: "加工生产报告监控",
    machiningBody: "对接 Blacklake 报工记录列表中的 JG/加工报告，并与生产计划比较。",
    machiningDate: "基准日",
    machiningTotalPlan: "加工计划",
    machiningTotalMes: "MES 报工",
    machiningAchievement: "达成率",
    machiningGap: "计划差异",
    machiningUnreported: "未报工项目",
    machiningLatest: "最新报工",
    machiningTableTitle: "按线别生产报工",
    machiningTableHint: "按上午 08:00 ~ 次日 08:00 将报工数量匹配到 Part No. 计划。",
    machiningLine: "线别",
    machiningPartNo: "Part No.",
    machiningModel: "型号",
    machiningPlanned: "计划",
    machiningReported: "报工",
    machiningReports: "报工数",
    machiningStatus: "状态",
    machiningMatched: "匹配",
    machiningPlanOnly: "未报工",
    machiningMesOnly: "无计划",
    machiningEmpty: "暂无加工计划或 MES 报工。",
    transitionEyebrow: "INJECTION STOP ANALYSIS",
    transitionTitle: "注塑停机/切换分析",
    transitionDescription: "从 MES 合模数识别 10 分钟以上无生产区间，并结合生产计划和 Part No 分类为模具更换、型芯更换、调机、生产停机候选。无计划或工单之间长时间等待的一般停机不纳入候选。",
    transitionEventCount: "停机候选",
    moldChangeTime: "模具更换",
    coreChangeTime: "型芯更换",
    tuningTime: "调机",
    productionStopTime: "生产停机",
    moldChangeEstimate: "模具更换推定",
    coreChangeEstimate: "型芯更换推定",
    productionStopEstimate: "生产停机",
    tuningEstimate: "调机",
    requiresInjectionNote: "注塑科需确认",
    noTransitionEvents: "全部注塑机暂无 10 分钟以上停机候选。",
    duration: "耗时",
    stableStart: "量产稳定开始",
    eventEvidence: "判断依据",
    fromTo: "切换",
    producedBeforeStop: "停机前产量",
    targetWorkOrder: "工单",
    overproductionFlag: "超计划生产需确认",
    advanceProductionFlag: "可能提前生产",
    planDate: "计划日",
    outputQty: "合模数",
    inventoryTitle: "库存信息监控",
    inventoryBody: "库存 API 连接后，以相同结构查看品号별 현재库存、计划缺口和出入库变动。",
    readyStatus: "API 契约准备中",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

const infoOptions = [
  { value: "production", labelKey: "productionInfo" },
  { value: "inventory", labelKey: "inventoryInfo" },
] satisfies Array<{ value: MesInfoView; labelKey: "productionInfo" | "inventoryInfo" }>;

function numberAt(values: number[] | undefined, index: number) {
  if (!values || index < 0) return 0;
  return Number(values[index] ?? 0);
}

function nullableNumberAt(values: number[] | undefined, index: number) {
  if (!values || index < 0 || values[index] === undefined || values[index] === null) return null;
  const value = Number(values[index]);
  return Number.isFinite(value) && value !== 0 ? value : null;
}

function finiteNumberAt(values: number[] | undefined, index: number) {
  if (!values || index < 0 || values[index] === undefined || values[index] === null) return null;
  const value = Number(values[index]);
  return Number.isFinite(value) ? value : null;
}

function formatNumber(value: number) {
  return Math.round(value).toLocaleString();
}

function formatDecimal(value: number | null, digits = 1) {
  if (value === null) return "-";
  return value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatTemperature(value: number | null) {
  return value === null ? "-" : `${formatDecimal(value)}°C`;
}

function formatPercent(value: number | null) {
  return value === null ? "-" : `${formatDecimal(value, 1)}%`;
}

function formatSignedNumber(value: number, suffix = "") {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatDecimal(value, suffix ? 1 : 0)}${suffix}`;
}

function formatSignedInteger(value: number, suffix = "") {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatNumber(value)}${suffix}`;
}

function formatSignedQty(value: number) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatNumber(value)}`;
}

function compareStatusLabel(
  status: ProductionMesReportStatsResponse["rows"][number]["compare_status"],
  copy: Record<string, string>,
) {
  if (status === "matched") return copy.machiningMatched;
  if (status === "plan_only") return copy.machiningPlanOnly;
  return copy.machiningMesOnly;
}

function formatTonnage(value: string) {
  return value.endsWith("T") ? value : `${value}T`;
}

function formatLocalizedMachineName(value: string, language: AppLanguage) {
  return language === "zh" ? value.replace(/호기/g, "号机") : value;
}

function formatDateParam(value: Date) {
  return getShanghaiDateString(value);
}

function startOfLocalDay(value: Date) {
  return new Date(`${getShanghaiDateString(value)}T00:00:00+08:00`);
}

function startOfProductionDay(value: Date) {
  return new Date(`${getShanghaiBusinessDateString(value)}T08:00:00+08:00`);
}

function getShanghaiHour(value: Date) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }).format(value)) % 24;
}

function getBusinessDayStart(businessDate: string) {
  return new Date(`${businessDate}T08:00:00+08:00`);
}

function getBusinessDayEnd(businessDate: string) {
  return new Date(getBusinessDayStart(businessDate).getTime() + 24 * 60 * 60 * 1000);
}

function getBusinessDayReferenceEnd(businessDate: string, latestTime: Date | null) {
  const start = getBusinessDayStart(businessDate);
  const end = getBusinessDayEnd(businessDate);
  if (!latestTime) return end;
  return new Date(Math.min(Math.max(latestTime.getTime(), start.getTime()), end.getTime()));
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function clampDateRangeColumns(startDate: string, latestTime: Date | null) {
  if (!startDate || !latestTime) return 336;
  const start = startOfLocalDay(new Date(startDate));
  const hours = hoursBetween(start, latestTime) + 24;
  return Math.min(1440, Math.max(336, hours));
}

function hoursBetween(startTime: Date, endTime: Date) {
  const diff = Math.ceil((endTime.getTime() - startTime.getTime()) / (60 * 60 * 1000));
  return Number.isFinite(diff) && diff > 0 ? diff : 0;
}

function formatDateTime(value: string, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatHourLabel(value: Date, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hour12: false,
  }).format(value);
}

function formatShortDate(value: Date, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function formatTooltipDate(value: Date, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
  }).format(value);
}

function formatTooltipTime(value: Date, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function dateKey(value: Date) {
  return getShanghaiDateString(value);
}

function getShiftSectionInfo(value: Date, language: AppLanguage) {
  const hour = getShanghaiHour(value);
  const ownerDate = startOfProductionDay(value);

  const shift: "day" | "night" = hour >= 8 && hour < 20 ? "day" : "night";
  return {
    key: `${dateKey(ownerDate)}-${shift}`,
    dateLabel: formatShortDate(ownerDate, language),
    shift,
    shiftLabel: language === "ko"
      ? (shift === "day" ? "Day" : "Night")
      : (shift === "day" ? "白" : "夜"),
    ownerDate,
  };
}

function buildRows(data?: InjectionProductionMatrix, businessDate?: string): InjectionMachineRow[] {
  if (!data || !data.time_slots?.length) return [];
  const latestIndex = data.time_slots.length - 1;
  const latestTime = getLatestTime(data);
  const shiftStartTime = businessDate ? getBusinessDayStart(businessDate) : getShiftStart(latestTime);
  const referenceEndTime = businessDate ? getBusinessDayReferenceEnd(businessDate, latestTime) : latestTime;
  const recentStartTime = referenceEndTime ? new Date(referenceEndTime.getTime() - 60 * 60 * 1000) : null;

  return (data.machines ?? []).map((machine) => {
    const key = String(machine.machine_number);
    const latestOutput = numberAt(data.actual_production_matrix?.[key], latestIndex);
    const shiftOutput = buildPeriodSummary(data, machine.machine_number, shiftStartTime, referenceEndTime).output;
    const recentOutput = buildPeriodSummary(data, machine.machine_number, recentStartTime, referenceEndTime).output;
    const cumulativeOutput = numberAt(data.cumulative_production_matrix?.[key], latestIndex);
    const oilTemperature = nullableNumberAt(data.oil_temperature_matrix?.[key], latestIndex);
    const powerUsage = nullableNumberAt(data.power_usage_matrix?.[key], latestIndex);
    const powerTotal = nullableNumberAt(data.power_kwh_matrix?.[key], latestIndex);
    const source = data.machine_sources?.[key];
    const status = source?.status !== "ok" ? "warning" : recentOutput > 0 ? "running" : "idle";

    return {
      machineNumber: machine.machine_number,
      name: machine.machine_name,
      tonnage: machine.tonnage,
      latestOutput,
      cumulativeOutput,
      oilTemperature,
      powerUsage,
      powerTotal,
      shiftOutput,
      recentOutput,
      status,
    };
  });
}

function getLatestTime(data?: InjectionProductionMatrix) {
  const latestSlot = data?.time_slots?.at(-1);
  if (!latestSlot) return null;
  // Source slots are [start, end); include the final observed bucket, then cap by business day.
  const minutes = latestSlot.interval_minutes ?? (data?.time_slots.length && data.time_slots.length > 1
    ? (Date.parse(latestSlot.time) - Date.parse(data.time_slots[data.time_slots.length - 2].time)) / 60_000 : 2);
  return new Date(Date.parse(latestSlot.time) + minutes * 60_000);
}

function getShiftStart(latestTime: Date | null) {
  return latestTime ? startOfProductionDay(latestTime) : null;
}

function findLastFiniteValueAtOrBefore(
  data: InjectionProductionMatrix,
  values: number[] | undefined,
  targetTime: Date,
) {
  let matchedValue: number | null = null;
  for (let index = 0; index < data.time_slots.length; index += 1) {
    const slotTime = new Date(data.time_slots[index].time);
    if (slotTime > targetTime) break;
    const value = finiteNumberAt(values, index);
    if (value !== null) {
      matchedValue = value;
    }
  }
  return matchedValue;
}

function buildCumulativePowerUsage(
  data: InjectionProductionMatrix,
  powerTotalRow: number[] | undefined,
  startTime: Date,
  endTime: Date,
) {
  if (!powerTotalRow?.length) return null;

  const startValue = findLastFiniteValueAtOrBefore(data, powerTotalRow, startTime);
  const endValue = findLastFiniteValueAtOrBefore(data, powerTotalRow, endTime);
  if (startValue !== null && endValue !== null && endValue >= startValue) {
    return endValue - startValue;
  }

  let previousValue = startValue;
  let usage = 0;
  let hasUsage = false;
  (data.time_slots ?? []).forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    if (!isMonitoringSlotInWindow(slotTime.getTime(), startTime, endTime)) return;

    const currentValue = finiteNumberAt(powerTotalRow, index);
    if (currentValue === null) return;

    if (previousValue !== null && currentValue >= previousValue) {
      usage += currentValue - previousValue;
      hasUsage = true;
    }
    previousValue = currentValue;
  });

  return hasUsage ? usage : null;
}

function buildFallbackPowerUsage(
  data: InjectionProductionMatrix,
  powerUsageRow: number[] | undefined,
  startTime: Date,
  endTime: Date,
) {
  let usage = 0;
  let hasUsage = false;
  (data.time_slots ?? []).forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    if (!isMonitoringSlotInWindow(slotTime.getTime(), startTime, endTime)) return;

    const powerValue = nullableNumberAt(powerUsageRow, index);
    if (powerValue !== null) {
      usage += powerValue;
      hasUsage = true;
    }
  });

  return hasUsage ? usage : null;
}

function buildPowerUsage(
  data: InjectionProductionMatrix,
  powerTotalRow: number[] | undefined,
  powerUsageRow: number[] | undefined,
  startTime: Date,
  endTime: Date,
) {
  return buildCumulativePowerUsage(data, powerTotalRow, startTime, endTime)
    ?? buildFallbackPowerUsage(data, powerUsageRow, startTime, endTime);
}

function buildPeriodSummary(
  data: InjectionProductionMatrix | undefined,
  machineNumber: number,
  startTime: Date | null,
  endTime: Date | null,
): PeriodSummary {
  if (!data || !startTime || !endTime) {
    return { output: 0, power: null, oilTemperature: null };
  }

  const productionRow = getMachineMatrixValues(data, data.actual_production_matrix, machineNumber);
  const powerUsageRow = getMachineMatrixValues(data, data.power_usage_matrix, machineNumber);
  const powerTotalRow = getMachineMatrixValues(data, data.power_kwh_matrix, machineNumber);
  const oilTemperatureRow = getMachineMatrixValues(data, data.oil_temperature_matrix, machineNumber);
  let output = 0;
  let oilTotal = 0;
  let oilCount = 0;

  (data.time_slots ?? []).forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    if (!isMonitoringSlotInWindow(slotTime.getTime(), startTime, endTime)) return;

    output += numberAt(productionRow, index);

    const oilValue = nullableNumberAt(oilTemperatureRow, index);
    if (oilValue !== null) {
      oilTotal += oilValue;
      oilCount += 1;
    }
  });

  return {
    output,
    power: buildPowerUsage(data, powerTotalRow, powerUsageRow, startTime, endTime),
    oilTemperature: oilCount > 0 ? oilTotal / oilCount : null,
  };
}

function buildFleetPeriodSummary(
  data: InjectionProductionMatrix | undefined,
  startTime: Date | null,
  endTime: Date | null,
): PeriodSummary {
  if (!data || !startTime || !endTime) {
    return { output: 0, power: null, oilTemperature: null };
  }

  let output = 0;
  let power = 0;
  let hasPower = false;
  let oilTotal = 0;
  let oilCount = 0;

  (data.machines ?? []).forEach((machine) => {
    const summary = buildPeriodSummary(data, machine.machine_number, startTime, endTime);
    output += summary.output;
    if (summary.power !== null) {
      power += summary.power;
      hasPower = true;
    }
    if (summary.oilTemperature !== null) {
      oilTotal += summary.oilTemperature;
      oilCount += 1;
    }
  });

  return {
    output,
    power: hasPower ? power : null,
    oilTemperature: oilCount > 0 ? oilTotal / oilCount : null,
  };
}

function getSlotIntervalMinutes(data: InjectionProductionMatrix, index: number) {
  const explicitInterval = data.time_slots?.[index]?.interval_minutes;
  if (explicitInterval) return explicitInterval;

  const currentTime = new Date(data.time_slots?.[index]?.time ?? 0);
  const nextSlot = data.time_slots?.[index + 1];
  if (!Number.isNaN(currentTime.getTime()) && nextSlot) {
    const nextTime = new Date(nextSlot.time);
    const diffMinutes = (nextTime.getTime() - currentTime.getTime()) / (60 * 1000);
    if (diffMinutes > 0) return diffMinutes;
  }

  return 2;
}

function getMachineMatrixValues(
  data: InjectionProductionMatrix | undefined,
  matrix: Record<string, number[]> | undefined,
  machineNumber: number,
) {
  if (!data || !matrix) return [];
  const machine = data.machines?.find((item) => item.machine_number === machineNumber);
  const candidateKeys = [
    String(machineNumber),
    machine?.machine_name,
    machine?.display_name,
    `${machineNumber}호기`,
  ].filter((value): value is string => Boolean(value));

  for (const key of candidateKeys) {
    const values = matrix[key];
    if (values) return values;
  }

  return [];
}

function buildMachineProductionWindow(
  data: InjectionProductionMatrix | undefined,
  machineNumber: number,
  startTime: Date | null,
  endTime: Date | null,
): ProductionWindowSummary {
  if (!data || !startTime || !endTime) {
    return { output: 0, activeHours: 0, startTime: null, endTime: null };
  }

  const productionRow = getMachineMatrixValues(data, data.actual_production_matrix, machineNumber);
  let output = 0;
  let firstProductionMs: number | null = null;
  let lastProductionEndMs: number | null = null;

  (data.time_slots ?? []).forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    if (!isMonitoringSlotInWindow(slotTime.getTime(), startTime, endTime)) return;

    const slotOutput = numberAt(productionRow, index);
    if (slotOutput <= 0) return;

    output += slotOutput;
    firstProductionMs = firstProductionMs ?? slotTime.getTime();
    lastProductionEndMs = slotTime.getTime() + getSlotIntervalMinutes(data, index) * 60 * 1000;
  });

  const activeHours = firstProductionMs !== null && lastProductionEndMs !== null
    ? Math.max(1 / 60, (lastProductionEndMs - firstProductionMs) / (60 * 60 * 1000))
    : 0;

  return {
    output,
    activeHours,
    startTime: firstProductionMs === null ? null : new Date(firstProductionMs),
    endTime: lastProductionEndMs === null ? null : new Date(lastProductionEndMs),
  };
}

function buildFleetProductionWindow(
  data: InjectionProductionMatrix | undefined,
  startTime: Date | null,
  endTime: Date | null,
): ProductionWindowSummary {
  if (!data || !startTime || !endTime) {
    return { output: 0, activeHours: 0, startTime: null, endTime: null };
  }

  return data.machines.reduce<ProductionWindowSummary>((summary, machine) => {
    const machineWindow = buildMachineProductionWindow(data, machine.machine_number, startTime, endTime);
    summary.output += machineWindow.output;
    if (machineWindow.startTime && (!summary.startTime || machineWindow.startTime < summary.startTime)) {
      summary.startTime = machineWindow.startTime;
    }
    if (machineWindow.endTime && (!summary.endTime || machineWindow.endTime > summary.endTime)) {
      summary.endTime = machineWindow.endTime;
    }
    summary.activeHours = summary.startTime && summary.endTime
      ? Math.max(1 / 60, (summary.endTime.getTime() - summary.startTime.getTime()) / (60 * 60 * 1000))
      : 0;
    return summary;
  }, { output: 0, activeHours: 0, startTime: null, endTime: null });
}

function buildMachineUtilizationSummary(
  data: InjectionProductionMatrix | undefined,
  machineNumber: number,
  startTime: Date | null,
  endTime: Date | null,
  idleThresholdMinutes = 10,
): UtilizationSummary {
  if (!data || !startTime || !endTime) {
    return { rate: null, runningMinutes: 0, totalMinutes: 0, output: 0 };
  }

  let runningMinutes = 0;
  let totalMinutes = 0;
  let outputTotal = 0;
  const productionRow = getMachineMatrixValues(data, data.actual_production_matrix, machineNumber);
  let lastOutputTime: Date | null = null;

  (data.time_slots ?? []).forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    if (!isMonitoringSlotInWindow(slotTime.getTime(), startTime, endTime)) return;

    const intervalMinutes = getSlotIntervalMinutes(data, index);
    totalMinutes += intervalMinutes;

    const output = numberAt(productionRow, index);
    outputTotal += output;
    if (output > 0) {
      runningMinutes += intervalMinutes;
      lastOutputTime = slotTime;
      return;
    }

    if (
      lastOutputTime &&
      (slotTime.getTime() - lastOutputTime.getTime()) / (60 * 1000) < idleThresholdMinutes
    ) {
      runningMinutes += intervalMinutes;
    }
  });

  return {
    rate: totalMinutes > 0 ? (runningMinutes / totalMinutes) * 100 : null,
    runningMinutes,
    totalMinutes,
    output: outputTotal,
  };
}

function buildFleetUtilizationSummary(
  data: InjectionProductionMatrix | undefined,
  startTime: Date | null,
  endTime: Date | null,
  idleThresholdMinutes = 10,
): UtilizationSummary {
  if (!data || !startTime || !endTime) {
    return { rate: null, runningMinutes: 0, totalMinutes: 0, output: 0, activeMachines: 0 };
  }

  return data.machines.reduce<UtilizationSummary>(
    (summary, machine) => {
      const machineSummary = buildMachineUtilizationSummary(
        data,
        machine.machine_number,
        startTime,
        endTime,
        idleThresholdMinutes,
      );
      summary.runningMinutes += machineSummary.runningMinutes;
      summary.totalMinutes += machineSummary.totalMinutes;
      summary.output += machineSummary.output;
      if (machineSummary.output > 0) {
        summary.activeMachines = (summary.activeMachines ?? 0) + 1;
      }
      summary.rate = summary.totalMinutes > 0 ? (summary.runningMinutes / summary.totalMinutes) * 100 : null;
      return summary;
    },
    { rate: null, runningMinutes: 0, totalMinutes: 0, output: 0, activeMachines: 0 },
  );
}

function buildDailyUtilizationPoints(
  data: InjectionProductionMatrix | undefined,
  language: AppLanguage,
): DailyUtilizationPoint[] {
  const latestTime = getLatestTime(data);
  const firstSlot = data?.time_slots[0];
  if (!data || !firstSlot || !latestTime) return [];

  const firstDay = startOfProductionDay(new Date(firstSlot.time));
  const lastDay = startOfProductionDay(latestTime);
  const points: DailyUtilizationPoint[] = [];

  for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
    const nextDay = addDays(day, 1);
    const rangeStart = new Date(day.getTime() - 1);
    const rangeEnd = nextDay > latestTime ? latestTime : new Date(nextDay.getTime() - 1);
    const summary = buildFleetUtilizationSummary(data, rangeStart, rangeEnd);

    points.push({
      date: formatDateParam(day),
      label: formatShortDate(day, language),
      activeMachines: summary.activeMachines ?? 0,
      utilizationRate: summary.rate,
      runningMinutes: summary.runningMinutes,
      totalMinutes: summary.totalMinutes,
    });
  }

  return points.filter((point) => point.totalMinutes > 0);
}

function filterDailyUtilizationPoints(
  points: DailyUtilizationPoint[],
  startDate: string,
  endDate: string,
) {
  if (!startDate || !endDate) return points;
  return points.filter((point) => point.date >= startDate && point.date <= endDate);
}

function buildHourlyTrend(
  data: InjectionProductionMatrix | undefined,
  machineNumber: number,
  language: AppLanguage,
  businessDate?: string,
): HourlyTrendPoint[] {
  const rawLatestTime = getLatestTime(data);
  const latestTime = businessDate && rawLatestTime ? getBusinessDayReferenceEnd(businessDate, rawLatestTime) : rawLatestTime;
  if (!data || !latestTime) return [];

  const firstHour = new Date(Math.floor((latestTime.getTime() - 1) / 3_600_000) * 3_600_000 - 23 * 3_600_000);

  return Array.from({ length: 24 }, (_, hourIndex) => {
    const start = new Date(firstHour.getTime() + hourIndex * 3_600_000);
    const end = new Date(start.getTime() + 3_600_000);

    const summary = buildPeriodSummary(data, machineNumber, start, end);
    return {
      label: formatHourLabel(start, language),
      dateLabel: formatShortDate(start, language),
      startTime: start,
      endTime: end,
      hour: getShanghaiHour(start),
      isDayBreak: getShanghaiHour(start) === 0,
      output: hasObservedCapacityInWindow(data, machineNumber, start, end) ? summary.output : null,
      power: summary.power,
      oilTemperature: summary.oilTemperature,
    };
  });
}

function maxTrendValue(points: HourlyTrendPoint[], metric: keyof Pick<HourlyTrendPoint, "output" | "power" | "oilTemperature">) {
  const values = points.map((point) => Number(point[metric] ?? 0));
  return Math.max(1, ...values);
}

function buildFleetHourlyTrendScale(
  data: InjectionProductionMatrix | undefined,
  language: AppLanguage,
  businessDate?: string,
): HourlyTrendScale {
  if (!data) {
    return { powerMax: 1, oilMax: 50 };
  }

  const allPoints = data.machines.flatMap((machine) => buildHourlyTrend(data, machine.machine_number, language, businessDate));
  return {
    powerMax: maxTrendValue(allPoints, "power"),
    oilMax: Math.max(50, maxTrendValue(allPoints, "oilTemperature")),
  };
}

function CombinedTrendChart({
  points,
  labels,
  language,
  scale,
}: {
  points: HourlyTrendPoint[];
  labels: { output: string; power: string; oil: string };
  language: AppLanguage;
  scale: HourlyTrendScale;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<{ point: HourlyTrendPoint; index: number } | null>(null);
  const [chartWidth, setChartWidth] = useState(720);
  useEffect(() => {
    if (!stageRef.current || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const nextWidth = Math.round(entries[0]?.contentRect.width ?? 720);
      setChartWidth((currentWidth) => {
        const clampedWidth = Math.max(360, nextWidth);
        return Math.abs(currentWidth - clampedWidth) > 2 ? clampedWidth : currentWidth;
      });
    });
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, []);

  const width = chartWidth;
  const height = Math.max(210, Math.min(300, Math.round(width * 0.32)));
  const plotTop = 14;
  const plotBottom = height - 44;
  const xGap = width / Math.max(1, points.length - 1);
  const outputMax = maxTrendValue(points, "output");
  const powerMax = Math.max(1, scale.powerMax);
  const oilMax = Math.max(50, scale.oilMax);
  const yFor = (value: number, max: number) => plotBottom - (value / max) * (plotBottom - plotTop);
  const lineFor = (metric: "power" | "oilTemperature", max: number) => {
    let hasPrevious = false;
    return points.map((point, index) => {
      const value = point[metric];
      if (value === null || !Number.isFinite(value)) {
        hasPrevious = false;
        return "";
      }
      const command = hasPrevious ? "L" : "M";
      hasPrevious = true;
      return `${command}${index * xGap},${yFor(value, max)}`;
    }).join(" ");
  };
  const shiftSections = points.reduce<Array<{
    key: string;
    dateLabel: string;
    shiftLabel: string;
    shift: "day" | "night";
    startIndex: number;
    endIndex: number;
  }>>((sections, point, index) => {
    const shiftInfo = getShiftSectionInfo(point.startTime, language);
    const last = sections.at(-1);
    if (!last || last.key !== shiftInfo.key) {
      sections.push({
        key: shiftInfo.key,
        dateLabel: shiftInfo.dateLabel,
        shiftLabel: shiftInfo.shiftLabel,
        shift: shiftInfo.shift,
        startIndex: index,
        endIndex: index,
      });
    } else {
      last.endIndex = index;
    }
    return sections;
  }, []);
  const tooltipLeft = hoveredPoint ? (hoveredPoint.index * xGap / width) * 100 : 0;
  const tooltipAlign = hoveredPoint && hoveredPoint.index > points.length - 5 ? "end" : "center";

  return (
    <div className="mes-combined-chart-stage" ref={stageRef} onMouseLeave={() => setHoveredPoint(null)}>
      <svg className="mes-combined-chart" viewBox={`0 0 ${width} ${height}`} style={{ height }} role="img" aria-hidden="true">
        {shiftSections.map((section) => {
          const startX = Math.max(0, section.startIndex * xGap - xGap / 2);
          const endX = Math.min(width, section.endIndex * xGap + xGap / 2);
          const isTrailingSection = section.endIndex === points.length - 1;
          const visibleHours = section.endIndex - section.startIndex + 1;
          const hideDateLabel = isTrailingSection && visibleHours < 3;
          return (
            <g key={section.key}>
              <rect
                className={`mes-combined-chart__shift mes-combined-chart__shift--${section.shift}`}
                x={startX}
                y={plotTop}
                width={Math.max(1, endX - startX)}
                height={plotBottom - plotTop}
              />
              {!hideDateLabel && (
                <text className="mes-combined-chart__date" x={Math.min(width - 94, startX + 8)} y={plotTop + 12}>
                  {section.dateLabel}
                </text>
              )}
              <text
                className="mes-combined-chart__shift-label"
                x={Math.min(width - 116, startX + 8)}
                y={hideDateLabel ? plotTop + 14 : plotTop + 25}
              >
                {section.shiftLabel}
              </text>
            </g>
          );
        })}
        {[0, 1, 2, 3].map((line) => {
          const y = plotTop + ((plotBottom - plotTop) / 3) * line;
          return <line key={line} className="mes-combined-chart__grid" x1="0" x2={width} y1={y} y2={y} />;
        })}
        {points.map((point, index) => {
          const x = index * xGap;
          const isMajor = index % 3 === 0;
          return (
            <g key={`${point.dateLabel}-${point.label}-${index}`}>
              <line
                className={point.isDayBreak ? "mes-combined-chart__daybreak" : "mes-combined-chart__tick"}
                x1={x}
                x2={x}
                y1={plotTop}
                y2={plotBottom + (point.isDayBreak ? 22 : isMajor ? 14 : 8)}
              />
              {(isMajor || point.isDayBreak) && (
                <text x={x} y={plotBottom + 28} textAnchor="middle">
                  {point.label}
                </text>
              )}
            </g>
          );
        })}
        {points.map((point, index) => {
          if (point.output === null) return null;
          const value = point.output;
          const barHeight = Math.max(value > 0 ? 2 : 0, (value / outputMax) * (plotBottom - plotTop));
          return (
            <rect
              key={`output-${point.dateLabel}-${point.label}-${index}`}
              x={index * xGap - 5}
              y={plotBottom - barHeight}
              width="10"
              height={barHeight}
              rx="3"
              className="mes-combined-chart__bar"
            />
          );
        })}
        <path className="mes-combined-chart__power" d={lineFor("power", powerMax)} />
        <path className="mes-combined-chart__oil" d={lineFor("oilTemperature", oilMax)} />
        {points.map((point, index) => (
          <g key={`dots-${point.dateLabel}-${point.label}-${index}`}>
            {point.power !== null && <circle cx={index * xGap} cy={yFor(point.power, powerMax)} r="2.5" className="mes-combined-chart__power-dot" />}
            {point.oilTemperature !== null && (
              <circle cx={index * xGap} cy={yFor(point.oilTemperature, oilMax)} r="2.5" className="mes-combined-chart__oil-dot" />
            )}
          </g>
        ))}
        {points.map((point, index) => (
          <rect
            key={`hit-${point.dateLabel}-${point.label}-${index}`}
            className="mes-combined-chart__hit"
            x={Math.max(0, index * xGap - xGap / 2)}
            y="0"
            width={index === 0 || index === points.length - 1 ? xGap / 2 : xGap}
            height={height}
            onMouseEnter={() => setHoveredPoint({ point, index })}
            onMouseMove={() => setHoveredPoint({ point, index })}
          />
        ))}
      </svg>
      {hoveredPoint && (
        <div
          className={`mes-chart-tooltip mes-chart-tooltip--${tooltipAlign}`}
          style={{ left: `${tooltipLeft}%` }}
        >
          <strong>
            <span>{formatTooltipDate(hoveredPoint.point.startTime, language)}</span>
            <em>
              {formatTooltipTime(hoveredPoint.point.startTime, language)} ~ {formatTooltipTime(hoveredPoint.point.endTime, language)}
            </em>
          </strong>
          <span>{labels.output} {hoveredPoint.point.output === null ? "—" : formatNumber(hoveredPoint.point.output)}</span>
          <span>{labels.power} {formatDecimal(hoveredPoint.point.power, 2)} kWh</span>
          <span>{labels.oil} {formatTemperature(hoveredPoint.point.oilTemperature)}</span>
        </div>
      )}
    </div>
  );
}

function DailyUtilizationChart({
  points,
  labels,
}: {
  points: DailyUtilizationPoint[];
  labels: { utilizationRate: string; activeMachineCount: string };
}) {
  const [hoveredPoint, setHoveredPoint] = useState<DailyUtilizationPoint | null>(null);
  const width = 720;
  const height = 260;
  const plotTop = 24;
  const plotRight = 28;
  const plotBottom = 196;
  const plotLeft = 42;
  const plotWidth = width - plotLeft - plotRight;
  const xGap = plotWidth / Math.max(1, points.length - 1);
  const maxMachines = Math.max(17, ...points.map((point) => point.activeMachines));
  const yForRate = (rate: number | null) => plotBottom - ((rate ?? 0) / 100) * (plotBottom - plotTop);
  const yForMachineCount = (count: number) => plotBottom - (count / maxMachines) * (plotBottom - plotTop);
  const linePoints = points
    .map((point, index) => `${plotLeft + index * xGap},${yForRate(point.utilizationRate)}`)
    .join(" ");
  const tooltipIndex = hoveredPoint ? points.findIndex((point) => point.date === hoveredPoint.date) : -1;
  const tooltipLeft = tooltipIndex >= 0 ? ((plotLeft + tooltipIndex * xGap) / width) * 100 : 0;
  const tooltipAlign = tooltipIndex > points.length - 3 ? "end" : "center";

  return (
    <div className="mes-utilization-chart-stage" onMouseLeave={() => setHoveredPoint(null)}>
      <svg className="mes-utilization-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((line) => {
          const y = plotTop + ((plotBottom - plotTop) / 4) * line;
          return <line key={line} className="mes-utilization-chart__grid" x1={plotLeft} x2={width - plotRight} y1={y} y2={y} />;
        })}
        {points.map((point, index) => {
          const x = plotLeft + index * xGap;
          const barHeight = plotBottom - yForMachineCount(point.activeMachines);
          const rateY = yForRate(point.utilizationRate);
          return (
            <g key={point.date}>
              <rect
                className="mes-utilization-chart__bar"
                x={x - 14}
                y={plotBottom - barHeight}
                width="28"
                height={Math.max(2, barHeight)}
                rx="4"
              />
              <text className="mes-utilization-chart__value" x={x} y={plotBottom - barHeight - 8} textAnchor="middle">
                {formatNumber(point.activeMachines)}
              </text>
              <text className="mes-utilization-chart__rate-value" x={x} y={rateY - 12} textAnchor="middle">
                {formatPercent(point.utilizationRate)}
              </text>
              <text className="mes-utilization-chart__label" x={x} y={plotBottom + 24} textAnchor="middle">
                {point.label}
              </text>
              <rect
                className="mes-utilization-chart__hit"
                x={Math.max(plotLeft, x - xGap / 2)}
                y="0"
                width={index === 0 || index === points.length - 1 ? Math.max(34, xGap / 2) : Math.max(34, xGap)}
                height={height}
                onMouseEnter={() => setHoveredPoint(point)}
                onMouseMove={() => setHoveredPoint(point)}
              />
            </g>
          );
        })}
        <polyline className="mes-utilization-chart__line" points={linePoints} />
        {points.map((point, index) => (
          <circle
            key={`rate-${point.date}`}
            className="mes-utilization-chart__dot"
            cx={plotLeft + index * xGap}
            cy={yForRate(point.utilizationRate)}
            r="4"
          />
        ))}
      </svg>
      {hoveredPoint && (
        <div
          className={`mes-chart-tooltip mes-chart-tooltip--${tooltipAlign}`}
          style={{ left: `${tooltipLeft}%` }}
        >
          <strong>
            <span>{hoveredPoint.label}</span>
          </strong>
          <span>{labels.utilizationRate} {formatPercent(hoveredPoint.utilizationRate)}</span>
          <span>{labels.activeMachineCount} {formatNumber(hoveredPoint.activeMachines)}</span>
        </div>
      )}
    </div>
  );
}

function SummaryMetricCard({
  title,
  value,
  hint,
  delta,
  deltaTone = "neutral",
  onClick,
  actionLabel,
}: {
  title: string;
  value: string;
  hint?: string;
  delta?: string;
  deltaTone?: "up" | "down" | "neutral" | "info";
  onClick?: () => void;
  actionLabel?: string;
}) {
  const content = (
    <>
      <p className="stat-card__title">{title}</p>
      <strong className="stat-card__value">{value}</strong>
      {delta && <span className={`mes-stat-card__delta mes-stat-card__delta--${deltaTone}`}>{delta}</span>}
      {hint ? <p className="stat-card__hint">{hint}</p> : null}
    </>
  );

  if (onClick) {
    return (
      <button
        className="stat-card mes-stat-card mes-stat-card--button"
        type="button"
        onClick={onClick}
        aria-label={actionLabel ?? title}
      >
        {content}
      </button>
    );
  }

  return (
    <article className="stat-card mes-stat-card">
      {content}
    </article>
  );
}

function MonitoringStateNotice({ state, language, onRetry }: {
  state: MonitoringState; language: AppLanguage; onRetry: () => void;
}) {
  if (state === "ready") return null;
  const text = language === "ko" ? {
    loading: "필요한 원천 자료를 불러오는 중입니다.",
    error: "원천 조회 또는 갱신에 실패했습니다. 이전 자료로 현재 수량·정상·정지를 판정하지 않습니다.",
    empty: "조회 범위에 확인 가능한 원천 자료가 없습니다. 생산 0 또는 정상 상태를 뜻하지 않습니다.",
  } : {
    loading: "正在获取所需数据源。",
    error: "数据源查询或刷新失败，不用旧资料判断当前数量、正常或停机状态。",
    empty: "查询范围内无可确认的源数据，不代表产量为0或状态正常。",
  };
  return <div className={`notice ${state === "error" ? "notice--warning" : "notice--neutral"}`} role="status">
    <p>{text[state]}</p>
    {state !== "loading" && <button className="button button--ghost" type="button" onClick={onRetry}>{language === "ko" ? "다시 조회" : "重新查询"}</button>}
  </div>;
}

function MonitoringCoverageNotice({ data, machineNumber, language }: {
  data: InjectionProductionMatrix | undefined; machineNumber?: number | null; language: AppLanguage;
}) {
  const coverage = getMonitoringCoverage(data, machineNumber ?? null);
  const copy = language === "ko" ? {
    unknown: "설비별 수집 범위를 확인할 수 없어 생산·가동 판단을 보류합니다.",
    missing: "일부 설비의 형합 원천이 없거나 지연되었습니다. 누락을 정지나 생산 0으로 해석하지 마세요.",
    policy: "이 자료의 형합수 집계 정책을 확인할 수 없어 파생 판단을 보류합니다.",
    coverage: "형합 샘플이 있는 구간", note: "0은 수집 구간에서 확인된 증가량입니다. 수집 누락은 별도로 확인해야 하며, 정지 확정이나 계획 가동률이 아닙니다.",
  } : {
    unknown: "无法确认各设备采集范围，暂停生产与运行判断。",
    missing: "部分设备合模数据缺失或延迟，请勿将缺失解释为停机或产量为0。",
    policy: "无法确认该资料的模次汇总规则，暂停派生判断。",
    coverage: "有合模样本的区间", note: "0表示采集区间内确认的增量。需另行核对采集缺失，不代表确认停机或计划开机率。",
  };
  const latestSource = machineNumber === null || machineNumber === undefined ? data?.source_latest_at : data?.machine_sources?.[String(machineNumber)]?.latest_capacity_at;
  return <div className={`notice ${coverage.ready ? "notice--neutral" : "notice--warning"}`} role="status">
    <p>{language === "ko" ? "저장된 형합 관측 최신" : "已存合模观测最新时间"}: {latestSource ? formatDateTime(latestSource, language) : "—"} · UTC+8</p>
    {data?.source_window && <p>{language === "ko" ? "원천 조회 범위" : "源数据查询范围"}: {formatDateTime(data.source_window.start, language)} ~ {formatDateTime(data.source_window.end, language)} · UTC+8. {language === "ko" ? "아래 관측 구간 수는 조회 범위 기준이며, 일일 합계는 표시된 업무일로 제한합니다." : "下方观测区间数以查询范围为准，日合计限于所示业务日。"}</p>}
    {!coverage.known ? <p>{copy.unknown}</p> : <><p>{coverage.policyUnverified ? copy.policy : coverage.ready ? copy.note : copy.missing}</p><p>{copy.coverage}: {formatNumber(coverage.observedSlots)} / {formatNumber(coverage.totalSlots)}</p></>}
    <p>{language === "ko" ? "전력은 형합수와 별도 집계 정책입니다. 계기 리셋·결측 보정과 정확한 사용 시점이 검증되기 전에는 비용 또는 절감 성과로 판단하지 않습니다." : "电力与模次采用不同汇总规则。电表重置、缺失修正与准确使用时点验证前，不作为费用或节能成效判断。"}</p>
  </div>;
}

function MesMonitoringSkeleton({ copy }: { copy: Record<string, string> }) {
  return (
    <>
      <div className="mes-stats-grid">
        {Array.from({ length: 5 }, (_, index) => (
          <article className="stat-card mes-stat-card mes-skeleton-card" key={index}>
            <span className="mes-skeleton-line mes-skeleton-line--short" />
            <span className="mes-skeleton-line mes-skeleton-line--value" />
            <span className="mes-skeleton-line" />
          </article>
        ))}
      </div>

      <section className="panel mes-monitor-panel">
        <div className="mes-skeleton-heading">
          <span className="mes-skeleton-line mes-skeleton-line--eyebrow" />
          <span className="mes-skeleton-line mes-skeleton-line--title" />
          <span className="mes-skeleton-line mes-skeleton-line--wide" />
        </div>
        <div className="mes-machine-rail">
          {Array.from({ length: 17 }, (_, index) => (
            <span className="mes-machine-tile mes-skeleton-tile" key={index} />
          ))}
        </div>
        <div className="mes-live-layout">
          <div className="mes-summary-column">
            <article className="mes-period-card mes-skeleton-block" />
            <article className="mes-period-card mes-skeleton-block" />
          </div>
          <article className="mes-trend-card mes-skeleton-chart">
            <span className="mes-skeleton-line mes-skeleton-line--title" />
            <span className="mes-skeleton-chart__box" />
          </article>
        </div>
        <p className="mes-loading-note">{copy.loadingData}</p>
      </section>
    </>
  );
}

export function MesMonitoringPage() {
  const [language] = useStoredLanguage();
  const { hasCapability } = useAuth();
  const [selectedInfoView, setSelectedInfoView] = useState<MesInfoView>("production");
  const [isMachiningOpen, setIsMachiningOpen] = useState(false);
  const currentProductionDate = useShanghaiBusinessDate();
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = resolveInjectionScope(searchParams.toString(), currentProductionDate);
  const injectionDate = scope.date;
  const selectedMachineNumber = scope.machineNumber;
  const setInjectionDate = (date: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("date", date || currentProductionDate);
    setSearchParams(next);
  };
  const setSelectedMachineNumber = (machine: number | null) => {
    const next = new URLSearchParams(searchParams);
    next.set("date", injectionDate);
    if (machine === null) next.delete("machine");
    else next.set("machine", String(machine));
    setSearchParams(next);
  };
  const [snapshotJobId, setSnapshotJobId] = useState<string | null>(null);
  const [isUtilizationModalOpen, setIsUtilizationModalOpen] = useState(false);
  const [utilizationStartDate, setUtilizationStartDate] = useState(() => formatDateParam(addDays(new Date(), -13)));
  const [utilizationEndDate, setUtilizationEndDate] = useState(() => formatDateParam(new Date()));
  const copy = pageCopy[language];
  const queryClient = useQueryClient();
  const isCurrentInjectionDate = injectionDate === currentProductionDate;
  const isProductionInfoView = selectedInfoView === "production";

  const injectionQuery = useQuery({
    queryKey: ["mes", "injection-production-matrix", injectionDate, isCurrentInjectionDate],
    queryFn: () => (isCurrentInjectionDate ? getInjectionProductionMatrix() : getInjectionProductionMatrixForDate(injectionDate)),
    enabled: isProductionInfoView,
    refetchInterval: isProductionInfoView && isCurrentInjectionDate ? 60_000 : false,
  });

  const monitoringDatesQuery = useQuery({
    queryKey: ["mes", "injection-monitoring-dates"],
    queryFn: getInjectionMonitoringDates,
    enabled: isProductionInfoView,
    staleTime: 5 * 60 * 1000,
  });

  const updateMutation = useMutation({
    mutationFn: requestInjectionSnapshotUpdate,
    onSuccess: (data) => {
      if (data.job_id) {
        setSnapshotJobId(data.job_id);
      }
    },
  });

  const updateStatusQuery = useQuery({
    queryKey: ["mes", "injection-snapshot-update-status", snapshotJobId],
    queryFn: () => getInjectionSnapshotUpdateStatus(snapshotJobId ?? undefined),
    enabled: Boolean(snapshotJobId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 3_000 : false),
  });

  const machiningStatsQuery = useQuery({
    queryKey: ["production-mes-report-stats", "machining", injectionDate],
    queryFn: () => getProductionMesReportStats(injectionDate, "machining"),
    enabled: isProductionInfoView && isMachiningOpen && Boolean(injectionDate),
    refetchInterval: isProductionInfoView && isMachiningOpen && isCurrentInjectionDate ? 60_000 : false,
  });

  const utilizationColumns = useMemo(
    () => clampDateRangeColumns(utilizationStartDate, getBusinessDayEnd(utilizationEndDate)),
    [utilizationEndDate, utilizationStartDate],
  );

  const utilizationQuery = useQuery({
    queryKey: ["mes", "injection-utilization-matrix", utilizationColumns, utilizationEndDate],
    queryFn: () => getInjectionUtilizationMatrix(utilizationColumns, utilizationEndDate < currentProductionDate ? utilizationEndDate : undefined),
    enabled: isProductionInfoView && isUtilizationModalOpen,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    const status = updateStatusQuery.data?.status;
    if (status === "completed" || status === "skipped" || status === "failed") {
      void queryClient.invalidateQueries({ queryKey: ["mes", "injection-production-matrix"] });
      window.setTimeout(() => setSnapshotJobId(null), 2000);
    }
  }, [queryClient, updateStatusQuery.data?.status]);

  const machineRows = useMemo(() => buildRows(injectionQuery.data, injectionDate), [injectionDate, injectionQuery.data]);
  const latestTime = getLatestTime(injectionQuery.data);
  const dayStart = useMemo(() => getBusinessDayStart(injectionDate), [injectionDate]);
  const referenceEndTime = useMemo(
    () => getBusinessDayReferenceEnd(injectionDate, latestTime),
    [injectionDate, latestTime],
  );
  const defaultUtilizationEndDate = injectionDate;
  const defaultUtilizationStartDate = formatDateParam(addDays(getBusinessDayStart(injectionDate), -13));
  useEffect(() => {
    if (!isUtilizationModalOpen) return;
    setUtilizationStartDate(defaultUtilizationStartDate);
    setUtilizationEndDate(defaultUtilizationEndDate);
  }, [defaultUtilizationEndDate, defaultUtilizationStartDate, isUtilizationModalOpen]);
  const planDate = injectionDate;
  const nextPlanDate = formatDateParam(addDays(new Date(`${planDate}T08:00:00+08:00`), 1));
  const secondNextPlanDate = formatDateParam(addDays(new Date(`${planDate}T08:00:00+08:00`), 2));
  const planSummaryQuery = useQuery({
    queryKey: ["production-plan-summary", planDate],
    queryFn: () => getProductionPlanSummary(planDate),
    enabled: isProductionInfoView && Boolean(planDate),
  });
  const nextPlanSummaryQuery = useQuery({
    queryKey: ["production-plan-summary", nextPlanDate],
    queryFn: () => getProductionPlanSummary(nextPlanDate),
    enabled: isProductionInfoView && Boolean(nextPlanDate),
  });
  const secondNextPlanSummaryQuery = useQuery({
    queryKey: ["production-plan-summary", secondNextPlanDate],
    queryFn: () => getProductionPlanSummary(secondNextPlanDate),
    enabled: isProductionInfoView && Boolean(secondNextPlanDate),
  });
  const downtimeConfirmationsQuery = useQuery({
    queryKey: ["production", "injection-downtime-confirmations", planDate],
    queryFn: () => getInjectionDowntimeConfirmations(planDate),
    enabled: isProductionInfoView && Boolean(planDate),
    refetchInterval: isProductionInfoView && isCurrentInjectionDate ? 60_000 : false,
    retry: false,
  });
  const saveDowntimeConfirmationMutation = useMutation({
    mutationFn: saveInjectionDowntimeConfirmation,
    onSuccess: () => queryClient.invalidateQueries({
      queryKey: ["production", "injection-downtime-confirmations", planDate],
    }),
  });
  const resetDowntimeConfirmationMutation = useMutation({
    mutationFn: resetInjectionDowntimeConfirmation,
    onSuccess: () => queryClient.invalidateQueries({
      queryKey: ["production", "injection-downtime-confirmations", planDate],
    }),
  });
  const selectedMachine = machineRows.find((row) => row.machineNumber === selectedMachineNumber);
  const selectedMachineKey = selectedMachine?.machineNumber ?? selectedMachineNumber ?? 1;
  const shiftSummary = useMemo(
    () => buildPeriodSummary(injectionQuery.data, selectedMachineKey, dayStart, referenceEndTime),
    [dayStart, injectionQuery.data, referenceEndTime, selectedMachineKey],
  );
  const recentSummary = useMemo(() => {
    if (!referenceEndTime) return { output: 0, power: null, oilTemperature: null };
    return buildPeriodSummary(
      injectionQuery.data,
      selectedMachineKey,
      new Date(referenceEndTime.getTime() - 60 * 60 * 1000),
      referenceEndTime,
    );
  }, [injectionQuery.data, referenceEndTime, selectedMachineKey]);
  const hourlyTrend = useMemo(
    () => buildHourlyTrend(injectionQuery.data, selectedMachineKey, language, injectionDate),
    [injectionDate, injectionQuery.data, language, selectedMachineKey],
  );
  const fleetHourlyTrendScale = useMemo(
    () => buildFleetHourlyTrendScale(injectionQuery.data, language, injectionDate),
    [injectionDate, injectionQuery.data, language],
  );
  const utilizationMatrix = utilizationQuery.data;
  const dailyUtilizationPoints = useMemo(
    () => filterDailyUtilizationPoints(
      buildDailyUtilizationPoints(utilizationMatrix, language),
      utilizationStartDate,
      utilizationEndDate,
    ),
    [language, utilizationEndDate, utilizationMatrix, utilizationStartDate],
  );
  const selectedUtilizationSummary = useMemo(() => {
    const totalMinutes = dailyUtilizationPoints.reduce((sum, point) => sum + point.totalMinutes, 0);
    const runningMinutes = dailyUtilizationPoints.reduce((sum, point) => sum + point.runningMinutes, 0);
    const activeMachines = dailyUtilizationPoints.length
      ? dailyUtilizationPoints.reduce((sum, point) => sum + point.activeMachines, 0) / dailyUtilizationPoints.length
      : 0;

    return {
      rate: totalMinutes > 0 ? (runningMinutes / totalMinutes) * 100 : null,
      activeMachines,
    };
  }, [dailyUtilizationPoints]);
  const recentStart = useMemo(
    () => (referenceEndTime ? new Date(referenceEndTime.getTime() - 60 * 60 * 1000) : null),
    [referenceEndTime],
  );
  const previousRecentStart = useMemo(
    () => (referenceEndTime ? new Date(referenceEndTime.getTime() - 120 * 60 * 1000) : null),
    [referenceEndTime],
  );
  const previousDayStart = useMemo(
    () => (dayStart ? new Date(dayStart.getTime() - 24 * 60 * 60 * 1000) : null),
    [dayStart],
  );
  const previousDayEnd = useMemo(
    () => (referenceEndTime ? new Date(referenceEndTime.getTime() - 24 * 60 * 60 * 1000) : null),
    [referenceEndTime],
  );
  const todayFleetSummary = useMemo(
    () => buildFleetPeriodSummary(injectionQuery.data, dayStart, referenceEndTime),
    [dayStart, injectionQuery.data, referenceEndTime],
  );
  const recentFleetSummary = useMemo(
    () => buildFleetPeriodSummary(injectionQuery.data, recentStart, referenceEndTime),
    [injectionQuery.data, recentStart, referenceEndTime],
  );
  const previousRecentFleetSummary = useMemo(
    () => buildFleetPeriodSummary(injectionQuery.data, previousRecentStart, recentStart),
    [injectionQuery.data, previousRecentStart, recentStart],
  );
  const previousDayFleetSummary = useMemo(
    () => buildFleetPeriodSummary(injectionQuery.data, previousDayStart, previousDayEnd),
    [injectionQuery.data, previousDayEnd, previousDayStart],
  );
  const utilizationStart = useMemo(
    () => (referenceEndTime ? new Date(referenceEndTime.getTime() - 24 * 60 * 60 * 1000) : null),
    [referenceEndTime],
  );
  const utilization24 = useMemo(
    () => buildFleetUtilizationSummary(injectionQuery.data, utilizationStart, referenceEndTime),
    [injectionQuery.data, referenceEndTime, utilizationStart],
  );
  const transitionMatrix = useMemo(
    () => trimMonitoringSlots(injectionQuery.data, getBusinessDayStart(planDate), getBusinessDayEnd(planDate)),
    [injectionQuery.data, planDate],
  );
  const transitionAnalysis = useMemo(
    () => buildInjectionTransitionAnalysis(
      planSummaryQuery.data,
      transitionMatrix,
      planDate,
      undefined,
      [nextPlanSummaryQuery.data, secondNextPlanSummaryQuery.data].filter(
        (summary): summary is NonNullable<typeof summary> => Boolean(summary),
      ),
    ),
    [transitionMatrix, nextPlanSummaryQuery.data, planDate, planSummaryQuery.data, secondNextPlanSummaryQuery.data],
  );
  const summary = useMemo(() => {
    const runningRows = machineRows.filter((row) => row.status === "running");

    return {
      running: runningRows.length,
      total: machineRows.length,
    };
  }, [machineRows]);
  const machineProductionWindows = useMemo(() => new Map(
    machineRows.map((row) => [
      row.machineNumber,
      buildMachineProductionWindow(injectionQuery.data, row.machineNumber, dayStart, referenceEndTime),
    ]),
  ), [dayStart, injectionQuery.data, machineRows, referenceEndTime]);
  const fleetProductionWindow = useMemo(
    () => buildFleetProductionWindow(injectionQuery.data, dayStart, referenceEndTime),
    [dayStart, injectionQuery.data, referenceEndTime],
  );
  const fleetElapsedUph = fleetProductionWindow.activeHours > 0
    ? fleetProductionWindow.output / fleetProductionWindow.activeHours
    : 0;
  const maxMachineShiftOutput = Math.max(1, ...machineRows.map((row) => row.shiftOutput));
  const utilizationTone = "neutral";
  const recentOutputDelta = coversMonitoringWindow(injectionQuery.data, previousRecentStart, referenceEndTime) ? recentFleetSummary.output - previousRecentFleetSummary.output : null;
  const recentOilDelta =
    coversMonitoringWindow(injectionQuery.data, previousRecentStart, referenceEndTime) && recentFleetSummary.oilTemperature !== null && previousRecentFleetSummary.oilTemperature !== null
      ? recentFleetSummary.oilTemperature - previousRecentFleetSummary.oilTemperature
      : null;
  const todayPowerDelta =
    coversMonitoringWindow(injectionQuery.data, previousDayStart, previousDayEnd) && todayFleetSummary.power !== null && previousDayFleetSummary.power !== null
      ? todayFleetSummary.power - previousDayFleetSummary.power
      : null;
  const isInitialMesLoading = isProductionInfoView && !injectionQuery.data && injectionQuery.isFetching;
  const isBackfillRunning = updateMutation.isPending || updateStatusQuery.data?.status === "running";
  const backfillPercent = updateStatusQuery.data?.percent ?? 0;
  const isUtilizationAnalysisLoading = isUtilizationModalOpen && utilizationQuery.isFetching && !utilizationQuery.data;
  const machiningStats = machiningStatsQuery.data;
  const machiningRows = machiningStats?.rows ?? [];
  const machiningGapTone = (machiningStats?.summary.gap_qty ?? 0) >= 0 ? "up" : "down";
  const machiningLatestReportTime = machiningRows
    .map((row) => row.latest_report_time)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const monitoringDates = monitoringDatesQuery.data?.dates ?? [];
  const matrixState = getMonitoringState([injectionQuery], hasMonitoringMatrix(injectionQuery.data));
  const hasLivePlanSource = !isDevSessionActive() || import.meta.env.VITE_USE_REMOTE_PRODUCTION_API === "true";
  const hasProductionEvidence = hasMonitoringMatrix(injectionQuery.data) && hasLivePlanSource;
  const planQueries = [planSummaryQuery, nextPlanSummaryQuery, secondNextPlanSummaryQuery];
  const transitionState = getMonitoringState([injectionQuery, ...planQueries], hasProductionEvidence);
  const machiningState = getMonitoringState([machiningStatsQuery]);
  const utilizationState = getMonitoringState([utilizationQuery], hasMonitoringMatrix(utilizationQuery.data) && dailyUtilizationPoints.length > 0);
  const fleetCoverage = getMonitoringCoverage(injectionQuery.data);
  const selectedCoverage = getMonitoringCoverage(injectionQuery.data, selectedMachineNumber);
  const utilizationCoverage = getMonitoringCoverage(utilizationQuery.data);
  const transitionCoverage = getMonitoringCoverage(transitionMatrix, selectedMachineNumber);
  const retryFleet = () => {
    void injectionQuery.refetch();
    for (const query of planQueries) void query.refetch();
  };


  useEffect(() => {
    if (!dailyUtilizationPoints.length || !latestTime) return;

    window.localStorage.setItem(
      "wj_mes_daily_utilization",
      JSON.stringify({
        updatedAt: latestTime.toISOString(),
        records: dailyUtilizationPoints,
      }),
    );
  }, [dailyUtilizationPoints, latestTime]);

  useEffect(() => {
    if (!isUtilizationModalOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsUtilizationModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isUtilizationModalOpen]);

  return (
    <section className="page mes-page">
      <section className="panel mes-hero-panel">
        <div className="mes-hero-panel__main">
          <PageHeaderIcon icon="mes" />
          <div className="mes-hero-panel__content">
            <h2>{copy.title}</h2>
            <p>{copy.description}</p>
          </div>
          <div className="mes-source-chips" aria-label={copy.availableData}>
            <span>{copy.productionInfo}</span>
            <span>{copy.inventoryInfo}</span>
          </div>
        </div>
        <nav className="mes-monitor-panel__actions" aria-label={language === "ko" ? "사출 업무 연결" : "注塑工作入口"}>
          <Link className="button button--ghost" to={buildInjectionLink("/injection/dashboard", scope, "overview")}>{language === "ko" ? "생산 관리" : "生产管理"}</Link>
          <Link className="button button--ghost" to={buildInjectionLink("/injection/dashboard", scope, "field-records")}>{language === "ko" ? "선택일 현장 기록" : "所选日现场记录"}</Link>
          {selectedMachineNumber !== null && <Link className="button button--ghost" to={`/field/imm${String(selectedMachineNumber).padStart(2, "0")}`}>{language === "ko" ? "현재 현장 입력" : "当前现场输入"}</Link>}
        </nav>
        <p className="plan-dashboard__meta">{injectionDate} · Asia/Shanghai 08:00 → {language === "ko" ? "다음 날" : "次日"} 08:00 · UTC+8</p>
        <p className="plan-dashboard__meta">{language === "ko" ? "위 시간대 요약은 전체 설비 기준이며, 아래 상세 설비 선택은 시간대 신호와 정지 확인 목록에 적용합니다. 현장 입력 링크는 현재 업무일로 이동합니다." : "上方时段摘要为全部设备范围，下方详细设备选择应用于时段信号与停机核对列表。现场输入入口打开当前业务日。"}</p>
        <div className="mes-hero-panel__control">
          <div className={`mes-hero-panel__field-row${isProductionInfoView ? "" : " mes-hero-panel__field-row--single"}`}>
            <label className="mes-source-select">
              <span>{copy.selectHint}</span>
              <select
                value={selectedInfoView}
                onChange={(event) => setSelectedInfoView(event.target.value as MesInfoView)}
              >
                {infoOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {copy[option.labelKey]}
                  </option>
                ))}
              </select>
            </label>
            {isProductionInfoView ? (
              <label className="mes-date-field mes-date-field--stacked">
                <span>{copy.injectionDate}</span>
                <input
                  type="date"
                  value={injectionDate}
                  list="mes-monitoring-dates"
                  max={currentProductionDate}
                  onChange={(event) => {
                    setInjectionDate(event.target.value);
                  }}
                />
                <datalist id="mes-monitoring-dates">
                  {monitoringDates.map((date) => (
                    <option key={date} value={date} />
                  ))}
                </datalist>
              </label>
            ) : null}
          </div>
        </div>
      </section>

      {isProductionInfoView ? (
        isInitialMesLoading ? (
          <MesMonitoringSkeleton copy={copy} />
        ) : (
        <>
          <h3 className="panel__title">{language === "ko" ? "전체 설비 요약" : "全部设备摘要"}</h3>
          <MonitoringStateNotice state={matrixState} language={language} onRetry={retryFleet} />
          {matrixState === "ready" && <MonitoringCoverageNotice data={injectionQuery.data} language={language} />}
          {matrixState === "ready" && fleetCoverage.ready && <>
          <div className="mes-stats-grid">
            <SummaryMetricCard
              title={copy.activeMachines}
              value={`${summary.running}/${summary.total}`}
              delta={`${copy.utilization24} ${formatPercent(utilization24.rate)}`}
              deltaTone={utilizationTone}
              onClick={() => setIsUtilizationModalOpen(true)}
              actionLabel={copy.utilizationModalTitle}
            />
            <SummaryMetricCard
              title={language === "ko" ? "선택일 관측 형합 합계 (shot)" : "所选日观测模次合计 (shot)"}
              value={formatNumber(todayFleetSummary.output)}
              delta={language === "ko" ? "시간대 원천 참고값 · 일일 ea 실적과 구분" : "时段源数据参考值 · 与日实绩 ea 区分"}
              deltaTone="neutral"
            />
            <SummaryMetricCard
              title={copy.recentOutput60}
              value={formatNumber(recentFleetSummary.output)}
              delta={recentOutputDelta === null ? copy.noCompareData : `${copy.previous60} ${formatSignedNumber(recentOutputDelta)}`}
              deltaTone={recentOutputDelta === null ? "neutral" : recentOutputDelta > 0 ? "up" : recentOutputDelta < 0 ? "down" : "neutral"}
            />
            <SummaryMetricCard
              title={copy.recentAvgOil60}
              value={formatTemperature(recentFleetSummary.oilTemperature)}
              delta={
                recentOilDelta === null
                  ? copy.noCompareData
                  : `${copy.previous60} ${formatSignedNumber(recentOilDelta, "°C")}`
              }
              deltaTone={recentOilDelta === null ? "neutral" : recentOilDelta > 0 ? "up" : recentOilDelta < 0 ? "down" : "neutral"}
            />
            <SummaryMetricCard
              title={copy.todayPowerUsage}
              value={`${formatDecimal(todayFleetSummary.power, 2)} kWh`}
              delta={
                todayPowerDelta === null
                  ? copy.noCompareData
                  : `${copy.previousDay} ${formatSignedInteger(todayPowerDelta, " kWh")}`
              }
              deltaTone={todayPowerDelta === null ? "neutral" : todayPowerDelta > 0 ? "up" : todayPowerDelta < 0 ? "down" : "neutral"}
            />
          </div>

          <section className="panel mes-fleet-production-card">
            <div className="mes-fleet-production-card__header">
              <div>
                <p className="panel-card__eyebrow">{copy.fleetProductionEyebrow}</p>
                <h3 className="panel__title">{copy.fleetProductionTitle}</h3>
                <p>{copy.fleetProductionDescription}</p>
              </div>
            </div>
            <div className="mes-fleet-production-card__body">
              <div className="mes-fleet-production-card__progress">
                <strong>{formatNumber(todayFleetSummary.output)} shot</strong>
                <p>{language === "ko" ? "선택일 08:00 이상, 다음 날 08:00 미만의 관측 구간만 합산합니다. 품목·Cavity를 배분한 일일 ea 실적은 생산 관리의 공통 집계를 확인하세요." : "仅合计所选日08:00（含）至次日08:00（不含）的观测区间。按品号、穴数分配的日实绩 ea 请查看生产管理的统一汇总。"}</p>
                <Link className="button button--ghost" to={buildInjectionLink("/injection/dashboard", scope, "overview")}>{language === "ko" ? "일일 ea 실적 · 공통 집계" : "日实绩 ea · 统一汇总"}</Link>
                <Link className="button button--ghost" to={`/production/stats?date=${encodeURIComponent(injectionDate)}&plan_type=injection`}>{language === "ko" ? "MES 보고 원장 · 전체 설비" : "MES 报工台账 · 全部设备"}</Link>
              </div>
              <div className="mes-fleet-production-metrics">
                <div>
                  <span>{copy.activeMachines}</span>
                  <strong>{summary.running}/{summary.total}</strong>
                </div>
                <div>
                  <span>{copy.recentOutput60}</span>
                  <strong>{formatNumber(recentFleetSummary.output)}</strong>
                </div>
                <div>
                  <span>{copy.fleetElapsedUph}</span>
                  <strong>{formatDecimal(fleetElapsedUph, 1)}</strong>
                </div>
                <div>
                  <span>{copy.utilization24}</span>
                  <strong>{formatPercent(utilization24.rate)}</strong>
                </div>
              </div>
            </div>

            <div className="mes-fleet-machine-spread">
              <div className="mes-fleet-machine-spread__header">
                <span>{copy.fleetMachineSpread}</span>
                <em>{copy.lastUpdated}: {injectionQuery.data?.source_latest_at ? formatDateTime(injectionQuery.data.source_latest_at, language) : copy.noData}</em>
              </div>
              <div className="mes-fleet-machine-spread__grid">
                {machineRows.map((row) => {
                  const productionWindow = machineProductionWindows.get(row.machineNumber);
                  const machineUph = productionWindow?.activeHours ? row.shiftOutput / productionWindow.activeHours : 0;
                  return (
                    <div className={`mes-fleet-machine-spread__item mes-fleet-machine-spread__item--${row.status}`} key={row.machineNumber}>
                      <span>{row.machineNumber}</span>
                      <div>
                        <i style={{ height: `${Math.max(4, (row.shiftOutput / maxMachineShiftOutput) * 100)}%` }} />
                      </div>
                      <strong>{copy.fleetMachineTotal} {formatNumber(row.shiftOutput)}</strong>
                      <small>{copy.uph} {formatDecimal(machineUph, 1)}</small>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          </>}

          <section className="panel mes-monitor-panel">
            <div className="mes-monitor-panel__header">
              <div>
                <p className="panel-card__eyebrow">Injection</p>
                <h3 className="panel__title">{copy.injectionTitle}</h3>
              </div>
              <div className="mes-monitor-panel__actions">
                <span>
                  {copy.lastUpdated}:{" "}
                  {injectionQuery.data?.source_latest_at ? formatDateTime(injectionQuery.data.source_latest_at, language) : copy.noData}
                </span>
                {isCurrentInjectionDate ? (
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={isBackfillRunning}
                    onClick={() => updateMutation.mutate()}
                  >
                    {isBackfillRunning
                      ? `${copy.refreshing}${backfillPercent ? ` ${backfillPercent}%` : ""}`
                      : copy.refresh}
                  </button>
                ) : (
                  <span>{copy.historicalSnapshotMode}</span>
                )}
              </div>
            </div>
            {isBackfillRunning && (
              <div className="mes-backfill-progress" aria-label={copy.backfillProgress}>
                <span style={{ width: `${Math.max(2, backfillPercent)}%` }} />
                <strong>{copy.backfillProgress} {backfillPercent}%</strong>
              </div>
            )}

            {(updateMutation.isError || updateStatusQuery.isError || updateStatusQuery.data?.status === "failed") && <p className="notice notice--warning">{language === "ko" ? "보강 수집에 실패했거나 진행 상태를 확인할 수 없습니다. 저장된 자료의 원천 시각을 확인하세요." : "补采失败或无法确认进度，请核对已保存资料的源数据时间。"}</p>}
            {matrixState !== "ready" ? (
              <MonitoringStateNotice state={matrixState} language={language} onRetry={() => { void injectionQuery.refetch(); }} />
            ) : (
              <>
                <div className="mes-machine-rail__header">
                  <div>
                    <h4>{language === "ko" ? "상세 설비 선택" : "详细设备选择"}</h4>
                    <button className="button button--ghost" type="button" onClick={() => setSelectedMachineNumber(null)}>{language === "ko" ? "전체 설비 보기" : "查看全部设备"}</button>
                    <p>{copy.machineRailHint}</p>
                  </div>
                  {selectedMachine && (
                    <strong>
                      {copy.selectedMachine}: {formatLocalizedMachineName(selectedMachine.name, language)} · {formatTonnage(selectedMachine.tonnage)}
                    </strong>
                  )}
                </div>

                <div className="mes-machine-rail" aria-label={copy.machineRailTitle}>
                  {machineRows.map((row) => (
                    <button
                      key={row.machineNumber}
                      type="button"
                      className={`mes-machine-tile mes-machine-tile--${row.status} ${
                        selectedMachineNumber === row.machineNumber ? "mes-machine-tile--active" : ""
                      }`}
                      onClick={() => setSelectedMachineNumber(row.machineNumber)}
                    >
                      <span className="mes-machine-tile__name">{row.machineNumber}</span>
                      <span className="mes-machine-tile__ton">{formatTonnage(row.tonnage)}</span>
                      <strong>{row.status === "warning" ? "—" : formatNumber(row.shiftOutput)}</strong>
                      <small>{row.status === "warning" ? copy.warning : formatTemperature(row.oilTemperature)}</small>
                    </button>
                  ))}
                </div>

                {selectedMachineNumber === null && <p className="notice notice--neutral">{language === "ko" ? "설비를 선택하면 해당 설비의 시간대 형합·전력·오일온도를 확인할 수 있습니다." : "选择设备后，可查看该设备各时段合模、电力及油温。"}</p>}
                {selectedMachine && <MonitoringCoverageNotice data={injectionQuery.data} machineNumber={selectedMachineNumber} language={language} />}
                {selectedMachine && selectedCoverage.ready && (
                  <div className="mes-live-layout">
                    <div className="mes-summary-column">
                      <article className="mes-period-card">
                        <span>{copy.shiftSummary}</span>
                        <strong>{formatNumber(shiftSummary.output)}</strong>
                        <dl>
                          <div>
                            <dt>{copy.totalOutput}</dt>
                            <dd>{formatNumber(shiftSummary.output)}</dd>
                          </div>
                          <div>
                            <dt>{copy.totalPower}</dt>
                            <dd>{formatDecimal(shiftSummary.power, 2)} kWh</dd>
                          </div>
                          <div>
                            <dt>{copy.avgOil}</dt>
                            <dd>{formatTemperature(shiftSummary.oilTemperature)}</dd>
                          </div>
                        </dl>
                      </article>

                      <article className="mes-period-card mes-period-card--recent">
                        <span>{copy.recentSummary}</span>
                        <strong>{formatNumber(recentSummary.output)}</strong>
                        <dl>
                          <div>
                            <dt>{copy.totalOutput}</dt>
                            <dd>{formatNumber(recentSummary.output)}</dd>
                          </div>
                          <div>
                            <dt>{copy.totalPower}</dt>
                            <dd>{formatDecimal(recentSummary.power, 2)} kWh</dd>
                          </div>
                          <div>
                            <dt>{copy.avgOil}</dt>
                            <dd>{formatTemperature(recentSummary.oilTemperature)}</dd>
                          </div>
                        </dl>
                      </article>
                    </div>

                    <article className="mes-trend-card">
                      <div className="mes-trend-card__header">
                        <div>
                          <h4>
                            {formatLocalizedMachineName(selectedMachine.name, language)} · {copy.trendTitle}
                          </h4>
                        </div>
                        <div className="mes-trend-card__current">
                          <span>{copy.todayCumulative}</span>
                          <strong>{formatNumber(shiftSummary.output)}</strong>
                        </div>
                      </div>

                      <div className="mes-combined-chart-wrap">
                        <CombinedTrendChart
                          points={hourlyTrend}
                          labels={{ output: copy.output, power: copy.power, oil: copy.oil }}
                          language={language}
                          scale={fleetHourlyTrendScale}
                        />
                      </div>

                      <div className="mes-trend-legend">
                        <span><i className="mes-trend-legend__output" />{copy.trendOutput}</span>
                        <span><i className="mes-trend-legend__power" />{copy.trendPower}</span>
                        <span><i className="mes-trend-legend__oil" />{copy.trendOil}</span>
                      </div>
                    </article>
                  </div>
                )}
              </>
            )}
          </section>

          <MonitoringStateNotice state={transitionState} language={language} onRetry={retryFleet} />
          {transitionState === "ready" && transitionCoverage.ready && !transitionCoverage.hasGaps ? (
          <InjectionTransitionPanel
            analysis={transitionAnalysis}
            canConfirm={hasCapability("injection.write")}
            confirmationState={downtimeConfirmationsQuery.isError ? "error" : downtimeConfirmationsQuery.isPending ? "loading" : "ready"}
            confirmations={downtimeConfirmationsQuery.data?.confirmations}
            copy={copy}
            language={language}
            machineKey={selectedMachineNumber}
            mode="review"
            onResetConfirmation={(eventKey) => resetDowntimeConfirmationMutation.mutateAsync(eventKey)}
            onSaveConfirmation={(payload) => saveDowntimeConfirmationMutation.mutateAsync(payload)}
          />

          ) : transitionState === "ready" ? <p className="notice notice--warning">{language === "ko" ? "형합 관측 구간이 부족하거나 지연되어 자동 정지·전환 판정을 보류합니다. 선택일의 현장 확정 기록은 생산 관리에서 확인하세요." : "合模观测区间不足或延迟，暂停自动停机、换模判断。所选日现场确认记录请在生产管理中查看。"}</p> : null}

          <details className="panel" onToggle={(event) => setIsMachiningOpen(event.currentTarget.open)}>
            <summary>{language === "ko" ? "가공 생산보고 · 펼쳐서 조회" : "加工报工 · 展开查询"}</summary>
            {isMachiningOpen && <>
            <MonitoringStateNotice state={machiningState} language={language} onRetry={() => { void machiningStatsQuery.refetch(); }} />
            {machiningState === "ready" && <>
          <div className="mes-stats-grid">
            <SummaryMetricCard
              title={copy.machiningTotalPlan}
              value={formatNumber(machiningStats?.summary.total_planned ?? 0)}
              delta={copy.planReady}
              deltaTone="info"
            />
            <SummaryMetricCard
              title={copy.machiningTotalMes}
              value={formatNumber(machiningStats?.summary.total_mes ?? 0)}
              delta={`${copy.machiningReports} ${formatNumber(machiningStats?.summary.grouped_mes_count ?? 0)}`}
              deltaTone="up"
            />
            <SummaryMetricCard
              title={copy.machiningAchievement}
              value={formatPercent((machiningStats?.summary.total_planned ?? 0) > 0 ? machiningStats?.summary.achievement_rate ?? null : null)}
              delta={`${copy.machiningMatched} ${formatNumber(machiningStats?.summary.matched_rows ?? 0)}`}
              deltaTone="neutral"
            />
            <SummaryMetricCard
              title={copy.machiningGap}
              value={(machiningStats?.summary.total_planned ?? 0) > 0 ? formatSignedQty(machiningStats?.summary.gap_qty ?? 0) : "—"}
              delta={copy.fleetPlanGap}
              deltaTone={machiningGapTone}
            />
            <SummaryMetricCard
              title={copy.machiningUnreported}
              value={formatNumber(machiningStats?.summary.plan_only_rows ?? 0)}
              delta={`${copy.machiningMesOnly} ${formatNumber(machiningStats?.summary.mes_only_rows ?? 0)}`}
              deltaTone={(machiningStats?.summary.plan_only_rows ?? 0) > 0 ? "down" : "up"}
            />
          </div>

          <section className="panel mes-monitor-panel mes-machining-panel">
            <div className="mes-monitor-panel__header">
              <div>
                <p className="panel-card__eyebrow">Machining</p>
                <h3 className="panel__title">{copy.machiningTitle}</h3>
                <p className="mes-machining-panel__hint">{copy.machiningTableHint}</p>
              </div>
              <div className="mes-monitor-panel__actions mes-machining-toolbar">
                <span>
                  {copy.machiningLatest}:{" "}
                  {machiningLatestReportTime ? formatDateTime(machiningLatestReportTime, language) : copy.noData}
                </span>
              </div>
            </div>

            {machiningStatsQuery.isError ? (
              <div className="notice notice--warning">{copy.fetchError}</div>
            ) : machiningStatsQuery.isLoading && !machiningStats ? (
              <div className="notice notice--neutral">{copy.loadingData}</div>
            ) : machiningRows.length ? (
              <div className="mes-machining-table-wrap">
                <table className="mes-machining-table">
                  <thead>
                    <tr>
                      <th>{copy.machiningLine}</th>
                      <th>{copy.machiningPartNo}</th>
                      <th>{copy.machiningModel}</th>
                      <th>{copy.machiningPlanned}</th>
                      <th>{copy.machiningReported}</th>
                      <th>{copy.machiningStatus}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {machiningRows.map((row) => {
                      const achievement = row.achievement_rate ?? (row.planned_qty > 0 ? 0 : 100);
                      const progress = Math.max(0, Math.min(100, achievement));
                      const isOverrun = row.gap_qty > 0;
                      return (
                        <tr key={`${row.equipment_key}-${row.part_no}`}>
                          <td>
                            <div className="mes-machining-line-cell">
                              <strong>{row.equipment_label || row.equipment_name || row.equipment_key}</strong>
                              <span>{row.equipment_name || "-"}</span>
                            </div>
                          </td>
                          <td>{row.part_no}</td>
                          <td>{row.model_name || "-"}</td>
                          <td>{formatNumber(row.planned_qty)}</td>
                          <td>
                            <div className="mes-machining-progress-cell">
                              <strong>{formatNumber(row.mes_qty)}</strong>
                              <div className={`mes-machining-progress${isOverrun ? " mes-machining-progress--overrun" : ""}`}>
                                <span style={{ width: `${progress}%` }} />
                              </div>
                              <small>{row.achievement_rate === null ? "-" : formatPercent(row.achievement_rate)}</small>
                            </div>
                          </td>
                          <td>
                            <span className={`mes-machining-status mes-machining-status--${row.compare_status}`}>
                              {compareStatusLabel(row.compare_status, copy)}
                            </span>
                            <small>{copy.machiningReports} {formatNumber(row.mes_report_count)}</small>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="notice notice--neutral">{copy.machiningEmpty}</div>
            )}
          </section>
            </>}
            </>}
          </details>
        </>
        )
      ) : (
        <section className="panel mes-ready-panel">
          <p className="panel-card__eyebrow">{copy.readyStatus}</p>
          <h3 className="panel__title">
            {copy.inventoryTitle}
          </h3>
          <p>
            {language === "ko" ? "현재 재고와 입출고는 재고 상세 화면에서 확인합니다." : "当前库存与出入库请在库存明细页面查看。"}
          </p>
          <Link className="button button--primary" to="/sales/inventory-status">{language === "ko" ? "재고 상세 열기" : "打开库存明细"}</Link>
        </section>
      )}
      {isUtilizationModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsUtilizationModalOpen(false);
            }
          }}
        >
          <section
            className="modal-card mes-utilization-modal"
            aria-label={copy.utilizationModalTitle}
            aria-modal="true"
            role="dialog"
          >
            <div className="modal-card__header">
              <div>
                <p className="panel-card__eyebrow">{copy.utilization24}</p>
                <h3 className="panel__title">{copy.utilizationModalTitle}</h3>
                <p className="plan-dashboard__meta">{copy.utilizationModalSubtitle}</p>
              </div>
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setIsUtilizationModalOpen(false)}
              >
                {copy.close}
              </button>
            </div>

            <div className="mes-utilization-filter">
              <span>{copy.utilizationPeriod}</span>
              <label>
                {copy.utilizationStartDate}
                <input
                  type="date"
                  value={utilizationStartDate}
                  max={utilizationEndDate}
                  onChange={(event) => setUtilizationStartDate(event.target.value)}
                />
              </label>
              <label>
                {copy.utilizationEndDate}
                <input
                  type="date"
                  value={utilizationEndDate}
                  min={utilizationStartDate}
                  max={defaultUtilizationEndDate}
                  onChange={(event) => setUtilizationEndDate(event.target.value)}
                />
              </label>
              <button
                className="button button--ghost"
                type="button"
                onClick={() => {
                  setUtilizationStartDate(defaultUtilizationStartDate);
                  setUtilizationEndDate(defaultUtilizationEndDate);
                }}
              >
                {copy.recentTwoWeeks}
              </button>
            </div>

            {utilizationState !== "ready" ? (
              <MonitoringStateNotice state={utilizationState} language={language} onRetry={() => { void utilizationQuery.refetch(); }} />
            ) : !utilizationCoverage.ready ? (
              <MonitoringCoverageNotice data={utilizationQuery.data} language={language} />
            ) : isUtilizationAnalysisLoading ? (
              <div className="mes-utilization-loading">
                <span className="mes-skeleton-line mes-skeleton-line--wide" />
                <span className="mes-skeleton-chart__box" />
                <p className="mes-loading-note">{copy.loadingData}</p>
              </div>
            ) : (
              <>
                <div className="mes-utilization-summary">
                  <div>
                    <span>{copy.utilizationRate}</span>
                    <strong>{formatPercent(selectedUtilizationSummary.rate)}</strong>
                  </div>
                  <div>
                    <span>{language === "ko" ? "기간 일평균 형합 설비 수" : "期间日均合模设备数"}</span>
                    <strong>{formatDecimal(selectedUtilizationSummary.activeMachines, 1)}</strong>
                  </div>
                  <div>
                    <span>{copy.utilizationSavedAt}</span>
                    <strong>{utilizationQuery.data?.source_latest_at ? formatDateTime(utilizationQuery.data.source_latest_at, language) : copy.noData}</strong>
                  </div>
                </div>

                <div className="mes-utilization-chart-panel">
                  <DailyUtilizationChart
                    points={dailyUtilizationPoints}
                    labels={{
                      utilizationRate: copy.utilizationRate,
                      activeMachineCount: copy.activeMachineCount,
                    }}
                  />
                </div>

                <div className="mes-trend-legend mes-utilization-legend">
                  <span><i className="mes-utilization-legend__bar" />{copy.activeMachineCount}</span>
                  <span><i className="mes-utilization-legend__line" />{copy.utilizationRate}</span>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}
