import { queryOptions } from "@tanstack/react-query";
import { http } from "@/shared/api/http";
import { BOARD_PART_STALE_MS, boardPartQueryKey } from "./board-part-prefetch";
import type { BoardPartDay } from "./board-part-trend";

export function boardPartQueryOptions(partNo: string, businessDate: string) {
  return queryOptions({
    queryKey: boardPartQueryKey(partNo, businessDate),
    queryFn: async ({ signal }) => (await http.get<{
      start_date: string; end_date: string; cycle_time_seconds: number | null; daily: BoardPartDay[];
    }>(`/injection/board-part-cycle-time/?${new URLSearchParams({ part_no: partNo.trim().toUpperCase() })}`, { signal })).data,
    staleTime: BOARD_PART_STALE_MS, gcTime: 30 * 60_000, retry: 1,
  });
}
