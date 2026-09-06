import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { Activity, AlertTriangle, ArrowUpRight, BarChart3, CheckCircle2, Download, Eye, FileText, RefreshCw, X } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import PermissionLink from '@/components/common/PermissionLink';
import { useLang } from '@/i18n';
import { getShanghaiDateString } from '@/shared/utils/date';
import { getQualityAnalysis, getQualitySourceReport } from './api';
import { createQualityAnalysisCsv, defaultQualityScope, QUALITY_SECTIONS, qualityLabel, qualityScopeParams, quantityCoverage, resolveQualityScope, SECTION_LABELS, validateQualityScope } from './model';
import type { QualityAnalysis, QualityConcentration, QualityGroup, QualityLanguage, QualityScope } from './model';
import './quality-analysis.css';

type Copy = { lang: QualityLanguage; tx: (ko: string, zh: string) => string };
type OpenSources = (row: QualityGroup) => void;
function quantity(value: number | null | undefined, lang: QualityLanguage, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(lang === 'zh' ? 'zh-CN' : 'ko-KR', { maximumFractionDigits: digits }) : '—';
}
function moment(value: string | null | undefined, lang: QualityLanguage) {
  return value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'ko-KR', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
}
function ReportSources({ ids, title, onClose, lang, tx }: Copy & { ids: number[]; title: string; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const id = ids[index];
  const query = useQuery({ queryKey: ['quality-analysis-source', id], queryFn: () => getQualitySourceReport(id), enabled: Boolean(id), staleTime: 30_000 });
  const report = query.isSuccess ? query.data : undefined;
  return <Dialog open onClose={onClose} className="qa-dialog"><DialogBackdrop className="qa-dialog-backdrop" /><div className="qa-dialog-position"><DialogPanel className="qa-dialog-panel">
    <div className="qa-section-heading"><div><DialogTitle>{tx('원본 품질 보고서', '原始品质报告')} #{id}</DialogTitle><p>{title} · {tx('그룹별 최근 표본 최대 5건', '每组最近样本，最多5条')}</p></div><button type="button" className="qa-icon-button" onClick={onClose} aria-label={tx('닫기', '关闭')}><X size={20} /></button></div>
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
      <p className="qa-caption">{tx('원본 입력값입니다. 이 보고서의 판정·입력 불량률을 전체 생산의 품질 판정으로 확대하지 않습니다.', '以上为原始填写值，不将单份报告的判定或填写不良率推广为整体生产质量结论。')}</p>
    </> : null}
  </DialogPanel></div></Dialog>;
}
function Concentration({ title, subtitle, data, lang, tx, onSources, sectionLabels = false }: Copy & { title: string; subtitle: string; data: QualityConcentration; onSources: OpenSources; sectionLabels?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? data.items : data.items.slice(0, 6);
  const hiddenCount = data.other_report_count + data.items.slice(rows.length).reduce((sum, row) => sum + row.report_count, 0);
  return <section className="qa-panel"><div className="qa-section-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><span className="qa-badge">{data.total_group_count}{tx('개 그룹', '个分组')}</span></div>
    {rows.length ? <div className="qa-table-wrap"><table className="qa-table"><thead><tr><th>{tx('대상', '对象')}</th><th>{tx('신고 건수 / 비중', '报告条数 / 占比')}</th><th>{tx('기록 불량수', '记录不良数')}</th><th>{tx('원본', '原始报告')}</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}><th scope="row">{sectionLabels ? SECTION_LABELS[row.key]?.[lang] ?? qualityLabel(row.label, lang) : row.key === 'unknown' ? tx('미지정 / 미기재', '未关联 / 未填写') : qualityLabel(row.label, lang)}</th><td><strong>{quantity(row.report_count, lang)}</strong><small>{quantity(row.share_of_reports_percent, lang, 1)}%</small><span className="qa-inline-bar"><i style={{ width: `${row.share_of_reports_percent}%` }} /></span></td><td>{quantity(row.reported_defect_qty, lang)}<small>{row.defect_quantity_record_count}/{row.report_count}{tx('건 수량 기재', '条已填写数量')}</small></td><td><button type="button" className="qa-link" disabled={!row.sample_report_ids.length} onClick={() => onSources(row)}><Eye size={14} />{tx('보기', '查看')}</button></td></tr>)}</tbody></table></div> : <p className="qa-empty">{tx('이 범위에 저장된 보고서가 없습니다.', '此范围内没有已保存报告。')}</p>}
    <div className="qa-panel-footer"><span>{hiddenCount > 0 ? tx(`현재 표 밖 ${quantity(hiddenCount, lang)}건 · 비중 분모는 선택 범위 전체 신고`, `当前表外 ${quantity(hiddenCount, lang)} 条 · 占比分母为所选范围全部报告`) : tx('선택 범위의 전체 그룹', '所选范围全部分组')}</span>{data.items.length > 6 && <button type="button" className="qa-link" onClick={() => setExpanded(!expanded)}>{expanded ? tx('간략히', '收起') : tx(`상위 ${data.items.length}개 보기`, `查看前 ${data.items.length} 组`)}</button>}</div>
  </section>;
}
function Charts({ data, lang, tx, onSources }: Copy & { data: QualityAnalysis; onSources: OpenSources }) {
  const [metric, setMetric] = useState<'reports' | 'quantity'>('reports');
  const paretoRows = data.pareto.slice(0, 10).map(row => ({ ...row, name: qualityLabel(row.label, lang) }));
  return <div className="qa-two-columns"><section className="qa-panel"><div className="qa-section-heading"><div><h2>{tx('기간 추세', '期间趋势')}</h2><p>{metric === 'reports' ? tx('보고일 기준 신고 건수', '按报告日期统计报告条数') : tx('수량이 기록된 보고서의 불량수 합계', '已填写数量的报告不良数合计')}</p></div><div className="qa-segments"><button type="button" aria-pressed={metric === 'reports'} onClick={() => setMetric('reports')}>{tx('건수', '条数')}</button><button type="button" aria-pressed={metric === 'quantity'} onClick={() => setMetric('quantity')}>{tx('수량', '数量')}</button></div></div>
    <div className="qa-chart" role="img" aria-label={metric === 'reports' ? tx('일별 저장된 신고 건수 추세', '每日已保存报告条数趋势') : tx('일별 기록된 불량 수량 추세. 수량 미기재 날짜는 공백입니다.', '每日记录不良数量趋势，数量未填写的日期显示为空白。')}><ResponsiveContainer width="100%" height={250}><ComposedChart data={data.trend} margin={{ top: 12, right: 14, left: 0, bottom: 4 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7edf4" /><XAxis dataKey="date" minTickGap={28} tickFormatter={(value: string) => value.slice(5)} tickLine={false} axisLine={false} /><YAxis width={52} allowDecimals={false} tickLine={false} axisLine={false} /><Tooltip labelFormatter={label => String(label)} formatter={(value: number) => `${quantity(value, lang)} ${metric === 'reports' ? tx('건', '条') : tx('개', '个')}`} />{metric === 'reports' ? <Bar dataKey="report_count" name={tx('신고 건수', '报告条数')} fill="#3978dc" maxBarSize={24} radius={[3, 3, 0, 0]} isAnimationActive={false} /> : <Line dataKey="reported_defect_qty" name={tx('기록된 불량 수량', '记录不良数量')} stroke="#bf6b21" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />}</ComposedChart></ResponsiveContainer></div>
    <p className="qa-caption">{tx('신고가 없는 날짜는 신고 0건입니다. 불량 수량 공백은 불량 0이나 검사 완료를 뜻하지 않습니다.', '无报告的日期为报告0条。不良数量空白不代表不良为0或检验已完成。')}</p>
    <details className="qa-detail"><summary>{tx('일별 수치 보기', '查看每日数值')}</summary><div className="qa-table-wrap qa-scroll"><table className="qa-table"><thead><tr><th>{tx('보고일', '报告日期')}</th><th>{tx('신고 건수', '报告条数')}</th><th>{tx('기록 불량수', '记录不良数')}</th><th>{tx('수량 기재 건수', '已填数量条数')}</th></tr></thead><tbody>{data.trend.map(row => <tr key={row.date}><th>{row.date}</th><td>{quantity(row.report_count, lang)}</td><td>{quantity(row.reported_defect_qty, lang)}</td><td>{row.defect_quantity_record_count}</td></tr>)}</tbody></table></div></details>
  </section><section className="qa-panel"><div className="qa-section-heading"><div><h2>{tx('불량 유형 Pareto', '不良类型 Pareto')}</h2><p>{tx(`신고 건수 순 상위 ${paretoRows.length}개 · 누적 비중 분모 ${data.summary.report_count}건`, `按报告条数前 ${paretoRows.length} 类 · 累计占比分母 ${data.summary.report_count} 条`)}</p></div></div>
    {paretoRows.length ? <div className="qa-chart" role="img" aria-label={tx('불량 유형별 신고 건수 막대와 전체 신고 대비 누적 비중', '各不良类型报告条数及占全部报告的累计比例')}><ResponsiveContainer width="100%" height={250}><ComposedChart data={paretoRows} margin={{ top: 12, right: 0, left: 0, bottom: 18 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7edf4" /><XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-18} textAnchor="end" height={55} tickLine={false} axisLine={false} /><YAxis yAxisId="count" allowDecimals={false} width={42} tickLine={false} axisLine={false} /><YAxis yAxisId="share" orientation="right" domain={[0, 100]} width={38} tickFormatter={value => `${value}%`} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} /><Tooltip formatter={(value: number, name: string) => `${quantity(value, lang, name === tx('누적 비중', '累计占比') ? 1 : 0)}${name === tx('누적 비중', '累计占比') ? '%' : tx('건', '条')}`} /><Bar yAxisId="count" dataKey="report_count" name={tx('신고 건수', '报告条数')} fill="#6382b8" maxBarSize={38} radius={[3, 3, 0, 0]} isAnimationActive={false} /><Line yAxisId="share" dataKey="cumulative_report_share_percent" name={tx('누적 비중', '累计占比')} stroke="#cc7a2b" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} /></ComposedChart></ResponsiveContainer></div> : <p className="qa-empty">{tx('분류할 신고가 없습니다.', '没有可分类的报告。')}</p>}
    <p className="qa-caption">{tx('유형은 현상 원문으로 분류합니다. 복합 유형은 한 그룹으로 묶어 건수·수량을 중복 배정하지 않습니다.', '按现象原文分类，复合类型归为一个分组，不重复分配报告条数或数量。')}</p>
    <details className="qa-detail"><summary>{tx('전체 유형과 원본 보기', '查看全部类型及原始报告')}</summary><div className="qa-table-wrap qa-scroll"><table className="qa-table"><thead><tr><th>{tx('유형', '类型')}</th><th>{tx('신고', '报告')}</th><th>{tx('누적', '累计')}</th><th>{tx('원본', '原始报告')}</th></tr></thead><tbody>{data.pareto.map(row => <tr key={row.key}><th>{qualityLabel(row.label, lang)}</th><td>{row.report_count}</td><td>{quantity(row.cumulative_report_share_percent, lang, 1)}%</td><td><button type="button" className="qa-link" onClick={() => onSources(row)} disabled={!row.sample_report_ids.length}>{tx('보기', '查看')}</button></td></tr>)}</tbody></table></div></details>
  </section></div>;
}
function ReviewFocus({ data, lang, tx, onSources }: Copy & { data: QualityAnalysis; onSources: OpenSources }) {
  const repeatedPart = data.concentrations.parts.items.find(row => row.key !== 'unknown' && row.report_count > 1);
  const ambiguous = data.pareto.filter(row => row.key === 'multiple' || row.key === 'unclassified');
  const unknownMachine = data.concentrations.machines.items.find(row => row.key === 'unknown');
  const candidates = [
    ...ambiguous.map(row => ({ row, title: tx('불량 유형 원문 확인', '核对不良类型原文'), reason: tx('분류가 미확정이거나 여러 유형이 함께 기재된 보고서입니다.', '类型未确定或同时填写了多种类型的报告。') })),
    ...(repeatedPart ? [{ row: repeatedPart, title: tx('같은 품번의 반복 신고 확인', '核对同品号重复报告'), reason: tx('별개 사건인지 반복 문제인지 원본을 비교하세요. 동일 품번만으로 중복을 확정하지 않습니다.', '对照原始报告，确认是独立事件还是重复问题。仅凭相同品号不判定重复。') }] : []),
    ...(unknownMachine ? [{ row: unknownMachine, title: tx('발생 설비 보완', '补充发生设备'), reason: tx('발생 위치에 명시된 설비 번호를 확인할 수 없습니다.', '发生位置中无法确认明确的设备编号。') }] : []),
  ];
  return <section className="qa-panel"><div className="qa-section-heading"><div><h2>{tx('주요 확인 대상', '重点核对对象')}</h2><p>{tx('원문 비교와 입력 보완 후보입니다. 실제 원인·조치 완료를 판정하지 않습니다.', '以下为原文对照及补录候选，不代表已确定原因或完成措施。')}</p></div></div>
    {candidates.length ? <div className="qa-focus-grid">{candidates.map(({ row, title, reason }, index) => <article className="qa-focus" key={`${row.key}-${index}`}><h3>{title}</h3><strong>{qualityLabel(row.label, lang)} <span>· {row.report_count}{tx('건', '条')}</span></strong><p>{reason}</p><button type="button" className="qa-link" onClick={() => onSources(row)} disabled={!row.sample_report_ids.length}>{tx('원본 비교', '对照原始报告')}<ArrowUpRight size={14} /></button></article>)}</div> : <p className="qa-empty">{data.summary.report_count ? tx('현재 분류에서 확인 후보가 없습니다. 아래 미기재 항목을 함께 확인하세요.', '当前分类下没有核对候选，请同时检查下方缺失项。') : tx('저장된 보고서가 없어 확인 대상을 정할 수 없습니다.', '没有已保存报告，无法确定核对对象。')}</p>}
  </section>;
}
function DataQuality({ data, lang, tx }: Copy & { data: QualityAnalysis }) {
  const q = data.data_quality;
  const checks = [
    [tx('불량 수량 미기재', '不良数量未填写'), q.missing_defect_qty_count, tx('수량 합계에서 제외 · 0으로 대체하지 않음', '不纳入数量合计，不替换为0')],
    [tx('검사 수량 미기재', '检验数量未填写'), q.missing_inspection_qty_count, tx('불량률 분모로 사용할 수 없음', '不能作为不良率分母')],
    [tx('불량수 > 검사수', '不良数 > 检验数'), q.inconsistent_quantity_count, tx('원본 수량과 대상 LOT 확인', '核对原始数量及对应批次')],
    [tx('유효하지 않은 수량', '无效数量'), q.invalid_quantity_count, tx('유효 수량 합계에서 제외', '不纳入有效数量合计')],
    [tx('설비 미지정', '设备未关联'), q.unassigned_machine_count, tx('기록된 위치에서만 설비를 확인', '仅根据已记录位置确认设备')],
    [tx('품번 미기재', '品号未填写'), q.missing_part_count, tx('품번별 집중도 비교 제한', '限制按品号比较集中度')],
    [tx('현상 원문 미기재', '现象原文未填写'), q.missing_phenomenon_count, tx('유형·원인 검토 근거 부족', '类型及原因核对依据不足')],
    [tx('중복 후보 보고서', '疑似重复报告'), q.duplicate_candidate_report_count, tx(`${q.duplicate_candidate_group_count}개 후보 그룹 · 합계에서 자동 제외하지 않음`, `${q.duplicate_candidate_group_count} 个候选组，不自动从合计中剔除`)],
  ] as const;
  return <section className="qa-panel"><div className="qa-section-heading"><div><h2>{tx('자료 완전성과 해석 범위', '数据完整性与解释范围')}</h2><p>{tx(`선택 범위 신고 ${data.summary.report_count}건 기준 · 점검 항목은 서로 겹칠 수 있습니다.`, `以所选范围 ${data.summary.report_count} 条报告为基准，检查项之间可能重叠。`)}</p></div></div><div className="qa-quality-grid">{checks.map(([label, value, caption]) => <article className={value ? 'qa-check qa-check--warning' : 'qa-check'} key={label}><span>{value ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}{label}</span><strong>{quantity(value, lang)}<small>{tx('건', '条')}</small></strong><p>{caption}</p></article>)}</div>
    <p className="qa-caption">{tx(`검사·불량 수량이 함께 기재된 보고서는 ${q.paired_quantity_record_count}건입니다. 검사 수량은 같은 LOT이 반복될 수 있어 고유 검사수나 전체 불량률 분모로 합산하지 않습니다.`, `同时填写检验与不良数量的报告为 ${q.paired_quantity_record_count} 条。同一批次可能重复出现，检验数量不作为唯一检验数或整体不良率分母。`)}</p>
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
    const url = URL.createObjectURL(new Blob([createQualityAnalysisCsv(data, lang)], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = `quality_analysis_${scope.startDate}_${scope.endDate}_${scope.section || 'all'}_${scope.machineNumber || 'all'}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  const coverage = data ? quantityCoverage(data.summary) : null;
  const selectedSection = scope.section ? SECTION_LABELS[scope.section]?.[lang] ?? scope.section : tx('전체 검사 부문', '全部检验部门');
  const selectedMachine = scope.machineNumber === 'unknown' ? tx('설비 미지정', '设备未关联') : scope.machineNumber ? `IMM${scope.machineNumber.padStart(2, '0')}` : tx('전체 설비', '全部设备');
  return <main className="quality-analysis">
    <header className="qa-header"><div className="qa-title"><span><BarChart3 size={21} /></span><div><h1>{tx('불량 분석 보고서', '不良分析报告')}</h1><p>{tx('저장된 품질 신고의 추세·집중도와 입력 완전성', '已保存品质报告的趋势、集中度及填写完整性')}</p></div></div><div className="qa-header-actions"><PermissionLink className="qa-button qa-button--quiet" to="/quality#stats"><FileText size={15} />{tx('전체 보고 이력', '全部报告履历')}</PermissionLink><button type="button" className="qa-button qa-button--quiet" disabled={query.isFetching || urlError} onClick={() => void query.refetch()}><RefreshCw size={15} />{tx('새로고침', '刷新')}</button><button type="button" className="qa-button" disabled={!data} onClick={exportCsv}><Download size={15} />{tx('분석 CSV', '分析 CSV')}</button></div></header>
    <form className="qa-filters" onSubmit={applyFilters}><label>{tx('시작일', '开始日期')}<input type="date" value={draft.startDate} max={today} required onChange={event => setDraft(prev => ({ ...prev, startDate: event.target.value }))} /></label><label>{tx('종료일', '结束日期')}<input type="date" value={draft.endDate} max={today} required onChange={event => setDraft(prev => ({ ...prev, endDate: event.target.value }))} /></label><label>{tx('검사 부문 / 공정', '检验部门 / 工序')}<select value={draft.section} onChange={event => setDraft(prev => ({ ...prev, section: event.target.value }))}><option value="">{tx('전체', '全部')}</option>{QUALITY_SECTIONS.map(section => <option key={section} value={section}>{SECTION_LABELS[section][lang]}</option>)}</select></label><label>{tx('기록된 설비', '已记录设备')}<select value={draft.machineNumber} onChange={event => setDraft(prev => ({ ...prev, machineNumber: event.target.value }))}><option value="">{tx('전체', '全部')}</option>{Array.from({ length: 17 }, (_, index) => String(index + 1)).map(number => <option key={number} value={number}>IMM{number.padStart(2, '0')}</option>)}<option value="unknown">{tx('설비 미지정', '设备未关联')}</option></select></label><button type="submit" className="qa-button">{tx('조회 적용', '应用查询')}</button><button type="button" className="qa-button qa-button--quiet" onClick={() => { const next = defaultQualityScope(today); setDraft(next); setSearchParams(qualityScopeParams(next)); setSource(null); }}>{tx('최근 30일', '最近30天')}</button><p>{tx('보고일 기준 · 중국 달력일 00:00~24:00 · 최대 366일', '按报告日期 · 中国日历日00:00~24:00 · 最多366天')}{scopeChanged ? ` · ${tx('필터 변경 후 조회 적용', '修改筛选后请应用查询')}` : ''}</p></form>
    {(filterError || urlError) && <div role="alert" className="qa-notice qa-notice--warning">{tx('날짜 순서와 조회 조건을 확인하세요. 미래 날짜를 제외한 최대 366일을 선택할 수 있습니다.', '请检查日期顺序及查询条件，可选择不含未来日期的最多366天。')}</div>}
    {!urlError && query.isPending && <div className="qa-loading" role="status"><Activity size={22} /><p>{tx('선택 범위의 품질 보고서를 집계하고 있습니다…', '正在汇总所选范围的品质报告…')}</p></div>}
    {!urlError && query.isError && <div role="alert" className="qa-notice qa-notice--warning"><AlertTriangle size={20} /><div><strong>{tx('분석 자료를 확인할 수 없습니다.', '无法确认分析数据。')}</strong><p>{tx('조회 실패를 신고 0건으로 표시하지 않습니다. 기간·공정을 좁혀 재시도하거나 접근 권한과 원천 연결을 확인하세요.', '查询失败不显示为报告0条。请缩小日期或工序范围后重试，或检查访问权限及数据源连接。')}</p></div></div>}
    {data && <>
      <div className="qa-applied-scope"><strong>{scope.startDate} → {scope.endDate}</strong><span>{selectedSection} · {selectedMachine}</span><span>{tx('원천 최근 수정', '数据源最近修改')} {moment(data.freshness.latest_updated_at, lang)} · UTC+8</span></div>
      <section className="qa-metrics" aria-label={tx('선택 범위 요약', '所选范围汇总')}><article><span>{tx('저장된 신고', '已保存报告')}</span><strong>{quantity(data.summary.report_count, lang)}<small>{tx('건', '条')}</small></strong><p>{tx('서로 다른 보고서 ID 기준', '按不同报告ID计数')}</p></article><article><span>{tx('기록된 불량 수량', '记录的不良数量')}</span><strong>{quantity(data.summary.reported_defect_qty, lang)}<small>{tx('개', '个')}</small></strong><p>{tx(`${data.summary.defect_quantity_record_count}건의 수량 합계 · 미기재 제외`, `${data.summary.defect_quantity_record_count} 条报告的数量合计，排除未填写值`)}</p></article><article><span>{tx('불량 수량 기재율', '不良数量填写率')}</span><strong>{quantity(coverage, lang, 1)}<small>%</small></strong><p>{data.summary.defect_quantity_record_count}/{data.summary.report_count}{tx('건 · 검사 합격률 아님', '条 · 非检验合格率')}</p></article><article><span>{tx('불량 0을 명시한 보고서', '明确填写不良0的报告')}</span><strong>{quantity(data.summary.zero_defect_report_count, lang)}<small>{tx('건', '条')}</small></strong><p>{tx('수량 공백과 구분하여 집계', '与数量空白分开统计')}</p></article></section>
      {data.status === 'no_records' ? <div className="qa-notice">{tx('선택 범위에 저장된 품질 보고서가 없습니다. 생산·불량 발생이 0이거나 검사가 완료되었다는 뜻은 아닙니다.', '所选范围没有已保存的品质报告，不代表生产或不良发生为0，也不代表检验已完成。')}</div> : data.summary.defect_quantity_record_count < data.summary.report_count ? <div className="qa-notice qa-notice--warning">{tx(`전체 ${data.summary.report_count}건 중 수량이 확인되는 ${data.summary.defect_quantity_record_count}건만 불량 수량 합계에 포함됩니다.`, `全部 ${data.summary.report_count} 条中，仅 ${data.summary.defect_quantity_record_count} 条数量已填写的报告纳入不良数量合计。`)}</div> : null}
      <Charts data={data} lang={lang} tx={tx} onSources={onSources} />
      <div className="qa-two-columns"><Concentration title={tx('설비별 신고 집중도', '设备报告集中度')} subtitle={tx('명시된 발생 위치 기준 · 생산계획에서 추정하지 않음', '仅按明确记录的发生位置，不从生产计划推断')} data={data.concentrations.machines} lang={lang} tx={tx} onSources={onSources} /><Concentration title={tx('품번별 신고 집중도', '品号报告集中度')} subtitle={tx('정규화한 품번 기준 · 신고 건수 순', '按规范化品号，依报告条数排序')} data={data.concentrations.parts} lang={lang} tx={tx} onSources={onSources} /></div>
      <ReviewFocus data={data} lang={lang} tx={tx} onSources={onSources} />
      <DataQuality data={data} lang={lang} tx={tx} />
      <details className="qa-panel qa-detail"><summary>{tx('검사 부문 분포와 계산 근거', '检验部门分布与计算依据')}</summary><div className="qa-evidence"><Concentration title={tx('검사 부문별 신고', '各检验部门报告')} subtitle={tx('비중 분모는 현재 조회 범위의 신고 건수', '占比分母为当前查询范围报告条数')} data={data.concentrations.sections} lang={lang} tx={tx} onSources={onSources} sectionLabels /><div><h3>{tx('보고서 해석 기준', '报告解释口径')}</h3><ul><li>{tx('품질 보고서만 집계하며, 현장 불량 체크포인트·MES 수량·사출 수기일보와 자동 합산하지 않습니다.', '仅汇总品质报告，不自动合并现场不良检查点、MES 数量或注塑手工日报。')}</li><li>{tx('불량 수량은 기록된 유효 정수의 합계입니다. 생산·검사 전체 모집단이 아니므로 공장 불량률을 계산하지 않습니다.', '不良数量是已记录有效整数的合计，不是全部生产或检验总体，因此不计算工厂不良率。')}</li><li>{tx('중복 후보도 자동 제외하지 않습니다. 실제 중복인지 별개 사건인지 원본 확인이 필요합니다.', '疑似重复报告也不自动剔除，需核对原始报告是否为重复或独立事件。')}</li><li>{tx('설비·품번·부문 표는 상위 20그룹까지 제공하며 표 밖 신고 건수를 따로 표시합니다.', '设备、品号、部门表最多提供前20组，表外报告条数单独显示。')}</li></ul><p className="qa-caption">{tx('집계 생성', '汇总生成')}: {moment(data.freshness.generated_at, lang)} · UTC+8<br />{tx('기간 내 최신 보고', '期间内最近报告')}: {moment(data.freshness.latest_report_at, lang)} · UTC+8<br />{tx('자료는 보고서 저장·수정 시 변경됩니다.', '数据随报告保存或修改而变化。')}</p></div></div></details>
    </>}
    {source && <ReportSources key={source.ids.join(',')} ids={source.ids} title={source.title} onClose={() => setSource(null)} lang={lang} tx={tx} />}
  </main>;
}
