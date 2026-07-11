import { NextRequest, NextResponse } from "next/server";
import { isMockMode, mockGeocode } from "../_mock/fixtures";

// POST /api/geocode { query } → { label, location: { latitude, longitude } }
// Turns a free-text city or street address into coordinates for the
// weather anchor and the home leg. Deliberately reuses the Places API
// Text Search (same key, no new external dependency) instead of adding
// the separate Geocoding API.
const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = ["places.displayName", "places.formattedAddress", "places.location"].join(",");

export async function POST(request: NextRequest) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey && !isMockMode()) {
    return NextResponse.json({ error: "GOOGLE_PLACES_API_KEY is not set." }, { status: 500 });
  }

  let query: string;
  try {
    const body = await request.json();
    query = body?.query;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  if (typeof query !== "string" || !query.trim()) {
    return NextResponse.json(
      { error: "`query` (non-empty string) is required in the body." },
      { status: 400 }
    );
  }

  // fixture seam — deterministic coordinates, no Places call
  if (isMockMode()) return NextResponse.json(mockGeocode(query.trim()));

  try {
    const res = await fetch(SEARCH_TEXT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey!,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query.trim() }),
      cache: "no-store",
    });
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { error: `Geocoding request failed (${res.status}).`, details: data?.error?.message ?? data },
        { status: 502 }
      );
    }
    const top = (data?.places ?? [])[0];
    if (!top?.location) {
      return NextResponse.json(
        { error: `Couldn't find "${query.trim()}" — check the spelling?` },
        { status: 404 }
      );
    }
    return NextResponse.json({
      label: top.displayName?.text ?? top.formattedAddress ?? query.trim(),
      location: { latitude: top.location.latitude, longitude: top.location.longitude },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Geocoding failed.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
