import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInjectionTransitionAnalysis,
  hasSameModelDifferentPartNo,
  needsFieldPartNoReview,
} from "../src/domains/production/injection-transition-analysis.ts";
import type { InjectionProductionMatrix } from "../src/domains/mes/api.ts";
import type { ProductionPlanRecord, ProductionPlanSummaryResponse } from "../src/domains/production/api.ts";

const businessDate = "2026-09-28";
const firstPlan: ProductionPlanRecord = {
  id: 17317,
  machine_name: "550T-11",
  sequence: 1,
  part_no: "AAN30049855",
  model_name: "75NAN080",
  planned_quantity: 4,
  cavity: 4,
};
const nextPlan: ProductionPlanRecord = {
  ...firstPlan,
  id: 17325,
  sequence: 2,
  part_no: "MAM66002511",
};

function planSummary(records: ProductionPlanRecord[]): ProductionPlanSummaryResponse {
  const bucket = { records, machine_summary: [], model_summary: [], daily_totals: [] };
  return { plan_date: businessDate, injection: bucket, machining: { ...bucket, records: [] } };
}

function matrix(): InjectionProductionMatrix {
  const shots = [1, 0, 0, 0, 0, 0, 0, 1, 1, 1];
  return {
    timestamp: "2026-09-28T08:18:00+08:00",
    time_slots: shots.map((_, index) => ({
      hour_offset: index / 30,
      time: new Date(Date.parse("2026-09-28T08:00:00+08:00") + index * 120_000).toISOString(),
      label: String(index),
      interval_minutes: 2,
    })),
    machines: [{ machine_number: 11, machine_name: "11호기", tonnage: "550T", display_name: "11호기" }],
    actual_production_matrix: { "11": shots },
    cumulative_production_matrix: {},
    oil_temperature_matrix: {},
  };
}

test("same model and cavity with a different Part No. requires review after MES allocation advances", () => {
  assert.equal(hasSameModelDifferentPartNo(firstPlan, nextPlan), true);
  assert.equal(needsFieldPartNoReview(
    { ...firstPlan, status: "completed" },
    { ...nextPlan, actual_piece_qty: 8 },
  ), true);
  assert.equal(needsFieldPartNoReview(
    { ...firstPlan, status: "in_progress" },
    { ...nextPlan, actual_piece_qty: 8 },
  ), false);
  assert.equal(needsFieldPartNoReview(
    { ...firstPlan, status: "completed" },
    { ...nextPlan, actual_piece_qty: 0 },
  ), false);
  assert.equal(hasSameModelDifferentPartNo(firstPlan, { ...nextPlan, cavity: 2 }), false);
  assert.equal(hasSameModelDifferentPartNo({ ...firstPlan, cavity: 0 }, { ...nextPlan, cavity: 0 }), false);
  assert.equal(hasSameModelDifferentPartNo(firstPlan, { ...nextPlan, model_name: "OTHER" }), false);
});

test("same-model Part No. difference does not become an inferred mold change, while real model and core changes remain candidates", () => {
  const sameModel = buildInjectionTransitionAnalysis(planSummary([firstPlan, nextPlan]), matrix(), businessDate);
  assert.equal(sameModel.events.some((event) => event.type === "mold_change" || event.type === "core_change"), false);
  const stop = sameModel.events.find((event) => event.type === "production_stop");
  assert.equal(stop?.partNoReview, true);
  assert.equal(stop?.fromRecord?.part_no, firstPlan.part_no);
  assert.equal(stop?.toRecord?.part_no, nextPlan.part_no);

  const changedModel = buildInjectionTransitionAnalysis(
    planSummary([firstPlan, { ...nextPlan, model_name: "OTHER" }]), matrix(), businessDate,
  );
  assert.equal(changedModel.events.some((event) => event.type === "mold_change"), true);

  const changedCavity = buildInjectionTransitionAnalysis(
    planSummary([firstPlan, { ...nextPlan, cavity: 2 }]), matrix(), businessDate,
  );
  assert.equal(changedCavity.events.some((event) => event.type === "mold_change"), true);

  const changedCore = { ...nextPlan, part_no: "AAN30049856" };
  const core = buildInjectionTransitionAnalysis(planSummary([firstPlan, changedCore]), matrix(), businessDate);
  assert.equal(core.events.some((event) => event.type === "core_change"), true);
  assert.equal(needsFieldPartNoReview(
    { ...firstPlan, status: "completed" },
    { ...changedCore, actual_piece_qty: 8 },
  ), false);
});
