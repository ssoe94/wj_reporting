import assert from "node:assert/strict";
import test from "node:test";
import {
  activityEvidenceBasis,
  assessOpenPlanGroup,
  assessPlannedMould,
  assessMachineMould,
  applyModelValidationRule,
  canCarryoverModel,
  chooseMachineEvidence,
  machineCardModel,
  machineIdentityConflict,
  machineIdentityEvidenceStatus,
  mergedActivityBasis,
  plannedMouldRelation,
} from "../src/domains/moulds/machine-plan-comparison.ts";

test("today's pending plan takes precedence over an older, different output model", () => {
  const planned = { date: "2026-09-28", model: "27G440A-BB.AMIEMKN" };
  const actual = { date: "2026-09-24", model: "32HL512D-BA.AWCKMPN" };
  assert.equal(chooseMachineEvidence(planned, actual, "2026-09-28"), planned);
  assert.equal(chooseMachineEvidence(planned, actual, "2026-09-29"), actual);
  assert.deepEqual(machineCardModel({ ...planned, basis: "planned_only", isRunning: false }, "2026-09-28"), {
    model: "27G440A-BB.AMIEMKN",
    planned: true,
  });
  assert.deepEqual(machineCardModel({ ...planned, basis: "planned_only", isRunning: true }, "2026-09-28"), {
    model: "27G440A-BB.AMIEMKN",
    planned: true,
  });
  assert.deepEqual(machineCardModel({ ...actual, basis: "last_output", isRunning: false }, "2026-09-28"), {
    model: actual.model, planned: false, recent: true, date: actual.date,
  });
  assert.equal(machineCardModel({ ...actual, basis: "last_output", isRunning: false }, "2026-10-02"), null);
});

test("machine 7 keeps its MES identity across the known temporary tonnage rename", () => {
  assert.equal(machineIdentityConflict("850T-2", 2, "850"), false);
  assert.equal(machineIdentityConflict("2500T-6", 6, "2500"), false);
  for (const rating of ["1300", "1800"]) {
    assert.equal(machineIdentityConflict("1300T-7", 7, rating), false);
    assert.equal(machineIdentityConflict("1800T-7", 7, rating), false);
    assert.equal(machineIdentityConflict("1400T-7", 7, rating), true);
    assert.equal(machineIdentityEvidenceStatus({
      sourceMachineName: "1800T-7", secondarySourceMachineName: "1300T-7",
    }, 7, rating), "match");
  }
  assert.equal(machineIdentityConflict("1300T-8", 8, "850"), true);
  assert.equal(machineIdentityConflict("1800T-6", 7, "1300"), true);
  assert.equal(machineIdentityConflict("2000T-7", 7, "1300"), true);
  assert.equal(machineIdentityConflict("1800T-3", 3, "1300"), true);
});

test("free-text mould names require review instead of an inferred match", () => {
  assert.equal(plannedMouldRelation("前仓行李箱", "蔚来汽车", "汽车外部行李箱"), "unknown");
  assert.equal(plannedMouldRelation("托盘", "JF2", "JF2"), "exact");
  assert.equal(plannedMouldRelation("托盘", "ＪＦ２", " jf2 "), "exact");
  assert.notEqual(plannedMouldRelation("托盘", "JF2", "JF3"), "exact");
  assert.equal(plannedMouldRelation("JF3", "JF2", "JF2"), "family");
  assert.equal(plannedMouldRelation("托盘", "", "托盘"), "unknown");
  assert.equal(plannedMouldRelation("27G440A", "", "27G440A-BB.AMIEMKN"), "family");
  assert.equal(plannedMouldRelation("27G440A-BB", "", "27G440A-CC"), "family");
  assert.equal(plannedMouldRelation("27G440A-BB", "", "27G440A-BB"), "exact");
  assert.equal(plannedMouldRelation("JF2", "JF2", "JF2"), "exact");
});

test("today's 2, 6 and 7 machine plans have distinct, reviewable outcomes", () => {
  assert.equal(assessPlannedMould(undefined, {
    model: "27G440A-BB.AMIEMKN", sourceMachineName: "850T-2",
  }, 2, "850"), "mould_missing");
  assert.equal(assessPlannedMould({ model: "前仓行李箱", drawingNo: "蔚来汽车" }, {
    model: "汽车外部行李箱", sourceMachineName: "2500T-6",
  }, 6, "2500"), "review");
  assert.equal(assessPlannedMould({ model: "托盘", drawingNo: "JF2" }, {
    model: "JF2", sourceMachineName: "1300T-7", secondarySourceMachineName: "1800T-7",
  }, 7, "1300"), "match");
  assert.equal(assessPlannedMould({ model: "27G440A-BB", drawingNo: "" }, {
    model: "27G440A-BB", sourceMachineName: "",
  }, 2, "850"), "machine_identity_unknown");
});

