// E2E fixture layer — deterministic stand-ins for the live APIs, active
// only when the server runs with E2E_MOCK=1. A SEAM, not a rewrite: the
// objective filter, scheduling, floor guards, and resettle ladder all run
// for real; only the DATA SOURCES (Groq parse/select/interpret, Places
// search, Routes legs, Weather) are swapped — same discipline as
// isUsableAt. Real routes stay the default.
//
// The pools are deliberately varied so real scenarios are exercisable:
//  - prices from $ to $$$ (a "cheaper" swap has somewhere to land — the
//    top-rated dinner is EXPENSIVE, so budget requests change the pick)
//  - hours from early-closing to overnight (time/duration swaps can hit
//    open vs closed; the early closers make the adapt path fire)
//  - three named categories (dinner / drinks / dessert) + a generated
//    generic pool for anything else
import type { ParsedPrompt, Place, WeatherHour } from "../places/search/filter";
import { isOpenAt, isOpenAtInstant, CurrentOpeningHours } from "../places/search/hours";
import type { LatLng, TravelLeg } from "../schedule/travel";
import type { Selection } from "../select/selectVenues";
import type {
  SwapDeps,
  SwapIntent,
  TimeShift,
  DurationShift,
} from "../itinerary/swap";
import type { RerouteDeps } from "../itinerary/reroute";

export function isMockMode(): boolean {
  return process.env.E2E_MOCK === "1";
}

// ── hours: identical every day; closeH <= openH wraps past midnight ──
function daily(openH: number, closeH: number): CurrentOpeningHours {
  const periods = [];
  for (let day = 0; day < 7; day++) {
    periods.push({
      open: { day, hour: openH, minute: 0 },
      close: {
        day: closeH <= openH ? (day + 1) % 7 : day,
        hour: closeH % 24,
        minute: 0,
      },
    });
  }
  return { periods };
}

function venue(
  id: string,
  name: string,
  lat: number,
  lng: number,
  rating: number,
  priceLevel: string,
  openH: number,
  closeH: number,
  desc?: string
): Place {
  return {
    id,
    displayName: { text: name },
    location: { latitude: lat, longitude: lng },
    rating,
    priceLevel,
    currentOpeningHours: daily(openH, closeH),
    businessStatus: "OPERATIONAL",
    // omitted when absent — the keep-on-missing/description-less case
    ...(desc ? { editorialSummary: { text: desc } } : {}),
  };
}

// ── the fixture pools (Ossington-strip coordinates). Descriptions double
// as constraint evidence for mockSelect: "vegan" lives on Noodle
// Letterpress, "patio" on The Standing Room — everything else fails those
// constraints, deterministically. ──
const DINNER: Place[] = [
  // top-rated but EXPENSIVE → the default pick; "cheaper" must beat it
  venue("fx_dinner_velvet", "Velvet Fig", 43.6491, -79.4203, 4.8, "PRICE_LEVEL_EXPENSIVE", 17, 23,
    "Dim-lit modern bistro known for fig-glazed duck and a serious wine list."),
  venue("fx_dinner_corner", "The Corner Table", 43.6478, -79.4194, 4.5, "PRICE_LEVEL_MODERATE", 17, 23,
    "Neighbourhood standby doing honest plates and warm service."),
  venue("fx_dinner_noodle", "Noodle Letterpress", 43.6502, -79.4211, 4.3, "PRICE_LEVEL_INEXPENSIVE", 11, 22,
    "Hand-pulled noodle counter with a deep vegan menu."),
  // closes at 8 PM → late dinners drop it / adapt away from it
  venue("fx_dinner_early", "Early Bird Diner", 43.6468, -79.4186, 4.1, "PRICE_LEVEL_INEXPENSIVE", 8, 20,
    "Sunny all-day diner that packs it in early."),
];
const BAR: Place[] = [
  // top-rated but closes 10 PM → pushing drinks later fires the adapt path
  venue("fx_bar_curfew", "Ten O'Clock Curfew", 43.6485, -79.4199, 4.7, "PRICE_LEVEL_EXPENSIVE", 16, 22,
    "Cocktail room with strict hours and stricter pours."),
  venue("fx_bar_standing", "The Standing Room", 43.6495, -79.4207, 4.6, "PRICE_LEVEL_MODERATE", 17, 2,
    "Snug standing bar with a lantern-lit patio out back."),
  venue("fx_bar_lantern", "Paper Lantern", 43.6473, -79.419, 4.4, "PRICE_LEVEL_INEXPENSIVE", 18, 2,
    "Cheap-and-cheerful late-night bar under red lanterns."),
  // NO hours — keep-on-missing makes it the any-hour survivor (same role
  // as "Fixture … Three"), so bar scenarios that run the pipeline at an
  // odd server hour (the time-gate "something else → drinks" e2e) stay
  // deterministic. Lowest-rated on purpose: it never displaces the picks
  // the other specs pin (Curfew evenings, Standing Room late).
  {
    id: "fx_bar_nightowl",
    displayName: { text: "Night Owl" },
    location: { latitude: 43.6489, longitude: -79.4203 },
    rating: 4.1,
    priceLevel: "PRICE_LEVEL_INEXPENSIVE",
    businessStatus: "OPERATIONAL",
    editorialSummary: { text: "Unfussy neighbourhood bar with unlisted hours." },
  },
];
const DESSERT: Place[] = [
  // closes 9 PM — THE adapt trigger for late-shifted evenings. Deliberately
  // has NO description: the dessert card is the absent-description case.
  venue("fx_dessert_sundown", "Sundown Scoops", 43.6488, -79.4197, 4.5, "PRICE_LEVEL_INEXPENSIVE", 12, 21),
  venue("fx_dessert_midnight", "Midnight Flour", 43.6497, -79.4209, 4.4, "PRICE_LEVEL_MODERATE", 10, 1,
    "Late-night bakery for the after-dinner crowd."),
  venue("fx_dessert_glace", "Glacé Counter", 43.647, -79.4188, 4.2, "PRICE_LEVEL_INEXPENSIVE", 12, 23,
    "French-leaning ice cream counter on the strip."),
];

