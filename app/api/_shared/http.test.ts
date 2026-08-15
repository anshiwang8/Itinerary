import assert from "node:assert";
import { NextRequest } from "next/server";
import {
  ApiError,
  REQUEST_LIMITS,
  apiError,
  enforceRateLimit,
  readJsonBody,
  requestContext,
  resetRateLimitsForTests,
} from "./http";
import { fetchProvider, ProviderError, readProviderJson } from "./provider";
import {
  parseDwellMinutes,
  parseOptionalTimeZone,
  parsePoints,
} from "./schemas";

function post(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

const cases: Array<[string, () => Promise<void>]> = [
  [
    "declared oversized JSON is rejected with 413 before parsing",
    async () => {
      const request = post("{}", {
        "content-length": String(REQUEST_LIMITS.jsonBytes + 1),
      });
      await assert.rejects(
        () => readJsonBody(request),
        (error: unknown) => error instanceof ApiError && error.status === 413
      );
    },
  ],
  [
    "actual oversized JSON is rejected even without Content-Length",
    async () => {
      const request = post(JSON.stringify({ value: "x".repeat(REQUEST_LIMITS.jsonBytes) }));
      await assert.rejects(
        () => readJsonBody(request),
        (error: unknown) => error instanceof ApiError && error.status === 413
      );
    },
  ],
  [
    "rate limiter allows a shared-network burst, then returns 429 metadata",
    async () => {
      resetRateLimitsForTests();
      const ctx = requestContext(
        post("{}", { "x-forwarded-for": "203.0.113.5, 10.0.0.1" }),
        "test_scope"
      );
      enforceRateLimit(ctx, 2, 1_000);
      enforceRateLimit(ctx, 2, 1_000);
      assert.throws(
        () => enforceRateLimit(ctx, 2, 1_000),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 429 &&
          error.headers?.["Retry-After"] === "60"
      );
      resetRateLimitsForTests();
    },
  ],
  [
    "coordinate, dwell, and timezone schemas reject non-finite or out-of-range input",
    async () => {
      assert.throws(() => parsePoints([{ latitude: 91, longitude: 0 }]), ApiError);
      assert.throws(() => parsePoints([{ latitude: 43, longitude: Number.NaN }]), ApiError);
      assert.throws(() => parseDwellMinutes([0, 1.5], 2), ApiError);
      assert.throws(() => parseDwellMinutes([0, 361], 2), ApiError);
      assert.throws(() => parseOptionalTimeZone("Mars/Olympus"), ApiError);
      assert.strictEqual(parseOptionalTimeZone("America/Vancouver"), "America/Vancouver");
    },
  ],
  [
    "provider deadline aborts and maps to 504 without exposing the thrown value",
    async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = ((_: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("secret upstream detail")),
            { once: true }
          );
        })) as typeof fetch;
      try {
        await assert.rejects(
          () => fetchProvider("weather", "https://provider.invalid", {}, 5),
          (error: unknown) =>
            error instanceof ProviderError &&
            error.status === 504 &&
            !error.message.includes("secret upstream detail")
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "non-JSON provider response maps to a generic 502",
    async () => {
      await assert.rejects(
        () => readProviderJson("places", new Response("<html>", { status: 200 })),
        (error: unknown) => error instanceof ProviderError && error.status === 502
      );
    },
  ],
  [
    "a 429 gets its OWN code and carries the upstream status + retry-after",
    async () => {
      // Before this, the status was checked and discarded: a 429, a 401 and a
      // 403 all became the same generic 502, so nothing downstream could
      // react to a rate limit because nothing downstream knew it was one.
      await assert.rejects(
        () =>
          readProviderJson(
            "openrouter",
            new Response("{}", { status: 429, headers: { "retry-after": "12" } })
          ),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.strictEqual(error.code, "openrouter_rate_limited");
          assert.strictEqual(error.failure?.upstreamStatus, 429);
          assert.strictEqual(error.failure?.retryAfterSeconds, 12);
          assert.strictEqual(error.isModelRetryable, true);
          // the PUBLIC surface is unchanged — this is about what the server knows
          assert.strictEqual(error.status, 502);
          return true;
        }
      );
    },
  ],
  [
    "a 401 keeps the generic code and is NOT model-retryable",
    async () => {
      await assert.rejects(
        () => readProviderJson("openrouter", new Response("{}", { status: 401 })),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.strictEqual(error.code, "openrouter_rejected_request");
          assert.strictEqual(error.failure?.upstreamStatus, 401);
          assert.strictEqual(
            error.isModelRetryable,
            false,
            "the same key fails identically on every model — advancing buries the real problem"
          );
          return true;
        }
      );
    },
  ],
  // ── the 200-with-an-error-body handler (OpenRouter migration) ──
  // OpenRouter can answer a rate limit with HTTP 200 and the failure in the
  // BODY. Checking response.ok alone let that through as a normal answer:
  // `choices` came back undefined, the call site threw its own
  // *_invalid_response, and that error carries no upstreamStatus — so
  // isModelRetryable was false and the chain never advanced. These pin the
  // fix, because it is the only thing keeping the fallback chain useful
  // under a provider that wraps errors this way.
  [
    "a 200 whose BODY is a rate limit is a rate limit, and advances the chain",
    async () => {
      await assert.rejects(
        () =>
          readProviderJson(
            "openrouter",
            new Response(
              JSON.stringify({ error: { code: 429, message: "rate limited" } }),
              { status: 200, headers: { "retry-after": "12" } }
            )
          ),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.strictEqual(error.code, "openrouter_rate_limited");
          assert.strictEqual(error.failure?.upstreamStatus, 429);
          assert.strictEqual(error.failure?.retryAfterSeconds, 12);
          assert.strictEqual(
            error.isModelRetryable,
            true,
            "a body-wrapped 429 must reach the next model, exactly like a real 429"
          );
          return true;
        }
      );
    },
  ],
  [
    "a 200-wrapped 401 is NOT model-retryable — same key, same failure, every model",
    async () => {
      await assert.rejects(
        () =>
          readProviderJson(
            "openrouter",
            new Response(JSON.stringify({ error: { code: 401, message: "no key" } }), {
              status: 200,
            })
          ),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.strictEqual(error.code, "openrouter_rejected_request");
          assert.strictEqual(error.failure?.upstreamStatus, 401);
          assert.strictEqual(error.isModelRetryable, false);
          return true;
        }
      );
    },
  ],
  [
    "a 200-wrapped error with no readable code degrades to a retryable 502",
    async () => {
      // A wrapped error with nothing to read is the provider malfunctioning;
      // asking a different model is the cheap correct response to that.
      await assert.rejects(
        () =>
          readProviderJson(
            "openrouter",
            new Response(JSON.stringify({ error: { message: "something broke" } }), {
              status: 200,
            })
          ),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.strictEqual(error.failure?.upstreamStatus, 502);
          assert.strictEqual(error.isModelRetryable, true);
          return true;
        }
      );
    },
  ],
  [
    "a REAL completion is never mistaken for a wrapped error",
    async () => {
      const body = JSON.stringify({ choices: [{ message: { content: "{}" } }] });
      const parsed = await readProviderJson(
        "openrouter",
        new Response(body, { status: 200 })
      );
      assert.deepStrictEqual(parsed, JSON.parse(body));
    },
  ],
  [
    "the guard leaves the OTHER providers alone (Upstash's string error)",
    async () => {
      // Upstash answers a failed command with `{ error: "<string>" }`. The
      // guard requires an error OBJECT precisely so Redis behaviour is
      // untouched by a fix aimed at one LLM provider.
      const parsed = await readProviderJson(
        "redis",
        new Response(JSON.stringify({ error: "ERR unknown command" }), { status: 200 })
      );
      assert.deepStrictEqual(parsed, { error: "ERR unknown command" });
    },
  ],
  [
    "a rejection with a non-JSON body is still a rejection, not 'malformed'",
    async () => {
      // An HTML error page from a gateway is a rejected request; calling it
      // invalid_response sends the reader hunting a parser bug that isn't there.
      await assert.rejects(
        () => readProviderJson("openrouter", new Response("<html>429</html>", { status: 429 })),
        (error: unknown) =>
          error instanceof ProviderError &&
          error.code === "openrouter_rate_limited" &&
          error.failure?.upstreamStatus === 429
      );
    },
  ],
  [
    "unexpected errors expose only a correlation id and structured redacted log",
    async () => {
      const ctx = requestContext(
        post("{}", { "x-request-id": "safe-correlation-id" }),
        "redaction_test"
      );
      const realError = console.error;
      const lines: string[] = [];
      console.error = (...values: unknown[]) => lines.push(values.join(" "));
      try {
        const response = apiError(ctx, new Error("secret prompt and token"));
        const body = await response.json();
        assert.strictEqual(response.status, 500);
        assert.strictEqual(response.headers.get("x-request-id"), "safe-correlation-id");
        assert.strictEqual(body.requestId, "safe-correlation-id");
        assert.ok(!JSON.stringify(body).includes("secret prompt"));
        assert.ok(!lines.join("\n").includes("secret prompt"));
        assert.match(lines[0], /"event":"api_request_failed"/);
      } finally {
        console.error = realError;
      }
    },
  ],
  [
    "oversized parse request never reaches the mocked model provider",
    async () => {
      resetRateLimitsForTests();
      delete process.env.E2E_MOCK;
      process.env.OPENROUTER_API_KEY = "test-key";
      const realFetch = globalThis.fetch;
      let providerCalls = 0;
      globalThis.fetch = (async () => {
        providerCalls++;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      try {
        const { POST } = await import("../parse/route");
        const response = await POST(
          post(JSON.stringify({ prompt: "x".repeat(REQUEST_LIMITS.jsonBytes) }))
        );
        assert.strictEqual(response.status, 413);
        assert.strictEqual(providerCalls, 0);
      } finally {
        globalThis.fetch = realFetch;
        resetRateLimitsForTests();
      }
    },
  ],
  [
    "rate-limited parse request never reaches the mocked model provider",
    async () => {
      resetRateLimitsForTests();
      delete process.env.E2E_MOCK;
      process.env.OPENROUTER_API_KEY = "test-key";
      const request = post(JSON.stringify({ prompt: "dinner" }), {
        "x-forwarded-for": "198.51.100.25",
      });
      const ctx = requestContext(request, "parse");
      // /api/parse allows 120: one PLAN can cost two calls to it (the
      // proposal, then the answered second pass). Fill the real bucket.
      for (let i = 0; i < 120; i++) enforceRateLimit(ctx, 120);

      const realFetch = globalThis.fetch;
      let providerCalls = 0;
      globalThis.fetch = (async () => {
        providerCalls++;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      try {
        const { POST } = await import("../parse/route");
        const response = await POST(request);
        assert.strictEqual(response.status, 429);
        assert.strictEqual(response.headers.get("retry-after"), "60");
        assert.strictEqual(providerCalls, 0);
      } finally {
        globalThis.fetch = realFetch;
        resetRateLimitsForTests();
      }
    },
  ],
];

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
