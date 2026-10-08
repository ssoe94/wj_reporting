import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  assessmentTone, needsReconciliationReview, reconciliationQueryOptions, reconciliationSummary,
  type MesTaskReconciliation,
} from "../src/domains/production/mes-task-reconciliation.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mes-task-reconciliation.json", import.meta.url), "utf8")) as MesTaskReconciliation;
const fresh = () => structuredClone(fixture);

test("summary counts tasks and today's plans separately without duplicate starts", () => {
  const summary = reconciliationSummary(fresh());
  assert.equal(summary.pauseReview, 1);
  assert.equal(summary.taskLinkReview, 2);
  assert.equal(summary.startNeeded, 1);
  assert.equal(summary.noOpenTask, 2);
  assert.ok(summary.heldMachines! > 0);
});

test("absent, failed, partial and historical results never show normal zero summaries", () => {
  assert.equal(reconciliationSummary().pauseReview, null);
  assert.equal(reconciliationSummary(fresh(), true).pauseReview, null);
  for (const field of ["mes_complete", "assignment_complete", "plan_complete"] as const) {
    const data = fresh();
    data.data_freshness[field] = false;
    assert.equal(reconciliationSummary(data).pauseReview, null);
    assert.equal(reconciliationSummary(data).noOpenTask, null);
  }
  const data = fresh();
  data.warnings.push("current_snapshot_with_other_date");
  assert.equal(reconciliationSummary(data).startNeeded, null);
});

test("review filter retains incomplete plans and unknown task state", () => {
  const data = fresh();
  assert.equal(needsReconciliationReview(data.machines[0]), false);
  assert.equal(needsReconciliationReview(data.machines[1]), true);
  assert.equal(needsReconciliationReview(data.machines[16]), true);
  data.machines[0].plans[0].group_incomplete = true;
  assert.equal(needsReconciliationReview(data.machines[0]), true);
});

test("parallel parts from backend remain two plan memberships, without current-production status", () => {
  const machine = fresh().machines[9];
  const today = machine.plans.filter((plan) => plan.plan_date === fixture.business_date);
  assert.equal(today.length, 2);
  assert.deepEqual(today[0].parallel_parts, ["AAN30078443", "AAN30078444"]);
  assert.notEqual(today[0].sequence, today[1].sequence);
  assert.equal(machine.tasks.every((task) => task.assessment === "plan_match"), true);
  assert.equal(assessmentTone("plan_match"), "neutral");
});

test("mount and manual refresh only: no polling, focus, reconnect or retry", () => {
  const options = reconciliationQueryOptions("2026-10-08");
  assert.deepEqual(options.queryKey, ["production", "mes-task-reconciliation", "2026-10-08"]);
  assert.equal(options.refetchInterval, false);
  assert.equal(options.refetchOnWindowFocus, false);
  assert.equal(options.refetchOnReconnect, false);
  assert.equal(options.retry, false);
  assert.equal(options.refetchOnMount, "always");
});

test("every comparison message has Korean and Chinese translations", () => {
  const source = readFileSync(new URL("../src/i18n.tsx", import.meta.url), "utf8");
  const keys = [...source.matchAll(/'mesTasks\.([^']+)'\s*:/g)].map((match) => match[1]);
  const counts = new Map<string, number>();
  keys.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
  for (const [key, count] of counts) assert.equal(count, 2, key);
  const data = fresh();
  for (const machine of data.machines) {
    assert.equal(counts.get(`observation.${machine.observation.state}`), 2);
    for (const plan of machine.plans) assert.equal(counts.get(`assessment.${plan.assessment}`), 2);
    for (const task of machine.tasks) {
      assert.equal(counts.get(`assessment.${task.assessment}`), 2);
      task.reasons.forEach((reason) => assert.equal(counts.get(`reason.${reason}`), 2, reason));
    }
  }
});
