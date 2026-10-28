import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, Boxes, CalendarDays, CheckCircle2, CircleAlert, Clock3, Factory, PackageCheck, RefreshCw, ShieldCheck, Truck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import PermissionLink from '@/components/common/PermissionLink';
import { PageContainer } from '@/components/layout/PageLayout';
import { getAnalysisOverview, getAnalysisSources } from '@/domains/analysis/api';
import { getPriorityEquipment, getProcessEvidence, resolveAnalysisDate } from '@/domains/analysis/model';
import { getProductionStatus } from '@/domains/production/api';
import { deriveInjectionQuality, reduceInjectionQuality, type InjectionQualityState } from '@/domains/production/injection-quality-status';
import { injectionQualityAttention } from '@/domains/production/injection-quality-attention';
import type { OverviewBoardModel, ProductionProcess } from '@/domains/boards/overview/types';
import { useLang } from '@/i18n';
import { useShanghaiBusinessDate } from '@/shared/hooks/useShanghaiBusinessDate';
import './FlowDashboard.css';

type Translate = (ko: string, zh: string) => string;
type Language = 'ko' | 'zh';
type StageTone = 'ready' | 'attention' | 'unknown';

function number(value: number | null | undefined, lang: Language, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'ko-KR', { maximumFractionDigits: digits }).format(value)
    : '—';
}

