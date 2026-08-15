import { ApiError, isRecord } from "./http";

export type ProviderName =
  | "openrouter"
  | "places"
  | "routes"
  | "weather"
  | "geocoding"
  | "redis";

export const PROVIDER_TIMEOUT_MS: Record<ProviderName, number> = {
  // 45s, up from the 20s this was while the LLM was Groq. That number was
  // tuned to an LPU that answered in seconds; OpenRouter routes to whichever
  // upstream is serving the model, and two of the three chain entries
  // (`openai/gpt-oss-*`) emit reasoning tokens BEFORE the answer, so a fat
  // select call has a genuinely different latency floor. A timeout here is
  // also the worst possible failure: `fetchProvider` throws without a
  // `failure`, so `isModelRetryable` is false and the chain does NOT advance
  // — a slow model fails the request outright rather than falling back.
  //
  // Not higher than 45s on purpose: two ceilings sit above this one. The
  // BROWSER gives up first (`DEFAULT_CLIENT_FETCH_TIMEOUT_MS`, 15s — no
  // caller overrides it), and Vercel's function `maxDuration` sits above
  // that. Waiting past either buys the user nothing.
  openrouter: 45_000,
  places: 10_000,
  routes: 10_000,
  weather: 8_000,
  geocoding: 10_000,
  redis: 5_000,
};

/** Details a caller needs to decide whether a failure is worth reacting to.
 *  Server-side only — none of this reaches the browser. */
export interface ProviderFailure {
  /** the provider's OWN HTTP status. Previously checked and discarded, which
   *  made a 429 (wait), a 401 (bad key) and a 500 (their problem) identical
   *  to every consumer. */
  upstreamStatus: number;
  /** seconds from the `retry-after` header, when the provider sent a usable
   *  one. Absent is normal — never invent a wait. */
  retryAfterSeconds?: number;
}

export class ProviderError extends ApiError {
  /** see ProviderFailure — absent when the failure never reached the provider
   *  (timeout, transport) */
  public readonly failure?: ProviderFailure;

  constructor(
    public readonly provider: ProviderName,
    status: 502 | 504,
    code: string,
    failure?: ProviderFailure
  ) {
    super(
      status,
      code,
      status === 504
        ? "A provider took too long to respond. Please try again."
        : "A provider could not complete the request. Please try again."
    );
    this.name = "ProviderError";
    this.failure = failure;
  }

  /**
   * Is retrying this on a DIFFERENT model worth doing?
   *
   * Only 429 and provider-side 5xx. The distinction matters more than it
   * looks: a 401 or 403 is the same API key failing the same way on every
   * model in the chain, so advancing just burns time and buries the real
   * problem (missing or unconfigured key) under a pile of identical
   * failures. A 400 is our own malformed request — the next model will
   * reject it too.
   */
  get isModelRetryable(): boolean {
    const status = this.failure?.upstreamStatus;
    if (status === undefined) return false;
    return status === 429 || status >= 500;
  }
}

/** `retry-after` is seconds or an HTTP-date (RFC 9110). Anything else — and
 *  a date already in the past — yields undefined rather than a bogus wait. */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now()
): number | undefined {
  if (!header) return undefined;
  const text = header.trim();
  if (text === "") return undefined;

  // Providers send fractional seconds ("7.5"); floor to whole seconds but
  // never to zero, since 0 reads as "no wait needed" downstream.
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Math.floor(Number(text));
    return Number.isFinite(seconds) ? Math.max(1, seconds) : undefined;
  }

  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.ceil((at - now) / 1_000);
  return seconds > 0 ? seconds : undefined;
}

export async function fetchProvider(
  provider: ProviderName,
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = PROVIDER_TIMEOUT_MS[provider]
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch {
    throw new ProviderError(
      provider,
      timedOut ? 504 : 502,
      timedOut ? `${provider}_timeout` : `${provider}_unavailable`
    );
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

export async function readProviderJson(
  provider: ProviderName,
  response: Response
): Promise<unknown> {
  // Read as TEXT first: a rejection's body is often not JSON (an HTML error
  // page from a gateway), and parsing first would turn a rejection into
  // "invalid_response", sending the reader after a parser bug that isn't there.
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ProviderError(provider, 502, `${provider}_invalid_response`);
  }

  if (!response.ok) {
    const failure: ProviderFailure = {
      upstreamStatus: response.status,
      ...(parseRetryAfter(response.headers.get("retry-after")) !== undefined
        ? { retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) }
        : {}),
    };
    // A rate limit gets its OWN code. It is the one provider rejection with a
    // different remedy — wait, or ask a different model — and callers cannot
    // act on what they cannot distinguish. Everything else keeps the existing
    // generic code, so no other behaviour changes.
    throw new ProviderError(
      provider,
      502,
      response.status === 429
        ? `${provider}_rate_limited`
        : `${provider}_rejected_request`,
      failure
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError(provider, 502, `${provider}_invalid_response`);
  }

  // A 200 that is actually a failure. OpenRouter can answer a rate limit (and
  // other upstream rejections) with HTTP 200 and an `{ error: { code, ... } }`
  // body instead of a status. Checking `response.ok` alone let that through:
  // `choices` came back undefined, the call site threw its own
  // `*_invalid_response`, and because that error carries no upstreamStatus,
  // `isModelRetryable` was false and the CHAIN NEVER ADVANCED — the exact
  // failure withModelFallback exists to survive burned the request instead.
  // Reading the wrapped code back into upstreamStatus restores it.
  const wrapped = wrappedErrorStatus(parsed);
  if (wrapped !== undefined) {
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
    throw new ProviderError(
      provider,
      502,
      wrapped === 429 ? `${provider}_rate_limited` : `${provider}_rejected_request`,
      {
        upstreamStatus: wrapped,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      }
    );
  }

  return parsed;
}

/**
 * The upstream status hiding inside a 200 body, or undefined when the body is
 * a normal answer.
 *
 * Deliberately conservative on both sides:
 *  - a body that carries `choices` is a real completion and is never treated
 *    as an error, whatever else rides alongside it;
 *  - `error` must be an OBJECT. Upstash answers a failed command with
 *    `{ error: "<string>" }`, and this must not change how Redis behaves.
 *
 * An unreadable code falls to 502 rather than to nothing: a body-wrapped error
 * with no usable code is the provider malfunctioning, and asking a different
 * model is the cheap correct response to that.
 */
function wrappedErrorStatus(body: unknown): number | undefined {
  if (!isRecord(body) || Array.isArray(body.choices)) return undefined;
  const error = body.error;
  if (!isRecord(error)) return undefined;

  const raw = error.code;
  const code =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
      ? Number(raw.trim())
      : undefined;
  return code !== undefined && code >= 100 && code <= 599 ? code : 502;
}

export function requireProviderRecord(
  provider: ProviderName,
  value: unknown
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProviderError(provider, 502, `${provider}_invalid_response`);
  }
  return value;
}
