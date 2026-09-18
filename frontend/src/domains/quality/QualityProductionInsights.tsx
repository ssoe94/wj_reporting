import { useState } from 'react';
import { Eye } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { QualityLanguage, QualityProductionConcentration, QualityProductionContext, QualityProductionGroup, QualityTypeEvidence } from './model';
import type { QualityReport, QualityReportTrendPoint } from './report';

type Copy = { lang: QualityLanguage; tx: (ko: string, zh: string) => string };
type Sources = (group: QualityTypeEvidence) => void;
function number(value: number | null | undefined, lang: QualityLanguage, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(lang === 'zh' ? 'zh-CN' : 'ko-KR', { maximumFractionDigits: digits }) : '—';
}
function machineName(value: number) { return `IMM${String(value).padStart(2, '0')}`; }

function ProductionConcentration({ data, machines, lang, tx, onSources }: Copy & { data: QualityProductionConcentration; machines: boolean; onSources: Sources }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? data.items : data.items.slice(0, 6);
  const modelName = (row: QualityProductionGroup) => row.model_display || tx('모델 미기재', '型号未填写');
  return <section className="qa-panel">
    <div className="qa-section-heading"><div><h2>{machines ? tx('설비·모델별 신고', '按设备及型号的报告') : tx('모델·품목별 신고', '按型号及品项的报告')}</h2><p>{machines ? tx('신고가 몰린 설비와 모델 조합', '报告集中的设备与型号组合') : tx('신고가 몰린 모델과 품번', '报告集中的型号与品号')} · {tx('신고 건수 순', '按报告条数排序')}</p></div><span className="qa-badge">{data.total_group_count}{tx('개', '组')}</span></div>
    {rows.length ? <div className="qa-table-wrap"><table className="qa-table qa-production-table"><thead><tr><th>{machines ? tx('설비 / 모델', '设备 / 型号') : tx('모델 / 품목', '型号 / 品项')}</th><th>{tx('신고', '报告')}</th><th>{tx('기록 불량수', '记录不良数')}</th><th>{tx('원본', '原始报告')}</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}>
      <th scope="row">{machines && <span className="qa-machine-label">{row.machine_number ? machineName(row.machine_number) : tx('설비 미기재', '设备未填写')}</span>}<strong>{modelName(row)}</strong><small>Part No. {row.part_no || '—'}</small></th>
      <td><strong>{number(row.report_count, lang)}{tx('건', '条')}</strong><small>{number(row.share_of_reports_percent, lang, 1)}%</small><span className="qa-inline-bar"><i style={{ width: `${row.share_of_reports_percent}%` }} /></span></td>
      <td>{number(row.reported_defect_qty, lang)}</td>
      <td><button type="button" className="qa-link" disabled={!row.sample_report_ids.length} onClick={() => onSources({ ...row, label: modelName(row) })}><Eye size={14} />{tx('보기', '查看')}</button></td>
    </tr>)}</tbody></table></div> : <p className="qa-empty">{tx('이 범위에 신고가 없습니다.', '此范围内没有报告。')}</p>}
    {data.items.length > 6 && <div className="qa-panel-footer"><span /><button className="qa-link" type="button" onClick={() => setExpanded(!expanded)}>{expanded ? tx('간략히', '收起') : tx(`상위 ${data.items.length}개 보기`, `查看前${data.items.length}组`)}</button></div>}
  </section>;
}
export function QualityProductionConcentrations({ data, lang, tx, onSources }: Copy & { data: QualityProductionContext; onSources: Sources }) {
  return <div className="qa-two-columns"><ProductionConcentration data={data.model_parts} machines={false} lang={lang} tx={tx} onSources={onSources} /><ProductionConcentration data={data.machine_models} machines lang={lang} tx={tx} onSources={onSources} /></div>;
}