const POOL_RULES: Array<[RegExp, Place[]]> = [
  [/dessert|ice\s*cream|gelato|sweet|bakery|cake/i, DESSERT],
  [/drink|bar|cocktail|pub|brewery|wine|lounge|club/i, BAR],
  [/dinner|restaurant|dining|food|eat|ramen|sushi|pizza|taco|lunch|brunch/i, DINNER],
];

// Partial-failure recovery fixture: a "dumplings" search IN A NEIGHBOURHOOD
// returns only a permanently-closed spot — the objective filter empties the
// pool and logs a businessStatus drop (→ the honest "permanently closed"
// reason). Widened city-wide (neighbourhood dropped) it returns a real open
// venue, so accepting the widen offer recovers the stop. This is the mock
// stand-in for the live Scenario-1 case (the only nearby ramen was closed).
const DUMPLING_CLOSED: Place = {
  id: "fx_dumpling_closed",
  displayName: { text: "Shuttered Dumpling House" },
  location: { latitude: 43.6489, longitude: -79.4198 },
  rating: 4.6,
  priceLevel: "PRICE_LEVEL_INEXPENSIVE",
  businessStatus: "CLOSED_PERMANENTLY",
  editorialSummary: { text: "Beloved dumpling counter — now permanently closed." },
};
// no currentOpeningHours → keep-on-missing (never dropped on hours), so the
// widen path recovers deterministically regardless of the e2e's run-hour
const DUMPLING_OPEN: Place = {
  id: "fx_dumpling_open",
  displayName: { text: "Citywide Dumpling Bar" },
  location: { latitude: 43.6601, longitude: -79.3802 },
  rating: 4.6,
  priceLevel: "PRICE_LEVEL_INEXPENSIVE",
  businessStatus: "OPERATIONAL",
  editorialSummary: { text: "Handmade dumplings across town, open late." },
};

// second recovery trigger, same shape — lets a scenario produce TWO empty
// categories in one request ("dumplings and bao …") to exercise the
// multi-empty recovery panel
const BAO_CLOSED: Place = {
  id: "fx_bao_closed",
  displayName: { text: "Folded Cloud Bao" },
  location: { latitude: 43.6493, longitude: -79.4206 },
  rating: 4.7,
  priceLevel: "PRICE_LEVEL_INEXPENSIVE",
  businessStatus: "CLOSED_PERMANENTLY",
  editorialSummary: { text: "Steamed-bun counter — now permanently closed." },
};
const BAO_OPEN: Place = {
  id: "fx_bao_open",
  displayName: { text: "Harbourside Bao House" },
  location: { latitude: 43.6389, longitude: -79.3817 },
  rating: 4.5,
  priceLevel: "PRICE_LEVEL_INEXPENSIVE",
  businessStatus: "OPERATIONAL",
  editorialSummary: { text: "Pillowy bao by the water, open late." },
};

