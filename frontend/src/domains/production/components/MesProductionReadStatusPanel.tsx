import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { getMesReadStatus } from '../mes-read-status-api';
import { deriveMesReadStatus, isExistingMesWorkOrderCode, type MesReadStage } from '../mes-read-status';
import './MesProductionReadStatusPanel.css';

const COPY = {
  ko: {
    title: 'MES 생산·입고 현황', open: '생산·입고 현황', close: '닫기',
    scope: '생산지시·생산·입고 작업은 MES에서 수행합니다. WJ는 상태와 다음 할 일을 표시합니다.',
    workOrder: '기존 MES 생산지시 번호', placeholder: 'MES에서 확인한 기존 번호',
    query: '상태 조회', querying: '조회 중', codeRequired: '기존 MES 생산지시 번호를 확인해 입력하세요.',
    order: '생산지시', production: '생산상태', inbound: '입고상태', next: '다음 할 일',
    unknown: '미조회', observed: 'MES 조회', quantity: '보고 수량', inboundQuantity: '입고 수량', permissions: '조회 권한 확인 대상',
    qcLink: 'WJ 검사 화면', qcScope: '검사 입력·완료는 WJ 검사 화면에서 진행합니다.', empty: '이 번호로 확인된 생산지시 자료가 없습니다.',
    state: {
      loading: 'MES 상태를 조회하고 있습니다.', verified: '조회한 생산지시의 상태입니다.',
      partial: '일부 상태의 연결 근거가 부족합니다. 미확인 항목은 MES에서 확인하세요.',
      not_queried: '기존 생산지시 번호를 입력하고 상태를 조회하세요.',
      permission_required: '조회 권한 확인이 필요합니다. 생산·입고 상태는 미확인입니다.',
      connection_required: 'MES 계정 연결을 확인하세요. 생산·입고 상태는 미확인입니다.',
      unavailable: '상태를 조회하지 못했습니다. 생산·입고 상태는 미확인입니다.',
      stale: '조회 자료가 오래됐습니다. 상태를 다시 조회하세요.',
    },
  },
  zh: {
    title: 'MES 生产·入库状态', open: '生产·入库状态', close: '关闭',
    scope: '生产工单、生产及入库操作在 MES 中完成。WJ 显示状态和下一步操作。',
    workOrder: '现有 MES 工单编号', placeholder: '在 MES 中确认的现有编号',
    query: '状态查询', querying: '查询中', codeRequired: '请确认并输入现有 MES 工单编号。',
    order: '生产工单', production: '生产状态', inbound: '入库状态', next: '下一步',
    unknown: '未查询', observed: 'MES 查询', quantity: '报工数量', inboundQuantity: '入库数量', permissions: '需确认的查询权限',
    qcLink: 'WJ 检验页面', qcScope: '检验录入和完成在 WJ 检验页面操作。', empty: '此编号暂无已确认的工单资料。',
    state: {
      loading: '正在查询 MES 状态。', verified: '以下为已查询工单的状态。',
      partial: '部分状态的关联依据不足，请在 MES 中确认待核实项目。',
      not_queried: '输入现有工单编号后查询状态。',
      permission_required: '需确认查询权限。生产及入库状态待确认。',
      connection_required: '请确认 MES 账号连接。生产及入库状态待确认。',
      unavailable: '状态查询失败。生产及入库状态待确认。',
      stale: '查询资料已过期，请重新查询状态。',
    },
  },
} as const;

