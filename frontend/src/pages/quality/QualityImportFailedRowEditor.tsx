import axios from 'axios';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useLang } from '../../i18n';
import {
  publishQualityImportRow,
  QualityImportPublishConflictError,
  reviewQualityImportRow,
} from './importApi';
import type {
  QualityExcelImportRowResult,
  QualityImportRowReviewPayload,
  QualityImportRowWorkflowResult,
} from './importTypes';

const failedRowCopy = {
  ko: {
    failed: '실패',
    editRow: '입력값 수정',
    closeEdit: '수정 닫기',
    reportDate: '보고일',
    section: '보고 부서',
    occurrenceLocation: '발생 위치',
    model: '모델',
    partNo: 'Part No.',
    phenomenon: '불량 현상',
    correctAndRegister: '수정 후 등록',
    correcting: '수정 내용 등록 중',
    correctedRegistered: '입력 오류를 수정해 보고서로 등록했습니다.',
    correctionFailed: '수정한 행을 등록하지 못했습니다. 입력값과 오류 메시지를 확인해 주세요.',
    duplicateConflict: '기존 보고서와 중복 가능성이 있어 자동 등록하지 않았습니다.',
    versionConflict: '검토하는 동안 행 내용이 변경되었습니다. 최신 값을 다시 확인한 뒤 등록해 주세요.',
    requiredField: '필수 입력',
    inputError: '입력 오류',
    imageTooLarge: '사진 용량 초과',
    sourceMatchFailed: '원본 확인 필요',
    correctableRowMessage: '입력값을 바로잡으면 이 화면에서 보고서로 등록할 수 있습니다.',
    imageTooLargeMessage: '사진 용량이 커서 바로 수정할 수 없습니다. 사진을 줄인 뒤 다시 업로드해 주세요.',
    sourceMatchFailedMessage: '이동된 Excel 행의 기존 보고서를 안전하게 찾지 못했습니다. 원본을 확인해 주세요.',
    reportDateRequired: '보고일을 입력해 주세요.',
    sectionUnsupported: '보고 부서를 선택해 주세요.',
    modelOrPartNoRequired: '모델 또는 Part No. 중 하나를 입력해 주세요.',
    phenomenonRequired: '불량 현상을 입력해 주세요.',
    maxLength: '{field}: 최대 {max}자까지 입력할 수 있습니다.',
    defectRate: '불량률',
    judgement: '판정 결과',
    sectionLabels: {
      LQC_INJ: 'LQC_INJ · 사출 품질',
      LQC_ASM: 'LQC_ASM · 가공·조립 품질',
      IQC: 'IQC · 수입 검사',
      OQC: 'OQC · 출하 검사',
      CS: 'CS · 고객 품질',
    },
  },
  zh: {
    failed: '失败',
    editRow: '修改输入值',
    closeEdit: '收起修改',
    reportDate: '报告日期',
    section: '报告部门',
    occurrenceLocation: '发生位置',
    model: '型号',
    partNo: 'Part No.',
    phenomenon: '不良现象',
    correctAndRegister: '修改并登记',
    correcting: '正在登记修改内容',
    correctedRegistered: '输入错误已修改并登记为报告。',
    correctionFailed: '修改后的行未能登记，请确认输入值和错误信息。',
    duplicateConflict: '可能与已有报告重复，因此未自动登记。',
    versionConflict: '审核期间该行内容已更改，请重新确认最新值后再登记。',
    requiredField: '必填',
    inputError: '输入错误',
    imageTooLarge: '图片容量超限',
    sourceMatchFailed: '需确认原始记录',
    correctableRowMessage: '更正输入值后，可在此页面直接登记为报告。',
    imageTooLargeMessage: '图片容量过大，无法直接修改。请压缩图片后重新上传。',
    sourceMatchFailedMessage: '无法安全匹配移动后的 Excel 行与已有报告，请确认原始记录。',
    reportDateRequired: '请输入报告日期。',
    sectionUnsupported: '请选择报告部门。',
    modelOrPartNoRequired: '型号或 Part No. 至少填写一项。',
    phenomenonRequired: '请输入不良现象。',
    maxLength: '{field}：最多可输入 {max} 个字符。',
    defectRate: '不良率',
    judgement: '判定结果',
    sectionLabels: {
      LQC_INJ: 'LQC_INJ · 注塑品质',
      LQC_ASM: 'LQC_ASM · 加工·组装品质',
      IQC: 'IQC · 来料检验',
      OQC: 'OQC · 出货检验',
      CS: 'CS · 客户品质',
    },
  },
} as const;

