import test from "node:test";
import assert from "node:assert/strict";
import { materialRequirement } from "../src/domains/production/plan-workflow-form.ts";
test("reviewed ratio gives material requirement without float conversion", () => {
  assert.equal(materialRequirement("2300", "0.02", "1"), "46");
  assert.equal(materialRequirement("3200", "0.02", "1"), "64");
  assert.equal(materialRequirement("3", "0.1", "1"), "0.3");
});
test("invalid, zero, exponent and repeating ratios require correction", () => {
  for (const value of ["", "-", "NaN", "Infinity", "1e3", "0", "-1"])
    assert.equal(materialRequirement("1000", value, "1"), null);
  assert.equal(materialRequirement("1", "1", "3"), null);
  assert.equal(materialRequirement("1000", "2", "0"), null);
});
