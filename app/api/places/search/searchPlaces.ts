// Places Text Search core, shared by the /api/places/search route and
// the reroute engine (which re-searches only the affected categories).
import { DropEntry, ParsedPrompt, Place } from "./filter";
import { isParkLike } from "../../../lib/categoryTraits";
import {
  badRequest,
  finiteNumber,
  isRecord,
  REQUEST_LIMITS,
  validLatitude,
  validLongitude,
} from "../../_shared/http";
import {
  ProviderError,
  fetchProvider,
  readProviderJson,
  requireProviderRecord,
} from "../../_shared/provider";

const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";

/**
 * Every requested Places field has a code-side consumer. In particular, a
 * cheap ID-only discovery pass cannot choose a safe shortlist: hours, status,
 * rating and price are the deterministic filter, while the feature booleans
 * are the only evidence hard constraints may trust. `editorialSummary` is the
 * stop-card description. Dropping any of these facts before shortlisting
 * changes product correctness; asking for them in a later Details pass adds
 * calls without a fact-based way to choose which candidates to enrich.
 *
 * Keep the purpose groups exported so tests make a field-mask expansion (and
 * its provider-cost impact) measurable instead of hiding it in a string.
 */
export const SEARCH_FIELD_GROUPS = {
  identityAndRouting: [
    "places.displayName",
    "places.id",
    "places.location",
  ],
  objectiveFilter: [
    "places.rating",
    "places.priceLevel",
    "places.currentOpeningHours",
    "places.businessStatus",
  ],
  productOutput: ["places.editorialSummary"],
  structuredConstraintEvidence: [
    "places.servesVegetarianFood",
    "places.outdoorSeating",
    "places.liveMusic",
    "places.goodForChildren",
    "places.allowsDogs",
    "places.accessibilityOptions",
  ],
} as const;

export const SEARCH_FIELD_MASK_FIELDS = Object.values(SEARCH_FIELD_GROUPS).flat();
export const SEARCH_FIELD_MASK = SEARCH_FIELD_MASK_FIELDS.join(",");

/** Public request schemas allow at most eight categories. A late-night plan
 * runs two variants per distinct category, so one searchPools call is bounded
 * at sixteen provider calls (the general pool uses five). */
export const MAX_PROVIDER_CALLS_PER_SEARCH = REQUEST_LIMITS.categories * 2;

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
  const res = await fetchProvider("places", SEARCH_TEXT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": SEARCH_FIELD_MASK,
    },
    body: JSON.stringify({ textQuery, ...(includedType ? { includedType } : {}) }),
    cache: "no-store",
  });
  const data = requireProviderRecord("places", await readProviderJson("places", res));
  if (!Array.isArray(data.places)) {
    // Google may omit `places` for a valid empty result.
    if (data.places === undefined) return [];
    throw new ProviderError("places", 502, "places_invalid_response");
  }
  return data.places.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id === "") {
      throw new ProviderError("places", 502, "places_invalid_response");
    }
    if (candidate.location !== undefined) {
      if (
        !isRecord(candidate.location) ||
        !validLatitude(candidate.location.latitude) ||
        !validLongitude(candidate.location.longitude)
      ) {
        throw new ProviderError("places", 502, "places_invalid_response");
      }
    }
    if (
      candidate.rating !== undefined &&
      (!finiteNumber(candidate.rating) || candidate.rating < 0 || candidate.rating > 5)
    ) {
      throw new ProviderError("places", 502, "places_invalid_response");
    }
    return candidate as unknown as Place;
  });
}

function normalizedSearchKey(textQuery: string, includedType?: string): string {
  // buildQuery embeds aesthetic, constraints, category, neighbourhood and
  // city. includedType is separate provider behavior and therefore part of
  // the key. lateNight changes the query set itself.
  const query = textQuery.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const type = includedType?.normalize("NFKC").trim().toLowerCase() ?? "";
  return `${type}\u0000${query}`;
}

