import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
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
import QualityExcelRollbackButton from './QualityExcelRollbackButton';
import { useAuth } from '../../contexts/AuthContext';
import { useLang } from '../../i18n';
import {
  QUALITY_IMPORT_MAX_FILE_BYTES,
  completeQualityExcelDirectAsset,
  finalizeQualityExcelDirectJob,
  previewQualityExcel,
  prepareQualityExcelDirectJob,
} from './importApi';
import QualityImportFailedRowEditor, {
  qualityImportFailureMessage,
} from './QualityImportFailedRowEditor';
import { scanQualityWorkbook } from './qualityWorkbookScanner';
import { deliverQualityDirectAssets } from './qualityDirectCloudinaryUpload';
import {
  combineQualityImportResults,
  createQualityImportChunks,
  sortQualityImportRows,
} from './importResult';
import {
  acceptedQualityImportJobIds,
  clearQualityImportWorkflow,
  loadQualityImportWorkflow,
  saveQualityImportWorkflow,
} from './qualityImportJobs';
import type { PersistedQualityImportWorkflow } from './qualityImportJobs';
import type {
  QualityExcelImportPreview,
  QualityExcelImportProgress,
  QualityExcelImportResult,
  QualityExcelImportRowResult,
  QualityImportRowWorkflowResult,
  QualityReportHistoryScope,
} from './importTypes';

