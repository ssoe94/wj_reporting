import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Clock3,
  Factory,
  FileCheck2,
  FileText,
  FileUp,
  Eye,
  ListOrdered,
  Loader2,
  MonitorUp,
  RefreshCw,
  Share2,
  UploadCloud,
  X,
} from "lucide-react";

import {
  getFieldMaterials,
  repairFieldMaterialPreview,
  uploadFieldMaterial,
  type FieldDocument,
  type FieldMaterialMachineSchedule,
  type FieldMaterialMatchRule,
  type FieldMaterialModel,
  type FieldMaterialsResponse,
  type FieldMaterialSchedulePlan,
} from "@/domains/field/api";
import {
  getProductionStatus,
  type ProductionStatusPart,
  type ProductionStatusResponse,
} from "@/domains/production/api";
import { useAuth } from "@/contexts/AuthContext";
import { useLang } from "@/i18n";
import { useModalFocusTrap } from "@/shared/hooks/useModalFocusTrap";
import { useShanghaiBusinessDate } from "@/shared/hooks/useShanghaiBusinessDate";

import "./FieldMaterialsPage.css";

type MaterialKind = FieldDocument["kind"];
const PPT_AUTO_CONVERSION_LIMIT = 10 * 1024 * 1024;

const pageCopy = {
  ko: {
    eyebrow: "개발 · 현장 지원",
    title: "현장 칸반 자료관리",
    description: "오늘 사출 계획을 호기와 작업 순서대로 보면서 현재·완료·대기 작업의 작업지도서와 도면을 관리합니다.",
    businessDate: "상하이 업무일",
    refresh: "새로고침",
    totalModels: "오늘 계획 모델",
    completeModels: "자료 완비",
    missingModels: "보충 필요",
    plannedMachines: "계획 호기",
    loading: "오늘 계획 모델과 자료 상태를 불러오는 중입니다.",
    error: "현장 자료 현황을 불러오지 못했습니다.",
    empty: "오늘 사출 계획에 등록된 모델이 없습니다.",
    machine: "사출기",
    model: "모델",
    partNo: "Part No.",
    planned: "계획 수량",
    instruction: "작업지도서",
    drawing: "도면",
    ready: "현장 준비 완료",
    missing: "미등록",
    previewMissing: "PDF 미리보기 필요",
    converting: "현장 미리보기 생성 중",
    conversionFailed: "미리보기 생성 실패",
    upload: "업로드",
    replace: "교체 업로드",
    repairPreview: "미리보기 복구",
    repairingPreview: "복구 중…",
    repairReady: "현장용 미리보기를 복구했습니다.",
    repairPending: "PPT 변환을 다시 시작했습니다.",
    repairFailed: "미리보기를 복구하지 못했습니다.",
    modalTitleInstruction: "작업지도서 업로드",
    modalTitleDrawing: "도면 업로드",
    modalHintInstruction: "PDF, PPT 또는 PPTX 파일 하나만 올리면 됩니다. PPT/PPTX는 현장용 화면으로 자동 변환합니다.",
    modalHintDrawing: "도면은 PDF 파일 하나만 올리면 됩니다.",
    revision: "개정번호",
    revisionPlaceholder: "예: Rev. C",
    uploadFile: "업로드 파일",
    chooseFile: "파일 선택",
    changeFile: "파일 바꾸기",
    dropFile: "파일을 여기에 놓거나 눌러서 선택",
    dropActive: "여기에 파일을 놓아 주세요",
    acceptedInstruction: "PDF · PPT · PPTX 중 파일 1개",
    acceptedDrawing: "PDF 파일 1개",
    singleFileOnly: "파일은 한 번에 하나만 올려 주세요.",
    noFile: "선택된 파일 없음",
    cancel: "취소",
    uploading: "업로드 중…",
    submit: "자료 업로드",
    uploadSuccess: "현장 자료를 업로드했습니다.",
    uploadConverting: "PPT 원본을 업로드했습니다. 현장용 미리보기를 변환하고 있습니다.",
    uploadConversionFailed: "PPT 원본은 저장했지만 자동 변환을 시작하지 못했습니다. 같은 자료를 PDF로 저장한 뒤 PDF 한 파일로 다시 올려 주세요.",
    uploadError: "현장 자료 업로드에 실패했습니다.",
    invalidDrawing: "도면은 PDF 파일만 선택해 주세요.",
    invalidInstruction: "작업지도서는 PDF, PPT, PPTX 파일만 선택해 주세요.",
    pptWarning: "PPT/PPTX는 업로드 후 현장용 화면으로 자동 변환됩니다.",
    pptTooLarge: "파일이 10MB를 초과합니다. PDF로 변환해서 올려 주세요.",
    machinesUnit: "호기",
    pieces: "개",
    noRevision: "개정번호 없음",
    scheduleTitle: "호기별 생산 순서와 자료 준비도",
    scheduleDescription: "각 호기의 Sequence 순서와 현재 위치, 현장 자료 누락을 한눈에 확인합니다.",
    sequence: "순서",
    completed: "완료",
    current: "현재 작업",
    waiting: "대기",
    actual: "실적",
    progress: "진행률",
    lot: "LOT",
    planCount: "개 작업",
    sharedRule: "끝 두 자리 공유",
    sharedFrom: "공유 출처",
    shareLastTwo: "품번 끝 두 자리 공유",
    shareLastTwoHint: "마지막 두 자리만 다른 같은 품번 Family에도 이 자료를 함께 적용합니다.",
    exactMatchHint: "선택하지 않으면 현재 품번에만 정확히 적용됩니다.",
    readOnly: "읽기 전용",
    permissionDenied: "현장 칸반 자료를 조회할 권한이 없습니다.",
  },
  zh: {
    eyebrow: "开发 · 现场支持",
    title: "现场看板资料管理",
    description: "按注塑机与作业顺序查看今日计划，并管理当前、已完成和待生产作业的作业指导书与图纸。",
    businessDate: "上海业务日",
    refresh: "刷新",
    totalModels: "今日计划型号",
    completeModels: "资料完整",
    missingModels: "待补充",
    plannedMachines: "计划机台",
    loading: "正在读取今日计划型号和资料状态。",
    error: "无法读取现场资料状态。",
    empty: "今日注塑计划中没有登记型号。",
    machine: "注塑机",
    model: "型号",
    partNo: "品号",
    planned: "计划数量",
    instruction: "作业指导书",
    drawing: "图纸",
    ready: "现场可用",
    missing: "未登记",
    previewMissing: "需要 PDF 预览",
    converting: "现场预览生成中",
    conversionFailed: "预览生成失败",
    upload: "上传",
    replace: "替换上传",
    repairPreview: "修复预览",
    repairingPreview: "修复中…",
    repairReady: "现场预览已修复。",
    repairPending: "已重新启动 PPT 转换。",
    repairFailed: "无法修复预览。",
    modalTitleInstruction: "上传作业指导书",
    modalTitleDrawing: "上传图纸",
    modalHintInstruction: "只需上传一个 PDF、PPT 或 PPTX 文件；PPT/PPTX 会自动转换为现场画面。",
    modalHintDrawing: "图纸只需上传一个 PDF 文件。",
    revision: "修订号",
    revisionPlaceholder: "例如：Rev. C",
    uploadFile: "上传文件",
    chooseFile: "选择文件",
    changeFile: "更换文件",
    dropFile: "将文件拖放到此处，或点击选择",
    dropActive: "请将文件放在这里",
    acceptedInstruction: "PDF · PPT · PPTX，仅限 1 个文件",
    acceptedDrawing: "PDF，仅限 1 个文件",
    singleFileOnly: "一次只能上传一个文件。",
    noFile: "未选择文件",
    cancel: "取消",
    uploading: "上传中…",
    submit: "上传资料",
    uploadSuccess: "现场资料已上传。",
    uploadConverting: "PPT 原件已上传，正在生成现场预览。",
    uploadConversionFailed: "PPT 原件已保存，但无法启动自动转换。请将同一资料另存为 PDF 后，仅上传该 PDF 文件。",
    uploadError: "现场资料上传失败。",
    invalidDrawing: "图纸只能选择 PDF 文件。",
    invalidInstruction: "作业指导书只能选择 PDF、PPT 或 PPTX 文件。",
    pptWarning: "PPT/PPTX 上传后会自动转换为现场画面。",
    pptTooLarge: "文件超过 10MB，请转换为 PDF 后再上传。",
    machinesUnit: "号机",
    pieces: "件",
    noRevision: "无修订号",
    scheduleTitle: "各机台生产顺序与资料状态",
    scheduleDescription: "集中确认各机台的 Sequence、当前作业位置及现场资料缺失情况。",
    sequence: "顺序",
    completed: "已完成",
    current: "当前作业",
    waiting: "等待",
    actual: "实绩",
    progress: "进度",
    lot: "LOT",
    planCount: "个作业",
    sharedRule: "末两位共享",
    sharedFrom: "共享来源",
    shareLastTwo: "品号末两位共享",
    shareLastTwoHint: "将此资料同时应用到仅末两位不同的同一品号 Family。",
    exactMatchHint: "未选择时，仅精确应用于当前品号。",
    readOnly: "只读",
    permissionDenied: "没有查看现场看板资料的权限。",
  },
} as const;

