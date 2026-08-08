// E2E fixture layer — deterministic stand-ins for the live APIs, active
// only when the server runs with E2E_MOCK=1. A SEAM, not a rewrite: the
// objective filter, scheduling, floor guards, and resettle ladder all run
// for real; only the DATA SOURCES (Groq parse/select/interpret, Places
// search, Geocoding results, Routes legs, Weather) are swapped — same discipline as
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
import type { GeocodeRequest } from "../geocode/geocode";
// only the hours TYPE is needed now — the fixture layer no longer does any
// openness reasoning of its own (see the availability-seam note below)
import type { CurrentOpeningHours } from "../places/search/hours";
import type { LatLng, TravelLeg } from "../schedule/travel";
import type { Selection, SelectModelCall } from "../select/selectVenues";
import { GENERAL_CATEGORY, isGeneralCategory } from "../places/search/searchPlaces";
import {
  instantAtWallClock,
  nextFullHourInZone,
  toZonedISO,
} from "../../lib/zoneTime";
import { parseBudget } from "../../lib/budget";
import {
  normalizeConstraints,
  placeMeetsAllConstraints,
} from "../../lib/constraints";
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

// ── the fixture pools (Ossington-strip coordinates). Hard constraints use
// explicit provider fields only: Noodle carries servesVegetarianFood and
// The Standing Room carries outdoorSeating below. Narrative descriptions
// remain display copy and never become factual evidence. ──
const DINNER: Place[] = [
  // top-rated but EXPENSIVE → the default pick; "cheaper" must beat it
  venue("fx_dinner_velvet", "Velvet Fig", 43.6491, -79.4203, 4.8, "PRICE_LEVEL_EXPENSIVE", 17, 23,
    "Dim-lit modern bistro known for fig-glazed duck and a serious wine list."),
  venue("fx_dinner_corner", "The Corner Table", 43.6478, -79.4194, 4.5, "PRICE_LEVEL_MODERATE", 17, 23,
    "Neighbourhood standby doing honest plates and warm service."),
  {
    ...venue(
      "fx_dinner_noodle",
      "Noodle Letterpress",
      43.6502,
      -79.4211,
      4.3,
      "PRICE_LEVEL_INEXPENSIVE",
      11,
      22,
      "Hand-pulled noodle counter with a deep vegan menu."
    ),
    servesVegetarianFood: true,
  },
  // closes at 8 PM → late dinners drop it / adapt away from it
  venue("fx_dinner_early", "Early Bird Diner", 43.6468, -79.4186, 4.1, "PRICE_LEVEL_INEXPENSIVE", 8, 20,
    "Sunny all-day diner that packs it in early."),
  // SAME TIER as Velvet Fig ($$$) and nothing else about it is special. It
  // exists so a "fancier" swap off Velvet Fig has a same-price sibling to
  // wrongly return — without one, a price-direction bug is invisible to e2e
  // because the pool simply runs out. Deliberately the LOWEST-rated dinner
  // fixture and on Velvet Fig's own 17–23 hours, so it can never displace a
  // pick another spec pins (rating sorts put it last; the 3 PM recovery
  // scenario still sees it closed).
  venue("fx_dinner_brass", "Brass and Bone", 43.6483, -79.4198, 4.0, "PRICE_LEVEL_EXPENSIVE", 17, 23,
    "Chophouse with a long marble bar and a longer wine list."),
];
const BAR: Place[] = [
  // top-rated but closes 10 PM → pushing drinks later fires the adapt path
  venue("fx_bar_curfew", "Ten O'Clock Curfew", 43.6485, -79.4199, 4.7, "PRICE_LEVEL_EXPENSIVE", 16, 22,
    "Cocktail room with strict hours and stricter pours."),
  {
    ...venue(
      "fx_bar_standing",
      "The Standing Room",
      43.6495,
      -79.4207,
      4.6,
      "PRICE_LEVEL_MODERATE",
      17,
      2,
      "Snug standing bar with a lantern-lit patio out back."
    ),
    outdoorSeating: true,
  },
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

// Per-slot recovery fixtures:
// - the gallery is closed at a 7 PM plan anchor but open at the second
//   slot's provisional 8:45 PM arrival (dinner = 90 + 15 minutes)
// - the tiny-bar category deliberately has only one candidate, so asking
//   for it twice proves recovery never reuses an occupied venue id
const LATE_GALLERY: Place[] = [
  venue(
    "fx_late_gallery",
    "After Eight Gallery",
    43.6508,
    -79.4184,
    4.7,
    "PRICE_LEVEL_MODERATE",
    20,
    23,
    "A small evening gallery whose doors open at eight."
  ),
];
const TINY_BAR: Place[] = [
  venue(
    "fx_tiny_bar_only",
    "The One-Seat Bar",
    43.6484,
    -79.4196,
    4.8,
    "PRICE_LEVEL_MODERATE",
    17,
    2,
    "A single-room bar used to exercise a genuinely narrowed second slot."
  ),
];
// THE PUSH trigger. Every other fixture sits within a few hundred metres of
// the rest of the strip, so their legs are three-minute walks and a swap
// always fits the gap the schedule already left. This one is ~12 km east,
// which `mockLeg` turns into a ~53-minute transit ride — far longer than that
// gap — so swapping into it is the deterministic way to reach "the
// replacement can't be reached at its committed start", which now pushes the
// later stops back instead of refusing.
//
// It lives behind its OWN category, like `tiny bar` and `late gallery`, so it
// can never enter the BAR pool and displace the picks other specs pin.
// Open 16:00–02:00 on purpose: the pushed arrival must never be what fails,
// or the test would be proving the closing-time refusal instead.
const RIVERSIDE_BAR: Place[] = [
  venue(
    "fx_bar_riverside",
    "Riverside Long Bar",
    43.6491,
    -79.2716,
    4.6,
    "PRICE_LEVEL_MODERATE",
    16,
    2,
    "A long bar clear across the city — getting there is most of the trip."
  ),
];

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
  if (/\blate gallery\b/i.test(category)) return LATE_GALLERY;
  if (/\btiny bar\b/i.test(category)) return TINY_BAR;
  if (/\briverside bar\b/i.test(category)) return RIVERSIDE_BAR;
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
  return Object.fromEntries(
    cats.map((c) => [
      c,
      // production expands the NAMED general category into the same broad
      // union the categoryless path uses; the fixture mirrors that by
      // serving the "general" pool for it, so a vague plan keeps its
      // recognizable Fixture General venues
      isGeneralCategory(c) ? genericPool("general") : poolFor(c, hasNeighbourhood),
    ])
  );
}

