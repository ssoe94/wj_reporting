import { type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getInjectionProductionMatrix,
  getInjectionProductionMatrixForDate,
  type InjectionProductionMatrix,
  type TimeSlot,
} from "@/domains/mes/api";
import {
  askProductionAi,
  cancelAiJob,
  createMachiningManualReport,
  createAiJob,
  getAiJob,
  getMachiningProvision,
  getProductionAiBriefing,
  getProductionMesReportStats,
  getProductionPlanSummary,
  getProductionStatus,
  type MachiningProvisionResponse,
  type MachiningProvisionRow,
  type ProductionMesReportStatsResponse,
  type ProductionPlanRecord,
  type ProductionPlanSummaryResponse,
  type ProductionStatusResponse,
  type AiJob,
  type AiJobStatus,
} from "@/domains/production/api";
import { InjectionTransitionPanel } from "@/domains/production/components/InjectionTransitionPanel";
import {
  buildInjectionTransitionAnalysis,
  type InjectionTransitionAnalysis,
} from "@/domains/production/injection-transition-analysis";
import {
  buildRealtimeProgressSummary,
  type RealtimeProgressRow,
  type RealtimeProgressSegment,
  type RealtimeProgressSegmentStatus,
  type RealtimeProgressSummary,
} from "@/domains/production/realtime-progress";
import { PageHeader } from "@/shared/components/PageHeader";
import { StatCard } from "@/shared/components/StatCard";
import { type AppLanguage, useStoredLanguage } from "@/shared/i18n/language";
import { getShanghaiDateString } from "@/shared/utils/date";

type ProductionBriefContext = {
  businessDate: string;
  injectionPlanQty: number;
  machiningPlanQty: number;
  actualInjectionOutput: number;
  actualMachiningOutput: number;
  planGap: number;
  machiningPlanGap: number;
  activeMachineCount: number;
  runningMachineCount: number;
  totalMachines: number;
  topMachines: Array<{ machine: string; output: number }>;
  lowOutputMachines: Array<{ machine: string; output: number }>;
  latestUpdatedAt: string | null;
};

type MachiningProgressPreview = {
  plannedQty: number;
  actualQty: number;
  partCount: number;
  progressRate: number;
  completedCount: number;
  inProgressCount: number;
  pendingCount: number;
  rows: Array<{
    key: string;
    label: string;
    plannedQty: number;
    actualQty: number;
    gapQty: number;
    progressRate: number;
    completedCount: number;
    inProgressCount: number;
    pendingCount: number;
    mesQty: number;
    manualOpenQty: number;
    matchedManualQty: number;
    defectQty: number;
    status: MachiningProvisionRow["status"] | "legacy";
    provisionRow?: MachiningProvisionRow;
    segments: RealtimeProgressSegment[];
  }>;
};

type KpiDetailKey = "injection" | "machining" | "machines";

type CumulativeTrendPoint = {
  key: string;
  label: string;
  elapsedRate: number;
  actualQty: number;
  targetQty: number;
};

type CumulativeTrendSummary = {
  plannedQty: number;
  actualQty: number;
  completionRate: number;
  elapsedRate: number;
  latestPoint: CumulativeTrendPoint;
  points: CumulativeTrendPoint[];
  axisLabels: string[];
};

type MachineActivitySegment = {
  key: string;
  active: boolean;
  startPct: number;
  widthPct: number;
  output: number;
  estimatedQty: number;
  partNo?: string;
  partFamily?: string;
  partVariant?: string;
  partHue?: number;
  partLightness?: number;
  partSaturation?: number;
  density?: number;
};

type MachineActivityRow = {
  machineNumber: number;
  label: string;
  output: number;
  activeMinutes: number;
  isActive: boolean;
  segments: MachineActivitySegment[];
  slots: MachineActivitySlot[];
};

type MachineActivitySlot = {
  slotIndex: number;
  slotTime: Date;
  slotEnd: Date;
  intervalMinutes: number;
  output: number;
  estimatedQty: number;
  partNo?: string;
  partFamily?: string;
  partVariant?: string;
  partHue?: number;
  partLightness?: number;
  partSaturation?: number;
  cavity: number;
  active: boolean;
  displayActive: boolean;
};

type MachineActivitySelection = {
  origin: "timeline" | "utilization";
  startPct: number;
  endPct: number;
  isDragging: boolean;
  layerX: number;
  layerY: number;
  machineNumber?: number;
};

type ActivitySelectionSummary = {
  startLabel: string;
  endLabel: string;
  totalOutput: number;
  totalEstimatedQty: number;
  partRows: Array<{
    key: string;
    partNo: string;
    machineLabel: string;
    output: number;
    estimatedQty: number;
    partHue?: number;
    partLightness?: number;
    partSaturation?: number;
  }>;
  machineRows: Array<{
    key: string;
    machineLabel: string;
    output: number;
    estimatedQty: number;
  }>;
};

type MachineUtilizationPoint = {
  key: string;
  label: string;
  timestampMs: number;
  elapsedRate: number;
  utilizationRate: number;
  activeMachineCount: number;
};

type MachineActivitySummary = {
  totalMachines: number;
  activeMachineCount: number;
  utilizationScaleMin: number;
  utilizationScaleMax: number;
  utilizationAxisTicks: number[];
  averageUtilizationRate: number;
  averageActiveMachineCount: number;
  peakUtilizationRate: number;
  peakActiveMachineCount: number;
  peakPoint: MachineUtilizationPoint | null;
  currentUtilizationRate: number;
  currentActiveMachineCount: number;
  points: MachineUtilizationPoint[];
  movingAverageSeries: Array<{
    key: string;
    label: string;
    points: MachineUtilizationPoint[];
  }>;
  axisLabels: string[];
};

