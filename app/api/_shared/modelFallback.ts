import { ApiError, logEvent } from "./http";
import { ProviderError } from "./provider";
import { CallType, modelChain } from "./models";

// Survive a rate limit by asking a DIFFERENT model, rather than failing the
// request. Groq limits per model, so the next chain entry has its own budget —
// which is what makes this different from a retry, and why a plain retry
// cannot fix this failure: it hits the same wall by definition.

/**
 * Thrown when every model in a chain is rate limited. Deliberately NOT the
 * generic provider error: "the service could not complete that request" tells
 * someone nothing they can act on, while "busy right now, try again in ~30s"
 * tells them exactly what to do. 503 rather than 502 — the upstream is
 * working fine, it is capacity that ran out, and that is what 503 means.
 */
export class AllModelsRateLimitedError extends ApiError {
  constructor(
    public readonly call: CallType,
    public readonly attempted: string[],
    public readonly retryAfterSeconds?: number
  ) {
    super(
      503,
      "model_capacity_exhausted",
      retryAfterSeconds !== undefined
        ? `Busy right now — try again in about ${retryAfterSeconds} seconds.`
        : "Busy right now — try again in a moment.",
      retryAfterSeconds !== undefined
        ? { "Retry-After": String(retryAfterSeconds) }
        : undefined
    );
    this.name = "AllModelsRateLimitedError";
  }
}

/**
 * Run one LOGICAL call against a model chain, advancing on rate limits.
 *
 * `run` must be the WHOLE unit of work — for the planner and select that
 * includes their own correction retry, because those are a conversation with
 * one model. Wrapping the inner call instead would let a correction land on a
 * different model than the answer it is correcting, which is a subtler bug
 * than the rate limit it was trying to fix.
 *
 * Only rate limits and provider-side 5xx advance the chain (see
 * ProviderError.isModelRetryable). A 401/403 fails immediately: it is the same
 * key failing identically on every model, so advancing would burn time and
 * bury the real problem under a pile of matching failures.
 */
export async function withModelFallback<T>(
  call: CallType,
  run: (model: string) => Promise<T>
): Promise<T> {
  const chain = modelChain(call);
  const attempted: string[] = [];
  let lastRetryAfter: number | undefined;

  for (let index = 0; index < chain.length; index++) {
    const model = chain[index];
    attempted.push(model);
    try {
      const result = await run(model);
      // Which model actually served this. Running degraded silently is worse
      // than running degraded: without this line, an hour of plans from the
      // backup model is indistinguishable from an hour of normal ones.
      logEvent("info", "model_call", {
        call,
        model,
        attempt: index + 1,
        ...(index > 0 ? { fellBackFrom: chain.slice(0, index) } : {}),
      });
      return result;
    } catch (error) {
      const retryable = error instanceof ProviderError && error.isModelRetryable;
      if (!retryable) throw error;

      lastRetryAfter = error.failure?.retryAfterSeconds ?? lastRetryAfter;
      logEvent("error", "model_unavailable", {
        call,
        model,
        attempt: index + 1,
        upstreamStatus: error.failure?.upstreamStatus,
        ...(error.failure?.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.failure.retryAfterSeconds }
          : {}),
        remaining: chain.length - index - 1,
      });
    }
  }

  logEvent("error", "model_chain_exhausted", { call, attempted });
  throw new AllModelsRateLimitedError(call, attempted, lastRetryAfter);
}
