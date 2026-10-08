export type Assessment = "plan_match" | "next_plan_match" | "task_link_review" | "pause_review"
  | "start_needed" | "no_open_task" | "outside_plan" | "unknown" | "unmapped";

export type ReconciliationTask = {
  task_id: string;
  task_code: string;
  work_order_code: string;
  part_no: string;
  machine_number: number | null;
  status: 1 | 2 | 3;
  actual_start: string | null;
  planned_quantity: number | null;
  reported_quantity: number | null;
  inbound_quantity: number | null;
  quantity_unit: string | null;
  assessment: Assessment;
  reasons: string[];
  plan_relation?: "today" | "next_date" | "outside_plans";
};

export type ReconciliationPlan = {
  plan_id: number;
  plan_date: string;
  part_no: string;
  lot_no: string;
  planned_quantity: number;
  sequence: number;
  group_id: string;
  parallel_parts: string[];
  group_incomplete: boolean;
  matching_task_ids: string[];
  assessment: Assessment;
};

export type ReconciliationMachine = {
  machine_number: number;
  plans: ReconciliationPlan[];
  tasks: ReconciliationTask[];
  plan_scope: "present" | "incomplete";
  observation: {
    state: "activity_observed" | "no_increase_observed" | "insufficient_data" | "unavailable";
    sample_count: number;
    first_at: string | null;
    last_at: string | null;
  };
};

export type MesTaskReconciliation = {
  business_date: string;
  next_business_date: string;
  machines: ReconciliationMachine[];
  unmapped_tasks: ReconciliationTask[];
  data_freshness: {
    queried_at: string | null;
    mes_complete: boolean;
    plan_complete: boolean;
    assignment_complete: boolean;
    snapshot_kind: "current";
    list_may_lag: boolean;
  };
  warnings: string[];
  old_open_days: number;
};

const reviewAssessments = new Set<Assessment>([
  "task_link_review", "pause_review", "start_needed", "no_open_task", "unknown", "unmapped",
]);

export function needsReconciliationReview(machine: ReconciliationMachine) {
  return machine.plan_scope === "incomplete"
    || machine.tasks.some((task) => reviewAssessments.has(task.assessment))
    || machine.plans.some((plan) => reviewAssessments.has(plan.assessment) || plan.group_incomplete);
}

export function reconciliationSummary(data?: MesTaskReconciliation, failed = false) {
  const heldMachines = data && !failed ? data.machines.filter((machine) =>
    machine.plan_scope === "incomplete" || machine.tasks.some((task) => task.assessment === "unknown")
    || machine.plans.some((plan) => plan.assessment === "unknown")).length : null;
  if (!data || failed || !data.data_freshness.assignment_complete
      || !data.data_freshness.mes_complete || !data.data_freshness.plan_complete
      || data.warnings.includes("current_snapshot_with_other_date")) {
    return { pauseReview: null, taskLinkReview: null, startNeeded: null, noOpenTask: null, heldMachines };
  }
  const tasks = data.machines.flatMap((machine) => machine.tasks);
  const todayPlans = data.machines.flatMap((machine) => machine.plans)
    .filter((plan) => plan.plan_date === data.business_date);
  return {
    heldMachines,
    pauseReview: tasks.filter((task) => task.assessment === "pause_review").length,
    taskLinkReview: tasks.filter((task) => task.assessment === "task_link_review").length,
    startNeeded: todayPlans.filter((plan) => plan.assessment === "start_needed").length,
    noOpenTask: todayPlans.filter((plan) => plan.assessment === "no_open_task").length,
  };
}

export function assessmentTone(assessment: Assessment) {
  return assessment === "pause_review" || assessment === "task_link_review" ? "warning" : "neutral";
}

export function reconciliationQueryOptions(businessDate: string) {
  return {
    queryKey: ["production", "mes-task-reconciliation", businessDate],
    retry: false as const,
    staleTime: 60_000,
    refetchInterval: false as const,
    refetchOnWindowFocus: false as const,
    refetchOnReconnect: false as const,
    refetchOnMount: "always" as const,
  };
}