// ── planner: keyword scan → the PLANNER contract, deterministic. The
// fixture stands in for the MODEL only; the response it returns still goes
// through the production validator (findPlanProblems → coerce → floors) in
// the parse route, exactly like a live Groq answer would. Nothing
// recognized → one general activity plus the broad questions, which is what
// the real planner returns for a vague prompt.
//
// It also has to carry the JUDGMENT the retired rule tables used to make —
// which activities are too generic to search well, and what hour an
// unstated "dinner" implies. Those judgments are the model's job now, so
// they live in the fixture model, never back in production code.

/** Which searchQueries are still too vague, and the question that pins each
 *  down. Lifted from the retired clarify.ts GENERIC_RULES: same product
 *  behaviour, now sourced from the "model" rather than a code table. */
const MOCK_VAGUE_RULES: Array<{
  id: string;
  generic: RegExp;
  specific: RegExp;
  question: string;
  options: string[];
  /** how the answer folds back: a cuisine MODIFIES ("Italian" + "dinner"),
   *  an activity/venue type REPLACES ("cocktail bar") */
  mode: "prefix" | "replace";
}> = [
  {
    id: "food-type",
    generic: /^(restaurants?|dinner|lunch|food|meal)$/i,
    specific:
      /italian|japanese|mexican|chinese|thai|indian|korean|vietnamese|french|greek|mediterranean|american|bbq|barbecue|seafood|sushi|ramen|pizza|taco|burger|noodle|pho|steak|dumpling|shawarma|curry|pasta|izakaya|brunch|breakfast|fast food|vegan|vegetarian/i,
    question: "What are you craving?",
    options: [
      "Italian", "Japanese", "Mexican", "Chinese", "Thai", "Indian", "Mediterranean", "BBQ",
    ],
    mode: "prefix",
  },
  {
    id: "kind",
    generic: /^(things to do|something to do|entertainment|activity|activities)$/i,
    specific:
      /arcade|bowling|mini ?golf|escape room|movie|cinema|museum|galler|comedy|live music|karaoke|axe|climbing|skating/i,
    question: "What kind of thing?",
    options: ["food", "drinks", "something to do", "outdoors"],
    mode: "replace",
  },
  {
    id: "bar-type",
    generic: /^(bars?|drinks?)$/i,
    specific: /cocktail|sports bar|dive|wine|brewery|rooftop|speakeasy|pub|club|izakaya/i,
    question: "What kind of bar?",
    options: [
      "cocktail bar", "sports bar", "dive bar", "wine bar", "brewery", "rooftop bar",
    ],
    mode: "replace",
  },
];

/** "food" / "drinks" / "outdoors" → a searchable place kind, the same map
 *  the retired categoriesForKindAnswer used. Free text passes through. */
function mockKindAnswer(answer: string): string {
  const a = answer.trim().toLowerCase();
  if (a === "food") return "restaurant";
  if (a === "drinks") return "bar";
  if (a === "outdoors") return "park";
  if (a === "something to do") return GENERAL_CATEGORY;
  return answer.trim();
}

