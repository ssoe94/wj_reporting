import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Download, Eye, FileText, RefreshCw, X } from 'lucide-react';
import { Bar, Brush, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import PermissionLink from '@/components/common/PermissionLink';
import { useLang } from '@/i18n';
import { getShanghaiDateString } from '@/shared/utils/date';
import { getQualityAnalysis, getQualitySourceReport } from './api';
import { defaultQualityScope, QUALITY_SECTIONS, qualityLabel, qualityScopeParams, resolveQualityScope, SECTION_LABELS, validateQualityScope } from './model';
import type { QualityAnalysis, QualityConcentration, QualityLanguage, QualityScope, QualityTypeEvidence } from './model';
import { buildQualityHighlights, createQualityReportCsv, getReportTrendSeries, percentChange } from './report';
import { QualityProductionConcentrations, QualityProductionIntensity } from './QualityProductionInsights';
import './quality-analysis.css';

type Copy = { lang: QualityLanguage; tx: (ko: string, zh: string) => string };
type OpenSources = (row: QualityTypeEvidence) => void;
function quantity(value: number | null | undefined, lang: QualityLanguage, digits = 0, fixed = false) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(lang === 'zh' ? 'zh-CN' : 'ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: fixed ? digits : 0 }) : '—';
}
function moment(value: string | null | undefined, lang: QualityLanguage) {
  return value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'ko-KR', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
}
function Delta({ value, lang, unit = '%' }: { value: number | null; lang: QualityLanguage; unit?: string }) {
  if (value === null) return null;
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={value > 0 ? 'qa-delta qa-delta--up' : value < 0 ? 'qa-delta qa-delta--down' : 'qa-delta'}>{value !== 0 && <Icon size={13} />}{value > 0 ? '+' : ''}{quantity(value, lang, 1)}{unit}</span>;
}
function ReportSources({ ids, title, onClose, lang, tx }: Copy & { ids: number[]; title: string; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const id = ids[index];
  const query = useQuery({ queryKey: ['quality-analysis-source', id], queryFn: () => getQualitySourceReport(id), enabled: Boolean(id), staleTime: 30_000 });
  const report = query.isSuccess ? query.data : undefined;
  return <Dialog open onClose={onClose} className="qa-dialog"><DialogBackdrop className="qa-dialog-backdrop" /><div className="qa-dialog-position"><DialogPanel className="qa-dialog-panel">
    <div className="qa-section-heading"><div><DialogTitle>{tx('원본 품질 보고서', '原始品质报告')} #{id}</DialogTitle><p>{title} · {tx('최근 5건까지', '最近最多5条')}</p></div><button type="button" className="qa-icon-button" onClick={onClose} aria-label={tx('닫기', '关闭')}><X size={20} /></button></div>
    {ids.length > 1 && <div className="qa-segments">{ids.map((reportId, i) => <button type="button" key={reportId} aria-pressed={index === i} onClick={() => setIndex(i)}>#{reportId}</button>)}</div>}
    {query.isPending ? <p role="status" className="qa-empty">{tx('원본을 불러오는 중…', '正在加载原始报告…')}</p> : query.isError ? <div role="alert" className="qa-notice qa-notice--warning">{tx('원본을 불러오지 못했습니다. 삭제 또는 접근 권한을 확인하세요.', '未能加载原始报告，请确认是否已删除或是否有访问权限。')}<button type="button" className="qa-link" disabled={query.isFetching} onClick={() => void query.refetch()}>{tx('재시도', '重试')}</button></div> : report ? <>
      <dl className="qa-source-facts">{[
        [tx('보고일시 · UTC+8', '报告时间 · UTC+8'), new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'ko-KR', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.report_dt))],
        [tx('검사 부문', '检验部门'), SECTION_LABELS[report.section]?.[lang] ?? report.section], [tx('모델 / 품번', '型号 / 品号'), `${report.model || '—'} / ${report.part_no || '—'}`],
        [tx('기록된 발생 위치', '记录的发生位置'), report.source_import?.occurrence_location || tx('미기재', '未填写')],
        [tx('기록된 검사 수량', '记录的检验数量'), quantity(report.inspection_qty, lang)], [tx('기록된 불량 수량', '记录的不良数量'), quantity(report.defect_qty, lang)],
        [tx('원본 판정', '原始判定'), report.judgement || '—'], [tx('원본 입력 불량률', '原始填写的不良率'), report.defect_rate || '—'],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {[ [tx('불량 현상 원문', '不良现象原文'), report.phenomenon], [tx('처리 방식', '处理方式'), report.disposition], [tx('처리 결과', '处理结果'), report.action_result] ].map(([label, value]) => <section className="qa-source-text" key={label}><h3>{label}</h3><p>{value?.trim() || tx('미기재', '未填写')}</p></section>)}
    </> : null}
  </DialogPanel></div></Dialog>;
}
function SectionShare({ data, lang, tx, onSources }: Copy & { data: QualityConcentration; onSources: OpenSources }) {
  return <section className="qa-panel"><div className="qa-section-heading"><div><h2>{tx('검사 부문별 신고', '各检验部门报告')}</h2><p>{tx('어느 검사 단계에서 발견되었는지', '在哪个检验环节发现')}</p></div></div>
    <div className="qa-table-wrap"><table className="qa-table"><thead><tr><th>{tx('검사 부문', '检验部门')}</th><th>{tx('신고', '报告')}</th><th>{tx('기록 불량수', '记录不良数')}</th><th>{tx('원본', '原始报告')}</th></tr></thead>
      <tbody>{data.items.map(row => <tr key={row.key}><th scope="row">{SECTION_LABELS[row.key]?.[lang] ?? qualityLabel(row.label, lang)}</th><td><strong>{quantity(row.report_count, lang)}{tx('건', '条')}</strong><small>{quantity(row.share_of_reports_percent, lang, 1)}%</small><span className="qa-inline-bar"><i style={{ width: `${row.share_of_reports_percent}%` }} /></span></td><td>{quantity(row.reported_defect_qty, lang)}</td><td><button type="button" className="qa-link" disabled={!row.sample_report_ids.length} onClick={() => onSources(row)}><Eye size={14} />{tx('보기', '查看')}</button></td></tr>)}</tbody></table></div>
  </section>;
}
function Trend({ data, lang, tx }: Copy & { data: QualityAnalysis }) {
  const [metric, setMetric] = useState<'reports' | 'quantity'>('reports');
  const series = getReportTrendSeries(data, metric);
  const pending = data.report?.operations.days.filter(day => day.pending).length ?? 0;
  const hidden = data.trend.length - series.length - pending;
  const unit = metric === 'reports' ? tx('건', '条') : tx('개', '个');
  const dailyName = metric === 'reports' ? tx('일별 신고', '每日报告') : tx('일별 기록 불량수', '每日记录不良数');
  const averageName = tx('최근 7조업일 평균', '最近7个生产日均值');
  const weekly = data.report?.weekly ?? [];
  const showShots = weekly.some(week => week.injection_reports_per_10k_shots !== null);
  return <section className="qa-panel">
    <div className="qa-section-heading">
      <div><h2>{tx('기간 추세', '期间趋势')}</h2><p>{tx(`${series.length}일 표시`, `显示 ${series.length} 天`)}{hidden > 0 ? tx(` · 작업이 없던 ${hidden}일 제외`, ` · 已排除无作业的 ${hidden} 天`) : ''}{pending > 0 && data.report?.operations.reported_through ? tx(` · 신고 입력은 ${data.report.operations.reported_through.slice(5)}까지`, ` · 报告已录入至 ${data.report.operations.reported_through.slice(5)}`) : ''} · {tx('단위', '单位')} {unit}</p></div>
      <div className="qa-segments" aria-label={tx('추세 지표', '趋势指标')}>
        <button type="button" aria-pressed={metric === 'reports'} onClick={() => setMetric('reports')}>{tx('건수', '条数')}</button>
        <button type="button" aria-pressed={metric === 'quantity'} onClick={() => setMetric('quantity')}>{tx('수량', '数量')}</button>
      </div>
    </div>
    {series.length > 0 ? <div className="qa-chart" role="img" aria-label={tx(`조업일별 ${dailyName}와 ${averageName}`, `各生产日${dailyName}与${averageName}`)}>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart key={data.filters.start_date + data.filters.end_date + metric} data={series} margin={{ top: 12, right: 20, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7edf4" />
          <XAxis dataKey="date" minTickGap={28} interval="preserveStartEnd" tickFormatter={(value: string) => value.slice(5)} tickLine={false} axisLine={false} />
          <YAxis width={56} domain={[0, 'auto']} allowDecimals={false} tickLine={false} axisLine={false} />
          <Tooltip labelFormatter={label => String(label)} formatter={(value: number, name: string) => [quantity(value, lang, name === averageName ? 1 : 0) + ' ' + unit, name]} />
          <Legend iconSize={12} wrapperStyle={{ fontSize: 12, paddingTop: 10 }} />
          <Bar dataKey="value" name={dailyName} fill="#8fb0e6" maxBarSize={28} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Line type="monotone" dataKey="average" name={averageName} stroke="#b76a20" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
          {series.length > 45 && <Brush dataKey="date" height={24} travellerWidth={10} stroke="#a7bad2" fill="#f7f9fc" tickFormatter={(value: string) => value.slice(5)} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div> : <p className="qa-empty">{tx('이 기간에는 조업일과 신고가 없습니다.', '此期间没有生产日及报告。')}</p>}
    {weekly.length > 0 && <div className="qa-table-wrap qa-week-table"><table className="qa-table">
      <thead><tr><th>{tx('주간', '周')}</th><th>{tx('조업일', '生产日')}</th><th>{tx('신고', '报告')}</th><th>{tx('조업일당 신고', '每生产日报告')}</th>{showShots && <th>{tx('사출 1만 쇼트당', '注塑每万模次')}</th>}<th>{tx('최다 유형', '最多类型')}</th></tr></thead>
      <tbody>{weekly.map(week => <tr key={week.week_start}><th scope="row">{week.week_start.slice(5)} ~ {week.week_end.slice(5)}</th><td>{quantity(week.operating_day_count, lang)}</td><td>{quantity(week.report_count, lang)}</td><td><strong>{quantity(week.reports_per_operating_day, lang, 1, true)}</strong></td>{showShots && <td>{quantity(week.injection_reports_per_10k_shots, lang, 2, true)}</td>}<td>{week.top_type ? `${qualityLabel(week.top_type.label, lang)} · ${week.top_type.report_count}${tx('건', '条')}` : '—'}</td></tr>)}</tbody>
    </table></div>}
  </section>;
}
function Types({ data, lang, tx, onSources }: Copy & { data: QualityAnalysis; onSources: OpenSources }) {
  const rows = data.type_pareto.slice(0, 10).map(row => ({ ...row, name: qualityLabel(row.label, lang) }));
  const unclassified = data.type_pareto_exclusions.reduce((sum, row) => sum + row.report_count, 0);
  const comparison = data.report?.comparison;
  const previous = new Map(comparison?.types.map(row => [row.key, row]) ?? []);
  const shareName = tx('누적 비중', '累计占比');
  return <div className="qa-two-columns qa-types">
    <section className="qa-panel">
      <div className="qa-section-heading"><div><h2>{tx('불량 유형 Pareto', '不良类型 Pareto')}</h2><p>{tx('유형별 신고 건수와 누적 비중', '各类型报告条数及累计占比')} · {tx('상위', '前')} {rows.length}{tx('개', '类')}</p></div></div>
      {rows.length ? <div className="qa-chart" role="img" aria-label={tx('불량 유형별 신고 건수와 누적 비중', '各不良类型报告条数及累计占比')}>
        <ResponsiveContainer width="100%" height={300}><ComposedChart data={rows} margin={{ top: 12, right: 4, left: 0, bottom: 16 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7edf4" />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-18} textAnchor="end" height={55} tickLine={false} axisLine={false} />
          <YAxis yAxisId="count" allowDecimals={false} width={44} tickLine={false} axisLine={false} />
          <YAxis yAxisId="share" orientation="right" domain={[0, 100]} width={40} tickFormatter={value => value + '%'} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip formatter={(value: number, name: string) => quantity(value, lang, name === shareName ? 1 : 0) + (name === shareName ? '%' : tx('건', '条'))} />
          <Bar yAxisId="count" dataKey="report_count" name={tx('신고 건수', '报告条数')} fill="#6382b8" maxBarSize={48} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Line yAxisId="share" dataKey="cumulative_type_share_percent" name={shareName} stroke="#cc7a2b" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
          <Legend iconSize={12} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        </ComposedChart></ResponsiveContainer>
      </div> : <p className="qa-empty">{tx('분류된 불량 유형이 없습니다.', '没有已分类的不良类型。')}</p>}
      {unclassified > 0 && <p className="qa-caption">{tx(`현상 설명만으로 유형을 나눌 수 없는 ${unclassified}건은 그래프에서 제외했습니다.`, `仅凭现象描述无法归类的 ${unclassified} 条未纳入图表。`)} {data.type_pareto_exclusions.map(row => <button key={row.key} type="button" className="qa-link" onClick={() => onSources(row)} disabled={!row.sample_report_ids.length}>{tx('원문 보기', '查看原文')}</button>)}</p>}
    </section>
    <section className="qa-panel">
      <div className="qa-section-heading"><div><h2>{comparison ? tx('유형별 증감', '各类型增减') : tx('유형별 신고', '各类型报告')}</h2><p>{comparison ? tx(`직전 기간 ${comparison.previous_start.slice(5)}~${comparison.previous_end.slice(5)} 대비`, `对比上一期间 ${comparison.previous_start.slice(5)}~${comparison.previous_end.slice(5)}`) : tx('유형별 신고 건수와 비중', '各类型报告条数及占比')}</p></div></div>
      {data.type_pareto.length ? <div className="qa-table-wrap qa-scroll"><table className="qa-table">
        <thead><tr><th>{tx('유형', '类型')}</th><th>{tx('이번 기간', '本期间')}</th>{comparison && <th>{tx('직전 기간', '上一期间')}</th>}{comparison && <th>{tx('증감', '增减')}</th>}<th>{tx('비중', '占比')}</th><th>{tx('원본', '原始报告')}</th></tr></thead>
        <tbody>{data.type_pareto.map(row => <tr key={row.key}><th scope="row">{qualityLabel(row.label, lang)}</th><td><strong>{quantity(row.report_count, lang)}</strong></td>{comparison && <td>{quantity(previous.get(row.key)?.previous_count ?? 0, lang)}</td>}{comparison && <td><Delta value={previous.get(row.key)?.change ?? row.report_count} lang={lang} unit="" /></td>}<td>{quantity(row.share_of_type_occurrences_percent, lang, 1)}%</td><td><button type="button" className="qa-link" onClick={() => onSources(row)} disabled={!row.sample_report_ids.length}>{tx('보기', '查看')}</button></td></tr>)}</tbody>
      </table></div> : <p className="qa-empty">{tx('분류된 불량 유형이 없습니다.', '没有已分类的不良类型。')}</p>}
    </section>
  </div>;
}
function Recurring({ data, lang, tx, onSources }: Copy & { data: QualityAnalysis; onSources: OpenSources }) {
  const rows = data.report?.recurring ?? [];
  if (!rows.length) return null;
  return <section className="qa-panel"><div className="qa-section-heading"><div><h2>{tx('반복 발생 품목', '重复发生品项')}</h2><p>{tx('같은 품목에서 같은 불량 유형이 2건 이상 · 여러 날에 걸친 순', '同一品项同一不良类型 2 条以上 · 按跨越天数排序')}</p></div></div>
    <div className="qa-focus-grid">{rows.slice(0, 8).map(row => <article className="qa-focus" key={`${row.model_display}-${row.part_no}-${row.type_key}`}>
      <h3>{qualityLabel(row.type_label, lang)}</h3><strong>{row.model_display || row.part_no} <span>· {row.report_count}{tx('건', '条')}</span></strong>
      <p>{row.model_display && row.part_no ? `${row.part_no} · ` : ''}{row.day_count > 1 ? tx(`${row.day_count}일에 걸쳐 발생 (${row.first_date.slice(5)}~${row.last_date.slice(5)})`, `跨 ${row.day_count} 天发生（${row.first_date.slice(5)}~${row.last_date.slice(5)}）`) : tx(`${row.first_date.slice(5)} 하루에 집중`, `集中在 ${row.first_date.slice(5)} 当天`)}</p>
      <button type="button" className="qa-link" onClick={() => onSources({ key: row.type_key, label: `${row.model_display || row.part_no} · ${qualityLabel(row.type_label, lang)}`, report_count: row.report_count, sample_report_ids: row.sample_report_ids })}>{tx('원본 비교', '对照原始报告')}<ArrowUpRight size={14} /></button>
    </article>)}</div>
  </section>;
}
export default function QualityAnalysisPage() {
  const { lang: appLang } = useLang();
  const lang: QualityLanguage = appLang === 'zh' ? 'zh' : 'ko';
  const tx = (ko: string, zh: string) => lang === 'zh' ? zh : ko;
  const [searchParams, setSearchParams] = useSearchParams();
  const today = getShanghaiDateString();
  let scope: QualityScope = defaultQualityScope(today);
  let urlError = false;
  try { scope = resolveQualityScope(searchParams.toString(), today); if (scope.endDate > today) urlError = true; } catch { urlError = true; }
  const [draft, setDraft] = useState(scope);
  const [filterError, setFilterError] = useState(false);
  const [source, setSource] = useState<{ ids: number[]; title: string } | null>(null);
  useEffect(() => { setDraft({ startDate: scope.startDate, endDate: scope.endDate, section: scope.section, machineNumber: scope.machineNumber }); setFilterError(false); setSource(null); }, [scope.startDate, scope.endDate, scope.section, scope.machineNumber]);
  const query = useQuery({ queryKey: ['quality-analysis', scope.startDate, scope.endDate, scope.section, scope.machineNumber], queryFn: () => getQualityAnalysis(scope), enabled: !urlError, staleTime: 60_000 });
  const data = !urlError && query.isSuccess ? query.data : undefined;
  const scopeChanged = draft.startDate !== scope.startDate || draft.endDate !== scope.endDate || draft.section !== scope.section || draft.machineNumber !== scope.machineNumber;
  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    try { validateQualityScope(draft); if (draft.endDate > today) throw new Error('future'); setSearchParams(qualityScopeParams(draft)); setFilterError(false); setSource(null); } catch { setFilterError(true); }
  };
  const onSources: OpenSources = row => { if (row.sample_report_ids.length) setSource({ ids: row.sample_report_ids, title: qualityLabel(row.label, lang) }); };
  const exportCsv = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([createQualityReportCsv(data, lang)], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = `quality_report_${scope.startDate}_${scope.endDate}_${scope.section || 'all'}_${scope.machineNumber || 'all'}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  const selectedSection = scope.section ? SECTION_LABELS[scope.section]?.[lang] ?? scope.section : tx('전체 검사 부문', '全部检验部门');
  const selectedMachine = scope.machineNumber === 'unknown' ? tx('설비 미기재', '设备未填写') : scope.machineNumber ? `IMM${scope.machineNumber.padStart(2, '0')}` : tx('전체 설비', '全部设备');
  const operations = data?.report?.operations.summary;
  const minimumShots = data?.report?.operations.min_operating_shots ?? 100;
  const comparison = data?.report?.comparison;
  const topType = data?.type_pareto[0];
  const highlights = data ? buildQualityHighlights(data, lang) : [];
  return <main className="quality-analysis">
    <header className="qa-header"><div className="qa-title"><span><BarChart3 size={21} /></span><div><h1>{tx('불량 분석 보고서', '不良分析报告')}</h1><p>{tx('품질 신고의 추세·유형·품목과 생산량 대비 현황', '品质报告的趋势、类型、品项及与产量的对比')}</p></div></div><div className="qa-header-actions"><PermissionLink className="qa-button qa-button--quiet" to="/quality#history"><FileText size={15} />{tx('전체 보고 이력', '全部报告履历')}</PermissionLink><button type="button" className="qa-button qa-button--quiet" disabled={query.isFetching || urlError} onClick={() => void query.refetch()}><RefreshCw size={15} />{tx('새로고침', '刷新')}</button><button type="button" className="qa-button" disabled={!data} onClick={exportCsv}><Download size={15} />{tx('보고서 CSV', '报告 CSV')}</button></div></header>
    <form className="qa-filters" onSubmit={applyFilters}><label>{tx('시작일', '开始日期')}<input type="date" value={draft.startDate} max={today} required onChange={event => setDraft(prev => ({ ...prev, startDate: event.target.value }))} /></label><label>{tx('종료일', '结束日期')}<input type="date" value={draft.endDate} max={today} required onChange={event => setDraft(prev => ({ ...prev, endDate: event.target.value }))} /></label><label>{tx('검사 부문 / 공정', '检验部门 / 工序')}<select value={draft.section} onChange={event => setDraft(prev => ({ ...prev, section: event.target.value }))}><option value="">{tx('전체', '全部')}</option>{QUALITY_SECTIONS.map(section => <option key={section} value={section}>{SECTION_LABELS[section][lang]}</option>)}</select></label><label>{tx('설비', '设备')}<select value={draft.machineNumber} onChange={event => setDraft(prev => ({ ...prev, machineNumber: event.target.value }))}><option value="">{tx('전체', '全部')}</option>{Array.from({ length: 17 }, (_, index) => String(index + 1)).map(number => <option key={number} value={number}>IMM{number.padStart(2, '0')}</option>)}<option value="unknown">{tx('설비 미기재', '设备未填写')}</option></select></label><button type="submit" className="qa-button">{tx('조회 적용', '应用查询')}</button><button type="button" className="qa-button qa-button--quiet" onClick={() => { const next = defaultQualityScope(today); setDraft(next); setSearchParams(qualityScopeParams(next)); setSource(null); }}>{tx('최근 30일', '最近30天')}</button>{scopeChanged && <p>{tx('필터 변경 후 조회 적용을 눌러 주세요.', '修改筛选后请点击应用查询。')}</p>}</form>
    {(filterError || urlError) && <div role="alert" className="qa-notice qa-notice--warning">{tx('날짜 순서와 조회 조건을 확인하세요. 미래 날짜를 제외한 최대 366일을 선택할 수 있습니다.', '请检查日期顺序及查询条件，可选择不含未来日期的最多366天。')}</div>}
    {!urlError && query.isPending && <div className="qa-loading" role="status"><Activity size={22} /><p>{tx('보고서를 집계하고 있습니다…', '正在汇总报告…')}</p></div>}
    {!urlError && query.isError && <div role="alert" className="qa-notice qa-notice--warning"><AlertTriangle size={20} /><div><strong>{tx('보고서를 불러오지 못했습니다.', '未能加载报告。')}</strong><p>{tx('잠시 후 새로고침하거나 기간을 좁혀 다시 조회해 주세요.', '请稍后刷新，或缩小期间后重新查询。')}</p></div></div>}
    {data && <>
      <div className="qa-applied-scope"><strong>{scope.startDate} → {scope.endDate}</strong><span>{selectedSection} · {selectedMachine}</span><span>{tx('최근 신고 반영', '最近报告更新')} {moment(data.freshness.latest_updated_at, lang)}</span></div>
      <section className="qa-metrics" aria-label={tx('기간 요약', '期间汇总')}>
        <article><span>{tx('품질 신고', '品质报告')}</span><strong>{quantity(data.summary.report_count, lang)}<small>{tx('건', '条')}</small></strong><p>{comparison ? <>{tx('직전 기간', '上一期间')} {quantity(comparison.report_count, lang)}{tx('건', '条')} <Delta value={percentChange(data.summary.report_count, comparison.report_count)} lang={lang} /></> : tx('선택 기간 합계', '所选期间合计')}</p></article>
        <article><span>{tx('조업일당 신고', '每生产日报告')}</span><strong>{quantity(operations?.reports_per_operating_day, lang, 1)}<small>{tx('건/일', '条/天')}</small></strong><p>{operations?.operating_day_count != null ? tx(`조업일 ${operations.operating_day_count}일 / 달력 ${operations.calendar_day_count}일`, `生产日 ${operations.operating_day_count} 天 / 日历 ${operations.calendar_day_count} 天`) : tx('생산 자료 확인 중', '生产数据确认中')} <Delta value={percentChange(operations?.reports_per_operating_day, comparison?.reports_per_operating_day)} lang={lang} /></p></article>
        <article><span>{tx('사출 1만 쇼트당 신고', '注塑每万模次报告')}</span><strong>{quantity(operations?.injection_reports_per_10k_shots, lang, 2)}<small>{tx('건', '条')}</small></strong><p>{operations?.injection_reports_per_10k_shots != null ? tx(`사출 신고 ${quantity(operations.injection_report_count, lang)}건 · ${quantity((operations.shot_count ?? 0) / 10000, lang, 1)}만 쇼트`, `注塑报告 ${quantity(operations.injection_report_count, lang)} 条 · ${quantity((operations.shot_count ?? 0) / 10000, lang, 1)} 万模次`) : tx('사출 공정·설비 조회에서 표시', '在注塑工序及设备查询中显示')}</p></article>
        <article><span>{tx('최다 불량 유형', '最多不良类型')}</span><strong className="qa-metric-text">{topType ? qualityLabel(topType.label, lang) : '—'}</strong><p>{topType ? tx(`${topType.report_count}건 · 분류된 불량의 ${quantity(topType.share_of_type_occurrences_percent, lang, 1)}%`, `${topType.report_count} 条 · 占已分类不良 ${quantity(topType.share_of_type_occurrences_percent, lang, 1)}%`) : tx('분류된 유형 없음', '无已分类类型')}</p></article>
      </section>
      {data.status === 'no_records' ? <div className="qa-notice">{tx('선택한 기간·조건에 해당하는 품질 신고가 없습니다.', '所选期间及条件下没有品质报告。')}</div> : <>
        {highlights.length > 0 && <section className="qa-panel qa-highlights"><h2>{tx('핵심 요약', '要点摘要')}</h2><ul>{highlights.map(line => <li key={line}>{line}</li>)}</ul></section>}
        <Trend data={data} lang={lang} tx={tx} />
        <Types data={data} lang={lang} tx={tx} onSources={onSources} />
        {data.production_context && <QualityProductionConcentrations data={data.production_context} lang={lang} tx={tx} onSources={onSources} />}
        <Recurring data={data} lang={lang} tx={tx} onSources={onSources} />
        {data.report && <QualityProductionIntensity report={data.report} series={getReportTrendSeries(data, 'reports')} lang={lang} tx={tx} />}
        {!scope.section && <SectionShare data={data.concentrations.sections} lang={lang} tx={tx} onSources={onSources} />}
      </>}
      <p className="qa-caption qa-report-basis">{tx(`기준: 신고는 보고일. 조업일은 MES 쇼트가 ${minimumShots}회 이상 기록된 날(08시~익일 08시)이며, 쇼트 기록이 전혀 없는 날만 사출 계획으로 대신합니다. 불량 수량은 신고서에 적힌 수량의 합계입니다.`, `口径：报告按报告日期。生产日为 MES 模次达到 ${minimumShots} 次以上的日期（08时~次日08时）；仅在完全没有模次记录时改用注塑计划判断。不良数量为报告中所填数量的合计。`)} · {tx('집계', '汇总')} {moment(data.freshness.generated_at, lang)}</p>
    </>}
    {source && <ReportSources key={source.ids.join(',')} ids={source.ids} title={source.title} onClose={() => setSource(null)} lang={lang} tx={tx} />}
  </main>;
}
