import assert from "node:assert/strict";
import test from "node:test";
import { canShowQualityAi, getBriefingDuration, getDisplayTextLength, getNumberDensity, getWeatherPresentation } from "../src/domains/boards/overview/presentation.ts";
import type { QualityAiSummary, WeatherStatus } from "../src/domains/boards/overview/types.ts";

const weather: WeatherStatus = {
  location: "Nanjing", status: "ok", isStale: false, temperatureC: 24,
  relativeHumidityPercent: 60, windSpeedMps: 2, conditionCode: "clear", dayPhase: "day",
  validAt: null, source: "fixture", sourceUrl: null, attribution: "Synthetic test",
};
const ai: QualityAiSummary = {
  status: "ready", businessDate: "2026-09-07", sourcePlanHash: "fixture-plan", sourceEvidenceHash: "fixture-evidence",
  generatedAt: null, completedAt: null, modelId: "qwen38", schemaVersion: "quality-daily-attention-ai.v1",
  generationSource: "fixture", llmFallback: false, llmFallbackCode: null,
  summary: { ko: "확인할 이력", zh: "待确认历史" }, disclaimer: null, totals: null, attentionItems: [], reason: null,
};

test("weather artwork follows the observed condition in both day phases", () => {
  const expected = { clear: "clear", partly_cloudy: "cloudy", cloudy: "cloudy", fog: "cloudy", rain: "rain", heavy_rain: "rain", snow: "snow", thunder: "thunder" };
  for (const dayPhase of ["day", "night"] as const) {
    for (const [conditionCode, artwork] of Object.entries(expected)) {
      assert.deepEqual(getWeatherPresentation({ ...weather, conditionCode, dayPhase }), { artwork, stale: false, unavailable: false });
    }
  }
});

test("unknown and unavailable weather cannot appear as confirmed cloudy observations", () => {
  assert.equal(getWeatherPresentation({ ...weather, conditionCode: "unknown" }).artwork, null);
  assert.equal(getWeatherPresentation({ ...weather, conditionCode: "new-provider-code" }).artwork, null);
  assert.deepEqual(getWeatherPresentation({ ...weather, status: "unavailable" }), { artwork: null, unavailable: true, stale: false });
  assert.equal(getWeatherPresentation({ ...weather, status: "stale" }).stale, true);
  assert.equal(getWeatherPresentation({ ...weather, isStale: true }).stale, true);
});

test("AI display preserves every evidence, date, model and language requirement", () => {
  assert.equal(canShowQualityAi(ai, "2026-09-07", "ko"), true);
  assert.equal(canShowQualityAi(ai, "2026-09-07", "zh"), true);
  for (const change of [
    { status: "pending" }, { status: "stale" }, { status: "unavailable" },
    { businessDate: "2026-09-06" }, { modelId: "other" }, { schemaVersion: "other" },
    { llmFallback: true }, { sourcePlanHash: null }, { sourceEvidenceHash: null },
    { summary: null }, { summary: { ko: "  ", zh: "待确认" } },
  ] as Partial<QualityAiSummary>[]) {
    assert.equal(canShowQualityAi({ ...ai, ...change }, "2026-09-07", "ko"), false, JSON.stringify(change));
  }
  assert.equal(canShowQualityAi(null, "2026-09-07", "ko"), false);
  assert.equal(canShowQualityAi({ ...ai, summary: { ko: "확인", zh: null } }, "2026-09-07", "zh"), false);
});

test("dense bilingual briefings receive a bounded reading interval without changing text", () => {
  assert.equal(getBriefingDuration("짧은 요약"), 12_000);
  assert.ok(getBriefingDuration("금형 상태 확인 ".repeat(20)) > 12_000);
  assert.equal(getBriefingDuration("检查模具状态".repeat(100)), 45_000);
  assert.ok(getDisplayTextLength("金型确认") > getDisplayTextLength("abcd"));
  assert.equal(getDisplayTextLength("🌤"), 1);
});

test("quantity typography adapts to grouped digits without rounding the value", () => {
  assert.equal(getNumberDensity("—"), "normal");
  assert.equal(getNumberDensity("128,400"), "normal");
  assert.equal(getNumberDensity("1,284,000"), "compact");
  assert.equal(getNumberDensity("128,400,000"), "dense");
  assert.equal(getNumberDensity("1,284,000,000"), "dense");
});
