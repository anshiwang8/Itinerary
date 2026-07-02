import { NextResponse } from "next/server";

// Places API (New) — Text Search.
// Hardcoded query for now: this route exists purely to prove the
// Google Places connection works end to end.
const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
const HARDCODED_QUERY = "coffee shop Ossington Toronto";

const FIELD_MASK = [
  "places.displayName",
  "places.id",
  "places.location",
  "places.rating",
  "places.priceLevel",
  "places.currentOpeningHours",
  "places.businessStatus",
].join(",");

export async function GET() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_PLACES_API_KEY is not set." },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(SEARCH_TEXT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: HARDCODED_QUERY }),
      // Don't cache while we're proving the connection works.
      cache: "no-store",
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(
        {
          error: `Places API request failed (${res.status}).`,
          details: data?.error?.message ?? data,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to reach the Places API.",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
