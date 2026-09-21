// The batching / concurrency mechanism, shared by BOTH persona sets.
//
// It was extracted from `run-personas.ts` (behaviour byte-identical) so the
// break set reuses the exact same pool rather than duplicating it: CLAUDE.md's
// "reuse, don't fork" applied to the runner. Both the ordinary 51-persona set
// and the 100-persona break set share one client IP against the app's own
// per-(route, IP) rate limits, so both cap how many personas are in flight.

/**
 * Run `items` through `work` with at most `limit` in flight, preserving input
 * order in the results. A worker takes the next index whenever it finishes
 * one, so a persona that ends in ninety seconds does not hold a slot for the
 * twenty minutes its neighbour needs.
 */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await work(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
