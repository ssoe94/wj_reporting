import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildMachineBoardRows, currentPlanParts, MACHINE_BOARD_GROUPS, recommendTaskActions, SPORADIC_SHOT_LIMIT, summarizeMachineStops,
} from "../src/domains/production/injection-machine-board.ts";
import type { MesTaskReconciliation } from "../src/domains/production/mes-task-reconciliation.ts";
import type { InjectionTransitionAnalysis, InjectionTransitionEvent } from "../src/domains/production/injection-transition-analysis.ts";
import type { RealtimeProgressRow } from "../src/domains/production/realtime-progress.ts";
import type { InjectionDowntimeConfirmation } from "../src/domains/production/api.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mes-task-reconciliation.json", import.meta.url), "utf8")) as MesTaskReconciliation;
const fresh = () => structuredClone(fixture);

const emptyTotals = {
  moldChangeMinutes: 0, coreChangeMinutes: 0, tuningMinutes: 0, productionStopMinutes: 0,
  eventCount: 0, flagCount: 0, noteRequiredCount: 0,
};

function event(machineKey: string, eventKey: string, durationMinutes: number): InjectionTransitionEvent {
  return {
    id: eventKey, eventKey, machineKey, machineLabel: `${machineKey}호기`, type: "production_stop",
    status: "estimated", startTime: "2026-10-08T01:00:00Z", endTime: "2026-10-08T01:30:00Z",
    durationMinutes, confidence: "medium",
    evidence: { stopThresholdMinutes: 10, cumulativeQtyAtStop: 0, runOutputQty: 0 },
  };
}

function analysis(events: InjectionTransitionEvent[] = []): InjectionTransitionAnalysis {
  return { businessDate: fixture.business_date, stopThresholdMinutes: 10, machines: [], events, flags: [], totals: emptyTotals };
}

function progressRow(key: string, overrides: Partial<RealtimeProgressRow> = {}): RealtimeProgressRow {
  return {
    key, label: `${key}호기`, plannedQty: 100, shotCount: 10, recentShots: 1, recentCycleTimeSec: 30,
    estimatedQty: 10, progressRate: 10, gapQty: 0, partCount: 1, avgCavity: 1, isRunning: true,
    equipmentState: "running", hasPlan: true, lastShotAt: null, idleMinutes: null, expectedCycleTimeSec: null,
    completedCount: 0, inProgressCount: 1, pendingCount: 0, segments: [], ...overrides,
  };
}

const base = {
  progressRows: [] as RealtimeProgressRow[],
  analysis: analysis(),
  confirmationsReady: true,
  reconciliationFailed: false,
};

test("always lists machines 1-17 plus unknown progress keys, ordered by group then machine", () => {
  const rows = buildMachineBoardRows({ ...base, progressRows: [progressRow("3"), progressRow("A-line")], reconciliation: fresh() });
  assert.deepEqual(new Set(rows.map((row) => row.key)), new Set([...Array.from({ length: 17 }, (_, index) => String(index + 1)), "A-line"]));
  const groupIndex = rows.map((row) => MACHINE_BOARD_GROUPS.indexOf(row.group));
  assert.deepEqual(groupIndex, [...groupIndex].sort((left, right) => left - right));
  const planned = rows.filter((row) => row.group === "planned_idle").map((row) => row.key);
  assert.deepEqual(planned.filter((key) => /^\d+$/.test(key)), [...planned.filter((key) => /^\d+$/.test(key))].sort((a, b) => Number(a) - Number(b)));
});

test("groups: running, stopped after production, planned but idle, and nothing", () => {
  const rows = buildMachineBoardRows({
    ...base,
    reconciliation: fresh(),
    progressRows: [
      progressRow("1", { shotCount: 400, isRunning: true }),
      progressRow("2", { shotCount: 400, isRunning: false, equipmentState: "paused", idleMinutes: 40 }),
      progressRow("6", { shotCount: 0, isRunning: false, equipmentState: "idle" }),
    ],
  });
  const group = (key: string) => rows.find((row) => row.key === key)?.group;
  assert.equal(group("1"), "running");
  assert.equal(group("2"), "stopped_after_run");
  assert.equal(group("6"), "planned_idle");
  assert.equal(group("4"), "planned_idle", "a reconciliation plan alone marks the machine as planned");
  assert.equal(group("8"), "inactive");
  assert.deepEqual(rows.slice(0, 2).map((row) => row.key), ["1", "2"]);
});

