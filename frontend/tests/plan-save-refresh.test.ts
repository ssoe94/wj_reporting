import assert from "node:assert/strict";
import test from "node:test";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { refreshPlanQueriesAfterSave } from "../src/domains/production/plan-save-refresh.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const outcome of ["success", "failure"] as const) {
  test(`save completes and the next save works while background reads await ${outcome}`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
    const read = deferred<number>();
    const keys = [["production", "plan-items"], ["production-plan-summary"], ["production-mes-report-stats"]];
    const observers = keys.map(queryKey => new QueryObserver(client, {
      queryKey, initialData: 1, staleTime: Infinity, queryFn: () => read.promise,
    }));
    const unsubscribe = observers.map(observer => observer.subscribe(() => {}));
    let writes = 0;
    const mutation = new MutationObserver(client, {
      mutationFn: async () => ++writes,
      onSuccess: () => refreshPlanQueriesAfterSave(client),
    });
    try {
      await mutation.mutate();
      assert.equal(mutation.getCurrentResult().isPending, false);
      assert.equal(client.isFetching(), 3, "reads are still outstanding");
      await mutation.mutate();
      assert.equal(writes, 2);
      assert.equal(mutation.getCurrentResult().status, "success");
      if (outcome === "failure") read.reject(new Error("read unavailable"));
      else read.resolve(2);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(mutation.getCurrentResult().status, "success", "read failure is not a save failure");
    } finally {
      unsubscribe.forEach(stop => stop());
      client.clear();
    }
  });
}

test("an unfinished or failed write stays distinct from background refresh", async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 } } });
  const write = deferred<void>();
  let refreshed = false;
  const mutation = new MutationObserver(client, {
    mutationFn: () => write.promise,
    onSuccess: () => { refreshed = true; refreshPlanQueriesAfterSave(client); },
  });
  const result = mutation.mutate();
  const rejected = assert.rejects(result, /permission denied/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutation.getCurrentResult().isPending, true);
  write.reject(new Error("permission denied"));
  await rejected;
  assert.equal(mutation.getCurrentResult().isPending, false);
  assert.equal(mutation.getCurrentResult().status, "error");
  assert.equal(refreshed, false);
  client.clear();
});
