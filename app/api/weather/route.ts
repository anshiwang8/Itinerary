import { NextRequest } from "next/server";
import { WeatherHour } from "../places/search/filter";
import { isMockMode, mockWeather } from "../_mock/fixtures";
import {
  ApiError,
  apiError,
  apiJson,
  enforceRateLimit,
  finiteNumber,
  isRecord,
  requestContext,
  requireServiceKey,
  validLatitude,
  validLongitude,
} from "../_shared/http";
import { fetchProvider, readProviderJson, requireProviderRecord } from "../_shared/provider";

// Google Weather API hourly forecast, next 24h.
// GET /api/weather?lat=..&lng=.. — forecast for the plan's geocoded
// location. The app ALWAYS passes coordinates; the fallback below exists
// only for old clients calling without them, and is deliberately not
// relied on any more — a parameterless call used to power the pre-plan
// ambient chip, which meant a Vancouver plan showed a Toronto forecast
// until the pipeline ran (code-audit 2026-07-18 §3.2).
const FORECAST_URL = "https://weather.googleapis.com/v1/forecast/hours:lookup";
// The parts of Google's forecast payload we actually read — same "declare
// the shape you consume" pattern travel.ts uses for ComputeRoutesResponse,
// replacing an `any` on the map callback (code-audit 2026-07-18 §4.1).
// Every field is optional: this is an external payload, and the mapping
// below already falls back to null for each one.
interface RawForecastHour {
  interval?: { startTime?: string };
  temperature?: { degrees?: number };
  precipitation?: { probability?: { percent?: number } };
  weatherCondition?: { description?: { text?: string }; type?: string };
}

// A parameterless GET would otherwise be rendered statically at BUILD
// time (stale forecast baked into the deploy). Force per-request
// execution; the fetch below keeps its own 10-minute data cache.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ctx = requestContext(request, "weather");
  try {
    enforceRateLimit(ctx, 90);
    const latParam = request.nextUrl.searchParams.get("lat");
    const lngParam = request.nextUrl.searchParams.get("lng");
    const lat = latParam === null ? Number.NaN : Number(latParam);
    const lng = lngParam === null ? Number.NaN : Number(lngParam);
    if (!validLatitude(lat) || !validLongitude(lng)) {
      throw new ApiError(
        400,
        "invalid_coordinates",
        "`lat` and `lng` must be valid coordinates."
      );
    }
    const loc = { latitude: lat, longitude: lng };

    // fixture seam: deterministic hours, no Weather call (location does
    // not change the fixture, but the public coordinate contract still
    // validates before reaching the seam).
    if (isMockMode()) return apiJson(ctx, mockWeather());

    const apiKey = requireServiceKey(process.env.GOOGLE_WEATHER_API_KEY);

    const url = new URL(FORECAST_URL);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("location.latitude", String(loc.latitude));
    url.searchParams.set("location.longitude", String(loc.longitude));
    url.searchParams.set("hours", "24");
    url.searchParams.set("pageSize", "24");
    url.searchParams.set("unitsSystem", "METRIC");

    const res = await fetchProvider("weather", url, {
      // hourly forecast doesn't move fast; cache for 10 minutes
      next: { revalidate: 600 },
    });
    const data = requireProviderRecord("weather", await readProviderJson("weather", res));
    if (!Array.isArray(data.forecastHours)) {
      throw new ApiError(
        502,
        "weather_invalid_response",
        "The weather provider returned an invalid response. Please try again."
      );
    }

    // An hour with no start time can't be matched to a plan instant, so it
    // is dropped — the filter is a type GUARD, which is what makes the
    // nullable hourISO safe. (Under the old `any` this mismatch with
    // WeatherHour.hourISO: string was simply invisible.)
    const hours: WeatherHour[] = (data.forecastHours as RawForecastHour[])
      .filter((h): h is RawForecastHour => isRecord(h))
      .map((h) => ({
        hourISO: h?.interval?.startTime ?? null,
        tempC: finiteNumber(h?.temperature?.degrees) ? h.temperature.degrees : null,
        precipProbability: finiteNumber(h?.precipitation?.probability?.percent)
          ? h.precipitation.probability.percent
          : null,
        condition:
          h?.weatherCondition?.description?.text ??
          h?.weatherCondition?.type ??
          null,
      }))
      .filter((h): h is WeatherHour => typeof h.hourISO === "string")
      .slice(0, 24);

    return apiJson(ctx, hours);
  } catch (err) {
    return apiError(ctx, err);
  }
}
