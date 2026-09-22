import assert from "node:assert/strict";
import test from "node:test";
import { describeLocalAiHistory, getLocalAiAnalysisState } from "../src/domains/ai/local-ai-history.ts";

const latest = "2026-09-21T02:00:00Z";
const prior = "2026-09-21T01:00:00Z";

test("fallback completion never becomes AI success even when timestamps match", () => {
  const result = {
    last_analysis_completed_at: latest, last_analysis_llm_fallback: true,
    last_analysis_source: "local_llm_rewrite", last_successful_analysis_at: latest, last_analysis_fallback_code: "grounding_rejected",
  };
  assert.equal(getLocalAiAnalysisState(result), "fallback");
  for (const language of ["ko", "zh"] as const) {
    const description = describeLocalAiHistory(result, language);
    assert.ok(description.reason);
    assert.doesNotMatch(description.label, /성공|成功/);
  }
});

test("latest real success requires explicit model provenance and no fallback", () => {
  assert.equal(getLocalAiAnalysisState({
    last_analysis_completed_at: latest, last_analysis_llm_fallback: false,
    last_analysis_source: "local_llm_rewrite", last_successful_analysis_at: prior,
  }), "success");
  assert.equal(getLocalAiAnalysisState({
    last_analysis_completed_at: latest, last_analysis_llm_fallback: false,
    last_analysis_source: "deterministic", last_successful_analysis_at: latest,
  }), "unverified");
  assert.equal(getLocalAiAnalysisState({ last_analysis_completed_at: latest, last_analysis_llm_fallback: false }), "unverified");
  assert.equal(getLocalAiAnalysisState({
    last_analysis_completed_at: latest, last_analysis_source: "local_llm_rewrite", last_successful_analysis_at: latest,
  }), "unverified");
});

test("fallback reasons distinguish grounding checks from response format checks in both languages", () => {
  for (const [code, ko, zh] of [
    ["grounding_rejected", "설명 근거·형식 검증 실패", "说明依据·格式校验失败"],
    ["response_format_rejected", "설명 형식 검증 실패", "说明格式校验失败"],
  ] as const) {
    const history = {
      last_analysis_completed_at: latest,
      last_analysis_llm_fallback: true,
      last_analysis_fallback_code: code,
    };
    assert.equal(describeLocalAiHistory(history, "ko").reason, ko);
    assert.equal(describeLocalAiHistory(history, "zh").reason, zh);
    assert.equal(describeLocalAiHistory({ ...history, last_analysis_llm_fallback: false }, "ko").reason, "");
  }
});

test("unavailable, absent and malformed history remain distinct from confirmed success", () => {
  assert.equal(getLocalAiAnalysisState(undefined), "unknown");
  assert.equal(getLocalAiAnalysisState({ last_analysis_completed_at: null }), "none");
  assert.equal(getLocalAiAnalysisState({
    last_analysis_completed_at: "invalid", last_analysis_llm_fallback: false, last_analysis_source: "local_llm_rewrite",
  }), "unverified");
  assert.equal(describeLocalAiHistory({
    last_analysis_completed_at: latest, last_analysis_llm_fallback: false,
    last_analysis_source: "local_llm_rewrite", last_analysis_fallback_code: "timeout",
  }, "ko").reason, "");
});
