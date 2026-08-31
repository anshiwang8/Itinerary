import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { fetchProvider, ProviderError, readProviderJson } from "./provider";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function expectError(error: unknown, code: string, status: number, retryable = false) {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert.equal(error.isModelRetryable, retryable);
  assert.equal(error.publicMessage, status === 504
    ? "A provider took too long to respond. Please try again."
    : "A provider could not complete the request. Please try again.");
  if (!retryable) assert.equal(error.failure, undefined);
  return true;
}

// A controllable body, with fetch's real abort semantics: headers resolve
// immediately, but only body completion/error/abort can settle text().
async function withBody(run: (h: {
  response: Response;
  stream: ReadableStreamDefaultController<Uint8Array>;
  caller: AbortController;
  signal: AbortSignal;
  removed: () => number;
}) => Promise<void>, status = 200) {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let removed = 0;
  const remove = caller.signal.removeEventListener.bind(caller.signal);
  caller.signal.removeEventListener = (...args: Parameters<typeof remove>) => { removed++; remove(...args); };
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  globalThis.fetch = async (_input, init) => {
    signal = init!.signal!;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode('{"value":'));
      signal.addEventListener("abort", () => controller.error(new Error("private upstream detail")), { once: true });
    } });
    return new Response(body, { status, headers: { "retry-after": "12" } });
  };
  try {
    const response = await fetchProvider("openrouter", "https://provider.invalid", { signal: caller.signal }, 30);
    await run({ response, stream, caller, signal, removed: () => removed });
  } finally {
    // Also terminates the pre-fix stalled read during the revert-run.
    stream?.error(new Error("test cleanup"));
    globalThis.fetch = originalFetch;
  }
}

test("D1: headers arrive immediately, stalled body reaches the original deadline and then cleans up", async () => {
  await withBody(async ({ response, signal, removed }) => {
    assert.equal(removed(), 0, "caller abort listener must survive headers");
    const read = readProviderJson("openrouter", response).then(
      () => "unexpected success", (error: unknown) => error
    );
    const result = await Promise.race([read, pause(150).then(() => "body remained pending")]);
    expectError(result, "openrouter_timeout", 504);
    assert.equal(signal.aborted, true);
    assert.equal(removed(), 1, "cleanup follows the failed body read");
  });
});

test("D1: caller abort still bounds body reading after headers", async () => {
  await withBody(async ({ response, caller, removed }) => {
    const read = readProviderJson("openrouter", response).catch((error: unknown) => error);
    caller.abort();
    const result = await Promise.race([read, pause(150).then(() => "caller abort left body pending")]);
    expectError(result, "openrouter_unavailable", 502);
    assert.equal(removed(), 1);
  });
});

test("D1: successful body consumption releases timer and caller listener", async () => {
  await withBody(async ({ response, stream, caller, signal, removed }) => {
    assert.equal(removed(), 0);
    const read = readProviderJson("openrouter", response);
    stream.enqueue(new TextEncoder().encode('1}'));
    stream.close();
    assert.deepEqual(await read, { value: 1 });
    assert.equal(removed(), 1);
    caller.abort();
    await pause(50);
    assert.equal(signal.aborted, false, "neither the cleared timer nor detached caller may abort now");
  });
});

test("D1: a non-abort body error retains invalid_response and also cleans up", async () => {
  await withBody(async ({ response, stream, signal, removed }) => {
    const rejected = assert.rejects(readProviderJson("openrouter", response),
      (error) => expectError(error, "openrouter_invalid_response", 502));
    stream.error(new Error("private body failure"));
    await rejected;
    assert.equal(removed(), 1);
    await pause(50);
    assert.equal(signal.aborted, false);
  });
});

test("D1: consumed provider rejection retains status, retry-after and retry classification", async () => {
  await withBody(async ({ response, stream, removed }) => {
    stream.enqueue(new TextEncoder().encode('1}'));
    stream.close();
    await assert.rejects(readProviderJson("openrouter", response), (error) => {
      expectError(error, "openrouter_rate_limited", 502, true);
      assert.deepEqual((error as ProviderError).failure, { upstreamStatus: 429, retryAfterSeconds: 12 });
      return true;
    });
    assert.equal(removed(), 1);
  }, 429);
});

test("D1: no headers still times out; transport errors keep their existing public shape", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("private timeout")), { once: true });
    });
    await assert.rejects(fetchProvider("openrouter", "https://provider.invalid", {}, 5),
      (error) => expectError(error, "openrouter_timeout", 504));
    globalThis.fetch = async () => { throw new Error("private network failure"); };
    await assert.rejects(fetchProvider("openrouter", "https://provider.invalid", {}, 30),
      (error) => expectError(error, "openrouter_unavailable", 502));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("D1: real fetch aborts a local HTTP body that sends headers and partial JSON but never ends", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    res.write('{"partial":');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetchProvider("openrouter", `http://127.0.0.1:${address.port}`, {}, 100);
    assert.equal(response.status, 200, "headers arrived before the deadline");
    const read = readProviderJson("openrouter", response).catch((error: unknown) => error);
    const result = await Promise.race([read, pause(500).then(() => "body remained pending")]);
    expectError(result, "openrouter_timeout", 504);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
