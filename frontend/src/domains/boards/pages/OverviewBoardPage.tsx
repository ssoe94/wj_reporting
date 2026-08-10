import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Clock3,
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSun,
  Droplets,
  Factory,
  Gauge,
  GitCompareArrows,
  MapPin,
  PackageCheck,
  PackageOpen,
  Radio,
  ShieldCheck,
  Signal,
  Snowflake,
  Sun,
  TimerReset,
  TrendingDown,
  Workflow,
  Wind,
  Wrench,
  Zap,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import assemblyConveyorIcon from "@/assets/overview-assembly-conveyor-icon.png";
import injectionProcessIcon from "@/assets/overview-injection-process-icon.png";
import { getOverviewBoard } from "@/domains/boards/overview/api";
import type {
  AttentionItem,
  InjectionEquipmentRow,
  OverviewBoardModel,
  ProductionProcess,
  QualityAttentionItem,
} from "@/domains/boards/overview/types";
import { useStoredLanguage, type AppLanguage } from "@/shared/i18n/language";
import { getShanghaiBusinessDateString } from "@/shared/utils/date";
import styles from "./OverviewBoardPage.module.css";

const QUALITY_PAGE_SIZE = 3;
const QUALITY_ROTATION_MS = 12_000;
const MACHINE_PAGE_SIZE = 3;
const MACHINE_ROTATION_MS = 10_000;