function number(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value || 0)));
}

function buildFallbackMachineSchedules(models: FieldMaterialModel[]): FieldMaterialMachineSchedule[] {
  const grouped = new Map<number, FieldMaterialSchedulePlan[]>();
  for (const model of models) {
    for (const machineNumber of model.machine_numbers) {
      const plans = grouped.get(machineNumber) ?? [];
      plans.push({
        ...model,
        machine_numbers: [machineNumber],
        plan_id: null,
        sequence: plans.length + 1,
        source_sequence: plans.length + 1,
        display_order: plans.length + 1,
        lot_no: "",
        actual_quantity: 0,
        progress: 0,
        mes_estimated_status: null,
        status: "waiting",
        is_current: false,
        is_completed: false,
      });
      grouped.set(machineNumber, plans);
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([machineNumber, plans]) => ({
      machine_number: machineNumber,
      machine_label: `${String(machineNumber).padStart(2, "0")}号机`,
      plans,
    }));
}

function uniqueScheduleModels(schedules: FieldMaterialMachineSchedule[]) {
  const unique = new Map<string, FieldMaterialModel>();
  for (const schedule of schedules) {
    for (const plan of schedule.plans) {
      const key = `${plan.part_no.trim().toUpperCase()}::${plan.model_name.trim().toUpperCase()}`;
      if (!unique.has(key)) unique.set(key, plan);
    }
  }
  return [...unique.values()];
}

function productionMachineNumber(value: string) {
  const normalized = value.trim();
  const tonnageMatch = normalized.match(/T\s*[-–—]?\s*(\d{1,2})(?:\s*(?:호기|号机))?$/i);
  const endMatch = normalized.match(/(\d{1,2})\s*(?:호기|号机)?$/i);
  const machineNumber = Number(tonnageMatch?.[1] ?? endMatch?.[1]);
  return Number.isInteger(machineNumber) && machineNumber >= 1 && machineNumber <= 17
    ? machineNumber
    : null;
}

function productionPartStatus(part: ProductionStatusPart) {
  return String(part.status || "").trim().toLowerCase();
}

function mergeProductionStatus(
  schedules: FieldMaterialMachineSchedule[],
  productionStatus: ProductionStatusResponse | undefined,
): FieldMaterialMachineSchedule[] {
  if (!productionStatus) return schedules;

  const statusByPlanId = new Map<number, ProductionStatusPart>();
  const currentPlanByMachine = new Map<number, number | null>();

  for (const machine of productionStatus.injection) {
    const machineNumber = productionMachineNumber(machine.machine_name);
    if (!machineNumber) continue;
    const orderedParts = machine.parts
      .map((part, index) => ({ part, index, planId: Number(part.plan_id) }))
      .filter((item) => Number.isInteger(item.planId) && item.planId > 0)
      .sort((left, right) => {
        const leftSequence = Number(left.part.sequence);
        const rightSequence = Number(right.part.sequence);
        const leftOrder = Number.isFinite(leftSequence) && leftSequence > 0 ? leftSequence : Number.MAX_SAFE_INTEGER;
        const rightOrder = Number.isFinite(rightSequence) && rightSequence > 0 ? rightSequence : Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.index - right.index;
      });
    if (orderedParts.length === 0) continue;

    for (const { part, planId } of orderedParts) statusByPlanId.set(planId, part);
    const currentPart = orderedParts.find(({ part }) => productionPartStatus(part) === "in_progress")
      ?? orderedParts.find(({ part }) => productionPartStatus(part) === "pending");
    currentPlanByMachine.set(machineNumber, currentPart?.planId ?? null);
  }

  return schedules.map((schedule) => {
    const hasLiveMachineStatus = currentPlanByMachine.has(schedule.machine_number);
    const currentPlanId = currentPlanByMachine.get(schedule.machine_number) ?? null;
    return {
      ...schedule,
      plans: schedule.plans.map((plan) => {
        const livePart = plan.plan_id === null ? undefined : statusByPlanId.get(plan.plan_id);
        const liveStatus = livePart ? productionPartStatus(livePart) : "";
        const isCompleted = livePart ? liveStatus === "completed" : plan.is_completed;
        const isCurrent = hasLiveMachineStatus
          ? !isCompleted && plan.plan_id !== null && plan.plan_id === currentPlanId
          : plan.is_current;
        return {
          ...plan,
          actual_quantity: livePart ? Number(livePart.actual_quantity || 0) : plan.actual_quantity,
          progress: livePart ? Math.max(0, Number(livePart.progress || 0)) : plan.progress,
          mes_estimated_status: liveStatus || plan.mes_estimated_status,
          status: isCompleted ? "completed" : isCurrent ? "current" : "waiting",
          is_current: isCurrent,
          is_completed: isCompleted,
        } satisfies FieldMaterialSchedulePlan;
      }),
    };
  });
}

function getErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== "object") return fallback;
  const data = (error as { response?: { data?: unknown } }).response?.data;
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    const detail = (data as { detail?: unknown; error?: unknown }).detail
      ?? (data as { error?: unknown }).error;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return fallback;
}