/** Rough dwell per activity — the fixture model's estimate, not a lookup
 *  the scheduler owns. Production clamps whatever comes back to 15-360.
 *
 *  These values deliberately EQUAL DURATION_TABLE's base minutes for every
 *  fixture category. The mock's job is to prove the plumbing (estimate →
 *  selector refinement → stop → schedule), not the arithmetic, and every
 *  arrival-sensitive e2e scenario — the per-slot recovery targeting, the
 *  weather-at-that-slot check, the closes-before-you-arrive adapt — pins
 *  exact clock times that would all shift for no product reason if the
 *  fixture disagreed with the table. That an estimate DIFFERENT from the
 *  table really moves the schedule is pinned in schedule.test.ts, and the
 *  refinement/clamp/fallback ladder in select.test.ts. */
const MOCK_MINUTES: Array<[RegExp, number]> = [
  [/coffee|caf[eé]/i, 50],
  [/dessert|ice ?cream|gelato|bao/i, 30],
  [/park|walk|beach|garden/i, 40],
  [/galler|museum/i, 105],
  [/bar|drink|pub|cocktail/i, 60],
  [/dinner|restaurant|sushi|ramen|dumpling|steak|brunch|lunch|food/i, 90],
];
function mockMinutes(query: string): number {
  return MOCK_MINUTES.find(([pattern]) => pattern.test(query))?.[1] ?? 60;
}

/** The hour an activity IMPLIES when the user stated no time. This is the
 *  semantic judgment CATEGORY_START_DEFAULTS used to hardcode in the
 *  scheduler — the planner makes it now, so the fixture makes it here.
 *  Earliest implied hour across the activities wins, like the old anchor. */
const MOCK_IMPLIED_HOUR: Array<[RegExp, { hour: number; minute: number }]> = [
  [/breakfast/i, { hour: 9, minute: 0 }],
  [/brunch/i, { hour: 10, minute: 30 }],
  [/coffee|caf[eé]/i, { hour: 10, minute: 0 }],
  [/lunch/i, { hour: 12, minute: 0 }],
  [/park|walk|beach|garden/i, { hour: 14, minute: 0 }],
  [/galler|museum/i, { hour: 14, minute: 0 }],
  [/dessert/i, { hour: 20, minute: 0 }],
  [/bar|drink|pub|cocktail/i, { hour: 20, minute: 0 }],
  [/dinner|restaurant|sushi|ramen|dumpling|steak|food|eat/i, { hour: 19, minute: 0 }],
];
function mockImpliedTime(queries: string[]): { hour: number; minute: number } | null {
  let best: { hour: number; minute: number } | null = null;
  for (const query of queries) {
    const hit = MOCK_IMPLIED_HOUR.find(([pattern]) => pattern.test(query))?.[1];
    if (!hit) continue;
    if (!best || hit.hour * 60 + hit.minute < best.hour * 60 + best.minute) best = hit;
  }
  return best;
}

interface MockTime {
  startISO: string | null;
  endISO: string | null;
  kind: "explicit" | "relative" | "unspecified";
  label: string;
}

/** Clock-time resolution for the fixture model. Meridiem wins; a bare hour
 *  reads as afternoon/evening on an outing planner (1-11 → +12), the same
 *  convention the swap engine's parseTimeExpr uses. */
function mockClock(hour: number, minute: number, ap: string | undefined): { hour: number; minute: number } {
  let h = hour;
  if (ap === "pm" && h < 12) h += 12;
  else if (ap === "am" && h === 12) h = 0;
  else if (!ap && h >= 1 && h <= 11) h += 12;
  return { hour: h % 24, minute };
}

