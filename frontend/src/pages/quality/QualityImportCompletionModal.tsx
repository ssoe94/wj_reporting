import { Fragment } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  FileSpreadsheet,
  Rows3,
  X,
} from 'lucide-react';
import { useLang } from '../../i18n';
import type { QualityExcelImportResult } from './importTypes';

const copy = {
  ko: {
    title: 'Excel 업로드 처리 완료',
    description: '업로드 결과를 확인했습니다. 아래 요약을 확인한 뒤 보고 이력으로 이동할 수 있습니다.',
    descriptionWithFailures: '업로드는 완료되었지만 확인이 필요한 행이 남아 있습니다.',
    file: '업로드 파일',
    sheet: '선택 시트',
    fileDataPeriod: '파일 데이터 기간',
    fileDataPeriodHelp: '파일에 포함된 전체 보고일 범위',
    appliedPeriod: '이번 반영 기간',
    appliedPeriodHelp: '신규 등록·변경된 행의 보고일 범위',
    total: '총 건수',
    succeeded: '처리 성공',
    created: '신규 등록',
    changed: '변경 감지',
    skipped: '기존 건너뜀',
    failed: '실패',
    remainingFailures: '실패 {count}건이 남아 있습니다. 입력 오류는 업로드 화면에서 이어서 수정할 수 있습니다.',
    continueFailures: '실패 수정 계속',
    reviewResults: '처리 결과 확인',
    details: '상세 결과 보기',
    complete: '업로드 완료',
    close: '닫기',
    unknown: '—',
  },
  zh: {
    title: 'Excel 上传处理完成',
    description: '上传结果已确认。查看以下摘要后，可前往报告记录。',
    descriptionWithFailures: '上传已完成，但仍有需要确认的行。',
    file: '上传文件',
    sheet: '所选工作表',
    fileDataPeriod: '文件数据期间',
    fileDataPeriodHelp: '文件内全部报告日期范围',
    appliedPeriod: '本次更新期间',
    appliedPeriodHelp: '新增登记及变更行的报告日期范围',
    total: '总行数',
    succeeded: '处理成功',
    created: '新增登记',
    changed: '检测到变更',
    skipped: '跳过已有',
    failed: '失败',
    remainingFailures: '仍有 {count} 行失败。输入错误可返回上传页面继续修改。',
    continueFailures: '继续修改失败行',
    reviewResults: '查看处理结果',
    details: '查看详细结果',
    complete: '上传完成',
    close: '关闭',
    unknown: '—',
  },
} as const;

function interpolate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, value.toLocaleString()),
    template,
  );
}

function isValidIsoDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validDateRange(values: Array<string | null>): string | null {
  const dates = values
    .filter(isValidIsoDate)
    .sort();
  if (dates.length === 0) return null;
  const first = dates[0];
  const last = dates[dates.length - 1];
  return first === last ? first : `${first} ~ ${last}`;
}

interface QualityImportCompletionModalProps {
  open: boolean;
  result: QualityExcelImportResult;
  selectedSheetName: string | null;
  canOpenHistory: boolean;
  completionDisabled: boolean;
  onClose: () => void;
  onReviewFailures: () => void;
  onShowDetails: () => void;
  onComplete: () => void;
}

