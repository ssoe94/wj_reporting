import axios from 'axios';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileSpreadsheet,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Rows3,
  SkipForward,
  UploadCloud,
  GitCompareArrows,
  XCircle,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useAuth } from '../../contexts/AuthContext';
import { useLang } from '../../i18n';
import {
  QUALITY_IMPORT_MAX_FILE_BYTES,
  commitQualityExcel,
  previewQualityExcel,
} from './importApi';
import { scanQualityWorkbook } from './qualityWorkbookScanner';
import { combineQualityImportResults, createQualityImportChunks } from './importResult';
import type {
  QualityExcelImportPreview,
  QualityExcelImportProgress,
  QualityExcelImportResult,
  QualityExcelImportRowResult,
  QualityReportHistoryScope,
} from './importTypes';

const copy = {
  ko: {
    title: 'Excel 품질 이슈 업로드',
    description: 'Excel은 브라우저에서 비교하고, 신규 행의 사진만 전송해 즉시 등록합니다.',
    drop: '.xlsx 파일을 놓거나 클릭해 선택하세요',
    fileHelp: '최대 80MB · 같은 내용은 건너뛰고 사진은 행당 최대 5장 저장합니다.',
    scanning: 'Excel을 기기에서 분석 중',
    comparing: '기존 보고서와 비교 중',
    extracting: '신규 행의 사진만 준비 중',
    uploading: '필요한 사진 업로드 및 저장 중',
    deltaSummary: '신규 {rows}건 · 사진 {images}장만 전송합니다.',
    success: 'Excel 처리가 완료되었습니다.',
    partialSuccess: '일부 행을 처리하지 못했습니다. 실패 행을 확인한 뒤 다시 시도하세요.',
    allFailed: '등록된 행이 없습니다. 실패 원인을 확인한 뒤 다시 시도하세요.',
    upstreamUnavailable: '서버 처리가 중단되었거나 지연되었습니다. 잠시 후 다시 시도해 주세요.',
    partialInterrupted: '전체 처리를 끝내지 못해 일부 등록 결과를 확인할 수 없습니다.',
    completionUnconfirmed: '등록 완료를 확인하지 못했습니다. 다시 시도하면 등록된 건은 안전하게 건너뜁니다.',
    invalidFile: '.xlsx 형식의 Excel 파일만 선택할 수 있습니다.',
    emptyFile: '내용이 없는 파일은 업로드할 수 없습니다.',
    oversizedFile: 'Excel 파일은 최대 80MB까지 업로드할 수 있습니다.',
    permissionDenied: '품질 자료를 업로드할 권한이 없습니다.',
    retry: '다시 시도',
    retryFailed: '실패 건 다시 시도',
    resultTitle: '처리 결과',
    total: '전체 행',
    created: '신규 등록',
    skipped: '기존 건너뜀',
    changed: '변경 감지',
    failed: '실패',
    imagesFound: '발견 사진',
    imagesSaved: '사진 저장',
    imagesFailed: '사진 실패',
    imagesIgnored: '사진 제외',
    imagesSkipped: '사진 건너뜀',
    workbookWarnings: '파일 확인 사항',
    createdPostProcess: '신규 건 후처리',
    skippedView: '기존 건 보기',
    changedPostProcess: '변경 건 확인',
    allView: '전체 결과 보기',
    source: '원본 위치',
    status: '결과',
    report: '보고서',
    issue: '품질 이슈',
    images: '사진',
    notes: '메시지',
    action: '후처리',
    noRows: '표시할 행별 결과가 없습니다.',
    unknown: '미확인',
    reportNumber: '보고서 #{id}',
    viewReport: '보고서 보기',
    uploadFailed: 'Excel 업로드에 실패했습니다.',
  },
  zh: {
    title: '上传 Excel 品质问题',
    description: '在浏览器中比较 Excel，仅上传新增行的图片并立即登记。',
    drop: '拖入或点击选择 .xlsx 文件',
    fileHelp: '最大 80MB · 跳过相同内容，每行最多保存 5 张图片。',
    scanning: '正在本机分析 Excel',
    comparing: '正在与已有报告比较',
    extracting: '正在准备新增行的图片',
    uploading: '正在上传必要图片并保存',
    deltaSummary: '仅传输 {rows} 条新增记录和 {images} 张图片。',
    success: 'Excel 处理完成。',
    partialSuccess: '部分行未处理，请确认失败行后重试。',
    allFailed: '没有登记任何行，请确认失败原因后重试。',
    upstreamUnavailable: '服务器处理已中断或延迟，请稍后重试。',
    partialInterrupted: '处理未完成，部分登记结果无法确认。',
    completionUnconfirmed: '无法确认登记是否完成。重试时会安全跳过已登记的记录。',
    invalidFile: '只能选择 .xlsx 格式的 Excel 文件。',
    emptyFile: '无法上传空文件。',
    oversizedFile: 'Excel 文件最大可上传 80MB。',
    permissionDenied: '您没有上传品质资料的权限。',
    retry: '重试',
    retryFailed: '重试失败项',
    resultTitle: '处理结果',
    total: '总行数',
    created: '新增登记',
    skipped: '跳过已有',
    changed: '检测到变更',
    failed: '失败',
    imagesFound: '发现图片',
    imagesSaved: '已保存图片',
    imagesFailed: '图片失败',
    imagesIgnored: '未处理图片',
    imagesSkipped: '跳过图片',
    workbookWarnings: '文件注意事项',
    createdPostProcess: '处理新增报告',
    skippedView: '查看已有报告',
    changedPostProcess: '确认变更记录',
    allView: '查看全部结果',
    source: '源位置',
    status: '结果',
    report: '报告',
    issue: '品质问题',
    images: '图片',
    notes: '消息',
    action: '后续处理',
    noRows: '没有可显示的逐行结果。',
    unknown: '未确认',
    reportNumber: '报告 #{id}',
    viewReport: '查看报告',
    uploadFailed: 'Excel 上传失败。',
  },
} as const;

