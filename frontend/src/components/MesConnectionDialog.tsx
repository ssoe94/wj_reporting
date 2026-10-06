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

  const loadStatus = useCallback(async () => {
    if (!isCurrent() || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await api.get('/mes-connection/', {
        signal: controller.signal, authSessionId: sessionId,
      });
      if (isCurrent() && request.current === controller && !controller.signal.aborted) {
        const next = parseMesConnectionStatus(response.data);
        if (!next.can_connect) clearTicket();
        setStatus(next);
        if (next.status === 'connected') setNotice(null);
      }
    } catch {
      if (isCurrent() && request.current === controller && !controller.signal.aborted) {
        clearTicket(); setStatus(null); setError(true);
      }
    } finally {
      if (request.current === controller) {
        inFlight.current = false;
        if (isCurrent()) setBusy(false);
      }
    }
  }, [clearTicket, isCurrent, sessionId]);

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

  const prepare = async () => {
    if (!isCurrent() || inFlight.current || isLoggingOut || !status?.enabled || !status.can_connect || !sessionId) return;
    clearTicket();
    setNotice(null);
    setError(false);
    setBusy(true);
    inFlight.current = true;
    const startedAt = Date.now();
    request.current = new AbortController();
    try {
      const response = await api.post('/mes-connection/launch/', {}, {
        signal: request.current.signal, authSessionId: sessionId,
      });
      if (!isCurrent()) return;
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
      if (isCurrent()) { clearTicket(); setError(true); }
    } finally {
      inFlight.current = false;
      if (isCurrent()) setBusy(false);
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
    // A second explicit user gesture submits the secret only in the POST body.
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
            <p className="mt-2 text-sm text-slate-600">{ko ? 'MES 작업 권한은 작업을 수행할 때 별도로 확인합니다.' : '执行 MES 操作时会另行检查操作权限。'}</p>
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
            {notice === 'opened' ? (ko ? '새 창에서 연결을 마친 뒤 이 탭으로 돌아와 주세요. 검사 화면과 입력 내용은 이 탭에 유지됩니다. 창이 열리지 않거나 연결을 취소했다면 다시 준비해 주세요.' : '请在新窗口完成连接后返回此标签页，检查页面和已输入内容会保留。若窗口未打开或已取消连接，请重新准备。')
              : notice === 'expired' ? (ko ? '연결 준비 시간이 지났습니다. 다시 준비해 주세요.' : '连接准备已过期，请重新准备。')
                : (ko ? 'MES 연결을 해제했습니다.' : '已断开 MES 连接。')}
          </p>}
          <div className="mt-5 flex flex-wrap gap-2">
            {launch ? (
              <form method="post" action={MES_SESSION_SUBMIT_URL} target="_blank" rel="noopener" onSubmit={submit}>
                <input ref={ticketInput} type="hidden" name="ticket" value={launch.ticket} readOnly autoComplete="off" />
                <Button type="submit" disabled={disabled}>{ko ? 'MES 연결 화면 열기' : '打开 MES 连接页面'}</Button>
              </form>
            ) : <Button type="button" disabled={disabled || !status?.enabled || !status.can_connect} onClick={() => { void prepare(); }}>{ko ? '연결 준비' : '准备连接'}</Button>}
            <Button type="button" variant="secondary" disabled={disabled || !status?.can_disconnect} onClick={() => { void disconnect(); }}>{ko ? '연결 해제' : '断开连接'}</Button>
            <Button type="button" variant="ghost" disabled={disabled} onClick={() => { void loadStatus(); }}>{ko ? '상태 확인' : '检查状态'}</Button>
          </div>
          {launch && <p className="mt-2 text-sm text-slate-600">{ko ? '1분 안에 열어 주세요. 연결 화면은 새 창으로 열립니다. 팝업이 차단되면 이 사이트의 팝업을 허용한 뒤 다시 준비해 주세요.' : '请在一分钟内打开，连接页面将在新窗口中打开。如弹窗被拦截，请允许此网站弹窗后重新准备。'}</p>}
          <div className="mt-5 flex justify-end"><Button type="button" variant="ghost" onClick={() => { clearTicket(); onClose(); }}>{ko ? '닫기' : '关闭'}</Button></div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
