import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  Factory,
  FileText,
  FolderOpen,
  Delete,
  LogOut,
  Loader2,
  Radio,
  RotateCcw,
  ShieldAlert,
  Triangle,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import {
  getFieldKanban,
  submitFieldDefects,
  type FieldDefectCheckpoint,
  type FieldDocument,
  type FieldKanbanResponse,
} from "@/domains/field/api";
import { getInjectionProductionMatrix } from "@/domains/mes/api";
import {
  getFieldInjectionDowntimeConfirmations,
  getProductionPlanSummary,
  saveFieldInjectionDowntimeConfirmation,
  type SaveInjectionDowntimeConfirmationPayload,
} from "@/domains/production/api";
import {
  buildInjectionTransitionAnalysis,
  type InjectionTransitionEvent,
} from "@/domains/production/injection-transition-analysis";
import { type FieldStation } from "@/lib/fieldTerminal";
import { useModalFocusTrap } from "@/shared/hooks/useModalFocusTrap";
import { useShanghaiBusinessDate } from "@/shared/hooks/useShanghaiBusinessDate";

import "./InjectionKanban.css";

type FieldLanguage = "zh" | "ko";
type CanvasMode = "work_instruction" | "drawing" | "quality";

const WORK_INSTRUCTION_DISPLAY_MS = 60_000;
const QUALITY_PHOTO_DISPLAY_MS = 10_000;
const QUALITY_PHOTO_LOAD_TIMEOUT_MS = 20_000;
const DOCUMENT_ZOOM_MIN = 1;
const DOCUMENT_ZOOM_MAX = 2.25;
const DOCUMENT_ZOOM_STEP = 0.25;
const DOCUMENT_HIGH_DETAIL_THRESHOLD = 1.5;
const DRAWING_PREVIEW_LONG_EDGE_PX = 3000;

type DefectRequest = {
  eventKey: string;
  trigger: string;
  blocking: boolean;
  source: "transition" | "shift" | "manual";
  businessDate: string;
  machineNumber: number;
  planId: number | null;
  partNo: string;
  modelName: string;
  sequence: number | null;
  dueAt?: string | null;
};

const DEFECT_TYPES = [
  { code: "scratch", zh: "划伤", ko: "스크래치" },
  { code: "black_dot", zh: "黑点", ko: "흑점" },
  { code: "eaten_meat", zh: "吃肉", ko: "파먹음" },
  { code: "air_mark", zh: "气印", ko: "가스 마크" },
  { code: "deform", zh: "变形", ko: "변형" },
  { code: "short_shot", zh: "缺胶", ko: "미성형" },
  { code: "broken_pillar", zh: "断柱子", ko: "기둥 파손" },
  { code: "flow_mark", zh: "流痕", ko: "플로우 마크" },
  { code: "sink_mark", zh: "缩水", ko: "수축" },
  { code: "whitening", zh: "发白", ko: "백화" },
  { code: "other", zh: "其他", ko: "기타" },
] as const;

const defectErrorCopy = {
  zh: {
    defect_exceeds_gross_quantity: "输入的不良数超过服务器计算的本区间生产数，请减少数量后重试。",
    production_plan_identity_mismatch: "生产计划已更新，请关闭窗口并重新读取后再录入。",
    production_plan_missing: "当前没有可用于录入不良的生产计划。",
    shift_checkpoint_not_due: "尚未到交接录入时间。",
    permission_denied: "当前账号没有不良录入权限，请联系管理员。",
    timeout: "保存处理超时。请用同一窗口再次提交，系统不会重复登记。",
  },
  ko: {
    defect_exceeds_gross_quantity: "입력한 불량수가 서버에서 계산한 이번 구간 생산수보다 큽니다. 수량을 줄여 다시 시도해 주세요.",
    production_plan_identity_mismatch: "생산계획이 변경되었습니다. 창을 닫고 새로 불러온 뒤 다시 입력해 주세요.",
    production_plan_missing: "현재 불량 입력에 연결할 생산계획이 없습니다.",
    shift_checkpoint_not_due: "아직 교대 불량 입력 시간이 아닙니다.",
    permission_denied: "현재 계정에는 불량 입력 권한이 없습니다. 관리자에게 문의해 주세요.",
    timeout: "저장 처리가 지연되었습니다. 같은 창에서 다시 제출해도 중복 등록되지 않습니다.",
  },
} as const;

const copy = {
  zh: {
    brandSubtitle: "万佳数据平台",
    injection: "注塑",
    online: "在线",
    offline: "数据延迟",
    secondsAgo: "秒前",
    noSignal: "暂无数据",
    shiftShots: "本班合模数",
    dayShiftWindow: "08:00–20:00",
    nightShiftWindow: "20:00–次日 08:00",
    model: "型号",
    partNo: "品号",
    currentPlanShots: "当前作业推定合模数",
    theoretical: "理论产出（当前作业）",
    progress: "计划完成进度",
    pieces: "件",
    shots: "模次",
    records: "条",
    workQueue: "作业队列",
    currentJob: "当前作业",
    nextJob: "下一作业",
    queueOutput: "生产 / 计划",
    plannedChange: "预计换型时间",
    noNext: "暂无下一作业",
    confirmChange: "确认换型",
    inputDefect: "输入不良",
    workInstruction: "作业指导书",
    drawing: "图纸",
    qualityHistory: "品质",
    noPlan: "本机当前没有生产计划",
    noPlanHint: "计划下发后，这里会自动显示对应型号、品号和现场资料。",
    noDocument: "尚未补充对应资料",
    noDocumentHint: "请在“开发 > 现场看板资料管理”上传 PPT/PPTX 或 PDF。",
    sourceOnly: "原始文件已上传，仍需补充 PDF 预览",
    conversionPending: "正在生成 PPT 现场预览",
    conversionPendingHint: "转换完成后会自动显示，通常只需几秒钟。",
    conversionFailed: "PPT 现场预览转换失败",
    conversionFailedHint: "请在资料管理中补充 PDF 预览，或联系开发团队确认转换服务。",
    openSource: "打开原始文件",
    documentLoading: "正在读取资料…",
    documentUnavailable: "资料暂时无法显示",
    documentUnavailableHint: "资料服务器拒绝访问或文件预览损坏，请联系开发团队重新上传。",
    documentRetry: "重新读取资料",
    previousPage: "上一页",
    nextPage: "下一页",
    previousContent: "上一项资料",
    nextContent: "下一项资料",
    page: "页",
    viewAll: "查看全部资料",
    materialReady: "资料完整",
    materialMissing: "资料待补充",
    historicalOnly: "历史记录提醒，不表示当前正在发生不良。",
    historicalEvidence: "关联记录",
    latestReport: "最近报告",
    representativePhotos: "代表照片",
    noRepresentativePhotos: "暂无代表照片",
    qualityLoading: "正在读取品质资料…",
    qualityUnavailable: "暂时无法读取品质资料",
    qualityPermissionRequired: "当前账号没有品质资料查看权限",
    qualityPermissionHint: "请联系管理员确认品质查看权限。",
    qualityEmpty: "当前型号暂无品质Issue",
    qualityEmptyHint: "新增匹配的品质记录后会自动显示在这里。",
    matchingReports: "匹配报告",
    historicalReference: "历史参考",
    sourceMaterial: "样本来源",
    verificationPending: "示例 · 型号/品号/版本待核对",
    verificationMatched: "资料匹配完成",
    verificationMismatch: "资料与当前计划不一致",
    section: "报告区分",
    action: "对策/结果",
    disposition: "处置",
    noDetail: "历史报告未记录详细内容",
    loading: "正在读取现场数据…",
    loadError: "现场数据读取失败",
    retry: "重新读取",
    stationSelect: "工位选择",
    logout: "登出",
    changeDetected: "检测到品号 / 型号变更，请现场确认",
    defectDue: "不良录入时间已到，请先完成录入",
    missingMaterialAlert: "当前作业资料不完整，请联系开发团队补充",
    interactDocument: "操作文档",
    interactDocumentHint: "点击后暂停轮播，可缩放、翻页或滚动查看。",
    documentZoom: "文档缩放",
    zoomIn: "放大",
    zoomOut: "缩小",
    resetZoom: "适合屏幕",
    allMaterials: "当前作业资料",
    close: "关闭",
    transitionTitle: "请确认是否换型",
    transitionHint: "MES 停机区间与生产计划推定出以下变化。请按现场实际确认。",
    from: "变更前",
    to: "变更后",
    detectedTime: "检测时间",
    moldChange: "换模",
    coreChange: "换镶件",
    yesChanged: "品号 / 型号已变更",
    notChanged: "不是换型",
    saving: "保存中…",
    confirmationFailed: "现场确认保存失败，请重试。",
    confirmationDataPending: "正在核对已确认的换型记录，暂不弹出重复确认。",
    noPendingChange: "当前没有待确认的换型候选。",
    previousPlanIdentityMissing: "无法确认变更前的生产计划，请刷新数据后重试。",
    defectTitle: "输入不良类型与数量",
    defectShiftHint: "交接前请录入本生产区间的不良数量。",
    defectTransitionHint: "换型前请先结清上一生产区间的不良数量。",
    defectManualHint: "录入当前生产区间的不良数量。",
    selectedDefect: "当前选择",
    defectTotal: "不良合计",
    clear: "清零",
    submitDefect: "计算并确认",
    submitting: "计算中…",
    defectFailed: "不良数据保存失败，请检查后重试。",
    summaryTitle: "生产区间数量确认",
    endingShots: "当前累计合模数",
    segmentShots: "本区间合模数",
    cavity: "穴数",
    grossPieces: "理论生产数",
    defects: "不良数",
    goodPieces: "最终良品数",
    confirmSummary: "确认完成",
    completingChange: "保存换型确认中…",
    due: "计划时间",
    overdue: "已逾期",
  },
  ko: {
    brandSubtitle: "万佳数据平台",
    injection: "사출",
    online: "온라인",
    offline: "데이터 지연",
    secondsAgo: "초 전",
    noSignal: "데이터 없음",
    shiftShots: "이번 시프트 형합수",
    dayShiftWindow: "08:00–20:00",
    nightShiftWindow: "20:00–익일 08:00",
    model: "모델",
    partNo: "품번",
    currentPlanShots: "현재 작업 추정 형합수",
    theoretical: "이론 생산수(현재 작업)",
    progress: "계획 완료율",
    pieces: "개",
    shots: "회",
    records: "건",
    workQueue: "작업 대기열",
    currentJob: "현재 작업",
    nextJob: "다음 작업",
    queueOutput: "생산 / 계획",
    plannedChange: "예상 모델체인지",
    noNext: "다음 작업 없음",
    confirmChange: "모델체인지 확인",
    inputDefect: "불량 입력",
    workInstruction: "작업지도서",
    drawing: "도면",
    qualityHistory: "품질",
    noPlan: "현재 이 설비의 생산계획이 없습니다",
    noPlanHint: "계획이 배포되면 모델, 품번, 현장 자료가 자동으로 표시됩니다.",
    noDocument: "해당 자료가 아직 없습니다",
    noDocumentHint: "‘개발 > 현장 칸반 자료관리’에서 PPT/PPTX 또는 PDF를 올려 주세요.",
    sourceOnly: "원본은 업로드되었지만 PDF 미리보기가 필요합니다",
    conversionPending: "PPT 현장 미리보기 변환 중",
    conversionPendingHint: "변환이 끝나면 자동으로 표시되며 보통 몇 초 정도 걸립니다.",
    conversionFailed: "PPT 현장 미리보기 변환 실패",
    conversionFailedHint: "자료관리에서 PDF 미리보기를 추가하거나 개발팀에 변환 서비스를 확인해 주세요.",
    openSource: "원본 파일 열기",
    documentLoading: "자료를 불러오는 중…",
    documentUnavailable: "자료를 표시할 수 없습니다",
    documentUnavailableHint: "자료 서버가 접근을 거부했거나 미리보기 파일이 손상되었습니다. 개발팀에 재업로드를 요청해 주세요.",
    documentRetry: "자료 다시 불러오기",
    previousPage: "이전 페이지",
    nextPage: "다음 페이지",
    previousContent: "이전 자료",
    nextContent: "다음 자료",
    page: "페이지",
    viewAll: "전체 자료 보기",
    materialReady: "자료 완비",
    materialMissing: "자료 보충 필요",
    historicalOnly: "이력 기반 참고이며 현재 불량 발생을 뜻하지 않습니다.",
    historicalEvidence: "연관 이력",
    latestReport: "최근 보고",
    representativePhotos: "대표 사진",
    noRepresentativePhotos: "대표 사진 없음",
    qualityLoading: "품질 자료를 불러오는 중입니다…",
    qualityUnavailable: "품질 자료를 불러오지 못했습니다",
    qualityPermissionRequired: "현재 계정에는 품질 자료 조회 권한이 없습니다",
    qualityPermissionHint: "관리자에게 품질 조회 권한을 확인해 주세요.",
    qualityEmpty: "현재 모델의 품질 이슈가 없습니다",
    qualityEmptyHint: "일치하는 품질 기록이 추가되면 여기에 자동으로 표시됩니다.",
    matchingReports: "매칭 보고",
    historicalReference: "이력 참고",
    sourceMaterial: "샘플 출처",
    verificationPending: "샘플 · 모델/품번/Revision 확인 전",
    verificationMatched: "자료 일치 확인 완료",
    verificationMismatch: "현재 계획과 자료가 일치하지 않음",
    section: "보고 구분",
    action: "대책/결과",
    disposition: "처리",
    noDetail: "과거 보고서에 세부 내용이 없습니다",
    loading: "현장 데이터를 불러오는 중…",
    loadError: "현장 데이터를 불러오지 못했습니다",
    retry: "다시 불러오기",
    stationSelect: "설비 선택",
    logout: "로그아웃",
    changeDetected: "품번 / 모델 변경 후보가 감지되었습니다. 현장 확인이 필요합니다",
    defectDue: "불량 입력 시간이 되었습니다. 먼저 입력을 완료해 주세요",
    missingMaterialAlert: "현재 작업 자료가 완비되지 않았습니다. 개발팀에 보충을 요청해 주세요",
    interactDocument: "문서 조작",
    interactDocumentHint: "누르면 자동 순환이 멈추며 확대·페이지 이동·스크롤을 사용할 수 있습니다.",
    documentZoom: "문서 확대",
    zoomIn: "확대",
    zoomOut: "축소",
    resetZoom: "화면 맞춤",
    allMaterials: "현재 작업 자료",
    close: "닫기",
    transitionTitle: "모델체인지 여부를 확인해 주세요",
    transitionHint: "MES 정지 구간과 생산계획을 기준으로 추정했습니다. 현장 상황대로 선택해 주세요.",
    from: "변경 전",
    to: "변경 후",
    detectedTime: "감지 시간",
    moldChange: "금형 교체",
    coreChange: "코어 교체",
    yesChanged: "품번 / 모델 변경 맞음",
    notChanged: "모델체인지 아님",
    saving: "저장 중…",
    confirmationFailed: "현장 확인 저장에 실패했습니다. 다시 시도해 주세요.",
    confirmationDataPending: "기존 모델체인지 확인 이력을 대조 중입니다. 중복 팝업은 잠시 보류합니다.",
    noPendingChange: "현재 확인 대기 중인 모델체인지 후보가 없습니다.",
    previousPlanIdentityMissing: "변경 전 생산계획을 확인할 수 없습니다. 데이터를 새로 불러온 뒤 다시 시도해 주세요.",
    defectTitle: "불량 유형과 수량 입력",
    defectShiftHint: "교대 전에 이번 생산 구간의 불량 수량을 입력해 주세요.",
    defectTransitionHint: "모델체인지 전에 이전 생산 구간의 불량 수량을 마감해 주세요.",
    defectManualHint: "현재 생산 구간의 불량 수량을 입력합니다.",
    selectedDefect: "현재 선택",
    defectTotal: "불량 합계",
    clear: "초기화",
    submitDefect: "계산 후 확인",
    submitting: "계산 중…",
    defectFailed: "불량 데이터 저장에 실패했습니다. 확인 후 다시 시도해 주세요.",
    summaryTitle: "생산 구간 수량 확인",
    endingShots: "현재 누적 형합수",
    segmentShots: "이번 구간 형합수",
    cavity: "캐비티",
    grossPieces: "이론 생산수",
    defects: "불량수",
    goodPieces: "최종 양품수",
    confirmSummary: "확인 완료",
    completingChange: "모델체인지 확인 저장 중…",
    due: "예정 시각",
    overdue: "지연됨",
  },
} as const;

