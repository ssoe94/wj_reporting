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

test("a fresh but unchanged counter asks for signal verification instead of declaring a stop", () => {
  const tone = getBoardTone(planned, 50, false);
  assert.equal(tone, "signal");
  assert.equal(getBoardCycleTime(planned, tone), null);
  assert.equal(getBoardTone(planned, 50, true), "stale");
});

test("sparse counter changes do not display an implausibly short current cycle time", () => {
  const sparse = { ...planned, isRunning: true };
  const tone = getBoardTone(sparse, 50, false);
  assert.equal(tone, "warning");
  assert.equal(getBoardCycleTime(sparse, tone), null);
  assert.equal(getBoardCycleTime({ ...sparse, recentCycleTimeSec: 90 }, tone), 75);
});

test("a changeover estimate keeps its separate state", () => {
  assert.equal(getBoardTone({ ...planned, transition: { phase: "changeover" } }, 50, false), "stopped");
});
