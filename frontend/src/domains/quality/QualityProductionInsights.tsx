import { useState } from 'react';
import { Eye } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { QualityLanguage, QualityProductionConcentration, QualityProductionContext, QualityProductionGroup, QualityProductionShifts, QualityTypeEvidence } from './model';

type Copy = { lang: QualityLanguage; tx: (ko: string, zh: string) => string };
type Sources = (group: QualityTypeEvidence) => void;
function number(value: number | null | undefined, lang: QualityLanguage, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(lang === 'zh' ? 'zh-CN' : 'ko-KR', { maximumFractionDigits: digits }) : '—';
}
function basisLabels(tx: Copy['tx']) {
  return {
    production_record: tx('실적 기록 연결', '关联实绩记录'), stored_plan: tx('저장 계획 연결', '关联已存计划'),
    recorded_only: tx('원본 설비만 확인', '仅确认原记录设备'), ambiguous: tx('연결 확인 필요', '需核对关联'),
    unmatched: tx('생산 미연결', '未关联生产'), not_injection: tx('사출 연결 대상 외', '非注塑关联范围'),
  };
}
function ProductionConcentration({ data, machines, lang, tx, onSources }: Copy & { data: QualityProductionConcentration; machines: boolean; onSources: Sources }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? data.items : data.items.slice(0, 6);
  const hiddenCount = data.other_report_count + data.items.slice(rows.length).reduce((sum, row) => sum + row.report_count, 0);
  const labels = basisLabels(tx);
  const modelName = (row: QualityProductionGroup) => row.model_display || tx('모델 미기재', '型号未填写');
  return <section className="qa-panel">
    <div className="qa-section-heading"><div><h2>{machines ? tx('설비·모델별 신고 집중도', '设备及型号报告集中度') : tx('모델·품목별 신고 집중도', '型号及品项报告集中度')}</h2><p>{machines ? tx('신고 모델과 해당 일자 실적·저장 계획의 연결 근거', '报告型号与相应日期实绩、已存计划的关联依据') : tx('모델을 먼저 표시 · 정확한 품번과 모델 표기별 집계', '优先显示型号 · 按完整品号及型号名称汇总')}</p></div><span className="qa-badge">{data.total_group_count}{tx('개 그룹', '个分组')}</span></div>
    {rows.length ? <div className="qa-table-wrap"><table className="qa-table qa-production-table"><thead><tr><th>{machines ? tx('설비 / 모델', '设备 / 型号') : tx('모델 / 품목', '型号 / 品项')}</th><th>{tx('신고 건수', '报告条数')}</th><th>{tx('연결 근거', '关联依据')}</th><th>{tx('원본', '原始报告')}</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}>
      <th scope="row">{machines && <span className="qa-machine-label">{row.machine_number ? `IMM${String(row.machine_number).padStart(2, '0')}` : tx('설비 미확정', '设备未确定')}</span>}<strong>{modelName(row)}</strong><small>Part No. {row.part_no || tx('미기재', '未填写')}</small></th>
      <td><strong>{number(row.report_count, lang)}{tx('건', '条')}</strong><small>{number(row.share_of_reports_percent, lang, 1)}%</small><small>{tx('기록 불량', '记录不良')} {number(row.reported_defect_qty, lang)} · {row.defect_quantity_record_count}/{row.report_count}{tx('건 기재', '条已填')}</small></td>
      <td><div className="qa-link-basis">{Object.entries(labels).filter(([key]) => row.match_basis_counts[key as keyof typeof labels] > 0).map(([key, label]) => <span key={key} className={key === 'ambiguous' ? 'qa-link-basis--review' : ''}>{label} {number(row.match_basis_counts[key as keyof typeof labels], lang)}</span>)}</div></td>
      <td><button type="button" className="qa-link" disabled={!row.sample_report_ids.length} onClick={() => onSources({ ...row, label: modelName(row) })}><Eye size={14} />{tx('보기', '查看')}</button></td>
    </tr>)}</tbody></table></div> : <p className="qa-empty">{tx('이 범위에 저장된 신고가 없습니다.', '此范围内没有已保存报告。')}</p>}
    <div className="qa-panel-footer"><span>{hiddenCount > 0 ? tx(`현재 표 밖 ${number(hiddenCount, lang)}건 · 비중은 전체 선택 신고 기준`, `当前表外 ${number(hiddenCount, lang)} 条 · 占比以全部所选报告为准`) : tx('선택 범위 전체 그룹', '所选范围全部分组')}</span>{data.items.length > 6 && <button className="qa-link" type="button" onClick={() => setExpanded(!expanded)}>{expanded ? tx('간략히', '收起') : tx(`상위 ${data.items.length}개 보기`, `查看前${data.items.length}组`)}</button>}</div>
  </section>;
}
export function QualityProductionConcentrations({ data, lang, tx, onSources }: Copy & { data: QualityProductionContext; onSources: Sources }) {
  const summary = data.summary;
  return <section className="qa-production-context">
    {data.status === 'unavailable' && <p className="qa-notice qa-notice--warning">{tx('생산 원천 조회를 완료하지 못해 추가 연결을 보류했습니다. 신고 원문의 모델·품번·설비 정보는 유지합니다.', '生产源数据查询未完成，暂不追加关联。报告原文中的型号、品号及设备信息予以保留。')}</p>}
    <div className="qa-notice qa-production-summary"><strong>{tx('생산 연결 범위', '生产关联范围')}</strong><span>{tx('실적 기록', '实绩记录')} {number(summary.production_record_match_count, lang)}{tx('건', '条')} · {tx('저장 계획', '已存计划')} {number(summary.plan_match_count, lang)}{tx('건', '条')} · {tx('연결 확인 필요', '需核对关联')} {number(summary.ambiguous_count, lang)}{tx('건', '条')} · {tx('생산 미연결', '未关联生产')} {number(summary.unmatched_count, lang)}{tx('건', '条')} · {tx('모델 미기재', '型号未填写')} {number(summary.missing_model_count, lang)}{tx('건', '条')}</span><p>{tx('같은 날짜·전체 품번·모델의 후보가 유일할 때만 연결합니다. 저장 계획은 해당 일자의 현재 저장 자료이며 실제 생산이나 불량 발생 설비를 확정하지 않습니다. 원본 설비와 충돌하면 확인 대상으로 남깁니다.', '仅在相同日期、完整品号及型号的候选唯一时关联。已存计划是相应日期当前保存的资料，不代表已确认实际生产或不良发生设备。与原记录设备冲突时保留待核对。')}</p></div>
    <div className="qa-two-columns"><ProductionConcentration data={data.machine_models} machines lang={lang} tx={tx} onSources={onSources} /><ProductionConcentration data={data.model_parts} machines={false} lang={lang} tx={tx} onSources={onSources} /></div>
  </section>;
}

