import assert from "node:assert/strict";
import test from "node:test";
import { buildRealtimeProgressSummary } from "../src/domains/production/realtime-progress.ts";
import type { InjectionProductionMatrix } from "../src/domains/mes/api.ts";
import type { ProductionPlanRecord, ProductionPlanSummaryResponse, ProductionStatusResponse } from "../src/domains/production/api.ts";
import type { InjectionTransitionAnalysis } from "../src/domains/production/injection-transition-analysis.ts";

const businessDate = "2026-09-14";

function planSummary(records: ProductionPlanRecord[]): ProductionPlanSummaryResponse {
  const bucket = { records, machine_summary: [], model_summary: [], daily_totals: [] };
  return { plan_date: businessDate, injection: bucket, machining: { ...bucket, records: [] } };
}

function matrix(shots: number): InjectionProductionMatrix {
  return {
    timestamp: "2026-09-14T18:30:00+08:00",
    time_slots: [{ hour_offset: 10, time: "2026-09-14T18:30:00+08:00", label: "18:30", interval_minutes: 2 }],
    machines: [{ machine_number: 4, machine_name: "4호기", tonnage: "1400T", display_name: "4호기" }],
    actual_production_matrix: { "4": [shots] },
    cumulative_production_matrix: {},
    oil_temperature_matrix: {},
  };
}

const oldPlan: ProductionPlanRecord = {
  id: 1, machine_name: "1400T-4", sequence: 1, part_no: "40-INCH", model_name: "40 inch",
  lot_no: "A", planned_quantity: 412, cavity: 1,
};
const newPlan: ProductionPlanRecord = {
  id: 2, machine_name: "1400T-4", sequence: 2, part_no: "32-INCH", model_name: "32 inch",
  lot_no: "B", planned_quantity: 824, cavity: 1,
};

test("without canonical status, an old-model overrun does not start the next model", () => {
  // The 494 MES shots may include 493 old-model shots and one setup shot;
  // even a client-estimated gap is not a verified product boundary.
  const speculativeTransition = {
    events: [{
      machineKey: "4", type: "mold_change", status: "needs_note",
      startTime: "2026-09-14T18:00:00+08:00", fromRecord: oldPlan, toRecord: newPlan,
      evidence: { cumulativeQtyAtStop: 493 },
    }],
  } as unknown as InjectionTransitionAnalysis;
  const result = buildRealtimeProgressSummary(
    planSummary([oldPlan, newPlan]), matrix(494), undefined, businessDate, speculativeTransition,
  );
  const row = result.rows.find((item) => item.key === "4");
  assert.ok(row);
  assert.deepEqual(row.segments.map((part) => part.allocatedShots), [494, 0]);
  assert.deepEqual(row.segments.map((part) => part.status), ["in_progress", "pending"]);
});

test("the noncanonical status path also keeps distinct models at zero", () => {
  const status: ProductionStatusResponse = {
    injection: [{
      machine_name: "1400T-4", total_planned: 1236, total_actual: 494, progress: 40,
      parts: [oldPlan, newPlan].map((part) => ({
        plan_id: part.id, part_no: part.part_no ?? null, model_name: part.model_name ?? null,
        planned_quantity: part.planned_quantity, actual_quantity: 0, progress: 0,
      })),
    }],
    machining: [],
  };
  const result = buildRealtimeProgressSummary(planSummary([oldPlan, newPlan]), matrix(494), status, businessDate);
  const row = result.rows.find((item) => item.key === "4");
  assert.ok(row);
  assert.deepEqual(row.segments.map((part) => part.allocatedShots), [494, 0]);
  assert.deepEqual(row.segments.map((part) => part.status), ["in_progress", "pending"]);
});

test("an identical product may roll over to its next LOT without a changeover", () => {
  const nextLot: ProductionPlanRecord = {
    ...oldPlan, id: 3, sequence: 2, lot_no: "B", planned_quantity: 100,
  };
  const laterModel = { ...newPlan, sequence: 3 };
  const result = buildRealtimeProgressSummary(planSummary([oldPlan, nextLot, laterModel]), matrix(450), undefined, businessDate);
  const row = result.rows.find((item) => item.key === "4");
  assert.ok(row);
  assert.deepEqual(row.segments.map((part) => part.allocatedShots), [412, 38, 0]);
  assert.deepEqual(row.segments.map((part) => part.status), ["completed", "in_progress", "pending"]);
});

