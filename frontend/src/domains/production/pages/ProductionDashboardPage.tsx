import { type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isAxiosError } from "axios";
import { GripVertical, MessageCircle, X } from "lucide-react";
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
  createProductionPlanItem,
  getAiJob,
  getAiWorkerStatus,
  getLatestAiJob,
  getMachiningProvision,
  getInjectionActivityConfirmations,
  getInjectionDowntimeConfirmations,
  getProductionMesReportStats,
  getProductionPlanSummary,
  getProductionStatus,
  resetInjectionActivityConfirmation,
  saveInjectionActivityConfirmation,
  updateProductionPartCavity,
  type InjectionActivityConfirmation,
  type InjectionActivityType,
  type MachiningProvisionResponse,
  type MachiningProvisionRow,
  type ProductionAiAskResponse,
  type ProductionAiChatHistoryMessage,
  type ProductionAiModelId,
  type ProductionMesReportStatsResponse,
  type ProductionPlanRecord,
  type ProductionPlanSummaryResponse,
  type ProductionStatusResponse,
  type SaveInjectionActivityConfirmationPayload,
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
import { getShanghaiBusinessDateString } from "@/shared/utils/date";

type ProductionBriefContext = {
  businessDate: string;
  injectionPlanQty: number;
  machiningPlanQty: number;
  actualInjectionOutput: number;
  actualMachiningOutput: number;
  plannedInjectionMachineCount: number;
  unplannedInjectionShots: number;
  unplannedInjectionMachineCount: number;
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

type KpiDetailKey = "injection" | "unplanned" | "machining" | "machines";

type ProductionAiChatMessage = ProductionAiChatHistoryMessage & {
  id: string;
  label?: string;
  tone?: "default" | "warning";
  meta?: string[];
  notice?: string;
  includeInHistory?: boolean;
  modelId?: ProductionAiModelId;
};

type ProductionAiQuestionRequest = {
  question: string;
  history: ProductionAiChatHistoryMessage[];
  requestId: string;
  businessDate: string;
  language: AppLanguage;
  modelId: ProductionAiModelId;
};

type ProductionAiActiveRequest = Pick<
  ProductionAiQuestionRequest,
  "requestId" | "businessDate" | "language" | "modelId"
>;

type ProductionAiApiError = {
  status: number | null;
  code: string;
  detail: string;
};

type ProductionAiChatViewportStyle = CSSProperties & {
  "--production-ai-chat-bottom"?: string;
  "--production-ai-chat-visible-height"?: string;
};

type ProductionAiChatVisibleViewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ProductionAiChatLauncherPosition = {
  x: number;
  y: number;
};

type ProductionAiChatLauncherDrag = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startCenterX: number;
  startCenterY: number;
  width: number;
  height: number;
  moved: boolean;
  lastPosition: ProductionAiChatLauncherPosition | null;
};

const PRODUCTION_AI_MODEL_OPTIONS: Array<{ id: ProductionAiModelId; label: string }> = [
  { id: "qwen35", label: "Qwen 3.5" },
  { id: "gemma4_26b_a4b", label: "Gemma 4" },
];
const GEMMA_READY_WORKER_VERSION = "production-ai-worker-v2-gemma1";
const AI_CHAT_LAUNCHER_POSITION_KEY = "wj-production-ai-chat-launcher-position-v1";
const AI_CHAT_LAUNCHER_MARGIN_PX = 8;
const AI_CHAT_LAUNCHER_DRAG_THRESHOLD_PX = 5;

function clampUnitInterval(value: number) {
  return Math.min(1, Math.max(0, value));
}

function readAiChatLauncherPosition(): ProductionAiChatLauncherPosition | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(AI_CHAT_LAUNCHER_POSITION_KEY) || "null");
    if (!value || typeof value !== "object") return null;
    const x = Number((value as Record<string, unknown>).x);
    const y = Number((value as Record<string, unknown>).y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: clampUnitInterval(x), y: clampUnitInterval(y) };
  } catch {
    return null;
  }
}