function mockTime(p: string, queries: string[], now: Date, timeZone: string): MockTime {
  const dayOffset = /\btomorrow\b/.test(p) ? 1 : 0;
  const at = (hour: number, minute: number, roll: boolean) =>
    toZonedISO(instantAtWallClock(now, timeZone, hour, minute, dayOffset, roll), timeZone);

  // a stated RANGE ("3-8pm", "from 3 to 8") — start and end together
  const range = p.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/
  );
  if (range) {
    const endAp = range[6];
    // "3-8pm": the trailing meridiem governs both ends
    const start = mockClock(Number(range[1]), Number(range[2] ?? 0), range[3] ?? endAp);
    const end = mockClock(Number(range[4]), Number(range[5] ?? 0), endAp);
    // A range rolls as ONE unit. Rolling each end independently is what a
    // per-instant `rollForward` does, and at 5:30 PM it turns "5-9pm" into
    // start=tomorrow 17:00 / end=today 21:00 — an inverted window the
    // validator rightly rejects, dropping the plan to the fallback. Which
    // day the window belongs to is decided ONCE, by its end: a window whose
    // end has passed is tomorrow's; one already underway is still today's.
    const rolls =
      dayOffset === 0 &&
      instantAtWallClock(now, timeZone, end.hour, end.minute, 0).getTime() <= now.getTime();
    const offset = dayOffset + (rolls ? 1 : 0);
    return {
      startISO: toZonedISO(
        instantAtWallClock(now, timeZone, start.hour, start.minute, offset),
        timeZone
      ),
      endISO: toZonedISO(
        instantAtWallClock(now, timeZone, end.hour, end.minute, offset),
        timeZone
      ),
      kind: "explicit",
      label: range[0],
    };
  }

  const clock = p.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (clock) {
    const t = mockClock(Number(clock[1]), Number(clock[2] ?? 0), clock[3]);
    return {
      startISO: at(t.hour, t.minute, dayOffset === 0),
      endISO: null,
      kind: "explicit",
      label: clock[0].trim(),
    };
  }
  if (/\bmidnight\b/.test(p)) {
    return { startISO: at(0, 0, true), endISO: null, kind: "relative", label: "midnight" };
  }

  const dayPart: Array<[RegExp, { hour: number; label: string }]> = [
    [/tonight/, { hour: 20, label: "tonight" }],
    [/evening/, { hour: 19, label: "evening" }],
    [/afternoon/, { hour: 14, label: "afternoon" }],
    [/morning/, { hour: 10, label: "morning" }],
    [/\bnight\b/, { hour: 20, label: "night" }],
  ];
  for (const [pattern, part] of dayPart) {
    if (pattern.test(p)) {
      return {
        startISO: at(part.hour, 0, dayOffset === 0),
        endISO: null,
        kind: "relative",
        label: dayOffset ? `tomorrow ${part.label}` : part.label,
      };
    }
  }

  // no stated time: the ACTIVITIES imply one ("dinner" means evening)
  const implied = mockImpliedTime(queries);
  if (implied) {
    return {
      startISO: at(implied.hour, implied.minute, dayOffset === 0),
      endISO: null,
      kind: "relative",
      label: dayOffset ? "tomorrow" : "unspecified",
    };
  }
  if (dayOffset === 1) {
    return { startISO: at(11, 0, false), endISO: null, kind: "relative", label: "tomorrow" };
  }
  return { startISO: null, endISO: null, kind: "unspecified", label: "unspecified" };
}

export interface MockPlannerAnswer {
  question: string;
  answer: string;
}

