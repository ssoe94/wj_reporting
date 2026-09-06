import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { coversMonitoringWindow, hasObservedCapacityInWindow, isMonitoringSlotInWindow, trimMonitoringSlots, getMonitoringCoverage, getMonitoringState, hasMonitoringMatrix } from "../src/domains/mes/monitoring-state.ts";
import type { InjectionProductionMatrix } from "../src/domains/mes/api.ts";

function matrix(): InjectionProductionMatrix {
  return {
    timestamp: "2026-09-04T10:00:00+08:00", counter_policy: "reset-aware-v1",
    time_slots: [{ hour_offset: 1, time: "2026-09-04T08:00:00+08:00", label: "08" }, { hour_offset: 0, time: "2026-09-04T10:00:00+08:00", label: "10" }],
    machines: [{ machine_number: 1, machine_name: "1", display_name: "1", tonnage: "850T" }],
    actual_production_matrix: { "1": [0, 0] }, cumulative_production_matrix: { "1": [100, 100] }, oil_temperature_matrix: {},
    machine_sources: { "1": { status: "ok", latest_capacity_at: "2026-09-04T10:00:00+08:00", sample_count: 2, observed_slot_count: 2, total_slot_count: 2 } },
    capacity_observed_matrix: { "1": [true, true] },
  };
}
const ready = (data: unknown) => ({ data, isError: false, isPending: false });

test("a cached success cannot bypass a refresh error", () => {
  assert.equal(getMonitoringState([{ ...ready(matrix()), isError: true }]), "error");
});
test("an independent missing dependency cannot become zero or ready", () => {
  assert.equal(getMonitoringState([ready(matrix()), { data: undefined, isPending: true, isError: false }]), "loading");
  assert.equal(getMonitoringState([ready(matrix()), ready(undefined)]), "empty");
});
test("an empty normalized matrix is unavailable evidence", () => {
  const data = { ...matrix(), time_slots: [] };
  assert.equal(hasMonitoringMatrix(data), false);
  assert.equal(getMonitoringState([ready(data)], hasMonitoringMatrix(data)), "empty");
});
test("observed zero counters remain valid data", () => {
  const coverage = getMonitoringCoverage(matrix());
  assert.equal(coverage.ready, true);
  assert.equal(coverage.hasGaps, false);
});
test("legacy coverage absence cannot establish a stopped machine", () => {
  const coverage = getMonitoringCoverage({ ...matrix(), machine_sources: undefined });
  assert.equal(coverage.known, false);
  assert.equal(coverage.ready, false);
});
test("stale and missing machine samples cannot establish current conclusions", () => {
  for (const status of ["stale", "missing"] as const) {
    const data = matrix();
    data.machine_sources!["1"].status = status;
    assert.equal(getMonitoringCoverage(data).ready, false);
  }
});
test("a selected machine is not blocked by a different missing machine", () => {
  const data = matrix();
  data.machines.push({ ...data.machines[0], machine_number: 2 });
  data.machine_sources!["2"] = { ...data.machine_sources!["1"], status: "missing", sample_count: 0, observed_slot_count: 0 };
  assert.equal(getMonitoringCoverage(data).ready, false);
  assert.equal(getMonitoringCoverage(data, 1).ready, true);
  assert.equal(getMonitoringCoverage(data, 2).ready, false);
});
test("unobserved slots block automatic stop inference", () => {
  const data = matrix();
  data.machine_sources!["1"].observed_slot_count = 1;
  data.capacity_observed_matrix!["1"][1] = false;
  assert.equal(getMonitoringCoverage(data).hasGaps, true);
});
test("legacy unversioned rollups cannot support a reset-aware total", () => {
  const data = matrix();
  data.warnings = ["stored_rollup_counter_policy_unversioned"];
  assert.equal(getMonitoringCoverage(data).ready, false);
  assert.equal(getMonitoringCoverage(data).policyUnverified, true);
});
test("a preceding-day comparison requires the entire preceding window", () => {
  assert.equal(coversMonitoringWindow(matrix(), new Date("2026-09-03T08:00:00+08:00"), new Date("2026-09-03T10:00:00+08:00")), false);
  assert.equal(coversMonitoringWindow(matrix(), new Date("2026-09-04T08:00:00+08:00"), new Date("2026-09-04T10:00:00+08:00")), true);
});

test("an observed zero is distinct from an unobserved chart bucket", () => {
  const data = matrix();
  const start = new Date("2026-09-04T10:00:00+08:00");
  const end = new Date("2026-09-04T11:00:00+08:00");
  assert.equal(hasObservedCapacityInWindow(data, 1, start, end), true);
  data.capacity_observed_matrix!["1"][1] = false;
  assert.equal(hasObservedCapacityInWindow(data, 1, start, end), false);
});

test("a real QueryObserver refresh failure retains data but defers monitoring conclusions", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let fail = false;
  const observer = new QueryObserver(client, {
    queryKey: ["monitoring-test"],
    queryFn: async () => {
      if (fail) throw new Error("source unavailable");
      return matrix();
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    assert.equal(getMonitoringState([observer.getCurrentResult()]), "ready");
    fail = true;
    await observer.refetch();
    const result = observer.getCurrentResult();
    assert.ok(result.data);
    assert.equal(getMonitoringState([result]), "error");
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("business-day bucket totals include opening 08:00 and exclude next-day 08:00", () => {
  const start = new Date("2026-09-04T08:00:00+08:00");
  const end = new Date("2026-09-05T08:00:00+08:00");
  const values = [[start.getTime(), 5], [start.getTime() + 600_000, 7], [end.getTime(), 11]];
  assert.equal(values.filter(([time]) => isMonitoringSlotInWindow(time, start, end)).reduce((sum, [, qty]) => sum + qty, 0), 12);
  const data = matrix();
  data.time_slots.push({ hour_offset: 0, time: end.toISOString(), label: "next08" });
  data.actual_production_matrix["1"] = [5, 7, 11];
  data.capacity_observed_matrix!["1"] = [true, true, true];
  const scoped = trimMonitoringSlots(data, start, end)!;
  assert.deepEqual(scoped.actual_production_matrix["1"], [5, 7]);
  assert.equal(scoped.time_slots.length, scoped.capacity_observed_matrix!["1"].length);
});
