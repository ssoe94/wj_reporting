// Keep the broad prefix compatible with snapshot refresh invalidation and the
// existing machine-scoped field queries. Fleet results must never fill a station.
export const INJECTION_MATRIX_QUERY_PREFIX = ["mes", "injection-production-matrix"] as const;

export function injectionFleetMatrixQueryOptions(businessDate: string, isCurrentDate: boolean) {
  return {
    queryKey: [
      ...INJECTION_MATRIX_QUERY_PREFIX,
      "fleet",
      businessDate,
      // Live uses the 2-minute/721-column request; historical uses the dated
      // 10-minute/145-column request. They are different response windows.
      isCurrentDate ? "live" : "historical",
    ] as const,
    staleTime: 30_000,
  };
}