function isPdf(file: File | null) {
  if (!file) return false;
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isPpt(file: File | null) {
  if (!file) return false;
  const name = file.name.toLowerCase();
  return name.endsWith(".ppt") || name.endsWith(".pptx");
}

function formatFileSize(size: number) {
  const megabytes = size / (1024 * 1024);
  if (megabytes >= 1) return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function DocumentStatus({
  document,
  ready,
  language,
}: {
  document: FieldDocument | null;
  ready: boolean;
  language: "ko" | "zh";
}) {
  const c = pageCopy[language];
  const converting = document?.conversion_status === "pending";
  const conversionFailed = document?.conversion_status === "failed";
  const needsPreview = Boolean(document && !ready && !converting && !conversionFailed);
  const statusClass = ready
    ? "is-ready"
    : converting
      ? "is-converting"
      : conversionFailed || needsPreview
        ? "is-preview-missing"
        : "is-missing";
  const statusLabel = ready
    ? c.ready
    : converting
      ? c.converting
      : conversionFailed
        ? c.conversionFailed
        : needsPreview
          ? c.previewMissing
          : c.missing;
  return (
    <div className={`field-material-document-status ${statusClass}`}>
      <span>{ready ? <CheckCircle2 /> : converting ? <Loader2 className="is-spinning" /> : <AlertTriangle />}</span>
      <div>
        <strong>{statusLabel}</strong>
        <small>{document?.original_name || "-"}</small>
        <span className="field-material-document-meta">
          <em>{document?.revision || c.noRevision}</em>
          {document?.match_basis === "part_family_last_two" ? (
            <b>
              <Share2 />{c.sharedRule}
              {document.matched_from_part_no ? ` · ${c.sharedFrom} ${document.matched_from_part_no}` : ""}
            </b>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function SchedulePlanCard({
  canEdit,
  language,
  onRepair,
  plan,
  onUpload,
  repairingDocumentId,
}: {
  canEdit: boolean;
  language: "ko" | "zh";
  plan: FieldMaterialSchedulePlan;
  onRepair: (document: FieldDocument) => void;
  onUpload: (kind: MaterialKind, model: FieldMaterialModel) => void;
  repairingDocumentId: string | null;
}) {
  const c = pageCopy[language];
  const statusLabel = plan.status === "completed" ? c.completed : plan.status === "current" ? c.current : c.waiting;
  const StatusIcon = plan.status === "completed" ? CheckCircle2 : plan.status === "current" ? CircleDot : Clock3;
  const progress = Math.min(100, Math.max(0, plan.progress));
  const sourceSequence = plan.source_sequence > 0 ? plan.source_sequence : null;
  const workInstructionNeedsRepair = Boolean(
    plan.work_instruction
    && plan.work_instruction.repairable
    && !plan.readiness.work_instruction
    && plan.work_instruction.conversion_status !== "pending",
  );
  const drawingNeedsRepair = Boolean(
    plan.drawing
    && plan.drawing.repairable
    && !plan.readiness.drawing
    && plan.drawing.conversion_status !== "pending",
  );
  return (
    <article className={`field-material-plan-card is-${plan.status}`}>
      <header>
        <span className="field-material-sequence">
          <ListOrdered />{c.sequence} {plan.display_order}
          {sourceSequence && sourceSequence !== plan.display_order ? ` · Seq ${sourceSequence}` : ""}
        </span>
        <strong className="field-material-plan-status"><StatusIcon />{statusLabel}</strong>
      </header>
      <div className="field-material-plan-identity">
        <strong>{plan.model_name || "-"}</strong>
        <span>{plan.part_no || "-"}</span>
        {plan.lot_no ? <small>{c.lot} {plan.lot_no}</small> : null}
      </div>
      <div className="field-material-plan-metrics">
        <span>{c.planned}<strong>{number(plan.planned_quantity)}<small>{c.pieces}</small></strong></span>
        <span>{c.actual}<strong>{number(plan.actual_quantity)}<small>{c.pieces}</small></strong></span>
        <span>{c.progress}<strong>{number(progress)}<small>%</small></strong></span>
      </div>
      <div className="field-material-plan-progress" aria-label={`${c.progress} ${number(progress)}%`}>
        <i style={{ width: `${progress}%` }} />
      </div>
      <div className="field-material-plan-documents">
        <section className={plan.readiness.work_instruction ? "is-ready" : "is-missing"}>
          <h3>{c.instruction}</h3>
          <DocumentStatus document={plan.work_instruction} language={language} ready={plan.readiness.work_instruction} />
          {canEdit && workInstructionNeedsRepair && plan.work_instruction ? (
            <button
              className="is-repair"
              disabled={Boolean(repairingDocumentId)}
              onClick={() => onRepair(plan.work_instruction as FieldDocument)}
              type="button"
            >
              <RefreshCw className={repairingDocumentId === plan.work_instruction.id ? "is-spinning" : ""} />
              {repairingDocumentId === plan.work_instruction.id ? c.repairingPreview : c.repairPreview}
            </button>
          ) : null}
          {canEdit ? <button disabled={Boolean(repairingDocumentId)} onClick={() => onUpload("work_instruction", plan)} type="button"><FileUp />{plan.work_instruction ? c.replace : c.upload}</button> : null}
        </section>
        <section className={plan.readiness.drawing ? "is-ready" : "is-missing"}>
          <h3>{c.drawing}</h3>
          <DocumentStatus document={plan.drawing} language={language} ready={plan.readiness.drawing} />
          {canEdit && drawingNeedsRepair && plan.drawing ? (
            <button
              className="is-repair"
              disabled={Boolean(repairingDocumentId)}
              onClick={() => onRepair(plan.drawing as FieldDocument)}
              type="button"
            >
              <RefreshCw className={repairingDocumentId === plan.drawing.id ? "is-spinning" : ""} />
              {repairingDocumentId === plan.drawing.id ? c.repairingPreview : c.repairPreview}
            </button>
          ) : null}
          {canEdit ? <button disabled={Boolean(repairingDocumentId)} onClick={() => onUpload("drawing", plan)} type="button"><FileUp />{plan.drawing ? c.replace : c.upload}</button> : null}
        </section>
      </div>
    </article>
  );
}

function UploadDialog({
  kind,
  model,
  language,
  onClose,
}: {
  kind: MaterialKind;
  model: FieldMaterialModel;
  language: "ko" | "zh";
  onClose: () => void;
}) {
  const c = pageCopy[language];
  const queryClient = useQueryClient();
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const currentDocument = kind === "work_instruction" ? model.work_instruction : model.drawing;
  const [revision, setRevision] = useState(currentDocument?.revision || "");
  const [matchRule, setMatchRule] = useState<FieldMaterialMatchRule>("exact");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const uploadMutation = useMutation({ mutationFn: uploadFieldMaterial });
  const isInstruction = kind === "work_instruction";
  const uploadDialogRef = useModalFocusTrap<HTMLFormElement>({
    onEscape: uploadMutation.isPending ? undefined : onClose,
  });

  function selectSourceFile(file: File | null) {
    setSuccess(null);
    setLocalError(null);
    if (!file) {
      setSourceFile(null);
      return;
    }
    if (!isInstruction && !isPdf(file)) {
      setLocalError(c.invalidDrawing);
      return;
    }
    if (isInstruction && !isPdf(file) && !isPpt(file)) {
      setLocalError(c.invalidInstruction);
      return;
    }
    if (isInstruction && isPpt(file) && file.size > PPT_AUTO_CONVERSION_LIMIT) {
      setLocalError(c.pptTooLarge);
      toast.error(c.pptTooLarge);
      return;
    }
    setSourceFile(file);
  }

  function selectDroppedFiles(files: FileList | null) {
    if (!files?.length) return;
    if (files.length !== 1) {
      setSuccess(null);
      setLocalError(c.singleFileOnly);
      return;
    }
    selectSourceFile(files[0]);
  }

  function enterDropZone(event: React.DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (uploadMutation.isPending) return;
    dragDepthRef.current += 1;
    setIsDraggingFile(true);
  }

  function leaveDropZone(event: React.DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFile(false);
  }

  function dropFile(event: React.DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFile(false);
    if (uploadMutation.isPending) return;
    selectDroppedFiles(event.dataTransfer.files);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError(null);
    setSuccess(null);
    if (!sourceFile) {
      setLocalError(c.noFile);
      return;
    }
    if (!isInstruction && !isPdf(sourceFile)) {
      setLocalError(c.invalidDrawing);
      return;
    }
    if (isInstruction && !isPdf(sourceFile) && !isPpt(sourceFile)) {
      setLocalError(c.invalidInstruction);
      return;
    }
    if (isInstruction && isPpt(sourceFile) && sourceFile.size > PPT_AUTO_CONVERSION_LIMIT) {
      setLocalError(c.pptTooLarge);
      return;
    }
    try {
      const uploadedDocument = await uploadMutation.mutateAsync({
        kind,
        partNo: model.part_no,
        modelName: model.model_name,
        revision,
        matchRule,
        file: sourceFile,
      });
      await queryClient.invalidateQueries({ queryKey: ["field-materials"] });
      if (uploadedDocument?.conversion_status === "failed" && !uploadedDocument.ready) {
        setLocalError(c.uploadConversionFailed);
        return;
      }
      setSuccess(uploadedDocument?.conversion_status === "pending" ? c.uploadConverting : c.uploadSuccess);
      window.setTimeout(onClose, uploadedDocument?.conversion_status === "pending" ? 1_200 : 700);
    } catch (error) {
      setLocalError(getErrorMessage(error, c.uploadError));
    }
  }

  return (
    <div className="field-material-upload-backdrop" role="presentation">
      <form
        aria-label={isInstruction ? c.modalTitleInstruction : c.modalTitleDrawing}
        aria-modal="true"
        className="field-material-upload-dialog"
        onSubmit={submit}
        ref={uploadDialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <span><UploadCloud /></span>
          <div>
            <h2>{isInstruction ? c.modalTitleInstruction : c.modalTitleDrawing}</h2>
            <p>{isInstruction ? c.modalHintInstruction : c.modalHintDrawing}</p>
          </div>
          <button aria-label={c.cancel} disabled={uploadMutation.isPending} onClick={onClose} type="button"><X /></button>
        </header>

        <div className="field-material-upload-context">
          <div><span>{c.partNo}</span><strong>{model.part_no || "-"}</strong></div>
          <div><span>{c.model}</span><strong>{model.model_name || "-"}</strong></div>
          <div><span>{c.machine}</span><strong>{model.machine_numbers.map((item) => `${item}${c.machinesUnit}`).join(", ") || "-"}</strong></div>
        </div>

        <div className="field-material-upload-fields">
          <label>
            <span>{c.revision}</span>
            <input data-modal-initial-focus maxLength={80} onChange={(event) => setRevision(event.target.value)} placeholder={c.revisionPlaceholder} type="text" value={revision} />
          </label>
          <label className="field-material-match-rule">
            <input
              checked={matchRule === "part_family_last_two"}
              onChange={(event) => setMatchRule(event.target.checked ? "part_family_last_two" : "exact")}
              type="checkbox"
            />
            <span aria-hidden="true"><i /></span>
            <div>
              <strong><Share2 />{c.shareLastTwo}</strong>
              <small>{c.shareLastTwoHint}</small>
              <em>{c.exactMatchHint}</em>
            </div>
          </label>
          <div className="field-material-file-field">
            <span>{c.uploadFile}</span>
            <input
              accept={isInstruction ? ".pdf,.ppt,.pptx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation" : ".pdf,application/pdf"}
              aria-hidden="true"
              disabled={uploadMutation.isPending}
              onChange={(event) => {
                selectDroppedFiles(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
              ref={sourceInputRef}
              tabIndex={-1}
              type="file"
            />
            <button
              aria-label={sourceFile ? `${c.changeFile}: ${sourceFile.name}` : c.dropFile}
              className={`field-material-file-drop${isDraggingFile ? " is-dragging" : ""}${sourceFile ? " has-file" : ""}`}
              disabled={uploadMutation.isPending}
              onClick={() => sourceInputRef.current?.click()}
              onDragEnter={enterDropZone}
              onDragLeave={leaveDropZone}
              onDragOver={(event) => {
                event.preventDefault();
                if (!uploadMutation.isPending) event.dataTransfer.dropEffect = "copy";
              }}
              onDrop={dropFile}
              type="button"
            >
              <span className="field-material-file-drop__icon">
                {sourceFile ? <FileCheck2 /> : <UploadCloud />}
              </span>
              <span className="field-material-file-drop__copy">
                <strong>{isDraggingFile ? c.dropActive : sourceFile?.name || c.dropFile}</strong>
                <small>
                  {sourceFile
                    ? `${sourceFile.name.split(".").pop()?.toUpperCase() || "FILE"} · ${formatFileSize(sourceFile.size)}`
                    : isInstruction ? c.acceptedInstruction : c.acceptedDrawing}
                </small>
              </span>
              <em>{sourceFile ? c.changeFile : c.chooseFile}</em>
            </button>
          </div>
          {isInstruction && isPpt(sourceFile) ? (
            <div className="field-material-ppt-warning"><FileCheck2 />{c.pptWarning}</div>
          ) : null}
        </div>

        {localError ? <div className="field-material-upload-message is-error" role="alert">{localError}</div> : null}
        {success ? <div className="field-material-upload-message is-success" role="status">{success}</div> : null}

        <footer>
          <button className="is-cancel" disabled={uploadMutation.isPending} onClick={onClose} type="button">{c.cancel}</button>
          <button className="is-submit" disabled={uploadMutation.isPending} type="submit">
            {uploadMutation.isPending ? <Loader2 className="is-spinning" /> : <UploadCloud />}
            {uploadMutation.isPending ? c.uploading : c.submit}
          </button>
        </footer>
      </form>
    </div>
  );
}

export default function FieldMaterialsPage() {
  const { lang } = useLang();
  const { hasPermission, user } = useAuth();
  const language = lang === "zh" ? "zh" : "ko";
  const c = pageCopy[language];
  const businessDate = useShanghaiBusinessDate();
  const canViewMaterials = Boolean(user && (user.is_staff || hasPermission("can_view_development")));
  const canEditMaterials = Boolean(user && (user.is_staff || hasPermission("can_edit_development")));
  const [uploadTarget, setUploadTarget] = useState<{ kind: MaterialKind; model: FieldMaterialModel } | null>(null);
  const queryClient = useQueryClient();
  const repairMutation = useMutation({
    mutationFn: repairFieldMaterialPreview,
    onSuccess: async (document) => {
      await queryClient.invalidateQueries({ queryKey: ["field-materials"] });
      if (document.ready) toast.success(c.repairReady);
      else if (document.conversion_status === "pending") toast.info(c.repairPending);
      else toast.error(c.repairFailed);
    },
    onError: (error) => toast.error(getErrorMessage(error, c.repairFailed)),
  });
  const materialsQuery = useQuery({
    queryKey: ["field-materials", businessDate],
    queryFn: () => getFieldMaterials(businessDate),
    enabled: canViewMaterials,
    staleTime: 30_000,
    refetchInterval: (query) => {
      const data = query.state.data as FieldMaterialsResponse | undefined;
      const hasPendingConversion = data?.models.some((item) => (
        item.work_instruction?.conversion_status === "pending"
        || item.drawing?.conversion_status === "pending"
      ));
      return hasPendingConversion ? 10_000 : 5 * 60_000;
    },
  });
  const productionStatusQuery = useQuery({
    queryKey: ["production-status", businessDate],
    queryFn: () => getProductionStatus(businessDate),
    enabled: canViewMaterials && materialsQuery.isSuccess,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const models = useMemo(() => materialsQuery.data?.models ?? [], [materialsQuery.data?.models]);
  const materialSchedules = useMemo(() => {
    const serverSchedules = materialsQuery.data?.machine_schedules ?? [];
    return serverSchedules.length > 0 ? serverSchedules : buildFallbackMachineSchedules(models);
  }, [materialsQuery.data?.machine_schedules, models]);
  const schedules = useMemo(
    () => mergeProductionStatus(materialSchedules, productionStatusQuery.data),
    [materialSchedules, productionStatusQuery.data],
  );
  const summaryModels = useMemo(
    () => models.length > 0 ? models : uniqueScheduleModels(schedules),
    [models, schedules],
  );
  const summary = useMemo(() => {
    const complete = summaryModels.filter((item) => item.readiness.complete).length;
    return {
      total: summaryModels.length,
      complete,
      missing: summaryModels.length - complete,
      machines: schedules.length,
    };
  }, [schedules.length, summaryModels]);

  return (
    <div className="field-materials-page">
      <header className="field-materials-hero">
        <span className="field-materials-hero__icon"><MonitorUp /></span>
        <div>
          <small>{c.eyebrow}</small>
          <h1>{c.title}</h1>
          <p>{c.description}</p>
        </div>
        <div className="field-materials-hero__actions">
          {canViewMaterials && !canEditMaterials ? <span className="field-materials-readonly"><Eye /><strong>{c.readOnly}</strong></span> : null}
          <span>{c.businessDate}<strong>{businessDate}</strong></span>
          <button
            disabled={!canViewMaterials || materialsQuery.isFetching || productionStatusQuery.isFetching}
            onClick={() => {
              void materialsQuery.refetch();
              if (materialsQuery.data) void productionStatusQuery.refetch();
            }}
            type="button"
          >
            <RefreshCw className={materialsQuery.isFetching || productionStatusQuery.isFetching ? "is-spinning" : ""} />{c.refresh}
          </button>
        </div>
      </header>

      <section className="field-materials-summary" aria-label={c.title}>
        <article><span><FileText /></span><div><small>{c.totalModels}</small><strong>{number(summary.total)}</strong></div></article>
        <article className="is-complete"><span><FileCheck2 /></span><div><small>{c.completeModels}</small><strong>{number(summary.complete)}</strong></div></article>
        <article className="is-missing"><span><AlertTriangle /></span><div><small>{c.missingModels}</small><strong>{number(summary.missing)}</strong></div></article>
        <article className="is-machines"><span><Factory /></span><div><small>{c.plannedMachines}</small><strong>{number(summary.machines)}</strong></div></article>
      </section>

      {!canViewMaterials ? (
        <div className="field-materials-state is-error"><AlertTriangle /><strong>{c.permissionDenied}</strong></div>
      ) : materialsQuery.isLoading ? (
        <div className="field-materials-state"><Loader2 className="is-spinning" /><strong>{c.loading}</strong></div>
      ) : materialsQuery.isError ? (
        <div className="field-materials-state is-error"><AlertTriangle /><strong>{c.error}</strong><p>{getErrorMessage(materialsQuery.error, c.error)}</p><button onClick={() => void materialsQuery.refetch()} type="button">{c.refresh}</button></div>
      ) : schedules.length === 0 ? (
        <div className="field-materials-state"><FileText /><strong>{c.empty}</strong></div>
      ) : (
        <section className="field-material-schedule-board" aria-labelledby="field-material-schedule-title">
          <header className="field-material-schedule-heading">
            <div>
              <small><ListOrdered />SEQUENCE VIEW</small>
              <h2 id="field-material-schedule-title">{c.scheduleTitle}</h2>
              <p>{c.scheduleDescription}</p>
            </div>
            <div className="field-material-status-legend" aria-label={c.scheduleTitle}>
              <span className="is-completed"><i />{c.completed}</span>
              <span className="is-current"><i />{c.current}</span>
              <span className="is-waiting"><i />{c.waiting}</span>
              <span className="is-missing"><AlertTriangle />{c.missingModels}</span>
            </div>
          </header>
          <div className="field-material-machine-schedules">
            {schedules.map((schedule) => {
              const completedCount = schedule.plans.filter((plan) => plan.status === "completed").length;
              const currentCount = schedule.plans.filter((plan) => plan.status === "current").length;
              const missingCount = schedule.plans.filter((plan) => !plan.readiness.complete).length;
              const hasCurrent = currentCount > 0;
              return (
                <article className={`field-material-machine-schedule${hasCurrent ? " has-current" : ""}`} key={schedule.machine_number}>
                  <header>
                    <span className="field-material-machine-number"><Factory /><strong>{String(schedule.machine_number).padStart(2, "0")}</strong><small>{c.machinesUnit}</small></span>
                    <div>
                      <h2>{schedule.machine_label || `${schedule.machine_number}${c.machinesUnit}`}</h2>
                      <p>{schedule.plans.length}{c.planCount} · {c.completed} {completedCount} · {c.current} {currentCount} · {c.waiting} {Math.max(0, schedule.plans.length - completedCount - currentCount)}</p>
                    </div>
                    <span className={`field-material-machine-readiness${missingCount ? " is-missing" : " is-ready"}`}>
                      {missingCount ? <AlertTriangle /> : <FileCheck2 />}
                      {missingCount ? `${c.missingModels} ${missingCount}` : c.completeModels}
                    </span>
                  </header>
                  <div className="field-material-plan-timeline">
                    {schedule.plans.map((plan) => (
                      <SchedulePlanCard
                        canEdit={canEditMaterials}
                        key={`${plan.plan_id ?? "plan"}:${plan.sequence}:${plan.part_no}`}
                        language={language}
                        onRepair={(document) => {
                          if (canEditMaterials) repairMutation.mutate(document.id);
                        }}
                        onUpload={(kind, model) => {
                          if (canEditMaterials) setUploadTarget({ kind, model });
                        }}
                        plan={plan}
                        repairingDocumentId={repairMutation.isPending ? repairMutation.variables : null}
                      />
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {canEditMaterials && uploadTarget ? (
        <UploadDialog
          kind={uploadTarget.kind}
          language={language}
          model={uploadTarget.model}
          onClose={() => setUploadTarget(null)}
        />
      ) : null}
    </div>
  );
}
