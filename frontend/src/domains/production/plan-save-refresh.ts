import type { QueryClient } from "@tanstack/react-query";

// The saved row is already in the cache. Slow or paused reads must not keep
// the mutation pending and lock the next row's Save button.
export function refreshPlanQueriesAfterSave(queryClient: QueryClient): void {
  void Promise.allSettled([
    queryClient.invalidateQueries({ queryKey: ["production"] }),
    queryClient.invalidateQueries({ queryKey: ["production-plan-summary"] }),
    queryClient.invalidateQueries({ queryKey: ["production-mes-report-stats"] }),
  ]);
}
