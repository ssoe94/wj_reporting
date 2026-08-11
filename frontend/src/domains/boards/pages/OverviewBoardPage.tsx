import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowUpFromLine,
  CalendarDays,
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
  Maximize2,
  Minimize2,
  PackageOpen,
  Radio,
  RefreshCw,
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
  ComposedChart,
  Legend,
  Line,
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
  OutboundPerformanceMetric,
  OutboundPerformancePeriod,
  OutboundPriorityItem,
  OutboundTodayDetailSummary,
  OverviewBoardModel,
  ProductionProcess,
  QualityAttentionItem,
} from "@/domains/boards/overview/types";
import { useStoredLanguage, type AppLanguage } from "@/shared/i18n/language";
import { useShanghaiBusinessDate } from "@/shared/hooks/useShanghaiBusinessDate";
import { useRetainedValue } from "@/shared/hooks/useRetainedValue";
import styles from "./OverviewBoardPage.module.css";

const QUALITY_WINDOW_SIZE = 3;
const QUALITY_ROTATION_MS = 12_000;
const MACHINE_WINDOW_SIZE = 3;
const MACHINE_ROTATION_MS = 10_000;
const ATTENTION_WINDOW_SIZE = 3;
const ATTENTION_ROTATION_MS = 10_000;
const OUTBOUND_PRIORITY_ROTATION_MS = 9_000;
const MACHINE_TONNAGE_BY_NUMBER: Readonly<Record<number, string>> = {
  1: "850T", 2: "850T", 3: "1300T", 4: "1400T", 5: "1400T", 6: "2500T",
  7: "1800T", 8: "850T", 9: "850T", 10: "650T", 11: "550T", 12: "550T",
  13: "450T", 14: "850T", 15: "650T", 16: "1050T", 17: "1200T",
};

const ONE_ROW_ROLL_VARIANTS = {
  enter: (direction: number) => ({ y: direction > 0 ? "calc(33.333% + 0.113rem)" : "calc(-33.333% - 0.113rem)" }),
  center: { y: "0%" },
  exit: (direction: number) => ({ y: direction > 0 ? "calc(-33.333% - 0.113rem)" : "calc(33.333% + 0.113rem)" }),
};