function time(value: string | number | null | undefined, lang: Language) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'ko-KR', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function isTime(value: string | null | undefined) {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function Status({ tone, children }: { tone: StageTone; children: React.ReactNode }) {
  return <span className={`flow-status flow-status--${tone}`}><span aria-hidden="true" />{children}</span>;
}

function Stage({ step, icon: Icon, title, tone, status, children, to, link }: {
  step: string; icon: LucideIcon; title: string; tone: StageTone; status: string;
  children: React.ReactNode; to: string; link: string;
}) {
  return <article className={`flow-stage flow-stage--${step}`}>
    <div className="flow-stage__top"><span className="flow-stage__step">{step}</span><span className="flow-stage__icon"><Icon size={19} aria-hidden="true" /></span></div>
    <h3>{title}</h3><Status tone={tone}>{status}</Status>
    <div className="flow-stage__body">{children}</div>
    <PermissionLink to={to} className="flow-stage__link">{link}<ArrowRight size={15} aria-hidden="true" /></PermissionLink>
  </article>;
}

type ProcessEvidence = ReturnType<typeof getProcessEvidence>;
function processReady(evidence: ProcessEvidence, key: ProductionProcess['key'], refreshFailed: boolean) {
  return !refreshFailed && evidence.canEvaluate && evidence.hasPlan && evidence.actual !== null
    && isTime(evidence.source?.sourceLatestAt)
    && (key !== 'injection' || evidence.process.capacityCoverageComplete === true);
}

function ProcessStage({ model, processKey, failed, loading, lang, tx, date }: {
  model?: OverviewBoardModel; processKey: ProductionProcess['key']; failed: boolean; loading: boolean;
  lang: Language; tx: Translate; date: string;
}) {
  const evidence = model ? getProcessEvidence(model, processKey) : undefined;
  const injection = processKey === 'injection';
  const ready = Boolean(evidence && processReady(evidence, processKey, failed));
  // Assembly source freshness is not independently assessed by this API.
  const label = loading && !model ? tx('불러오는 중', '加载中') : !evidence || failed || evidence.unavailable
    ? tx('미확인', '未确认') : evidence.source?.stale || evidence.source?.status === 'stale'
      ? tx('원천 지연', '数据源延迟') : !ready || !injection ? tx('확인 필요', '需要核对') : tx('원천 응답', '数据源已响应');
  const tone: StageTone = ready && injection ? 'ready' : evidence && !evidence.unavailable ? 'attention' : 'unknown';
  const actual = evidence?.actual ?? null;
  const planAvailable = evidence && evidence.process.planRowCount !== null && evidence.process.planRowCount > 0
    && !model?.warnings.includes(`${processKey}_plan_missing`);
  const completion = ready && evidence?.completionRate !== null && evidence?.completionRate !== undefined ? evidence.completionRate : null;
  return <Stage step={injection ? '01' : '02'} icon={injection ? Factory : Activity} title={injection ? tx('사출', '注塑') : tx('조립', '组装')}
    tone={tone} status={label} to={`/production?date=${encodeURIComponent(date)}`} link={tx('생산 상세', '生产明细')}>
    <p className="flow-metric-label">{injection ? tx('추정 실적 / 계획', '估算实绩 / 计划') : tx('관측 실적 / 계획', '观测实绩 / 计划')}</p>
    <p className="flow-quantity"><strong>{number(actual, lang)}</strong><span> / {number(planAvailable ? evidence?.process.plannedQuantity : null, lang)} ea</span></p>
    <div className="flow-progress-label"><span>{tx('계획 달성', '计划达成')}</span><b>{completion === null ? '—' : `${number(completion, lang, 1)}%`}</b></div>
    <div className="flow-progress" aria-hidden="true"><span style={{ width: completion === null ? '0%' : `${Math.max(0, Math.min(100, completion))}%` }} /></div>
    <p className="flow-stage__note">{injection
      ? tx('MES 형합수 × Cavity를 계획 순서에 배분한 추정치입니다.', '按计划顺序分配 MES 模次 × 穴数所得估算值。')
      : tx('MES 귀속 실적과 미대사 수기 보고를 포함합니다. 원천 지연 여부는 별도 평가되지 않습니다.', '包含 MES 归属实绩及待对账手工报工；数据源延迟未单独评估。')}</p>
    <p className="flow-stage__time">{injection ? tx('원천 최신', '数据源最新') : tx('원천 최신 (보고 또는 계획 수정)', '源最新时间（报工或计划修改）')}: {time(evidence?.source?.sourceLatestAt, lang)} UTC+8{failed && model ? tx(' · 이전 수신값', ' · 上次接收值') : ''}</p>
  </Stage>;
}

function QualityStage({ date, lang, tx }: { date: string; lang: Language; tx: Translate }) {
  const query = useQuery({
    queryKey: ['flow-inspection', date], queryFn: () => getProductionStatus(date),
    staleTime: 30_000, retry: 1, refetchInterval: 60_000, refetchOnWindowFocus: false,
  });
  const generations = useRef(new Map<number, InjectionQualityState>());
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const rows = Array.from({ length: 17 }, (_, index) => {
    const machineNumber = index + 1;
    const matches = query.data?.injection.filter((row) => row.machine_number === machineNumber) ?? [];
    const row = matches.length === 1 ? matches[0] : undefined;
    const binding = row?.inspection_scope;
    const valid = binding?.business_date === date && binding.machine_number === machineNumber
      && binding.current_plan_id !== null && row?.parts.filter((part) => part.plan_id === binding.current_plan_id).length === 1;
    const scope = { businessDate: date, machineNumber, currentPlanId: valid ? binding.current_plan_id : null,
      planVersion: valid ? binding.plan_version : '0'.repeat(64) };
    const state = reduceInjectionQuality(generations.current.get(machineNumber), valid ? row?.inspection_status : null, scope);
    generations.current.set(machineNumber, state);
    const view = deriveInjectionQuality(state, scope, now, { transportError: query.isError });
    return { view, attention: injectionQualityAttention(view) };
  });
  const known = rows.filter((row) => row.attention.verified);
  const failedCount = known.filter((row) => {
    const data = row.view.data;
    return data && [...data.first.checks, ...data.periodic.checks].some((check) => check.status === 'failed');
  }).length;
  const latestObservation = known.map((row) => row.view.data?.observed_at).filter((value): value is string => Boolean(value) && isTime(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return <Stage step="03" icon={ShieldCheck} title={tx('사출 초품·타임체크', '注塑首检与巡检')} tone={known.length ? 'attention' : 'unknown'}
    status={query.isPending ? tx('불러오는 중', '加载中') : known.length ? tx('부분 확인', '部分已核对') : tx('미확인', '未确认')}
    to="/quality/inspection-requests" link={tx('검사 관리', '检验管理')}>
    <p className="flow-metric-label">{tx('유효 범위 확인 설비', '已核对有效范围的设备')}</p>
    <p className="flow-quantity"><strong>{known.length ? number(known.length, lang) : '—'}</strong><span> / 17 {tx('호기', '台')}</span></p>
    <p className="flow-mini-line">{tx('불합격 관측 설비', '有不合格观测的设备')} <b>{known.length ? number(failedCount, lang) : '—'}</b></p>
    <p className="flow-stage__note">{tx('사출 설비의 초품·타임체크만 표시합니다. 유효·완전·계획 연결된 범위이며, 불합격 관측은 이력을 포함해 현재 불합격 확정이 아닙니다.', '仅显示注塑设备的首检与巡检，范围限于有效、完整且关联计划的资料。不合格观测含历史记录，不代表当前不合格。')}</p>
    <p className="flow-stage__time">{tx('최신 수집 관측', '最近采集观测')}: {time(latestObservation, lang)} UTC+8{query.isError ? tx(' · 조회 실패', ' · 查询失败') : ''}</p>
  </Stage>;
}

function InventoryStage({ model, failed, loading, lang, tx, date }: {
  model?: OverviewBoardModel; failed: boolean; loading: boolean; lang: Language; tx: Translate; date: string;
}) {
  const inventory = model?.inventory;
  const snapshotDate = inventory?.snapshotDate;
  const available = Boolean(snapshotDate && !model?.warnings.includes('inventory_snapshot_unavailable')
    && !model?.warnings.includes('inventory_snapshot_missing'));
  const current = snapshotDate === date;
  const finished = inventory?.warehouses.find((row) => row.label === '成品仓库');
  const semi = inventory?.warehouses.find((row) => row.label === '半成品仓库');
  return <Stage step="04" icon={Boxes} title={tx('재고', '库存')} tone={available && current && !failed ? 'ready' : available ? 'attention' : 'unknown'}
    status={loading && !model ? tx('불러오는 중', '加载中') : !available ? tx('미확인', '未确认') : failed ? tx('이전 수신값', '上次接收值') : current ? tx('선택일 스냅샷', '所选日快照') : tx('이전 스냅샷', '较早的快照')}
    to="/sales/inventory-status" link={tx('재고 상세', '库存明细')}>
    <p className="flow-metric-label">{tx('창고별 스냅샷 수량', '各仓库快照数量')}</p>
    <div className="flow-warehouse"><span>{tx('완제품 창고', '成品仓库')}</span><b>{number(available ? finished?.quantity : null, lang, 2)}</b></div>
    <div className="flow-warehouse"><span>{tx('반제품 창고', '半成品仓库')}</span><b>{number(available ? semi?.quantity : null, lang, 2)}</b></div>
    <p className="flow-stage__note">{tx('창고별 집계 스냅샷이며 공정 생산량이나 실시간 재고가 아닙니다.', '为各仓库汇总快照，不是工序产量或实时库存。')}</p>
    <p className="flow-stage__time">{tx('스냅샷 기준일', '快照日期')}: {snapshotDate || '—'}</p>
  </Stage>;
}

function ShippingStage({ model, failed, loading, lang, tx, date }: {
  model?: OverviewBoardModel; failed: boolean; loading: boolean; lang: Language; tx: Translate; date: string;
}) {
  const inventory = model?.inventory;
  const snapshot = inventory?.shippingSnapshotAt;
  const available = isTime(snapshot) && !model?.warnings.includes('finished_goods_shipping_snapshot_missing')
    && !model?.warnings.includes('inventory_snapshot_unavailable');
  const start = Date.parse(`${date}T08:00:00+08:00`);
  const inWindow = available && Date.parse(snapshot as string) >= start && Date.parse(snapshot as string) < start + 86_400_000;
  return <Stage step="05" icon={Truck} title={tx('출고·출하', '出库与出货')} tone={available ? 'attention' : 'unknown'}
    status={loading && !model ? tx('불러오는 중', '加载中') : !available ? tx('미확인', '未确认') : failed ? tx('이전 수신값', '上次接收值') : inWindow ? tx('스냅샷 확인', '快照已获取') : tx('업무일 범위 밖', '业务日范围外')}
    to="/sales/movement-history" link={tx('입·출고 이력', '出入库记录')}>
    <p className="flow-metric-label">{tx('스냅샷 출고 합계', '快照出库合计')}</p>
    <p className="flow-quantity"><strong>{number(available ? inventory?.shippingOutbound : null, lang, 2)}</strong></p>
    <p className="flow-stage__note">{tx('출고 스냅샷 집계입니다. 개별 출하 완료·승인 또는 납기 준수를 뜻하지 않습니다.', '为出库快照汇总，不代表逐笔出货完成、审批或交期达成。')}</p>
    <p className="flow-stage__time">{tx('스냅샷 예정 시각', '快照计划时间')}: {time(snapshot, lang)} UTC+8</p>
  </Stage>;
}

function CandidatePanel({ model, failed, loading, historical, lang, tx, date }: {
  model?: OverviewBoardModel; failed: boolean; loading: boolean; historical: boolean; lang: Language; tx: Translate; date: string;
}) {
  const evidence = model ? getProcessEvidence(model, 'injection') : undefined;
  const gap = evidence?.process.completionVsTimeGap;
  const reference = model?.businessWindowDetails?.referenceTime;
  const eligible = Boolean(evidence && processReady(evidence, 'injection', failed) && isTime(reference)
    && typeof gap === 'number' && Number.isFinite(gap));
  const candidate = eligible && gap !== null && gap !== undefined && gap < -5;
  const activity = model?.freshness.sources?.find((source) => source.key === 'injection_activity');
  const equipmentEvidence = Boolean(eligible && !historical && activity?.status === 'ok' && !activity.stale
    && isTime(activity.sourceLatestAt));
  const equipment = model && equipmentEvidence ? getPriorityEquipment(model).filter(({ row, reason }) => (
    reason !== 'source' && row.sourceStatus === 'ok' && row.capacityDataAvailable === true
    && isTime(row.sourceLatestAt) && isTime(row.latestCapacityTime)
    && typeof row.activityWindowMinutes === 'number' && row.activityWindowMinutes > 0
  )).slice(0, 4) : [];
  const reasonLabel = (reason: string, minutes: number | null, difference: number | null) => {
    if (reason === 'unplanned') return tx(`최근 ${number(minutes, lang)}분 가동 관측 · 계획 미연결`, `最近${number(minutes, lang)}分钟观测到运行 · 未关联计划`);
    if (reason === 'unresolved') return tx(`최근 ${number(minutes, lang)}분 가동 관측 · 품번 미확정`, `最近${number(minutes, lang)}分钟观测到运行 · 品号未确定`);
    if (reason === 'stopped') return tx(`계획 있음 · 최근 ${number(minutes, lang)}분 가동 관측 없음`, `有计划 · 最近${number(minutes, lang)}分钟无运行观测`);
    return tx(`계획 설비 · 24시간 경과율 대비 ${number(difference, lang, 1)}%p (잠정 −5%p 미만)`, `计划设备 · 对比24小时经过比例 ${number(difference, lang, 1)}个百分点（暂定低于−5个百分点）`);
  };
  return <section className="flow-panel flow-candidates" aria-labelledby="flow-candidates-title">
    <div className="flow-panel__heading"><div><p className="flow-eyebrow">FOCUS AREA</p><h2 id="flow-candidates-title">{tx('병목 확인 후보', '瓶颈核对候选')}</h2><p>{tx('우선 살펴볼 신호이며 확정된 병목이나 원인은 아닙니다.', '仅为优先核对信号，不代表已确认瓶颈或原因。')}</p></div><CircleAlert size={21} aria-hidden="true" /></div>
    {candidate ? <div className="flow-candidate"><span className="flow-candidate__icon"><CircleAlert size={19} /></span><div><div className="flow-candidate__title"><strong>{historical ? tx('과거 업무일 · 사출 진도 확인', '历史业务日 · 核对注塑进度') : tx('사출 진도 확인', '核对注塑进度')}</strong><Status tone="attention">{tx('확인 후보', '核对候选')}</Status></div>
      <p>{tx('계획 달성률 − 24시간 경과율', '计划达成率 − 24小时经过比例')}: <b>{number(gap, lang, 1)}%p</b> · {tx('기준 시각', '参考时间')}: {time(reference, lang)} UTC+8</p>
      <PermissionLink to={`/production?date=${encodeURIComponent(date)}`} className="flow-inline-link">{tx('생산 상세에서 확인', '查看生产明细')} <ArrowRight size={14} aria-hidden="true" /></PermissionLink></div></div>
      : <div className="flow-candidate flow-candidate--neutral"><span className="flow-candidate__icon"><CheckCircle2 size={19} /></span><div><strong>{loading ? tx('사출 자료 확인 중', '正在核对注塑数据') : eligible ? tx('사출 공정 전체의 진도 기준 미해당', '注塑整体进度未触发条件') : tx('사출 후보 판정 보류', '暂不判断注塑候选')}</strong><p>{eligible ? tx('다른 공정과 원천이 정상이라는 뜻은 아닙니다.', '不代表其他工序及数据源正常。') : tx('계획·원천 시각·유효 범위 또는 갱신 상태를 확인해야 합니다.', '请核对计划、数据源时间、有效范围或刷新状态。')}</p></div></div>}
    {equipment.length > 0 && <div className="flow-equipment"><h3>{tx('설비별 확인 후보', '设备核对候选')}</h3>
      <p>{tx('현재 업무일의 유효한 생산·가동 원천과 설비별 수량 근거가 있는 항목만 최대 4개 표시합니다.', '仅显示当前业务日生产、运行源有效且有设备数量依据的项目，最多4项。')}</p>
      <ul>{equipment.map(({ row, reason }) => <li key={row.id}><div><strong>{row.label}</strong><span>{reasonLabel(reason, row.activityWindowMinutes, row.gapToTimeRate)}</span></div>
        <small>{tx('가동 원천', '运行源')}: {time(row.sourceLatestAt, lang)} · {tx('수량 원천', '数量源')}: {time(row.latestCapacityTime, lang)} UTC+8</small></li>)}</ul>
      <p>{tx('가동 관측 없음은 정지 원인이나 실제 병목을 뜻하지 않습니다. 개별 원천 시각과 현장을 확인하세요.', '无运行观测不代表停机原因或实际瓶颈，请核对各源时间和现场。')}</p>
      <PermissionLink to="/mes/monitoring" className="flow-inline-link">{tx('설비 모니터링', '设备监控')} <ArrowRight size={14} aria-hidden="true" /></PermissionLink></div>}
    <p className="flow-criterion">{tx('공정 전체의 잠정 진도 기준: 사출 원천 응답이 정상이고 계획 설비의 수량 근거가 모두 확인된 경우, 계획 달성률이 08:00부터의 24시간 경과율보다 5%p 초과 낮을 때 표시합니다. 휴무·교대·계획정지는 반영하지 않은 선형 비교입니다.', '工序整体的暂定进度条件：注塑数据源响应正常且所有计划设备的数量依据已确认，计划达成率比08:00起24小时经过比例低超过5个百分点时显示。该线性比较不考虑休息、班次或计划停机。')}</p>
    <p className="flow-criterion">{tx('조립 원천 지연은 별도 평가되지 않아 후보 판정을 보류합니다. 품질·재고·출하도 연결 근거가 없어 병목으로 판정하지 않습니다.', '组装源延迟未单独评估，故暂不判断候选；质量、库存和出货缺少关联依据，不判定为瓶颈。')}</p>
  </section>;
}

export default function FlowDashboard() {
  const { lang } = useLang();
  const tx: Translate = (ko, zh) => lang === 'zh' ? zh : ko;
  const currentDate = useShanghaiBusinessDate();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const date = resolveAnalysisDate(selectedDate, currentDate);
  const historical = date !== currentDate;
  const production = useQuery({ queryKey: ['flow-production-overview', date, lang],
    queryFn: ({ signal }) => getAnalysisOverview(date, lang, signal), staleTime: 30_000, retry: 1,
    refetchInterval: historical ? false : 60_000, refetchOnWindowFocus: false });
  const sources = useQuery({ queryKey: ['flow-additional-sources', date, lang],
    queryFn: ({ signal }) => getAnalysisSources(date, lang, signal), staleTime: 30_000, retry: 1,
    refetchInterval: historical ? false : 60_000, refetchOnWindowFocus: false });
  const refreshing = production.isFetching || sources.isFetching;
  return <PageContainer className="flow-dashboard">
    <header className="flow-hero">
      <div className="flow-hero__copy"><p className="flow-eyebrow">WJ OPERATIONS / FLOW</p><h1>{tx('운영 흐름 대시보드', '运营流程仪表盘')}</h1>
        <p>{tx('생산부터 출고까지, 서로 다른 원천을 한 화면에서 확인합니다.', '从生产到出库，在同一画面核对不同数据源。')}</p></div>
      <div className="flow-controls"><label><CalendarDays size={17} aria-hidden="true" /><span className="flow-sr-only">{tx('업무일', '业务日')}</span>
        <input aria-label={tx('업무일', '业务日')} type="date" max={currentDate} value={date} onChange={(event) => { if (event.target.value) setSelectedDate(event.target.value); }} /></label>
        <button type="button" onClick={() => setSelectedDate(null)}>{tx('오늘', '今天')}</button>
        <button type="button" className="flow-refresh" disabled={refreshing} onClick={() => { void production.refetch(); void sources.refetch(); }} aria-label={tx('생산·스냅샷 새로고침', '刷新生产及快照')}><RefreshCw size={17} className={refreshing ? 'flow-spin' : ''} aria-hidden="true" /></button>
      </div>
    </header>
    <div className="flow-context"><div><span className="flow-context__dot" /><strong>{date}</strong><span>{historical ? tx('과거 업무일', '历史业务日') : tx('현재 업무일', '当前业务日')}</span></div>
      <p><Clock3 size={15} aria-hidden="true" />{tx('중국 시간 08:00 → 다음 날 08:00', '中国时间 08:00 → 次日 08:00')} · UTC+8</p></div>
    {(production.isError || sources.isError) && <div className="flow-notice" role="status"><CircleAlert size={18} aria-hidden="true" /><span>{tx('일부 조회 또는 갱신에 실패했습니다. 이전 수신값은 별도로 표시하며, 누락은 0을 뜻하지 않습니다.', '部分查询或刷新失败。上次接收值会单独标注；缺失不代表为0。')}</span></div>}
    <section className="flow-route" aria-label={tx('MES 전체 업무 흐름', 'MES 整体业务流程')}>
      <div className="flow-route__heading"><strong>{tx('전체 업무 흐름', '整体业务流程')}</strong><span>{tx('연결 확인 범위 · 확정된 LOT 이동 경로 아님', '关联核对范围 · 非已确认批次流转路径')}</span></div>
      <ol>{[
        [tx('계획·작업지시', '计划与工单'), tx('계획 수량 조회', '计划数量查询')],
        [tx('개시·초품', '开工与首检'), tx('작업 연결 확인 필요', '需核对任务关联')],
        [tx('생산·순회검사', '生产与巡检'), tx('생산·사출 검사 조회', '生产及注塑检验查询')],
        [tx('완료·입고', '完工与入库'), tx('개별 보고 연결 미확인', '逐笔报工关联未确认')],
        [tx('격리·해제', '隔离与放行'), tx('정책·처분 미연동', '策略及处置未关联')],
        [tx('출하검사·승인', '出货检验与审批'), tx('완료·승인 미연동', '完成及审批未关联')],
        [tx('출고', '出库'), tx('입출고 이력 조회', '出入库记录查询')],
      ].map(([label, scope], index) => <li key={index}><span className="flow-route__number">{String(index + 1).padStart(2, '0')}</span><strong>{label}</strong><small>{scope}</small>{index < 6 && <ArrowRight size={14} aria-hidden="true" />}</li>)}</ol>
    </section>
    <section className="flow-section" aria-labelledby="flow-map-title"><div className="flow-section__heading"><div><p className="flow-eyebrow">SOURCE OBSERVATIONS</p><h2 id="flow-map-title">{tx('단계별 관측 자료', '各阶段观测资料')}</h2><p>{tx('단계별 독립 자료입니다. 수량을 공정 간 합산하거나 연결 실적으로 해석하지 않습니다.', '各阶段为独立数据，不跨工序合计数量，也不视为已关联实绩。')}</p></div><span className="flow-section__tag">{tx('읽기 전용', '只读')}</span></div>
      <div className="flow-stage-grid">
        <ProcessStage model={production.data} processKey="injection" failed={production.isError} loading={production.isPending} lang={lang} tx={tx} date={date} />
        <ProcessStage model={production.data} processKey="assembly" failed={production.isError} loading={production.isPending} lang={lang} tx={tx} date={date} />
        <QualityStage date={date} lang={lang} tx={tx} />
        <InventoryStage model={sources.data} failed={sources.isError} loading={sources.isPending} lang={lang} tx={tx} date={date} />
        <ShippingStage model={sources.data} failed={sources.isError} loading={sources.isPending} lang={lang} tx={tx} date={date} />
      </div>
    </section>
    <div className="flow-lower"><CandidatePanel model={production.data} failed={production.isError} loading={production.isPending} historical={historical} lang={lang} tx={tx} date={date} />
      <section className="flow-panel flow-boundaries" aria-labelledby="flow-boundaries-title"><div className="flow-panel__heading"><div><p className="flow-eyebrow">READING THE DATA</p><h2 id="flow-boundaries-title">{tx('연결 및 자료 범위', '关联与数据范围')}</h2></div><PackageCheck size={21} aria-hidden="true" /></div>
        <ul><li><span>01</span><div><strong>{tx('검사와 출하의 연결은 미확인', '检验与出货的关联未确认')}</strong><p>{tx('검사 통과, 처분 승인 또는 출하 가능 여부를 이 화면에서 판정하지 않습니다.', '本页面不判定检验通过、处置审批或是否可出货。')}</p></div></li>
          <li><span>02</span><div><strong>{tx('시각의 의미를 구분', '区分时间含义')}</strong><p>{tx('생산 원천 최신은 원천 시각, 검사는 수집 관측 시각, 출고는 스냅샷 예정 시각입니다. 개별 사건 시각과 다를 수 있습니다.', '生产源最新时间是源时间，检验为采集观测时间，出库为快照计划时间；可能不同于单笔事件时间。')}</p></div></li>
          <li><span>03</span><div><strong>{tx('자동 변경 없음', '不会自动更改')}</strong><p>{tx('이 화면은 조회 전용이며 MES 계획이나 수량을 조정하지 않습니다.', '本页面只读，不会调整 MES 计划或数量。')}</p></div></li></ul>
        <p className="flow-criterion">{tx('상세 화면에서는 선택한 업무일을 다시 확인하세요.', '请在明细页面重新确认所选业务日。')}</p>
        <PermissionLink to="/analysis" className="flow-inline-link">{tx('운영요약 열기', '打开运营概要')} <ArrowRight size={15} aria-hidden="true" /></PermissionLink>
      </section></div>
    <footer className="flow-footer"><span>{tx('생산 집계 생성', '生产汇总生成')}: {time(production.data?.generatedAt, lang)} UTC+8</span><span>{tx('부가 원천 집계 생성', '附加数据汇总生成')}: {time(sources.data?.generatedAt, lang)} UTC+8</span><span>{tx('품질 조회는 별도 원천', '质量查询来自独立数据源')}</span></footer>
  </PageContainer>;
}
