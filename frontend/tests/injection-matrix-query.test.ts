import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import {
  INJECTION_MATRIX_QUERY_PREFIX,
  injectionFleetMatrixQueryOptions,
} from "../src/domains/mes/injection-matrix-query.ts";

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

test("identical fleet requests share in-flight work and fresh results across page consumers", async () => {
  const client = createClient();
  let calls = 0;
  let resolve!: (value: { timestamp: string; machines: number[] }) => void;
  const queryFn = () => {
    calls += 1;
    return new Promise<{ timestamp: string; machines: number[] }>((finish) => { resolve = finish; });
  };
  try {
    const dashboard = client.fetchQuery({ ...injectionFleetMatrixQueryOptions("2026-09-08", true), queryFn });
    const monitoring = client.fetchQuery({ ...injectionFleetMatrixQueryOptions("2026-09-08", true), queryFn });
    assert.equal(calls, 1);
    resolve({ timestamp: "2026-09-08T11:00:00+08:00", machines: [1, 2] });
    assert.deepEqual(await dashboard, await monitoring);
    await client.fetchQuery({ ...injectionFleetMatrixQueryOptions("2026-09-08", true), queryFn });
    assert.equal(calls, 1);
  } finally {
    client.clear();
  }
});

test("business dates, live/historical windows, and field machine scopes remain separate", async () => {
  const client = createClient();
  try {
    const current = injectionFleetMatrixQueryOptions("2026-09-08", true);
    client.setQueryData(current.queryKey, { source: "current-fleet" });
    assert.equal(client.getQueryData(injectionFleetMatrixQueryOptions("2026-09-08", false).queryKey), undefined);
    assert.equal(client.getQueryData(injectionFleetMatrixQueryOptions("2026-09-07", false).queryKey), undefined);
    assert.equal(client.getQueryData([...INJECTION_MATRIX_QUERY_PREFIX, "2026-09-08", true, 1]), undefined);
    assert.equal(client.getQueryData([...INJECTION_MATRIX_QUERY_PREFIX, "2026-09-08", true, 2]), undefined);
    const historical = await client.fetchQuery({
      ...injectionFleetMatrixQueryOptions("2026-09-08", false),
      queryFn: async () => ({ source: "dated-fleet" }),
    });
    assert.equal(historical.source, "dated-fleet");
    assert.deepEqual(client.getQueryData(current.queryKey), { source: "current-fleet" });
  } finally {
    client.clear();
  }
});

test("the short reuse window expires and explicit snapshot invalidation bypasses it", async () => {
  const client = createClient();
  const options = injectionFleetMatrixQueryOptions("2026-09-08", true);
  let calls = 0;
  const queryFn = async () => ({ revision: ++calls });
  try {
    assert.equal(options.staleTime, 30_000);
    client.setQueryData(options.queryKey, { revision: 0 }, { updatedAt: Date.now() - 30_001 });
    assert.deepEqual(await client.fetchQuery({ ...options, queryFn }), { revision: 1 });
    assert.deepEqual(await client.fetchQuery({ ...options, queryFn }), { revision: 1 });
    assert.equal(calls, 1);

    const stationKey = [...INJECTION_MATRIX_QUERY_PREFIX, "2026-09-08", true, 1] as const;
    client.setQueryData(stationKey, { revision: 1 });
    client.setQueryData(["inventory", "unrelated"], { revision: 1 });
    await client.invalidateQueries({ queryKey: INJECTION_MATRIX_QUERY_PREFIX });
    assert.equal(client.getQueryState(stationKey)?.isInvalidated, true);
    assert.equal(client.getQueryState(["inventory", "unrelated"])?.isInvalidated, false);
    assert.deepEqual(await client.fetchQuery({ ...options, queryFn }), { revision: 2 });
    assert.equal(calls, 2);
  } finally {
    client.clear();
  }
});
