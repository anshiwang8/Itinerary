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
    "oversized parse request never reaches the mocked Groq provider",
    async () => {
      resetRateLimitsForTests();
      delete process.env.E2E_MOCK;
      process.env.GROQ_API_KEY = "test-key";
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
    "rate-limited parse request never reaches the mocked Groq provider",
    async () => {
      resetRateLimitsForTests();
      delete process.env.E2E_MOCK;
      process.env.GROQ_API_KEY = "test-key";
      const request = post(JSON.stringify({ prompt: "dinner" }), {
        "x-forwarded-for": "198.51.100.25",
      });
      const ctx = requestContext(request, "parse");
      for (let i = 0; i < 60; i++) enforceRateLimit(ctx, 60);

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
