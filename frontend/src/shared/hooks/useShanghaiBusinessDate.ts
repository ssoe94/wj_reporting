import { useEffect, useState } from "react";

import {
  addIsoDateDays,
  getShanghaiBusinessDateString,
  getShanghaiDateString,
} from "@/shared/utils/date";

const ROLLOVER_SETTLE_DELAY_MS = 250;

function nextBusinessRolloverDelay(value = new Date(), cutoffHour = 8) {
  const shanghaiDate = getShanghaiDateString(value);
  const hour = String(cutoffHour).padStart(2, "0");
  const todayBoundary = new Date(`${shanghaiDate}T${hour}:00:00+08:00`).getTime();
  const nextDate = value.getTime() < todayBoundary
    ? shanghaiDate
    : addIsoDateDays(shanghaiDate, 1);
  const nextBoundary = new Date(`${nextDate}T${hour}:00:00+08:00`).getTime();
  return Math.max(1_000, nextBoundary - value.getTime() + ROLLOVER_SETTLE_DELAY_MS);
}

/** Keeps unattended wallboards on the Shanghai 08:00 business day. */
export function useShanghaiBusinessDate(cutoffHour = 8) {
  const [businessDate, setBusinessDate] = useState(() => (
    getShanghaiBusinessDateString(new Date(), cutoffHour)
  ));

  useEffect(() => {
    let timer: number | undefined;
    const sync = () => {
      const next = getShanghaiBusinessDateString(new Date(), cutoffHour);
      setBusinessDate((current) => current === next ? current : next);
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        sync();
        schedule();
      }, nextBusinessRolloverDelay(new Date(), cutoffHour));
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") sync();
    };

    sync();
    schedule();
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [cutoffHour]);

  return businessDate;
}