export function mockPlan(
  prompt: string,
  now: Date,
  timeZone: string,
  answers: MockPlannerAnswer[] = []
): Record<string, unknown> {
  const p = prompt.toLowerCase();
  // Deliberate malformed-output trigger: proves the production retry and
  // deterministic fallback in mock e2e without a live model.
  if (/fixture-badplan/.test(p)) return { activities: "not an array" };
  const signals: string[] = [];
  if (/brunch/.test(p)) signals.push("brunch");
  if (/steak/.test(p)) signals.push("steakhouse");
  // dumplings/bao are their own categories (the partial-failure recovery
  // fixtures); kept BEFORE the broad dinner rule so they aren't swallowed
  if (/dumpling/.test(p)) signals.push("dumplings");
  if (/\bbao\b/.test(p)) signals.push("bao");
  // specific dishes stay their OWN category — mirrors the real parse
  // contract ("ramen stays ramen, never generalized to restaurant"), which
  // the generic-category clarify axis depends on: "sushi tonight" must not
  // be re-asked what cuisine it is
  if (/\bsushi\b/.test(p)) signals.push("sushi");
  else if (/\bramen\b/.test(p)) signals.push("ramen");
  else if (/dinner|restaurant|food|eat/.test(p)) signals.push("dinner");
  if (/\blate gallery\b/.test(p)) signals.push("late gallery");
  const tinyBar = /\btiny bar\b/.test(p);
  if (tinyBar) {
    signals.push("tiny bar");
    if (/another tiny bar|two tiny bars|second tiny bar/.test(p)) {
      signals.push("tiny bar");
    }
  } else {
    if (/drink|bar|cocktail|pub/.test(p)) signals.push("drinks");
    // A SECOND stop of the same kind — "drinks then another bar" is two
    // stops, not one. The deterministic duplicate-category trigger (§7.1):
    // both slots share the BAR pool and must still get different venues.
    if (/another (?:bar|drink|round)|two bars|bar hop|second bar/.test(p)) {
      signals.push("drinks");
    }
  }
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

  // A stated COUNT wins: the planner emits exactly that many activities,
  // repeating the stated kind or falling back to the general one. There is
  // no stop_count on the wire any more — the activity LIST is the answer.
  const countWords: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  };
  const countMatch = p.match(
    /\b(one|two|three|four|five|six|seven|eight|\d+)\s+(?:stops?|places?|activit(?:y|ies)|things?|coffee shops?|caf[eé]s?|bars?)\b/
  );
  const stated = countMatch ? countWords[countMatch[1]] ?? Number(countMatch[1]) : null;
  const count = stated && stated >= 1 && stated <= 8 ? stated : null;

  let queries = signals.length > 0 ? signals : [GENERAL_CATEGORY];
  if (count) {
    // repeat the single stated kind, or pad the general one out to the count
    queries =
      queries.length === count
        ? queries
        : Array.from({ length: count }, (_, i) => queries[Math.min(i, queries.length - 1)]);
  }

  const constraints: string[] = [];
  if (/patio/.test(p)) constraints.push("patio");
  if (/vegan/.test(p)) constraints.push("vegan");
  if (/vegetarian/.test(p)) constraints.push("vegetarian");
  if (/wheelchair|accessible/.test(p)) constraints.push("wheelchair accessible");
  if (/live music/.test(p)) constraints.push("live music");

  const numericBudget = p.match(
    /\b(?:under|below|less than|up to|max(?:imum)?)\s*(?:us\$|ca\$|c\$|\$|€|£|¥|usd|cad|eur|gbp|jpy)?\s*\d+(?:\.\d{1,2})?(?:\s*(?:usd|cad|eur|gbp|jpy))?\b/i
  );
  const symbolicBudget = p.match(/(?:^|\s)(\${1,2})(?:\s|$)/);
  const budget =
    numericBudget?.[0] ??
    symbolicBudget?.[1] ??
    (/\b(?:cheap|budget)\b/.test(p) ? "cheap" : null);
  let aesthetic = /fancy|upscale|fine dining/.test(p) ? "fancy" : "unspecified";

  // ── which activities are still too vague, and the one question each ──
  const vagueRuleFor = (query: string) =>
    MOCK_VAGUE_RULES.find(
      (rule) =>
        rule.generic.test(query.trim()) &&
        !rule.specific.test(`${query} ${constraints.join(" ")}`)
    ) ?? null;

  let time = mockTime(p, queries, now, timeZone);

  // ── fold the answers in (the SECOND planner pass) ──
  // One answer resolves every slot sharing that searchQuery — the same rule
  // the validator uses for question coverage.
  for (const { question, answer } of answers) {
    const text = (answer ?? "").trim();
    if (!text) continue;
    if (question === "When?") {
      const a = text.toLowerCase();
      const resolved =
        a === "now"
          ? { hour: -1, minute: 0 }
          : a === "this afternoon"
          ? { hour: 14, minute: 0 }
          : a === "this evening"
          ? { hour: 19, minute: 0 }
          : null;
      time = resolved
        ? resolved.hour < 0
          ? {
              startISO: toZonedISO(nextFullHourInZone(now, timeZone), timeZone),
              endISO: null,
              kind: "relative",
              label: "now",
            }
          : {
              startISO: toZonedISO(
                instantAtWallClock(now, timeZone, resolved.hour, resolved.minute, 0, true),
                timeZone
              ),
              endISO: null,
              kind: "relative",
              label: a,
            }
        : mockTime(text.toLowerCase(), queries, now, timeZone);
      continue;
    }
    if (/vibe/i.test(question)) {
      aesthetic = text;
      continue;
    }
    const rule = MOCK_VAGUE_RULES.find((r) => r.question === question);
    if (!rule) continue;
    queries = queries.map((query) =>
      vagueRuleFor(query)?.id === rule.id
        ? rule.mode === "prefix"
          ? `${text} ${query}`
          : rule.id === "kind"
          ? mockKindAnswer(text)
          : text
        : query
    );
    // an answered time-implied activity can move the anchor ("food" → 7 PM)
    if (time.kind === "unspecified") time = mockTime(p, queries, now, timeZone);
  }

  const activities = queries.map((query, slot) => ({
    slot,
    intent: query,
    searchQuery: query,
    estimatedMinutes: mockMinutes(query),
    // ONE round: on the second pass the plan is final, so nothing is left
    // "unconfident" even if the answer landed on a still-broad kind
    // ("drinks" → "bar"). Re-asking would be a second round.
    confident: answers.length > 0 || vagueRuleFor(query) === null,
  }));

  const questions: Array<Record<string, unknown>> = [];
  if (answers.length === 0) {
    const asked = new Set<string>();
    activities.forEach((activity) => {
      const rule = vagueRuleFor(activity.searchQuery);
      if (!rule || asked.has(rule.id)) return;
      asked.add(rule.id);
      questions.push({
        id: rule.id,
        question: rule.question,
        options: rule.options,
        appliesToSlot: activity.slot,
      });
    });
    if (time.kind === "unspecified") {
      questions.push({
        id: "when",
        question: "When?",
        options: ["now", "this afternoon", "this evening", "pick a time"],
        appliesToSlot: null,
      });
    }
    // the vibe question rides along ONLY when something else is already
    // being asked — a fully specified request gets no questions at all
    if (questions.length > 0 && aesthetic === "unspecified" && constraints.length === 0) {
      questions.push({
        id: "vibe",
        question: "What kind of vibe are you going for?",
        options: ["cozy", "lively", "quiet"],
        appliesToSlot: null,
      });
    }
  }

  return {
    activities,
    timeIntent: time,
    questions,
    context: {
      aesthetic,
      groupContext: "unspecified",
      budget,
      constraints,
      location: "Ossington",
    },
  };
}

