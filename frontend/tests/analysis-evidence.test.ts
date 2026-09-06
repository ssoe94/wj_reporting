import assert from "node:assert/strict";
import test from "node:test";
import {
  getPriorityEquipment,
  getProcessEvidence,
  parseFieldOperations,
  type FieldOperationsData,
} from "../src/domains/analysis/model.ts";
import type { OverviewBoardModel, ProductionProcess } from "../src/domains/boards/overview/types.ts";

// Synthetic fixtures only. No API client, production data, or database access.
// Run: node --experimental-strip-types --test tests/analysis-evidence.test.ts
const BUSINESS_DATE = "2026-09-06";
const REPORTED_AT = "2026-09-06T10:00:00+08:00";

function overviewFixture(): OverviewBoardModel {
  const process = (key: ProductionProcess["key"]) => ({
    key, plannedQuantity: 100, actualQuantity: 0, completionRate: 0,
    remainingQuantity: 100, reportingMix: null,
  });
  // Other board sections are intentionally absent: these helpers consume only
  // production, source evidence, warnings, and the equipment candidates below.
  return {
    processes: { injection: process("injection"), assembly: process("assembly") },
    freshness: { sources: ["injection_production", "assembly_production"].map((key) => ({
      key, status: "ok", rowCount: 1, stale: false, sourceLatestAt: REPORTED_AT,
    })) },
    warnings: [],
    equipment: { injectionRows: [{
      id: "imm01", machineNumber: 1, sourceStatus: "ok", productionState: "planned_stopped",
      hasPlan: true, gapToTimeRate: -30,
    }] },
  } as unknown as OverviewBoardModel;
}

function fieldFixture(): FieldOperationsData {
  const noReports = {
    checkpoint_count: 0, zero_defect_checkpoint_count: 0,
    reported_defect_qty: null, estimated_gross_qty: null, derived_good_qty: null,
    latest_reported_at: null,
  };
  return {
    schema_version: "field-operations.v1", business_date: BUSINESS_DATE, status: "no_records",
    summary: { ...noReports, recorded_machine_count: 0 },
    coverage: {
      total_machine_count: 17, recorded_machine_count: 0, unrecorded_machine_count: 17,
      invalid_document_count: 0, invalid_checkpoint_count: 0, duplicate_checkpoint_count: 0,
    },
    freshness: {
      generated_at: REPORTED_AT, latest_reported_at: null, snapshot_updated_at: null,
      refresh_policy: "event_driven",
    },
    machines: Array.from({ length: 17 }, (_, index) => ({
      machine_number: index + 1, station_id: `imm${String(index + 1).padStart(2, "0")}`,
      status: "no_records", ...noReports,
    })),
    defects: [], warnings: [], used_data: [], calculation_basis: [],
  };
}

function assertEvaluationHeld(model: OverviewBoardModel, key: ProductionProcess["key"]) {
  const result = getProcessEvidence(model, key);
  assert.equal(result.canEvaluate, false);
  assert.equal(result.completionRate, null);
  assert.equal(result.remainingQuantity, null);
  assert.equal(result.gap, null);
  return result;
}

test("assembly MES-missing warning overrides an otherwise healthy source status", () => {
  const model = overviewFixture();
  model.warnings = ["assembly_mes_data_missing"];
  const result = assertEvaluationHeld(model, "assembly");
  assert.equal(result.actual, null);
  assert.equal(result.unavailable, true);
});

test("known manual production remains separately available without becoming a complete MES total", () => {
  const model = overviewFixture();
  model.warnings = ["assembly_mes_data_missing"];
  model.processes.assembly.actualQuantity = 25;
  model.processes.assembly.reportingMix = {
    effectiveActualQuantity: 25, mesConfirmedQuantity: 0, manualOpenQuantity: 25,
    matchedManualQuantity: 0, reportedDefectQuantity: 0, manualOpenSharePercent: 100,
    manualOpenRowCount: 1, dataQualityNote: null,
  };
  const result = assertEvaluationHeld(model, "assembly");
  assert.equal(result.actual, null);
  assert.equal(result.process.reportingMix?.manualOpenQuantity, 25);
});

test("injection MES-missing warning cannot turn unavailable production into zero", () => {
  const model = overviewFixture();
  model.warnings = ["injection_mes_data_missing"];
  assert.equal(assertEvaluationHeld(model, "injection").actual, null);
});

test("failed source status suppresses quantities for either process", () => {
  const model = overviewFixture();
  for (const source of model.freshness.sources ?? []) source.status = "error";
  for (const key of ["injection", "assembly"] as const) {
    assert.equal(assertEvaluationHeld(model, key).actual, null);
  }
});