type Copy = (typeof copy)[keyof typeof copy];
type ImportPhase = 'idle' | 'scanning' | 'comparing' | 'extracting' | 'uploading';

interface QualityExcelImportProps {
  onPostProcess: (scope: QualityReportHistoryScope) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unitIndex)).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getUploadErrorMessage(
  error: unknown,
  fallback: string,
  upstreamFallback: string,
): string {
  if (axios.isAxiosError(error)) {
    const payload = error.response?.data as { error?: string; detail?: string; code?: string } | string | undefined;
    if (payload && typeof payload === 'object') {
      return payload.error || payload.detail || error.message || payload.code || fallback;
    }
    const status = error.response?.status;
    const contentType = String(error.response?.headers['content-type'] || '').toLowerCase();
    const isUpstreamFailure = status != null && [502, 503, 504].includes(status);
    if (typeof payload === 'string' && payload.trim()) {
      const text = payload.trim();
      const looksLikeMarkup = /^\s*</.test(text) || /<(?:!doctype|html|head|body|title)\b/i.test(text);
      if (isUpstreamFailure || contentType.includes('text/html')) return upstreamFallback;
      if (looksLikeMarkup || text.length > 1_000) return fallback;
      return text;
    }
    if (isUpstreamFailure) return upstreamFallback;
    return error.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function uniqueReportIds(ids: Array<number | null | undefined>): number[] {
  return [...new Set(ids.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0))];
}

function statusStyle(status: QualityExcelImportRowResult['status']): string {
  if (status === 'created') return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  if (status === 'changed') return 'bg-violet-50 text-violet-700 ring-violet-200';
  if (status === 'skipped') return 'bg-amber-50 text-amber-700 ring-amber-200';
  return 'bg-rose-50 text-rose-700 ring-rose-200';
}

function statusLabel(status: QualityExcelImportRowResult['status'], c: Copy): string {
  if (status === 'created') return c.created;
  if (status === 'changed') return c.changed;
  if (status === 'skipped') return c.skipped;
  return c.failed;
}

function interpolate(template: string, values: Record<string, number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, value.toLocaleString()),
    template,
  );
}

function ResultMetric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Rows3;
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
        <Icon className={`h-4 w-4 ${tone}`} aria-hidden="true" />
        {label}
      </div>
      <strong className="mt-1 block text-2xl tabular-nums text-slate-950">{value.toLocaleString()}</strong>
    </div>
  );
}

