import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { canAccessHr } from '../../domains/auth/hr-access';
import { getHrRoster } from '../../domains/hr/api';
import type { HrRosterEntry } from '../../domains/hr/workbook-types';
import { useLang } from '../../i18n';
import HrRosterPanel from './HrRosterPanel';
import { currentHrMonth, HrLoadState, HrShell } from './hrCommon';

type RosterResult = { scope: string; entries: HrRosterEntry[] };
export default function RosterPage() {
  const { user } = useAuth(); const allowed = canAccessHr(user);
  const { lang } = useLang(); const ko = lang === 'ko';
  const [month, setMonth] = useState(currentHrMonth);
  const scope = `${user?.id}:${month}`;
  const [result, setResult] = useState<RosterResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<{ scope: string; denied: boolean } | null>(null);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const entries = allowed && result?.scope === scope ? result.entries : null;
  const error = failure?.scope === scope ? failure.denied
    ? (ko ? '인사 자료를 조회할 권한이 없습니다.' : '没有查看人事资料的权限。')
    : (ko ? '명부를 불러오지 못했습니다. 다시 시도해 주세요.' : '无法加载人员名册，请重试。') : '';
  const refresh = () => setReload((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    if (!allowed) { setResult(null); setLoading(false); return () => controller.abort(); }
    setLoading(true);
    getHrRoster(month, controller.signal).then((items) => {
      if (!controller.signal.aborted) setResult({ scope, entries: items });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        setFailure({ scope, denied: status === 401 || status === 403 });
        if (status === 401 || status === 403) setResult(null);
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [allowed, month, scope, reload]);
  useEffect(() => {
    if (!editing && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const onLink = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(target instanceof HTMLAnchorElement) || target.target === '_blank' || target.hasAttribute('download') || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const next = new URL(target.href, window.location.href);
      if (next.href === window.location.href) return;
      if (busy || !window.confirm(ko ? '저장하지 않은 명부 편집을 버리고 이동할까요?' : '放弃未保存的名册编辑并离开吗？')) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('beforeunload', beforeUnload); document.addEventListener('click', onLink, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', onLink, true); };
  }, [editing, busy, ko]);
  function changeMonth(next: string) {
    if (busy || next === month) return;
    if (editing && !window.confirm(ko ? '저장하지 않은 명부 편집을 버리고 대상 월을 바꿀까요?' : '放弃未保存的名册编辑并切换月份吗？')) return;
    setEditing(false); setMonth(next);
  }
  if (!allowed) return <main className="hr-page"><HrLoadState allowed={false} loading={false} error="" retry={refresh} /></main>;
  return <HrShell page="roster" month={month} onMonthChange={changeMonth} monthDisabled={busy}>
    {entries === null ? <HrLoadState allowed={allowed} loading={loading || !error} error={error} retry={refresh} />
      : <HrRosterPanel key={scope} month={month} entries={entries}
        onUpdated={(items) => setResult({ scope, entries: items })} error={Boolean(error)} onRetry={refresh}
        disabled={loading || Boolean(error)} onEditChange={setEditing} onBusyChange={setBusy} />}
  </HrShell>;
}
