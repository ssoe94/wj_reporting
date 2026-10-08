import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildMachineBoardRows, summarizeMachineStops } from "../src/domains/production/injection-machine-board.ts";
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

test("always lists machines 1-17 in order, plus unknown progress keys after them", () => {
  const rows = buildMachineBoardRows({ ...base, progressRows: [progressRow("3"), progressRow("A-line")], reconciliation: fresh() });
  assert.deepEqual(rows.slice(0, 17).map((row) => row.key), Array.from({ length: 17 }, (_, index) => String(index + 1)));
  assert.equal(rows.at(-1)?.key, "A-line");
  assert.equal(rows.find((row) => row.key === "3")?.progress?.key, "3");
});

test("MES counts come from the matching machine and mark review rows", () => {
  const rows = buildMachineBoardRows({ ...base, reconciliation: fresh() });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  assert.deepEqual(byKey.get("2")?.mes, { state: "ready", running: 2, paused: 0, waiting: 0, pauseReview: 0, linkReview: 2, startNeeded: 0, held: false });
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
  const unplanned = progressRow("9", { hasPlan: false, equipmentState: "unplanned_running" });
  const stopped = progressRow("11", { equipmentState: "paused", idleMinutes: 25 });
  const open = buildMachineBoardRows({ ...base, progressRows: [unplanned, stopped], reconciliation: fresh() });
  assert.equal(open.find((row) => row.key === "9")?.needsAttention, true);
  assert.equal(open.find((row) => row.key === "11")?.needsAttention, true);
  const confirmed = buildMachineBoardRows({
    ...base, progressRows: [unplanned], reconciliation: fresh(), activityConfirmedKeys: new Set(["9"]),
  });
  assert.equal(confirmed.find((row) => row.key === "9")?.needsAttention, false);
});
