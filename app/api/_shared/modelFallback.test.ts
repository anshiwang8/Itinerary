// The model FALLBACK CHAIN — what stands between a Groq rate limit and a
// failed request. Everything here is pure: the chain is driven through an
// injected runner, so no network and no key.
// Run with: npx tsx app/api/_shared/modelFallback.test.ts
import assert from "node:assert";
import { AllModelsRateLimitedError, withModelFallback } from "./modelFallback";
import { BUILT_IN_CHAINS, modelChain, primaryModel } from "./models";
import { ProviderError, parseRetryAfter } from "./provider";

/** A provider rejection with a given upstream status, as readProviderJson
 *  would build it. */
function rejected(status: number, retryAfterSeconds?: number): ProviderError {
  return new ProviderError(
    "groq",
    502,
    status === 429 ? "groq_rate_limited" : "groq_rejected_request",
    { upstreamStatus: status, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }
  );
}

/** Silence the module's logEvent lines so test output stays readable, and
 *  hand back what was logged for the assertions that care. */
async function capturingLogs<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; lines: string[] }> {
  const lines: string[] = [];
  const realInfo = console.info;
  const realError = console.error;
  console.info = (...v: unknown[]) => lines.push(v.join(" "));
  console.error = (...v: unknown[]) => lines.push(v.join(" "));
  try {
    return { result: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    console.info = realInfo;
    console.error = realError;
  }
}

const ENV_KEYS = ["GROQ_MODELS_PLANNER", "GROQ_MODELS_SELECT", "GROQ_MODELS_SWAP"];
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const cases: Array<[string, () => Promise<void>]> = [
  // ── advancing, and NOT advancing ──
  [
    "a 429 advances to the next model and returns its answer",
    async () => {
      const tried: string[] = [];
      const { result } = await capturingLogs(() =>
        withModelFallback("planner", async (model) => {
          tried.push(model);
          if (tried.length === 1) throw rejected(429);
          return `answered by ${model}`;
        })
      );
      assert.strictEqual(tried.length, 2, "should have tried exactly two models");
      assert.strictEqual(result, `answered by ${tried[1]}`);
      assert.notStrictEqual(tried[0], tried[1], "the fallback must be a DIFFERENT model");
    },
  ],
  [
    "a 401 fails IMMEDIATELY — the same key fails on every model",
    async () => {
      // The distinction that matters most here. Advancing on an auth failure
      // would burn the whole chain and bury the real problem (missing or
      // unconfigured key) under a pile of identical failures.
      const tried: string[] = [];
      const { error } = await capturingLogs(() =>
        withModelFallback("planner", async (model) => {
          tried.push(model);
          throw rejected(401);
        })
      );
      assert.strictEqual(tried.length, 1, "must not advance past an auth failure");
      assert.ok(error instanceof ProviderError);
      assert.strictEqual((error as ProviderError).code, "groq_rejected_request");
    },
  ],
  [
    "a 403 also fails immediately, and a 400 does too",
    async () => {
      for (const status of [403, 400, 404, 422]) {
        const tried: string[] = [];
        const { error } = await capturingLogs(() =>
          withModelFallback("select", async (model) => {
            tried.push(model);
            throw rejected(status);
          })
        );
        assert.strictEqual(tried.length, 1, `status ${status} must not advance`);
        assert.ok(error instanceof ProviderError, `status ${status} rethrows as-is`);
      }
    },
  ],
  [
    "a provider-side 5xx DOES advance — that one is not our fault",
    async () => {
      for (const status of [500, 502, 503]) {
        const tried: string[] = [];
        await capturingLogs(() =>
          withModelFallback("select", async (model) => {
            tried.push(model);
            if (tried.length === 1) throw rejected(status);
            return "ok";
          })
        );
        assert.strictEqual(tried.length, 2, `status ${status} should advance`);
      }
    },
  ],
  [
    "a non-provider error propagates untouched (a bug is not a rate limit)",
    async () => {
      const tried: string[] = [];
      const { error } = await capturingLogs(() =>
        withModelFallback("planner", async (model) => {
          tried.push(model);
          throw new TypeError("cannot read property of undefined");
        })
      );
      assert.strictEqual(tried.length, 1);
      assert.ok(error instanceof TypeError, "must not be swallowed or reclassified");
    },
  ],

  // ── exhaustion ──
  [
    "chain exhaustion gives the RATE-LIMIT message, not the generic one",
    async () => {
      const tried: string[] = [];
      const { error } = await capturingLogs(() =>
        withModelFallback("planner", async (model) => {
          tried.push(model);
          throw rejected(429, 30);
        })
      );
      assert.strictEqual(tried.length, modelChain("planner").length, "tries every model");
      assert.ok(error instanceof AllModelsRateLimitedError);
      const err = error as AllModelsRateLimitedError;
      assert.strictEqual(err.status, 503, "capacity, not a bad gateway");
      assert.strictEqual(err.code, "model_capacity_exhausted");
      assert.deepStrictEqual(err.attempted, tried);
      // actionable, and NOT the generic provider text
      assert.match(err.publicMessage, /try again in about 30 seconds/i);
      assert.ok(!/could not complete/i.test(err.publicMessage));
      assert.strictEqual(err.headers?.["Retry-After"], "30");
    },
  ],
  [
    "exhaustion with no retry-after still says something useful",
    async () => {
      const { error } = await capturingLogs(() =>
        withModelFallback("swap", async () => {
          throw rejected(429);
        })
      );
      const err = error as AllModelsRateLimitedError;
      assert.match(err.publicMessage, /busy right now/i);
      assert.ok(!/about undefined/.test(err.publicMessage), "never renders a missing wait");
      assert.strictEqual(err.headers?.["Retry-After"], undefined);
    },
  ],
  [
    "the LAST seen retry-after survives to the exhaustion error",
    async () => {
      let n = 0;
      const { error } = await capturingLogs(() =>
        withModelFallback("planner", async () => {
          n++;
          // only the middle attempt carries a hint; it must not be lost
          throw rejected(429, n === 2 ? 45 : undefined);
        })
      );
      assert.strictEqual((error as AllModelsRateLimitedError).retryAfterSeconds, 45);
    },
  ],

  // ── observability ──
  [
    "the model that actually served the request is logged",
    async () => {
      const { lines } = await capturingLogs(() =>
        withModelFallback("planner", async (model) => {
          if (!model.includes("gpt-oss")) throw rejected(429);
          return "ok";
        })
      );
      const served = lines.find((l) => l.includes('"event":"model_call"'));
      assert.ok(served, "a model_call line must be emitted");
      assert.match(served!, /"attempt":2/, "records WHICH attempt answered");
      assert.match(served!, /fellBackFrom/, "records that it was a fallback");
      // running degraded silently is worse than running degraded
      assert.ok(
        lines.some((l) => l.includes('"event":"model_unavailable"')),
        "the skipped model is logged too"
      );
    },
  ],
  [
    "a first-try success logs no fallback noise",
    async () => {
      const { lines } = await capturingLogs(() =>
        withModelFallback("planner", async () => "ok")
      );
      assert.ok(lines.some((l) => l.includes('"attempt":1')));
      assert.ok(!lines.some((l) => l.includes("fellBackFrom")), "no fallback claimed");
      assert.ok(!lines.some((l) => l.includes("model_unavailable")));
    },
  ],

  // ── retry-after parsing ──
  [
    "retry-after: seconds, HTTP-date, absent, and malformed",
    async () => {
      const now = Date.parse("2026-07-27T12:00:00Z");
      assert.strictEqual(parseRetryAfter("30", now), 30);
      assert.strictEqual(parseRetryAfter("  30  ", now), 30);
      // Groq sends fractional seconds; never round DOWN to a zero wait
      assert.strictEqual(parseRetryAfter("7.5", now), 7);
      assert.strictEqual(parseRetryAfter("0.4", now), 1);
      // HTTP-date form
      assert.strictEqual(parseRetryAfter("Mon, 27 Jul 2026 12:00:45 GMT", now), 45);
      // a date already past is not a wait
      assert.strictEqual(parseRetryAfter("Mon, 27 Jul 2026 11:59:00 GMT", now), undefined);
      // absent / malformed are tolerated, never guessed at
      assert.strictEqual(parseRetryAfter(null, now), undefined);
      assert.strictEqual(parseRetryAfter("", now), undefined);
      assert.strictEqual(parseRetryAfter("   ", now), undefined);
      assert.strictEqual(parseRetryAfter("soon", now), undefined);
      assert.strictEqual(parseRetryAfter("-5", now), undefined);
    },
  ],

  // ── the chain config ──
  [
    "chains are per call type, and swap deliberately differs from the planner",
    async () => {
      withEnv({ GROQ_MODELS_PLANNER: undefined, GROQ_MODELS_SWAP: undefined }, () => {
        assert.ok(modelChain("planner").length >= 2, "a chain of one cannot fall back");
        assert.ok(modelChain("select").length >= 2);
        assert.ok(modelChain("swap").length >= 2);
        assert.notStrictEqual(
          primaryModel("swap"),
          primaryModel("planner"),
          "a separate swap primary is the point: swap traffic must not spend the planner's per-model budget"
        );
      });
    },
  ],
  [
    "an env override BEATS the default, and blanks fall back to it",
    async () => {
      withEnv({ GROQ_MODELS_PLANNER: "model-a, model-b ,, model-c" }, () => {
        assert.deepStrictEqual(modelChain("planner"), ["model-a", "model-b", "model-c"]);
        assert.strictEqual(primaryModel("planner"), "model-a");
        assert.notDeepStrictEqual(
          modelChain("planner"),
          [...BUILT_IN_CHAINS.planner],
          "the override must not coincidentally equal the default"
        );
      });
      // an all-blank override must not leave a call type with NO model
      withEnv({ GROQ_MODELS_PLANNER: " , , " }, () => {
        assert.deepStrictEqual(modelChain("planner"), [...BUILT_IN_CHAINS.planner]);
      });
      withEnv({ GROQ_MODELS_PLANNER: undefined }, () => {
        assert.deepStrictEqual(modelChain("planner"), [...BUILT_IN_CHAINS.planner]);
      });
    },
  ],
  [
    "the override drives the ACTUAL chain, not just the config read",
    async () => {
      await withEnv2({ GROQ_MODELS_SELECT: "first-model,second-model" }, async () => {
        const tried: string[] = [];
        await capturingLogs(() =>
          withModelFallback("select", async (model) => {
            tried.push(model);
            if (tried.length === 1) throw rejected(429);
            return "ok";
          })
        );
        assert.deepStrictEqual(tried, ["first-model", "second-model"]);
      });
    },
  ],
];

/** async-capable env swap (the sync one can't await) */
async function withEnv2(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main() {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

void main();
