import type { QualityAiSummary, WeatherStatus } from "./types";

export type WeatherArtwork = "clear" | "cloudy" | "rain" | "snow" | "thunder";

/** Missing observations must never look like a confirmed weather condition. */
export function getWeatherPresentation(weather: WeatherStatus) {
  const artworkByCondition: Record<string, WeatherArtwork> = {
    clear: "clear", partly_cloudy: "cloudy", cloudy: "cloudy", fog: "cloudy",
    rain: "rain", heavy_rain: "rain", snow: "snow", thunder: "thunder",
  };
  return {
    artwork: weather.status === "unavailable" ? null : artworkByCondition[weather.conditionCode] ?? null,
    unavailable: weather.status === "unavailable",
    stale: weather.status === "stale" || weather.isStale,
  };
}

/** Keep the existing board's evidence gate together, separate from visual treatment. */
export function canShowQualityAi(summary: QualityAiSummary | null, businessDate: string, language: "ko" | "zh") {
  return summary?.status === "ready"
    && summary.businessDate === businessDate
    && summary.modelId === "qwen38"
    && summary.schemaVersion === "quality-daily-attention-ai.v1"
    && !summary.llmFallback
    && Boolean(summary.sourcePlanHash)
    && Boolean(summary.sourceEvidenceHash)
    && Boolean(summary.summary?.[language]?.trim());
}

/** CJK glyphs occupy more width than Latin letters; code points keep emoji intact. */
export function getDisplayTextLength(text: string) {
  return Array.from(text).reduce((length, character) => length + ((character.codePointAt(0) ?? 0) > 255 ? 1 : 0.55), 0);
}

export function getBriefingDuration(text: string) {
  return Math.min(45_000, Math.max(12_000, Math.ceil(getDisplayTextLength(text) / 7 + 4) * 1_000));
}

export function getNumberDensity(value: string) {
  return value.length > 10 ? "dense" : value.length > 7 ? "compact" : "normal";
}
