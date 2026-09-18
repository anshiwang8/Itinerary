/**
 * The browser's deadline for every JSON call in the app — no caller overrides
 * it, by design: one deadline is easier to reason about than nineteen.
 *
 * 25s, up from 15s (2026-08-15). 15s was BELOW the server's own 45s budget for
 * a model call (`PROVIDER_TIMEOUT_MS.openrouter`), which made the browser the
 * real ceiling: a slow model surfaced as "the request took too long" no matter
 * what the server was willing to wait for. Routing by throughput
 * (`_shared/openrouter.ts`) is what actually fixed the latency — the fast path
 * is seconds, not tens of seconds — so this is not load-bearing; it is headroom
 * for the tail, where one LLM-backed request can legitimately cost several
 * sequential model calls (a correction retry, then the next model in the chain).
 *
 * Not raised to meet the server's 45s: past ~25s the honest answer to a user
 * staring at a spinner is that something is wrong, and every non-LLM route here
 * (geocode, store reads, weather) answers in well under a second or is broken.
 * The cost of the change is paid only on failure — a hung request now reports
 * ten seconds later than it did.
 */
export const DEFAULT_CLIENT_FETCH_TIMEOUT_MS = 25_000;

export type JsonGuard<T> = (value: unknown) => value is T;
export type JsonParser<T> = (value: unknown) => T;

export type FetchJsonOptions<T> = Omit<RequestInit, "signal"> & {
  signal?: AbortSignal | null;
  timeoutMs?: number;
  guard?: JsonGuard<T>;
  parse?: JsonParser<T>;
  /**
   * Overrides the generic "unexpected response" wording when this call's own
   * shape check (`parse`/`guard`) rejects an otherwise-successful reply. Each
   * pipeline step names its own honest phrase here (e.g. "Couldn't read the
   * route times for this plan."); a call site that omits it keeps the
   * generic `invalid_payload` message. This never changes what is LOGGED —
   * the real validator reason and the endpoint are always captured (see
   * `ClientFetchError.reason`/`.endpoint`) regardless of this override, and
   * the raw reason never becomes part of the public message either way, the
   * same discipline `safePublicMessage` already applies to server text.
   */
  invalidResponseMessage?: string;
};

const ERROR_MESSAGES = {
  request_timeout: "The request took too long. Please try again.",
  request_aborted: "The request was cancelled.",
  network_error: "The service could not be reached. Please try again.",
  invalid_json: "The service returned an unreadable response. Please try again.",
  http_error: "The service could not complete that request. Please try again.",
  invalid_payload: "The service returned an unexpected response. Please try again.",
} as const;

export class ClientFetchError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly code: string,
    message: string,
    /** The endpoint this call was made to, when known. Diagnostic only —
     *  never rendered in the public `message`. */
    public readonly endpoint?: string,
    /** The SPECIFIC rejection reason a `parse`/`guard` check produced (e.g.
     *  "invalid travel legs"), when this is an `invalid_payload` failure.
     *  Diagnostic only, always logged at the point of failure (see
     *  `logInvalidPayload`) — never folded into `message`, which stays the
     *  curated, per-step phrase a user can actually read. */
    public readonly reason?: string
  ) {
    super(message);
    this.name = "ClientFetchError";
  }
}

/** Resolve the URL a call was actually made to, for diagnostics only. */
function endpointOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * A previously EMPTY catch swallowed both of these — the shape check's own
 * rejection reason and which endpoint produced it — so a live "unexpected
 * response" incident could not be diagnosed without a full code trace. Every
 * `invalid_payload` failure now logs both, unconditionally, the same
 * bracket-tag + JSON convention `[window-fit]` already uses for client-side
 * diagnostics, so a FUTURE incident is readable from the console alone.
 */
function logInvalidPayload(endpoint: string, reason: string): void {
  console.error(
    "[client-fetch]",
    JSON.stringify({ endpoint, code: "invalid_payload", reason })
  );
}

function transportError(
  code: "request_timeout" | "request_aborted" | "network_error",
  endpoint: string
): ClientFetchError {
  return new ClientFetchError(null, code, ERROR_MESSAGES[code], endpoint);
}

function validErrorCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value);
}

function safePublicMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value.trim();
  return message.length > 0 &&
    message.length <= 500 &&
    !/<[a-z!/][^>]*>/i.test(message)
    ? message
    : null;
}

function httpError(status: number, payload: unknown, endpoint: string): ClientFetchError {
  const record =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const code = record && validErrorCode(record.code) ? record.code : "http_error";
  const message =
    (record && safePublicMessage(record.error)) ?? ERROR_MESSAGES.http_error;
  return new ClientFetchError(status, code, message, endpoint);
}

/**
 * Fetch a JSON response with one bounded deadline and an optional runtime
 * validator. The caller's AbortSignal cascades into the request, but timeout
 * aborts never propagate back into that caller-owned controller.
 */
export async function fetchJson<T = unknown>(
  input: RequestInfo | URL,
  options: FetchJsonOptions<T> = {}
): Promise<T> {
  const {
    timeoutMs = DEFAULT_CLIENT_FETCH_TIMEOUT_MS,
    signal: callerSignal,
    guard,
    parse,
    invalidResponseMessage,
    ...init
  } = options;
  const endpoint = endpointOf(input);

  if (callerSignal?.aborted) {
    throw transportError("request_aborted", endpoint);
  }

  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const deadline =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_CLIENT_FETCH_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadline);
  const onCallerAbort = () => {
    callerAborted = true;
    controller.abort();
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: controller.signal });
    } catch {
      if (timedOut) throw transportError("request_timeout", endpoint);
      if (callerAborted || callerSignal?.aborted) {
        throw transportError("request_aborted", endpoint);
      }
      throw transportError("network_error", endpoint);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (timedOut) throw transportError("request_timeout", endpoint);
      if (callerAborted || callerSignal?.aborted) {
        throw transportError("request_aborted", endpoint);
      }
      throw new ClientFetchError(
        response.status,
        response.ok ? "invalid_json" : "http_error",
        response.ok ? ERROR_MESSAGES.invalid_json : ERROR_MESSAGES.http_error,
        endpoint
      );
    }

    if (!response.ok) {
      throw httpError(response.status, payload, endpoint);
    }

    if (parse) {
      try {
        return parse(payload);
      } catch (parseErr) {
        // THE BUG: this used to be an empty `catch {}` that discarded both
        // the validator's own rejection reason (e.g. "invalid travel legs")
        // and which endpoint produced it — so a live "unexpected response"
        // incident could not be diagnosed without a full code trace. Both
        // are captured and logged unconditionally now; only the PUBLIC
        // message stays generic-unless-overridden, the same
        // don't-leak-internals discipline `safePublicMessage` already
        // applies to server error text.
        const reason =
          parseErr instanceof Error ? parseErr.message : String(parseErr);
        logInvalidPayload(endpoint, reason);
        throw new ClientFetchError(
          response.status,
          "invalid_payload",
          invalidResponseMessage ?? ERROR_MESSAGES.invalid_payload,
          endpoint,
          reason
        );
      }
    }

    if (guard && !guard(payload)) {
      const reason = "payload failed the shape guard";
      logInvalidPayload(endpoint, reason);
      throw new ClientFetchError(
        response.status,
        "invalid_payload",
        invalidResponseMessage ?? ERROR_MESSAGES.invalid_payload,
        endpoint,
        reason
      );
    }

    return payload as T;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
