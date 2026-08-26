import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  FileText,
  FileUp,
  Loader2,
  MonitorUp,
  RefreshCw,
  UploadCloud,
  X,
} from "lucide-react";

import {
  getFieldMaterials,
  uploadFieldMaterial,
  type FieldDocument,
  type FieldMaterialModel,
} from "@/domains/field/api";
import { useLang } from "@/i18n";
import { useModalFocusTrap } from "@/shared/hooks/useModalFocusTrap";
import { useShanghaiBusinessDate } from "@/shared/hooks/useShanghaiBusinessDate";

import "./FieldMaterialsPage.css";

type MaterialKind = FieldDocument["kind"];

const pageCopy = {
  ko: {
    eyebrow: "개발 · 현장 지원",
    title: "현장 자료 보충",
    description: "오늘 사출 계획 모델별 작업지도서와 도면 준비 상태를 확인하고, 빠진 자료를 바로 올립니다.",
    businessDate: "상하이 업무일",
    refresh: "새로고침",
    totalModels: "오늘 계획 모델",
    completeModels: "자료 완비",
    missingModels: "보충 필요",
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
    upload: "업로드",
    replace: "교체 업로드",
    modalTitleInstruction: "작업지도서 업로드",
    modalTitleDrawing: "도면 업로드",
    modalHintInstruction: "PDF는 바로 현장에 표시됩니다. PPT/PPTX는 원본과 함께 PDF 미리보기를 올려야 현장 준비 완료가 됩니다.",
    modalHintDrawing: "도면은 PDF 파일만 업로드할 수 있습니다.",
    revision: "개정번호",
    revisionPlaceholder: "예: Rev. C",
    sourceFile: "원본 파일",
    previewPdf: "현장용 PDF 미리보기",
    previewOptional: "PPT/PPTX 원본을 선택한 경우 추가해 주세요.",
    chooseFile: "파일 선택",
    noFile: "선택된 파일 없음",
    cancel: "취소",
    uploading: "업로드 중…",
    submit: "자료 업로드",
    uploadSuccess: "현장 자료를 업로드했습니다.",
    uploadError: "현장 자료 업로드에 실패했습니다.",
    invalidDrawing: "도면은 PDF 파일만 선택해 주세요.",
    invalidInstruction: "작업지도서는 PDF, PPT, PPTX 파일만 선택해 주세요.",
    invalidPreview: "미리보기는 PDF 파일만 선택해 주세요.",
    pptWarning: "PDF 미리보기 없이 업로드하면 원본은 저장되지만 현장 화면에는 표시되지 않습니다.",
    machinesUnit: "호기",
    pieces: "개",
    noRevision: "개정번호 없음",
  },
  zh: {
    eyebrow: "开发 · 现场支持",
    title: "现场资料补充",
    description: "按今日注塑计划检查每个型号的作业指导书与图纸，并直接补充缺失资料。",
    businessDate: "上海业务日",
    refresh: "刷新",
    totalModels: "今日计划型号",
    completeModels: "资料完整",
    missingModels: "待补充",
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
    upload: "上传",
    replace: "替换上传",
    modalTitleInstruction: "上传作业指导书",
    modalTitleDrawing: "上传图纸",
    modalHintInstruction: "PDF 可直接在现场显示。PPT/PPTX 需同时上传 PDF 预览后才算现场可用。",
    modalHintDrawing: "图纸仅支持 PDF 文件。",
    revision: "修订号",
    revisionPlaceholder: "例如：Rev. C",
    sourceFile: "原始文件",
    previewPdf: "现场 PDF 预览",
    previewOptional: "选择 PPT/PPTX 原件时请一并添加。",
    chooseFile: "选择文件",
    noFile: "未选择文件",
    cancel: "取消",
    uploading: "上传中…",
    submit: "上传资料",
    uploadSuccess: "现场资料已上传。",
    uploadError: "现场资料上传失败。",
    invalidDrawing: "图纸只能选择 PDF 文件。",
    invalidInstruction: "作业指导书只能选择 PDF、PPT 或 PPTX 文件。",
    invalidPreview: "预览文件只能选择 PDF。",
    pptWarning: "未上传 PDF 预览时，原件会保存，但不会显示在现场屏幕。",
    machinesUnit: "号机",
    pieces: "件",
    noRevision: "无修订号",
  },
} as const;