const pageCopy = {
  ko: {
    eyebrow: "Production",
    title: "생산 대시보드",
    description: "생산 계획과 MES 실적을 비교하고, 로컬 LLM으로 일일 생산 브리핑을 작성합니다.",
    loading: "생산 현황을 불러오는 중입니다.",
    productionDate: "기준일",
    productionDateHint: "오전 08:00 ~ 익일 08:00 기준",
    injectionActualPlan: "사출 계획 및 실행율",
    machiningActualPlan: "가공 실적 / 계획",
    completedRate: "완료",
    timeRate: "시간 기준",
    injectionFacilities: "사출기",
    machiningFacilities: "가공 라인",
    planOver: "계획 대비 초과",
    planShort: "계획 대비 부족",
    activeMachines: "기준일 가동 설비",
    todayActiveMachines: "기준일 실적 설비",
    recentRunning: "최근 60분 가동",
    localBrief: "AI BRIEFING",
    briefTitle: "일일 생산 브리핑",
    usedData: "사용한 데이터",
    calculationBasis: "계산 기준",
    deterministicBrief: "계산형 RAG 브리핑",
    askAi: "AI에게 질문하기",
    closeAi: "질문 닫기",
    runWorkerAnalysis: "로컬 AI 분석 실행",
    workerAnalysisRunning: "분석 작업 대기 중",
    workerJobTitle: "Mac Studio Worker 분석",
    workerJobStatus: "작업 상태",
    workerJobWaiting: "Mac Studio Worker가 작업을 가져가면 분석이 시작됩니다.",
    workerJobCancel: "작업 취소",
    workerJobResult: "분석 결과",
    workerJobIssue: "확인 이슈",
    workerJobNoIssue: "별도 이슈가 없습니다.",
    workerJobFallback: "로컬 LLM 응답 지연으로 계산 기반 분석을 표시합니다.",
    askingAi: "AI 답변 중",
    aiQuestionPlaceholder: "예: 오늘 계획 대비 가장 먼저 확인해야 할 사출기는 어디야?",
    aiAnswerTitle: "AI 답변",
    aiSubmit: "질문 보내기",
    llmError: "로컬 MLX LLM 서버에 연결하지 못했습니다. 현재는 데이터 기반 초안을 표시합니다.",
    progressEyebrow: "LIVE PROGRESS",
    progressTitle: "실시간 프로그레스",
    progressDescription: "사출은 생산 계획과 MES 형합수를 조합해 Cavity 기준 추정 생산량으로 진행률을 계산합니다.",
    injectionProgress: "사출 실시간 진행",
    machiningProgress: "가공 실시간 진행",
    planned: "계획",
    actualEstimate: "추정 생산",
    shotCount: "형합수",
    running: "가동",
    gap: "차이",
    overrun: "초과 생산",
    overrunShort: "초과",
    parts: "Part",
    cavity: "Cavity",
    completed: "완료",
    inProgress: "진행중",
    pending: "대기",
    currentPart: "현재",
    partProgress: "Part별 진행",
    totalProgress: "전체 진행률",
    detail: "상세",
    close: "닫기",
    machineDetailTitle: "사출기 진행 상세",
    sequence: "순서",
    model: "모델",
    lot: "Lot",
    progress: "진행률",
    completion: "완성도",
    estimatedVsPlan: "추정 / 계획",
    progressHint: "각 설비의 계획 순서대로 형합수를 배분해 완료/진행중/대기를 표시합니다.",
    noProgressRows: "계획 또는 MES 실적이 없습니다.",
    machiningPending: "Blacklake JG/加工 생산보고 수량을 계획 순서대로 배분해 진행률을 표시합니다.",
    machiningSupplementHint: "MES 실적을 우선하고, 누락된 선진행 생산만 수기 보정합니다.",
    mesQty: "MES",
    manualOpen: "MES 미등록 수기",
    manualMatched: "MES 확인 수기",
    effectiveQty: "보정 후",
    advanceQty: "선진행",
    manualReport: "수기 보정",
    manualReportTitle: "가공 수기 보정",
    goodQty: "양품 수량",
    defectQty: "불량 수량",
    defectType: "불량 유형",
    defectTypePlaceholder: "예: scratch",
    reasonCode: "보정 사유",
    reasonPlaceholder: "예: MES 작업지시 없음",
    note: "비고",
    saveManualReport: "보정 저장",
    savingManualReport: "저장 중",
    manualReportSaved: "수기 보정을 저장했습니다.",
    manualReportError: "수기 보정을 저장하지 못했습니다.",
    machineSummaryTitle: "기기 요약",
    workOrders: "작업지시",
    plannedOnly: "계획 수량 기준 준비",
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
    noTransitionEvents: "10분 이상 정지 후보가 없습니다.",
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
    rawTitle: "운영 API 확인",
  },
  zh: {
    eyebrow: "Production",
    title: "生产看板",
    description: "对比生产计划与 MES 实绩，并使用本地 LLM 生成每日生产简报。",
    loading: "正在读取生产现况。",
    productionDate: "基准日",
    productionDateHint: "上午 08:00 ~ 次日 08:00 基准",
    injectionActualPlan: "注塑计划及执行率",
    machiningActualPlan: "加工实绩 / 计划",
    completedRate: "完成",
    timeRate: "时间基准",
    injectionFacilities: "注塑机",
    machiningFacilities: "加工线",
    planOver: "较计划超出",
    planShort: "较计划不足",
    activeMachines: "基准日运行设备",
    todayActiveMachines: "基准日有实绩设备",
    recentRunning: "最近 60 分钟运行",
    localBrief: "AI BRIEFING",
    briefTitle: "每日生产简报",
    usedData: "使用的数据",
    calculationBasis: "计算基准",
    deterministicBrief: "计算型 RAG 简报",
    askAi: "向 AI 提问",
    closeAi: "关闭提问",
    runWorkerAnalysis: "运行本地 AI 分析",
    workerAnalysisRunning: "分析任务等待中",
    workerJobTitle: "Mac Studio Worker 分析",
    workerJobStatus: "任务状态",
    workerJobWaiting: "Mac Studio Worker 领取任务后将开始分析。",
    workerJobCancel: "取消任务",
    workerJobResult: "分析结果",
    workerJobIssue: "确认事项",
    workerJobNoIssue: "暂无特别事项。",
    workerJobFallback: "本地 LLM 响应延迟，当前显示基于计算的分析。",
    askingAi: "AI 回答中",
    aiQuestionPlaceholder: "例：今天计划对比最需要先确认哪台注塑机？",
    aiAnswerTitle: "AI 回答",
    aiSubmit: "发送问题",
    llmError: "无法连接本地 MLX LLM 服务。当前显示基于数据的草稿。",
    progressEyebrow: "LIVE PROGRESS",
    progressTitle: "实时进度",
    progressDescription: "注塑结合生产计划与 MES 合模数，并按 Cavity 估算生产量计算进度。",
    injectionProgress: "注塑实时进度",
    machiningProgress: "加工实时进度",
    planned: "计划",
    actualEstimate: "估算生产",
    shotCount: "合模数",
    running: "运行",
    gap: "差异",
    overrun: "超计划生产",
    overrunShort: "超出",
    parts: "Part",
    cavity: "Cavity",
    completed: "完成",
    inProgress: "进行中",
    pending: "待开始",
    currentPart: "当前",
    partProgress: "按 Part 进度",
    totalProgress: "整体进度",
    detail: "详情",
    close: "关闭",
    machineDetailTitle: "注塑机进度详情",
    sequence: "顺序",
    model: "型号",
    lot: "Lot",
    progress: "进度",
    completion: "完成度",
    estimatedVsPlan: "估算 / 计划",
    progressHint: "按设备计划顺序分配合模数，显示完成/进行中/待开始。",
    noProgressRows: "暂无计划或 MES 实绩。",
    machiningPending: "按 Blacklake JG/加工报工数量分配到计划顺序并显示进度。",
    machiningSupplementHint: "优先使用 MES 实绩，仅对漏报的提前生产进行手工补正。",
    mesQty: "MES",
    manualOpen: "MES未登记手工",
    manualMatched: "MES已确认手工",
    effectiveQty: "补正后",
    advanceQty: "提前生产",
    manualReport: "手工补正",
    manualReportTitle: "加工手工补正",
    goodQty: "良品数量",
    defectQty: "不良数量",
    defectType: "不良类型",
    defectTypePlaceholder: "例: scratch",
    reasonCode: "补正原因",
    reasonPlaceholder: "例: MES 工单未生成",
    note: "备注",
    saveManualReport: "保存补正",
    savingManualReport: "保存中",
    manualReportSaved: "手工补正已保存。",
    manualReportError: "无法保存手工补正。",
    machineSummaryTitle: "设备汇总",
    workOrders: "工单",
    plannedOnly: "按计划数量准备",
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
    noTransitionEvents: "暂无 10 分钟以上停机候选。",
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
    rawTitle: "运营 API 确认",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

const kpiDetailCopy = {
  ko: {
    clickHint: "클릭해서 상세 보기",
    injectionTitle: "사출 계획 및 실행율 상세",
    machiningTitle: "가공 실적 / 계획 상세",
    machinesTitle: "기준일 가동 설비 상세",
    cumulativeTrend: "누적 추이",
    actualLine: "실적",
    targetLine: "시간 목표",
    targetTotal: "목표",
    currentGap: "현재 차이",
    completionRate: "완료율",
    elapsedRate: "시간 기준",
    compactSummary: "요약",
    updatedAt: "업데이트",
    inProgressNow: "진행 중",
    paceGap: "시간목표 대비",
    paceRateGap: "시간 대비",
    quantityGap: "수량 차이",
    timeShort: "시간",
    quantityShort: "수량",
    byMachine: "설비별 진행",
    byLine: "라인별 진행",
    equipmentTimeline: "24시간 가동 타임라인",
    activeFirst: "당일 가동 설비 우선 · 08:00~익일 08:00",
    running: "생산 있음",
    idle: "생산 없음",
    output: "실적",
    clampCount: "형합수",
    activeTime: "가동 시간",
    utilizationSummary: "전체 가동율 요약",
    utilizationTrend: "금일 가동률 추이",
    currentUtilization: "현재 가동률",
    averageUtilization: "평균 가동률",
    peakUtilization: "최대 가동률",
    averageLine: "평균선",
    peakPoint: "최대점",
    movingAverage: "이동평균",
    noData: "표시할 상세 데이터가 없습니다.",
  },
  zh: {
    clickHint: "点击查看详情",
    injectionTitle: "注塑计划与执行率详情",
    machiningTitle: "加工实绩 / 计划详情",
    machinesTitle: "基准日运行设备详情",
    cumulativeTrend: "累计趋势",
    actualLine: "实绩",
    targetLine: "时间目标",
    targetTotal: "目标",
    currentGap: "当前差异",
    completionRate: "完成率",
    elapsedRate: "时间基准",
    compactSummary: "摘要",
    updatedAt: "更新",
    inProgressNow: "进行中",
    paceGap: "较时间目标",
    paceRateGap: "较时间",
    quantityGap: "数量差异",
    timeShort: "时间",
    quantityShort: "数量",
    byMachine: "设备别进度",
    byLine: "产线别进度",
    equipmentTimeline: "24小时运行时间线",
    activeFirst: "当日有生产的设备优先 · 08:00~次日 08:00",
    running: "有生产",
    idle: "无生产",
    output: "实绩",
    clampCount: "合模数",
    activeTime: "运行时间",
    utilizationSummary: "整体运行率摘要",
    utilizationTrend: "今日运行率趋势",
    currentUtilization: "当前运行率",
    averageUtilization: "平均运行率",
    peakUtilization: "最高运行率",
    averageLine: "平均线",
    peakPoint: "峰值",
    movingAverage: "移动平均",
    noData: "没有可显示的详细数据。",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

const activitySelectionCopy = {
  ko: {
    range: "선택 구간",
    selectedParts: "Part별 생산",
    selectedMachines: "설비별 형합",
    clampCount: "형합수",
    estimatedQty: "추정수량",
    total: "합계",
    clear: "선택 해제",
    partUnknown: "파트 미지정",
    noSelection: "선택 구간에 생산 기록 없음",
    dragHint: "드래그로 구간 분석",
    selectionFocus: "구간 분석",
  },
  zh: {
    range: "选择区间",
    selectedParts: "按 Part 生产",
    selectedMachines: "按设备合模",
    clampCount: "合模数",
    estimatedQty: "推定数量",
    total: "合计",
    clear: "清除选择",
    partUnknown: "未指定 Part",
    noSelection: "所选区间无生产记录",
    dragHint: "拖拽分析区间",
    selectionFocus: "区间分析",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

const LOCAL_LLM_BASE_URL = import.meta.env.VITE_LOCAL_LLM_BASE_URL || "http://127.0.0.1:8080/v1";
const LOCAL_LLM_MODEL = import.meta.env.VITE_LOCAL_LLM_MODEL || "mlx-community/gemma-4-e2b-it-8bit";
const LIVE_DATA_REFRESH_INTERVAL_MS = 120_000;
const AI_BRIEFING_REFRESH_INTERVAL_MS = 5 * 60_000;
const INJECTION_MACHINE_TOTAL = 17;
const MACHINE_UTILIZATION_BUCKET_MINUTES = 5;
const MACHINE_ACTIVITY_DETAIL_RETENTION_DAYS = 7;
const MACHINE_ACTIVITY_DISPLAY_IDLE_BRIDGE_MINUTES = 6;
const MACHINE_ACTIVITY_DISPLAY_IDLE_BRIDGE_PCT = (MACHINE_ACTIVITY_DISPLAY_IDLE_BRIDGE_MINUTES / (24 * 60)) * 100;
const UTILIZATION_CHART_TOP_Y = 4;
const UTILIZATION_CHART_BOTTOM_Y = 54;
const ACTIVITY_PART_SEQUENCE_HUES = [154, 170, 188, 206, 224, 42];
const ACTIVITY_PART_VARIANT_LIGHTNESS = [36, 42, 48, 54];
const ACTIVITY_PART_SEQUENCE_SATURATION = 54;

type DashboardAiIntent = {
  intent: "injection_cycle_time" | "production_output" | "production_status" | "production_summary" | "unknown";
  metric?: string | null;
  filters: {
    running_only?: boolean;
    product_family?: string | null;
    target_text?: string | null;
    machine?: string | null;
  };
  sort?: "ct_desc" | "ct_asc" | "output_desc" | "output_asc" | null;
  limit?: number;
};

function formatNumber(value: number) {
  return Math.round(value).toLocaleString();
}

function isAiJobTerminal(status?: AiJobStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function getAiJobStatusLabel(status: AiJobStatus | undefined, language: AppLanguage) {
  const labels = {
    ko: {
      pending: "대기",
      claimed: "Worker 배정",
      running: "분석 중",
      completed: "완료",
      failed: "실패",
      cancelled: "취소",
    },
    zh: {
      pending: "等待",
      claimed: "已分配",
      running: "分析中",
      completed: "完成",
      failed: "失败",
      cancelled: "已取消",
    },
  } satisfies Record<AppLanguage, Record<AiJobStatus, string>>;
  return status ? labels[language][status] : "-";
}

function getStringField(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function getTopIssues(source: Record<string, unknown>) {
  const issues = source.top_issues;
  return Array.isArray(issues)
    ? issues
      .filter((issue): issue is Record<string, unknown> => Boolean(issue) && typeof issue === "object")
      .slice(0, 5)
    : [];
}

function getIssueText(issue: Record<string, unknown>) {
  const evidence = issue.evidence;
  if (Array.isArray(evidence)) {
    return evidence.map((item) => String(item)).filter(Boolean).join(" · ");
  }
  return getStringField(issue, "detail") || getStringField(issue, "summary");
}

function normalizeProductFamily(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (["bc", "b/c", "backcover", "백커버"].includes(normalized)) return "BC";
  if (["ca", "c/a", "cabinet", "캐비넷"].includes(normalized)) return "CA";
  if (["gp", "g/p", "guidepanel", "가이드패널"].includes(normalized)) return "GP";
  return null;
}

function normalizeDashboardIntent(raw: Partial<DashboardAiIntent>): DashboardAiIntent {
  const validIntent = ["injection_cycle_time", "production_output", "production_status", "production_summary", "unknown"].includes(String(raw.intent))
    ? raw.intent
    : "unknown";
  const filters = raw.filters ?? {};
  const limit = Math.max(1, Math.min(20, Number(raw.limit ?? 8) || 8));
  return {
    intent: validIntent ?? "unknown",
    metric: raw.metric ?? null,
    filters: {
      running_only: Boolean(filters.running_only),
      product_family: normalizeProductFamily(filters.product_family),
      target_text: String(filters.target_text ?? "").trim() || null,
      machine: String(filters.machine ?? "").trim() || null,
    },
    sort: raw.sort ?? null,
    limit,
  };
}

function extractJsonObject(text: string) {
  try {
    const parsed = JSON.parse(text.trim());
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      const parsed = JSON.parse(match[0]);
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
      return {};
    }
  }
}

function heuristicDashboardIntent(question: string): DashboardAiIntent {
  const normalized = question.toLowerCase();
  const runningOnly = ["현재", "지금", "생산중", "가동", "现在", "当前", "运行"].some((token) => normalized.includes(token));
  const productFamily = normalizeProductFamily(
    ["back cover", "backcover", "b/c", "bc", "백커버"].some((token) => normalized.includes(token)) ? "BC"
      : ["cabinet", "c/a", "캐비넷"].some((token) => normalized.includes(token)) ? "CA"
        : ["guide panel", "g/p", "가이드"].some((token) => normalized.includes(token)) ? "GP"
          : null,
  );
  const targetTokens = question
    .match(/[A-Za-z0-9][A-Za-z0-9./_-]{2,}/g)
    ?.filter((token) => token.length >= 4 && !["back", "cover", "cycle", "output", "production"].includes(token.toLowerCase())) ?? [];

  if (["c/t", "ct", "cycle", "사이클", "싸이클", "시간", "节拍", "周期"].some((token) => normalized.includes(token))) {
    const longest = ["가장 길", "제일 길", "최장", "longest", "最慢", "最长"].some((token) => normalized.includes(token));
    const shortest = ["가장 짧", "제일 짧", "최단", "shortest", "最快", "最短"].some((token) => normalized.includes(token));
    return normalizeDashboardIntent({
      intent: "injection_cycle_time",
      metric: "recent_60m_avg_ct_sec",
      filters: { running_only: runningOnly, product_family: productFamily, target_text: targetTokens[0] ?? null },
      sort: longest ? "ct_desc" : shortest ? "ct_asc" : null,
      limit: longest || shortest ? 1 : 8,
    });
  }

  if (["생산량", "실적", "몇개", "몇 개", "output", "production", "产量", "实绩"].some((token) => normalized.includes(token))) {
    return normalizeDashboardIntent({
      intent: "production_output",
      metric: "estimated_qty",
      filters: { running_only: runningOnly, product_family: productFamily, target_text: targetTokens[0] ?? null },
      sort: "output_desc",
      limit: 8,
    });
  }

  if (runningOnly && ["몇대", "몇 대", "수는", "수량", "몇台", "几台", "多少台"].some((token) => normalized.includes(token))) {
    return normalizeDashboardIntent({
      intent: "production_status",
      metric: "running_count",
      filters: { running_only: true, product_family: productFamily },
      limit: 17,
    });
  }

  if (["진도", "진행", "진척", "상황", "어때", "어떄", "怎么样", "进度", "情况"].some((token) => normalized.includes(token))) {
    return normalizeDashboardIntent({
      intent: "production_summary",
      metric: "progress_rate",
      filters: { running_only: false, product_family: productFamily },
      limit: 8,
    });
  }

  return normalizeDashboardIntent({ intent: "unknown", filters: {} });
}

function getLatestTime(data?: InjectionProductionMatrix) {
  const latestSlot = data?.time_slots?.at(-1);
  return latestSlot ? new Date(latestSlot.time) : null;
}

function getBusinessDayStart(businessDate: string) {
  return new Date(`${businessDate}T08:00:00+08:00`);
}

function getBusinessDayEnd(businessDate: string) {
  return new Date(getBusinessDayStart(businessDate).getTime() + 24 * 60 * 60 * 1000);
}

function formatDateParam(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addBusinessDateDays(businessDate: string, days: number) {
  const nextDate = getBusinessDayStart(businessDate);
  nextDate.setDate(nextDate.getDate() + days);
  return formatDateParam(nextDate);
}

function getBusinessDateAgeDays(businessDate: string) {
  const todayStart = getBusinessDayStart(getShanghaiDateString());
  const targetStart = getBusinessDayStart(businessDate);
  return Math.floor((todayStart.getTime() - targetStart.getTime()) / (24 * 60 * 60 * 1000));
}

function hasSparseHistoricalActivityData(businessDate: string, mesData?: InjectionProductionMatrix) {
  if (!mesData || getBusinessDateAgeDays(businessDate) <= 0) return false;
  const slots = mesData.time_slots ?? [];
  if (slots.length < 2) return false;
  const slotIntervals = slots
    .slice(1)
    .map((slot, index) => (
      (new Date(slot.time).getTime() - new Date(slots[index].time).getTime()) / (60 * 1000)
    ))
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0)
    .sort((left, right) => left - right);
  const medianSlotInterval = slotIntervals.length
    ? slotIntervals[Math.floor(slotIntervals.length / 2)]
    : 0;
  if (medianSlotInterval >= 30) return true;

  let activeSlotCount = 0;
  const activeMinuteBuckets = new Map<number, number>();

  slots.forEach((slot, slotIndex) => {
    const slotTime = new Date(slot.time);
    if (Number.isNaN(slotTime.getTime())) return;

    let hasProduction = false;
    for (let machineNumber = 1; machineNumber <= INJECTION_MACHINE_TOTAL; machineNumber += 1) {
      const productionRow = getMachineMatrixValues(mesData, mesData.actual_production_matrix, machineNumber);
      if (numberAt(productionRow, slotIndex) > 0) {
        hasProduction = true;
        break;
      }
    }

    if (!hasProduction) return;
    activeSlotCount += 1;
    const minuteBucket = Math.round(slotTime.getMinutes() / 5) * 5 % 60;
    activeMinuteBuckets.set(minuteBucket, (activeMinuteBuckets.get(minuteBucket) ?? 0) + 1);
  });

  if (activeSlotCount < 8) return false;
  const activeSlotRatio = activeSlotCount / slots.length;
  const dominantMinuteShare = Math.max(...activeMinuteBuckets.values()) / activeSlotCount;
  return activeSlotRatio <= 0.20 && dominantMinuteShare >= 0.50;
}

function shouldPreferActivityDensity(businessDate: string, mesData?: InjectionProductionMatrix) {
  return getBusinessDateAgeDays(businessDate) >= MACHINE_ACTIVITY_DETAIL_RETENTION_DAYS ||
    hasSparseHistoricalActivityData(businessDate, mesData);
}

function buildLocalBucketedActivitySeries(
  businessDate: string,
  mesData: InjectionProductionMatrix | undefined,
  bucketMinutes = 60,
) {
  if (!mesData) return null;
  const businessStart = getBusinessDayStart(businessDate);
  const businessEnd = getBusinessDayEnd(businessDate);
  const bucketMs = bucketMinutes * 60 * 1000;
  const slots: TimeSlot[] = [];
  const matrix: Record<string, number[]> = {};

  for (
    let slotTimeMs = businessStart.getTime(), index = 0;
    slotTimeMs < businessEnd.getTime();
    slotTimeMs += bucketMs, index += 1
  ) {
    const slotTime = new Date(slotTimeMs);
    slots.push({
      hour_offset: index,
      time: slotTime.toISOString(),
      label: formatTimeLabel(slotTime),
      interval_minutes: bucketMinutes,
    });
  }

  for (let machineNumber = 1; machineNumber <= INJECTION_MACHINE_TOTAL; machineNumber += 1) {
    matrix[String(machineNumber)] = Array.from({ length: slots.length }, () => 0);
  }

  (mesData.time_slots ?? []).forEach((slot, slotIndex) => {
    const slotTime = new Date(slot.time);
    if (Number.isNaN(slotTime.getTime()) || slotTime < businessStart || slotTime >= businessEnd) return;
    const targetIndex = Math.floor((slotTime.getTime() - businessStart.getTime()) / bucketMs);
    if (targetIndex < 0 || targetIndex >= slots.length) return;

    for (let machineNumber = 1; machineNumber <= INJECTION_MACHINE_TOTAL; machineNumber += 1) {
      const productionRow = getMachineMatrixValues(mesData, mesData.actual_production_matrix, machineNumber);
      matrix[String(machineNumber)][targetIndex] += numberAt(productionRow, slotIndex);
    }
  });

  return {
    slots,
    matrix,
    bucketMinutes,
  };
}

function getMachineActivitySeries(businessDate: string, mesData?: InjectionProductionMatrix) {
  const rollupSlots = mesData?.rollup_time_slots ?? mesData?.hourly_rollup_time_slots;
  const rollupMatrix = mesData?.rollup_production_matrix ?? mesData?.hourly_production_matrix;
  const useDensity = shouldPreferActivityDensity(businessDate, mesData);

  if (useDensity && rollupSlots?.length && rollupMatrix) {
    return {
      slots: rollupSlots,
      matrix: rollupMatrix,
      bucketMinutes: mesData?.rollup_bucket_minutes ?? rollupSlots[0]?.interval_minutes ?? 30,
      useDensity: true,
    };
  }

  if (useDensity) {
    const localSeries = buildLocalBucketedActivitySeries(businessDate, mesData, 60);
    if (localSeries) {
      return {
        ...localSeries,
        useDensity: true,
      };
    }
  }

  return {
    slots: mesData?.time_slots,
    matrix: mesData?.actual_production_matrix,
    bucketMinutes: MACHINE_UTILIZATION_BUCKET_MINUTES,
    useDensity: false,
  };
}

function getBusinessDayReferenceEnd(businessDate: string, mesData?: InjectionProductionMatrix) {
  const start = getBusinessDayStart(businessDate);
  const end = getBusinessDayEnd(businessDate);
  const latestTime = getLatestTime(mesData);
  if (!latestTime) return end;
  return new Date(Math.min(Math.max(latestTime.getTime(), start.getTime()), end.getTime()));
}

function getProductionElapsedRate(businessDate: string, mesData?: InjectionProductionMatrix) {
  const start = getBusinessDayStart(businessDate);
  const end = getBusinessDayEnd(businessDate);
  const latestTime = getLatestTime(mesData);
  const fallbackTime = businessDate === getShanghaiDateString() ? new Date() : end;
  const referenceTime = latestTime ?? fallbackTime;
  const clampedTime = new Date(Math.min(Math.max(referenceTime.getTime(), start.getTime()), end.getTime()));
  return ((clampedTime.getTime() - start.getTime()) / (end.getTime() - start.getTime())) * 100;
}

function getRateTone(actualRate: number, expectedRate: number): "positive" | "negative" | "neutral" {
  const gap = actualRate - expectedRate;
  if (gap >= 5) return "positive";
  if (gap <= -5) return "negative";
  return "neutral";
}

function numberAt(values: number[] | undefined, index: number) {
  if (!values || index < 0) return 0;
  return Number(values[index] ?? 0);
}

function getMachineNumberFromName(value: string | null | undefined) {
  const text = String(value ?? "");
  const suffixMatch = text.match(/-(\d+)\s*$/);
  if (suffixMatch) return suffixMatch[1];
  const machineLabelMatch = text.match(/^(\d+)\s*(?:호기|号机)/);
  if (machineLabelMatch) return machineLabelMatch[1];
  const leadingMatch = text.match(/^(\d+)\D/);
  return leadingMatch ? leadingMatch[1] : null;
}

function getMachineFallbackLabel(machineNumber: number, language: AppLanguage) {
  return language === "zh" ? `${machineNumber}号机` : `${machineNumber}호기`;
}

function getLocalizedMachineLabel(value: string | null | undefined, language: AppLanguage) {
  const label = String(value ?? "").trim();
  if (language !== "zh") return label;
  return label.replace(/호기/g, "号机");
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function formatHourLabel(value: Date) {
  return `${String(value.getHours()).padStart(2, "0")}:00`;
}

function formatTimeLabel(value: Date) {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function formatHoursFromMinutes(minutes: number) {
  if (minutes <= 0) return "0h";
  const hours = Math.floor(minutes / 60);
  const restMinutes = Math.round(minutes % 60);
  if (hours <= 0) return `${restMinutes}m`;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
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
  const keys = [
    String(machineNumber),
    machine?.machine_name,
    machine?.display_name,
  ].filter((key): key is string => Boolean(key));
  for (const key of keys) {
    if (matrix[key]) return matrix[key];
  }
  return [];
}

function getTrendAxisLabels(businessDate: string) {
  const start = getBusinessDayStart(businessDate);
  return [0, 4, 8, 12, 16, 20, 24].map((hour) => {
    const tick = new Date(start.getTime() + hour * 60 * 60 * 1000);
    return formatHourLabel(tick);
  });
}

function getTrendPoint(
  key: string,
  time: Date,
  actualQty: number,
  plannedQty: number,
  businessStart: Date,
  businessEnd: Date,
): CumulativeTrendPoint {
  const elapsedRate = clampPercent(((time.getTime() - businessStart.getTime()) / (businessEnd.getTime() - businessStart.getTime())) * 100);
  return {
    key,
    label: formatTimeLabel(time),
    elapsedRate,
    actualQty,
    targetQty: Math.round(plannedQty * (elapsedRate / 100)),
  };
}

function buildInjectionCumulativeTrend(
  businessDate: string,
  plannedQty: number,
  actualQty: number,
  mesData?: InjectionProductionMatrix,
): CumulativeTrendSummary {
  const businessStart = getBusinessDayStart(businessDate);
  const businessEnd = getBusinessDayEnd(businessDate);
  const referenceEnd = getBusinessDayReferenceEnd(businessDate, mesData);
  const points: CumulativeTrendPoint[] = [getTrendPoint("start", businessStart, 0, plannedQty, businessStart, businessEnd)];
  let cumulativeQty = 0;

  mesData?.time_slots?.forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    if (slotTime <= businessStart || slotTime > referenceEnd || slotTime > businessEnd) return;
    cumulativeQty += (mesData.machines ?? []).reduce((sum, machine) => {
      const row = getMachineMatrixValues(mesData, mesData.actual_production_matrix, machine.machine_number);
      return sum + numberAt(row, index);
    }, 0);
    points.push(getTrendPoint(`slot-${index}`, slotTime, cumulativeQty, plannedQty, businessStart, businessEnd));
  });

  if (points.length === 1 && referenceEnd > businessStart) {
    points.push(getTrendPoint("reference", referenceEnd, actualQty, plannedQty, businessStart, businessEnd));
  }

  const latestPoint = points.at(-1) ?? getTrendPoint("start", businessStart, 0, plannedQty, businessStart, businessEnd);

  return {
    plannedQty,
    actualQty,
    completionRate: plannedQty > 0 ? (actualQty / plannedQty) * 100 : 0,
    elapsedRate: getProductionElapsedRate(businessDate, mesData),
    latestPoint,
    points,
    axisLabels: getTrendAxisLabels(businessDate),
  };
}

function getMachiningReportTime(
  row: MachiningProvisionRow,
  machiningStats: ProductionMesReportStatsResponse | undefined,
  fallbackTime: Date,
) {
  const manualTimes = (row.manual_reports ?? [])
    .map((report) => report.reported_at || report.updated_at)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()));
  if (manualTimes.length) {
    return new Date(Math.max(...manualTimes.map((value) => value.getTime())));
  }

  const rowPartNo = normalizeDashboardPartNo(row.part_no);
  const matchedStat = machiningStats?.rows.find((statRow) => {
    const samePart = normalizeDashboardPartNo(statRow.part_no) === rowPartNo;
    const sameEquipment = [statRow.equipment_key, statRow.equipment_label, statRow.equipment_name]
      .filter(Boolean)
      .some((value) => value === row.equipment_key || value === row.equipment_label || value === row.machine_name);
    return samePart && sameEquipment && statRow.latest_report_time;
  });

  if (matchedStat?.latest_report_time) {
    const reportTime = new Date(matchedStat.latest_report_time);
    if (!Number.isNaN(reportTime.getTime())) return reportTime;
  }

  return fallbackTime;
}

function buildMachiningCumulativeTrend(
  businessDate: string,
  plannedQty: number,
  actualQty: number,
  machiningProgress: MachiningProgressPreview,
  machiningStats: ProductionMesReportStatsResponse | undefined,
  machiningProvision: MachiningProvisionResponse | undefined,
  mesData?: InjectionProductionMatrix,
): CumulativeTrendSummary {
  const businessStart = getBusinessDayStart(businessDate);
  const businessEnd = getBusinessDayEnd(businessDate);
  const referenceEnd = getBusinessDayReferenceEnd(businessDate, mesData);
  const points: CumulativeTrendPoint[] = [getTrendPoint("start", businessStart, 0, plannedQty, businessStart, businessEnd)];
  const events = machiningProvision?.rows?.length
    ? machiningProvision.rows.map((row, index) => ({
      key: `provision-${row.plan_identity_hash || row.plan_id || index}`,
      qty: Math.max(0, Number(row.effective_actual_qty ?? 0) || 0),
      time: getMachiningReportTime(row, machiningStats, referenceEnd),
    }))
    : (machiningStats?.rows ?? []).map((row, index) => ({
      key: `stats-${row.equipment_key}-${row.part_no}-${index}`,
      qty: Math.max(0, Number(row.mes_qty ?? 0) || 0),
      time: row.latest_report_time ? new Date(row.latest_report_time) : referenceEnd,
    }));

  let cumulativeQty = 0;
  events
    .filter((event) => event.qty > 0)
    .map((event) => ({
      ...event,
      time: Number.isNaN(event.time.getTime()) ? referenceEnd : event.time,
    }))
    .sort((left, right) => left.time.getTime() - right.time.getTime())
    .forEach((event) => {
      const clampedTime = new Date(Math.min(Math.max(event.time.getTime(), businessStart.getTime()), businessEnd.getTime()));
      cumulativeQty += event.qty;
      points.push(getTrendPoint(event.key, clampedTime, cumulativeQty, plannedQty, businessStart, businessEnd));
    });

  if (points.length === 1 && machiningProgress.actualQty > 0) {
    points.push(getTrendPoint("summary-actual", referenceEnd, machiningProgress.actualQty, plannedQty, businessStart, businessEnd));
  }

  if (points.length === 1 && referenceEnd > businessStart) {
    points.push(getTrendPoint("reference", referenceEnd, 0, plannedQty, businessStart, businessEnd));
  }

  const latestPoint = points.at(-1) ?? getTrendPoint("start", businessStart, 0, plannedQty, businessStart, businessEnd);

  return {
    plannedQty,
    actualQty,
    completionRate: plannedQty > 0 ? (actualQty / plannedQty) * 100 : 0,
    elapsedRate: getProductionElapsedRate(businessDate, mesData),
    latestPoint,
    points,
    axisLabels: getTrendAxisLabels(businessDate),
  };
}

function bridgeShortInactiveActivitySlots(
  slots: MachineActivitySlot[],
  maxBridgeMinutes = MACHINE_ACTIVITY_DISPLAY_IDLE_BRIDGE_MINUTES,
) {
  const bridgedSlots = slots.map((slot) => ({ ...slot }));
  let runStart = 0;

  while (runStart < bridgedSlots.length) {
    if (bridgedSlots[runStart].active) {
      runStart += 1;
      continue;
    }

    let runEnd = runStart + 1;
    while (runEnd < bridgedSlots.length && !bridgedSlots[runEnd].active) {
      runEnd += 1;
    }

    const previousSlot = bridgedSlots[runStart - 1];
    const nextSlot = bridgedSlots[runEnd];
    const idleMinutes = bridgedSlots
      .slice(runStart, runEnd)
      .reduce((sum, slot) => sum + slot.intervalMinutes, 0);
    const isBoundedByProduction = Boolean(previousSlot?.active && nextSlot?.active);
    const isTimeContinuous = previousSlot && nextSlot
      ? Math.abs(bridgedSlots[runStart].slotTime.getTime() - previousSlot.slotEnd.getTime()) < 1000 &&
        Math.abs(nextSlot.slotTime.getTime() - bridgedSlots[runEnd - 1].slotEnd.getTime()) < 1000
      : false;

    if (isBoundedByProduction && isTimeContinuous && idleMinutes <= maxBridgeMinutes) {
      for (let index = runStart; index < runEnd; index += 1) {
        bridgedSlots[index].displayActive = true;
      }
    }

    runStart = runEnd;
  }

  return bridgedSlots;
}

function buildMachineActivityRows(
  businessDate: string,
  mesData: InjectionProductionMatrix | undefined,
  language: AppLanguage,
  progressSummary?: RealtimeProgressSummary,
): MachineActivityRow[] {
  const businessStart = getBusinessDayStart(businessDate);
  const businessEnd = getBusinessDayEnd(businessDate);
  const machineInfo = new Map((mesData?.machines ?? []).map((machine) => [machine.machine_number, machine]));
  const activitySeries = getMachineActivitySeries(businessDate, mesData);
  const useRollupDensity = activitySeries.useDensity;
  const activitySlots = activitySeries.slots;
  const activityMatrix = activitySeries.matrix;
  const maxSegmentOutput = Math.max(
    1,
    ...Array.from({ length: INJECTION_MACHINE_TOTAL }, (_, index) => (
      getMachineMatrixValues(mesData, activityMatrix, index + 1)
    )).flat().map((value) => Number(value) || 0),
  );

  return Array.from({ length: INJECTION_MACHINE_TOTAL }, (_, index) => {
    const machineNumber = index + 1;
    const machine = machineInfo.get(machineNumber);
    const productionRow = getMachineMatrixValues(mesData, activityMatrix, machineNumber);
    const segments: MachineActivitySegment[] = [];
    let output = 0;
    let activeMinutes = 0;
    const rawSlots: MachineActivitySlot[] = [];
    const progressRow = getMachineProgressRow(progressSummary, machineNumber);
    const partSequence = getPartVisualSequence(progressRow);
    let cumulativeShots = 0;

    activitySlots?.forEach((slot, slotIndex) => {
      const slotTime = new Date(slot.time);
      if (slotTime < businessStart || slotTime >= businessEnd) return;

      const intervalMinutes = slot.interval_minutes ?? (useRollupDensity ? activitySeries.bucketMinutes : (mesData ? getSlotIntervalMinutes(mesData, slotIndex) : 2));
      const slotEnd = new Date(Math.min(slotTime.getTime() + intervalMinutes * 60 * 1000, businessEnd.getTime()));
      const slotOutput = numberAt(productionRow, slotIndex);
      const active = slotOutput > 0;
      const segment = active ? getProgressSegmentForShot(progressRow, cumulativeShots) : undefined;
      const partFields = getSlotPartFields(segment, partSequence);
      const estimatedQty = active ? Math.round(slotOutput * partFields.cavity) : 0;
      cumulativeShots += slotOutput;
      rawSlots.push({
        slotIndex,
        slotTime,
        slotEnd,
        intervalMinutes,
        output: slotOutput,
        estimatedQty,
        partNo: active ? partFields.partNo : undefined,
        partFamily: active ? partFields.partFamily : undefined,
        partVariant: active ? partFields.partVariant : undefined,
        partHue: active ? partFields.partHue : undefined,
        partLightness: active ? partFields.partLightness : undefined,
        partSaturation: active ? partFields.partSaturation : undefined,
        cavity: partFields.cavity,
        active,
        displayActive: active,
      });
    });

    const displaySlots = applyAdjacentPartFieldsToDisplaySlots(useRollupDensity
      ? rawSlots
      : bridgeShortInactiveActivitySlots(rawSlots));

    displaySlots.forEach((slot) => {
      const startPct = clampPercent(((slot.slotTime.getTime() - businessStart.getTime()) / (businessEnd.getTime() - businessStart.getTime())) * 100);
      const widthPct = Math.max(0.1, clampPercent(((slot.slotEnd.getTime() - slot.slotTime.getTime()) / (businessEnd.getTime() - businessStart.getTime())) * 100));
      const displayActive = slot.displayActive;
      const density = displayActive
        ? (useRollupDensity ? Math.min(1, Math.max(0.22, 0.22 + (slot.output / maxSegmentOutput) * 0.78)) : 0.88)
        : undefined;
      output += slot.output;
      if (slot.active) activeMinutes += slot.intervalMinutes;

      const previous = segments.at(-1);
      const previousEndPct = previous ? previous.startPct + previous.widthPct : 0;
      const gapPct = startPct - previousEndPct;
      const contiguous = previous && Math.abs(gapPct) < 0.08;
      const bridgeableDisplayGap = !useRollupDensity &&
        previous?.active &&
        displayActive &&
        gapPct > 0 &&
        gapPct <= MACHINE_ACTIVITY_DISPLAY_IDLE_BRIDGE_PCT;
      const matchingDensity = !useRollupDensity || !displayActive || Math.abs((previous?.density ?? 0) - (density ?? 0)) < 0.03;
      const matchingPartVisual = !displayActive || (
        previous?.partFamily === slot.partFamily &&
        previous?.partVariant === slot.partVariant
      );
      const canMergeSegment = !useRollupDensity || !displayActive;
      if (previous && previous.active === displayActive && (contiguous || bridgeableDisplayGap) && matchingDensity && matchingPartVisual && canMergeSegment) {
        previous.widthPct += (bridgeableDisplayGap ? gapPct : 0) + widthPct;
        previous.output += slot.output;
        previous.estimatedQty += slot.estimatedQty;
        return;
      }

      segments.push({
        key: `${machineNumber}-${slot.slotIndex}`,
        active: displayActive,
        startPct,
        widthPct,
        output: slot.output,
        estimatedQty: slot.estimatedQty,
        partNo: displayActive ? slot.partNo : undefined,
        partFamily: displayActive ? slot.partFamily : undefined,
        partVariant: displayActive ? slot.partVariant : undefined,
        partHue: displayActive ? slot.partHue : undefined,
        partLightness: displayActive ? slot.partLightness : undefined,
        partSaturation: displayActive ? slot.partSaturation : undefined,
        density,
      });
    });

    return {
      machineNumber,
      label: getLocalizedMachineLabel(
        machine?.display_name || machine?.machine_name || getMachineFallbackLabel(machineNumber, language),
        language,
      ),
      output,
      activeMinutes,
      isActive: output > 0,
      segments,
      slots: displaySlots,
    };
  }).sort((left, right) => left.machineNumber - right.machineNumber);
}

function buildMachineUtilizationPoints(
  businessDate: string,
  mesData: InjectionProductionMatrix | undefined,
  totalMachines: number,
  rows?: MachineActivityRow[],
): MachineUtilizationPoint[] {
  const businessStart = getBusinessDayStart(businessDate);
  const businessEnd = getBusinessDayEnd(businessDate);
  const referenceEnd = getBusinessDayReferenceEnd(businessDate, mesData);
  const displayRows = rows?.filter((row) => row.slots.length) ?? [];
  if (displayRows.length) {
    const bucketMs = MACHINE_UTILIZATION_BUCKET_MINUTES * 60 * 1000;
    const points: MachineUtilizationPoint[] = [];

    for (
      let bucketStartMs = businessStart.getTime(), bucketIndex = 0;
      bucketStartMs < referenceEnd.getTime() && bucketStartMs < businessEnd.getTime();
      bucketStartMs += bucketMs, bucketIndex += 1
    ) {
      const bucketEndMs = Math.min(bucketStartMs + bucketMs, referenceEnd.getTime(), businessEnd.getTime());
      if (bucketEndMs <= bucketStartMs) continue;

      let activeMs = 0;
      const activeMachines = new Set<number>();

      displayRows.forEach((row) => {
        row.slots.forEach((slot) => {
          if (!slot.displayActive) return;

          const overlapMs = Math.min(slot.slotEnd.getTime(), bucketEndMs) - Math.max(slot.slotTime.getTime(), bucketStartMs);
          if (overlapMs <= 0) return;

          activeMs += overlapMs;
          activeMachines.add(row.machineNumber);
        });
      });

      const bucketDurationMinutes = (bucketEndMs - bucketStartMs) / (60 * 1000);
      const utilizationRate = totalMachines > 0 && bucketDurationMinutes > 0
        ? (activeMs / (bucketDurationMinutes * 60 * 1000 * totalMachines)) * 100
        : 0;
      const pointTime = new Date(bucketEndMs);

      points.push({
        key: `${businessDate}-bucket-${bucketIndex}`,
        label: formatTimeLabel(pointTime),
        timestampMs: pointTime.getTime(),
        elapsedRate: clampPercent(((pointTime.getTime() - businessStart.getTime()) / (businessEnd.getTime() - businessStart.getTime())) * 100),
        utilizationRate,
        activeMachineCount: activeMachines.size,
      });
    }

    return points;
  }

  const activitySeries = getMachineActivitySeries(businessDate, mesData);
  const activitySlots = activitySeries.slots;
  const activityMatrix = activitySeries.matrix;
  const bucketMinutes = activitySeries.useDensity
    ? Math.max(MACHINE_UTILIZATION_BUCKET_MINUTES, activitySeries.bucketMinutes)
    : MACHINE_UTILIZATION_BUCKET_MINUTES;
  const bucketMs = bucketMinutes * 60 * 1000;
  const buckets = new Map<number, {
    activeMachines: Set<number>;
    latestSampleTime: Date;
  }>();

  activitySlots?.forEach((slot, slotIndex) => {
    const slotTime = new Date(slot.time);
    if (Number.isNaN(slotTime.getTime()) || slotTime < businessStart || slotTime > referenceEnd || slotTime > businessEnd) return;

    const elapsedMs = Math.max(0, slotTime.getTime() - businessStart.getTime());
    const bucketIndex = Math.floor(elapsedMs / bucketMs);
    const bucket = buckets.get(bucketIndex) ?? {
      activeMachines: new Set<number>(),
      latestSampleTime: slotTime,
    };

    for (let machineNumber = 1; machineNumber <= totalMachines; machineNumber += 1) {
      const productionRow = getMachineMatrixValues(mesData, activityMatrix, machineNumber);
      if (numberAt(productionRow, slotIndex) > 0) bucket.activeMachines.add(machineNumber);
    }

    bucket.latestSampleTime = slotTime > bucket.latestSampleTime ? slotTime : bucket.latestSampleTime;
    buckets.set(bucketIndex, bucket);
  });

  return Array.from(buckets.entries())
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([bucketIndex, bucket]) => {
      const activeMachineCount = bucket.activeMachines.size;
      return {
        key: `${businessDate}-bucket-${bucketIndex}`,
        label: formatTimeLabel(bucket.latestSampleTime),
        timestampMs: bucket.latestSampleTime.getTime(),
        elapsedRate: clampPercent(((bucket.latestSampleTime.getTime() - businessStart.getTime()) / (businessEnd.getTime() - businessStart.getTime())) * 100),
        utilizationRate: totalMachines > 0 ? (activeMachineCount / totalMachines) * 100 : 0,
        activeMachineCount,
      };
    });
}

function buildMovingAveragePoints(
  points: MachineUtilizationPoint[],
  historyPoints: MachineUtilizationPoint[],
  windowHours: number,
): MachineUtilizationPoint[] {
  const windowMs = windowHours * 60 * 60 * 1000;
  const allPoints = [...historyPoints, ...points].sort((left, right) => left.timestampMs - right.timestampMs);
  return points.map((point) => {
    const windowStartMs = point.timestampMs - windowMs;
    const windowPoints = allPoints.filter((candidate) => (
      candidate.timestampMs >= windowStartMs && candidate.timestampMs <= point.timestampMs
    ));
    const divisor = Math.max(1, windowPoints.length);
    const utilizationRate = windowPoints.reduce((sum, candidate) => sum + candidate.utilizationRate, 0) / divisor;
    const activeMachineCount = windowPoints.reduce((sum, candidate) => sum + candidate.activeMachineCount, 0) / divisor;
    return {
      key: `${point.key}-ma-${windowHours}`,
      label: point.label,
      timestampMs: point.timestampMs,
      elapsedRate: point.elapsedRate,
      utilizationRate,
      activeMachineCount: Math.round(activeMachineCount),
    };
  });
}

function buildMachineActivitySummary(
  businessDate: string,
  mesData: InjectionProductionMatrix | undefined,
  rows: MachineActivityRow[],
  previousMesData?: InjectionProductionMatrix,
  previousRows: MachineActivityRow[] = [],
): MachineActivitySummary {
  const totalMachines = INJECTION_MACHINE_TOTAL;
  const points = buildMachineUtilizationPoints(businessDate, mesData, totalMachines, rows);
  const historyPoints = previousMesData
    ? buildMachineUtilizationPoints(addBusinessDateDays(businessDate, -1), previousMesData, totalMachines, previousRows)
    : [];

  const latestPoint = points.at(-1);
  const peakPoint = points.reduce<MachineUtilizationPoint | null>((currentPeak, point) => {
    if (!currentPeak || point.utilizationRate > currentPeak.utilizationRate) return point;
    return currentPeak;
  }, null);
  const averageUtilizationRate = points.length
    ? points.reduce((sum, point) => sum + point.utilizationRate, 0) / points.length
    : 0;
  const averageActiveMachineCount = points.length
    ? points.reduce((sum, point) => sum + point.activeMachineCount, 0) / points.length
    : 0;
  const movingAverageSeries = [2, 4, 8, 24].map((hours) => ({
    key: `ma-${hours}`,
    label: `MA ${hours}h`,
    points: buildMovingAveragePoints(points, historyPoints, hours),
  }));
  const scaleRates = [
    ...points.map((point) => point.utilizationRate),
    ...movingAverageSeries.flatMap((series) => series.points.map((point) => point.utilizationRate)),
    averageUtilizationRate,
  ].filter((rate) => Number.isFinite(rate));
  const rawScaleMin = scaleRates.length ? Math.min(...scaleRates) : 0;
  const rawScaleMax = scaleRates.length ? Math.max(...scaleRates) : 0;
  const scalePadding = Math.max(2, (rawScaleMax - rawScaleMin) * 0.22);
  const minimumScaleSpan = 12;
  let scaleMinCandidate = rawScaleMin - scalePadding;
  let scaleMaxCandidate = rawScaleMax + scalePadding;

  if (scaleMaxCandidate - scaleMinCandidate < minimumScaleSpan) {
    const scaleCenter = (rawScaleMin + rawScaleMax) / 2;
    scaleMinCandidate = scaleCenter - minimumScaleSpan / 2;
    scaleMaxCandidate = scaleCenter + minimumScaleSpan / 2;
  }

  let utilizationScaleMin = Math.max(0, Math.floor(scaleMinCandidate / 5) * 5);
  let utilizationScaleMax = Math.min(100, Math.ceil(scaleMaxCandidate / 5) * 5);

  if (utilizationScaleMax - utilizationScaleMin < 10) {
    if (utilizationScaleMin === 0) {
      utilizationScaleMax = Math.min(100, utilizationScaleMin + 10);
    } else if (utilizationScaleMax === 100) {
      utilizationScaleMin = Math.max(0, utilizationScaleMax - 10);
    } else {
      const missingSpan = 10 - (utilizationScaleMax - utilizationScaleMin);
      utilizationScaleMin = Math.max(0, utilizationScaleMin - Math.ceil(missingSpan / 2));
      utilizationScaleMax = Math.min(100, utilizationScaleMax + Math.ceil(missingSpan / 2));
    }
  }

  const tickStep = (utilizationScaleMax - utilizationScaleMin) / 3;
  const utilizationAxisTicks = Array.from({ length: 4 }, (_, index) => (
    Math.round(utilizationScaleMax - tickStep * index)
  ));

  return {
    totalMachines,
    activeMachineCount: rows.filter((row) => row.isActive).length,
    utilizationScaleMin,
    utilizationScaleMax,
    utilizationAxisTicks,
    averageUtilizationRate,
    averageActiveMachineCount,
    peakUtilizationRate: peakPoint?.utilizationRate ?? 0,
    peakActiveMachineCount: peakPoint?.activeMachineCount ?? 0,
    peakPoint,
    currentUtilizationRate: latestPoint?.utilizationRate ?? 0,
    currentActiveMachineCount: latestPoint?.activeMachineCount ?? 0,
    points,
    movingAverageSeries,
    axisLabels: getTrendAxisLabels(businessDate),
  };
}

function getOrderedPlanRecords(records: ProductionPlanRecord[]) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftSequence = Number(left.record.sequence ?? left.index);
      const rightSequence = Number(right.record.sequence ?? right.index);
      if (leftSequence !== rightSequence) return leftSequence - rightSequence;
      return left.index - right.index;
    })
    .map(({ record }) => record);
}

function normalizeDashboardPartNo(value: string | null | undefined) {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

function getPartVisualIdentity(value: string | null | undefined) {
  const partNo = normalizeDashboardPartNo(value);
  const compact = partNo.replace(/[^0-9A-Z]/g, "");
  if (!compact || compact === "-") {
    return {
      partNo: partNo || "-",
      partFamily: "UNKNOWN",
      partVariant: "",
    };
  }

  return {
    partNo,
    partFamily: compact.length > 2 ? compact.slice(0, -2) : compact,
    partVariant: compact.length > 2 ? compact.slice(-2) : "",
  };
}

function getPartVisualSequence(row: RealtimeProgressRow | undefined) {
  const familyOrder = new Map<string, number>();
  const variantOrderByFamily = new Map<string, Map<string, number>>();

  [...(row?.segments ?? [])]
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0))
    .forEach((segment) => {
      const identity = getPartVisualIdentity(segment.partNo);
      if (!familyOrder.has(identity.partFamily)) {
        familyOrder.set(identity.partFamily, familyOrder.size);
      }

      const variantOrder = variantOrderByFamily.get(identity.partFamily) ?? new Map<string, number>();
      if (!variantOrder.has(identity.partVariant)) {
        variantOrder.set(identity.partVariant, variantOrder.size);
      }
      variantOrderByFamily.set(identity.partFamily, variantOrder);
    });

  return {
    familyOrder,
    variantOrderByFamily,
  };
}

