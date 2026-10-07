import { IntegrationTrialBadge } from './TrialPresentation';
import { isIntegrationTrial, integrationTrialCopy } from './integrationTrial';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Plus, RefreshCw, Search, Users } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { subscribeToAuthStorage } from '@/domains/auth/auth-storage';
import { assertAuthSessionCurrent, isAuthSessionCurrent, registerAuthTransitionGuard } from '@/domains/auth/auth-transition';
import { useLang } from '../../../i18n';
import { getInspectionCapabilities, getInspectionKanban, getInspectionRequest, getInspectionRequests } from './api';
import type { InspectionCapabilities, InspectionList, InspectionRequest } from './api';
import { inspectionCopy, inspectionRequestStatusLabels, inspectionTime } from './copy';
import { inspectionBusinessDate } from './kanban';
import type { InspectionKanban as Kanban } from './kanban';
import { inspectionError } from './workflow';
import { inspectionConfirmsScopedRefresh, inspectionNavigationGate, isCurrentInspectionEditor, nextInspectionEditor } from './navigation';
import { refreshInspectionProjectionQueries } from './mesWorkflowResult';
import type { InspectionEditorSelection } from './navigation';
import { useInspectionRouteLeaveGuard } from './useInspectionRouteLeaveGuard';
import InspectionStationPicker from './InspectionStationPicker';
import InspectionRequestDetail from './InspectionRequestDetail';
import NewInspectionRequest from './NewInspectionRequest';
import RoleSettings from './RoleSettings';
import InspectionRoomTeam from './InspectionRoomTeam';
import MesDetailPreview from './MesDetailPreview';
import './InspectionRequestsPage.css';

