import { NextRequest, NextResponse } from "next/server";
import { filterPools, ParsedPrompt, WeatherHour } from "./filter";
import { searchPools } from "./searchPlaces";

// Places API (New) — Text Search, driven by the parsed prompt from
// /api/parse. Search core lives in searchPlaces.ts (shared with the
// reroute engine); pools pass through the objective filter before the
// response. No LLM selection here.
export async function POST(request: NextRequest) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_PLACES_API_KEY is not set." },
      { status: 500 }
    );
  }

  let parsed: ParsedPrompt;
  let weather: WeatherHour[] | null;
  try {
    const body = await request.json();
    parsed = body?.parsed;
    // optional; missing/invalid weather just skips the weather gate
    weather = Array.isArray(body?.weather) ? body.weather : null;
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
    const rawPools = await searchPools(apiKey, parsed);
    const { pools, dropLog, weatherBlocked } = filterPools(
      rawPools,
      parsed,
      weather
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
