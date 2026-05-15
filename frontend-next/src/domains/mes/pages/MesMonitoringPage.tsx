import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type InjectionProductionMatrix,
  type MesDataSource,
  getInjectionSnapshotUpdateStatus,
  getInjectionProductionMatrix,
  getInjectionUtilizationMatrix,
  requestInjectionSnapshotUpdate,
} from "@/domains/mes/api";
import { getProductionPlanSummary, getProductionStatus } from "@/domains/production/api";
import { buildRealtimeProgressSummary } from "@/domains/production/realtime-progress";
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
    machiningTitle: "가공 생산보고 모니터링",
    machiningBody: "추후 MES 완료 보고를 연결해 계획 수량 대비 완료 수량, 지연 공정, 미보고 항목을 보여줄 예정입니다.",
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
    machiningTitle: "加工生产报告监控",
    machiningBody: "后续连接 MES 完成报告，显示计划数量对比完成数量、延迟工序和未报告项目。",
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

  const key = String(machineNumber);
  let output = 0;
  let power = 0;
  let oilTotal = 0;
  let oilCount = 0;
  let hasPower = false;

  data.time_slots.forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    if (slotTime <= startTime || slotTime > endTime) return;

    output += numberAt(data.actual_production_matrix[key], index);

    const powerValue = nullableNumberAt(data.power_usage_matrix?.[key], index);
    if (powerValue !== null) {
      power += powerValue;
      hasPower = true;
    }

    const oilValue = nullableNumberAt(data.oil_temperature_matrix[key], index);
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
  const key = String(machineNumber);
  const productionRow = data.actual_production_matrix[key] ?? [];
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

function CombinedTrendChart({
  points,
  labels,
  language,
}: {
  points: HourlyTrendPoint[];
  labels: { output: string; power: string; oil: string };
  language: AppLanguage;
}) {
  const [hoveredPoint, setHoveredPoint] = useState<{ point: HourlyTrendPoint; index: number } | null>(null);
  const width = 720;
  const height = 210;
  const plotTop = 14;
  const plotBottom = 166;
  const xGap = width / Math.max(1, points.length - 1);
  const outputMax = maxTrendValue(points, "output");
  const powerMax = maxTrendValue(points, "power");
  const oilMax = Math.max(50, maxTrendValue(points, "oilTemperature"));
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
    <div className="mes-combined-chart-stage" onMouseLeave={() => setHoveredPoint(null)}>
      <svg className="mes-combined-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-hidden="true">
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
  const planDate = latestTime ? formatDateParam(latestTime) : formatDateParam(new Date());
  const planSummaryQuery = useQuery({
    queryKey: ["production-plan-summary", planDate],
    queryFn: () => getProductionPlanSummary(planDate),
    enabled: selectedSource === "injection" && Boolean(planDate),
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
  const realtimeProgress = useMemo(
    () => buildRealtimeProgressSummary(planSummaryQuery.data, injectionQuery.data, productionStatusQuery.data),
    [injectionQuery.data, planSummaryQuery.data, productionStatusQuery.data],
  );
  const todayProductionQty = realtimeProgress.estimatedQty;
  const todayProductionPlanQty = realtimeProgress.plannedQty || injectionPlanQty;
  const summary = useMemo(() => {
    const runningRows = machineRows.filter((row) => row.status === "running");

    return {
      running: runningRows.length,
      total: machineRows.length,
    };
  }, [machineRows]);
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
        </>
        )
      ) : (
        <section className="panel mes-ready-panel">
          <p className="panel-card__eyebrow">{copy.readyStatus}</p>
          <h3 className="panel__title">
            {selectedSource === "machining" ? copy.machiningTitle : copy.inventoryTitle}
          </h3>
          <p>
            {selectedSource === "machining" ? copy.machiningBody : copy.inventoryBody}
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