// unknown categories still get a small deterministic pool
const genericCache = new Map<string, Place[]>();
function genericPool(category: string): Place[] {
  const cached = genericCache.get(category);
  if (cached) return cached;
  const slug = category.replace(/\W+/g, "_").toLowerCase();
  const label = category.charAt(0).toUpperCase() + category.slice(1);
  const pool = [
    venue(`fx_${slug}_one`, `Fixture ${label} One`, 43.6493, -79.4201, 4.4, "PRICE_LEVEL_MODERATE", 10, 23,
      `A dependable ${category} option on the strip.`),
    venue(`fx_${slug}_two`, `Fixture ${label} Two`, 43.6481, -79.4192, 4.2, "PRICE_LEVEL_INEXPENSIVE", 10, 23,
      `A budget-friendly ${category} pick nearby.`),
    // Three carries NO hours — keep-on-missing makes it the any-hour
    // survivor, so scenarios that run the pipeline at a late/odd hour
    // (the time-gate override e2e) stay deterministic across run hours
    {
      id: `fx_${slug}_three`,
      displayName: { text: `Fixture ${label} Three` },
      location: { latitude: 43.6505, longitude: -79.4214 },
      rating: 4.0,
      priceLevel: "PRICE_LEVEL_INEXPENSIVE",
      businessStatus: "OPERATIONAL",
      editorialSummary: { text: `A quieter ${category} fallback around the corner.` },
    } as Place,
  ];
  genericCache.set(category, pool);
  return pool;
}

export function poolFor(category: string, hasNeighbourhood = false): Place[] {
  // recovery fixtures: in-a-neighbourhood → only-a-closed-spot; city-wide
  // (widened) → a real open venue (see DUMPLING_* / BAO_* above)
  if (/dumpling/i.test(category)) return hasNeighbourhood ? [DUMPLING_CLOSED] : [DUMPLING_OPEN];
  if (/\bbao\b/i.test(category)) return hasNeighbourhood ? [BAO_CLOSED] : [BAO_OPEN];
  // "beach" is the deliberately EMPTY park-family pool: it shares the park
  // plausible band (so the time-gate fires late at night) but nothing is
  // ever found — the deterministic trigger for "override finds nothing →
  // lands in the recovery flow" scenarios, at any run hour
  if (/\bbeach(es)?\b/i.test(category)) return [];
  for (const [pattern, pool] of POOL_RULES) {
    if (pattern.test(category)) return pool;
  }
  return genericPool(category);
}

/** Mirror of searchPools: one pool per category, "general" when none. The
 *  optional parsed lets a fixture react to the neighbourhood the way real
 *  Places does (used by the partial-failure recovery trigger). */
export function mockPools(categories: string[], parsed?: ParsedPrompt): Record<string, Place[]> {
  const cats = categories.filter((c) => typeof c === "string" && c.trim() !== "");
  const hasNeighbourhood = !!(
    parsed?.location && parsed.location.trim() && parsed.location.trim().toLowerCase() !== "unspecified"
  );
  if (cats.length === 0) return { general: genericPool("general") };
  return Object.fromEntries(cats.map((c) => [c, poolFor(c, hasNeighbourhood)]));
}

// ── parse: keyword scan, deterministic, schema-complete. Nothing
// recognized → the all-unspecified signature (what the real model returns
// for nonsense), so the unparseable guard is exercisable in mock mode. ──
export function mockParse(prompt: string): ParsedPrompt {
  const p = prompt.toLowerCase();
  const signals: string[] = [];
  if (/brunch/.test(p)) signals.push("brunch");
  if (/steak/.test(p)) signals.push("steakhouse");
  // dumplings/bao are their own categories (the partial-failure recovery
  // fixtures); kept BEFORE the broad dinner rule so they aren't swallowed
  if (/dumpling/.test(p)) signals.push("dumplings");
  if (/\bbao\b/.test(p)) signals.push("bao");
  if (/dinner|restaurant|ramen|sushi|food|eat/.test(p)) signals.push("dinner");
  if (/drink|bar|cocktail|pub/.test(p)) signals.push("drinks");
  if (/dessert|ice\s*cream|gelato/.test(p)) signals.push("dessert");
  if (/coffee|caf[eé]/.test(p)) signals.push("coffee");
  // "beach" is its own park-family category (the deliberately-empty pool
  // above) — checked before the broader park rules so it isn't swallowed
  if (/\bbeach(es)?\b/.test(p)) {
    signals.push("beach");
  } else if (/bench|scenery|greenery|fresh air|people.watching|calm outside|nature/.test(p)) {
    // passive outdoor/nature enjoyment normalizes to "park" (mirrors the
    // real parse prompt's normalization rule)
    signals.push("park");
  } else if (/walk|park|stroll|hike|picnic/.test(p)) {
    signals.push("park walk");
  }

  const clock = p.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)/);
  const time_window = clock
    ? clock[0]
    : /tonight/.test(p)
    ? "tonight"
    : /evening/.test(p)
    ? "evening"
    : "unspecified";

  const constraints: string[] = [];
  if (/patio/.test(p)) constraints.push("patio");
  if (/vegan/.test(p)) constraints.push("vegan");

  return {
    time_window,
    stop_count: null,
    aesthetic: /fancy|upscale|fine dining/.test(p) ? "fancy" : "unspecified",
    category_signals: signals,
    group_context: "unspecified",
    budget: /cheap|budget/.test(p) ? "cheap" : null,
    constraints,
    location: "Ossington",
  };
}

