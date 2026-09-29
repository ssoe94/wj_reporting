import assert from "node:assert/strict";
import test from "node:test";
import { getBoardCycleTime, getBoardTone, isMesDataReadyForBusinessDate } from "../src/domains/production/board-machine-status.ts";

const planned = {
  hasPlan: true,
  isRunning: false,
  shotCount: 168,
  lastShotAt: "2026-09-28T20:38:00+08:00",
  progressRate: 25.7,
  transition: { phase: "running" as const },
  expectedCycleTimeSec: 75,
  recentCycleTimeSec: 1200,
};

test("a planned run with no recent shots gets a stop estimate", () => {
  const tone = getBoardTone(planned, 50, false);
  assert.equal(tone, "production_stopped");
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

test("an unconfirmed changeover remains a review candidate", () => {
  assert.equal(getBoardTone({ ...planned, transition: { phase: "changeover", confirmation_status: "pending" } }, 50, false), "transition_review");
  assert.equal(getBoardTone({ ...planned, transition: { phase: "changeover", confirmation_status: "confirmed" } }, 50, false), "stopped");
});

test("completed production and no-shot startup are not labeled as a stopped run", () => {
  assert.equal(getBoardTone({ ...planned, progressRate: 100 }, 50, false), "completed");
  assert.equal(getBoardTone({ ...planned, shotCount: 0 }, 50, false), "production_stopped");
  assert.equal(getBoardTone({ ...planned, shotCount: 0, lastShotAt: null }, 50, false), "shot_issue");
});

test("a new business day waits for a matching MES sample before classifying machines", () => {
  assert.equal(isMesDataReadyForBusinessDate(new Date("2026-09-29T07:58:00+08:00"), "2026-09-29"), false);
  assert.equal(isMesDataReadyForBusinessDate(new Date("2026-09-29T08:00:00+08:00"), "2026-09-29"), true);
  assert.equal(isMesDataReadyForBusinessDate(null, "2026-09-29"), false);
});