const COPY = {
  ko: {
    title: "WJ 통합 운영 센터",
    titleToggle: "중국어로 전환",
    languageChanged: "언어가 한국어에서 중국어로 변경되었습니다.",
    nanjingWeather: "난징",
    weatherClear: "맑음",
    weatherPartlyCloudy: "구름 조금",
    weatherCloudy: "흐림",
    weatherFog: "안개",
    weatherRain: "비",
    weatherHeavyRain: "강한 비",
    weatherSnow: "눈",
    weatherThunder: "뇌우",
    weatherUnknown: "날씨 미수신",
    humidity: "습도",
    wind: "바람",
    weatherStale: "업데이트 지연",
    generatedAt: "기준",
    injectionProduction: "사출 생산",
    assemblyProduction: "조립 생산",
    plan: "계획",
    actual: "실적",
    completion: "완료율",
    timeProgress: "시간 진행률",
    finishForecast: "종료 전망",
    paceGap: "시간 대비",
    expectedNow: "현재 시간 목표",
    quantityGap: "목표 수량 차이",
    remaining: "잔여 수량",
    requiredPerHour: "남은 시간 필요 생산",
    mesConfirmed: "MES 확정",
    manualOpen: "수기 대사 대기",
    manualShare: "실적 중 {value}%",
    lineCount: "계획 항목",
    ahead: "앞섬",
    onTrack: "계획 범위",
    behind: "지연",
    noPlan: "계획 없음",
    equipment: "사출 설비 생산 현황",
    equipmentRotationHint: "설비별 현재 생산 · 10초 롤링",
    machineRunning: "생산 중",
    machineStopped: "정지",
    machineWaiting: "생산 대기",
    machineCompleted: "계획 완료",
    machineUnplanned: "무계획 가동",
    machineSourceStale: "신호 지연",
    currentProduct: "생산 모델",
    productUnconfirmed: "생산 모델 미확인",
    planActual: "실적 / 계획",
    recentShots: "60분 Shot",
    completionLegend: "완료",
    timeLegend: "시간",
    previousMachinePage: "이전 사출 설비",
    nextMachinePage: "다음 사출 설비",
    pauseMachineRotation: "사출 설비 자동 전환 일시정지",
    resumeMachineRotation: "사출 설비 자동 전환 재생",
    machineRotationPaused: "전환 일시정지",
    machineReducedMotion: "수동 전환",
    machineNextIn: "10초 후 다음",
    machineCount: "전체 {count}대",
    injection: "사출",
    assembly: "조립",
    runningMachines: "가동 감지",
    behindMachines: "진도 지연",
    unplannedActive: "무계획 가동",
    operations: "종합 운영 현황",
    priorityCount: "우선 확인",
    attention: "주의",
    normal: "정상",
    disconnected: "미연결",
    operatingStatus: "운영상태",
    checks: "확인",
    qualityHistoryCount: "품질 이력",
    noAttentionData: "현재 우선 확인 항목이 없습니다.",
    injectionPace: "사출 진도",
    assemblyPace: "조립 진도",
    quality: "생산 모델 · 품질 이력",
    exactPartMatch: "품번 정확 일치",
    historicalDisclaimer: "현재 불량 발생을 의미하지 않습니다",
    noQualityData: "현재 생산 품번과 일치하는 최근 품질 이력이 없습니다.",
    recentReports: "최근 {days}일 {count}건",
    previousQualityPage: "이전 품질 이력",
    nextQualityPage: "다음 품질 이력",
    pauseRotation: "품질 이력 자동 전환 일시정지",
    resumeRotation: "품질 이력 자동 전환 재생",
    rotationPaused: "전환 일시정지",
    reducedMotion: "수동 전환",
    nextIn: "12초 후 다음",
    inventory: "재고 · 창고",
    finishedAndSemifinished: "완제품 · 반제품",
    warehouseComposition: "창고 구성",
    finishedWarehouse: "완제품",
    semifinishedWarehouse: "반제품",
    inventoryCarts: "재고 카트",
    shippingNetChange: "완제품 창고 순변동",
    inbound: "입고",
    outbound: "출고",
    cartUnit: "대",
    recordUnit: "건",
    energy: "에너지",
    energyTrendTitle: "시간대별 사용량 · 이동평균",
    energyTrendSubtitle: "최근 완료 24시간 · kWh",
    todayCumulativeEnergy: "금일 누적",
    energyPer1000Shots: "1,000 Shot당",
    todayShots: "금일 Shot",
    efficiencyCoverage: "효율 계산",
    hourlyEnergy: "시간대",
    movingAverage8h: "8h 평균",
    movingAverage12h: "12h 평균",
    movingAverage24h: "24h 평균",
    meteredMachines: "계측 설비",
    noEnergyTrend: "시간대별 전력 데이터 없음",
    moulds: "금형 · 보전",
    managedMoulds: "금형 관리 수",
    mountedMoulds: "장착 금형",
    storedMoulds: "보관",
    maintenanceMoulds: "보전",
    repairMoulds: "수리",
    offsiteMoulds: "외부",
    mouldStatusMix: "금형 상태 구성",
    confirmationRequired: "확인 필요",
    locationConflict: "위치 충돌",
    dataUnavailable: "통합 현황 데이터를 불러올 수 없습니다.",
    retry: "다시 불러오기",
    loading: "통합 현황 데이터를 불러오는 중입니다.",
    demo: "DEMO",
    sourceFreshness: "데이터 최신성",
    staleSources: "지연 {count}",
    unavailableSources: "미수신 {count}",
  },
  zh: {
    title: "WJ 综合运营中心",
    titleToggle: "切换为韩语",
    languageChanged: "语言已从中文切换为韩语。",
    nanjingWeather: "南京",
    weatherClear: "晴",
    weatherPartlyCloudy: "多云间晴",
    weatherCloudy: "阴",
    weatherFog: "雾",
    weatherRain: "雨",
    weatherHeavyRain: "大雨",
    weatherSnow: "雪",
    weatherThunder: "雷雨",
    weatherUnknown: "天气未接收",
    humidity: "湿度",
    wind: "风速",
    weatherStale: "更新延迟",
    generatedAt: "基准",
    injectionProduction: "注塑生产",
    assemblyProduction: "组装生产",
    plan: "计划",
    actual: "实绩",
    completion: "完成率",
    timeProgress: "时间进度",
    finishForecast: "完工预测",
    paceGap: "较时间进度",
    expectedNow: "当前时间目标",
    quantityGap: "目标数量差异",
    remaining: "剩余数量",
    requiredPerHour: "剩余时间每小时需产",
    mesConfirmed: "MES 已确认",
    manualOpen: "手工待对账",
    manualShare: "占实绩 {value}%",
    lineCount: "计划项目",
    ahead: "领先",
    onTrack: "计划范围",
    behind: "滞后",
    noPlan: "无计划",
    equipment: "注塑设备生产现状",
    equipmentRotationHint: "各设备当前生产 · 10秒轮播",
    machineRunning: "生产中",
    machineStopped: "停机",
    machineWaiting: "等待生产",
    machineCompleted: "计划完成",
    machineUnplanned: "无计划运行",
    machineSourceStale: "信号延迟",
    currentProduct: "生产型号",
    productUnconfirmed: "生产型号未确认",
    planActual: "实绩 / 计划",
    recentShots: "60分钟 Shot",
    completionLegend: "完成",
    timeLegend: "时间",
    previousMachinePage: "上一页注塑设备",
    nextMachinePage: "下一页注塑设备",
    pauseMachineRotation: "暂停注塑设备自动切换",
    resumeMachineRotation: "继续注塑设备自动切换",
    machineRotationPaused: "切换已暂停",
    machineReducedMotion: "手动切换",
    machineNextIn: "10秒后切换",
    machineCount: "共 {count} 台",
    injection: "注塑",
    assembly: "组装",
    runningMachines: "检测运行",
    behindMachines: "进度滞后",
    unplannedActive: "无计划运行",
    operations: "综合运营现状",
    priorityCount: "优先确认",
    attention: "注意",
    normal: "正常",
    disconnected: "未连接",
    operatingStatus: "运营状态",
    checks: "待确认",
    qualityHistoryCount: "品质记录",
    noAttentionData: "当前没有优先确认项目。",
    injectionPace: "注塑进度",
    assemblyPace: "组装进度",
    quality: "生产型号 · 品质记录",
    exactPartMatch: "零件号精确匹配",
    historicalDisclaimer: "不代表当前正在发生不良",
    noQualityData: "近期没有与当前生产零件号精确匹配的品质记录。",
    recentReports: "近 {days} 天 {count} 件",
    previousQualityPage: "上一页品质记录",
    nextQualityPage: "下一页品质记录",
    pauseRotation: "暂停品质记录自动切换",
    resumeRotation: "继续品质记录自动切换",
    rotationPaused: "切换已暂停",
    reducedMotion: "手动切换",
    nextIn: "12秒后切换",
    inventory: "库存 · 仓库",
    finishedAndSemifinished: "成品 · 半成品",
    warehouseComposition: "仓库构成",
    finishedWarehouse: "成品",
    semifinishedWarehouse: "半成品",
    inventoryCarts: "库存台车",
    shippingNetChange: "成品仓净变化",
    inbound: "入库",
    outbound: "出库",
    cartUnit: "台",
    recordUnit: "件",
    energy: "能源",
    energyTrendTitle: "分时用电 · 移动平均",
    energyTrendSubtitle: "最近完成24小时 · kWh",
    todayCumulativeEnergy: "今日累计",
    energyPer1000Shots: "每1,000模次",
    todayShots: "今日模次",
    efficiencyCoverage: "能效计算",
    hourlyEnergy: "分时",
    movingAverage8h: "8h平均",
    movingAverage12h: "12h平均",
    movingAverage24h: "24h平均",
    meteredMachines: "计量设备",
    noEnergyTrend: "暂无分时用电数据",
    moulds: "模具 · 保全",
    managedMoulds: "模具管理数",
    mountedMoulds: "已安装模具",
    storedMoulds: "在库",
    maintenanceMoulds: "保养",
    repairMoulds: "维修",
    offsiteMoulds: "外部",
    mouldStatusMix: "模具状态构成",
    confirmationRequired: "需要确认",
    locationConflict: "位置冲突",
    dataUnavailable: "无法读取综合运营数据。",
    retry: "重新读取",
    loading: "正在读取综合运营数据。",
    demo: "DEMO",
    sourceFreshness: "数据时效",
    staleSources: "延迟 {count}",
    unavailableSources: "未接收 {count}",
  },
} as const;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

