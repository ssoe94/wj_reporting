import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Factory,
  ImageOff,
  Search,
  ShieldAlert,
  X,
  ZoomIn,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';

import { usePartSpecSearch, type PartSpec } from '../../hooks/usePartSpecs';

export type EvidenceMatchLevel = 'exact_part' | 'related_prefix';

export type DailyAttentionEvidenceCase = {
  id: number;
  reportDt: string;
  section: string;
  model: string;
  partNo: string;
  judgement: string;
  defectRate: string;
  rawPhenomenon: string;
  canonicalLabels: string[];
  disposition: string;
  actionResult: string;
  images: string[];
  matchLevel: EvidenceMatchLevel;
};

export type DailyAttentionEvidenceSelection = {
  key: string;
  metricLabel: string;
  businessDate: string;
  targetLabel: string;
  machineName: string;
  modelNames: string[];
  partNos: string[];
  partPrefix: string;
  metricEvidenceCount: number;
  cases: DailyAttentionEvidenceCase[];
};

type Props = {
  lang: 'ko' | 'zh';
  selection: DailyAttentionEvidenceSelection | null;
  onClose: () => void;
};

type CaseFilter = 'all' | EvidenceMatchLevel;

type ActiveImage = {
  caseId: number;
  index: number;
};

function normalizeSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizePartIdentity(value: string): string {
  return (value || '').toUpperCase().replace(/\s+/g, '');
}

function effectivePartSpec(partSpecs: PartSpec[], partNos: string[], asOfDate: string): PartSpec | null {
  const targetParts = new Set(partNos.map(normalizePartIdentity).filter(Boolean));
  return partSpecs
    .filter((spec) => targetParts.has(normalizePartIdentity(spec.part_no)))
    .filter((spec) => Boolean(spec.valid_from) && spec.valid_from! <= asOfDate)
    .sort((left, right) => String(right.valid_from).localeCompare(String(left.valid_from)))[0] ?? null;
}

