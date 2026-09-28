import assert from "node:assert/strict";
import test from "node:test";

import {
  fromShanghaiDateTimeInput,
  toShanghaiDateTimeInput,
} from "../src/pages/field/transitionStartTime.ts";

test("field start confirmation preserves Shanghai wall time across the business-day boundary", () => {
  assert.equal(toShanghaiDateTimeInput("2026-09-28T18:36:20+08:00"), "2026-09-28T18:36");
  assert.equal(fromShanghaiDateTimeInput("2026-09-28T18:36"), "2026-09-28T10:36:00.000Z");
  assert.equal(toShanghaiDateTimeInput("2026-09-28T23:40:00Z"), "2026-09-29T07:40");
});

test("field start confirmation rejects invalid local times instead of silently rolling dates", () => {
  assert.equal(fromShanghaiDateTimeInput("2026-02-30T18:36"), null);
  assert.equal(fromShanghaiDateTimeInput("2026-09-28T25:00"), null);
  assert.equal(fromShanghaiDateTimeInput(""), null);
});