const COPY = {
  ko: {
    title: "WJ 통합 운영 센터",
    titleToggle: "중국어로 전환",
    languageChanged: "언어가 한국어에서 중국어로 변경되었습니다.",
    enterFullscreen: "전체 화면 보기",
    exitFullscreen: "전체 화면 종료",
    fullscreenUnavailable: "이 브라우저에서는 전체 화면을 지원하지 않습니다.",
    refreshBoard: "새로고침",
    refreshingBoard: "새로고침 중",
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
    equipmentRotationHint: "설비별 현재 생산",
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
    inventory: "출고 실행 · JIT / CSKD",
    outboundToday: "오늘 출고단 상세",
    outboundActualTarget: "실적 / 목표",
    outboundDetailBasis: "목표=应发(계획) · 실적=实发(누적)",
    outboundPendingItems: "미출고",
    outboundRemainingQuantity: "잔량",
    outboundOverQuantity: "초과",
    outboundPriorityModel: "우선",
    outboundNoPending: "미출고 품목 없음",
    outboundDetailUnavailable: "상세 미수신",
    previousWeek: "지난주",
    previousMonth: "지난달",
    completedPeriod: "현재 누적 기준",
    outboundOrders: "출고지시",
    outboundLines: "품목",
    outboundNoPlan: "계획 없음",
    outboundConnected: "MES 연동",
    outboundPartial: "일부 수신",
    outboundUnavailable: "MES 출고계획 연결 필요",
    outboundUnavailableDescription: "목표와 실적은 연결 후 표시됩니다. 미수신 값을 0으로 표시하지 않습니다.",
    outboundMeasurementBasis: "출고단 계획시간 기준 · 목표=应发 · 실적=누적 实发 · EA",
    outboundExcluded: "집계 제외 {count}행",
    outboundUnclassified: "미분류 {count}건",
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
    moulds: "금형 / 유지보수",
    managedMoulds: "금형 관리 수",
    mountedMoulds: "장착 금형",
    storedMoulds: "보관",
    maintenanceMoulds: "보전",
    repairMoulds: "수리",
    offsiteMoulds: "외부",
    mouldStatusMix: "금형 상태 구성",
    confirmationRequired: "확인 필요",
    mouldHighlights: "특기 사항",
    shotInspection: "샷수 점검",
    maintenanceInProgress: "유지보수 중",
    unknownMoulds: "미확인",
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
    enterFullscreen: "全屏查看",
    exitFullscreen: "退出全屏",
    fullscreenUnavailable: "此浏览器不支持全屏显示。",
    refreshBoard: "刷新",
    refreshingBoard: "正在刷新",
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
    equipmentRotationHint: "各设备当前生产",
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
    inventory: "出库执行 · JIT / CSKD",
    outboundToday: "今日出库单明细",
    outboundActualTarget: "实发 / 应发",
    outboundDetailBasis: "目标=应发 · 实绩=累计实发",
    outboundPendingItems: "待出库",
    outboundRemainingQuantity: "剩余",
    outboundOverQuantity: "超发",
    outboundPriorityModel: "优先",
    outboundNoPending: "无待出库物料",
    outboundDetailUnavailable: "明细未接收",
    previousWeek: "上周",
    previousMonth: "上月",
    completedPeriod: "当前累计口径",
    outboundOrders: "出库单",
    outboundLines: "物料行",
    outboundNoPlan: "无计划",
    outboundConnected: "MES 已连接",
    outboundPartial: "部分接收",
    outboundUnavailable: "需要连接 MES 出库计划",
    outboundUnavailableDescription: "连接后显示目标和实绩，未接收的数据不会显示为零。",
    outboundMeasurementBasis: "按出库单计划时间 · 目标=应发 · 实绩=累计实发 · 仅 EA",
    outboundExcluded: "排除 {count} 行",
    outboundUnclassified: "未分类 {count} 单",
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
    moulds: "模具 / 维护",
    managedMoulds: "模具管理数",
    mountedMoulds: "已安装模具",
    storedMoulds: "在库",
    maintenanceMoulds: "保养",
    repairMoulds: "维修",
    offsiteMoulds: "外部",
    mouldStatusMix: "模具状态构成",
    confirmationRequired: "需要确认",
    mouldHighlights: "重点事项",
    shotInspection: "模次检查",
    maintenanceInProgress: "维护中",
    unknownMoulds: "未确认",
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

function getCircularWindow<T>(items: readonly T[], startIndex: number, windowSize: number): T[] {
  if (items.length <= windowSize) return [...items];
  return Array.from(
    { length: windowSize },
    (_, offset) => items[(startIndex + offset) % items.length],
  );
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
      <header className={`${styles.productionHeading} ${styles.standardPanelHeading}`}>
        <div className={styles.cardTitle}>
          {isInjection ? <Factory aria-hidden="true" /> : <Workflow aria-hidden="true" />}
          <h2 id={`${kind}-production-title`}>{isInjection ? copy.injectionProduction : copy.assemblyProduction}</h2>
        </div>
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

function getMachineIdentity(row: InjectionEquipmentRow, language: AppLanguage) {
  const rawLabel = row.label.trim();
  const tonnageMatch = rawLabel.match(/(\d{2,5})\s*T\b/i);
  const machineNumber = row.machineNumber ?? (() => {
    const machineNumberMatch = rawLabel.match(/(?:^|[-#\s])0*(\d{1,2})\s*(?:호기|号机)?$/i)
      ?? rawLabel.match(/^[IM][-\s]?0*(\d{1,2})$/i);
    if (!machineNumberMatch) return null;
    const parsed = Number(machineNumberMatch[1]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  })();
  const tonnageLabel = tonnageMatch
    ? `${tonnageMatch[1]}T`
    : machineNumber === null
      ? null
      : MACHINE_TONNAGE_BY_NUMBER[machineNumber] ?? null;

  return {
    machineLabel: machineNumber === null
      ? rawLabel || "—"
      : language === "ko"
        ? `${machineNumber}호기`
        : `${machineNumber}号机`,
    tonnageLabel,
  };
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
  const modelLabel = [primaryPart?.modelName, primaryPart?.partName, row.currentModels[0]]
    .find((value) => value && !["-", "—"].includes(value.trim()))
    ?.trim() ?? null;
  const primaryPartNumber = primaryPart?.partNumber?.trim();
  const partNumberLabel = primaryPartNumber
    && !["-", "—"].includes(primaryPartNumber)
    && primaryPartNumber !== modelLabel
    ? primaryPartNumber
    : null;
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
  const machineIdentity = getMachineIdentity(row, language);

  return (
    <article className={`${styles.machineRow} ${stateTone}`} title={row.stateReason ?? undefined}>
      <div className={styles.machineIdentity}>
        <div className={styles.machineIdentityName} title={row.label}>
          <strong>{machineIdentity.machineLabel}</strong>
          {machineIdentity.tonnageLabel ? <small>{machineIdentity.tonnageLabel}</small> : null}
        </div>
        <span><i aria-hidden="true" />{getMachineStateLabel(row, language)}</span>
        {isStale ? <small><AlertTriangle aria-hidden="true" />{copy.machineSourceStale}</small> : null}
      </div>
      <div className={styles.machineProduct}>
        <small>{copy.currentProduct}</small>
        <strong title={modelLabel ?? copy.productUnconfirmed}>{modelLabel ?? copy.productUnconfirmed}</strong>
        {partNumberLabel ? <span title={partNumberLabel}>{partNumberLabel}</span> : null}
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
  const [startIndex, setStartIndex] = useState(0);
  const [rollDirection, setRollDirection] = useState(1);
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const [interactionPaused, setInteractionPaused] = useState(false);
  const rows = useMemo(() => [...model.equipment.injectionRows], [model.equipment.injectionRows]);
  const visibleRows = useMemo(
    () => getCircularWindow(rows, startIndex, MACHINE_WINDOW_SIZE),
    [rows, startIndex],
  );
  const positionCount = rows.length > MACHINE_WINDOW_SIZE ? rows.length : 1;
  const canRotate = positionCount > 1;
  const autoPaused = reducedMotion || manuallyPaused || interactionPaused || !canRotate;
  const summary = model.equipment.injectionOee;
  const runningCount = summary.runningMachineCount ?? rows.filter((row) => row.isRunning).length;
  const totalCount = summary.totalEquipmentCount ?? rows.length;

  useEffect(() => setStartIndex(0), [model.businessDate, rows.length, language]);

  useEffect(() => {
    if (autoPaused) return;
    const timer = window.setInterval(() => {
      setRollDirection(1);
      setStartIndex((current) => (current + 1) % positionCount);
    }, MACHINE_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [autoPaused, positionCount]);

  const moveWindow = (step: number) => {
    setRollDirection(step >= 0 ? 1 : -1);
    setStartIndex((current) => (current + step + positionCount) % positionCount);
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
      <header className={`${styles.equipmentHeading} ${styles.standardPanelHeading}`}>
        <div className={styles.cardTitle}><Factory aria-hidden="true" /><h2 id="equipment-title">{copy.equipment}</h2></div>
        <div>
          <span>{copy.equipmentRotationHint}</span>
          <strong><i aria-hidden="true" />{copy.runningMachines} {formatInteger(runningCount, language)} / {formatInteger(totalCount, language)}</strong>
        </div>
      </header>
      <div className={styles.machineViewport}>
        <AnimatePresence custom={rollDirection} initial={false} mode="sync">
          <motion.div
            animate="center"
            className={styles.machineBody}
            custom={rollDirection}
            exit={reducedMotion ? undefined : "exit"}
            initial={reducedMotion ? false : "enter"}
            key={`${startIndex}-${language}`}
            transition={{ duration: reducedMotion ? 0 : 0.52, ease: [0.22, 1, 0.36, 1] }}
            variants={ONE_ROW_ROLL_VARIANTS}
          >
            {visibleRows.length > 0
              ? visibleRows.map((row) => (
                  <MachineProductionRow
                    businessTimeProgress={model.processes.injection.timeProgressRate}
                    key={row.id}
                    language={language}
                    row={row}
                  />
                ))
              : <p className={styles.panelEmpty}>—</p>}
          </motion.div>
        </AnimatePresence>
      </div>
      <footer className={styles.machineControls}>
        <button aria-label={copy.previousMachinePage} disabled={!canRotate} onClick={() => moveWindow(-1)} type="button"><ChevronLeft aria-hidden="true" /></button>
        <span>{startIndex + 1} / {positionCount} · {copy.machineCount.replace("{count}", String(rows.length))}</span>
        <button
          aria-label={manuallyPaused ? copy.resumeMachineRotation : copy.pauseMachineRotation}
          aria-pressed={manuallyPaused}
          disabled={reducedMotion || !canRotate}
          onClick={() => setManuallyPaused((current) => !current)}
          type="button"
        >
          {manuallyPaused || reducedMotion ? <CirclePlay aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
        </button>
        <button aria-label={copy.nextMachinePage} disabled={!canRotate} onClick={() => moveWindow(1)} type="button"><ChevronRight aria-hidden="true" /></button>
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
  const reducedMotion = usePrefersReducedMotion();
  const [startIndex, setStartIndex] = useState(0);
  const [rollDirection, setRollDirection] = useState(1);
  const [interactionPaused, setInteractionPaused] = useState(false);
  const attentionItems = useMemo(() => [...model.attention], [model.attention]);
  const visibleItems = useMemo(
    () => getCircularWindow(attentionItems, startIndex, ATTENTION_WINDOW_SIZE),
    [attentionItems, startIndex],
  );
  const positionCount = attentionItems.length > ATTENTION_WINDOW_SIZE ? attentionItems.length : 1;
  const autoPaused = reducedMotion || interactionPaused || positionCount <= 1;
  const injectionPace = getProcessPace(model.processes.injection);
  const assemblyPace = getProcessPace(model.processes.assembly);

  useEffect(() => setStartIndex(0), [model.businessDate, attentionItems.length, language]);

  useEffect(() => {
    if (autoPaused) return;
    const timer = window.setInterval(() => {
      setRollDirection(1);
      setStartIndex((current) => (current + 1) % positionCount);
    }, ATTENTION_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [autoPaused, positionCount]);

  return (
    <section
      className={`${styles.card} ${styles.operationsCard}`}
      aria-labelledby="operations-title"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInteractionPaused(false);
      }}
      onFocusCapture={() => setInteractionPaused(true)}
      onMouseEnter={() => setInteractionPaused(true)}
      onMouseLeave={() => setInteractionPaused(false)}
    >
      <div className={`${styles.operationsHeading} ${styles.standardPanelHeading}`}>
        <div className={styles.cardTitle}><Gauge aria-hidden="true" /><h2 id="operations-title">{copy.operations}</h2></div>
      </div>
      <div className={styles.attentionViewport}>
        <AnimatePresence custom={rollDirection} initial={false} mode="sync">
          <motion.div
            animate="center"
            className={styles.attentionList}
            custom={rollDirection}
            exit={reducedMotion ? undefined : "exit"}
            initial={reducedMotion ? false : "enter"}
            key={`${startIndex}-${language}`}
            transition={{ duration: reducedMotion ? 0 : 0.52, ease: [0.22, 1, 0.36, 1] }}
            variants={ONE_ROW_ROLL_VARIANTS}
          >
            {visibleItems.length > 0 ? visibleItems.map((item) => (
              <article className={styles.attentionRow} key={item.id}>
                <strong className={styles.attentionRank}>{item.rank}</strong>
                <span className={styles.attentionIcon}><AttentionIcon category={item.category} /></span>
                <p><strong>{item.summary}</strong>{item.action ? <span> · {item.action}</span> : null}</p>
                <small>{copy.attention}</small>
              </article>
            )) : <p className={styles.panelEmpty}>{copy.noAttentionData}</p>}
          </motion.div>
        </AnimatePresence>
      </div>
      <div className={styles.operationsPulse}>
        <article className={injectionPace.status === "behind" ? styles.pulseAttention : ""}><Factory aria-hidden="true" /><span>{copy.injectionPace}</span><strong>{formatSignedPercentPoints(injectionPace.gap)}</strong></article>
        <article className={assemblyPace.status === "behind" ? styles.pulseAttention : ""}><Workflow aria-hidden="true" /><span>{copy.assemblyPace}</span><strong>{formatSignedPercentPoints(assemblyPace.gap)}</strong></article>
        <article className={styles.pulseAttention}><TrendingDown aria-hidden="true" /><span>{copy.behindMachines}</span><strong>{formatInteger(model.equipment.injectionOee.behindMachineCount, language)}</strong></article>
        <article className={model.equipment.injectionOee.unplannedMachineCount ? styles.pulseAttention : ""}><AlertTriangle aria-hidden="true" /><span>{copy.unplannedActive}</span><strong>{formatInteger(model.equipment.injectionOee.unplannedMachineCount, language)}</strong></article>
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
  const [startIndex, setStartIndex] = useState(0);
  const [rollDirection, setRollDirection] = useState(1);
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const [interactionPaused, setInteractionPaused] = useState(false);
  const qualityItems = useMemo(() => [...model.quality.items], [model.quality.items]);
  const visibleItems = useMemo(
    () => getCircularWindow(qualityItems, startIndex, QUALITY_WINDOW_SIZE),
    [qualityItems, startIndex],
  );
  const positionCount = qualityItems.length > QUALITY_WINDOW_SIZE ? qualityItems.length : 1;
  const canRotate = positionCount > 1;
  const autoPaused = reducedMotion || manuallyPaused || interactionPaused || !canRotate;

  useEffect(() => setStartIndex(0), [model.businessDate, qualityItems.length, language]);

  useEffect(() => {
    if (autoPaused) return;
    const timer = window.setInterval(() => {
      setRollDirection(1);
      setStartIndex((current) => (current + 1) % positionCount);
    }, QUALITY_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [autoPaused, positionCount]);

  const moveWindow = (step: number) => {
    setRollDirection(step >= 0 ? 1 : -1);
    setStartIndex((current) => (current + step + positionCount) % positionCount);
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
      <header className={`${styles.qualityHeading} ${styles.standardPanelHeading}`}>
        <div className={styles.cardTitle}><ShieldCheck aria-hidden="true" /><h2 id="quality-title">{copy.quality}</h2></div>
        <span><CheckCircle2 aria-hidden="true" />{model.quality.disclaimer ?? copy.historicalDisclaimer}</span>
      </header>
      <div className={styles.qualityViewport}>
        <AnimatePresence custom={rollDirection} initial={false} mode="sync">
          <motion.div
            animate="center"
            className={styles.qualityBody}
            custom={rollDirection}
            exit={reducedMotion ? undefined : "exit"}
            initial={reducedMotion ? false : "enter"}
            key={`${startIndex}-${language}`}
            transition={{ duration: reducedMotion ? 0 : 0.56, ease: [0.22, 1, 0.36, 1] }}
            variants={ONE_ROW_ROLL_VARIANTS}
          >
            {visibleItems.length > 0
              ? visibleItems.map((item) => (
                  <QualityRow historyWindowDays={model.quality.historyWindowDays} item={item} key={item.id} language={language} />
                ))
              : <p className={styles.panelEmpty}>{copy.noQualityData}</p>}
          </motion.div>
        </AnimatePresence>
      </div>
      <footer className={styles.qualityControls}>
        <button aria-label={copy.previousQualityPage} disabled={!canRotate} onClick={() => moveWindow(-1)} type="button"><ChevronLeft aria-hidden="true" /></button>
        <span>{startIndex + 1} / {positionCount}</span>
        <button
          aria-label={manuallyPaused ? copy.resumeRotation : copy.pauseRotation}
          aria-pressed={manuallyPaused}
          disabled={reducedMotion || !canRotate}
          onClick={() => setManuallyPaused((current) => !current)}
          type="button"
        >
          {manuallyPaused || reducedMotion ? <CirclePlay aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
        </button>
        <button aria-label={copy.nextQualityPage} disabled={!canRotate} onClick={() => moveWindow(1)} type="button"><ChevronRight aria-hidden="true" /></button>
      </footer>
    </section>
  );
}

function OutboundTodayLane({
  code,
  metric,
  detail,
  priorityItem,
  language,
}: {
  code: "JIT" | "CSKD";
  metric: OutboundPerformanceMetric;
  detail: OutboundTodayDetailSummary;
  priorityItem: OutboundPriorityItem | null;
  language: AppLanguage;
}) {
  const copy = COPY[language];
  const noPlan = metric.targetQuantity === 0;
  const progressWidth = metric.completionRate === null ? 0 : Math.max(0, Math.min(100, metric.completionRate));
  const quantityUnit = metric.unit ?? "EA";
  const priority = priorityItem ?? detail.largestPending;
  const detailAvailable = detail.pendingLineCount !== null || detail.remainingQuantity !== null;
  const detailUnit = detail.unit ?? priority?.unit ?? quantityUnit;
  const priorityDescription = priority
    ? [priority.materialName, priority.specification]
        .find((value) => Boolean(value && value !== priority.materialCode)) ?? null
    : null;
  const laneTitle = [
    `${copy.outboundOrders} ${formatInteger(metric.orderCount, language)}`,
    `${copy.outboundLines} ${formatInteger(metric.lineCount, language)}`,
    priority?.outboundOrderCode,
    priority?.materialCode,
    priorityDescription,
  ].filter(Boolean).join(" · ");
  return (
    <article className={`${styles.outboundLane} ${code === "CSKD" ? styles.cskdLane : ""}`} title={laneTitle}>
      <b className={styles.outboundCode}>{code}<small>{formatInteger(metric.orderCount, language)} {language === "ko" ? "단" : "单"}</small></b>
      <div className={styles.outboundLaneValue}>
        <span>{copy.outboundActualTarget}</span>
        <strong>{formatInteger(metric.fulfilledQuantity, language)}<small>/ {formatInteger(metric.targetQuantity, language)} {quantityUnit}</small></strong>
      </div>
      <div className={styles.outboundLaneMeta}>
        {detailAvailable ? (
          <>
            <span><b>{copy.outboundPendingItems}</b> {formatInteger(detail.pendingLineCount, language)}{language === "ko" ? "품목" : "行"}</span>
            <span><b>{copy.outboundRemainingQuantity}</b> <strong>{formatInteger(detail.remainingQuantity, language)} {detailUnit}</strong></span>
            {detail.overLineCount !== null && detail.overLineCount > 0
              ? <span className={styles.outboundOverMeta}><b>{copy.outboundOverQuantity}</b> {formatInteger(detail.overLineCount, language)} / +{formatInteger(detail.overQuantity, language)}</span>
              : null}
          </>
        ) : <span>{copy.outboundDetailUnavailable}</span>}
      </div>
      <div className={`${styles.outboundPriority} ${priority ? "" : styles.outboundPriorityEmpty}`}>
        {priority ? (
          <>
            <span>{copy.outboundPriorityModel} {formatShanghaiTime(priority.planTime)}</span>
            <strong>{priority.materialCode}</strong>
            <em>{priorityDescription ?? ""}</em>
            <b aria-label={copy.outboundActualTarget} title={copy.outboundActualTarget}>{formatInteger(priority.fulfilledQuantity, language)}<small>/ {formatInteger(priority.targetQuantity, language)} {priority.unit ?? detailUnit}</small></b>
            <i>{copy.outboundRemainingQuantity} {formatInteger(priority.remainingQuantity, language)}</i>
          </>
        ) : <span>{detailAvailable && detail.pendingLineCount === 0 ? copy.outboundNoPending : copy.outboundDetailUnavailable}</span>}
      </div>
      <em className={styles.outboundRate}>{noPlan ? copy.outboundNoPlan : formatPercent(metric.completionRate)}</em>
      <div
        aria-label={`${code} ${copy.completion}`}
        aria-valuemax={Math.max(100, metric.completionRate ?? 100)}
        aria-valuemin={0}
        aria-valuenow={metric.completionRate ?? undefined}
        aria-valuetext={noPlan ? copy.outboundNoPlan : formatPercent(metric.completionRate)}
        className={styles.outboundProgress}
        role="progressbar"
      >
        <span style={{ width: `${progressWidth}%` }} />
      </div>
    </article>
  );
}

function OutboundPeriodComparison({
  label,
  period,
  language,
}: {
  label: string;
  period: OutboundPerformancePeriod;
  language: AppLanguage;
}) {
  const copy = COPY[language];
  return (
    <article className={styles.outboundPeriod}>
      <header><strong>{period.label ?? label}</strong><span>{copy.completedPeriod}</span></header>
      {(["JIT", "CSKD"] as const).map((code) => {
        const metric = code === "JIT" ? period.jit : period.cskd;
        return (
          <div key={code}>
            <b>{code}</b>
            <strong>{metric.targetQuantity === 0 ? copy.outboundNoPlan : formatPercent(metric.completionRate)}</strong>
            <span>{formatInteger(metric.fulfilledQuantity, language)} / {formatInteger(metric.targetQuantity, language)}</span>
          </div>
        );
      })}
    </article>
  );
}

function InventoryPanel({ model, language }: { model: OverviewBoardModel; language: AppLanguage }) {
  const copy = COPY[language];
  const outbound = model.inventory.outboundPerformance;
  const reducedMotion = usePrefersReducedMotion();
  const [priorityIndex, setPriorityIndex] = useState(0);
  const pendingPriorityItems = useMemo(() => ({
    jit: outbound.todayPriorityItems.filter((item) => item.category === "JIT" && item.fulfillmentState === "pending"),
    cskd: outbound.todayPriorityItems.filter((item) => item.category === "CSKD" && item.fulfillmentState === "pending"),
  }), [outbound.todayPriorityItems]);
  const priorityPageCount = Math.max(pendingPriorityItems.jit.length, pendingPriorityItems.cskd.length);
  useEffect(() => {
    setPriorityIndex(0);
  }, [outbound.fetchedAt]);
  useEffect(() => {
    if (reducedMotion || priorityPageCount <= 1) return undefined;
    const timer = window.setInterval(() => {
      setPriorityIndex((current) => (current + 1) % priorityPageCount);
    }, OUTBOUND_PRIORITY_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [priorityPageCount, reducedMotion]);
  const isUnavailable = outbound.status === "unavailable";
  const measurementDetails = outbound.measurementBasis
    ? Object.values(outbound.measurementBasis).filter((value): value is string => Boolean(value)).join(" · ")
    : copy.outboundMeasurementBasis;
  const unclassifiedOrders = outbound.unclassified.orderCount;
  const excludedLineCount = outbound.excludedLineCount;
  const exclusionDetails = Object.entries(outbound.exclusionsByReason)
    .map(([reason, count]) => `${reason}: ${formatInteger(count, language)}`)
    .join(" · ");
  return (
    <section className={`${styles.card} ${styles.inventoryCard}`} aria-labelledby="inventory-title" data-testid="outbound-performance-card">
      <header className={`${styles.inventoryHeading} ${styles.standardPanelHeading}`}>
        <div className={styles.cardTitle}><ArrowUpFromLine aria-hidden="true" /><h2 id="inventory-title">{copy.inventory}</h2></div>
        <span className={`${styles.outboundStatus} ${outbound.status === "partial" ? styles.outboundStatusPartial : ""} ${isUnavailable ? styles.outboundStatusUnavailable : ""}`}>
          {isUnavailable ? copy.disconnected : outbound.status === "partial" ? copy.outboundPartial : copy.outboundConnected}
        </span>
      </header>
      <div className={`${styles.outboundContent} ${isUnavailable ? styles.outboundContentUnavailable : ""}`}>
        {isUnavailable ? (
          <div className={styles.outboundUnavailable}>
            <AlertTriangle aria-hidden="true" />
            <div><strong>{copy.outboundUnavailable}</strong><span>{copy.outboundUnavailableDescription}</span></div>
          </div>
        ) : (
          <>
          <div className={styles.outboundToday}>
            <div className={styles.outboundSectionLabel}><strong>{copy.outboundToday}</strong><span>{copy.outboundDetailBasis}</span></div>
            <OutboundTodayLane
              code="JIT"
              detail={outbound.todayDetailSummary.jit}
              language={language}
              metric={outbound.periods.today.jit}
              priorityItem={pendingPriorityItems.jit.length > 0
                ? pendingPriorityItems.jit[priorityIndex % pendingPriorityItems.jit.length]
                : null}
            />
            <OutboundTodayLane
              code="CSKD"
              detail={outbound.todayDetailSummary.cskd}
              language={language}
              metric={outbound.periods.today.cskd}
              priorityItem={pendingPriorityItems.cskd.length > 0
                ? pendingPriorityItems.cskd[priorityIndex % pendingPriorityItems.cskd.length]
                : null}
            />
          </div>
          <div className={styles.outboundComparisons}>
            <OutboundPeriodComparison label={copy.previousWeek} language={language} period={outbound.periods.previousWeek} />
            <OutboundPeriodComparison label={copy.previousMonth} language={language} period={outbound.periods.previousMonth} />
          </div>
          </>
        )}
      </div>
      <footer className={styles.outboundFooter} title={measurementDetails}>
        <span>{copy.outboundMeasurementBasis}</span>
        <div>
          {unclassifiedOrders !== null && unclassifiedOrders > 0
            ? <em>{copy.outboundUnclassified.replace("{count}", formatInteger(unclassifiedOrders, language))}</em>
            : null}
          {excludedLineCount !== null && excludedLineCount > 0
            ? <em title={exclusionDetails || undefined}>{copy.outboundExcluded.replace("{count}", formatInteger(excludedLineCount, language))}</em>
            : null}
          {outbound.warnings.length > 0 ? <em title={outbound.warnings.join(" · ")}><AlertTriangle aria-hidden="true" />{outbound.warnings.length}</em> : null}
        </div>
      </footer>
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
      <header className={`${styles.cardTitle} ${styles.standardPanelHeading}`}><Zap aria-hidden="true" /><h2 id="energy-title">{copy.energy}</h2></header>
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
              <ComposedChart data={chartData} margin={{ top: 0, right: 4, bottom: -8, left: -12 }}>
                <CartesianGrid stroke="#dce5ee" strokeDasharray="3 5" vertical={false} />
                <XAxis axisLine={{ stroke: "#9eb0c7" }} dataKey="label" fontSize="0.56rem" interval={3} tickLine={false} />
                <YAxis axisLine={false} domain={[0, "auto"]} fontSize="0.56rem" tickLine={false} width={38} />
                <Tooltip formatter={(value, name) => [`${formatDecimal(Number(value), 1)} kWh`, name]} />
                <Legend align="right" height={18} iconSize={8} verticalAlign="top" wrapperStyle={{ fontSize: "0.54rem" }} />
                <Bar barSize={9} dataKey="usageKwh" fill="#8db7df" isAnimationActive={false} name={copy.hourlyEnergy} radius={[3, 3, 0, 0]} />
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
  const maintenanceInProgress = model.moulds.maintenance === null && model.moulds.repair === null
    ? null
    : (model.moulds.maintenance ?? 0) + (model.moulds.repair ?? 0);
  const statusRows = [
    { key: "stored", label: copy.storedMoulds, value: model.moulds.stored, icon: PackageOpen },
    { key: "mounted", label: copy.mountedMoulds, value: model.moulds.mounted, icon: Gauge },
    { key: "offsite", label: copy.offsiteMoulds, value: model.moulds.offsite, icon: MapPin },
  ];
  const distributionRows = [
    { key: "stored", label: copy.storedMoulds, value: model.moulds.stored, color: "#1765b2" },
    { key: "mounted", label: copy.mountedMoulds, value: model.moulds.mounted, color: "#0a8a57" },
    { key: "offsite", label: copy.offsiteMoulds, value: model.moulds.offsite, color: "#7b6fa9" },
    { key: "maintenance", label: copy.maintenanceInProgress, value: maintenanceInProgress, color: "#d88718" },
    { key: "unknown", label: copy.unknownMoulds, value: model.moulds.unknown, color: "#91a1b2" },
  ].filter((row) => row.value !== null && row.value > 0);
  const distributionTotal = distributionRows.reduce((sum, row) => sum + (row.value ?? 0), 0);
  return (
    <section className={`${styles.card} ${styles.mouldCard}`} aria-labelledby="mould-title">
      <header className={`${styles.mouldHeading} ${styles.standardPanelHeading}`}>
        <div className={styles.cardTitle}><Wrench aria-hidden="true" /><h2 id="mould-title">{copy.moulds}</h2></div>
        <span>{copy.managedMoulds} <strong>{formatInteger(model.moulds.total, language)}</strong></span>
      </header>
      <div className={styles.mouldSimpleBody}>
        <div className={styles.mouldStatusSummary}>
          {statusRows.map((row) => {
            const Icon = row.icon;
            return <article key={row.key}><Icon aria-hidden="true" /><span>{row.label}</span><strong>{formatInteger(row.value, language)}</strong></article>;
          })}
        </div>
        <div className={styles.mouldDistribution}>
          <div>
            <span>{copy.mouldStatusMix}</span>
            <div>
              {distributionRows.map((row) => <small key={row.key}><i style={{ backgroundColor: row.color }} />{row.label}</small>)}
            </div>
          </div>
          <div aria-label={`${copy.mouldStatusMix} ${distributionRows.map((row) => `${row.label} ${formatInteger(row.value, language)}`).join(", ")}`} className={styles.mouldDistributionBar} role="img">
            {distributionRows.map((row) => (
              <i
                key={row.key}
                style={{ backgroundColor: row.color, width: distributionTotal > 0 ? `${((row.value ?? 0) / distributionTotal) * 100}%` : "0%" }}
                title={`${row.label} ${formatInteger(row.value, language)}`}
              />
            ))}
          </div>
        </div>
        <div className={styles.mouldHighlights}>
          <span>{copy.mouldHighlights}</span>
          <div>
            <article title={copy.confirmationRequired}><Gauge aria-hidden="true" /><span>{copy.shotInspection}</span><strong>{formatInteger(model.moulds.confirmationRequired, language)}</strong></article>
            <article title={`${copy.maintenanceMoulds} ${formatInteger(model.moulds.maintenance, language)} · ${copy.repairMoulds} ${formatInteger(model.moulds.repair, language)}`}><Wrench aria-hidden="true" /><span>{copy.maintenanceInProgress}</span><strong>{formatInteger(maintenanceInProgress, language)}</strong></article>
          </div>
        </div>
      </div>
    </section>
  );
}

function HeaderPanel({
  model,
  language,
  mode,
  isRefreshing,
  onRefresh,
  onToggleLanguage,
}: {
  model: OverviewBoardModel;
  language: AppLanguage;
  mode: "live" | "demo";
  isRefreshing: boolean;
  onRefresh: () => void;
  onToggleLanguage: () => void;
}) {
  const copy = COPY[language];
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));
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
  const fullscreenSupported = typeof document.documentElement.requestFullscreen === "function";
  const fullscreenLabel = isFullscreen ? copy.exitFullscreen : copy.enterFullscreen;

  useEffect(() => {
    const syncFullscreenState = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (fullscreenSupported) {
        try {
          await document.documentElement.requestFullscreen({ navigationUI: "hide" });
        } catch {
          await document.documentElement.requestFullscreen();
        }
      }
    } catch {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
  };

  return (
    <header className={`${styles.card} ${styles.headerCard}`}>
      <div className={styles.brandRow}>
        <img alt="WJ" src="/logo-transparent.png" />
        <h1>
          <button aria-label={copy.titleToggle} className={styles.titleButton} onClick={onToggleLanguage} type="button">
            <strong>{copy.title}</strong>
          </button>
        </h1>
        <div className={styles.headerActions}>
          <button
            aria-label={fullscreenSupported ? fullscreenLabel : copy.fullscreenUnavailable}
            aria-pressed={isFullscreen}
            disabled={!fullscreenSupported}
            onClick={() => void toggleFullscreen()}
            title={fullscreenSupported ? fullscreenLabel : copy.fullscreenUnavailable}
            type="button"
          >
            {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>
          <button
            aria-busy={isRefreshing}
            aria-label={isRefreshing ? copy.refreshingBoard : copy.refreshBoard}
            disabled={isRefreshing}
            onClick={onRefresh}
            title={isRefreshing ? copy.refreshingBoard : copy.refreshBoard}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={isRefreshing ? styles.refreshingIcon : undefined} />
          </button>
        </div>
        {mode === "demo" ? <div className={styles.demoBadge}><Radio aria-hidden="true" />{copy.demo}</div> : null}
      </div>
      <div className={styles.headerContent}>
        <div className={styles.headerHero}>
          <div className={styles.brandSummary}>
            <p className={styles.businessDate}><CalendarDays aria-hidden="true" />{formatBusinessDate(model.businessDate, language)}</p>
            <div className={styles.headerPaceSummary}>
              <article className={injectionPace.status === "behind" ? styles.headerPaceAttention : ""}><Factory aria-hidden="true" /><span>{copy.injectionPace}</span><strong>{formatSignedPercentPoints(injectionPace.gap)}</strong></article>
              <article className={assemblyPace.status === "behind" ? styles.headerPaceAttention : ""}><Workflow aria-hidden="true" /><span>{copy.assemblyPace}</span><strong>{formatSignedPercentPoints(assemblyPace.gap)}</strong></article>
              <article><Factory aria-hidden="true" /><span>{copy.runningMachines}</span><strong>{formatInteger(model.equipment.injectionOee.runningMachineCount, language)} / {formatInteger(model.equipment.injectionOee.totalEquipmentCount, language)}</strong></article>
            </div>
          </div>
          <section className={`${styles.weatherCard} ${weather.isStale ? styles.weatherStale : ""}`} title={weather.isStale ? copy.weatherStale : weather.attribution}>
            <div className={styles.weatherPrimary}>
              <div className={styles.weatherIcon}><WeatherConditionIcon conditionCode={weather.conditionCode} /></div>
              <div className={styles.weatherIdentity}>
                <span><MapPin aria-hidden="true" />{copy.nanjingWeather}</span>
                <strong>{getWeatherConditionLabel(weather.conditionCode, language)}</strong>
              </div>
              <strong className={styles.weatherTemperature}>{weatherAvailable ? `${formatDecimal(weather.temperatureC, 1)}°C` : "—"}</strong>
            </div>
            <div className={styles.weatherMetrics}>
              <article><Droplets aria-hidden="true" /><span>{copy.humidity}</span><strong>{weather.relativeHumidityPercent === null ? "—" : `${formatDecimal(weather.relativeHumidityPercent, 0)}%`}</strong></article>
              <article><Wind aria-hidden="true" /><span>{copy.wind}</span><strong>{weather.windSpeedMps === null ? "—" : `${formatDecimal(weather.windSpeedMps, 1)} m/s`}</strong></article>
            </div>
            {weather.isStale ? <div className={styles.weatherSource}><em>{copy.weatherStale}</em></div> : null}
          </section>
        </div>
        <div className={styles.statusStrip}>
          <span><Clock3 aria-hidden="true" />{formatShanghaiTime(model.generatedAt)} {copy.generatedAt}</span>
          <span className={model.overallStatus === "normal" ? styles.normalStatus : styles.attentionStatus}><CheckCircle2 aria-hidden="true" />{copy.operatingStatus} <strong>{statusCopy}</strong></span>
          <span className={styles.attentionStatus}><AlertTriangle aria-hidden="true" />{copy.checks} <strong>{formatInteger(model.attention.length, language)}</strong></span>
          <span><ShieldCheck aria-hidden="true" />{copy.qualityHistoryCount} <strong>{formatInteger(model.quality.items.length, language)}</strong></span>
        </div>
        {freshnessLabel ? <small className={styles.freshness}><TimerReset aria-hidden="true" />{copy.sourceFreshness} · {freshnessLabel}</small> : null}
      </div>
    </header>
  );
}

export function OverviewBoardPage() {
  const [language, setLanguage] = useStoredLanguage();
  const [languageAnnouncement, setLanguageAnnouncement] = useState("");
  const businessDate = useShanghaiBusinessDate();
  const query = useQuery({
    queryKey: ["overview-board", businessDate, language],
    queryFn: () => getOverviewBoard(businessDate, language),
    refetchInterval: 60_000,
    staleTime: 45_000,
    placeholderData: (previousData) => previousData,
  });
  const visibleData = useRetainedValue(query.data);
  const copy = COPY[language];

  const toggleLanguage = () => {
    const nextLanguage = language === "ko" ? "zh" : "ko";
    setLanguageAnnouncement(copy.languageChanged);
    setLanguage(nextLanguage);
  };

  if (query.isPending && !visibleData) {
    return (
      <main className={styles.statePage} role="status">
        <img alt="WJ" src="/logo-transparent.png" />
        <span className={styles.stateSpinner} aria-hidden="true" />
        <p>{copy.loading}</p>
      </main>
    );
  }

  if (!visibleData) {
    return (
      <main className={styles.statePage} role="alert">
        <AlertTriangle aria-hidden="true" />
        <h1>{copy.dataUnavailable}</h1>
        <button onClick={() => void query.refetch()} type="button">{copy.retry}</button>
      </main>
    );
  }

  const { model, mode } = visibleData;
  return (
    <main className={styles.page} data-mode={mode} data-testid="overview-board-page">
      <ProductionCard kind="injection" language={language} process={model.processes.injection} />
      <HeaderPanel
        isRefreshing={query.isFetching}
        language={language}
        mode={mode}
        model={model}
        onRefresh={() => void query.refetch()}
        onToggleLanguage={toggleLanguage}
      />
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
