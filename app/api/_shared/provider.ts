import { ApiError, isRecord } from "./http";

export type ProviderName =
  | "groq"
  | "places"
  | "routes"
  | "weather"
  | "geocoding"
  | "redis";

export const PROVIDER_TIMEOUT_MS: Record<ProviderName, number> = {
  groq: 20_000,
  places: 10_000,
  routes: 10_000,
  weather: 8_000,
  geocoding: 10_000,
  redis: 5_000,
};

export class ProviderError extends ApiError {
  constructor(
    public readonly provider: ProviderName,
    status: 502 | 504,
    code: string
  ) {
    super(
      status,
      code,
      status === 504
        ? "A provider took too long to respond. Please try again."
        : "A provider could not complete the request. Please try again."
    );
    this.name = "ProviderError";
  }
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
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ProviderError(provider, 502, `${provider}_invalid_response`);
  }
  if (!response.ok) {
    throw new ProviderError(provider, 502, `${provider}_rejected_request`);
  }
  return data;
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
