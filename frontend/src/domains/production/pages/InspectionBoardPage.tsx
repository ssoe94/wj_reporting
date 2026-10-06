import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ArrowUpRight, Check, Circle, ClipboardList, History, Maximize2, Pause, RefreshCw, X } from 'lucide-react';
import { getInjectionProductionMatrix } from '@/domains/mes/api';
import { useShanghaiBusinessDate } from '@/shared/hooks/useShanghaiBusinessDate';
import { useStoredLanguage } from '@/shared/i18n/language';
import { getProductionPlanSummary, getProductionStatus } from '../api';
import { buildInspectionBoardMachines, type InspectionBoardMachine } from '../inspection-board-model';
import type { InjectionQualityState, QualityCheckStatus } from '../injection-quality-status';
import { InjectionQualityStatus } from '../components/InjectionQualityStatus';
import machineImage from '@/assets/inspection-machine-miniature.png';
import inspectorImage from '@/assets/inspection-inspector-miniature.png';
import './InspectionBoardPage.css';

const COPY = {
  ko: {
    title: '사출 검사 현황판', machine: '호기', range: '사출', date: '기준일', refreshed: '화면 갱신',
    first: '초품', periodic: '순검', production: '당일 생산 추정량', productionShort: '생산(추정)', productionHint: '배분 형합수 × Cavity', plan: '당일 계획',
    currentPlan: '현재 계획', noPart: 'Part 확인 대기', noPlan: '현재 계획 미확인', inspectionQty: '검사수량',
    quantityUnknown: '미확인', quantityHint: '생산수량과 별도', record: '검사요청·기록', history: '누적 이력',
    historyHint: '로그인 후 검사요청에 기록된 내역을 확인합니다.',
    observations: '현재 계획 · 검사 관측', count: '건', empty: '확인된 검사 자료 없음',
    incomplete: '전체 검사 목록 미확인', inspection: '순검 판정', saved: 'MES 저장', saveUnknown: '요청 상세에서 확인',
    disposition: '불량 후속처리', dispositionUnknown: '조치 상태 미연동', dispositionHint: '검사 완료와 조치 종료는 별도입니다.',
    failedObservation: '불합격 관측', historical: '이전 관측', connectionError: '연결 오류', stale: '데이터 지연',
    unknown: '미확인', synced: '동기화됨', sample: '시험 자료', lastSync: '마지막 동기화',
    refreshing: '갱신 중', refresh: '지금 새로고침', autoRefresh: '1분 자동 갱신', full: '전체 화면',
    reduceMotion: '동작 줄이기', motionNote: '움직임은 상태 안내이며 실제 설비 주기와 동기화되지 않습니다.',
    injectionBoard: '사출 현황판', back: '현황판 목록', choose: '설비를 선택하면 검사 상세를 확인할 수 있습니다.',
    loading: '현황을 불러오는 중입니다.', unavailable: '현재 상태를 확인하지 못했습니다. 마지막 관측 시각을 확인해 주세요.',
    status: { unknown: '미확인', waiting: '대기', in_progress: '진행', passed: '합격', failed: '불합격' },
    tone: { running: '정상 가동', warning: '진도 확인', shot_issue: '형합 실적 이상', production_stopped: '현재 정지 추정', transition_review: '전환 후보·현장 확인', stopped: '금형 교체 중', overproducing: '초과 생산 중', completed: '생산 완료', unplanned: '계획 외 가동', idle: '형합 미관측', stale: '데이터 지연' },
  },
  zh: {
    title: '注塑检验看板', machine: '号机', range: '注塑', date: '基准日', refreshed: '页面更新',
    first: '首检', periodic: '巡检', production: '当日生产估算量', productionShort: '产量(估)', productionHint: '分配合模数 × 模穴数', plan: '当日计划',
    currentPlan: '当前计划', noPart: '等待确认Part', noPlan: '当前计划待确认', inspectionQty: '检验数量',
    quantityUnknown: '待确认', quantityHint: '与生产数量分开', record: '检验请求·记录', history: '累计记录',
    historyHint: '登录后可查看检验请求中已记录的内容。',
    observations: '当前计划 · 检验观测', count: '项', empty: '暂无已确认的检验资料',
    incomplete: '检验列表完整性待确认', inspection: '巡检判定', saved: 'MES 保存', saveUnknown: '请查看请求详情',
    disposition: '不合格后续处置', dispositionUnknown: '处置状态尚未关联', dispositionHint: '检验完成与处置结束分别确认。',
    failedObservation: '不合格观测', historical: '历史观测', connectionError: '连接异常', stale: '数据延迟',
    unknown: '待确认', synced: '已同步', sample: '测试资料', lastSync: '最后同步',
    refreshing: '刷新中', refresh: '立即刷新', autoRefresh: '每分钟自动更新', full: '全屏',
    reduceMotion: '减少动态效果', motionNote: '动效仅示意状态，不代表实际机台周期。',
    injectionBoard: '注塑实时看板', back: '看板中心', choose: '选择设备，查看检验详情。',
    loading: '正在加载看板。', unavailable: '当前状态待确认，请查看最后观测时间。',
    status: { unknown: '待确认', waiting: '待检', in_progress: '进行中', passed: '合格', failed: '不合格' },
    tone: { running: '按计划运行', warning: '进度待确认', shot_issue: '合模次数异常', production_stopped: '推测当前停产', transition_review: '换型候选·待现场确认', stopped: '正在换模', overproducing: '超额生产中', completed: '生产完成', unplanned: '计划外运行', idle: '未观测到合模', stale: '数据延迟' },
  },
} as const;

