import assert from "node:assert/strict";
import test from "node:test";
import {
  deepAnalysisRequestScope,
  describeDeepAnalysisSchedule,
  latestDeepAnalysisPath,
  type DeepAnalysisSchedule,
} from "../src/domains/ai/deep-analysis.ts";

const schedule: DeepAnalysisSchedule = {
  cadence: "daily", hour: 9, timezone: "Asia/Shanghai", context_days: 7,
  date_basis: "previous_completed_business_day",
};

test("latest results retain access to historical providers, while new requests use ChatGPT", () => {
  for (const kind of ["production_weekly", "quality_weekly"] as const) {
    for (const language of ["ko", "zh"] as const) {
      const query = new URL(latestDeepAnalysisPath(kind, language), "https://example.invalid").searchParams;
      assert.equal(query.get("model_id"), null);
      assert.equal(query.get("kind"), kind);
      assert.equal(query.get("language"), language);
      assert.deepEqual(deepAnalysisRequestScope(kind, language), { kind, language, model_id: "chatgpt" });
      assert.deepEqual(deepAnalysisRequestScope(kind, language, "2026-09-20"), {
        kind, language, model_id: "chatgpt", date: "2026-09-20",
      });
    }
  }
});

test("schedule copy uses the server-reported time and context without claiming scheduler health", () => {
  for (const language of ["ko", "zh"] as const) {
    const daily = describeDeepAnalysisSchedule(schedule, language);
    assert.doesNotMatch(daily, /실행 중|运行中/);
    assert.match(daily, /09:00/);
    assert.match(daily, /Asia\/Shanghai/);
    assert.match(daily, /7/);
    const changed = describeDeepAnalysisSchedule({ ...schedule, hour: 10, context_days: 5 }, language);
    assert.match(changed, /10:00/);
    assert.match(changed, /5/);
    assert.doesNotMatch(changed, /09:00|7/);
  }
});

test("missing or invalid schedule metadata never claims daily execution", () => {
  for (const language of ["ko", "zh"] as const) {
    assert.equal(describeDeepAnalysisSchedule(null, language), "");
    assert.equal(describeDeepAnalysisSchedule(undefined, language), "");
    assert.equal(describeDeepAnalysisSchedule({ ...schedule, hour: 24 }, language), "");
    assert.equal(describeDeepAnalysisSchedule({ ...schedule, context_days: 0 }, language), "");
  }
});