test("sporadic shots below the limit count as no activity, even while the machine looks running", () => {
  const rows = buildMachineBoardRows({
    ...base,
    reconciliation: fresh(),
    progressRows: [
      progressRow("8", { hasPlan: false, shotCount: SPORADIC_SHOT_LIMIT - 1, isRunning: true, equipmentState: "unplanned_running" }),
      progressRow("9", { hasPlan: false, shotCount: SPORADIC_SHOT_LIMIT, isRunning: true, equipmentState: "unplanned_running" }),
    ],
  });
  const eight = rows.find((row) => row.key === "8")!;
  const nine = rows.find((row) => row.key === "9")!;
  assert.equal(eight.group, "inactive");
  assert.equal(eight.hadProduction, false);
  assert.equal(eight.needsAttention, false);
  assert.equal(nine.group, "running");
  assert.equal(nine.needsAttention, true, "unconfirmed unplanned production needs review");
});

test("verified inspection failure or overdue periodic check needs attention; unknown does not", () => {
  const inspection = new Map([
    ["8", { failed: true, overdue: false }],
    ["9", { failed: false, overdue: true }],
    ["11", { failed: null, overdue: null }],
  ]);
  const rows = buildMachineBoardRows({ ...base, reconciliation: fresh(), inspection });
  const attention = (key: string) => rows.find((row) => row.key === key)?.needsAttention;
  assert.equal(attention("8"), true);
  assert.equal(attention("9"), true);
  assert.equal(attention("11"), false);
});

test("MES counts come from the matching machine and mark review rows", () => {
  const rows = buildMachineBoardRows({ ...base, reconciliation: fresh() });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  assert.deepEqual(byKey.get("2")?.mes, { state: "ready", running: 2, paused: 0, waiting: 0, pauseReview: 0, linkReview: 2, startNeeded: 0, noTask: 0, held: false });
  assert.equal(byKey.get("3")?.mes.state === "ready" && byKey.get("3")?.mes.pauseReview, 1);
  assert.equal(byKey.get("2")?.needsAttention, true);
  assert.equal(byKey.get("1")?.needsAttention, false);
});

test("an idle machine without plans or tasks is not held or flagged; one with an unknown task is", () => {
  const rows = buildMachineBoardRows({ ...base, reconciliation: fresh() });
  const idle = rows.find((row) => row.key === "8")!;
  const unknown = rows.find((row) => row.key === "17")!;
  assert.equal(idle.mes.state === "ready" && idle.mes.held, false);
  assert.equal(idle.needsAttention, false);
  assert.equal(unknown.mes.state === "ready" && unknown.mes.held, true);
  assert.equal(unknown.needsAttention, true);
});

test("a failed or missing reconciliation never reads as zero open tasks", () => {
  for (const input of [{ reconciliation: undefined }, { reconciliation: fresh(), reconciliationFailed: true }]) {
    const rows = buildMachineBoardRows({ ...base, ...input });
    assert.ok(rows.every((row) => row.mes.state === "unavailable"));
  }
});

test("stop summary counts unconfirmed events only when confirmations loaded", () => {
  const events = [event("5", "e1", 12.4), event("5", "e2", 30)];
  const confirmations = [{ event_key: "e1" }] as InjectionDowntimeConfirmation[];
  assert.deepEqual(summarizeMachineStops(events, confirmations, true), { eventCount: 2, minutes: 42.4, pending: 1, ongoing: false });
  assert.equal(summarizeMachineStops(events, undefined, false).pending, null);
  const rows = buildMachineBoardRows({ ...base, analysis: analysis(events), confirmations, reconciliation: fresh() });
  assert.equal(rows.find((row) => row.key === "5")?.events.length, 2);
  assert.equal(rows.find((row) => row.key === "6")?.events.length, 0);
});

test("unplanned activity needs attention until it is confirmed; a stopped machine always does", () => {
  const unplanned = progressRow("9", { hasPlan: false, shotCount: 120, equipmentState: "unplanned_running" });
  const stopped = progressRow("11", { shotCount: 300, isRunning: false, equipmentState: "paused", idleMinutes: 25 });
  const open = buildMachineBoardRows({ ...base, progressRows: [unplanned, stopped], reconciliation: fresh() });
  assert.equal(open.find((row) => row.key === "9")?.needsAttention, true);
  assert.equal(open.find((row) => row.key === "11")?.needsAttention, true);
  const confirmed = buildMachineBoardRows({
    ...base, progressRows: [unplanned], reconciliation: fresh(), activityConfirmedKeys: new Set(["9"]),
  });
  assert.equal(confirmed.find((row) => row.key === "9")?.needsAttention, false);
});

