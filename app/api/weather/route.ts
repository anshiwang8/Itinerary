import { NextResponse } from "next/server";
import { WeatherHour } from "../places/search/filter";
import { isMockMode, mockWeather } from "../_mock/fixtures";

// Google Weather API hourly forecast, next 24h. Single-neighborhood
// launch: location hardcoded to Ossington/Toronto, no location plumbing.
const FORECAST_URL = "https://weather.googleapis.com/v1/forecast/hours:lookup";
const OSSINGTON = { latitude: 43.6479, longitude: -79.4197 };

export async function GET() {
  // fixture seam: 24 calm deterministic hours, no Weather call
  if (isMockMode()) return NextResponse.json(mockWeather());

  const apiKey = process.env.GOOGLE_WEATHER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_WEATHER_API_KEY is not set." },
      { status: 500 }
    );
  }

  const url = new URL(FORECAST_URL);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("location.latitude", String(OSSINGTON.latitude));
  url.searchParams.set("location.longitude", String(OSSINGTON.longitude));
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
