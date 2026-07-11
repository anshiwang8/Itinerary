import { NextRequest, NextResponse } from "next/server";
import { filterPools, ParsedPrompt, WeatherHour } from "./filter";
import { searchPools } from "./searchPlaces";
import { resolveStartTime } from "../../schedule/schedule";
import { isMockMode, mockPools } from "../../_mock/fixtures";

// Places API (New) — Text Search, driven by the parsed prompt from
// /api/parse. Search core lives in searchPlaces.ts (shared with the
// reroute engine); pools pass through the objective filter before the
// response. No LLM selection here.
export async function POST(request: NextRequest) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey && !isMockMode()) {
    return NextResponse.json(
      { error: "GOOGLE_PLACES_API_KEY is not set." },
      { status: 500 }
    );
  }

  let parsed: ParsedPrompt;
  let weather: WeatherHour[] | null;
  let timeZone: string | undefined;
  try {
    const body = await request.json();
    parsed = body?.parsed;
    // optional; missing/invalid weather just skips the weather gate
    weather = Array.isArray(body?.weather) ? body.weather : null;
    // the plan's zone — the hours filter checks the VENUE's local wall clock
    timeZone = typeof body?.timeZone === "string" ? body.timeZone : undefined;
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400 }
    );
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.location !== "string") {
    return NextResponse.json(
      { error: "`parsed` (the /api/parse output object) is required in the body." },
      { status: 400 }
    );
  }

  try {
    // observability at the resolution point (like [swap-apply]): what the
    // parse handed us, what instant it resolved to, and under which TZ —
    // a schedule anchored at a nonsense hour is visible right here
    {
      const cats = (parsed.category_signals ?? []).filter(
        (c): c is string => typeof c === "string" && c.trim() !== ""
      );
      const resolved = resolveStartTime(parsed.time_window ?? "", new Date(), cats, timeZone);
      console.log(
        `[schedule-resolve] time_window=${JSON.stringify(parsed.time_window)} ` +
          `categories=${JSON.stringify(cats)} zone=${timeZone ?? "(default Toronto)"} ` +
          `resolved=${resolved.toISOString()} TZ=${process.env.TZ ?? "(unset)"}`
      );
    }

    // fixture seam: swap the DATA SOURCE only — the objective filter
    // below still runs for real over the fixture pools
    const rawPools = isMockMode()
      ? mockPools(parsed.category_signals ?? [])
      : await searchPools(apiKey!, parsed);
    const { pools, dropLog, weatherBlocked } = filterPools(
      rawPools,
      parsed,
      weather,
      new Date(),
      undefined,
      timeZone
    );
    return NextResponse.json({
      ...pools,
      _dropLog: dropLog,
      _weatherBlocked: weatherBlocked,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Places search failed.",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
