import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  Maximize2,
  Minus,
  Plus,
  Radio,
  RotateCcw,
  ShieldAlert,
  X,
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
  getInjectionDowntimeConfirmations,
  getProductionPlanSummary,
  saveInjectionDowntimeConfirmation,
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
const DEFAULT_DOCUMENT_ZOOM = 125;

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
    currentShots: "当前合模数",
    model: "型号",
    partNo: "品号",
    currentPlanShots: "当前作业合模数",
    theoretical: "理论产出（当前作业）",
    progress: "计划完成进度",
    pieces: "件",
    shots: "模次",
    records: "条",
    workQueue: "作业队列",
    currentJob: "当前作业",
    nextJob: "下一作业",
    plannedChange: "预计换型时间",
    noNext: "暂无下一作业",
    confirmChange: "确认换型",
    inputDefect: "输入不良",
    workInstruction: "作业指导书",
    drawing: "图纸",
    qualityHistory: "品质Issue",
    noPlan: "本机当前没有生产计划",
    noPlanHint: "计划下发后，这里会自动显示对应型号、品号和现场资料。",
    noDocument: "尚未补充对应资料",
    noDocumentHint: "请在“开发 > 现场资料补充”上传 PDF 预览文件。",
    sourceOnly: "原始文件已上传，仍需补充 PDF 预览",
    openSource: "打开原始文件",
    previousPage: "上一页",
    nextPage: "下一页",
    previousContent: "上一项资料",
    nextContent: "下一项资料",
    page: "页",
    autoPlaying: "自动轮播中",
    autoPaused: "轮播已暂停",
    resume: "继续轮播",
    pause: "暂停轮播",
    instructionCycle: "指导书 60 秒",
    qualityCycle: "每项品质Issue 30 秒",
    viewAll: "查看全部资料",
    materialReady: "资料完整",
    materialMissing: "资料待补充",
    historicalOnly: "历史记录提醒，不表示当前正在发生不良。",
    historicalEvidence: "关联记录",
    latestReport: "最近报告",
    issueSummary: "现场重点",
    representativePhotos: "代表照片",
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
    cycleAlert: "作业指导书 60 秒 / 品质Issue 每项 30 秒自动轮播",
    interactDocument: "操作文档",
    interactDocumentHint: "点击后暂停轮播，可缩放、翻页或滚动查看。",
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
    currentShots: "현재 형합수",
    model: "모델",
    partNo: "품번",
    currentPlanShots: "현재 작업 형합수",
    theoretical: "이론 생산수(현재 작업)",
    progress: "계획 완료율",
    pieces: "개",
    shots: "회",
    records: "건",
    workQueue: "작업 대기열",
    currentJob: "현재 작업",
    nextJob: "다음 작업",
    plannedChange: "예상 모델체인지",
    noNext: "다음 작업 없음",
    confirmChange: "모델체인지 확인",
    inputDefect: "불량 입력",
    workInstruction: "작업지도서",
    drawing: "도면",
    qualityHistory: "품질Issue",
    noPlan: "현재 이 설비의 생산계획이 없습니다",
    noPlanHint: "계획이 배포되면 모델, 품번, 현장 자료가 자동으로 표시됩니다.",
    noDocument: "해당 자료가 아직 없습니다",
    noDocumentHint: "‘개발 > 현장 자료 보충’에서 PDF 미리보기를 올려 주세요.",
    sourceOnly: "원본은 업로드되었지만 PDF 미리보기가 필요합니다",
    openSource: "원본 파일 열기",
    previousPage: "이전 페이지",
    nextPage: "다음 페이지",
    previousContent: "이전 자료",
    nextContent: "다음 자료",
    page: "페이지",
    autoPlaying: "자동 순환 중",
    autoPaused: "자동 순환 일시정지",
    resume: "순환 계속",
    pause: "순환 정지",
    instructionCycle: "작업지도서 60초",
    qualityCycle: "품질 이슈별 30초",
    viewAll: "전체 자료 보기",
    materialReady: "자료 완비",
    materialMissing: "자료 보충 필요",
    historicalOnly: "이력 기반 참고이며 현재 불량 발생을 뜻하지 않습니다.",
    historicalEvidence: "연관 이력",
    latestReport: "최근 보고",
    issueSummary: "현장 핵심",
    representativePhotos: "대표 사진",
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
    cycleAlert: "작업지도서 60초 / 품질Issue별 30초 자동 순환",
    interactDocument: "문서 조작",
    interactDocumentHint: "누르면 자동 순환이 멈추며 확대·페이지 이동·스크롤을 사용할 수 있습니다.",
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
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(Number(value) || 0)));
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

