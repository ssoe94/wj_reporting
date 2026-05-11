import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type InjectionProductionMatrix,
  type MesDataSource,
  getInjectionProductionMatrix,
  requestInjectionSnapshotUpdate,
} from "@/domains/mes/api";
import { PageHeader } from "@/shared/components/PageHeader";
import { StatCard } from "@/shared/components/StatCard";
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
  recentOutput: number;
  status: "running" | "idle" | "warning";
};

type PeriodSummary = {
  output: number;
  power: number | null;
  oilTemperature: number | null;
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
    description: "MES에서 수집한 생산·설비 데이터를 저장하고, 계획 대비 모니터링 화면으로 확장합니다.",
    sourceLabel: "조회 대상",
    sourceTitle: "데이터 조회 범위",
    sourceDescription: "먼저 사출기의 형합수, 오일온도, 전력 사용량을 안정적으로 저장하고 모니터링합니다.",
    selectHint: "현재 선택",
    injection: "사출기 정보",
    machining: "가공 생산보고 정보",
    inventory: "재고 정보",
    refresh: "최신 데이터 수집·저장",
    refreshing: "수집 중",
    lastUpdated: "마지막 갱신",
    activeMachines: "가동 설비",
    latestOutput: "최근 60분 형합수",
    avgOil: "평균 오일온도",
    powerUsage: "최근 전력 사용량",
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
    description: "保存 MES 采集的生产与设备数据，并扩展为计划对比监控页面。",
    sourceLabel: "查询对象",
    sourceTitle: "数据查询范围",
    sourceDescription: "优先稳定保存并监控注塑机合模数、油温、电力使用量。",
    selectHint: "当前选择",
    injection: "注塑机信息",
    machining: "加工生产报告",
    inventory: "库存信息",
    refresh: "采集并保存最新数据",
    refreshing: "采集中",
    lastUpdated: "最后更新",
    activeMachines: "运行设备",
    latestOutput: "最近 60 分钟合模数",
    avgOil: "平均油温",
    powerUsage: "最近用电量",
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

function formatTonnage(value: string) {
  return value.endsWith("T") ? value : `${value}T`;
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
  const recentStartTime = latestTime ? new Date(latestTime.getTime() - 60 * 60 * 1000) : null;

  return data.machines.map((machine) => {
    const key = String(machine.machine_number);
    const latestOutput = numberAt(data.actual_production_matrix[key], latestIndex);
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
          return (
            <g key={section.key}>
              <rect
                className={`mes-combined-chart__shift mes-combined-chart__shift--${section.shift}`}
                x={startX}
                y={plotTop}
                width={Math.max(1, endX - startX)}
                height={plotBottom - plotTop}
              />
              <text className="mes-combined-chart__date" x={Math.min(width - 94, startX + 8)} y={plotTop + 12}>
                {section.dateLabel}
              </text>
              <text className="mes-combined-chart__shift-label" x={Math.min(width - 116, startX + 8)} y={plotTop + 25}>
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

export function MesMonitoringPage() {
  const [language] = useStoredLanguage();
  const [selectedSource, setSelectedSource] = useState<MesDataSource>("injection");
  const [selectedMachineNumber, setSelectedMachineNumber] = useState(1);
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mes", "injection-production-matrix"] });
    },
  });

  const machineRows = useMemo(() => buildRows(injectionQuery.data), [injectionQuery.data]);
  const latestSlot = injectionQuery.data?.time_slots.at(-1);
  const latestTime = getLatestTime(injectionQuery.data);
  const selectedMachine = machineRows.find((row) => row.machineNumber === selectedMachineNumber) ?? machineRows[0];
  const selectedMachineKey = selectedMachine?.machineNumber ?? selectedMachineNumber;
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
  const summary = useMemo(() => {
    const runningRows = machineRows.filter((row) => row.status === "running");
    const temperatureRows = machineRows.filter((row) => row.oilTemperature !== null);
    const totalOutput = machineRows.reduce((sum, row) => sum + row.recentOutput, 0);
    const totalPower = machineRows.reduce((sum, row) => sum + (row.powerUsage ?? 0), 0);
    const avgOil =
      temperatureRows.length > 0
        ? temperatureRows.reduce((sum, row) => sum + (row.oilTemperature ?? 0), 0) / temperatureRows.length
        : null;

    return {
      running: runningRows.length,
      total: machineRows.length,
      totalOutput,
      totalPower,
      avgOil,
    };
  }, [machineRows]);

  return (
    <section className="page mes-page">
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} description={copy.description} />

      <section className="panel mes-source-panel">
        <div>
          <p className="panel-card__eyebrow">{copy.sourceLabel}</p>
          <h3 className="panel__title">{copy.sourceTitle}</h3>
          <p className="mes-source-panel__description">{copy.sourceDescription}</p>
        </div>
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
      </section>

      {selectedSource === "injection" ? (
        <>
          <div className="stats-grid">
            <StatCard title={copy.activeMachines} value={`${summary.running}/${summary.total}`} hint={copy.savedByBackend} />
            <StatCard title={copy.latestOutput} value={formatNumber(summary.totalOutput)} hint={copy.output} />
            <StatCard title={copy.avgOil} value={formatTemperature(summary.avgOil)} hint={copy.oil} />
            <StatCard title={copy.powerUsage} value={`${formatDecimal(summary.totalPower, 2)} kWh`} hint={copy.power} />
          </div>

          <section className="panel mes-monitor-panel">
            <div className="mes-monitor-panel__header">
              <div>
                <p className="panel-card__eyebrow">Injection</p>
                <h3 className="panel__title">{copy.injectionTitle}</h3>
                <p className="plan-dashboard__meta">{copy.injectionHint}</p>
              </div>
              <div className="mes-monitor-panel__actions">
                <span>
                  {copy.lastUpdated}:{" "}
                  {latestSlot ? formatDateTime(latestSlot.time, language) : copy.noData}
                </span>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={updateMutation.isPending}
                  onClick={() => updateMutation.mutate()}
                >
                  {updateMutation.isPending ? copy.refreshing : copy.refresh}
                </button>
              </div>
            </div>

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
                      <strong>{formatNumber(row.recentOutput)}</strong>
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
                          <span>{copy.cumulative}</span>
                          <strong>{formatNumber(selectedMachine.cumulativeOutput)}</strong>
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
    </section>
  );
}
