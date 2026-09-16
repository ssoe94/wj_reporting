import assert from "node:assert/strict";
import test from "node:test";
import { buildCavityEditPartNos } from "../src/domains/production/cavity-edit-payload.ts";

test("machine 12: a newly entered Part No survives an empty original cavity list", () => {
  assert.deepEqual(buildCavityEditPartNos("", "75NAN080-Inner", []), ["75NAN080-INNER"]);
});
test("a new Part No is included alongside selected co-production partners", () => {
  assert.deepEqual(buildCavityEditPartNos("", "NEW-PART", ["PARTNER"]), ["NEW-PART", "PARTNER"]);
});
test("renaming replaces the old identity and preserves group partners", () => {
  assert.deepEqual(buildCavityEditPartNos("OLD", "NEW", ["PARTNER", "OLD"]), ["NEW", "PARTNER"]);
});
test("unchanged identity, split groups, and duplicate normalized entries remain unique", () => {
  assert.deepEqual(buildCavityEditPartNos(" a ", " A", ["a", " B", "b", ""]), ["A", "B"]);
});
test("an empty edited Part No never produces a partner-only cavity update", () => {
  assert.deepEqual(buildCavityEditPartNos("OLD", " ", ["OLD", "PARTNER"]), []);
});