function persistAiChatLauncherPosition(position: ProductionAiChatLauncherPosition) {
  try {
    window.localStorage.setItem(AI_CHAT_LAUNCHER_POSITION_KEY, JSON.stringify(position));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function getProductionAiModelLabel(modelId: ProductionAiModelId) {
  return PRODUCTION_AI_MODEL_OPTIONS.find((option) => option.id === modelId)?.label ?? modelId;
}

function inferProductionAiModelId(modelName: string): ProductionAiModelId | null {
  const normalized = modelName.trim().toLowerCase();
  if (normalized.includes("gemma")) return "gemma4_26b_a4b";
  if (normalized.includes("qwen")) return "qwen35";
  return null;
}

type InjectionActivityConfirmationForm = {
  activityType: InjectionActivityType | "";
  partNo: string;
  modelName: string;
  plannedQuantity: string;
  lotNo: string;
  cavity: string;
  note: string;
};

const EMPTY_INJECTION_ACTIVITY_CONFIRMATION_FORM: InjectionActivityConfirmationForm = {
  activityType: "",
  partNo: "",
  modelName: "",
  plannedQuantity: "",
  lotNo: "",
  cavity: "1",
  note: "",
};

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

type MachineActivityHover = {
  machineNumber: number;
  machineLabel: string;
  pct: number;
  layerX: number;
  layerY: number;
  startLabel: string;
  endLabel: string;
  shots: number;
  averageCycleTimeSec: number | null;
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
    description: "생산 계획과 MES 실적을 비교하고, Qwen과 Gemma의 생산 브리핑을 제공합니다.",
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
    briefModelSelect: "브리핑 모델 선택",
    briefModelCompareHint: "동일한 검증 데이터를 요약한 모델별 브리핑을 비교합니다.",
    briefLoading: "선택한 모델의 최신 생산 브리핑을 불러오는 중입니다.",
    briefPending: "선택한 모델의 생산 브리핑을 준비하고 있습니다. 잠시 후 자동으로 표시됩니다.",
    briefFailed: "선택한 모델의 최신 AI 브리핑이 안전 검증을 통과하지 못했습니다. 다음 자동 분석을 기다려 주세요.",
    askAi: "AI 생산 어시스턴트",
    aiLauncherDragHint: "드래그해서 챗봇 버튼 위치를 옮길 수 있습니다.",
    closeAi: "AI 어시스턴트 닫기",
    aiAssistantTitle: "AI 생산 어시스턴트",
    aiAssistantIntro: "선택한 로컬 모델이 현재 기준일의 검증된 생산 데이터와 저장된 시간별 분석 기록을 바탕으로 답합니다.",
    aiAssistantUser: "나",
    aiAssistantAi: "생산 어시스턴트",
    aiInputLabel: "생산 데이터 질문 입력",
    workerOnline: "Mac Studio Worker 온라인",
    workerOffline: "Mac Studio Worker 오프라인",
    workerUnknown: "Worker 상태 확인 불가",
    workerModelReady: "로컬 모델 준비됨",
    workerModelUnavailable: "로컬 모델 연결 안 됨",
    workerHeartbeat: "마지막 신호",
    workerLastAnalysis: "최근 분석 완료",
    workerModel: "모델",
    workerJobTitle: "선택 모델의 최근 AI 브리핑",
    workerJobResult: "AI 요약",
    askingAi: "질문 전송 중",
    aiQuestionPlaceholder: "예: 오늘 사출 생산 진도는? / 최근 60분 C/T가 가장 긴 설비는? / 지금 추이대로 1, 9호기 예상 형합수는?",
    aiQuestionScope: "검증된 생산 데이터 · 시간별 분석 기록 기반",
    aiSource: "출처",
    aiSourceVerified: "검증된 생산 데이터",
    aiRequestFailedTitle: "질문 전송 실패",
    aiRequestFailed: "질문을 서버로 전송하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.",
    aiQuestionInProgressTitle: "이전 질문 처리 중",
    aiQuestionInProgress: "이전 질문을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.",
    aiQueueUnavailableTitle: "로컬 AI 큐 이용 불가",
    aiQueueUnavailable: "로컬 AI 질문 큐를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    aiQuestionTooLongTitle: "질문이 너무 깁니다",
    aiQuestionTooLong: "질문은 1,000자 이하로 줄여서 다시 입력해 주세요.",
    aiRequestRejectedTitle: "질문 확인 필요",
    aiModelSelect: "답변 모델 선택",
    aiModelCompareHint: "모델별 대화 기록을 분리하며, 선택 모델 연결은 질문 전에 확인합니다.",
    aiSelectedModelUnavailable: "선택한 모델이 아직 준비되지 않았습니다. Worker와 모델 서버 상태를 확인해 주세요.",
    aiAnswerTitle: "답변",
    aiAnswerQueued: "답변 준비 중",
    aiAnswerRunning: "답변 작성 중",
    aiAnswerReady: "답변 완료",
    aiAnswerFailed: "답변 실패",
    aiAnswerQueuedHint: "생산 데이터를 확인해 답변을 작성하고 있습니다",
    aiAnswerQueuedFailedHint: "선택한 로컬 모델의 답변을 가져오지 못했습니다. 잠시 후 다시 질문해 주세요.",
    aiAnswerModelMismatchHint: "선택한 모델과 실제 실행 모델이 달라 답변을 표시하지 않았습니다. Worker 업데이트 상태를 확인해 주세요.",
    aiSubmit: "질문하기",
    progressEyebrow: "LIVE PROGRESS",
    progressTitle: "실시간 프로그레스",
    progressDescription: "사출은 생산 계획과 MES 형합수를 조합해 Cavity 기준 추정 생산량으로 진행률을 계산합니다.",
    injectionProgress: "사출 실시간 진행",
    machiningProgress: "가공 실시간 진행",
    planned: "계획",
    actualEstimate: "추정 생산",
    shotCount: "형합수",
    shotUnit: "회",
    machineUnit: "대",
    unplannedShotSummary: "무계획가동",
    noUnplannedOperation: "무계획가동 없음",
    moreMachines: "외",
    openInjectionBoard: "사출 현황판 열기",
    openInjectionBoardHint: "사무실 모니터용 20블록 실시간 현황판",
    running: "가동",
    paused: "일시중지",
    unplannedRunning: "무계획 가동",
    activityReview: "활동 확인",
    pausedCount: "일시중지",
    reviewCount: "확인 필요",
    baselineCycleTime: "기준 C/T",
    noClampDuration: "무형합",
    noPlan: "생산 계획 없음",
    productConfirmationTitle: "생산 제품 확인 필요",
    productConfirmationBody: "계획 없이 형합이 계속 들어오고 있습니다. 생산 중인 Part No.와 계획을 확인해 반영하세요.",
    activityConfirmationTitle: "활동 내역 확인 필요",
    activityConfirmationBody: "계획 없이 형합 이력이 있습니다. 시험 사출, 금형 점검 또는 실제 생산 여부를 MES에서 확인하세요.",
    productInputAction: "제품/계획 입력",
    quickPlanEyebrow: "QUICK PLAN",
    quickPlanModalTitle: "생산 제품·계획 등록",
    quickPlanModalBody: "현재 화면을 유지한 채 생산 제품과 당일 계획을 등록합니다. 저장 즉시 실시간 진행률에 반영됩니다.",
    quickPlanDate: "기준일",
    plannedQuantityLabel: "계획 수량",
    plannedQuantityPlaceholder: "예: 1,200",
    lotNoLabel: "Lot No. (선택)",
    cavityCountLabel: "개별 캐비티",
    cavityCountHint: "1회 형합 시 이 Part의 생산 수량",
    planNoteLabel: "비고 (선택)",
    quickPlanRequired: "Part No., 모델명, 계획 수량을 모두 입력하세요.",
    quickPlanQuantityRequired: "계획 수량은 1개 이상이어야 합니다.",
    quickPlanCavityRequired: "개별 캐비티는 1개 이상이어야 합니다.",
    quickPlanSave: "계획 등록",
    quickPlanSaving: "등록 중",
    quickPlanSaveError: "생산 계획을 등록하지 못했습니다. 중복 계획, 권한 또는 입력값을 확인하세요.",
    activityCheckAction: "MES 활동 확인",
    activityConfirmModalTitle: "설비 활동 확정",
    activityConfirmModalBody: "계획에 없는 형합 이력을 분류해 다음 근무자가 같은 설비 상태를 바로 이해할 수 있게 합니다.",
    activityType: "활동 구분",
    activityTypePlaceholder: "활동을 선택하세요",
    activityProduction: "실제 생산",
    activityTestShot: "시험 사출",
    activityMoldCheck: "금형 점검",
    activityMachineCheck: "설비 점검",
    activityMaintenance: "보전 작업",
    activityQualityCheck: "품질 확인",
    activityOther: "기타",
    partNoLabel: "Part No.",
    modelNameLabel: "모델명",
    activityNotePlaceholder: "판정 근거나 교대 전달 사항을 입력하세요.",
    activityPartRequired: "실제 생산이면 Part No.를 입력해야 합니다.",
    activityOtherNoteRequired: "기타 활동의 내용을 비고에 입력해야 합니다.",
    activitySave: "확정 저장",
    activitySaving: "저장 중",
    activitySaveError: "활동 확인 내용을 저장하지 못했습니다. 권한과 입력값을 확인하세요.",
    activityReset: "확정 해제",
    activityResetting: "해제 중",
    activityConfirmed: "확인 완료",
    activityEdit: "확인 내용 수정",
    activityConfirmedBy: "확정자",
    lastClamp: "최근 형합",
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
    description: "对比生产计划与 MES 实绩，并提供 Qwen 与 Gemma 的生产简报。",
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
    briefModelSelect: "选择简报模型",
    briefModelCompareHint: "比较基于同一份已验证数据生成的模型简报。",
    briefLoading: "正在加载所选模型的最新生产简报。",
    briefPending: "所选模型的生产简报正在生成，完成后会自动显示。",
    briefFailed: "所选模型的最新 AI 简报未通过安全验证，请等待下一次自动分析。",
    askAi: "AI 生产助手",
    aiLauncherDragHint: "可拖动聊天按钮调整位置。",
    closeAi: "关闭 AI 助手",
    aiAssistantTitle: "AI 生产助手",
    aiAssistantIntro: "所选本地模型会根据当前基准日的已验证生产数据和已保存的每小时分析记录回答。",
    aiAssistantUser: "我",
    aiAssistantAi: "生产助手",
    aiInputLabel: "输入生产数据问题",
    workerOnline: "Mac Studio Worker 在线",
    workerOffline: "Mac Studio Worker 离线",
    workerUnknown: "无法确认 Worker 状态",
    workerModelReady: "本地模型已就绪",
    workerModelUnavailable: "本地模型未连接",
    workerHeartbeat: "最后心跳",
    workerLastAnalysis: "最近分析完成",
    workerModel: "模型",
    workerJobTitle: "所选模型的最新 AI 简报",
    workerJobResult: "AI 摘要",
    askingAi: "发送中",
    aiQuestionPlaceholder: "例：今天注塑生产进度？/ 最近60分钟 C/T 最长的设备？/ 按当前趋势，1、9号机结束时预计合模数？",
    aiQuestionScope: "基于已验证生产数据与每小时分析记录",
    aiSource: "来源",
    aiSourceVerified: "已验证的生产数据",
    aiRequestFailedTitle: "问题发送失败",
    aiRequestFailed: "无法将问题发送到服务器。请检查连接后重试。",
    aiQuestionInProgressTitle: "上一问题仍在处理中",
    aiQuestionInProgress: "上一问题仍在处理中，请稍后重试。",
    aiQueueUnavailableTitle: "本地 AI 队列暂不可用",
    aiQueueUnavailable: "本地 AI 问题队列暂时不可用，请稍后重试。",
    aiQuestionTooLongTitle: "问题内容过长",
    aiQuestionTooLong: "请将问题缩短至 1,000 个字符以内后重试。",
    aiRequestRejectedTitle: "请确认问题内容",
    aiModelSelect: "选择回答模型",
    aiModelCompareHint: "不同模型的对话记录会分开；提问前会检查所选模型的连接状态。",
    aiSelectedModelUnavailable: "所选模型尚未就绪。请确认 Worker 和模型服务器状态。",
    aiAnswerTitle: "回答",
    aiAnswerQueued: "准备回答中",
    aiAnswerRunning: "正在撰写回答",
    aiAnswerReady: "回答完成",
    aiAnswerFailed: "回答失败",
    aiAnswerQueuedHint: "正在查看生产数据并撰写回答",
    aiAnswerQueuedFailedHint: "无法获取所选本地模型的回答。请稍后重新提问。",
    aiAnswerModelMismatchHint: "所选模型与实际运行模型不一致，因此未显示该回答。请检查 Worker 更新状态。",
    aiSubmit: "提问",
    progressEyebrow: "LIVE PROGRESS",
    progressTitle: "实时进度",
    progressDescription: "注塑结合生产计划与 MES 合模数，并按 Cavity 估算生产量计算进度。",
    injectionProgress: "注塑实时进度",
    machiningProgress: "加工实时进度",
    planned: "计划",
    actualEstimate: "估算生产",
    shotCount: "合模数",
    shotUnit: "次",
    machineUnit: "台",
    unplannedShotSummary: "无计划运行",
    noUnplannedOperation: "无计划运行记录",
    moreMachines: "另有",
    openInjectionBoard: "打开注塑看板",
    openInjectionBoardHint: "办公室显示器用20格实时看板",
    running: "运行",
    paused: "暂时停机",
    unplannedRunning: "无计划运行",
    activityReview: "活动待确认",
    pausedCount: "暂时停机",
    reviewCount: "待确认",
    baselineCycleTime: "基准 C/T",
    noClampDuration: "无合模",
    noPlan: "无生产计划",
    productConfirmationTitle: "需确认生产产品",
    productConfirmationBody: "设备在无计划状态下持续产生合模记录。请确认正在生产的 Part No. 并补充计划。",
    activityConfirmationTitle: "需确认设备活动",
    activityConfirmationBody: "设备存在无计划合模记录。请在 MES 中确认是试模、模具检查还是实际生产。",
    productInputAction: "录入产品/计划",
    quickPlanEyebrow: "QUICK PLAN",
    quickPlanModalTitle: "登记产品与生产计划",
    quickPlanModalBody: "保持当前画面并登记产品及当日计划，保存后立即反映到实时进度。",
    quickPlanDate: "基准日",
    plannedQuantityLabel: "计划数量",
    plannedQuantityPlaceholder: "例如 1,200",
    lotNoLabel: "Lot No.（选填）",
    cavityCountLabel: "单件型腔数",
    cavityCountHint: "每次合模该 Part 的生产数量",
    planNoteLabel: "备注（选填）",
    quickPlanRequired: "请填写 Part No.、型号和计划数量。",
    quickPlanQuantityRequired: "计划数量必须大于 0。",
    quickPlanCavityRequired: "单件型腔数必须大于 0。",
    quickPlanSave: "登记计划",
    quickPlanSaving: "登记中",
    quickPlanSaveError: "无法登记生产计划。请检查重复计划、权限或输入内容。",
    activityCheckAction: "确认 MES 活动",
    activityConfirmModalTitle: "确认设备活动",
    activityConfirmModalBody: "对计划外合模记录进行分类，便于下一班人员直接了解设备状态。",
    activityType: "活动分类",
    activityTypePlaceholder: "请选择活动",
    activityProduction: "实际生产",
    activityTestShot: "试模",
    activityMoldCheck: "模具检查",
    activityMachineCheck: "设备检查",
    activityMaintenance: "维护作业",
    activityQualityCheck: "品质确认",
    activityOther: "其他",
    partNoLabel: "Part No.",
    modelNameLabel: "型号",
    activityNotePlaceholder: "请输入判断依据或交班事项。",
    activityPartRequired: "实际生产必须填写 Part No.。",
    activityOtherNoteRequired: "其他活动必须在备注中填写内容。",
    activitySave: "保存确认",
    activitySaving: "保存中",
    activitySaveError: "无法保存活动确认。请检查权限和输入内容。",
    activityReset: "撤销确认",
    activityResetting: "撤销中",
    activityConfirmed: "已确认",
    activityEdit: "修改确认内容",
    activityConfirmedBy: "确认人",
    lastClamp: "最近合模",
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
    plannedActualPlan: "계획 실적 / 계획",
    unplannedShotSummary: "무계획가동",
    outsidePlanMes: "계획 외 MES 실적",
    unplannedBadge: "무계획",
    confirmationNeeded: "활동 확인 필요",
    unplannedTitle: "무계획가동 상세",
    unplannedDescription: "생산계획 없이 형합이 기록된 설비입니다. 실제 생산, 시험 사출 또는 점검 여부를 확인하세요.",
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
    plannedActualPlan: "计划内实绩 / 计划",
    unplannedShotSummary: "无计划运行",
    outsidePlanMes: "计划外 MES 实绩",
    unplannedBadge: "无计划",
    confirmationNeeded: "需确认活动",
    unplannedTitle: "无计划运行详情",
    unplannedDescription: "以下设备在没有生产计划时记录了合模。请确认是实际生产、试模还是检查作业。",
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
    rollingCycleTime: "직전 60분 평균 C/T",
    noCycleTime: "직전 60분 형합 기록 없음",
    cycleTimeSeconds: "초",
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
    rollingCycleTime: "前60分钟平均 C/T",
    noCycleTime: "前60分钟无合模记录",
    cycleTimeSeconds: "秒",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

const LIVE_DATA_REFRESH_INTERVAL_MS = 120_000;
const AI_WORKER_STATUS_REFRESH_INTERVAL_MS = 30_000;
const AI_QUESTION_JOB_POLL_INTERVAL_MS = 1_500;
const AI_QUESTION_JOB_POLL_TIMEOUT_MS = 3 * 60_000;
const INJECTION_MACHINE_TOTAL = 17;
const MACHINE_UTILIZATION_BUCKET_MINUTES = 5;
const MACHINE_ACTIVITY_DETAIL_RETENTION_DAYS = 7;
const MACHINE_ACTIVITY_DISPLAY_IDLE_BRIDGE_MINUTES = 6;
const MACHINE_ACTIVITY_CT_COMPARISON_WINDOW_MINUTES = 60;
const MACHINE_ACTIVITY_CT_CONTINUITY_RATIO = 1.35;
const MACHINE_ACTIVITY_CT_MAX_BRIDGE_MINUTES = 15;
const UTILIZATION_CHART_TOP_Y = 4;
const UTILIZATION_CHART_BOTTOM_Y = 54;
const ACTIVITY_PART_SEQUENCE_HUES = [154, 170, 188, 206, 224, 42];
const ACTIVITY_PART_VARIANT_LIGHTNESS = [36, 42, 48, 54];
const ACTIVITY_PART_SEQUENCE_SATURATION = 54;

function formatNumber(value: number) {
  return Math.round(value).toLocaleString();
}

function getStringField(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function getProductionAiApiError(error: unknown): ProductionAiApiError {
  if (!isAxiosError(error)) {
    return { status: null, code: "", detail: "" };
  }
  const responseData = error.response?.data;
  const payload = responseData && typeof responseData === "object"
    ? responseData as Record<string, unknown>
    : {};
  const detail = getStringField(payload, "detail")
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 500);
  return {
    status: error.response?.status ?? null,
    code: getStringField(payload, "code").trim().slice(0, 100),
    detail,
  };
}

async function cancelProductionAiJobBestEffort(jobId: number) {
  try {
    await cancelAiJob(jobId);
    return true;
  } catch (error) {
    const status = isAxiosError(error) ? error.response?.status : null;
    if (status === 400 || status === 404) return false;
    return false;
  }
}

function formatAiTimestamp(value: string | null | undefined, language: AppLanguage) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatAiModelName(value: string | null | undefined) {
  const segments = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  return segments.length ? segments[segments.length - 1] : "-";
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
  const todayStart = getBusinessDayStart(getShanghaiBusinessDateString());
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
  const fallbackTime = businessDate === getShanghaiBusinessDateString() ? new Date() : end;
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

function getQuickPlanMachineName(row: RealtimeProgressRow, mesData?: InjectionProductionMatrix) {
  const machineNumber = Number(row.key || getMachineNumberFromName(row.label));
  const machine = Number.isFinite(machineNumber)
    ? mesData?.machines?.find((item) => item.machine_number === machineNumber)
    : undefined;
  const tonnage = String(machine?.tonnage ?? "").trim().replace(/T$/i, "");

  if (machine && tonnage) return `${tonnage}T-${machine.machine_number}`;
  return machine?.display_name || row.label;
}

function getMachineFallbackLabel(machineNumber: number, language: AppLanguage) {
  return language === "zh" ? `${machineNumber}号机` : `${machineNumber}호기`;
}

function getLocalizedMachineLabel(value: string | null | undefined, language: AppLanguage) {
  const label = String(value ?? "").trim();
  if (language !== "zh") return label;
  return label.replace(/호기/g, "号机");
}

function getCompactMachineLabel(value: string | null | undefined, language: AppLanguage) {
  const machineNumber = Number(getMachineNumberFromName(value));
  return Number.isFinite(machineNumber) && machineNumber > 0
    ? getMachineFallbackLabel(machineNumber, language)
    : getLocalizedMachineLabel(value, language);
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

function formatOptionalTimeLabel(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "-" : formatTimeLabel(parsed);
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
  progressRows: RealtimeProgressRow[],
  mesData?: InjectionProductionMatrix,
): CumulativeTrendSummary {
  const businessStart = getBusinessDayStart(businessDate);
  const businessEnd = getBusinessDayEnd(businessDate);
  const referenceEnd = getBusinessDayReferenceEnd(businessDate, mesData);
  const points: CumulativeTrendPoint[] = [getTrendPoint("start", businessStart, 0, plannedQty, businessStart, businessEnd)];
  const plannedProgressByMachine = new Map<string, RealtimeProgressRow>();
  progressRows.forEach((row) => {
    if (!row.hasPlan) return;
    const machineKey = String(getMachineNumberFromName(row.label) ?? row.key);
    plannedProgressByMachine.set(machineKey, row);
  });
  let cumulativeQty = 0;

  mesData?.time_slots?.forEach((slot, index) => {
    const slotTime = new Date(slot.time);
    if (slotTime < businessStart || slotTime > referenceEnd || slotTime > businessEnd) return;
    cumulativeQty += (mesData.machines ?? []).reduce((sum, machine) => {
      const progressRow = plannedProgressByMachine.get(String(machine.machine_number));
      if (!progressRow) return sum;
      const row = getMachineMatrixValues(mesData, mesData.actual_production_matrix, machine.machine_number);
      const shotYield = progressRow.shotCount > 0
        ? progressRow.estimatedQty / progressRow.shotCount
        : Math.max(1, progressRow.avgCavity);
      return sum + numberAt(row, index) * shotYield;
    }, 0);
    points.push(getTrendPoint(`slot-${index}`, slotTime, Math.round(cumulativeQty), plannedQty, businessStart, businessEnd));
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

function summarizeActivityCycleTime(
  slots: MachineActivitySlot[],
  startTime: Date,
  endTime: Date,
) {
  const startMs = startTime.getTime();
  const endMs = endTime.getTime();
  if (endMs <= startMs) {
    return {
      shots: 0,
      averageCycleTimeSec: null as number | null,
      windowMinutes: 0,
    };
  }

  let shots = 0;
  slots.forEach((slot) => {
    const slotStartMs = slot.slotTime.getTime();
    const slotEndMs = slot.slotEnd.getTime();
    const slotDurationMs = slotEndMs - slotStartMs;
    if (slotDurationMs <= 0 || slot.output <= 0) return;

    const overlapMs = Math.min(slotEndMs, endMs) - Math.max(slotStartMs, startMs);
    if (overlapMs <= 0) return;
    shots += slot.output * Math.min(1, overlapMs / slotDurationMs);
  });

  const elapsedSeconds = (endMs - startMs) / 1000;
  return {
    shots,
    averageCycleTimeSec: shots > 0 ? elapsedSeconds / shots : null,
    windowMinutes: elapsedSeconds / 60,
  };
}

function getCycleTimeBridgeLimit(
  summary: ReturnType<typeof summarizeActivityCycleTime>,
  adjacentIntervalMinutes: number,
  fallbackBridgeMinutes: number,
) {
  if (!isReliableCycleTimeSummary(summary)) {
    return fallbackBridgeMinutes;
  }

  return Math.min(
    MACHINE_ACTIVITY_CT_MAX_BRIDGE_MINUTES,
    Math.max(
      fallbackBridgeMinutes,
      ((summary.averageCycleTimeSec ?? 0) * 2.5) / 60 + adjacentIntervalMinutes,
    ),
  );
}

function isReliableCycleTimeSummary(
  summary: ReturnType<typeof summarizeActivityCycleTime>,
) {
  return summary.averageCycleTimeSec !== null && summary.shots >= 3 && summary.windowMinutes >= 10;
}

function isContinuousCycleTimeGap(
  slots: MachineActivitySlot[],
  previousIndex: number,
  nextIndex: number,
  gapMinutes: number,
  fallbackBridgeMinutes: number,
) {
  const previousSlot = slots[previousIndex];
  const nextSlot = slots[nextIndex];
  if (!previousSlot?.active || !nextSlot?.active || gapMinutes <= 0) return false;

  const availableStart = slots[0]?.slotTime;
  const availableEnd = slots.at(-1)?.slotEnd;
  if (!availableStart || !availableEnd) return gapMinutes <= fallbackBridgeMinutes;

  const windowMs = MACHINE_ACTIVITY_CT_COMPARISON_WINDOW_MINUTES * 60 * 1000;
  const beforeEnd = previousSlot.slotEnd;
  const beforeStart = new Date(Math.max(availableStart.getTime(), beforeEnd.getTime() - windowMs));
  const afterStart = nextSlot.slotTime;
  const afterEnd = new Date(Math.min(availableEnd.getTime(), afterStart.getTime() + windowMs));
  const before = summarizeActivityCycleTime(slots, beforeStart, beforeEnd);
  const after = summarizeActivityCycleTime(slots, afterStart, afterEnd);
  const adjacentIntervalMinutes = Math.max(previousSlot.intervalMinutes, nextSlot.intervalMinutes);
  const beforeLimit = getCycleTimeBridgeLimit(before, adjacentIntervalMinutes, fallbackBridgeMinutes);
  const afterLimit = getCycleTimeBridgeLimit(after, adjacentIntervalMinutes, fallbackBridgeMinutes);
  const beforeReliable = isReliableCycleTimeSummary(before);
  const afterReliable = isReliableCycleTimeSummary(after);

  if (
    beforeReliable &&
    afterReliable &&
    before.averageCycleTimeSec !== null &&
    after.averageCycleTimeSec !== null
  ) {
    const slowerCycleTime = Math.max(before.averageCycleTimeSec, after.averageCycleTimeSec);
    const fasterCycleTime = Math.min(before.averageCycleTimeSec, after.averageCycleTimeSec);
    const cycleTimeRatio = slowerCycleTime / Math.max(0.1, fasterCycleTime);
    if (cycleTimeRatio > MACHINE_ACTIVITY_CT_CONTINUITY_RATIO) return false;
  }

  const maxBridgeMinutes = Math.max(beforeLimit, afterLimit);
  return gapMinutes <= maxBridgeMinutes;
}

function isExpectedCycleTimeTail(
  slots: MachineActivitySlot[],
  previousIndex: number,
  idleMinutes: number,
  fallbackBridgeMinutes: number,
) {
  const previousSlot = slots[previousIndex];
  const availableStart = slots[0]?.slotTime;
  if (!previousSlot?.active || !availableStart || idleMinutes <= 0) return false;

  const windowMs = MACHINE_ACTIVITY_CT_COMPARISON_WINDOW_MINUTES * 60 * 1000;
  const windowEnd = previousSlot.slotEnd;
  const windowStart = new Date(Math.max(availableStart.getTime(), windowEnd.getTime() - windowMs));
  const summary = summarizeActivityCycleTime(slots, windowStart, windowEnd);
  const bridgeLimit = getCycleTimeBridgeLimit(
    summary,
    previousSlot.intervalMinutes,
    fallbackBridgeMinutes,
  );
  return idleMinutes <= bridgeLimit;
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

    const hasContinuousCycleTime = nextSlot
      ? isContinuousCycleTimeGap(
        bridgedSlots,
        runStart - 1,
        runEnd,
        idleMinutes,
        maxBridgeMinutes,
      )
      : isExpectedCycleTimeTail(
        bridgedSlots,
        runStart - 1,
        idleMinutes,
        maxBridgeMinutes,
      );

    const isTrailingContinuous = Boolean(
      previousSlot?.active &&
      !nextSlot &&
      Math.abs(bridgedSlots[runStart].slotTime.getTime() - previousSlot.slotEnd.getTime()) < 1000 &&
      bridgedSlots.slice(runStart + 1, runEnd).every((slot, index) => (
        Math.abs(slot.slotTime.getTime() - bridgedSlots[runStart + index].slotEnd.getTime()) < 1000
      )),
    );
    if ((isBoundedByProduction && isTimeContinuous || isTrailingContinuous) && hasContinuousCycleTime) {
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
    const bridgeableGapBefore = new Set<number>();

    if (!useRollupDensity) {
      for (let slotIndex = 1; slotIndex < displaySlots.length; slotIndex += 1) {
        const previousSlot = displaySlots[slotIndex - 1];
        const currentSlot = displaySlots[slotIndex];
        const gapMinutes = (currentSlot.slotTime.getTime() - previousSlot.slotEnd.getTime()) / (60 * 1000);
        if (
          previousSlot.displayActive &&
          currentSlot.displayActive &&
          isContinuousCycleTimeGap(
            displaySlots,
            slotIndex - 1,
            slotIndex,
            gapMinutes,
            MACHINE_ACTIVITY_DISPLAY_IDLE_BRIDGE_MINUTES,
          )
        ) {
          bridgeableGapBefore.add(slotIndex);
        }
      }
    }

    displaySlots.forEach((slot, displaySlotIndex) => {
      const startPct = clampPercent(((slot.slotTime.getTime() - businessStart.getTime()) / (businessEnd.getTime() - businessStart.getTime())) * 100);
      const widthPct = Math.max(0.1, clampPercent(((slot.slotEnd.getTime() - slot.slotTime.getTime()) / (businessEnd.getTime() - businessStart.getTime())) * 100));
      const displayActive = slot.displayActive;
      const density = displayActive
        ? (useRollupDensity ? Math.min(1, Math.max(0.22, 0.22 + (slot.output / maxSegmentOutput) * 0.78)) : 0.88)
        : undefined;
      output += slot.output;
      if (displayActive) {
        activeMinutes += Math.max(0, (slot.slotEnd.getTime() - slot.slotTime.getTime()) / (60 * 1000));
      }
      if (bridgeableGapBefore.has(displaySlotIndex)) {
        const previousSlot = displaySlots[displaySlotIndex - 1];
        activeMinutes += Math.max(0, (slot.slotTime.getTime() - previousSlot.slotEnd.getTime()) / (60 * 1000));
      }

      const previous = segments.at(-1);
      const previousEndPct = previous ? previous.startPct + previous.widthPct : 0;
      const gapPct = startPct - previousEndPct;
      const contiguous = previous && Math.abs(gapPct) < 0.08;
      const bridgeableDisplayGap = bridgeableGapBefore.has(displaySlotIndex);
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
  const consumedGroups = new Set<string>();
  for (const segment of orderedSegments) {
    const groupKey = segment.shotGroupKey || segment.key;
    if (consumedGroups.has(groupKey)) continue;
    consumedGroups.add(groupKey);
    const groupSegments = orderedSegments.filter((candidate) => (candidate.shotGroupKey || candidate.key) === groupKey);
    const allocatedShots = Math.max(0, ...groupSegments.map((candidate) => Number(candidate.allocatedShots ?? 0) || 0));
    if (allocatedShots > 0 && shotCursor < cursor + allocatedShots) return groupSegments[0] ?? segment;
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
    .filter((row) => row.hasPlan && row.estimatedQty > 0)
    .map((row) => ({ machine: getLocalizedMachineLabel(row.label, language), output: row.estimatedQty }));
  const injectionPlanQty = realtimeSummary.plannedQty || sumPlannedQuantity(planSummary, "injection", businessDate);
  const actualInjectionOutput = realtimeSummary.estimatedQty;
  const machiningPlanQty = Number(machiningProvision?.summary?.total_planned ?? sumPlannedQuantity(planSummary, "machining", businessDate));
  const actualMachiningOutput = Number(machiningProvision?.summary?.effective_actual_qty ?? machiningStats?.summary?.total_mes ?? 0);
  const activeMachineCount = machineOutputs.filter((item) => item.output > 0).length;
  const runningMachineCount = realtimeSummary.rows.filter((row) => row.isRunning).length;
  const sortedActiveMachines = actualMachineOutputs
    .filter((item) => item.output > 0)
    .sort((a, b) => b.output - a.output);

  return {
    businessDate,
    injectionPlanQty,
    machiningPlanQty,
    actualInjectionOutput,
    actualMachiningOutput,
    plannedInjectionMachineCount: realtimeSummary.rows.filter((row) => row.hasPlan).length,
    unplannedInjectionShots: realtimeSummary.unplannedShotCount,
    unplannedInjectionMachineCount: realtimeSummary.unplannedMachineCount,
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
  const currentDate = getShanghaiBusinessDateString();
  const [businessDate, setBusinessDate] = useState(currentDate);
  const [isAiAskOpen, setIsAiAskOpen] = useState(false);
  const [aiModelId, setAiModelId] = useState<ProductionAiModelId>("qwen35");
  const [briefingModelId, setBriefingModelId] = useState<ProductionAiModelId>("qwen35");
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiChatMessages, setAiChatMessages] = useState<ProductionAiChatMessage[]>([]);
  const [aiActiveRequest, setAiActiveRequest] = useState<ProductionAiActiveRequest | null>(null);
  const [aiQuestionJobId, setAiQuestionJobId] = useState<number | null>(null);
  const [aiChatViewportStyle, setAiChatViewportStyle] = useState<ProductionAiChatViewportStyle>();
  const [aiChatVisibleViewport, setAiChatVisibleViewport] = useState<ProductionAiChatVisibleViewport>(() => ({
    left: 0,
    top: 0,
    width: typeof window === "undefined" ? 1024 : window.innerWidth,
    height: typeof window === "undefined" ? 768 : window.innerHeight,
  }));
  const [aiChatLauncherPosition, setAiChatLauncherPosition] = useState<ProductionAiChatLauncherPosition | null>(
    readAiChatLauncherPosition,
  );
  const [isAiChatLauncherDragging, setIsAiChatLauncherDragging] = useState(false);
  const [selectedProgressRow, setSelectedProgressRow] = useState<RealtimeProgressRow | null>(null);
  const [selectedActivityRow, setSelectedActivityRow] = useState<RealtimeProgressRow | null>(null);
  const [activityConfirmationForm, setActivityConfirmationForm] = useState<InjectionActivityConfirmationForm>({
    ...EMPTY_INJECTION_ACTIVITY_CONFIRMATION_FORM,
  });
  const [activityConfirmationError, setActivityConfirmationError] = useState<string | null>(null);
  const [activityModalViewportStyle, setActivityModalViewportStyle] = useState<CSSProperties>();
  const [selectedMachiningRow, setSelectedMachiningRow] = useState<MachiningProvisionRow | null>(null);
  const [activeKpiDetail, setActiveKpiDetail] = useState<KpiDetailKey | null>(null);
  const [activitySelection, setActivitySelection] = useState<MachineActivitySelection | null>(null);
  const [activityHover, setActivityHover] = useState<MachineActivityHover | null>(null);
  const aiQuestionInputRef = useRef<HTMLTextAreaElement>(null);
  const aiChatBodyRef = useRef<HTMLDivElement>(null);
  const aiChatDrawerRef = useRef<HTMLElement>(null);
  const aiChatLauncherRef = useRef<HTMLButtonElement>(null);
  const aiChatLauncherDragRef = useRef<ProductionAiChatLauncherDrag | null>(null);
  const suppressAiChatLauncherClickRef = useRef(false);
  const previousAiChatScopeRef = useRef({ businessDate: currentDate, language });
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
  const downtimeConfirmationsQuery = useQuery({
    queryKey: ["production", "injection-downtime-confirmations", businessDate],
    queryFn: () => getInjectionDowntimeConfirmations(businessDate),
    refetchInterval: liveDataRefetchInterval,
    retry: false,
  });
  const activityConfirmationsQuery = useQuery({
    queryKey: ["production", "injection-activity-confirmations", businessDate],
    queryFn: () => getInjectionActivityConfirmations(businessDate),
    refetchInterval: liveDataRefetchInterval,
    retry: false,
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
  const latestAiJobQuery = useQuery({
    queryKey: ["ai-job", "latest", businessDate, language, briefingModelId],
    queryFn: () => getLatestAiJob(businessDate, language, briefingModelId),
    enabled: isCoreDashboardDataReady,
    refetchInterval: isCurrentDate ? 30_000 : false,
    retry: false,
  });
  const aiWorkerStatusQuery = useQuery({
    queryKey: ["ai-worker", "status", language],
    queryFn: () => getAiWorkerStatus(language),
    refetchInterval: AI_WORKER_STATUS_REFRESH_INTERVAL_MS,
    retry: 1,
  });
  const aiQuestionJobQuery = useQuery({
    queryKey: ["ai-job", "question", aiQuestionJobId],
    queryFn: () => getAiJob(aiQuestionJobId as number),
    enabled: aiQuestionJobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ["completed", "failed", "cancelled"].includes(status)
        ? false
        : AI_QUESTION_JOB_POLL_INTERVAL_MS;
    },
    retry: 1,
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
      setSelectedMachiningRow(null);
    },
  });
  const saveActivityConfirmationMutation = useMutation({
    mutationFn: (payload: SaveInjectionActivityConfirmationPayload) => saveInjectionActivityConfirmation(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["production", "injection-activity-confirmations", businessDate] });
      setSelectedActivityRow(null);
      setActivityConfirmationError(null);
    },
    onError: () => setActivityConfirmationError(copy.activitySaveError),
  });
  const createQuickPlanMutation = useMutation({
    mutationFn: async () => {
      if (!selectedActivityRow) throw new Error("machine is required");

      const partNo = activityConfirmationForm.partNo.trim().toUpperCase();
      const modelName = activityConfirmationForm.modelName.trim();
      const plannedQuantity = Math.max(1, Math.round(Number(activityConfirmationForm.plannedQuantity) || 0));
      const cavity = Math.max(1, Math.round(Number(activityConfirmationForm.cavity) || 0));

      if (cavity > 1) {
        await updateProductionPartCavity(partNo, `1x${cavity}`);
      }

      const plan = await createProductionPlanItem({
        plan_date: businessDate,
        plan_type: "injection",
        machine_name: getQuickPlanMachineName(selectedActivityRow, mesQuery.data),
        part_no: partNo,
        model_name: modelName,
        lot_no: activityConfirmationForm.lotNo.trim() || null,
        planned_quantity: plannedQuantity,
      });

      await saveInjectionActivityConfirmation({
        business_date: businessDate,
        machine_key: selectedActivityRow.key,
        machine_label: selectedActivityRow.label,
        activity_type: "production",
        part_no: partNo,
        model_name: modelName,
        shot_count: selectedActivityRow.shotCount,
        last_shot_at: selectedActivityRow.lastShotAt,
        note: activityConfirmationForm.note.trim(),
      }).catch(() => undefined);

      return plan;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["production-plan-summary", businessDate] });
      queryClient.invalidateQueries({ queryKey: ["production", "plan-items", businessDate, "injection"] });
      queryClient.invalidateQueries({ queryKey: ["production-status", businessDate] });
      queryClient.invalidateQueries({ queryKey: ["production", "injection-activity-confirmations", businessDate] });
      setSelectedActivityRow(null);
      setActivityConfirmationError(null);
    },
    onError: () => setActivityConfirmationError(copy.quickPlanSaveError),
  });
  const resetActivityConfirmationMutation = useMutation({
    mutationFn: ({ targetDate, machineKey }: { targetDate: string; machineKey: string }) => (
      resetInjectionActivityConfirmation(targetDate, machineKey)
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["production", "injection-activity-confirmations", businessDate] });
      setSelectedActivityRow(null);
      setActivityConfirmationError(null);
    },
    onError: () => setActivityConfirmationError(copy.activitySaveError),
  });

  useEffect(() => {
    if (!selectedActivityRow) return undefined;

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const parentWindow = window.parent === window ? null : window.parent;
    let parentBody: HTMLElement | null = null;
    let previousParentOverflow = "";

    const syncVisibleViewport = () => {
      try {
        if (!parentWindow || !window.frameElement) {
          setActivityModalViewportStyle(undefined);
          return;
        }

        const frameRect = window.frameElement.getBoundingClientRect();
        const visibleTop = Math.max(0, -frameRect.top);
        const visibleBottom = Math.min(frameRect.height, parentWindow.innerHeight - frameRect.top);
        const visibleHeight = Math.max(320, visibleBottom - visibleTop);
        setActivityModalViewportStyle({
          position: "absolute",
          inset: "auto 0 auto 0",
          top: visibleTop,
          height: visibleHeight,
          "--modal-viewport-height": `${visibleHeight}px`,
        } as CSSProperties);
      } catch {
        setActivityModalViewportStyle(undefined);
      }
    };

    syncVisibleViewport();

    try {
      if (parentWindow) {
        parentBody = parentWindow.document.body;
        previousParentOverflow = parentBody.style.overflow;
        parentBody.style.overflow = "hidden";
        parentWindow.addEventListener("resize", syncVisibleViewport);
        parentWindow.addEventListener("scroll", syncVisibleViewport, { passive: true });
      }
    } catch {
      parentBody = null;
    }

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      if (parentBody) parentBody.style.overflow = previousParentOverflow;
      parentWindow?.removeEventListener("resize", syncVisibleViewport);
      parentWindow?.removeEventListener("scroll", syncVisibleViewport);
      setActivityModalViewportStyle(undefined);
    };
  }, [selectedActivityRow]);

  useEffect(() => {
    if (!selectedActivityRow) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (
        saveActivityConfirmationMutation.isPending ||
        createQuickPlanMutation.isPending ||
        resetActivityConfirmationMutation.isPending
      ) return;
      setSelectedActivityRow(null);
      setActivityConfirmationError(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    createQuickPlanMutation.isPending,
    resetActivityConfirmationMutation.isPending,
    saveActivityConfirmationMutation.isPending,
    selectedActivityRow,
  ]);

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
  const activityConfirmationByMachine = useMemo(
    () => new Map(
      (activityConfirmationsQuery.data?.confirmations ?? []).map((confirmation) => [confirmation.machine_key, confirmation]),
    ),
    [activityConfirmationsQuery.data?.confirmations],
  );
  const activityTypeOptions = useMemo<Array<{ value: InjectionActivityType; label: string }>>(() => [
    { value: "production", label: copy.activityProduction },
    { value: "test_shot", label: copy.activityTestShot },
    { value: "mold_check", label: copy.activityMoldCheck },
    { value: "machine_check", label: copy.activityMachineCheck },
    { value: "maintenance", label: copy.activityMaintenance },
    { value: "quality_check", label: copy.activityQualityCheck },
    { value: "other", label: copy.activityOther },
  ], [copy]);
  const unresolvedActivityReviewCount = useMemo(
    () => realtimeProgress.rows.filter((row) => !row.hasPlan && !activityConfirmationByMachine.has(row.key)).length,
    [activityConfirmationByMachine, realtimeProgress.rows],
  );
  const selectedActivityConfirmation = selectedActivityRow
    ? activityConfirmationByMachine.get(selectedActivityRow.key)
    : undefined;
  const selectedActivityIsQuickPlan = Boolean(
    selectedActivityRow && !selectedActivityRow.hasPlan && selectedActivityRow.equipmentState === "unplanned_running",
  );
  const machiningProgress = useMemo(
    () => buildMachiningProgressPreview(planSummaryQuery.data, machiningStatsQuery.data, machiningProvisionQuery.data),
    [machiningProvisionQuery.data, machiningStatsQuery.data, planSummaryQuery.data],
  );
  const latestAiJob = latestAiJobQuery.data ?? undefined;
  const latestAiJobResult = latestAiJob?.result_payload ?? {};
  const latestAiJobSummary = getStringField(latestAiJobResult, "summary").trim();
  const latestAiJobSource = getStringField(latestAiJobResult, "source");
  const latestAiJobUsedFallback = latestAiJobResult.llm_fallback === true;
  const aiWorkerStatus = aiWorkerStatusQuery.isError ? undefined : aiWorkerStatusQuery.data;
  const aiWorkerState = aiWorkerStatus?.state ?? "unknown";
  const aiWorkerStateLabel = aiWorkerState === "online"
    ? copy.workerOnline
    : aiWorkerState === "offline"
      ? copy.workerOffline
      : copy.workerUnknown;
  const aiWorkerAvailableModelIds = (aiWorkerStatus?.available_model_ids ?? []).filter(
    (modelId): modelId is ProductionAiModelId => modelId === "qwen35" || modelId === "gemma4_26b_a4b",
  );
  const workerHasExplicitModelReadiness = Array.isArray(aiWorkerStatus?.available_model_ids)
    && (aiWorkerAvailableModelIds.length > 0 || aiWorkerStatus?.llm_ready === false);
  const isAiModelAvailable = (modelId: ProductionAiModelId) => aiWorkerState === "online" && (
    workerHasExplicitModelReadiness
      ? aiWorkerAvailableModelIds.includes(modelId)
      : modelId === "qwen35"
        ? aiWorkerStatus?.llm_ready === true
        : aiWorkerStatus?.worker_version === GEMMA_READY_WORKER_VERSION
  );
  const aiSelectedModelIsAvailable = isAiModelAvailable(aiModelId);
  const briefingModelIsAvailable = isAiModelAvailable(briefingModelId);
  const latestAiJobResultModelId = getStringField(latestAiJobResult, "model_id");
  const latestAiJobActualModelId = latestAiJobResultModelId === "qwen35"
    || latestAiJobResultModelId === "gemma4_26b_a4b"
    ? latestAiJobResultModelId
    : inferProductionAiModelId(latestAiJob?.model_name || "");
  const latestAiJobUsedLocalLlm = latestAiJobSource === "local_llm_rewrite"
    && !latestAiJobUsedFallback
    && latestAiJobActualModelId === briefingModelId;
  const briefingModelStatusLabel = briefingModelIsAvailable
    ? `${getProductionAiModelLabel(briefingModelId)} · ${copy.workerModelReady}`
    : `${getProductionAiModelLabel(briefingModelId)} · ${copy.workerModelUnavailable}`;
  const aiQuestionJob = aiQuestionJobQuery.data;
  const aiQuestionJobStatus = aiQuestionJob?.status ?? (aiQuestionJobId !== null ? "pending" : null);
  const aiQuestionJobResult = aiQuestionJob?.result_payload ?? {};
  const aiQuestionJobSource = getStringField(aiQuestionJobResult, "source");
  const activeAiModelId = aiActiveRequest?.modelId ?? aiModelId;
  const activeAiModelLabel = getProductionAiModelLabel(activeAiModelId);
  const activeAiModelIsAvailable = isAiModelAvailable(activeAiModelId);
  const activeAiModelStatusLabel = activeAiModelIsAvailable
    ? `${activeAiModelLabel} · ${copy.workerModelReady}`
    : `${activeAiModelLabel} · ${copy.workerModelUnavailable}`;
  const aiQuestionJobModelName = aiQuestionJob?.model_name || getStringField(aiQuestionJobResult, "model_name");
  const aiQuestionJobResultModelId = getStringField(aiQuestionJobResult, "model_id");
  const aiQuestionJobActualModelId = aiQuestionJobResultModelId === "qwen35"
    || aiQuestionJobResultModelId === "gemma4_26b_a4b"
    ? aiQuestionJobResultModelId
    : inferProductionAiModelId(aiQuestionJobModelName);
  const aiQuestionJobModelMatchesRequest = !aiActiveRequest
    || aiQuestionJobActualModelId === aiActiveRequest.modelId;
  const aiQuestionJobUsedLocalLlm = aiQuestionJobSource === "local_llm_rewrite"
    && aiQuestionJobResult.llm_fallback !== true
    && aiQuestionJobModelMatchesRequest;
  const aiQuestionJobFailed = aiQuestionJobStatus === "failed" || aiQuestionJobStatus === "cancelled";
  const aiQuestionJobCompleted = aiQuestionJobStatus === "completed";
  const aiQuestionJobStatusLabel = aiQuestionJobFailed
    ? copy.aiAnswerFailed
    : aiQuestionJobCompleted
      ? aiQuestionJobUsedLocalLlm
        ? copy.aiAnswerReady
        : copy.aiAnswerFailed
      : aiQuestionJobStatus === "claimed" || aiQuestionJobStatus === "running"
        ? copy.aiAnswerRunning
        : copy.aiAnswerQueued;
  const visibleAiChatMessages = aiChatMessages.filter((message) => message.modelId === activeAiModelId);

  function appendAiChatMessage(message: ProductionAiChatMessage) {
    setAiChatMessages((current) => (
      current.some((item) => item.id === message.id) ? current : [...current, message]
    ));
  }

  function excludeAiQuestionFromHistory(requestId: string) {
    setAiChatMessages((current) => current.map((message) => (
      message.id === `${requestId}-user`
        ? { ...message, includeInHistory: false }
        : message
    )));
  }

  const aiQuestionMutation = useMutation({
    mutationFn: (request: ProductionAiQuestionRequest): Promise<ProductionAiAskResponse> => (
      askProductionAi(
        request.businessDate,
        request.question,
        request.language,
        request.history,
        request.modelId,
      )
    ),
    onMutate: (request) => {
      setAiActiveRequest({
        requestId: request.requestId,
        businessDate: request.businessDate,
        language: request.language,
        modelId: request.modelId,
      });
      setAiQuestionJobId(null);
      appendAiChatMessage({
        id: `${request.requestId}-user`,
        role: "user",
        content: request.question,
        includeInHistory: true,
        modelId: request.modelId,
      });
      setAiQuestion("");
    },
    onSuccess: (payload, request) => {
      const jobId = typeof payload.job_id === "number" ? payload.job_id : null;
      if (request.businessDate !== businessDate || request.language !== language) {
        if (jobId !== null) void cancelProductionAiJobBestEffort(jobId);
        setAiActiveRequest((current) => current?.requestId === request.requestId ? null : current);
        return;
      }
      if (payload.model_id !== request.modelId) {
        if (jobId !== null) void cancelProductionAiJobBestEffort(jobId);
        excludeAiQuestionFromHistory(request.requestId);
        appendAiChatMessage({
          id: `${request.requestId}-model-mismatch`,
          role: "assistant",
          content: copy.aiAnswerModelMismatchHint,
          label: `${getProductionAiModelLabel(request.modelId)} · ${copy.aiAnswerFailed}`,
          tone: "warning",
          includeInHistory: false,
          modelId: request.modelId,
        });
        setAiQuestionJobId(null);
        setAiActiveRequest((current) => current?.requestId === request.requestId ? null : current);
        return;
      }
      if (jobId === null) {
        excludeAiQuestionFromHistory(request.requestId);
        const questionWasUnsupported = payload.source === "deterministic_unhandled";
        appendAiChatMessage({
          id: `${request.requestId}-model-unavailable`,
          role: "assistant",
          content: questionWasUnsupported ? payload.answer : copy.aiQueueUnavailable,
          label: questionWasUnsupported ? copy.aiRequestRejectedTitle : copy.aiQueueUnavailableTitle,
          tone: "warning",
          includeInHistory: false,
          modelId: request.modelId,
        });
      }
      setAiQuestionJobId(jobId);
      if (jobId === null) {
        setAiActiveRequest((current) => current?.requestId === request.requestId ? null : current);
      }
    },
    onError: (error, request) => {
      if (request.businessDate !== businessDate || request.language !== language) {
        setAiActiveRequest((current) => current?.requestId === request.requestId ? null : current);
        return;
      }
      const apiError = getProductionAiApiError(error);
      excludeAiQuestionFromHistory(request.requestId);
      const isQuestionInProgress = apiError.code === "ai_question_in_progress" || apiError.status === 429;
      const isQueueUnavailable = apiError.code === "ai_question_enqueue_failed" || apiError.status === 503;
      const isQuestionTooLong = apiError.code === "question_too_long";
      const canShowServerDetail = Boolean(apiError.detail)
        && apiError.status !== null
        && apiError.status >= 400
        && apiError.status < 500;
      appendAiChatMessage({
        id: `${request.requestId}-request-error`,
        role: "assistant",
        content: isQuestionInProgress
          ? copy.aiQuestionInProgress
          : isQueueUnavailable
            ? copy.aiQueueUnavailable
            : isQuestionTooLong
              ? copy.aiQuestionTooLong
              : canShowServerDetail
                ? apiError.detail
                : copy.aiRequestFailed,
        label: isQuestionInProgress
          ? copy.aiQuestionInProgressTitle
          : isQueueUnavailable
            ? copy.aiQueueUnavailableTitle
            : isQuestionTooLong
              ? copy.aiQuestionTooLongTitle
              : canShowServerDetail
                ? copy.aiRequestRejectedTitle
                : copy.aiRequestFailedTitle,
        tone: "warning",
        includeInHistory: false,
        modelId: request.modelId,
      });
      setAiActiveRequest((current) => current?.requestId === request.requestId ? null : current);
    },
  });
  const aiQuestionIsGenerating = aiQuestionMutation.isPending || (
    aiQuestionJobId !== null
    && !aiQuestionJobFailed
    && !aiQuestionJobCompleted
  );

  useEffect(() => {
    const previousScope = previousAiChatScopeRef.current;
    const scopeChanged = previousScope.businessDate !== businessDate || previousScope.language !== language;
    if (!scopeChanged) return;
    previousAiChatScopeRef.current = { businessDate, language };
    if (aiQuestionJobId !== null) {
      void cancelProductionAiJobBestEffort(aiQuestionJobId);
    }
    setAiChatMessages([]);
    setAiActiveRequest(null);
    setAiQuestionJobId(null);
  }, [aiQuestionJobId, businessDate, language]);

  useEffect(() => {
    if (
      aiQuestionJobId === null
      || !aiActiveRequest
    ) return undefined;
    const timedOutJobId = aiQuestionJobId;
    let disposed = false;
    let retryTimeoutId: number | undefined;
    const scheduleRetry = (callback: () => void) => {
      if (disposed) return;
      retryTimeoutId = window.setTimeout(callback, 30_000);
    };
    const resolveTimedOutJob = async () => {
      if (disposed) return;
      let latestJob: Awaited<ReturnType<typeof getAiJob>>;
      try {
        latestJob = await getAiJob(timedOutJobId);
      } catch {
        scheduleRetry(() => void resolveTimedOutJob());
        return;
      }
      if (!["completed", "failed", "cancelled"].includes(latestJob.status)) {
        try {
          latestJob = await cancelAiJob(timedOutJobId);
        } catch {
          // The job can finish between the status check and cancellation.
          // Keep polling unless a second read confirms a terminal result.
          try {
            latestJob = await getAiJob(timedOutJobId);
          } catch {
            scheduleRetry(() => void resolveTimedOutJob());
            return;
          }
        }
      }
      if (!["completed", "failed", "cancelled"].includes(latestJob.status)) {
        scheduleRetry(() => void resolveTimedOutJob());
        return;
      }
      if (!disposed) {
        queryClient.setQueryData(["ai-job", "question", timedOutJobId], latestJob);
      }
    };
    const timeoutId = window.setTimeout(() => {
      void resolveTimedOutJob();
    }, AI_QUESTION_JOB_POLL_TIMEOUT_MS);
    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
      if (retryTimeoutId !== undefined) window.clearTimeout(retryTimeoutId);
    };
  }, [aiActiveRequest, aiQuestionJobId, queryClient]);

  useEffect(() => {
    if (
      !aiQuestionJob
      || !aiActiveRequest
      || aiActiveRequest.businessDate !== businessDate
      || aiActiveRequest.language !== language
    ) return;
    const activeRequestId = aiActiveRequest.requestId;
    const activeRequestModelId = aiActiveRequest.modelId;
    if (aiQuestionJob.status === "completed") {
      const summary = getStringField(aiQuestionJob.result_payload ?? {}, "summary").trim();
      const modelLabel = aiQuestionJobModelName
        ? formatAiModelName(aiQuestionJobModelName)
        : getProductionAiModelLabel(activeRequestModelId);
      if (aiQuestionJobUsedLocalLlm && summary) {
        appendAiChatMessage({
          id: `${activeRequestId}-model-answer`,
          role: "assistant",
          content: summary,
          label: `${modelLabel || getProductionAiModelLabel(activeRequestModelId)} · ${copy.aiAnswerReady}`,
          meta: [
            `${copy.aiSource}: ${copy.aiSourceVerified}`,
            `${copy.workerModel}: ${modelLabel}`,
          ],
          includeInHistory: true,
          modelId: activeRequestModelId,
        });
      } else {
        excludeAiQuestionFromHistory(activeRequestId);
        appendAiChatMessage({
          id: `${activeRequestId}-model-error`,
          role: "assistant",
          content: aiQuestionJobModelMatchesRequest
            ? copy.aiAnswerQueuedFailedHint
            : copy.aiAnswerModelMismatchHint,
          label: `${getProductionAiModelLabel(activeRequestModelId)} · ${copy.aiAnswerFailed}`,
          tone: "warning",
          includeInHistory: false,
          modelId: activeRequestModelId,
        });
      }
      setAiQuestionJobId(null);
      setAiActiveRequest((current) => current?.requestId === activeRequestId ? null : current);
      return;
    }
    if (aiQuestionJob.status === "failed" || aiQuestionJob.status === "cancelled") {
      excludeAiQuestionFromHistory(activeRequestId);
      appendAiChatMessage({
        id: `${activeRequestId}-model-error`,
        role: "assistant",
        content: copy.aiAnswerQueuedFailedHint,
        label: `${getProductionAiModelLabel(activeRequestModelId)} · ${copy.aiAnswerFailed}`,
        tone: "warning",
        includeInHistory: false,
        modelId: activeRequestModelId,
      });
      setAiQuestionJobId(null);
      setAiActiveRequest((current) => current?.requestId === activeRequestId ? null : current);
    }
  }, [
    aiActiveRequest,
    aiQuestionJob,
    aiQuestionJobModelMatchesRequest,
    aiQuestionJobModelName,
    aiQuestionJobUsedLocalLlm,
    businessDate,
    copy,
    language,
  ]);

  useEffect(() => {
    const cleanupListeners: Array<() => void> = [];
    const listen = (target: EventTarget | null | undefined, eventName: string, listener: () => void) => {
      if (!target) return;
      target.addEventListener(eventName, listener as EventListener, { passive: true });
      cleanupListeners.push(() => target.removeEventListener(eventName, listener as EventListener));
    };
    const cleanup = () => cleanupListeners.forEach((removeListener) => removeListener());

    const configureStandaloneViewport = () => {
      const updateStandaloneViewport = () => {
        const visualViewport = window.visualViewport;
        const viewportLeft = visualViewport?.offsetLeft ?? 0;
        const viewportTop = visualViewport?.offsetTop ?? 0;
        const viewportWidth = visualViewport?.width ?? window.innerWidth;
        const viewportHeight = visualViewport?.height ?? window.innerHeight;
        const viewportBottom = viewportTop + viewportHeight;
        const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
        setAiChatVisibleViewport({
          left: viewportLeft,
          top: viewportTop,
          width: Math.max(64, viewportWidth),
          height: Math.max(64, viewportHeight),
        });
        setAiChatViewportStyle({
          "--production-ai-chat-bottom": `${Math.max(16, layoutHeight - viewportBottom + 16)}px`,
          "--production-ai-chat-visible-height": `${Math.max(64, viewportHeight)}px`,
        });
      };

      updateStandaloneViewport();
      listen(window, "resize", updateStandaloneViewport);
      listen(window.visualViewport, "resize", updateStandaloneViewport);
      listen(window.visualViewport, "scroll", updateStandaloneViewport);
    };

    if (window.parent === window) {
      configureStandaloneViewport();
      return cleanup;
    }

    try {
      const parentWindow = window.parent;
      const parentDocument = parentWindow.document;
      const frameElement = window.frameElement as HTMLElement | null;
      if (!frameElement) {
        configureStandaloneViewport();
        return cleanup;
      }

      const getTopOcclusionBottom = (
        frameRect: DOMRect,
        viewportTop: number,
        viewportBottom: number,
      ) => {
        const candidates = Array.from(parentDocument.querySelectorAll<HTMLElement>(
          "header, [role='banner'], .sticky, .fixed, [data-sticky], [style*='position']",
        ));
        const coveringRects = candidates.flatMap((element) => {
          const computedStyle = parentWindow.getComputedStyle(element);
          if (
            !["fixed", "sticky"].includes(computedStyle.position)
            || computedStyle.display === "none"
            || computedStyle.visibility === "hidden"
            || Number(computedStyle.opacity) === 0
          ) return [];
          const rect = element.getBoundingClientRect();
          if (
            rect.width <= 0
            || rect.height <= 0
            || rect.bottom <= viewportTop
            || rect.top >= viewportBottom
            || rect.right <= frameRect.left
            || rect.left >= frameRect.right
          ) return [];

          const overlapLeft = Math.max(rect.left, frameRect.left);
          const overlapRight = Math.min(rect.right, frameRect.right);
          const sampleX = Math.min(overlapRight - 1, Math.max(overlapLeft + 1, (overlapLeft + overlapRight) / 2));
          const sampleY = Math.min(rect.bottom - 1, Math.max(rect.top + 1, (rect.top + rect.bottom) / 2));
          const stack = parentDocument.elementsFromPoint(sampleX, sampleY);
          const coveringIndex = stack.findIndex((stackElement) => (
            stackElement === element || element.contains(stackElement)
          ));
          const frameIndex = stack.indexOf(frameElement);
          if (coveringIndex < 0 || (frameIndex >= 0 && coveringIndex > frameIndex)) return [];
          return [rect];
        }).sort((left, right) => left.top - right.top);

        return coveringRects.reduce((occlusionBottom, rect) => (
          rect.top <= occlusionBottom + 16
            ? Math.min(viewportBottom, Math.max(occlusionBottom, rect.bottom))
            : occlusionBottom
        ), viewportTop);
      };

      const updateEmbeddedViewport = () => {
        const frameRect = frameElement.getBoundingClientRect();
        const frameWidth = Math.max(frameRect.width, frameElement.offsetWidth, window.innerWidth);
        const frameHeight = Math.max(frameRect.height, frameElement.offsetHeight, window.innerHeight);
        const parentVisualViewport = parentWindow.visualViewport;
        const viewportLeft = parentVisualViewport?.offsetLeft ?? 0;
        const viewportTop = parentVisualViewport?.offsetTop ?? 0;
        const viewportWidth = parentVisualViewport?.width ?? parentWindow.innerWidth;
        const viewportHeight = parentVisualViewport?.height ?? parentWindow.innerHeight;
        const viewportRight = viewportLeft + viewportWidth;
        const viewportBottom = viewportTop + viewportHeight;
        const intersectionLeft = Math.max(viewportLeft, frameRect.left);
        const intersectionRight = Math.min(viewportRight, frameRect.right);
        const intersectionTop = Math.max(viewportTop, frameRect.top);
        const intersectionBottom = Math.min(viewportBottom, frameRect.bottom);
        const occlusionBottom = getTopOcclusionBottom(frameRect, viewportTop, viewportBottom);
        const effectiveTop = Math.max(intersectionTop, occlusionBottom);
        const visibleTop = Math.max(0, Math.min(frameHeight, effectiveTop - frameRect.top));
        const visibleLeft = Math.max(0, Math.min(frameWidth, intersectionLeft - frameRect.left));
        const visibleRight = Math.max(
          visibleLeft,
          Math.min(frameWidth, intersectionRight - frameRect.left),
        );
        const visibleBottom = Math.max(
          visibleTop,
          Math.min(frameHeight, intersectionBottom - frameRect.top),
        );
        const visibleWidth = Math.max(64, visibleRight - visibleLeft);
        const visibleHeight = Math.max(64, visibleBottom - visibleTop);
        setAiChatVisibleViewport({
          left: visibleLeft,
          top: visibleTop,
          width: visibleWidth,
          height: visibleHeight,
        });
        setAiChatViewportStyle({
          "--production-ai-chat-bottom": `${Math.max(16, frameHeight - visibleBottom + 16)}px`,
          "--production-ai-chat-visible-height": `${visibleHeight}px`,
        });
      };

      updateEmbeddedViewport();
      listen(parentWindow, "scroll", updateEmbeddedViewport);
      listen(parentWindow, "resize", updateEmbeddedViewport);
      listen(parentWindow.visualViewport, "resize", updateEmbeddedViewport);
      listen(parentWindow.visualViewport, "scroll", updateEmbeddedViewport);
      listen(window, "resize", updateEmbeddedViewport);
      listen(window.visualViewport, "resize", updateEmbeddedViewport);
      listen(window.visualViewport, "scroll", updateEmbeddedViewport);
    } catch {
      configureStandaloneViewport();
    }

    return cleanup;
  }, []);

  useEffect(() => {
    if (!aiChatLauncherPosition || !aiChatLauncherRef.current) return;
    const rect = aiChatLauncherRef.current.getBoundingClientRect();
    const horizontalInset = Math.min(
      0.5,
      (rect.width / 2 + AI_CHAT_LAUNCHER_MARGIN_PX) / aiChatVisibleViewport.width,
    );
    const verticalInset = Math.min(
      0.5,
      (rect.height / 2 + AI_CHAT_LAUNCHER_MARGIN_PX) / aiChatVisibleViewport.height,
    );
    const nextPosition = {
      x: Math.min(1 - horizontalInset, Math.max(horizontalInset, aiChatLauncherPosition.x)),
      y: Math.min(1 - verticalInset, Math.max(verticalInset, aiChatLauncherPosition.y)),
    };
    if (
      Math.abs(nextPosition.x - aiChatLauncherPosition.x) < 0.0001
      && Math.abs(nextPosition.y - aiChatLauncherPosition.y) < 0.0001
    ) return;
    setAiChatLauncherPosition(nextPosition);
    persistAiChatLauncherPosition(nextPosition);
  }, [
    aiChatLauncherPosition,
    aiChatVisibleViewport.height,
    aiChatVisibleViewport.width,
  ]);

  useEffect(() => {
    if (!isAiAskOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusId = window.requestAnimationFrame(() => aiQuestionInputRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsAiAskOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(aiChatDrawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusId);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      aiChatLauncherRef.current?.focus();
    };
  }, [isAiAskOpen]);

  useEffect(() => {
    if (!isAiAskOpen) return;
    aiChatBodyRef.current?.scrollTo({ top: aiChatBodyRef.current.scrollHeight, behavior: "smooth" });
  }, [aiChatMessages, aiQuestionJobStatus, isAiAskOpen]);

  useEffect(() => {
    setActivitySelection(null);
    setActivityHover(null);
    setSelectedActivityRow(null);
    setActivityConfirmationError(null);
  }, [businessDate, language]);

  function beginAiChatLauncherDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    aiChatLauncherDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCenterX: rect.left + rect.width / 2,
      startCenterY: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      moved: false,
      lastPosition: aiChatLauncherPosition,
    };
    suppressAiChatLauncherClickRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveAiChatLauncher(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = aiChatLauncherDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < AI_CHAT_LAUNCHER_DRAG_THRESHOLD_PX) return;

    drag.moved = true;
    setIsAiChatLauncherDragging(true);
    event.preventDefault();

    const horizontalInset = Math.min(
      aiChatVisibleViewport.width / 2,
      drag.width / 2 + AI_CHAT_LAUNCHER_MARGIN_PX,
    );
    const verticalInset = Math.min(
      aiChatVisibleViewport.height / 2,
      drag.height / 2 + AI_CHAT_LAUNCHER_MARGIN_PX,
    );
    const minCenterX = aiChatVisibleViewport.left + horizontalInset;
    const maxCenterX = aiChatVisibleViewport.left + aiChatVisibleViewport.width - horizontalInset;
    const minCenterY = aiChatVisibleViewport.top + verticalInset;
    const maxCenterY = aiChatVisibleViewport.top + aiChatVisibleViewport.height - verticalInset;
    const centerX = Math.min(maxCenterX, Math.max(minCenterX, drag.startCenterX + deltaX));
    const centerY = Math.min(maxCenterY, Math.max(minCenterY, drag.startCenterY + deltaY));
    const nextPosition = {
      x: clampUnitInterval((centerX - aiChatVisibleViewport.left) / aiChatVisibleViewport.width),
      y: clampUnitInterval((centerY - aiChatVisibleViewport.top) / aiChatVisibleViewport.height),
    };
    drag.lastPosition = nextPosition;
    setAiChatLauncherPosition(nextPosition);
  }

  function finishAiChatLauncherDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    suppressClick: boolean,
  ) {
    const drag = aiChatLauncherDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    aiChatLauncherDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved && drag.lastPosition) {
      persistAiChatLauncherPosition(drag.lastPosition);
      suppressAiChatLauncherClickRef.current = suppressClick;
    }
    setIsAiChatLauncherDragging(false);
  }

  function openAiChatFromLauncher() {
    if (suppressAiChatLauncherClickRef.current) {
      suppressAiChatLauncherClickRef.current = false;
      return;
    }
    setIsAiAskOpen(true);
  }

  function submitAiQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = aiQuestion.trim();
    if (
      !question
      || aiQuestionMutation.isPending
      || aiQuestionJobId !== null
      || !aiSelectedModelIsAvailable
    ) return;
    const history = aiChatMessages
      .filter((message) => (
        message.includeInHistory !== false && message.modelId === aiModelId
      ))
      .slice(-8)
      .map(({ role, content }) => ({ role, content }));
    aiQuestionMutation.mutate({
      question,
      history,
      requestId: `question-${Date.now().toString(36)}`,
      businessDate,
      language,
      modelId: aiModelId,
    });
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
  const unplannedProgressRows = realtimeProgress.rows.filter((row) => !row.hasPlan && row.shotCount > 0);
  const unplannedPreview = unplannedProgressRows
    .slice(0, 2)
    .map((row) => `${getCompactMachineLabel(row.label, language)} ${formatNumber(row.shotCount)}${copy.shotUnit}`)
    .join(" · ");
  const unplannedRemainingCount = Math.max(0, unplannedProgressRows.length - 2);
  const unplannedKpiHint = unplannedProgressRows.length
    ? `${unplannedPreview}${unplannedRemainingCount > 0 ? ` · ${copy.moreMachines} ${unplannedRemainingCount}${copy.machineUnit}` : ""}`
    : copy.noUnplannedOperation;
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
      realtimeProgress.rows,
      mesQuery.data,
    ),
    [briefContext.actualInjectionOutput, briefContext.injectionPlanQty, businessDate, mesQuery.data, realtimeProgress.rows],
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
    rect: DOMRect,
    startPct: number,
    endPct: number,
  ) {
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
    setActivityHover(null);
    if (suppressNextActivityPointerRef.current) {
      suppressNextActivityPointerRef.current = false;
      return;
    }
    const pct = getActivityPointerPercent(event);
    const targetRect = event.currentTarget.getBoundingClientRect();
    const layerPoint = getActivitySelectionLayerPoint(origin, targetRect, pct, pct);
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

  function updateActivityCycleTimeHover(
    event: ReactPointerEvent<HTMLElement>,
    row: MachineActivityRow,
  ) {
    if (activitySelection) return;
    const pct = getActivityPointerPercent(event);
    const businessStart = getBusinessDayStart(businessDate);
    const businessEnd = getBusinessDayEnd(businessDate);
    const businessDurationMs = businessEnd.getTime() - businessStart.getTime();
    const endTime = new Date(businessStart.getTime() + businessDurationMs * (pct / 100));
    const startTime = new Date(Math.max(
      businessStart.getTime(),
      endTime.getTime() - MACHINE_ACTIVITY_CT_COMPARISON_WINDOW_MINUTES * 60 * 1000,
    ));
    const summary = summarizeActivityCycleTime(row.slots, startTime, endTime);
    const tooltipHalfWidth = 132;
    const margin = 12;

    setActivityHover({
      machineNumber: row.machineNumber,
      machineLabel: row.label,
      pct,
      layerX: Math.max(tooltipHalfWidth + margin, Math.min(window.innerWidth - tooltipHalfWidth - margin, event.clientX)),
      layerY: Math.max(96, event.clientY - 12),
      startLabel: formatTimeLabel(startTime),
      endLabel: formatTimeLabel(endTime),
      shots: summary.shots,
      averageCycleTimeSec: summary.averageCycleTimeSec,
    });
  }

  function moveActivitySelection(
    origin: MachineActivitySelection["origin"],
    event: ReactPointerEvent<HTMLElement>,
    machineNumber?: number,
  ) {
    const pct = getActivityPointerPercent(event);
    const targetRect = event.currentTarget.getBoundingClientRect();
    setActivitySelection((current) => {
      if (!current?.isDragging || current.origin !== origin || current.machineNumber !== machineNumber) return current;
      return { ...current, endPct: pct, ...getActivitySelectionLayerPoint(origin, targetRect, current.startPct, pct) };
    });
  }

  function endActivitySelection(
    origin: MachineActivitySelection["origin"],
    event: ReactPointerEvent<HTMLElement>,
    machineNumber?: number,
  ) {
    const pct = getActivityPointerPercent(event);
    const targetRect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setActivitySelection((current) => {
      if (!current || current.origin !== origin || current.machineNumber !== machineNumber) return current;
      const nextEndPct = Math.abs(current.startPct - pct) < 0.35 ? Math.min(100, current.startPct + 2) : pct;
      return {
        ...current,
        endPct: nextEndPct,
        isDragging: false,
        ...getActivitySelectionLayerPoint(origin, targetRect, current.startPct, nextEndPct),
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

  function getActivityTypeLabel(activityType: InjectionActivityType) {
    return activityTypeOptions.find((option) => option.value === activityType)?.label ?? activityType;
  }

  function getActivityConfirmationSummary(confirmation: InjectionActivityConfirmation) {
    const confirmedAt = new Date(confirmation.confirmed_at);
    const details = [
      confirmation.part_no,
      confirmation.model_name,
      confirmation.note,
      confirmation.confirmed_by_name
        ? `${copy.activityConfirmedBy} ${confirmation.confirmed_by_name}${Number.isNaN(confirmedAt.getTime()) ? "" : ` ${formatTimeLabel(confirmedAt)}`}`
        : "",
    ].filter(Boolean);
    return details.join(" · ") || copy.activityConfirmed;
  }

  function openActivityConfirmation(row: RealtimeProgressRow) {
    const confirmation = activityConfirmationByMachine.get(row.key);
    setSelectedActivityRow(row);
    setActivityConfirmationForm(confirmation ? {
      ...EMPTY_INJECTION_ACTIVITY_CONFIRMATION_FORM,
      activityType: confirmation.activity_type,
      partNo: confirmation.part_no,
      modelName: confirmation.model_name,
      note: confirmation.note,
    } : {
      ...EMPTY_INJECTION_ACTIVITY_CONFIRMATION_FORM,
      activityType: row.equipmentState === "unplanned_running" ? "production" : "",
    });
    setActivityConfirmationError(null);
  }

  function closeActivityConfirmation() {
    if (
      saveActivityConfirmationMutation.isPending ||
      createQuickPlanMutation.isPending ||
      resetActivityConfirmationMutation.isPending
    ) return;
    setSelectedActivityRow(null);
    setActivityConfirmationError(null);
  }

  function handleActivityConfirmationSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedActivityRow) return;
    const activityType = activityConfirmationForm.activityType;
    const partNo = activityConfirmationForm.partNo.trim();
    const modelName = activityConfirmationForm.modelName.trim();
    const note = activityConfirmationForm.note.trim();
    if (selectedActivityIsQuickPlan) {
      if (!partNo || !modelName || !activityConfirmationForm.plannedQuantity.trim()) {
        setActivityConfirmationError(copy.quickPlanRequired);
        return;
      }
      if (!Number.isFinite(Number(activityConfirmationForm.plannedQuantity)) || Number(activityConfirmationForm.plannedQuantity) <= 0) {
        setActivityConfirmationError(copy.quickPlanQuantityRequired);
        return;
      }
      if (!Number.isFinite(Number(activityConfirmationForm.cavity)) || Number(activityConfirmationForm.cavity) < 1) {
        setActivityConfirmationError(copy.quickPlanCavityRequired);
        return;
      }

      setActivityConfirmationError(null);
      createQuickPlanMutation.mutate();
      return;
    }
    if (!activityType) {
      setActivityConfirmationError(copy.activityTypePlaceholder);
      return;
    }
    if (activityType === "production" && !partNo) {
      setActivityConfirmationError(copy.activityPartRequired);
      return;
    }
    if (activityType === "other" && !note) {
      setActivityConfirmationError(copy.activityOtherNoteRequired);
      return;
    }

    setActivityConfirmationError(null);
    saveActivityConfirmationMutation.mutate({
      business_date: businessDate,
      machine_key: selectedActivityRow.key,
      machine_label: selectedActivityRow.label,
      activity_type: activityType,
      part_no: partNo,
      model_name: modelName,
      shot_count: selectedActivityRow.shotCount,
      last_shot_at: selectedActivityRow.lastShotAt,
      note,
    });
  }

  function handleActivityConfirmationReset() {
    if (!selectedActivityRow) return;
    resetActivityConfirmationMutation.mutate({
      targetDate: businessDate,
      machineKey: selectedActivityRow.key,
    });
  }

  function renderProgressRow(row: RealtimeProgressRow) {
    const progress = Math.max(0, Math.min(100, row.progressRate));
    const progressText = getProgressText(row.progressRate);
    const currentSegment = row.segments.find((segment) => segment.status === "in_progress");
    const displaySegments = getDisplaySegments(row.segments);
    const displayLabel = getLocalizedMachineLabel(row.label, language);
    const isReviewRow = !row.hasPlan;
    const activityConfirmation = isReviewRow ? activityConfirmationByMachine.get(row.key) : undefined;
    const statusLabel = activityConfirmation
      ? copy.activityConfirmed
      : row.equipmentState === "running"
      ? copy.running
      : row.equipmentState === "paused"
        ? copy.paused
        : row.equipmentState === "unplanned_running"
          ? copy.unplannedRunning
          : row.equipmentState === "activity_review"
            ? copy.activityReview
            : "-";
    const statusClass = [
      "production-progress-status",
      row.equipmentState === "running" ? "production-progress-status--running" : "",
      row.equipmentState === "paused" ? "production-progress-status--paused" : "",
      isReviewRow && !activityConfirmation ? "production-progress-status--review" : "",
      activityConfirmation ? "production-progress-status--confirmed" : "",
    ].filter(Boolean).join(" ");
    const reviewIsRunning = row.equipmentState === "unplanned_running";
    const reviewTitle = activityConfirmation
      ? `${copy.activityConfirmed} · ${getActivityTypeLabel(activityConfirmation.activity_type)}`
      : reviewIsRunning ? copy.productConfirmationTitle : copy.activityConfirmationTitle;
    const reviewBody = activityConfirmation
      ? getActivityConfirmationSummary(activityConfirmation)
      : reviewIsRunning ? copy.productConfirmationBody : copy.activityConfirmationBody;

    return (
      <article className={`production-progress-row${row.equipmentState === "paused" ? " production-progress-row--paused" : ""}${isReviewRow && !activityConfirmation ? " production-progress-row--review" : ""}${activityConfirmation ? " production-progress-row--confirmed" : ""}`} key={row.key}>
        <div className="production-progress-row__head">
          <div className="production-progress-row__identity">
            <div className="production-progress-row__title">
              <strong>{displayLabel}</strong>
              {row.hasPlan ? (
                <button
                  aria-label={`${displayLabel} ${copy.detail}`}
                  className="production-progress-detail-button"
                  onClick={() => setSelectedProgressRow(row)}
                  type="button"
                >
                  {copy.detail}
                </button>
              ) : null}
            </div>
            <span>
              {isReviewRow
                ? `${copy.noPlan} · ${copy.shotCount} ${formatNumber(row.shotCount)}`
                : currentSegment
                  ? `${copy.currentPart} ${currentSegment.partNo}`
                  : copy.partProgress}
            </span>
            {row.equipmentState === "paused" ? (
              <small className="production-progress-row__diagnostic">
                {copy.noClampDuration} {formatNumber(Math.max(0, Math.round(row.idleMinutes ?? 0)))}m
                {row.expectedCycleTimeSec !== null ? ` · ${copy.baselineCycleTime} ${row.expectedCycleTimeSec.toFixed(1)}s` : ""}
              </small>
            ) : null}
          </div>
          <div className="production-progress-row__state">
            <span>{isReviewRow ? `${copy.shotCount} ${formatNumber(row.shotCount)}` : progressText}</span>
            <em className={statusClass}>{statusLabel}</em>
          </div>
        </div>
        {isReviewRow ? (
          <div className={`production-progress-review-callout${activityConfirmation ? " production-progress-review-callout--confirmed" : ""}`}>
            <div>
              <strong>{reviewTitle}</strong>
              <span>{reviewBody}</span>
            </div>
            <button className="production-progress-review-action" onClick={() => openActivityConfirmation(row)} type="button">
              {activityConfirmation ? copy.activityEdit : reviewIsRunning ? copy.productInputAction : copy.activityCheckAction}
            </button>
          </div>
        ) : (
          <>
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
          </>
        )}
      </article>
    );
  }

  function renderMachiningPreviewRow(row: MachiningProgressPreview["rows"][number]) {
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

  function renderUnplannedKpiDetail() {
    return (
      <section className="panel production-kpi-detail production-kpi-detail--unplanned">
        <div className="production-kpi-detail__header">
          <div>
            <p className="panel-card__eyebrow">MES ACTIVITY</p>
            <h3 className="panel__title">{detailCopy.unplannedTitle}</h3>
          </div>
          <div className="production-unplanned-detail__summary">
            <strong>{formatNumber(briefContext.unplannedInjectionShots)}{copy.shotUnit}</strong>
            <span>{briefContext.unplannedInjectionMachineCount}{copy.machineUnit}</span>
          </div>
        </div>
        <p className="production-unplanned-detail__description">{detailCopy.unplannedDescription}</p>
        {unplannedProgressRows.length ? (
          <div className="production-kpi-rank__grid">
            {unplannedProgressRows.map((row) => {
              const displayLabel = getLocalizedMachineLabel(row.label, language);
              return (
                <article className="production-kpi-rank__card production-kpi-rank__card--unplanned" key={row.key}>
                  <div className="production-kpi-rank__card-head">
                    <strong>{displayLabel}</strong>
                    <span>{detailCopy.unplannedBadge}</span>
                  </div>
                  <div className="production-kpi-rank__card-meta">
                    <em>{detailCopy.outsidePlanMes}</em>
                    <span>{detailCopy.confirmationNeeded}</span>
                  </div>
                  <div className="production-kpi-rank__unplanned-total">
                    <span>{copy.shotCount}</span>
                    <strong>{formatNumber(row.shotCount)}{copy.shotUnit}</strong>
                  </div>
                  <p>{detailCopy.unplannedShotSummary} · {formatNumber(row.shotCount)}{copy.shotUnit}</p>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="notice notice--neutral">{copy.noUnplannedOperation}</div>
        )}
      </section>
    );
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
                <span>{options.detailKey === "injection" ? detailCopy.plannedActualPlan : detailCopy.compactSummary}</span>
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
                  onPointerMove={(event) => {
                    updateActivityCycleTimeHover(event, row);
                    moveActivitySelection("timeline", event, row.machineNumber);
                  }}
                  onPointerUp={(event) => endActivitySelection("timeline", event, row.machineNumber)}
                  onPointerCancel={(event) => endActivitySelection("timeline", event, row.machineNumber)}
                  onPointerLeave={() => {
                    if (!activitySelection?.isDragging) setActivityHover(null);
                  }}
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
                  {activityHover?.machineNumber === row.machineNumber && !activitySelection ? (
                    <span
                      aria-hidden="true"
                      className="production-machine-activity__ct-cursor"
                      style={{ left: `${activityHover.pct}%` }}
                    />
                  ) : null}
                  {renderActivitySelectionOverlays("timeline", row.machineNumber)}
                </div>
              </article>
            );
          })}
        </div>
        {activityHover && !activitySelection ? (
          <div
            className="production-machine-activity__ct-tooltip"
            role="tooltip"
            style={{ left: activityHover.layerX, top: activityHover.layerY }}
          >
            <span>{getLocalizedMachineLabel(activityHover.machineLabel, language)} · {activityHover.startLabel} ~ {activityHover.endLabel}</span>
            <strong>
              {activityHover.averageCycleTimeSec === null
                ? activityCopy.noCycleTime
                : `${activityCopy.rollingCycleTime} ${activityHover.averageCycleTimeSec.toFixed(1)}${activityCopy.cycleTimeSeconds}`}
            </strong>
            <small>{detailCopy.clampCount} {formatNumber(Math.round(activityHover.shots))}</small>
          </div>
        ) : null}
      </section>
    );
  }

  const aiChatLauncherStyle: ProductionAiChatViewportStyle = {
    ...aiChatViewportStyle,
    ...(aiChatLauncherPosition ? {
      left: aiChatVisibleViewport.left + aiChatVisibleViewport.width * aiChatLauncherPosition.x,
      top: aiChatVisibleViewport.top + aiChatVisibleViewport.height * aiChatLauncherPosition.y,
      right: "auto",
      bottom: "auto",
      transform: "translate(-50%, -50%)",
    } : {}),
  };

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
              hint={`${copy.planned} ${briefContext.plannedInjectionMachineCount}${copy.machineUnit} ${copy.completedRate} ${injectionCompletionRate.toFixed(1)}%`}
              hintTone={injectionRateTone}
              isActive={activeKpiDetail === "injection"}
              onClick={() => toggleKpiDetail("injection")}
              title={copy.injectionActualPlan}
              value={`${formatNumber(briefContext.actualInjectionOutput)} / ${formatNumber(briefContext.injectionPlanQty)}`}
            />
            <StatCard
              hint={unplannedKpiHint}
              hintTone={briefContext.unplannedInjectionShots > 0 ? "negative" : "neutral"}
              isActive={activeKpiDetail === "unplanned"}
              onClick={() => toggleKpiDetail("unplanned")}
              title={copy.unplannedShotSummary}
              value={`${formatNumber(briefContext.unplannedInjectionShots)}${copy.shotUnit} / ${briefContext.unplannedInjectionMachineCount}${copy.machineUnit}`}
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
            rows: realtimeProgress.rows.filter((row) => row.hasPlan).map((row) => ({
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

          {activeKpiDetail === "unplanned" ? renderUnplannedKpiDetail() : null}

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
              <fieldset className="production-ai-model-selector production-brief-model-selector">
                <legend>{copy.briefModelSelect}</legend>
                <div className="production-ai-model-selector__options">
                  {PRODUCTION_AI_MODEL_OPTIONS.map((option) => (
                    <button
                      aria-pressed={briefingModelId === option.id}
                      className={briefingModelId === option.id ? "is-active" : ""}
                      key={option.id}
                      onClick={() => setBriefingModelId(option.id)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p>{copy.briefModelCompareHint}</p>
              </fieldset>
            </div>

            <div className="production-ai-worker-status">
              <div className="production-ai-worker-status__states" role="status">
                <span className={`production-ai-worker-status__pill production-ai-worker-status__pill--${aiWorkerState}`}>
                  {aiWorkerStateLabel}
                </span>
                <span className={`production-ai-worker-status__pill production-ai-worker-status__pill--llm-${briefingModelIsAvailable ? "ready" : "unavailable"}`}>
                  {briefingModelStatusLabel}
                </span>
              </div>
            </div>

            <div className="production-brief-panel__body">
              {latestAiJobQuery.isLoading ? (
                <p>{copy.briefLoading}</p>
              ) : !briefingModelIsAvailable ? (
                <div className="notice notice--warning">{copy.aiSelectedModelUnavailable}</div>
              ) : !latestAiJob ? (
                <p>{copy.briefPending}</p>
              ) : !latestAiJobUsedLocalLlm ? (
                <div className="notice notice--warning">{copy.briefFailed}</div>
              ) : (
                <div className="production-ai-job production-ai-job--completed">
                <div className="production-ai-job__header">
                  <div>
                    <strong>{copy.workerJobTitle}</strong>
                    <span>
                      {formatAiTimestamp(latestAiJob.completed_at, language)}
                      {latestAiJob.model_name ? ` · ${formatAiModelName(latestAiJob.model_name)}` : ""}
                    </span>
                  </div>
                </div>

                <div className="production-ai-job__result">
                  <strong>{copy.workerJobResult}</strong>
                  {latestAiJobSummary.split("\n\n").map((paragraph, index) => (
                    <p key={`${paragraph.slice(0, 24)}-${index}`}>{paragraph}</p>
                  ))}
                </div>
              </div>
              )}
            </div>
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
                      {realtimeProgress.pausedCount > 0 ? (
                        <span className="production-progress-chip production-progress-chip--paused">{copy.pausedCount} {realtimeProgress.pausedCount}</span>
                      ) : null}
                      {unresolvedActivityReviewCount > 0 ? (
                        <span className="production-progress-chip production-progress-chip--review">{copy.reviewCount} {unresolvedActivityReviewCount}</span>
                      ) : null}
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
            confirmationState={downtimeConfirmationsQuery.isError ? "error" : downtimeConfirmationsQuery.isPending ? "loading" : "ready"}
            confirmations={downtimeConfirmationsQuery.data?.confirmations}
            copy={copy}
            language={language}
            mode="dashboard"
          />

          <div className="production-dashboard__board-launcher">
            <span>{copy.openInjectionBoardHint}</span>
            <button
              className="button button--ghost"
              onClick={() => {
                const boardUrl = new URL("/production/injection-board", window.location.origin);
                window.open(boardUrl.toString(), "wj-injection-board", "popup=yes,width=1920,height=1080");
              }}
              type="button"
            >
              {copy.openInjectionBoard}
            </button>
          </div>

          {selectedActivityRow ? createPortal(
            <div
              className="modal-backdrop production-activity-modal-backdrop"
              role="presentation"
              style={activityModalViewportStyle}
              onClick={closeActivityConfirmation}
            >
              <section
                className={`modal-card production-activity-confirmation-modal${selectedActivityIsQuickPlan ? " production-quick-plan-modal" : ""}`}
                aria-labelledby="production-activity-confirmation-title"
                aria-modal="true"
                role="dialog"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="modal-card__header">
                  <div>
                    <p className="panel-card__eyebrow">{selectedActivityIsQuickPlan ? copy.quickPlanEyebrow : "ACTIVITY REVIEW"}</p>
                    <h3 className="panel__title" id="production-activity-confirmation-title">
                      {selectedActivityIsQuickPlan ? copy.quickPlanModalTitle : copy.activityConfirmModalTitle}
                    </h3>
                    <p>{selectedActivityIsQuickPlan ? copy.quickPlanModalBody : copy.activityConfirmModalBody}</p>
                  </div>
                  <button className="button button--ghost" onClick={closeActivityConfirmation} type="button">
                    {copy.close}
                  </button>
                </div>

                <div className={`production-activity-confirmation-context${selectedActivityIsQuickPlan ? " production-activity-confirmation-context--quick" : ""}`}>
                  <div>
                    <span>{copy.injectionFacilities}</span>
                    <strong>{getLocalizedMachineLabel(selectedActivityRow.label, language)}</strong>
                  </div>
                  {selectedActivityIsQuickPlan ? (
                    <div>
                      <span>{copy.quickPlanDate}</span>
                      <strong>{businessDate}</strong>
                    </div>
                  ) : null}
                  <div>
                    <span>{copy.shotCount}</span>
                    <strong>{formatNumber(selectedActivityRow.shotCount)}</strong>
                  </div>
                  <div>
                    <span>{copy.lastClamp}</span>
                    <strong>{formatOptionalTimeLabel(selectedActivityRow.lastShotAt)}</strong>
                  </div>
                </div>

                <form onSubmit={handleActivityConfirmationSubmit}>
                  {!selectedActivityIsQuickPlan ? (
                    <label className="field-group">
                      <span>{copy.activityType}</span>
                      <select
                        aria-label={copy.activityType}
                        onChange={(event) => {
                          setActivityConfirmationForm((current) => ({
                            ...current,
                            activityType: event.target.value as InjectionActivityType | "",
                          }));
                          setActivityConfirmationError(null);
                        }}
                        required
                        value={activityConfirmationForm.activityType}
                      >
                        <option disabled value="">{copy.activityTypePlaceholder}</option>
                        {activityTypeOptions.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  <div className="production-activity-confirmation-fields">
                    <label className="field-group">
                      <span>{copy.partNoLabel}{selectedActivityIsQuickPlan || activityConfirmationForm.activityType === "production" ? " *" : ""}</span>
                      <input
                        autoComplete="off"
                        onChange={(event) => {
                          setActivityConfirmationForm((current) => ({ ...current, partNo: event.target.value }));
                          setActivityConfirmationError(null);
                        }}
                        required={selectedActivityIsQuickPlan || activityConfirmationForm.activityType === "production"}
                        value={activityConfirmationForm.partNo}
                      />
                    </label>
                    <label className="field-group">
                      <span>{copy.modelNameLabel}{selectedActivityIsQuickPlan ? " *" : ""}</span>
                      <input
                        autoComplete="off"
                        onChange={(event) => {
                          setActivityConfirmationForm((current) => ({ ...current, modelName: event.target.value }));
                          setActivityConfirmationError(null);
                        }}
                        required={selectedActivityIsQuickPlan}
                        value={activityConfirmationForm.modelName}
                      />
                    </label>
                  </div>

                  {selectedActivityIsQuickPlan ? (
                    <>
                      <div className="production-activity-confirmation-fields">
                        <label className="field-group">
                          <span>{copy.plannedQuantityLabel} *</span>
                          <input
                            inputMode="numeric"
                            min="1"
                            onChange={(event) => {
                              setActivityConfirmationForm((current) => ({ ...current, plannedQuantity: event.target.value }));
                              setActivityConfirmationError(null);
                            }}
                            placeholder={copy.plannedQuantityPlaceholder}
                            required
                            step="1"
                            type="number"
                            value={activityConfirmationForm.plannedQuantity}
                          />
                        </label>
                        <label className="field-group">
                          <span>{copy.lotNoLabel}</span>
                          <input
                            autoComplete="off"
                            onChange={(event) => setActivityConfirmationForm((current) => ({ ...current, lotNo: event.target.value }))}
                            value={activityConfirmationForm.lotNo}
                          />
                        </label>
                      </div>

                      <label className="field-group production-quick-plan-cavity-field">
                        <span>{copy.cavityCountLabel} *</span>
                        <div className="production-quick-plan-cavity-input">
                          <strong>1 ×</strong>
                          <input
                            aria-describedby="production-quick-plan-cavity-hint"
                            inputMode="numeric"
                            min="1"
                            onChange={(event) => {
                              setActivityConfirmationForm((current) => ({ ...current, cavity: event.target.value }));
                              setActivityConfirmationError(null);
                            }}
                            required
                            step="1"
                            type="number"
                            value={activityConfirmationForm.cavity}
                          />
                        </div>
                        <small id="production-quick-plan-cavity-hint">{copy.cavityCountHint}</small>
                      </label>
                    </>
                  ) : null}

                  <label className="field-group">
                    <span>{selectedActivityIsQuickPlan ? copy.planNoteLabel : copy.note}{activityConfirmationForm.activityType === "other" ? " *" : ""}</span>
                    <textarea
                      onChange={(event) => {
                        setActivityConfirmationForm((current) => ({ ...current, note: event.target.value }));
                        setActivityConfirmationError(null);
                      }}
                      placeholder={copy.activityNotePlaceholder}
                      required={activityConfirmationForm.activityType === "other"}
                      value={activityConfirmationForm.note}
                    />
                  </label>

                  {activityConfirmationError ? (
                    <div className="notice notice--warning">{activityConfirmationError}</div>
                  ) : null}

                  <div className="production-activity-confirmation-actions">
                    <div>
                      {selectedActivityConfirmation && !selectedActivityIsQuickPlan ? (
                        <button
                          className="button button--ghost"
                          disabled={saveActivityConfirmationMutation.isPending || createQuickPlanMutation.isPending || resetActivityConfirmationMutation.isPending}
                          onClick={handleActivityConfirmationReset}
                          type="button"
                        >
                          {resetActivityConfirmationMutation.isPending ? copy.activityResetting : copy.activityReset}
                        </button>
                      ) : null}
                    </div>
                    <div>
                      <button className="button button--ghost" onClick={closeActivityConfirmation} type="button">
                        {copy.close}
                      </button>
                      <button
                        className="button button--primary"
                        disabled={saveActivityConfirmationMutation.isPending || createQuickPlanMutation.isPending || resetActivityConfirmationMutation.isPending}
                        type="submit"
                      >
                        {selectedActivityIsQuickPlan
                          ? createQuickPlanMutation.isPending ? copy.quickPlanSaving : copy.quickPlanSave
                          : saveActivityConfirmationMutation.isPending ? copy.activitySaving : copy.activitySave}
                      </button>
                    </div>
                  </div>
                </form>
              </section>
            </div>
          , document.body) : null}

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

      <button
        aria-label={`${copy.askAi}. ${copy.aiLauncherDragHint}`}
        aria-expanded={isAiAskOpen}
        aria-haspopup="dialog"
        className={`production-ai-chat-launcher production-ai-chat-launcher--${aiWorkerState === "online" && aiWorkerStatus?.llm_ready === true ? "ready" : aiWorkerState === "offline" || aiWorkerStatus?.llm_ready === false ? "warning" : "unknown"}${isAiChatLauncherDragging ? " is-dragging" : ""}`}
        onClick={openAiChatFromLauncher}
        onLostPointerCapture={(event) => finishAiChatLauncherDrag(event, false)}
        onPointerCancel={(event) => finishAiChatLauncherDrag(event, false)}
        onPointerDown={beginAiChatLauncherDrag}
        onPointerMove={moveAiChatLauncher}
        onPointerUp={(event) => finishAiChatLauncherDrag(event, true)}
        ref={aiChatLauncherRef}
        style={aiChatLauncherStyle}
        title={copy.aiLauncherDragHint}
        type="button"
      >
        <span aria-hidden="true" />
        <MessageCircle aria-hidden="true" size={18} strokeWidth={2.2} />
        {copy.askAi}
        <GripVertical aria-hidden="true" className="production-ai-chat-launcher__grip" size={14} strokeWidth={2.2} />
      </button>

      {isAiAskOpen ? createPortal(
        <div className="production-ai-chat-layer" style={aiChatViewportStyle}>
          <button
            aria-label={copy.closeAi}
            className="production-ai-chat-overlay"
            onClick={() => setIsAiAskOpen(false)}
            tabIndex={-1}
            type="button"
          />
          <section
            aria-label={copy.aiAssistantTitle}
            aria-modal="true"
            className="production-ai-chat-drawer"
            ref={aiChatDrawerRef}
            role="dialog"
          >
            <header className="production-ai-chat-drawer__header">
              <div>
                <p className="panel-card__eyebrow">AI ASSISTANT</p>
                <h3>{copy.aiAssistantTitle}</h3>
                <div className="production-ai-chat-drawer__states" role="status">
                  <span className={`production-ai-worker-status__pill production-ai-worker-status__pill--${aiWorkerState}`}>
                    {aiWorkerStateLabel}
                  </span>
                  <span className={`production-ai-worker-status__pill production-ai-worker-status__pill--llm-${activeAiModelIsAvailable ? "ready" : "unavailable"}`}>
                    {activeAiModelStatusLabel}
                  </span>
                </div>
              </div>
              <button
                aria-label={copy.closeAi}
                className="button button--ghost production-ai-chat-drawer__close"
                onClick={() => setIsAiAskOpen(false)}
                type="button"
              >
                <X aria-hidden="true" size={20} strokeWidth={2.2} />
              </button>
            </header>

            <div className="production-ai-chat-drawer__body" ref={aiChatBodyRef}>
              <p className="production-ai-chat-drawer__intro">{copy.aiAssistantIntro}</p>
              {visibleAiChatMessages.map((message) => (
                <article
                  className={`production-ai-chat-message production-ai-chat-message--${message.role}${message.tone === "warning" ? " production-ai-chat-message--warning" : ""}`}
                  key={message.id}
                >
                  <div className="production-ai-chat-message__header">
                    <strong>{message.label || (message.role === "user"
                      ? `${copy.aiAssistantUser} · ${getProductionAiModelLabel(message.modelId ?? activeAiModelId)}`
                      : copy.aiAssistantAi)}</strong>
                  </div>
                  {message.content.split("\n\n").map((paragraph, index) => (
                    <p key={`${message.id}-${index}`}>{paragraph}</p>
                  ))}
                  {message.notice ? <div className="notice notice--warning">{message.notice}</div> : null}
                  {message.meta?.length ? (
                    <div className="production-ai-chat-message__meta">
                      {message.meta.map((item) => <span key={item}>{item}</span>)}
                    </div>
                  ) : null}
                </article>
              ))}

              {aiQuestionIsGenerating ? (
                <article className="production-ai-chat-message production-ai-chat-message--assistant production-ai-chat-message--pending">
                  <div className="production-ai-chat-message__header">
                    <strong>{activeAiModelLabel} · {copy.aiAnswerTitle}</strong>
                    <span aria-live="polite" role="status">
                      {aiQuestionMutation.isPending ? copy.aiAnswerQueued : aiQuestionJobStatusLabel}
                    </span>
                  </div>
                  <p className="production-ai-chat-message__typing">
                    <span>{copy.aiAnswerQueuedHint}</span>
                    <span aria-hidden="true" className="production-ai-chat-typing-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                  </p>
                </article>
              ) : null}
            </div>

            <form className="production-ai-chat-drawer__footer" onSubmit={submitAiQuestion}>
              <fieldset className="production-ai-model-selector" disabled={aiQuestionIsGenerating}>
                <legend>{copy.aiModelSelect}</legend>
                <div className="production-ai-model-selector__options">
                  {PRODUCTION_AI_MODEL_OPTIONS.map((option) => (
                    <button
                      aria-pressed={aiModelId === option.id}
                      className={aiModelId === option.id ? "is-active" : ""}
                      key={option.id}
                      onClick={() => setAiModelId(option.id)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p>{aiSelectedModelIsAvailable ? copy.aiModelCompareHint : copy.aiSelectedModelUnavailable}</p>
              </fieldset>
              <label className="production-ai-chat__visually-hidden" htmlFor="production-ai-chat-question">
                {copy.aiInputLabel}
              </label>
              <textarea
                id="production-ai-chat-question"
                onChange={(event) => setAiQuestion(event.target.value)}
                placeholder={copy.aiQuestionPlaceholder}
                ref={aiQuestionInputRef}
                rows={3}
                value={aiQuestion}
              />
              <div>
                <span>{copy.aiQuestionScope}</span>
                <button
                  className="button button--primary"
                  disabled={!aiQuestion.trim() || aiQuestionMutation.isPending || aiQuestionJobId !== null || !aiSelectedModelIsAvailable}
                  type="submit"
                >
                  {aiQuestionMutation.isPending ? copy.askingAi : copy.aiSubmit}
                </button>
              </div>
            </form>
          </section>
        </div>
      , document.body) : null}
    </section>
  );
}
