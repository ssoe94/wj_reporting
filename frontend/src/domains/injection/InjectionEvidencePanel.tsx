import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Download, RefreshCw } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { useLang } from '@/i18n';
import PermissionLink from '@/components/common/PermissionLink';
import { getAnalysisOverview, getFieldOperations } from '@/domains/analysis/api';
import { getFieldStationPath } from '@/domains/analysis/model';
import type { FieldOperationsData } from '@/domains/analysis/model';
import { injectionQuantityStatus, rowCanEvaluate, scopedProduction } from './production-evidence';
import { buildInjectionLink, createInjectionCsv } from './workspace';
import type { InjectionScope } from './workspace';

type Props = { scope: InjectionScope; currentDate: string; view: 'overview' | 'field-records' };
type Translate = (ko: string, zh: string) => string;
const panel = 'rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-sm';
const linkStyle = 'inline-flex items-center gap-1 text-sm font-semibold text-blue-700 hover:underline';
const buttonStyle = 'inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-40';

const defectNames: Record<string, [string, string]> = {
  scratch: ['스크래치', '划伤'], black_dot: ['흑점', '黑点'], eaten_meat: ['살먹음', '缺肉'],
  air_mark: ['가스 자국', '气纹'], deform: ['변형', '变形'], short_shot: ['미성형', '缺胶'],
  broken_pillar: ['보스 파손', '断柱'], flow_mark: ['흐름 자국', '流痕'], sink_mark: ['수축', '缩水'],
  whitening: ['백화', '发白'], other: ['기타', '其他'],
};

