import { useEffect, useState } from "react";
import { getBoardThemeSchedule, parseBoardThemeOverride, resolveBoardTheme, type BoardThemeOverride } from "./theme";

const STORAGE_KEY = "wj_overview_theme_override";

function readOverride() {
  try { return parseBoardThemeOverride(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}

export function useBoardTheme() {
  const [now, setNow] = useState(() => new Date());
  const [override, setOverride] = useState<BoardThemeOverride | null>(readOverride);
  const { nextChangeAt } = getBoardThemeSchedule(now);
  const theme = resolveBoardTheme(now, override);

  useEffect(() => {
    const update = () => setNow(new Date());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        setOverride(readOverride());
        update();
      }
    };
    const boundaryTimer = window.setTimeout(update, Math.max(0, nextChangeAt - Date.now()) + 25);
    const clockTimer = window.setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.clearTimeout(boundaryTimer);
      window.clearInterval(clockTimer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("storage", syncStorage);
    };
  }, [nextChangeAt]);

  const toggleTheme = () => {
    const currentTime = new Date();
    const next: BoardThemeOverride = {
      theme: resolveBoardTheme(currentTime, override) === "dark" ? "light" : "dark",
      expiresAt: getBoardThemeSchedule(currentTime).nextChangeAt,
    };
    setNow(currentTime);
    setOverride(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* This tab can still switch when storage is unavailable. */ }
  };

  return { theme, toggleTheme };
}
