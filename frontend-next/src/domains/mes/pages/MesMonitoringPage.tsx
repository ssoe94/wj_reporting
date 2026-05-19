import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type InjectionProductionMatrix,
  type MesDataSource,
  getInjectionSnapshotUpdateStatus,
  getInjectionProductionMatrix,
  getInjectionUtilizationMatrix,
  requestInjectionSnapshotUpdate,
} from "@/domains/mes/api";
import {
  getProductionMesReportStats,
  getProductionPlanSummary,
  getProductionStatus,
  type ProductionMesReportStatsResponse,
} from "@/domains/production/api";
import { InjectionTransitionPanel } from "@/domains/production/components/InjectionTransitionPanel";
import { buildInjectionTransitionAnalysis } from "@/domains/production/injection-transition-analysis";
import { buildRealtimeProgressSummary, type RealtimeProgressSummary } from "@/domains/production/realtime-progress";
import { PageHeaderIcon } from "@/shared/components/PageHeader";
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
  output: number;
  power: number;
  oilTemperature: number | null;
};

type HourlyTrendScale = {
  powerMax: number;
  oilMax: number;
};

type InjectionReceiptStatus = "matched" | "shortage" | "over" | "missing" | "receipt_only";
type InjectionReceiptMatchMethod = "direct_part_no" | "model_candidate" | "unmatched";

type InjectionReceiptComparisonRow = {
  key: string;
  machineKey: string;
  machineLabel: string;
  partNo: string;
  modelName: string;
  plannedQty: number;
  estimatedQty: number;
  allocatedShots: number;
  receiptQty: number;
  gapQty: number;
  reportCount: number;
  latestReportTime: string | null;
  status: InjectionReceiptStatus;
  sequence: number;
  receiptPartNos: string[];
  matchMethods: InjectionReceiptMatchMethod[];
};

type InjectionReceiptComparison = {
  rows: InjectionReceiptComparisonRow[];
  summary: {
    plannedQty: number;
    estimatedQty: number;
    receiptQty: number;
    gapQty: number;
    matchedCount: number;
    issueCount: number;
    latestReportTime: string | null;
  };
};