function formatShanghaiTime(value: Date, language: FieldLanguage) {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "ko-KR", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function formatShanghaiDate(value: Date, language: FieldLanguage) {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "ko-KR", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(value);
}

function formatShortDateTime(value: string | null | undefined, language: FieldLanguage) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "ko-KR", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function formatShortTime(value: string | null | undefined, language: FieldLanguage) {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "-" : formatShanghaiTime(parsed, language);
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

function getDocumentUrl(document: FieldDocument | null, page: number, zoom: number) {
  const reachableUrl = getReachableDocumentUrl(document?.preview_url);
  if (!reachableUrl) return null;
  const base = reachableUrl.split("#")[0];
  return `${base}#page=${Math.max(1, page)}&zoom=${Math.max(50, zoom)}&pagemode=none&navpanes=0`;
}

function isImagePreview(value: string | null | undefined) {
  if (!value) return false;
  try {
    return /\.(?:avif|jpe?g|png|webp)$/i.test(new URL(value, window.location.origin).pathname);
  } catch {
    return false;
  }
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
  const sourceOnly = Boolean(document?.source_url && !document.preview_url);
  const sourceUrl = getReachableDocumentUrl(document?.source_url);
  return (
    <div className="field-document-empty">
      <FileText aria-hidden="true" />
      <h2>{sourceOnly ? c.sourceOnly : c.noDocument}</h2>
      <p>{c.noDocumentHint}</p>
      {sourceOnly && sourceUrl ? (
        <a href={sourceUrl} rel="noreferrer" target="_blank">
          <ExternalLink aria-hidden="true" />{c.openSource}
        </a>
      ) : null}
    </div>
  );
}

function QualityCanvas({
  snapshot,
  issueIndex,
  language,
}: {
  snapshot: FieldKanbanResponse;
  issueIndex: number;
  language: FieldLanguage;
}) {
  const c = copy[language];
  const issue = snapshot.quality.issues[issueIndex];
  if (!issue) return null;
  const disclaimer = snapshot.quality.disclaimer[language] || c.historicalOnly;
  const summaryPoints = issue.summary_points
    .map((point) => point[language])
    .filter(Boolean)
    .slice(0, 3);
  const fallbackPoints = [issue.action_result, issue.disposition, issue.section].filter(Boolean).slice(0, 3);
  const points = summaryPoints.length ? summaryPoints : fallbackPoints;
  const images = Array.from(new Set([
    ...issue.image_urls,
    ...(issue.image_url ? [issue.image_url] : []),
  ])).slice(0, 3);
  const verificationLabel = getVerificationLabel(
    issue.verification_status,
    issue.verification_label,
    language,
  );
  return (
    <article className="field-quality-canvas">
      <header>
        <div>
          <div className="field-quality-canvas__eyebrow">
            <span>{c.qualityHistory}</span>
            {verificationLabel ? (
              <em className={`is-${issue.verification_status}`}>
                <ShieldAlert aria-hidden="true" />
                {verificationLabel}
              </em>
            ) : null}
          </div>
          <h2>{issue.label[language] || issue.key}</h2>
          <p>{snapshot.active_plan?.part_no || "-"} · {snapshot.active_plan?.model_name || "-"}</p>
        </div>
        <strong>{issueIndex + 1} / {snapshot.quality.issues.length}</strong>
      </header>
      <div className={`field-quality-canvas__body${images.length ? " has-image" : ""}`}>
        <section className="field-quality-canvas__summary">
          <h3><ShieldAlert aria-hidden="true" />{c.issueSummary}</h3>
          <ol>
            {(points.length ? points : [c.noDetail]).map((point, index) => (
              <li key={`${issue.key}-summary-${index}`}><span>{index + 1}</span><strong>{point}</strong></li>
            ))}
          </ol>
          <div className="field-quality-canvas__meta">
            <span><strong>{c.historicalEvidence}</strong>{number(issue.evidence_count)} {c.records}</span>
            <span><strong>{c.latestReport}</strong>{formatShortDateTime(issue.latest_report_dt, language)}</span>
            {issue.source_document || issue.source_model ? (
              <span>
                <strong>{c.sourceMaterial}</strong>
                {[issue.source_model, issue.source_document].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </div>
        </section>
        {images.length ? (
          <section className={`field-quality-canvas__gallery has-${images.length}`} aria-label={c.representativePhotos}>
            {images.map((imageUrl, index) => (
              <figure key={imageUrl}>
                <img alt={`${issue.label[language]} ${c.representativePhotos} ${index + 1}`} src={imageUrl} />
                <figcaption>{index === 0 ? c.representativePhotos : `${index + 1}`}</figcaption>
              </figure>
            ))}
          </section>
        ) : null}
      </div>
      <footer>
        <AlertTriangle aria-hidden="true" />
        <strong>{disclaimer}</strong>
      </footer>
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

export default function InjectionKanban({ station, onBack }: { station: FieldStation; onBack: () => void }) {
  const { logout, user, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const businessDate = useShanghaiBusinessDate();
  const machineNumber = Number(station.machineFilterValue);
  const [language, setLanguage] = useState<FieldLanguage>(() => {
    const stored = window.localStorage.getItem("wj-field-language");
    return stored === "ko" ? "ko" : "zh";
  });
  const [now, setNow] = useState(() => new Date());
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("work_instruction");
  const [qualityIndex, setQualityIndex] = useState(0);
  const [_rotationSeconds, setRotationSeconds] = useState(60);
  const [manualPause, setManualPause] = useState(false);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(DEFAULT_DOCUMENT_ZOOM);
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
  const canEnterDefects = Boolean(
    user?.is_staff
    || hasPermission("is_admin")
    || hasPermission("can_edit_injection"),
  );

  useEffect(() => {
    window.localStorage.setItem("wj-field-language", language);
  }, [language]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  const snapshotQuery = useQuery({
    queryKey: ["field-kanban", businessDate, machineNumber],
    queryFn: () => getFieldKanban(businessDate, machineNumber, { includeQuality: false }),
    refetchInterval: 15_000,
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
    refetchInterval: 60_000,
  });
  const matrixQuery = useQuery({
    queryKey: ["mes", "injection-production-matrix", businessDate, true, machineNumber],
    queryFn: () => getInjectionProductionMatrix(machineNumber),
    enabled: transitionQueriesEnabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const confirmationsQuery = useQuery({
    queryKey: ["production", "injection-downtime-confirmations", businessDate],
    queryFn: () => getInjectionDowntimeConfirmations(businessDate),
    enabled: transitionQueriesEnabled,
    staleTime: 15_000,
    refetchInterval: 30_000,
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
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
  const confirmationMutation = useMutation({ mutationFn: saveInjectionDowntimeConfirmation });

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
    setRotationSeconds(60);
    setManualPause(false);
    setPage(1);
    setZoom(DEFAULT_DOCUMENT_ZOOM);
  }, [planIdentity]);

  const modalOpen = Boolean(transitionReview || defectRequest || allMaterialsOpen);
  const qualityIssueCount = snapshot?.quality.issues.length ?? 0;
  const rotationPaused = manualPause || modalOpen || canvasMode === "drawing" || !snapshot?.active_plan;
  useEffect(() => {
    if (qualityIssueCount === 0 && canvasMode === "quality") {
      setCanvasMode("work_instruction");
      setQualityIndex(0);
      setRotationSeconds(60);
    } else if (canvasMode === "quality" && qualityIndex >= qualityIssueCount) {
      setQualityIndex(0);
      setRotationSeconds(30);
    }
  }, [canvasMode, qualityIndex, qualityIssueCount]);

  useEffect(() => {
    if (rotationPaused) return;
    const timer = window.setInterval(() => {
      setRotationSeconds((current) => {
        if (current > 1) return current - 1;
        if (canvasMode === "work_instruction") {
          if (qualityIssueCount > 0) {
            setQualityIndex(0);
            setCanvasMode("quality");
            return 30;
          }
          return 60;
        }
        if (canvasMode === "quality") {
          if (qualityIndex + 1 < qualityIssueCount) {
            setQualityIndex((value) => value + 1);
            return 30;
          }
          setQualityIndex(0);
          setCanvasMode("work_instruction");
          return 60;
        }
        return 60;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [canvasMode, qualityIndex, qualityIssueCount, rotationPaused]);

  const displayedDocument = canvasMode === "drawing"
    ? snapshot?.documents.drawing ?? null
    : snapshot?.documents.work_instruction ?? null;
  const documentUrl = getDocumentUrl(displayedDocument, page, zoom);
  const documentIsImage = isImagePreview(displayedDocument?.preview_url);
  const documentInteractionLocked = Boolean(
    documentUrl && canvasMode === "work_instruction" && !manualPause,
  );
  const pageCount = displayedDocument?.page_count;
  const freshnessSeconds = getFreshnessSeconds(snapshot?.machine.latest_mes_time, now);
  const progress = Math.max(0, Math.min(100, snapshot?.active_plan?.progress_rate ?? 0));
  const queue = snapshot?.queue.length
    ? snapshot.queue
    : [snapshot?.active_plan, snapshot?.next_plan].filter(Boolean) as NonNullable<FieldKanbanResponse["active_plan"]>[];
  const documentsReady = Boolean(snapshot?.documents.work_instruction?.ready && snapshot?.documents.drawing?.ready);

  function chooseCanvasMode(mode: CanvasMode) {
    setCanvasMode(mode);
    setQualityIndex(0);
    setRotationSeconds(mode === "quality" ? 30 : 60);
    setManualPause(true);
    setPage(1);
    setZoom(mode === "work_instruction" ? DEFAULT_DOCUMENT_ZOOM : 100);
  }

  function stepCanvas(direction: -1 | 1) {
    const carouselLength = qualityIssueCount + 1;
    const currentIndex = canvasMode === "quality" ? qualityIndex + 1 : 0;
    const nextIndex = (currentIndex + direction + carouselLength) % carouselLength;

    setManualPause(true);
    setPage(1);
    if (nextIndex === 0) {
      setCanvasMode("work_instruction");
      setQualityIndex(0);
      setRotationSeconds(60);
      setZoom(DEFAULT_DOCUMENT_ZOOM);
      return;
    }

    setCanvasMode("quality");
    setQualityIndex(nextIndex - 1);
    setRotationSeconds(30);
    setZoom(100);
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
        : c.cycleAlert;

  return (
    <div className="field-kanban" data-language={language}>
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
        <div className="field-kanban-clock">
          <Clock3 aria-hidden="true" />
          <div><strong>{formatShanghaiTime(now, language)}</strong><span>{formatShanghaiDate(now, language)}</span></div>
        </div>
        <div className="field-kanban-header-actions">
          <button aria-label={c.stationSelect} onClick={onBack} type="button"><ArrowLeft /></button>
          <button aria-label={c.logout} onClick={logout} type="button"><LogOut /></button>
          <div className="field-language-toggle" role="group" aria-label={language === "zh" ? "语言" : "언어"}>
            <button aria-pressed={language === "zh"} className={language === "zh" ? "is-active" : ""} onClick={() => setLanguage("zh")} type="button">中文</button>
            <button aria-pressed={language === "ko"} className={language === "ko" ? "is-active" : ""} onClick={() => setLanguage("ko")} type="button">KOR</button>
          </div>
        </div>
      </header>

      <main className="field-kanban-main">
        <aside className="field-command-panel">
          <section className="field-shot-hero">
            <span>{c.currentShots}</span>
            <strong>{number(snapshot.machine.device_counter ?? snapshot.counters.business_day_shots)}</strong>
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
          <section className="field-queue">
            <h2>{c.workQueue}</h2>
            <div className="field-queue-list">
              {queue.slice(0, 2).map((plan, index) => (
                <article className={index === 0 ? "is-current" : ""} key={`${plan.plan_id ?? index}:${plan.part_no}`}>
                  <span className="field-queue-index">{index + 1}</span>
                  <div className="field-queue-copy"><small>{index === 0 ? c.currentJob : c.nextJob}</small><strong>{plan.part_no || "-"}</strong><span>{plan.model_name || "-"}</span></div>
                  <div className="field-queue-value">
                    <small>{index === 0 ? c.currentShots : c.plannedChange}</small>
                    {index === 0 ? (
                      <>
                        <strong>{number(plan.allocated_shots)} / {number(plan.planned_piece_qty)}</strong>
                        <span>{c.shots} / {c.pieces}</span>
                      </>
                    ) : (
                      <strong>{snapshot.machine.estimated_change_at
                        ? formatShortTime(snapshot.machine.estimated_change_at, language)
                        : (plan.status || c.noNext)}</strong>
                    )}
                  </div>
                </article>
              ))}
              {queue.length < 2 ? (
                <article className="is-empty"><span className="field-queue-index">2</span><div className="field-queue-copy"><small>{c.nextJob}</small><strong>{c.noNext}</strong></div></article>
              ) : null}
            </div>
          </section>
          <section className="field-command-actions">
            <button className="is-change" disabled={!canEnterDefects} onClick={openPendingTransition} type="button"><ClipboardCheck />{c.confirmChange}</button>
            <button className="is-defect" disabled={!canEnterDefects} onClick={openManualDefect} type="button"><AlertTriangle />{c.inputDefect}</button>
          </section>
        </aside>

        <section className={`field-content-panel${canvasMode === "quality" ? " is-quality" : ""}`}>
          <div className={`field-alert-band field-alert-band--${alertTone}`}>
            <AlertTriangle aria-hidden="true" />
            <strong>{alertText}</strong>
            {pendingPrompt?.due_at ? <span>{c.due} {formatShortDateTime(pendingPrompt.due_at, language)} {pendingPrompt.is_overdue ? `· ${c.overdue}` : ""}</span> : null}
            {!transitionDataReady && alertText !== c.confirmationDataPending ? <span>{c.confirmationDataPending}</span> : null}
          </div>
          <div className={`field-document-toolbar${canvasMode === "quality" ? " is-quality" : ""}`}>
            <div className="field-document-tabs" role="tablist">
              <button aria-selected={canvasMode === "work_instruction"} className={canvasMode === "work_instruction" ? "is-active" : ""} onClick={() => chooseCanvasMode("work_instruction")} role="tab" type="button">{c.workInstruction}</button>
              <button aria-selected={canvasMode === "drawing"} className={canvasMode === "drawing" ? "is-active" : ""} onClick={() => chooseCanvasMode("drawing")} role="tab" type="button">{c.drawing}</button>
              {qualityIssueCount > 0 ? <button aria-selected={canvasMode === "quality"} className={canvasMode === "quality" ? "is-active is-quality" : "is-quality"} onClick={() => chooseCanvasMode("quality")} role="tab" type="button">{c.qualityHistory}</button> : null}
            </div>
            <div aria-label={`${c.previousContent} / ${c.nextContent}`} className="field-cycle-nav" role="group">
              <button aria-label={c.previousContent} disabled={qualityIssueCount === 0} onClick={() => stepCanvas(-1)} type="button"><ChevronLeft /></button>
              <button aria-label={c.nextContent} disabled={qualityIssueCount === 0} onClick={() => stepCanvas(1)} type="button"><ChevronRight /></button>
            </div>
            {canvasMode !== "quality" ? (
              <div className="field-document-controls" role="group">
                <button aria-label="zoom out" onClick={() => { setManualPause(true); setZoom((value) => Math.max(50, value - 10)); }} type="button"><Minus /></button>
                <strong>{zoom}%</strong>
                <button aria-label="zoom in" onClick={() => { setManualPause(true); setZoom((value) => Math.min(180, value + 10)); }} type="button"><Plus /></button>
                <button aria-label={c.previousPage} disabled={page <= 1} onClick={() => { setManualPause(true); setPage((value) => Math.max(1, value - 1)); }} type="button"><ChevronLeft /></button>
                <span>{page}{pageCount ? ` / ${pageCount}` : ""}</span>
                <button aria-label={c.nextPage} disabled={Boolean(pageCount && page >= pageCount)} onClick={() => { setManualPause(true); setPage((value) => value + 1); }} type="button"><ChevronRight /></button>
                {displayedDocument?.source_url ? <a aria-label={c.openSource} href={getReachableDocumentUrl(displayedDocument.source_url) || undefined} rel="noreferrer" target="_blank"><Maximize2 /></a> : null}
              </div>
            ) : null}
          </div>

          <div className="field-document-canvas" onPointerDown={() => setManualPause(true)}>
            {!snapshot.active_plan ? (
              <div className="field-document-empty"><Factory /><h2>{c.noPlan}</h2><p>{c.noPlanHint}</p></div>
            ) : canvasMode === "quality" ? (
              <QualityCanvas issueIndex={qualityIndex} language={language} snapshot={snapshot} />
            ) : documentUrl ? (
              <>
                {documentIsImage ? (
                  <div className={`field-document-image-preview${documentInteractionLocked ? " is-interaction-locked" : ""}`}>
                    <img
                      alt={displayedDocument?.original_name || c.workInstruction}
                      src={documentUrl.split("#")[0]}
                      style={{ width: `${zoom}%` }}
                    />
                  </div>
                ) : (
                  <iframe
                    className={documentInteractionLocked ? "is-interaction-locked" : undefined}
                    key={documentUrl}
                    src={documentUrl}
                    tabIndex={documentInteractionLocked ? -1 : 0}
                    title={displayedDocument?.original_name || c.workInstruction}
                  />
                )}
                {documentInteractionLocked ? (
                  <button
                    aria-label={`${c.interactDocument}. ${c.interactDocumentHint}`}
                    className="field-document-interaction-gate"
                    onClick={() => setManualPause(true)}
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
            ) : (
              <DocumentEmptyState document={displayedDocument} language={language} />
            )}
          </div>

          <footer className="field-material-footer">
            <div className={documentsReady ? "is-ready" : "is-missing"}>
              <FileText aria-hidden="true" />
              <strong>{documentsReady ? c.materialReady : c.materialMissing}:</strong>
              <span>{c.workInstruction} {snapshot.documents.work_instruction?.ready ? <CheckCircle2 /> : <AlertTriangle />}</span>
              <span>{c.drawing} {snapshot.documents.drawing?.ready ? <CheckCircle2 /> : <AlertTriangle />}</span>
            </div>
            <button onClick={() => setAllMaterialsOpen(true)} type="button"><FolderOpen />{c.viewAll}<ChevronRight /></button>
          </footer>
        </section>
      </main>

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
