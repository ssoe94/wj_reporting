import type { InjectionDowntimeConfirmation } from "@/domains/production/api";
import type { InjectionTransitionAnalysis, InjectionTransitionEvent } from "@/domains/production/injection-transition-analysis";
import type { RealtimeProgressRow } from "@/domains/production/realtime-progress";
import type { Assessment, MesTaskReconciliation, ReconciliationMachine } from "@/domains/production/mes-task-reconciliation";

export const INJECTION_MACHINE_COUNT = 17;
/** A business day with fewer shots than this is setup or test shots, not production. */
export const SPORADIC_SHOT_LIMIT = 50;

export type MachineBoardGroup = "running" | "stopped_after_run" | "planned_idle" | "inactive";
export const MACHINE_BOARD_GROUPS: MachineBoardGroup[] = ["running", "stopped_after_run", "planned_idle", "inactive"];

export type MachineInspectionAttention = { failed: boolean | null; overdue: boolean | null };

export type MachineMesSummary =
  | { state: "unavailable" }
  | {
    state: "ready";
    running: number;
    paused: number;
    waiting: number;
    pauseReview: number;
    linkReview: number;
    startNeeded: number;
    noTask: number;
    held: boolean;
  };

export type MachineStopSummary = {
  eventCount: number;
  minutes: number;
  pending: number | null;
  ongoing: boolean;
};

export type MachineBoardRow = {
  key: string;
  machineNumber: number | null;
  progress: RealtimeProgressRow | null;
  mesMachine: ReconciliationMachine | null;
  mes: MachineMesSummary;
  stop: MachineStopSummary;
  events: InjectionTransitionEvent[];
  group: MachineBoardGroup;
  hasTodayPlan: boolean;
  hadProduction: boolean;
  needsAttention: boolean;
};

const heldAssessments = new Set<Assessment>(["unknown", "unmapped"]);

export function summarizeMachineMes(machine: ReconciliationMachine | null, data: MesTaskReconciliation | undefined, failed: boolean): MachineMesSummary {
  if (failed || !data || !machine) return { state: "unavailable" };
  const tasks = machine.tasks;
  const todayPlans = machine.plans.filter((plan) => plan.plan_date === data.business_date);
  return {
    state: "ready",
    running: tasks.filter((task) => task.status === 2).length,
    paused: tasks.filter((task) => task.status === 3).length,
    waiting: tasks.filter((task) => task.status === 1).length,
    pauseReview: tasks.filter((task) => task.assessment === "pause_review").length,
    linkReview: tasks.filter((task) => task.assessment === "task_link_review").length,
    startNeeded: todayPlans.filter((plan) => plan.assessment === "start_needed").length,
    noTask: todayPlans.filter((plan) => plan.assessment === "no_open_task").length,
    // An idle machine without plans or open tasks has nothing to judge.
    held: (machine.plan_scope === "incomplete" && tasks.length > 0)
      || tasks.some((task) => heldAssessments.has(task.assessment))
      || machine.plans.some((plan) => heldAssessments.has(plan.assessment)),
  };
}

export function summarizeMachineStops(
  events: InjectionTransitionEvent[],
  confirmations: InjectionDowntimeConfirmation[] | undefined,
  confirmationsReady: boolean,
): MachineStopSummary {
  const confirmed = new Set((confirmations ?? []).map((confirmation) => confirmation.event_key));
  return {
    eventCount: events.length,
    minutes: events.reduce((sum, event) => sum + Math.max(0, event.durationMinutes), 0),
    pending: confirmationsReady ? events.filter((event) => !confirmed.has(event.eventKey)).length : null,
    ongoing: events.some((event) => event.status === "ongoing"),
  };
}

function machineNumberOf(key: string) {
  const number = Number(key);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function buildMachineBoardRows(input: {
  progressRows: RealtimeProgressRow[];
  analysis: InjectionTransitionAnalysis;
  confirmations?: InjectionDowntimeConfirmation[];
  confirmationsReady: boolean;
  reconciliation?: MesTaskReconciliation;
  reconciliationFailed: boolean;
  activityConfirmedKeys?: ReadonlySet<string>;
  inspection?: ReadonlyMap<string, MachineInspectionAttention>;
}): MachineBoardRow[] {
  const progressByKey = new Map(input.progressRows.map((row) => [row.key, row]));
  const keys = Array.from({ length: INJECTION_MACHINE_COUNT }, (_, index) => String(index + 1));
  for (const row of input.progressRows) {
    if (!keys.includes(row.key)) keys.push(row.key);
  }
  const order = new Map(MACHINE_BOARD_GROUPS.map((group, index) => [group, index]));
  const rows = keys.map((key): MachineBoardRow => {
    const machineNumber = machineNumberOf(key);
    const progress = progressByKey.get(key) ?? null;
    const mesMachine = machineNumber === null
      ? null
      : input.reconciliation?.machines.find((machine) => machine.machine_number === machineNumber) ?? null;
    const mes = summarizeMachineMes(mesMachine, input.reconciliation, input.reconciliationFailed);
    const events = input.analysis.events.filter((event) => event.machineKey === key);
    const stop = summarizeMachineStops(events, input.confirmations, input.confirmationsReady);
    const hadProduction = (progress?.shotCount ?? 0) >= SPORADIC_SHOT_LIMIT;
    const hasTodayPlan = Boolean(progress?.hasPlan)
      || Boolean(mesMachine?.plans.some((plan) => plan.plan_date === input.reconciliation?.business_date));
    const group: MachineBoardGroup = hadProduction && progress?.isRunning
      ? "running"
      : hadProduction
        ? "stopped_after_run"
        : hasTodayPlan
          ? "planned_idle"
          : "inactive";
    const inspection = input.inspection?.get(key);
    const needsAttention = Boolean(
      (group === "stopped_after_run" && progress?.equipmentState === "paused")
      || (hadProduction && progress && !progress.hasPlan && !input.activityConfirmedKeys?.has(key))
      || (stop.pending ?? 0) > 0
      || inspection?.failed === true
      || inspection?.overdue === true
      || (mes.state === "ready" && (mes.pauseReview + mes.linkReview + mes.startNeeded > 0 || mes.held))
      // A planned machine with no MES task cannot start: the work order still has to be issued.
      || (mes.state === "ready" && group === "planned_idle" && mes.noTask > 0),
    );
    return { key, machineNumber, progress, mesMachine, mes, stop, events, group, hasTodayPlan, hadProduction, needsAttention };
  });
  // Stable sort keeps machine order inside each group.
  return rows.sort((left, right) => (order.get(left.group) ?? 0) - (order.get(right.group) ?? 0));
}
