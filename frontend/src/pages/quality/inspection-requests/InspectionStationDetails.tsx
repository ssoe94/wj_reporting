import { inspectionCopy, inspectionRequestStatusLabels, inspectionTime } from './copy';
import { inspectionKanbanCopy } from './kanbanCopy';
import { inspectionDisplayPlans, inspectionRequestKind, inspectionRequestStage } from './kanban';
import type { InspectionKanban, InspectionMachine } from './kanban';
import { stationRequests } from './stationPickerModel';
import MesReadObservationCard from './MesReadObservationCard';

export default function InspectionStationDetails({ machine, snapshot, lang, selectedId, locked, onSelect }: {
  machine: InspectionMachine; snapshot: InspectionKanban; lang: 'ko' | 'zh'; selectedId: number | null; locked: boolean; onSelect: (id: number) => void;
}) {
  const text = inspectionKanbanCopy[lang], common = inspectionCopy[lang];
  const plans = inspectionDisplayPlans(machine.plans), requests = stationRequests(machine);
  return <section id="inspection-station-detail" className="inspection-station-detail" aria-label={`${machine.machine_number}${text.machine} · ${text.plan}`}>
    <header><strong>{machine.machine_number}{text.machine} · {lang === 'ko' ? '설비·계획 상세' : '设备·计划详情'}</strong><span>{text.refreshed}: {inspectionTime(snapshot.generated_at, lang)}</span></header>
    <div className="inspection-station-detail-grid">
      <section><h3>{text.plan} ({plans.length})</h3>{plans.length ? <div className="inspection-station-detail-scroll"><table><thead><tr><th>{common.part}</th><th>{text.lot}</th><th>{lang === 'ko' ? '계획 수량' : '计划数量'}</th><th>{text.seq}</th><th>{lang === 'ko' ? '상태' : '状态'}</th></tr></thead><tbody>{plans.map((plan) => <tr key={plan.id}><th scope="row">{plan.part_no || text.noPart}</th><td>{plan.lot_no || '—'}</td><td>{plan.planned_quantity}</td><td>{plan.sequence}</td><td>{plan.execution_status === 'running' ? text.running : plan.execution_status === 'paused' ? text.paused : text.scheduled}</td></tr>)}</tbody></table></div> : <p>{machine.plan_status === 'missing' ? text.planMissing : text.planUnknown}</p>}{plans.length > 0 && machine.plan_status === 'unknown' && <p>{text.planUnknown}</p>}</section>
      <section><h3>{common.requests} ({requests.length})</h3>{requests.length ? <div className="inspection-station-detail-scroll"><table><thead><tr><th>{common.part}</th><th>{common.inspectionType}</th><th>{lang === 'ko' ? '상태' : '状态'}</th><th>{text.localReview}</th></tr></thead><tbody>{requests.map((request) => <tr key={request.id}><th scope="row"><button type="button" className="inspection-station-detail-request" disabled={locked} aria-current={selectedId === request.id ? 'true' : undefined} onClick={() => onSelect(request.id)}>#{request.id} · {request.part_no || request.work_order_ref}</button></th><td>{text[inspectionRequestKind(request)]}</td><td>{text[inspectionRequestStage(request)]}</td><td>{inspectionRequestStatusLabels[lang][request.status]}</td></tr>)}</tbody></table></div> : <p>{text.empty}</p>}</section>
    </div>
    {!!machine.mes_observations?.length && <ul className="inspection-station-observations">{machine.mes_observations.map((observation) => <MesReadObservationCard key={observation.observation_key} item={observation} lang={lang} />)}</ul>}
    {(machine.requests_truncated || snapshot.plans_truncated || !snapshot.plan_snapshot.complete) && <p className="inspection-muted" role="status">{!snapshot.plan_snapshot.complete ? text.partial : text.truncation}</p>}
  </section>;
}
