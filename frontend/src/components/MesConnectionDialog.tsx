import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { Button } from './ui/button';
import { useLang } from '../i18n';
import { useAuth } from '../contexts/AuthContext';
import api from '../lib/api';
import { getAuthSessionSnapshot, subscribeToAuthStorage } from '../domains/auth/auth-storage';
import { assertAuthSessionCurrent } from '../domains/auth/auth-transition';
import {
  MES_SESSION_SUBMIT_URL, isDisconnectConfirmed, isMesLaunchUsable, mesConnectionDiagnostic,
  parseMesConnectionStatus, parseMesLaunch,
  type MesConnectionStatus, type MesLaunch,
} from '../domains/auth/mes-connection';

export default function MesConnectionDialog({ onClose }: { onClose: () => void }) {
  const { lang } = useLang();
  const { isLoggingOut } = useAuth();
  const ko = lang === 'ko';
  const [sessionId] = useState(() => getAuthSessionSnapshot().id);
  const [status, setStatus] = useState<MesConnectionStatus | null>(null);
  const [launch, setLaunch] = useState<MesLaunch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState<'opened' | 'expired' | 'disconnected' | null>(null);
  const [copyNotice, setCopyNotice] = useState<'factory' | 'account' | 'failed' | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const request = useRef<AbortController | null>(null);
  const ticket = useRef<MesLaunch | null>(null);
  const ticketInput = useRef<HTMLInputElement>(null);
  const expiryTimer = useRef<number | null>(null);
  const submissionTimer = useRef<number | null>(null);
  const submitted = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const confirmedStatus = useRef<MesConnectionStatus | null>(null);
  const preparationAttempted = useRef(false);
  const loggingOut = useRef(isLoggingOut);
  loggingOut.current = isLoggingOut;

  const clearTicket = useCallback(() => {
    ticket.current = null;
    if (ticketInput.current) ticketInput.current.value = '';
    if (expiryTimer.current !== null) window.clearTimeout(expiryTimer.current);
    expiryTimer.current = null;
    if (mounted.current) setLaunch(null);
  }, []);

  const isCurrent = useCallback(() => {
    if (!mounted.current) return false;
    try { assertAuthSessionCurrent(sessionId); return true; } catch { return false; }
  }, [sessionId]);

  const prepare = useCallback(async (candidate: MesConnectionStatus | null) => {
    if (!isCurrent() || inFlight.current || loggingOut.current || !sessionId
      || candidate !== confirmedStatus.current || !candidate?.enabled || !candidate.can_connect
      || !['disconnected', 'reconnect_required'].includes(candidate.status)) return;
    // Preparing only the current WJ account's one-use bridge ticket makes no
    // provider request. The user still opens MES with a native form gesture.
    preparationAttempted.current = true;
    clearTicket();
    setNotice(null);
    setError(false);
    setBusy(true);
    inFlight.current = true;
    const startedAt = Date.now();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await api.post('/mes-connection/launch/', {}, {
        signal: controller.signal, authSessionId: sessionId,
      });
      if (!isCurrent() || request.current !== controller || controller.signal.aborted) return;
      const prepared = parseMesLaunch(response.data, sessionId, startedAt);
      if (!isMesLaunchUsable(prepared, sessionId, Date.now())) throw new Error('Launch expired');
      submitted.current = false;
      ticket.current = prepared;
      setLaunch(prepared);
      expiryTimer.current = window.setTimeout(() => {
        clearTicket();
        if (isCurrent()) setNotice('expired');
      }, prepared.expiresAt - Date.now());
    } catch {
      if (isCurrent() && request.current === controller && !controller.signal.aborted) {
        clearTicket(); setError(true);
      }
    } finally {
      if (request.current === controller) {
        inFlight.current = false;
        // A failed logout may retain this dialog after the ending latch clears.
        // Settle its loading UI without accepting any late response or ticket.
        if (mounted.current) setBusy(false);
      }
    }
  }, [clearTicket, isCurrent, sessionId]);

  const loadStatus = useCallback(async () => {
    if (!isCurrent() || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    const controller = new AbortController();
    request.current = controller;
    let next: MesConnectionStatus | null = null;
    try {
      const response = await api.get('/mes-connection/', {
        signal: controller.signal, authSessionId: sessionId,
      });
      if (isCurrent() && request.current === controller && !controller.signal.aborted) {
        next = parseMesConnectionStatus(response.data);
        confirmedStatus.current = next;
        if (!next.can_connect || !['disconnected', 'reconnect_required'].includes(next.status)) clearTicket();
        setStatus(next);
        if (next.status === 'connected') setNotice(null);
      }
    } catch {
      if (isCurrent() && request.current === controller && !controller.signal.aborted) {
        confirmedStatus.current = null;
        clearTicket(); setStatus(null); setError(true);
      }
    } finally {
      if (request.current === controller) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
    // At most one automatic preparation per dialog. Return/focus/status checks
    // never replace a submitted, expired or failed ticket without another click.
    if (!preparationAttempted.current && isCurrent() && request.current === controller
      && !controller.signal.aborted && next) await prepare(next);
  }, [clearTicket, isCurrent, prepare, sessionId]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeToAuthStorage(() => {
      if (getAuthSessionSnapshot().id !== sessionId) {
        clearTicket();
        request.current?.abort();
        onCloseRef.current();
      }
    }, true);
    // The original tab and its inspection draft remain in place. Recheck with
    // the server on return; a popup message or successful window.open is not
    // evidence of a connected MES identity.
    const onReturn = () => {
      if (submitted.current && document.visibilityState === 'visible') void loadStatus();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    void loadStatus();
    return () => {
      mounted.current = false;
      unsubscribe();
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
      request.current?.abort();
      inFlight.current = false;
      clearTicket();
      if (submissionTimer.current !== null) window.clearTimeout(submissionTimer.current);
    };
  }, [clearTicket, loadStatus, sessionId]);

  const copyLoginHint = async (field: 'factory' | 'account') => {
    const hint = status?.login_hint;
    if (!isCurrent() || isLoggingOut || !hint) return;
    setCopyNotice(null);
    try {
      await navigator.clipboard.writeText(field === 'factory' ? hint.factory_number : hint.account_name);
      if (isCurrent()) setCopyNotice(field);
    } catch {
      if (isCurrent()) setCopyNotice('failed');
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    if (!isCurrent() || isLoggingOut || submitted.current
      || !isMesLaunchUsable(ticket.current, getAuthSessionSnapshot().id, Date.now())) {
      event.preventDefault();
      clearTicket();
      setNotice('expired');
      return;
    }
    // The explicit user gesture submits the secret only in the POST body.
    // Let the browser serialize the native form before clearing its input.
    submitted.current = true;
    event.currentTarget.action = MES_SESSION_SUBMIT_URL;
    submissionTimer.current = window.setTimeout(() => {
      clearTicket();
      if (isCurrent()) setNotice('opened');
    }, 0);
  };

  const disconnect = async () => {
    if (!isCurrent() || inFlight.current || isLoggingOut || !status?.can_disconnect) return;
    preparationAttempted.current = true;
    clearTicket();
    setNotice(null);
    setError(false);
    setBusy(true);
    inFlight.current = true;
    request.current = new AbortController();
    let confirmed = false;
    try {
      const response = await api.post('/mes-connection/disconnect/', {}, {
        signal: request.current.signal, authSessionId: sessionId,
      });
      if (!isCurrent()) return;
      if (!isDisconnectConfirmed(response.data)) throw new Error('Unconfirmed disconnect');
      confirmed = true;
      setNotice('disconnected');
      setStatus(null);
    } catch {
      if (isCurrent()) setError(true);
    } finally {
      inFlight.current = false;
      if (isCurrent()) setBusy(false);
    }
    if (confirmed && isCurrent()) await loadStatus();
  };

  const labels = ko ? {
    disabled: '현재 MES 연결을 사용할 수 없습니다.', disconnected: 'MES에 연결되지 않았습니다.',
    connected: 'MES 계정이 연결되어 있습니다.', reconnect_required: 'MES 계정을 다시 연결해 주세요.',
    blocked: '현재 계정으로 MES에 연결할 수 없습니다.',
  } : {
    disabled: '目前无法连接 MES。', disconnected: '尚未连接 MES。',
    connected: 'MES 账号已连接。', reconnect_required: '请重新连接 MES 账号。',
    blocked: '当前账号无法连接 MES。',
  };
  const disabled = busy || isLoggingOut;
  const diagnostic = status ? mesConnectionDiagnostic(status.reason, ko ? 'ko' : 'zh') : null;
  const canPrepare = status?.enabled && status.can_connect
    && ['disconnected', 'reconnect_required'].includes(status.status);
  const connectLabel = status?.status === 'reconnect_required'
    ? (ko ? 'MES 다시 연결' : '重新连接 MES') : (ko ? 'MES 연결' : '连接 MES');
  const expiry = status?.expires_at ? new Intl.DateTimeFormat(ko ? 'ko-KR' : 'zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(status.expires_at)) : null;

  return (
    <Dialog open onClose={() => { clearTicket(); onClose(); }} className="relative z-[100]">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center overflow-y-auto p-4">
        <DialogPanel className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
          <DialogTitle className="text-xl font-bold text-slate-900">{ko ? 'MES 연결' : 'MES 连接'}</DialogTitle>
          <p className="mt-4 text-base text-slate-700" aria-live="polite">
            {status ? labels[status.status] : busy ? (ko ? '연결 상태 확인 중…' : '正在检查连接状态…') : (ko ? '연결 상태를 확인해 주세요.' : '请检查连接状态。')}
          </p>
          {diagnostic && (
            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700" role="status">
              <p>{diagnostic.message}</p>
              <p className="mt-2 break-all text-xs text-slate-600">{ko ? '진단코드' : '诊断代码'}: <code>{diagnostic.code}</code></p>
            </div>
          )}
          {status?.status === 'connected' && (
            <div className="mt-2 text-sm text-slate-600">
              <p>{status.mode === 'stored_identity'
                ? (ko ? '현재 사용자의 유효한 MES 연결을 자동으로 재사용합니다.' : '自动复用当前用户的有效 MES 连接。')
                : (ko ? '현재 사용자의 MES 신원을 확인했습니다.' : '已确认当前用户的 MES 身份。')}</p>
              {expiry && <p>{ko ? '연결 만료 예정' : '连接预计到期'}: {expiry} ({ko ? '중국시간' : '中国时间'})</p>}
              <p>{ko ? 'MES 작업 권한은 작업을 수행할 때 별도로 확인합니다.' : '执行 MES 操作时会另行检查操作权限。'}</p>
            </div>
          )}
          {status?.login_hint && (status.can_connect || launch) && (
            <div className="mt-4 rounded-lg bg-slate-50 p-3">
              <p className="text-sm text-slate-700">{ko ? '공식 MES 화면에서 아래 계정으로 로그인해 주세요. 비밀번호는 MES 화면에 직접 입력합니다.' : '请在 MES 官方页面使用以下账号登录，并在 MES 页面直接输入密码。'}</p>
              <div className="mt-3 flex items-end gap-2">
                <label className="min-w-0 flex-1 text-sm text-slate-700">{ko ? '공장번호' : '工厂编号'}
                  <input className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-base" value={status.login_hint.factory_number} readOnly autoComplete="off" />
                </label>
                <Button type="button" variant="secondary" disabled={isLoggingOut} onClick={() => { void copyLoginHint('factory'); }}>{ko ? '공장번호 복사' : '复制工厂编号'}</Button>
              </div>
              <div className="mt-2 flex items-end gap-2">
                <label className="min-w-0 flex-1 text-sm text-slate-700">{ko ? 'MES 로그인 ID' : 'MES 登录账号'}
                  <input className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-base" value={status.login_hint.account_name} readOnly autoComplete="off" />
                </label>
                <Button type="button" variant="secondary" disabled={isLoggingOut} onClick={() => { void copyLoginHint('account'); }}>{ko ? 'ID 복사' : '复制账号'}</Button>
              </div>
              <p className="mt-2 text-sm text-slate-600">{ko ? '다른 검사자는 먼저 WJ의 검사자를 변경해 주세요. 위 계정과 다른 MES 계정은 연결할 수 없습니다.' : '其他检验员请先切换 WJ 检验员。无法连接与上方账号不同的 MES 账号。'}</p>
              {copyNotice && <p role="status" className="mt-2 text-sm text-slate-700">{copyNotice === 'failed'
                ? (ko ? '복사할 수 없습니다. 위 값을 선택해 직접 복사해 주세요.' : '无法复制，请选中上方内容手动复制。')
                : copyNotice === 'factory' ? (ko ? '공장번호를 복사했습니다.' : '已复制工厂编号。') : (ko ? 'MES 로그인 ID를 복사했습니다.' : '已复制 MES 登录账号。')}</p>}
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-red-700">{ko ? '요청 완료를 확인할 수 없습니다. 상태를 확인한 뒤 다시 시도해 주세요.' : '无法确认请求是否完成。请检查状态后重试。'}</p>}
          {notice && <p role="status" className="mt-3 text-sm text-slate-700">
            {notice === 'opened' ? (ko ? 'MES 화면에서 ‘WJ Lee 신원 확인’을 한 번 눌러 주세요. 현재 WJ 사용자에게 연결할 MES 계정으로 로그인되어 있어야 합니다. 다른 계정이면 MES에서 전환해 주세요.' : '请在 MES 页面点击一次“WJ Lee 신원 확인”。需登录当前 WJ 用户对应的 MES 账号；账号不符时请在 MES 切换。')
              : notice === 'expired' ? (ko ? '연결 준비 시간이 지났습니다. 다시 준비해 주세요.' : '连接准备已过期，请重新准备。')
                : (ko ? 'MES 연결을 해제했습니다.' : '已断开 MES 连接。')}
          </p>}
          <div className="mt-5 flex flex-wrap gap-2">
            {launch ? (
              <form method="post" action={MES_SESSION_SUBMIT_URL} target="_blank" rel="noopener" onSubmit={submit}>
                <input ref={ticketInput} type="hidden" name="ticket" value={launch.ticket} readOnly autoComplete="off" />
                <Button type="submit" disabled={disabled}>{connectLabel}</Button>
              </form>
            ) : status?.status !== 'connected' && <Button type="button" disabled={disabled || !canPrepare} onClick={() => { void prepare(confirmedStatus.current); }}>{busy && canPrepare
              ? (ko ? '연결 준비 중…' : '正在准备连接…') : notice || error || preparationAttempted.current
                ? (ko ? '다시 연결 준비' : '重新准备连接') : connectLabel}</Button>}
            <Button type="button" variant="secondary" disabled={disabled || !status?.can_disconnect} onClick={() => { void disconnect(); }}>{ko ? '연결 해제' : '断开连接'}</Button>
            <Button type="button" variant="ghost" disabled={disabled} onClick={() => { void loadStatus(); }}>{ko ? '상태 확인' : '检查状态'}</Button>
          </div>
          {launch && <p className="mt-2 text-sm text-slate-600">{ko ? '새 창에서 연결합니다. 1분 안에 눌러 주세요.' : '将在新窗口连接。请在一分钟内点击。'}</p>}
          <div className="mt-5 flex justify-end"><Button type="button" variant="ghost" onClick={() => { clearTicket(); onClose(); }}>{ko ? '닫기' : '关闭'}</Button></div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