function number(value: number | null | undefined, lang: string, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'ko-KR', { maximumFractionDigits: digits }).format(value) : '—';
}
function time(value: string | null | undefined, lang: string) {
  return value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'ko-KR', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value)) : '—';
}
function download(rows: Array<Array<string | number | null | undefined>>, filename: string) {
  const url = URL.createObjectURL(new Blob([createInjectionCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const element = document.createElement('a');
  element.href = url;
  element.download = filename;
  element.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RequestNotice({ loading, error, hasData, retry, tx }: {
  loading: boolean; error: boolean; hasData: boolean; retry: () => void; tx: Translate;
}) {
  if (loading) return <p role="status" className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">{tx('선택한 날짜·설비의 자료를 불러오는 중입니다.', '正在加载所选日期和设备的数据。')}</p>;
  if (!error) return null;
  return <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
    <span>{hasData ? tx('갱신 실패 · 아래는 이전 수신 자료입니다. 판단과 내보내기를 보류합니다.', '刷新失败 · 下方保留此前资料，暂不判断或导出。') : tx('조회에 실패했습니다. 생산·불량 0건을 의미하지 않습니다.', '查询失败，不代表产量或不良为零。')}</span>
    <button type="button" onClick={retry} className={buttonStyle}>{tx('다시 확인', '重试')}</button>
  </div>;
}

function FieldRecords({ data, scope, compact, refreshFailed, lang, tx }: {
  data: FieldOperationsData; scope: InjectionScope; compact: boolean; refreshFailed: boolean; lang: string; tx: Translate;
}) {
  const title = tx('현장에 저장한 구간 기록', '现场已保存的区间记录');
  const exportRecords = () => download([
    ['business_date', 'machine_number', 'source', 'unit', 'record_status', 'valid_checkpoint_count', 'zero_defect_checkpoint_count', 'reported_defect_qty', 'estimated_segment_gross_qty', 'latest_reported_at', 'query_status', 'invalid_checkpoint_count_in_scope', 'invalid_document_count_in_scope', 'duplicate_checkpoint_count_in_scope', 'warnings'],
    ...data.machines.map((row) => [scope.date, row.machine_number, 'field-defects.v1', 'ea', row.status, row.checkpoint_count, row.zero_defect_checkpoint_count, row.reported_defect_qty, row.estimated_gross_qty, row.latest_reported_at, data.status, data.coverage.invalid_checkpoint_count, data.coverage.invalid_document_count, data.coverage.duplicate_checkpoint_count, data.warnings.join(';')]),
  ], `injection-field-${scope.date}-${scope.machineNumber ?? 'all'}.csv`);
  const causes = data.defects.map((row) => ({ ...row, name: defectNames[row.code]?.[lang === 'zh' ? 1 : 0] ?? row.code }));
  const recordState = (status: string) => status === 'reported' ? tx('기록 있음', '有记录') : status === 'invalid' ? tx('유효 기록 없음 · 검증 필요', '无有效记录 · 需核对') : tx('미기록', '未记录');
  return <section className={panel} aria-label={title}>
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-bold text-slate-900">{title}</h2><p className="mt-1 text-sm text-slate-500">{tx('현장 신고 원천 · MES 실적이나 수기일보와 별도로 읽습니다.', '现场申报来源 · 与 MES 实绩、手工日报分开解读。')}</p></div>
      {compact ? <Link className={linkStyle} to={buildInjectionLink('/injection/dashboard', scope, 'field-records')}>{tx('현장 기록 상세', '现场记录详情')}<ArrowUpRight size={15} /></Link>
        : <button type="button" className={buttonStyle} disabled={refreshFailed} onClick={exportRecords}><Download size={15} />{tx('현장 신고 CSV', '现场申报 CSV')}</button>}
    </div>
    <dl className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl bg-slate-50 p-4"><dt className="text-sm text-slate-500">{tx('신고 불량', '申报不良')}</dt><dd className="mt-1 text-2xl font-bold text-slate-950">{number(data.summary.reported_defect_qty, lang)} <span className="text-sm font-normal">ea</span></dd></div>
      <div className="rounded-xl bg-slate-50 p-4"><dt className="text-sm text-slate-500">{tx('저장한 구간', '已保存区间')}</dt><dd className="mt-1 text-2xl font-bold text-slate-950">{number(data.summary.checkpoint_count, lang)}</dd><p className="mt-1 text-xs text-slate-500">{tx('그중 불량 0 신고', '其中零不良申报')}: {number(data.summary.zero_defect_checkpoint_count, lang)}</p></div>
      <div className="rounded-xl bg-slate-50 p-4"><dt className="text-sm text-slate-500">{tx('기록이 있는 설비 / 선택 범위', '有记录设备 / 所选范围')}</dt><dd className="mt-1 text-2xl font-bold text-slate-950">{data.summary.recorded_machine_count} <span className="text-sm font-normal">/ {data.coverage.total_machine_count}</span></dd><p className="mt-1 text-xs text-slate-500">{tx('교대 기록완료율·가동률 아님', '并非班次完成率或开机率')}</p></div>
    </dl>
    <p className="mt-3 text-sm leading-6 text-slate-600">{tx('미기록은 정상 품질이나 미가동을 뜻하지 않습니다. 검사 수량이 없어 불량률은 계산하지 않습니다.', '未记录不代表质量正常或停机。没有检验数量，因此不计算不良率。')}</p>
    {data.status === 'partial' && <div role="status" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      {tx('검증 주의', '校验提醒')}: {tx('제외 기록', '排除记录')} {data.coverage.invalid_checkpoint_count} · {tx('문서 오류', '文档错误')} {data.coverage.invalid_document_count} · {tx('중복 발견', '发现重复')} {data.coverage.duplicate_checkpoint_count}
      <details className="mt-2"><summary className="cursor-pointer font-semibold">{tx('제외 사유와 원천 경고', '排除原因与来源警告')}</summary><ul className="mt-2 list-inside list-disc break-words">{Object.entries(data.coverage.excluded_by_reason ?? {}).map(([reason, count]) => <li key={reason}>{reason}: {count}</li>)}{data.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>
    </div>}
    {!compact && <>
      {causes.length > 0 ? <div className="mt-6" role="img" aria-label={tx('선택 범위의 신고 불량 유형별 수량, ea', '所选范围申报不良类型数量，ea')}>
        <h3 className="mb-3 font-semibold text-slate-800">{tx('신고 불량 유형', '申报不良类型')} · ea</h3>
        <ResponsiveContainer width="100%" height={Math.max(180, causes.length * 34)}><BarChart data={causes} layout="vertical" margin={{ left: 16, right: 35 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" /><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="name" width={88} tick={{ fontSize: 12 }} /><Tooltip formatter={(value: number) => [`${number(value, lang)} ea`, tx('신고 불량', '申报不良')]} />
          <Bar dataKey="reported_defect_qty" fill="#d97706" radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart></ResponsiveContainer>
        <p className="mt-2 text-sm text-slate-500">{causes.map((row) => `${row.name} ${number(row.reported_defect_qty, lang)} ea`).join(' · ')}</p>
      </div> : <p className="my-5 rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">{data.summary.checkpoint_count > 0 ? tx('저장된 유효 구간의 신고 불량은 0입니다.', '已保存的有效区间申报不良为零。') : tx('이 날짜·설비 범위에 저장된 유효 구간이 없습니다.', '此日期和设备范围内没有已保存的有效区间。')}</p>}
      <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm">
        <caption className="mb-3 text-left font-semibold text-slate-800">{tx('설비별 현장 신고', '设备现场申报')}</caption>
        <thead className="border-b border-slate-200 text-slate-500"><tr>{[tx('설비', '设备'), tx('기록 상태', '记录状态'), tx('구간 수', '区间数'), tx('신고 불량 ea', '申报不良 ea'), tx('구간 추정 총량 ea', '区间估算总量 ea'), tx('최근 저장 · UTC+8', '最近保存 · UTC+8'), tx('연결', '链接')].map((label) => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead>
        <tbody>{data.machines.map((row) => <tr key={row.machine_number} className="border-b border-slate-100"><th className="p-3 font-semibold">{row.machine_number}{tx('호기', '号机')}</th><td className="p-3">{recordState(row.status)}</td><td className="p-3">{row.checkpoint_count}</td><td className="p-3 tabular-nums">{number(row.reported_defect_qty, lang)}</td><td className="p-3 tabular-nums">{number(row.estimated_gross_qty, lang)}</td><td className="p-3">{time(row.latest_reported_at, lang)}</td><td className="p-3"><PermissionLink className={linkStyle} to={buildInjectionLink('/mes/monitoring', { ...scope, machineNumber: row.machine_number })}>{tx('계측 확인', '查看监测')}</PermissionLink></td></tr>)}</tbody>
      </table></div>
      <p className="mt-3 text-xs leading-5 text-slate-500">{tx('구간 추정 총량 = 저장한 형합 구간 × 당시 Cavity. 일일 전체 실적·검사 확정 양품과 다르며 MES 추정 실적에 더하지 않습니다.', '区间估算总量 = 已保存模次区间 × 当时穴数。与全天实绩、检验确认良品不同，不与 MES 估算实绩相加。')}</p>
    </>}
    <p className="mt-4 text-xs text-slate-500">{tx('최근 현장 저장', '最近现场保存')}: {time(data.freshness.latest_reported_at, lang)} · {tx('집계 생성', '汇总生成')}: {time(data.freshness.generated_at, lang)} · UTC+8</p>
  </section>;
}

export default function InjectionEvidencePanel({ scope, currentDate, view }: Props) {
  const { lang } = useLang();
  const tx: Translate = (ko, zh) => lang === 'zh' ? zh : ko;
  const historical = scope.date !== currentDate;
  const overview = useQuery({ queryKey: ['analysis-overview', scope.date, lang], queryFn: () => getAnalysisOverview(scope.date, lang), enabled: view === 'overview', staleTime: 30_000, retry: 1, refetchInterval: historical || view !== 'overview' ? false : 60_000, refetchOnWindowFocus: false });
  const field = useQuery({ queryKey: scope.machineNumber === null ? ['analysis-field-operations', scope.date] : ['analysis-field-operations', scope.date, scope.machineNumber], queryFn: () => getFieldOperations(scope.date, scope.machineNumber), staleTime: 30_000, retry: 1, refetchInterval: historical ? false : 60_000, refetchOnWindowFocus: false });
  const production = overview.data ? scopedProduction(overview.data, scope) : null;
  const canEvaluate = Boolean(production?.canEvaluate && !overview.isError);
  const fieldData = field.data;
  const rowsReady = Boolean(production && !production.contextUnavailable && !overview.isError);
  const chartRows = production?.rows.filter((row) => rowCanEvaluate(row, rowsReady) && (row.plannedQuantity ?? 0) > 0) ?? [];
  const exportProduction = () => {
    if (!production) return;
    download([
      ['business_date', 'machine_number', 'source', 'unit', 'planned_qty', 'estimated_mes_qty', 'source_status', 'source_latest_at', 'basis'],
      ...production.rows.map((row) => [scope.date, row.machineNumber, 'MES_and_production_plan', 'ea', row.plannedQuantity, rowCanEvaluate(row, rowsReady) ? row.actualQuantity : null, injectionQuantityStatus(row), row.latestCapacityTime, 'MES shots x cavity; allocated by plan sequence; not inspected good quantity']),
    ], `injection-observed-${scope.date}-${scope.machineNumber ?? 'all'}.csv`);
  };
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-500">{tx('조회 범위', '查询范围')}: {scope.date} · {scope.machineNumber === null ? tx('전체 사출 설비', '全部注塑设备') : `${scope.machineNumber}${tx('호기', '号机')}`}</p><button className={buttonStyle} type="button" disabled={field.isFetching || (view === 'overview' && overview.isFetching)} onClick={() => { void field.refetch(); if (view === 'overview') void overview.refetch(); }}><RefreshCw size={15} />{tx('자료 새로고침', '刷新资料')}</button></div>
    {view === 'overview' && <>
      <RequestNotice loading={overview.isPending} error={overview.isError} hasData={Boolean(overview.data)} retry={() => void overview.refetch()} tx={tx} />
      {production && <section className={panel} aria-label={tx('MES와 계획 기반 사출 실적', '基于 MES 与计划的注塑实绩')}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-bold text-slate-900">{tx('계획과 관측 실적', '计划与观测实绩')}</h2><p className="mt-1 text-sm text-slate-500">{tx('MES 형합수 × Cavity · 계획 순서 배분 기준', 'MES 模次 × 穴数 · 按计划顺序分配')}</p></div><button className={buttonStyle} type="button" disabled={!production.rows.some((row) => rowCanEvaluate(row, rowsReady))} onClick={exportProduction}><Download size={15} />{tx('관측 실적 CSV', '观测实绩 CSV')}</button></div>
        <dl className="grid gap-3 sm:grid-cols-3">{[
          [tx('등록 계획', '登记计划'), `${number(production.planned, lang)} ea`],
          [canEvaluate ? tx('계획 설비 MES 추정 실적', '计划设备 MES 估算实绩') : tx('MES 추정 실적 · 확인 필요', 'MES 估算实绩 · 需核对'), `${number(production.actual, lang)} ea`],
          [tx('계획 달성', '计划达成'), canEvaluate && production.completion !== null ? `${number(production.completion, lang, 1)}%` : '—'],
        ].map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-4"><dt className="text-sm text-slate-500">{label}</dt><dd className="mt-1 text-2xl font-bold text-slate-950">{value}</dd></div>)}</dl>
        {!canEvaluate && <p role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{tx('계수 누락·지연, 계획 미확정 또는 갱신 실패로 합계와 달성 판단을 보류합니다.', '因计数缺失、延迟、计划未确认或刷新失败，暂不判断合计与达成。')}</p>}
        {production.planned === 0 && <p className="mt-3 text-sm text-amber-800">{tx('등록 계획이 없습니다. 휴무인지 계획이 미등록되었는지 확인하세요.', '没有登记计划，请核对是否休息或漏登记。')}</p>}
        {chartRows.length > 0 && <div className="mt-5" role="img" aria-label={tx('설비별 계획과 MES 추정 실적 비교, ea', '各设备计划与 MES 估算实绩比较，ea')}>
          <ResponsiveContainer width="100%" height={Math.max(160, chartRows.length * 34)}><BarChart layout="vertical" data={chartRows} margin={{ left: 6, right: 25 }}><CartesianGrid horizontal={false} strokeDasharray="3 3" /><XAxis type="number" /><YAxis type="category" dataKey="label" width={83} tick={{ fontSize: 11 }} /><Tooltip formatter={(value: number) => `${number(value, lang)} ea`} /><Bar dataKey="plannedQuantity" name={tx('계획', '计划')} fill="#b8c8de" isAnimationActive={false} /><Bar dataKey="actualQuantity" name={tx('MES 추정 실적', 'MES 估算实绩')} fill="#2563eb" isAnimationActive={false} /></BarChart></ResponsiveContainer>
          <p className="mt-1 text-xs text-slate-500">{tx('연한 막대: 계획 · 파란 막대: MES 추정 실적. 계획과 유효 관측이 있는 설비만 표시합니다.', '浅色：计划 · 蓝色：MES 估算实绩。仅展示有计划且有有效观测的设备。')}</p>
        </div>}
        <p className="mt-4 text-sm leading-6 text-slate-600">{tx('계획에 배분한 추정 수량이며 무계획 생산과 검사 확정 양품을 나타내지 않습니다. 현장 신고·관리자 실행·수기일보는 별도 기록이며 이 숫자에 자동 합산되지 않습니다.', '这是分配到计划的估算数量，不代表无计划生产或检验确认良品。现场申报、管理报工、手工日报为独立记录，不自动合入此数。')}</p>
        <p className="mt-2 text-xs text-slate-500">{tx('MES 원천 최신', 'MES 来源最新时间')}: {time(production.source?.sourceLatestAt, lang)} · UTC+8 · {tx('전체 설비 기준 시각 · 개별 설비의 계수 수집 상태로 수치를 검증하며 연속 관측을 보장하지 않습니다.', '全部设备来源时间 · 数值按单台设备的计数采集状态校验，不保证连续观测。')}</p>
      </section>}
    </>}
    <RequestNotice loading={field.isPending} error={field.isError} hasData={Boolean(fieldData)} retry={() => void field.refetch()} tx={tx} />
    {fieldData && <FieldRecords data={fieldData} scope={scope} compact={view === 'overview'} refreshFailed={field.isError} lang={lang} tx={tx} />}
    {view === 'overview' && production && <section className={panel} aria-label={tx('설비별 원천과 확인 연결', '设备数据源与核对链接')}>
      <h2 className="mb-2 text-xl font-bold text-slate-900">{tx('설비별 확인', '逐台核对')}</h2><p className="mb-4 text-sm text-slate-500">{tx('같은 설비·업무일로 기록과 계측을 확인합니다. 현장 입력 링크는 현재 업무일입니다.', '按同一设备、业务日查看记录与监测。现场录入链接进入当前业务日。')}</p>
      <div className="overflow-x-auto"><table className="w-full min-w-[730px] text-left text-sm"><thead className="border-b border-slate-200 text-slate-500"><tr>{[tx('설비', '设备'), tx('계획 ea', '计划 ea'), tx('MES 추정 ea', 'MES 估算 ea'), tx('현장 신고 불량 ea', '现场申报不良 ea'), tx('원천 상태', '来源状态'), tx('관련 화면', '相关页面')].map((label) => <th className="p-3 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{production.rows.map((row) => {
        const record = fieldData?.machines.find((item) => item.machine_number === row.machineNumber);
        const rowScope = { ...scope, machineNumber: row.machineNumber };
        return <tr key={row.id} className="border-b border-slate-100"><th className="p-3 font-semibold text-slate-800">{row.label}</th><td className="p-3 tabular-nums">{number(row.plannedQuantity, lang)}</td><td className="p-3 tabular-nums">{number(rowCanEvaluate(row, rowsReady) ? row.actualQuantity : null, lang)}</td><td className="p-3 tabular-nums">{number(record?.reported_defect_qty, lang)}{record?.status === 'no_records' && <span className="ml-1 text-xs text-slate-500">{tx('미기록', '未记录')}</span>}</td><td className="p-3">{rowCanEvaluate(row, rowsReady) ? tx('관측 자료', '观测资料') : tx('확인 필요', '需核对')}</td><td className="p-3"><div className="flex flex-wrap gap-x-3 gap-y-2"><Link className={linkStyle} to={buildInjectionLink('/injection/dashboard', rowScope, 'field-records')}>{tx('현장 기록', '现场记录')}</Link><PermissionLink className={linkStyle} to={buildInjectionLink('/mes/monitoring', rowScope)}>{tx('계측', '监测')}</PermissionLink>{row.machineNumber !== null && <PermissionLink className={linkStyle} to={getFieldStationPath(row.machineNumber)}>{tx('현재 현장', '当前现场')}</PermissionLink>}</div></td></tr>;
      })}</tbody></table></div>
    </section>}
  </div>;
}
