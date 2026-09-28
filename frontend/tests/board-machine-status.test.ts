import assert from "node:assert/strict";
import test from "node:test";
import { getBoardCycleTime, getBoardTone } from "../src/domains/production/board-machine-status.ts";

const planned = {
  hasPlan: true,
  isRunning: false,
  progressRate: 25.7,
  transition: { phase: "running" as const },
  expectedCycleTimeSec: 75,
  recentCycleTimeSec: 1200,
};

test("missing observed shots flag a production issue without diagnosing its cause", () => {
  const tone = getBoardTone(planned, 50, false);
  assert.equal(tone, "shot_issue");
  assert.equal(getBoardCycleTime(planned, tone), null);
  assert.equal(getBoardTone(planned, 50, true), "stale");
});

test("sparse observed shots keep a visible production alert and hide the misleading cycle time", () => {
  const sparse = { ...planned, isRunning: true };
  const tone = getBoardTone(sparse, 50, false);
  assert.equal(tone, "shot_issue");
  assert.equal(getBoardCycleTime(sparse, tone), null);
  const normal = { ...sparse, recentCycleTimeSec: 90 };
  assert.equal(getBoardTone(normal, 50, false), "warning");
  assert.equal(getBoardCycleTime(normal, "warning"), 75);
});

test("a changeover estimate keeps its separate state", () => {
  assert.equal(getBoardTone({ ...planned, transition: { phase: "changeover" } }, 50, false), "stopped");
});