function getPartVisualStyle(
  value: string | null | undefined,
  sequence?: ReturnType<typeof getPartVisualSequence>,
) {
  const identity = getPartVisualIdentity(value);
  const familyIndex = sequence?.familyOrder.get(identity.partFamily) ?? 0;
  const variantIndex = sequence?.variantOrderByFamily.get(identity.partFamily)?.get(identity.partVariant) ?? 0;

  return {
    ...identity,
    partHue: ACTIVITY_PART_SEQUENCE_HUES[familyIndex % ACTIVITY_PART_SEQUENCE_HUES.length],
    partLightness: ACTIVITY_PART_VARIANT_LIGHTNESS[variantIndex % ACTIVITY_PART_VARIANT_LIGHTNESS.length],
    partSaturation: ACTIVITY_PART_SEQUENCE_SATURATION,
  };
}

function getMachineProgressRow(progressSummary: RealtimeProgressSummary | undefined, machineNumber: number) {
  return progressSummary?.rows.find((row) => {
    const rowMachineNumber = Number(getMachineNumberFromName(row.label) ?? row.key);
    return Number.isFinite(rowMachineNumber) && rowMachineNumber === machineNumber;
  });
}

function getProgressSegmentForShot(row: RealtimeProgressRow | undefined, shotCursor: number) {
  const orderedSegments = [...(row?.segments ?? [])]
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
  if (!orderedSegments.length) return undefined;

  let cursor = 0;
  for (const segment of orderedSegments) {
    const allocatedShots = Math.max(0, Number(segment.allocatedShots ?? 0) || 0);
    if (allocatedShots > 0 && shotCursor < cursor + allocatedShots) return segment;
    cursor += allocatedShots;
  }

  return orderedSegments.find((segment) => segment.status === "in_progress") ??
    orderedSegments.find((segment) => segment.status === "pending") ??
    orderedSegments.at(-1);
}

function getSlotPartFields(
  segment: RealtimeProgressSegment | undefined,
  sequence?: ReturnType<typeof getPartVisualSequence>,
) {
  const style = getPartVisualStyle(segment?.partNo, sequence);
  const cavity = Math.max(1, Number(segment?.cavity ?? 1) || 1);
  return {
    partNo: style.partNo,
    partFamily: style.partFamily,
    partVariant: style.partVariant,
    partHue: style.partHue,
    partLightness: style.partLightness,
    partSaturation: style.partSaturation,
    cavity,
  };
}

function applyAdjacentPartFieldsToDisplaySlots(slots: MachineActivitySlot[]) {
  const patchedSlots = slots.map((slot) => ({ ...slot }));

  patchedSlots.forEach((slot, index) => {
    if (!slot.displayActive || slot.partNo) return;

    let source = patchedSlots.slice(0, index).reverse().find((candidate) => Boolean(candidate.partNo));
    if (!source) {
      source = patchedSlots.slice(index + 1).find((candidate) => Boolean(candidate.partNo));
    }
    if (!source) return;

    slot.partNo = source.partNo;
    slot.partFamily = source.partFamily;
    slot.partVariant = source.partVariant;
    slot.partHue = source.partHue;
    slot.partLightness = source.partLightness;
    slot.partSaturation = source.partSaturation;
    slot.cavity = source.cavity;
  });

  return patchedSlots;
}

function getActivitySelectionBounds(selection: MachineActivitySelection) {
  const startPct = clampPercent(Math.min(selection.startPct, selection.endPct));
  const endPct = clampPercent(Math.max(selection.startPct, selection.endPct));
  return {
    startPct,
    endPct,
    widthPct: Math.max(0.35, endPct - startPct),
  };
}