test("a matching model and cavity continue by plan sequence across a Part No. change", () => {
  const nextPart: ProductionPlanRecord = {
    ...oldPlan, id: 3, sequence: 2, part_no: "OTHER-PART", planned_quantity: 100,
  };
  const result = buildRealtimeProgressSummary(planSummary([oldPlan, nextPart]), matrix(450), undefined, businessDate);
  const row = result.rows.find((item) => item.key === "4");
  assert.ok(row);
  assert.deepEqual(row.segments.map((part) => part.allocatedShots), [412, 38]);
});

test("business-day rollover retains the last observed shot without carrying yesterday's output", () => {
  const nextDate = "2026-09-15";
  const nextPlan = { ...oldPlan, id: 4 };
  const rolloverMatrix: InjectionProductionMatrix = {
    ...matrix(0),
    timestamp: "2026-09-15T08:20:00+08:00",
    time_slots: [
      { hour_offset: 0, time: "2026-09-15T07:58:00+08:00", label: "07:58", interval_minutes: 2 },
      { hour_offset: 1, time: "2026-09-15T08:20:00+08:00", label: "08:20", interval_minutes: 2 },
    ],
    actual_production_matrix: { "4": [3, 0] },
  };
  const row = buildRealtimeProgressSummary({ ...planSummary([nextPlan]), plan_date: nextDate }, rolloverMatrix, undefined, nextDate)
    .rows.find((item) => item.key === "4");
  assert.ok(row);
  assert.equal(row.shotCount, 0);
  assert.equal(row.estimatedQty, 0);
  assert.equal(row.lastShotAt, "2026-09-14T23:58:00.000Z");
  assert.equal(row.isRunning, false);
});

test("morning shot gaps require observed capacity throughout the gap", () => {
  const timeSlots = Array.from({ length: 12 }, (_, index) => ({
    hour_offset: index,
    time: new Date(Date.parse("2026-09-14T08:00:00+08:00") + index * 2 * 60_000).toISOString(),
    label: String(index),
    interval_minutes: 2,
  }));
  const gapMatrix: InjectionProductionMatrix = {
    ...matrix(0),
    timestamp: timeSlots.at(-1)!.time,
    time_slots: timeSlots,
    actual_production_matrix: { "4": [1, ...Array(9).fill(0), 1, 0] },
    capacity_observed_matrix: { "4": Array(12).fill(true) },
  };
  const observed = buildRealtimeProgressSummary(planSummary([oldPlan]), gapMatrix, undefined, businessDate)
    .rows.find((item) => item.key === "4");
  assert.equal(observed?.morningShotGapCount, 1);

  gapMatrix.capacity_observed_matrix!["4"][5] = false;
  const incomplete = buildRealtimeProgressSummary(planSummary([oldPlan]), gapMatrix, undefined, businessDate)
    .rows.find((item) => item.key === "4");
  assert.equal(incomplete?.morningShotGapCount, 0);
});

const dailyTargetDate = "2026-10-08";
const datedPlans: Array<ProductionPlanRecord & { date?: string; plan_date?: string }> = [
  { ...oldPlan, id: 10, date: dailyTargetDate, part_no: "ABJ76756112", planned_quantity: 535 },
  { ...newPlan, id: 11, date: dailyTargetDate, part_no: null, model_name: "汽车外部行李箱", planned_quantity: 400 },
  ...["2026-10-09", "2026-10-10", "2026-10-12"].map((date, index) => ({
    ...newPlan, id: 12 + index, date, part_no: null, model_name: "汽车外部行李箱", planned_quantity: 480,
  })),
  { ...newPlan, id: 15, plan_date: "2026-10-09", machine_name: "1400T-5", planned_quantity: 480 },
];

test("the selected day uses its Excel targets and retains a model-only plan", () => {
  const result = buildRealtimeProgressSummary(planSummary(datedPlans), undefined, undefined, dailyTargetDate);
  assert.equal(result.plannedQty, 935);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].partCount, 2);
  assert.deepEqual(result.rows[0].segments.map((segment) => segment.plannedQty), [535, 400]);
  assert.equal(result.rows[0].segments[1].partNo, "汽车外部行李箱");
  assert.equal(result.rows[0].segments[1].modelName, "汽车外部行李箱");
  assert.equal(result.rows[0].lastShotAt, null);
  assert.equal(result.rows[0].recentCycleTimeSec, null);
});

