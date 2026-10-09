import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  deriveInjectionQuality,
  type ExpectedInjectionQualityScope,
  type InjectionQualityState,
  type PublicQualityCheck,
  type QualityCheckStatus,
  type QualityWarning,
} from '../injection-quality-status';
import './InjectionQualityStatus.css';

export interface InjectionQualityStatusProps {
  state?: InjectionQualityState | null;
  expectedScope: ExpectedInjectionQualityScope;
  language: 'ko' | 'zh';
  transportError?: boolean;
  /** Optional shared board clock. Otherwise this component wakes only at known deadlines. */
  nowMs?: number;
}

type QualityTone = 'ok' | 'wait' | 'bad' | 'none';

/** Traffic-light tone: passed green, waiting/in progress amber, failed red, unknown gray. */
function qualityTone(status: QualityCheckStatus): QualityTone {
  if (status === 'passed') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'waiting' || status === 'in_progress') return 'wait';
  return 'none';
}

const COPY = {
  ko: {
    title: '품질 검사 현황', first: '초품검사', periodic: '타임체크', other: '분류 미확인·기타',
    status: { unknown: '미확인', waiting: '대기', in_progress: '진행', passed: '합격', failed: '불합격' },
    freshness: { unavailable: '미확인', fresh: '동기화됨', stale: '갱신 지연', fixture: '시험 자료' },
    error: '연결 오류', details: '검사 현황 자세히', close: '닫기', sync: '마지막 동기화',
    observed: '자료 조회 시각', checked: '검사 완료', last: '최근 관측 결과', due: '다음 예정',
    schedule: { unverified: '주기 미확인', unknown: '예정 미확인', scheduled: '예정', overdue: '지연' },
    history: '이전 관측', incomplete: '검사 목록 확인이 완료되지 않았습니다.', empty: '확인된 검사 자료 없음',
    unresolved: '현재 생산계획과 MES 작업의 연결을 확인하지 못했습니다.',
    stale: '현재 상태는 미확인입니다. 아래 개별 결과는 마지막으로 받은 관측 자료입니다.',
    machine: '호기', summary: '전체 상태', count: '건',
    warnings: {
      snapshot_type_unverified: '검사 유형 확인 필요', duplicate_qc_evidence: '중복 검사 자료',
      plan_name_type_mismatch: '검사 이름과 실제 유형 불일치', current_task_binding_unresolved: '현재 작업 연결 미확인',
      read_scope_mismatch: '이전 생산계획의 응답', periodic_series_unresolved: '검사방안별 타임체크 관계 미확인',
      quality_projection_unavailable: '품질 상태를 불러오지 못했습니다.',
    },
  },
  zh: {
    title: '质量检验状态', first: '首检', periodic: '巡检', other: '类型待确认·其他',
    status: { unknown: '待确认', waiting: '待检', in_progress: '进行中', passed: '合格', failed: '不合格' },
    freshness: { unavailable: '待确认', fresh: '已同步', stale: '更新延迟', fixture: '测试资料' },
    error: '连接异常', details: '查看检验状态', close: '关闭', sync: '最后同步',
    observed: '资料查询时间', checked: '检验完成', last: '最近观测结果', due: '下次计划',
    schedule: { unverified: '周期待确认', unknown: '计划待确认', scheduled: '已计划', overdue: '已逾期' },
    history: '历史观测', incomplete: '检验列表尚未确认完整。', empty: '暂无已确认的检验资料',
    unresolved: '当前生产计划与 MES 生产任务的关联尚未确认。',
    stale: '当前状态待确认。以下单项结果为最后收到的观测资料。',
    machine: '号机', summary: '整体状态', count: '项',
    warnings: {
      snapshot_type_unverified: '检验类型待确认', duplicate_qc_evidence: '检验资料重复',
      plan_name_type_mismatch: '名称与实际检验类型不一致', current_task_binding_unresolved: '当前任务关联待确认',
      read_scope_mismatch: '上一个生产计划的响应', periodic_series_unresolved: '不同检验方案的巡检关系待确认',
      quality_projection_unavailable: '无法加载质量状态。',
    },
  },
} as const;

