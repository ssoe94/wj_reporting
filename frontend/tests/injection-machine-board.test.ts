import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildMachineBoardRows, MACHINE_BOARD_GROUPS, SPORADIC_SHOT_LIMIT, summarizeMachineStops } from "../src/domains/production/injection-machine-board.ts";
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
