export const BOARD_PART_STALE_MS = 5 * 60_000;

export const boardPartQueryKey = (partNo: string, businessDate: string) =>
  ["board-part-cycle-time", partNo.trim().toUpperCase(), businessDate] as const;

/** One request at a time: warming history must not compete with live collection. */
export async function prefetchBoardParts(parts: string[], load: (part: string) => Promise<unknown>, cancelled: () => boolean) {
  for (const part of [...new Set(parts.map(value => value.trim().toUpperCase()).filter(Boolean))]) {
    if (cancelled()) return;
    try { await load(part); } catch { /* A single failed part must not stop the queue. */ }
  }
}
