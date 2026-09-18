import type { AppLanguage } from "@/shared/i18n/language";

/**
 * Model-neutral AI labels. Persisted identifiers (`qwen38`, `claude`) never change;
 * every user-visible model name comes from server data through this module so a
 * model change is not a bilingual copy sweep.
 */
export type AiModelTier = "local" | "deep" | "unknown";

export const LOCAL_AI_MODEL_ID = "qwen38";
export const DEEP_ANALYSIS_MODEL_ID = "claude";

export const AI_MODEL_DISPLAY_NAMES: Record<string, string> = {
  [LOCAL_AI_MODEL_ID]: "Qwen 3.8 27B",
  [DEEP_ANALYSIS_MODEL_ID]: "Claude",
};

export const AI_MODEL_TIERS: Record<string, AiModelTier> = {
  [LOCAL_AI_MODEL_ID]: "local",
  [DEEP_ANALYSIS_MODEL_ID]: "deep",
};

export type AiModelDescription = {
  displayName: string;
  tier: AiModelTier;
};

/** Basename of a checkpoint path such as `/models/Qwen3.8-27B-4bit` -> `Qwen3.8-27B-4bit`. */
export function displayAiModelName(value: string | null | undefined) {
  const segments = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  return segments.length ? segments[segments.length - 1] : "";
}

/**
 * Resolve the display name and tier for a model. Preference order:
 * the API-provided `model_display_name`, the registry entry for `model_id`,
 * then the basename of the raw `model_name`.
 */
export function describeAiModel(input: {
  modelId?: string | null;
  modelName?: string | null;
  modelDisplayName?: string | null;
}): AiModelDescription {
  const modelId = String(input.modelId ?? "").trim();
  const tier: AiModelTier = (modelId && AI_MODEL_TIERS[modelId]) || "unknown";
  const explicit = String(input.modelDisplayName ?? "").trim();
  if (explicit) return { displayName: explicit, tier };
  const registered = modelId ? AI_MODEL_DISPLAY_NAMES[modelId] : undefined;
  if (registered) return { displayName: registered, tier };
  return { displayName: displayAiModelName(input.modelName), tier };
}

const TIER_LABELS: Record<AppLanguage, Record<Exclude<AiModelTier, "unknown">, string>> = {
  ko: { local: "AI 보조 분석", deep: "AI 심층 분석" },
  zh: { local: "AI 辅助分析", deep: "AI 深度分析" },
};

const WORKER_LABELS: Record<AppLanguage, { worker: string; online: string; offline: string; unknown: string }> = {
  ko: { worker: "AI 워커", online: "AI 워커 온라인", offline: "AI 워커 오프라인", unknown: "AI 워커 상태 확인 불가" },
  zh: { worker: "AI 处理端", online: "AI 处理端在线", offline: "AI 处理端离线", unknown: "无法确认 AI 处理端状态" },
};

/** "AI 보조 분석" / "AI 심층 분석" (ko) and "AI 辅助分析" / "AI 深度分析" (zh). Unknown tiers use the local wording. */
export function getAiTierLabel(tier: AiModelTier, language: AppLanguage) {
  return TIER_LABELS[language][tier === "deep" ? "deep" : "local"];
}

/** "AI 워커" / "AI 处理端". */
export function getAiWorkerLabel(language: AppLanguage) {
  return WORKER_LABELS[language].worker;
}

/** Append " · {displayName}" only when a display name is known. */
export function withAiModelName(label: string, displayName: string | null | undefined) {
  const name = String(displayName ?? "").trim();
  return name ? `${label} · ${name}` : label;
}

/** "AI 워커 온라인 · Qwen 3.8 27B" style labels; the model name is omitted when unknown. */
export function getAiWorkerStateLabel(
  state: "online" | "offline" | "unknown",
  language: AppLanguage,
  displayName?: string | null,
) {
  return withAiModelName(WORKER_LABELS[language][state], displayName);
}

/** "AI 보조 분석 · Qwen 3.8 27B" / "AI 심층 분석 · Claude". */
export function getAiTierModelLabel(tier: AiModelTier, language: AppLanguage, displayName?: string | null) {
  return withAiModelName(getAiTierLabel(tier, language), displayName);
}
