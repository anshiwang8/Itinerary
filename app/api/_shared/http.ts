import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const REQUEST_LIMITS = {
  jsonBytes: 256 * 1024,
  promptChars: 2_000,
  refinementChars: 1_000,
  categories: 8,
  candidatesPerPool: 25,
  totalCandidates: 160,
  points: 9,
  textFieldChars: 240,
} as const;

const RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 90;

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateGlobal = globalThis as {
  __itineraryRateBuckets?: Map<string, RateBucket>;
};
const rateBuckets = (rateGlobal.__itineraryRateBuckets ??= new Map<string, RateBucket>());
const requestStore = new AsyncLocalStorage<RequestContext>();

export interface RequestContext {
  requestId: string;
  scope: string;
  clientKey: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly publicMessage: string,
    public readonly headers?: Record<string, string>
  ) {
    super(code);
    this.name = "ApiError";
  }
}

function requestIdFrom(request: NextRequest): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && /^[A-Za-z0-9._-]{1,64}$/.test(supplied) ? supplied : randomUUID();
}

function clientKeyFrom(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || request.headers.get("x-real-ip")?.trim();
  // Proxy headers are untrusted input. Keep the rate-limit key bounded so a
  // fabricated header cannot turn the bucket map into an unbounded string sink.
  return candidate ? candidate.slice(0, 128) : "anonymous";
}

export function requestContext(request: NextRequest, scope: string): RequestContext {
  const ctx = {
    requestId: requestIdFrom(request),
    scope,
    clientKey: clientKeyFrom(request),
  };
  requestStore.enterWith(ctx);
  return ctx;
}

export function logEvent(
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {}
): void {
  console[level](
    JSON.stringify({
      level,
      event,
      requestId: requestStore.getStore()?.requestId ?? "unscoped",
      ...fields,
    })
  );
}

export function enforceRateLimit(
  ctx: RequestContext,
  limit = DEFAULT_RATE_LIMIT,
  now = Date.now()
): void {
  if (rateBuckets.size > 10_000) {
    for (const [key, bucket] of rateBuckets) {
      if (bucket.resetAt <= now || rateBuckets.size > 10_000) rateBuckets.delete(key);
      if (rateBuckets.size <= 10_000) break;
    }
  }
  const key = `${ctx.scope}:${ctx.clientKey}`;
  const current = rateBuckets.get(key);
  const bucket =
    !current || current.resetAt <= now
      ? { count: 0, resetAt: now + RATE_WINDOW_MS }
      : current;
  bucket.count++;
  rateBuckets.set(key, bucket);

  if (bucket.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
    throw new ApiError(
      429,
      "rate_limited",
      "Too many requests. Please wait a moment and try again.",
      { "Retry-After": String(retryAfter) }
    );
  }
}

/** Test-only control: suites run in isolated processes, so clearing cannot
 * affect a production request. */
export function resetRateLimitsForTests(): void {
  rateBuckets.clear();
}

export async function readJsonBody<T = unknown>(
  request: NextRequest,
  maxBytes = REQUEST_LIMITS.jsonBytes
): Promise<T> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      throw new ApiError(413, "body_too_large", "Request body is too large.");
    }
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ApiError(413, "body_too_large", "Request body is too large.");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

export function apiJson(
  ctx: RequestContext,
  value: unknown,
  init: number | ResponseInit = 200
): NextResponse {
  const responseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(responseInit.headers);
  headers.set("x-request-id", ctx.requestId);
  return NextResponse.json(value, { ...responseInit, headers });
}

export function apiError(ctx: RequestContext, error: unknown): NextResponse {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "internal_error";
  const message = known
    ? error.publicMessage
    : "The service could not complete that request. Please try again.";
  const headers = new Headers(known ? error.headers : undefined);
  headers.set("x-request-id", ctx.requestId);

  // Structured and deliberately sparse: no prompt, refinement, provider
  // body, environment value, token, location, or arbitrary error message.
  logEvent("error", "api_request_failed", {
    requestId: ctx.requestId,
    scope: ctx.scope,
    status,
    code,
  });

  return NextResponse.json(
    { error: message, code, requestId: ctx.requestId },
    { status, headers }
  );
}

export function badRequest(message: string, code = "invalid_request"): never {
  throw new ApiError(400, code, message);
}

export function requireServiceKey(value: string | undefined): string {
  if (!value) {
    throw new ApiError(
      503,
      "service_not_configured",
      "That service is temporarily unavailable."
    );
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validLatitude(value: unknown): value is number {
  return finiteNumber(value) && value >= -90 && value <= 90;
}

export function validLongitude(value: unknown): value is number {
  return finiteNumber(value) && value >= -180 && value <= 180;
}

export function validIsoInstant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

export function validIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