function summarizeActivitySelection(
  selection: MachineActivitySelection | null,
  businessDate: string,
  rows: MachineActivityRow[],
  language: AppLanguage,
): ActivitySelectionSummary | null {
  if (!selection) return null;

  const businessStart = getBusinessDayStart(businessDate);
  const businessEnd = getBusinessDayEnd(businessDate);
  const durationMs = businessEnd.getTime() - businessStart.getTime();
  const bounds = getActivitySelectionBounds(selection);
  const startMs = businessStart.getTime() + durationMs * (bounds.startPct / 100);
  const endMs = businessStart.getTime() + durationMs * ((bounds.startPct + bounds.widthPct) / 100);
  const targetRows = selection.machineNumber
    ? rows.filter((row) => row.machineNumber === selection.machineNumber)
    : rows;
  const partMap = new Map<string, ActivitySelectionSummary["partRows"][number]>();
  const machineMap = new Map<string, ActivitySelectionSummary["machineRows"][number]>();

  targetRows.forEach((row) => {
    row.slots.forEach((slot) => {
      if (!slot.active || slot.output <= 0) return;

      const slotStartMs = slot.slotTime.getTime();
      const slotEndMs = slot.slotEnd.getTime();
      const overlapMs = Math.min(slotEndMs, endMs) - Math.max(slotStartMs, startMs);
      if (overlapMs <= 0 || slotEndMs <= slotStartMs) return;

      const ratio = overlapMs / (slotEndMs - slotStartMs);
      const output = slot.output * ratio;
      const estimatedQty = slot.estimatedQty * ratio;
      const machineLabel = getLocalizedMachineLabel(row.label, language);
      const partNo = slot.partNo && slot.partNo !== "-" ? slot.partNo : activitySelectionCopy[language].partUnknown;
      const partKey = `${row.machineNumber}-${partNo}`;
      const partRow = partMap.get(partKey) ?? {
        key: partKey,
        partNo,
        machineLabel,
        output: 0,
        estimatedQty: 0,
        partHue: slot.partHue,
        partLightness: slot.partLightness,
        partSaturation: slot.partSaturation,
      };
      partRow.output += output;
      partRow.estimatedQty += estimatedQty;
      partMap.set(partKey, partRow);

      const machineKey = String(row.machineNumber);
      const machineRow = machineMap.get(machineKey) ?? {
        key: machineKey,
        machineLabel,
        output: 0,
        estimatedQty: 0,
      };
      machineRow.output += output;
      machineRow.estimatedQty += estimatedQty;
      machineMap.set(machineKey, machineRow);
    });
  });

  const partRows = [...partMap.values()].sort((left, right) => right.output - left.output);
  const machineRows = [...machineMap.values()].sort((left, right) => right.output - left.output);

  return {
    startLabel: formatTimeLabel(new Date(startMs)),
    endLabel: formatTimeLabel(new Date(endMs)),
    totalOutput: partRows.reduce((sum, row) => sum + row.output, 0),
    totalEstimatedQty: partRows.reduce((sum, row) => sum + row.estimatedQty, 0),
    partRows,
    machineRows,
  };
}

function getProgressLabel(status: RealtimeProgressSegmentStatus, copy: Record<string, string>) {
  if (status === "completed") return copy.completed;
  if (status === "in_progress") return copy.inProgress;
  return copy.pending;
}

const progressStatusSortOrder: Record<RealtimeProgressSegmentStatus, number> = {
  completed: 0,
  in_progress: 1,
  pending: 2,
};

function getDisplaySegments(segments: RealtimeProgressSegment[]) {
  return [...segments].sort((left, right) => {
    const statusDiff = progressStatusSortOrder[left.status] - progressStatusSortOrder[right.status];
    if (statusDiff !== 0) return statusDiff;
    return Number(left.sequence ?? 0) - Number(right.sequence ?? 0);
  });
}

function sumPlannedQuantity(summary: ProductionPlanSummaryResponse | undefined, bucket: "injection" | "machining", date: string) {
  const dailyTotal = summary?.[bucket].daily_totals.find((item) => item.date === date);
  if (dailyTotal) return Number(dailyTotal.plan_qty ?? 0);
  return (summary?.[bucket]?.records ?? []).reduce((sum, record) => sum + Number(record.planned_quantity ?? 0), 0);
}

function buildProductionBriefContext(
  businessDate: string,
  planSummary: ProductionPlanSummaryResponse | undefined,
  mesData: InjectionProductionMatrix | undefined,
  machiningStats: ProductionMesReportStatsResponse | undefined,
  productionStatus: ProductionStatusResponse | undefined,
  machiningProvision?: MachiningProvisionResponse,
  transitionAnalysis?: InjectionTransitionAnalysis,
  language: AppLanguage = "ko",
): ProductionBriefContext {
  const latestTime = getLatestTime(mesData);
  const productionDayStart = getBusinessDayStart(businessDate);
  const productionDayEnd = getBusinessDayReferenceEnd(businessDate, mesData);
  const recentStart = latestTime ? new Date(latestTime.getTime() - 60 * 60 * 1000) : null;
  const machineOutputs = mesData?.machines?.map((machine) => {
    const key = String(machine.machine_number);
    let shiftOutput = 0;
    let recentOutput = 0;

    (mesData.time_slots ?? []).forEach((slot, index) => {
      const slotTime = new Date(slot.time);
      const output = numberAt(mesData.actual_production_matrix?.[key], index);
      if (slotTime >= productionDayStart && slotTime <= productionDayEnd) {
        shiftOutput += output;
      }
      if (recentStart && latestTime && slotTime >= recentStart && slotTime <= latestTime) {
        recentOutput += output;
      }
    });

    return {
      machine: getMachineFallbackLabel(machine.machine_number, language),
      output: shiftOutput,
      recentOutput,
    };
  }) ?? [];
  const realtimeSummary = buildRealtimeProgressSummary(planSummary, mesData, productionStatus, businessDate, transitionAnalysis);
  const actualMachineOutputs = realtimeSummary.rows
    .filter((row) => row.estimatedQty > 0)
    .map((row) => ({ machine: getLocalizedMachineLabel(row.label, language), output: row.estimatedQty }));
  const injectionPlanQty = realtimeSummary.plannedQty || sumPlannedQuantity(planSummary, "injection", businessDate);
  const actualInjectionOutput = realtimeSummary.estimatedQty;
  const machiningPlanQty = Number(machiningProvision?.summary?.total_planned ?? sumPlannedQuantity(planSummary, "machining", businessDate));
  const actualMachiningOutput = Number(machiningProvision?.summary?.effective_actual_qty ?? machiningStats?.summary?.total_mes ?? 0);
  const activeMachineCount = machineOutputs.filter((item) => item.output > 0).length;
  const runningMachineCount = machineOutputs.filter((item) => item.recentOutput > 0).length;
  const sortedActiveMachines = actualMachineOutputs
    .filter((item) => item.output > 0)
    .sort((a, b) => b.output - a.output);

  return {
    businessDate,
    injectionPlanQty,
    machiningPlanQty,
    actualInjectionOutput,
    actualMachiningOutput,
    planGap: actualInjectionOutput - injectionPlanQty,
    machiningPlanGap: actualMachiningOutput - machiningPlanQty,
    activeMachineCount,
    runningMachineCount,
    totalMachines: mesData?.machines?.length || 17,
    topMachines: sortedActiveMachines.slice(0, 4).map(({ machine, output }) => ({ machine, output })),
    lowOutputMachines: sortedActiveMachines.slice(-4).map(({ machine, output }) => ({ machine, output })),
    latestUpdatedAt: latestTime?.toISOString() ?? null,
  };
}

