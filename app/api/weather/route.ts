import { NextRequest, NextResponse } from "next/server";
import { WeatherHour } from "../places/search/filter";
import { isMockMode, mockWeather } from "../_mock/fixtures";

// Google Weather API hourly forecast, next 24h.
// GET /api/weather?lat=..&lng=.. — forecast for the plan's geocoded
// location. The app ALWAYS passes coordinates; the fallback below exists
// only for old clients calling without them, and is deliberately not
// relied on any more — a parameterless call used to power the pre-plan
// ambient chip, which meant a Vancouver plan showed a Toronto forecast
// until the pipeline ran (code-audit 2026-07-18 §3.2).
const FORECAST_URL = "https://weather.googleapis.com/v1/forecast/hours:lookup";
const DEFAULT_LOC = { latitude: 43.6479, longitude: -79.4197 }; // Ossington

// A parameterless GET would otherwise be rendered statically at BUILD
// time (stale forecast baked into the deploy). Force per-request
// execution; the fetch below keeps its own 10-minute data cache.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // fixture seam: deterministic hours, no Weather call (coords ignored —
  // the mock is a data source; location doesn't change the fixture)
  if (isMockMode()) return NextResponse.json(mockWeather());

  const apiKey = process.env.GOOGLE_WEATHER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_WEATHER_API_KEY is not set." },
      { status: 500 }
    );
  }

  const lat = parseFloat(request.nextUrl.searchParams.get("lat") ?? "");
  const lng = parseFloat(request.nextUrl.searchParams.get("lng") ?? "");
  const loc =
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? { latitude: lat, longitude: lng }
      : DEFAULT_LOC;

  const url = new URL(FORECAST_URL);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("location.latitude", String(loc.latitude));
  url.searchParams.set("location.longitude", String(loc.longitude));
  url.searchParams.set("hours", "24");
  url.searchParams.set("pageSize", "24");
  url.searchParams.set("unitsSystem", "METRIC");

  try {
    const res = await fetch(url.toString(), {
      // hourly forecast doesn't move fast; cache for 10 minutes
      next: { revalidate: 600 },
    });
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        {
          error: `Weather API request failed (${res.status}).`,
          details: data?.error?.message ?? data,
        },
        { status: 502 }
      );
    }

    const hours: WeatherHour[] = (data?.forecastHours ?? [])
      .map((h: any): WeatherHour => ({
        hourISO: h?.interval?.startTime ?? null,
        tempC: h?.temperature?.degrees ?? null,
        precipProbability: h?.precipitation?.probability?.percent ?? null,
        condition:
          h?.weatherCondition?.description?.text ??
          h?.weatherCondition?.type ??
          null,
      }))
      .filter((h: WeatherHour) => typeof h.hourISO === "string")
      .slice(0, 24);

    return NextResponse.json(hours);
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to reach the Weather API.",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }
}