test("mixed or incomplete multi-part plans cannot be compared by their first model", () => {
  assert.deepEqual(assessOpenPlanGroup([
    { model_name: "JF2", parts_per_shot: 2, production_group_complete: true },
    { model_name: "JF3", parts_per_shot: 2, production_group_complete: true },
  ]), { unambiguous: false, multiCavity: true });
  assert.deepEqual(assessOpenPlanGroup([
    { model_name: "JF2", parts_per_shot: 2, production_group_complete: false },
  ]), { unambiguous: false, multiCavity: true });
  assert.deepEqual(assessOpenPlanGroup([
    { model_name: "JF2", parts_per_shot: 2, production_group_complete: true },
    { model_name: "JF2", parts_per_shot: 2, production_group_complete: true },
  ]), { unambiguous: true, multiCavity: true });
});

test("recent shots do not turn an unresolved plan model into observed production", () => {
  assert.equal(activityEvidenceBasis(1, "planned"), "planned_only");
  assert.equal(activityEvidenceBasis(1, "unresolved"), "ambiguous");
  assert.equal(activityEvidenceBasis(1, "resolved"), "active_estimate");
  const plannedActivity = { date: "2026-09-28", model: "", basis: "planned_only" };
  assert.equal(canCarryoverModel(plannedActivity, { date: "2026-09-24", model: "JF2", basis: "last_output" }), false);
  assert.equal(canCarryoverModel(plannedActivity, { date: "2026-09-28", model: "JF2", basis: "planned_only" }), true);
  assert.equal(mergedActivityBasis("planned_only", "planned_only"), "planned_only");
  assert.equal(mergedActivityBasis("active_estimate", "planned_only"), "planned_only");
});

test("drawing-based JF2 evidence is shared by active and planned comparisons without inventing activity", () => {
  const moulds = [{ model: "托盘", drawingNo: "JF2" }];
  const production = { date: "2026-09-28", model: "JF2", sourceMachineName: "1300T-7", isRunning: true, basis: "active_estimate" };
  assert.equal(assessMachineMould(moulds, production, 7, "1300T", "2026-09-28"), "match");
  assert.equal(assessMachineMould(moulds, { ...production, isRunning: false, basis: "planned_only" }, 7, "1300T", "2026-09-28"), "planned_match");
  assert.equal(assessMachineMould(moulds, { ...production, date: "2026-09-24", isRunning: false }, 7, "1300T", "2026-09-28"), "no_production");
  assert.equal(assessMachineMould(moulds, { ...production, date: "2026-09-24" }, 7, "1300T", "2026-09-28"), "stale");
  assert.equal(assessMachineMould(moulds, { ...production, basis: "ambiguous" }, 7, "1300T", "2026-09-28"), "ambiguous");
  assert.equal(assessMachineMould([...moulds, ...moulds], production, 7, "1300T", "2026-09-28"), "conflict");
  assert.notEqual(assessMachineMould(moulds, { ...production, model: "JF3" }, 7, "1300T", "2026-09-28"), "match");
});

test("saved model-pair decisions apply to plans without overriding operational evidence", () => {
  assert.equal(applyModelValidationRule("planned_review", "match"), "planned_match");
  assert.equal(applyModelValidationRule("planned_mismatch", "match"), "planned_match");
  assert.equal(applyModelValidationRule("planned_review", "mismatch"), "planned_mismatch");
  assert.equal(applyModelValidationRule("unknown", "match"), "confirmed_match");
  for (const state of ["no_production", "stale", "ambiguous", "conflict", "machine_identity_conflict", "machine_identity_unknown", "mould_missing"] as const) {
    assert.equal(applyModelValidationRule(state, "match"), state);
  }
});

test("missing per-machine collection never becomes a stopped or running conclusion", () => {
  const moulds = [{ model: "托盘", drawingNo: "JF2" }];
  const historical = { date: "2026-09-24", model: "JF2", sourceMachineName: "1300T-7", isRunning: false, basis: "active_estimate", sourceStatus: "missing" };
  assert.equal(assessMachineMould(moulds, historical, 7, "1300T", "2026-09-28"), "activity_unknown");
  assert.equal(applyModelValidationRule("activity_unknown", "match"), "activity_unknown");
  assert.deepEqual(machineCardModel(historical, "2026-09-28"), { model: "JF2", planned: false, recent: true, date: "2026-09-24" });
  const staleActivity = { ...historical, date: "2026-09-28", isRunning: true, sourceStatus: "stale" };
  assert.equal(assessMachineMould(moulds, staleActivity, 7, "1300T", "2026-09-28"), "activity_unknown");
  assert.deepEqual(machineCardModel(staleActivity, "2026-09-28"), { model: "JF2", planned: false, recent: true, date: "2026-09-28" });
  assert.equal(assessMachineMould(moulds, { ...historical, date: "2026-09-28", basis: "planned_only" }, 7, "1300T", "2026-09-28"), "planned_match");
});

test("new drawing exact matches retain a previously rejected model pair", () => {
  assert.equal(applyModelValidationRule("match", "mismatch"), "confirmed_mismatch");
  assert.equal(applyModelValidationRule("planned_match", "mismatch"), "planned_mismatch");
});
