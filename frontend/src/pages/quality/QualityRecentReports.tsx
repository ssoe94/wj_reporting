import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Clock3, RefreshCw } from 'lucide-react';
import { useLang } from '../../i18n';
import api from '../../lib/api';

const RECENT_REPORT_LIMIT = 6;

interface RecentQualityReport {
  id: number;
  report_dt: string;
  section: string;
  model: string;
  part_no: string;
  judgement: string;
  phenomenon?: string;
}

interface RecentQualityReportResponse {
  count: number;
  results: RecentQualityReport[];
}

interface QualityRecentReportsProps {
  onViewAll: () => void;
}

function sectionLabel(section: string, lang: 'ko' | 'zh'): string {
  const labels: Record<string, { ko: string; zh: string }> = {
    LQC_INJ: { ko: 'LQC · 사출', zh: 'LQC · 注塑' },
    LQC_ASM: { ko: 'LQC · 조립', zh: 'LQC · 组装' },
    IQC: { ko: 'IQC', zh: 'IQC' },
    OQC: { ko: 'OQC', zh: 'OQC' },
    CS: { ko: 'CS', zh: 'CS' },
  };
  return labels[section]?.[lang] || section || '-';
}

function judgementClass(judgement: string): string {
  return judgement.toUpperCase() === 'NG'
    ? 'bg-rose-50 text-rose-700 ring-rose-200'
    : 'bg-emerald-50 text-emerald-700 ring-emerald-200';
}

export default function QualityRecentReports({ onViewAll }: QualityRecentReportsProps) {
  const { lang } = useLang();
  const locale = lang === 'zh' ? 'zh' : 'ko';
  const { data, isLoading, isError, isFetching, refetch } = useQuery<RecentQualityReportResponse>({
    queryKey: ['quality-reports', 'recent', RECENT_REPORT_LIMIT],
    queryFn: async () => {
      const { data } = await api.get('/quality/reports/', {
        params: {
          page: 1,
          page_size: RECENT_REPORT_LIMIT,
          ordering: '-report_dt,-id',
        },
      });
      return data;
    },
  });

  const reports = data?.results || [];
  const totalCount = data?.count || 0;

  return (
    <section className="overflow-hidden rounded-2xl border border-indigo-100 bg-white shadow-sm" aria-labelledby="recent-quality-title">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-gradient-to-r from-indigo-50/90 to-white px-4 py-3.5 md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded-lg bg-indigo-600 p-2 text-white shadow-sm">
            <Clock3 className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="recent-quality-title" className="text-base font-bold text-slate-950">
                {locale === 'zh' ? '最近报告履历' : '최근 보고 이력'}
              </h2>
              {!isLoading && !isError && (
                <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                  {locale === 'zh' ? `共 ${totalCount.toLocaleString()} 条` : `전체 ${totalCount.toLocaleString()}건`}
                </span>
              )}
              {isFetching && !isLoading && (
                <span className="text-xs font-medium text-indigo-600">
                  {locale === 'zh' ? '正在更新' : '업데이트 중'}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              {locale === 'zh' ? `按报告日期显示最近 ${RECENT_REPORT_LIMIT} 条` : `보고일 기준 최근 ${RECENT_REPORT_LIMIT}건을 보여줍니다.`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm font-semibold text-indigo-700 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50"
        >
          {locale === 'zh' ? '查看更多履历' : '전체 이력 더보기'}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      {isLoading ? (
        <div className="space-y-2 p-4" aria-label={locale === 'zh' ? '正在加载最近报告' : '최근 보고 불러오는 중'}>
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-14 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
          <p className="text-sm text-rose-700">
            {locale === 'zh' ? '无法加载最近报告。' : '최근 보고를 불러오지 못했습니다.'}
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {locale === 'zh' ? '重新加载' : '다시 불러오기'}
          </button>
        </div>
      ) : reports.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-slate-500">
          {locale === 'zh' ? '暂无已登记的品质报告。' : '등록된 품질 보고가 없습니다.'}
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full table-fixed text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
                <tr>
                  <th className="w-[124px] px-4 py-2.5 text-left">{locale === 'zh' ? '日期' : '보고일'}</th>
                  <th className="w-[118px] px-3 py-2.5 text-left">{locale === 'zh' ? '部门' : '보고 부서'}</th>
                  <th className="w-[240px] px-3 py-2.5 text-left">{locale === 'zh' ? '型号 / Part No.' : '모델 / Part No.'}</th>
                  <th className="px-3 py-2.5 text-left">{locale === 'zh' ? '不良现象' : '불량 현상'}</th>
                  <th className="w-[82px] px-4 py-2.5 text-center">{locale === 'zh' ? '判定' : '판정'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reports.map((report) => (
                  <tr key={report.id} className="transition hover:bg-indigo-50/40">
                    <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums text-slate-700">{report.report_dt.slice(0, 10)}</td>
                    <td className="px-3 py-3 text-slate-600">{sectionLabel(report.section, locale)}</td>
                    <td className="px-3 py-3">
                      <strong className="block truncate font-semibold text-slate-900" title={report.model || '-'}>{report.model || '-'}</strong>
                      <span className="mt-0.5 block truncate text-xs text-slate-500" title={report.part_no || '-'}>{report.part_no || '-'}</span>
                    </td>
                    <td className="px-3 py-3">
                      <p className="truncate text-slate-700" title={report.phenomenon || '-'}>{report.phenomenon || '-'}</p>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex rounded-full px-2 py-1 text-xs font-bold ring-1 ${judgementClass(report.judgement)}`}>
                        {report.judgement || '-'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="divide-y divide-slate-100 md:hidden">
            {reports.map((report) => (
              <article key={report.id} className="space-y-2 px-4 py-3.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-slate-500">
                    <span className="tabular-nums">{report.report_dt.slice(0, 10)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{sectionLabel(report.section, locale)}</span>
                  </div>
                  <span className={`inline-flex shrink-0 rounded-full px-2 py-1 text-xs font-bold ring-1 ${judgementClass(report.judgement)}`}>
                    {report.judgement || '-'}
                  </span>
                </div>
                <div className="flex min-w-0 items-baseline gap-2">
                  <strong className="truncate text-sm text-slate-900">{report.model || '-'}</strong>
                  <span className="truncate text-xs text-slate-500">{report.part_no || '-'}</span>
                </div>
                <p className="line-clamp-2 text-sm leading-5 text-slate-600">{report.phenomenon || '-'}</p>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