export function InjectionQualityStatus({ state, expectedScope, language, transportError = false, nowMs }: InjectionQualityStatusProps) {
  const copy = COPY[language];
  const [open, setOpen] = useState(false);
  const [, wakeAtDeadline] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  const now = nowMs ?? Date.now();
  const view = deriveInjectionQuality(state, expectedScope, now, { transportError });
  const data = view.data;
  const freshUntil = data?.fresh_until;
  const nextDue = data?.periodic.next_due_at;

  // This is a local display deadline, never a provider polling interval.
  useEffect(() => {
    if (nowMs !== undefined) return;
    const clock = Date.now();
    const deadlines = [freshUntil, nextDue].flatMap(value => value ? [Date.parse(value)] : [])
      .filter(value => Number.isFinite(value) && value > clock);
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => wakeAtDeadline(value => value + 1),
      Math.min(2_147_483_647, Math.max(1, Math.min(...deadlines) - clock + 1)));
    return () => window.clearTimeout(timer);
  }, [freshUntil, nextDue, nowMs, now]);

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const returnFocus = trigger.current;
    if (!element) return;
    element.showModal();
    close.current?.focus();
    return () => {
      element.close();
      returnFocus?.focus();
    };
  }, [open]);

  const formatTime = (value: string | null | undefined) => value
    ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'ko-KR', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'Asia/Shanghai', timeZoneName: 'short', hour12: false,
    }).format(new Date(value)) : '—';
  const freshnessText = view.availability === 'error' ? copy.error : copy.freshness[view.freshness];
  const statusText = `${copy.first} ${copy.status[view.firstStatus]} · ${copy.periodic} ${copy.status[view.periodicStatus]}`;
  const periodicOverdue = view.scheduleStatus === 'overdue';
  const firstTone = qualityTone(view.firstStatus);
  const periodicTone = periodicOverdue ? 'bad' : qualityTone(view.periodicStatus);
  const bandStatus = (status: QualityCheckStatus) => status === 'failed' ? (language === 'ko' ? '불량' : '不合格') : copy.status[status];
  const firstText = `${copy.first} ${bandStatus(view.firstStatus)}`;
  const periodicText = `${copy.periodic} ${periodicOverdue ? copy.schedule.overdue : bandStatus(view.periodicStatus)}`;
  // Show the next due time only while the schedule is verified and not yet overdue.
  const nextDueLabel = view.scheduleStatus === 'scheduled' && data?.periodic.next_due_at
    ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'ko-KR', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai',
    }).format(new Date(data.periodic.next_due_at))
    : null;
  const failureText = view.counts.failed > 0
    ? `${view.historical ? `${copy.history} ` : ''}${copy.status.failed} ${view.counts.failed}${copy.count}` : '';
  const fullLabel = `${copy.details}: ${statusText}${failureText ? ` · ${failureText}` : ''} · ${freshnessText} · ${copy.sync} ${formatTime(data?.last_success_at)}`;
  const alertList = (values: QualityWarning[]) => values.length > 0 && (
    <ul className="injection-quality__warnings">{values.map((value, index) => <li key={`${value}-${index}`}>{copy.warnings[value]}</li>)}</ul>
  );
  const renderChecks = (items: PublicQualityCheck[]) => items.length === 0
    ? <p className="injection-quality__muted">{copy.empty}</p>
    : <ol className="injection-quality__checks">{items.map((item, index) => (
      <li key={index}>
        <span className={`injection-quality__state injection-quality__state--${item.status}`}>{copy.status[item.status]}</span>
        {item.checked_at && <span>{copy.checked} <time dateTime={item.checked_at}>{formatTime(item.checked_at)}</time></span>}
        {alertList(item.warnings)}
      </li>
    ))}</ol>;
  const section = (kind: 'first' | 'periodic', aggregate: QualityCheckStatus) => (
    <section className="injection-quality__section">
      <h3>{copy[kind]} <span className={`injection-quality__state injection-quality__state--${aggregate}`}>{copy.status[aggregate]}</span></h3>
      {renderChecks(data?.[kind].checks ?? [])}
    </section>
  );

  return <div className="injection-quality" data-quality-freshness={view.freshness}>
    <button ref={trigger} type="button" className="injection-quality__summary" aria-haspopup="dialog"
      data-first-tone={firstTone} data-periodic-tone={periodicTone}
      aria-expanded={open} aria-label={fullLabel} title={fullLabel}
      onClick={event => { event.stopPropagation(); setOpen(true); }}>
      {/* Only the two current results; history, disposition and sync details stay in the dialog. */}
      <span className="injection-quality__summary-text">
        <span className={`injection-quality__tone injection-quality__tone--${firstTone}`}>{firstText}</span>
        <span className={`injection-quality__tone injection-quality__tone--${periodicTone}`}>
          {periodicText}
          {nextDueLabel ? <span className="injection-quality__next">{language === 'ko' ? '다음' : '下次'} {nextDueLabel}</span> : null}
        </span>
      </span>
    </button>
    {open && typeof document !== 'undefined' && createPortal(
      <dialog ref={dialog} className="injection-quality-dialog" aria-labelledby={headingId} aria-describedby={descriptionId}
        onCancel={event => { event.preventDefault(); setOpen(false); }}
        onClick={event => event.stopPropagation()}>
        <div className="injection-quality-dialog__header">
          <h2 id={headingId}>{expectedScope.machineNumber}{copy.machine} · {copy.title}</h2>
          <button ref={close} type="button" onClick={() => setOpen(false)}>{copy.close}</button>
        </div>
        <p id={descriptionId} className="injection-quality__notice">
          {freshnessText}{view.historical ? ` · ${copy.stale}` : ''}
        </p>
        {(!data || data.binding_status !== 'verified') && <p>{copy.unresolved}</p>}
        {data && !data.complete && <p>{copy.incomplete}</p>}
        <p>{language === 'ko' ? '특채·폐기·재작업 상태: MES 미연동. 검사 완료는 불량조치 종료를 의미하지 않습니다.' : '让步接收、报废、返工状态：尚未关联 MES。检验完成不代表不合格处置结束。'}</p>
        <dl className="injection-quality__times">
          <dt>{copy.sync}</dt><dd>{formatTime(data?.last_success_at)}</dd>
          <dt>{copy.observed}</dt><dd>{formatTime(data?.observed_at)}</dd>
          <dt>{copy.periodic} · {copy.last}</dt><dd>{copy.status[data?.periodic.last_result ?? 'unknown']} · {formatTime(data?.periodic.last_checked_at)}</dd>
          <dt>{copy.periodic} · {copy.due}</dt><dd>{copy.schedule[view.scheduleStatus]}{data?.periodic.next_due_at ? ` · ${formatTime(data.periodic.next_due_at)}` : ''}</dd>
        </dl>
        {alertList(data?.warnings ?? [])}
        {section('first', view.firstStatus)}
        {section('periodic', view.periodicStatus)}
        {!!data?.other_checks.length && <section className="injection-quality__section"><h3>{copy.other}</h3>{renderChecks(data.other_checks)}</section>}
      </dialog>, document.body,
    )}
  </div>;
}
