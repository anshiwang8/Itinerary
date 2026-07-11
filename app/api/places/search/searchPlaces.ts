// Places Text Search core, shared by the /api/places/search route and
// the reroute engine (which re-searches only the affected categories).
import { ParsedPrompt, Place } from "./filter";

const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.displayName",
  "places.id",
  "places.location",
  "places.rating",
  "places.priceLevel",
  "places.currentOpeningHours",
  "places.businessStatus",
  "places.editorialSummary",
].join(",");

// e.g. aesthetic="lively night out", category="bar", location="Ossington",
// city="Toronto" → "lively night out bar Ossington Toronto".
// Constraints (dietary/vibe: "vegan", "quiet", "wheelchair accessible")
// are injected into the query so they shape the candidate pool itself —
// not just the selection reasons ("vegan lunch" must SEARCH vegan).
// The city comes from parsed.city (user-supplied input, injected by the
// app); itineraries stored before multi-city carry no city and keep the
// original Toronto behavior.
export function buildQuery(parsed: ParsedPrompt, category: string): string {
  const aesthetic =
    parsed.aesthetic && parsed.aesthetic.toLowerCase() !== "unspecified"
      ? parsed.aesthetic
      : "";
  const constraints = (parsed.constraints ?? [])
    .filter((c) => typeof c === "string" && c.trim() !== "")
    .join(" ");
  const neighbourhood =
    parsed.location && parsed.location.toLowerCase() !== "unspecified" ? parsed.location : "";
  const city = parsed.city?.trim() || "Toronto";
  return [aesthetic, constraints, category, neighbourhood, city]
    .filter(Boolean)
    .join(" ");
}

// Green-space categories get a hard Places type filter (includedType:
// "park") so a "scenic lounge" or view-restaurant can't leak into the
// pool — free-text relevance alone can't guarantee a genuine public
// park. Pattern aligned with the park resolver in durations.ts.
const PARK_PATTERN = /park|trail|garden|green\s*space|greenspace|beach|bench|stroll|hike|\bwalk\b/i;

/** Places type filter for a category, when one applies. */
export function includedTypeFor(category: string): string | undefined {
  return PARK_PATTERN.test(category ?? "") ? "park" : undefined;
}

async function searchText(
  apiKey: string,
  textQuery: string,
  includedType?: string
): Promise<Place[]> {
  const res = await fetch(SEARCH_TEXT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({ textQuery, ...(includedType ? { includedType } : {}) }),
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

/**
 * One Text Search per category (parallel), keyed by category. With no
 * categories, a single aesthetic+location query keyed "general" so
 * vague prompts still get candidates. `categoriesOverride` lets the
 * reroute engine re-search a subset without touching parsed.
 */
export async function searchPools(
  apiKey: string,
  parsed: ParsedPrompt,
  categoriesOverride?: string[]
): Promise<Record<string, Place[]>> {
  const categories = (categoriesOverride ?? parsed.category_signals ?? []).filter(
    (c): c is string => typeof c === "string" && c.trim() !== ""
  );

  if (categories.length === 0) {
    return { general: await searchText(apiKey, buildQuery(parsed, "things to do")) };
  }

  const results = await Promise.all(
    categories.map((category) =>
      searchText(apiKey, buildQuery(parsed, category), includedTypeFor(category))
    )
  );
  const pools: Record<string, Place[]> = {};
  categories.forEach((category, i) => {
    pools[category] = results[i];
  });
  return pools;
}