function number(value: number | null | undefined) {
  const rounded = Math.max(0, Math.round(Number(value) || 0));
  try {
    return new Intl.NumberFormat("en-US").format(rounded);
  } catch {
    return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
}

function readLocalStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable on locked-down kiosk profiles. The field
    // screen must continue with its in-memory preference instead of crashing.
  }
}

type FieldQueuePlan = NonNullable<FieldKanbanResponse["active_plan"]>;

type FieldQueueItem = {
  plan: FieldQueuePlan;
  position: "previous" | "current" | "next";
};

function isSameQueuePlan(left: FieldQueuePlan, right: FieldQueuePlan) {
  if (left.plan_id !== null && right.plan_id !== null) {
    return left.plan_id === right.plan_id;
  }
  return left.sequence === right.sequence
    && left.plan_date === right.plan_date
    && left.part_no === right.part_no
    && left.model_name === right.model_name
    && left.lot_no === right.lot_no;
}

function formatQueueDate(value: string, language: FieldLanguage) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return "-";
  const month = Number(match[2]);
  const day = Number(match[3]);
  return language === "zh" ? `${month}月${day}日` : `${month}/${day}`;
}

function getFieldQueueWindow(plans: FieldQueuePlan[], activePlan: FieldQueuePlan | null): FieldQueueItem[] {
  if (!activePlan) return [];
  const activeIndex = plans.findIndex((plan) => isSameQueuePlan(plan, activePlan));
  if (activeIndex < 0) {
    return [{
      plan: activePlan,
      position: "current",
    }];
  }

  const startIndex = Math.max(0, activeIndex - 2);
  const endIndex = Math.min(plans.length, activeIndex + 3);
  return plans.slice(startIndex, endIndex).map((plan, index) => {
    const absoluteIndex = startIndex + index;
    const relativeOffset = absoluteIndex - activeIndex;
    return {
      plan,
      position: relativeOffset === 0 ? "current" : relativeOffset < 0 ? "previous" : "next",
    };
  });
}

function getErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== "object") return fallback;
  const response = (error as { response?: { data?: unknown } }).response;
  const data = response?.data;
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    const detail = (data as { detail?: unknown; error?: unknown }).detail
      ?? (data as { error?: unknown }).error;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return fallback;
}

function getDefectErrorMessage(error: unknown, language: FieldLanguage, fallback: string) {
  if (!error || typeof error !== "object") return fallback;
  const candidate = error as {
    code?: unknown;
    response?: { status?: number; data?: { code?: unknown } };
  };
  const responseCode = String(candidate.response?.data?.code || "");
  const messages = defectErrorCopy[language] as Record<string, string>;
  if (messages[responseCode]) return messages[responseCode];
  if (candidate.response?.status === 403) return messages.permission_denied;
  if (candidate.code === "ECONNABORTED" || candidate.code === "ETIMEDOUT") return messages.timeout;
  return getErrorMessage(error, fallback);
}

function getShanghaiDateParts(value: Date) {
  const shanghaiTime = new Date(value.getTime() + 8 * 60 * 60 * 1_000);
  return {
    year: shanghaiTime.getUTCFullYear(),
    month: shanghaiTime.getUTCMonth() + 1,
    day: shanghaiTime.getUTCDate(),
    weekday: shanghaiTime.getUTCDay(),
    hour: shanghaiTime.getUTCHours(),
    minute: shanghaiTime.getUTCMinutes(),
  };
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function formatShanghaiTime(value: Date, language: FieldLanguage) {
  try {
    return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "ko-KR", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(value);
  } catch {
    const parts = getShanghaiDateParts(value);
    return `${twoDigits(parts.hour)}:${twoDigits(parts.minute)}`;
  }
}

function formatShanghaiDate(value: Date, language: FieldLanguage) {
  try {
    return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "ko-KR", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    }).format(value);
  } catch {
    const parts = getShanghaiDateParts(value);
    const weekdays = language === "zh"
      ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
      : ["일", "월", "화", "수", "목", "금", "토"];
    return `${parts.year}.${twoDigits(parts.month)}.${twoDigits(parts.day)} ${weekdays[parts.weekday]}`;
  }
}

function formatShortDateTime(value: string | null | undefined, language: FieldLanguage) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "ko-KR", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed);
  } catch {
    const parts = getShanghaiDateParts(parsed);
    return `${twoDigits(parts.month)}/${twoDigits(parts.day)} ${twoDigits(parts.hour)}:${twoDigits(parts.minute)}`;
  }
}

function getFreshnessSeconds(latest: string | null | undefined, now: Date) {
  if (!latest) return null;
  const value = new Date(latest).getTime();
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round((now.getTime() - value) / 1000));
}

function getReachableDocumentUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value, window.location.origin);
    const openedFromAnotherDevice = !["127.0.0.1", "localhost"].includes(window.location.hostname);
    const pointsAtLocalMock = ["127.0.0.1", "localhost"].includes(parsed.hostname) && parsed.port === "8000";
    if (import.meta.env.DEV && openedFromAnotherDevice && pointsAtLocalMock) {
      return `${window.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function getCloudinaryPdfPageImageUrls(
  document: FieldDocument | null,
  page: number,
  highDetail = false,
) {
  if (
    document?.preview_resource_type !== "image"
    || document.preview_format !== "pdf"
    || !document.preview_url
  ) return [];

  try {
    const parsed = new URL(document.preview_url, window.location.origin);
    if (parsed.hostname !== "res.cloudinary.com") return [];
    const uploadMarker = "/image/upload/";
    const markerIndex = parsed.pathname.indexOf(uploadMarker);
    if (markerIndex < 0) return [];
    const prefix = parsed.pathname.slice(0, markerIndex + uploadMarker.length);
    const originalAssetPath = parsed.pathname.slice(markerIndex + uploadMarker.length);
    const buildUrl = (profile: string, outputFormat: "jpg" | "png") => {
      const next = new URL(parsed.toString());
      const assetPath = originalAssetPath.replace(/\.pdf$/i, `.${outputFormat}`);
      next.pathname = `${prefix}pg_${Math.max(1, page)},${profile}/${assetPath}`;
      next.hash = "";
      return next.toString();
    };

    if (document.kind === "drawing") {
      // A single, lossless 3,000 px derivative keeps CAD text and dimensions
      // readable without exposing or decoding the original A0 PDF in kiosks.
      // The smaller JPEG is requested only if an older device cannot decode it.
      return [
        buildUrl(
          `dn_300,w_${DRAWING_PREVIEW_LONG_EDGE_PX},h_${DRAWING_PREVIEW_LONG_EDGE_PX},dpr_1.0,c_limit,f_png`,
          "png",
        ),
        buildUrl("dn_200,w_2000,h_2000,dpr_1.0,c_limit,q_auto:best,f_jpg", "jpg"),
      ];
    }

    // Work instructions stay lightweight until the operator asks for detail.
    const urls = highDetail
      ? [
        buildUrl("dn_300,w_3200,h_3200,dpr_1.0,c_limit,q_auto:best,f_jpg", "jpg"),
        buildUrl("dn_200,w_2000,h_2000,dpr_1.0,c_limit,q_auto:best,f_jpg", "jpg"),
      ]
      : [buildUrl("dn_200,w_2000,h_2000,dpr_1.0,c_limit,q_auto:best,f_jpg", "jpg")];
    return urls;
  } catch {
    return [];
  }
}

function getOptimizedFieldImageUrl(value: string) {
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.hostname !== "res.cloudinary.com") return value;
    const uploadMarker = "/image/upload/";
    const markerIndex = parsed.pathname.indexOf(uploadMarker);
    if (markerIndex < 0) return value;
    const prefix = parsed.pathname.slice(0, markerIndex + uploadMarker.length);
    const assetPath = parsed.pathname.slice(markerIndex + uploadMarker.length);
    parsed.pathname = `${prefix}w_1200,dpr_1.0,c_limit,q_auto:good,f_auto/${assetPath}`;
    return parsed.toString();
  } catch {
    return value;
  }
}

function isImagePreview(value: string | null | undefined) {
  if (!value) return false;
  try {
    return /\.(?:avif|jpe?g|png|webp)$/i.test(new URL(value, window.location.origin).pathname);
  } catch {
    return false;
  }
}

function getQualityIssueImages(issue: FieldKanbanResponse["quality"]["issues"][number] | undefined) {
  if (!issue) return [];
  return Array.from(new Set([
    ...issue.image_urls,
    ...(issue.image_url ? [issue.image_url] : []),
  ])).slice(0, 4);
}

function usePageVisibility() {
  const [isVisible, setIsVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setIsVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return isVisible;
}

function getVerificationLabel(
  status: FieldDocument["verification_status"],
  customLabel: FieldDocument["verification_label"],
  language: FieldLanguage,
) {
  if (!status) return "";
  if (customLabel?.[language]) return customLabel[language];
  const c = copy[language];
  if (status === "matched") return c.verificationMatched;
  if (status === "mismatch") return c.verificationMismatch;
  return c.verificationPending;
}

function getTransitionPart(record: InjectionTransitionEvent["fromRecord"] | undefined) {
  return record?.part_no || record?.model_name || record?.part_spec || "-";
}

function getTransitionBusinessDate(event: InjectionTransitionEvent, fallback: string) {
  const datePrefix = event.eventKey.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePrefix) ? datePrefix : fallback;
}

function buildConfirmationPayload(
  event: InjectionTransitionEvent,
  businessDate: string,
  resolution: "confirmed" | "dismissed",
  language: FieldLanguage,
): SaveInjectionDowntimeConfirmationPayload {
  return {
    business_date: businessDate,
    event_key: event.eventKey,
    machine_key: event.machineKey,
    machine_label: event.machineLabel,
    detected_type: event.type,
    detected_start: event.startTime,
    detected_end: event.endTime,
    duration_minutes: Math.max(0, Math.round(event.durationMinutes)),
    resolution,
    reason_code: resolution === "dismissed" ? "not_stop" : event.type === "core_change" ? "core_change" : "mold_change",
    note: resolution === "dismissed"
      ? (language === "zh" ? "现场确认：不是换型" : "현장 확인: 모델체인지 아님")
      : (language === "zh" ? "现场触摸屏确认" : "현장 터치스크린 확인"),
    evidence: {
      ...event.evidence,
      from_part_no: event.fromRecord?.part_no ?? "",
      from_model_name: event.fromRecord?.model_name ?? "",
      to_part_no: event.toRecord?.part_no ?? "",
      to_model_name: event.toRecord?.model_name ?? "",
      target_part_no: event.targetRecord?.part_no ?? "",
      confidence: event.confidence,
      auto_status: event.status,
      source: "field_touchscreen",
    },
  };
}

function ModalShell({
  children,
  label,
  onEscape,
  wide = false,
}: {
  children: React.ReactNode;
  label: string;
  onEscape?: () => void;
  wide?: boolean;
}) {
  const modalRef = useModalFocusTrap<HTMLElement>({ onEscape });
  return (
    <div className="field-modal-backdrop" role="presentation">
      <section
        aria-label={label}
        aria-modal="true"
        className={`field-modal${wide ? " field-modal--wide" : ""}`}
        ref={modalRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}

function TransitionModal({
  event,
  language,
  error,
  saving,
  onConfirm,
  onDismiss,
}: {
  event: InjectionTransitionEvent;
  language: FieldLanguage;
  error: string | null;
  saving: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const c = copy[language];
  return (
    <ModalShell label={c.transitionTitle}>
      <header className="field-modal__header field-modal__header--warning">
        <span className="field-modal__icon"><AlertTriangle aria-hidden="true" /></span>
        <div>
          <h2>{c.transitionTitle}</h2>
          <p>{c.transitionHint}</p>
        </div>
      </header>
      <div className="field-transition-summary">
        <span className="field-transition-summary__type">
          {event.type === "core_change" ? c.coreChange : c.moldChange}
        </span>
        <div>
          <small>{c.from}</small>
          <strong>{getTransitionPart(event.fromRecord)}</strong>
          <span>{event.fromRecord?.model_name || "-"}</span>
        </div>
        <ChevronRight aria-hidden="true" />
        <div>
          <small>{c.to}</small>
          <strong>{getTransitionPart(event.toRecord)}</strong>
          <span>{event.toRecord?.model_name || "-"}</span>
        </div>
      </div>
      <p className="field-transition-time">
        <Clock3 aria-hidden="true" />
        {c.detectedTime} {formatShortDateTime(event.startTime, language)} ~ {formatShortDateTime(event.endTime, language)}
      </p>
      {error ? <div className="field-modal__error" role="alert">{error}</div> : null}
      <div className="field-modal__actions field-modal__actions--split">
        <button className="field-touch-button field-touch-button--muted" disabled={saving} onClick={onDismiss} type="button">
          <X aria-hidden="true" />
          {saving ? c.saving : c.notChanged}
        </button>
        <button className="field-touch-button field-touch-button--warning" data-modal-initial-focus disabled={saving} onClick={onConfirm} type="button">
          <ClipboardCheck aria-hidden="true" />
          {c.yesChanged}
        </button>
      </div>
    </ModalShell>
  );
}

function DefectModal({
  request,
  language,
  completionBusy,
  completionError,
  onCancel,
  onComplete,
}: {
  request: DefectRequest;
  language: FieldLanguage;
  completionBusy: boolean;
  completionError: string | null;
  onCancel: () => void;
  onComplete: (checkpoint: FieldDefectCheckpoint) => Promise<void> | void;
}) {
  const c = copy[language];
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [selectedCode, setSelectedCode] = useState<string>(DEFECT_TYPES[0].code);
  const [checkpoint, setCheckpoint] = useState<FieldDefectCheckpoint | null>(null);
  const defectMutation = useMutation({
    mutationFn: submitFieldDefects,
  });
  const resetDefectMutation = defectMutation.reset;

  useEffect(() => {
    setQuantities({});
    setSelectedCode(DEFECT_TYPES[0].code);
    setCheckpoint(null);
    resetDefectMutation();
  }, [request.eventKey, resetDefectMutation]);

  const selectedType = DEFECT_TYPES.find((item) => item.code === selectedCode) ?? DEFECT_TYPES[0];
  const selectedValue = quantities[selectedCode] ?? 0;
  const defectTotal = Object.values(quantities).reduce((sum, item) => sum + (Number(item) || 0), 0);
  const hint = request.source === "transition"
    ? c.defectTransitionHint
    : request.source === "shift"
      ? c.defectShiftHint
      : c.defectManualHint;

  function setSelectedValue(value: number) {
    setQuantities((current) => ({ ...current, [selectedCode]: Math.max(0, Math.min(999_999, Math.round(value))) }));
  }

  function inputDigit(digit: number) {
    const next = Number(`${selectedValue === 0 ? "" : selectedValue}${digit}`);
    setSelectedValue(next);
  }

  async function submit() {
    try {
      const result = await defectMutation.mutateAsync({
        event_key: request.eventKey,
        trigger: request.trigger,
        business_date: request.businessDate,
        machine_number: request.machineNumber,
        plan_id: request.planId,
        part_no: request.partNo || undefined,
        sequence: request.sequence,
        items: DEFECT_TYPES
          .map((item) => ({ code: item.code, quantity: quantities[item.code] ?? 0 }))
          .filter((item) => item.quantity > 0),
      });
      setCheckpoint(result.checkpoint);
    } catch {
      // React Query retains the error for the visible retry message below.
    }
  }

  if (checkpoint) {
    return (
      <ModalShell label={c.summaryTitle} wide>
        <header className="field-modal__header field-modal__header--success">
          <span className="field-modal__icon"><CheckCircle2 aria-hidden="true" /></span>
          <div>
            <h2>{c.summaryTitle}</h2>
            <p>{checkpoint.part_no || "-"} · {checkpoint.model_name || "-"}</p>
          </div>
        </header>
        <div className="field-defect-summary-grid">
          <div><span>{c.endingShots}</span><strong>{number(checkpoint.ending_business_day_shots)}</strong></div>
          <div><span>{c.segmentShots}</span><strong>{number(checkpoint.segment_shots)}</strong></div>
          <div><span>{c.cavity}</span><strong>{number(checkpoint.cavity)}</strong></div>
          <div><span>{c.grossPieces}</span><strong>{number(checkpoint.gross_piece_qty)}</strong></div>
          <div className="is-defect"><span>{c.defects}</span><strong>{number(checkpoint.defect_piece_qty)}</strong></div>
          <div className="is-good"><span>{c.goodPieces}</span><strong>{number(checkpoint.good_piece_qty)}</strong></div>
        </div>
        <div className="field-defect-formula">
          {number(checkpoint.segment_shots)} × {number(checkpoint.cavity)} = {number(checkpoint.gross_piece_qty)} · {number(checkpoint.gross_piece_qty)} − {number(checkpoint.defect_piece_qty)} = <strong>{number(checkpoint.good_piece_qty)}</strong>
        </div>
        {completionError ? <div className="field-modal__error" role="alert">{completionError}</div> : null}
        <div className="field-modal__actions">
          <button
            className="field-touch-button field-touch-button--primary"
            disabled={completionBusy}
            onClick={() => void onComplete(checkpoint)}
            type="button"
          >
            <Check aria-hidden="true" />
            {completionBusy ? c.completingChange : c.confirmSummary}
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell label={c.defectTitle} wide>
      <header className="field-modal__header field-modal__header--danger">
        <span className="field-modal__icon"><ShieldAlert aria-hidden="true" /></span>
        <div>
          <h2>{c.defectTitle}</h2>
          <p>{hint}</p>
        </div>
        {!request.blocking ? (
          <button aria-label={c.close} className="field-modal__close" onClick={onCancel} type="button"><X /></button>
        ) : null}
      </header>
      <div className="field-defect-layout">
        <section className="field-defect-picker" aria-label={c.defectTitle}>
          <div className="field-defect-picker__header">
            <span>{request.partNo || "-"} · {request.modelName || "-"}</span>
            <strong>{c.defectTotal} <b>{number(defectTotal)}</b> {c.pieces}</strong>
          </div>
          <div className="field-defect-types">
            {DEFECT_TYPES.map((item) => {
              const value = quantities[item.code] ?? 0;
              return (
                <button
                  className={selectedCode === item.code ? "is-active" : ""}
                  key={item.code}
                  onClick={() => setSelectedCode(item.code)}
                  type="button"
                >
                  <span>{item[language]}</span>
                  <strong>{number(value)}</strong>
                </button>
              );
            })}
          </div>
        </section>
        <section className="field-numpad-panel">
          <div className="field-numpad-display">
            <span>{c.selectedDefect}</span>
            <strong>{selectedType[language]}</strong>
            <output>{number(selectedValue)}</output>
          </div>
          <div className="field-numpad" aria-label={c.selectedDefect}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
              <button key={digit} onClick={() => inputDigit(digit)} type="button">{digit}</button>
            ))}
            <button className="is-clear" onClick={() => setSelectedValue(0)} type="button">{c.clear}</button>
            <button onClick={() => inputDigit(0)} type="button">0</button>
            <button aria-label="backspace" onClick={() => setSelectedValue(Math.floor(selectedValue / 10))} type="button"><Delete /></button>
          </div>
        </section>
      </div>
      {defectMutation.isError ? (
        <div className="field-modal__error" role="alert">{getDefectErrorMessage(defectMutation.error, language, c.defectFailed)}</div>
      ) : null}
      <div className="field-modal__actions field-modal__actions--defect">
        {!request.blocking ? (
          <button className="field-touch-button field-touch-button--muted" disabled={defectMutation.isPending} onClick={onCancel} type="button">
            <X aria-hidden="true" />{c.close}
          </button>
        ) : null}
        <button className="field-touch-button field-touch-button--danger" disabled={defectMutation.isPending} onClick={() => void submit()} type="button">
          <Check aria-hidden="true" />
          {defectMutation.isPending ? c.submitting : c.submitDefect}
        </button>
      </div>
    </ModalShell>
  );
}

function DocumentEmptyState({ document, language }: { document: FieldDocument | null; language: FieldLanguage }) {
  const c = copy[language];
  const conversionPending = document?.conversion_status === "pending";
  const conversionFailed = document?.conversion_status === "failed";
  const sourceOnly = Boolean(document?.source_url && !document.preview_url);
  const sourceUrl = getReachableDocumentUrl(document?.source_url);
  const heading = conversionPending
    ? c.conversionPending
    : conversionFailed
      ? c.conversionFailed
      : sourceOnly
        ? c.sourceOnly
        : c.noDocument;
  const hint = conversionPending
    ? c.conversionPendingHint
    : conversionFailed
      ? c.conversionFailedHint
      : c.noDocumentHint;
  return (
    <div className="field-document-empty">
      {conversionPending ? <Loader2 aria-hidden="true" className="is-spinning" /> : <FileText aria-hidden="true" />}
      <h2>{heading}</h2>
      <p>{hint}</p>
      {sourceOnly && sourceUrl ? (
        <a href={sourceUrl} rel="noreferrer" target="_blank">
          <ExternalLink aria-hidden="true" />{c.openSource}
        </a>
      ) : null}
    </div>
  );
}

let pdfJsModulePromise: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;
const pdfJsAssetBase = `${import.meta.env.BASE_URL.replace(/\/?$/, "/")}pdfjs/`;

function loadPdfJs() {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ]).then(([pdfJs, workerModule]) => {
      pdfJs.GlobalWorkerOptions.workerSrc = workerModule.default;
      return pdfJs;
    });
    void pdfJsModulePromise.catch(() => {
      pdfJsModulePromise = null;
    });
  }
  return pdfJsModulePromise;
}

function isPdfRenderCancellation(error: unknown) {
  return (error as { name?: string } | null)?.name === "RenderingCancelledException";
}

type DocumentView = {
  scale: number;
  x: number;
  y: number;
};

type ClientPoint = {
  x: number;
  y: number;
};

function clampDocumentScale(value: number) {
  return Math.min(DOCUMENT_ZOOM_MAX, Math.max(DOCUMENT_ZOOM_MIN, value));
}

function getPointCenter(points: ClientPoint[]) {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
  return {
    x: (points[0].x + points[1].x) / 2,
    y: (points[0].y + points[1].y) / 2,
  };
}

function getPointDistance(points: ClientPoint[]) {
  if (points.length < 2) return 0;
  return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
}

function DocumentPanZoomViewport({
  children,
  controlsVisible,
  language,
  onZoomChange,
  resetKey,
}: {
  children: ReactNode;
  controlsVisible: boolean;
  language: FieldLanguage;
  onZoomChange?: (scale: number) => void;
  resetKey: string;
}) {
  const c = copy[language];
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DocumentView>({ scale: 1, x: 0, y: 0 });
  const [view, setView] = useState<DocumentView>(viewRef.current);

  const commitView = useCallback((candidate: DocumentView) => {
    const viewport = viewportRef.current;
    const scale = clampDocumentScale(candidate.scale);
    const maxX = Math.max(0, ((viewport?.clientWidth ?? 0) * (scale - 1)) / 2);
    const maxY = Math.max(0, ((viewport?.clientHeight ?? 0) * (scale - 1)) / 2);
    const next = {
      scale,
      x: Math.min(maxX, Math.max(-maxX, scale === 1 ? 0 : candidate.x)),
      y: Math.min(maxY, Math.max(-maxY, scale === 1 ? 0 : candidate.y)),
    };
    viewRef.current = next;
    onZoomChange?.(next.scale);
    setView((current) => (
      current.scale === next.scale && current.x === next.x && current.y === next.y
        ? current
        : next
    ));
  }, [onZoomChange]);

  const zoomAt = useCallback((nextScale: number, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const current = viewRef.current;
    const scale = clampDocumentScale(nextScale);
    const bounds = viewport.getBoundingClientRect();
    const focalX = (clientX ?? bounds.left + bounds.width / 2) - bounds.left - bounds.width / 2;
    const focalY = (clientY ?? bounds.top + bounds.height / 2) - bounds.top - bounds.height / 2;
    commitView({
      scale,
      x: focalX - ((focalX - current.x) / current.scale) * scale,
      y: focalY - ((focalY - current.y) / current.scale) * scale,
    });
  }, [commitView]);

  useEffect(() => {
    commitView({ scale: 1, x: 0, y: 0 });
  }, [commitView, resetKey]);

  useEffect(() => {
    const keepInsideViewport = () => commitView(viewRef.current);
    window.addEventListener("resize", keepInsideViewport);
    return () => window.removeEventListener("resize", keepInsideViewport);
  }, [commitView]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    type Gesture = {
      distance: number;
      points: ClientPoint[];
      startView: DocumentView;
    };

    let gesture: Gesture | null = null;
    let mouseActive = false;
    const pointerPoints = new Map<number, ClientPoint>();
    const isControlTarget = (target: EventTarget | null) => (
      target instanceof Element && Boolean(target.closest(".field-document-zoom-controls"))
    );
    const startGesture = (points: ClientPoint[]) => {
      gesture = points.length
        ? {
          distance: getPointDistance(points),
          points: points.slice(0, 2),
          startView: viewRef.current,
        }
        : null;
    };
    const moveGesture = (points: ClientPoint[]) => {
      if (!gesture || !points.length) return;
      if (points.length >= 2 && gesture.points.length >= 2) {
        const viewportBounds = viewport.getBoundingClientRect();
        const startCenter = getPointCenter(gesture.points);
        const currentCenter = getPointCenter(points);
        const startRelative = {
          x: startCenter.x - viewportBounds.left - viewportBounds.width / 2,
          y: startCenter.y - viewportBounds.top - viewportBounds.height / 2,
        };
        const currentRelative = {
          x: currentCenter.x - viewportBounds.left - viewportBounds.width / 2,
          y: currentCenter.y - viewportBounds.top - viewportBounds.height / 2,
        };
        const distance = getPointDistance(points);
        const scale = clampDocumentScale(
          gesture.startView.scale * (gesture.distance > 0 ? distance / gesture.distance : 1),
        );
        commitView({
          scale,
          x: currentRelative.x - ((startRelative.x - gesture.startView.x) / gesture.startView.scale) * scale,
          y: currentRelative.y - ((startRelative.y - gesture.startView.y) / gesture.startView.scale) * scale,
        });
        return;
      }
      if (points.length === 1 && gesture.points.length === 1) {
        commitView({
          scale: gesture.startView.scale,
          x: gesture.startView.x + points[0].x - gesture.points[0].x,
          y: gesture.startView.y + points[0].y - gesture.points[0].y,
        });
      }
    };
    const normalizeWheelDelta = (event: WheelEvent) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * viewport.clientHeight;
      return event.deltaY;
    };
    const onWheel = (event: WheelEvent) => {
      if (isControlTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!controlsVisible) return;
      const delta = normalizeWheelDelta(event);
      if (!delta) return;
      zoomAt(
        viewRef.current.scale + (delta < 0 ? DOCUMENT_ZOOM_STEP : -DOCUMENT_ZOOM_STEP),
        event.clientX,
        event.clientY,
      );
    };
    const onDoubleClick = (event: MouseEvent) => {
      if (isControlTarget(event.target)) return;
      event.preventDefault();
      if (!controlsVisible) return;
      zoomAt(
        viewRef.current.scale >= DOCUMENT_ZOOM_MAX ? DOCUMENT_ZOOM_MIN : viewRef.current.scale + 0.5,
        event.clientX,
        event.clientY,
      );
    };
    const onDragStart = (event: DragEvent) => event.preventDefault();

    let passiveSupported = false;
    try {
      const passiveProbe = Object.defineProperty({}, "passive", {
        get() {
          passiveSupported = true;
          return false;
        },
      });
      const noop = () => undefined;
      window.addEventListener("field-passive-probe", noop, passiveProbe);
      window.removeEventListener("field-passive-probe", noop, passiveProbe);
    } catch {
      passiveSupported = false;
    }
    const activeListenerOptions: AddEventListenerOptions | boolean = passiveSupported
      ? { passive: false }
      : false;

    viewport.addEventListener("wheel", onWheel, activeListenerOptions);
    viewport.addEventListener("dblclick", onDoubleClick);
    viewport.addEventListener("dragstart", onDragStart);

    const supportsPointerEvents = typeof (window as Window & { PointerEvent?: typeof PointerEvent }).PointerEvent !== "undefined";
    if (supportsPointerEvents) {
      const onPointerDown = (event: PointerEvent) => {
        if (isControlTarget(event.target)) return;
        event.preventDefault();
        if (!controlsVisible) return;
        pointerPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        startGesture(Array.from(pointerPoints.values()));
        try {
          viewport.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is optional on older Firefox implementations.
        }
      };
      const onPointerMove = (event: PointerEvent) => {
        if (!pointerPoints.has(event.pointerId)) return;
        event.preventDefault();
        pointerPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        moveGesture(Array.from(pointerPoints.values()));
      };
      const onPointerEnd = (event: PointerEvent) => {
        if (!pointerPoints.has(event.pointerId)) return;
        pointerPoints.delete(event.pointerId);
        startGesture(Array.from(pointerPoints.values()));
      };
      viewport.addEventListener("pointerdown", onPointerDown);
      viewport.addEventListener("pointermove", onPointerMove);
      viewport.addEventListener("pointerup", onPointerEnd);
      viewport.addEventListener("pointercancel", onPointerEnd);
      return () => {
        viewport.removeEventListener("wheel", onWheel, activeListenerOptions);
        viewport.removeEventListener("dblclick", onDoubleClick);
        viewport.removeEventListener("dragstart", onDragStart);
        viewport.removeEventListener("pointerdown", onPointerDown);
        viewport.removeEventListener("pointermove", onPointerMove);
        viewport.removeEventListener("pointerup", onPointerEnd);
        viewport.removeEventListener("pointercancel", onPointerEnd);
      };
    }

    const getTouchPoints = (touches: TouchList) => Array.from(touches)
      .slice(0, 2)
      .map((touch) => ({ x: touch.clientX, y: touch.clientY }));
    const onTouchStart = (event: TouchEvent) => {
      if (isControlTarget(event.target)) return;
      event.preventDefault();
      if (!controlsVisible) return;
      startGesture(getTouchPoints(event.touches));
    };
    const onTouchMove = (event: TouchEvent) => {
      if (isControlTarget(event.target)) return;
      event.preventDefault();
      if (!controlsVisible) return;
      moveGesture(getTouchPoints(event.touches));
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (isControlTarget(event.target)) return;
      event.preventDefault();
      if (!controlsVisible) return;
      startGesture(getTouchPoints(event.touches));
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || isControlTarget(event.target)) return;
      event.preventDefault();
      if (!controlsVisible) return;
      mouseActive = true;
      startGesture([{ x: event.clientX, y: event.clientY }]);
    };
    const onMouseMove = (event: MouseEvent) => {
      if (!mouseActive) return;
      event.preventDefault();
      moveGesture([{ x: event.clientX, y: event.clientY }]);
    };
    const onMouseUp = () => {
      mouseActive = false;
      gesture = null;
    };
    viewport.addEventListener("touchstart", onTouchStart, activeListenerOptions);
    viewport.addEventListener("touchmove", onTouchMove, activeListenerOptions);
    viewport.addEventListener("touchend", onTouchEnd, activeListenerOptions);
    viewport.addEventListener("touchcancel", onTouchEnd, activeListenerOptions);
    viewport.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      viewport.removeEventListener("wheel", onWheel, activeListenerOptions);
      viewport.removeEventListener("dblclick", onDoubleClick);
      viewport.removeEventListener("dragstart", onDragStart);
      viewport.removeEventListener("touchstart", onTouchStart, activeListenerOptions);
      viewport.removeEventListener("touchmove", onTouchMove, activeListenerOptions);
      viewport.removeEventListener("touchend", onTouchEnd, activeListenerOptions);
      viewport.removeEventListener("touchcancel", onTouchEnd, activeListenerOptions);
      viewport.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [commitView, controlsVisible, zoomAt]);

  const isReset = view.scale === 1 && view.x === 0 && view.y === 0;
  return (
    <div className="field-document-pan-zoom" ref={viewportRef}>
      <div
        className="field-document-pan-zoom__surface"
        style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
      >
        {children}
      </div>
      {controlsVisible ? (
        <div aria-label={c.documentZoom} className="field-document-zoom-controls" role="group">
          <button
            aria-label={c.zoomOut}
            disabled={view.scale <= DOCUMENT_ZOOM_MIN}
            onClick={() => zoomAt(view.scale - DOCUMENT_ZOOM_STEP)}
            type="button"
          ><ZoomOut aria-hidden="true" /></button>
          <output aria-live="polite">{Math.round(view.scale * 100)}%</output>
          <button
            aria-label={c.resetZoom}
            disabled={isReset}
            onClick={() => commitView({ scale: 1, x: 0, y: 0 })}
            type="button"
          ><RotateCcw aria-hidden="true" /></button>
          <button
            aria-label={c.zoomIn}
            disabled={view.scale >= DOCUMENT_ZOOM_MAX}
            onClick={() => zoomAt(view.scale + DOCUMENT_ZOOM_STEP)}
            type="button"
          ><ZoomIn aria-hidden="true" /></button>
        </div>
      ) : null}
    </div>
  );
}

function PdfCanvasPreview({
  attempt,
  highDetail,
  interactionLocked,
  onLoadStateChange,
  page,
  title,
  url,
}: {
  attempt: number;
  highDetail: boolean;
  interactionLocked: boolean;
  onLoadStateChange: (state: "loading" | "ready" | "error") => void;
  page: number;
  title: string;
  url: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerSize, setContainerSize] = useState({ height: 0, width: 0 });
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [renderedPage, setRenderedPage] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let frame = 0;
    const updateSize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const nextHeight = Math.max(1, Math.floor(host.clientHeight));
        const nextWidth = Math.max(1, Math.floor(host.clientWidth));
        setContainerSize((current) => (
          Math.abs(current.height - nextHeight) > 1 || Math.abs(current.width - nextWidth) > 1
            ? { height: nextHeight, width: nextWidth }
            : current
        ));
      });
    };

    updateSize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateSize);
    const legacyResizeTimer = observer ? null : window.setInterval(updateSize, 500);
    observer?.observe(host);
    window.addEventListener("resize", updateSize);
    return () => {
      observer?.disconnect();
      if (legacyResizeTimer !== null) window.clearInterval(legacyResizeTimer);
      window.removeEventListener("resize", updateSize);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let loadedDocument: PDFDocumentProxy | null = null;

    setPdfDocument(null);
    onLoadStateChange("loading");
    void loadPdfJs()
      .then((pdfJs) => {
        if (!active) return null;
        loadingTask = pdfJs.getDocument({
          url: url.split("#")[0],
          cMapPacked: true,
          cMapUrl: `${pdfJsAssetBase}cmaps/`,
          standardFontDataUrl: `${pdfJsAssetBase}standard_fonts/`,
          useSystemFonts: true,
        });
        return loadingTask.promise;
      })
      .then((nextDocument) => {
        if (!nextDocument) return;
        loadedDocument = nextDocument;
        if (!active) {
          void nextDocument.destroy();
          return;
        }
        setPdfDocument(nextDocument);
      })
      .catch(() => {
        if (active) onLoadStateChange("error");
      });

    return () => {
      active = false;
      if (loadingTask) void loadingTask.destroy();
      if (loadedDocument) void loadedDocument.destroy();
    };
  }, [attempt, onLoadStateChange, url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!pdfDocument || !containerSize.height || !containerSize.width || !canvas) return;

    let active = true;
    let pdfPage: PDFPageProxy | null = null;
    let renderTask: RenderTask | null = null;
    setRenderedPage(false);
    onLoadStateChange("loading");

    void pdfDocument
      .getPage(Math.min(Math.max(1, page), pdfDocument.numPages))
      .then((nextPage) => {
        if (!active) {
          nextPage.cleanup();
          return null;
        }
        pdfPage = nextPage;
        const baseViewport = nextPage.getViewport({ scale: 1 });
        const cssScale = Math.min(
          containerSize.width / baseViewport.width,
          containerSize.height / baseViewport.height,
        );
        const cssViewport = nextPage.getViewport({ scale: cssScale });
        // Direct canvas rendering avoids holding a second base64 PNG copy in
        // memory. Capping DPR also protects low-memory Android kiosks.
        const baseOutputScale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 1.5);
        const outputScale = highDetail ? Math.min(baseOutputScale * 2, 3) : baseOutputScale;
        const renderViewport = nextPage.getViewport({ scale: cssScale * outputScale });
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("PDF canvas is unavailable");

        canvas.width = Math.max(1, Math.floor(renderViewport.width));
        canvas.height = Math.max(1, Math.floor(renderViewport.height));
        canvas.style.width = `${Math.max(1, Math.floor(cssViewport.width))}px`;
        canvas.style.height = `${Math.max(1, Math.floor(cssViewport.height))}px`;
        renderTask = nextPage.render({
          canvasContext: context,
          viewport: renderViewport,
          background: "#ffffff",
        });
        return renderTask.promise;
      })
      .then(() => {
        if (!active) return;
        setRenderedPage(true);
        onLoadStateChange("ready");
      })
      .catch((error) => {
        if (active && !isPdfRenderCancellation(error)) onLoadStateChange("error");
      });

    return () => {
      active = false;
      renderTask?.cancel();
      pdfPage?.cleanup();
    };
  }, [containerSize.height, containerSize.width, highDetail, onLoadStateChange, page, pdfDocument]);

  return (
    <div
      className={`field-pdf-preview${interactionLocked ? " is-interaction-locked" : ""}`}
      ref={hostRef}
    >
      <canvas
        aria-label={`${title} · ${page}`}
        className={renderedPage ? "is-ready" : ""}
        ref={canvasRef}
        role="img"
      />
    </div>
  );
}

function FieldDocumentPreview({
  document,
  interactionLocked,
  language,
  page,
  onInteract,
}: {
  document: FieldDocument;
  interactionLocked: boolean;
  language: FieldLanguage;
  page: number;
  onInteract: () => void;
}) {
  const c = copy[language];
  const [highDetail, setHighDetail] = useState(false);
  const imageCandidateKey = `${document.id}:${document.preview_url ?? ""}`;
  const [imageCandidateState, setImageCandidateState] = useState(() => ({
    index: 0,
    key: imageCandidateKey,
  }));
  const storedImageCandidateIndex = imageCandidateState.key === imageCandidateKey
    ? imageCandidateState.index
    : 0;
  const pageImageUrls = getCloudinaryPdfPageImageUrls(document, page, highDetail);
  const directImageUrl = isImagePreview(document.preview_url)
    ? getReachableDocumentUrl(document.preview_url)
    : null;
  const imageCandidates = directImageUrl
    ? [...pageImageUrls, directImageUrl].filter((url, index, urls) => urls.indexOf(url) === index)
    : pageImageUrls;
  const imageCandidateIndex = Math.min(
    storedImageCandidateIndex,
    Math.max(0, imageCandidates.length - 1),
  );
  const imageUrl = imageCandidates[imageCandidateIndex] || null;
  const pdfUrl = imageUrl ? null : getReachableDocumentUrl(document.preview_url);
  const sourceUrl = getReachableDocumentUrl(document.source_url);
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const handleZoomChange = useCallback((scale: number) => {
    if (document.kind !== "drawing" && scale >= DOCUMENT_HIGH_DETAIL_THRESHOLD) {
      setHighDetail(true);
    }
  }, [document.kind]);

  useEffect(() => {
    setHighDetail(false);
  }, [document.id, document.preview_url, page]);

  useEffect(() => {
    if (imageUrl) {
      setLoadState("loading");
      return;
    }
    if (!pdfUrl) {
      setLoadState("error");
      return;
    }

    setLoadState("loading");
  }, [attempt, imageUrl, pdfUrl]);

  if (loadState === "error") {
    return (
      <div className="field-document-load-state field-document-load-state--error" role="alert">
        <AlertTriangle aria-hidden="true" />
        <h2>{c.documentUnavailable}</h2>
        <p>{c.documentUnavailableHint}</p>
        <div>
          <button
            onClick={() => {
              setImageCandidateState({ index: 0, key: imageCandidateKey });
              setLoadState("loading");
              setAttempt((current) => current + 1);
            }}
            type="button"
          >
            <RotateCcw aria-hidden="true" />{c.documentRetry}
          </button>
          {sourceUrl ? (
            <a href={sourceUrl} rel="noreferrer" target="_blank">
              <ExternalLink aria-hidden="true" />{c.openSource}
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <DocumentPanZoomViewport
        controlsVisible={!interactionLocked && loadState === "ready"}
        language={language}
        onZoomChange={handleZoomChange}
        resetKey={`${document.id}:${document.preview_url ?? ""}:${page}`}
      >
        {imageUrl ? (
          <div className={`field-document-image-preview${interactionLocked ? " is-interaction-locked" : ""}`}>
            <img
              alt={document.original_name || c.workInstruction}
              decoding="async"
              draggable={false}
              key={`${imageUrl}:${attempt}`}
              onError={() => {
                if (imageCandidateIndex + 1 < imageCandidates.length) {
                  setImageCandidateState({
                    index: imageCandidateIndex + 1,
                    key: imageCandidateKey,
                  });
                  setLoadState("loading");
                  return;
                }
                setLoadState("error");
              }}
              onLoad={() => setLoadState("ready")}
              src={imageUrl}
            />
          </div>
        ) : pdfUrl ? (
          <PdfCanvasPreview
            attempt={attempt}
            highDetail={highDetail}
            interactionLocked={interactionLocked}
            onLoadStateChange={setLoadState}
            page={page}
            title={document.original_name || c.workInstruction}
            url={pdfUrl}
          />
        ) : null}
      </DocumentPanZoomViewport>
      <div
        aria-hidden={loadState !== "loading"}
        className={`field-document-load-state${loadState === "loading" ? "" : " is-hidden"}`}
        role={loadState === "loading" ? "status" : undefined}
      >
        <FileText aria-hidden="true" />
        <strong>{c.documentLoading}</strong>
      </div>
      {interactionLocked && loadState === "ready" ? (
        <button
          aria-label={`${c.interactDocument}. ${c.interactDocumentHint}`}
          className="field-document-interaction-gate"
          onClick={onInteract}
          onWheel={(event) => event.preventDefault()}
          type="button"
        >
          <span>
            <FileText aria-hidden="true" />
            <strong>{c.interactDocument}</strong>
            <small>{c.interactDocumentHint}</small>
          </span>
        </button>
      ) : null}
    </>
  );
}

function QualityCanvas({
  snapshot,
  issueIndex,
  language,
  isLoading,
  hasError,
  onIssueComplete,
  rotationPaused,
  unavailableReason,
}: {
  snapshot: FieldKanbanResponse;
  issueIndex: number;
  language: FieldLanguage;
  isLoading: boolean;
  hasError: boolean;
  onIssueComplete: () => void;
  rotationPaused: boolean;
  unavailableReason: string | null;
}) {
  const c = copy[language];
  const issue = snapshot.quality.issues[issueIndex];
  const issueKey = issue?.key ?? "";
  const images = getQualityIssueImages(issue);
  const imageSignature = images.join("|");
  const [photoIndex, setPhotoIndex] = useState(0);
  const [readyPhotoKey, setReadyPhotoKey] = useState("");
  const [failedPhotoUrls, setFailedPhotoUrls] = useState<Set<string>>(() => new Set());
  const displayImages = images.filter((imageUrl) => !failedPhotoUrls.has(imageUrl));
  const activePhotoIndex = displayImages.length ? photoIndex % displayImages.length : 0;
  const activePhotoUrl = displayImages[activePhotoIndex];
  const activePhotoKey = activePhotoUrl ? `${issueKey}|${imageSignature}|${activePhotoUrl}` : "";
  const photoReady = Boolean(activePhotoKey && readyPhotoKey === activePhotoKey);
  const handleActivePhotoFailure = useCallback((photoUrl: string) => {
    setFailedPhotoUrls((current) => new Set(current).add(photoUrl));
    setReadyPhotoKey("");
    if (activePhotoIndex >= displayImages.length - 1) {
      onIssueComplete();
      return;
    }
    // Removing the current item shifts the next valid photo into this slot.
    setPhotoIndex(activePhotoIndex);
  }, [activePhotoIndex, displayImages.length, onIssueComplete]);

  useEffect(() => {
    setPhotoIndex(0);
    setFailedPhotoUrls(new Set());
  }, [issueKey, imageSignature]);

  useEffect(() => {
    if (rotationPaused || !issueKey || (displayImages.length > 0 && !photoReady)) return;
    const timer = window.setTimeout(() => {
      const currentIndex = displayImages.length ? photoIndex % displayImages.length : 0;
      if (currentIndex + 1 < displayImages.length) {
        setPhotoIndex(currentIndex + 1);
        return;
      }
      onIssueComplete();
    }, QUALITY_PHOTO_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [displayImages.length, imageSignature, issueKey, onIssueComplete, photoIndex, photoReady, rotationPaused]);

  useEffect(() => {
    if (!activePhotoUrl || photoReady || rotationPaused) return;
    const timer = window.setTimeout(() => {
      handleActivePhotoFailure(activePhotoUrl);
    }, QUALITY_PHOTO_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [activePhotoUrl, handleActivePhotoFailure, photoReady, rotationPaused]);

  if (!issue) {
    const permissionRequired = unavailableReason === "quality_permission_required" && !isLoading;
    const unavailable = hasError || unavailableReason === "quality_data_unavailable";
    return (
      <article className="field-quality-canvas field-quality-canvas--status">
        <div className="field-quality-canvas__empty">
          {isLoading ? <Loader2 aria-hidden="true" className="is-spinning" /> : unavailable || permissionRequired ? <AlertTriangle aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
          <strong>{isLoading ? c.qualityLoading : permissionRequired ? c.qualityPermissionRequired : unavailable ? c.qualityUnavailable : c.qualityEmpty}</strong>
          <span>{permissionRequired ? c.qualityPermissionHint : unavailable ? c.retry : c.qualityEmptyHint}</span>
        </div>
      </article>
    );
  }
  const disclaimer = snapshot.quality.disclaimer[language] || c.historicalOnly;
  const headline = issue.summary_points
    .map((point) => point[language])
    .find(Boolean)
    || issue.action_result
    || issue.disposition
    || c.noDetail;
  const sectionCounts = issue.section_counts?.length
    ? issue.section_counts.slice(0, 3)
    : issue.section
      ? [{ section: issue.section, evidence_count: issue.evidence_count }]
      : [];
  const verificationLabel = getVerificationLabel(
    issue.verification_status,
    issue.verification_label,
    language,
  );
  return (
    <article className="field-quality-canvas">
      <header>
        <div className="field-quality-canvas__title">
          <div className="field-quality-canvas__heading">
            <h2>{issue.label[language] || issue.key}</h2>
            <div className="field-quality-canvas__eyebrow">
              <span>{c.qualityHistory}</span>
              <em
                className={verificationLabel ? `is-${issue.verification_status}` : "is-history"}
                title={disclaimer}
              >
                <ShieldAlert aria-hidden="true" />
                {verificationLabel || c.historicalReference}
              </em>
            </div>
          </div>
        </div>
        <div className="field-quality-canvas__summary">
          <div className="field-quality-canvas__detail">
            <p className="field-quality-canvas__plan">
              {snapshot.active_plan?.part_no || "-"} · {snapshot.active_plan?.model_name || "-"}
            </p>
            <p className="field-quality-canvas__headline">{headline}</p>
          </div>
          <div className="field-quality-canvas__header-meta">
            <span><small>{c.historicalEvidence}</small><strong>{number(issue.evidence_count)} {c.records}</strong></span>
            {sectionCounts.map((item) => (
              <span className="is-section" key={item.section}>
                <small>{item.section}</small><strong>{number(item.evidence_count)}</strong>
              </span>
            ))}
            <span><small>{c.matchingReports}</small><strong>{number(snapshot.quality.matching_report_count)} {c.records}</strong></span>
            <span><small>{c.latestReport}</small><strong>{formatShortDateTime(issue.latest_report_dt, language)}</strong></span>
          </div>
        </div>
        <div className="field-quality-canvas__issue-position">
          <strong>{issueIndex + 1}</strong><span>/ {snapshot.quality.issues.length}</span>
        </div>
      </header>
      <div className="field-quality-canvas__body">
        {displayImages.length && activePhotoUrl ? (
          <section
            aria-busy={!photoReady}
            aria-label={c.representativePhotos}
            className="field-quality-canvas__gallery"
          >
            <div className="field-quality-canvas__viewport">
              <figure className="field-quality-canvas__active-photo" key={activePhotoKey}>
                <img
                  alt={`${issue.label[language]} ${c.representativePhotos} ${activePhotoIndex + 1}`}
                  decoding="async"
                  onError={() => handleActivePhotoFailure(activePhotoUrl)}
                  onLoad={() => setReadyPhotoKey(activePhotoKey)}
                  src={getOptimizedFieldImageUrl(activePhotoUrl)}
                />
              </figure>
            </div>
            <div className="field-quality-canvas__carousel-controls">
              <strong>{c.representativePhotos} · {activePhotoIndex + 1} / {displayImages.length}</strong>
              <div aria-label={c.representativePhotos} role="tablist">
                {displayImages.map((imageUrl, index) => (
                  <button
                    aria-label={`${c.representativePhotos} ${index + 1}`}
                    aria-selected={activePhotoIndex === index}
                    className={activePhotoIndex === index ? "is-active" : ""}
                    key={`${imageUrl}-selector`}
                    onClick={() => {
                      if (index === activePhotoIndex) return;
                      setPhotoIndex(index);
                    }}
                    role="tab"
                    type="button"
                  ><span /></button>
                ))}
              </div>
            </div>
          </section>
        ) : (
          <div className="field-quality-canvas__empty">
            <ShieldAlert aria-hidden="true" />
            <strong>{c.noRepresentativePhotos}</strong>
            <span>{c.noDetail}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function MaterialsModal({
  documents,
  language,
  onClose,
}: {
  documents: FieldKanbanResponse["documents"];
  language: FieldLanguage;
  onClose: () => void;
}) {
  const c = copy[language];
  return (
    <ModalShell label={c.allMaterials} onEscape={onClose}>
      <header className="field-modal__header">
        <span className="field-modal__icon"><FolderOpen aria-hidden="true" /></span>
        <div><h2>{c.allMaterials}</h2><p>{c.materialReady}</p></div>
        <button aria-label={c.close} className="field-modal__close" onClick={onClose} type="button"><X /></button>
      </header>
      <div className="field-material-list">
        {([
          ["work_instruction", c.workInstruction, documents.work_instruction],
          ["drawing", c.drawing, documents.drawing],
        ] as const).map(([key, label, document]) => (
          <article key={key}>
            <span className={document?.ready ? "is-ready" : "is-missing"}>
              {document?.ready ? <CheckCircle2 /> : <AlertTriangle />}
            </span>
            <div><h3>{label}</h3><p>{document?.original_name || c.noDocument}</p><small>{document?.revision || "-"}</small></div>
            {document?.source_url ? <a href={getReachableDocumentUrl(document.source_url) || undefined} rel="noreferrer" target="_blank"><ExternalLink />{c.openSource}</a> : null}
          </article>
        ))}
      </div>
      <div className="field-modal__actions">
        <button className="field-touch-button field-touch-button--primary" onClick={onClose} type="button">{c.close}</button>
      </div>
    </ModalShell>
  );
}

function FieldClock({ language }: { language: FieldLanguage }) {
  const isPageVisible = usePageVisibility();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    setNow(new Date());
    if (!isPageVisible) return;
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, [isPageVisible]);

  return (
    <div className="field-kanban-clock">
      <Clock3 aria-hidden="true" />
      <div><strong>{formatShanghaiTime(now, language)}</strong><span>{formatShanghaiDate(now, language)}</span></div>
    </div>
  );
}

export default function InjectionKanban({ station, onBack }: { station: FieldStation; onBack: () => void }) {
  const { logout, user } = useAuth();
  const queryClient = useQueryClient();
  const businessDate = useShanghaiBusinessDate();
  const machineNumber = Number(station.machineFilterValue);
  const [language, setLanguage] = useState<FieldLanguage>(() => {
    const stored = readLocalStorage("wj-field-language");
    return stored === "ko" ? "ko" : "zh";
  });
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("work_instruction");
  const [qualityIndex, setQualityIndex] = useState(0);
  const [manualPause, setManualPause] = useState(false);
  const [instructionCycleRevision, setInstructionCycleRevision] = useState(0);
  const [page, setPage] = useState(1);
  const [transitionReview, setTransitionReview] = useState<InjectionTransitionEvent | null>(null);
  const [transitionWorkflow, setTransitionWorkflow] = useState<InjectionTransitionEvent | null>(null);
  const [defectRequest, setDefectRequest] = useState<DefectRequest | null>(null);
  const [resolvedEventKeys, setResolvedEventKeys] = useState<Set<string>>(() => new Set());
  const [resolvedPromptKeys, setResolvedPromptKeys] = useState<Set<string>>(() => new Set());
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [allMaterialsOpen, setAllMaterialsOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const c = copy[language];
  const currentCanvasLabel = canvasMode === "work_instruction"
    ? c.workInstruction
    : canvasMode === "drawing"
      ? c.drawing
      : c.qualityHistory;
  const isPageVisible = usePageVisibility();
  const canEnterDefects = true;

  useEffect(() => {
    writeLocalStorage("wj-field-language", language);
  }, [language]);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  const snapshotQuery = useQuery({
    queryKey: ["field-kanban", businessDate, machineNumber],
    queryFn: () => getFieldKanban(businessDate, machineNumber, { includeQuality: false }),
    refetchInterval: isPageVisible ? 15_000 : false,
    staleTime: 8_000,
    retry: 1,
  });
  const coreKanbanReady = snapshotQuery.isSuccess && Boolean(snapshotQuery.data);
  const [transitionQueriesEnabled, setTransitionQueriesEnabled] = useState(false);
  useEffect(() => {
    setTransitionQueriesEnabled(false);
    if (!coreKanbanReady || !canEnterDefects) return;

    // The full-day MES matrix is only needed for model-change analysis. Give
    // the core Kanban one painted frame before starting that heavier request.
    const timer = window.setTimeout(() => setTransitionQueriesEnabled(true), 1_000);
    return () => window.clearTimeout(timer);
  }, [businessDate, canEnterDefects, coreKanbanReady, machineNumber]);

  const planQuery = useQuery({
    queryKey: ["production-plan-summary", businessDate],
    queryFn: () => getProductionPlanSummary(businessDate),
    enabled: transitionQueriesEnabled,
    staleTime: 30_000,
    refetchInterval: isPageVisible ? 60_000 : false,
  });
  const matrixQuery = useQuery({
    queryKey: ["mes", "injection-production-matrix", businessDate, true, machineNumber],
    queryFn: () => getInjectionProductionMatrix(machineNumber),
    enabled: transitionQueriesEnabled,
    staleTime: 60_000,
    refetchInterval: isPageVisible ? 60_000 : false,
    retry: false,
  });
  const confirmationsQuery = useQuery({
    queryKey: ["production", "injection-downtime-confirmations", businessDate, machineNumber],
    queryFn: () => getFieldInjectionDowntimeConfirmations(businessDate, machineNumber),
    enabled: transitionQueriesEnabled,
    staleTime: 15_000,
    refetchInterval: isPageVisible ? 30_000 : false,
    retry: false,
  });
  const qualityPlanIdentity = snapshotQuery.data?.active_plan
    ? `${snapshotQuery.data.active_plan.plan_id ?? "-"}:${snapshotQuery.data.active_plan.part_no}`
    : "no-plan";
  const qualityQuery = useQuery({
    queryKey: ["field-kanban-quality", businessDate, machineNumber, qualityPlanIdentity],
    queryFn: () => getFieldKanban(businessDate, machineNumber, { includeQuality: true }),
    enabled: coreKanbanReady && Boolean(snapshotQuery.data?.active_plan),
    staleTime: 5 * 60_000,
    refetchInterval: isPageVisible ? 5 * 60_000 : false,
    retry: 1,
  });
  const confirmationMutation = useMutation({ mutationFn: saveFieldInjectionDowntimeConfirmation });

  const transitionAnalysis = useMemo(() => buildInjectionTransitionAnalysis(
    planQuery.data,
    matrixQuery.data,
    businessDate,
  ), [businessDate, matrixQuery.data, planQuery.data]);
  const pendingTransition = useMemo(() => {
    if (!canEnterDefects || !confirmationsQuery.isSuccess) return null;
    const confirmedKeys = new Set((confirmationsQuery.data?.confirmations ?? []).map((item) => item.event_key));
    return transitionAnalysis.events
      .filter((event) => event.machineKey === String(machineNumber))
      .filter((event) => event.type === "mold_change" || event.type === "core_change")
      .filter((event) => !confirmedKeys.has(event.eventKey) && !resolvedEventKeys.has(event.eventKey))
      .sort((left, right) => new Date(right.startTime).getTime() - new Date(left.startTime).getTime())[0] ?? null;
  }, [canEnterDefects, confirmationsQuery.data?.confirmations, confirmationsQuery.isSuccess, machineNumber, resolvedEventKeys, transitionAnalysis.events]);

  useEffect(() => {
    if (!canEnterDefects || !pendingTransition || transitionReview || transitionWorkflow || defectRequest || allMaterialsOpen) return;
    setTransitionError(null);
    setTransitionReview(pendingTransition);
  }, [allMaterialsOpen, canEnterDefects, defectRequest, pendingTransition, transitionReview, transitionWorkflow]);

  const snapshot = useMemo(() => {
    const base = snapshotQuery.data;
    if (!base) return undefined;
    if (!qualityQuery.data) return base;
    return { ...base, quality: qualityQuery.data.quality };
  }, [qualityQuery.data, snapshotQuery.data]);
  const pendingPrompt = snapshot?.pending_prompt;
  useEffect(() => {
    if (
      !canEnterDefects
      || !snapshot?.active_plan
      || !pendingPrompt?.event_key
      || pendingPrompt.is_overdue
      || resolvedPromptKeys.has(pendingPrompt.event_key)
    ) return;
    if (pendingTransition || transitionReview || transitionWorkflow || defectRequest || allMaterialsOpen) return;
    setDefectRequest({
      eventKey: pendingPrompt.event_key,
      trigger: pendingPrompt.trigger,
      blocking: true,
      source: "shift",
      businessDate: pendingPrompt.business_date,
      machineNumber: snapshot.machine.number,
      planId: pendingPrompt.plan_id,
      partNo: pendingPrompt.part_no,
      modelName: pendingPrompt.model_name,
      sequence: pendingPrompt.sequence,
      dueAt: pendingPrompt.due_at,
    });
  }, [allMaterialsOpen, canEnterDefects, defectRequest, pendingPrompt, pendingTransition, resolvedPromptKeys, snapshot, transitionReview, transitionWorkflow]);

  const planIdentity = snapshot?.active_plan
    ? `${snapshot.active_plan.plan_id ?? "-"}:${snapshot.active_plan.part_no}:${snapshot.active_plan.model_name}`
    : "no-plan";
  useEffect(() => {
    setCanvasMode("work_instruction");
    setQualityIndex(0);
    setManualPause(false);
    setInstructionCycleRevision(0);
    setPage(1);
  }, [planIdentity]);

  const modalOpen = Boolean(transitionReview || defectRequest || allMaterialsOpen);
  const qualityIssueCount = snapshot?.quality.issues.length ?? 0;
  const qualityIssueCountRef = useRef(qualityIssueCount);
  qualityIssueCountRef.current = qualityIssueCount;
  const rotationPaused = !isPageVisible || manualPause || modalOpen || canvasMode === "drawing" || !snapshot?.active_plan;
  useEffect(() => {
    if (canvasMode === "quality" && qualityIssueCount > 0 && qualityIndex >= qualityIssueCount) {
      setQualityIndex(0);
    }
  }, [canvasMode, qualityIndex, qualityIssueCount]);

  useEffect(() => {
    if (rotationPaused || canvasMode !== "work_instruction") return;
    const timer = window.setTimeout(() => {
      if (qualityIssueCountRef.current > 0) {
        setQualityIndex(0);
        setCanvasMode("quality");
        return;
      }
      // No quality history yet: keep the instruction visible and check again
      // after another full instruction interval without resetting on refetch.
      setInstructionCycleRevision((value) => value + 1);
    }, WORK_INSTRUCTION_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [canvasMode, instructionCycleRevision, planIdentity, rotationPaused]);

  const completeQualityIssue = useCallback(() => {
    if (qualityIndex + 1 < qualityIssueCount) {
      setQualityIndex((value) => value + 1);
      return;
    }
    setQualityIndex(0);
    setCanvasMode("work_instruction");
  }, [qualityIndex, qualityIssueCount]);

  const displayedDocument = canvasMode === "drawing"
    ? snapshot?.documents.drawing ?? null
    : snapshot?.documents.work_instruction ?? null;
  const documentInteractionLocked = Boolean(
    displayedDocument?.preview_url && canvasMode === "work_instruction" && !manualPause,
  );
  const pageCount = displayedDocument?.page_count;
  const freshnessSeconds = getFreshnessSeconds(snapshot?.machine.latest_mes_time, new Date());
  const progress = Math.max(0, Math.min(100, snapshot?.active_plan?.progress_rate ?? 0));
  // Keep the active plan centered in the production-day sequence: at most
  // two completed/earlier plans, the active plan, and two following plans.
  const queueSource = snapshot?.queue?.length
    ? snapshot.queue
    : [snapshot?.active_plan, snapshot?.next_plan].filter(Boolean) as FieldQueuePlan[];
  const queue = getFieldQueueWindow(queueSource, snapshot?.active_plan ?? null);
  const documentsReady = Boolean(snapshot?.documents.work_instruction?.ready && snapshot?.documents.drawing?.ready);

  function chooseCanvasMode(nextMode: CanvasMode) {
    setPage(1);
    setCanvasMode(nextMode);
    setQualityIndex(0);
    // Drawing is intentionally manual-only. Returning to either automatic
    // tab starts a fresh cycle from the operator's selected view.
    setManualPause(nextMode === "drawing");
  }

  function openManualDefect() {
    if (!canEnterDefects) {
      setToastMessage(defectErrorCopy[language].permission_denied);
      return;
    }
    if (!snapshot?.active_plan) {
      setToastMessage(c.noPlan);
      return;
    }
    if (pendingPrompt?.event_key && !resolvedPromptKeys.has(pendingPrompt.event_key)) {
      setDefectRequest({
        eventKey: pendingPrompt.event_key,
        trigger: pendingPrompt.trigger,
        blocking: false,
        source: "shift",
        businessDate: pendingPrompt.business_date,
        machineNumber: snapshot.machine.number,
        planId: pendingPrompt.plan_id,
        partNo: pendingPrompt.part_no,
        modelName: pendingPrompt.model_name,
        sequence: pendingPrompt.sequence,
        dueAt: pendingPrompt.due_at,
      });
      return;
    }
    const plan = snapshot.active_plan;
    setDefectRequest({
      eventKey: `manual:${snapshot.business_date}:${snapshot.machine.number}:${Date.now()}`,
      trigger: "manual",
      blocking: false,
      source: "manual",
      businessDate: snapshot.business_date,
      machineNumber: snapshot.machine.number,
      planId: plan.plan_id,
      partNo: plan.part_no,
      modelName: plan.model_name,
      sequence: plan.sequence,
    });
  }

  async function dismissTransition() {
    if (!transitionReview) return;
    setTransitionError(null);
    const transitionBusinessDate = getTransitionBusinessDate(transitionReview, businessDate);
    try {
      await confirmationMutation.mutateAsync(buildConfirmationPayload(transitionReview, transitionBusinessDate, "dismissed", language));
      setResolvedEventKeys((current) => new Set(current).add(transitionReview.eventKey));
      setTransitionReview(null);
      await queryClient.invalidateQueries({ queryKey: ["production", "injection-downtime-confirmations", transitionBusinessDate] });
    } catch (error) {
      setTransitionError(getErrorMessage(error, c.confirmationFailed));
    }
  }

  function beginTransitionDefect() {
    if (!transitionReview) return;
    if (!canEnterDefects) {
      setTransitionError(defectErrorCopy[language].permission_denied);
      return;
    }
    const event = transitionReview;
    const transitionBusinessDate = getTransitionBusinessDate(event, businessDate);
    const previousPlan = event.fromRecord;
    const previousPlanId = previousPlan?.id ?? null;
    const previousPartNo = String(previousPlan?.part_no ?? "").trim();
    if (previousPlanId === null && !previousPartNo) {
      setTransitionError(c.previousPlanIdentityMissing);
      return;
    }
    setTransitionWorkflow(event);
    setTransitionReview(null);
    setDefectRequest({
      eventKey: `defect:part-change:${event.eventKey}`,
      trigger: "part_change",
      blocking: true,
      source: "transition",
      businessDate: transitionBusinessDate,
      machineNumber,
      planId: previousPlanId,
      partNo: previousPartNo,
      modelName: String(previousPlan?.model_name || previousPlan?.part_spec || "").trim(),
      sequence: previousPlan?.sequence ?? null,
    });
  }

  async function completeDefect() {
    if (!defectRequest) return;
    setCompletionError(null);
    try {
      if (transitionWorkflow) {
        await confirmationMutation.mutateAsync(buildConfirmationPayload(transitionWorkflow, defectRequest.businessDate, "confirmed", language));
        setResolvedEventKeys((current) => new Set(current).add(transitionWorkflow.eventKey));
        await queryClient.invalidateQueries({ queryKey: ["production", "injection-downtime-confirmations", defectRequest.businessDate] });
      } else if (defectRequest.source === "shift") {
        setResolvedPromptKeys((current) => new Set(current).add(defectRequest.eventKey));
      }
      setDefectRequest(null);
      setTransitionWorkflow(null);
      await queryClient.invalidateQueries({ queryKey: ["field-kanban", businessDate, machineNumber] });
    } catch (error) {
      setCompletionError(getErrorMessage(error, c.confirmationFailed));
    }
  }

  function openPendingTransition() {
    if (!confirmationsQuery.isSuccess) {
      setToastMessage(c.confirmationDataPending);
      return;
    }
    if (pendingTransition) {
      setTransitionError(null);
      setTransitionReview(pendingTransition);
    } else {
      setToastMessage(c.noPendingChange);
    }
  }

  if (snapshotQuery.isLoading && !snapshot) {
    return (
      <div className="field-kanban-state">
        <Factory aria-hidden="true" />
        <h1>{c.loading}</h1>
      </div>
    );
  }

  if (snapshotQuery.isError && !snapshot) {
    return (
      <div className="field-kanban-state field-kanban-state--error">
        <AlertTriangle aria-hidden="true" />
        <h1>{c.loadError}</h1>
        <p>{getErrorMessage(snapshotQuery.error, c.loadError)}</p>
        <button onClick={() => void snapshotQuery.refetch()} type="button"><RotateCcw />{c.retry}</button>
        <button onClick={onBack} type="button"><ArrowLeft />{c.stationSelect}</button>
      </div>
    );
  }

  if (!snapshot) return null;

  const transitionDataReady = !canEnterDefects || confirmationsQuery.isSuccess;
  const alertTone = pendingTransition
    ? "warning"
    : pendingPrompt
      ? "danger"
      : !documentsReady
        ? "warning"
        : !transitionDataReady
          ? "warning"
        : "info";
  const alertText = pendingTransition
    ? c.changeDetected
    : pendingPrompt
      ? c.defectDue
      : !documentsReady
        ? c.missingMaterialAlert
        : !transitionDataReady
          ? c.confirmationDataPending
          : null;

  return (
    <div
      className="field-kanban"
      data-language={language}
      data-read-only={canEnterDefects ? "false" : "true"}
    >
      <div className="field-kanban-stage">
        <header className="field-kanban-header">
        <button aria-label={c.stationSelect} className="field-kanban-brand" onClick={onBack} type="button">
          <img alt="WJ" src="/logo-transparent.png" />
          <span><strong>WJ DATA CENTER</strong><small>{c.brandSubtitle}</small></span>
        </button>
        <div className="field-kanban-machine">
          <Factory aria-hidden="true" />
          <strong>{c.injection} {String(machineNumber).padStart(2, "0")}{language === "zh" ? "号机" : "호기"}</strong>
        </div>
        <div className={`field-kanban-live${snapshot.machine.is_stale ? " is-stale" : ""}`}>
          <Radio aria-hidden="true" />
          <strong>{snapshot.machine.is_stale ? c.offline : c.online}</strong>
          <span>· {freshnessSeconds === null ? c.noSignal : `${freshnessSeconds} ${c.secondsAgo}`}</span>
        </div>
        <FieldClock language={language} />
        <div className="field-kanban-header-actions">
          {user ? <button aria-label={c.stationSelect} onClick={onBack} type="button"><ArrowLeft /></button> : null}
          {user ? <button aria-label={c.logout} onClick={logout} type="button"><LogOut /></button> : null}
          <div className="field-language-toggle" role="group" aria-label={language === "zh" ? "语言" : "언어"}>
            <button aria-pressed={language === "zh"} className={language === "zh" ? "is-active" : ""} onClick={() => setLanguage("zh")} type="button">中文</button>
            <button aria-pressed={language === "ko"} className={language === "ko" ? "is-active" : ""} onClick={() => setLanguage("ko")} type="button">KOR</button>
          </div>
        </div>
        </header>

        <main className="field-kanban-main">
        <aside className="field-command-panel">
          <section className="field-shot-hero">
            <span>
              {c.shiftShots}
              <small>{snapshot.counters.shift_code === "night" ? c.nightShiftWindow : c.dayShiftWindow}</small>
            </span>
            <strong>{number(snapshot.counters.shift_shots)}</strong>
          </section>
          <section className="field-part-summary">
            <div><span>{c.model}</span><strong>{snapshot.active_plan?.model_name || "-"}</strong></div>
            <div><span>{c.partNo} <small>Part No.</small></span><strong>{snapshot.active_plan?.part_no || "-"}</strong></div>
          </section>
          <section className="field-current-metrics">
            <div><span>{c.currentPlanShots}</span><strong>{number(snapshot.counters.current_plan_shots)} <small>{c.shots}</small></strong></div>
            <div><span>{c.theoretical}</span><strong>{number(snapshot.counters.theoretical_piece_qty)} <small>{c.pieces}</small></strong></div>
            <div><span>{c.progress}</span><strong>{Math.round(progress)}<small>%</small></strong><i><b style={{ width: `${progress}%` }} /></i></div>
          </section>
          <section className={`field-queue${queue.length >= 4 ? " is-expanded" : ""}`}>
            <h2>{c.workQueue}</h2>
            <div className="field-queue-list">
              {queue.map(({ plan, position }, visibleIndex) => (
                <article
                  aria-label={`${visibleIndex + 1} / ${queue.length}`}
                  aria-current={position === "current" ? "step" : undefined}
                  className={`is-${position}`}
                  key={`${plan.plan_date}:${plan.plan_id ?? `${plan.sequence}:${plan.part_no}:${plan.lot_no}`}`}
                >
                  <span className="field-queue-index">{visibleIndex + 1}</span>
                  {visibleIndex < queue.length - 1 ? <Triangle aria-hidden="true" className="field-queue-flow" /> : null}
                  <div className="field-queue-copy">
                    <strong>{plan.part_no || "-"}</strong>
                    <div className="field-queue-meta">
                      <time dateTime={plan.plan_date}>{formatQueueDate(plan.plan_date, language)}</time>
                      <span>{plan.model_name || "-"}</span>
                    </div>
                  </div>
                  <div className="field-queue-value">
                    <small>{c.queueOutput}</small>
                    <strong>{number(plan.actual_piece_qty)} / {number(plan.planned_piece_qty)}</strong>
                  </div>
                </article>
              ))}
            </div>
          </section>
          {canEnterDefects ? (
            <section className="field-command-actions">
              <button className="is-change" onClick={openPendingTransition} type="button"><ClipboardCheck />{c.confirmChange}</button>
              <button className="is-defect" onClick={openManualDefect} type="button"><AlertTriangle />{c.inputDefect}</button>
            </section>
          ) : null}
        </aside>

        <section
          aria-label={currentCanvasLabel}
          className={`field-content-panel${canvasMode === "quality" ? " is-quality" : ""}${alertText ? " has-alert" : ""}`}
        >
          {alertText ? (
            <div className={`field-alert-band field-alert-band--${alertTone}`} role="status">
              <AlertTriangle aria-hidden="true" />
              <strong>{alertText}</strong>
              {pendingPrompt?.due_at ? <span>{c.due} {formatShortDateTime(pendingPrompt.due_at, language)} {pendingPrompt.is_overdue ? `· ${c.overdue}` : ""}</span> : null}
              {!transitionDataReady && alertText !== c.confirmationDataPending ? <span>{c.confirmationDataPending}</span> : null}
            </div>
          ) : null}
          <div className="field-document-toolbar">
            <div className="field-document-tabs" role="tablist" aria-label={c.allMaterials}>
              <button
                aria-selected={canvasMode === "work_instruction"}
                className={`is-work${canvasMode === "work_instruction" ? " is-active" : ""}`}
                disabled={!snapshot.active_plan}
                onClick={() => chooseCanvasMode("work_instruction")}
                role="tab"
                type="button"
              >{c.workInstruction}</button>
              <button
                aria-selected={canvasMode === "quality"}
                className={`is-quality${canvasMode === "quality" ? " is-active" : ""}`}
                disabled={!snapshot.active_plan}
                onClick={() => chooseCanvasMode("quality")}
                role="tab"
                type="button"
              >{c.qualityHistory}</button>
              <button
                aria-selected={canvasMode === "drawing"}
                className={`is-drawing${canvasMode === "drawing" ? " is-active" : ""}`}
                disabled={!snapshot.active_plan}
                onClick={() => chooseCanvasMode("drawing")}
                role="tab"
                type="button"
              >{c.drawing}</button>
            </div>
          </div>

          <div className="field-document-canvas">
            {!snapshot.active_plan ? (
              <div className="field-document-empty"><Factory /><h2>{c.noPlan}</h2><p>{c.noPlanHint}</p></div>
            ) : canvasMode === "quality" ? (
              <QualityCanvas
                hasError={qualityQuery.isError}
                isLoading={qualityQuery.isPending || (qualityQuery.isFetching && qualityIssueCount === 0)}
                issueIndex={qualityIndex}
                language={language}
                onIssueComplete={completeQualityIssue}
                rotationPaused={rotationPaused}
                snapshot={snapshot}
                unavailableReason={snapshot.quality.unavailable_reason}
              />
            ) : displayedDocument?.preview_url ? (
              <FieldDocumentPreview
                document={displayedDocument}
                interactionLocked={documentInteractionLocked}
                language={language}
                onInteract={() => setManualPause(true)}
                page={page}
              />
            ) : (
              <DocumentEmptyState document={displayedDocument} language={language} />
            )}
          </div>

          <footer className={`field-material-footer${canvasMode !== "quality" && displayedDocument?.preview_url ? " has-page-nav" : ""}`}>
            <div className={documentsReady ? "is-ready" : "is-missing"}>
              <FileText aria-hidden="true" />
              <strong>{documentsReady ? c.materialReady : c.materialMissing}:</strong>
              <span>{c.workInstruction} {snapshot.documents.work_instruction?.ready ? <CheckCircle2 /> : <AlertTriangle />}</span>
              <span>{c.drawing} {snapshot.documents.drawing?.ready ? <CheckCircle2 /> : <AlertTriangle />}</span>
            </div>
            {canvasMode !== "quality" && displayedDocument?.preview_url ? (
              <nav aria-label={`${c.previousPage} / ${c.nextPage}`} className="field-document-page-nav">
                <button aria-label={c.previousPage} disabled={page <= 1} onClick={() => { setManualPause(true); setPage((value) => Math.max(1, value - 1)); }} type="button"><ChevronLeft /></button>
                <span>{page}{pageCount ? ` / ${pageCount}` : ""}</span>
                <button aria-label={c.nextPage} disabled={!pageCount || page >= pageCount} onClick={() => { setManualPause(true); setPage((value) => value + 1); }} type="button"><ChevronRight /></button>
              </nav>
            ) : null}
            <button onClick={() => setAllMaterialsOpen(true)} type="button"><FolderOpen />{c.viewAll}<ChevronRight /></button>
          </footer>
        </section>
        </main>
      </div>

      {toastMessage ? <div className="field-kanban-toast" role="status">{toastMessage}</div> : null}
      {transitionReview ? (
        <TransitionModal
          error={transitionError}
          event={transitionReview}
          language={language}
          onConfirm={beginTransitionDefect}
          onDismiss={() => void dismissTransition()}
          saving={confirmationMutation.isPending}
        />
      ) : null}
      {defectRequest ? (
        <DefectModal
          completionBusy={confirmationMutation.isPending}
          completionError={completionError}
          language={language}
          onCancel={() => setDefectRequest(null)}
          onComplete={completeDefect}
          request={defectRequest}
        />
      ) : null}
      {allMaterialsOpen ? <MaterialsModal documents={snapshot.documents} language={language} onClose={() => setAllMaterialsOpen(false)} /> : null}
    </div>
  );
}
