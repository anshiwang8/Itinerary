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

/** Captures every `console.error` call made during `run`, then restores it —
 *  the one place this suite can observe the `[client-fetch]` diagnostic log
 *  without hard-coding a global spy into every case. */
async function withConsoleError(
  run: () => Promise<void>
): Promise<unknown[][]> {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return calls;
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
    "captures the parser's own rejection reason and the endpoint, logs both, and keeps the reason out of the public message",
    async () => {
      await withFetch(
        async () => Response.json({ legs: "not-an-array" }),
        async () => {
          const calls = await withConsoleError(async () => {
            await assert.rejects(
              fetchJson("/api/schedule/travel", {
                parse(value) {
                  if (
                    typeof value !== "object" ||
                    value === null ||
                    !Array.isArray((value as { legs?: unknown }).legs)
                  ) {
                    throw new Error("invalid travel legs");
                  }
                  return value;
                },
              }),
              (error) => {
                assertClientError(error, { status: 200, code: "invalid_payload" });
                assert.ok(error instanceof ClientFetchError);
                assert.strictEqual(error.endpoint, "/api/schedule/travel");
                assert.strictEqual(error.reason, "invalid travel legs");
                // the internal reason must never leak into the text a user reads
                assert.ok(!error.message.includes("invalid travel legs"));
                assert.strictEqual(
                  error.message,
                  "The service returned an unexpected response. Please try again."
                );
                return true;
              }
            );
          });
          assert.strictEqual(calls.length, 1);
          const [tag, payload] = calls[0];
          assert.strictEqual(tag, "[client-fetch]");
          const logged = JSON.parse(payload as string);
          assert.strictEqual(logged.endpoint, "/api/schedule/travel");
          assert.strictEqual(logged.reason, "invalid travel legs");
          assert.strictEqual(logged.code, "invalid_payload");
        }
      );
    },
  ],
  [
    "lets a call site override the public message without touching the logged reason",
    async () => {
      await withFetch(
        async () => Response.json({ legs: "not-an-array" }),
        async () => {
          await assert.rejects(
            fetchJson("/api/schedule/travel", {
              invalidResponseMessage: "Couldn't read the route times for this plan. Please try again.",
              parse(): never {
                throw new Error("invalid travel legs");
              },
            }),
            (error) => {
              assert.ok(error instanceof ClientFetchError);
              assert.strictEqual(
                error.message,
                "Couldn't read the route times for this plan. Please try again."
              );
              assert.strictEqual(error.reason, "invalid travel legs");
              return true;
            }
          );
        }
      );
    },
  ],
  [
    "captures the reason and endpoint for a failed guard too",
    async () => {
      interface Payload {
        ok: true;
      }
      const isPayload: JsonGuard<Payload> = (value): value is Payload =>
        typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true;
      await withFetch(
        async () => Response.json({ ok: false }),
        async () => {
          await assert.rejects(
            fetchJson<Payload>("/api/malformed", { guard: isPayload }),
            (error) => {
              assert.ok(error instanceof ClientFetchError);
              assert.strictEqual(error.endpoint, "/api/malformed");
              assert.ok(!!error.reason);
              return true;
            }
          );
        }
      );
    },
  ],
  [
    "records the endpoint on every other failure kind too (timeout, network, http, invalid_json)",
    async () => {
      await withFetch(
        async () =>
          new Response("<html>secret proxy diagnostic</html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          }),
        async () => {
          await assert.rejects(fetchJson("/api/gateway"), (error) => {
            assert.ok(error instanceof ClientFetchError);
            assert.strictEqual(error.endpoint, "/api/gateway");
            return true;
          });
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