type SupportedLang = keyof typeof failedRowCopy;
type FailedRowCopy = (typeof failedRowCopy)[SupportedLang];

const QUALITY_SECTION_OPTIONS = ['LQC_INJ', 'LQC_ASM', 'IQC', 'OQC', 'CS'] as const;

function interpolate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, value.toLocaleString()),
    template,
  );
}

function failureLabel(row: QualityExcelImportRowResult, c: FailedRowCopy): string {
  if (row.failure_code === 'row_validation_failed') return c.inputError;
  if (row.failure_code === 'selected_row_images_too_large') return c.imageTooLarge;
  if (row.failure_code === 'ambiguous_source_identity') return c.sourceMatchFailed;
  return c.failed;
}

function failureMessage(row: QualityExcelImportRowResult, c: FailedRowCopy): string {
  if (row.failure_code === 'row_validation_failed') return c.correctableRowMessage;
  if (row.failure_code === 'selected_row_images_too_large') return c.imageTooLargeMessage;
  if (row.failure_code === 'ambiguous_source_identity') return c.sourceMatchFailedMessage;
  return row.message;
}

// This localized formatter is also used by the compact result table.
// eslint-disable-next-line react-refresh/only-export-components
export function qualityImportFailureMessage(
  row: QualityExcelImportRowResult,
  lang: SupportedLang,
): string {
  return failureMessage(row, failedRowCopy[lang]);
}

function validationErrorMessage(
  error: QualityExcelImportRowResult['validation_errors'][number],
  c: FailedRowCopy,
): string {
  if (error.field === 'section' && error.code === 'unsupported') return c.sectionUnsupported;
  if (error.code === 'required') {
    if (error.field === 'report_date') return c.reportDateRequired;
    if (error.field === 'model_or_part_no') return c.modelOrPartNoRequired;
    if (error.field === 'phenomenon') return c.phenomenonRequired;
  }
  if (error.code === 'max_length') {
    const limits: Record<string, number> = {
      model: 64,
      part_no: 64,
      defect_rate: 16,
      judgement: 8,
    };
    const fieldLabels: Record<string, string> = {
      model: c.model,
      part_no: c.partNo,
      defect_rate: c.defectRate,
      judgement: c.judgement,
    };
    const maximum = limits[error.field];
    if (maximum) {
      return interpolate(c.maxLength, {
        field: fieldLabels[error.field] || error.field,
        max: maximum,
      });
    }
  }
  return error.message;
}

function correctionErrorMessage(error: unknown, c: FailedRowCopy): string {
  if (error instanceof QualityImportPublishConflictError) {
    return error.conflict.code === 'review_version_changed'
      ? c.versionConflict
      : c.duplicateConflict;
  }
  if (axios.isAxiosError(error)) {
    const payload: unknown = error.response?.data;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      const detail = [record.error, record.detail]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (detail) return detail;
      if (Array.isArray(record.errors)) {
        const messages = record.errors.filter((value): value is string => typeof value === 'string');
        if (messages.length > 0) return messages.join('\n');
      }
      const fieldMessages = Object.entries(record).flatMap(([field, value]) => (
        Array.isArray(value)
          ? value
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item) => `${field}: ${item}`)
          : []
      ));
      if (fieldMessages.length > 0) return fieldMessages.join('\n');
    }
  }
  return error instanceof Error && error.message ? error.message : c.correctionFailed;
}

interface QualityImportFailedRowEditorProps {
  row: QualityExcelImportRowResult;
  onSubmittingChange?: (submitting: boolean) => void;
  onRegistered: (
    sourceRow: QualityExcelImportRowResult,
    publishedRow: QualityImportRowWorkflowResult,
    successMessage: string,
  ) => void;
}