const pageCopy = {
  ko: {
    eyebrow: "MES MONITORING",
    title: "MES 데이터 모니터링",
    description: "MES에서 수집한 생산·설비 데이터를 저장하고 모니터링합니다.",
    availableData: "조회 가능 데이터",
    sourceDescriptionInjection: "사출기의 생산량, 형합수, 오일온도, 전력 사용량을 확인할 수 있습니다.",
    sourceDescriptionMachining: "가공 생산 완료 보고를 연결해 계획 대비 진행률과 미보고 항목을 확인할 예정입니다.",
    sourceDescriptionInventory: "재고 API를 연결해 품번별 현재고, 부족 수량, 입출고 변동을 확인할 예정입니다.",
    selectHint: "현재 선택",
    injection: "사출기 정보",
    machining: "가공 생산보고 정보",
    inventory: "재고 정보",
    refresh: "최근 24시간 보강 수집",
    refreshing: "보강 수집 중",
    loadingData: "MES 데이터를 불러오는 중입니다.",
    backfillProgress: "보강 진행률",
    lastUpdated: "마지막 갱신",
    activeMachines: "가동 설비",
    todayOutput: "금일 총 생산량",
    recentOutput60: "최근 60분 형합수",
    recentAvgOil60: "최근 60분 평균 오일온도",
    avgOil: "평균 오일온도",
    todayPowerUsage: "금일 총 전력 사용량",
    fleetProductionEyebrow: "INJECTION TOTAL",
    fleetProductionTitle: "전체 사출기 총합 생산현황",
    fleetProductionDescription: "기준일 08:00부터 현재까지 17대 사출기의 MES 형합수와 생산계획 기준 추정 실적을 합산합니다.",
    fleetPlanProgress: "계획 진행률",
    fleetPlanGap: "계획 대비",
    fleetMachineSpread: "설비별 생산 분포",
    fleetElapsedUph: "생산구간 UPH",
    fleetMachineTotal: "총",
    uph: "UPH",
    planShortage: "계획 대비 부족",
    planReady: "계획 수량 기준",
    utilization24: "최근 24시간 가동률",
    utilizationModalTitle: "가동률 상세 분석",
    utilizationModalSubtitle: "날짜별 가동 기기 수와 가동률",
    utilizationPeriod: "분석 기간",
    utilizationStartDate: "시작일",
    utilizationEndDate: "종료일",
    recentTwoWeeks: "최근 2주",
    utilizationRate: "가동률",
    activeMachineCount: "가동 기기 수",
    utilizationSavedAt: "저장 갱신",
    close: "닫기",
    previous60: "직전 60분 대비",
    previousDay: "전일 동시간 대비",
    noCompareData: "비교 데이터 부족",
    injectionTitle: "사출기 실시간 현황",
    injectionHint: "1~17호기를 순서대로 확인하고, 선택한 호기의 24시간 추세를 분석합니다.",
    machineRailTitle: "설비 선택",
    machineRailHint: "호기를 선택하면 아래 요약과 추이 그래프가 해당 설비 기준으로 변경됩니다.",
    selectedMachine: "선택 설비",
    shiftSummary: "금일 08:00 ~ 현재",
    recentSummary: "최근 60분",
    trendTitle: "최근 24시간 추이",
    trendHint: "10분 수집 데이터를 정시간 단위로 집계해 형합수, 전력, 오일온도 추세를 표시합니다.",
    output: "형합수",
    cumulative: "누적",
    todayCumulative: "금일 누적",
    oil: "오일온도",
    power: "전력",
    powerTotal: "누적 전력",
    totalOutput: "총 형합수",
    totalPower: "총 전력량",
    trendOutput: "정시간 형합수",
    trendPower: "전력 사용량",
    trendOil: "오일온도",
    running: "가동",
    idle: "대기",
    warning: "확인 필요",
    noData: "데이터 없음",
    fetchError: "MES 데이터를 불러오지 못했습니다.",
    savedByBackend: "수집 시 백엔드 DB에 시간대별 기록으로 저장됩니다.",
    injectionReceiptTitle: "注塑 ZS 입고 / 형합수 비교",
    injectionReceiptBody: "MES ZS 입고 보고 수량을 같은 설비·품번의 형합수 기반 추정 생산량과 비교합니다.",
    injectionReceiptEstimated: "형합수 추정",
    injectionReceiptReported: "ZS 입고",
    injectionReceiptGap: "ZS-형합수",
    injectionReceiptIssue: "확인 필요",
    injectionReceiptMachine: "설비",
    injectionReceiptPartNo: "작업지시 Part No.",
    injectionReceiptSourcePartNo: "ZS Part No.",
    injectionReceiptModel: "모델",
    injectionReceiptPlan: "계획",
    injectionReceiptStatus: "대사 상태",
    injectionReceiptLatest: "최신 ZS",
    injectionReceiptMatched: "수량 일치",
    injectionReceiptShortage: "ZS 입고 부족",
    injectionReceiptOver: "ZS 입고 초과",
    injectionReceiptMissing: "ZS 미입고",
    injectionReceiptOnly: "형합수 없음",
    injectionReceiptMatchBy: "매칭 기준",
    injectionReceiptDirectPartNo: "직접 Part No.",
    injectionReceiptModelCandidate: "모델/품번 후보",
    injectionReceiptUnmatched: "미매칭",
    injectionReceiptEmpty: "비교할 ZS 입고 또는 형합수 추정 실적이 없습니다.",
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
    sourceDescriptionInjection: "可查看注塑机合模数、油温和电力使用量。",
    sourceDescriptionMachining: "后续连接加工生产完成报告，用于查看计划对比进度和未报告项目。",
    sourceDescriptionInventory: "后续连接库存 API，用于查看品号当前库存、缺口数量和出入库变动。",
    selectHint: "当前选择",
    injection: "注塑机信息",
    machining: "加工生产报告",
    inventory: "库存信息",
    refresh: "补采最近 24 小时",
    refreshing: "补采中",
    loadingData: "正在读取 MES 数据。",
    backfillProgress: "补采进度",
    lastUpdated: "最后更新",
    activeMachines: "运行设备",
    todayOutput: "今日总产量",
    recentOutput60: "最近 60 分钟合模数",
    recentAvgOil60: "最近 60 分钟平均油温",
    avgOil: "平均油温",
    todayPowerUsage: "今日总用电量",
    fleetProductionEyebrow: "INJECTION TOTAL",
    fleetProductionTitle: "全部注塑机汇总生产状态",
    fleetProductionDescription: "按基准日 08:00 至当前，汇总 17 台注塑机的 MES 合模数与生产计划推定实绩。",
    fleetPlanProgress: "计划进度",
    fleetPlanGap: "计划对比",
    fleetMachineSpread: "设备产量分布",
    fleetElapsedUph: "生产区间 UPH",
    fleetMachineTotal: "总",
    uph: "UPH",
    planShortage: "计划差额",
    planReady: "按计划数量",
    utilization24: "最近24小时运行率",
    utilizationModalTitle: "运行率详细分析",
    utilizationModalSubtitle: "按日期查看运行设备数与运行率",
    utilizationPeriod: "分析期间",
    utilizationStartDate: "开始日",
    utilizationEndDate: "结束日",
    recentTwoWeeks: "最近2周",
    utilizationRate: "运行率",
    activeMachineCount: "运行设备数",
    utilizationSavedAt: "保存更新",
    close: "关闭",
    previous60: "较前 60 分钟",
    previousDay: "较昨日同时段",
    noCompareData: "比较数据不足",
    injectionTitle: "注塑机实时状态",
    injectionHint: "按 1~17 号设备顺序查看，并分析所选设备的 24 小时趋势。",
    machineRailTitle: "设备选择",
    machineRailHint: "选择设备后，下方摘要和趋势图会按该设备更新。",
    selectedMachine: "所选设备",
    shiftSummary: "今日 08:00 ~ 当前",
    recentSummary: "最近 60 分钟",
    trendTitle: "最近 24 小时趋势",
    trendHint: "将 10 分钟采集数据按整点汇总，显示合模数、电力、油温趋势。",
    output: "合模数",
    cumulative: "累计",
    todayCumulative: "今日累计",
    oil: "油温",
    power: "电力",
    powerTotal: "累计电力",
    totalOutput: "总合模数",
    totalPower: "总电量",
    trendOutput: "整点合模数",
    trendPower: "电力使用量",
    trendOil: "油温",
    running: "运行",
    idle: "待机",
    warning: "需确认",
    noData: "无数据",
    fetchError: "无法读取 MES 数据。",
    savedByBackend: "采集时会按时间段保存到后端数据库。",
    injectionReceiptTitle: "注塑 ZS 入库 / 合模数对比",
    injectionReceiptBody: "将 MES ZS 入库报工数量与同一设备、品号的合模数推定生产量进行对账。",
    injectionReceiptEstimated: "合模数推定",
    injectionReceiptReported: "ZS 入库",
    injectionReceiptGap: "ZS-合模数",
    injectionReceiptIssue: "需确认",
    injectionReceiptMachine: "设备",
    injectionReceiptPartNo: "工单 Part No.",
    injectionReceiptSourcePartNo: "ZS Part No.",
    injectionReceiptModel: "型号",
    injectionReceiptPlan: "计划",
    injectionReceiptStatus: "对账状态",
    injectionReceiptLatest: "最新 ZS",
    injectionReceiptMatched: "数量一致",
    injectionReceiptShortage: "ZS 入库不足",
    injectionReceiptOver: "ZS 入库超出",
    injectionReceiptMissing: "未入 ZS",
    injectionReceiptOnly: "无合模数",
    injectionReceiptMatchBy: "匹配依据",
    injectionReceiptDirectPartNo: "直接 Part No.",
    injectionReceiptModelCandidate: "型号/品号候选",
    injectionReceiptUnmatched: "未匹配",
    injectionReceiptEmpty: "暂无可比较的 ZS 入库或合模数推定实绩。",
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

const sourceOptions = [
  { value: "injection", labelKey: "injection" },
  { value: "machining", labelKey: "machining" },
  { value: "inventory", labelKey: "inventory" },
] satisfies Array<{ value: MesDataSource; labelKey: "injection" | "machining" | "inventory" }>;

function numberAt(values: number[] | undefined, index: number) {
  if (!values || index < 0) return 0;
  return Number(values[index] ?? 0);
}

function nullableNumberAt(values: number[] | undefined, index: number) {
  if (!values || index < 0 || values[index] === undefined || values[index] === null) return null;
  const value = Number(values[index]);
  return Number.isFinite(value) && value !== 0 ? value : null;
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

function normalizeComparisonPartNo(value: string | null | undefined) {
  return normalizeComparisonIdentity(value);
}

function normalizeComparisonIdentity(value: string | number | null | undefined) {
  return String(value ?? "").replace(/\s+/g, "").trim().toUpperCase();
}

function normalizeComparisonMachineKey(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const suffixMatch = text.match(/-(\d+)\s*$/);
  if (suffixMatch) return suffixMatch[1];
  const koreanMatch = text.match(/(\d+)\s*호기/);
  if (koreanMatch) return koreanMatch[1];
  const leadingMatch = text.match(/^(\d+)(?:\D|$)/);
  if (leadingMatch) return leadingMatch[1];
  return text;
}

function injectionReceiptStatusLabel(status: InjectionReceiptStatus, copy: Record<string, string>) {
  if (status === "matched") return copy.injectionReceiptMatched;
  if (status === "shortage") return copy.injectionReceiptShortage;
  if (status === "over") return copy.injectionReceiptOver;
  if (status === "missing") return copy.injectionReceiptMissing;
  return copy.injectionReceiptOnly;
}

function resolveInjectionReceiptStatus(estimatedQty: number, receiptQty: number): InjectionReceiptStatus {
  if (estimatedQty > 0 && receiptQty > 0) {
    if (Math.round(estimatedQty) === Math.round(receiptQty)) return "matched";
    return receiptQty > estimatedQty ? "over" : "shortage";
  }
  if (estimatedQty > 0) return "missing";
  return "receipt_only";
}

function expandSlashComparisonToken(token: string) {
  const normalized = normalizeComparisonIdentity(token);
  if (!normalized.includes("/")) return [normalized];
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) return [normalized];

  const expanded = new Set<string>([normalized, parts[0]]);
  const base = parts[0];
  for (const suffix of parts.slice(1)) {
    if (!suffix) continue;
    if (/[A-Z]/.test(suffix) && suffix.length >= base.length / 2) {
      expanded.add(suffix);
      continue;
    }
    const prefixLength = Math.max(0, base.length - suffix.length);
    expanded.add(`${base.slice(0, prefixLength)}${suffix}`);
  }

  return [...expanded];
}

function isUsefulComparisonToken(token: string) {
  const normalized = normalizeComparisonIdentity(token);
  return normalized.length >= 4;
}

function getComparisonTokens(...values: Array<string | number | null | undefined>) {
  const tokens = new Set<string>();

  for (const value of values) {
    const rawText = String(value ?? "").trim();
    if (!rawText) continue;

    const whole = normalizeComparisonIdentity(rawText);
    if (isUsefulComparisonToken(whole)) tokens.add(whole);

    const textTokens = rawText.toUpperCase().match(/[A-Z0-9][A-Z0-9._/-]*[A-Z0-9]/g) ?? [];
    for (const token of textTokens) {
      for (const expanded of expandSlashComparisonToken(token)) {
        const normalized = normalizeComparisonIdentity(expanded);
        if (isUsefulComparisonToken(normalized)) tokens.add(normalized);
      }
    }
  }

  return [...tokens];
}

function addReceiptPartNo(row: InjectionReceiptComparisonRow, partNo: string | null | undefined) {
  const normalized = normalizeComparisonPartNo(partNo);
  if (!normalized) return;
  if (!row.receiptPartNos.some((item) => normalizeComparisonPartNo(item) === normalized)) {
    row.receiptPartNos.push(String(partNo ?? "").trim() || normalized);
  }
}

function addReceiptMatchMethod(row: InjectionReceiptComparisonRow, method: InjectionReceiptMatchMethod) {
  if (!row.matchMethods.includes(method)) {
    row.matchMethods.push(method);
  }
}

function receiptMatchMethodLabel(method: InjectionReceiptMatchMethod, copy: Record<string, string>) {
  if (method === "direct_part_no") return copy.injectionReceiptDirectPartNo;
  if (method === "model_candidate") return copy.injectionReceiptModelCandidate;
  return copy.injectionReceiptUnmatched;
}

function registerInjectionReceiptCandidate(
  candidateIndex: Map<string, string | null>,
  machineKey: string,
  rowKey: string,
  ...values: Array<string | number | null | undefined>
) {
  for (const token of getComparisonTokens(...values)) {
    const candidateKey = `${machineKey}::${token}`;
    const existing = candidateIndex.get(candidateKey);
    if (existing === undefined) {
      candidateIndex.set(candidateKey, rowKey);
    } else if (existing !== rowKey) {
      candidateIndex.set(candidateKey, null);
    }
  }
}

function resolveInjectionReceiptRowKey(
  candidateIndex: Map<string, string | null>,
  machineKey: string,
  ...values: Array<string | number | null | undefined>
) {
  for (const token of getComparisonTokens(...values)) {
    const rowKey = candidateIndex.get(`${machineKey}::${token}`);
    if (rowKey) return rowKey;
  }
  return null;
}

function buildInjectionReceiptComparison(
  realtimeProgress: RealtimeProgressSummary,
  reportStats: ProductionMesReportStatsResponse | undefined,
): InjectionReceiptComparison {
  const rowsByKey = new Map<string, InjectionReceiptComparisonRow>();
  const candidateIndex = new Map<string, string | null>();

  for (const progressRow of realtimeProgress.rows) {
    const machineKey = normalizeComparisonMachineKey(progressRow.key) || normalizeComparisonMachineKey(progressRow.label);
    if (!machineKey) continue;
    for (const segment of progressRow.segments) {
      const partKey = normalizeComparisonPartNo(segment.partNo);
      if (!partKey || partKey === "-") continue;
      const key = `${machineKey}::${partKey}`;
      const current = rowsByKey.get(key) ?? {
        key,
        machineKey,
        machineLabel: progressRow.label || `${machineKey}호기`,
        partNo: segment.partNo,
        modelName: segment.modelName,
        plannedQty: 0,
        estimatedQty: 0,
        allocatedShots: 0,
        receiptQty: 0,
        gapQty: 0,
        reportCount: 0,
        latestReportTime: null,
        status: "missing" as InjectionReceiptStatus,
        sequence: segment.sequence,
        receiptPartNos: [],
        matchMethods: [],
      };
      current.plannedQty += Number(segment.plannedQty ?? 0);
      current.estimatedQty += Number(segment.estimatedQty ?? 0);
      current.allocatedShots += Number(segment.allocatedShots ?? 0);
      current.sequence = Math.min(current.sequence, segment.sequence);
      if (!current.modelName || current.modelName === "-") {
        current.modelName = segment.modelName;
      }
      rowsByKey.set(key, current);
      registerInjectionReceiptCandidate(candidateIndex, machineKey, key, segment.partNo, segment.modelName);
    }
  }

  for (const reportRow of reportStats?.rows ?? []) {
    const machineKey = (
      normalizeComparisonMachineKey(reportRow.equipment_key)
      || normalizeComparisonMachineKey(reportRow.equipment_name)
      || normalizeComparisonMachineKey(reportRow.equipment_label)
    );
    const partKey = normalizeComparisonPartNo(reportRow.part_no);
    if (!machineKey || !partKey) continue;
    const directKey = `${machineKey}::${partKey}`;
    const matchedPlanKey = resolveInjectionReceiptRowKey(
      candidateIndex,
      machineKey,
      reportRow.part_no,
      reportRow.model_name,
      ...(reportRow.mes_material_names ?? []),
    );
    const key = rowsByKey.has(directKey) ? directKey : matchedPlanKey ?? directKey;
    const current = rowsByKey.get(key) ?? {
      key,
      machineKey,
      machineLabel: reportRow.equipment_label || reportRow.equipment_name || `${machineKey}호기`,
      partNo: reportRow.part_no,
      modelName: reportRow.model_name || "-",
      plannedQty: Number(reportRow.planned_qty ?? 0),
      estimatedQty: 0,
      allocatedShots: 0,
      receiptQty: 0,
      gapQty: 0,
      reportCount: 0,
      latestReportTime: null,
      status: "receipt_only" as InjectionReceiptStatus,
      sequence: 9999,
      receiptPartNos: [],
      matchMethods: [],
    };
    const hasReceipt = Number(reportRow.mes_qty ?? 0) > 0 || Number(reportRow.mes_report_count ?? 0) > 0;
    if (hasReceipt) {
      addReceiptPartNo(current, reportRow.part_no);
      addReceiptMatchMethod(
        current,
        key === directKey && rowsByKey.has(directKey)
          ? "direct_part_no"
          : matchedPlanKey
            ? "model_candidate"
            : "unmatched",
      );
    }
    current.receiptQty += Number(reportRow.mes_qty ?? 0);
    current.reportCount += Number(reportRow.mes_report_count ?? 0);
    if (!current.plannedQty) {
      current.plannedQty = Number(reportRow.planned_qty ?? 0);
    }
    if ((!current.modelName || current.modelName === "-") && reportRow.model_name) {
      current.modelName = reportRow.model_name;
    }
    if (reportRow.latest_report_time && (!current.latestReportTime || reportRow.latest_report_time > current.latestReportTime)) {
      current.latestReportTime = reportRow.latest_report_time;
    }
    rowsByKey.set(key, current);
  }

  const rows = [...rowsByKey.values()]
    .map((row) => {
      const roundedEstimated = Math.round(row.estimatedQty);
      const roundedReceipt = Math.round(row.receiptQty);
      const gapQty = roundedReceipt - roundedEstimated;
      return {
        ...row,
        estimatedQty: roundedEstimated,
        allocatedShots: Math.round(row.allocatedShots),
        receiptQty: roundedReceipt,
        gapQty,
        status: resolveInjectionReceiptStatus(roundedEstimated, roundedReceipt),
      };
    })
    .filter((row) => row.estimatedQty > 0 || row.receiptQty > 0)
    .sort((left, right) => {
      const leftMachine = Number(left.machineKey);
      const rightMachine = Number(right.machineKey);
      if (Number.isFinite(leftMachine) && Number.isFinite(rightMachine) && leftMachine !== rightMachine) {
        return leftMachine - rightMachine;
      }
      if (left.sequence !== right.sequence) return left.sequence - right.sequence;
      return left.partNo.localeCompare(right.partNo, "ko-KR", { numeric: true, sensitivity: "base" });
    });

  const latestReportTime = rows
    .map((row) => row.latestReportTime)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const estimatedQty = rows.reduce((sum, row) => sum + row.estimatedQty, 0);
  const receiptQty = rows.reduce((sum, row) => sum + row.receiptQty, 0);
  const matchedCount = rows.filter((row) => row.status === "matched").length;
  const issueCount = rows.filter((row) => row.status !== "matched").length;

  return {
    rows,
    summary: {
      plannedQty: rows.reduce((sum, row) => sum + row.plannedQty, 0),
      estimatedQty,
      receiptQty,
      gapQty: receiptQty - estimatedQty,
      matchedCount,
      issueCount,
      latestReportTime,
    },
  };
}

function formatTonnage(value: string) {
  return value.endsWith("T") ? value : `${value}T`;
}

function formatDateParam(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(value: Date) {
  const day = new Date(value);
  day.setHours(0, 0, 0, 0);
  return day;
}

function startOfProductionDay(value: Date) {
  const day = new Date(value);
  day.setHours(8, 0, 0, 0);
  if (value < day) {
    day.setDate(day.getDate() - 1);
  }
  return day;
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
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
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatHourLabel(value: Date, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    hour: "2-digit",
    hour12: false,
  }).format(value);
}

function formatShortDate(value: Date, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function formatTooltipDate(value: Date, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    month: "long",
    day: "numeric",
  }).format(value);
}

function formatTooltipTime(value: Date, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function dateKey(value: Date) {
  return `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`;
}

function getShiftSectionInfo(value: Date, language: AppLanguage) {
  const hour = value.getHours();
  const ownerDate = new Date(value);
  if (hour < 8) {
    ownerDate.setDate(ownerDate.getDate() - 1);
  }

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

function buildRows(data?: InjectionProductionMatrix): InjectionMachineRow[] {
  if (!data || data.time_slots.length === 0) return [];
  const latestIndex = data.time_slots.length - 1;
  const latestTime = getLatestTime(data);
  const shiftStartTime = getShiftStart(latestTime);
  const recentStartTime = latestTime ? new Date(latestTime.getTime() - 60 * 60 * 1000) : null;

  return data.machines.map((machine) => {
    const key = String(machine.machine_number);
    const latestOutput = numberAt(data.actual_production_matrix[key], latestIndex);
    const shiftOutput = buildPeriodSummary(data, machine.machine_number, shiftStartTime, latestTime).output;
    const recentOutput = buildPeriodSummary(data, machine.machine_number, recentStartTime, latestTime).output;
    const cumulativeOutput = numberAt(data.cumulative_production_matrix[key], latestIndex);
    const oilTemperature = nullableNumberAt(data.oil_temperature_matrix[key], latestIndex);
    const powerUsage = nullableNumberAt(data.power_usage_matrix?.[key], latestIndex);
    const powerTotal = nullableNumberAt(data.power_kwh_matrix?.[key], latestIndex);
    const status = recentOutput > 0 ? "running" : "idle";

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
  const latestSlot = data?.time_slots.at(-1);
  return latestSlot ? new Date(latestSlot.time) : null;
}

function getShiftStart(latestTime: Date | null) {
  if (!latestTime) return null;
  const shiftStart = new Date(latestTime);
  shiftStart.setHours(8, 0, 0, 0);
  if (latestTime < shiftStart) {
    shiftStart.setDate(shiftStart.getDate() - 1);
  }
  return shiftStart;
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
  const oilTemperatureRow = getMachineMatrixValues(data, data.oil_temperature_matrix, machineNumber);
  let output = 0;
  let power = 0;
  let oilTotal = 0;
  let oilCount = 0;
  let hasPower = false;

  data.time_slots.forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    if (slotTime <= startTime || slotTime > endTime) return;

    output += numberAt(productionRow, index);

    const powerValue = nullableNumberAt(powerUsageRow, index);
    if (powerValue !== null) {
      power += powerValue;
      hasPower = true;
    }

    const oilValue = nullableNumberAt(oilTemperatureRow, index);
    if (oilValue !== null) {
      oilTotal += oilValue;
      oilCount += 1;
    }
  });

  return {
    output,
    power: hasPower ? power : null,
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

  data.machines.forEach((machine) => {
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
  const explicitInterval = data.time_slots[index]?.interval_minutes;
  if (explicitInterval) return explicitInterval;

  const currentTime = new Date(data.time_slots[index]?.time ?? 0);
  const nextSlot = data.time_slots[index + 1];
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
  const machine = data.machines.find((item) => item.machine_number === machineNumber);
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

  data.time_slots.forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    if (slotTime <= startTime || slotTime > endTime) return;

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

  data.time_slots.forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    if (slotTime <= startTime || slotTime > endTime) return;

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
): HourlyTrendPoint[] {
  const latestTime = getLatestTime(data);
  if (!data || !latestTime) return [];

  const firstHour = new Date(latestTime);
  firstHour.setMinutes(0, 0, 0);
  firstHour.setHours(firstHour.getHours() - 23);

  return Array.from({ length: 24 }, (_, hourIndex) => {
    const start = new Date(firstHour);
    start.setHours(firstHour.getHours() + hourIndex);
    const end = new Date(start);
    end.setHours(start.getHours() + 1);

    const summary = buildPeriodSummary(data, machineNumber, start, end);
    return {
      label: formatHourLabel(start, language),
      dateLabel: formatShortDate(start, language),
      startTime: start,
      endTime: end,
      hour: start.getHours(),
      isDayBreak: start.getHours() === 0,
      output: summary.output,
      power: summary.power ?? 0,
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
): HourlyTrendScale {
  if (!data) {
    return { powerMax: 1, oilMax: 50 };
  }

  const allPoints = data.machines.flatMap((machine) => buildHourlyTrend(data, machine.machine_number, language));
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
  const lineFor = (metric: "power" | "oilTemperature", max: number) =>
    points
      .map((point, index) => {
        const value = Number(point[metric] ?? 0);
        return `${index * xGap},${yFor(value, max)}`;
      })
      .join(" ");
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
          const value = Number(point.output ?? 0);
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
        <polyline className="mes-combined-chart__power" points={lineFor("power", powerMax)} />
        <polyline className="mes-combined-chart__oil" points={lineFor("oilTemperature", oilMax)} />
        {points.map((point, index) => (
          <g key={`dots-${point.dateLabel}-${point.label}-${index}`}>
            <circle cx={index * xGap} cy={yFor(point.power, powerMax)} r="2.5" className="mes-combined-chart__power-dot" />
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
          <span>{labels.output} {formatNumber(hoveredPoint.point.output)}</span>
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
  const [selectedSource, setSelectedSource] = useState<MesDataSource>("injection");
  const [selectedMachineNumber, setSelectedMachineNumber] = useState(1);
  const [snapshotJobId, setSnapshotJobId] = useState<string | null>(null);
  const [isUtilizationModalOpen, setIsUtilizationModalOpen] = useState(false);
  const [machiningDate, setMachiningDate] = useState(() => formatDateParam(startOfProductionDay(new Date())));
  const [utilizationStartDate, setUtilizationStartDate] = useState(() => formatDateParam(addDays(new Date(), -13)));
  const [utilizationEndDate, setUtilizationEndDate] = useState(() => formatDateParam(new Date()));
  const copy = pageCopy[language];
  const queryClient = useQueryClient();

  const injectionQuery = useQuery({
    queryKey: ["mes", "injection-production-matrix"],
    queryFn: getInjectionProductionMatrix,
    enabled: selectedSource === "injection",
    refetchInterval: selectedSource === "injection" ? 60_000 : false,
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
    queryKey: ["production-mes-report-stats", "machining", machiningDate],
    queryFn: () => getProductionMesReportStats(machiningDate, "machining"),
    enabled: selectedSource === "machining" && Boolean(machiningDate),
    refetchInterval: selectedSource === "machining" ? 60_000 : false,
  });

  const utilizationColumns = useMemo(
    () => clampDateRangeColumns(utilizationStartDate, getLatestTime(injectionQuery.data) ?? new Date()),
    [injectionQuery.data, utilizationStartDate],
  );

  const utilizationQuery = useQuery({
    queryKey: ["mes", "injection-utilization-matrix", utilizationColumns],
    queryFn: () => getInjectionUtilizationMatrix(utilizationColumns),
    enabled: selectedSource === "injection" && isUtilizationModalOpen,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    const status = updateStatusQuery.data?.status;
    if (status === "completed" || status === "skipped" || status === "failed") {
      void queryClient.invalidateQueries({ queryKey: ["mes", "injection-production-matrix"] });
      window.setTimeout(() => setSnapshotJobId(null), 2000);
    }
  }, [queryClient, updateStatusQuery.data?.status]);

  const machineRows = useMemo(() => buildRows(injectionQuery.data), [injectionQuery.data]);
  const latestSlot = injectionQuery.data?.time_slots.at(-1);
  const latestTime = getLatestTime(injectionQuery.data);
  const defaultUtilizationEndDate = latestTime ? formatDateParam(latestTime) : formatDateParam(new Date());
  const defaultUtilizationStartDate = latestTime
    ? formatDateParam(addDays(latestTime, -13))
    : formatDateParam(addDays(new Date(), -13));
  useEffect(() => {
    if (!isUtilizationModalOpen) return;
    setUtilizationStartDate(defaultUtilizationStartDate);
    setUtilizationEndDate(defaultUtilizationEndDate);
  }, [defaultUtilizationEndDate, defaultUtilizationStartDate, isUtilizationModalOpen]);
  const planDate = latestTime ? formatDateParam(startOfProductionDay(latestTime)) : formatDateParam(startOfProductionDay(new Date()));
  const nextPlanDate = formatDateParam(addDays(new Date(`${planDate}T08:00:00+08:00`), 1));
  const secondNextPlanDate = formatDateParam(addDays(new Date(`${planDate}T08:00:00+08:00`), 2));
  const injectionReportStatsQuery = useQuery({
    queryKey: ["production-mes-report-stats", "injection", planDate],
    queryFn: () => getProductionMesReportStats(planDate, "injection"),
    enabled: selectedSource === "injection" && Boolean(planDate),
    refetchInterval: selectedSource === "injection" ? 60_000 : false,
  });
  const planSummaryQuery = useQuery({
    queryKey: ["production-plan-summary", planDate],
    queryFn: () => getProductionPlanSummary(planDate),
    enabled: selectedSource === "injection" && Boolean(planDate),
  });
  const nextPlanSummaryQuery = useQuery({
    queryKey: ["production-plan-summary", nextPlanDate],
    queryFn: () => getProductionPlanSummary(nextPlanDate),
    enabled: selectedSource === "injection" && Boolean(nextPlanDate),
  });
  const secondNextPlanSummaryQuery = useQuery({
    queryKey: ["production-plan-summary", secondNextPlanDate],
    queryFn: () => getProductionPlanSummary(secondNextPlanDate),
    enabled: selectedSource === "injection" && Boolean(secondNextPlanDate),
  });
  const productionStatusQuery = useQuery({
    queryKey: ["production-status", planDate],
    queryFn: () => getProductionStatus(planDate),
    enabled: selectedSource === "injection" && Boolean(planDate),
    refetchInterval: selectedSource === "injection" ? 60_000 : false,
  });
  const selectedMachine = machineRows.find((row) => row.machineNumber === selectedMachineNumber) ?? machineRows[0];
  const selectedMachineKey = selectedMachine?.machineNumber ?? selectedMachineNumber;
  const selectedSourceDescription =
    selectedSource === "injection"
      ? copy.sourceDescriptionInjection
      : selectedSource === "machining"
        ? copy.sourceDescriptionMachining
        : copy.sourceDescriptionInventory;
  const shiftSummary = useMemo(
    () => buildPeriodSummary(injectionQuery.data, selectedMachineKey, getShiftStart(latestTime), latestTime),
    [injectionQuery.data, latestTime, selectedMachineKey],
  );
  const recentSummary = useMemo(() => {
    if (!latestTime) return { output: 0, power: null, oilTemperature: null };
    return buildPeriodSummary(
      injectionQuery.data,
      selectedMachineKey,
      new Date(latestTime.getTime() - 60 * 60 * 1000),
      latestTime,
    );
  }, [injectionQuery.data, latestTime, selectedMachineKey]);
  const hourlyTrend = useMemo(
    () => buildHourlyTrend(injectionQuery.data, selectedMachineKey, language),
    [injectionQuery.data, language, selectedMachineKey],
  );
  const fleetHourlyTrendScale = useMemo(
    () => buildFleetHourlyTrendScale(injectionQuery.data, language),
    [injectionQuery.data, language],
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
  const dayStart = useMemo(() => {
    return getShiftStart(latestTime);
  }, [latestTime]);
  const recentStart = useMemo(
    () => (latestTime ? new Date(latestTime.getTime() - 60 * 60 * 1000) : null),
    [latestTime],
  );
  const previousRecentStart = useMemo(
    () => (latestTime ? new Date(latestTime.getTime() - 120 * 60 * 1000) : null),
    [latestTime],
  );
  const previousDayStart = useMemo(
    () => (dayStart ? new Date(dayStart.getTime() - 24 * 60 * 60 * 1000) : null),
    [dayStart],
  );
  const previousDayEnd = useMemo(
    () => (latestTime ? new Date(latestTime.getTime() - 24 * 60 * 60 * 1000) : null),
    [latestTime],
  );
  const todayFleetSummary = useMemo(
    () => buildFleetPeriodSummary(injectionQuery.data, dayStart, latestTime),
    [dayStart, injectionQuery.data, latestTime],
  );
  const recentFleetSummary = useMemo(
    () => buildFleetPeriodSummary(injectionQuery.data, recentStart, latestTime),
    [injectionQuery.data, latestTime, recentStart],
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
    () => (latestTime ? new Date(latestTime.getTime() - 24 * 60 * 60 * 1000) : null),
    [latestTime],
  );
  const utilization24 = useMemo(
    () => buildFleetUtilizationSummary(injectionQuery.data, utilizationStart, latestTime),
    [injectionQuery.data, latestTime, utilizationStart],
  );
  const injectionPlanQty = useMemo(() => {
    const dailyTotal = planSummaryQuery.data?.injection.daily_totals.find((item) => item.date === planDate);
    if (dailyTotal) return dailyTotal.plan_qty;
    return planSummaryQuery.data?.injection.records.reduce((sum, record) => sum + Number(record.planned_quantity ?? 0), 0) ?? 0;
  }, [planDate, planSummaryQuery.data]);
  const transitionAnalysis = useMemo(
    () => buildInjectionTransitionAnalysis(
      planSummaryQuery.data,
      injectionQuery.data,
      planDate,
      undefined,
      [nextPlanSummaryQuery.data, secondNextPlanSummaryQuery.data].filter(
        (summary): summary is NonNullable<typeof summary> => Boolean(summary),
      ),
    ),
    [injectionQuery.data, nextPlanSummaryQuery.data, planDate, planSummaryQuery.data, secondNextPlanSummaryQuery.data],
  );
  const realtimeProgress = useMemo(
    () => buildRealtimeProgressSummary(planSummaryQuery.data, injectionQuery.data, productionStatusQuery.data, planDate, transitionAnalysis),
    [injectionQuery.data, planDate, planSummaryQuery.data, productionStatusQuery.data, transitionAnalysis],
  );
  const injectionReceiptComparison = useMemo(
    () => buildInjectionReceiptComparison(realtimeProgress, injectionReportStatsQuery.data),
    [injectionReportStatsQuery.data, realtimeProgress],
  );
  const todayProductionQty = realtimeProgress.estimatedQty;
  const todayProductionPlanQty = realtimeProgress.plannedQty || injectionPlanQty;
  const fleetProgressRate = todayProductionPlanQty > 0 ? (todayProductionQty / todayProductionPlanQty) * 100 : 0;
  const fleetProgressWidth = Math.max(0, Math.min(100, fleetProgressRate));
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
      buildMachineProductionWindow(injectionQuery.data, row.machineNumber, dayStart, latestTime),
    ]),
  ), [dayStart, injectionQuery.data, latestTime, machineRows]);
  const fleetProductionWindow = useMemo(
    () => buildFleetProductionWindow(injectionQuery.data, dayStart, latestTime),
    [dayStart, injectionQuery.data, latestTime],
  );
  const fleetElapsedUph = fleetProductionWindow.activeHours > 0
    ? fleetProductionWindow.output / fleetProductionWindow.activeHours
    : 0;
  const maxMachineShiftOutput = Math.max(1, ...machineRows.map((row) => row.shiftOutput));
  const todayPlanGap = todayProductionQty - todayProductionPlanQty;
  const utilizationTone =
    utilization24.rate === null ? "neutral" : utilization24.rate >= 70 ? "up" : utilization24.rate >= 40 ? "info" : "down";
  const recentOutputDelta = recentFleetSummary.output - previousRecentFleetSummary.output;
  const recentOilDelta =
    recentFleetSummary.oilTemperature !== null && previousRecentFleetSummary.oilTemperature !== null
      ? recentFleetSummary.oilTemperature - previousRecentFleetSummary.oilTemperature
      : null;
  const todayPowerDelta =
    todayFleetSummary.power !== null && previousDayFleetSummary.power !== null
      ? todayFleetSummary.power - previousDayFleetSummary.power
      : null;
  const isInitialMesLoading = selectedSource === "injection" && !injectionQuery.data && injectionQuery.isFetching;
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
            <span>{copy.injection}</span>
            <span>{copy.machining}</span>
            <span>{copy.inventory}</span>
          </div>
        </div>
        <div className="mes-hero-panel__control">
          <label className="mes-source-select">
            <span>{copy.selectHint}</span>
            <select
              value={selectedSource}
              onChange={(event) => setSelectedSource(event.target.value as MesDataSource)}
            >
              {sourceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {copy[option.labelKey]}
                </option>
              ))}
            </select>
          </label>
          <p>{selectedSourceDescription}</p>
        </div>
      </section>

      {selectedSource === "injection" ? (
        isInitialMesLoading ? (
          <MesMonitoringSkeleton copy={copy} />
        ) : (
        <>
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
              title={copy.todayOutput}
              value={`${formatNumber(todayProductionQty)} / ${formatNumber(todayProductionPlanQty)}`}
              delta={copy.planReady}
              deltaTone={todayPlanGap >= 0 ? "up" : "down"}
            />
            <SummaryMetricCard
              title={copy.recentOutput60}
              value={formatNumber(recentFleetSummary.output)}
              delta={`${copy.previous60} ${formatSignedNumber(recentOutputDelta)}`}
              deltaTone={recentOutputDelta > 0 ? "up" : recentOutputDelta < 0 ? "down" : "neutral"}
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
              <div className="mes-fleet-production-card__total">
                <span>{copy.fleetPlanProgress}</span>
                <strong>{formatPercent(fleetProgressRate)}</strong>
              </div>
            </div>

            <div className="mes-fleet-production-card__body">
              <div className="mes-fleet-production-card__progress">
                <div>
                  <strong>{formatNumber(todayProductionQty)} / {formatNumber(todayProductionPlanQty)}</strong>
                  <span className={todayPlanGap >= 0 ? "mes-fleet-production-card__gap mes-fleet-production-card__gap--up" : "mes-fleet-production-card__gap mes-fleet-production-card__gap--down"}>
                    {copy.fleetPlanGap} {formatSignedQty(todayPlanGap)}
                  </span>
                </div>
                <div className="mes-fleet-progress-bar" aria-label={copy.fleetPlanProgress}>
                  <span style={{ width: `${fleetProgressWidth}%` }} />
                </div>
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
                <em>{copy.lastUpdated}: {latestSlot ? formatDateTime(latestSlot.time, language) : copy.noData}</em>
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

          <section className="panel mes-monitor-panel mes-injection-receipt-panel">
            <div className="mes-monitor-panel__header">
              <div>
                <p className="panel-card__eyebrow">Injection ZS</p>
                <h3 className="panel__title">{copy.injectionReceiptTitle}</h3>
                <p className="mes-injection-receipt-panel__hint">{copy.injectionReceiptBody}</p>
              </div>
              <div className="mes-monitor-panel__actions">
                <span>
                  {copy.injectionReceiptLatest}:{" "}
                  {injectionReceiptComparison.summary.latestReportTime
                    ? formatDateTime(injectionReceiptComparison.summary.latestReportTime, language)
                    : copy.noData}
                </span>
              </div>
            </div>

            <div className="mes-injection-receipt-summary">
              <div>
                <span>{copy.injectionReceiptEstimated}</span>
                <strong>{formatNumber(injectionReceiptComparison.summary.estimatedQty)}</strong>
              </div>
              <div>
                <span>{copy.injectionReceiptReported}</span>
                <strong>{formatNumber(injectionReceiptComparison.summary.receiptQty)}</strong>
              </div>
              <div>
                <span>{copy.injectionReceiptGap}</span>
                <strong className={injectionReceiptComparison.summary.gapQty >= 0 ? "is-up" : "is-down"}>
                  {formatSignedQty(injectionReceiptComparison.summary.gapQty)}
                </strong>
              </div>
              <div>
                <span>{copy.injectionReceiptIssue}</span>
                <strong>{formatNumber(injectionReceiptComparison.summary.issueCount)}</strong>
              </div>
            </div>

            {injectionReportStatsQuery.isError ? (
              <div className="notice notice--warning">{copy.fetchError}</div>
            ) : injectionReportStatsQuery.isLoading && !injectionReportStatsQuery.data ? (
              <div className="notice notice--neutral">{copy.loadingData}</div>
            ) : injectionReceiptComparison.rows.length ? (
              <div className="mes-injection-receipt-table-wrap">
                <table className="mes-injection-receipt-table">
                  <thead>
                    <tr>
                      <th>{copy.injectionReceiptMachine}</th>
                      <th>{copy.injectionReceiptPartNo}</th>
                      <th>{copy.injectionReceiptModel}</th>
                      <th>{copy.injectionReceiptPlan}</th>
                      <th>{copy.injectionReceiptEstimated}</th>
                      <th>{copy.injectionReceiptReported}</th>
                      <th>{copy.injectionReceiptGap}</th>
                      <th>{copy.injectionReceiptStatus}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {injectionReceiptComparison.rows.map((row) => {
                      const progressRate = row.plannedQty > 0 ? Math.min(100, (row.estimatedQty / row.plannedQty) * 100) : 0;
                      const alternateReceiptPartNos = row.receiptPartNos.filter(
                        (partNo) => normalizeComparisonPartNo(partNo) !== normalizeComparisonPartNo(row.partNo),
                      );
                      return (
                        <tr key={row.key}>
                          <td>
                            <div className="mes-injection-receipt-machine">
                              <span>{row.machineLabel}</span>
                              <small>{language === "ko" ? `${row.machineKey}호기` : `${row.machineKey}号机`}</small>
                            </div>
                          </td>
                          <td>
                            <div className="mes-injection-receipt-part">
                              <span>{row.partNo}</span>
                              {alternateReceiptPartNos.length ? (
                                <small>
                                  {copy.injectionReceiptSourcePartNo} {alternateReceiptPartNos.join(", ")}
                                </small>
                              ) : null}
                            </div>
                          </td>
                          <td>{row.modelName || "-"}</td>
                          <td>{formatNumber(row.plannedQty)}</td>
                          <td>
                            <div className="mes-injection-receipt-progress">
                              <span>{formatNumber(row.estimatedQty)}</span>
                              <div>
                                <i style={{ width: `${progressRate}%` }} />
                              </div>
                              <small>{copy.outputQty} {formatNumber(row.allocatedShots)}</small>
                            </div>
                          </td>
                          <td>{formatNumber(row.receiptQty)}</td>
                          <td className={row.gapQty >= 0 ? "is-up" : "is-down"}>{formatSignedQty(row.gapQty)}</td>
                          <td>
                            <div className="mes-injection-receipt-status-cell">
                              <span className={`mes-injection-receipt-status mes-injection-receipt-status--${row.status}`}>
                                {injectionReceiptStatusLabel(row.status, copy)}
                              </span>
                              <small>{copy.machiningReports} {formatNumber(row.reportCount)}</small>
                              {row.matchMethods.length ? (
                                <small>
                                  {copy.injectionReceiptMatchBy}{" "}
                                  {row.matchMethods.map((method) => receiptMatchMethodLabel(method, copy)).join(", ")}
                                </small>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="notice notice--neutral">{copy.injectionReceiptEmpty}</div>
            )}
          </section>

          <section className="panel mes-monitor-panel">
            <div className="mes-monitor-panel__header">
              <div>
                <p className="panel-card__eyebrow">Injection</p>
                <h3 className="panel__title">{copy.injectionTitle}</h3>
              </div>
              <div className="mes-monitor-panel__actions">
                <span>
                  {copy.lastUpdated}:{" "}
                  {latestSlot ? formatDateTime(latestSlot.time, language) : copy.noData}
                </span>
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
              </div>
            </div>
            {isBackfillRunning && (
              <div className="mes-backfill-progress" aria-label={copy.backfillProgress}>
                <span style={{ width: `${Math.max(2, backfillPercent)}%` }} />
                <strong>{copy.backfillProgress} {backfillPercent}%</strong>
              </div>
            )}

            {injectionQuery.isError ? (
              <div className="notice notice--warning">{copy.fetchError}</div>
            ) : (
              <>
                <div className="mes-machine-rail__header">
                  <div>
                    <h4>{copy.machineRailTitle}</h4>
                    <p>{copy.machineRailHint}</p>
                  </div>
                  {selectedMachine && (
                    <strong>
                      {copy.selectedMachine}: {selectedMachine.name} · {formatTonnage(selectedMachine.tonnage)}
                    </strong>
                  )}
                </div>

                <div className="mes-machine-rail" aria-label={copy.machineRailTitle}>
                  {machineRows.map((row) => (
                    <button
                      key={row.machineNumber}
                      type="button"
                      className={`mes-machine-tile mes-machine-tile--${row.status} ${
                        selectedMachineKey === row.machineNumber ? "mes-machine-tile--active" : ""
                      }`}
                      onClick={() => setSelectedMachineNumber(row.machineNumber)}
                    >
                      <span className="mes-machine-tile__name">{row.machineNumber}</span>
                      <span className="mes-machine-tile__ton">{formatTonnage(row.tonnage)}</span>
                      <strong>{formatNumber(row.shiftOutput)}</strong>
                      <small>{formatTemperature(row.oilTemperature)}</small>
                    </button>
                  ))}
                </div>

                {selectedMachine && (
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
                            {selectedMachine.name} · {copy.trendTitle}
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

          <InjectionTransitionPanel
            analysis={transitionAnalysis}
            copy={copy}
            language={language}
          />
        </>
        )
      ) : selectedSource === "machining" ? (
        <>
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
              value={formatPercent(machiningStats?.summary.achievement_rate ?? 0)}
              delta={`${copy.machiningMatched} ${formatNumber(machiningStats?.summary.matched_rows ?? 0)}`}
              deltaTone="neutral"
            />
            <SummaryMetricCard
              title={copy.machiningGap}
              value={formatSignedQty(machiningStats?.summary.gap_qty ?? 0)}
              delta={copy.previousDay}
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
                <label className="mes-date-field">
                  <span>{copy.machiningDate}</span>
                  <input
                    type="date"
                    value={machiningDate}
                    onChange={(event) => setMachiningDate(event.target.value)}
                  />
                </label>
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
        </>
      ) : (
        <section className="panel mes-ready-panel">
          <p className="panel-card__eyebrow">{copy.readyStatus}</p>
          <h3 className="panel__title">
            {copy.inventoryTitle}
          </h3>
          <p>
            {copy.inventoryBody}
          </p>
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

            {isUtilizationAnalysisLoading ? (
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
                    <span>{copy.activeMachineCount}</span>
                    <strong>{formatNumber(selectedUtilizationSummary.activeMachines)}</strong>
                  </div>
                  <div>
                    <span>{copy.utilizationSavedAt}</span>
                    <strong>{latestTime ? formatDateTime(latestTime.toISOString(), language) : copy.noData}</strong>
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
