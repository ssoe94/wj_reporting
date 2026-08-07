import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Clock3,
  Factory,
  Gauge,
  Maximize2,
  Minimize2,
  RefreshCw,
  Zap,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  getInjectionEnergyMatrix,
  getInjectionMonitoringDates,
  type InjectionProductionMatrix,
} from "@/domains/mes/api";
import { type AppLanguage, useStoredLanguage } from "@/shared/i18n/language";
import { addIsoDateDays, getShanghaiBusinessDateString } from "@/shared/utils/date";
import styles from "./EnergyBoardPage.module.css";

const REFRESH_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 10 * 60_000;
const HISTORY_HOURS = 193;
const HOUR_MS = 60 * 60 * 1000;

const COPY = {
  ko: {
    eyebrow: "INJECTION ENERGY BOARD",
    title: "사출 전력 사용 현황판",
    subtitle: "17대 사출기의 누적 전력계 차이를 기준으로 사용량과 생산 효율을 집계합니다.",
    businessDate: "생산 기준일",
    dataTime: "MES 최신",
    refreshCycle: "1분 자동 갱신",
    back: "현황판 목록",
    refresh: "새로고침",
    fullscreen: "전체 화면",
    exitFullscreen: "전체 화면 종료",
    totalUsage: "금일 누적 사용량",
    previousCompare: "전일 동시간 대비",
    sevenDayCompare: "최근 7일 평균 대비",
    peakHour: "최대 사용 시간대",
    efficiency: "1,000 Shot당 전력",
    measuredMachines: "전력 계측 설비",
    current: "오늘",
    previous: "전일",
    sevenDayAverage: "7일 평균",
    sameElapsed: "동일 경과시간 기준",
    hourlyTitle: "시간대별 전체 전력 사용량",
    hourlySubtitle: "08:00부터 다음 날 08:00까지 · 단위 kWh",
    shiftTitle: "주간조·야간조 비교",
    shiftSubtitle: "주간 08:00~20:00 · 야간 20:00~08:00",
    dayShift: "주간조",
    nightShift: "야간조",
    machineTitle: "설비별 전력 사용량",
    machineSubtitle: "금일 사용량 순위 · Shot 효율 함께 표시",
    heatmapTitle: "설비 × 시간대 전력 히트맵",
    heatmapSubtitle: "진한 셀일수록 같은 기준일 내 사용량이 큽니다.",
    machine: "호기",
    shots: "Shot",
    noEfficiency: "생산 없음",
    noData: "전력 데이터가 없습니다.",
    loading: "전력 사용량을 불러오는 중입니다.",
    error: "전력 현황 데이터를 불러오지 못했습니다. 잠시 후 자동으로 다시 시도합니다.",
    stale: "MES 데이터가 10분 이상 갱신되지 않았습니다.",
    partial: "진행 중",
  },
  zh: {
    eyebrow: "INJECTION ENERGY BOARD",
    title: "注塑用电现状看板",
    subtitle: "根据17台注塑机累计电表的差值，统计用电量与生产能效。",
    businessDate: "生产基准日",
    dataTime: "MES最新",
    refreshCycle: "每分钟自动刷新",
    back: "返回看板中心",
    refresh: "刷新",
    fullscreen: "全屏",
    exitFullscreen: "退出全屏",
    totalUsage: "今日累计用电量",
    previousCompare: "与前日同时段比较",
    sevenDayCompare: "与近7日平均比较",
    peakHour: "最高用电时段",
    efficiency: "每1,000模次用电",
    measuredMachines: "电力计量设备",
    current: "今日",
    previous: "前日",
    sevenDayAverage: "7日平均",
    sameElapsed: "按相同经过时间",
    hourlyTitle: "分时段总用电量",
    hourlySubtitle: "08:00至次日08:00 · 单位 kWh",
    shiftTitle: "白班·夜班比较",
    shiftSubtitle: "白班 08:00~20:00 · 夜班 20:00~08:00",
    dayShift: "白班",
    nightShift: "夜班",
    machineTitle: "设备用电量",
    machineSubtitle: "今日用电排名 · 同时显示模次能效",
    heatmapTitle: "设备 × 时段用电热力图",
    heatmapSubtitle: "颜色越深，表示该基准日内用电量越高。",
    machine: "号机",
    shots: "模次",
    noEfficiency: "无生产",
    noData: "暂无电力数据。",
    loading: "正在读取用电量。",
    error: "无法读取用电看板数据，稍后将自动重试。",
    stale: "MES数据已超过10分钟未更新。",
    partial: "进行中",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

type HourPoint = {
  hourIndex: number;
  label: string;
  current: number | null;
  previous: number;
};

type MachineEnergyRow = {
  machineNumber: number;
  label: string;
  usage: number;
  shots: number;
  efficiency: number | null;
  hourly: Array<number | null>;
};

function formatPower(value: number | null, maximumFractionDigits = 1) {
  if (value === null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function formatDateTime(value: string | null, language: AppLanguage) {
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

function businessStartMs(businessDate: string) {
  return new Date(`${businessDate}T08:00:00+08:00`).getTime();
}

function matrixRow(
  data: InjectionProductionMatrix,
  matrix: Record<string, number[]> | undefined,
  machineNumber: number,
) {
  if (!matrix) return [];
  const machine = data.machines.find((item) => item.machine_number === machineNumber);
  const keys = [String(machineNumber), machine?.machine_name, machine?.display_name, `${machineNumber}호기`];
  for (const key of keys) {
    if (key && matrix[key]) return matrix[key];
  }
  return [];
}

function safeValue(row: number[], index: number) {
  const value = Number(row[index]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function percentDelta(current: number, baseline: number) {
  return baseline > 0 ? ((current - baseline) / baseline) * 100 : null;
}

function hourLabel(index: number) {
  const hour = (8 + index) % 24;
  return `${String(hour).padStart(2, "0")}:00`;
}

function buildEnergyModel(data: InjectionProductionMatrix, businessDate: string) {
  const slotIndexByTime = new Map<number, number>();
  data.time_slots.forEach((slot, index) => {
    const time = new Date(slot.time).getTime();
    if (Number.isFinite(time)) slotIndexByTime.set(time, index);
  });

  const startMs = businessStartMs(businessDate);
  const latestSlotMs = Math.max(...slotIndexByTime.keys(), startMs);
  const elapsedHours = Math.max(0, Math.min(24, Math.floor((latestSlotMs - startMs) / HOUR_MS)));
  const machineNumbers = data.machines.map((machine) => machine.machine_number);

  const usageAt = (machineNumber: number, endMs: number) => {
    const slotIndex = slotIndexByTime.get(endMs);
    if (slotIndex === undefined) return 0;
    return safeValue(matrixRow(data, data.power_usage_matrix, machineNumber), slotIndex);
  };
  const shotsAt = (machineNumber: number, endMs: number) => {
    const slotIndex = slotIndexByTime.get(endMs);
    if (slotIndex === undefined) return 0;
    return safeValue(matrixRow(data, data.actual_production_matrix, machineNumber), slotIndex);
  };

  const dayHours = (date: string) => {
    const dayStart = businessStartMs(date);
    return Array.from({ length: 24 }, (_, index) => {
      const endMs = dayStart + (index + 1) * HOUR_MS;
      return machineNumbers.reduce((total, machineNumber) => total + usageAt(machineNumber, endMs), 0);
    });
  };

  const currentHours = dayHours(businessDate);
  const previousDate = addIsoDateDays(businessDate, -1);
  const previousHours = dayHours(previousDate);
  const completedHours = Math.min(24, elapsedHours);
  const currentTotal = currentHours.slice(0, completedHours).reduce((sum, value) => sum + value, 0);
  const previousSameElapsed = previousHours.slice(0, completedHours).reduce((sum, value) => sum + value, 0);
  const sevenDaySameElapsed = Array.from({ length: 7 }, (_, offset) => {
    const date = addIsoDateDays(businessDate, -(offset + 1));
    return dayHours(date).slice(0, completedHours).reduce((sum, value) => sum + value, 0);
  });
  const validSevenDayTotals = sevenDaySameElapsed.filter((value) => value > 0);
  const sevenDayAverage = validSevenDayTotals.length > 0
    ? validSevenDayTotals.reduce((sum, value) => sum + value, 0) / validSevenDayTotals.length
    : 0;

  const hourly: HourPoint[] = currentHours.map((value, index) => ({
    hourIndex: index,
    label: hourLabel(index),
    current: index < completedHours ? value : null,
    previous: previousHours[index],
  }));
  const visibleCurrent = hourly.filter((point) => point.current !== null);
  const peak = visibleCurrent.reduce<HourPoint | null>((selected, point) => (
    !selected || Number(point.current) > Number(selected.current) ? point : selected
  ), null);

  const machineRows: MachineEnergyRow[] = data.machines.map((machine) => {
    const hourlyValues = Array.from({ length: 24 }, (_, index) => {
      if (index >= completedHours) return null;
      const endMs = startMs + (index + 1) * HOUR_MS;
      return usageAt(machine.machine_number, endMs);
    });
    const usage = hourlyValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const shots = Array.from({ length: completedHours }, (_, index) => (
      shotsAt(machine.machine_number, startMs + (index + 1) * HOUR_MS)
    )).reduce((sum, value) => sum + value, 0);
    return {
      machineNumber: machine.machine_number,
      label: machine.display_name || `${machine.machine_number}호기`,
      usage,
      shots,
      efficiency: shots > 0 ? (usage / shots) * 1000 : null,
      hourly: hourlyValues,
    };
  }).sort((a, b) => b.usage - a.usage || a.machineNumber - b.machineNumber);

  const totalShots = machineRows.reduce((sum, row) => sum + row.shots, 0);
  const meteredMachines = data.machines.filter((machine) => (
    matrixRow(data, data.power_kwh_matrix, machine.machine_number).some((value) => Number(value) > 0)
  )).length;
  const heatMax = Math.max(1, ...machineRows.flatMap((row) => row.hourly.map((value) => value ?? 0)));

  return {
    hourly,
    machineRows,
    currentTotal,
    previousSameElapsed,
    sevenDayAverage,
    previousDelta: percentDelta(currentTotal, previousSameElapsed),
    sevenDayDelta: percentDelta(currentTotal, sevenDayAverage),
    peak,
    totalShots,
    efficiency: totalShots > 0 ? (currentTotal / totalShots) * 1000 : null,
    meteredMachines,
    heatMax,
    currentDayShift: currentHours.slice(0, Math.min(12, completedHours)).reduce((sum, value) => sum + value, 0),
    currentNightShift: currentHours.slice(12, completedHours).reduce((sum, value) => sum + value, 0),
    previousDayShift: previousHours.slice(0, Math.min(12, completedHours)).reduce((sum, value) => sum + value, 0),
    previousNightShift: previousHours.slice(12, completedHours).reduce((sum, value) => sum + value, 0),
    completedHours,
  };
}

export function EnergyBoardPage() {
  const [language, setLanguage] = useStoredLanguage();
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));
  const copy = COPY[language];
  const businessDate = getShanghaiBusinessDateString();

  const energyQuery = useQuery({
    queryKey: ["mes", "energy-board", HISTORY_HOURS],
    queryFn: () => getInjectionEnergyMatrix(HISTORY_HOURS),
    refetchInterval: REFRESH_INTERVAL_MS,
    retry: 2,
  });
  const freshnessQuery = useQuery({
    queryKey: ["mes", "energy-board-freshness"],
    queryFn: getInjectionMonitoringDates,
    refetchInterval: REFRESH_INTERVAL_MS,
    retry: 2,
  });
  const model = useMemo(
    () => energyQuery.data ? buildEnergyModel(energyQuery.data, businessDate) : null,
    [businessDate, energyQuery.data],
  );
  const latestTimestamp = freshnessQuery.data?.latest_timestamp ?? null;
  const isStale = latestTimestamp
    ? Date.now() - new Date(latestTimestamp).getTime() > STALE_THRESHOLD_MS
    : false;
  const maxMachineUsage = Math.max(1, ...(model?.machineRows.map((row) => row.usage) ?? [1]));

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    setIsFullscreen(Boolean(document.fullscreenElement));
  };

  return (
    <main className={styles.board} data-testid="energy-board-page">
      <header className={styles.topbar}>
        <div className={styles.heading}>
          <span className={styles.logo}><Zap aria-hidden="true" /></span>
          <div>
            <p>{copy.eyebrow}</p>
            <h1>{copy.title}</h1>
            <span>{copy.subtitle}</span>
          </div>
        </div>
        <div className={styles.meta}>
          <div><span>{copy.businessDate}</span><strong>{businessDate}</strong></div>
          <div><span>{copy.dataTime}</span><strong>{formatDateTime(latestTimestamp, language)}</strong></div>
          <em>{copy.refreshCycle}</em>
          <div className={styles.language} aria-label="Language">
            <button className={language === "ko" ? styles.activeLanguage : ""} onClick={() => setLanguage("ko")} type="button">KOR</button>
            <button className={language === "zh" ? styles.activeLanguage : ""} onClick={() => setLanguage("zh")} type="button">中文</button>
          </div>
          <button aria-label={copy.back} className={styles.action} onClick={() => window.location.assign("/boards")} title={copy.back} type="button"><ArrowLeft /></button>
          <button aria-label={copy.refresh} className={styles.action} onClick={() => void energyQuery.refetch()} title={copy.refresh} type="button"><RefreshCw className={energyQuery.isFetching ? styles.spinning : ""} /></button>
          <button aria-label={isFullscreen ? copy.exitFullscreen : copy.fullscreen} className={styles.action} onClick={() => void toggleFullscreen()} title={isFullscreen ? copy.exitFullscreen : copy.fullscreen} type="button">
            {isFullscreen ? <Minimize2 /> : <Maximize2 />}
          </button>
        </div>
      </header>

      <section className={styles.workspace}>
        {isStale ? <div className={styles.stale}>{copy.stale}</div> : null}
        {energyQuery.isError ? <div className={styles.error}>{copy.error}</div> : null}

        {!model && energyQuery.isLoading ? <div className={styles.loading}>{copy.loading}</div> : null}
        {model ? (
          <div className={styles.dashboardContent}>
          <section className={styles.kpis}>
            <article className={styles.primaryKpi}>
              <span><Zap aria-hidden="true" />{copy.totalUsage}</span>
              <strong>{formatPower(model.currentTotal)} <small>kWh</small></strong>
              <em>{model.completedHours}/24h · {copy.partial}</em>
            </article>
            <article>
              <span>{copy.previousCompare}</span>
              <strong className={model.previousDelta !== null && model.previousDelta > 0 ? styles.rising : ""}>{formatPercent(model.previousDelta)}</strong>
              <em>{copy.previous} {formatPower(model.previousSameElapsed)} kWh</em>
            </article>
            <article>
              <span>{copy.sevenDayCompare}</span>
              <strong className={model.sevenDayDelta !== null && model.sevenDayDelta > 0 ? styles.rising : ""}>{formatPercent(model.sevenDayDelta)}</strong>
              <em>{copy.sevenDayAverage} {formatPower(model.sevenDayAverage)} kWh</em>
            </article>
            <article>
              <span><Clock3 aria-hidden="true" />{copy.peakHour}</span>
              <strong>{model.peak ? model.peak.label : "-"}</strong>
              <em>{formatPower(model.peak?.current ?? null)} kWh</em>
            </article>
            <article>
              <span><Gauge aria-hidden="true" />{copy.efficiency}</span>
              <strong>{formatPower(model.efficiency, 2)}</strong>
              <em>{formatInteger(model.totalShots)} {copy.shots}</em>
            </article>
            <article>
              <span><Factory aria-hidden="true" />{copy.measuredMachines}</span>
              <strong>{model.meteredMachines}<small>/17</small></strong>
              <em>{copy.sameElapsed}</em>
            </article>
          </section>

          <section className={styles.mainGrid}>
            <article className={`${styles.panel} ${styles.hourlyPanel}`}>
              <header><div><h2>{copy.hourlyTitle}</h2><p>{copy.hourlySubtitle}</p></div></header>
              <div className={styles.chart}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={model.hourly} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#dce7ee" strokeDasharray="3 5" vertical={false} />
                    <XAxis dataKey="label" interval={2} tick={{ fill: "#6d8292", fontSize: "clamp(11px, 0.45vw, 17px)" }} tickLine={false} axisLine={{ stroke: "#bdcdd7" }} />
                    <YAxis tick={{ fill: "#6d8292", fontSize: "clamp(11px, 0.45vw, 17px)" }} tickLine={false} axisLine={false} width={48} />
                    <Tooltip formatter={(value) => `${formatPower(Number(value))} kWh`} labelFormatter={(label) => `${label} ~`} />
                    <Legend wrapperStyle={{ fontSize: "clamp(12px, 0.5vw, 18px)" }} />
                    <Bar dataKey="current" fill="#176f9f" name={copy.current} radius={[5, 5, 0, 0]} maxBarSize={30} />
                    <Line dataKey="previous" dot={false} name={copy.previous} stroke="#d18a24" strokeDasharray="6 5" strokeWidth={2.5} type="monotone" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className={`${styles.panel} ${styles.shiftPanel}`}>
              <header><div><h2>{copy.shiftTitle}</h2><p>{copy.shiftSubtitle}</p></div></header>
              {[
                { label: copy.dayShift, current: model.currentDayShift, previous: model.previousDayShift },
                { label: copy.nightShift, current: model.currentNightShift, previous: model.previousNightShift },
              ].map((shift) => {
                const max = Math.max(1, shift.current, shift.previous);
                return (
                  <div className={styles.shiftRow} key={shift.label}>
                    <strong>{shift.label}</strong>
                    <div className={styles.shiftBars}>
                      <span><i style={{ width: `${(shift.current / max) * 100}%` }} />{copy.current}<b>{formatPower(shift.current)} kWh</b></span>
                      <span><i className={styles.previousBar} style={{ width: `${(shift.previous / max) * 100}%` }} />{copy.previous}<b>{formatPower(shift.previous)} kWh</b></span>
                    </div>
                  </div>
                );
              })}
              <footer>{copy.sameElapsed}</footer>
            </article>

            <article className={`${styles.panel} ${styles.machinePanel}`}>
              <header><div><h2>{copy.machineTitle}</h2><p>{copy.machineSubtitle}</p></div></header>
              <div className={styles.machineRanking}>
                {model.machineRows.map((row, index) => (
                  <div className={styles.machineRow} key={row.machineNumber}>
                    <span className={styles.rank}>{index + 1}</span>
                    <strong>{row.machineNumber}{copy.machine}</strong>
                    <div className={styles.machineBar}><i style={{ width: `${(row.usage / maxMachineUsage) * 100}%` }} /></div>
                    <b>{formatPower(row.usage)} kWh</b>
                    <small>{row.efficiency === null ? copy.noEfficiency : `${formatPower(row.efficiency, 2)} kWh/1k`}</small>
                  </div>
                ))}
              </div>
            </article>

            <article className={`${styles.panel} ${styles.heatmapPanel}`}>
              <header><div><h2>{copy.heatmapTitle}</h2><p>{copy.heatmapSubtitle}</p></div></header>
              <div className={styles.heatmapScroll}>
                <div className={styles.heatmap}>
                  <div />
                  {Array.from({ length: 24 }, (_, index) => <span className={styles.hourLabel} key={index}>{index % 2 === 0 ? hourLabel(index).slice(0, 2) : ""}</span>)}
                  {[...model.machineRows].sort((a, b) => a.machineNumber - b.machineNumber).map((row) => (
                    <div className={styles.heatmapRow} key={row.machineNumber}>
                      <strong>{row.machineNumber}</strong>
                      {row.hourly.map((value, index) => {
                        const intensity = value === null ? 0 : Math.min(1, value / model.heatMax);
                        return (
                          <span
                            className={value === null ? styles.futureCell : styles.heatCell}
                            key={index}
                            style={value === null ? undefined : { backgroundColor: `rgba(20, 111, 159, ${0.08 + intensity * 0.82})` }}
                            title={`${row.machineNumber}${copy.machine} · ${hourLabel(index)} · ${formatPower(value)} kWh`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </article>
          </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}