test("mixed-day status targets cannot restore future plans to the daily denominator", () => {
  const status: ProductionStatusResponse = {
    injection: [
      { machine_name: "1400T-4", total_planned: 2375, total_actual: 556, progress: 23.4, parts: [] },
      { machine_name: "1400T-5", total_planned: 480, total_actual: 7, progress: 1.5, parts: [] },
    ],
    machining: [],
  };
  const datedMatrix: InjectionProductionMatrix = {
    ...matrix(556),
    timestamp: "2026-10-08T18:30:00+08:00",
    time_slots: [{ hour_offset: 10, time: "2026-10-08T18:30:00+08:00", label: "18:30", interval_minutes: 2 }],
    machines: [
      ...matrix(0).machines,
      { machine_number: 5, machine_name: "5호기", tonnage: "1400T", display_name: "5호기" },
    ],
    actual_production_matrix: { "4": [556], "5": [7] },
  };
  const result = buildRealtimeProgressSummary(planSummary(datedPlans), datedMatrix, status, dailyTargetDate);
  assert.equal(result.plannedQty, 935);
  assert.equal(result.shotCount, 563);
  assert.equal(result.estimatedQty, 556);
  assert.equal(result.unplannedShotCount, 7);
  const current = result.rows.find((row) => row.key === "4");
  assert.ok(current);
  assert.deepEqual(current.segments.map((segment) => segment.allocatedShots), [556, 0]);
  assert.equal(current.lastShotAt, "2026-10-08T10:30:00.000Z");
  assert.equal(current.recentShots, 556);
  assert.equal(current.isRunning, true);
  const future = result.rows.find((row) => row.key === "5");
  assert.ok(future);
  assert.equal(future.hasPlan, false);
  assert.equal(future.plannedQty, 0);
});

test("the next date gets only its model target and its own machine plans", () => {
  const result = buildRealtimeProgressSummary(planSummary(datedPlans), undefined, undefined, "2026-10-09");
  assert.equal(result.plannedQty, 960);
  assert.deepEqual(result.rows.map((row) => row.plannedQty), [480, 480]);
  assert.deepEqual(result.rows[0].segments.map((segment) => segment.partNo), ["汽车外部行李箱"]);
});

test("daily filtering retains canonical allocations for the selected plan IDs", () => {
  const status: ProductionStatusResponse = {
    injection: [{
      machine_name: "1400T-4", total_planned: 2375, total_actual: 1036, progress: 43.6,
      parts: datedPlans.filter((plan) => plan.machine_name === "1400T-4").map((plan) => ({
        plan_id: plan.id, part_no: plan.part_no ?? null, model_name: plan.model_name ?? null,
        planned_quantity: plan.planned_quantity,
        actual_quantity: plan.id === 10 ? 556 : plan.id === 12 ? 480 : 0,
        allocated_shots: plan.id === 10 ? 556 : plan.id === 12 ? 480 : 0,
        progress: 0,
      })),
    }],
    machining: [],
  };
  const result = buildRealtimeProgressSummary(planSummary(datedPlans), undefined, status, dailyTargetDate);
  assert.equal(result.plannedQty, 935);
  assert.equal(result.estimatedQty, 556);
  assert.deepEqual(result.rows[0].segments.map((segment) => segment.planId), [10, 11]);
  assert.deepEqual(result.rows[0].segments.map((segment) => segment.allocatedShots), [556, 0]);
  assert.deepEqual(result.rows[0].segments.map((segment) => segment.estimatedQty), [556, 0]);
});

test("omitting the business date preserves the existing combined-plan fallback", () => {
  const result = buildRealtimeProgressSummary(planSummary(datedPlans), undefined);
  assert.equal(result.plannedQty, 2855);
  assert.equal(result.rows.length, 2);
  assert.equal(result.partCount, 6);
});

test("undated records inherit their response date instead of another selected day", () => {
  const futureSummary = { ...planSummary([oldPlan]), plan_date: "2026-09-15" };
  const result = buildRealtimeProgressSummary(futureSummary, undefined, undefined, businessDate);
  assert.equal(result.plannedQty, 0);
  assert.equal(result.rows.length, 0);
});
