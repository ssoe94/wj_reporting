import type { RealtimeProgressRow } from "./realtime-progress";

export type BoardTone = "running" | "warning" | "shot_issue" | "stopped" | "overproducing" | "completed" | "unplanned" | "idle" | "stale";

type MachineEvidence = Pick<RealtimeProgressRow,
  "hasPlan" | "isRunning" | "progressRate" | "transition" | "expectedCycleTimeSec" | "recentCycleTimeSec"
>;

export function getBoardTone(row: MachineEvidence | undefined, elapsedRate: number, isStale: boolean): BoardTone {
  if (isStale) return "stale";
  if (!row) return "idle";
  if (row.transition?.phase === "changeover") return "stopped";
  if (!row.hasPlan) return row.isRunning ? "unplanned" : "idle";
  if (row.progressRate >= 99.9) return row.isRunning ? "overproducing" : "completed";
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
  if (tone === "stale" || tone === "shot_issue" || tone === "stopped" || tone === "idle" || tone === "completed") return null;
  // The active-slot estimate excludes long zero-counter gaps; such a value is
  // misleading when the observed hour contains far fewer shots than it implies.
  if (row?.recentCycleTimeSec && row.recentCycleTimeSec > cycleTime * 3) return null;
  return cycleTime;
}