interface MockModelCandidate {
  id: string;
  rating: number | null;
  price: string | null;
  constraintEvidence: string[];
}

function mockSelectionPayload(messages: unknown[]): Record<string, unknown> {
  for (const message of messages) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      !("content" in message) ||
      message.role !== "user" ||
      typeof message.content !== "string"
    ) {
      continue;
    }
    try {
      const parsed = JSON.parse(message.content);
      if (typeof parsed === "object" && parsed !== null && "slots" in parsed) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Correction prompts are plain text. The original JSON user payload
      // remains earlier in the same message list.
    }
  }
  return {};
}

/** Deterministic stand-in for the Groq completion only. The production
 * selectVenues core still owns slot validation, correction, constraint
 * enforcement, global uniqueness, and fallback assignment in mock E2E. */
export const mockSelectModelResponse: SelectModelCall = async (messages) => {
  const payload = mockSelectionPayload(messages);
  const request =
    typeof payload.request === "object" && payload.request !== null
      ? (payload.request as Record<string, unknown>)
      : {};
  const constraints = Array.isArray(request.constraints)
    ? request.constraints.filter((value): value is string => typeof value === "string")
    : [];
  const budget =
    typeof request.budget === "object" && request.budget !== null
      ? (request.budget as Record<string, unknown>)
      : null;
  const cheap =
    budget?.kind === "relative" ||
    (budget?.kind === "places-level" &&
      typeof budget.maxLevel === "number" &&
      budget.maxLevel <= 2);
  const candidatePools =
    typeof payload.candidates === "object" && payload.candidates !== null
      ? (payload.candidates as Record<string, unknown>)
      : {};
  const slots = Array.isArray(payload.slots) ? payload.slots : [];

  const selections: Array<{
    slot: number;
    category: string;
    id: string | null;
    reason: string;
    unmet_constraint: string | null;
    minutes?: number;
  }> = [];
  for (const value of slots) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("slot" in value) ||
      !("category" in value) ||
      typeof value.slot !== "number" ||
      typeof value.category !== "string"
    ) {
      continue;
    }
    const rawCandidates = candidatePools[value.category];
    const candidates = (Array.isArray(rawCandidates) ? rawCandidates : [])
      .filter(
        (candidate): candidate is MockModelCandidate =>
          typeof candidate === "object" &&
          candidate !== null &&
          "id" in candidate &&
          typeof candidate.id === "string" &&
          "constraintEvidence" in candidate &&
          Array.isArray(candidate.constraintEvidence)
      )
      .filter((candidate) =>
        constraints.every((constraint) =>
          candidate.constraintEvidence.includes(constraint)
        )
      )
      .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
    const pick = cheap
      ? candidates.find(
          (candidate) =>
            candidate.price !== "PRICE_LEVEL_EXPENSIVE" &&
            candidate.price !== "PRICE_LEVEL_VERY_EXPENSIVE"
        ) ?? candidates[0]
      : candidates[0];
    if (!pick) {
      selections.push({
        slot: value.slot,
        category: value.category,
        id: null,
        reason: "No candidate carries all requested evidence.",
        unmet_constraint: constraints[0] ?? null,
      });
      continue;
    }
    // The DURATION REFINEMENT, mirrored: the fixture "model" echoes the
    // planner's pre-venue estimate back unchanged, which is the honest
    // no-adjustment-needed answer and keeps mock schedules byte-stable.
    // Production clamps whatever comes back to 15-360 either way.
    const estimatedMinutes =
      "estimatedMinutes" in value && typeof value.estimatedMinutes === "number"
        ? value.estimatedMinutes
        : undefined;
    selections.push({
      slot: value.slot,
      category: value.category,
      id: pick.id,
      reason: `A reliable ${value.category} spot that suits the outing.`,
      unmet_constraint: null,
      ...(estimatedMinutes !== undefined ? { minutes: estimatedMinutes } : {}),
    });
  }
  return JSON.stringify({ selections });
};

