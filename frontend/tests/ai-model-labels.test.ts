import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_MODEL_DISPLAY_NAMES,
  describeAiModel,
  displayAiModelName,
  getAiTierLabel,
  getAiTierModelLabel,
  getAiWorkerLabel,
  getAiWorkerStateLabel,
  withAiModelName,
} from "../src/domains/ai/model-labels.ts";

test("registry maps persisted model ids to display names and tiers", () => {
  assert.deepEqual(AI_MODEL_DISPLAY_NAMES, { qwen38: "Qwen 3.8 27B", claude: "Claude" });
  assert.deepEqual(describeAiModel({ modelId: "qwen38" }), { displayName: "Qwen 3.8 27B", tier: "local" });
  assert.deepEqual(describeAiModel({ modelId: "claude" }), { displayName: "Claude", tier: "deep" });
});

test("API display name wins, then the registry, then the checkpoint basename", () => {
  assert.equal(describeAiModel({ modelId: "qwen38", modelDisplayName: "Server Name" }).displayName, "Server Name");
  assert.equal(describeAiModel({ modelId: "qwen38", modelName: "/models/Other" }).displayName, "Qwen 3.8 27B");
  assert.deepEqual(
    describeAiModel({ modelId: "unknown-id", modelName: "/Users/x/models/Qwen3.8-27B-4bit" }),
    { displayName: "Qwen3.8-27B-4bit", tier: "unknown" },
  );
  assert.deepEqual(describeAiModel({ modelName: "C:\\models\\Qwen3.8-27B-4bit" }), { displayName: "Qwen3.8-27B-4bit", tier: "unknown" });
  assert.deepEqual(describeAiModel({}), { displayName: "", tier: "unknown" });
  assert.equal(describeAiModel({ modelId: "qwen38", modelDisplayName: "   " }).displayName, "Qwen 3.8 27B");
  assert.equal(displayAiModelName(null), "");
  assert.equal(displayAiModelName(" /a/b/ "), "b");
});

test("tier and worker labels are bilingual and neutral", () => {
  assert.equal(getAiTierLabel("local", "ko"), "AI 보조 분석");
  assert.equal(getAiTierLabel("local", "zh"), "AI 辅助分析");
  assert.equal(getAiTierLabel("deep", "ko"), "AI 심층 분석");
  assert.equal(getAiTierLabel("deep", "zh"), "AI 深度分析");
  assert.equal(getAiTierLabel("unknown", "ko"), "AI 보조 분석");
  assert.equal(getAiWorkerLabel("ko"), "AI 워커");
  assert.equal(getAiWorkerLabel("zh"), "AI 处理端");
  for (const language of ["ko", "zh"] as const) {
    for (const label of [getAiTierLabel("local", language), getAiTierLabel("deep", language), getAiWorkerLabel(language)]) {
      assert.doesNotMatch(label, /qwen|claude|mac ?studio/i, label);
    }
  }
});

test("state labels append the display name only when it is known", () => {
  assert.equal(getAiWorkerStateLabel("online", "ko", "Qwen 3.8 27B"), "AI 워커 온라인 · Qwen 3.8 27B");
  assert.equal(getAiWorkerStateLabel("offline", "zh", "Qwen 3.8 27B"), "AI 处理端离线 · Qwen 3.8 27B");
  assert.equal(getAiWorkerStateLabel("offline", "ko"), "AI 워커 오프라인");
  assert.equal(getAiWorkerStateLabel("unknown", "ko", ""), "AI 워커 상태 확인 불가");
  assert.equal(getAiWorkerStateLabel("unknown", "zh", null), "无法确认 AI 处理端状态");
  assert.equal(getAiTierModelLabel("deep", "zh", "Claude"), "AI 深度分析 · Claude");
  assert.equal(getAiTierModelLabel("local", "ko", undefined), "AI 보조 분석");
  assert.equal(withAiModelName("AI 요약", " Qwen 3.8 27B "), "AI 요약 · Qwen 3.8 27B");
});
