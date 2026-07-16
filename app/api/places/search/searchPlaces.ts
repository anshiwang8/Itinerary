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

// Some categories get a hard Places type filter (includedType) because
// free-text relevance alone drifts into lookalike venues:
//  - green space → "park": a "scenic lounge" or view-restaurant can't
//    leak into the pool (pattern aligned with the park resolver in
//    durations.ts)
//  - casino → "casino": the text query "casino <city>" returns poker
//    clubs, arcade bars, and jazz lounges — often HIGHER-rated than the
//    real casinos, so select drifts to a nightclub without the filter
const PARK_PATTERN = /park|trail|garden|green\s*space|greenspace|beach|bench|stroll|hike|\bwalk\b/i;
const TYPE_FILTERS: Array<[RegExp, string]> = [
  [PARK_PATTERN, "park"],
  [/\bcasinos?\b/i, "casino"],
];

/** Places type filter for a category, when one applies. */
export function includedTypeFor(category: string): string | undefined {
  return TYPE_FILTERS.find(([pattern]) => pattern.test(category ?? ""))?.[1];
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

// A vague prompt ("not sure what to do") has no category, so the general
// pool IS the whole plan. One "things to do" text search skews hard to
// daytime tourist attractions — live at 11 PM, 15 of 20 results were
// museums/galleries/the zoo, all dropped as closed, leaving only parks
// (which survive on missing hours). Bars, live music and late food never
// entered the running at all. So the general pool is the UNION of several
// broad queries spanning day and night. No time-awareness needed here:
// the objective hours filter drops whatever is closed at the resolved
// instant, so the same query set self-selects — attractions win at 2 PM,
// nightlife wins at 11 PM.
export const GENERAL_QUERIES = [
  "things to do",
  "bar",
  "live music",
  "late night food",
  "entertainment",
];

/** Merge pools, first occurrence wins (queries overlap on popular venues). */
function dedupeById(places: Place[]): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const p of places) {
    if (p.id && seen.has(p.id)) continue;
    if (p.id) seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * One Text Search per category (parallel), keyed by category. With no
 * categories, the GENERAL_QUERIES union keyed "general" so vague prompts
 * get candidates spanning day and night. `categoriesOverride` lets the
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
    const results = await Promise.all(
      GENERAL_QUERIES.map((q) => searchText(apiKey, buildQuery(parsed, q)))
    );
    return { general: dedupeById(results.flat()) };
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