// ── engine select fixture: highest-rated wins; a stated cheap budget prefers non-$$$.
// Hard constraints mirror the real contract: only deterministic candidate
// evidence counts; none do → id:null +
// unmetConstraint, never a hedged pick. ──
export function mockSelect(
  parsed: ParsedPrompt,
  poolsIn: Record<string, Place[]>,
  slotsIn?: string[]
): Selection[] {
  const budget = parseBudget(parsed.budget);
  const cheap =
    budget?.kind === "relative" ||
    (budget?.kind === "places-level" && budget.maxLevel <= 2);
  const constraints = normalizeConstraints(parsed.constraints);
  const out: Selection[] = [];
  // mirror the REAL selectVenues contract: empty-pool categories are
  // answered without the LLM and appended LAST — the recovery flow's
  // ordering behavior depends on this shape, so the fixture must not
  // quietly keep them in place
  const empties: Selection[] = [];
  // ...and mirror the SLOT contract too: one entry per REQUESTED stop, with
  // repeated categories getting DIFFERENT venues. A fixture that collapsed
  // duplicates would make mock e2e agree with the very bug §7.1 fixes.
  const slots = (slotsIn ?? Object.keys(poolsIn)).filter(
    (c) => typeof c === "string" && c.trim() !== "" && !c.startsWith("_")
  );
  const taken = new Set<string>();
  slots.forEach((category, slot) => {
    const places = poolsIn[category];
    if (!Array.isArray(places) || places.length === 0) {
      empties.push({ category, slot, id: null, reason: "no venues survived filtering" });
      return;
    }
    let pool = places;
    if (constraints.length > 0) {
      const unmet = constraints.find(
        (constraint) =>
          !places.some((place) =>
            placeMeetsAllConstraints(place, [constraint])
          )
      );
      if (unmet) {
        out.push({
          category,
          slot,
          id: null,
          reason: `no ${category} candidate actually meets "${unmet}"`,
          unmetConstraint: unmet,
        });
        return;
      }
      pool = places.filter((place) =>
        placeMeetsAllConstraints(place, constraints)
      );
    }
    const ranked = [...pool]
      .filter((p) => !taken.has(p.id))
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    const pick = cheap
      ? ranked.find(
          (v) =>
            v.priceLevel !== "PRICE_LEVEL_EXPENSIVE" &&
            v.priceLevel !== "PRICE_LEVEL_VERY_EXPENSIVE"
        ) ?? ranked[0]
      : ranked[0];
    if (!pick) {
      // fewer distinct venues than requested stops — narrowed, not dropped
      out.push({
        category,
        slot,
        id: null,
        narrowed: true,
        reason: `only found ${taken.size === 1 ? "one" : String(taken.size)} ${category} nearby`,
      });
      return;
    }
    taken.add(pick.id);
    out.push({
      category,
      slot,
      id: pick.id,
      reason: `A reliable ${category} spot that suits the evening.`,
      name: pick.displayName?.text,
      rating: pick.rating,
      priceLevel: pick.priceLevel,
      description: pick.editorialSummary?.text,
      // hours travel with the pick, exactly as the real selectVenues does —
      // a fixture that withheld them would leave mock stops hours-less and
      // keep the production gap invisible all over again
      currentOpeningHours: pick.currentOpeningHours,
    });
  });
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
  // one ride, mirrored into transitSegments exactly as the real
  // extraction does (transit === transitSegments[0]) — the fixture layer
  // supplies DATA, the bubble grouping is LOGIC and runs for real
  const ride = {
    lineName: "505 Fixture",
    shortName: "505",
    color: "#DA291C",
    textColor: "#FFFFFF",
    vehicle: "TRAM",
    headsign: "Mockbound",
    stopCount: Math.max(2, Math.round(km * 3)),
    departStop: "Fixture St at Mock Ave",
    arriveStop: "Ossington Stand-In",
  };
  return {
    fromIndex,
    mode: "transit",
    rawMinutes: raw,
    marginMinutes: 5,
    totalMinutes: raw + 5,
    distanceMeters,
    encodedPolyline: null,
    transit: ride,
    transitSegments: [ride],
  };
}

export function mockTravelLegs(points: LatLng[]): TravelLeg[] {
  if (points.length < 2) return [];
  return points.slice(0, -1).map((from, i) => mockLeg(i, from, points[i + 1]));
}

/** Provider-shaped Geocoding API data. The route feeds this through the
 * same type/component/context validation as a live response; mock mode
 * replaces only the network data source. */
