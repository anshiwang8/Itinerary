import assert from "node:assert";
import {
  ClientFetchError,
  fetchJson,
  type JsonGuard,
} from "./clientFetch";

type AsyncCase = [string, () => Promise<void>];

async function withFetch(
  implementation: typeof fetch,
  run: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function assertClientError(
  error: unknown,
  expected: { status: number | null; code: string }
): true {
  assert.ok(error instanceof ClientFetchError);
  assert.strictEqual(error.status, expected.status);
  assert.strictEqual(error.code, expected.code);
  return true;
}

const cases: AsyncCase[] = [
  [
    "returns a typed JSON success",
    async () => {
      await withFetch(
        async () => Response.json({ value: 7 }),
        async () => {
          const result = await fetchJson<{ value: number }>("/api/example");
          assert.deepStrictEqual(result, { value: 7 });
        }
      );
    },
  ],
  [
    "supports a runtime parser without leaking parser errors",
    async () => {
      await withFetch(
        async () => Response.json({ value: "7" }),
        async () => {
          const result = await fetchJson("/api/example", {
            parse(value) {
              if (
                typeof value !== "object" ||
                value === null ||
                !("value" in value) ||
                typeof value.value !== "string"
              ) {
                throw new Error("private parser detail");
              }
              return { value: Number(value.value) };
            },
          });
          assert.deepStrictEqual(result, { value: 7 });
        }
      );
    },
  ],
  [
    "aborts at the deadline and reports a stable timeout",
    async () => {
      await withFetch(
        ((_, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            );
          })) as typeof fetch,
        async () => {
          await assert.rejects(
            fetchJson("/api/slow", { timeoutMs: 5 }),
            (error) =>
              assertClientError(error, {
                status: null,
                code: "request_timeout",
              })
          );
        }
      );
    },
  ],
  [
    "cascades an external abort without classifying it as a timeout",
    async () => {
      const caller = new AbortController();
      await withFetch(
        ((_, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            );
          })) as typeof fetch,
        async () => {
          const pending = fetchJson("/api/cancel", {
            signal: caller.signal,
            timeoutMs: 1_000,
          });
          caller.abort();
          await assert.rejects(
            pending,
            (error) =>
              assertClientError(error, {
                status: null,
                code: "request_aborted",
              })
          );
        }
      );
    },
  ],
  [
    "rejects a non-JSON success without exposing its body",
    async () => {
      await withFetch(
        async () =>
          new Response("<html>private gateway detail</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        async () => {
          await assert.rejects(fetchJson("/api/html"), (error) => {
            assertClientError(error, { status: 200, code: "invalid_json" });
            assert.ok(error instanceof Error);
            assert.ok(!error.message.includes("private gateway detail"));
            return true;
          });
        }
      );
    },
  ],
  [
    "preserves a structured non-2xx status and public error code",
    async () => {
      await withFetch(
        async () =>
          Response.json(
            {
              error: "Please wait before trying again.",
              code: "rate_limited",
              internal: "<html>private provider response</html>",
            },
            { status: 429 }
          ),
        async () => {
          await assert.rejects(fetchJson("/api/limited"), (error) => {
            assertClientError(error, { status: 429, code: "rate_limited" });
            assert.ok(error instanceof Error);
            assert.strictEqual(error.message, "Please wait before trying again.");
            assert.ok(!error.message.includes("private provider response"));
            return true;
          });
        }
      );
    },
  ],
  [
    "does not expose a non-JSON HTTP error body",
    async () => {
      await withFetch(
        async () =>
          new Response("<html>secret proxy diagnostic</html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          }),
        async () => {
          await assert.rejects(fetchJson("/api/gateway"), (error) => {
            assertClientError(error, { status: 502, code: "http_error" });
            assert.ok(error instanceof Error);
            assert.ok(!error.message.includes("secret proxy diagnostic"));
            return true;
          });
        }
      );
    },
  ],
  [
    "turns a malformed guarded payload into invalid_payload",
    async () => {
      interface Payload {
        ok: true;
        id: string;
      }
      const isPayload: JsonGuard<Payload> = (value): value is Payload =>
        typeof value === "object" &&
        value !== null &&
        "ok" in value &&
        value.ok === true &&
        "id" in value &&
        typeof value.id === "string";

      await withFetch(
        async () => Response.json({ ok: true, id: 42 }),
        async () => {
          await assert.rejects(
            fetchJson<Payload>("/api/malformed", { guard: isPayload }),
            (error) =>
              assertClientError(error, {
                status: 200,
                code: "invalid_payload",
              })
          );
        }
      );
    },
  ],
  [
    "clears its deadline and detaches the caller signal after success",
    async () => {
      const caller = new AbortController();
      let requestSignal: AbortSignal | null | undefined;
      let requestAborts = 0;

      await withFetch(
        (async (_, init) => {
          requestSignal = init?.signal;
          requestSignal?.addEventListener("abort", () => requestAborts++);
          return Response.json({ ok: true });
        }) as typeof fetch,
        async () => {
          await fetchJson("/api/fast", {
            signal: caller.signal,
            timeoutMs: 10,
          });
          caller.abort();
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      );

      assert.strictEqual(requestAborts, 0);
      assert.strictEqual(requestSignal?.aborted, false);
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