function buildMachiningProgressPreview(
  planSummary: ProductionPlanSummaryResponse | undefined,
  machiningStats: ProductionMesReportStatsResponse | undefined,
  machiningProvision?: MachiningProvisionResponse,
): MachiningProgressPreview {
  if (machiningProvision) {
    const provisionGroups = new Map<string, {
      key: string;
      label: string;
      plannedQty: number;
      actualQty: number;
      mesQty: number;
      manualOpenQty: number;
      matchedManualQty: number;
      defectQty: number;
      provisionRows: MachiningProvisionRow[];
      segments: RealtimeProgressSegment[];
    }>();

    machiningProvision.rows.forEach((row, index) => {
      const plannedQty = Number(row.planned_qty ?? 0);
      const actualQty = Number(row.effective_actual_qty ?? 0);
      const progressRate = plannedQty > 0 ? (actualQty / plannedQty) * 100 : actualQty > 0 ? 100 : 0;
      const segmentStatus: RealtimeProgressSegmentStatus = plannedQty > 0 && actualQty >= plannedQty
        ? "completed"
        : actualQty > 0
          ? "in_progress"
          : "pending";
      const segment: RealtimeProgressSegment = {
        key: `${row.plan_id ?? (row.plan_identity_hash || index)}-${row.part_no}`,
        sequence: Number(row.sequence ?? index + 1),
        partNo: row.part_no || "-",
        modelName: row.model_name || "-",
        lotNo: row.lot_no || "-",
        productFamilyCode: null,
        productFamilyName: null,
        isFinishedProduct: false,
        plannedQty,
        cavity: 1,
        requiredShots: plannedQty,
        allocatedShots: actualQty,
        estimatedQty: actualQty,
        progressRate,
        status: segmentStatus,
      };
      const groupKey = row.equipment_key || row.equipment_label || row.machine_name || `unknown-${index}`;
      const group = provisionGroups.get(groupKey) ?? {
        key: groupKey,
        label: row.equipment_label || row.machine_name || row.equipment_key || "-",
        plannedQty: 0,
        actualQty: 0,
        mesQty: 0,
        manualOpenQty: 0,
        matchedManualQty: 0,
        defectQty: 0,
        provisionRows: [],
        segments: [],
      };
      group.plannedQty += plannedQty;
      group.actualQty += actualQty;
      group.mesQty += Number(row.mes_qty ?? 0);
      group.manualOpenQty += Number(row.manual_open_qty ?? 0);
      group.matchedManualQty += Number(row.matched_manual_qty ?? 0);
      group.defectQty += Number(row.defect_qty ?? 0);
      group.provisionRows.push(row);
      group.segments.push(segment);
      provisionGroups.set(groupKey, group);
    });

    const rows = [...provisionGroups.values()]
      .map((group) => {
        const completedCount = group.segments.filter((segment) => segment.status === "completed").length;
        const inProgressCount = group.segments.filter((segment) => segment.status === "in_progress").length;
        const pendingCount = group.segments.filter((segment) => segment.status === "pending").length;
        const provisionRow = [...group.provisionRows].sort((left, right) => {
          const leftActual = Number(left.effective_actual_qty ?? 0);
          const leftPlan = Number(left.planned_qty ?? 0);
          const rightActual = Number(right.effective_actual_qty ?? 0);
          const rightPlan = Number(right.planned_qty ?? 0);
          const leftDone = leftPlan > 0 && leftActual >= leftPlan;
          const rightDone = rightPlan > 0 && rightActual >= rightPlan;
          if (leftDone !== rightDone) return leftDone ? 1 : -1;
          return Number(left.sequence ?? 0) - Number(right.sequence ?? 0);
        }).find((item) => item.plan_id) ?? group.provisionRows.find((item) => item.plan_id);
        return {
          key: group.key,
          label: group.label,
          plannedQty: group.plannedQty,
          actualQty: group.actualQty,
          gapQty: group.actualQty - group.plannedQty,
          progressRate: group.plannedQty > 0 ? (group.actualQty / group.plannedQty) * 100 : group.actualQty > 0 ? 100 : 0,
          completedCount,
          inProgressCount,
          pendingCount,
          mesQty: group.mesQty,
          manualOpenQty: group.manualOpenQty,
          matchedManualQty: group.matchedManualQty,
          defectQty: group.defectQty,
          status: group.provisionRows.some((item) => item.status === "manual_mismatch")
            ? "manual_mismatch"
            : group.provisionRows.some((item) => item.status === "manual_open")
              ? "manual_open"
              : group.provisionRows.some((item) => item.status === "manual_partial")
                ? "manual_partial"
                : group.provisionRows.some((item) => item.status === "manual_matched")
                  ? "manual_matched"
                  : group.provisionRows.some((item) => item.status === "mes_reported")
                    ? "mes_reported"
                    : group.provisionRows[0]?.status ?? "needs_review",
          provisionRow,
          segments: group.segments,
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label, "ko-KR", { numeric: true, sensitivity: "base" }));

    return {
      plannedQty: Number(machiningProvision.summary.total_planned ?? 0),
      actualQty: Number(machiningProvision.summary.effective_actual_qty ?? 0),
      partCount: rows.reduce((sum, row) => sum + row.segments.length, 0),
      progressRate: Number(machiningProvision.summary.achievement_rate ?? 0),
      completedCount: rows.reduce((sum, row) => sum + row.completedCount, 0),
      inProgressCount: rows.reduce((sum, row) => sum + row.inProgressCount, 0),
      pendingCount: rows.reduce((sum, row) => sum + row.pendingCount, 0),
      rows,
    };
  }

  const planMap = new Map<string, {
    label: string;
    plannedQty: number;
    records: ProductionPlanRecord[];
  }>();
  const plannedParts = new Set<string>();

  for (const record of planSummary?.machining?.records ?? []) {
    const key = record.machine_name || "unknown";
    const current = planMap.get(key) ?? {
      label: record.machine_name || "-",
      plannedQty: 0,
      records: [],
    };
    current.plannedQty += Number(record.planned_quantity ?? 0);
    current.records.push(record);
    planMap.set(key, current);

    const partNo = normalizeDashboardPartNo(record.part_no);
    if (partNo) {
      plannedParts.add(partNo);
    }
  }

  const mesQtyByPart = new Map<string, number>();
  const mesRowsByPart = new Map<string, ProductionMesReportStatsResponse["rows"]>();

  for (const row of machiningStats?.rows ?? []) {
    const partNo = normalizeDashboardPartNo(row.part_no);
    const mesQty = Number(row.mes_qty ?? 0);
    if (!partNo || mesQty <= 0) continue;

    mesQtyByPart.set(partNo, (mesQtyByPart.get(partNo) ?? 0) + mesQty);
    mesRowsByPart.set(partNo, [...(mesRowsByPart.get(partNo) ?? []), row]);
  }

  const rows = [...planMap.entries()]
    .sort((left, right) => left[1].label.localeCompare(right[1].label, "ko-KR", { numeric: true, sensitivity: "base" }))
    .map(([key, plan]) => ({
      key,
      label: plan.label,
      plannedQty: plan.plannedQty,
      actualQty: 0,
      gapQty: 0,
      progressRate: 0,
      completedCount: 0,
      inProgressCount: 0,
      pendingCount: 0,
      segments: getOrderedPlanRecords(plan.records).map((record, index) => {
        const segmentPlannedQty = Number(record.planned_quantity ?? 0);
        const partNo = normalizeDashboardPartNo(record.part_no);
        const availableQty = partNo ? (mesQtyByPart.get(partNo) ?? 0) : 0;
        const estimatedQty = Math.min(segmentPlannedQty, Math.max(0, availableQty));

        if (partNo) {
          mesQtyByPart.set(partNo, Math.max(0, availableQty - estimatedQty));
        }

        const progressRate = segmentPlannedQty > 0 ? (estimatedQty / segmentPlannedQty) * 100 : 0;
        const status: RealtimeProgressSegmentStatus = estimatedQty >= segmentPlannedQty && segmentPlannedQty > 0
          ? "completed"
          : estimatedQty > 0
            ? "in_progress"
            : "pending";
        return {
          key: `${record.id ?? index}-${record.part_no ?? record.model_name ?? "part"}`,
          sequence: index + 1,
          partNo: record.part_no || record.model_name || record.part_spec || "-",
          modelName: record.model_name || record.part_spec || "-",
          lotNo: record.lot_no || "-",
          productFamilyCode: record.product_family_code || null,
          productFamilyName: record.product_family_name || null,
          isFinishedProduct: Boolean(record.is_finished_product),
          plannedQty: segmentPlannedQty,
          cavity: Math.max(1, Number(record.cavity ?? 1) || 1),
          requiredShots: segmentPlannedQty,
          allocatedShots: estimatedQty,
          estimatedQty,
          progressRate,
          status,
        };
      }),
    }))
    .map((row) => {
      const actualQty = row.segments.reduce((sum, segment) => sum + segment.estimatedQty, 0);
      const completedCount = row.segments.filter((segment) => segment.status === "completed").length;
      const inProgressCount = row.segments.filter((segment) => segment.status === "in_progress").length;
      const pendingCount = row.segments.filter((segment) => segment.status === "pending").length;
      const extraPartKeys = new Set<string>();
      const extraQty = getOrderedPlanRecords(planMap.get(row.key)?.records ?? []).reduce((sum, record) => {
        const partNo = normalizeDashboardPartNo(record.part_no);
        if (partNo && !extraPartKeys.has(partNo)) {
          const extra = mesQtyByPart.get(partNo) ?? 0;
          mesQtyByPart.set(partNo, 0);
          extraPartKeys.add(partNo);
          return sum + extra;
        }
        return sum;
      }, 0);
      const totalActualQty = actualQty + extraQty;
      return {
        ...row,
        actualQty: totalActualQty,
        gapQty: totalActualQty - row.plannedQty,
        progressRate: row.plannedQty > 0 ? (totalActualQty / row.plannedQty) * 100 : 0,
        completedCount,
        inProgressCount,
        pendingCount,
        mesQty: totalActualQty,
        manualOpenQty: 0,
        matchedManualQty: 0,
        defectQty: 0,
        status: "legacy" as const,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label, "ko-KR", { numeric: true, sensitivity: "base" }));

  const mesOnlyRows = [...mesRowsByPart.entries()]
    .filter(([partNo]) => !plannedParts.has(partNo))
    .map(([partNo, mesRows]) => {
      const mesQty = mesRows.reduce((sum, row) => sum + Number(row.mes_qty ?? 0), 0);
      const firstRow = mesRows[0];
      const segment: RealtimeProgressSegment = {
        key: `mes-only-${partNo}`,
        sequence: 1,
        partNo: firstRow?.part_no || partNo || "-",
        modelName: firstRow?.model_name || "-",
        lotNo: "-",
        productFamilyCode: null,
        productFamilyName: null,
        isFinishedProduct: false,
        plannedQty: 0,
        cavity: 1,
        requiredShots: 0,
        allocatedShots: mesQty,
        estimatedQty: mesQty,
        progressRate: 100,
        status: "completed" as const,
      };
      return {
        key: `mes-only-${partNo}`,
        label: firstRow?.equipment_label || firstRow?.equipment_name || firstRow?.equipment_key || "-",
        plannedQty: 0,
        actualQty: mesQty,
        gapQty: mesQty,
        progressRate: 100,
        completedCount: 1,
        inProgressCount: 0,
        pendingCount: 0,
        mesQty,
        manualOpenQty: 0,
        matchedManualQty: 0,
        defectQty: 0,
        status: "legacy" as const,
        segments: [segment],
      };
    });

  const allRows = [...rows, ...mesOnlyRows]
    .sort((left, right) => left.label.localeCompare(right.label, "ko-KR", { numeric: true, sensitivity: "base" }));
  const plannedQty = allRows.reduce((sum, row) => sum + row.plannedQty, 0);
  const actualQty = allRows.reduce((sum, row) => sum + row.actualQty, 0);

  return {
    plannedQty,
    actualQty,
    partCount: allRows.reduce((sum, row) => sum + row.segments.length, 0),
    progressRate: plannedQty > 0 ? (actualQty / plannedQty) * 100 : 0,
    completedCount: allRows.reduce((sum, row) => sum + row.completedCount, 0),
    inProgressCount: allRows.reduce((sum, row) => sum + row.inProgressCount, 0),
    pendingCount: allRows.reduce((sum, row) => sum + row.pendingCount, 0),
    rows: allRows,
  };
}

async function requestLocalDashboardIntent(question: string, businessDate: string) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 18_000);
  const systemPrompt = [
    "You convert Korean/Chinese manufacturing questions into JSON only.",
    "Do not answer or calculate.",
    "Schema:",
    '{"intent":"injection_cycle_time|production_output|production_status|production_summary|unknown","metric":"recent_60m_avg_ct_sec|estimated_qty|running_count|progress_rate|null","filters":{"running_only":true,"product_family":"BC|CA|GP|null","target_text":"part/model/machine text or null","machine":"machine text or null"},"sort":"ct_desc|ct_asc|output_desc|output_asc|null","limit":number}',
    `Default business_date is ${businessDate}.`,
    "Glossary: B/C/back cover/백커버=BC, C/A/cabinet=CA, G/P/guide panel=GP. C/T/ct/节拍/周期 means cycle time.",
  ].join(" ");

  try {
    const response = await fetch(`${LOCAL_LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: LOCAL_LLM_MODEL,
        temperature: 0,
        max_tokens: 220,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              'Q: 오늘 생산중인 사출기의 수는?\nA: {"intent":"production_status","metric":"running_count","filters":{"running_only":true,"product_family":null,"target_text":null,"machine":null},"sort":null,"limit":17}',
              'Q: 지금 백커버 만드는 기계 중 제일 느린 거 뭐야?\nA: {"intent":"injection_cycle_time","metric":"recent_60m_avg_ct_sec","filters":{"running_only":true,"product_family":"BC","target_text":null,"machine":null},"sort":"ct_desc","limit":1}',
              'Q: 24g411 오늘 얼마나 나왔어?\nA: {"intent":"production_output","metric":"estimated_qty","filters":{"running_only":false,"product_family":null,"target_text":"24G411","machine":null},"sort":"output_desc","limit":8}',
              'Q: 오늘 생산 진도 어때?\nA: {"intent":"production_summary","metric":"progress_rate","filters":{"running_only":false,"product_family":null,"target_text":null,"machine":null},"sort":null,"limit":8}',
              `Q: ${question}\nA:`,
            ].join("\n"),
          },
        ],
      }),
    });
    const data = await response.json();
    const content = String(data?.choices?.[0]?.message?.content ?? "");
    const parsed = normalizeDashboardIntent(extractJsonObject(content) as Partial<DashboardAiIntent>);
    if (parsed.intent !== "unknown") return parsed;
  } catch {
    // Fall through to the heuristic parser so local tests do not get blocked by MLX latency.
  } finally {
    window.clearTimeout(timeoutId);
  }

  return heuristicDashboardIntent(question);
}

function matchesPartTarget(segment: RealtimeProgressSegment | undefined, targetText: string | null | undefined) {
  if (!targetText) return true;
  if (!segment) return false;
  const needle = targetText.toUpperCase();
  const haystack = `${segment.partNo} ${segment.modelName}`.toUpperCase();
  return haystack.includes(needle);
}

function answerDashboardIntent(intent: DashboardAiIntent, realtimeProgress: RealtimeProgressSummary, language: AppLanguage) {
  const isChinese = language === "zh";
  const productFamily = intent.filters.product_family;
  const targetText = intent.filters.target_text;

  if (intent.intent === "production_status") {
    const runningRows = realtimeProgress.rows.filter((row) => {
      if (!row.isRunning) return false;
      const current = row.segments.find((segment) => segment.status === "in_progress");
      if (productFamily && current?.productFamilyCode !== productFamily) return false;
      return true;
    });
    const labels = runningRows.map((row) => getLocalizedMachineLabel(row.label, language)).join(", ") || "-";
    return isChinese
      ? `最近60分钟合模数 기준 현재 생산중인 사출기는 ${runningRows.length}대입니다. 대상 설비: ${labels}.`
      : `최근 60분 형합수 기준 현재 생산중인 사출기는 ${runningRows.length}대입니다. 대상 설비는 ${labels}입니다.`;
  }

  if (intent.intent === "injection_cycle_time") {
    const rows = realtimeProgress.rows
      .map((row) => ({ row, current: row.segments.find((segment) => segment.status === "in_progress") }))
      .filter(({ row, current }) => {
        if (intent.filters.running_only && !row.isRunning) return false;
        if (productFamily && current?.productFamilyCode !== productFamily) return false;
        if (!matchesPartTarget(current, targetText)) return false;
        return row.recentCycleTimeSec !== null;
      })
      .map(({ row, current }) => ({
        machine: getLocalizedMachineLabel(row.label, language),
        partNo: current?.partNo ?? "-",
        modelName: current?.modelName ?? "-",
        family: current?.productFamilyName ?? "-",
        shots: row.recentShots,
        ct: row.recentCycleTimeSec ?? 0,
      }));

    if (intent.sort === "ct_desc") rows.sort((a, b) => b.ct - a.ct);
    if (intent.sort === "ct_asc") rows.sort((a, b) => a.ct - b.ct);
    if (!rows.length) return isChinese ? "未找到符合条件的最近60分钟 C/T 数据。" : "조건에 맞는 최근 60분 C/T 데이터를 찾지 못했습니다.";
    if (intent.limit === 1 || intent.sort === "ct_desc" || intent.sort === "ct_asc") {
      const top = rows[0];
      return isChinese
        ? `最近60分钟 기준 ${top.machine} 的 C/T 约 ${top.ct.toFixed(1)} 秒，当前推定 Part 为 ${top.partNo}（${top.modelName}，${top.family}），60分钟合模数 ${top.shots} 次。`
        : `최근 60분 기준 ${top.machine}의 평균 C/T는 약 ${top.ct.toFixed(1)}초입니다. 현재 추정 Part는 ${top.partNo} (${top.modelName}, ${top.family})이고, 최근 60분 형합수는 ${formatNumber(top.shots)}회입니다.`;
    }
    const averageCt = rows.reduce((sum, row) => sum + row.ct, 0) / rows.length;
    const details = rows.slice(0, intent.limit ?? 8).map((row) => `${row.machine} ${row.ct.toFixed(1)}초`).join(", ");
    return `최근 60분 기준 대상 사출기 ${rows.length}대의 평균 C/T는 약 ${averageCt.toFixed(1)}초입니다. 설비별로는 ${details}입니다.`;
  }

  if (intent.intent === "production_output") {
    const items = realtimeProgress.rows.flatMap((row) => row.segments
      .filter((segment) => {
        if (productFamily && segment.productFamilyCode !== productFamily) return false;
        if (!matchesPartTarget(segment, targetText)) return false;
        return true;
      })
      .map((segment) => ({
        machine: getLocalizedMachineLabel(row.label, language),
        partNo: segment.partNo,
        estimatedQty: segment.estimatedQty,
        plannedQty: segment.plannedQty,
      })));
    items.sort((a, b) => b.estimatedQty - a.estimatedQty);
    if (!items.length) return isChinese ? "未找到符合条件的生产计划或 MES 推定实绩。" : "조건에 맞는 생산계획 또는 MES 추정 실적을 찾지 못했습니다.";
    const totalEstimated = items.reduce((sum, item) => sum + item.estimatedQty, 0);
    const totalPlanned = items.reduce((sum, item) => sum + item.plannedQty, 0);
    const details = items.slice(0, intent.limit ?? 8).map((item) => `${item.machine} ${item.partNo} ${formatNumber(item.estimatedQty)}/${formatNumber(item.plannedQty)}개`).join(", ");
    return `기준일 현재 추정 생산량은 총 ${formatNumber(totalEstimated)}개이고, 계획은 ${formatNumber(totalPlanned)}개입니다. 설비별 주요 내역은 ${details}입니다.`;
  }

  if (intent.intent === "production_summary") {
    const segments = realtimeProgress.rows.flatMap((row) => row.segments)
      .filter((segment) => !productFamily || segment.productFamilyCode === productFamily);
    const plannedQty = segments.reduce((sum, segment) => sum + segment.plannedQty, 0);
    const estimatedQty = segments.reduce((sum, segment) => sum + segment.estimatedQty, 0);
    const progressRate = plannedQty > 0 ? (estimatedQty / plannedQty) * 100 : 0;
    const completed = segments.filter((segment) => segment.status === "completed").length;
    const inProgress = segments.filter((segment) => segment.status === "in_progress").length;
    const pending = segments.filter((segment) => segment.status === "pending").length;
    const runningRows = realtimeProgress.rows.filter((row) => row.isRunning);
    const topRows = [...realtimeProgress.rows]
      .filter((row) => row.estimatedQty > 0)
      .sort((a, b) => b.estimatedQty - a.estimatedQty)
      .slice(0, 4)
      .map((row) => `${getLocalizedMachineLabel(row.label, language)} ${formatNumber(row.estimatedQty)}개`)
      .join(", ") || "-";
    return isChinese
      ? `今天注塑进度约 ${Math.round(progressRate)}%，推定实绩 ${formatNumber(estimatedQty)} / 计划 ${formatNumber(plannedQty)} 个。最近60分钟运行设备 ${runningRows.length}台，状态为完成 ${completed}、进行中 ${inProgress}、待开始 ${pending}。主要生产设备: ${topRows}。`
      : `오늘 사출 생산 진도는 약 ${Math.round(progressRate)}%입니다. 추정 실적은 ${formatNumber(estimatedQty)} / 계획 ${formatNumber(plannedQty)}개이고, 최근 60분 기준 가동 사출기는 ${runningRows.length}대입니다. 작업 상태는 완료 ${completed}건, 진행중 ${inProgress}건, 대기 ${pending}건이며, 상위 생산 설비는 ${topRows}입니다.`;
  }

  return null;
}

async function answerWithLocalMlxFallback(question: string, businessDate: string, realtimeProgress: RealtimeProgressSummary, language: AppLanguage) {
  const intent = await requestLocalDashboardIntent(question, businessDate);
  const answer = answerDashboardIntent(intent, realtimeProgress, language);
  return answer ?? (language === "ko"
    ? "질문 의도는 해석했지만 현재 대시보드 데이터로 계산 가능한 답을 찾지 못했습니다."
    : "已解析问题意图，但当前看板数据无法计算出答案。");
}

function buildRuleBasedBrief(context: ProductionBriefContext, language: AppLanguage) {
  const planRate = context.injectionPlanQty > 0
    ? Math.round((context.actualInjectionOutput / context.injectionPlanQty) * 100)
    : 0;
  const unit = language === "ko" ? "개" : "个";
  const gapText = context.planGap >= 0
    ? (language === "ko" ? `계획 대비 ${formatNumber(context.planGap)}${unit} 초과` : `较计划超出 ${formatNumber(context.planGap)}${unit}`)
    : (language === "ko" ? `계획 대비 ${formatNumber(Math.abs(context.planGap))}${unit} 부족` : `较计划不足 ${formatNumber(Math.abs(context.planGap))}${unit}`);
  const topText = context.topMachines.length
    ? context.topMachines.map((item) => `${item.machine} ${formatNumber(item.output)}${unit}`).join(", ")
    : (language === "ko" ? "생산 실적 없음" : "暂无生产实绩");
  const lowText = context.lowOutputMachines.length
    ? context.lowOutputMachines.map((item) => `${item.machine} ${formatNumber(item.output)}${unit}`).join(", ")
    : (language === "ko" ? "확인 대상 없음" : "暂无需确认设备");

  if (language === "zh") {
    return [
      `${context.businessDate} 基准日注塑实绩为 ${formatNumber(context.actualInjectionOutput)}${unit}，对比注塑计划 ${formatNumber(context.injectionPlanQty)}${unit}，进度约 ${planRate}%。加工实绩为 ${formatNumber(context.actualMachiningOutput)}${unit}，计划为 ${formatNumber(context.machiningPlanQty)}${unit}。`,
      `基准日 ${context.activeMachineCount}/${context.totalMachines} 台设备有生产实绩，区间最后 60 分钟运行设备为 ${context.runningMachineCount} 台。当前为${gapText}。`,
      `主要生产设备为 ${topText}。低实绩设备为 ${lowText}，如计划存在缺口，建议优先确认停机记录与作业安排。`,
    ].join("\n\n");
  }

  return [
    `${context.businessDate} 기준일의 사출 실적은 ${formatNumber(context.actualInjectionOutput)}${unit}이며, 사출 계획 ${formatNumber(context.injectionPlanQty)}${unit} 대비 진행률은 약 ${planRate}%입니다. 가공 실적은 ${formatNumber(context.actualMachiningOutput)}${unit}, 가공 계획은 ${formatNumber(context.machiningPlanQty)}${unit}입니다.`,
    `기준일에 ${context.activeMachineCount}/${context.totalMachines}대가 생산 실적을 남겼고, 선택 구간 마지막 60분 기준 가동 설비는 ${context.runningMachineCount}대입니다. ${gapText} 상태입니다.`,
    `상위 생산 설비는 ${topText}입니다. 낮은 실적 설비는 ${lowText}이며, 계획 대비 부족 상태라면 해당 설비의 정지 이력과 작업 배정을 먼저 확인하는 것이 좋습니다.`,
  ].join("\n\n");
}

function ProductionDashboardSkeleton({ copy }: { copy: Record<string, string> }) {
  return (
    <div className="production-dashboard-skeleton" aria-label={copy.loading} role="status">
      <div className="stats-grid">
        {[0, 1, 2, 3].map((item) => (
          <article className="stat-card production-skeleton-card" key={item}>
            <span className="mes-skeleton-line mes-skeleton-line--eyebrow" />
            <span className="mes-skeleton-line mes-skeleton-line--value" />
            <span className="mes-skeleton-line" />
          </article>
        ))}
      </div>

      <section className="panel production-brief-panel">
        <div className="production-brief-panel__header">
          <div className="mes-skeleton-heading">
            <span className="mes-skeleton-line mes-skeleton-line--eyebrow" />
            <span className="mes-skeleton-line mes-skeleton-line--title" />
          </div>
          <span className="mes-skeleton-line production-skeleton-button" />
        </div>
        <div className="production-brief-panel__body production-skeleton-brief">
          <span className="mes-skeleton-line mes-skeleton-line--wide" />
          <span className="mes-skeleton-line" />
          <span className="mes-skeleton-line mes-skeleton-line--short" />
        </div>
      </section>

      <section className="panel production-progress-panel">
        <div className="mes-skeleton-heading">
          <span className="mes-skeleton-line mes-skeleton-line--eyebrow" />
          <span className="mes-skeleton-line mes-skeleton-line--title" />
        </div>
        <div className="production-progress-grid">
          {[0, 1].map((card) => (
            <article className="production-progress-card" key={card}>
              <div className="production-progress-visual-summary">
                <span className="production-skeleton-ring" />
                <div className="mes-skeleton-heading">
                  <span className="mes-skeleton-line mes-skeleton-line--title" />
                  <span className="mes-skeleton-line" />
                  <span className="mes-skeleton-line mes-skeleton-line--short" />
                </div>
              </div>
              <div className="production-progress-list">
                {[0, 1, 2, 3].map((row) => (
                  <div className="production-progress-row production-skeleton-row" key={row}>
                    <div className="production-progress-row__head">
                      <span className="mes-skeleton-line mes-skeleton-line--short" />
                      <span className="mes-skeleton-line production-skeleton-pill" />
                    </div>
                    <span className="mes-skeleton-line production-skeleton-track" />
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export function ProductionDashboardPage() {
  const queryClient = useQueryClient();
  const [language] = useStoredLanguage();
  const currentDate = getShanghaiDateString();
  const [businessDate, setBusinessDate] = useState(currentDate);
  const [isAiAskOpen, setIsAiAskOpen] = useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [activeAiJobId, setActiveAiJobId] = useState<number | null>(null);
  const [selectedProgressRow, setSelectedProgressRow] = useState<RealtimeProgressRow | null>(null);
  const [selectedMachiningRow, setSelectedMachiningRow] = useState<MachiningProvisionRow | null>(null);
  const [activeKpiDetail, setActiveKpiDetail] = useState<KpiDetailKey | null>(null);
  const [activitySelection, setActivitySelection] = useState<MachineActivitySelection | null>(null);
  const suppressNextActivityPointerRef = useRef(false);
  const [manualForm, setManualForm] = useState({
    goodQty: "",
    defectQty: "0",
    defectType: "",
    reasonCode: "mes_work_order_missing",
    note: "",
  });
  const copy = pageCopy[language];
  const detailCopy = kpiDetailCopy[language];
  const activityCopy = activitySelectionCopy[language];
  const isCurrentDate = businessDate === currentDate;
  const liveDataRefetchInterval = isCurrentDate ? LIVE_DATA_REFRESH_INTERVAL_MS : false;
  const previousBusinessDate = addBusinessDateDays(businessDate, -1);
  const nextBusinessDate = addBusinessDateDays(businessDate, 1);
  const secondNextBusinessDate = addBusinessDateDays(businessDate, 2);
  const planSummaryQuery = useQuery({
    queryKey: ["production-plan-summary", businessDate],
    queryFn: () => getProductionPlanSummary(businessDate),
  });
  const nextPlanSummaryQuery = useQuery({
    queryKey: ["production-plan-summary", nextBusinessDate],
    queryFn: () => getProductionPlanSummary(nextBusinessDate),
  });
  const secondNextPlanSummaryQuery = useQuery({
    queryKey: ["production-plan-summary", secondNextBusinessDate],
    queryFn: () => getProductionPlanSummary(secondNextBusinessDate),
  });
  const productionStatusQuery = useQuery({
    queryKey: ["production-status", businessDate],
    queryFn: () => getProductionStatus(businessDate),
    refetchInterval: liveDataRefetchInterval,
  });
  const machiningStatsQuery = useQuery({
    queryKey: ["production-mes-report-stats", "machining", businessDate],
    queryFn: () => getProductionMesReportStats(businessDate, "machining"),
  });
  const machiningProvisionQuery = useQuery({
    queryKey: ["production", "machining-provision", businessDate],
    queryFn: () => getMachiningProvision(businessDate, 3),
    refetchInterval: liveDataRefetchInterval,
    retry: false,
  });
  const mesQuery = useQuery({
    queryKey: ["mes", "production-dashboard-matrix", businessDate, isCurrentDate],
    queryFn: () => (isCurrentDate ? getInjectionProductionMatrix() : getInjectionProductionMatrixForDate(businessDate)),
    refetchInterval: liveDataRefetchInterval,
  });
  const previousMesQuery = useQuery({
    queryKey: ["mes", "production-dashboard-matrix", previousBusinessDate, "ma-history"],
    queryFn: () => getInjectionProductionMatrixForDate(previousBusinessDate),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const isCoreDashboardDataReady = Boolean(planSummaryQuery.data && mesQuery.data && machiningStatsQuery.data);
  const aiBriefingQuery = useQuery({
    queryKey: ["production", "ai-briefing", businessDate, language],
    queryFn: () => getProductionAiBriefing(businessDate, language),
    enabled: isCoreDashboardDataReady,
    refetchInterval: isCurrentDate && isCoreDashboardDataReady ? AI_BRIEFING_REFRESH_INTERVAL_MS : false,
    retry: 1,
  });
  const aiJobQuery = useQuery({
    queryKey: ["ai-job", activeAiJobId],
    queryFn: () => getAiJob(activeAiJobId ?? 0),
    enabled: Boolean(activeAiJobId),
    refetchInterval: (query) => {
      const job = query.state.data as AiJob | undefined;
      return job && !isAiJobTerminal(job.status) ? 3_000 : false;
    },
  });
  const createAiJobMutation = useMutation({
    mutationFn: () => createAiJob({
      job_type: "production_daily_analysis",
      scope: { date: businessDate, language },
    }),
    onSuccess: (job) => {
      setActiveAiJobId(job.id);
      queryClient.setQueryData(["ai-job", job.id], job);
    },
  });
  const cancelAiJobMutation = useMutation({
    mutationFn: (jobId: number) => cancelAiJob(jobId),
    onSuccess: (job) => {
      queryClient.setQueryData(["ai-job", job.id], job);
    },
  });
  const createManualReportMutation = useMutation({
    mutationFn: () => {
      if (!selectedMachiningRow?.plan_id) {
        throw new Error("plan_id is required");
      }
      const defectQty = Math.max(0, Number(manualForm.defectQty || 0) || 0);
      const defectType = manualForm.defectType.trim();
      return createMachiningManualReport({
        business_date: businessDate,
        plan_id: selectedMachiningRow.plan_id,
        good_qty: Math.max(0, Number(manualForm.goodQty || 0) || 0),
        defect_qty: defectQty,
        defect_items: defectQty > 0 && defectType
          ? [{ defect_category: "processing", defect_type: defectType, quantity: defectQty }]
          : [],
        reason_code: manualForm.reasonCode.trim() || "mes_work_order_missing",
        note: manualForm.note.trim(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["production", "machining-provision"] });
      queryClient.invalidateQueries({ queryKey: ["production-status"] });
      queryClient.invalidateQueries({ queryKey: ["production", "ai-briefing"] });
      setSelectedMachiningRow(null);
    },
  });

  const transitionAnalysis = useMemo(
    () => buildInjectionTransitionAnalysis(
      planSummaryQuery.data,
      mesQuery.data,
      businessDate,
      undefined,
      [nextPlanSummaryQuery.data, secondNextPlanSummaryQuery.data].filter(
        (summary): summary is NonNullable<typeof summary> => Boolean(summary),
      ),
    ),
    [businessDate, mesQuery.data, nextPlanSummaryQuery.data, planSummaryQuery.data, secondNextPlanSummaryQuery.data],
  );
  const briefContext = useMemo(
    () => buildProductionBriefContext(
      businessDate,
      planSummaryQuery.data,
      mesQuery.data,
      machiningStatsQuery.data,
      productionStatusQuery.data,
      machiningProvisionQuery.data,
      transitionAnalysis,
      language,
    ),
    [businessDate, language, machiningProvisionQuery.data, machiningStatsQuery.data, mesQuery.data, planSummaryQuery.data, productionStatusQuery.data, transitionAnalysis],
  );
  const realtimeProgress = useMemo(
    () => buildRealtimeProgressSummary(planSummaryQuery.data, mesQuery.data, productionStatusQuery.data, businessDate, transitionAnalysis),
    [businessDate, mesQuery.data, planSummaryQuery.data, productionStatusQuery.data, transitionAnalysis],
  );
  const machiningProgress = useMemo(
    () => buildMachiningProgressPreview(planSummaryQuery.data, machiningStatsQuery.data, machiningProvisionQuery.data),
    [machiningProvisionQuery.data, machiningStatsQuery.data, planSummaryQuery.data],
  );
  const ruleBasedBrief = useMemo(() => buildRuleBasedBrief(briefContext, language), [briefContext, language]);
  const briefingText = aiBriefingQuery.data?.answer || ruleBasedBrief;
  const activeAiJob = aiJobQuery.data;
  const activeAiJobResult = activeAiJob?.result_payload ?? {};
  const activeAiJobSummary = getStringField(activeAiJobResult, "summary");
  const activeAiJobTopIssues = getTopIssues(activeAiJobResult);
  const aiQuestionMutation = useMutation({
    mutationFn: async () => {
      try {
        const response = await askProductionAi(businessDate, aiQuestion, language);
        if (response.source !== "timeout_or_llm_error") {
          return response;
        }
      } catch {
        // In local development the API may still point to Render, which cannot reach this Mac's MLX server.
      }
      const answer = await answerWithLocalMlxFallback(aiQuestion, businessDate, realtimeProgress, language);
      return { answer, source: "local_llm" as const };
    },
    onSuccess: (payload) => setAiAnswer(payload.answer),
  });

  useEffect(() => {
    setAiAnswer(null);
  }, [language, briefContext.businessDate, briefContext.latestUpdatedAt]);

  useEffect(() => {
    setActiveAiJobId(null);
  }, [businessDate, language]);

  useEffect(() => {
    setActivitySelection(null);
  }, [businessDate, language]);

  function submitAiQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!aiQuestion.trim() || aiQuestionMutation.isPending) return;
    aiQuestionMutation.mutate();
  }

  const isInitialLoading = !isCoreDashboardDataReady && (planSummaryQuery.isFetching || mesQuery.isFetching || machiningStatsQuery.isFetching);
  const isLiveDataRefreshing = isCoreDashboardDataReady && (productionStatusQuery.isFetching || machiningProvisionQuery.isFetching || mesQuery.isFetching);
  const injectionCompletionRate = briefContext.injectionPlanQty > 0
    ? (briefContext.actualInjectionOutput / briefContext.injectionPlanQty) * 100
    : 0;
  const machiningCompletionRate = briefContext.machiningPlanQty > 0
    ? (briefContext.actualMachiningOutput / briefContext.machiningPlanQty) * 100
    : 0;
  const productionElapsedRate = getProductionElapsedRate(businessDate, mesQuery.data);
  const injectionRateTone = getRateTone(injectionCompletionRate, productionElapsedRate);
  const machiningSummaryMesQty = Number(machiningProvisionQuery.data?.summary.mes_qty ?? machiningStatsQuery.data?.summary.total_mes ?? machiningProgress.actualQty);
  const machiningSummaryManualOpenQty = Number(machiningProvisionQuery.data?.summary.manual_open_qty ?? 0);
  const machiningSummaryEffectiveQty = Number(machiningProvisionQuery.data?.summary.effective_actual_qty ?? machiningProgress.actualQty);
  const machiningSummaryAdvanceQty = Number(machiningProvisionQuery.data?.summary.advance_qty ?? 0);
  const activeMachiningLineCount = new Set(
    (machiningProvisionQuery.data?.rows ?? machiningProgress.rows)
      .filter((row) => Number("effective_actual_qty" in row ? row.effective_actual_qty : row.actualQty) > 0)
      .map((row) => {
        if ("equipment_label" in row) {
          return row.equipment_label || row.machine_name || row.equipment_key;
        }
        return row.label;
      })
      .filter(Boolean),
  ).size;
  const injectionTrend = useMemo(
    () => buildInjectionCumulativeTrend(
      businessDate,
      briefContext.injectionPlanQty,
      briefContext.actualInjectionOutput,
      mesQuery.data,
    ),
    [briefContext.actualInjectionOutput, briefContext.injectionPlanQty, businessDate, mesQuery.data],
  );
  const machiningTrend = useMemo(
    () => buildMachiningCumulativeTrend(
      businessDate,
      briefContext.machiningPlanQty,
      briefContext.actualMachiningOutput,
      machiningProgress,
      machiningStatsQuery.data,
      machiningProvisionQuery.data,
      mesQuery.data,
    ),
    [
      briefContext.actualMachiningOutput,
      briefContext.machiningPlanQty,
      businessDate,
      machiningProgress,
      machiningProvisionQuery.data,
      machiningStatsQuery.data,
      mesQuery.data,
    ],
  );
  const machineActivityRows = useMemo(
    () => buildMachineActivityRows(businessDate, mesQuery.data, language, realtimeProgress),
    [businessDate, language, mesQuery.data, realtimeProgress],
  );
  const previousMachineActivityRows = useMemo(
    () => buildMachineActivityRows(previousBusinessDate, previousMesQuery.data, language),
    [language, previousBusinessDate, previousMesQuery.data],
  );
  const machineActivitySummary = useMemo(
    () => buildMachineActivitySummary(businessDate, mesQuery.data, machineActivityRows, previousMesQuery.data, previousMachineActivityRows),
    [businessDate, machineActivityRows, mesQuery.data, previousMachineActivityRows, previousMesQuery.data],
  );
  const activitySelectionSummary = useMemo(
    () => summarizeActivitySelection(activitySelection, businessDate, machineActivityRows, language),
    [activitySelection, businessDate, language, machineActivityRows],
  );

  useEffect(() => {
    if (!activitySelection || activitySelection.isDragging) return undefined;

    function clearSelectionFromOutside(event: PointerEvent) {
      const target = event.target as Element | null;
      if (target?.closest(".production-machine-activity__selection-layer")) return;
      suppressNextActivityPointerRef.current = true;
      window.setTimeout(() => {
        suppressNextActivityPointerRef.current = false;
      }, 0);
      setActivitySelection(null);
    }

    document.addEventListener("pointerdown", clearSelectionFromOutside, true);
    return () => document.removeEventListener("pointerdown", clearSelectionFromOutside, true);
  }, [activitySelection]);

  function openMachiningManualReport(row: MachiningProvisionRow) {
    const remainingQty = Math.max(0, Number(row.planned_qty ?? 0) - Number(row.effective_actual_qty ?? 0));
    setSelectedMachiningRow(row);
    setManualForm({
      goodQty: remainingQty > 0 ? String(remainingQty) : "",
      defectQty: "0",
      defectType: "",
      reasonCode: "mes_work_order_missing",
      note: "",
    });
  }

  function getRingStyle(progressRate: number) {
    const degree = Math.max(0, Math.min(100, progressRate)) * 3.6;
    return { "--progress-deg": `${degree}deg` } as CSSProperties;
  }

  function getProgressText(progressRate: number) {
    return `${Math.round(Math.max(0, progressRate))}%`;
  }

  function getOverrunRate(gapQty: number, plannedQty: number) {
    if (gapQty <= 0 || plannedQty <= 0) return null;
    return Math.round((gapQty / plannedQty) * 100);
  }

  function getOverrunText(gapQty: number, plannedQty: number) {
    const overrunRate = getOverrunRate(gapQty, plannedQty);
    const quantityText = `+${formatNumber(gapQty)}`;
    return overrunRate === null ? quantityText : `${quantityText} (+${overrunRate}%)`;
  }

  function getOverrunLabel(gapQty: number, plannedQty: number) {
    const overrunRate = getOverrunRate(gapQty, plannedQty);
    return overrunRate === null ? `+${formatNumber(gapQty)}` : `+${overrunRate}%`;
  }

  function renderOverrunChip(quantity: number, plannedQty: number) {
    if (quantity <= 0) return null;
    return (
      <span className="production-progress-chip production-progress-chip--overrun">
        {copy.overrunShort} {getOverrunText(quantity, plannedQty)}
      </span>
    );
  }

  function getActivityPointerPercent(event: ReactPointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clampPercent(((event.clientX - rect.left) / rect.width) * 100);
  }

  function getActivitySelectionLayerPoint(
    origin: MachineActivitySelection["origin"],
    event: ReactPointerEvent<HTMLElement>,
    startPct: number,
    endPct: number,
  ) {
    const rect = event.currentTarget.getBoundingClientRect();
    const centerPct = clampPercent((startPct + endPct) / 2);
    const layerWidth = origin === "timeline" ? 640 : 560;
    const layerHeight = origin === "timeline" ? 178 : 206;
    const margin = 18;
    const rawX = rect.left + rect.width * (centerPct / 100);
    const rawY = origin === "timeline" ? rect.bottom + 14 : rect.top + 14;
    return {
      layerX: Math.max(margin + layerWidth / 2, Math.min(window.innerWidth - margin - layerWidth / 2, rawX)),
      layerY: Math.max(margin, Math.min(window.innerHeight - layerHeight - margin, rawY)),
    };
  }

  function beginActivitySelection(
    origin: MachineActivitySelection["origin"],
    event: ReactPointerEvent<HTMLElement>,
    machineNumber?: number,
  ) {
    if (event.button !== 0) return;
    if (suppressNextActivityPointerRef.current) {
      suppressNextActivityPointerRef.current = false;
      return;
    }
    const pct = getActivityPointerPercent(event);
    const layerPoint = getActivitySelectionLayerPoint(origin, event, pct, pct);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setActivitySelection({
      origin,
      machineNumber,
      startPct: pct,
      endPct: pct,
      isDragging: true,
      ...layerPoint,
    });
  }

  function moveActivitySelection(
    origin: MachineActivitySelection["origin"],
    event: ReactPointerEvent<HTMLElement>,
    machineNumber?: number,
  ) {
    const pct = getActivityPointerPercent(event);
    setActivitySelection((current) => {
      if (!current?.isDragging || current.origin !== origin || current.machineNumber !== machineNumber) return current;
      return { ...current, endPct: pct, ...getActivitySelectionLayerPoint(origin, event, current.startPct, pct) };
    });
  }

  function endActivitySelection(
    origin: MachineActivitySelection["origin"],
    event: ReactPointerEvent<HTMLElement>,
    machineNumber?: number,
  ) {
    const pct = getActivityPointerPercent(event);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setActivitySelection((current) => {
      if (!current || current.origin !== origin || current.machineNumber !== machineNumber) return current;
      const nextEndPct = Math.abs(current.startPct - pct) < 0.35 ? Math.min(100, current.startPct + 2) : pct;
      return {
        ...current,
        endPct: nextEndPct,
        isDragging: false,
        ...getActivitySelectionLayerPoint(origin, event, current.startPct, nextEndPct),
      };
    });
  }

  function getActivitySelectionVisuals(origin: MachineActivitySelection["origin"], machineNumber?: number) {
    if (!activitySelection || activitySelection.origin !== origin || activitySelection.machineNumber !== machineNumber) return null;
    const bounds = getActivitySelectionBounds(activitySelection);
    return {
      selectionStyle: {
        left: `${bounds.startPct}%`,
        width: `${bounds.widthPct}%`,
      } as CSSProperties,
      leftDimStyle: {
        left: "0%",
        width: `${bounds.startPct}%`,
      } as CSSProperties,
      rightDimStyle: {
        left: `${bounds.startPct + bounds.widthPct}%`,
        width: `${Math.max(0, 100 - bounds.startPct - bounds.widthPct)}%`,
      } as CSSProperties,
      layerStyle: {
        left: `${activitySelection.layerX}px`,
        top: `${activitySelection.layerY}px`,
      } as CSSProperties,
    };
  }

  function renderActivitySelectionOverlays(origin: MachineActivitySelection["origin"], machineNumber?: number) {
    if (!activitySelection || !activitySelectionSummary) return null;
    const visuals = getActivitySelectionVisuals(origin, machineNumber);
    if (!visuals) return null;
    const partRows = activitySelectionSummary.partRows.slice(0, origin === "timeline" ? 2 : 3);
    const machineRows = activitySelectionSummary.machineRows.slice(0, origin === "timeline" ? 2 : 3);
    const layerClassName = [
      "production-machine-activity__selection-layer",
      origin === "timeline" ? "production-machine-activity__selection-layer--track" : "",
    ].filter(Boolean).join(" ");

    return (
      <>
        <span className="production-machine-activity__selection-dim" style={visuals.leftDimStyle} aria-hidden="true" />
        <span className="production-machine-activity__selection-dim" style={visuals.rightDimStyle} aria-hidden="true" />
        <span className="production-machine-activity__selection" style={visuals.selectionStyle} aria-hidden="true" />
        <div className={layerClassName} style={visuals.layerStyle}>
          <div className="production-machine-activity__selection-layer-head">
            <div>
              <span>{activityCopy.range}</span>
              <strong>{activitySelectionSummary.startLabel} - {activitySelectionSummary.endLabel}</strong>
            </div>
            <div>
              <span>{activityCopy.total}</span>
              <strong>
                {activityCopy.clampCount} {formatNumber(activitySelectionSummary.totalOutput)}
                {" · "}
                {activityCopy.estimatedQty} {formatNumber(activitySelectionSummary.totalEstimatedQty)}
              </strong>
            </div>
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setActivitySelection(null);
              }}
            >
              {activityCopy.clear}
            </button>
          </div>
          {partRows.length || machineRows.length ? (
            <div className="production-machine-activity__selection-layer-grid">
              <div>
                <strong>{activityCopy.selectedParts}</strong>
                <ul>
                  {partRows.map((row) => (
                    <li key={row.key}>
                      <i
                        style={{
                          "--activity-hue": row.partHue ? String(row.partHue) : undefined,
                          "--activity-lightness": row.partLightness ? `${row.partLightness}%` : undefined,
                          "--activity-saturation": row.partSaturation ? `${row.partSaturation}%` : undefined,
                        } as CSSProperties}
                      />
                      <span>{row.machineLabel} · {row.partNo}</span>
                      <b>{activityCopy.clampCount} {formatNumber(row.output)} · {activityCopy.estimatedQty} {formatNumber(row.estimatedQty)}</b>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>{activityCopy.selectedMachines}</strong>
                <ul>
                  {machineRows.map((row) => (
                    <li key={row.key}>
                      <span>{row.machineLabel}</span>
                      <b>{activityCopy.clampCount} {formatNumber(row.output)} · {activityCopy.estimatedQty} {formatNumber(row.estimatedQty)}</b>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className="production-machine-activity__selection-layer-empty">{activityCopy.noSelection}</p>
          )}
        </div>
      </>
    );
  }

  function renderActivitySelectionSummary() {
    if (!activitySelection || !activitySelectionSummary) return null;
    const partRows = activitySelectionSummary.partRows.slice(0, 6);
    const machineRows = activitySelectionSummary.machineRows.slice(0, 8);

    return (
      <div className="production-machine-activity__selection-panel">
        <div className="production-machine-activity__selection-head">
          <div>
            <span>{activityCopy.range}</span>
            <strong>{activitySelectionSummary.startLabel} - {activitySelectionSummary.endLabel}</strong>
          </div>
          <div>
            <span>{activityCopy.total}</span>
            <strong>
              {activityCopy.clampCount} {formatNumber(activitySelectionSummary.totalOutput)}
              {" · "}
              {activityCopy.estimatedQty} {formatNumber(activitySelectionSummary.totalEstimatedQty)}
            </strong>
          </div>
          <button type="button" onClick={() => setActivitySelection(null)}>
            {activityCopy.clear}
          </button>
        </div>
        {partRows.length || machineRows.length ? (
          <div className="production-machine-activity__selection-grid">
            <div>
              <strong>{activityCopy.selectedParts}</strong>
              <ul>
                {partRows.map((row) => (
                  <li key={row.key}>
                    <i
                      style={{
                        "--activity-hue": row.partHue ? String(row.partHue) : undefined,
                        "--activity-lightness": row.partLightness ? `${row.partLightness}%` : undefined,
                        "--activity-saturation": row.partSaturation ? `${row.partSaturation}%` : undefined,
                      } as CSSProperties}
                    />
                    <span>{row.machineLabel} · {row.partNo}</span>
                    <b>{activityCopy.clampCount} {formatNumber(row.output)} · {activityCopy.estimatedQty} {formatNumber(row.estimatedQty)}</b>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <strong>{activityCopy.selectedMachines}</strong>
              <ul>
                {machineRows.map((row) => (
                  <li key={row.key}>
                    <span>{row.machineLabel}</span>
                    <b>{activityCopy.clampCount} {formatNumber(row.output)} · {activityCopy.estimatedQty} {formatNumber(row.estimatedQty)}</b>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <p className="production-machine-activity__selection-empty">{activityCopy.noSelection}</p>
        )}
      </div>
    );
  }

  function renderProgressSegment(segment: RealtimeProgressSegment, row: { plannedQty: number } | null) {
    const share = row && row.plannedQty > 0 ? segment.plannedQty / row.plannedQty : 0;

    return (
      <span
        className={`production-part-segment production-part-segment--${segment.status}`}
        key={segment.key}
        style={{ flexBasis: 0, flexGrow: Math.max(segment.plannedQty, 1) }}
      >
        <span
          className="production-part-segment__fill"
          style={{ width: `${Math.max(0, Math.min(100, segment.progressRate))}%` }}
        />
        {share > 0.18 ? <em>{segment.partNo}</em> : null}
      </span>
    );
  }

  function renderProgressHoverCard(options: {
    label: string;
    progressText: string;
    actualLabel: string;
    actualQty: number;
    plannedQty: number;
    gapQty: number;
    completedCount: number;
    inProgressCount: number;
    pendingCount: number;
    currentPart?: string;
    shotCount?: number;
    recentShots?: number;
    avgCavity?: number;
    mesQty?: number;
    manualOpenQty?: number;
    matchedManualQty?: number;
    defectQty?: number;
    showInjectionMetrics?: boolean;
    segments: RealtimeProgressSegment[];
  }) {
    const displaySegments = getDisplaySegments(options.segments);
    return (
      <div className="production-progress-hover-card" role="tooltip">
        <div className="production-progress-hover-card__head">
          <span>{copy.machineSummaryTitle}</span>
          <strong>{options.label}</strong>
          <em>{options.progressText}</em>
        </div>
        <dl>
          <div>
            <dt>{options.actualLabel}</dt>
            <dd>{formatNumber(options.actualQty)} / {formatNumber(options.plannedQty)}</dd>
          </div>
          <div>
            <dt>{copy.gap}</dt>
            <dd className={options.gapQty >= 0 ? "production-progress-gap--up" : "production-progress-gap--down"}>
              {options.gapQty >= 0 ? "+" : "-"}{formatNumber(Math.abs(options.gapQty))}
            </dd>
          </div>
          <div>
            <dt>{copy.workOrders}</dt>
            <dd>{copy.completed} {options.completedCount} · {copy.inProgress} {options.inProgressCount} · {copy.pending} {options.pendingCount}</dd>
          </div>
          {options.currentPart ? (
            <div>
              <dt>{copy.currentPart}</dt>
              <dd>{options.currentPart}</dd>
            </div>
          ) : null}
          {options.showInjectionMetrics ? (
            <>
              <div>
                <dt>{copy.shotCount}</dt>
                <dd>{formatNumber(options.shotCount ?? 0)}</dd>
              </div>
              <div>
                <dt>{copy.recentRunning}</dt>
                <dd>{formatNumber(options.recentShots ?? 0)}</dd>
              </div>
              <div>
                <dt>{copy.cavity}</dt>
                <dd>{(options.avgCavity ?? 1).toFixed(1)}</dd>
              </div>
            </>
          ) : (
            <>
              <div>
                <dt>{copy.mesQty}</dt>
                <dd>{formatNumber(options.mesQty ?? 0)}</dd>
              </div>
              <div>
                <dt>{copy.manualOpen}</dt>
                <dd>{formatNumber(options.manualOpenQty ?? 0)}</dd>
              </div>
              <div>
                <dt>{copy.manualMatched}</dt>
                <dd>{formatNumber(options.matchedManualQty ?? 0)}</dd>
              </div>
              {(options.defectQty ?? 0) > 0 ? (
                <div>
                  <dt>{copy.defectQty}</dt>
                  <dd>{formatNumber(options.defectQty ?? 0)}</dd>
                </div>
              ) : null}
            </>
          )}
        </dl>
        <div className="production-progress-hover-card__jobs">
          <div className="production-progress-hover-card__jobs-head">
            <span>{copy.workOrders}</span>
            <span>{options.actualLabel}</span>
            <span>{copy.progress}</span>
            <span>{copy.completion}</span>
          </div>
          {displaySegments.map((segment) => (
            <div className="production-progress-hover-card__job" key={segment.key}>
              <span>
                <i>{segment.sequence}</i>
                {segment.partNo}
              </span>
              <span>{formatNumber(segment.estimatedQty)} / {formatNumber(segment.plannedQty)}</span>
              <span>{getProgressText(segment.progressRate)}</span>
              <span>{getProgressLabel(segment.status, copy)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderProgressRow(row: RealtimeProgressRow) {
    const progress = Math.max(0, Math.min(100, row.progressRate));
    const progressText = getProgressText(row.progressRate);
    const currentSegment = row.segments.find((segment) => segment.status === "in_progress");
    const displaySegments = getDisplaySegments(row.segments);
    const displayLabel = getLocalizedMachineLabel(row.label, language);

    return (
      <article className="production-progress-row" key={row.key}>
        <div className="production-progress-row__head">
          <div className="production-progress-row__identity">
            <div className="production-progress-row__title">
              <strong>{displayLabel}</strong>
              <button
                aria-label={`${displayLabel} ${copy.detail}`}
                className="production-progress-detail-button"
                onClick={() => setSelectedProgressRow(row)}
                type="button"
              >
                {copy.detail}
              </button>
            </div>
            <span>{currentSegment ? `${copy.currentPart} ${currentSegment.partNo}` : copy.partProgress}</span>
          </div>
          <div className="production-progress-row__state">
            <span>{progressText}</span>
            <em className={row.isRunning ? "production-progress-status production-progress-status--running" : "production-progress-status"}>
              {row.isRunning ? copy.running : "-"}
            </em>
          </div>
        </div>
        <div className="production-progress-track-wrap">
          <div className={`production-part-track${row.gapQty > 0 ? " production-part-track--overrun" : ""}`} aria-label={`${displayLabel} ${progressText}`}>
            {displaySegments.length ? displaySegments.map((segment) => renderProgressSegment(segment, row)) : (
              <span className="production-part-segment production-part-segment--pending" style={{ flexBasis: 0, flexGrow: 1 }}>
                <span className="production-part-segment__fill" style={{ width: `${progress}%` }} />
              </span>
            )}
            {row.gapQty > 0 ? (
              <span
                className="production-part-overrun"
                style={{ flexBasis: 0, flexGrow: Math.max(row.gapQty, 1) }}
              >
                <em>{getOverrunLabel(row.gapQty, row.plannedQty)}</em>
              </span>
            ) : null}
          </div>
          {renderProgressHoverCard({
            label: displayLabel,
            progressText,
            actualLabel: copy.estimatedVsPlan,
            actualQty: row.estimatedQty,
            plannedQty: row.plannedQty,
            gapQty: row.gapQty,
            completedCount: row.completedCount,
            inProgressCount: row.inProgressCount,
            pendingCount: row.pendingCount,
            currentPart: currentSegment?.partNo,
            shotCount: row.shotCount,
            recentShots: row.recentShots,
            avgCavity: row.avgCavity,
            showInjectionMetrics: true,
            segments: row.segments,
          })}
        </div>
        <div className="production-progress-state-strip">
          <span className="production-progress-chip production-progress-chip--completed">{copy.completed} {row.completedCount}</span>
          <span className="production-progress-chip production-progress-chip--active">{copy.inProgress} {row.inProgressCount}</span>
          <span className="production-progress-chip">{copy.pending} {row.pendingCount}</span>
          {renderOverrunChip(row.gapQty, row.plannedQty)}
        </div>
      </article>
    );
  }

  function renderMachiningPreviewRow(row: MachiningProgressPreview["rows"][number]) {
    const progress = Math.max(0, Math.min(100, row.progressRate));
    const progressText = getProgressText(row.progressRate);
    const currentSegment = row.segments.find((segment) => segment.status === "in_progress");
    const displaySegments = getDisplaySegments(row.segments);
    const isActive = row.inProgressCount > 0;
    const displayLabel = getLocalizedMachineLabel(row.label, language);
    return (
      <article className="production-progress-row production-progress-row--preview" key={row.key}>
        <div className="production-progress-row__head">
          <div className="production-progress-row__identity">
            <div className="production-progress-row__title">
              <strong>{displayLabel}</strong>
              {row.provisionRow?.plan_id ? (
                <button
                  aria-label={`${displayLabel} ${copy.manualReport}`}
                  className="production-progress-detail-button"
                  onClick={() => openMachiningManualReport(row.provisionRow as MachiningProvisionRow)}
                  type="button"
                >
                  {copy.manualReport}
                </button>
              ) : null}
            </div>
            <span>{currentSegment ? `${copy.currentPart} ${currentSegment.partNo}` : `${copy.effectiveQty} ${formatNumber(row.actualQty)} / ${formatNumber(row.plannedQty)}`}</span>
          </div>
          <div className="production-progress-row__state">
            <span>{progressText}</span>
            <em className={isActive ? "production-progress-status production-progress-status--running" : "production-progress-status"}>
              {isActive ? copy.running : "-"}
            </em>
          </div>
        </div>
        <div className="production-progress-track-wrap">
          <div className={`production-part-track${row.gapQty > 0 ? " production-part-track--overrun" : " production-part-track--preview"}`}>
            {displaySegments.map((segment) => renderProgressSegment(segment, { plannedQty: row.plannedQty }))}
            {row.gapQty > 0 ? (
              <span
                className="production-part-overrun"
                style={{ flexBasis: 0, flexGrow: Math.max(row.gapQty, 1) }}
              >
                <em>{getOverrunLabel(row.gapQty, row.plannedQty)}</em>
              </span>
            ) : null}
          </div>
          {renderProgressHoverCard({
            label: displayLabel,
            progressText,
            actualLabel: copy.effectiveQty,
            actualQty: row.actualQty,
            plannedQty: row.plannedQty,
            gapQty: row.gapQty,
            completedCount: row.completedCount,
            inProgressCount: row.inProgressCount,
            pendingCount: row.pendingCount,
            currentPart: currentSegment?.partNo,
            mesQty: row.mesQty,
            manualOpenQty: row.manualOpenQty,
            matchedManualQty: row.matchedManualQty,
            defectQty: row.defectQty,
            segments: row.segments,
          })}
        </div>
        <div className="production-progress-state-strip">
          <span className="production-progress-chip">{copy.mesQty} {formatNumber(row.mesQty)}</span>
          <span className="production-progress-chip production-progress-chip--active">{copy.manualOpen} {formatNumber(row.manualOpenQty)}</span>
          <span className="production-progress-chip production-progress-chip--completed">{copy.manualMatched} {formatNumber(row.matchedManualQty)}</span>
          {row.defectQty > 0 ? <span className="production-progress-chip production-progress-chip--overrun">{copy.defectQty} {formatNumber(row.defectQty)}</span> : null}
          <span className="production-progress-chip production-progress-chip--completed">{copy.completed} {row.completedCount}</span>
          <span className="production-progress-chip production-progress-chip--active">{copy.inProgress} {row.inProgressCount}</span>
          <span className="production-progress-chip">{copy.pending} {row.pendingCount}</span>
          {renderOverrunChip(row.gapQty, row.plannedQty)}
        </div>
      </article>
    );
  }

  function toggleKpiDetail(nextDetail: KpiDetailKey) {
    setActiveKpiDetail((current) => (current === nextDetail ? null : nextDetail));
  }

  function getTrendChartMax(trend: CumulativeTrendSummary) {
    const currentRangeMax = Math.max(
      ...trend.points.map((point) => Math.max(point.actualQty, point.targetQty)),
      trend.plannedQty,
      1,
    );
    return currentRangeMax * 1.08;
  }

  function getTrendPointPosition(trend: CumulativeTrendSummary, point: CumulativeTrendPoint, valueKey: "actualQty" | "targetQty") {
    const chartMax = getTrendChartMax(trend);
    const top = 5;
    const bottom = 52;
    const height = bottom - top;
    const y = bottom - (Math.max(0, point[valueKey]) / chartMax) * height;
    return {
      x: point.elapsedRate,
      y: Math.max(top, Math.min(bottom, y)),
    };
  }

  function getTrendPolylinePoints(trend: CumulativeTrendSummary, valueKey: "actualQty" | "targetQty") {
    return trend.points
      .map((point) => {
        const position = getTrendPointPosition(trend, point, valueKey);
        return `${position.x.toFixed(2)},${position.y.toFixed(2)}`;
      })
      .join(" ");
  }

  function getTrendTargetPolylinePoints(trend: CumulativeTrendSummary) {
    const targetPoints: CumulativeTrendPoint[] = [
      {
        key: "target-start",
        label: "08:00",
        elapsedRate: 0,
        actualQty: 0,
        targetQty: 0,
      },
      {
        key: "target-end",
        label: "08:00",
        elapsedRate: 100,
        actualQty: 0,
        targetQty: trend.plannedQty,
      },
    ];
    return targetPoints
      .map((point) => {
        const position = getTrendPointPosition(trend, point, "targetQty");
        return `${position.x.toFixed(2)},${position.y.toFixed(2)}`;
      })
      .join(" ");
  }

  function getUtilizationY(utilizationRate: number, summary: MachineActivitySummary) {
    const top = UTILIZATION_CHART_TOP_Y;
    const bottom = UTILIZATION_CHART_BOTTOM_Y;
    const scaleMin = summary.utilizationScaleMin;
    const scaleMax = summary.utilizationScaleMax;
    const scaleRange = Math.max(1, scaleMax - scaleMin);
    const clippedRate = Math.max(scaleMin, Math.min(scaleMax, utilizationRate));
    const y = bottom - ((clippedRate - scaleMin) / scaleRange) * (bottom - top);
    return Math.max(top, Math.min(bottom, y));
  }

  function getUtilizationPointPosition(point: MachineUtilizationPoint, summary: MachineActivitySummary) {
    return {
      x: point.elapsedRate,
      y: getUtilizationY(point.utilizationRate, summary),
    };
  }

  function getUtilizationPolylinePoints(points: MachineUtilizationPoint[], summary: MachineActivitySummary) {
    return points
      .map((point) => {
        const position = getUtilizationPointPosition(point, summary);
        return `${position.x.toFixed(2)},${position.y.toFixed(2)}`;
      })
      .join(" ");
  }

  function renderCumulativeKpiDetail(options: {
    detailKey: "injection" | "machining";
    title: string;
    trend: CumulativeTrendSummary;
    rowLabel: string;
    rows: Array<{
      key: string;
      label: string;
      actualQty: number;
      plannedQty: number;
      progressRate: number;
      gapQty: number;
      completedCount: number;
      inProgressCount: number;
      pendingCount: number;
    }>;
  }) {
    const currentPoint = options.trend.latestPoint;
    const markerPosition = getTrendPointPosition(options.trend, currentPoint, "actualQty");
    const markerTop = (markerPosition.y / 56) * 100;
    const markerProgressRate = options.trend.plannedQty > 0
      ? (currentPoint.actualQty / options.trend.plannedQty) * 100
      : 0;
    const targetGap = currentPoint.actualQty - currentPoint.targetQty;
    const paceRateGap = markerProgressRate - options.trend.elapsedRate;
    const sortedRows = [...options.rows].sort((left, right) => {
      if (options.detailKey === "injection") {
        const leftMachineNumber = Number(getMachineNumberFromName(left.label) ?? Number.POSITIVE_INFINITY);
        const rightMachineNumber = Number(getMachineNumberFromName(right.label) ?? Number.POSITIVE_INFINITY);
        if (leftMachineNumber !== rightMachineNumber) return leftMachineNumber - rightMachineNumber;
        return left.label.localeCompare(right.label, "ko-KR", { numeric: true, sensitivity: "base" });
      }

      return right.actualQty - left.actualQty;
    });

    return (
      <section className={`panel production-kpi-detail production-kpi-detail--${options.detailKey}`}>
        <div className="production-kpi-detail__header">
          <div>
            <p className="panel-card__eyebrow">{detailCopy.cumulativeTrend}</p>
            <h3 className="panel__title">{options.title}</h3>
          </div>
          <div className="production-kpi-detail__legend">
            <span><i className="production-kpi-detail__legend-line production-kpi-detail__legend-line--actual" />{detailCopy.actualLine}</span>
            <span><i className="production-kpi-detail__legend-line production-kpi-detail__legend-line--target" />{detailCopy.targetLine}</span>
          </div>
        </div>

        <div className="production-kpi-detail__body">
          <div className="production-kpi-chart production-kpi-chart--compact" aria-label={`${options.title} ${detailCopy.cumulativeTrend}`}>
            <div className="production-kpi-chart__summary">
              <div>
                <span>{detailCopy.compactSummary}</span>
                <strong>{formatNumber(currentPoint.actualQty)} / {formatNumber(options.trend.plannedQty)}</strong>
              </div>
              <div className="production-kpi-chart__summary-stats">
                <span>{detailCopy.completionRate} {Math.round(markerProgressRate)}%</span>
                <span>{detailCopy.elapsedRate} {Math.round(options.trend.elapsedRate)}%</span>
                <span className={targetGap >= 0 ? "production-progress-gap--up" : "production-progress-gap--down"}>
                  {detailCopy.paceRateGap} {paceRateGap >= 0 ? "+" : "-"}{Math.abs(Math.round(paceRateGap))}%p
                </span>
                <span className={targetGap >= 0 ? "production-progress-gap--up" : "production-progress-gap--down"}>
                  {detailCopy.quantityGap} {targetGap >= 0 ? "+" : "-"}{formatNumber(Math.abs(targetGap))}
                </span>
                <span className="production-kpi-chart__live-status">
                  <i />
                  {detailCopy.inProgressNow} {currentPoint.label} · {Math.round(markerProgressRate)}%
                </span>
              </div>
            </div>

            <div className="production-kpi-chart__plot">
              <svg viewBox="0 0 100 56" preserveAspectRatio="none" role="img">
                <line className="production-kpi-chart__grid" x1="0" x2="100" y1="52" y2="52" />
                <line className="production-kpi-chart__grid" x1="0" x2="100" y1="28" y2="28" />
                <polyline className="production-kpi-chart__line production-kpi-chart__line--target" points={getTrendTargetPolylinePoints(options.trend)} />
                <polyline className="production-kpi-chart__line production-kpi-chart__line--actual" points={getTrendPolylinePoints(options.trend, "actualQty")} />
                <line className="production-kpi-chart__cursor" x1={markerPosition.x} x2={markerPosition.x} y1="5" y2="52" />
              </svg>
              <span
                aria-hidden="true"
                className="production-kpi-chart__marker"
                style={{ left: `${markerPosition.x}%`, top: `${markerTop}%` }}
              />
            </div>

            <div className="production-kpi-chart__axis production-kpi-chart__axis--timeline">
              {options.trend.axisLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}
            </div>
            <p className="production-kpi-chart__updated">{detailCopy.updatedAt} {currentPoint.label}</p>
          </div>
        </div>

        <div className="production-kpi-rank">
          <div className="production-kpi-rank__header">
            <strong>{options.rowLabel}</strong>
            <span>{detailCopy.paceRateGap} · {detailCopy.output} / {detailCopy.targetTotal}</span>
          </div>
          {sortedRows.length ? (
            <div className="production-kpi-rank__grid">
              {sortedRows.map((row) => {
                const rowExpectedQty = Math.round(row.plannedQty * (options.trend.elapsedRate / 100));
                const rowPaceQtyGap = row.actualQty - rowExpectedQty;
                const rowPaceRateGap = row.plannedQty > 0
                  ? row.progressRate - options.trend.elapsedRate
                  : (row.actualQty > 0 ? 100 : 0);
                const rowGapClass = rowPaceQtyGap >= 0 ? "production-kpi-rank__delta production-kpi-rank__delta--up" : "production-kpi-rank__delta production-kpi-rank__delta--down";
                const displayLabel = getLocalizedMachineLabel(row.label, language);
                return (
                  <article className="production-kpi-rank__card" key={row.key}>
                    <div className="production-kpi-rank__card-head">
                      <strong>{displayLabel}</strong>
                      <span>{Math.round(row.progressRate)}%</span>
                    </div>
                    <div className="production-kpi-rank__card-meta">
                      <em className={rowGapClass}>{detailCopy.timeShort} {rowPaceRateGap >= 0 ? "+" : "-"}{Math.abs(Math.round(rowPaceRateGap))}%p</em>
                      <span>{detailCopy.quantityShort} {rowPaceQtyGap >= 0 ? "+" : "-"}{formatNumber(Math.abs(rowPaceQtyGap))}</span>
                    </div>
                    <div className="production-kpi-rank__progress">
                      <span>{formatNumber(row.actualQty)} / {formatNumber(row.plannedQty)}</span>
                      <div><i style={{ width: `${Math.max(0, Math.min(100, row.progressRate))}%` }} /></div>
                    </div>
                    <p>{copy.completed} {row.completedCount} · {copy.inProgress} {row.inProgressCount} · {copy.pending} {row.pendingCount}</p>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="notice notice--neutral">{detailCopy.noData}</div>
          )}
        </div>
      </section>
    );
  }

  function renderMachineActivityDetail() {
    const axisLabels = getTrendAxisLabels(businessDate);
    const utilizationGridTicks = [0, 4, 8, 12, 16, 20, 24].map((hour) => (hour / 24) * 100);
    const averageY = getUtilizationY(machineActivitySummary.averageUtilizationRate, machineActivitySummary);
    const averageLabelTop = (averageY / 56) * 100;
    const peakPosition = machineActivitySummary.peakPoint
      ? getUtilizationPointPosition(machineActivitySummary.peakPoint, machineActivitySummary)
      : null;
    const peakMarkerTop = peakPosition ? (peakPosition.y / 56) * 100 : 0;
    const peakLabelTop = peakPosition ? Math.max(15, Math.min(82, peakMarkerTop)) : 0;
    const peakLabelClass = peakPosition && peakPosition.x > 82
      ? "production-machine-activity__annotation-badge--peak-end"
      : "production-machine-activity__annotation-badge--peak-start";

    return (
      <section className={`panel production-kpi-detail production-machine-activity${activitySelection ? " production-machine-activity--has-selection" : ""}`}>
        {activitySelection ? (
          <button
            type="button"
            className="production-machine-activity__screen-dim"
            aria-label={activityCopy.clear}
            onClick={() => setActivitySelection(null)}
          />
        ) : null}
        <div className="production-kpi-detail__header">
          <div>
            <p className="panel-card__eyebrow">{detailCopy.equipmentTimeline}</p>
            <h3 className="panel__title">{detailCopy.machinesTitle}</h3>
            <p className="production-machine-activity__hint">{detailCopy.activeFirst}</p>
          </div>
          <div className="production-kpi-detail__legend">
            <span><i className="production-machine-activity__legend production-machine-activity__legend--active" />{detailCopy.running}</span>
            <span><i className="production-machine-activity__legend production-machine-activity__legend--idle" />{detailCopy.idle}</span>
          </div>
        </div>

        <div className="production-machine-activity__summary">
          <div
            className={[
              "production-machine-activity__summary-chart",
              activitySelection?.origin === "utilization" ? "production-machine-activity__summary-chart--selection-focused" : "",
            ].filter(Boolean).join(" ")}
          >
            <div className="production-kpi-chart production-machine-activity__utilization-chart" aria-label={`${detailCopy.utilizationSummary} ${detailCopy.utilizationTrend}`}>
              <div className="production-machine-activity__timeline-aligner">
                <div className="production-machine-activity__timeline-gutter">
                  <div className="production-machine-activity__side-summary">
                    <strong>{detailCopy.utilizationTrend}</strong>
                    <dl className="production-machine-activity__summary-metrics">
                      <div>
                        <dt>{detailCopy.currentUtilization}</dt>
                        <dd>{Math.round(machineActivitySummary.currentUtilizationRate)}%</dd>
                      </div>
                      <div>
                        <dt>{detailCopy.averageUtilization}</dt>
                        <dd>{Math.round(machineActivitySummary.averageUtilizationRate)}%</dd>
                      </div>
                      <div>
                        <dt>{detailCopy.peakUtilization}</dt>
                        <dd>{Math.round(machineActivitySummary.peakUtilizationRate)}%</dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <div className="production-machine-activity__timeline-area">
                  <div
                    className="production-machine-activity__utilization-plot"
                    onPointerDown={(event) => beginActivitySelection("utilization", event)}
                    onPointerMove={(event) => moveActivitySelection("utilization", event)}
                    onPointerUp={(event) => endActivitySelection("utilization", event)}
                    onPointerCancel={(event) => endActivitySelection("utilization", event)}
                  >
                    <svg viewBox="0 0 100 56" preserveAspectRatio="none" role="img">
                      {utilizationGridTicks.map((tick) => (
                        <line
                          className="production-machine-activity__vertical-grid"
                          key={`utilization-grid-${tick}`}
                          x1={tick}
                          x2={tick}
                          y1={UTILIZATION_CHART_TOP_Y}
                          y2={UTILIZATION_CHART_BOTTOM_Y}
                        />
                      ))}
                      {machineActivitySummary.utilizationAxisTicks.map((tick, index) => (
                        <line
                          className="production-machine-activity__horizontal-grid"
                          key={`utilization-y-grid-${tick}-${index}`}
                          x1="0"
                          x2="100"
                          y1={getUtilizationY(tick, machineActivitySummary)}
                          y2={getUtilizationY(tick, machineActivitySummary)}
                        />
                      ))}
                      <line className="production-machine-activity__average-line" x1="0" x2="100" y1={averageY} y2={averageY} />
                      {machineActivitySummary.movingAverageSeries.map((series) => (
                        <polyline
                          className={`production-machine-activity__ma-line production-machine-activity__ma-line--${series.key}`}
                          key={series.key}
                          points={getUtilizationPolylinePoints(series.points, machineActivitySummary)}
                        />
                      ))}
                      <polyline className="production-kpi-chart__line production-machine-activity__utilization-line" points={getUtilizationPolylinePoints(machineActivitySummary.points, machineActivitySummary)} />
                    </svg>
                    <div className="production-machine-activity__y-axis" aria-hidden="true">
                      {machineActivitySummary.utilizationAxisTicks.map((tick, index) => (
                        <span key={`utilization-y-label-${tick}-${index}`} style={{ top: `${(getUtilizationY(tick, machineActivitySummary) / 56) * 100}%` }}>
                          {tick}%
                        </span>
                      ))}
                    </div>
                    <div className="production-machine-activity__ma-legend production-machine-activity__ma-legend--overlay" aria-label={detailCopy.movingAverage}>
                      <span className="production-machine-activity__ma-legend--avg">{detailCopy.averageLine}</span>
                      {machineActivitySummary.movingAverageSeries.map((series) => (
                        <span className={`production-machine-activity__ma-legend--${series.key}`} key={series.key}>{series.label}</span>
                      ))}
                    </div>
                    {!activitySelection ? (
                      <span className="production-machine-activity__drag-hint">{activityCopy.dragHint}</span>
                    ) : null}
                    <span className="production-machine-activity__annotation-badge production-machine-activity__annotation-badge--average" style={{ top: `${averageLabelTop}%` }}>
                      {detailCopy.averageLine} {Math.round(machineActivitySummary.averageUtilizationRate)}%
                    </span>
                    {peakPosition ? (
                      <span className="production-machine-activity__peak-marker" style={{ left: `${peakPosition.x}%`, top: `${peakMarkerTop}%` }} aria-hidden="true" />
                    ) : null}
                    {peakPosition ? (
                      <span
                        className={`production-machine-activity__annotation-badge ${peakLabelClass}`}
                        style={{ left: `${peakPosition.x}%`, top: `${peakLabelTop}%` }}
                      >
                        {detailCopy.peakPoint} {Math.round(machineActivitySummary.peakUtilizationRate)}%
                      </span>
                    ) : null}
                    {renderActivitySelectionOverlays("utilization")}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="production-machine-activity__axis">
          <span />
          <div>
            {axisLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}
          </div>
        </div>

        <div className="production-machine-activity__list">
          {machineActivityRows.map((row) => {
            const displayLabel = getLocalizedMachineLabel(row.label, language);
            const isSelectedBySelection = activitySelection?.origin === "timeline" && activitySelection.machineNumber === row.machineNumber;
            const isMutedBySelection = activitySelection?.origin === "timeline" && activitySelection.machineNumber !== row.machineNumber;
            return (
              <article
                className={[
                  "production-machine-activity__row",
                  row.isActive ? "production-machine-activity__row--active" : "",
                  isSelectedBySelection ? "production-machine-activity__row--selection-focused" : "",
                  isMutedBySelection ? "production-machine-activity__row--selection-muted" : "",
                ].filter(Boolean).join(" ")}
                key={row.machineNumber}
              >
                <div className="production-machine-activity__label">
                  <strong>{displayLabel}</strong>
                  <span>{detailCopy.clampCount} {formatNumber(row.output)} · {detailCopy.activeTime} {formatHoursFromMinutes(row.activeMinutes)}</span>
                </div>
                <div
                  className="production-machine-activity__track"
                  onPointerDown={(event) => beginActivitySelection("timeline", event, row.machineNumber)}
                  onPointerMove={(event) => moveActivitySelection("timeline", event, row.machineNumber)}
                  onPointerUp={(event) => endActivitySelection("timeline", event, row.machineNumber)}
                  onPointerCancel={(event) => endActivitySelection("timeline", event, row.machineNumber)}
                >
                  {row.segments.length ? row.segments.map((segment) => (
                    <i
                      className={segment.active ? "production-machine-activity__segment production-machine-activity__segment--active" : "production-machine-activity__segment"}
                      key={segment.key}
                      style={{
                        left: `${segment.startPct}%`,
                        width: `${segment.widthPct}%`,
                        "--activity-alpha": segment.density ? String(segment.density) : undefined,
                        "--activity-hue": segment.partHue ? String(segment.partHue) : undefined,
                        "--activity-lightness": segment.partLightness ? `${segment.partLightness}%` : undefined,
                        "--activity-saturation": segment.partSaturation ? `${segment.partSaturation}%` : undefined,
                      } as CSSProperties}
                      title={`${segment.active ? `${segment.partNo ?? activityCopy.partUnknown} · ` : ""}${segment.active ? detailCopy.running : detailCopy.idle} · ${detailCopy.clampCount} ${formatNumber(segment.output)}`}
                    />
                  )) : (
                    <i className="production-machine-activity__segment production-machine-activity__segment--empty" style={{ left: "0%", width: "100%" }} />
                  )}
                  {renderActivitySelectionOverlays("timeline", row.machineNumber)}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <section className="page production-dashboard" aria-busy={isLiveDataRefreshing}>
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        description={copy.description}
      />

      {isInitialLoading ? <ProductionDashboardSkeleton copy={copy} /> : null}

      {!isInitialLoading ? (
        <>
          <div className="stats-grid">
            <label className="stat-card production-date-card">
              <span className="stat-card__title">{copy.productionDate}</span>
              <input
                type="date"
                value={businessDate}
                max={currentDate}
                onChange={(event) => setBusinessDate(event.target.value || currentDate)}
              />
              <span className="stat-card__hint">{copy.productionDateHint}</span>
            </label>
            <StatCard
              hint={`${copy.completedRate} ${Math.round(injectionCompletionRate)}% · ${copy.timeRate} ${Math.round(productionElapsedRate)}%`}
              hintTone={injectionRateTone}
              isActive={activeKpiDetail === "injection"}
              onClick={() => toggleKpiDetail("injection")}
              title={copy.injectionActualPlan}
              value={`${formatNumber(briefContext.actualInjectionOutput)} / ${formatNumber(briefContext.injectionPlanQty)}`}
            />
            <StatCard
              hint={`${copy.completedRate} ${Math.round(machiningCompletionRate)}%`}
              isActive={activeKpiDetail === "machining"}
              onClick={() => toggleKpiDetail("machining")}
              title={copy.machiningActualPlan}
              value={`${formatNumber(briefContext.actualMachiningOutput)} / ${formatNumber(briefContext.machiningPlanQty)}`}
            />
            <StatCard
              hint={`${copy.injectionFacilities} ${briefContext.activeMachineCount} · ${copy.machiningFacilities} ${activeMachiningLineCount}`}
              isActive={activeKpiDetail === "machines"}
              onClick={() => toggleKpiDetail("machines")}
              title={copy.activeMachines}
              value={`${briefContext.activeMachineCount}/${briefContext.totalMachines}`}
            />
          </div>

          {activeKpiDetail === "injection" ? renderCumulativeKpiDetail({
            detailKey: "injection",
            title: detailCopy.injectionTitle,
            trend: injectionTrend,
            rowLabel: detailCopy.byMachine,
            rows: realtimeProgress.rows.map((row) => ({
              key: row.key,
              label: row.label,
              actualQty: row.estimatedQty,
              plannedQty: row.plannedQty,
              progressRate: row.progressRate,
              gapQty: row.gapQty,
              completedCount: row.completedCount,
              inProgressCount: row.inProgressCount,
              pendingCount: row.pendingCount,
            })),
          }) : null}

          {activeKpiDetail === "machining" ? renderCumulativeKpiDetail({
            detailKey: "machining",
            title: detailCopy.machiningTitle,
            trend: machiningTrend,
            rowLabel: detailCopy.byLine,
            rows: machiningProgress.rows.map((row) => ({
              key: row.key,
              label: row.label,
              actualQty: row.actualQty,
              plannedQty: row.plannedQty,
              progressRate: row.progressRate,
              gapQty: row.gapQty,
              completedCount: row.completedCount,
              inProgressCount: row.inProgressCount,
              pendingCount: row.pendingCount,
            })),
          }) : null}

          {activeKpiDetail === "machines" ? renderMachineActivityDetail() : null}

          <section className="panel production-brief-panel">
            <div className="production-brief-panel__header">
              <div>
                <p className="panel-card__eyebrow">{copy.localBrief}</p>
                <h3 className="panel__title">{copy.briefTitle}</h3>
              </div>
              <div className="production-brief-panel__actions">
                <button
                  className="button button--primary"
                  disabled={createAiJobMutation.isPending || Boolean(activeAiJob && !isAiJobTerminal(activeAiJob.status))}
                  type="button"
                  onClick={() => createAiJobMutation.mutate()}
                >
                  {createAiJobMutation.isPending ? copy.workerAnalysisRunning : copy.runWorkerAnalysis}
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => setIsAiAskOpen((isOpen) => !isOpen)}
                >
                  {isAiAskOpen ? copy.closeAi : copy.askAi}
                </button>
              </div>
            </div>

            <div className="production-brief-panel__body">
              {briefingText.split("\n\n").map((paragraph, index) => (
                <p key={`${paragraph.slice(0, 24)}-${index}`}>{paragraph}</p>
              ))}
            </div>

            <div className="production-brief-evidence">
              <span>{copy.deterministicBrief}</span>
              <details>
                <summary>{copy.usedData}</summary>
                <ul>
                  {(aiBriefingQuery.data?.used_data ?? []).map((item) => (
                    <li key={item.name}>
                      {item.name}: {formatNumber(item.row_count)}
                    </li>
                  ))}
                  {!aiBriefingQuery.data?.used_data?.length ? (
                    <li>{language === "ko" ? "백엔드 브리핑 연결 실패 시 화면 데이터로 계산한 초안을 표시합니다." : "后端简报连接失败时显示基于页面数据计算的草稿。"}</li>
                  ) : null}
                </ul>
              </details>
              <details>
                <summary>{copy.calculationBasis}</summary>
                <ul>
                  {(aiBriefingQuery.data?.calculation_basis ?? []).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                  {!aiBriefingQuery.data?.calculation_basis?.length ? (
                    <li>{language === "ko" ? "기준일 08:00 ~ 익일 08:00 기준으로 계산합니다." : "按基准日 08:00 ~ 次日 08:00 计算。"}</li>
                  ) : null}
                </ul>
              </details>
            </div>

            {isAiAskOpen ? (
              <form className="production-ai-ask" onSubmit={submitAiQuestion}>
                <textarea
                  onChange={(event) => setAiQuestion(event.target.value)}
                  placeholder={copy.aiQuestionPlaceholder}
                  rows={3}
                  value={aiQuestion}
                />
                <div className="production-ai-ask__actions">
                  <span>{language === "ko" ? "내부 생산 데이터 계산 + 로컬 MLX LLM" : "内部生产数据计算 + 本地 MLX LLM"}</span>
                  <button className="button button--primary" disabled={!aiQuestion.trim() || aiQuestionMutation.isPending} type="submit">
                    {aiQuestionMutation.isPending ? copy.askingAi : copy.aiSubmit}
                  </button>
                </div>
              </form>
            ) : null}

            {aiAnswer ? (
              <div className="production-ai-answer">
                <strong>{copy.aiAnswerTitle}</strong>
                {aiAnswer.split("\n\n").map((paragraph, index) => (
                  <p key={`${paragraph.slice(0, 24)}-${index}`}>{paragraph}</p>
                ))}
              </div>
            ) : null}

            {activeAiJob ? (
              <div className={`production-ai-job production-ai-job--${activeAiJob.status}`}>
                <div className="production-ai-job__header">
                  <div>
                    <strong>{copy.workerJobTitle}</strong>
                    <span>
                      {copy.workerJobStatus}: {getAiJobStatusLabel(activeAiJob.status, language)}
                      {activeAiJob.claimed_by ? ` · ${activeAiJob.claimed_by}` : ""}
                    </span>
                  </div>
                  {!isAiJobTerminal(activeAiJob.status) ? (
                    <button
                      className="button button--ghost button--mini"
                      disabled={cancelAiJobMutation.isPending}
                      onClick={() => cancelAiJobMutation.mutate(activeAiJob.id)}
                      type="button"
                    >
                      {copy.workerJobCancel}
                    </button>
                  ) : null}
                </div>

                {!isAiJobTerminal(activeAiJob.status) ? (
                  <p className="production-ai-job__message">{copy.workerJobWaiting}</p>
                ) : null}

                {activeAiJob.status === "completed" ? (
                  <div className="production-ai-job__result">
                    <strong>{copy.workerJobResult}</strong>
                    {activeAiJobResult.llm_fallback ? (
                      <div className="notice notice--warning">{copy.workerJobFallback}</div>
                    ) : null}
                    <p>{activeAiJobSummary || getStringField(activeAiJobResult, "title") || copy.workerJobNoIssue}</p>
                    <div className="production-ai-job__issues">
                      {activeAiJobTopIssues.length ? activeAiJobTopIssues.map((issue, index) => (
                        <div className="production-ai-job__issue" key={`${getStringField(issue, "label")}-${index}`}>
                          <span>{copy.workerJobIssue}</span>
                          <strong>{getStringField(issue, "label") || getStringField(issue, "type") || "-"}</strong>
                          <p>{getIssueText(issue)}</p>
                        </div>
                      )) : (
                        <div className="production-ai-job__issue">
                          <span>{copy.workerJobIssue}</span>
                          <strong>{copy.workerJobNoIssue}</strong>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}

                {activeAiJob.status === "failed" ? (
                  <div className="notice notice--warning">{activeAiJob.error_message || copy.llmError}</div>
                ) : null}
              </div>
            ) : null}

            {aiQuestionMutation.isError ? (
              <div className="notice notice--warning">
                {copy.llmError}
              </div>
            ) : null}
          </section>

          <section className="panel production-progress-panel">
            <div className="production-progress-panel__header">
              <div>
                <p className="panel-card__eyebrow">{copy.progressEyebrow}</p>
                <div className="production-progress-title-line">
                  <h3 className="panel__title">{copy.progressTitle}</h3>
                  <span
                    className="production-progress-help"
                    data-tooltip={copy.progressDescription}
                    role="img"
                    aria-label={copy.progressDescription}
                  >
                    ?
                  </span>
                </div>
              </div>
            </div>

            <div className="production-progress-grid">
              <article className="production-progress-card">
                <div className="production-progress-visual-summary">
                  <div className={`production-progress-ring${realtimeProgress.estimatedQty > realtimeProgress.plannedQty ? " production-progress-ring--overrun" : ""}`} style={getRingStyle(realtimeProgress.progressRate)}>
                    <strong>{getProgressText(realtimeProgress.progressRate)}</strong>
                    <span>{copy.totalProgress}</span>
                  </div>
                  <div className="production-progress-summary-text">
                    <h4>{copy.injectionProgress}</h4>
                    <p>{copy.progressHint}</p>
                    <div className="production-progress-state-strip">
                      <span className="production-progress-chip production-progress-chip--completed">{copy.completed} {realtimeProgress.completedCount}</span>
                      <span className="production-progress-chip production-progress-chip--active">{copy.inProgress} {realtimeProgress.inProgressCount}</span>
                      <span className="production-progress-chip">{copy.pending} {realtimeProgress.pendingCount}</span>
                      {renderOverrunChip(realtimeProgress.estimatedQty - realtimeProgress.plannedQty, realtimeProgress.plannedQty)}
                    </div>
                  </div>
                </div>
                <div className="production-progress-list">
                  {realtimeProgress.rows.length ? (
                    realtimeProgress.rows.map(renderProgressRow)
                  ) : (
                    <div className="notice notice--neutral">{copy.noProgressRows}</div>
                  )}
                </div>
              </article>

              <article className="production-progress-card production-progress-card--pending">
                <div className="production-progress-visual-summary">
                  <div className={`production-progress-ring${machiningProgress.actualQty > machiningProgress.plannedQty ? " production-progress-ring--overrun" : ""}`} style={getRingStyle(machiningProgress.progressRate)}>
                    <strong>{getProgressText(machiningProgress.progressRate)}</strong>
                    <span>{copy.totalProgress}</span>
                  </div>
                  <div className="production-progress-summary-text">
                    <h4>{copy.machiningProgress}</h4>
                    <p>{copy.machiningSupplementHint}</p>
                    <div className="production-progress-state-strip">
                      <span className="production-progress-chip">{copy.mesQty} {formatNumber(machiningSummaryMesQty)}</span>
                      <span className="production-progress-chip production-progress-chip--active">{copy.manualOpen} {formatNumber(machiningSummaryManualOpenQty)}</span>
                      <span className="production-progress-chip production-progress-chip--completed">{copy.effectiveQty} {formatNumber(machiningSummaryEffectiveQty)}</span>
                      {machiningSummaryAdvanceQty > 0 ? (
                        <span className="production-progress-chip production-progress-chip--overrun">{copy.advanceQty} {formatNumber(machiningSummaryAdvanceQty)}</span>
                      ) : null}
                      <span className="production-progress-chip production-progress-chip--completed">{copy.completed} {machiningProgress.completedCount}</span>
                      <span className="production-progress-chip production-progress-chip--active">{copy.inProgress} {machiningProgress.inProgressCount}</span>
                      <span className="production-progress-chip">{copy.pending} {machiningProgress.pendingCount}</span>
                      {renderOverrunChip(machiningProgress.actualQty - machiningProgress.plannedQty, machiningProgress.plannedQty)}
                    </div>
                  </div>
                </div>
                <div className="production-progress-list">
                  {machiningProgress.rows.length ? (
                    machiningProgress.rows.map(renderMachiningPreviewRow)
                  ) : (
                    <div className="notice notice--neutral">{copy.noProgressRows}</div>
                  )}
                </div>
              </article>
            </div>
          </section>

          <InjectionTransitionPanel
            analysis={transitionAnalysis}
            copy={copy}
            language={language}
          />

          {selectedProgressRow ? (
            <div className="modal-backdrop" role="presentation" onClick={() => setSelectedProgressRow(null)}>
              <section
                className="modal-card production-progress-modal"
                aria-modal="true"
                role="dialog"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="modal-card__header">
                  <div>
                    <p className="panel-card__eyebrow">{copy.machineDetailTitle}</p>
                    <h3 className="panel__title">{getLocalizedMachineLabel(selectedProgressRow.label, language)}</h3>
                    <p className="production-progress-modal__meta">
                      {copy.totalProgress} {getProgressText(selectedProgressRow.progressRate)} · {copy.estimatedVsPlan} {formatNumber(selectedProgressRow.estimatedQty)} / {formatNumber(selectedProgressRow.plannedQty)}
                    </p>
                  </div>
                  <button className="button button--ghost" onClick={() => setSelectedProgressRow(null)} type="button">
                    {copy.close}
                  </button>
                </div>

                <div className="production-progress-modal__summary">
                  <div>
                    <span>{copy.shotCount}</span>
                    <strong>{formatNumber(selectedProgressRow.shotCount)}</strong>
                  </div>
                  <div>
                    <span>{copy.cavity}</span>
                    <strong>{selectedProgressRow.avgCavity.toFixed(1)}</strong>
                  </div>
                  <div>
                    <span>{copy.gap}</span>
                    <strong className={selectedProgressRow.gapQty >= 0 ? "production-progress-gap--up" : "production-progress-gap--down"}>
                      {selectedProgressRow.gapQty >= 0 ? "+" : "-"}{formatNumber(Math.abs(selectedProgressRow.gapQty))}
                    </strong>
                  </div>
                </div>

                <div className="production-progress-modal__table">
                  <div className="production-progress-modal__table-head">
                    <span>{copy.sequence}</span>
                    <span>Part No</span>
                    <span>{copy.model}</span>
                    <span>{copy.estimatedVsPlan}</span>
                    <span>{copy.progress}</span>
                  </div>
                  {getDisplaySegments(selectedProgressRow.segments).map((segment) => (
                    <div className="production-progress-modal__row" key={segment.key}>
                      <span>{segment.sequence}</span>
                      <span>{segment.partNo}</span>
                      <span>{segment.modelName}</span>
                      <span>{formatNumber(segment.estimatedQty)} / {formatNumber(segment.plannedQty)}</span>
                      <span>
                        <div className="production-progress-modal__progress">
                          <div className="production-progress-modal__bar">
                            <span style={{ width: `${Math.max(0, Math.min(100, segment.progressRate))}%` }} />
                          </div>
                          <em className={`production-progress-chip production-progress-chip--${segment.status === "completed" ? "completed" : segment.status === "in_progress" ? "active" : "pending"}`}>
                            {getProgressText(segment.progressRate)}
                          </em>
                        </div>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : null}

          {selectedMachiningRow ? (
            <div className="modal-backdrop" role="presentation" onClick={() => setSelectedMachiningRow(null)}>
              <section
                className="modal-card production-progress-modal production-machining-manual-modal"
                aria-modal="true"
                role="dialog"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="modal-card__header">
                  <div>
                    <p className="panel-card__eyebrow">Machining</p>
                    <h3 className="panel__title">{copy.manualReportTitle}</h3>
                    <p className="production-progress-modal__meta">
                      {getLocalizedMachineLabel(selectedMachiningRow.equipment_label, language)} · {selectedMachiningRow.part_no} · {copy.planned} {formatNumber(selectedMachiningRow.planned_qty)} · {copy.effectiveQty} {formatNumber(selectedMachiningRow.effective_actual_qty)}
                    </p>
                  </div>
                  <button className="button button--ghost" onClick={() => setSelectedMachiningRow(null)} type="button">
                    {copy.close}
                  </button>
                </div>

                <div className="production-progress-modal__summary">
                  <div>
                    <span>{copy.mesQty}</span>
                    <strong>{formatNumber(selectedMachiningRow.mes_qty)}</strong>
                  </div>
                  <div>
                    <span>{copy.manualOpen}</span>
                    <strong>{formatNumber(selectedMachiningRow.manual_open_qty)}</strong>
                  </div>
                  <div>
                    <span>{copy.defectQty}</span>
                    <strong>{formatNumber(selectedMachiningRow.defect_qty)}</strong>
                  </div>
                </div>

                <form
                  className="production-manual-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!selectedMachiningRow.plan_id || createManualReportMutation.isPending) return;
                    createManualReportMutation.mutate();
                  }}
                >
                  <label>
                    <span>{copy.goodQty}</span>
                    <input
                      min="0"
                      inputMode="numeric"
                      type="number"
                      value={manualForm.goodQty}
                      onChange={(event) => setManualForm((current) => ({ ...current, goodQty: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>{copy.defectQty}</span>
                    <input
                      min="0"
                      inputMode="numeric"
                      type="number"
                      value={manualForm.defectQty}
                      onChange={(event) => setManualForm((current) => ({ ...current, defectQty: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>{copy.defectType}</span>
                    <input
                      placeholder={copy.defectTypePlaceholder}
                      value={manualForm.defectType}
                      onChange={(event) => setManualForm((current) => ({ ...current, defectType: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>{copy.reasonCode}</span>
                    <input
                      placeholder={copy.reasonPlaceholder}
                      value={manualForm.reasonCode}
                      onChange={(event) => setManualForm((current) => ({ ...current, reasonCode: event.target.value }))}
                    />
                  </label>
                  <label className="production-manual-form__wide">
                    <span>{copy.note}</span>
                    <textarea
                      rows={3}
                      value={manualForm.note}
                      onChange={(event) => setManualForm((current) => ({ ...current, note: event.target.value }))}
                    />
                  </label>
                  {createManualReportMutation.isError ? (
                    <div className="notice notice--warning production-manual-form__wide">{copy.manualReportError}</div>
                  ) : null}
                  <div className="production-manual-form__actions production-manual-form__wide">
                    <span>{copy.machiningSupplementHint}</span>
                    <button
                      className="button button--primary"
                      disabled={!selectedMachiningRow.plan_id || Number(manualForm.goodQty || 0) <= 0 || createManualReportMutation.isPending}
                      type="submit"
                    >
                      {createManualReportMutation.isPending ? copy.savingManualReport : copy.saveManualReport}
                    </button>
                  </div>
                </form>
              </section>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