function segment(partNo: string, sequence: number, status: "completed" | "in_progress" | "pending", shotGroupKey?: string) {
  return {
    key: `${partNo}-${sequence}`, sequence, partNo, modelName: "", lotNo: "", productFamilyCode: null, productFamilyName: null,
    isFinishedProduct: true, plannedQty: 100, cavity: 1, shotGroupKey, requiredShots: 100, allocatedShots: 0,
    estimatedQty: 0, progressRate: 0, status,
  };
}

function machineWithTasks(tasks: Array<{ id: string; part: string; status: 1 | 2 | 3; assessment?: string }>, overrides: Partial<RealtimeProgressRow> = {}) {
  const data = fresh();
  const machine = data.machines.find((entry) => entry.machine_number === 1)!;
  machine.plan_scope = "present";
  machine.tasks = tasks.map((item) => ({
    task_id: item.id, task_code: `C${item.id}`, work_order_code: `W${item.id}`, part_no: item.part, machine_number: 1,
    status: item.status, actual_start: null, planned_quantity: 100, reported_quantity: 0, inbound_quantity: null,
    quantity_unit: null, assessment: (item.assessment ?? "plan_match") as never, reasons: [],
  }));
  const progress = progressRow("1", {
    shotCount: 300, isRunning: true,
    segments: [segment("PART-01", 1, "completed"), segment("PART-02", 2, "in_progress", "g2"), segment("PART-02B", 2, "in_progress", "g2"), segment("PART-03", 3, "pending")],
    ...overrides,
  });
  return buildMachineBoardRows({ ...base, reconciliation: data, progressRows: [progress] }).find((row) => row.key === "1")!;
}

test("current plan parts are the in-progress segment plus parts shot together with it", () => {
  const row = machineWithTasks([]);
  assert.deepEqual([...currentPlanParts(row, fixture.business_date)].sort(), ["PART-02", "PART-02B"]);
});

test("only the current plan part is started or resumed; running tasks for other parts are paused", () => {
  const row = machineWithTasks([
    { id: "1", part: "PART-02", status: 1 },
    { id: "2", part: "PART-02B", status: 3 },
    { id: "3", part: "PART-01", status: 2 },
    { id: "4", part: "OLD", status: 2, assessment: "pause_review" },
    { id: "5", part: "PART-03", status: 1 },
  ]);
  const actions = Object.fromEntries(recommendTaskActions(row, fixture.business_date).map((item) => [item.taskId, item.action ?? item.note]));
  assert.deepEqual(actions, { 1: "start", 2: "resume", 3: "pause", 4: "pause", 5: "not_current_waiting" });
});

test("a running current task is kept and duplicate current tasks are left for the operator", () => {
  const keep = machineWithTasks([{ id: "1", part: "PART-02", status: 2 }]);
  assert.equal(recommendTaskActions(keep, fixture.business_date)[0].note, "current");
  const duplicate = machineWithTasks([{ id: "1", part: "PART-02", status: 1 }, { id: "2", part: "PART-02", status: 3 }]);
  assert.deepEqual(recommendTaskActions(duplicate, fixture.business_date).map((item) => [item.action, item.note]), [[null, "duplicate"], [null, "duplicate"]]);
});

test("no action is suggested when plan or MES data is incomplete", () => {
  const unknown = machineWithTasks([{ id: "1", part: "OLD", status: 2, assessment: "unknown" }]);
  assert.deepEqual(recommendTaskActions(unknown, fixture.business_date).map((item) => item.action), [null]);
  const failed = buildMachineBoardRows({ ...base, reconciliation: fresh(), reconciliationFailed: true }).find((row) => row.key === "3")!;
  assert.deepEqual(recommendTaskActions(failed, fixture.business_date), []);
});

test("without a progress row the earliest planned part of the day is current", () => {
  const rows = buildMachineBoardRows({ ...base, reconciliation: fresh() });
  const four = rows.find((row) => row.key === "4")!;
  const firstPlan = four.mesMachine!.plans.filter((plan) => plan.plan_date === fixture.business_date)
    .sort((left, right) => left.sequence - right.sequence)[0];
  assert.ok(currentPlanParts(four, fixture.business_date).has(firstPlan.part_no.toUpperCase()));
});