export default function QualityExcelImport({ onPostProcess }: QualityExcelImportProps) {
  const { lang } = useLang();
  const { user, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const c = copy[lang === 'zh' ? 'zh' : 'ko'];
  const canUpload = Boolean(user?.is_staff || hasPermission('can_edit_quality'));
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [progress, setProgress] = useState<QualityExcelImportProgress | null>(null);
  const [preview, setPreview] = useState<QualityExcelImportPreview | null>(null);
  const [result, setResult] = useState<QualityExcelImportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const uploading = phase !== 'idle';

  const upload = async (candidate: File) => {
    let completedPreview: QualityExcelImportPreview | null = null;
    const completedCommits: QualityExcelImportResult[] = [];
    setFile(candidate);
    setPhase('scanning');
    setProgress(null);
    setPreview(null);
    setResult(null);
    setErrorMessage(null);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const scanned = await scanQualityWorkbook(candidate);
      setPhase('comparing');
      const comparison = await previewQualityExcel(scanned.manifest);
      completedPreview = comparison;
      setPreview(comparison);
      const chunks = createQualityImportChunks(comparison, scanned.manifest);
      for (const chunk of chunks) {
        setPhase('extracting');
        const requiredMedia = await scanned.extractMedia(chunk.mediaKeys);
        setPhase('uploading');
        completedCommits.push(await commitQualityExcel(
          scanned.manifest,
          requiredMedia,
          chunk.rowKeys,
          setProgress,
        ));
      }
      const response = combineQualityImportResults(comparison, completedCommits);
      setResult(response);
      void queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
      if (response.failed_count === 0) {
        toast.success(c.success);
      } else if (response.created_count + response.skipped_count + response.changed_count === 0) {
        toast.error(c.allFailed);
      } else {
        toast.warning(c.partialSuccess);
      }
    } catch (error) {
      const message = getUploadErrorMessage(error, c.uploadFailed, c.upstreamUnavailable);
      if (completedPreview) {
        setResult(combineQualityImportResults(completedPreview, completedCommits, {
          includeUnprocessedNewAsFailed: true,
          unprocessedMessage: c.completionUnconfirmed,
        }));
        void queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
        setErrorMessage(`${c.partialInterrupted}\n${message}`);
        toast.warning(c.partialInterrupted);
      } else {
        setErrorMessage(message);
        toast.error(message);
      }
    } finally {
      setPhase('idle');
    }
  };

  const selectFile = (candidate: File | null) => {
    if (!candidate) return;
    if (!canUpload) {
      toast.error(c.permissionDenied);
      return;
    }
    if (!candidate.name.toLowerCase().endsWith('.xlsx')) {
      toast.warning(c.invalidFile);
      return;
    }
    if (candidate.size <= 0) {
      toast.warning(c.emptyFile);
      return;
    }
    if (candidate.size > QUALITY_IMPORT_MAX_FILE_BYTES) {
      toast.warning(c.oversizedFile);
      return;
    }
    void upload(candidate);
  };

  const openReports = (ids: number[], kind: QualityReportHistoryScope['kind']) => {
    const reportIds = uniqueReportIds(ids);
    if (reportIds.length > 0) onPostProcess({ reportIds, kind });
  };

  const resultCreatedIds = result ? uniqueReportIds(result.created_report_ids) : [];
  const resultSkippedIds = result ? uniqueReportIds(result.skipped_report_ids) : [];
  const resultChangedIds = result ? uniqueReportIds(result.changed_report_ids) : [];
  const allResultIds = uniqueReportIds([
    ...resultCreatedIds,
    ...resultSkippedIds,
    ...resultChangedIds,
  ]);
  const resultHasFailures = Boolean(result?.failed_count);
  const resultAllFailed = Boolean(
    result
      && result.failed_count > 0
      && result.created_count + result.skipped_count + result.changed_count === 0,
  );
  const phaseLabel = phase === 'scanning'
    ? c.scanning
    : phase === 'comparing'
      ? c.comparing
      : phase === 'extracting'
        ? c.extracting
        : c.uploading;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-br from-white via-blue-50/40 to-cyan-50/60 shadow-sm">
        <div className="p-5 md:p-7">
          <div className="flex items-start gap-3">
            <span className="rounded-xl bg-blue-600 p-2.5 text-white shadow-sm">
              <FileSpreadsheet className="h-6 w-6" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-xl font-bold text-slate-950">{c.title}</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">{c.description}</p>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            disabled={uploading}
            onChange={(event) => {
              const candidate = event.currentTarget.files?.[0] || null;
              event.currentTarget.value = '';
              selectFile(candidate);
            }}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => {
              if (!canUpload) {
                toast.error(c.permissionDenied);
                return;
              }
              fileInputRef.current?.click();
            }}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (!uploading) selectFile(event.dataTransfer.files?.[0] || null);
            }}
            className={`mt-5 flex w-full items-center gap-4 rounded-xl border-2 border-dashed px-5 py-6 text-left transition disabled:cursor-wait disabled:opacity-70 ${dragging ? 'border-blue-500 bg-blue-100/70' : 'border-blue-200 bg-white/80 hover:border-blue-400 hover:bg-white'}`}
          >
            <span className="rounded-full bg-blue-50 p-3 text-blue-600">
              {uploading ? <Loader2 className="h-6 w-6 animate-spin" /> : <UploadCloud className="h-6 w-6" />}
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-sm text-slate-900">{file?.name || c.drop}</strong>
              <span className="mt-1 block text-xs text-slate-500">
                {file ? `${formatBytes(file.size)} · ${c.fileHelp}` : c.fileHelp}
              </span>
            </span>
          </button>

          {uploading && (
            <div className="mt-4" role="status">
              <div className="mb-1 flex flex-wrap justify-between gap-2 text-xs font-semibold text-blue-700">
                <span>{phaseLabel}</span>
                {phase === 'uploading' && progress && (
                  <span className="tabular-nums">
                    {formatBytes(progress.uploadedBytes)} / {formatBytes(progress.totalBytes)} · {progress.percent}%
                  </span>
                )}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-blue-100">
                <div
                  className={`h-full rounded-full bg-blue-600 transition-[width] ${phase === 'uploading' ? '' : 'animate-pulse'}`}
                  style={{ width: phase === 'uploading' ? `${progress?.percent || 0}%` : '55%' }}
                />
              </div>
              {preview && (
                <p className="mt-2 text-xs text-slate-600">
                  {interpolate(c.deltaSummary, {
                    rows: preview.new_count,
                    images: preview.images_to_upload,
                  })}
                </p>
              )}
            </div>
          )}

          {errorMessage && !uploading && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">
              <XCircle className="h-5 w-5 shrink-0 text-rose-600" />
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{errorMessage}</span>
              {file && (
                <button type="button" onClick={() => void upload(file)} className="inline-flex items-center gap-2 rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100">
                  <RefreshCw className="h-4 w-4" />{c.retry}
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {result && (
        <section className="space-y-5" aria-labelledby="quality-import-result-title">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 shadow-sm md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  {resultAllFailed ? (
                    <XCircle className="h-5 w-5 text-rose-600" aria-hidden="true" />
                  ) : resultHasFailures ? (
                    <AlertTriangle className="h-5 w-5 text-amber-600" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
                  )}
                  <h2 id="quality-import-result-title" className="text-lg font-bold text-slate-950">{c.resultTitle}</h2>
                </div>
                <p className="mt-1 break-all text-sm text-slate-600">{result.filename}</p>
                {resultHasFailures && (
                  <p className={`mt-2 text-sm font-semibold ${resultAllFailed ? 'text-rose-700' : 'text-amber-700'}`}>
                    {resultAllFailed ? c.allFailed : c.partialSuccess}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={resultCreatedIds.length === 0} onClick={() => openReports(resultCreatedIds, 'created')} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">
                  {c.createdPostProcess}
                </button>
                <button type="button" disabled={resultChangedIds.length === 0} onClick={() => openReports(resultChangedIds, 'changed')} className="rounded-lg border border-violet-300 bg-white px-3 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-40">
                  {c.changedPostProcess}
                </button>
                <button type="button" disabled={resultSkippedIds.length === 0} onClick={() => openReports(resultSkippedIds, 'skipped')} className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-40">
                  {c.skippedView}
                </button>
                <button type="button" disabled={allResultIds.length === 0} onClick={() => openReports(allResultIds, 'all')} className="rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40">
                  {c.allView}
                </button>
                {resultHasFailures && file && (
                  <button type="button" onClick={() => void upload(file)} className="inline-flex items-center gap-2 rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50">
                    <RefreshCw className="h-4 w-4" />{c.retryFailed}
                  </button>
                )}
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5 2xl:grid-cols-10">
              <ResultMetric icon={Rows3} label={c.total} value={result.total_rows} tone="text-blue-600" />
              <ResultMetric icon={CheckCircle2} label={c.created} value={result.created_count} tone="text-emerald-600" />
              <ResultMetric icon={GitCompareArrows} label={c.changed} value={result.changed_count} tone="text-violet-600" />
              <ResultMetric icon={SkipForward} label={c.skipped} value={result.skipped_count} tone="text-amber-600" />
              <ResultMetric icon={XCircle} label={c.failed} value={result.failed_count} tone="text-rose-600" />
              <ResultMetric icon={ImageIcon} label={c.imagesFound} value={result.images_found} tone="text-blue-500" />
              <ResultMetric icon={ImageIcon} label={c.imagesSaved} value={result.images_saved} tone="text-violet-600" />
              <ResultMetric icon={AlertTriangle} label={c.imagesFailed} value={result.images_failed} tone="text-rose-500" />
              <ResultMetric icon={ImageIcon} label={c.imagesIgnored} value={result.images_ignored} tone="text-slate-500" />
              <ResultMetric icon={SkipForward} label={c.imagesSkipped} value={result.images_skipped} tone="text-amber-500" />
            </div>

            {result.warnings.length > 0 && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <strong className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" />{c.workbookWarnings}</strong>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {result.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
                </ul>
              </div>
            )}
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="min-w-[1080px] w-full border-collapse text-left">
                <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">{c.source}</th>
                    <th className="px-4 py-3">{c.status}</th>
                    <th className="px-4 py-3">{c.report}</th>
                    <th className="px-4 py-3">{c.issue}</th>
                    <th className="px-4 py-3">{c.images}</th>
                    <th className="px-4 py-3">{c.notes}</th>
                    <th className="px-4 py-3 text-right">{c.action}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.rows.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500">{c.noRows}</td></tr>
                  ) : result.rows.map((row, index) => (
                    <tr key={`${row.sheet_name}-${row.source_row_number}-${row.source_sequence}-${index}`} className={row.status === 'failed' ? 'bg-rose-50/30' : row.status === 'changed' ? 'bg-violet-50/30' : 'hover:bg-blue-50/30'}>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-700">
                        <strong className="block text-slate-900">{row.sheet_name}</strong>
                        <span className="text-xs text-slate-500">#{row.source_row_number}{row.source_sequence ? ` · No.${row.source_sequence}` : ''}</span>
                      </td>
                      <td className="px-4 py-3"><span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset ${statusStyle(row.status)}`}>{statusLabel(row.status, c)}</span></td>
                      <td className="px-4 py-3 text-sm text-slate-700">
                        <span className="block whitespace-nowrap">{row.report_date || c.unknown}</span>
                        <span className="mt-0.5 block text-xs text-slate-500">{row.section || c.unknown}</span>
                        {row.report_id && <span className="mt-0.5 block text-xs font-semibold text-blue-700">{c.reportNumber.replace('{id}', String(row.report_id))}</span>}
                      </td>
                      <td className="max-w-sm px-4 py-3 text-sm text-slate-700">
                        <strong className="block truncate text-slate-900">{row.model || c.unknown}</strong>
                        <span className="block truncate font-mono text-xs text-blue-700">{row.part_no || c.unknown}</span>
                        <p className="mt-1 line-clamp-2 leading-5">{row.phenomenon || '-'}</p>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-600">
                        <span className="font-semibold text-violet-700">{row.images_saved.toLocaleString()}</span>
                        <span> / {row.images_found.toLocaleString()}</span>
                      </td>
                      <td className="max-w-sm px-4 py-3 text-sm text-slate-600">
                        {row.message && <p className="whitespace-pre-wrap break-words">{row.message}</p>}
                        {row.warnings.length > 0 && (
                          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-700">
                            {row.warnings.map((warning, warningIndex) => <li key={`${warning}-${warningIndex}`}>{warning}</li>)}
                          </ul>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button type="button" disabled={!row.report_id} onClick={() => row.report_id && openReports([row.report_id], row.status === 'created' ? 'created' : row.status === 'changed' ? 'changed' : 'skipped')} className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40">
                          <Eye className="h-3.5 w-3.5" />{c.viewReport}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