function formatInteger(value: number | null, language: AppLanguage) {
  if (value === null) return "—";
  return new Intl.NumberFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDecimal(value: number | null, maximumFractionDigits = 1) {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function formatPercent(value: number | null) {
  return value === null ? "—" : `${formatDecimal(value, 1)}%`;
}

function formatBusinessDate(value: string, language: AppLanguage) {
  const [year, month, day] = value.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return value;
  const weekday = new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
  return language === "ko"
    ? `${year}년 ${month}월 ${day}일 ${weekday}`
    : `${year}年 ${month}月 ${day}日 ${weekday}`;
}

function WeatherConditionIcon({ conditionCode }: { conditionCode: string }) {
  const Icon = conditionCode === "clear"
    ? Sun
    : conditionCode === "partly_cloudy"
      ? CloudSun
      : conditionCode === "fog"
        ? CloudFog
        : conditionCode === "rain" || conditionCode === "heavy_rain"
          ? CloudRain
          : conditionCode === "snow"
            ? Snowflake
            : conditionCode === "thunder"
              ? CloudLightning
              : Cloud;
  return <Icon aria-hidden="true" />;
}

function getWeatherConditionLabel(conditionCode: string, language: AppLanguage) {
  const copy = COPY[language];
  const labels: Record<string, string> = {
    clear: copy.weatherClear,
    partly_cloudy: copy.weatherPartlyCloudy,
    cloudy: copy.weatherCloudy,
    fog: copy.weatherFog,
    rain: copy.weatherRain,
    heavy_rain: copy.weatherHeavyRain,
    snow: copy.weatherSnow,
    thunder: copy.weatherThunder,
  };
  return labels[conditionCode] ?? copy.weatherUnknown;
}

function formatShanghaiTime(value: string | null) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatShortDate(value: string | null) {
  if (!value) return "--";
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[2]}-${match[3]}` : value;
}

function replaceCount(template: string, days: number, count: number | null) {
  return template
    .replace("{days}", String(days))
    .replace("{count}", count === null ? "—" : String(count));
}

function replaceSingleCount(template: string, count: number) {
  return template.replace("{count}", String(count));
}

function formatSignedPercentPoints(value: number | null) {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${formatDecimal(value, 1)}%p`;
}

function formatSignedInteger(value: number | null, language: AppLanguage) {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${formatInteger(value, language)}`;
}

function getProcessPace(process: ProductionProcess) {
  const completion = process.completionRate;
  const time = process.timeProgressRate;
  const gap = process.completionVsTimeGap
    ?? (completion !== null && time !== null ? completion - time : null);
  const expected = process.expectedQuantityByTime
    ?? (process.plannedQuantity !== null && time !== null
      ? Math.round(process.plannedQuantity * (time / 100))
      : null);
  const quantityGap = process.gapToTimeQuantity
    ?? (process.actualQuantity !== null && expected !== null ? process.actualQuantity - expected : null);
  const remaining = process.remainingQuantity
    ?? (process.plannedQuantity !== null && process.actualQuantity !== null
      ? Math.max(0, process.plannedQuantity - process.actualQuantity)
      : null);
  const status = process.paceStatus !== "unknown"
    ? process.paceStatus
    : process.plannedQuantity === 0
      ? "no_plan"
      : gap !== null && gap < -5
        ? "behind"
        : gap !== null && gap > 5
          ? "ahead"
          : "on_track";
  return { completion, time, gap, expected, quantityGap, remaining, status };
}

function paceLabel(status: ReturnType<typeof getProcessPace>["status"], language: AppLanguage) {
  const copy = COPY[language];
  if (status === "ahead") return copy.ahead;
  if (status === "behind") return copy.behind;
  if (status === "no_plan") return copy.noPlan;
  return copy.onTrack;
}

function PaceBar({ label, value, color }: { label: string; value: number | null; color: string }) {
  const width = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className={styles.paceBar}>
      <div><span>{label}</span><strong>{formatPercent(value)}</strong></div>
      <div className={styles.paceTrack} aria-hidden="true"><span style={{ backgroundColor: color, width: `${width}%` }} /></div>
    </div>
  );
}

function ProductionCard({
  process,
  kind,
  language,
}: {
  process: ProductionProcess;
  kind: "injection" | "assembly";
  language: AppLanguage;
}) {
  const copy = COPY[language];
  const isInjection = kind === "injection";
  const color = isInjection ? "#1260b6" : "#078c55";
  const pace = getProcessPace(process);
  const paceTone = pace.status === "behind" ? styles.paceBehind : pace.status === "ahead" ? styles.paceAhead : styles.paceOnTrack;
  return (
    <section className={`${styles.card} ${styles.productionCard}`} aria-labelledby={`${kind}-production-title`}>
      <header className={styles.productionHeading}>
        <h2 id={`${kind}-production-title`}>{isInjection ? copy.injectionProduction : copy.assemblyProduction}</h2>
        <span className={`${styles.paceBadge} ${paceTone}`}>{paceLabel(pace.status, language)} · {formatSignedPercentPoints(pace.gap)}</span>
      </header>
      <div className={styles.productionPrimary}>
        <div className={styles.productionIdentity}>
          <div className={`${styles.productionAsset} ${isInjection ? styles.injectionAsset : styles.assemblyAsset}`}>
            <img alt="" aria-hidden="true" src={isInjection ? injectionProcessIcon : assemblyConveyorIcon} />
          </div>
          <dl className={styles.productionNumbers}>
            <div><dt>{copy.plan}</dt><dd>{formatInteger(process.plannedQuantity, language)}</dd></div>
            <div><dt>{copy.actual}</dt><dd>{formatInteger(process.actualQuantity, language)}</dd></div>
          </dl>
        </div>
        <div className={styles.paceComparison}>
          <PaceBar color={color} label={copy.completion} value={pace.completion} />
          <PaceBar color="#6c8198" label={copy.timeProgress} value={pace.time} />
          <div className={`${styles.paceDelta} ${paceTone}`}>
            <GitCompareArrows aria-hidden="true" />
            <span>{copy.paceGap}</span>
            <strong>{formatSignedPercentPoints(pace.gap)}</strong>
          </div>
        </div>
      </div>
      <div className={styles.productionInsights}>
        <article><span>{copy.expectedNow}</span><strong>{formatInteger(pace.expected, language)}</strong><small>{copy.quantityGap} {formatSignedInteger(pace.quantityGap, language)}</small></article>
        <article><span>{copy.finishForecast}</span><strong>{formatPercent(process.forecastCompletionRate)}</strong><small>{copy.remaining} {formatInteger(pace.remaining, language)}</small></article>
        {process.reportingMix ? (
          <article title={process.reportingMix.dataQualityNote ?? undefined}>
            <span>{copy.manualOpen}</span>
            <strong>{formatInteger(process.reportingMix.manualOpenQuantity, language)}</strong>
            <small>{copy.mesConfirmed} {formatInteger(process.reportingMix.mesConfirmedQuantity, language)} · {copy.manualShare.replace("{value}", formatDecimal(process.reportingMix.manualOpenSharePercent, 1))}</small>
          </article>
        ) : (
          <article><span>{copy.requiredPerHour}</span><strong>{formatInteger(process.requiredQuantityPerHour, language)}</strong><small>{copy.lineCount} {formatInteger(process.planRowCount, language)}</small></article>
        )}
      </div>
    </section>
  );
}

function getMachineStateLabel(row: InjectionEquipmentRow, language: AppLanguage) {
  const copy = COPY[language];
  if (row.productionState === "running_without_plan") return copy.machineUnplanned;
  if (row.productionState?.startsWith("running_") || row.isRunning) return copy.machineRunning;
  if (row.productionState === "planned_waiting") return copy.machineWaiting;
  if (row.productionState === "plan_completed") return copy.machineCompleted;
  return copy.machineStopped;
}

function MachineProductionRow({
  row,
  businessTimeProgress,
  language,
}: {
  row: InjectionEquipmentRow;
  businessTimeProgress: number | null;
  language: AppLanguage;
}) {
  const copy = COPY[language];
  const completion = row.completionRate;
  const timeProgress = row.timeProgressRate ?? businessTimeProgress;
  const gap = row.gapToTimeRate
    ?? (completion !== null && timeProgress !== null ? completion - timeProgress : null);
  const completionWidth = completion === null ? 0 : Math.max(0, Math.min(100, completion));
  const timePosition = timeProgress === null ? null : Math.max(0, Math.min(100, timeProgress));
  const primaryPart = row.currentParts[0];
  const modelLabel = primaryPart?.modelName ?? primaryPart?.partName ?? row.currentModels[0] ?? null;
  const planActualLabel = row.hasPlan === false
    ? "—"
    : `${formatInteger(row.actualQuantity, language)} / ${formatInteger(row.plannedQuantity, language)}`;
  const isStale = row.sourceStatus === "stale" || row.sourceStatus === "missing";
  const stateTone = row.isRunning ? styles.machineRunning : styles.machineStopped;
  const paceTone = gap !== null && gap < -5
    ? styles.machinePaceBehind
    : gap !== null && gap > 5
      ? styles.machinePaceAhead
      : styles.machinePaceOnTrack;
  const progressLabel = `${copy.completion} ${formatPercent(completion)} · ${copy.timeProgress} ${formatPercent(timeProgress)}`;

  return (
    <article className={`${styles.machineRow} ${stateTone}`} title={row.stateReason ?? undefined}>
      <div className={styles.machineIdentity}>
        <strong>{row.label}</strong>
        <span><i aria-hidden="true" />{getMachineStateLabel(row, language)}</span>
        {isStale ? <small><AlertTriangle aria-hidden="true" />{copy.machineSourceStale}</small> : null}
      </div>
      <div className={styles.machineProduct}>
        <small>{copy.currentProduct}</small>
        <strong title={modelLabel ?? copy.productUnconfirmed}>{modelLabel ?? copy.productUnconfirmed}</strong>
      </div>
      <div className={styles.machineProgress}>
        <div className={styles.machineProgressValue}>
          <span>{copy.planActual}</span>
          <strong>{planActualLabel}</strong>
          <em className={paceTone}>{formatSignedPercentPoints(gap)}</em>
        </div>
        <div aria-label={progressLabel} className={styles.machineProgressTrack} role="img">
          <span style={{ width: `${completionWidth}%` }} />
          {timePosition !== null ? <i aria-hidden="true" style={{ left: `${timePosition}%` }} /> : null}
        </div>
        <div className={styles.machineProgressLegend}>
          <span><i />{copy.completion} <b>{formatPercent(completion)}</b></span>
          <span><i />{copy.timeLegend} <b>{formatPercent(timeProgress)}</b></span>
        </div>
      </div>
      <div className={styles.machineLiveMetrics}>
        <article><Radio aria-hidden="true" /><span>{copy.recentShots}</span><strong>{formatInteger(row.recent60mShots, language)}</strong></article>
      </div>
    </article>
  );
}

function EquipmentPanel({ model, language }: { model: OverviewBoardModel; language: AppLanguage }) {
  const copy = COPY[language];
  const reducedMotion = usePrefersReducedMotion();
  const [pageIndex, setPageIndex] = useState(0);
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const [interactionPaused, setInteractionPaused] = useState(false);
  const rows = useMemo(() => [...model.equipment.injectionRows], [model.equipment.injectionRows]);
  const pages = useMemo(() => {
    const result: InjectionEquipmentRow[][] = [];
    for (let index = 0; index < rows.length; index += MACHINE_PAGE_SIZE) {
      result.push(rows.slice(index, index + MACHINE_PAGE_SIZE));
    }
    return result.length > 0 ? result : [[]];
  }, [rows]);
  const pageCount = pages.length;
  const autoPaused = reducedMotion || manuallyPaused || interactionPaused || pageCount <= 1;
  const summary = model.equipment.injectionOee;
  const runningCount = summary.runningMachineCount ?? rows.filter((row) => row.isRunning).length;
  const totalCount = summary.totalEquipmentCount ?? rows.length;

  useEffect(() => setPageIndex(0), [model.businessDate, rows.length, language]);

  useEffect(() => {
    if (autoPaused) return;
    const timer = window.setInterval(() => {
      setPageIndex((current) => (current + 1) % pageCount);
    }, MACHINE_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [autoPaused, pageCount]);

  const movePage = (step: number) => {
    setPageIndex((current) => (current + step + pageCount) % pageCount);
  };

  return (
    <section
      className={`${styles.card} ${styles.equipmentCard}`}
      aria-labelledby="equipment-title"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInteractionPaused(false);
      }}
      onFocusCapture={() => setInteractionPaused(true)}
      onMouseEnter={() => setInteractionPaused(true)}
      onMouseLeave={() => setInteractionPaused(false)}
    >
      <header className={styles.equipmentHeading}>
        <div className={styles.cardTitle}><Factory aria-hidden="true" /><h2 id="equipment-title">{copy.equipment}</h2></div>
        <div>
          <span>{copy.equipmentRotationHint}</span>
          <strong><i aria-hidden="true" />{copy.runningMachines} {formatInteger(runningCount, language)} / {formatInteger(totalCount, language)}</strong>
        </div>
      </header>
      <div className={styles.machineBody} key={`${pageIndex}-${language}`}>
        {pages[pageIndex].length > 0
          ? pages[pageIndex].map((row) => (
              <MachineProductionRow
                businessTimeProgress={model.processes.injection.timeProgressRate}
                key={row.id}
                language={language}
                row={row}
              />
            ))
          : <p className={styles.panelEmpty}>—</p>}
      </div>
      <footer className={styles.machineControls}>
        <button aria-label={copy.previousMachinePage} disabled={pageCount <= 1} onClick={() => movePage(-1)} type="button"><ChevronLeft aria-hidden="true" /></button>
        <span>{pageIndex + 1} / {pageCount} · {copy.machineCount.replace("{count}", String(rows.length))} · {reducedMotion ? copy.machineReducedMotion : autoPaused ? copy.machineRotationPaused : copy.machineNextIn}</span>
        <button
          aria-label={manuallyPaused ? copy.resumeMachineRotation : copy.pauseMachineRotation}
          aria-pressed={manuallyPaused}
          disabled={reducedMotion || pageCount <= 1}
          onClick={() => setManuallyPaused((current) => !current)}
          type="button"
        >
          {manuallyPaused || reducedMotion ? <CirclePlay aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
        </button>
        <button aria-label={copy.nextMachinePage} disabled={pageCount <= 1} onClick={() => movePage(1)} type="button"><ChevronRight aria-hidden="true" /></button>
      </footer>
    </section>
  );
}

function AttentionIcon({ category }: { category: AttentionItem["category"] }) {
  if (category === "injection") return <Factory aria-hidden="true" />;
  if (category === "mould") return <MapPin aria-hidden="true" />;
  if (category === "signal") return <Signal aria-hidden="true" />;
  if (category === "material") return <PackageOpen aria-hidden="true" />;
  if (category === "quality") return <ShieldCheck aria-hidden="true" />;
  if (category === "equipment") return <Wrench aria-hidden="true" />;
  return <Workflow aria-hidden="true" />;
}

function OperationsPanel({ model, language }: { model: OverviewBoardModel; language: AppLanguage }) {
  const copy = COPY[language];
  const visibleItems = model.attention.slice(0, 3);
  const injectionPace = getProcessPace(model.processes.injection);
  const assemblyPace = getProcessPace(model.processes.assembly);
  return (
    <section className={`${styles.card} ${styles.operationsCard}`} aria-labelledby="operations-title">
      <div className={styles.operationsHeading}>
        <h2 id="operations-title">{copy.operations}</h2>
        <div className={styles.overallAttention}><AlertTriangle aria-hidden="true" /><strong>{copy.attention}</strong></div>
      </div>
      <div className={styles.operationsPulse}>
        <article className={injectionPace.status === "behind" ? styles.pulseAttention : ""}><Factory aria-hidden="true" /><span>{copy.injectionPace}</span><strong>{formatSignedPercentPoints(injectionPace.gap)}</strong></article>
        <article className={assemblyPace.status === "behind" ? styles.pulseAttention : ""}><Workflow aria-hidden="true" /><span>{copy.assemblyPace}</span><strong>{formatSignedPercentPoints(assemblyPace.gap)}</strong></article>
        <article className={styles.pulseAttention}><TrendingDown aria-hidden="true" /><span>{copy.behindMachines}</span><strong>{formatInteger(model.equipment.injectionOee.behindMachineCount, language)}</strong></article>
        <article className={model.equipment.injectionOee.unplannedMachineCount ? styles.pulseAttention : ""}><AlertTriangle aria-hidden="true" /><span>{copy.unplannedActive}</span><strong>{formatInteger(model.equipment.injectionOee.unplannedMachineCount, language)}</strong></article>
      </div>
      <div className={styles.attentionList}>
        {visibleItems.length > 0 ? visibleItems.map((item) => (
          <article className={styles.attentionRow} key={item.id}>
            <strong className={styles.attentionRank}>{item.rank}</strong>
            <span className={styles.attentionIcon}><AttentionIcon category={item.category} /></span>
            <p><strong>{item.summary}</strong>{item.action ? <span> · {item.action}</span> : null}</p>
            <small>{copy.attention}</small>
          </article>
        )) : <p className={styles.panelEmpty}>{copy.noAttentionData}</p>}
      </div>
    </section>
  );
}

function QualityRow({
  item,
  language,
  historyWindowDays,
}: {
  item: QualityAttentionItem;
  language: AppLanguage;
  historyWindowDays: number;
}) {
  const copy = COPY[language];
  return (
    <article className={styles.qualityRow}>
      <strong className={styles.qualityMachine}>{item.machineLabel}</strong>
      <span className={styles.qualityModel} title={`${item.modelLabel}${item.partNumber ? ` · ${item.partNumber}` : ""}`}>
        <b>{item.modelLabel}</b>
        <small>{item.partNumber ? `${item.partNumber} · ` : ""}{copy.exactPartMatch}</small>
      </span>
      <p><Clock3 aria-hidden="true" />{item.phenomena.length > 0 ? item.phenomena.join(" / ") : "—"}</p>
      <small>
        <span>{replaceCount(copy.recentReports, historyWindowDays, item.reportCount)}</span>
        <span>{formatShortDate(item.latestReportDate)}</span>
      </small>
    </article>
  );
}

function QualityPanel({ model, language }: { model: OverviewBoardModel; language: AppLanguage }) {
  const copy = COPY[language];
  const reducedMotion = usePrefersReducedMotion();
  const [pageIndex, setPageIndex] = useState(0);
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const [interactionPaused, setInteractionPaused] = useState(false);
  const pages = useMemo(() => {
    const result: QualityAttentionItem[][] = [];
    for (let index = 0; index < model.quality.items.length; index += QUALITY_PAGE_SIZE) {
      result.push(model.quality.items.slice(index, index + QUALITY_PAGE_SIZE));
    }
    return result.length > 0 ? result : [[]];
  }, [model.quality.items]);
  const pageCount = pages.length;
  const autoPaused = reducedMotion || manuallyPaused || interactionPaused || pageCount <= 1;

  useEffect(() => setPageIndex(0), [model.businessDate, model.quality.items.length, language]);

  useEffect(() => {
    if (autoPaused) return;
    const timer = window.setInterval(() => {
      setPageIndex((current) => (current + 1) % pageCount);
    }, QUALITY_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [autoPaused, pageCount]);

  const movePage = (step: number) => {
    setPageIndex((current) => (current + step + pageCount) % pageCount);
  };

  return (
    <section
      className={`${styles.card} ${styles.qualityCard}`}
      aria-labelledby="quality-title"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInteractionPaused(false);
      }}
      onFocusCapture={() => setInteractionPaused(true)}
      onMouseEnter={() => setInteractionPaused(true)}
      onMouseLeave={() => setInteractionPaused(false)}
    >
      <header className={styles.qualityHeading}>
        <div className={styles.cardTitle}><ShieldCheck aria-hidden="true" /><h2 id="quality-title">{copy.quality}</h2></div>
        <span><CheckCircle2 aria-hidden="true" />{model.quality.disclaimer ?? copy.historicalDisclaimer}</span>
      </header>
      <div className={styles.qualityBody} key={`${pageIndex}-${language}`}>
        {pages[pageIndex].length > 0
          ? pages[pageIndex].map((item) => (
              <QualityRow historyWindowDays={model.quality.historyWindowDays} item={item} key={item.id} language={language} />
            ))
          : <p className={styles.panelEmpty}>{copy.noQualityData}</p>}
      </div>
      <footer className={styles.qualityControls}>
        <button aria-label={copy.previousQualityPage} disabled={pageCount <= 1} onClick={() => movePage(-1)} type="button"><ChevronLeft aria-hidden="true" /></button>
        <span>{pageIndex + 1} / {pageCount} · {reducedMotion ? copy.reducedMotion : autoPaused ? copy.rotationPaused : copy.nextIn}</span>
        <button
          aria-label={manuallyPaused ? copy.resumeRotation : copy.pauseRotation}
          aria-pressed={manuallyPaused}
          disabled={reducedMotion || pageCount <= 1}
          onClick={() => setManuallyPaused((current) => !current)}
          type="button"
        >
          {manuallyPaused || reducedMotion ? <CirclePlay aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
        </button>
        <button aria-label={copy.nextQualityPage} disabled={pageCount <= 1} onClick={() => movePage(1)} type="button"><ChevronRight aria-hidden="true" /></button>
      </footer>
    </section>
  );
}

function InventoryPanel({ model, language }: { model: OverviewBoardModel; language: AppLanguage }) {
  const copy = COPY[language];
  const totalWarehouseQuantity = model.inventory.warehouses.reduce((sum, row) => sum + (row.quantity ?? 0), 0);
  const warehouseRows = model.inventory.warehouses.map((row) => {
    const label = row.label.includes("半成")
      ? copy.semifinishedWarehouse
      : row.label.includes("成品")
        ? copy.finishedWarehouse
        : row.label;
    return {
      ...row,
      label,
      share: totalWarehouseQuantity > 0 && row.quantity !== null ? (row.quantity / totalWarehouseQuantity) * 100 : 0,
    };
  });
  return (
    <section className={`${styles.card} ${styles.inventoryCard}`} aria-labelledby="inventory-title">
      <header className={styles.inventoryHeading}>
        <div className={styles.cardTitle}><Boxes aria-hidden="true" /><h2 id="inventory-title">{copy.inventory}</h2></div>
        <div><span>{copy.finishedAndSemifinished}</span><strong>{formatInteger(model.inventory.finishedAndSemifinishedQuantity, language)}</strong></div>
      </header>
      <div className={styles.inventoryBody}>
        <div className={styles.inventoryMeta}>
          <span><PackageCheck aria-hidden="true" />{formatInteger(model.inventory.skuCount, language)} SKU</span>
          <span><PackageOpen aria-hidden="true" />{formatInteger(model.inventory.totalCarts, language)} {copy.cartUnit}</span>
        </div>
        <div className={styles.warehouseComposition}>
          <span>{copy.warehouseComposition}</span>
          {warehouseRows.length > 0 ? warehouseRows.map((row, index) => (
            <article key={`${row.label}-${index}`}>
              <div><strong>{row.label}</strong><span>{formatInteger(row.quantity, language)} · {formatDecimal(row.share, 1)}%</span></div>
              <div><span style={{ width: `${Math.max(0, Math.min(100, row.share))}%` }} /></div>
            </article>
          )) : <p className={styles.panelEmpty}>—</p>}
        </div>
      </div>
      <div className={styles.inventoryFlow}>
        <article><ArrowDownToLine aria-hidden="true" /><span>{copy.inbound}</span><strong>{formatInteger(model.inventory.shippingInbound, language)}</strong></article>
        <article><ArrowUpFromLine aria-hidden="true" /><span>{copy.outbound}</span><strong>{formatInteger(model.inventory.shippingOutbound, language)}</strong></article>
        <article className={styles.orangeMetric}><GitCompareArrows aria-hidden="true" /><span>{copy.shippingNetChange}</span><strong>{formatSignedInteger(model.inventory.shippingNetChange, language)}</strong><small>{formatInteger(model.inventory.shippingRecordCount, language)} {copy.recordUnit}</small></article>
      </div>
    </section>
  );
}

function EnergyPanel({ model, language }: { model: OverviewBoardModel; language: AppLanguage }) {
  const copy = COPY[language];
  const chartData = model.energy.hourlyTrend;
  const hasTrend = chartData.some((point) => (
    point.usageKwh !== null
    || point.movingAverage8hKwh !== null
    || point.movingAverage12hKwh !== null
    || point.movingAverage24hKwh !== null
  ));
  const machineUnit = language === "ko" ? "대" : "台";
  return (
    <section className={`${styles.card} ${styles.energyCard}`} aria-labelledby="energy-title">
      <header className={styles.cardTitle}><Zap aria-hidden="true" /><h2 id="energy-title">{copy.energy}</h2></header>
      <div className={styles.energyContent}>
        <div className={styles.energyKpi}>
          <span className={styles.energyKpiLabel}>{copy.todayCumulativeEnergy}</span>
          <strong>{formatDecimal(model.energy.usageValue, 2)}<small>{model.energy.usageValue === null ? "" : model.energy.unit}</small></strong>
          <article><span>{copy.energyPer1000Shots}</span><b>{formatDecimal(model.energy.energyPer1000ShotsKwh, 1)}<small>kWh</small></b></article>
          <article><span>{copy.todayShots}</span><b>{formatInteger(model.energy.totalShots, language)}</b></article>
          <div>
            <span>{copy.meteredMachines} <b>{formatInteger(model.energy.meteredMachineCount, language)}{machineUnit}</b></span>
            <span>{copy.efficiencyCoverage} <b>{formatInteger(model.energy.efficiencyMeteredMachineCount, language)}{machineUnit}</b></span>
          </div>
        </div>
        <div className={styles.energyTrend}>
          <div className={styles.energyTrendHeading}><strong>{copy.energyTrendTitle}</strong><span>{copy.energyTrendSubtitle}</span></div>
          {hasTrend ? (
            <ResponsiveContainer height="100%" width="100%">
              <ComposedChart data={chartData} margin={{ top: 2, right: 6, bottom: 0, left: -10 }}>
                <CartesianGrid stroke="#dce5ee" strokeDasharray="3 5" vertical={false} />
                <XAxis axisLine={{ stroke: "#9eb0c7" }} dataKey="label" fontSize="0.56rem" interval={3} tickLine={false} />
                <YAxis axisLine={false} domain={[0, "auto"]} fontSize="0.56rem" tickLine={false} width={42} />
                <Tooltip formatter={(value, name) => [`${formatDecimal(Number(value), 1)} kWh`, name]} />
                <Legend align="right" height={24} iconSize={8} verticalAlign="top" wrapperStyle={{ fontSize: "0.56rem" }} />
                <Bar barSize={8} dataKey="usageKwh" fill="#8db7df" isAnimationActive={false} name={copy.hourlyEnergy} radius={[3, 3, 0, 0]} />
                <Line connectNulls={false} dataKey="movingAverage8hKwh" dot={false} isAnimationActive={false} name={copy.movingAverage8h} stroke="#155fb2" strokeWidth={2.4} type="monotone" />
                <Line connectNulls={false} dataKey="movingAverage12hKwh" dot={false} isAnimationActive={false} name={copy.movingAverage12h} stroke="#657d96" strokeDasharray="6 4" strokeWidth={2.1} type="monotone" />
                <Line connectNulls={false} dataKey="movingAverage24hKwh" dot={false} isAnimationActive={false} name={copy.movingAverage24h} stroke="#d88718" strokeDasharray="2 4" strokeWidth={2.2} type="monotone" />
              </ComposedChart>
            </ResponsiveContainer>
          ) : <p className={styles.panelEmpty}>{copy.noEnergyTrend}</p>}
        </div>
      </div>
    </section>
  );
}

function MouldPanel({ model, language }: { model: OverviewBoardModel; language: AppLanguage }) {
  const copy = COPY[language];
  const statusRows = [
    { key: "stored", label: copy.storedMoulds, value: model.moulds.stored, color: "#1765b2" },
    { key: "mounted", label: copy.mountedMoulds, value: model.moulds.mounted, color: "#0a8a57" },
    { key: "maintenance", label: copy.maintenanceMoulds, value: model.moulds.maintenance, color: "#d99917" },
    { key: "repair", label: copy.repairMoulds, value: model.moulds.repair, color: "#d96516" },
    { key: "offsite", label: copy.offsiteMoulds, value: model.moulds.offsite, color: "#7b6fa9" },
  ].filter((row) => row.value !== null && row.value > 0);
  return (
    <section className={`${styles.card} ${styles.mouldCard}`} aria-labelledby="mould-title">
      <header className={styles.mouldHeading}>
        <div className={styles.cardTitle}><Wrench aria-hidden="true" /><h2 id="mould-title">{copy.moulds}</h2></div>
        <span>{copy.managedMoulds} <strong>{formatInteger(model.moulds.total, language)}</strong></span>
      </header>
      <div className={styles.mouldOverview}>
        <div className={styles.mouldDonut} aria-label={`${copy.managedMoulds} ${formatInteger(model.moulds.total, language)}`}>
          <ResponsiveContainer height="100%" width="100%">
            <PieChart>
              <Pie data={statusRows} dataKey="value" innerRadius="64%" outerRadius="94%" isAnimationActive={false} stroke="#fbfdff" strokeWidth={2}>
                {statusRows.map((row) => <Cell fill={row.color} key={row.key} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div><strong>{formatInteger(model.moulds.total, language)}</strong><span>{copy.mouldStatusMix}</span></div>
        </div>
        <div className={styles.mouldLegend}>
          {statusRows.map((row) => (
            <article key={row.key}><i style={{ backgroundColor: row.color }} /><span>{row.label}</span><strong>{formatInteger(row.value, language)}</strong><em>{model.moulds.total ? `${formatDecimal(((row.value ?? 0) / model.moulds.total) * 100, 1)}%` : "—"}</em></article>
          ))}
        </div>
      </div>
      <div className={styles.mouldAlerts}>
        <article><Gauge aria-hidden="true" /><span>{copy.mountedMoulds}</span><strong>{formatInteger(model.moulds.mounted, language)}</strong></article>
        <article className={styles.orangeMetric}><AlertTriangle aria-hidden="true" /><span>{copy.confirmationRequired}</span><strong>{formatInteger(model.moulds.confirmationRequired, language)}</strong></article>
        <article className={styles.orangeMetric}><MapPin aria-hidden="true" /><span>{copy.locationConflict}</span><strong>{formatInteger(model.moulds.conflicts, language)}</strong></article>
      </div>
    </section>
  );
}

function HeaderPanel({
  model,
  language,
  mode,
  onToggleLanguage,
}: {
  model: OverviewBoardModel;
  language: AppLanguage;
  mode: "live" | "demo";
  onToggleLanguage: () => void;
}) {
  const copy = COPY[language];
  const statusCopy = model.overallStatus === "normal" ? copy.normal : copy.attention;
  const injectionPace = getProcessPace(model.processes.injection);
  const assemblyPace = getProcessPace(model.processes.assembly);
  const freshnessParts = [
    model.freshness.staleSourceCount > 0
      ? replaceSingleCount(copy.staleSources, model.freshness.staleSourceCount)
      : null,
    model.freshness.unavailableSourceCount > 0
      ? replaceSingleCount(copy.unavailableSources, model.freshness.unavailableSourceCount)
      : null,
  ].filter((item): item is string => Boolean(item));
  const freshnessLabel = model.freshnessLabel ?? (freshnessParts.length > 0 ? freshnessParts.join(" · ") : null);
  const weather = model.weather;
  const weatherAvailable = weather.status !== "unavailable" && weather.temperatureC !== null;
  return (
    <header className={`${styles.card} ${styles.headerCard}`}>
      <div className={styles.brandRow}>
        <img alt="WJ" src="/logo-transparent.png" />
        <h1>
          <button aria-label={copy.titleToggle} className={styles.titleButton} onClick={onToggleLanguage} type="button">
            <strong>{copy.title}</strong>
          </button>
        </h1>
      </div>
      <div className={styles.headerContextRow}>
        <p className={styles.businessDate}>{formatBusinessDate(model.businessDate, language)}</p>
        <div className={`${styles.weatherStrip} ${weather.isStale ? styles.weatherStale : ""}`} title={weather.isStale ? copy.weatherStale : weather.attribution}>
          <WeatherConditionIcon conditionCode={weather.conditionCode} />
          <span className={styles.weatherCondition}><strong>{copy.nanjingWeather}</strong>{getWeatherConditionLabel(weather.conditionCode, language)}</span>
          <strong className={styles.weatherTemperature}>{weatherAvailable ? `${formatDecimal(weather.temperatureC, 1)}°C` : "—"}</strong>
          <span><Droplets aria-hidden="true" />{copy.humidity} <strong>{weather.relativeHumidityPercent === null ? "—" : `${formatDecimal(weather.relativeHumidityPercent, 0)}%`}</strong></span>
          <span><Wind aria-hidden="true" />{copy.wind} <strong>{weather.windSpeedMps === null ? "—" : `${formatDecimal(weather.windSpeedMps, 1)} m/s`}</strong></span>
          {weather.sourceUrl ? <a href={weather.sourceUrl} rel="noreferrer" target="_blank">{weather.source}</a> : <small>{weather.source}</small>}
        </div>
      </div>
      <div className={styles.headerPaceSummary}>
        <article className={injectionPace.status === "behind" ? styles.headerPaceAttention : ""}><Factory aria-hidden="true" /><span>{copy.injectionPace}</span><strong>{formatSignedPercentPoints(injectionPace.gap)}</strong></article>
        <article className={assemblyPace.status === "behind" ? styles.headerPaceAttention : ""}><Workflow aria-hidden="true" /><span>{copy.assemblyPace}</span><strong>{formatSignedPercentPoints(assemblyPace.gap)}</strong></article>
        <article><Factory aria-hidden="true" /><span>{copy.runningMachines}</span><strong>{formatInteger(model.equipment.injectionOee.runningMachineCount, language)} / {formatInteger(model.equipment.injectionOee.totalEquipmentCount, language)}</strong></article>
      </div>
      {mode === "demo" ? <div className={styles.demoBadge}><Radio aria-hidden="true" />{copy.demo}</div> : null}
      <div className={styles.statusStrip}>
        <span><Clock3 aria-hidden="true" />{formatShanghaiTime(model.generatedAt)} {copy.generatedAt}</span>
        <span className={model.overallStatus === "normal" ? styles.normalStatus : styles.attentionStatus}><CheckCircle2 aria-hidden="true" />{copy.operatingStatus} <strong>{statusCopy}</strong></span>
        <span className={styles.attentionStatus}><AlertTriangle aria-hidden="true" />{copy.checks} <strong>{formatInteger(model.attention.length, language)}</strong></span>
        <span><ShieldCheck aria-hidden="true" />{copy.qualityHistoryCount} <strong>{formatInteger(model.quality.items.length, language)}</strong></span>
      </div>
      {freshnessLabel ? <small className={styles.freshness}><TimerReset aria-hidden="true" />{copy.sourceFreshness} · {freshnessLabel}</small> : null}
    </header>
  );
}

export function OverviewBoardPage() {
  const [language, setLanguage] = useStoredLanguage();
  const [languageAnnouncement, setLanguageAnnouncement] = useState("");
  const businessDate = useMemo(() => getShanghaiBusinessDateString(), []);
  const query = useQuery({
    queryKey: ["overview-board", businessDate, language],
    queryFn: () => getOverviewBoard(businessDate, language),
    refetchInterval: 60_000,
    staleTime: 45_000,
  });
  const copy = COPY[language];

  const toggleLanguage = () => {
    const nextLanguage = language === "ko" ? "zh" : "ko";
    setLanguageAnnouncement(copy.languageChanged);
    setLanguage(nextLanguage);
  };

  if (query.isLoading) {
    return (
      <main className={styles.statePage} role="status">
        <img alt="WJ" src="/logo-transparent.png" />
        <span className={styles.stateSpinner} aria-hidden="true" />
        <p>{copy.loading}</p>
      </main>
    );
  }

  if (query.isError || !query.data) {
    return (
      <main className={styles.statePage} role="alert">
        <AlertTriangle aria-hidden="true" />
        <h1>{copy.dataUnavailable}</h1>
        <button onClick={() => void query.refetch()} type="button">{copy.retry}</button>
      </main>
    );
  }

  const { model, mode } = query.data;
  return (
    <main className={styles.page} data-mode={mode} data-testid="overview-board-page">
      <ProductionCard kind="injection" language={language} process={model.processes.injection} />
      <HeaderPanel language={language} mode={mode} model={model} onToggleLanguage={toggleLanguage} />
      <ProductionCard kind="assembly" language={language} process={model.processes.assembly} />
      <EquipmentPanel language={language} model={model} />
      <OperationsPanel language={language} model={model} />
      <QualityPanel language={language} model={model} />
      <InventoryPanel language={language} model={model} />
      <EnergyPanel language={language} model={model} />
      <MouldPanel language={language} model={model} />
      <p aria-live="polite" className={styles.srAnnouncement}>{languageAnnouncement}</p>
    </main>
  );
}
