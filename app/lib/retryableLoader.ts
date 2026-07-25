/**
 * Cache one successful asynchronous load while allowing a later call to
 * recover from a rejected attempt. Consumers receive the same in-flight
 * promise, so concurrent mounts do not start duplicate provider loads.
 */
export function createRetryableLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;

  return () => {
    if (!cached) {
      const attempt = load();
      cached = attempt;
      void attempt.catch(() => {
        if (cached === attempt) cached = null;
      });
    }
    return cached;
  };
}
