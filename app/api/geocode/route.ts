import { NextRequest } from "next/server";
import { zoneFromLatLng } from "../../lib/zoneTime";
import { isMockMode, mockGeocode } from "../_mock/fixtures";
import {
  ApiError,
  REQUEST_LIMITS,
  apiError,
  apiJson,
  enforceRateLimit,
  isRecord,
  readJsonBody,
  requestContext,
  requireServiceKey,
  validLatitude,
  validLongitude,
} from "../_shared/http";
import { fetchProvider, readProviderJson, requireProviderRecord } from "../_shared/provider";

// POST /api/geocode { query } → { label, location: { latitude, longitude } }
// Turns a free-text city or street address into coordinates for the
// weather anchor and the home leg. Deliberately reuses the Places API
// Text Search (same key, no new external dependency) instead of adding
// the separate Geocoding API.
const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = ["places.displayName", "places.formattedAddress", "places.location"].join(",");

export async function POST(request: NextRequest) {
  const ctx = requestContext(request, "geocode");
  try {
    enforceRateLimit(ctx, 60);
    const body = await readJsonBody(request);
    if (
      !isRecord(body) ||
      typeof body.query !== "string" ||
      body.query.trim() === "" ||
      body.query.length > REQUEST_LIMITS.promptChars
    ) {
      throw new ApiError(
        400,
        "invalid_query",
        `\`query\` must be a non-empty string no longer than ${REQUEST_LIMITS.promptChars} characters.`
      );
    }
    const query = body.query.trim();

    // fixture seam — deterministic coordinates, no Places call
    if (isMockMode()) return apiJson(ctx, mockGeocode(query));

    const apiKey = requireServiceKey(process.env.GOOGLE_PLACES_API_KEY);
    const res = await fetchProvider("places", SEARCH_TEXT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query }),
      cache: "no-store",
    });
    const data = requireProviderRecord("places", await readProviderJson("places", res));
    const places = data.places;
    const top = Array.isArray(places) ? places[0] : undefined;
    if (!isRecord(top)) {
      throw new ApiError(
        404,
        "geocode_not_found",
        "Couldn't find that location — check the spelling?"
      );
    }
    const location = top.location;
    if (
      !isRecord(location) ||
      !validLatitude(location.latitude) ||
      !validLongitude(location.longitude)
    ) {
      throw new ApiError(
        502,
        "places_invalid_response",
        "The location provider returned an invalid response. Please try again."
      );
    }
    const { latitude, longitude } = location;
    const displayName = isRecord(top.displayName) ? top.displayName.text : undefined;
    return apiJson(ctx, {
      label:
        (typeof top.formattedAddress === "string" && top.formattedAddress) ||
        (typeof displayName === "string" && displayName) ||
        query,
      location: { latitude, longitude },
      // resolve the plan's timezone from the geocoded coords (offline)
      timeZone: zoneFromLatLng(latitude, longitude),
    });
  } catch (err) {
    return apiError(ctx, err);
  }
}
