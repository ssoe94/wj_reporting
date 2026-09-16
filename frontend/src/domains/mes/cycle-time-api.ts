import { http } from "@/shared/api/http";
import { cycleTimeQueryParams } from "./cycle-time-history";
import type { CycleTimeHistoryResponse, CycleTimeHistoryScope } from "./cycle-time-types";

export async function getCycleTimeHistory(scope: CycleTimeHistoryScope, signal?: AbortSignal): Promise<CycleTimeHistoryResponse> {
  const response = await http.get<CycleTimeHistoryResponse>(`/injection/cycle-time-history/?${cycleTimeQueryParams(scope)}`, { signal });
  return response.data;
}
