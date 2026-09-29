import type { RealtimeProgressRow } from "./realtime-progress";

export type BoardTone = "running" | "warning" | "shot_issue" | "production_stopped" | "transition_review" | "stopped" | "overproducing" | "completed" | "unplanned" | "idle" | "stale";

type MachineEvidence = Pick<RealtimeProgressRow,
  "hasPlan" | "isRunning" | "shotCount" | "lastShotAt" | "progressRate" | "transition" | "expectedCycleTimeSec" | "recentCycleTimeSec"
>;

export function isMesDataReadyForBusinessDate(latestTime: Date | null, businessDate: string): boolean {
  const start = new Date(`${businessDate}T08:00:00+08:00`);
  return latestTime !== null && Number.isFinite(latestTime.getTime())
    && Number.isFinite(start.getTime()) && latestTime >= start;
}

export function getBoardTone(row: MachineEvidence | undefined, elapsedRate: number, isStale: boolean): BoardTone {
  if (isStale) return "stale";
  if (!row) return "idle";
  if (row.transition?.phase === "changeover") {
    return row.transition.confirmation_status === "confirmed" ? "stopped" : "transition_review";
  }
  if (!row.hasPlan) return row.isRunning ? "unplanned" : "idle";
  if (row.progressRate >= 99.9) return row.isRunning ? "overproducing" : "completed";
  // A previous production run followed by no recent counter increase suggests
  // a current stop. The board must label this as an estimate because the MES
  // counter can stall while the machine physically continues production.
  if (!row.isRunning && (row.shotCount > 0 || row.lastShotAt)) return "production_stopped";
  // Missing or sparse observed shots need a visible production alert. The
  // observations alone cannot distinguish equipment trouble from data trouble.
  if (!row.isRunning || (row.expectedCycleTimeSec && row.recentCycleTimeSec
    && row.recentCycleTimeSec > row.expectedCycleTimeSec * 3)) return "shot_issue";
  if (row.progressRate + 5 < elapsedRate) return "warning";
  return "running";
}

export function getBoardCycleTime(row: MachineEvidence | undefined, tone: BoardTone): number | null {
  const cycleTime = row?.expectedCycleTimeSec;
  if (!cycleTime || !Number.isFinite(cycleTime) || cycleTime <= 0) return null;
  if (tone === "stale" || tone === "shot_issue" || tone === "production_stopped" || tone === "transition_review" || tone === "stopped" || tone === "idle" || tone === "completed") return null;
  // The active-slot estimate excludes long zero-counter gaps; such a value is
  // misleading when the observed hour contains far fewer shots than it implies.
  if (row?.recentCycleTimeSec && row.recentCycleTimeSec > cycleTime * 3) return null;
  return cycleTime;
}