function StateMark({ state, text }: { state: QualityCheckStatus; text: string }) {
  return <span className={`inspection-board-state is-${state}`} data-status={state}>
    {state === 'passed' ? <Check aria-hidden="true" size={16} /> : state === 'failed' ? <X aria-hidden="true" size={16} /> : <Circle className="inspection-board-state-dot" aria-hidden="true" size={8} fill="currentColor" />}
    {text}
  </span>;
}

export function InspectionBoardPage() {
  const [language, setLanguage] = useStoredLanguage();
  const copy = COPY[language];
  const businessDate = useShanghaiBusinessDate();
  const [selectedNumber, setSelectedNumber] = useState(1);
  const [nowMs, setNowMs] = useState(Date.now);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [systemReduceMotion, setSystemReduceMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [fullscreenError, setFullscreenError] = useState(false);
  const previousQualityStates = useRef<Record<number, InjectionQualityState | null>>({});
  const planQuery = useQuery({ queryKey: ['production-plan-summary', businessDate, 'inspection-board'], queryFn: () => getProductionPlanSummary(businessDate), refetchInterval: 60_000 });
  const statusQuery = useQuery({ queryKey: ['production-status', businessDate, 'inspection-board'], queryFn: () => getProductionStatus(businessDate), refetchInterval: 60_000 });
  const mesQuery = useQuery({ queryKey: ['mes', 'inspection-board-matrix', businessDate], queryFn: () => getInjectionProductionMatrix(), refetchInterval: 60_000 });
  const transportError = planQuery.isError || statusQuery.isError || mesQuery.isError;
  const loading = planQuery.isPending || statusQuery.isPending || mesQuery.isPending;
  const refreshing = planQuery.isFetching || statusQuery.isFetching || mesQuery.isFetching;
  const machines = useMemo(() => buildInspectionBoardMachines({ businessDate, requestedBusinessDate: businessDate,
    planData: planQuery.data, statusData: statusQuery.data, mesData: mesQuery.data, nowMs, transportError,
    previousQualityStates: previousQualityStates.current }), [businessDate, planQuery.data, statusQuery.data, mesQuery.data, nowMs, transportError]);
  useEffect(() => { previousQualityStates.current = Object.fromEntries(machines.map(machine => [machine.machineNumber, machine.qualityState])); }, [machines]);
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 5_000);
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setSystemReduceMotion(query.matches);
    query.addEventListener('change', onMotion);
    return () => { window.clearInterval(interval); query.removeEventListener('change', onMotion); };
  }, []);
  const motion = !reduceMotion && !systemReduceMotion;
  const selected = machines.find(machine => machine.machineNumber === selectedNumber) ?? machines[0];
  const view = selected.qualityView;
  const data = view.data;
  const fresh = view.freshness === 'fresh' && view.availability === 'ok' && !transportError;
  const observations = data ? [...data.first.checks, ...data.periodic.checks, ...data.other_checks] : [];
  const checking = fresh && observations.some(item => item.status === 'in_progress');
  const qualityFreshness = (machine: InspectionBoardMachine) => machine.qualityView.availability === 'error' ? copy.connectionError
    : machine.qualityView.freshness === 'fresh' ? copy.synced : machine.qualityView.freshness === 'stale' ? copy.stale
      : machine.qualityView.freshness === 'fixture' ? copy.sample : copy.unknown;
  const number = (value: number | null) => value !== null && Number.isFinite(value) ? value.toLocaleString(language === 'ko' ? 'ko-KR' : 'zh-CN', { maximumFractionDigits: 0 }) : '—';
  const time = (value: string | number | null | undefined) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat(language === 'ko' ? 'ko-KR' : 'zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
  const dataTimes = [planQuery.dataUpdatedAt, statusQuery.dataUpdatedAt, mesQuery.dataUpdatedAt];
  const refreshedAt = dataTimes.every(value => value > 0) ? Math.min(...dataTimes) : null;
  const refresh = () => { void planQuery.refetch(); void statusQuery.refetch(); void mesQuery.refetch(); };
  const fullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); setFullscreenError(false); }
    catch { setFullscreenError(true); }
  };
  const selectMachine = (machineNumber: number) => {
    setSelectedNumber(machineNumber);
    if (window.matchMedia('(max-width: 900px)').matches) document.getElementById('inspection-board-detail')?.scrollIntoView({ block: 'start' });
  };
  return <main className="inspection-board" data-testid="inspection-board-page" data-motion={motion ? 'on' : 'off'}>
    <header className="inspection-board-header">
      <Link to="/boards" className="inspection-board-brand" aria-label={copy.back}><img src="/logo-transparent.png" alt="" /><span>WJ DATA CENTER<small>万佳数据平台</small></span></Link>
      <h1>{copy.title}</h1>
      <div className="inspection-board-date"><span>{copy.date} <strong>{businessDate}</strong></span><small>{copy.refreshed} {time(refreshedAt)} · {copy.autoRefresh}</small></div>
      <nav className="inspection-board-controls" aria-label={language === 'ko' ? '화면 설정' : '画面设置'}>
        <button type="button" aria-pressed={language === 'ko'} onClick={() => setLanguage('ko')}>KOR</button>
        <button type="button" aria-pressed={language === 'zh'} onClick={() => setLanguage('zh')}>中文</button>
        <button type="button" data-testid="inspection-motion-toggle" aria-label={copy.reduceMotion} title={copy.reduceMotion} aria-pressed={!motion} onClick={() => setReduceMotion(value => !value)}><Pause size={17} /></button>
        <button type="button" data-testid="inspection-refresh" aria-label={copy.refresh} title={copy.refresh} disabled={refreshing} onClick={refresh}><RefreshCw size={18} className={refreshing ? 'is-refreshing' : ''} /></button>
        <button type="button" aria-label={copy.full} title={copy.full} onClick={() => { void fullscreen(); }}><Maximize2 size={18} /></button>
      </nav>
    </header>
    {fullscreenError && <p className="inspection-board-banner" role="status">{language === 'ko' ? '전체 화면을 열 수 없습니다. 현재 화면에서 계속 사용할 수 있습니다.' : '无法进入全屏，可继续使用当前画面。'}</p>}
    {(transportError || loading) && <p className="inspection-board-banner" role="status"><AlertTriangle size={18} />{loading ? copy.loading : `${copy.connectionError} · ${copy.unavailable}`}</p>}
    <div className="inspection-board-layout">
      <section className="inspection-board-floor" aria-label={copy.choose}>
        {[machines.slice(0, 6), machines.slice(6, 12), machines.slice(12, 17)].map((group, index) => <section className="inspection-board-row" key={index}>
          <h2>{copy.range} <span>{group[0].machineNumber}–{group[group.length - 1].machineNumber}{copy.machine}</span></h2>
          <div className="inspection-board-grid">{group.map(machine => <button type="button" key={machine.machineNumber}
            data-machine-card={machine.machineNumber} className={`inspection-board-machine${selectedNumber === machine.machineNumber ? ' is-selected' : ''}`}
            aria-pressed={selectedNumber === machine.machineNumber} aria-label={`${machine.machineNumber}${copy.machine} · ${copy.first} ${copy.status[machine.qualityView.firstStatus]} · ${copy.periodic} ${copy.status[machine.qualityView.periodicStatus]}`}
            onClick={() => selectMachine(machine.machineNumber)}>
            <span className="inspection-board-machine-name">{machine.machineNumber}{copy.machine}<small>{machine.tonnage && machine.tonnage !== '-' ? `${machine.tonnage}T` : '—'}</small></span>
            <img className={`inspection-board-machine-image${machine.productionTone === 'stale' ? ' is-stale' : ''}`} src={machineImage} alt="" />
            <strong className="inspection-board-part" title={machine.currentParts.join(' + ')}>{machine.currentParts.join(' + ') || copy.noPart}</strong>
            <span className="inspection-board-production">{copy.productionShort} {number(machine.productionQuantity)}</span>
            <span className="inspection-board-mini-state" data-inspection-kind="first"><span>{copy.first}</span><StateMark state={machine.qualityView.firstStatus} text={copy.status[machine.qualityView.firstStatus]} /></span>
            <span className="inspection-board-mini-state" data-inspection-kind="periodic"><span>{copy.periodic}</span><StateMark state={machine.qualityView.periodicStatus} text={copy.status[machine.qualityView.periodicStatus]} /></span>
            <small className="inspection-board-machine-freshness">{machine.productionTone === 'stale' ? `${copy.productionShort} · ${copy.stale}` : qualityFreshness(machine)}</small>
          </button>)}</div>
        </section>)}
        <footer className="inspection-board-legend">{(['waiting', 'in_progress', 'passed', 'failed', 'unknown'] as const).map(state => <StateMark key={state} state={state} text={copy.status[state]} />)}<span>{copy.choose}</span></footer>
      </section>
      <aside className="inspection-board-detail" id="inspection-board-detail" data-testid="inspection-board-detail" data-machine-detail={selectedNumber} aria-label={`${selectedNumber}${copy.machine} ${copy.title}`}>
        <div className="inspection-board-detail-title"><strong className="inspection-board-number">{selectedNumber}{copy.machine}</strong><div><h2>{selected.currentParts.join(' + ') || copy.noPart}</h2><p>{selected.model || '—'}</p><small>{copy.currentPlan} · {selected.currentPlanId ? `#${selected.currentPlanId}` : copy.noPlan}</small></div></div>
        <div className="inspection-board-scene" data-animate={motion && checking ? 'true' : 'false'}>
          <div className="inspection-board-scene-status"><span>{copy.first} <StateMark state={view.firstStatus} text={copy.status[view.firstStatus]} /></span><span>{copy.periodic} <StateMark state={view.periodicStatus} text={copy.status[view.periodicStatus]} /></span></div>
          <img className="inspection-board-scene-machine" src={machineImage} alt="" />
          <img className="inspection-board-scene-inspector" src={inspectorImage} alt="" />
          <span className={`inspection-board-production-tone is-${selected.productionTone}`}>{copy.tone[selected.productionTone]}</span>
        </div>
        <div className="inspection-board-quantities"><div><span>{copy.production}</span><strong>{number(selected.productionQuantity)} <small>/ {number(selected.plannedQuantity)}</small></strong><small>{copy.plan} · {copy.productionHint}</small></div><div><span>{copy.inspectionQty}</span><strong className="inspection-board-unconfirmed" data-testid="inspection-quantity">{copy.quantityUnknown}</strong><small>{copy.quantityHint}</small></div></div>
        <div className="inspection-board-actions"><Link to="/quality/inspection-requests" className="inspection-board-record"><ClipboardList size={23} />{copy.record}<ArrowUpRight size={19} /></Link><div><span>{copy.inspection}</span><strong>{copy.status[view.periodicStatus]}</strong></div><div><span>{copy.saved}</span><strong className="inspection-board-unconfirmed" data-testid="inspection-save-status">{copy.saveUnknown}</strong></div></div>
        <section className="inspection-board-observations"><div className="inspection-board-section-heading"><h3>{copy.observations}</h3><Link to="/quality/inspection-requests" data-testid="inspection-history"><History size={16} />{copy.history}<ArrowUpRight size={14} /></Link></div>
          <div className="inspection-board-observation-summary"><span>{view.historical ? `${copy.historical} · ` : ''}{copy.status.passed} <b>{data ? view.counts.passed : '—'}</b> · {copy.status.failed} <b>{data ? view.counts.failed : '—'}</b> {copy.count}</span><small>{!data?.complete ? copy.incomplete : ''}</small></div>
          {observations.length ? <ol className="inspection-board-observation-list">{observations.map((item, index) => <li key={`${item.kind}-${index}`}><StateMark state={item.status} text={copy.status[item.status]} /><time dateTime={item.checked_at ?? undefined}>{time(item.checked_at)}</time><small>{item.kind === 'first' ? copy.first : item.kind === 'periodic' ? copy.periodic : copy.inspection}</small></li>)}</ol> : <p className="inspection-board-empty">{copy.empty}</p>}
          <p className="inspection-board-history-hint">{copy.historyHint}</p>
        </section>
        <div className="inspection-board-disposition"><AlertTriangle size={20} /><div><strong>{copy.disposition} · {view.counts.failed > 0 ? `${view.historical ? `${copy.historical} ` : ''}${copy.failedObservation} ${view.counts.failed}${copy.count}` : copy.dispositionUnknown}</strong><small>{copy.dispositionHint}</small></div></div>
        <div className={`inspection-board-sync${fresh ? ' is-fresh' : ''}`}><AlertTriangle size={19} /><div><strong>{qualityFreshness(selected)} · {copy.lastSync} {time(data?.last_success_at)}</strong>{!fresh && <small>{copy.unavailable}</small>}</div><button type="button" aria-label={copy.refresh} disabled={refreshing} onClick={refresh}><RefreshCw size={17} /></button></div>
        <InjectionQualityStatus state={selected.qualityState} expectedScope={selected.qualityScope} language={language} nowMs={nowMs} transportError={transportError} />
        <p className="inspection-board-motion-note">{copy.motionNote}</p>
      </aside>
    </div>
    <footer className="inspection-board-footer"><Link to="/boards/injection"><ArrowLeft size={15} />{copy.injectionBoard}</Link><span>{copy.date} {businessDate} · Asia/Shanghai</span></footer>
  </main>;
}
