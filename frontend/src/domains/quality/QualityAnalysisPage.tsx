import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { Activity, AlertTriangle, ArrowUpRight, BarChart3, CheckCircle2, Download, Eye, FileText, RefreshCw, X } from 'lucide-react';
import { Bar, Brush, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import PermissionLink from '@/components/common/PermissionLink';
import { useLang } from '@/i18n';
import { getShanghaiDateString } from '@/shared/utils/date';
import { getQualityAnalysis, getQualitySourceReport } from './api';
import { createQualityAnalysisCsv, defaultQualityScope, QUALITY_SECTIONS, qualityLabel, qualityScopeParams, quantityCoverage, resolveQualityScope, SECTION_LABELS, validateQualityScope } from './model';
import type { QualityAnalysis, QualityConcentration, QualityGroup, QualityLanguage, QualityScope } from './model';
import { getQualityTrendSeries } from './trend';
import { QualityProductionConcentrations, QualityProductionShiftTrend } from './QualityProductionInsights';
import './quality-analysis.css';

type Copy = { lang: QualityLanguage; tx: (ko: string, zh: string) => string };
type OpenSources = (row: Pick<QualityGroup, 'key' | 'label' | 'report_count' | 'sample_report_ids'>) => void;
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
function Charts({ data, lang, tx, onSources, collapseInactiveDays, onCollapseChange }: Copy & { data: QualityAnalysis; onSources: OpenSources; collapseInactiveDays: boolean; onCollapseChange: (value: boolean) => void }) {
  const [metric, setMetric] = useState<'reports' | 'quantity'>('reports');
  const trend = getQualityTrendSeries(data.trend, metric, data.activity_calendar, collapseInactiveDays);
  const visibleDates = new Set(trend.map(row => row.date));
  const trendByDate = new Map(trend.map(row => [row.date, row]));
  const omittedCount = data.trend.length - trend.length;
  const calendarDays = new Map(data.activity_calendar?.days.map(row => [row.date, row]) ?? []);
  const noChangeCount = data.activity_calendar?.days.filter(row => row.can_collapse).length ?? 0;
  const unknownCount = data.activity_calendar?.days.filter(row => row.status === 'unknown').length ?? data.trend.length;
  const paretoRows = data.type_pareto.slice(0, 10).map(row => ({ ...row, name: qualityLabel(row.label, lang) }));
  const basis = data.type_pareto_summary;
  const unit = metric === 'reports' ? tx('건', '条') : tx('개', '个');
  const averageName = collapseInactiveDays ? tx('최근 7표시일 평균', '最近7个显示日均值') : tx('7일 이동평균', '7日移动平均');
  const dailyName = metric === 'reports' ? tx('일별 신고', '每日报告') : tx('일별 기록 불량수', '每日记录不良数');
  return <div className="qa-chart-sections">
    <section className="qa-panel">
      <div className="qa-section-heading">
        <div><h2>{tx('기간 추세', '期间趋势')}</h2><p>{tx('일별 흐름과 선택 기간 내 평균', '每日变化及所选期间内的均值')} · {tx('단위', '单位')} {unit}</p></div>
        <div className="qa-segments" aria-label={tx('추세 지표', '趋势指标')}>
          <button type="button" aria-pressed={metric === 'reports'} onClick={() => setMetric('reports')}>{tx('건수', '条数')}</button>
          <button type="button" aria-pressed={metric === 'quantity'} onClick={() => setMetric('quantity')}>{tx('수량', '数量')}</button>
        </div>
      </div>
      <div className="qa-trend-controls">
        <label><input type="checkbox" checked={collapseInactiveDays} disabled={data.activity_calendar?.status === 'not_applicable'} onChange={event => onCollapseChange(event.target.checked)} />{tx('형합 미증가·미신고일 건너뛰기', '跳过模次未增加且无报告的日期')}</label>
        <span>{tx('접은 날짜', '折叠日期')} {omittedCount}{tx('일', '天')} · {tx('표시', '显示')} {trend.length}{tx('일', '天')}</span>
      </div>
      {data.activity_calendar?.status === 'ready' ? <p className="qa-caption qa-trend-source">{tx('사출 형합 저장 로그 기준', '以注塑模次存储日志为依据')} · {data.activity_calendar.expected_machine_count}{tx('대', '台')} · {tx('미증가·미신고', '模次未增加且无报告')} {noChangeCount}{tx('일', '天')} · {tx('판정 근거 부족', '判定依据不足')} {unknownCount}{tx('일은 유지', '天予以保留')}. {tx('시간 단위로 압축된 과거 로그와 수집 공백은 휴무로 판단하지 않습니다.', '按小时压缩的历史日志及采集空白不判定为休息日。')}</p> : <p className="qa-caption qa-trend-source">{data.activity_calendar?.status === 'not_applicable'
        ? tx('이 검사 부문 또는 미지정 설비에는 사출 형합 기준을 적용하지 않아 전체 날짜를 표시합니다.', '该检验部门或未关联设备不适用注塑模次依据，因此显示全部日期。')
        : tx('형합 로그의 날짜별 근거를 확인할 수 없어 전체 날짜를 유지합니다.', '无法确认模次日志的每日依据，因此保留全部日期。')}</p>}
      {!data.filters.section && data.activity_calendar?.status === 'ready' && <p className="qa-caption">{tx('전체 검사 부문에서도 날짜 접기는 사출 형합 로그만 참고합니다. 다른 공정의 가동 여부나 회사 휴무일을 뜻하지 않습니다.', '全部检验部门的日期折叠也仅参考注塑模次日志，不代表其他工序的运行状态或公司休息日。')}</p>}
      {data.warnings.includes('activity_calendar_invalid') && <p className="qa-notice qa-notice--warning">{tx('형합 로그의 판정 자료를 검증하지 못해 날짜 접기를 해제했습니다. 품질 집계는 그대로 표시합니다.', '模次判定数据未通过校验，已停止折叠日期，品质汇总仍正常显示。')}</p>}
      {trend.length > 0 ? <div className="qa-chart" role="img" aria-label={tx(`일별 값과 ${averageName} 선 그래프. 수량 미기재는 공백입니다.`, `每日值与${averageName}折线图，数量未填写时保留空白。`)}>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart key={data.filters.start_date + data.filters.end_date + metric + String(collapseInactiveDays)} data={trend} margin={{ top: 12, right: 20, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7edf4" />
            <XAxis dataKey="date" minTickGap={38} interval="preserveStartEnd" tickFormatter={(value: string) => value.slice(5)} tickLine={false} axisLine={false} />
            <YAxis width={56} domain={[0, 'auto']} allowDecimals={false} tickLine={false} axisLine={false} />
            <Tooltip labelFormatter={label => String(label)} formatter={(value: number, name: string) => [quantity(value, lang, name === averageName ? 1 : 0) + ' ' + unit, name]} />
            <Legend iconSize={12} wrapperStyle={{ fontSize: 12, paddingTop: 10 }} />
            <Line type="linear" dataKey="value" name={dailyName} stroke="#3978dc" strokeWidth={2} dot={trend.length <= 60 ? { r: 2.5 } : false} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
            <Line type="linear" dataKey="moving_average" name={averageName} stroke="#b76a20" strokeWidth={2.5} strokeDasharray="7 4" dot={trend.length <= 60 ? { r: 2 } : false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
            {trend.length > 45 && <Brush dataKey="date" height={24} travellerWidth={10} stroke="#a7bad2" fill="#f7f9fc" tickFormatter={(value: string) => value.slice(5)} />}
          </LineChart>
        </ResponsiveContainer>
      </div> : <p className="qa-empty">{tx('표시할 날짜가 없습니다. 위 옵션을 해제하면 전체 날짜를 볼 수 있습니다.', '没有可显示的日期。取消上方选项可查看全部日期。')}</p>}
      <p className="qa-caption">{tx('전체 신고 원장 기준입니다. 신고가 없는 날짜는 신고 0건이며, 수량 미기재는 불량 0이 아닙니다. 평균은 표시한 최근 7일의 값이 모두 있을 때만 계산합니다. 신고가 있거나 불량 0을 명시한 날은 형합수와 관계없이 유지합니다.', '以全部报告记录为基准。无报告日期为报告0条，数量未填写不代表不良为0。仅最近7个显示日数值完整时计算均值。有报告或明确填写不良0的日期均保留，不受模次影响。')}{trend.length > 45 ? ' ' + tx('하단 날짜 구간을 좁혀 확대할 수 있습니다.', '可缩小下方日期范围进行放大。') : ''}</p>
      <details className="qa-detail"><summary>{tx('일별 수치 보기', '查看每日数值')}</summary><div className="qa-table-wrap qa-scroll"><table className="qa-table">
        <thead><tr><th>{tx('보고일', '报告日期')}</th><th>{tx('신고 건수', '报告条数')}</th><th>{tx('기록 불량수', '记录不良数')}</th><th>{tx('수량 기재 건수', '已填数量条数')}</th><th>{averageName} · {unit}</th><th>{tx('형합 로그·표시', '模次日志·显示')}</th></tr></thead>
        <tbody>{data.trend.map(row => <tr key={row.date}><th>{row.date}</th><td>{quantity(row.report_count, lang)}</td><td>{quantity(row.reported_defect_qty, lang)}</td><td>{row.defect_quantity_record_count}</td><td>{quantity(trendByDate.get(row.date)?.moving_average, lang, 1)}</td><td>{!visibleDates.has(row.date) ? tx('미증가 · 접음', '未增加 · 已折叠') : calendarDays.get(row.date)?.status === 'no_change' ? tx('미증가 · 표시', '未增加 · 显示') : calendarDays.get(row.date)?.status === 'activity' ? tx('변화 관측 · 표시', '观测到变化 · 显示') : tx('판정 보류 · 표시', '暂不判定 · 显示')}</td></tr>)}</tbody>
      </table></div></details>
    </section>
    <section className="qa-panel">
      <div className="qa-section-heading"><div><h2>{tx('불량 유형 Pareto', '不良类型 Pareto')}</h2>
        <p>{tx('개별 유형별 신고 건수 순', '按各独立类型的报告条数排序')} · {tx('표시 상위', '显示前')} {paretoRows.length}{tx('개', '类')} · {tx('누적 비중 분모: 유형 집계', '累计占比分母：类型计数')} {quantity(basis.type_occurrence_count, lang)}{tx('건', '条')}</p>
      </div></div>
      <div className="qa-pareto-basis">
        <span>{tx('분류된 신고', '已分类报告')} <strong>{quantity(basis.classified_report_count, lang)}</strong>{tx('건', '条')}</span>
        <span>{tx('복합 신고', '多类型报告')} <strong>{quantity(basis.multi_type_report_count, lang)}</strong>{tx('건 · 각 유형에 포함', '条 · 分别计入各类型')}</span>
        <span>{tx('Pareto 제외', 'Pareto 排除')} <strong>{quantity(basis.excluded_report_count, lang)}</strong>{tx('건 · 미분류/현상 미기재', '条 · 未分类/现象未填写')}</span>
      </div>
      {paretoRows.length ? <div className="qa-chart" role="img" aria-label={tx('복합 신고를 개별 유형으로 나눈 신고 건수와 유형 집계 대비 누적 비중. 미분류 제외.', '将多类型报告拆分为独立类型后的报告条数及类型计数累计占比，排除未分类。')}>
        <ResponsiveContainer width="100%" height={280}><ComposedChart data={paretoRows} margin={{ top: 12, right: 4, left: 0, bottom: 16 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7edf4" />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-18} textAnchor="end" height={55} tickLine={false} axisLine={false} />
          <YAxis yAxisId="count" allowDecimals={false} width={44} tickLine={false} axisLine={false} />
          <YAxis yAxisId="share" orientation="right" domain={[0, 100]} width={40} tickFormatter={value => value + '%'} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip formatter={(value: number, name: string) => quantity(value, lang, name === tx('누적 비중', '累计占比') ? 1 : 0) + (name === tx('누적 비중', '累计占比') ? '%' : tx('건', '条'))} />
          <Bar yAxisId="count" dataKey="report_count" name={tx('유형별 신고', '各类型报告')} fill="#6382b8" maxBarSize={48} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Line yAxisId="share" dataKey="cumulative_type_share_percent" name={tx('누적 비중', '累计占比')} stroke="#cc7a2b" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
          <Legend iconSize={12} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        </ComposedChart></ResponsiveContainer>
      </div> : <p className="qa-empty">{data.summary.report_count ? tx('분류 가능한 유형이 없어 Pareto를 표시하지 않습니다. 제외된 신고는 원문을 보완한 뒤 다시 집계할 수 있습니다.', '没有可分类的类型，因此不显示 Pareto。补充被排除报告的原文后可重新汇总。') : tx('분류할 신고가 없습니다.', '没有可分类的报告。')}</p>}
      <p className="qa-caption">{tx('한 신고에 흑점·스크래치가 함께 있으면 각 유형에 1건씩 집계합니다. 같은 유형의 반복 표현은 한 번만 셉니다. 비중은 분류된 유형 집계 건수 기준이며, 불량 개체 수나 전체 신고 비중이 아닙니다. 유형별 불량 수량은 배분 근거가 없어 복제하지 않습니다.', '同一报告含黑点及擦伤时，每种类型各计1条；同一类型的重复表述只计1次。占比以已分类类型计数为分母，不代表不良个数或全部报告占比。因无数量分配依据，不复制各类型不良数量。')}</p>
      <details className="qa-detail"><summary>{tx('전체 유형과 원본 보기', '查看全部类型及原始报告')}</summary><div className="qa-table-wrap qa-scroll"><table className="qa-table">
        <thead><tr><th>{tx('유형', '类型')}</th><th>{tx('유형별 신고', '各类型报告')}</th><th>{tx('비중', '占比')}</th><th>{tx('누적', '累计')}</th><th>{tx('원본', '原始报告')}</th></tr></thead>
        <tbody>{data.type_pareto.map(row => <tr key={row.key}><th>{qualityLabel(row.label, lang)}</th><td>{quantity(row.report_count, lang)}</td><td>{quantity(row.share_of_type_occurrences_percent, lang, 1)}%</td><td>{quantity(row.cumulative_type_share_percent, lang, 1)}%</td><td><button type="button" className="qa-link" onClick={() => onSources(row)} disabled={!row.sample_report_ids.length}>{tx('보기', '查看')}</button></td></tr>)}</tbody>
      </table></div></details>
      {basis.excluded_report_count > 0 && <details className="qa-detail"><summary>{tx('통계에서 제외한 신고 확인', '查看统计中排除的报告')}</summary><div className="qa-table-wrap"><table className="qa-table">
        <thead><tr><th>{tx('제외 사유', '排除原因')}</th><th>{tx('신고', '报告')}</th><th>{tx('원본', '原始报告')}</th></tr></thead>
        <tbody>{data.type_pareto_exclusions.map(row => <tr key={row.key}><th>{qualityLabel(row.label, lang)}</th><td>{quantity(row.report_count, lang)}</td><td><button type="button" className="qa-link" onClick={() => onSources(row)} disabled={!row.sample_report_ids.length}>{tx('원문 확인', '核对原文')}</button></td></tr>)}</tbody>
      </table></div></details>}
    </section>
  </div>;
}
function ReviewFocus({ data, lang, tx, onSources }: Copy & { data: QualityAnalysis; onSources: OpenSources }) {
  const repeatedPart = data.concentrations.parts.items.find(row => row.key !== 'unknown' && row.report_count > 1);
  const ambiguous = data.type_pareto_exclusions;
  const unknownMachine = data.concentrations.machines.items.find(row => row.key === 'unknown');
  const candidates = [
    ...ambiguous.map(row => ({ row, title: tx('불량 유형 원문 확인', '核对不良类型原文'), reason: tx('유형 통계에서 제외된 신고입니다. 현상 원문을 보완하면 다시 분류할 수 있습니다.', '这是类型统计中被排除的报告，补充现象原文后可重新分类。') })),
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
  const [collapseInactiveDays, setCollapseInactiveDays] = useState(true);
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
    const url = URL.createObjectURL(new Blob([createQualityAnalysisCsv(data, lang, { collapseInactiveDays })], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = `quality_analysis_${scope.startDate}_${scope.endDate}_${scope.section || 'all'}_${scope.machineNumber || 'all'}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  const coverage = data ? quantityCoverage(data.summary) : null;
  const selectedSection = scope.section ? SECTION_LABELS[scope.section]?.[lang] ?? scope.section : tx('전체 검사 부문', '全部检验部门');
  const selectedMachine = scope.machineNumber === 'unknown' ? tx('설비 미지정', '设备未关联') : scope.machineNumber ? `IMM${scope.machineNumber.padStart(2, '0')}` : tx('전체 설비', '全部设备');
  return <main className="quality-analysis">
    <header className="qa-header"><div className="qa-title"><span><BarChart3 size={21} /></span><div><h1>{tx('불량 분석 보고서', '不良分析报告')}</h1><p>{tx('저장된 품질 신고의 추세·집중도와 입력 완전성', '已保存品质报告的趋势、集中度及填写完整性')}</p></div></div><div className="qa-header-actions"><PermissionLink className="qa-button qa-button--quiet" to="/quality#history"><FileText size={15} />{tx('전체 보고 이력', '全部报告履历')}</PermissionLink><button type="button" className="qa-button qa-button--quiet" disabled={query.isFetching || urlError} onClick={() => void query.refetch()}><RefreshCw size={15} />{tx('새로고침', '刷新')}</button><button type="button" className="qa-button" disabled={!data} onClick={exportCsv}><Download size={15} />{tx('분석 CSV', '分析 CSV')}</button></div></header>
    <form className="qa-filters" onSubmit={applyFilters}><label>{tx('시작일', '开始日期')}<input type="date" value={draft.startDate} max={today} required onChange={event => setDraft(prev => ({ ...prev, startDate: event.target.value }))} /></label><label>{tx('종료일', '结束日期')}<input type="date" value={draft.endDate} max={today} required onChange={event => setDraft(prev => ({ ...prev, endDate: event.target.value }))} /></label><label>{tx('검사 부문 / 공정', '检验部门 / 工序')}<select value={draft.section} onChange={event => setDraft(prev => ({ ...prev, section: event.target.value }))}><option value="">{tx('전체', '全部')}</option>{QUALITY_SECTIONS.map(section => <option key={section} value={section}>{SECTION_LABELS[section][lang]}</option>)}</select></label><label>{tx('기록된 설비', '已记录设备')}<select value={draft.machineNumber} onChange={event => setDraft(prev => ({ ...prev, machineNumber: event.target.value }))}><option value="">{tx('전체', '全部')}</option>{Array.from({ length: 17 }, (_, index) => String(index + 1)).map(number => <option key={number} value={number}>IMM{number.padStart(2, '0')}</option>)}<option value="unknown">{tx('설비 미지정', '设备未关联')}</option></select></label><button type="submit" className="qa-button">{tx('조회 적용', '应用查询')}</button><button type="button" className="qa-button qa-button--quiet" onClick={() => { const next = defaultQualityScope(today); setDraft(next); setSearchParams(qualityScopeParams(next)); setSource(null); }}>{tx('최근 30일', '最近30天')}</button><p>{tx('보고일 기준 · 중국 달력일 00:00~24:00 · 최대 366일', '按报告日期 · 中国日历日00:00~24:00 · 最多366天')}{scopeChanged ? ` · ${tx('필터 변경 후 조회 적용', '修改筛选后请应用查询')}` : ''}</p></form>
    {(filterError || urlError) && <div role="alert" className="qa-notice qa-notice--warning">{tx('날짜 순서와 조회 조건을 확인하세요. 미래 날짜를 제외한 최대 366일을 선택할 수 있습니다.', '请检查日期顺序及查询条件，可选择不含未来日期的最多366天。')}</div>}
    {!urlError && query.isPending && <div className="qa-loading" role="status"><Activity size={22} /><p>{tx('선택 범위의 품질 보고서를 집계하고 있습니다…', '正在汇总所选范围的品质报告…')}</p></div>}
    {!urlError && query.isError && <div role="alert" className="qa-notice qa-notice--warning"><AlertTriangle size={20} /><div><strong>{tx('분석 자료를 확인할 수 없습니다.', '无法确认分析数据。')}</strong><p>{tx('조회 실패를 신고 0건으로 표시하지 않습니다. 기간·공정을 좁혀 재시도하거나 접근 권한과 원천 연결을 확인하세요.', '查询失败不显示为报告0条。请缩小日期或工序范围后重试，或检查访问权限及数据源连接。')}</p></div></div>}
    {data && <>
      <div className="qa-applied-scope"><strong>{scope.startDate} → {scope.endDate}</strong><span>{selectedSection} · {selectedMachine}</span><span>{tx('원천 최근 수정', '数据源最近修改')} {moment(data.freshness.latest_updated_at, lang)} · UTC+8</span></div>
      <section className="qa-metrics" aria-label={tx('선택 범위 요약', '所选范围汇总')}><article><span>{tx('저장된 신고', '已保存报告')}</span><strong>{quantity(data.summary.report_count, lang)}<small>{tx('건', '条')}</small></strong><p>{tx('서로 다른 보고서 ID 기준', '按不同报告ID计数')}</p></article><article><span>{tx('기록된 불량 수량', '记录的不良数量')}</span><strong>{quantity(data.summary.reported_defect_qty, lang)}<small>{tx('개', '个')}</small></strong><p>{tx(`${data.summary.defect_quantity_record_count}건의 수량 합계 · 미기재 제외`, `${data.summary.defect_quantity_record_count} 条报告的数量合计，排除未填写值`)}</p></article><article><span>{tx('불량 수량 기재율', '不良数量填写率')}</span><strong>{quantity(coverage, lang, 1)}<small>%</small></strong><p>{data.summary.defect_quantity_record_count}/{data.summary.report_count}{tx('건 · 검사 합격률 아님', '条 · 非检验合格率')}</p></article><article><span>{tx('불량 0을 명시한 보고서', '明确填写不良0的报告')}</span><strong>{quantity(data.summary.zero_defect_report_count, lang)}<small>{tx('건', '条')}</small></strong><p>{tx('수량 공백과 구분하여 집계', '与数量空白分开统计')}</p></article></section>
      {data.status === 'no_records' ? <div className="qa-notice">{tx('선택 범위에 저장된 품질 보고서가 없습니다. 생산·불량 발생이 0이거나 검사가 완료되었다는 뜻은 아닙니다.', '所选范围没有已保存的品质报告，不代表生产或不良发生为0，也不代表检验已完成。')}</div> : data.summary.defect_quantity_record_count < data.summary.report_count ? <div className="qa-notice qa-notice--warning">{tx(`전체 ${data.summary.report_count}건 중 수량이 확인되는 ${data.summary.defect_quantity_record_count}건만 불량 수량 합계에 포함됩니다.`, `全部 ${data.summary.report_count} 条中，仅 ${data.summary.defect_quantity_record_count} 条数量已填写的报告纳入不良数量合计。`)}</div> : null}
      <Charts data={data} lang={lang} tx={tx} onSources={onSources} collapseInactiveDays={collapseInactiveDays} onCollapseChange={setCollapseInactiveDays} />
      {data.production_context ? <QualityProductionConcentrations data={data.production_context} lang={lang} tx={tx} onSources={onSources} /> : <><p className="qa-notice">{tx('생산 연결 자료를 확인하지 못해 기존 원장 기준 집중도를 표시합니다.', '无法确认生产关联资料，因此显示原记录口径的集中度。')}</p><div className="qa-two-columns"><Concentration title={tx('설비별 신고 집중도', '设备报告集中度')} subtitle={tx('명시된 발생 위치 기준', '按明确记录的发生位置')} data={data.concentrations.machines} lang={lang} tx={tx} onSources={onSources} /><Concentration title={tx('품번별 신고 집중도', '品号报告集中度')} subtitle={tx('정규화한 품번 기준 · 신고 건수 순', '按规范化品号，依报告条数排序')} data={data.concentrations.parts} lang={lang} tx={tx} onSources={onSources} /></div></>}
      <QualityProductionShiftTrend data={data.production_shifts} lang={lang} tx={tx} />
      <ReviewFocus data={data} lang={lang} tx={tx} onSources={onSources} />
      <DataQuality data={data} lang={lang} tx={tx} />
      <details className="qa-panel qa-detail"><summary>{tx('검사 부문 분포와 계산 근거', '检验部门分布与计算依据')}</summary><div className="qa-evidence"><Concentration title={tx('검사 부문별 신고', '各检验部门报告')} subtitle={tx('비중 분모는 현재 조회 범위의 신고 건수', '占比分母为当前查询范围报告条数')} data={data.concentrations.sections} lang={lang} tx={tx} onSources={onSources} sectionLabels /><div><h3>{tx('보고서 해석 기준', '报告解释口径')}</h3><ul><li>{tx('품질 보고서만 집계하며, 현장 불량 체크포인트·MES 수량·사출 수기일보와 자동 합산하지 않습니다.', '仅汇总品质报告，不自动合并现场不良检查点、MES 数量或注塑手工日报。')}</li><li>{tx('불량 수량은 기록된 유효 정수의 합계입니다. 생산·검사 전체 모집단이 아니므로 공장 불량률을 계산하지 않습니다.', '不良数量是已记录有效整数的合计，不是全部生产或检验总体，因此不计算工厂不良率。')}</li><li>{tx('중복 후보도 자동 제외하지 않습니다. 실제 중복인지 별개 사건인지 원본 확인이 필요합니다.', '疑似重复报告也不自动剔除，需核对原始报告是否为重复或独立事件。')}</li><li>{tx('설비·품번·부문 표는 상위 20그룹까지 제공하며 표 밖 신고 건수를 따로 표시합니다.', '设备、品号、部门表最多提供前20组，表外报告条数单独显示。')}</li></ul><p className="qa-caption">{tx('집계 생성', '汇总生成')}: {moment(data.freshness.generated_at, lang)} · UTC+8<br />{tx('기간 내 최신 보고', '期间内最近报告')}: {moment(data.freshness.latest_report_at, lang)} · UTC+8<br />{tx('자료는 보고서 저장·수정 시 변경됩니다.', '数据随报告保存或修改而变化。')}</p></div></div></details>
    </>}
    {source && <ReportSources key={source.ids.join(',')} ids={source.ids} title={source.title} onClose={() => setSource(null)} lang={lang} tx={tx} />}
  </main>;
}
