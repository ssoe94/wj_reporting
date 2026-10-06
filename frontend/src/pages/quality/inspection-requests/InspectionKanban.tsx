import { useState } from 'react';
import MesReadObservationCard from './MesReadObservationCard';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { inspectionCopy, inspectionRequestStatusLabels, inspectionTime } from './copy';
import { inspectionKanbanCopy } from './kanbanCopy';
import { inspectionDisplayPlans, inspectionElapsedMinutes, inspectionPlanAlignment, inspectionRequestKind, inspectionRequestStage, inspectionStageCounts } from './kanban';
import type { InspectionKanban as Kanban, InspectionPlan, KanbanInspectionRequest } from './kanban';
import { filterInspectionManagement, inspectionPredatesBusinessDay } from './managementFilters';
import type { ManagementFilter } from './managementFilters';



function inspectionElapsedLabel(createdAt: string, now: Date, lang: 'ko' | 'zh'): string {
  const minutes = inspectionElapsedMinutes(createdAt, now);
  if (minutes === null) return '—';
  const text = inspectionKanbanCopy[lang];
  if (minutes < 60) return `${minutes}${text.minute}`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}${text.hour} ${minutes % 60}${text.minute}`;
  return `${Math.floor(minutes / 1440)}${text.dayUnit} ${Math.floor(minutes % 1440 / 60)}${text.hour}`;
}

export default function InspectionKanban({ snapshot, date, lang, now, loading, error, selectedId, onSelect, onDate, onCurrent, onRefresh }: {
  snapshot: Kanban | null; date: string; lang: 'ko' | 'zh'; now: Date; loading: boolean; error: string; selectedId: number | null;
  onSelect: (id: number) => void; onDate: (date: string) => void; onCurrent: () => void; onRefresh: () => void;
}) {
  const text = inspectionKanbanCopy[lang];
  const common = inspectionCopy[lang];
  const requests = snapshot ? [...snapshot.machines.flatMap((machine) => machine.requests), ...snapshot.unmapped_requests] : [];
  const counts = inspectionStageCounts(requests);
  const [filter, setFilter] = useState<ManagementFilter>({ stage: 'all', machine: 'all', search: '' });
  const visible = snapshot ? filterInspectionManagement(snapshot, filter) : null;
  const filtered = filter.stage !== 'all' || filter.machine !== 'all' || filter.search.trim() !== '';
  const stageOptions = [
    { value: 'all', label: text.allStages, count: requests.length },
    { value: 'waiting', label: text.filterWaiting, count: counts.waiting },
    { value: 'in_progress', label: text.filterProgress, count: counts.in_progress },
    { value: 'completed', label: text.filterCompleted, count: counts.completed },
    { value: 'blocked', label: text.filterBlocked, count: counts.blocked },
  ] as const;
  const plan = (item: InspectionPlan) => <li key={item.id}><strong>{item.part_no || text.noPart}</strong><span>{item.execution_status === 'running' ? text.running : item.execution_status === 'paused' ? text.paused : text.scheduled} · {text.seq} {item.sequence}</span>{item.lot_no && <span>{text.lot}: {item.lot_no}</span>}</li>;
  const request = (item: KanbanInspectionRequest) => {
    const stage = inspectionRequestStage(item);
    const kind = inspectionRequestKind(item);
    const alignment = inspectionPlanAlignment(item);
    return <li key={item.id}><button type="button" className="inspection-kanban-request" aria-current={selectedId === item.id ? 'true' : undefined} onClick={() => onSelect(item.id)}>
      <div className="inspection-kanban-request-heading"><strong>{text[kind]} <small>#{item.id}</small></strong><span className="inspection-status" data-stage={stage}>{text[stage]}</span></div>
      <p>{item.part_no || text.noPart}</p><span>{common.workOrder}: {item.work_order_ref}</span><span>{common.task}: {item.task_ref}</span>
      <span>{item.parent ? `${common.parent}: #${item.parent} · ` : ''}{text.owner}: {item.assigned_to_name || common.unassigned}</span>
      {item.nonconformance && <span className="inspection-status" data-status="failed">{lang === 'ko' ? '불량조치 미해결' : '不合格处置未解决'}</span>}
      <span>{text.localReview}: {inspectionRequestStatusLabels[lang][item.status] || item.status}</span>
      {stage !== 'completed' && <span className="inspection-wait">{text.elapsed} {inspectionElapsedLabel(item.created_at, now, lang)}</span>}
      {stage !== 'completed' && snapshot && inspectionPredatesBusinessDay(item.created_at, snapshot.day_start) && <small>{text.previousDayOpen}</small>}
      <span className="inspection-plan-alignment" data-alignment={alignment}>{alignment === 'part_listed' ? text.listed : alignment === 'part_not_listed' ? text.discrepancy : text.alignmentUnknown}</span>
      <small>{item.source_kind === 'local_manual' ? common.local : item.source_kind}</small>
    </button></li>;
  };
  const candidates = { review_pause: 0, review_resume: 0, review_alignment: 0 };
  snapshot?.machines.forEach((machine) => { if (machine.dry_run.candidate in candidates) candidates[machine.dry_run.candidate as keyof typeof candidates] += 1; });

  return <section className="inspection-kanban" aria-labelledby="inspection-kanban-title" aria-busy={loading}>
    <div className="inspection-kanban-toolbar"><h2 id="inspection-kanban-title">{text.title}</h2><label>{text.date}<input type="date" value={date} onChange={(event) => { if (event.target.value) onDate(event.target.value); }} /></label>
      <button type="button" className="inspection-button" onClick={onCurrent}>{text.current}</button><button type="button" className="inspection-button" disabled={loading} onClick={onRefresh}><RefreshCw size={17} aria-hidden="true" />{text.refresh}</button>
    </div><p className="inspection-muted">{date} · {text.day} · {text.retained}</p>
    {error && <div className="inspection-message is-error" role="alert">{error}{snapshot && <p>{text.stale}</p>}<button type="button" className="inspection-button" disabled={loading} onClick={onRefresh}>{common.retry}</button></div>}
    {loading && !snapshot && <p className="inspection-empty" role="status">{common.loading}</p>}
    {snapshot && visible && <>
      <p className="inspection-muted">{text.displayedRequests}: {requests.length} {common.requestUnit} · {text.scopeHint}</p>
      <div className="inspection-management-filters" role="group" aria-label={text.filterTitle}>
        <div className="inspection-management-search"><label>{common.equipment}<select value={filter.machine} onChange={(event) => setFilter((value) => ({ ...value, machine: event.target.value }))}><option value="all">{text.allMachines}</option>{snapshot.machines.map((machine) => <option key={machine.machine_number} value={String(machine.machine_number)}>{machine.machine_number}{text.machine}</option>)}<option value="unmapped">{text.unmappedMachine}</option></select></label>
          <label>{text.search}<input type="search" maxLength={128} value={filter.search} onChange={(event) => setFilter((value) => ({ ...value, search: event.target.value }))} /></label>
          <button type="button" className="inspection-button" disabled={!filtered} onClick={() => setFilter({ stage: 'all', machine: 'all', search: '' })}>{text.clearFilters}</button></div>
        <div className="inspection-management-stages" role="group" aria-label={common.filter}>{stageOptions.map((stage) => <button key={stage.value} type="button" className="inspection-button" data-stage={stage.value} aria-pressed={filter.stage === stage.value} onClick={() => setFilter((value) => ({ ...value, stage: stage.value }))}>{stage.label} <strong>{stage.count}</strong></button>)}<button type="button" className="inspection-button" disabled aria-describedby="inspection-delay-unavailable">{text.delayed} · {text.delayUnavailable}</button></div>
        <p id="inspection-delay-unavailable" className="inspection-muted">{text.delayHint}</p><p className="inspection-muted">{text.filterScope}</p>
        <p className="inspection-management-result" role="status">{text.filterResult}: <strong>{visible.requestCount}</strong> {common.requestUnit}</p>
      </div>
      <p className="inspection-muted">{text.mapping}</p>
      <p className="inspection-muted">{text.executionHint}</p>
      {(snapshot.requests_truncated || snapshot.plans_truncated || snapshot.executions_truncated) && <div className="inspection-notice" role="status"><AlertTriangle size={18} aria-hidden="true" /><span>{text.truncation}</span></div>}
      {!snapshot.plan_snapshot.complete && <div className="inspection-notice" role="status">{text.partial}</div>}
      <div className="inspection-machine-grid">{[...visible.machines].sort((a, b) => a.machine_number - b.machine_number).map((machine) => {
        const plans = inspectionDisplayPlans(machine.plans);
        return <article className="inspection-machine-card" key={machine.machine_number} aria-labelledby={`inspection-machine-${machine.machine_number}`}>
          <header><h3 id={`inspection-machine-${machine.machine_number}`}>{machine.machine_number}{text.machine}</h3><span>{machine.mes_observations?.length ? `WJ ${machine.requests.length} · MES ${machine.mes_observations.length}` : `${text.displayCount} ${machine.requests.length} ${common.requestUnit}`}</span></header>
          <div className="inspection-machine-plans"><small>{text.plan}</small>{plans.length ? <><ul>{plans.slice(0, 2).map(plan)}</ul>{plans.length > 2 && <details><summary>{text.plansMore} ({plans.length - 2})</summary><ul>{plans.slice(2).map(plan)}</ul></details>}</> : <p>{machine.plan_status === 'missing' ? text.planMissing : text.planUnknown}</p>}
            {plans.length > 0 && machine.plan_status === 'unknown' && <p className="inspection-muted">{text.planUnknown}</p>}
          </div>
          {!!machine.mes_observations?.length && <ul className="inspection-machine-requests">{machine.mes_observations.map((item) => <MesReadObservationCard key={item.observation_key} item={item} lang={lang} />)}</ul>}
          {machine.requests.length ? <ul className="inspection-machine-requests">{machine.requests.map(request)}</ul> : <p className="inspection-kanban-empty">{machine.mes_observations?.length ? (lang === 'ko' ? 'WJ 수동 요청 없음' : '无 WJ 手工申请') : text.empty}</p>}
        </article>;
      })}</div>
      {!!visible.mesUnmappedObservations.length && <section className="inspection-unmapped"><h3>{lang === 'ko' ? 'MES 관측 · 설비/작업 연결 미확인' : 'MES 观测 · 设备/作业关联未确认'}</h3><ul>{visible.mesUnmappedObservations.map((item) => <MesReadObservationCard key={item.observation_key} item={item} lang={lang} />)}</ul></section>}
      {visible.unmappedRequests.length > 0 && <section className="inspection-unmapped"><h3>{text.unmapped} ({visible.unmappedRequests.length})</h3><p className="inspection-muted">{text.unmappedHint}</p><ul>{visible.unmappedRequests.map((item) => <li className="inspection-unmapped-request" key={item.id}><span>{item.equipment_ref || common.unassigned}</span><ul>{request(item)}</ul></li>)}</ul></section>}
      {visible.unmappedPlans.length > 0 && <details className="inspection-fold"><summary>{text.unmappedPlans} ({visible.unmappedPlans.length})</summary><ul className="inspection-unmapped-plans">{visible.unmappedPlans.map((item) => <li key={item.id}><strong>{item.machine_name}</strong> · {item.part_no || text.noPart} · {text.seq} {item.sequence}</li>)}</ul></details>}
      {filtered && !visible.machines.length && !visible.unmappedRequests.length && !visible.unmappedPlans.length && !visible.mesUnmappedObservations.length && <p className="inspection-empty" role="status">{text.noMatches}</p>}
      <details className="inspection-fold"><summary>{text.dryRun} · {text.dryRunHint}</summary><p className="inspection-muted">{text.reviewPause}: {candidates.review_pause} · {text.reviewResume}: {candidates.review_resume} · {text.reviewAlignment}: {candidates.review_alignment}</p><p className="inspection-muted">{text.dryRunBasis}</p></details>
      <p className="inspection-kanban-freshness">{text.refreshed}: {inspectionTime(snapshot.generated_at, lang)} · {text.planUpdated}: {inspectionTime(snapshot.plan_snapshot.latest_changed_at, lang)}</p>
    </>}
  </section>;
}