const copy = {
  ko: {
    title: 'Excel 품질 이슈 업로드',
    description: 'Excel은 브라우저에서 비교하고, 신규 사진은 이 PC에서 Cloudinary로 직접 전송한 뒤 서버에는 판정 결과만 등록합니다.',
    drop: '.xlsx 파일을 놓거나 클릭해 선택하세요',
    fileHelp: '최대 80MB · 같은 내용은 건너뛰고 사진은 행당 최대 5장 저장합니다.',
    scanning: 'Excel을 기기에서 분석 중',
    comparing: '기존 보고서와 비교 중',
    preparing: '안전한 Cloudinary 사진 경로 준비 중',
    extracting: '신규 행의 사진을 이 PC에서 준비 중',
    uploading: '이 PC에서 Cloudinary로 사진 직접 전송 중',
    finalizing: '사진 확인 및 품질 보고서 등록 중',
    overallProgress: '전체 진행 {completed}/{total}개 묶음 · {percent}%',
    currentChunkUpload: '현재 묶음 사진 {uploaded} / {total} · {percent}%',
    overallProgressLabel: 'Excel 전체 처리 진행률',
    deltaSummary: '신규 {newRows}건 · 수정 필요 {failedRows}건 · 전송 사진 {images}장',
    success: 'Excel 처리가 완료되었습니다.',
    partialSuccess: '일부 행은 입력값 수정 또는 재확인이 필요합니다. 아래 실패 행을 확인하세요.',
    allFailed: '등록된 행이 없습니다. 아래 실패 원인을 확인하고 수정 가능한 행은 바로 등록하세요.',
    upstreamUnavailable: 'Cloudinary 또는 서버 확인이 지연되었습니다. 같은 Excel 파일을 다시 선택하면 완료된 사진은 건너뛰고 이어서 진행합니다.',
    acceptanceInterrupted: '직접 전송이 중단되었습니다. 같은 Excel 파일을 다시 선택하면 완료된 사진은 건너뛰고 이어서 진행합니다.',
    resumeSameFile: '직접 전송을 재개하려면 같은 Excel 파일을 다시 선택해 주세요.',
    otherImportPending: '먼저 시작한 Excel 직접 전송이 남아 있습니다. 같은 파일로 완료한 뒤 새 파일을 올려 주세요.',
    invalidFile: '.xlsx 형식의 Excel 파일만 선택할 수 있습니다.',
    emptyFile: '내용이 없는 파일은 업로드할 수 없습니다.',
    oversizedFile: 'Excel 파일은 최대 80MB까지 업로드할 수 있습니다.',
    permissionDenied: '품질 자료를 업로드할 권한이 없습니다.',
    retry: '다시 시도',
    selectSameFile: '같은 파일 선택',
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
    selectedSheet: '처리 대상: {sheet} 시트만 · OQC 이력 및 다른 월 시트는 제외합니다.',
    createdPostProcess: '신규 보고서 확인',
    createdReviewHelp: '보고서 등록은 이미 완료되었습니다. 아래 버튼은 신규 보고서를 확인하거나 처리 결과를 입력할 때 사용합니다.',
    skippedView: '기존 건 보기',
    changedPostProcess: '변경 건 확인',
    allView: '전체 결과 보기',
    source: '원본 위치',
    status: '결과',
    report: '보고서',
    issue: '품질 이슈',
    images: '사진',
    notes: '메시지',
    action: '확인',
    noRows: '표시할 행별 결과가 없습니다.',
    unknown: '미확인',
    reportNumber: '보고서 #{id}',
    viewReport: '보고서 보기',
    uploadFailed: 'Excel 업로드에 실패했습니다.',
    fixRequiredTitle: '수정 필요한 행',
    fixRequiredDescription: '{count}개 행은 입력값을 바로잡아야 등록됩니다. 실패 원인을 확인하고 수정 후 등록하세요.',
  },
  zh: {
    title: '上传 Excel 品质问题',
    description: '浏览器比较 Excel 后，由此电脑将新增图片直接上传到 Cloudinary，服务器仅登记判定结果。',
    drop: '拖入或点击选择 .xlsx 文件',
    fileHelp: '最大 80MB · 跳过相同内容，每行最多保存 5 张图片。',
    scanning: '正在本机分析 Excel',
    comparing: '正在与已有报告比较',
    preparing: '正在准备安全的 Cloudinary 图片路径',
    extracting: '正在此电脑准备新增记录的图片',
    uploading: '正在从此电脑直接上传图片到 Cloudinary',
    finalizing: '正在确认图片并登记品质报告',
    overallProgress: '总体进度 {completed}/{total} 个批次 · {percent}%',
    currentChunkUpload: '当前批次图片 {uploaded} / {total} · {percent}%',
    overallProgressLabel: 'Excel 整体处理进度',
    deltaSummary: '新增 {newRows} 行 · 需修改 {failedRows} 行 · 传输图片 {images} 张',
    success: 'Excel 处理完成。',
    partialSuccess: '部分行需要修改输入值或重新确认，请查看下方失败行。',
    allFailed: '没有登记任何行，请确认下方失败原因，可修改的行可直接登记。',
    upstreamUnavailable: 'Cloudinary 或服务器确认暂时延迟。重新选择同一 Excel 文件后，将跳过已完成的图片并继续。',
    acceptanceInterrupted: '直接上传已中断。重新选择同一 Excel 文件后，将跳过已完成的图片并继续。',
    resumeSameFile: '请重新选择同一 Excel 文件以继续直接上传。',
    otherImportPending: '已有 Excel 直接上传尚未完成。请先用同一文件完成，再上传新文件。',
    invalidFile: '只能选择 .xlsx 格式的 Excel 文件。',
    emptyFile: '无法上传空文件。',
    oversizedFile: 'Excel 文件最大可上传 80MB。',
    permissionDenied: '您没有上传品质资料的权限。',
    retry: '重试',
    selectSameFile: '选择同一文件',
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
    selectedSheet: '处理范围：仅 {sheet} 工作表 · 排除 OQC 历史表及其他月份。',
    createdPostProcess: '查看新增报告',
    createdReviewHelp: '报告登记已经完成。下方按钮仅用于查看新增报告或填写处理结果。',
    skippedView: '查看已有报告',
    changedPostProcess: '确认变更记录',
    allView: '查看全部结果',
    source: '源位置',
    status: '结果',
    report: '报告',
    issue: '品质问题',
    images: '图片',
    notes: '消息',
    action: '查看',
    noRows: '没有可显示的逐行结果。',
    unknown: '未确认',
    reportNumber: '报告 #{id}',
    viewReport: '查看报告',
    uploadFailed: 'Excel 上传失败。',
    fixRequiredTitle: '需要修改的行',
    fixRequiredDescription: '{count} 行需要更正输入值后才能登记。请确认失败原因并修改后登记。',
  },
} as const;

type Copy = (typeof copy)[keyof typeof copy];
type ImportPhase = 'idle' | 'scanning' | 'comparing' | 'preparing' | 'extracting' | 'uploading' | 'finalizing';

