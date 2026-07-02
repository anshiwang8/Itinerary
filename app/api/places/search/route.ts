import { NextRequest, NextResponse } from "next/server";

// Places API (New) — Text Search, driven by the parsed prompt from
// /api/parse. One Text Search call per category signal, so downstream
// steps get a separate candidate pool per stop type rather than one
// mixed list. No filtering or LLM selection yet.
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

// Shape returned by /api/parse.
interface ParsedPrompt {
  time_window: string;
  stop_count: number | null;
  aesthetic: string;
  category_signals: string[];
  group_context: string;
  budget: string | null;
  constraints: string[];
  location: string;
}

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
  try {
    const body = await request.json();
    parsed = body?.parsed;
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
    if (categories.length === 0) {
      const query = buildQuery(parsed, "things to do");
      const places = await searchText(apiKey, query);
      return NextResponse.json({ general: places });
    }

    // One Text Search per category, in parallel.
    const pools = await Promise.all(
      categories.map((category) =>
        searchText(apiKey, buildQuery(parsed, category))
      )
    );

    const byCategory: Record<string, unknown[]> = {};
    categories.forEach((category, i) => {
      byCategory[category] = pools[i];
    });

    return NextResponse.json(byCategory);
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