export default function DailyAttentionEvidenceDialog({ lang, selection, onClose }: Props) {
  const [caseFilter, setCaseFilter] = useState<CaseFilter>('all');
  const [photosOnly, setPhotosOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [activeImage, setActiveImage] = useState<ActiveImage | null>(null);
  const partSpecQuery = selection?.partPrefix || selection?.partNos[0] || '';
  const {
    data: partSpecs = [],
    isLoading: isPartSpecLoading,
    isError: isPartSpecError,
  } = usePartSpecSearch(partSpecQuery);

  useEffect(() => {
    setCaseFilter('all');
    setPhotosOnly(false);
    setQuery('');
    setActiveImage(null);
  }, [selection?.key]);

  const copy = lang === 'zh'
    ? {
        eyebrow: '可追溯依据',
        titleSuffix: '相关案例与照片',
        currentTarget: '当前计划对象',
        exact: '料号完全一致',
        related: '前 9 位关联',
        all: '全部',
        photosOnly: '仅看有照片的案例',
        searchPlaceholder: '搜索原文、机种、料号（例：黑点、色差）',
        searchBasis: '按报告原文搜索，不按合并后的分类名称搜索。',
        noCases: '没有符合当前筛选条件的历史案例。',
        historicalModel: '报告机种',
        historicalPart: '报告料号',
        historicalColor: '报告日品目颜色',
        recordedText: '不良现象原文',
        action: '处理结果',
        noAction: '未填写',
        noImage: '无照片',
        imageCount: '张照片',
        close: '关闭依据明细',
        previousImage: '上一张照片',
        nextImage: '下一张照片',
        closeImage: '关闭大图',
        attributionWarning: '品质报告未记录发生机台。此处机台是当前生产计划对象，历史案例仅按料号前 9 位关联。',
        colorWarning: '照片颜色会因照明、曝光与角度而不同。历史报告没有结构化颜色字段，请同时核对报告机种、完整料号与原始照片。',
        metricBasis: '全部计划关联依据',
        visibleCases: '当前显示',
        caseFilters: '案例范围筛选',
        masterColor: '品目主数据颜色',
        masterColorLoading: '正在确认品目主数据颜色',
        masterColorError: '品目主数据颜色查询失败',
        masterColorMissing: '准确料号未登记颜色',
        masterColorBlank: '颜色值未填写',
      }
    : {
        eyebrow: '추적 가능한 근거',
        titleSuffix: '근거 사례·사진',
        currentTarget: '현재 계획 대상',
        exact: '현재 품번 정확 일치',
        related: '앞 9자리 연관',
        all: '전체',
        photosOnly: '사진 있는 사례만',
        searchPlaceholder: '원문·모델·품번 검색 (예: 黑点, 色差)',
        searchBasis: '통합 분류명이 아니라 보고서 원문 기준으로 검색합니다.',
        noCases: '현재 조건에 맞는 과거 사례가 없습니다.',
        historicalModel: '과거 보고 모델',
        historicalPart: '과거 보고 품번',
        historicalColor: '보고일 기준 품목 색상',
        recordedText: '불량 현상 원문',
        action: '처리 결과',
        noAction: '미입력',
        noImage: '사진 없음',
        imageCount: '장 사진',
        close: '근거 상세 닫기',
        previousImage: '이전 사진',
        nextImage: '다음 사진',
        closeImage: '큰 사진 닫기',
        attributionWarning: '과거 품질보고에는 발생 호기가 기록되지 않습니다. 표시된 호기는 오늘 계획 대상이며, 과거 사례는 품번 앞 9자리로 연결한 자료입니다.',
        colorWarning: '사진 색상은 조명·노출·각도에 따라 달라 보일 수 있습니다. 과거 보고에는 구조화된 색상 값이 없으므로 보고 모델·전체 품번·원본 사진을 함께 확인하세요.',
        metricBasis: '전체 계획 연결 근거',
        visibleCases: '현재 표시',
        caseFilters: '사례 범위 필터',
        masterColor: '품목 마스터 색상',
        masterColorLoading: '품목 마스터 색상 확인 중',
        masterColorError: '품목 마스터 색상 조회 실패',
        masterColorMissing: '정확 품번 색상 미등록',
        masterColorBlank: '색상 값 미입력',
      };

  const targetSpec = useMemo(() => {
    if (!selection) return null;
    return effectivePartSpec(partSpecs, selection.partNos, selection.businessDate);
  }, [partSpecs, selection]);

  const exactCount = selection?.cases.filter((item) => item.matchLevel === 'exact_part').length ?? 0;
  const relatedCount = selection?.cases.filter((item) => item.matchLevel === 'related_prefix').length ?? 0;

  const visibleCases = useMemo(() => {
    if (!selection) return [];
    const searchValue = normalizeSearchValue(query);
    return selection.cases.filter((item) => {
      if (caseFilter !== 'all' && item.matchLevel !== caseFilter) return false;
      if (photosOnly && item.images.length === 0) return false;
      if (!searchValue) return true;
      const searchable = [
        item.model,
        item.partNo,
        item.section,
        item.judgement,
        item.rawPhenomenon,
        item.disposition,
        item.actionResult,
      ].join(' ').toLocaleLowerCase();
      return searchable.includes(searchValue);
    });
  }, [caseFilter, photosOnly, query, selection]);

  const activeCase = activeImage
    ? selection?.cases.find((item) => item.id === activeImage.caseId) ?? null
    : null;
  const activeImageUrl = activeCase && activeImage
    ? activeCase.images[activeImage.index] ?? null
    : null;

  const moveImage = (direction: -1 | 1) => {
    if (!activeCase || !activeImage || activeCase.images.length < 2) return;
    const nextIndex = (activeImage.index + direction + activeCase.images.length) % activeCase.images.length;
    setActiveImage({ ...activeImage, index: nextIndex });
  };

  return (
    <>
      <Dialog open={Boolean(selection)} onClose={onClose} className="relative z-[90]">
        <DialogBackdrop className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm" />
        <div className="fixed inset-0 overflow-y-auto p-2 sm:p-4">
          <div className="flex min-h-full items-center justify-center">
            <DialogPanel className="flex max-h-[calc(100dvh-1rem)] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-950/10 sm:max-h-[calc(100dvh-2rem)] sm:rounded-3xl">
              {selection && (
                <>
                  <header className="border-b border-slate-200 bg-gradient-to-r from-slate-950 via-slate-900 to-blue-950 px-4 py-4 text-white sm:px-6 sm:py-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-cyan-300">{copy.eyebrow}</div>
                        <DialogTitle className="mt-1 break-keep text-xl font-bold leading-8 text-white sm:text-2xl">
                          {selection.metricLabel} {copy.titleSuffix}
                        </DialogTitle>
                        <div className="mt-3 flex min-w-0 items-start gap-2 text-sm font-semibold text-slate-100">
                          <Factory className="h-4 w-4 shrink-0 text-cyan-300" />
                          <span className="min-w-0 break-words" title={selection.targetLabel}>{copy.currentTarget}: {selection.targetLabel}</span>
                        </div>
                        <div className="mt-2 inline-flex max-w-full items-center rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-slate-100 ring-1 ring-inset ring-white/15">
                          {isPartSpecLoading
                            ? copy.masterColorLoading
                            : isPartSpecError
                              ? copy.masterColorError
                              : targetSpec
                                ? `${copy.masterColor}: ${targetSpec.color?.trim() || copy.masterColorBlank}${targetSpec.model_code ? ` · ${targetSpec.model_code}` : ''}`
                                : copy.masterColorMissing}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={onClose}
                        className="rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                        aria-label={copy.close}
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>
                  </header>

                  <div className="flex-1 overflow-y-auto">
                    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-5">
                      <section className="grid gap-3 lg:grid-cols-2">
                        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
                          <div className="flex gap-2">
                            <ShieldAlert className="mt-1 h-4 w-4 shrink-0 text-amber-700" />
                            <span>{copy.attributionWarning}</span>
                          </div>
                        </div>
                        <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-950">
                          <div className="flex gap-2">
                            <Camera className="mt-1 h-4 w-4 shrink-0 text-blue-700" />
                            <span>{copy.colorWarning}</span>
                          </div>
                        </div>
                      </section>

                      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {[
                          { label: copy.exact, value: exactCount, className: 'border-emerald-200 bg-emerald-50 text-emerald-900' },
                          { label: copy.related, value: relatedCount, className: 'border-amber-200 bg-amber-50 text-amber-900' },
                          { label: copy.metricBasis, value: selection.metricEvidenceCount, className: 'border-slate-200 bg-slate-50 text-slate-900' },
                          { label: copy.visibleCases, value: visibleCases.length, className: 'border-blue-200 bg-blue-50 text-blue-900' },
                        ].map((item) => (
                          <div key={item.label} className={`rounded-xl border px-3 py-2.5 ${item.className}`}>
                            <div className="text-[11px] font-semibold leading-4 opacity-75">{item.label}</div>
                            <div className="mt-1 text-xl font-bold tabular-nums">{item.value.toLocaleString()}</div>
                          </div>
                        ))}
                      </section>

                      <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex flex-wrap gap-2" role="group" aria-label={copy.caseFilters}>
                          {([
                            ['all', copy.all, selection.cases.length],
                            ['exact_part', copy.exact, exactCount],
                            ['related_prefix', copy.related, relatedCount],
                          ] as Array<[CaseFilter, string, number]>).map(([value, label, count]) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => setCaseFilter(value)}
                              aria-pressed={caseFilter === value}
                              className={`rounded-full px-3 py-1.5 text-xs font-bold ring-1 ring-inset transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                                caseFilter === value
                                  ? 'bg-slate-950 text-white ring-slate-950'
                                  : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-100'
                              }`}
                            >
                              {label} {count}
                            </button>
                          ))}
                          <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">
                            <input
                              type="checkbox"
                              checked={photosOnly}
                              onChange={(event) => setPhotosOnly(event.target.checked)}
                              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            />
                            {copy.photosOnly}
                          </label>
                        </div>
                        <div className="w-full lg:max-w-md">
                          <label className="relative block">
                            <span className="sr-only">{copy.searchPlaceholder}</span>
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <input
                              value={query}
                              onChange={(event) => setQuery(event.target.value)}
                              placeholder={copy.searchPlaceholder}
                              className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                            />
                          </label>
                          <p className="mt-1.5 text-[11px] leading-4 text-slate-500">{copy.searchBasis}</p>
                        </div>
                      </section>

                      {visibleCases.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-12 text-center text-sm text-slate-500">
                          {copy.noCases}
                        </div>
                      ) : (
                        <div className="grid gap-4 xl:grid-cols-2">
                          {visibleCases.map((item) => {
                            const exact = item.matchLevel === 'exact_part';
                            const actionText = item.disposition || item.actionResult;
                            const reportDate = dayjs(item.reportDt).format('YYYY-MM-DD');
                            const historicalSpec = effectivePartSpec(partSpecs, [item.partNo], reportDate);
                            return (
                              <article key={item.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3 text-xs">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className={`rounded-full px-2.5 py-1 font-bold ${exact ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                                      {exact ? copy.exact : copy.related}
                                    </span>
                                    <span className="rounded-full bg-white px-2.5 py-1 font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
                                      {item.section || '-'}
                                    </span>
                                    {item.judgement && (
                                      <span className="rounded-full bg-rose-50 px-2.5 py-1 font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">
                                        {item.judgement}
                                      </span>
                                    )}
                                  </div>
                                  <time className="font-semibold tabular-nums text-slate-600">{reportDate}</time>
                                </div>

                                <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                                  <div className="space-y-3">
                                    <div className="grid gap-2 text-sm sm:grid-cols-2 md:grid-cols-1">
                                      <div className="rounded-xl bg-slate-50 px-3 py-2">
                                        <div className="text-[11px] font-semibold text-slate-500">{copy.historicalModel}</div>
                                        <div className="mt-0.5 break-words font-bold text-slate-900">{item.model || '-'}</div>
                                      </div>
                                      <div className="rounded-xl bg-slate-50 px-3 py-2">
                                        <div className="text-[11px] font-semibold text-slate-500">{copy.historicalPart}</div>
                                        <div className="mt-0.5 break-all font-bold text-slate-900">{item.partNo || '-'}</div>
                                      </div>
                                      <div className="rounded-xl bg-slate-50 px-3 py-2 sm:col-span-2 md:col-span-1">
                                        <div className="text-[11px] font-semibold text-slate-500">{copy.historicalColor}</div>
                                        <div className="mt-0.5 break-words font-bold text-slate-900">
                                          {isPartSpecLoading
                                            ? copy.masterColorLoading
                                            : isPartSpecError
                                              ? copy.masterColorError
                                              : historicalSpec
                                                ? `${historicalSpec.color?.trim() || copy.masterColorBlank}${historicalSpec.model_code ? ` · ${historicalSpec.model_code}` : ''}`
                                                : copy.masterColorMissing}
                                        </div>
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500">{copy.recordedText}</div>
                                      <p className="mt-1 break-words text-sm font-semibold leading-6 text-slate-900">{item.rawPhenomenon || '-'}</p>
                                    </div>
                                    {item.canonicalLabels.length > 0 && (
                                      <div className="flex flex-wrap gap-1.5">
                                        {item.canonicalLabels.map((label) => (
                                          <span key={label} className="rounded-full bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700 ring-1 ring-inset ring-blue-200">
                                            {label}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                    <div className="border-t border-slate-100 pt-3 text-sm leading-6 text-slate-600">
                                      <span className="font-semibold text-slate-700">{copy.action}: </span>
                                      {actionText || copy.noAction}
                                    </div>
                                  </div>

                                  {item.images.length > 0 ? (
                                    <div className={`grid gap-2 ${item.images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                                      {item.images.map((imageUrl, imageIndex) => (
                                        <button
                                          key={`${item.id}-${imageIndex}`}
                                          type="button"
                                          onClick={() => setActiveImage({ caseId: item.id, index: imageIndex })}
                                          className="group relative aspect-[4/3] min-h-36 overflow-hidden rounded-xl bg-slate-100 outline-none ring-blue-500 focus-visible:ring-2"
                                          aria-label={`${item.model || item.partNo} ${imageIndex + 1}/${item.images.length}`}
                                        >
                                          <img
                                            src={imageUrl}
                                            alt={`${item.model || item.partNo} · ${item.rawPhenomenon || selection.metricLabel} · ${imageIndex + 1}`}
                                            loading="lazy"
                                            className="h-full min-h-36 w-full object-contain transition duration-200 group-hover:scale-[1.02]"
                                          />
                                          <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-slate-950/80 px-2 py-1 text-[11px] font-semibold text-white">
                                            <ZoomIn className="h-3.5 w-3.5" />
                                            {imageIndex + 1}/{item.images.length}
                                          </span>
                                        </button>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-400">
                                      <ImageOff className="mb-2 h-6 w-6" />
                                      {copy.noImage}
                                    </div>
                                  )}
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </DialogPanel>
          </div>
        </div>
      </Dialog>

      <Dialog open={Boolean(activeImageUrl)} onClose={() => setActiveImage(null)} className="relative z-[110]">
        <DialogBackdrop className="fixed inset-0 bg-slate-950/90 backdrop-blur-sm" />
        <div className="fixed inset-0 flex items-center justify-center p-2 sm:p-6">
          <DialogPanel className="relative flex h-full max-h-[calc(100dvh-1rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-slate-950 text-white shadow-2xl sm:max-h-[calc(100dvh-3rem)]">
            {activeCase && activeImage && activeImageUrl && (
              <>
                <div className="flex items-start justify-between gap-4 border-b border-white/10 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <DialogTitle className="truncate text-sm font-bold text-white sm:text-base">
                      {activeCase.model || activeCase.partNo} · {activeImage.index + 1}/{activeCase.images.length}
                    </DialogTitle>
                    <p className="mt-1 truncate text-xs text-slate-300">{activeCase.partNo} · {activeCase.rawPhenomenon}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveImage(null)}
                    className="rounded-full bg-white/10 p-2 text-white hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                    aria-label={copy.closeImage}
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-2 sm:p-4">
                  <img
                    src={activeImageUrl}
                    alt={`${activeCase.model || activeCase.partNo} · ${activeCase.rawPhenomenon} · ${activeImage.index + 1}`}
                    className="max-h-full max-w-full object-contain"
                  />
                  {activeCase.images.length > 1 && (
                    <>
                      <button
                        type="button"
                        onClick={() => moveImage(-1)}
                        className="absolute left-2 rounded-full bg-slate-950/75 p-2.5 text-white shadow-lg hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 sm:left-4"
                        aria-label={copy.previousImage}
                      >
                        <ChevronLeft className="h-6 w-6" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveImage(1)}
                        className="absolute right-2 rounded-full bg-slate-950/75 p-2.5 text-white shadow-lg hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 sm:right-4"
                        aria-label={copy.nextImage}
                      >
                        <ChevronRight className="h-6 w-6" />
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </DialogPanel>
        </div>
      </Dialog>
    </>
  );
}