interface DirectWorkflowProgress {
  completedChunks: number;
  totalChunks: number;
  currentChunkFraction: number;
}

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
    if (error.code === 'ECONNABORTED' || /\btimeout\b/i.test(error.message || '')) {
      return upstreamFallback;
    }
    if (!error.response && (error.request || error.code === 'ERR_NETWORK')) return upstreamFallback;
    const payload: unknown = error.response?.data;
    const status = error.response?.status;
    const contentType = String(error.response?.headers['content-type'] || '').toLowerCase();
    const isUpstreamFailure = status != null && [502, 503, 504].includes(status);
    if (isUpstreamFailure) return upstreamFallback;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      const detail = [record.error, record.detail, record.code]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
        ?.trim();
      if (detail && /\btimeout\b/i.test(detail)) return upstreamFallback;
      if (detail && detail.length <= 1_000 && !/^\s*</.test(detail)) return detail;
      return fallback;
    }
    if (typeof payload === 'string' && payload.trim()) {
      const text = payload.trim();
      const looksLikeMarkup = /^\s*</.test(text) || /<(?:!doctype|html|head|body|title)\b/i.test(text);
      if (/\btimeout\b/i.test(text) || contentType.includes('text/html')) return upstreamFallback;
      if (looksLikeMarkup || text.length > 1_000) return fallback;
      return text;
    }
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

function interpolate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, value.toLocaleString()),
    template,
  );
}

