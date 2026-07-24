// Places Text Search core, shared by the /api/places/search route and
// the reroute engine (which re-searches only the affected categories).
import { DropEntry, ParsedPrompt, Place } from "./filter";
import { isParkLike } from "../../../lib/categoryTraits";

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
const TYPE_FILTERS: Array<[RegExp, string]> = [[/\bcasinos?\b/i, "casino"]];

/** Places type filter for a category, when one applies. Park membership
 *  comes from the shared traits table (§5.3), not a fourth local regex. */
export function includedTypeFor(category: string): string | undefined {
  if (isParkLike(category ?? "")) return "park";
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
  categoriesOverride?: string[],
  /** optional out-param: per-category search failures, as drop entries the
   *  caller can fold into its drop log (code-audit 2026-07-18 §6.1) */
  out?: { failures: DropEntry[] },
  opts: {
    /** the plan resolves to a LATE hour — each named category also runs a
     * "late night <category>" variant and unions the results. Same class
     * of problem GENERAL_QUERIES already solved for the vague pool: one
     * relevance-ranked text search skews to well-known (and by-then-
     * closed) venues. Probe, Toronto 23:30: "restaurant" returned 6/20
     * open; the "late night" variant surfaced 8/20 with partial overlap,
     * so the union roughly doubles the genuinely-open pool. */
    lateNight?: boolean;
  } = {}
): Promise<Record<string, Place[]>> {
  // Pools are keyed by category, so a category requested twice ("a drink,
  // then another drink somewhere else") needs only ONE search — the second
  // would return the same venues and overwrite the first. De-duplicating
  // here also halves the API calls on such a request; the SLOT bookkeeping
  // that keeps two stops distinct lives in selectVenues, which is where
  // "one venue per requested stop" actually belongs.
  const categories = [
    ...new Set(
      (categoriesOverride ?? parsed.category_signals ?? []).filter(
        (c): c is string => typeof c === "string" && c.trim() !== ""
      )
    ),
  ];

  // allSettled, not all: one category's transient failure (rate limit,
  // timeout) used to reject the whole search and throw away every OTHER
  // category's perfectly good results as a 500. A failed category becomes
  // an EMPTY pool plus a drop entry saying why, which routes it into the
  // existing recovery panel — the flow built for exactly this shape.
  // Only a total wipeout still throws (§6.1).
  const note = (category: string, err: unknown) => {
    out?.failures.push({
      category,
      name: "(search unavailable)",
      id: "",
      rule: "searchFailed",
      detail: err instanceof Error ? err.message : String(err),
    });
  };

  if (categories.length === 0) {
    const settled = await Promise.allSettled(
      GENERAL_QUERIES.map((q) => searchText(apiKey, buildQuery(parsed, q)))
    );
    const ok = settled.filter(
      (r): r is PromiseFulfilledResult<Place[]> => r.status === "fulfilled"
    );
    if (ok.length === 0) {
      throw new Error(
        settled[0] && settled[0].status === "rejected"
          ? String(settled[0].reason?.message ?? settled[0].reason)
          : "Places search failed."
      );
    }
    for (const r of settled) if (r.status === "rejected") note("general", r.reason);
    return { general: dedupeById(ok.flatMap((r) => r.value)) };
  }

  // at a late target hour, pair each category query with its "late night"
  // variant; the primary query goes first so its results win the dedupe
  const queriesFor = (category: string): string[] =>
    opts.lateNight
      ? [buildQuery(parsed, category), buildQuery(parsed, `late night ${category}`)]
      : [buildQuery(parsed, category)];

  const settled = await Promise.allSettled(
    categories.map(async (category) => {
      const results = await Promise.all(
        queriesFor(category).map((q) => searchText(apiKey, q, includedTypeFor(category)))
      );
      return dedupeById(results.flat());
    })
  );
  if (settled.every((r) => r.status === "rejected")) {
    const first = settled[0] as PromiseRejectedResult;
    throw new Error(String(first.reason?.message ?? first.reason));
  }
  const pools: Record<string, Place[]> = {};
  categories.forEach((category, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") {
      pools[category] = r.value;
    } else {
      pools[category] = [];
      note(category, r.reason);
    }
  });
  return pools;
}
