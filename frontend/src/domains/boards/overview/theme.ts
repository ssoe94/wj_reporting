export type BoardTheme = "light" | "dark";

export interface BoardThemeOverride {
  theme: BoardTheme;
  expiresAt: number;
}

const shanghaiClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai", hourCycle: "h23",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** Display hours are independent of the production business date and weather phase. */
export function getBoardThemeSchedule(now: Date) {
  const parts = shanghaiClock.formatToParts(now);
  const part = (name: string) => Number(parts.find((value) => value.type === name)?.value);
  const hour = part("hour");
  const nextHour = hour < 8 ? 8 : hour < 20 ? 20 : 32;
  const untilBoundary = ((nextHour - hour) * 3600 - part("minute") * 60 - part("second")) * 1000 - now.getMilliseconds();
  return {
    theme: hour >= 8 && hour < 20 ? "light" as const : "dark" as const,
    nextChangeAt: now.getTime() + untilBoundary,
  };
}

export function parseBoardThemeOverride(value: string | null): BoardThemeOverride | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || !("theme" in parsed) || !("expiresAt" in parsed)) return null;
    if ((parsed.theme !== "light" && parsed.theme !== "dark") || typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt)) return null;
    return { theme: parsed.theme, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export function resolveBoardTheme(now: Date, override: BoardThemeOverride | null): BoardTheme {
  const schedule = getBoardThemeSchedule(now);
  // Only a choice made in this daylight/night interval may override the schedule.
  return override && override.expiresAt > now.getTime() && override.expiresAt === schedule.nextChangeAt
    ? override.theme
    : schedule.theme;
}