function sortedRowKeysKey(rowKeys: readonly string[]): string {
  return JSON.stringify([...rowKeys].sort());
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
  const [selectedSheetName, setSelectedSheetName] = useState<string | null>(null);
  const [workflowProgress, setWorkflowProgress] = useState<DirectWorkflowProgress | null>(null);
  const [pendingWorkflow, setPendingWorkflow] = useState<PersistedQualityImportWorkflow | null>(null);
  const uploading = phase !== 'idle';

  useEffect(() => {
    const restored = loadQualityImportWorkflow();
    if (!restored) return;
    setPendingWorkflow(restored);
    setPreview(restored.preview);
    setSelectedSheetName(restored.selectedSheetName);
    setWorkflowProgress({
      completedChunks: 0,
      totalChunks: restored.chunks.length,
      currentChunkFraction: 0,
    });
    // Raw workbook Blobs are deliberately not persisted. Reload recovery is
    // explicit: the user reselects the same SHA-identical workbook, then every
    // chunk is prepared again so the backend returns only missing assets.
    setErrorMessage(c.resumeSameFile);
  }, [c.resumeSameFile]);

  const upload = async (candidate: File) => {
    let workflow: PersistedQualityImportWorkflow | null = null;
    setFile(candidate);
    setPhase('scanning');
    setProgress(null);
    setWorkflowProgress(null);
    setPreview(null);
    setResult(null);
    setErrorMessage(null);
    setSelectedSheetName(null);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const scanned = await scanQualityWorkbook(candidate);
      const selectedSheet = scanned.manifest.sheets[0]?.sheet_name || '';
      setSelectedSheetName(selectedSheet);

      const stored = loadQualityImportWorkflow();
      if (
        stored
        && stored.workbookSha256 !== scanned.manifest.workbook_sha256
        && acceptedQualityImportJobIds(stored).length > 0
      ) {
        setFile(null);
        setPendingWorkflow(stored);
        setPreview(stored.preview);
        setSelectedSheetName(stored.selectedSheetName);
        setErrorMessage(c.otherImportPending);
        toast.warning(c.otherImportPending);
        return;
      }
      const sameWorkbook = stored?.workbookSha256 === scanned.manifest.workbook_sha256;
      if (stored && !sameWorkbook) clearQualityImportWorkflow();
      setPhase('comparing');
      const comparison = await previewQualityExcel(scanned.manifest);
      setPreview(comparison);
      setSelectedSheetName(selectedSheet);
      const storedChunksByRowKeys = new Map(
        sameWorkbook && stored
          ? stored.chunks.map((chunk) => [sortedRowKeysKey(chunk.rowKeys), chunk] as const)
          : [],
      );
      const chunks = createQualityImportChunks(comparison, scanned.manifest);
      workflow = {
        version: 2,
        deliveryMode: 'browser_direct',
        filename: comparison.filename,
        workbookSha256: scanned.manifest.workbook_sha256,
        selectedSheetName: selectedSheet,
        preview: comparison,
        chunks: chunks.map((chunk) => {
          const preserved = storedChunksByRowKeys.get(sortedRowKeysKey(chunk.rowKeys));
          return {
            ...chunk,
            jobId: preserved?.jobId ?? null,
            receipts: preserved ? [...preserved.receipts] : [],
          };
        }),
        acceptedAt: sameWorkbook && stored ? stored.acceptedAt : new Date().toISOString(),
      };
      saveQualityImportWorkflow(workflow);

      if (!workflow) throw new Error(c.uploadFailed);
      setPendingWorkflow(workflow);
      setWorkflowProgress({
        completedChunks: 0,
        totalChunks: workflow.chunks.length,
        currentChunkFraction: 0,
      });
      const commits: QualityExcelImportResult[] = [];
      const jobWarnings: string[] = [];
      for (let index = 0; index < workflow.chunks.length; index += 1) {
        const chunk = workflow.chunks[index];
        setPhase('preparing');
        setProgress(null);
        // Prepare every chunk on every same-file retry. The backend returns
        // upload intents only for assets whose Cloudinary receipt is missing.
        const job = await prepareQualityExcelDirectJob(
          scanned.manifest,
          chunk.rowKeys,
          chunk.mediaKeys,
        );
        workflow = {
          ...workflow,
          chunks: workflow.chunks.map((item, chunkIndex) => (
            chunkIndex === index
              ? {
                ...item,
                jobId: job.id,
                receipts: item.receipts.filter((receipt) => (
                  job.upload_intents.some((intent) => (
                    intent.asset_sha256 === receipt.assetSha256
                    && intent.upload.public_id === receipt.public_id
                  ))
                )),
              }
              : item
          )),
        };
        saveQualityImportWorkflow(workflow);
        setPendingWorkflow(workflow);
        if (job.upload_intents.length > 0) {
          const currentChunk = workflow.chunks[index];
          const savedReceipts = new Map(currentChunk.receipts.map((receipt) => [
            receipt.assetSha256,
            {
              public_id: receipt.public_id,
              version: receipt.version,
              signature: receipt.signature,
            },
          ]));
          setPhase('extracting');
          setWorkflowProgress((current) => (
            current ? { ...current, currentChunkFraction: 0.1 } : current
          ));
          const requiredKeys = [...new Set(
            job.upload_intents
              .filter((intent) => !savedReceipts.has(intent.asset_sha256))
              .map((intent) => intent.media_keys[0]),
          )];
          const requiredMedia = await scanned.extractMedia(requiredKeys);
          setPhase('uploading');
          setWorkflowProgress((current) => (
            current ? { ...current, currentChunkFraction: 0.1 } : current
          ));
          await deliverQualityDirectAssets({
            intents: job.upload_intents,
            media: requiredMedia,
            receipts: savedReceipts,
            onProgress: (nextProgress) => {
              setProgress(nextProgress);
              setWorkflowProgress((current) => (
                current
                  ? {
                    ...current,
                    currentChunkFraction: 0.1 + (0.8 * (nextProgress.percent / 100)),
                  }
                  : current
              ));
            },
            onReceipt: (intent, receipt) => {
              if (!workflow) throw new Error(c.uploadFailed);
              workflow = {
                ...workflow,
                chunks: workflow.chunks.map((item, chunkIndex) => (
                  chunkIndex === index
                    ? {
                      ...item,
                      receipts: [
                        ...item.receipts.filter((saved) => saved.assetSha256 !== intent.asset_sha256),
                        { assetSha256: intent.asset_sha256, ...receipt },
                      ],
                    }
                    : item
                )),
              };
              saveQualityImportWorkflow(workflow);
              setPendingWorkflow(workflow);
            },
            confirm: async (intent, receipt) => {
              await completeQualityExcelDirectAsset(job.id, intent.asset_sha256, receipt);
              if (!workflow) throw new Error(c.uploadFailed);
              workflow = {
                ...workflow,
                chunks: workflow.chunks.map((item, chunkIndex) => (
                  chunkIndex === index
                    ? {
                      ...item,
                      receipts: item.receipts.filter(
                        (saved) => saved.assetSha256 !== intent.asset_sha256,
                      ),
                    }
                    : item
                )),
              };
              saveQualityImportWorkflow(workflow);
              setPendingWorkflow(workflow);
            },
          });
        }
        setPhase('finalizing');
        setWorkflowProgress((current) => (
          current ? { ...current, currentChunkFraction: 0.9 } : current
        ));
        const finalized = await finalizeQualityExcelDirectJob(job.id);
        if (!finalized.result) throw new Error(c.uploadFailed);
        commits.push(finalized.result);
        jobWarnings.push(...finalized.warnings);
        setWorkflowProgress({
          completedChunks: index + 1,
          totalChunks: workflow.chunks.length,
          currentChunkFraction: 0,
        });
      }
      const response = combineQualityImportResults(workflow.preview, commits);
      response.warnings = [...new Set([...response.warnings, ...jobWarnings])].sort();
      setResult(response);
      clearQualityImportWorkflow(workflow.workbookSha256);
      setPendingWorkflow(null);
      void queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
      if (response.failed_count === 0) toast.success(c.success);
      else if (response.created_count + response.skipped_count + response.changed_count === 0) {
        toast.error(c.allFailed);
      } else {
        toast.warning(c.partialSuccess);
      }
    } catch (error) {
      const message = getUploadErrorMessage(error, c.uploadFailed, c.upstreamUnavailable);
      if (workflow) {
        setPendingWorkflow(workflow);
        setErrorMessage(`${c.acceptanceInterrupted}\n${message}`);
        toast.warning(c.acceptanceInterrupted);
      } else {
        setErrorMessage(message);
        toast.error(message);
      }
    } finally {
      setPhase('idle');
    }
  };

  const retryPendingWorkflow = async () => {
    if (file) void upload(file);
    else fileInputRef.current?.click();
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

  const handleCorrectedRowRegistered = (
    sourceRow: QualityExcelImportRowResult,
    publishedRow: QualityImportRowWorkflowResult,
    successMessage: string,
  ) => {
    const reportId = publishedRow.approved_report;
    if (!reportId) return;
    setResult((current) => {
      if (!current) return current;
      const rows = current.rows.map((row) => row.row_key === sourceRow.row_key ? {
        ...row,
        import_row_id: publishedRow.id,
        editable: false,
        failure_code: '',
        validation_errors: [],
        status: 'created' as const,
        report_id: reportId,
        report_date: publishedRow.report_date,
        section: publishedRow.section,
        occurrence_location: publishedRow.occurrence_location,
        model: publishedRow.model,
        part_no: publishedRow.part_no,
        lot_qty: publishedRow.lot_qty,
        inspection_qty: publishedRow.inspection_qty,
        defect_qty: publishedRow.defect_qty,
        defect_rate: publishedRow.defect_rate,
        judgement: publishedRow.judgement,
        phenomenon: publishedRow.phenomenon,
        disposition: publishedRow.disposition,
        action_result: publishedRow.action_result,
        message: successMessage,
      } : row).sort(sortQualityImportRows);
      return {
        ...current,
        created_count: rows.filter((row) => row.status === 'created').length,
        skipped_count: rows.filter((row) => row.status === 'skipped').length,
        changed_count: rows.filter((row) => row.status === 'changed').length,
        failed_count: rows.filter((row) => row.status === 'failed').length,
        created_report_ids: uniqueReportIds([...current.created_report_ids, reportId]),
      };
    });
    void queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
  };

  const resultCreatedIds = result ? uniqueReportIds(result.created_report_ids) : [];
  const resultSkippedIds = result ? uniqueReportIds(result.skipped_report_ids) : [];
  const resultChangedIds = result ? uniqueReportIds(result.changed_report_ids) : [];
  const allResultIds = uniqueReportIds([
    ...resultCreatedIds,
    ...resultSkippedIds,
    ...resultChangedIds,
  ]);
  const editableFailedRows = result?.rows.filter((row) => (
    row.status === 'failed' && row.editable && row.import_row_id !== null
  )) || [];
  const hasNonEditableFailures = Boolean(result?.rows.some((row) => (
    row.status === 'failed' && !(row.editable && row.import_row_id !== null)
  )));
  const tableResultRows = result?.rows.filter((row) => !(
    row.status === 'failed' && row.editable && row.import_row_id !== null
  )) || [];
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
      : phase === 'preparing'
        ? c.preparing
        : phase === 'extracting'
          ? c.extracting
          : phase === 'finalizing'
            ? c.finalizing
            : c.uploading;
  const workflowPercent = workflowProgress && workflowProgress.totalChunks > 0
    ? workflowProgress.completedChunks >= workflowProgress.totalChunks
      ? 100
      : Math.min(99, Math.floor((
        (workflowProgress.completedChunks + workflowProgress.currentChunkFraction)
        / workflowProgress.totalChunks
      ) * 100))
    : 0;
  const overallProgressText = workflowProgress
    ? interpolate(c.overallProgress, {
      completed: workflowProgress.completedChunks,
      total: workflowProgress.totalChunks,
      percent: workflowPercent,
    })
    : null;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-br from-white via-blue-50/40 to-cyan-50/60 shadow-sm">
        <div className="p-5 md:p-7">
          <div className="flex flex-wrap items-start gap-3">
            <span className="rounded-xl bg-blue-600 p-2.5 text-white shadow-sm">
              <FileSpreadsheet className="h-6 w-6" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-bold text-slate-950">{c.title}</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">{c.description}</p>
            </div>
            <QualityExcelRollbackButton
              disabled={uploading}
              onRolledBack={() => {
                clearQualityImportWorkflow();
                setFile(null);
                setPendingWorkflow(null);
                setPreview(null);
                setResult(null);
                setProgress(null);
                setWorkflowProgress(null);
                setSelectedSheetName(null);
                setErrorMessage(null);
              }}
            />
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
              <strong className="block truncate text-sm text-slate-900">{file?.name || pendingWorkflow?.filename || c.drop}</strong>
              <span className="mt-1 block text-xs text-slate-500">
                {file ? `${formatBytes(file.size)} · ${c.fileHelp}` : c.fileHelp}
              </span>
            </span>
          </button>

          {selectedSheetName && (
            <p className="mt-3 rounded-lg border border-blue-200 bg-white/80 px-3 py-2 text-xs font-semibold text-blue-800">
              {interpolate(c.selectedSheet, { sheet: selectedSheetName })}
            </p>
          )}

          {uploading && (
            <div className="mt-4">
              <div className="mb-1 flex flex-wrap justify-between gap-2 text-xs font-semibold text-blue-700">
                <span>{phaseLabel}</span>
                {overallProgressText && <span className="tabular-nums">{overallProgressText}</span>}
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-blue-100"
                role="progressbar"
                aria-label={c.overallProgressLabel}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={workflowProgress ? workflowPercent : undefined}
                aria-valuetext={overallProgressText || phaseLabel}
              >
                <div
                  className={`h-full rounded-full bg-blue-600 transition-[width] ${workflowProgress ? '' : 'animate-pulse'}`}
                  style={{
                    width: workflowProgress ? `${workflowPercent}%` : '55%',
                  }}
                />
              </div>
              {phase === 'uploading' && progress && (
                <p className="mt-1 text-right text-xs tabular-nums text-slate-500">
                  {interpolate(c.currentChunkUpload, {
                    uploaded: formatBytes(progress.uploadedBytes),
                    total: formatBytes(progress.totalBytes),
                    percent: progress.percent,
                  })}
                </p>
              )}
              {preview && (
                <p className="mt-2 text-xs text-slate-600">
                  {interpolate(c.deltaSummary, {
                    newRows: preview.new_count,
                    failedRows: preview.rows.filter((row) => (
                      row.status === 'failed' && row.editable
                    )).length,
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
              {(file || pendingWorkflow) && (
                <button type="button" onClick={() => void retryPendingWorkflow()} className="inline-flex items-center gap-2 rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100">
                  <RefreshCw className="h-4 w-4" />
                  {pendingWorkflow
                    ? file
                      ? c.retry
                      : c.selectSameFile
                    : c.retry}
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {result && (
        <section className="space-y-5" aria-labelledby="quality-import-result-title">
          {editableFailedRows.length > 0 && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-5 shadow-sm md:p-6">
              <div className="flex items-start gap-3">
                <span className="rounded-xl bg-rose-600 p-2.5 text-white shadow-sm">
                  <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-lg font-bold text-slate-950">{c.fixRequiredTitle}</h2>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {interpolate(c.fixRequiredDescription, { count: editableFailedRows.length })}
                  </p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {editableFailedRows.map((row) => (
                  <QualityImportFailedRowEditor
                    key={row.row_key}
                    row={row}
                    onRegistered={handleCorrectedRowRegistered}
                  />
                ))}
              </div>
            </div>
          )}
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
                {resultCreatedIds.length > 0 && (
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                    {c.createdReviewHelp}
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
                {hasNonEditableFailures && (file || pendingWorkflow) && (
                  <button type="button" onClick={() => void retryPendingWorkflow()} className="inline-flex items-center gap-2 rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50">
                    <RefreshCw className="h-4 w-4" />
                    {c.retry}
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
                  {tableResultRows.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500">{c.noRows}</td></tr>
                  ) : tableResultRows.map((row) => (
                    <tr key={row.row_key} className={row.status === 'failed' ? 'bg-rose-50/30' : row.status === 'changed' ? 'bg-violet-50/30' : 'hover:bg-blue-50/30'}>
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
                        {row.message && (
                          <p className="whitespace-pre-wrap break-words">
                            {row.status === 'failed'
                              ? qualityImportFailureMessage(row, lang === 'zh' ? 'zh' : 'ko')
                              : row.message}
                          </p>
                        )}
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
