type DashboardDataSource = {
  label: string;
  enabled?: boolean;
  query: {
    data: unknown;
    isError: boolean;
    isFetching: boolean;
    dataUpdatedAt: number;
  };
};

// These sources supply the displayed KPI values, including authoritative
// injection allocations and machining quantities after manual correction.
export const CORE_DASHBOARD_SOURCE_KEYS = [
  "planSummaryQuery",
  "mesQuery",
  "machiningStatsQuery",
  "productionStatusQuery",
  "machiningProvisionQuery",
] as const;

export type CoreDashboardSourceKey = typeof CORE_DASHBOARD_SOURCE_KEYS[number];

export function buildCoreDashboardSources<TQueries extends Record<CoreDashboardSourceKey, DashboardDataSource["query"]>>(
  queries: TQueries,
  labels: Record<CoreDashboardSourceKey, string>,
): Array<{ key: CoreDashboardSourceKey; label: string; query: TQueries[CoreDashboardSourceKey] }> {
  return CORE_DASHBOARD_SOURCE_KEYS.map((key) => ({ key, label: labels[key], query: queries[key] }));
}

// Only required, enabled sources belong here. Optional AI queries must not
// turn a usable deterministic dashboard into a loading or error state.
export function getDashboardDataState(sources: DashboardDataSource[]) {
  const enabledSources = sources.filter((source) => source.enabled !== false);
  const missingSources = enabledSources.filter((source) => source.query.data == null);
  const failedSources = enabledSources.filter((source) => source.query.isError);
  const isReady = enabledSources.length > 0 && missingSources.length === 0;

  return {
    isReady,
    missingSources,
    failedSources,
    isInitialLoading: !isReady && failedSources.length === 0 && missingSources.some((source) => source.query.isFetching),
    isRefreshing: isReady && enabledSources.some((source) => source.query.isFetching),
    hasRefreshError: isReady && failedSources.length > 0,
  };
}
