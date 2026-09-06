import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  buildCoreDashboardSources,
  CORE_DASHBOARD_SOURCE_KEYS,
  getDashboardDataState,
  type CoreDashboardSourceKey,
} from "../src/domains/production/dashboard-data-state.ts";

function createHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const observe = (label: string, queryFn: () => Promise<unknown>, enabled = true) => {
    const observer = new QueryObserver(client, { queryKey: [label], queryFn, enabled });
    return {
      observer,
      source: () => {
        observer.updateResult();
        return { label, enabled, query: observer.getCurrentResult() };
      },
    };
  };
  return { client, observe };
}

function createCoreHarness(total = 0) {
  const { client, observe } = createHarness();
  let failedKey: CoreDashboardSourceKey | null = null;
  const observed = Object.fromEntries(CORE_DASHBOARD_SOURCE_KEYS.map((key) => [
    key,
    observe(key, async () => {
      if (key === failedKey) throw new Error("unavailable");
      return { rows: [], total };
    }),
  ])) as Record<CoreDashboardSourceKey, ReturnType<typeof observe>>;
  const labels = Object.fromEntries(CORE_DASHBOARD_SOURCE_KEYS.map((key) => [key, key])) as Record<CoreDashboardSourceKey, string>;
  const sources = () => buildCoreDashboardSources({
    planSummaryQuery: observed.planSummaryQuery.source().query,
    mesQuery: observed.mesQuery.source().query,
    machiningStatsQuery: observed.machiningStatsQuery.source().query,
    productionStatusQuery: observed.productionStatusQuery.source().query,
    machiningProvisionQuery: observed.machiningProvisionQuery.source().query,
  }, labels);
  return {
    client,
    observe,
    sources,
    fail: (key: CoreDashboardSourceKey | null) => { failedKey = key; },
    refetch: () => Promise.all(sources().map(({ query }) => query.refetch())),
  };
}

test("successful empty responses are available data, including zero production", async () => {
  const { client, sources, refetch } = createCoreHarness();
  try {
    await refetch();
    assert.deepEqual(sources().map(({ key }) => key), [
      "planSummaryQuery", "mesQuery", "machiningStatsQuery", "productionStatusQuery", "machiningProvisionQuery",
    ]);
    const state = getDashboardDataState(sources());
    assert.equal(state.isReady, true);
    assert.equal(state.hasRefreshError, false);
    assert.equal(state.isInitialLoading, false);
    assert.deepEqual(state.missingSources, []);
  } finally {
    client.clear();
  }
});

for (const key of CORE_DASHBOARD_SOURCE_KEYS) {
  test(`${key}: initial failure blocks KPI values and recovers through the shared retry source list`, async () => {
    const { client, sources, fail, refetch } = createCoreHarness();
    try {
      fail(key);
      await refetch();
      const state = getDashboardDataState(sources());
      assert.equal(state.isReady, false);
      assert.equal(state.isInitialLoading, false);
      assert.equal(state.hasRefreshError, false);
      assert.deepEqual(state.missingSources.map(({ label }) => label), [key]);
      assert.deepEqual(state.failedSources.map(({ label }) => label), [key]);
      fail(null);
      await refetch();
      assert.equal(getDashboardDataState(sources()).isReady, true);
    } finally {
      client.clear();
    }
  });

  test(`${key}: failed refresh retains cached values as stale until retry succeeds`, async () => {
    const { client, sources, fail, refetch } = createCoreHarness(125);
    try {
      await refetch();
      const updatedAt = sources().find((source) => source.key === key)!.query.dataUpdatedAt;
      fail(key);
      await refetch();
      const stale = getDashboardDataState(sources());
      assert.equal(stale.isReady, true);
      assert.equal(stale.hasRefreshError, true);
      assert.deepEqual(stale.failedSources.map(({ label }) => label), [key]);
      assert.deepEqual(stale.failedSources[0].query.data, { rows: [], total: 125 });
      assert.equal(stale.failedSources[0].query.dataUpdatedAt, updatedAt);
      fail(null);
      await refetch();
      const recovered = getDashboardDataState(sources());
      assert.equal(recovered.isReady, true);
      assert.equal(recovered.hasRefreshError, false);
    } finally {
      client.clear();
    }
  });
}

test("first request remains loading while a required source is fetching", async () => {
  const { client, observe } = createHarness();
  try {
    let finish!: (data: unknown) => void;
    const plan = observe("plan", () => new Promise((resolve) => { finish = resolve; }));
    const request = plan.observer.refetch();
    const state = getDashboardDataState([plan.source()]);
    assert.equal(state.isReady, false);
    assert.equal(state.isInitialLoading, true);
    finish({ rows: [] });
    await request;
    assert.equal(getDashboardDataState([plan.source()]).isReady, true);
  } finally {
    client.clear();
  }
});

test("a known required-source error is visible even while another source is still loading", async () => {
  const { client, observe } = createHarness();
  try {
    let finish!: (data: unknown) => void;
    const pending = observe("plan", () => new Promise((resolve) => { finish = resolve; }));
    const failed = observe("injection", async () => { throw new Error("unavailable"); });
    const request = pending.observer.refetch();
    await failed.observer.refetch();
    const state = getDashboardDataState([pending.source(), failed.source()]);
    assert.equal(state.isReady, false);
    assert.equal(state.isInitialLoading, false);
    assert.deepEqual(state.failedSources.map(({ label }) => label), ["injection"]);
    finish({ rows: [] });
    await request;
  } finally {
    client.clear();
  }
});

test("disabled queries, including permission-limited sources, do not block required data", async () => {
  const { client, observe } = createHarness();
  try {
    const plan = observe("plan", async () => ({ rows: [] }));
    const disabled = observe("restricted", async () => { throw new Error("must not run"); }, false);
    await plan.observer.refetch();
    assert.equal(disabled.source().query.isPending, true);
    const state = getDashboardDataState([plan.source(), disabled.source()]);
    assert.equal(state.isReady, true);
    assert.equal(state.isInitialLoading, false);
    assert.deepEqual(state.failedSources, []);
  } finally {
    client.clear();
  }
});

test("optional AI failure leaves core data usable for deterministic screen fallback", async () => {
  const { client, observe, sources, refetch } = createCoreHarness();
  try {
    const ai = observe("ai-briefing", async () => { throw new Error("AI briefing unavailable"); });
    await Promise.all([refetch(), ai.observer.refetch()]);
    assert.equal(ai.source().query.isError, true);
    // AI is deliberately excluded from the required source list by the page.
    const state = getDashboardDataState(sources());
    assert.equal(state.isReady, true);
    assert.equal(state.hasRefreshError, false);
  } finally {
    client.clear();
  }
});
