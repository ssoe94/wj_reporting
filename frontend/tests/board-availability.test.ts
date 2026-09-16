import assert from "node:assert/strict";
import test from "node:test";
import { isBoardMachineStale, summarizeBoardAvailability } from "../src/domains/production/board-availability.ts";

test("a fresh machine cannot hide another machine's collector gap", () => {
  const now = Date.parse("2026-09-16T12:17:00+08:00");
  const sources = {
    "15": { status: "ok" as const, latest_capacity_at: "2026-09-16T12:16:00+08:00" },
    "12": { status: "ok" as const, latest_capacity_at: "2026-09-16T12:08:00+08:00" },
  };
  assert.equal(isBoardMachineStale(sources, 15, now), false);
  assert.equal(isBoardMachineStale(sources, 12, now), true);
  sources["12"].latest_capacity_at = "2026-09-16T12:16:00+08:00";
  assert.equal(isBoardMachineStale(sources, 12, now), false);
});

test("missing or invalid observations cannot establish machine state", () => {
  assert.equal(isBoardMachineStale(undefined, 1, 0), true);
  assert.equal(isBoardMachineStale({}, 1, 0), true);
  for (const source of [
    { status: "missing" as const, latest_capacity_at: null },
    { status: "stale" as const, latest_capacity_at: "2026-09-16T12:16:00+08:00" },
    { status: "ok" as const, latest_capacity_at: "invalid" },
  ]) assert.equal(isBoardMachineStale({ "1": source }, 1, 0), true);
});

test("unknown machines count as neither running nor idle", () => {
  const result = summarizeBoardAvailability([
    { tone: "running", row: { hasPlan: true, isRunning: true } },
    { tone: "unplanned", row: { hasPlan: false, isRunning: true } },
    { tone: "stopped", row: { hasPlan: true, isRunning: false } },
    { tone: "idle", row: { hasPlan: false, isRunning: false } },
    { tone: "stale", row: { hasPlan: true, isRunning: false } },
    { tone: "stale", row: { hasPlan: true, isRunning: true } },
  ]);
  assert.deepEqual(result, { plannedRunningCount: 1, unplannedRunningCount: 1, totalRunningCount: 2, idleMachineCount: 2, staleMachineCount: 2 });
});