export function mockGeocodingResponse(request: GeocodeRequest): Record<string, unknown> {
  const locality =
    request.kind === "address"
      ? (request.cityContext?.locality ?? "Toronto")
      : request.query;
  const formattedAddress = `${request.query} (fixture)`;
  const addressComponents =
    request.kind === "address"
      ? [
          { long_name: "89", short_name: "89", types: ["street_number"] },
          { long_name: "Chestnut Street", short_name: "Chestnut St", types: ["route"] },
          { long_name: locality, short_name: locality, types: ["locality", "political"] },
          {
            long_name: request.cityContext?.administrativeArea ?? "Ontario",
            short_name: request.cityContext?.administrativeArea ?? "ON",
            types: ["administrative_area_level_1", "political"],
          },
          {
            long_name: request.cityContext?.country ?? "Canada",
            short_name: request.cityContext?.countryCode ?? "CA",
            types: ["country", "political"],
          },
        ]
      : [
          { long_name: locality, short_name: locality, types: ["locality", "political"] },
          {
            long_name: "Ontario",
            short_name: "ON",
            types: ["administrative_area_level_1", "political"],
          },
          { long_name: "Canada", short_name: "CA", types: ["country", "political"] },
        ];

  return {
    status: "OK",
    results: [
      {
        formatted_address: formattedAddress,
        place_id: `fixture-${request.kind}`,
        types: [request.kind === "city" ? "locality" : "street_address", "political"],
        address_components: addressComponents,
        geometry: {
          location: { lat: 43.6547, lng: -79.3862 },
          location_type: request.kind === "city" ? "APPROXIMATE" : "ROOFTOP",
          viewport: {
            southwest: { lat: 43.58, lng: -79.64 },
            northeast: { lat: 43.86, lng: -79.11 },
          },
        },
      },
    ],
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

// ── availability seam: NOTHING mock-specific left. There used to be a
// fixtureHoursById registry lookup here, because stored stops carried no
// opening hours and the mock had to patch them back in by id — which meant
// mock mode exercised an adapt path that production could never reach.
// Hours now travel ON the stop (like price/description/rating), so the
// fixture layer supplies DATA and the real `usableByHours` supplies the
// LOGIC: swap.ts injects it below, exactly as it injects the deterministic
// time/duration parsers. Verified dead before removal by making the lookup
// throw and running the full mock e2e suite: 38/38 still passed. ──

// ── engine deps. The deterministic time/duration parsers are injected by
// swap.ts (they live there; injecting avoids a runtime import cycle). ──
/**
 * Refinements that NAME a different kind of place, and the kind they name.
 *
 * This is the fixture standing in for the MODEL's judgment, the same way
 * MOCK_VAGUE_RULES stands in for the planner's: REFINE_SYSTEM asks the model
 * to set `category` when a complaint names a new kind, so the fixture does
 * exactly that. Plain dissatisfaction ("somewhere else", "cheaper") is
 * deliberately absent — those must stay same-category, and the e2e specs that
 * swap with them are the proof.
 */
const MOCK_CATEGORY_CHANGES: Array<[RegExp, string]> = [
  [/\bboard games?\b/i, "board game cafe"],
  [/\bcoffee instead\b/i, "coffee shop"],
  // the push trigger — a kind of bar that only exists across town. It
  // resolves to the same 70-minute `bar` duration as drinks, so the slot's
  // LENGTH is held and the only thing the scenario changes is when it starts.
  [/\briverside\b/i, "riverside bar"],
];

export function mockSwapDeps(
  parseTime: (s: string) => TimeShift | null,
  parseDuration: (s: string) => DurationShift | null,
  /** the REAL availability default from swap.ts — injected rather than
   *  re-implemented, so mock and production can no longer disagree about
   *  what "open then" means (injection, not import, avoids a cycle) */
  isUsableAt: SwapDeps["isUsableAt"]
): SwapDeps {
  return {
    interpret: async (parsed, category, _startISO, refinement) => {
      const duration = parseDuration(refinement);
      const time = parseTime(refinement);
      // A CATEGORY CHANGE, behind the same deterministic floors the real
      // interpret puts first: an arithmetic phrase is never a new kind.
      const newKind =
        !time && !duration
          ? MOCK_CATEGORY_CHANGES.find(([pattern]) => pattern.test(refinement))?.[1]
          : undefined;
      if (newKind) {
        // Deliberately the shape a real model has been SEEN to return, not the
        // tidy one REFINE_SYSTEM asks for, because that is what production has
        // to survive:
        //  - path "refilter", i.e. its classification disagreeing with its own
        //    answer. The engine must honour the ANSWER, or the change is
        //    silently discarded and this swap hands back another dinner.
        //  - the new kind ALSO leaked into `constraints`, which is what the
        //    prompt's constraint branch invites. A kind of place is unprovable
        //    from provider booleans, so unless the engine strips it,
        //    `mockSelect` — which runs the REAL placeMeetsAllConstraints —
        //    answers unmet_constraint and the swap refuses forever.
        // A fixture emitting the tidy shape would prove neither guarantee.
        return {
          intent: "venue",
          path: "refilter",
          category: newKind,
          aesthetic: parsed.aesthetic,
          budget: parsed.budget,
          constraints: [...(parsed.constraints ?? []), newKind],
          time: null,
          duration: null,
        };
      }
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
    isUsableAt,
    getWeather: async () => mockWeather(),
  };
}

export function mockRerouteDeps(): RerouteDeps {
  return {
    searchPools: async (_parsed, categories) => mockPools(categories),
    selectVenues: async (parsed, pools, slots) => mockSelect(parsed, pools, slots),
    getSingleLeg: async (origin, destination, fromIndex, _departureTime, excludeTransit) =>
      mockLeg(fromIndex, origin, destination, excludeTransit),
    getWeather: async () => mockWeather(),
  };
}