/**
 * Deduplicate identical provider work only inside one searchPools call.
 *
 * Do not promote this to a module/global TTL cache: full Places payloads
 * include provider content that must not be persisted across requests, and
 * opening hours need to be fetched afresh for each planning/recovery attempt.
 * The request schema plus MAX_PROVIDER_CALLS_PER_SEARCH bounds this Map. A
 * rejected promise is evicted immediately and a later attempt must call the
 * provider again.
 */
function requestScopedSearch(apiKey: string) {
  const inFlight = new Map<string, Promise<Place[]>>();
  return (textQuery: string, includedType?: string): Promise<Place[]> => {
    const key = normalizedSearchKey(textQuery, includedType);
    const existing = inFlight.get(key);
    if (existing) return existing;

    const pending = searchText(apiKey, textQuery, includedType);
    inFlight.set(key, pending);
    void pending.catch(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
    return pending;
  };
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
  if (categories.length > REQUEST_LIMITS.categories) {
    badRequest(
      `Venue search accepts at most ${REQUEST_LIMITS.categories} distinct categories.`
    );
  }

  // Before: a normal named-category request made N calls, late-night made
  // 2N, and the five-query general pool made five, even when two variants
  // were byte-equivalent. After: those are hard upper bounds, with identical
  // query+type work shared only during this invocation. A later planning or
  // recovery attempt always fetches fresh provider data.
  const search = requestScopedSearch(apiKey);

  // allSettled, not all: one category's transient failure (rate limit,
  // timeout) used to reject the whole search and throw away every OTHER
  // category's perfectly good results as a 500. A failed category becomes
  // an EMPTY pool plus a drop entry saying why, which routes it into the
  // existing recovery panel — the flow built for exactly this shape.
  // Only a total wipeout still throws (§6.1).
  const note = (category: string) => {
    out?.failures.push({
      category,
      name: "(search unavailable)",
      id: "",
      rule: "searchFailed",
      detail: "The venue search provider was unavailable for this category.",
    });
  };

  if (categories.length === 0) {
    const settled = await Promise.allSettled(
      GENERAL_QUERIES.map((q) => search(buildQuery(parsed, q)))
    );
    const ok = settled.filter(
      (r): r is PromiseFulfilledResult<Place[]> => r.status === "fulfilled"
    );
    if (ok.length === 0) {
      const first = settled[0] as PromiseRejectedResult | undefined;
      throw first?.reason ?? new ProviderError("places", 502, "places_unavailable");
    }
    for (const r of settled) if (r.status === "rejected") note("general");
    return { general: dedupeById(ok.flatMap((r) => r.value)) };
  }

  // at a late target hour, pair each category query with its "late night"
  // variant; the primary query goes first so its results win the dedupe.
  // A category that already says "late night" needs no doubled
  // "late night late night …" sibling.
  const queriesFor = (category: string): string[] =>
    opts.lateNight && !/\blate[\s-]+night\b/i.test(category)
      ? [buildQuery(parsed, category), buildQuery(parsed, `late night ${category}`)]
      : [buildQuery(parsed, category)];

  const settled = await Promise.allSettled(
    categories.map(async (category) => {
      const variants = await Promise.allSettled(
        queriesFor(category).map((q) => search(q, includedTypeFor(category)))
      );
      const successful = variants.filter(
        (result): result is PromiseFulfilledResult<Place[]> =>
          result.status === "fulfilled"
      );
      if (successful.length === 0) {
        const first = variants[0] as PromiseRejectedResult | undefined;
        throw first?.reason ?? new Error("Places search failed.");
      }
      return dedupeById(successful.flatMap((result) => result.value));
    })
  );
  if (settled.every((r) => r.status === "rejected")) {
    const first = settled[0] as PromiseRejectedResult;
    throw first.reason;
  }
  const pools: Record<string, Place[]> = {};
  categories.forEach((category, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") {
      pools[category] = r.value;
    } else {
      pools[category] = [];
      note(category);
    }
  });
  return pools;
}