export default function QualityImportFailedRowEditor({
  row,
  onSubmittingChange,
  onRegistered,
}: QualityImportFailedRowEditorProps) {
  const { lang } = useLang();
  const c = failedRowCopy[lang === 'zh' ? 'zh' : 'ko'];
  const rootRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [reviewedVersion, setReviewedVersion] = useState<string | null>(null);
  const normalizedSection = QUALITY_SECTION_OPTIONS.includes(
    row.section as (typeof QUALITY_SECTION_OPTIONS)[number],
  ) ? row.section : '';
  const [form, setForm] = useState<QualityImportRowReviewPayload>({
    report_date: row.report_date || '',
    section: normalizedSection,
    occurrence_location: row.occurrence_location,
    model: row.model,
    part_no: row.part_no,
    defect_rate: row.defect_rate,
    judgement: row.judgement,
    phenomenon: row.phenomenon,
    review_status: 'reviewed',
  });
  const reportDateRef = useRef<HTMLInputElement | null>(null);
  const sectionRef = useRef<HTMLSelectElement | null>(null);
  const occurrenceLocationRef = useRef<HTMLInputElement | null>(null);
  const modelRef = useRef<HTMLInputElement | null>(null);
  const partNoRef = useRef<HTMLInputElement | null>(null);
  const defectRateRef = useRef<HTMLInputElement | null>(null);
  const judgementRef = useRef<HTMLInputElement | null>(null);
  const phenomenonRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root && root.parentElement?.firstElementChild === root) setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const firstInvalidField = row.validation_errors[0]?.field;
    const targets: Record<string, HTMLElement | null> = {
      report_date: reportDateRef.current,
      section: sectionRef.current,
      occurrence_location: occurrenceLocationRef.current,
      model: modelRef.current,
      model_or_part_no: modelRef.current,
      part_no: partNoRef.current,
      defect_rate: defectRateRef.current,
      judgement: judgementRef.current,
      phenomenon: phenomenonRef.current,
    };
    const target = (firstInvalidField && targets[firstInvalidField]) || sectionRef.current;
    const frame = window.requestAnimationFrame(() => target?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, row.validation_errors]);

  const fieldError = (field: string) => row.validation_errors.find((error) => error.field === field);
  const fieldErrorMessage = (field: string) => {
    const error = fieldError(field);
    return error ? validationErrorMessage(error, c) : null;
  };
  const modelOrPartError = fieldError('model_or_part_no');
  const modelOrPartErrorMessage = modelOrPartError
    ? validationErrorMessage(modelOrPartError, c)
    : null;
  const inputClass = 'mt-1 block h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200';
  const formId = `quality-import-row-${row.import_row_id || row.source_row_number}`;
  const updateForm = <K extends keyof QualityImportRowReviewPayload>(
    field: K,
    value: QualityImportRowReviewPayload[K],
  ) => {
    setReviewedVersion(null);
    setForm((current) => ({ ...current, [field]: value }));
  };

  const submit = async () => {
    if (!row.import_row_id || submitting) return;
    setSubmitting(true);
    onSubmittingChange?.(true);
    setSubmitError(null);
    try {
      let expectedVersion = reviewedVersion;
      if (!expectedVersion) {
        const reviewed = await reviewQualityImportRow(row.import_row_id, form);
        expectedVersion = reviewed.reviewed_content_sha256;
        setReviewedVersion(expectedVersion);
      }
      const published = await publishQualityImportRow(
        row.import_row_id,
        expectedVersion,
      );
      setRegistered(true);
      onRegistered(row, published, c.correctedRegistered);
      toast.success(c.correctedRegistered);
    } catch (error) {
      if (
        error instanceof QualityImportPublishConflictError
        && error.conflict.code === 'review_version_changed'
      ) {
        setReviewedVersion(null);
      }
      const message = correctionErrorMessage(error, c);
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  };

  if (registered) return null;

  return (
    <article ref={rootRef} className="rounded-xl border border-rose-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <span className="rounded-lg bg-rose-100 p-2 text-rose-700">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <strong className="text-sm text-slate-950">
              {row.sheet_name} #{row.source_row_number}
              {row.source_sequence ? ` · No.${row.source_sequence}` : ''}
            </strong>
            <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">
              {failureLabel(row, c)}
            </span>
          </div>
          <p className="mt-1 text-sm leading-5 text-slate-700">{failureMessage(row, c)}</p>
          {row.validation_errors.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-rose-700">
              {row.validation_errors.map((error) => (
                <li key={`${error.field}-${error.code}`}>{validationErrorMessage(error, c)}</li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={formId}
          onClick={() => setOpen((current) => !current)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
        >
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {open ? c.closeEdit : c.editRow}
        </button>
      </div>

      {open && (
        <form
          id={formId}
          className="border-t border-rose-100 bg-rose-50/40 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <label className="text-sm font-semibold text-slate-700">
              {c.reportDate} <span className="text-rose-600">*</span>
              <input
                ref={reportDateRef}
                type="date"
                required
                value={form.report_date}
                aria-invalid={Boolean(fieldError('report_date'))}
                onChange={(event) => updateForm('report_date', event.target.value)}
                className={inputClass}
              />
              {fieldErrorMessage('report_date') && <span className="mt-1 block text-xs font-normal text-rose-700">{fieldErrorMessage('report_date')}</span>}
            </label>
            <label className="text-sm font-semibold text-slate-700">
              {c.section} <span className="text-rose-600">*</span>
              <select
                ref={sectionRef}
                required
                value={form.section}
                aria-invalid={Boolean(fieldError('section'))}
                onChange={(event) => updateForm('section', event.target.value)}
                className={inputClass}
              >
                <option value="" disabled>{c.requiredField}</option>
                {QUALITY_SECTION_OPTIONS.map((section) => (
                  <option key={section} value={section}>{c.sectionLabels[section]}</option>
                ))}
              </select>
              {fieldErrorMessage('section') && <span className="mt-1 block text-xs font-normal text-rose-700">{fieldErrorMessage('section')}</span>}
            </label>
            <label className="text-sm font-semibold text-slate-700">
              {c.occurrenceLocation}
              <input
                ref={occurrenceLocationRef}
                maxLength={64}
                value={form.occurrence_location}
                aria-invalid={Boolean(fieldError('occurrence_location'))}
                onChange={(event) => updateForm('occurrence_location', event.target.value)}
                className={inputClass}
              />
              {fieldErrorMessage('occurrence_location') && <span className="mt-1 block text-xs font-normal text-rose-700">{fieldErrorMessage('occurrence_location')}</span>}
            </label>
            <label className="text-sm font-semibold text-slate-700">
              {c.model}
              <input
                ref={modelRef}
                maxLength={64}
                value={form.model}
                aria-invalid={Boolean(fieldError('model') || modelOrPartError)}
                onChange={(event) => updateForm('model', event.target.value)}
                className={inputClass}
              />
              {(fieldErrorMessage('model') || modelOrPartErrorMessage) && (
                <span className="mt-1 block text-xs font-normal text-rose-700">
                  {fieldErrorMessage('model') || modelOrPartErrorMessage}
                </span>
              )}
            </label>
            <label className="text-sm font-semibold text-slate-700">
              {c.partNo}
              <input
                ref={partNoRef}
                maxLength={64}
                value={form.part_no}
                aria-invalid={Boolean(fieldError('part_no') || modelOrPartError)}
                onChange={(event) => updateForm('part_no', event.target.value)}
                className={inputClass}
              />
              {fieldErrorMessage('part_no') && <span className="mt-1 block text-xs font-normal text-rose-700">{fieldErrorMessage('part_no')}</span>}
            </label>
            <label className="text-sm font-semibold text-slate-700">
              {c.defectRate}
              <input
                ref={defectRateRef}
                maxLength={16}
                value={form.defect_rate}
                aria-invalid={Boolean(fieldError('defect_rate'))}
                onChange={(event) => updateForm('defect_rate', event.target.value)}
                className={inputClass}
              />
              {fieldErrorMessage('defect_rate') && <span className="mt-1 block text-xs font-normal text-rose-700">{fieldErrorMessage('defect_rate')}</span>}
            </label>
            <label className="text-sm font-semibold text-slate-700">
              {c.judgement}
              <input
                ref={judgementRef}
                maxLength={8}
                value={form.judgement}
                aria-invalid={Boolean(fieldError('judgement'))}
                onChange={(event) => updateForm('judgement', event.target.value)}
                className={inputClass}
              />
              {fieldErrorMessage('judgement') && <span className="mt-1 block text-xs font-normal text-rose-700">{fieldErrorMessage('judgement')}</span>}
            </label>
            <label className="text-sm font-semibold text-slate-700 md:col-span-2 xl:col-span-3">
              {c.phenomenon} <span className="text-rose-600">*</span>
              <textarea
                ref={phenomenonRef}
                required
                rows={3}
                value={form.phenomenon}
                aria-invalid={Boolean(fieldError('phenomenon'))}
                onChange={(event) => updateForm('phenomenon', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              />
              {fieldErrorMessage('phenomenon') && <span className="mt-1 block text-xs font-normal text-rose-700">{fieldErrorMessage('phenomenon')}</span>}
            </label>
          </div>
          {submitError && (
            <p className="mt-4 whitespace-pre-wrap rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm text-rose-800" role="alert">
              {submitError}
            </p>
          )}
          <div className="mt-4 flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-wait disabled:opacity-60"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {submitting ? c.correcting : c.correctAndRegister}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