// ── select: highest-rated wins; a stated cheap budget prefers non-$$$.
// Hard constraints mirror the real contract: a candidate meets one only
// when its name/description evidences it; none do → id:null +
// unmetConstraint, never a hedged pick. ──
function meetsConstraint(place: Place, constraint: string): boolean {
  const hay = `${place.displayName?.text ?? ""} ${place.editorialSummary?.text ?? ""}`.toLowerCase();
  const tokens = constraint.toLowerCase().split(/\W+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => hay.includes(t));
}

export function mockSelect(
  parsed: ParsedPrompt,
  poolsIn: Record<string, Place[]>
): Selection[] {
  const cheap = /cheap|budget/i.test(parsed.budget ?? "");
  const constraints = (parsed.constraints ?? []).filter(
    (c) => typeof c === "string" && c.trim() !== ""
  );
  const out: Selection[] = [];
  // mirror the REAL selectVenues contract: empty-pool categories are
  // answered without the LLM and appended LAST — the recovery flow's
  // ordering behavior depends on this shape, so the fixture must not
  // quietly keep them in place
  const empties: Selection[] = [];
  for (const [category, places] of Object.entries(poolsIn)) {
    if (category.startsWith("_") || !Array.isArray(places)) continue;
    if (places.length === 0) {
      empties.push({ category, id: null, reason: "no venues survived filtering" });
      continue;
    }
    let pool = places;
    if (constraints.length > 0) {
      const unmet = constraints.find((c) => !places.some((p) => meetsConstraint(p, c)));
      if (unmet) {
        out.push({
          category,
          id: null,
          reason: `no ${category} candidate actually meets "${unmet}"`,
          unmetConstraint: unmet,
        });
        continue;
      }
      pool = places.filter((p) => constraints.every((c) => meetsConstraint(p, c)));
    }
    const ranked = [...pool].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    const pick = cheap
      ? ranked.find(
          (v) =>
            v.priceLevel !== "PRICE_LEVEL_EXPENSIVE" &&
            v.priceLevel !== "PRICE_LEVEL_VERY_EXPENSIVE"
        ) ?? ranked[0]
      : ranked[0];
    out.push({
      category,
      id: pick.id,
      reason: `A reliable ${category} spot that suits the evening.`,
      name: pick.displayName?.text,
      rating: pick.rating,
      priceLevel: pick.priceLevel,
      description: pick.editorialSummary?.text,
    });
  }
  return [...out, ...empties];
}