export function MesProductionReadStatusPanel({ businessDate, language, variant = 'dashboard' }: {
  businessDate: string;
  language: 'ko' | 'zh';
  variant?: 'dashboard' | 'board';
}) {
  const { user, authSessionId } = useAuth();
  const copy = COPY[language];
  const headingId = useId();
  const inputId = useId();
  const hintId = useId();
  const [open, setOpen] = useState(false);
  const [draftCode, setDraftCode] = useState('');
  const [invalidCode, setInvalidCode] = useState(false);
  const [, wakeAtExpiry] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const mutation = useMutation({
    mutationFn: ({ date, code, sessionId }: { date: string; code: string; actorId: number; sessionId: string | null }) => getMesReadStatus(date, code, sessionId),
    retry: false,
  });
  const code = draftCode.trim();
  const sameRequest = mutation.variables?.date === businessDate && mutation.variables?.code === code
    && mutation.variables?.actorId === user?.id && mutation.variables?.sessionId === authSessionId;
  const view = deriveMesReadStatus(sameRequest ? mutation.data : undefined, businessDate, code, {
    pending: mutation.isPending,
    failed: sameRequest && mutation.isError,
  });

  useEffect(() => {
    if (!open || variant !== 'board') return;
    const element = dialog.current;
    const returnFocus = trigger.current;
    if (!element) return;
    element.showModal();
    codeInput.current?.focus();
    return () => { element.close(); returnFocus?.focus(); };
  }, [open, variant]);

  useEffect(() => {
    const expires = mutation.data?.fresh_until;
    if (!expires) return;
    const remaining = Date.parse(expires) - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => wakeAtExpiry(value => value + 1), Math.min(remaining + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [mutation.data]);

  if (user?.is_superuser !== true) return null;

  function queryStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || !user || user.is_superuser !== true) return;
    if (!isExistingMesWorkOrderCode(code)) { setInvalidCode(true); return; }
    setInvalidCode(false);
    mutation.mutate({ date: businessDate, code, actorId: user.id, sessionId: authSessionId });
  }

  function statusCard(title: string, item: MesReadStage | undefined, inbound = false) {
    const amount = inbound ? item?.quantity : item?.reported_quantity;
    return <div className="mes-read-status__stage">
      <span>{title}</span>
      <strong className={`mes-read-status__value mes-read-status__value--${item?.state ?? 'unknown'}`}>{item?.label ?? copy.unknown}</strong>
      {amount !== undefined ? <small>{inbound ? copy.inboundQuantity : copy.quantity}: {amount} {item?.unit_name}</small> : null}
    </div>;
  }

  const content = <>
    <p className="mes-read-status__scope">{copy.scope}</p>
    <p className="mes-read-status__scope">{copy.qcScope} <Link to="/quality/inspection-requests">{copy.qcLink}</Link></p>
    <form className="mes-read-status__form" onSubmit={queryStatus}>
      <label htmlFor={inputId}>{copy.workOrder}</label>
      <div className="mes-read-status__controls">
        <input ref={codeInput} id={inputId} type="text" value={draftCode} maxLength={100} placeholder={copy.placeholder}
          autoComplete="off" spellCheck={false} disabled={mutation.isPending} aria-invalid={invalidCode || undefined}
          aria-describedby={hintId} onChange={event => { setDraftCode(event.target.value); setInvalidCode(false); }} />
        <button type="submit" className="button button--ghost" disabled={mutation.isPending} aria-busy={mutation.isPending}>
          {mutation.isPending ? copy.querying : copy.query}
        </button>
      </div>
    </form>
    <p id={hintId} className="mes-read-status__hint" role="status" aria-live="polite">
      {invalidCode ? copy.codeRequired : copy.state[view.state]}
    </p>
    {view.state === 'permission_required' && mutation.data?.required_read_permissions?.length ? <div className="mes-read-status__permissions">
      <strong>{copy.permissions}</strong>
      <ul>{mutation.data.required_read_permissions.map(item => <li key={item.name}>{item.name}</li>)}</ul>
    </div> : null}
    {view.row ? <p className="mes-read-status__identity"><strong>{view.row.code}</strong>
      {view.row.material_code ? <span>{view.row.material_code}</span> : null}
      {view.row.resource_name ? <span>{view.row.resource_name}</span> : null}
    </p> : null}
    <div className="mes-read-status__stages" aria-busy={mutation.isPending}>
      {statusCard(copy.order, view.row?.production_order)}
      {statusCard(copy.production, view.row?.production)}
      {statusCard(copy.inbound, view.row?.inbound, true)}
    </div>
    {view.row ? <div className="mes-read-status__next">
      <strong>{copy.next}</strong><p>{view.row.next_action.label}</p>
      {view.row.next_action.target === 'WJ_QC' ? <Link className="button button--ghost" to="/quality/inspection-requests">{copy.qcLink}</Link> : null}
    </div> : view.state === 'verified' ? <p className="mes-read-status__hint">{copy.empty}</p> : null}
    {view.observedAt ? <p className="mes-read-status__observed">{copy.observed}: <time dateTime={view.observedAt}>
      {new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'ko-KR', {
        timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date(view.observedAt))} (UTC+8)</time></p> : null}
  </>;

  if (variant === 'board') return <>
    <button ref={trigger} type="button" className="injection-board__history-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>{copy.open}</button>
    {open ? createPortal(<dialog ref={dialog} className="mes-read-status-dialog" aria-labelledby={headingId}
      onCancel={() => setOpen(false)} onClick={event => { if (event.target === dialog.current) setOpen(false); }}>
      <section className="mes-read-status">
        <header className="mes-read-status__header"><h2 id={headingId}>{copy.title}</h2>
          <button type="button" className="button button--ghost" onClick={() => setOpen(false)}>{copy.close}</button>
        </header>{content}
      </section>
    </dialog>, document.body) : null}
  </>;
  return <section className="panel mes-read-status" aria-labelledby={headingId}>
    <header className="mes-read-status__header"><h2 id={headingId}>{copy.title}</h2></header>{content}
  </section>;
}
