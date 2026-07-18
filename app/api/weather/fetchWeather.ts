// Server-side hourly forecast fetch, shared by the /api/weather route and
// the swap + reroute engines. The engines used to pass `weather: null` to
// filterPools, skipping the weather gate entirely — so only the INITIAL
// plan ever consulted the forecast, and a swap or reroute could move an
// outdoor stop into the rain undetected (code-audit 2026-07-18 §7.6).
import { WeatherHour } from "../places/search/filter";

const FORECAST_URL = "https://weather.googleapis.com/v1/forecast/hours:lookup";

/** The parts of Google's payload we read (same pattern as the route). */
interface RawForecastHour {
  interval?: { startTime?: string };
  temperature?: { degrees?: number };
  precipitation?: { probability?: { percent?: number } };
  weatherCondition?: { description?: { text?: string }; type?: string };
}

/**
 * Next 24 hours for a point. Returns null on ANY failure — missing key,
 * bad coords, network, non-OK response — because the weather gate's policy
 * is keep-on-missing: no forecast must never block a plan, only a BAD
 * forecast may. Callers pass the result straight to filterPools.
 */
export async function fetchWeatherHours(
  apiKey: string | undefined,
  lat: number,
  lng: number
): Promise<WeatherHour[] | null> {
  if (!apiKey) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const url = new URL(FORECAST_URL);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("location.latitude", String(lat));
  url.searchParams.set("location.longitude", String(lng));
  url.searchParams.set("hours", "24");
  url.searchParams.set("pageSize", "24");
  url.searchParams.set("unitsSystem", "METRIC");

  try {
    const res = await fetch(url.toString(), { next: { revalidate: 600 } });
    const data = await res.json();
    if (!res.ok) {
      console.error(
        `[weather] forecast failed (${res.status}):`,
        data?.error?.message ?? data
      );
      return null;
    }
    return ((data?.forecastHours ?? []) as RawForecastHour[])
      .map((h) => ({
        hourISO: h?.interval?.startTime ?? null,
        tempC: h?.temperature?.degrees ?? null,
        precipProbability: h?.precipitation?.probability?.percent ?? null,
        condition:
          h?.weatherCondition?.description?.text ?? h?.weatherCondition?.type ?? null,
      }))
      .filter((h): h is WeatherHour => typeof h.hourISO === "string")
      .slice(0, 24);
  } catch (err) {
    console.error("[weather] forecast unreachable:", err);
    return null;
  }
}
