import assert from "node:assert/strict";
import test from "node:test";
import { FALLBACK_MOULD_BOARD } from "../src/domains/moulds/fallback.ts";

test("machine 7 fallback displays 1800T while preserving MES location and device codes", () => {
  const machine = FALLBACK_MOULD_BOARD.machines.find((item) => item.number === 7);
  assert.equal(machine?.tonnage, "1800T");
  assert.equal(machine?.deviceCode, "1300T-7");
  assert.equal(machine?.locationCode, "#7-1300T");
  assert.equal(FALLBACK_MOULD_BOARD.moulds.find((item) => item.location.machineNumber === 7)?.location.code, "#7-1300T");
});
