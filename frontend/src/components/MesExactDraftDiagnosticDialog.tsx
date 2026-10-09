import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { useAuth } from '../contexts/AuthContext';
import { useLang } from '../i18n';
import { getAuthSessionSnapshot, subscribeToAuthStorage } from '../domains/auth/auth-storage';
import { assertAuthSessionCurrent } from '../domains/auth/auth-transition';
import { getExactDraftDiagnostic, postExactDraftDiagnostic, type ExactDraftAction } from '../domains/production/exact-draft-diagnostic-api';
import { canUseExactDraftDiagnostic, exactDraftActions, exactDraftAttemptKey, exactDraftLabel,
  type ExactDraftSnapshot } from '../domains/production/exact-draft-diagnostic';
import './MesExactDraftDiagnosticDialog.css';

type Props = { onClose: () => void; onReconnect: (requestUid: string) => void; sendAttempts: Set<string> };

export default function MesExactDraftDiagnosticDialog({ onClose, onReconnect, sendAttempts }: Props) {
  const { lang } = useLang();
  const ko = lang === 'ko';
  const language = ko ? 'ko' : 'zh';
  const { user, authSessionId, isLoggingOut } = useAuth();
  const [sessionId] = useState(authSessionId);
  const [snapshot, setSnapshot] = useState<ExactDraftSnapshot | null>(null);
  const [busy, setBusy] = useState<'read' | 'write' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  const currentRequest = useRef<AbortController | null>(null);
  const inFlight = useRef<'read' | 'write' | null>(null);
  const latest = useRef<ExactDraftSnapshot | null>(null);
  const identity = useRef({ user, isLoggingOut });
  const closeRef = useRef(onClose);
  const reconnectOpening = useRef(false);
  identity.current = { user, isLoggingOut };
  closeRef.current = onClose;

  const isCurrent = useCallback(() => {
    if (!mounted.current || !sessionId || identity.current.isLoggingOut
      || !canUseExactDraftDiagnostic(identity.current.user)
      || getAuthSessionSnapshot().id !== sessionId) return false;
    try { assertAuthSessionCurrent(sessionId); return true; } catch { return false; }
  }, [sessionId]);

  const run = useCallback(async (action: 'status' | ExactDraftAction) => {
    if (!isCurrent() || !sessionId || inFlight.current) return;
    const data = latest.current;
    const alreadySent = Boolean(data?.request_uid && sendAttempts.has(exactDraftAttemptKey(sessionId, data.request_uid)));
    const allowed = exactDraftActions(data, Date.now(), alreadySent, true);
    if (action !== 'status' && !allowed[action]) return;
    if (action === 'send') {
      // Retained by App for this session/request even after close and reopen.
      // A lost response permits only an explicit status read / readback.
      sendAttempts.add(exactDraftAttemptKey(sessionId, data!.request_uid!));
    }
    const controller = new AbortController();
    currentRequest.current = controller;
    inFlight.current = action === 'status' ? 'read' : 'write';
    setBusy(inFlight.current); setError(null);
    if (action === 'status') { latest.current = null; setSnapshot(null); }
    try {
      const next = action === 'status'
        ? await getExactDraftDiagnostic(sessionId, controller.signal)
        : await postExactDraftDiagnostic(action, data?.request_uid || null, sessionId, controller.signal);
      if (!isCurrent() || currentRequest.current !== controller || controller.signal.aborted) return;
      latest.current = next; setSnapshot(next); setNow(Date.now());
    } catch (caught) {
      if (!isCurrent() || currentRequest.current !== controller || controller.signal.aborted) return;
      latest.current = null; setSnapshot(null);
      const status = (caught as { response?: { status?: number } }).response?.status;
      setError(status === 403 ? 'permission_denied' : 'operation_unconfirmed');
    } finally {
      if (currentRequest.current === controller) {
        currentRequest.current = null; inFlight.current = null;
        if (mounted.current) setBusy(null);
      }
    }
  }, [isCurrent, sendAttempts, sessionId]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeToAuthStorage(() => {
      if (!isCurrent()) { currentRequest.current?.abort(); closeRef.current(); }
    }, true);
    // Opening and language changes cannot prepare a permit or send an order.
    void run('status');
    return () => { mounted.current = false; unsubscribe(); currentRequest.current?.abort(); inFlight.current = null; };
  }, [isCurrent, run]);

  useEffect(() => {
    if (!snapshot?.approval.expires_at) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot?.approval.expires_at]);

  const locallyAttempted = Boolean(sessionId && snapshot?.request_uid
    && sendAttempts.has(exactDraftAttemptKey(sessionId, snapshot.request_uid)));
  const actions = exactDraftActions(snapshot, now, locallyAttempted, !busy && isCurrent());
  const formatTime = (value: string | null) => value ? new Intl.DateTimeFormat(ko ? 'ko-KR' : 'zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value)) : '—';
  const expiry = snapshot?.approval.expires_at;
  const remaining = expiry ? Math.max(0, Math.ceil((Date.parse(expiry) - now) / 60000)) : 0;
  const close = () => { if (inFlight.current !== 'write') closeRef.current(); };
  const reconnect = () => {
    if (!isCurrent() || inFlight.current || reconnectOpening.current || !sessionId) return;
    const data = latest.current;
    const attempted = Boolean(data?.request_uid && sendAttempts.has(exactDraftAttemptKey(sessionId, data.request_uid)));
    if (!exactDraftActions(data, Date.now(), attempted, true).reconnect || !data?.request_uid) return;
    reconnectOpening.current = true;
    onReconnect(data.request_uid);
  };

  return <Dialog open onClose={close} className="mes-exact-draft-root">
    <div className="mes-exact-draft-backdrop" aria-hidden="true" />
    <div className="mes-exact-draft-layout"><DialogPanel className="mes-exact-draft-panel">
      <header className="mes-exact-draft-header">
        <DialogTitle>{ko ? '단건 工单 진단' : '单工单诊断'}</DialogTitle>
        <span>{ko ? '일상 MES 전송 OFF' : '日常 MES 发送 OFF'}</span>
      </header>
      <div className="mes-exact-draft-body">
        <p className="mes-exact-draft-flow">{ko ? 'permit 준비 → 이 준비번호로 MES 재연결 → 승인된 단건 전송' : '准备许可 → 使用此准备编号重新连接 MES → 发送已批准的单个工单'}</p>
        <dl className="mes-exact-draft-scope">
          <dt>工单</dt><dd><strong>WJ-IT-CREATE-20261009-001</strong></dd>
          <dt>{ko ? '제품 / 수량' : '产品 / 数量'}</dt><dd>code 0 · 1 个 · draft</dd>
          <dt>{ko ? '중국시간' : '中国时间'}</dt><dd>2026-10-10 08:00 → 10-11 08:00</dd>
          <dt>{ko ? '배정 / 동작' : '分配 / 操作'}</dt><dd>{ko ? '설비·원료·공정 미배정 · 下达·开工·입출고·삭제 요청 없음' : '设备、原料、工艺未分配 · 无下达、开工、出入库或删除请求'}</dd>
        </dl>
        <div className="mes-exact-draft-status" role="status" aria-live="polite">
          {error ? exactDraftLabel(error, language) : snapshot ? exactDraftLabel(snapshot.state, language)
            : busy ? (ko ? '읽기 상태 확인 중…' : '正在读取状态…') : (ko ? '읽기 상태를 확인하세요.' : '请读取状态。')}
          {snapshot && <span>{ko ? 'MES 전송 시도' : 'MES 发送尝试'} {snapshot.attempt} / 1{locallyAttempted && snapshot.attempt === 0 ? (ko ? ' · 응답 미확인, 재전송 금지' : ' · 未确认响应，不可重发') : ''}</span>}
        </div>
        {snapshot && <>
          <dl className="mes-exact-draft-permit">
            <dt>{ko ? '준비번호' : '准备编号'}</dt><dd>{snapshot.request_uid || '—'}</dd>
            <dt>{ko ? '승인 reference' : '批准 reference'}</dt><dd>{snapshot.approval.reference || '—'}</dd>
            <dt>{ko ? '승인 / 만료' : '批准 / 到期'}</dt><dd>{formatTime(snapshot.approval.approved_at)} → {formatTime(snapshot.approval.expires_at)}
              {expiry && <span> · {remaining > 0 && !snapshot.approval.expired ? (ko ? `${remaining}분 남음` : `剩余 ${remaining} 分钟`) : (ko ? '만료' : '已到期')}</span>} · {ko ? '최대 1회' : '最多 1 次'}</dd>
            <dt>{ko ? '기존 연결 / APP' : '现有连接 / APP'}</dt><dd>{snapshot.connection.status === 'ready' ? (ko ? '연결 확인됨' : '已核对连接') : snapshot.connection.status === 'reconnect_required' ? (ko ? '정상 MES 재연결 필요' : '需正常重新连接 MES') : (ko ? '연결 확인 필요' : '需核对连接')} · {snapshot.app_supply.available ? (ko ? 'APP 사용 가능' : 'APP 可用') : (ko ? 'APP 공급 확인 필요' : '需核对 APP 供应')} · APP {snapshot.approval.app_attempt} / 1</dd>
          </dl>
          {!!snapshot.blockers.length && <p className="mes-exact-draft-notice">{snapshot.blockers.map(code => exactDraftLabel(code, language)).filter((text, index, all) => all.indexOf(text) === index).join(' ')}</p>}
          {snapshot.result && <div className="mes-exact-draft-result">
            {snapshot.result.work_order_id && <p>MES #{snapshot.result.work_order_id}</p>}
            <p>{ko ? 'draft 스냅샷' : '草稿快照'}: {snapshot.result.draft_snapshot_matches ? (ko ? '일치' : '一致') : (ko ? '확인 필요' : '需确认')} · {ko ? '작업' : '任务'} {snapshot.result.task_count ?? '—'} · {ko ? '입출고 변경' : '出入库变更'} {snapshot.result.inventory_change_count ?? '—'}</p>
            <p>{ko ? '전역·지연 효과와 전체 원료 workflow는 별도 검증이 필요합니다.' : '全局或延迟效果及完整原料流程需要另行验证。'}</p>
          </div>}
        </>}
        <div className="mes-exact-draft-actions">
          <button type="button" className="btn btn-outline" disabled={Boolean(busy) || isLoggingOut} onClick={() => void run('status')}>{ko ? '읽기 상태 확인' : '读取状态'}</button>
          <button type="button" className="btn btn-outline" disabled={!actions.prepare} onClick={() => void run('prepare')}>{ko ? 'permit 준비 · 최대 30분' : '准备许可 · 最长 30 分钟'}</button>
          <button type="button" className="btn btn-outline" disabled={!actions.reconnect} onClick={reconnect}>{ko ? '이 준비번호로 MES 재연결' : '使用此准备编号重新连接 MES'}</button>
          <button type="button" className="btn btn-primary" disabled={!actions.send} onClick={() => void run('send')}>{ko ? '승인된 단건 1회 전송' : '批准的单工单发送 1 次'}</button>
          {snapshot?.can_recheck && <button type="button" className="btn btn-outline" disabled={!actions.recheck} onClick={() => void run('recheck')}>{ko ? 'MES 재조회만' : '仅复查 MES'}</button>}
        </div>
      </div>
      <footer className="mes-exact-draft-footer"><button type="button" className="btn btn-outline" disabled={busy === 'write'} onClick={close}>{ko ? '닫기' : '关闭'}</button></footer>
    </DialogPanel></div>
  </Dialog>;
}