function number(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value || 0)));
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
  const needsPreview = Boolean(document && !ready);
  return (
    <div className={`field-material-document-status ${ready ? "is-ready" : needsPreview ? "is-preview-missing" : "is-missing"}`}>
      <span>{ready ? <CheckCircle2 /> : <AlertTriangle />}</span>
      <div>
        <strong>{ready ? c.ready : needsPreview ? c.previewMissing : c.missing}</strong>
        <small>{document?.original_name || "-"}</small>
        <em>{document?.revision || c.noRevision}</em>
      </div>
    </div>
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
  const previewInputRef = useRef<HTMLInputElement>(null);
  const currentDocument = kind === "work_instruction" ? model.work_instruction : model.drawing;
  const [revision, setRevision] = useState(currentDocument?.revision || "");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const uploadMutation = useMutation({ mutationFn: uploadFieldMaterial });
  const isInstruction = kind === "work_instruction";
  const uploadDialogRef = useModalFocusTrap<HTMLFormElement>({
    onEscape: uploadMutation.isPending ? undefined : onClose,
  });

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
    if (previewFile && !isPdf(previewFile)) {
      setLocalError(c.invalidPreview);
      return;
    }
    try {
      await uploadMutation.mutateAsync({
        kind,
        partNo: model.part_no,
        modelName: model.model_name,
        revision,
        file: sourceFile,
        previewPdf: isInstruction ? previewFile : null,
      });
      await queryClient.invalidateQueries({ queryKey: ["field-materials"] });
      setSuccess(c.uploadSuccess);
      window.setTimeout(onClose, 700);
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
            <input data-modal-initial-focus maxLength={80} onChange={(event) => setRevision(event.target.value)} placeholder={c.revisionPlaceholder} value={revision} />
          </label>
          <div className="field-material-file-field">
            <span>{c.sourceFile}</span>
            <input
              accept={isInstruction ? ".pdf,.ppt,.pptx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation" : ".pdf,application/pdf"}
              aria-hidden="true"
              onChange={(event) => {
                setSourceFile(event.target.files?.[0] ?? null);
                setLocalError(null);
              }}
              ref={sourceInputRef}
              tabIndex={-1}
              type="file"
            />
            <button onClick={() => sourceInputRef.current?.click()} type="button"><FileUp />{c.chooseFile}</button>
            <strong>{sourceFile?.name || c.noFile}</strong>
          </div>
          {isInstruction ? (
            <div className="field-material-file-field">
              <span>{c.previewPdf}<small>{c.previewOptional}</small></span>
              <input
                accept=".pdf,application/pdf"
                aria-hidden="true"
                onChange={(event) => {
                  setPreviewFile(event.target.files?.[0] ?? null);
                  setLocalError(null);
                }}
                ref={previewInputRef}
                tabIndex={-1}
                type="file"
              />
              <button onClick={() => previewInputRef.current?.click()} type="button"><FileText />{c.chooseFile}</button>
              <strong>{previewFile?.name || c.noFile}</strong>
            </div>
          ) : null}
          {isInstruction && isPpt(sourceFile) && !previewFile ? (
            <div className="field-material-ppt-warning"><AlertTriangle />{c.pptWarning}</div>
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
  const language = lang === "zh" ? "zh" : "ko";
  const c = pageCopy[language];
  const businessDate = useShanghaiBusinessDate();
  const [uploadTarget, setUploadTarget] = useState<{ kind: MaterialKind; model: FieldMaterialModel } | null>(null);
  const materialsQuery = useQuery({
    queryKey: ["field-materials", businessDate],
    queryFn: () => getFieldMaterials(businessDate),
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
  });
  const models = useMemo(() => materialsQuery.data?.models ?? [], [materialsQuery.data?.models]);
  const summary = useMemo(() => {
    const complete = models.filter((item) => item.readiness.complete).length;
    return { total: models.length, complete, missing: models.length - complete };
  }, [models]);

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
          <span>{c.businessDate}<strong>{businessDate}</strong></span>
          <button disabled={materialsQuery.isFetching} onClick={() => void materialsQuery.refetch()} type="button">
            <RefreshCw className={materialsQuery.isFetching ? "is-spinning" : ""} />{c.refresh}
          </button>
        </div>
      </header>

      <section className="field-materials-summary" aria-label={c.title}>
        <article><span><FileText /></span><div><small>{c.totalModels}</small><strong>{number(summary.total)}</strong></div></article>
        <article className="is-complete"><span><FileCheck2 /></span><div><small>{c.completeModels}</small><strong>{number(summary.complete)}</strong></div></article>
        <article className="is-missing"><span><AlertTriangle /></span><div><small>{c.missingModels}</small><strong>{number(summary.missing)}</strong></div></article>
      </section>

      {materialsQuery.isLoading ? (
        <div className="field-materials-state"><Loader2 className="is-spinning" /><strong>{c.loading}</strong></div>
      ) : materialsQuery.isError ? (
        <div className="field-materials-state is-error"><AlertTriangle /><strong>{c.error}</strong><p>{getErrorMessage(materialsQuery.error, c.error)}</p><button onClick={() => void materialsQuery.refetch()} type="button">{c.refresh}</button></div>
      ) : models.length === 0 ? (
        <div className="field-materials-state"><FileText /><strong>{c.empty}</strong></div>
      ) : (
        <section className="field-materials-table-wrap">
          <table className="field-materials-table">
            <thead>
              <tr>
                <th>{c.machine}</th>
                <th>{c.model}</th>
                <th>{c.partNo}</th>
                <th>{c.planned}</th>
                <th>{c.instruction}</th>
                <th>{c.drawing}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr className={model.readiness.complete ? "is-complete" : "is-incomplete"} key={`${model.part_no}:${model.model_name}`}>
                  <td><div className="field-material-machine-list">{model.machine_numbers.map((item) => <span key={item}>{item}{c.machinesUnit}</span>)}</div></td>
                  <td><strong className="field-material-model">{model.model_name || "-"}</strong></td>
                  <td><strong className="field-material-part">{model.part_no || "-"}</strong></td>
                  <td><strong className="field-material-qty">{number(model.planned_quantity)}</strong><small>{c.pieces}</small></td>
                  <td>
                    <DocumentStatus document={model.work_instruction} language={language} ready={model.readiness.work_instruction} />
                    <button className="field-material-upload-button" onClick={() => setUploadTarget({ kind: "work_instruction", model })} type="button"><FileUp />{model.work_instruction ? c.replace : c.upload}</button>
                  </td>
                  <td>
                    <DocumentStatus document={model.drawing} language={language} ready={model.readiness.drawing} />
                    <button className="field-material-upload-button" onClick={() => setUploadTarget({ kind: "drawing", model })} type="button"><FileUp />{model.drawing ? c.replace : c.upload}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {uploadTarget ? (
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