/** Injection output against injection quality reports: shots, running machines and reports per 10,000 shots. */
export function QualityProductionIntensity({ report, series, lang, tx }: Copy & { report: QualityReport; series: QualityReportTrendPoint[] }) {
  const { summary, machines, min_operating_shots: minimum } = report.operations;
  if (report.operations.status !== 'ready' || !report.operations.injection_scope || !summary.shot_count) return null;
  const ranked = [...machines].sort((a, b) => (b.reports_per_10k_shots ?? -1) - (a.reports_per_10k_shots ?? -1) || b.report_count - a.report_count);
  const shotName = tx('사출 쇼트 수', '注塑模次'); const machineCountName = tx('가동 설비 수', '运行设备数');
  return <section className="qa-panel">
    <div className="qa-section-heading"><div><h2>{tx('생산량 대비 사출 신고', '注塑报告与产量对比')}</h2><p>{tx('MES 형합(쇼트) 수 기준 · 많이 생산한 날과 설비를 같은 잣대로 비교', '以 MES 模次为基准 · 用同一尺度比较产量不同的日期与设备')}</p></div></div>
    <div className="qa-shift-metrics">
      <article><span>{tx('사출 1만 쇼트당 신고', '注塑每万模次报告')}</span><strong>{number(summary.injection_reports_per_10k_shots, lang, 2)}<small>{tx('건', '条')}</small></strong><p>{number(summary.injection_report_count, lang)}{tx('건', '条')} ÷ {number(summary.shot_count / 10000, lang, 1)}{tx('만 쇼트', '万模次')}</p></article>
      <article><span>{tx('기간 사출 쇼트 수', '期间注塑模次')}</span><strong>{number(summary.shot_count, lang)}<small>{tx('쇼트', '模次')}</small></strong><p>{tx('조업일 평균', '生产日平均')} {number(summary.operating_day_count ? summary.shot_count / summary.operating_day_count : null, lang)}</p></article>
      <article><span>{tx('조업일', '生产日')}</span><strong>{number(summary.operating_day_count, lang)}<small>/ {summary.calendar_day_count}{tx('일', '天')}</small></strong><p>{tx(`쇼트 ${minimum}회 이상 기록된 날`, `模次达到 ${minimum} 次以上的日期`)}</p></article>
      <article><span>{tx('가동 설비', '运行设备')}</span><strong>{machines.filter(row => row.shot_count > 0).length}<small>{tx('대', '台')}</small></strong><p>{tx('기간 중 쇼트가 기록된 사출기', '期间有模次记录的注塑机')}</p></article>
    </div>
    <div className="qa-chart" role="img" aria-label={tx('조업일별 사출 쇼트 수와 가동 설비 수', '各生产日注塑模次与运行设备数')}><ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={series} margin={{ top: 10, right: 4, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7edf4" />
        <XAxis dataKey="date" tickFormatter={(value: string) => value.slice(5)} minTickGap={28} interval="preserveStartEnd" tickLine={false} axisLine={false} />
        <YAxis yAxisId="shots" width={56} tickFormatter={(value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)} tickLine={false} axisLine={false} />
        <YAxis yAxisId="machines" orientation="right" width={32} domain={[0, 17]} allowDecimals={false} tickLine={false} axisLine={false} />
        <Tooltip labelFormatter={value => String(value)} formatter={(value: number, name: string) => [number(value, lang) + ' ' + (name === shotName ? tx('쇼트', '模次') : tx('대', '台')), name]} />
        <Legend iconSize={12} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        <Bar yAxisId="shots" dataKey="shot_count" name={shotName} fill="#9db7d8" maxBarSize={26} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        <Line yAxisId="machines" type="linear" dataKey="running_machine_count" name={machineCountName} stroke="#2979a2" strokeWidth={2} dot={series.length <= 60 ? { r: 2 } : false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer></div>
    {ranked.some(row => row.report_count > 0) && <div className="qa-table-wrap"><table className="qa-table"><thead><tr><th>{tx('설비', '设备')}</th><th>{tx('가동일', '运行天数')}</th><th>{tx('쇼트 수', '模次')}</th><th>{tx('사출 신고', '注塑报告')}</th><th>{tx('1만 쇼트당 신고', '每万模次报告')}</th></tr></thead>
      <tbody>{ranked.map(row => <tr key={row.machine_number}><th scope="row">{machineName(row.machine_number)}</th><td>{number(row.running_day_count, lang)}</td><td>{number(row.shot_count, lang)}</td><td>{number(row.report_count, lang)}</td><td><strong>{number(row.reports_per_10k_shots, lang, 2)}</strong></td></tr>)}</tbody></table></div>}
    <p className="qa-caption">{ranked.some(row => row.report_count > 0)
      ? tx('설비별 신고는 신고서에 설비가 적혀 있거나 당일 생산 기록으로 설비가 하나로 확인되는 건만 집계합니다.', '各设备报告仅统计报告中已填写设备，或可由当日生产记录唯一确认设备的条目。')
      : tx('신고서에 설비가 적힌 건이 없어 설비별 비교는 표시하지 않습니다.', '报告中没有填写设备的条目，因此不显示各设备对比。')}</p>
  </section>;
}
