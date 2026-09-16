import assert from "node:assert/strict";
import test from "node:test";
import { buildCycleTimeTrend, cycleTimePartSearch, cycleTimePreviousDay, cycleTimeQueryParams, resolveCycleTimeScope, validCycleTimeRange, weightedCycleTime } from "../src/domains/mes/cycle-time-history.ts";
import type { CycleTimeDaily } from "../src/domains/mes/cycle-time-types.ts";

function row(overrides: Partial<CycleTimeDaily> = {}): CycleTimeDaily {
  return { business_date: "2026-09-15", machine_number: 12, machine_name: "12호기", cycle_time_seconds: 30, positive_interval_seconds: 300, shot_count: 10, observed_seconds: 300, sample_count: 6, coverage_percent: 100, quality: "available", parts: [], ...overrides };
}

test("Part No drilldown preserves complete identity and clears the API machine filter", () => {
  const search = cycleTimePartSearch("date=2026-09-15&machine=12&ct_start=2026-09-14&ct_end=2026-09-15&other=keep", "  H55C-A/LEFT  ");
  const scope = resolveCycleTimeScope(search.toString(), "2026-09-15", 12, "2026-09-16");
  assert.equal(scope.partNo, "H55C-A/LEFT");
  assert.equal(scope.machineNumber, null);
  assert.equal(search.get("machine"), "12", "Keep surrounding machine context for return");
  assert.equal(search.get("other"), "keep");
  assert.deepEqual(Object.fromEntries(cycleTimeQueryParams(scope)), { start_date: "2026-09-14", end_date: "2026-09-15", part_no: "H55C-A/LEFT" });
  const restored = resolveCycleTimeScope(cycleTimePartSearch(search.toString(), null).toString(), "2026-09-15", 12, "2026-09-16");
  assert.equal(restored.machineNumber, 12);
  assert.equal(restored.startDate, "2026-09-14");
});

test("invalid, future and oversized URL ranges fall back to seven Shanghai production dates", () => {
  for (const query of ["ct_start=2026-02-30&ct_end=2026-03-01", "ct_start=2026-09-15&ct_end=2026-09-14", "ct_start=2026-09-15&ct_end=2026-09-17", "ct_start=2025-01-01&ct_end=2026-09-15"]) {
    const scope = resolveCycleTimeScope(query, "2026-09-15", 12, "2026-09-16");
    assert.equal(scope.startDate, "2026-09-09");
    assert.equal(scope.endDate, "2026-09-15");
  }
  assert.equal(validCycleTimeRange("2024-01-01", "2024-12-31", "2026-09-16"), true);
  assert.equal(validCycleTimeRange("2024-01-01", "2025-01-01", "2026-09-16"), false);
});

test("C/T aggregates positive interval seconds by shots rather than averaging C/T values", () => {
  assert.equal(weightedCycleTime([row(), row({ cycle_time_seconds: 60, positive_interval_seconds: 60, shot_count: 1 })]), 360 / 11);
  assert.equal(weightedCycleTime([row({ cycle_time_seconds: null, positive_interval_seconds: 60, shot_count: 100, quality: "unavailable" })]), null);
  assert.equal(weightedCycleTime([row({ cycle_time_seconds: null, shot_count: 0, quality: "no_production" })]), null);
});

test("a missing production date remains a null chart gap for every machine", () => {
  const trend = buildCycleTimeTrend([row({ business_date: "2026-09-14" }), row({ business_date: "2026-09-16", machine_number: 11 })], "2026-09-14", "2026-09-16");
  assert.deepEqual(trend.machines, [11, 12]);
  assert.deepEqual(trend.points.map((point) => point.machine_12), [30, null, null]);
  assert.deepEqual(trend.points.map((point) => point.machine_11), [null, null, 30]);
});

test("prior-day comparison never silently skips an unavailable day", () => {
  const missing = cycleTimePreviousDay([row({ business_date: "2026-09-14" }), row({ business_date: "2026-09-16" })], "2026-09-16");
  assert.equal(missing.current, 30);
  assert.equal(missing.previous, null);
  assert.equal(missing.change, null);
  const complete = cycleTimePreviousDay([row(), row({ business_date: "2026-09-16", cycle_time_seconds: 36, positive_interval_seconds: 360 })], "2026-09-16");
  assert.equal(complete.change, 6);
});

test("trend tooltip attribution follows each day instead of treating estimates as confirmed", () => {
  const base = row();
  const actual = { ...base, part_no: "A", attribution: "execution_interval" as const };
  const estimate = { ...base, part_no: "A", attribution: "plan_estimated" as const };
  const result = buildCycleTimeTrend([
    row({ business_date: "2026-09-14", parts: [actual] }),
    row({ business_date: "2026-09-15", parts: [estimate] }),
    row({ business_date: "2026-09-16", parts: [actual, estimate] }),
  ], "2026-09-14", "2026-09-16");
  assert.deepEqual(result.points.map((point) => point.attribution_12), ["execution_interval", "plan_estimated", "mixed"]);
});