test("production-context retrieval failure overrides healthy-looking process values", () => {
  const model = overviewFixture();
  model.warnings = ["production_context_unavailable"];
  for (const key of ["injection", "assembly"] as const) {
    assert.equal(assertEvaluationHeld(model, key).actual, null);
  }
});

for (const status of ["stale", "partial"]) {
  test(`${status} production retains the observation but withholds derived progress judgments`, () => {
    const model = overviewFixture();
    model.freshness.sources![0].status = status;
    model.processes.injection.actualQuantity = 30;
    const result = assertEvaluationHeld(model, "injection");
    assert.equal(result.actual, 30);
  });
}

test("explicit stale flag overrides source status ok", () => {
  const model = overviewFixture();
  model.freshness.sources![0].stale = true;
  assertEvaluationHeld(model, "injection");
});

test("MES-stale warning overrides source status ok even without its stale flag", () => {
  const model = overviewFixture();
  model.warnings = ["injection_mes_data_stale"];
  assertEvaluationHeld(model, "injection");
});

test("verified zero production remains zero despite an unrelated quality-source failure", () => {
  const model = overviewFixture();
  model.warnings = ["quality_history_unavailable"];
  for (const key of ["injection", "assembly"] as const) {
    const result = getProcessEvidence(model, key);
    assert.equal(result.canEvaluate, true);
    assert.equal(result.actual, 0);
    assert.equal(result.completionRate, 0);
    assert.equal(result.gap, -100);
  }
});

test("process-level MES failure changes a stopped-machine judgment to source verification", () => {
  const model = overviewFixture();
  assert.equal(getPriorityEquipment(model)[0].reason, "stopped");
  model.warnings = ["injection_mes_data_missing"];
  assert.equal(getPriorityEquipment(model)[0].reason, "source");
});

test("an unrecorded day preserves unknown defect and production quantities", () => {
  const result = parseFieldOperations(fieldFixture(), BUSINESS_DATE);
  assert.equal(result.summary.reported_defect_qty, null);
  assert.equal(result.summary.estimated_gross_qty, null);
  assert.equal(result.summary.derived_good_qty, null);
  assert.equal(result.machines[0].status, "no_records");
});

test("a saved zero-defect checkpoint remains distinct from its unrecorded neighboring machine", () => {
  const input = fieldFixture();
  const reported = {
    checkpoint_count: 1, zero_defect_checkpoint_count: 1,
    reported_defect_qty: 0, estimated_gross_qty: 20, derived_good_qty: 20,
    latest_reported_at: REPORTED_AT,
  };
  input.status = "ok";
  input.summary = { ...reported, recorded_machine_count: 1 };
  input.coverage.recorded_machine_count = 1;
  input.coverage.unrecorded_machine_count = 16;
  input.machines[0] = { ...input.machines[0], ...reported, status: "reported" };
  const result = parseFieldOperations(input, BUSINESS_DATE);
  assert.equal(result.summary.reported_defect_qty, 0);
  assert.equal(result.summary.zero_defect_checkpoint_count, 1);
  assert.equal(result.machines[0].reported_defect_qty, 0);
  assert.equal(result.machines[1].reported_defect_qty, null);
});

test("a response from another business day is rejected", () => {
  assert.throws(() => parseFieldOperations({ ...fieldFixture(), business_date: "2026-09-05" }, BUSINESS_DATE));
});

test("missing reports cannot be replaced by numeric zero at either aggregate or station level", () => {
  const summary = fieldFixture();
  summary.summary.reported_defect_qty = 0;
  assert.throws(() => parseFieldOperations(summary, BUSINESS_DATE));
  const station = fieldFixture();
  station.machines[0].reported_defect_qty = 0;
  assert.throws(() => parseFieldOperations(station, BUSINESS_DATE));
});

test("malformed defect quantities, warnings, and source timestamps are rejected", () => {
  const input = fieldFixture();
  for (const quantity of [null, -1, Number.NaN]) {
    assert.throws(() => parseFieldOperations({
      ...input, defects: [{ code: "scratch", reported_defect_qty: quantity, checkpoint_count: 1 }],
    }, BUSINESS_DATE));
  }
  assert.throws(() => parseFieldOperations({ ...input, warnings: "source unavailable" }, BUSINESS_DATE));
  assert.throws(() => parseFieldOperations({
    ...input, freshness: { ...input.freshness, latest_reported_at: "invalid timestamp" },
  }, BUSINESS_DATE));
});

test("duplicate stations and mismatched station identities cannot be accepted as coverage", () => {
  const duplicated = fieldFixture();
  duplicated.machines[1] = { ...duplicated.machines[0] };
  assert.throws(() => parseFieldOperations(duplicated, BUSINESS_DATE));
  const mismatched = fieldFixture();
  mismatched.machines[0].station_id = "imm02";
  assert.throws(() => parseFieldOperations(mismatched, BUSINESS_DATE));
});
