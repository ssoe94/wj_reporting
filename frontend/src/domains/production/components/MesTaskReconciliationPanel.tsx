import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLang } from "@/i18n";
import { getMesTaskReconciliation } from "../mes-task-reconciliation-api";
import {
  assessmentTone, needsReconciliationReview, reconciliationQueryOptions, reconciliationSummary,
  type ReconciliationTask,
} from "../mes-task-reconciliation";
import "./mes-task-reconciliation.css";

export function MesTaskReconciliationPanel({ businessDate }: { businessDate: string }) {
  const { t, lang } = useLang();
  const [reviewOnly, setReviewOnly] = useState(false);
  const query = useQuery({
    ...reconciliationQueryOptions(businessDate),
    queryFn: ({ signal }) => getMesTaskReconciliation(businessDate, signal),
  });
  const data = query.data;
  const summary = reconciliationSummary(data, query.isError);
  const copy = (key: string) => t(`mesTasks.${key}`);
  const number = (value: number | null) => value === null ? "—" : value.toLocaleString(lang === "ko" ? "ko-KR" : "zh-CN");
  const time = (value: string | null) => {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(lang === "ko" ? "ko-KR" : "zh-CN", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }) : "—";
  };

  function renderTask(task: ReconciliationTask) {
    return <article className="mes-task-card" key={task.task_id}>
      <div className="mes-task-card__title">
        <strong>{task.part_no || "—"}</strong>
        <span className="mes-task-badge">{copy(`status.${task.status}`)}</span>
        <span className={`mes-task-badge mes-task-badge--${assessmentTone(task.assessment)}`}>
          {copy(`assessment.${task.assessment}`)}
        </span>
      </div>
      <p>{copy("task")} {task.task_code || task.task_id} · {copy("workOrder")} {task.work_order_code || "—"}</p>
      <p>{copy("quantities")} {number(task.planned_quantity)} / {number(task.reported_quantity)} / {number(task.inbound_quantity)}</p>
      <p>{copy("opened")} {time(task.actual_start)}</p>
      <ul>{task.reasons.map((reason) => <li key={reason}>{copy(`reason.${reason}`)}</li>)}</ul>
    </article>;
  }

  return <section className="panel mes-task-reconciliation" aria-labelledby="mes-task-reconciliation-title" aria-busy={query.isFetching}>
    <div className="mes-task-reconciliation__header">
      <div>
        <h3 className="panel__title" id="mes-task-reconciliation-title">{copy("title")}</h3>
        <p>{copy("description")}</p>
      </div>
      <button className="button button--ghost" type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
        {query.isFetching ? copy("loading") : copy("refresh")}
      </button>
    </div>
    <p className="mes-task-reconciliation__freshness">
      {businessDate} {data ? `· ${data.next_business_date}` : ""} · {copy("snapshot")} {time(data?.data_freshness.queried_at ?? null)}
      <br />{copy("freshnessHint")}
    </p>
    <div className="mes-task-reconciliation__summary" aria-live="polite">
      {([
        ["pauseReview", summary.pauseReview], ["taskLinkReview", summary.taskLinkReview],
        ["startNeeded", summary.startNeeded], ["noOpenTask", summary.noOpenTask],
      ] as const).map(([label, value]) => <div key={label}><span>{copy(label)}</span><strong>{number(value)}</strong></div>)}
    </div>
    <p>{copy("heldMachines")} {number(summary.heldMachines)} · {copy("summaryScope")}</p>
    {query.isError ? <p className="notice notice--warning" role="alert">{copy("failed")}</p> : null}
    {query.isPending ? <p role="status">{copy("loading")}</p> : null}
    {data && !query.isError ? <>
      {data.warnings.length > 0 ? <div className="notice notice--warning" role="status">
        <ul>{data.warnings.map((warning) => <li key={warning}>{copy(`warning.${warning}`)}</li>)}</ul>
      </div> : null}
      <label className="mes-task-reconciliation__filter">
        <input type="checkbox" checked={reviewOnly} onChange={(event) => setReviewOnly(event.target.checked)} />
        {copy("reviewOnly")}
      </label>
      <p className="mes-task-reconciliation__scroll-hint">{copy("scrollHint")}</p>
      <div className="mes-task-reconciliation__table-wrap" tabIndex={0} role="region" aria-label={copy("title")}>
        <table className="mes-task-reconciliation__table">
          <thead><tr><th scope="col">{copy("machine")}</th><th scope="col">{copy("plans")}</th><th scope="col">{copy("tasks")}</th></tr></thead>
          <tbody>{data.machines.filter((machine) => !reviewOnly || needsReconciliationReview(machine)).map((machine) => <tr key={machine.machine_number}>
            <th scope="row">
              <strong>{machine.machine_number}{copy("machineUnit")}</strong>
              <small>{copy(`observation.${machine.observation.state}`)}</small>
              <small>{copy("observedAt")} {time(machine.observation.last_at)}</small>
            </th>
            <td>
              {machine.plan_scope === "incomplete" ? <p className="mes-task-reconciliation__muted">{copy("planIncomplete")}</p> : null}
              {machine.plans.map((plan) => <article className="mes-task-card" key={plan.plan_id}>
                <small>{plan.plan_date} · {copy("sequence")} {plan.sequence}</small>
                <strong>{plan.part_no || "—"}</strong>
                <p>{number(plan.planned_quantity)} · LOT {plan.lot_no || "—"}</p>
                <span className={`mes-task-badge mes-task-badge--${assessmentTone(plan.assessment)}`}>{copy(`assessment.${plan.assessment}`)}</span>
                {plan.parallel_parts.length > 1 ? <p>{copy("parallel")} {plan.parallel_parts.join(" + ")}</p> : null}
                {plan.group_incomplete ? <p>{copy("groupIncomplete")}</p> : null}
              </article>)}
            </td>
            <td>{machine.tasks.length ? machine.tasks.map(renderTask) : <p>{data.data_freshness.assignment_complete ? copy("emptyTasks") : copy("unknownTasks")}</p>}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {reviewOnly && !data.machines.some(needsReconciliationReview) ? <p>{copy("noReviewRows")}</p> : null}
      {data.unmapped_tasks.length > 0 ? <details className="mes-task-reconciliation__unmapped">
        <summary>{copy("unmapped")} {data.unmapped_tasks.length}</summary>
        {data.unmapped_tasks.map(renderTask)}
      </details> : null}
    </> : null}
  </section>;
}