export default function QualityImportCompletionModal({
  open,
  result,
  selectedSheetName,
  canOpenHistory,
  completionDisabled,
  onClose,
  onReviewFailures,
  onShowDetails,
  onComplete,
}: QualityImportCompletionModalProps) {
  const { lang } = useLang();
  const c = copy[lang === 'zh' ? 'zh' : 'ko'];
  const hasFailures = result.failed_count > 0;
  const hasEditableFailures = result.rows.some((row) => (
    row.status === 'failed' && row.editable && row.import_row_id !== null
  ));
  const guardedPrimaryLabel = canOpenHistory
    ? c.complete
    : hasEditableFailures
      ? c.continueFailures
      : c.reviewResults;
  const guardedPrimaryAction = canOpenHistory
    ? onComplete
    : hasEditableFailures
      ? onReviewFailures
      : onShowDetails;
  const fileDataPeriod = validDateRange(result.rows.map((row) => row.report_date));
  const appliedPeriod = validDateRange(result.rows
    .filter((row) => row.status === 'created' || row.status === 'changed')
    .map((row) => row.report_date));
  const sheetName = selectedSheetName
    || result.rows.find((row) => row.sheet_name)?.sheet_name
    || c.unknown;
  const metrics = [
    { label: c.total, value: result.total_rows, tone: 'text-blue-700', bg: 'bg-blue-50' },
    { label: c.succeeded, value: result.created_count + result.changed_count + result.skipped_count, tone: 'text-cyan-700', bg: 'bg-cyan-50' },
    { label: c.created, value: result.created_count, tone: 'text-emerald-700', bg: 'bg-emerald-50' },
    { label: c.changed, value: result.changed_count, tone: 'text-violet-700', bg: 'bg-violet-50' },
    { label: c.skipped, value: result.skipped_count, tone: 'text-amber-700', bg: 'bg-amber-50' },
    { label: c.failed, value: result.failed_count, tone: 'text-rose-700', bg: 'bg-rose-50' },
  ];

  return (
    <Transition.Root show={open} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-slate-950/55 backdrop-blur-sm" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 sm:p-6">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 translate-y-3 sm:scale-95"
              enterTo="opacity-100 translate-y-0 sm:scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 translate-y-0 sm:scale-100"
              leaveTo="opacity-0 translate-y-3 sm:scale-95"
            >
              <Dialog.Panel className="flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-slate-900/10">
                <div className={`shrink-0 border-b px-4 py-5 sm:px-7 ${hasFailures ? 'border-amber-100 bg-amber-50/70' : 'border-emerald-100 bg-emerald-50/70'}`}>
                  <div className="flex items-start gap-3 sm:gap-4">
                    <span className={`rounded-2xl p-3 text-white shadow-sm ${hasFailures ? 'bg-amber-500' : 'bg-emerald-600'}`}>
                      {hasFailures
                        ? <AlertTriangle className="h-6 w-6" aria-hidden="true" />
                        : <CheckCircle2 className="h-6 w-6" aria-hidden="true" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Dialog.Title className="text-lg font-bold text-slate-950 sm:text-2xl">
                        {c.title}
                      </Dialog.Title>
                      <p className="mt-1 text-sm leading-6 text-slate-600">
                        {hasFailures ? c.descriptionWithFailures : c.description}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={onClose}
                      className="rounded-xl p-2 text-slate-500 hover:bg-white hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      aria-label={c.close}
                    >
                      <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <p className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                        <FileSpreadsheet className="h-4 w-4 text-blue-600" aria-hidden="true" />{c.file}
                      </p>
                      <p className="mt-1 truncate text-sm font-bold text-slate-900" title={result.filename}>{result.filename}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <p className="text-xs font-semibold text-slate-500">{c.sheet}</p>
                      <p className="mt-1 text-sm font-bold text-slate-900">{sheetName}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <p className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                        <CalendarRange className="h-4 w-4 text-blue-600" aria-hidden="true" />{c.fileDataPeriod}
                      </p>
                      <p className="mt-1 text-base font-bold tabular-nums text-slate-900">{fileDataPeriod || c.unknown}</p>
                      <p className="mt-1 text-xs text-slate-500">{c.fileDataPeriodHelp}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <p className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                        <CalendarRange className="h-4 w-4 text-violet-600" aria-hidden="true" />{c.appliedPeriod}
                      </p>
                      <p className="mt-1 text-base font-bold tabular-nums text-slate-900">{appliedPeriod || c.unknown}</p>
                      <p className="mt-1 text-xs text-slate-500">{c.appliedPeriodHelp}</p>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
                    {metrics.map((metric) => (
                      <div key={metric.label} className={`rounded-xl px-3 py-3 ${metric.bg}`}>
                        <p className="text-xs font-semibold text-slate-600">{metric.label}</p>
                        <p className={`mt-1 text-2xl font-bold tabular-nums ${metric.tone}`}>{metric.value.toLocaleString()}</p>
                      </div>
                    ))}
                  </div>

                  {hasFailures && (
                    <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold leading-6 text-rose-800" role="status">
                      {interpolate(c.remainingFailures, { count: result.failed_count })}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-col gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4 sm:flex-row-reverse sm:items-center sm:px-7">
                  <button
                    type="button"
                    autoFocus={!completionDisabled && (!hasFailures || !canOpenHistory)}
                    disabled={completionDisabled}
                    onClick={guardedPrimaryAction}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-50"
                  >
                    <Rows3 className="h-4 w-4" aria-hidden="true" />
                    {guardedPrimaryLabel}
                  </button>
                  {hasFailures && canOpenHistory && (
                    <button
                      type="button"
                      autoFocus
                      onClick={onReviewFailures}
                      className="rounded-xl border border-rose-300 bg-white px-4 py-2.5 text-sm font-semibold text-rose-700 hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-500"
                    >
                      {hasEditableFailures ? c.continueFailures : c.reviewResults}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onShowDetails}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {c.details}
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