// ── travel: distance-derived, deterministic. Short hops walk; the
// cross-town home leg comes out transit with a named fixture line. ──
function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.latitude * Math.PI) / 180) *
      Math.cos((b.latitude * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function mockLeg(
  fromIndex: number,
  from: LatLng,
  to: LatLng,
  excludeTransit = false
): TravelLeg {
  const km = haversineKm(from, to);
  const distanceMeters = Math.round(km * 1000);
  const walkMin = Math.max(3, Math.round(km * 13));
  if (excludeTransit || km < 1.0) {
    return {
      fromIndex,
      mode: "walk",
      rawMinutes: walkMin,
      marginMinutes: 0,
      totalMinutes: walkMin,
      distanceMeters,
      encodedPolyline: null,
    };
  }
  const raw = Math.max(8, Math.round(km * 4));
  return {
    fromIndex,
    mode: "transit",
    rawMinutes: raw,
    marginMinutes: 5,
    totalMinutes: raw + 5,
    distanceMeters,
    encodedPolyline: null,
    transit: {
      lineName: "505 Fixture",
      headsign: "Mockbound",
      stopCount: Math.max(2, Math.round(km * 3)),
      departStop: "Fixture St at Mock Ave",
      arriveStop: "Ossington Stand-In",
    },
  };
}

export function mockTravelLegs(points: LatLng[]): TravelLeg[] {
  if (points.length < 2) return [];
  return points.slice(0, -1).map((from, i) => mockLeg(i, from, points[i + 1]));
}

// ── geocode: deterministic — every query resolves to the classic fixture
// home (Chestnut Residence coords) so mock travel legs and the home card
// stay byte-stable regardless of what city/address a scenario types. ──
export function mockGeocode(query: string): {
  label: string;
  location: { latitude: number; longitude: number };
  timeZone: string;
} {
  // fixed Chestnut coords → America/Toronto, keeping mock plans on one
  // deterministic zone (byte-stable legs + Toronto-rendered labels)
  return {
    label: `${query} (fixture)`,
    location: { latitude: 43.6547, longitude: -79.3862 },
    timeZone: "America/Toronto",
  };
}

// ── weather: 48 calm hours from now, EXCEPT a fixed daily rain window at
// 3 PM local (precip 80) — the deterministic trigger for the weather gate
// and the all-pools-empty net: plan an outdoor category "at 3pm" and it
// blocks, today or rolled to tomorrow. Every other hour stays calm. ──
export const MOCK_RAIN_HOUR = 15;
export function mockWeather(): WeatherHour[] {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  return Array.from({ length: 48 }, (_, i) => {
    const d = new Date(start.getTime() + i * 3_600_000);
    const rain = d.getHours() === MOCK_RAIN_HOUR;
    return {
      hourISO: d.toISOString(),
      tempC: 20,
      precipProbability: rain ? 80 : 10,
      condition: rain ? "Rain" : "Clear",
    };
  });
}

// ── availability seam, mock flavor: stored stops carry no hours, so look
// the venue up in the fixture registry by id (exactly what a real
// availability API would do). Unknown id → keep-on-missing. ──
function fixtureHoursById(id: string): CurrentOpeningHours | undefined {
  const all = [
    ...DINNER,
    ...BAR,
    ...DESSERT,
    ...Array.from(genericCache.values()).flat(),
  ];
  return all.find((v) => v.id === id)?.currentOpeningHours;
}

// Only the LOOKUP is mock-specific — the openness logic itself delegates to
// the shared zone-aware helper. Reimplementing it here meant the fixture
// reproduced production's server-local-clock bug faithfully, so mock e2e
// could never fail on it (code-audit 2026-07-18 §1.3).
export function mockIsUsableAt(
  place: Place,
  when: Date,
  _category?: string,
  timeZone?: string
): boolean {
  const hours = place.currentOpeningHours ?? fixtureHoursById(place.id);
  return isOpenAtInstant(hours, when, timeZone) !== false;
}

// ── engine deps. The deterministic time/duration parsers are injected by
// swap.ts (they live there; injecting avoids a runtime import cycle). ──
export function mockSwapDeps(
  parseTime: (s: string) => TimeShift | null,
  parseDuration: (s: string) => DurationShift | null
): SwapDeps {
  return {
    interpret: async (parsed, category, _startISO, refinement) => {
      const duration = parseDuration(refinement);
      const time = parseTime(refinement);
      const constraintish = /patio|outdoor|rooftop|terrace|near /i.test(refinement);
      const cheap = /cheap|budget/i.test(refinement);
      // same routing as the real interpret: both halves ("start at 6pm for
      // 2 hours") go to time, which applies the duration alongside
      const intent: SwapIntent = time
        ? "time"
        : duration
        ? "duration"
        : constraintish
        ? "constraint"
        : "venue";
      return {
        intent,
        path: constraintish ? "research" : "refilter",
        category,
        aesthetic: parsed.aesthetic,
        budget: cheap ? "cheap" : parsed.budget,
        constraints: constraintish
          ? [...(parsed.constraints ?? []), refinement.trim()]
          : parsed.constraints ?? [],
        time: intent === "time" ? time : null,
        duration: intent === "duration" || intent === "time" ? duration : null,
      };
    },
    searchPools: async (_parsed, categories) => mockPools(categories),
    selectVenues: async (parsed, pools) => mockSelect(parsed, pools),
    getSingleLeg: async (origin, destination, fromIndex, _departureTime, excludeTransit) =>
      mockLeg(fromIndex, origin, destination, excludeTransit),
    isUsableAt: mockIsUsableAt,
  };
}

export function mockRerouteDeps(): RerouteDeps {
  return {
    searchPools: async (_parsed, categories) => mockPools(categories),
    selectVenues: async (parsed, pools) => mockSelect(parsed, pools),
    getSingleLeg: async (origin, destination, fromIndex, _departureTime, excludeTransit) =>
      mockLeg(fromIndex, origin, destination, excludeTransit),
  };
}
