import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ClipboardCheck, Plus, RefreshCw, Search } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useLang } from '../../../i18n';
import { getInspectionCapabilities, getInspectionKanban, getInspectionRequest, getInspectionRequests } from './api';
import type { InspectionCapabilities, InspectionList, InspectionRequest } from './api';
import { inspectionCopy, inspectionDataSourceCopy, inspectionRequestStatusLabels, inspectionTime } from './copy';
import { inspectionBusinessDate } from './kanban';
import type { InspectionKanban as Kanban } from './kanban';
import { inspectionError } from './workflow';
import { inspectionNavigationGate, isCurrentInspectionEditor, nextInspectionEditor } from './navigation';
import type { InspectionEditorSelection } from './navigation';
import { useInspectionRouteLeaveGuard } from './useInspectionRouteLeaveGuard';
import InspectionKanban from './InspectionKanban';
import InspectionRequestDetail from './InspectionRequestDetail';
import NewInspectionRequest from './NewInspectionRequest';
import './InspectionRequestsPage.css';

export default function InspectionRequestsPage() {
  const { lang } = useLang();
  const { user } = useAuth();
  const text = inspectionCopy[lang];
  const [capabilities, setCapabilities] = useState<InspectionCapabilities | null>(null);
  const dataSource = inspectionDataSourceCopy(lang, capabilities?.data_mode);
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
  const detailRef = useRef<HTMLDivElement>(null);
  const kanbanRef = useRef<HTMLDivElement>(null);
  const detailFallback = useRef(text.loadError);
  detailFallback.current = text.loadError;

  const loadCapabilities = useCallback(async () => {
    setCapabilityError('');
    try { setCapabilities(await getInspectionCapabilities()); }
    catch (cause) { setCapabilityError(inspectionError(cause, inspectionCopy[lang].loadError).message); }
  }, [lang]);
  const loadKanban = useCallback(async () => {
    const sequence = ++kanbanSequence.current;
    setKanbanLoading(true); setKanbanError('');
    try {
      const result = await getInspectionKanban(businessDate);
      if (sequence === kanbanSequence.current) setKanban(result);
    } catch (cause) { if (sequence === kanbanSequence.current) setKanbanError(inspectionError(cause, inspectionCopy[lang].loadError).message); }
    finally { if (sequence === kanbanSequence.current) setKanbanLoading(false); }
  }, [businessDate, lang]);
  const loadList = useCallback(async () => {
    const sequence = ++listSequence.current;
    setLoading(true); setListError('');
    try {
      const result = await getInspectionRequests(search, status, page);
      if (sequence === listSequence.current) setList(result);
    } catch (cause) { if (sequence === listSequence.current) setListError(inspectionError(cause, inspectionCopy[lang].loadError).message); }
    finally { if (sequence === listSequence.current) setLoading(false); }
  }, [search, status, page, lang]);

  useEffect(() => { void loadCapabilities(); }, [loadCapabilities]);
  useEffect(() => { void loadKanban(); return () => { kanbanSequence.current += 1; }; }, [loadKanban]);
  useEffect(() => { void loadList(); return () => { listSequence.current += 1; }; }, [loadList]);
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (followCurrentDate) setBusinessDate(inspectionBusinessDate(now));
  }, [followCurrentDate, now]);
  useEffect(() => {
    const timer = window.setInterval(() => { void loadKanban(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadKanban]);
  useEffect(() => {
    if (selectedId === null || creating) return;
    let active = true;
    setDetailLoading(true); setDetailError(''); setDetail(null); dirty.current = false; setEditorDirty(false);
    const stillCurrent = () => active && isCurrentInspectionEditor(editor, currentEditor.current);
    void getInspectionRequest(selectedId).then((item) => { if (stillCurrent()) setDetail(item); }).catch((cause) => { if (stillCurrent()) setDetailError(inspectionError(cause, detailFallback.current).message); }).finally(() => { if (stillCurrent()) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId, creating, detailRetry, editor]);
  useEffect(() => {
    if (creating || (selectedId !== null && !detailLoading)) {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [selectedId, creating, detailLoading]);
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
    const next = nextInspectionEditor(currentEditor.current, kind, requestId);
    currentEditor.current = next; setEditor(next);
    dirty.current = false; locked.current = false; setEditorDirty(false); setEditorLocked(false); setDetail(null); setDetailLoading(kind === 'request'); setNotice('');
  }, []);
  const onDirty = useCallback((value: boolean) => {
    if (!isCurrentInspectionEditor(editor, currentEditor.current)) return;
    dirty.current = value; setEditorDirty(value);
  }, [editor]);
  const onLocked = useCallback((value: boolean) => {
    if (!isCurrentInspectionEditor(editor, currentEditor.current)) return;
    locked.current = value; setEditorLocked(value);
  }, [editor]);
  const onChanged = useCallback((updated: InspectionRequest) => {
    if (!isCurrentInspectionEditor(editor, currentEditor.current) || editor.kind !== 'request') return;
    if (updated.id !== editor.requestId) openEditor('request', updated.id);
    setDetail(updated);
    void loadList(); void loadKanban();
  }, [loadList, loadKanban, editor, openEditor]);
  const canNavigate = () => {
    const gate = inspectionNavigationGate(dirty.current, locked.current);
    return gate === 'allow' || (gate === 'confirm' && window.confirm(text.discard));
  };
  const select = (id: number) => {
    if (selectedId === id && !creating) { detailRef.current?.focus({ preventScroll: true }); detailRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); return; }
    if (!canNavigate()) return;
    openEditor('request', id);
  };
  const showCreate = () => {
    if (creating) { detailRef.current?.focus({ preventScroll: true }); detailRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); return; }
    if (!canNavigate()) return;
    openEditor('create');
  };
  const closeDetail = () => { if (!canNavigate()) return; openEditor('none'); kanbanRef.current?.focus({ preventScroll: true }); kanbanRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); };
  const filter = (event: FormEvent) => { event.preventDefault(); setSearch(query.trim()); setPage(1); };
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

  return <main className="inspection-requests-page">
    {routeGuard.blocked && createPortal(<div className="inspection-route-dialog-backdrop"><div className="inspection-route-dialog" role="alertdialog" aria-modal="true" aria-labelledby="inspection-route-leave-title" aria-describedby="inspection-route-leave-hint" tabIndex={-1} ref={leaveDialogRef} onKeyDown={trapLeaveDialogFocus}>
      <h2 id="inspection-route-leave-title">{routeGuard.canLeave ? text.routeLeaveTitle : text.routeLockedTitle}</h2>
      <p id="inspection-route-leave-hint">{routeGuard.canLeave ? editorDirty ? text.routeDirtyHint : text.routeLeaveHint : text.navigationLocked}</p>
      <div className="inspection-actions"><button ref={leaveStayRef} type="button" className="inspection-button is-primary" onClick={routeGuard.stay}>{text.routeStay}</button>{routeGuard.canLeave && <button type="button" className="inspection-button" onClick={routeGuard.leave}>{text.routeLeave}</button>}</div>
    </div></div>, document.body)}
    <header className="inspection-hero"><div><small>WJ DATA CENTER · {lang === 'ko' ? '품질' : '品质'}</small><h1>{text.title}</h1><p>{text.description}</p></div><ClipboardCheck size={42} aria-hidden="true" /></header>
    <div className="inspection-notice inspection-connection-notice" data-mode={capabilities?.data_mode || 'unconfirmed'}><AlertTriangle size={20} aria-hidden="true" /><div><strong>{dataSource.notice}</strong><p>{dataSource.hint}</p><dl className="inspection-data-sources" aria-label={text.dataSource}><div><dt>{text.plans}</dt><dd>{dataSource.plans}</dd></div><div><dt>{text.requests}</dt><dd>{dataSource.requests}</dd></div></dl></div></div>
    {capabilityError && <div className="inspection-message is-error" role="alert">{capabilityError}<div className="inspection-actions"><button type="button" className="inspection-button" onClick={() => void loadCapabilities()}>{text.retry}</button></div></div>}
    {capabilities && !capabilities.can_view ? <div className="inspection-message" role="alert">{text.denied}</div> : <>
      <div ref={kanbanRef} tabIndex={-1}><InspectionKanban snapshot={kanban?.business_date === businessDate ? kanban : null} date={businessDate} lang={lang} now={now} loading={kanbanLoading} error={kanbanError} selectedId={creating ? null : selectedId} onSelect={select}
        onDate={(value) => { setFollowCurrentDate(false); setBusinessDate(value); }} onCurrent={() => { const current = new Date(); setNow(current); setFollowCurrentDate(true); setBusinessDate(inspectionBusinessDate(current)); }} onRefresh={() => void loadKanban()} /></div>
      <div className="inspection-page-actions">{capabilities?.can_manage && <button type="button" className="inspection-button" disabled={editorLocked} onClick={showCreate}><Plus size={17} aria-hidden="true" />{text.create}</button>}<span className="inspection-muted">{lang === 'ko' ? '검사요청 카드를 선택하면 검사 항목을 입력할 수 있습니다.' : '选择检验申请卡片后填写检验项目。'}</span></div>
      {(creating || selectedId !== null) && <div className="inspection-detail-workspace" ref={detailRef} tabIndex={-1}>
        <div className="inspection-detail-navigation"><button className="inspection-button" type="button" disabled={editorLocked} onClick={closeDetail}>{lang === 'ko' ? '칸반으로' : '返回看板'}</button>{editorLocked && <p className="inspection-muted" role="status">{text.navigationLocked}</p>}</div>
        {notice && <div className="inspection-message is-success" role="status">{notice}</div>}
        {creating && user && capabilities?.can_manage ? <NewInspectionRequest key={`new-${user.id}-${editor.epoch}`} userId={user.id} lang={lang} dataMode={capabilities.data_mode} onDirty={onDirty} onLocked={onLocked} onCreated={(item) => { if (!isCurrentInspectionEditor(editor, currentEditor.current) || editor.kind !== 'create') return; openEditor('request', item.id); setDetail(item); setNotice(text.createSuccess); void loadList(); void loadKanban(); }} onCancel={closeDetail} />
          : detailLoading ? <div className="inspection-empty" role="status">{text.loading}</div>
            : detailError ? <div className="inspection-detail"><div className="inspection-message is-error" role="alert">{detailError}</div><button type="button" className="inspection-button" onClick={() => setDetailRetry((value) => value + 1)}>{text.retry}</button></div>
              : detail && user && capabilities ? <InspectionRequestDetail key={`${user.id}-${detail.id}-${editor.epoch}`} initial={detail} userId={user.id} lang={lang} globalCapabilities={capabilities} onChanged={onChanged} onDirty={onDirty} onLocked={onLocked} /> : <div className="inspection-empty">{text.select}</div>}
      </div>}
      <details className="inspection-workspace inspection-auxiliary"><summary>{lang === 'ko' ? '전체 요청 검색·목록' : '全部申请搜索·列表'}{list && ` (${list.count})`}</summary>
        <form className="inspection-toolbar" onSubmit={filter}>
          <label className="inspection-search"><Search size={19} aria-hidden="true" /><span className="sr-only">{text.search}</span><input maxLength={128} type="search" value={query} placeholder={text.search} onChange={(event) => setQuery(event.target.value)} /></label>
          <button type="submit" className="inspection-button">{lang === 'ko' ? '검색' : '搜索'}</button>
          <label><span className="sr-only">{text.filter}</span><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">{text.all}</option>{['draft', 'submitted', 'approved', 'rejected', 'failed'].map((value) => <option value={value} key={value}>{inspectionRequestStatusLabels[lang][value]}</option>)}</select></label>
          <button className="inspection-button" type="button" disabled={loading} onClick={() => void loadList()}><RefreshCw size={17} aria-hidden="true" />{text.refreshList}</button>
        </form>
        <div className="inspection-list" aria-busy={loading}>
          {listError && <div className="inspection-message is-error" role="alert">{listError}<button type="button" className="inspection-button" onClick={() => void loadList()}>{text.retry}</button></div>}
          {loading && !list && <p className="inspection-empty" role="status">{text.loading}</p>}
          {list && list.results.length === 0 && <p className="inspection-empty">{text.empty}</p>}
          {list && <ul>{list.results.map((item) => <li key={item.id}><button type="button" className="inspection-list-row" disabled={editorLocked && selectedId !== item.id} aria-current={!creating && selectedId === item.id ? 'true' : undefined} onClick={() => select(item.id)}>
            <div><strong>#{item.id} · {item.work_order_ref}</strong><span className="inspection-status" data-status={item.status}>{inspectionRequestStatusLabels[lang][item.status] || item.status}</span></div>
            <p>{item.part_no} · {item.equipment_ref}</p><small>{text.task}: {item.task_ref} · {item.target_quantity} {item.uom}</small>
            <small>{text.owner}: {item.assigned_to_name || text.unassigned}</small><small>{inspectionTime(item.created_at, lang)}</small>
            <small>{text.source}: {dataSource.requests}</small>
          </button></li>)}</ul>}
          {list && <div className="inspection-pagination"><button type="button" className="inspection-button" disabled={loading || !list.previous} onClick={() => setPage((value) => Math.max(1, value - 1))}>{text.previous}</button><span>{page}</span><button type="button" className="inspection-button" disabled={loading || !list.next} onClick={() => setPage((value) => value + 1)}>{text.next}</button></div>}
        </div>
      </details>
      <details className="inspection-guide"><summary>{text.guideTitle}</summary><p>{text.guideStop}</p><p>{text.guideResume}</p><p>{text.guidePending}</p></details>
    </>}
  </main>;
}
