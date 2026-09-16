type MachineSource = { status: "ok" | "stale" | "missing"; latest_capacity_at: string | null };

/** Use observation time, never last positive shot time, to detect collector outages. */
export function isBoardMachineStale(
  sources: Record<string, MachineSource> | undefined,
  machineNumber: number,
  nowMs: number,
): boolean {
  const source = sources?.[String(machineNumber)];
  const latest = source?.latest_capacity_at ? Date.parse(source.latest_capacity_at) : NaN;
  return !source || source.status !== "ok" || !Number.isFinite(latest) || nowMs - latest > 300_000;
}

export function summarizeBoardAvailability(machines: Array<{
  tone: string;
  row?: { hasPlan: boolean; isRunning: boolean };
}>) {
  const known = machines.filter((machine) => machine.tone !== "stale");
  const plannedRunningCount = known.filter((machine) => machine.row?.hasPlan && machine.row.isRunning).length;
  const unplannedRunningCount = known.filter((machine) => !machine.row?.hasPlan && machine.row?.isRunning).length;
  const totalRunningCount = plannedRunningCount + unplannedRunningCount;
  return {
    plannedRunningCount, unplannedRunningCount, totalRunningCount,
    idleMachineCount: known.length - totalRunningCount,
    staleMachineCount: machines.length - known.length,
  };
}
