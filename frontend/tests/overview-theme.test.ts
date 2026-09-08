import assert from "node:assert/strict";
import test from "node:test";
import { getBoardThemeSchedule, parseBoardThemeOverride, resolveBoardTheme } from "../src/domains/boards/overview/theme.ts";

test("Shanghai display switches to light at 08:00 and dark at 20:00 exactly", () => {
  for (const [time, theme, next] of [
    ["2026-09-08T07:59:59.999+08:00", "dark", "2026-09-08T08:00:00+08:00"],
    ["2026-09-08T08:00:00+08:00", "light", "2026-09-08T20:00:00+08:00"],
    ["2026-09-08T19:59:59.999+08:00", "light", "2026-09-08T20:00:00+08:00"],
    ["2026-09-08T20:00:00+08:00", "dark", "2026-09-09T08:00:00+08:00"],
  ]) {
    assert.deepEqual(getBoardThemeSchedule(new Date(time)), { theme, nextChangeAt: Date.parse(next) });
  }
});

test("display schedule uses Shanghai time regardless of input timezone or date rollover", () => {
  assert.equal(getBoardThemeSchedule(new Date("2026-09-08T00:00:00Z")).theme, "light");
  assert.equal(getBoardThemeSchedule(new Date("2026-09-07T20:00:00-04:00")).theme, "light");
  assert.deepEqual(getBoardThemeSchedule(new Date("2026-12-31T23:59:59+08:00")), {
    theme: "dark", nextChangeAt: Date.parse("2027-01-01T08:00:00+08:00"),
  });
  assert.deepEqual(getBoardThemeSchedule(new Date("2026-09-09T00:00:00+08:00")), {
    theme: "dark", nextChangeAt: Date.parse("2026-09-09T08:00:00+08:00"),
  });
});

test("manual choices survive reload within the interval and expire at the next automatic boundary", () => {
  const override = parseBoardThemeOverride(JSON.stringify({ theme: "dark", expiresAt: Date.parse("2026-09-08T20:00:00+08:00") }));
  assert.equal(resolveBoardTheme(new Date("2026-09-08T10:00:00+08:00"), override), "dark");
  assert.equal(resolveBoardTheme(new Date("2026-09-08T20:00:00+08:00"), override), "dark");
  assert.equal(resolveBoardTheme(new Date("2026-09-08T20:00:00+08:00"), { theme: "light", expiresAt: Date.parse("2026-09-08T20:00:00+08:00") }), "dark");
  assert.equal(resolveBoardTheme(new Date("2026-09-09T08:00:00+08:00"), { theme: "dark", expiresAt: Date.parse("2026-09-09T08:00:00+08:00") }), "light");
  assert.equal(resolveBoardTheme(new Date("2026-09-09T09:00:00+08:00"), override), "light");
  const nightOverride = { theme: "light" as const, expiresAt: Date.parse("2026-09-09T08:00:00+08:00") };
  assert.equal(resolveBoardTheme(new Date("2026-09-08T23:00:00+08:00"), nightOverride), "light");
  assert.equal(resolveBoardTheme(new Date("2026-09-09T20:00:00+08:00"), nightOverride), "dark");
});

test("malformed storage and choices from other clock intervals cannot override the current schedule", () => {
  for (const value of [null, "bad-json", "null", "[]", '{"theme":"system","expiresAt":1}', '{"theme":"dark","expiresAt":"1"}']) {
    assert.equal(parseBoardThemeOverride(value), null);
  }
  const futureOverride = { theme: "dark" as const, expiresAt: Date.parse("2026-09-10T20:00:00+08:00") };
  assert.equal(resolveBoardTheme(new Date("2026-09-08T09:00:00+08:00"), futureOverride), "light");
  assert.equal(resolveBoardTheme(new Date("2026-09-08T09:00:00+08:00"), null), "light");
});