export default function InspectionRequestsPage() {
  const queryClient = useQueryClient();
  const { lang } = useLang();
  const { user, authSessionId, isLoggingOut } = useAuth();
  const [sessionId] = useState(authSessionId);
  const [inspector] = useState(user);
  const [staleSession, setStaleSession] = useState(() => !isAuthSessionCurrent(sessionId));
  const [transitionMessage, setTransitionMessage] = useState('');
  const mounted = useRef(true);
  const requestPending = useRef(false);
  const ownsSession = useCallback(() => {
    if (!mounted.current) return false;
    try { assertAuthSessionCurrent(sessionId); return true; } catch { return false; }
  }, [sessionId]);
  const text = inspectionCopy[lang];
  const [capabilities, setCapabilities] = useState<InspectionCapabilities | null>(null);
  const canView = capabilities?.can_view === true && ['all', 'assigned_only'].includes(capabilities.access_scope);
  const assignedOnly = canView && capabilities?.access_scope === 'assigned_only';
  const canViewKanban = canView && capabilities?.access_scope === 'all' && capabilities.can_view_kanban === true;
  const [capabilityError, setCapabilityError] = useState('');
  const [kanban, setKanban] = useState<Kanban | null>(null);
  const [businessDate, setBusinessDate] = useState(() => inspectionBusinessDate());
  const [followCurrentDate, setFollowCurrentDate] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const [kanbanLoading, setKanbanLoading] = useState(false);
  const [kanbanError, setKanbanError] = useState('');
  const [list, setList] = useState<InspectionList | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [editor, setEditor] = useState<InspectionEditorSelection>({ epoch: 0, kind: 'none', requestId: null });
  const currentEditor = useRef(editor);
  const selectedId = editor.kind === 'request' ? editor.requestId : null;
  const creating = editor.kind === 'create';
  const [showRoleSettings, setShowRoleSettings] = useState(false);
  const [selectedMachine, setSelectedMachine] = useState<number | null>(null);
  const [editorLocked, setEditorLocked] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const locked = useRef(false);
  const [detail, setDetail] = useState<InspectionRequest | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailRetry, setDetailRetry] = useState(0);
  const [notice, setNotice] = useState('');
  const dirty = useRef(false);
  const routeGuard = useInspectionRouteLeaveGuard(dirty, locked);
  const leaveDialogRef = useRef<HTMLDivElement>(null);
  const leaveStayRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const listSequence = useRef(0);
  const kanbanSequence = useRef(0);
  const capabilitySequence = useRef(0);
  const detailRef = useRef<HTMLDivElement>(null);
  const kanbanRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const detailFallback = useRef(text.loadError);
  detailFallback.current = text.loadError;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const checkSession = () => { if (!isAuthSessionCurrent(sessionId)) setStaleSession(true); };
    checkSession();
    return subscribeToAuthStorage(checkSession, true);
  }, [sessionId]);
  useEffect(() => registerAuthTransitionGuard(sessionId, () => {
    if (!isAuthSessionCurrent(sessionId)) return false;
    if (requestPending.current) { setTransitionMessage(text.inspectorPending); return false; }
    if (dirty.current && !window.confirm(text.inspectorDraftConfirm)) return false;
    return isAuthSessionCurrent(sessionId);
  }), [sessionId, text.inspectorPending, text.inspectorDraftConfirm]);

  const loadCapabilities = useCallback(async () => {
    if (!ownsSession()) return;
    const sequence = ++capabilitySequence.current;
    setCapabilityError(''); setCapabilities(null);
    try { const result = await getInspectionCapabilities(sessionId); if (ownsSession() && sequence === capabilitySequence.current) setCapabilities(result); }
    catch (cause) { if (ownsSession() && sequence === capabilitySequence.current) setCapabilityError(inspectionError(cause, detailFallback.current).message); }
  }, [ownsSession, sessionId]);
  const loadKanban = useCallback(async () => {
    if (!ownsSession() || !canViewKanban) return;
    const sequence = ++kanbanSequence.current;
    setKanbanLoading(true); setKanbanError('');
    try {
      const result = await getInspectionKanban(businessDate, sessionId);
      if (ownsSession() && sequence === kanbanSequence.current) setKanban(result);
    } catch (cause) { if (ownsSession() && sequence === kanbanSequence.current) setKanbanError(inspectionError(cause, inspectionCopy[lang].loadError).message); }
    finally { if (ownsSession() && sequence === kanbanSequence.current) setKanbanLoading(false); }
  }, [businessDate, lang, ownsSession, sessionId, canViewKanban]);
  const loadList = useCallback(async () => {
    if (!ownsSession() || !canView) return;
    const sequence = ++listSequence.current;
    setLoading(true); setListError('');
    try {
      const result = await getInspectionRequests(search, status, page, sessionId);
      if (ownsSession() && sequence === listSequence.current) setList(result);
    } catch (cause) { if (ownsSession() && sequence === listSequence.current) setListError(inspectionError(cause, inspectionCopy[lang].loadError).message); }
    finally { if (ownsSession() && sequence === listSequence.current) setLoading(false); }
  }, [search, status, page, lang, ownsSession, sessionId, canView]);

  useEffect(() => { void loadCapabilities(); }, [loadCapabilities]);
  useEffect(() => { void loadKanban(); return () => { kanbanSequence.current += 1; }; }, [loadKanban]);
  useEffect(() => { void loadList(); return () => { listSequence.current += 1; }; }, [loadList]);
  useEffect(() => {
    if (!canView) return;
    const timer = window.setInterval(() => { if (ownsSession()) setNow(new Date()); }, 60_000);
    return () => window.clearInterval(timer);
  }, [ownsSession, canView]);
  useEffect(() => {
    if (ownsSession() && canViewKanban && followCurrentDate) setBusinessDate(inspectionBusinessDate(now));
  }, [followCurrentDate, now, ownsSession, canViewKanban]);
  useEffect(() => {
    if (!canViewKanban) return;
    const timer = window.setInterval(() => { void loadKanban(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadKanban, canViewKanban]);
  useEffect(() => {
    if (selectedId === null || creating || !ownsSession() || !canView) return;
    let active = true;
    setDetailLoading(true); setDetailError(''); setDetail(null); dirty.current = false; setEditorDirty(false);
    const stillCurrent = () => active && ownsSession() && isCurrentInspectionEditor(editor, currentEditor.current);
    void getInspectionRequest(selectedId, sessionId).then((item) => { if (stillCurrent()) setDetail(item); }).catch((cause) => { if (stillCurrent()) setDetailError(inspectionError(cause, detailFallback.current).message); }).finally(() => { if (stillCurrent()) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId, creating, detailRetry, editor, ownsSession, sessionId, canView]);
  useEffect(() => {
    if (ownsSession() && (creating || (selectedId !== null && !detailLoading))) {
      detailRef.current?.focus({ preventScroll: true });
      if (creating) detailRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [selectedId, creating, detailLoading, ownsSession]);
  useEffect(() => {
    if (routeGuard.blocked) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      leaveStayRef.current?.focus({ preventScroll: true });
      const retainFocus = (event: FocusEvent) => {
        if (event.target instanceof Node && !leaveDialogRef.current?.contains(event.target)) leaveStayRef.current?.focus({ preventScroll: true });
      };
      document.addEventListener('focusin', retainFocus);
      return () => { document.removeEventListener('focusin', retainFocus); };
    } else {
      if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
      previousFocus.current = null;
    }
  }, [routeGuard.blocked]);

  const openEditor = useCallback((kind: InspectionEditorSelection['kind'], requestId: number | null = null) => {
    if (!ownsSession()) return;
    const next = nextInspectionEditor(currentEditor.current, kind, requestId);
    setShowRoleSettings(false);
    currentEditor.current = next; setEditor(next);
    dirty.current = false; locked.current = false; requestPending.current = false; setEditorDirty(false); setEditorLocked(false); setDetail(null); setDetailLoading(kind === 'request'); setNotice('');
  }, [ownsSession]);
  const onDirty = useCallback((value: boolean) => {
    if (!ownsSession() || !isCurrentInspectionEditor(editor, currentEditor.current)) return;
    dirty.current = value; setEditorDirty(value);
  }, [editor, ownsSession]);
  const onLocked = useCallback((value: boolean, pending: boolean) => {
    if (!ownsSession() || !isCurrentInspectionEditor(editor, currentEditor.current)) return;
    locked.current = value; requestPending.current = pending; setEditorLocked(value);
  }, [editor, ownsSession]);
  const onChanged = useCallback((updated: InspectionRequest) => {
    if (!ownsSession() || !isCurrentInspectionEditor(editor, currentEditor.current) || editor.kind !== 'request') return;
    if (updated.id !== editor.requestId) openEditor('request', updated.id);
    setDetail(updated);
    void loadList(); void loadKanban();
    if (updated.mes_workflow && updated.mes_workflow.phase !== 'unbound' && inspectionConfirmsScopedRefresh(updated)) refreshInspectionProjectionQueries(queryClient);
  }, [loadList, loadKanban, editor, openEditor, ownsSession, queryClient]);
  const canNavigate = () => {
    if (!ownsSession()) return false;
    const gate = inspectionNavigationGate(dirty.current, locked.current);
    return gate === 'allow' || (gate === 'confirm' && window.confirm(text.discard));
  };
  const select = (id: number) => {
    if (!ownsSession() || !canView) return;
    if (selectedId === id && !creating) { detailRef.current?.focus({ preventScroll: true }); return; }
    if (!canNavigate()) return;
    setSelectedMachine(kanban?.machines.find((machine) => machine.requests.some((request) => request.id === id))?.machine_number ?? null);
    openEditor('request', id);
  };
  const selectMachine = (machine: number, id: number | null) => {
    if (selectedMachine === machine && selectedId === id && !creating && !showRoleSettings) { detailRef.current?.focus({ preventScroll: true }); return; }
    if (!ownsSession() || !canViewKanban || !canNavigate()) return;
    setSelectedMachine(machine);
    if (id !== selectedId || creating || showRoleSettings) openEditor(id === null ? 'none' : 'request', id);
  };
  const showCreate = () => {
    if (!ownsSession() || !canView || capabilities?.can_manage !== true) return;
    if (creating) { detailRef.current?.focus({ preventScroll: true }); detailRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); return; }
    if (!canNavigate()) return;
    openEditor('create');
  };
  const openRoleSettings = () => {
    if (!ownsSession() || !canView || capabilities?.can_manage_role_settings !== true || !canNavigate()) return;
    openEditor('none'); setShowRoleSettings(true);
    window.setTimeout(() => { detailRef.current?.focus({ preventScroll: true }); detailRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); }, 0);
  };
  const closeDetail = () => { if (!canNavigate()) return; openEditor('none'); const target = canViewKanban ? kanbanRef.current : listRef.current; target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'start', behavior: 'instant' }); };
  const filter = (event: FormEvent) => { event.preventDefault(); if (!ownsSession()) return; setSearch(query.trim()); setPage(1); };
  const trapLeaveDialogFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); routeGuard.stay(); return; }
    if (event.key !== 'Tab') return;
    event.stopPropagation();
    const controls = leaveDialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    if (!controls?.length) { event.preventDefault(); leaveDialogRef.current?.focus(); return; }
    const first = controls[0]; const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const requestList = <>
        <form className="inspection-toolbar" onSubmit={filter}>
          {capabilities?.can_manage && <button type="button" className="inspection-button" disabled={editorLocked || isLoggingOut || staleSession} onClick={showCreate}><Plus size={16} aria-hidden="true" />{text.create}</button>}
          <label className="inspection-search"><Search size={19} aria-hidden="true" /><span className="sr-only">{text.search}</span><input maxLength={128} type="search" value={query} placeholder={text.search} onChange={(event) => { if (ownsSession()) setQuery(event.target.value); }} /></label>
          <button type="submit" className="inspection-button">{lang === 'ko' ? '검색' : '搜索'}</button>
          <label><span className="sr-only">{text.filter}</span><select value={status} onChange={(event) => { if (!ownsSession()) return; setStatus(event.target.value); setPage(1); }}><option value="">{text.all}</option>{['draft', 'submitted', 'approved', 'rejected', 'failed'].map((value) => <option value={value} key={value}>{inspectionRequestStatusLabels[lang][value]}</option>)}</select></label>
          <button className="inspection-button" type="button" disabled={loading} onClick={() => void loadList()}><RefreshCw size={17} aria-hidden="true" />{text.refreshList}</button>
        </form>
        <div className="inspection-list" aria-busy={loading}>
          {listError && <div className="inspection-message is-error" role="alert">{listError}<button type="button" className="inspection-button" onClick={() => void loadList()}>{text.retry}</button></div>}
          {loading && !list && <p className="inspection-empty" role="status">{text.loading}</p>}
          {list && list.results.length === 0 && <p className="inspection-empty">{text.empty}</p>}
          {list && <ul>{list.results.map((item) => <li key={item.id}><button type="button" className="inspection-list-row" disabled={editorLocked && selectedId !== item.id} aria-current={!creating && selectedId === item.id ? 'true' : undefined} onClick={() => select(item.id)}>
            <div><strong>#{item.id} · {item.work_order_ref}</strong><span className="inspection-status" data-status={item.status}>{isIntegrationTrial(item) ? `${integrationTrialCopy[lang].title} · ${inspectionRequestStatusLabels[lang][item.status] || item.status}` : inspectionRequestStatusLabels[lang][item.status] || item.status}</span></div>
            {isIntegrationTrial(item) && <><IntegrationTrialBadge lang={lang} /><small>{integrationTrialCopy[lang].excluded}</small></>}
            <p>{item.part_no} · {item.equipment_ref}</p><small>{text.task}: {item.task_ref} · {item.target_quantity} {item.uom}</small>
            <small>{text.owner}: {item.assigned_to_name || text.unassigned}</small><small>{inspectionTime(item.created_at, lang)}</small>
          </button></li>)}</ul>}
          {list && <div className="inspection-pagination"><button type="button" className="inspection-button" disabled={loading || !list.previous} onClick={() => { if (ownsSession()) setPage((value) => Math.max(1, value - 1)); }}>{text.previous}</button><span>{page}</span><button type="button" className="inspection-button" disabled={loading || !list.next} onClick={() => { if (ownsSession()) setPage((value) => value + 1); }}>{text.next}</button></div>}
        </div>
  </>;

  return <main className="inspection-requests-page">
    {!staleSession && routeGuard.blocked && createPortal(<div className="inspection-route-dialog-backdrop"><div className="inspection-route-dialog" role="alertdialog" aria-modal="true" aria-labelledby="inspection-route-leave-title" aria-describedby="inspection-route-leave-hint" tabIndex={-1} ref={leaveDialogRef} onKeyDown={trapLeaveDialogFocus}>
      <h2 id="inspection-route-leave-title">{routeGuard.canLeave ? text.routeLeaveTitle : text.routeLockedTitle}</h2>
      <p id="inspection-route-leave-hint">{routeGuard.canLeave ? editorDirty ? text.routeDirtyHint : text.routeLeaveHint : text.navigationLocked}</p>
      <div className="inspection-actions"><button ref={leaveStayRef} type="button" className="inspection-button is-primary" onClick={routeGuard.stay}>{text.routeStay}</button>{routeGuard.canLeave && <button type="button" className="inspection-button" onClick={routeGuard.leave}>{text.routeLeave}</button>}</div>
    </div></div>, document.body)}
    <header className="inspection-hero"><h1>{text.title}</h1>{canView && <InspectionRoomTeam sessionId={sessionId} lang={lang} now={now} refreshKey={showRoleSettings} />}<div className="inspection-header-actions">{canViewKanban && capabilities?.can_manage && <button type="button" className="inspection-button" disabled={editorLocked || isLoggingOut || staleSession} onClick={showCreate}><Plus size={16} aria-hidden="true" />{text.create}</button>}
      {canView && capabilities?.can_manage_role_settings && <button type="button" className="inspection-button" disabled={editorLocked || isLoggingOut || staleSession} onClick={openRoleSettings}><Users size={16} aria-hidden="true" />{lang === 'ko' ? '담당자·교대 설정' : '负责人·班次设置'}</button>}
    </div></header>
    {transitionMessage && <div className="inspection-message" role="status">{transitionMessage}</div>}
    {staleSession ? <div className="inspection-message is-error" role="alert">{text.inspectorSessionChanged}</div> : <fieldset className="inspection-session-scope" disabled={isLoggingOut} aria-label={text.title}>
    {capabilityError && <div className="inspection-message is-error" role="alert">{capabilityError}<div className="inspection-actions"><button type="button" className="inspection-button" onClick={() => void loadCapabilities()}>{text.retry}</button></div></div>}
    {!capabilities && !capabilityError && <div className="inspection-message" role="status">{text.checkingAccess}</div>}
    {capabilities && !canView && <div className="inspection-message" role="alert">{text.denied}</div>}
    {canView && <>
      {canViewKanban && <div ref={kanbanRef} tabIndex={-1}><InspectionStationPicker snapshot={kanban?.business_date === businessDate ? kanban : null} date={businessDate} lang={lang} loading={kanbanLoading} error={kanbanError} selectedMachine={selectedMachine} selectedId={selectedId} locked={editorLocked} onMachine={selectMachine} onSelect={select}
        onDate={(value) => { if (!ownsSession() || !canNavigate()) return; openEditor('none'); setSelectedMachine(null); setFollowCurrentDate(false); setBusinessDate(value); }} onRefresh={() => void loadKanban()} /></div>}
      {assignedOnly && <section className="inspection-workspace inspection-assigned-workspace" aria-labelledby="inspection-assigned-title" ref={listRef} tabIndex={-1}><header className="inspection-assigned-heading"><h2 id="inspection-assigned-title">{text.assignedRequests}{list && ` (${list.count})`}</h2><p>{text.assignedHint}</p></header>{requestList}</section>}
      {(showRoleSettings || creating || selectedId !== null) && <div className="inspection-detail-workspace" ref={detailRef} tabIndex={-1}>
        {(showRoleSettings || creating) && <div className="inspection-detail-navigation"><button className="inspection-button" type="button" disabled={editorLocked} onClick={closeDetail}>{canViewKanban ? text.returnToKanban : text.returnToList}</button>{editorLocked && <p className="inspection-muted" role="status">{text.navigationLocked}</p>}</div>}
        {notice && <div className="inspection-message is-success" role="status">{notice}</div>}
        {showRoleSettings && inspector ? <RoleSettings userId={inspector.id} sessionId={sessionId} lang={lang} onDirty={onDirty} onLocked={onLocked} onClose={closeDetail} /> : creating && inspector && capabilities?.can_manage ? <NewInspectionRequest key={`new-${inspector.id}-${editor.epoch}`} userId={inspector.id} sessionId={sessionId} lang={lang} dataMode={capabilities.data_mode} canPrepareIntegrationTrial={capabilities.can_prepare_integration_trial === true} onDirty={onDirty} onLocked={onLocked} onCreated={(item) => { if (!ownsSession() || !isCurrentInspectionEditor(editor, currentEditor.current) || editor.kind !== 'create') return; openEditor('request', item.id); setDetail(item); setNotice(text.createSuccess); void loadList(); void loadKanban(); }} onCancel={closeDetail} />
          : detailLoading ? <div className="inspection-empty" role="status">{text.loading}</div>
            : detailError ? <div className="inspection-detail"><div className="inspection-message is-error" role="alert">{detailError}</div><button type="button" className="inspection-button" onClick={() => { if (ownsSession()) setDetailRetry((value) => value + 1); }}>{text.retry}</button></div>
              : detail && inspector && capabilities ? <InspectionRequestDetail key={`${inspector.id}-${detail.id}-${editor.epoch}`} initial={detail} userId={inspector.id} sessionId={sessionId} lang={lang} globalCapabilities={capabilities} onChanged={onChanged} onDirty={onDirty} onLocked={onLocked} onOpenSettings={capabilities.can_manage_role_settings ? openRoleSettings : undefined} /> : <div className="inspection-empty">{text.select}</div>}
      </div>}
      {canViewKanban && !showRoleSettings && !creating && selectedId === null && <div className="inspection-station-placeholder">{selectedMachine === null ? (lang === 'ko' ? '설비를 선택하면 검사 항목을 바로 입력할 수 있습니다.' : '选择设备后可直接填写检验项目。') : (lang === 'ko' ? '이 설비에는 표시된 검사요청이 없습니다.' : '此设备没有显示的检验申请。')}</div>}
      {!canViewKanban && !assignedOnly && <section className="inspection-workspace" ref={listRef} tabIndex={-1}>{requestList}</section>}
      {inspector?.id === 18 && <details className="inspection-fold inspection-secondary-tool"><summary>{lang === 'ko' ? 'MES 검사 기준 조회' : '查询 MES 检验标准'}</summary><MesDetailPreview actorId={inspector.id} sessionId={sessionId} lang={lang} disabled={editorLocked || isLoggingOut} /></details>}

    </>}
    </fieldset>}
  </main>;
}