export function QualityProductionShiftTrend({ data, lang, tx }: Copy & { data?: QualityProductionShifts }) {
  const [metric, setMetric] = useState<'shifts' | 'reports' | 'rate'>('shifts');
  if (!data || data.status === 'not_applicable') return <section className="qa-panel"><h2>{tx('생산시프트당 품질 신고', '每生产班次的品质报告')}</h2><p className="qa-caption">{data?.status === 'not_applicable' ? tx('사출 공정검사와 지정 설비 범위에서 확인할 수 있습니다. 전체 부문을 선택하면 사출 공정검사 신고만 사용합니다.', '适用于注塑过程检验及指定设备范围。选择全部部门时仅采用注塑过程检验报告。') : tx('생산시프트의 근거 자료를 확인할 수 없습니다. 품질 원장 분석은 위에 유지합니다.', '无法确认生产班次依据，上方品质记录分析予以保留。')}</p></section>;
  const summary = data.summary;
  const monitoringReady = data.source_status.monitoring === 'ready';
  const names = { shifts: tx('가동 확인 시프트', '已确认运行班次'), reports: tx('사출 품질 신고', '注塑品质报告'), rate: tx('시프트당 신고', '每班次报告') };
  const unit = metric === 'rate' ? tx('건/시프트', '条/班次') : metric === 'reports' ? tx('건', '条') : tx('시프트', '班次');
  const points = data.days.map(day => ({ ...day,
    value: metric === 'rate' ? day.reports_per_shift : metric === 'reports' ? day.report_count : monitoringReady ? day.active_shift_count : null,
    unconfirmed: metric === 'shifts' ? day.unknown_shift_count + day.open_shift_count : null,
  }));
  const hasValues = points.some(day => day.value !== null);
  const unknown = summary.unknown_shift_count + summary.open_shift_count;
  return <section className="qa-panel qa-shift-panel">
    <div className="qa-section-heading"><div><h2>{tx('생산시프트당 품질 신고', '每生产班次的品质报告')}</h2><p>{tx('사출 공정검사 신고 ÷ 형합 증가를 확인한 설비 시프트', '注塑过程检验报告 ÷ 已确认模次增加的设备班次')}</p></div><span className="qa-badge">{tx('주간 08–20시 · 야간 20–익일 08시', '白班08–20时 · 夜班20–次日08时')}</span></div>
    <div className="qa-shift-metrics">
      <article><span>{tx('사출 품질 신고', '注塑品质报告')}</span><strong>{number(summary.report_count, lang)}<small>{tx('건', '条')}</small></strong><p>{tx('생산 업무일 기준 신고', '按生产业务日归属报告')}</p></article>
      <article><span>{tx('가동 확인 생산시프트', '已确认运行的生产班次')}</span><strong>{number(monitoringReady ? summary.active_shift_count : null, lang)}<small>{tx('회', '次')}</small></strong><p>{tx('설비 1대 × 주간 또는 야간 = 1회', '一台设备 × 白班或夜班 = 一次')}</p></article>
      <article><span>{tx('시프트당 신고 빈도', '每班次报告频度')}</span><strong>{number(summary.reports_per_shift, lang, 4)}<small>{tx('건/회', '条/次')}</small></strong><p>{summary.reports_per_shift !== null ? `${number(summary.report_count, lang)} ÷ ${number(summary.active_shift_count, lang)}` : tx('분모 0·미확인·진행 중이면 보류', '分母为0、未确认或进行中时不计算')}</p></article>
      <article><span>{tx('판정 보류·진행 중', '暂不判定及进行中')}</span><strong>{number(unknown, lang)}<small>{tx('시프트', '班次')}</small></strong><p>{tx('판정 보류', '暂不判定')} {number(summary.unknown_shift_count, lang)} · {tx('미완료', '未完成')} {number(summary.open_shift_count, lang)}</p></article>
    </div>
    <p className="qa-caption">{tx('1회라도 형합 증가가 관측된 설비·시프트를 한 번 셉니다. 12시간 풀가동 환산값이 아니며, 한 시프트에서 모델이 바뀌어도 중복 집계하지 않습니다. 신고 빈도는 불량 개수의 비율이나 검사 합격률이 아닙니다.', '设备班次内只要观测到模次增加，即计一次。这不是折算的12小时满负荷运行量，同班次换型也不重复计数。报告频度不是不良数量比例或检验合格率。')}</p>
    {unknown > 0 || data.status === 'unavailable' ? <div className="qa-notice qa-notice--warning">{tx('미확인 시프트가 포함된 날짜와 전체 기간의 비율은 계산을 보류합니다. 확인된 신고 건수와 가동 시프트 수는 각각 표시합니다.', '存在未确认班次的日期及整个期间暂不计算比率。已确认的报告条数与运行班次数分别显示。')}</div> : null}
    <div className="qa-section-heading qa-shift-chart-heading"><p>{tx('일별 생산 업무일 추세', '每日生产业务日趋势')} · {unit}</p><div className="qa-segments" aria-label={tx('시프트 추세 지표', '班次趋势指标')}>{(['shifts', 'reports', 'rate'] as const).map(value => <button key={value} type="button" aria-pressed={metric === value} onClick={() => setMetric(value)}>{names[value]}</button>)}</div></div>
    {hasValues ? <div className="qa-chart" role="img" aria-label={tx(`${names[metric]} 일별 선 그래프`, `${names[metric]}每日折线图`)}><ResponsiveContainer width="100%" height={280}><LineChart data={points} margin={{ top: 10, right: 15, bottom: 4, left: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7edf4" /><XAxis dataKey="date" tickFormatter={(value: string) => value.slice(5)} minTickGap={38} interval="preserveStartEnd" tickLine={false} axisLine={false} /><YAxis width={48} allowDecimals={metric === 'rate'} domain={[0, 'auto']} tickLine={false} axisLine={false} /><Tooltip labelFormatter={value => String(value)} formatter={(value: number, name: string) => [number(value, lang, metric === 'rate' ? 4 : 0) + ' ' + unit, name]} /><Legend wrapperStyle={{ fontSize: 12 }} /><Line type="linear" dataKey="value" name={names[metric]} stroke="#2979a2" strokeWidth={2} dot={points.length <= 60 ? { r: 2.5 } : false} connectNulls={false} isAnimationActive={false} />{metric === 'shifts' && <Line type="linear" dataKey="unconfirmed" name={tx('판정 보류·미완료', '暂不判定及未完成')} stroke="#a58250" strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />}</LineChart></ResponsiveContainer></div> : <p className="qa-empty">{metric === 'rate' ? tx('분모와 관측 범위가 확인된 날짜부터 비율을 표시합니다. 다른 지표에서 신고·가동 확인 수를 볼 수 있습니다.', '从分母及观测范围已确认的日期起显示比率，可切换指标查看报告及已确认运行次数。') : tx('선택 지표의 원천 자료를 확인할 수 없습니다.', '无法确认所选指标的源数据。')}</p>}
    <p className="qa-caption">{tx('위 품질 추세는 달력일(00–24시), 이 지표는 생산 업무일(08–다음날 08시)입니다. 엑셀 신고의 임의 08시를 실제 발생 시각으로 해석하지 않으며 신고를 주간·야간으로 나누지 않습니다. 전체 검사 부문에서도 분자는 사출 공정검사만 포함합니다.', '上方品质趋势按日历日(00–24时)，本指标按生产业务日(08–次日08时)。不将Excel报告的预设08时解释为实际发生时间，也不把报告分配到白班或夜班。即使选择全部部门，分子也仅包含注塑过程检验报告。')}</p>
    <details className="qa-detail"><summary>{tx('신고·시프트 절대값과 비율 보기', '查看报告、班次绝对值及比率')}</summary><div className="qa-table-wrap qa-scroll"><table className="qa-table"><thead><tr><th>{tx('생산 업무일', '生产业务日')}</th><th>{tx('신고', '报告')}</th><th>{tx('가동 확인', '已确认运行')}</th><th>{tx('형합 미증가', '模次未增加')}</th><th>{tx('판정 보류', '暂不判定')}</th><th>{tx('미완료', '未完成')}</th><th>{tx('신고/시프트', '报告/班次')}</th></tr></thead><tbody>{data.days.map(day => <tr key={day.date}><th scope="row">{day.date}</th><td>{number(day.report_count, lang)}</td><td>{number(monitoringReady ? day.active_shift_count : null, lang)}</td><td>{number(monitoringReady ? day.no_change_shift_count : null, lang)}</td><td>{number(day.unknown_shift_count, lang)}</td><td>{number(day.open_shift_count, lang)}</td><td>{number(day.reports_per_shift, lang, 4)}</td></tr>)}</tbody></table></div></details>
  </section>;
}
