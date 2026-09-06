import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, Database, RefreshCcw } from 'lucide-react';

import { useLang } from '../../i18n';
import { Button } from '../../components/ui/button';
import { getProductionMesReportStats } from '../../lib/api';
import { useShanghaiBusinessDate } from '@/shared/hooks/useShanghaiBusinessDate';
import { resolveInjectionScope, buildInjectionLink } from '@/domains/injection/workspace';
import {
  getMesReportEvidence, getMesReportRowEvidence, parseMesReportStats,
  type MesReportPresence, type MesStatsPlanType,
} from '@/domains/production/mes-report-evidence';

const ctrlCls = 'h-11 bg-white border border-gray-300 rounded-xl px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
const numberFormatter = new Intl.NumberFormat('ko-KR');
function formatNumber(value?: number | null) {
  return typeof value === 'number' && Number.isFinite(value) ? numberFormatter.format(value) : '—';
}
function formatDateTime(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export default function ProductionStatsPage() {
  const { t, lang } = useLang();
  const text = (ko: string, zh: string) => lang === 'ko' ? ko : zh;
  const currentDate = useShanghaiBusinessDate();
  const [params, setParams] = useSearchParams();
  const selectedDate = resolveInjectionScope(params.toString(), currentDate).date;
  const planType: MesStatsPlanType = params.get('plan_type') === 'machining' ? 'machining' : 'injection';
  const [search, setSearch] = useState('');
  const setScope = (date: string, type: MesStatsPlanType) => {
    const validatedDate = resolveInjectionScope(`date=${date}`, currentDate).date;
    setParams({ date: validatedDate, plan_type: type });
  };
  const query = useQuery({
    queryKey: ['productionMesStats', selectedDate, planType],
    queryFn: async () => parseMesReportStats(await getProductionMesReportStats(selectedDate, planType, 'day'), selectedDate, planType),
    refetchOnWindowFocus: false,
    refetchInterval: selectedDate === currentDate ? 5 * 60 * 1000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const evidence = getMesReportEvidence(query.data, query);
  const rows = useMemo(() => {
    const keyword = search.trim().toUpperCase();
    if (!keyword) return evidence.rows;
    return evidence.rows.filter((row) => [row.part_no, row.model_name, row.equipment_label, row.equipment_name, row.process_code]
      .join(' ').toUpperCase().includes(keyword));
  }, [evidence.rows, search]);
  const presenceLabel = (presence: MesReportPresence) => {
    if (presence === 'both') return text('양쪽 자료 있음', '双方均有记录');
    if (presence === 'plan_only') return text('계획 있음 · 보고 미관측', '有计划 · 未观测到报工');
    if (presence === 'report_only') return text('보고 있음 · 계획 미관측', '有报工 · 未观测到计划');
    return text('자료 미관측', '未观测到记录');
  };
  const basis = planType === 'injection'
    ? text('사출: 같은 업무일·설비·품번으로 합산합니다.', '注塑：按同一业务日、设备、品号合计。')
    : text('가공: 같은 업무일·품번으로 여러 라인의 보고를 합산합니다. 표시 설비는 대표값이며 라인별 실적이 아닙니다.', '加工：按同一业务日、品号合计多条线的报工。所示设备为代表值，不是分线实绩。');

  return (
    <div className="px-4 py-6 md:px-8 md:py-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-500">{t('prod_stats_tag')}</p>
              <h1 className="text-3xl font-bold text-slate-900">{t('prod_stats_title')}</h1>
              <p className="max-w-3xl text-sm text-slate-600">{text('저장된 MES 생산보고 원장과 생산계획을 원천별로 확인합니다.', '分别核对已存 MES 生产报工台账与生产计划。')} {basis}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <input type="date" aria-label={text('조회 업무일', '查询业务日')} max={currentDate} value={selectedDate}
                onChange={(event) => setScope(event.target.value, planType)} className={ctrlCls} />
              <div className="inline-flex rounded-2xl border border-gray-200 bg-gray-50 p-1">
                {(['injection', 'machining'] as const).map((type) => (
                  <button key={type} type="button" onClick={() => setScope(selectedDate, type)}
                    className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${planType === type ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600'}`}>
                    {t(type === 'injection' ? 'plan_toggle_injection' : 'plan_toggle_machining')}
                  </button>
                ))}
              </div>
              <Button type="button" variant="secondary" onClick={() => query.refetch()} className="gap-2 rounded-xl">
                <RefreshCcw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />{t('prod_stats_refresh')}
              </Button>
            </div>
          </div>
          <p className="mt-4 text-sm text-slate-500">
            {selectedDate} 08:00 ~ {text('다음 날', '次日')} 08:00 · Asia/Shanghai (UTC+8) · {text('전체 설비', '全部设备')}
          </p>
          <p className="mt-2 text-sm text-slate-600">{text('신고 시각 기준의 정수 저장 수량입니다. 원천 단위·품질 구분·취소/정정·실제 생산일이 검증되기 전에는 확정 양품이나 재고 입고로 해석하지 않습니다. 형합 추정 및 수기 보정에 더하지 않습니다.', '这是按报工时间保存的整数数量。源单位、质量分类、撤销/更正及实际生产日期验证前，不视为已确认合格品或入库量，不与合模估算和手工修正相加。')}</p>
          <p className="mt-2 text-sm text-slate-600">{text('최근 저장시각은 수집 작업의 완전한 성공시각이 아닙니다. 보고 미관측만으로 생산 0 또는 수집 실패를 확정할 수 없습니다.', '最近保存时间不是采集任务完整成功时间。未观测到报工不能确定产量为0或采集失败。')}</p>
          {planType === 'injection' && <Link className="mt-3 inline-block text-sm font-semibold text-blue-700 underline" to={buildInjectionLink('/injection/dashboard', { date: selectedDate, machineNumber: null }, 'overview')}>
            {text('사출 공통 실적·현장 기록 보기', '查看注塑统一实绩与现场记录')}
          </Link>}
        </section>

        {evidence.state !== 'ready' && <div role="status" className={`flex items-start gap-3 rounded-2xl p-5 ${evidence.state === 'error' ? 'bg-amber-50 text-amber-900' : 'bg-slate-100 text-slate-700'}`}>
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>{evidence.state === 'loading' ? text('원장 자료를 불러오는 중입니다.', '正在读取台账。')
            : evidence.state === 'error' ? text('조회·갱신 또는 응답 검증에 실패했습니다. 이전 캐시를 포함해 수량·대사 판단을 보류합니다. 다시 조회하세요.', '查询、刷新或响应验证失败，包括旧缓存的数量与对账判断均暂停，请重新查询。')
            : text('저장 업무일 기준의 계획·보고 그룹이 없습니다. 신고시각 범위의 행 수는 별도로 확인하며, 생산 0이나 정상 완료를 뜻하지 않습니다.', '按保存业务日无计划或报工分组。报工时间范围条数另行核对，不代表产量为0或正常完成。')}</p>
        </div>}
        {evidence.rangeMismatch && <p role="status" className="rounded-2xl bg-amber-50 p-5 text-sm text-amber-900">{text('신고시각 범위와 저장 업무일의 건수가 다르거나 범위 밖 신고시각이 있습니다. 원장 관측값은 유지하고 차이는 보류합니다. 날짜 귀속 대사가 필요합니다.', '报工时间范围与保存业务日条数不同，或存在范围外报工时间。保留台账观测值并暂停差额，需核对日期归属。')}</p>}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[
            { label: text('계획 원장 수량', '计划台账数量'), value: formatNumber(evidence.planQuantity) },
            { label: text('MES 저장 신고 수량', 'MES 已存报工数量'), value: formatNumber(evidence.reportQuantity) },
            { label: text('저장 업무일의 신고 행 수', '保存业务日报工条数'), value: formatNumber(evidence.reportCount) },
            { label: text('최종 신고 시각 (UTC+8)', '最后报工时间 (UTC+8)'), value: formatDateTime(evidence.latestReportTime) },
          ].map((card) => <div key={card.label} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
            <p className="text-sm text-slate-500">{card.label}</p><p className="mt-2 break-words text-2xl font-bold text-slate-900">{card.value}</p>
          </div>)}
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
            <div className="flex items-center gap-3"><Database className="h-5 w-5 text-blue-600" /><h2 className="text-lg font-semibold text-slate-900">{text('원천별 자료 존재', '各来源记录情况')}</h2></div>
            <p className="mt-2 text-sm text-slate-600">{text('양쪽 자료 있음은 수량 일치나 대사 완료가 아닙니다. 보고 수량이 0이어도 신고 행이 있으면 자료가 있는 것으로 구분합니다.', '双方有记录不代表数量一致或对账完成。报工数量为0但存在报工行时，仍视为有记录。')}</p>
            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                { label: presenceLabel('both'), value: evidence.bothCount },
                { label: presenceLabel('plan_only'), value: evidence.planOnlyCount },
                { label: presenceLabel('report_only'), value: evidence.reportOnlyCount },
                { label: text('신고시각 범위 행 수', '报工时间范围条数'), value: evidence.rawReportCount },
              ].map((card) => <div key={card.label} className="rounded-xl bg-slate-50 p-4"><p className="text-xs text-slate-500">{card.label}</p><p className="mt-2 text-2xl font-bold text-slate-900">{formatNumber(card.value)}</p></div>)}
            </div>
            <p className="mt-3 text-xs text-slate-500">{text('대상 원장 최근 저장', '范围内台账最近保存')}: {formatDateTime(evidence.latestStoredTime)} · UTC+8</p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
            <h2 className="text-lg font-semibold text-slate-900">{t('prod_stats_filter_title')}</h2>
            <p className="mt-1 text-sm text-slate-500">{text('검색은 아래 표에만 적용됩니다. 상단은 선택일·공정 전체입니다.', '搜索仅作用于下表，上方为所选日、工序全部数据。')}</p>
            <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label={t('prod_stats_filter_title')}
              placeholder={t('prod_stats_search_placeholder')} className={`${ctrlCls} mt-4 w-full`} />
          </div>
        </section>

        <section className="rounded-3xl bg-white shadow-sm ring-1 ring-gray-100">
          <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
            <div><h2 className="text-lg font-semibold text-slate-900">{t('prod_stats_table_title')}</h2><p className="text-sm text-slate-500">{basis}</p>
              <p className="text-xs text-slate-500">{text('차이는 양쪽 기록이 있는 행의 저장 신고량−계획량입니다. 단위·완전성 검증 전 참고 차이이며 완료율이나 손실이 아닙니다.', '差额为双方有记录行的已存报工量减计划量。单位与完整性验证前仅供参考，不代表完成率或损失。')}</p></div>
            <span className="text-sm text-slate-500">{evidence.state === 'ready' ? t('prod_stats_rows_count', { count: rows.length.toLocaleString() }) : '—'}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full table-fixed">
              <thead className="bg-slate-50 text-sm text-slate-700"><tr>
                <th className="px-4 py-3 text-left font-semibold">{planType === 'machining' ? text('대표 설비/라인', '代表设备/线体') : t('prod_stats_col_equipment')}</th>
                <th className="px-4 py-3 text-left font-semibold">{t('prod_stats_col_part_no')}</th>
                <th className="px-4 py-3 text-left font-semibold">{t('prod_stats_col_model')}</th>
                <th className="px-4 py-3 text-right font-semibold">{t('prod_stats_col_plan_qty')}</th>
                <th className="px-4 py-3 text-right font-semibold">{t('prod_stats_col_mes_qty')}</th>
                <th className="px-4 py-3 text-right font-semibold">{text('관측 차이 (참고)', '观测差额（参考）')}</th>
                <th className="px-4 py-3 text-center font-semibold">{text('계획 행', '计划行')}</th>
                <th className="px-4 py-3 text-center font-semibold">{t('prod_stats_col_mes_count')}</th>
                <th className="px-4 py-3 text-left font-semibold">{text('최종 신고 (UTC+8)', '最后报工 (UTC+8)')}</th>
                <th className="px-4 py-3 text-center font-semibold">{text('자료 존재', '记录情况')}</th>
              </tr></thead>
              <tbody>{rows.length === 0 ? <tr><td colSpan={10} className="px-6 py-16 text-center text-sm text-slate-500">
                {evidence.state === 'ready' ? text('검색 조건에 맞는 행이 없습니다.', '无符合搜索条件的行。') : text('조회 상태를 확인한 뒤 원장 자료를 표시합니다.', '确认查询状态后显示台账。')}
              </td></tr> : rows.map((row) => {
                const rowEvidence = getMesReportRowEvidence(row);
                return <tr key={`${row.equipment_key}-${row.part_no}`} className="border-t border-gray-100 text-sm">
                  <td className="px-4 py-3 font-semibold text-slate-900">{row.equipment_label}</td>
                  <td className="px-4 py-3 font-mono text-slate-800">{row.part_no}</td>
                  <td className="px-4 py-3 text-slate-700">{row.model_name || '—'}</td>
                  <td className="px-4 py-3 text-right text-slate-800">{formatNumber(rowEvidence.planQuantity)}</td>
                  <td className="px-4 py-3 text-right text-slate-800">{formatNumber(rowEvidence.reportQuantity)}</td>
                  <td className="px-4 py-3 text-right text-slate-700">{formatNumber(evidence.rangeMismatch ? null : rowEvidence.observedGap)}</td>
                  <td className="px-4 py-3 text-center text-slate-700">{formatNumber(row.plan_row_count)}</td>
                  <td className="px-4 py-3 text-center text-slate-700">{formatNumber(row.mes_report_count)}</td>
                  <td className="px-4 py-3 text-slate-700">{formatDateTime(row.latest_report_time)}</td>
                  <td className="px-4 py-3 text-center"><span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${rowEvidence.presence === 'both' ? 'bg-slate-100 text-slate-700' : 'bg-amber-50 text-amber-800'}`}>{presenceLabel(rowEvidence.presence)}</span></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
