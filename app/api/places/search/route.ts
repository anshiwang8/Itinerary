import { NextRequest, NextResponse } from "next/server";
import { filterPools, ParsedPrompt, Place, WeatherHour } from "./filter";

// Places API (New) — Text Search, driven by the parsed prompt from
// /api/parse. One Text Search call per category signal, so downstream
// steps get a separate candidate pool per stop type rather than one
// mixed list. Pools pass through the objective filter (filter.ts)
// before the response. No LLM selection yet.
const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.displayName",
  "places.id",
  "places.location",
  "places.rating",
  "places.priceLevel",
  "places.currentOpeningHours",
  "places.businessStatus",
].join(",");

// e.g. aesthetic="lively night out", category="bar", location="Ossington"
// → "lively night out bar Ossington Toronto"
function buildQuery(parsed: ParsedPrompt, category: string): string {
  const aesthetic =
    parsed.aesthetic && parsed.aesthetic.toLowerCase() !== "unspecified"
      ? parsed.aesthetic
      : "";
  return [aesthetic, category, parsed.location, "Toronto"]
    .filter(Boolean)
    .join(" ");
}

async function searchText(apiKey: string, textQuery: string) {
  const res = await fetch(SEARCH_TEXT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({ textQuery }),
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      data?.error?.message ?? `Places API request failed (${res.status}).`
    );
  }
  return data.places ?? [];
}

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

  const categories = Array.isArray(parsed.category_signals)
    ? parsed.category_signals.filter(
        (c): c is string => typeof c === "string" && c.trim() !== ""
      )
    : [];

  try {
    // Vague prompts can parse to zero category signals; run a single
    // aesthetic+location query so the caller still gets candidates.
    const rawPools: Record<string, Place[]> = {};
    if (categories.length === 0) {
      rawPools.general = await searchText(
        apiKey,
        buildQuery(parsed, "things to do")
      );
    } else {
      // One Text Search per category, in parallel.
      const results = await Promise.all(
        categories.map((category) =>
          searchText(apiKey, buildQuery(parsed, category))
        )
      );
      categories.forEach((category, i) => {
        rawPools[category] = results[i];
      });
    }

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
