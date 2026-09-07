import { CloudOff, MapPin } from "lucide-react";
import clearDay from "@/assets/overview-weather-clear-front.webp";
import clearNight from "@/assets/overview-weather-night-front.webp";
import cloudy from "@/assets/overview-weather-cloudy-front.webp";
import rain from "@/assets/overview-weather-rain-front.webp";
import snow from "@/assets/overview-weather-snow-front.webp";
import thunder from "@/assets/overview-weather-thunder-front.webp";
import { getWeatherPresentation } from "./presentation";
import type { WeatherStatus } from "./types";
import styles from "./WeatherDisplay.module.css";
import artworkStyles from "./OverviewArtwork.module.css";

const ARTWORK = {
  day: { clear: clearDay, cloudy, rain, snow, thunder },
  night: { clear: clearNight, cloudy, rain, snow, thunder },
};
const COPY = {
  ko: { place: "난징 날씨", stale: "이전 관측", unavailable: "날씨 미수신", observation: "관측", unknown: "상태 미확인" },
  zh: { place: "南京天气", stale: "历史观测", unavailable: "天气未接收", observation: "观测", unknown: "状态未确认" },
};

export function WeatherDisplay({ weather, language, conditionLabel }: {
  weather: WeatherStatus;
  language: "ko" | "zh";
  conditionLabel: string;
}) {
  const copy = COPY[language];
  const { artwork, unavailable, stale } = getWeatherPresentation(weather);
  const observedAt = weather.validAt ? new Date(weather.validAt) : null;
  const observation = observedAt && Number.isFinite(observedAt.getTime())
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(observedAt)
    : null;
  const temperature = !unavailable && weather.temperatureC !== null
    ? new Intl.NumberFormat(language === "ko" ? "ko-KR" : "zh-CN", { maximumFractionDigits: 1 }).format(weather.temperatureC)
    : "—";

  return (
    <section className={styles.weather} data-phase={weather.dayPhase} data-weather={artwork ?? "unknown"}
      data-stale={stale} aria-label={copy.place} title={weather.attribution}>
      <span className={styles.place}><MapPin aria-hidden="true" />{copy.place}</span>
      <div className={styles.temperature}>{temperature}{temperature === "—" ? null : <small>°C</small>}</div>
      <span className={styles.observation} role={stale || unavailable ? "status" : undefined}>
        {unavailable ? "—" : `${stale ? copy.stale : copy.observation}${observation ? ` ${observation}` : " —"}`}
      </span>
      <div className={styles.visual}>
        <div className={styles.artwork} aria-hidden="true">
          {artwork
            ? <img className={artworkStyles.animated} src={ARTWORK[weather.dayPhase][artwork]} alt="" data-weather-art={`${artwork}-${weather.dayPhase}`} />
            : <CloudOff />}
        </div>
        <strong className={styles.condition}>{unavailable ? copy.unavailable : artwork ? conditionLabel : copy.unknown}</strong>
      </div>
    </section>
  );
}
