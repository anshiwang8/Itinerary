// Per-stop swap — user-initiated and surgical. The user taps ONE
// upcoming stop and types a short complaint; the engine acts on the
// ACTUAL intent:
//   - VENUE ("don't like the food", "cheaper") → replace the venue in
//     the same slot (re-filter the pool, or re-search for it).
//   - TIME ("too late", "earlier", "after 8") → move the stop's slot,
//     re-check what's open at the new time, shift downstream if needed.
//   - CONSTRAINT ("with a patio", "somewhere near the water") → apply as
//     a new constraint and re-search the venue.
// Refusal ("nothing found") is the LAST resort — only when a genuine
// search comes back empty, with a specific reason, never as a substitute
// for acting on a time/constraint request.
//
// Distinct from reroute (external disruption → replans the whole tail).
// Same discipline: reuse the pipeline cores (searchPools / filterPools /
// selectVenues / schedule serialization), share floor_time with reroute,
// never fork.
import { Itinerary, ItineraryStop, withStatuses, floorTime, timedIndexes, rebuildLegs } from "./store";
import { filterPools, ParsedPrompt, Place, WeatherHour } from "../places/search/filter";
import { fetchWeatherHours } from "../weather/fetchWeather";
import { searchPools as realSearchPools } from "../places/search/searchPlaces";
import {
  selectVenues as realSelectVenues,
  selectModelCall,
  Selection,
} from "../select/selectVenues";
import { withModelFallback } from "../_shared/modelFallback";
import { getDuration } from "../schedule/durations";
import { toZonedISO } from "../schedule/schedule";
import { isParkLike } from "../../lib/categoryTraits";
import { normalizeConstraint } from "../../lib/constraints";
import {
  parsePriceDirection,
  priceDirectionSearchTerm,
  rankByPriceDirection,
} from "../../lib/budget";
import { DEFAULT_ZONE, instantAtWallClock, wallClockParts } from "../../lib/zoneTime";
import { isRecord, logEvent } from "../_shared/http";
import {
  ProviderError,
  fetchProvider,
  readProviderJson,
  requireProviderRecord,
} from "../_shared/provider";
import { isOpenAtInstant } from "../places/search/hours";
import {
  getSingleLeg as realGetSingleLeg,
  haversineMeters,
  LatLng,
  TravelLeg,
} from "../schedule/travel";
import { HOME, HOME_LEG_INDEX } from "../schedule/home";
import { isMockMode, mockSwapDeps } from "../_mock/fixtures";
import { fallbackParsedFor, UNKNOWN_LOCATION_MESSAGE } from "./fallbackParsed";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export type SwapIntent = "venue" | "time" | "constraint" | "duration";

// A parsed time request: relative ("an hour earlier" → -60) or absolute
// ("after 8" → 20:00). Vague amounts default to a 30-min step upstream.
export interface TimeShift {
  mode: "relative" | "absolute";
  deltaMinutes?: number; // relative
  targetTime?: string; // absolute, 24h "HH:MM"
  /** relative parsed from a vague phrase ("a bit earlier") — the model may
   * refine the amount (same sign, sane bounds); exact amounts never yield */
  vague?: boolean;
}

// A parsed duration request: relative ("stay longer" → +30) or absolute
// ("stay 2 hours" → 120). Vague amounts default to a 30-min step.
export interface DurationShift {
  mode: "relative" | "absolute";
  deltaMinutes?: number; // relative
  targetMinutes?: number; // absolute
}

// How the complaint reshapes this one stop.
export interface SwapInterpretation {
  intent: SwapIntent;
  // venue/constraint: refilter narrows the SAME pool (cheaper, higher-
  // rated); research needs venues the pool may not hold (a patio, a
  // different cuisine) → new Places search.
  path: "refilter" | "research";
  category: string;
  aesthetic: string;
  budget: string | null;
  constraints: string[];
  // time intent only.
  time: TimeShift | null;
  // duration intent only.
  duration: DurationShift | null;
}

interface Snap {
  name: string | null;
  start: string | null;
  end: string | null;
  category: string;
}

export type SwapResult =
  | { swapped: false; reason: string }
  | {
      swapped: true;
      stopIndex: number;
      path: "refilter" | "research" | "time" | "duration";
      before: Snap;
      after: Snap;
      reason: string;
      downstreamShifted: number[];
    };

// Injectable pipeline deps — the engine's guarantees are tested without
// network. Defaults hit the real modules with env keys.
export interface SwapDeps {
  interpret: (
    parsed: ParsedPrompt,
    category: string,
    currentStartISO: string,
    refinement: string
  ) => Promise<SwapInterpretation>;
  searchPools: (
    parsed: ParsedPrompt,
    categories: string[]
  ) => Promise<Record<string, Place[]>>;
  selectVenues: (
    parsed: ParsedPrompt,
    pools: Record<string, Place[]>
  ) => Promise<Selection[]>;
  getSingleLeg: (
    origin: LatLng,
    destination: LatLng,
    fromIndex: number,
    departureTime: string | undefined,
    excludeTransit: boolean
  ) => Promise<TravelLeg>;
  // Availability seam: the ONE place that answers "can we use this venue
  // at this time?" Default is the objective hours check (keep-on-missing);
  // a real reservation/availability API slots in here later without
  // touching the swap flow. `timeZone` is the PLAN's zone — the instant is
  // absolute, but "which hour / which weekday is that for this venue" is
  // not, so every caller passes it explicitly.
  isUsableAt: (
    place: Place,
    when: Date,
    category: string,
    timeZone: string
  ) => boolean;
  /** hourly forecast for the plan's origin — a swap consults the weather
   *  gate like the initial plan does (§7.6). Null = keep-on-missing. */
  getWeather: (lat: number, lng: number) => Promise<WeatherHour[] | null>;
}

// exported for the regression pin: the same-category guardrail below lives
// ONLY in this prompt, so a test asserts the prompt still carries it
export const REFINE_SYSTEM = `You adjust ONE stop of an existing day plan from a short complaint. You get the stop's current settings (category, aesthetic, budget, constraints) and its current start time, plus the complaint. Classify the user's INTENT and return the parameters to act on it.

"intent":
- "time": the complaint is about WHEN. Return a "time" object.
   - RELATIVE ("an hour earlier", "30 min later", "a bit earlier", "much later"): set { "mode": "relative", "deltaMinutes": N } where N is signed minutes (earlier is NEGATIVE, later is POSITIVE). Exact amounts parse exactly (an hour = 60, half an hour = 30, "45 min" = 45). Vague amounts ("a bit", "a little", "somewhat", "slightly") default to 30. "much"/"way" can be 60–90.
   - ABSOLUTE ("after 8", "at 7:30", "by 9", "make it 7"): set { "mode": "absolute", "targetTime": "HH:MM" } in 24h. Assume the plan's part of day (an evening plan means PM).
- "duration": the complaint is about HOW LONG they stay at this stop. Return a "duration" object.
   - ABSOLUTE ("stay 2 hours", "make it 90 minutes", "just an hour here"): set { "mode": "absolute", "targetMinutes": N }.
   - RELATIVE ("stay longer", "more time here", "shorter", "less time", "an extra hour"): set { "mode": "relative", "deltaMinutes": N } (longer is POSITIVE, shorter NEGATIVE). "an extra hour" = 60, "a lot longer" = 60; vague "longer"/"shorter" default to ±30.
- "constraint": the complaint asks for a venue with a different FEATURE or LOCATION, still the same kind of place — "with a patio", "near the water", "somewhere quieter that's outdoors". Set path "research", fold the feature into "constraints".
- "venue": the complaint is about the venue's quality/price/style in the SAME slot — "don't like it", "cheaper", "less fancy", "higher rated". Set path "refilter" (narrows the same pool) unless it needs different venues, then "research".

"category" — the KIND of place this stop is. Its current value is given to you.
- CHANGE it only when the complaint NAMES a different kind of place to go instead: "board games instead" -> "board game cafe"; "coffee instead of the bar" -> "coffee shop"; "let's do something active" -> "climbing gym"; "make it a proper restaurant" -> "restaurant"; "a museum instead" -> "museum". Set "intent": "venue" and "path": "research".
- A NAMED kind is the only trigger. Plain dissatisfaction is NOT one: "something different", "surprise me", "somewhere else", "something more chill", "don't like it", "higher rated", "cheaper", "somewhere quieter" all want a different VENUE of the SAME kind. For those, repeat "category" exactly as it was given and set "path": "refilter".
- If you are unsure whether a kind was named, keep the category unchanged. A same-kind swap the user did not want is a small miss; changing the kind of the stop when they only wanted a different venue rewrites their day.
- When you DO change "category", the new kind belongs ONLY in "category". NEVER also put it in "constraints".

Rules:
- "constraints" are provable venue FEATURES (patio, vegetarian, live music, wheelchair accessible, dog friendly) — never a kind of place, never a price word.
- Put budget words into "budget"; vibe/feature words into "constraints".
- Preserve still-relevant original constraints; drop ones the complaint overrides.

Respond with ONLY this JSON, no prose:
{ "intent": "venue"|"time"|"constraint"|"duration", "path": "refilter"|"research", "category": string, "aesthetic": string, "budget": string|null, "constraints": string[], "time": { "mode": "relative"|"absolute", "deltaMinutes": number, "targetTime": string } | null, "duration": { "mode": "relative"|"absolute", "deltaMinutes": number, "targetMinutes": number } | null }`;

const INTERPRET_KEYS = [
  "intent",
  "path",
  "category",
  "aesthetic",
  "budget",
  "constraints",
  "time",
  "duration",
] as const;

interface ValidInterpretOutput {
  intent: SwapIntent;
  path: "refilter" | "research";
  category: string;
  aesthetic: string;
  budget: string | null;
  constraints: string[];
  time:
    | { mode: "relative"; deltaMinutes: number }
    | { mode: "absolute"; targetTime: string }
    | null;
  duration:
    | { mode: "relative"; deltaMinutes: number }
    | { mode: "absolute"; targetMinutes: number }
    | null;
}

function validInterpretOutput(value: unknown): value is ValidInterpretOutput {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== INTERPRET_KEYS.length ||
    INTERPRET_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    !["venue", "time", "constraint", "duration"].includes(String(value.intent)) ||
    !["refilter", "research"].includes(String(value.path)) ||
    typeof value.category !== "string" ||
    value.category.trim() === "" ||
    value.category.length > 240 ||
    typeof value.aesthetic !== "string" ||
    value.aesthetic.length > 240 ||
    (value.budget !== null &&
      (typeof value.budget !== "string" || value.budget.length > 240)) ||
    !Array.isArray(value.constraints) ||
    value.constraints.length > 8 ||
    !value.constraints.every(
      (constraint) => typeof constraint === "string" && constraint.length <= 240
    )
  ) {
    return false;
  }
  const validShift = (shift: unknown, duration: boolean) => {
    if (shift === null) return true;
    if (!isRecord(shift) || !["relative", "absolute"].includes(String(shift.mode))) {
      return false;
    }
    if (shift.mode === "relative") {
      return typeof shift.deltaMinutes === "number" && Number.isFinite(shift.deltaMinutes);
    }
    return duration
      ? typeof shift.targetMinutes === "number" && Number.isFinite(shift.targetMinutes)
      : typeof shift.targetTime === "string" && /^\d{2}:\d{2}$/.test(shift.targetTime);
  };
  return validShift(value.time, false) && validShift(value.duration, true);
}

/**
 * MERIDIEM DISAMBIGUATION ONLY — the minimal survivor of the deleted
 * plausibility gate (2026-07-27). A bare hour in a swap refinement ("make
 * it 10") is genuinely ambiguous, and the stop's kind is the only evidence
 * available for reading it: on a brunch stop that plainly means 10 AM, on a
 * bar stop 10 PM. That is reading comprehension, not a verdict about
 * whether anywhere is open — nothing here can REFUSE a time any more, and
 * the objective hours filter still decides what is actually usable.
 *
 * Deliberately coarse and short: it only has to separate morning-ish kinds
 * from evening-ish ones. Unknown categories get no opinion, and the
 * outing-planner default (assume PM) stands.
 */
const ROUGH_HOURS: Array<[RegExp, { startHour: number; endHour: number }]> = [
  [/breakfast/i, { startHour: 6, endHour: 12 }],
  [/brunch/i, { startHour: 8, endHour: 15 }],
  [/coffee|caf[eé]|espresso|matcha/i, { startHour: 7, endHour: 22 }],
  [/lunch/i, { startHour: 11, endHour: 16 }],
  [/club/i, { startHour: 20, endHour: 4 }],
  [/\bbars?\b|cocktail|pub|brewery|wine|drink/i, { startHour: 11, endHour: 2 }],
  [
    /dinner|restaurant|dining|ramen|sushi|pizza|taco|noodle|pho|steak|izakaya|bbq/i,
    { startHour: 11, endHour: 23 },
  ],
];

/** Rough daytime window for a category, or null when we have no opinion.
 *  Parks come from the shared traits table, like everywhere else (§5.3). */
export function roughHoursFor(category: string | undefined): { startHour: number; endHour: number } | null {
  const c = (category ?? "").trim();
  if (!c) return null;
  if (isParkLike(c)) return { startHour: 6, endHour: 22 };
  return ROUGH_HOURS.find(([pattern]) => pattern.test(c))?.[1] ?? null;
}

/** Is this wall-clock hour inside the rough window? endHour < startHour
 *  wraps past midnight (bars, clubs). Pure — no date, no zone. */
export function hourInRoughHours(
  h: number,
  window: { startHour: number; endHour: number }
): boolean {
  if (window.startHour <= window.endHour) return h >= window.startHour && h < window.endHour;
  return h >= window.startHour || h < window.endHour;
}

// Deterministic fallback for time expressions, so common relative phrases
// resolve even if the model whiffs. Earlier is negative, later positive.
export function parseTimeExpr(text: string, category?: string): TimeShift | null {
  const s = text.toLowerCase();
  // The PM assumption below is right for most stops but was applied blind:
  // on a BRUNCH stop "make it 10" became 22:00, which read as a 10 PM
  // brunch — a confusing answer to a request that plainly meant 10 AM.
  // When the stop's category has a rough window, prefer the reading that
  // fits it (§7.3).
  const band = category ? roughHoursFor(category) : null;

  // hour/minute (+ optional meridiem) → "HH:MM"; null when out of range so
  // callers can fall through (e.g. "by 30 minutes" is relative, not 30:00)
  const absolute = (h: number, m: number, ap: "am" | "pm" | null): TimeShift | null => {
    if (ap === "pm" && h < 12) h += 12; // 6pm → 18
    else if (ap === "am" && h === 12) h = 0; // 12am → midnight
    // no meridiem: this is an outing planner — a small hour means
    // afternoon/evening ("3:30" is 15:30, "at 7" is 19:00); 12 stays noon
    else if (!ap && h >= 1 && h <= 11) {
      // keep AM only when the category's band actually wants it and the
      // PM reading is outside — otherwise the evening default stands
      const amFits = band ? hourInRoughHours(h, band) : false;
      const pmFits = band ? hourInRoughHours(h + 12, band) : true;
      if (!(amFits && !pmFits)) h += 12;
    }
    if (h < 0 || h > 24 || m < 0 || m >= 60) return null;
    return {
      mode: "absolute",
      targetTime: `${String(h % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
    };
  };

  // a number owned by a DURATION unit ("2 hours", "90 minutes") is never a
  // clock time — without this, "make it 2 hours" reads as "make it 2" = 14:00
  const NOT_DURATION_UNIT = /(?!\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b)/.source;

  // a refinement that is ONLY a number is a clock time ("6" → 18:00)
  const lone = s.trim().match(/^(\d{1,2})$/);
  if (lone) {
    const r = absolute(parseInt(lone[1], 10), 0, null);
    if (r) return r;
  }

  // 1) an explicit meridiem anywhere ("6pm", "6 pm", "12:30am") is exact —
  //    no preposition needed, and the stated am/pm always wins
  const mer = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (mer) {
    const r = absolute(parseInt(mer[1], 10), mer[2] ? parseInt(mer[2], 10) : 0, mer[3] as "am" | "pm");
    if (r) return r;
  }

  // 2) preposition-anchored bare time: "after 8", "at 7:30", "move it to 6"
  const abs = s.match(
    new RegExp(`\\b(?:after|at|by|around|to|make it)\\s+(\\d{1,2})(?::(\\d{2}))?${NOT_DURATION_UNIT}\\b`)
  );
  if (abs) {
    const r = absolute(parseInt(abs[1], 10), abs[2] ? parseInt(abs[2], 10) : 0, null);
    if (r) return r;
  }

  // 3) a bare colon time ("3:30") is unambiguously a clock time
  const bare = s.match(new RegExp(`\\b(\\d{1,2}):(\\d{2})${NOT_DURATION_UNIT}\\b`));
  if (bare) {
    const r = absolute(parseInt(bare[1], 10), parseInt(bare[2], 10), null);
    if (r) return r;
  }

  // relative direction
  const later = /\b(later|after|push|delay)\b/.test(s);
  const earlier = /\b(earlier|sooner|before|bump up|move up)\b/.test(s);
  if (!later && !earlier) return null;
  const sign = earlier ? -1 : 1;

  // explicit amount
  const amt = s.match(/(\d+)\s*(h|hr|hour|hours|min|mins|minute|minutes)/);
  if (amt) {
    const n = parseInt(amt[1], 10);
    const mins = /^h|hour/.test(amt[2]) ? n * 60 : n;
    return { mode: "relative", deltaMinutes: sign * mins };
  }
  if (/\bhalf\s+an?\s+hour\b/.test(s)) return { mode: "relative", deltaMinutes: sign * 30 };
  if (/\b(an?\s+hour|1\s*hour)\b/.test(s)) return { mode: "relative", deltaMinutes: sign * 60 };
  if (/\b(much|way|a lot)\b/.test(s)) return { mode: "relative", deltaMinutes: sign * 60, vague: true };
  // vague ("a bit", "a little", "somewhat", "slightly", bare "earlier/later")
  return { mode: "relative", deltaMinutes: sign * 30, vague: true };
}

// Deterministic fallback for duration expressions ("stay 2 hours",
// "longer", "an extra hour"). Longer is positive, shorter negative.
export function parseDurationExpr(text: string): DurationShift | null {
  const s = text.toLowerCase();
  // a bare time direction with no duration word is a TIME request, not a
  // duration one ("an hour earlier" must not read as "an hour").
  const timeSignal = /\b(earlier|later|sooner|after|at|by|around)\b/.test(s);
  const durationSignal =
    /\b(stay|staying|spend|spending|longer|shorter|more time|less time|extra|quicker|linger|hang|another|for)\b/.test(s);
  if (timeSignal && !durationSignal) return null;

  const hasAmount =
    /\b\d+\s*(h|hr|hrs|hour|hours|min|mins|minute|minutes)\b/.test(s) ||
    /\b(an?\s+hour|half\s+an?\s+hour|hour and a half)\b/.test(s);
  if (!durationSignal && !hasAmount) return null;

  const amount = (): number | null => {
    const m = s.match(/(\d+)\s*(h|hr|hrs|hour|hours|min|mins|minute|minutes)/);
    if (m) {
      const n = parseInt(m[1], 10);
      return /^h|hour/.test(m[2]) ? n * 60 : n;
    }
    if (/\bhour and a half\b/.test(s)) return 90;
    if (/\bhalf\s+an?\s+hour\b/.test(s)) return 30;
    if (/\bhours?\b/.test(s)) return 60; // "an hour", "an extra hour", "another hour"
    return null;
  };

  const longer = /\b(longer|more time|extra|linger|another)\b/.test(s);
  const shorter = /\b(shorter|less time|quicker|cut (?:it )?short)\b/.test(s);
  if (longer || shorter) {
    const sign = shorter ? -1 : 1;
    const amt = amount();
    if (amt !== null) return { mode: "relative", deltaMinutes: sign * amt };
    if (/\b(a lot|much|way)\b/.test(s)) return { mode: "relative", deltaMinutes: sign * 60 };
    return { mode: "relative", deltaMinutes: sign * 30 }; // vague
  }

  const amt = amount();
  return amt !== null ? { mode: "absolute", targetMinutes: amt } : null;
}

// exported for regression tests: the deterministic floor must hold even
// when the model misclassifies or returns garbage arithmetic
export async function interpretRefinement(
  apiKey: string,
  parsed: ParsedPrompt,
  category: string,
  currentStartISO: string,
  refinement: string
): Promise<SwapInterpretation> {
  // Trust the local parsers as the floor — the model can only refine
  // arithmetic requests, never lose them. Duration wins over time.
  const localDuration = parseDurationExpr(refinement);
  const localTime = parseTimeExpr(refinement, category);
  // Price direction is deterministic too, and unlike the two above it is
  // never handed to the model at all — `venueSwap` re-reads it from the raw
  // refinement and does the ranking itself.
  const localPrice = parsePriceDirection(refinement);
  const fallback: SwapInterpretation = {
    intent: "venue",
    path: "refilter",
    category,
    aesthetic: parsed.aesthetic,
    budget: parsed.budget,
    // A price phrase must NEVER land in `constraints`. Constraints are proved
    // from six provider booleans (`constraintEvidence`), so a "fancier" in
    // there makes `placeMeetsAllConstraints` false for EVERY venue and turns
    // the swap into a permanent unmet_constraint refusal. This fallback is
    // the path a Groq failure takes, so without the guard a busy model would
    // make every price swap fail loud for the wrong reason.
    constraints: localPrice
      ? [...(parsed.constraints ?? [])]
      : [...(parsed.constraints ?? []), refinement],
    time: null,
    duration: null,
  };
  const localFallback = (): SwapInterpretation =>
    localDuration && localTime
      ? { ...fallback, intent: "time", time: localTime, duration: localDuration }
      : localDuration
      ? { ...fallback, intent: "duration", duration: localDuration }
      : localTime
      ? { ...fallback, intent: "time", time: localTime }
      : fallback;
  // NOTE ON FAILURE HANDLING: the catch at the end of this function returns
  // localFallback() for EVERY failure, and that now includes a rate limit
  // that exhausted the swap chain. That is deliberate rather than an
  // oversight — unlike the planner, this call has a real deterministic
  // interpretation underneath it (parseTimeExpr/parseDurationExpr already
  // own every number), so degrading to it beats refusing the swap because a
  // model was busy. This is the one call type where "busy" should not reach
  // the user.
  try {
    // The swap chain, not the planner's: a small classification job with
    // deterministic parsers beneath it runs on a smaller primary, leaving the
    // 70B budget to the calls that need judgment (models.ts explains why).
    const content = await withModelFallback("swap", async (model) => {
      const res = await fetchProvider("groq", GROQ_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: REFINE_SYSTEM },
            {
              role: "user",
              content: JSON.stringify({
                current: {
                  category,
                  aesthetic: parsed.aesthetic,
                  budget: parsed.budget,
                  constraints: parsed.constraints ?? [],
                  startsAt: clockLabel(new Date(currentStartISO)),
                },
                complaint: refinement,
              }),
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
        }),
        cache: "no-store",
      });
      const data = requireProviderRecord("groq", await readProviderJson("groq", res));
      const choices = data.choices;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const message = isRecord(first) ? first.message : undefined;
      const raw = isRecord(message) ? message.content : undefined;
      // thrown, not returned as a fallback, so it reaches withModelFallback —
      // which passes it straight through (not retryable) to the catch below,
      // preserving the previous behaviour exactly
      if (typeof raw !== "string" || raw.length > 50_000) {
        throw new ProviderError("groq", 502, "groq_invalid_response");
      }
      return raw;
    });
    const parsedOutput: unknown = JSON.parse(content);
    if (!validInterpretOutput(parsedOutput)) return localFallback();
    const out = parsedOutput;
    let intent: SwapIntent = ["time", "constraint", "duration"].includes(out.intent)
      ? out.intent
      : "venue";
    // the deterministic parsers override classification — an arithmetic
    // phrase is a duration/time request even if the model called it a venue.
    // BOTH parsing ("start at 6pm for 2 hours") routes to time, which
    // applies the duration half alongside — neither request is dropped.
    if (localDuration && localTime) intent = "time";
    else if (localDuration) intent = "duration";
    else if (localTime) intent = "time";
    // A price phrase with no clock/length phrase in it is a VENUE request and
    // must never be allowed to move the stop's time. "venue" and "constraint"
    // both land in venueSwap, so only a time/duration misclassification is
    // wrong here — leave a genuine constraint reading alone.
    else if (localPrice && (intent === "time" || intent === "duration")) {
      intent = "venue";
    }

    let time: TimeShift | null = null;
    if (intent === "time") {
      const t = out.time;
      if (t?.mode === "relative" && typeof t.deltaMinutes === "number") {
        time = { mode: "relative", deltaMinutes: t.deltaMinutes };
      } else if (t?.mode === "absolute" && typeof t.targetTime === "string" && /^\d{1,2}:\d{2}$/.test(t.targetTime)) {
        time = { mode: "absolute", targetTime: t.targetTime };
      }
      if (localTime?.mode === "absolute") {
        // an explicit clock time parsed from the text is exact — the floor
        // wins ("6pm" must never become the model's 06:00)
        time = localTime;
      } else if (localTime?.mode === "relative") {
        // exact local amounts ("an hour earlier") win outright. Only a
        // VAGUE local ("a bit earlier") lets the model refine, and only
        // within sanity: same direction, at most 3h — a garbage delta must
        // never drift the stop across the day
        const localDelta = localTime.deltaMinutes ?? 0;
        const modelDelta = time?.mode === "relative" ? time.deltaMinutes : undefined;
        const sane =
          typeof modelDelta === "number" &&
          Math.sign(modelDelta) === Math.sign(localDelta) &&
          Math.abs(modelDelta) <= 180;
        time = { mode: "relative", deltaMinutes: localTime.vague && sane ? modelDelta! : localDelta };
      } else {
        time = time ?? null;
      }
    }

    let duration: DurationShift | null = null;
    if (intent === "duration") {
      const dd = out.duration;
      if (dd?.mode === "relative" && typeof dd.deltaMinutes === "number") {
        duration = { mode: "relative", deltaMinutes: dd.deltaMinutes };
      } else if (dd?.mode === "absolute" && typeof dd.targetMinutes === "number") {
        duration = { mode: "absolute", targetMinutes: dd.targetMinutes };
      }
      duration = duration ?? localDuration;
    } else if (intent === "time" && localDuration) {
      // compound: the deterministic duration rides along with the move
      duration = localDuration;
    }

    return {
      intent,
      path: out.path === "research" || intent === "constraint" ? "research" : "refilter",
      category: typeof out.category === "string" && out.category.trim() ? out.category : category,
      aesthetic: typeof out.aesthetic === "string" ? out.aesthetic : parsed.aesthetic,
      budget: typeof out.budget === "string" ? out.budget : out.budget === null ? null : parsed.budget,
      constraints: Array.isArray(out.constraints)
        ? out.constraints.filter((c: unknown): c is string => typeof c === "string")
        : fallback.constraints,
      time,
      duration,
    };
  } catch {
    return localFallback();
  }
}

function realDeps(): SwapDeps {
  // e2e fixture seam — deterministic interpret/search/select/legs/hours
  if (isMockMode()) return mockSwapDeps(parseTimeExpr, parseDurationExpr, usableByHours);
  return {
    interpret: (parsed, category, currentStartISO, refinement) =>
      interpretRefinement(process.env.GROQ_API_KEY ?? "", parsed, category, currentStartISO, refinement),
    searchPools: (parsed, categories) =>
      realSearchPools(process.env.GOOGLE_PLACES_API_KEY ?? "", parsed, categories),
    selectVenues: (parsed, pools) =>
      withModelFallback("select", (model) =>
        realSelectVenues(
          process.env.GROQ_API_KEY ?? "",
          parsed,
          pools,
          undefined,
          selectModelCall(process.env.GROQ_API_KEY ?? "", model)
        )
      ),
    getSingleLeg: (origin, destination, fromIndex, departureTime, excludeTransit) =>
      realGetSingleLeg(process.env.GOOGLE_ROUTES_API_KEY ?? "", origin, destination, fromIndex, departureTime, excludeTransit),
    isUsableAt: usableByHours,
    getWeather: (lat, lng) => fetchWeatherHours(process.env.GOOGLE_WEATHER_API_KEY, lat, lng),
  };
}

// Default availability seam — objective hours only (keep-on-missing: no
// hours data means we can't rule it out, so it stays usable). A real
// availability API replaces this function body, nothing else.
//
// The instant is judged on the VENUE's local clock (the plan's zone), via
// the shared isOpenAtInstant. It previously read the SERVER's wall clock
// (when.getDay()/getHours()), so on Vercel's UTC runtime every plan — even
// a Toronto one — was checked against the wrong hour, and often the wrong
// weekday. Exported for direct testing: every swap test injects its own
// isUsableAt, so this production default had no coverage at all.
// See code-audit 2026-07-18 §1.1.
export function usableByHours(
  place: Place,
  when: Date,
  _category?: string,
  timeZone: string = DEFAULT_ZONE
): boolean {
  return isOpenAtInstant(place.currentOpeningHours, when, timeZone) !== false;
}

// A Place view of a stored stop — for the availability check. The hours now
// travel WITH the stop (like price/description/rating already did), so this
// hands back real data instead of always-undefined. Until that field
// existed, every availability check on a stored stop hit keep-on-missing
// and returned "usable", which meant the try → adapt → notify ladder's
// adapt step could never fire in production — only in mock mode, where a
// fixture-registry lookup papered over the gap. Found during the Group A
// work on code-audit 2026-07-18 §1.1; NOT in the original audit.
// A venue Places genuinely has no hours for still arrives undefined here,
// and still reads as usable. That is the intentional rule, not the bug.
function placeOf(stop: ItineraryStop): Place {
  return {
    id: stop.id ?? "",
    displayName: stop.name ? { text: stop.name } : undefined,
    rating: stop.rating,
    priceLevel: stop.priceLevel,
    editorialSummary: stop.description
      ? { text: stop.description }
      : undefined,
    location: stop.location,
    currentOpeningHours: stop.currentOpeningHours,
  };
}

/** Forecast for the plan's origin, or null when there's nothing to ask
 *  about (pre-multi-city plans carry no home) — keep-on-missing. */
async function weatherFor(itinerary: Itinerary, deps: SwapDeps): Promise<WeatherHour[] | null> {
  const origin = itinerary.home?.location;
  return origin ? deps.getWeather(origin.latitude, origin.longitude) : null;
}

function cloneProposal(itinerary: Itinerary): Itinerary {
  return JSON.parse(JSON.stringify(itinerary)) as Itinerary;
}

function validLocation(location: LatLng | null | undefined): location is LatLng {
  return (
    !!location &&
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

function validLeg(leg: TravelLeg | null | undefined): leg is TravelLeg {
  return !!leg && Number.isFinite(leg.totalMinutes) && leg.totalMinutes >= 0;
}

async function proposalLeg(
  deps: SwapDeps,
  origin: LatLng,
  destination: LatLng,
  fromIndex: number,
  departureTime: string | undefined
): Promise<TravelLeg | null> {
  try {
    const leg = await deps.getSingleLeg(
      origin,
      destination,
      fromIndex,
      departureTime,
      false
    );
    return validLeg(leg) ? leg : null;
  } catch {
    return null;
  }
}

/**
 * How much of a stop's total is actually spent AT the venue.
 *
 * A stop's `total` is occupancy PLUS the table's scheduling margin — the
 * buffer is transition time, not time inside the door ("the buffer stays the
 * table's scheduling margin"). Judging openness against the total would demand
 * that a venue stay open through margin it has nothing to do with, and that is
 * not a hypothetical: it adapted a 4.7 bar closing at 22:00 away from a
 * 20:55–21:55 drinks stop whose buffer ran to 22:05. The venue was open the
 * entire time anyone was in it.
 *
 * The split mirrors `buildStop`'s exactly — buffer capped by the total — so
 * the instant checked here is the same one the committed stop implies.
 */
function occupancyMinutes(category: string, totalMinutes: number): number {
  const { bufferMinutes } = getDuration(category);
  return Math.max(0, totalMinutes - Math.min(bufferMinutes, totalMinutes));
}

/**
 * The last instant actually SPENT at a venue, for a stop starting at `start`
 * and occupying `occupancy` minutes.
 *
 * Occupancy is the half-open interval [start, end): you are there until the
 * end, not at it. Checking the end instant itself would reject a venue that
 * closes exactly when you leave — an ordinary plan, not a conflict — because
 * `isOpenAt` treats the closing minute as closed (`t >= open && t < close`).
 * So the check lands one minute inside, clamped so it can never precede the
 * start on a very short stop.
 */
function lastMomentOfSlot(start: Date, occupancy: number): Date {
  const endMs = start.getTime() + occupancy * 60_000;
  return new Date(Math.max(start.getTime(), endMs - 60_000));
}

/**
 * Is this venue usable for the WHOLE slot, rather than only at the moment of
 * arrival?
 *
 * Openness used to be judged at the slot's START and nowhere else — every
 * caller passed the start, and `isOpenAt` is a single-instant comparison. A
 * venue that closes MID-SLOT therefore passed every check the swap engine had:
 * a coffee shop closing at 9:30 was a legal answer for a 9:00–10:00 slot.
 * That was always wrong, and a category change makes it bite harder, because a
 * new kind of place brings a new duration the old slot was never sized for.
 *
 * It goes through `deps.isUsableAt` — the ONE availability seam — rather than
 * reaching for hours directly, so a real reservation API replaces both ends of
 * the slot at once. Keep-on-missing is inherited from that seam: a venue with
 * no hours data is still usable, exactly as at the start instant.
 */
function usableThroughSlot(
  place: Place,
  category: string,
  when: Date,
  slotMinutes: number,
  timeZone: string,
  deps: SwapDeps
): boolean {
  if (!Number.isFinite(slotMinutes) || slotMinutes <= 0) return true;
  const occupancy = occupancyMinutes(category, slotMinutes);
  if (occupancy <= 0) return true;
  return deps.isUsableAt(
    place,
    lastMomentOfSlot(when, occupancy),
    category,
    timeZone
  );
}

/**
 * Slot length for a stop this swap is NOT rescheduling — judge arrival only.
 *
 * The whole-slot rule applies to venues this swap actually commits or moves:
 * the replacement it picked, a stop whose length it changed, a stop it shifted
 * to a new time. A downstream stop that keeps its committed arrival is none of
 * those — the swap did not touch it, and the initial pipeline's own filter is
 * still arrival-only, so re-judging it here under a stricter rule would let an
 * unrelated swap silently re-kind stops the user never asked about. (The
 * planner-side asymmetry is real and noted in the devlog as follow-up; the fix
 * for it belongs in `filterPools`, not in a swap.)
 */
const ARRIVAL_ONLY = 0;

// `slotMinutes` is REQUIRED, not optional-with-a-default, on purpose: an
// optional one would let a future call site silently keep the old
// start-instant-only behaviour. Every caller has to say how long the stop it
// is proposing actually lasts — or ARRIVAL_ONLY, deliberately and visibly.
function usableForProposal(
  place: Place,
  category: string,
  base: ParsedPrompt,
  weather: WeatherHour[] | null,
  now: Date,
  when: Date,
  slotMinutes: number,
  timeZone: string,
  deps: SwapDeps
): boolean {
  if (!validLocation(place.location)) return false;
  const parsed = scoped(base, {}, category);
  const { pools } = filterPools(
    { [category]: [place] },
    parsed,
    weather,
    now,
    when,
    timeZone
  );
  return (
    (pools[category] ?? []).some((candidate) => candidate.id === place.id) &&
    deps.isUsableAt(place, when, category, timeZone) &&
    usableThroughSlot(place, category, when, slotMinutes, timeZone, deps)
  );
}

interface AnchorInbound {
  leg: TravelLeg;
  prevStop: ItineraryStop | null;
}

async function planAnchorInbound(
  itinerary: Itinerary,
  timedIdx: number[],
  stopIndex: number,
  anchorLoc: LatLng | null | undefined,
  anchorStart: Date,
  deps: SwapDeps
): Promise<AnchorInbound | null> {
  if (!validLocation(anchorLoc) || !Number.isFinite(anchorStart.getTime())) {
    return null;
  }
  const timedPosition = timedIdx.indexOf(stopIndex);
  if (timedPosition < 0) return null;
  const prevStop =
    timedPosition > 0 ? itinerary.stops[timedIdx[timedPosition - 1]] : null;
  const origin = prevStop?.location ?? itinerary.home?.location ?? HOME.location;
  if (!validLocation(origin)) return null;
  if (prevStop && (!prevStop.end_time || !validLocation(prevStop.location))) {
    return null;
  }
  if (
    prevStop?.end_time &&
    !Number.isFinite(new Date(prevStop.end_time).getTime())
  ) {
    return null;
  }
  const leg = await proposalLeg(
    deps,
    origin,
    anchorLoc,
    prevStop ? timedPosition - 1 : HOME_LEG_INDEX,
    prevStop?.end_time ?? undefined
  );
  if (!leg) return null;
  if (
    prevStop?.end_time &&
    new Date(prevStop.end_time).getTime() + leg.totalMinutes * 60_000 >
      anchorStart.getTime()
  ) {
    return null;
  }
  return { leg, prevStop };
}

function commitAnchorInbound(
  itinerary: Itinerary,
  inbound: AnchorInbound
): void {
  if (inbound.prevStop) {
    inbound.prevStop.travelToNext = inbound.leg;
    inbound.prevStop.travelMinutesToNext = inbound.leg.totalMinutes;
  } else {
    itinerary.homeLeg = { ...inbound.leg, fromIndex: HOME_LEG_INDEX };
  }
}

function snap(s: ItineraryStop): Snap {
  return { name: s.name ?? null, start: s.start_time, end: s.end_time, category: s.category };
}

// "4:00 AM" in the plan's zone — swap reasons quote the venue's local time.
function clockLabel(d: Date, timeZone: string = DEFAULT_ZONE): string {
  const { hour, minute } = wallClockParts(d, timeZone);
  const ap = hour < 12 ? "AM" : "PM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${ap}`;
}

export async function swapStop(
  itinerary: Itinerary,
  stopIndex: number,
  refinement: string,
  now: Date,
  depsIn: Partial<SwapDeps> = {}
): Promise<SwapResult> {
  const deps = { ...realDeps(), ...depsIn };
  const work = cloneProposal(itinerary);
  withStatuses(work, now);
  const floor = floorTime(work, now);

  const target = work.stops[stopIndex];
  if (!target) return { swapped: false, reason: "That stop doesn't exist." };
  if (!target.start_time || target.id === null) {
    return { swapped: false, reason: "That stop has no venue to swap." };
  }
  if (target.locked || new Date(target.start_time).getTime() <= floor.getTime()) {
    return {
      swapped: false,
      reason: `You can only swap an upcoming stop — “${target.name}” is already underway or done.`,
    };
  }

  // no stored parse → a minimal fallback that invents no location, and an
  // honest refusal when we can't even know the city (§3.1)
  const base = work.parsed ?? fallbackParsedFor(work);
  if (!base) return { swapped: false, reason: UNKNOWN_LOCATION_MESSAGE };
  const interp = await deps.interpret(base, target.category, target.start_time, refinement);
  const weather = await weatherFor(work, deps);

  // observability at the apply step (like the weather-gate log): parsed
  // intent + the stop's start/duration before vs after, so a swap that
  // silently rewrites the wrong field is visible in the server log
  const beforeStart = target.start_time;
  const beforeTotal = target.durationMinutes?.total ?? null;

  let result: SwapResult;
  if (interp.intent === "time") {
    result = await timeChange(
      work,
      stopIndex,
      target,
      interp,
      base,
      floor,
      now,
      deps,
      weather
    );
  } else if (interp.intent === "duration") {
    result = await durationChange(
      work,
      stopIndex,
      target,
      interp,
      base,
      floor,
      now,
      deps,
      weather
    );
  } else {
    result = await venueSwap(
      work,
      stopIndex,
      target,
      interp,
      base,
      floor,
      now,
      deps,
      refinement,
      weather
    );
  }

  if (result.swapped) Object.assign(itinerary, work);
  const after = result.swapped ? work.stops[result.stopIndex] : null;
  logEvent("info", "swap_applied", {
    intent: interp.intent,
    outcome: result.swapped ? "swapped" : "refused",
    beforeStart,
    beforeTotal,
    afterStart: after?.start_time ?? null,
    afterTotal: after?.durationMinutes?.total ?? null,
  });
  return result;
}

function durLabel(mins: number): string {
  if (mins % 60 === 0) return `${mins / 60} hour${mins === 60 ? "" : "s"}`;
  if (mins < 120) return `${mins} minutes`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Resolve a DurationShift against a stop's current total, with the sane
// bounds (6h cap, category-realistic floor). Shared by durationChange and
// timeChange's compound path ("start at 6pm for 2 hours").
function resolveNewTotal(
  category: string,
  target: ItineraryStop,
  dur: DurationShift
): { ok: true; total: number; currentTotal: number } | { ok: false; reason: string } {
  const d = getDuration(category);
  const defaultTotal = d.baseMinutes + d.bufferMinutes;
  const currentTotal = target.durationMinutes?.total ?? defaultTotal;
  const total = Math.round(
    dur.mode === "absolute" ? dur.targetMinutes ?? currentTotal : currentTotal + (dur.deltaMinutes ?? 0)
  );
  const MAX = 360;
  const categoryMin = Math.max(15, Math.round(defaultTotal * 0.4));
  if (total > MAX) {
    return { ok: false, reason: `${durLabel(total)} is longer than a single stop makes sense — keep it under 6 hours.` };
  }
  if (total < categoryMin) {
    return {
      ok: false,
      reason: `A ${durLabel(total)} ${category} isn't enough time — give it at least ${durLabel(categoryMin)}.`,
    };
  }
  return { ok: true, total, currentTotal };
}

// ── DURATION: change how long the stop lasts, then resettle the tail. The
// start stays put; only the end (and everything after) moves. Reuses the
// same try → adapt → notify ladder as time-swaps. ──
async function durationChange(
  itinerary: Itinerary,
  stopIndex: number,
  target: ItineraryStop,
  interp: SwapInterpretation,
  base: ParsedPrompt,
  floor: Date,
  now: Date,
  deps: SwapDeps,
  weather: WeatherHour[] | null
): Promise<SwapResult> {
  const tz = itinerary.timeZone ?? DEFAULT_ZONE;
  const category = target.category;
  const dur = interp.duration;
  if (!dur) {
    return { swapped: false, reason: "Couldn't tell how long you meant — try “stay 2 hours” or “a bit longer”." };
  }

  const resolved = resolveNewTotal(category, target, dur);
  if (!resolved.ok) return { swapped: false, reason: resolved.reason };
  const { total: newTotal, currentTotal } = resolved;

  const startISO = target.start_time!;
  const start = new Date(startISO);
  // the NEW length is the one to check: extending a stop can push its end past
  // the venue's closing time even though nothing about its start moved
  if (
    !usableForProposal(
      placeOf(target),
      category,
      base,
      weather,
      now,
      start,
      newTotal,
      tz,
      deps
    )
  ) {
    return {
      swapped: false,
      reason: `${target.name} is no longer usable at ${clockLabel(start, tz)}.`,
    };
  }
  const anchorEnd = new Date(new Date(startISO).getTime() + newTotal * 60_000);

  const timedIdx = timedIndexes(itinerary);
  const anchorInbound = await planAnchorInbound(
    itinerary,
    timedIdx,
    stopIndex,
    target.location,
    start,
    deps
  );
  if (!anchorInbound) {
    return {
      swapped: false,
      reason: `The route into ${target.name} no longer fits its committed start.`,
    };
  }
  const used = new Set<string>(itinerary.stops.map((s) => s.id).filter((id): id is string => !!id));

  // resettle downstream from the new end (start + venue unchanged, so the
  // inbound leg into this stop is untouched)
  const settle = await resettleTail(
    itinerary,
    stopIndex,
    timedIdx,
    anchorEnd,
    target.location ?? null,
    floor,
    now,
    base,
    deps,
    used,
    weather
  );
  if (!settle.ok) return { swapped: false, reason: settle.reason };

  const before = snap(target);
  const anchorOutbound =
    settle.changes[0]?.inbound ?? settle.terminalInbound ?? null;
  itinerary.stops[stopIndex] = buildStop(category, startISO, { keep: target }, anchorOutbound, newTotal, tz);
  commitAnchorInbound(itinerary, anchorInbound);
  commitTail(itinerary, settle.changes, settle.terminalInbound);
  rebuildLegs(itinerary);
  withStatuses(itinerary, now);

  const grew = newTotal >= currentTotal;
  let reason = `${grew ? "Extended" : "Shortened"} ${category} to ${durLabel(newTotal)}`;
  if (settle.changes.length) reason += ` — everything after shifted ${grew ? "later" : "earlier"}`;
  if (settle.changes.some((c) => c.venue)) reason += ` (moved a later stop to a spot that's still open)`;
  reason += ".";

  return {
    swapped: true,
    stopIndex,
    path: "duration",
    before,
    after: snap(itinerary.stops[stopIndex]),
    reason,
    downstreamShifted: settle.changes
      .filter((change) => change.moved)
      .map((change) => change.stopIndex),
  };
}

// A "closer/nearest" refinement is a DISTANCE request — detected
// deterministically (like the time/duration parsers) so the arithmetic
// never depends on the model.
const CLOSER_PATTERN = /\b(closer|nearer|nearest|closest|close by|nearby|walking distance|walkable)\b/i;

// ── VENUE / CONSTRAINT: replace the venue, hold the slot ──
async function venueSwap(
  itinerary: Itinerary,
  stopIndex: number,
  target: ItineraryStop,
  interp: SwapInterpretation,
  base: ParsedPrompt,
  floor: Date,
  now: Date,
  deps: SwapDeps,
  refinement: string,
  weather: WeatherHour[] | null
): Promise<SwapResult> {
  // A CATEGORY CHANGE ("board games instead", "coffee instead of the bar") is
  // a request for a different KIND of place, and it can only be honoured by
  // searching that kind's own pool. REFINE_SYSTEM asks the model to pair a new
  // `category` with path "research", but the path is its CLASSIFICATION and the
  // category is its ANSWER — when the two disagree, the answer wins. Without
  // this, a model that renamed the category while leaving path "refilter" had
  // the change SILENTLY discarded: the swap re-searched the old category and
  // handed back another bar for "board games instead", with nothing anywhere
  // reporting that the request had been dropped.
  // ONE effective path, derived once and used for every decision below — the
  // pool, the search parse, and the path REPORTED back. Deriving it per
  // consumer is how a swap ends up searching a new category through the
  // refilter parse and then telling the client it narrowed the old pool.
  const changesCategory =
    interp.category.trim().toLowerCase() !== target.category.trim().toLowerCase();
  const path: "refilter" | "research" =
    interp.path === "research" || changesCategory ? "research" : "refilter";
  const poolKey = path === "research" ? interp.category : target.category;

  // Name the category the user actually ASKED for. "another bar" on a
  // board-games request is wrong twice over — there is no other bar in
  // question — and "another board game cafe" is wrong the other way, since
  // there was never a first one.
  const noneFound = `Couldn't find ${
    changesCategory ? "a" : "another"
  } ${poolKey} that fits — keeping ${target.name}.`;

  // A "fancier"/"cheaper" refinement is a PRICE request, read from the RAW
  // text for exactly the reason the distance and time parsers are: price is a
  // field comparison, so the direction can never depend on the model. It is
  // deliberately NOT taken from `interp.budget` — that is the model's echo,
  // and gating on it would apply the plan's own budget to every swap.
  const priceDirection = parsePriceDirection(refinement);

  // LAYER 2 (the helper): the refilter path otherwise re-runs the ORIGINAL
  // query, so a "ramen" search returns the same same-tier pool with nothing
  // pricier in it to rank. `aesthetic` is the one buildQuery input that
  // reaches the Places text query verbatim, so the direction term rides in
  // there. This only IMPROVES the candidate pool — Google's notion of
  // "upscale" is fuzzy and may still return same-tier venues, which is why
  // the rank-and-refuse below is mandatory rather than an optimisation.
  const searchAesthetic = (existing: string): string => {
    if (!priceDirection) return existing;
    const term = priceDirectionSearchTerm(priceDirection);
    const kept = existing && existing.toLowerCase() !== "unspecified" ? existing : "";
    return kept ? `${term} ${kept}` : term;
  };

  // A price word the model folded into `constraints` has to come out of BOTH
  // consumers, and for two DIFFERENT reasons:
  //  - the JUDGE: constraints are proved from six provider booleans, so a
  //    "nicer" in there makes `placeMeetsAllConstraints` false for every venue
  //    — a permanent unmet_constraint refusal.
  //  - the SEARCH: `buildQuery` splices constraints into the Places text query
  //    verbatim, so "nicer" becomes literal query noise. Observed live:
  //    "somewhere nicer" produced constraints ["nicer"] and the query
  //    "upscale nicer ramen Toronto", whose results collapsed back to ordinary
  //    mid-tier ramen and made a genuine direction request refuse.
  // The prompt already forbids this; a model leaking a term into constraints
  // is something this codebase has watched happen, so it is a strip, not a
  // hope. Only the MODEL's constraints are filtered — the plan's own stated
  // constraints are its intent, not a leak from this refinement.
  //
  // A CATEGORY leaks the same way, and it is the SAME BUG wearing a different
  // word. REFINE_SYSTEM's "constraint" branch says to fold a different KIND of
  // venue into `constraints`, so "board games instead" can arrive as category
  // "board game cafe" AND constraints ["board game cafe"]. A kind of place is
  // unprovable BY CONSTRUCTION: `constraintEvidence` emits only six provider
  // booleans, so `placeMeetsAllConstraints` is false for EVERY candidate, the
  // correction retry fails identically, and the swap refuses with
  // unmet_constraint permanently — "Couldn't find a bar that's really board
  // game cafe". The kind is already carried, and carried better: it IS the
  // pool being searched. As a constraint it is pure duplication with a
  // permanent refusal attached.
  //
  // The strip is deliberately an EQUALITY test against the new category rather
  // than a keyword list. "with a patio" is a genuine, provider-provable
  // constraint, and any keyword list broad enough to catch "board games" would
  // eventually eat it. Normalisation is `normalizeConstraint` — the SAME
  // function the judge normalises with — so this removes exactly the strings
  // that would have choked it, and nothing else.
  const isLeakedConstraint = (constraint: string): boolean =>
    (priceDirection !== null && parsePriceDirection(constraint) !== null) ||
    (changesCategory &&
      normalizeConstraint(constraint) === normalizeConstraint(poolKey));
  const interpConstraints = (interp.constraints ?? []).filter(
    (constraint) => !isLeakedConstraint(constraint)
  );

  const searchParsed =
    path === "refilter"
      ? scoped(base, { aesthetic: searchAesthetic(base.aesthetic) }, poolKey)
      : scoped(
          base,
          {
            aesthetic: searchAesthetic(interp.aesthetic),
            budget: interp.budget,
            constraints: interpConstraints,
          },
          poolKey
        );

  // The judge keeps the model's reading, minus those constraints and minus its
  // BUDGET on a direction swap: "cheaper" makes the model emit budget "cheap",
  // which `parseBudget` turns into a flat ≤$$ CAP. That is what made "cheaper"
  // a ceiling instead of a decrease — on a $$$$ stop it hid the genuinely
  // cheaper $$$ options entirely. The relative rule below is the price rule for
  // these swaps; the plan's OWN stated budget still applies.
  const judgeParsed = scoped(
    base,
    {
      aesthetic: interp.aesthetic,
      budget: priceDirection ? base.budget : interp.budget,
      constraints: interpConstraints,
    },
    poolKey
  );

  const tz = itinerary.timeZone ?? DEFAULT_ZONE;
  const rawPools = await deps.searchPools(searchParsed, [poolKey]);
  // a swap must not move an outdoor stop into the rain either (§7.6)
  const { pools: filtered } = filterPools(
    rawPools,
    judgeParsed,
    weather,
    now,
    new Date(target.start_time!),
    tz
  );

  // never re-pick the rejected venue, nor anything already used elsewhere
  const excluded = new Set<string>(
    itinerary.stops
      .map((s, i) => (i === stopIndex ? target.id : s.id))
      .filter((id): id is string => id !== null)
  );
  let candidates = (filtered[poolKey] ?? []).filter(
    (place) => !excluded.has(place.id) && validLocation(place.location)
  );
  if (candidates.length === 0) {
    return { swapped: false, reason: noneFound };
  }

  // "closer" = CODE-side distance ranking against the anchor the user
  // travels from (the previous timed stop, else the plan's home): keep
  // only candidates strictly nearer than the current venue, nearest
  // first. The model then judges FIT among genuinely-closer options —
  // it never does the distance math.
  if (CLOSER_PATTERN.test(refinement) && target.location) {
    let anchor: LatLng | null = null;
    for (let i = stopIndex - 1; i >= 0; i--) {
      const s = itinerary.stops[i];
      if (s.start_time && s.location) {
        anchor = s.location;
        break;
      }
    }
    anchor = anchor ?? itinerary.home?.location ?? HOME.location;
    const currentMeters = haversineMeters(anchor, target.location);
    const closer = candidates
      .filter((p) => p.location && haversineMeters(anchor!, p.location) < currentMeters)
      .sort(
        (a, b) => haversineMeters(anchor!, a.location!) - haversineMeters(anchor!, b.location!)
      );
    if (closer.length === 0) {
      return {
        swapped: false,
        reason: `Couldn't find a ${poolKey} closer than ${target.name} — it's already the closest option I can find.`,
      };
    }
    candidates = closer;
  }

  // LAYER 1 (the guarantee): CODE-side price ranking against the CURRENT
  // stop's own priceLevel — the same shape as the distance block above, for
  // the same reason. Only candidates STRICTLY in the requested direction
  // survive; when none do the swap refuses honestly instead of shuffling in a
  // same-tier venue, which is precisely what made repeated "fancier" swaps
  // ping-pong A→B→A. The model then judges FIT among options already proven
  // to move the right way — it never compares prices.
  if (priceDirection) {
    const { ranked, unpriced, bestEffort, comparable } = rankByPriceDirection(
      candidates,
      target.priceLevel,
      priceDirection
    );
    // `ranked` is the WHOLE eligible set: a venue Places has no price for is
    // never handed back AS the pricier/cheaper answer, because nothing shows
    // it moves that way — the swap would be presenting an arbitrary venue as
    // a price result. This is NOT a keep-on-missing violation: that rule
    // forbids DROPPING a venue for a missing field, and it still governs
    // every ordinary swap and every filter rule (a plain "swap this" sees
    // these venues untouched, one case below pins it). Here price is the
    // question the user actually asked, so an unpriced venue is set aside for
    // being unanswerable, not for being incomplete.
    //
    // The earlier `ranked.length > 0 ? ranked : unpriced` fallback did hand
    // them back, and on a category Places prices for nobody — a park, an
    // attraction — EVERY candidate is unpriced, so "fancier" degraded to "any
    // venue at all": the exact arbitrary answer this block exists to prevent.
    logEvent("info", "swap_price_direction", {
      direction: priceDirection,
      currentPriceLevel: target.priceLevel ?? null,
      // no price on the CURRENT venue → nothing to compare against, so this
      // ranks every PRICED candidate by how extreme it is rather than refusing
      bestEffort,
      // ...which only works while some candidate is priced; `comparable`
      // false is the park case, and the first thing to check when a direction
      // swap refuses on a category that should have had prices
      comparable,
      candidates: candidates.length,
      rankedCount: ranked.length,
      unpricedCount: unpriced.length,
      outcome:
        ranked.length > 0
          ? "ranked"
          : comparable
          ? "refused_none_in_direction"
          : "refused_no_price_data",
    });
    if (ranked.length === 0) {
      const wanted = priceDirection === "up" ? "pricier" : "cheaper";
      return {
        swapped: false,
        // TWO refusals, because they report two different facts and only one
        // of them is a statement about price. With nothing priced to compare
        // against, "it's already the priciest" would be an assertion about
        // data we never had — and it reads as an outright lie on a $ venue.
        reason: !comparable
          ? `Can't compare prices for this ${poolKey} — none of the nearby options have a price listed, so I can't show you a ${wanted} one. Keeping ${target.name}.`
          : priceDirection === "up"
          ? `Couldn't find a ${poolKey} pricier than ${target.name} — it's already the priciest one I can find nearby.`
          : `Couldn't find a ${poolKey} cheaper than ${target.name} — it's already the cheapest one I can find nearby.`,
      };
    }
    candidates = ranked;
  }

  const selections = await deps.selectVenues(judgeParsed, { [poolKey]: candidates });
  const sel = selections.find((s) => s.category === poolKey);
  const pick = sel?.id ? candidates.find((p) => p.id === sel.id) : undefined;
  if (!sel || sel.id === null || !pick) {
    // an unmet hard constraint gets named, never hedged around
    const unmet = sel?.unmetConstraint;
    return {
      swapped: false,
      reason: unmet
        ? `Couldn't find a ${poolKey} that's really ${unmet} — keeping ${target.name}.`
        : noneFound,
    };
  }

  return finalize(
    itinerary,
    stopIndex,
    target,
    pick,
    sel,
    poolKey,
    target.start_time!,
    now,
    deps,
    path,
    sel.reason,
    base,
    floor,
    weather
  );
}

// ── TIME: move the anchor's slot, then resettle the tail. ──
async function timeChange(
  itinerary: Itinerary,
  stopIndex: number,
  target: ItineraryStop,
  interp: SwapInterpretation,
  base: ParsedPrompt,
  floor: Date,
  now: Date,
  deps: SwapDeps,
  weather: WeatherHour[] | null
): Promise<SwapResult> {
  const tz = itinerary.timeZone ?? DEFAULT_ZONE;
  const category = target.category;
  const shift = interp.time;
  if (!shift) {
    return { swapped: false, reason: "Couldn't tell what time you meant — try “after 8” or “an hour earlier”." };
  }

  let nd = new Date(target.start_time!);
  if (shift.mode === "relative") {
    // relative shift is a real-minute delta on the absolute instant
    nd = new Date(nd.getTime() + (shift.deltaMinutes ?? 0) * 60_000);
  } else if (shift.targetTime) {
    // absolute "to 6pm" sets the wall-clock hour in the PLAN's zone (not
    // the server's) on the stop's own local date
    const [h, m] = shift.targetTime.split(":").map(Number);
    nd = instantAtWallClock(nd, tz, h, m, 0, false);
  }
  const newStartMs = nd.getTime();

  // The plausible-hour refusal that used to sit here is GONE with the rest
  // of the gate: "a 4 AM dinner won't work" was a table's opinion, and a
  // wrong one next to a 24-hour diner. The move is still fully checked —
  // against FACTS. The floor and overlap guards below are arithmetic, and
  // `resettleTail` then re-runs the objective filter plus the availability
  // seam at every resulting arrival, so a genuinely closed target fails
  // with the honest "nothing open then" from real hours data instead.
  if (newStartMs <= floor.getTime()) {
    return { swapped: false, reason: `Can't move ${target.name} earlier than where the evening already is.` };
  }
  const timedIdx = timedIndexes(itinerary);
  const tp = timedIdx.indexOf(stopIndex);
  const prevStop = tp > 0 ? itinerary.stops[timedIdx[tp - 1]] : null;
  if (prevStop?.end_time && newStartMs < new Date(prevStop.end_time).getTime()) {
    return { swapped: false, reason: `That's too early — it runs into ${prevStop.name}.` };
  }

  const used = new Set<string>(itinerary.stops.map((s) => s.id).filter((id): id is string => !!id));

  // A time-swap moves the slot — it never resizes it, UNLESS the request
  // carried a duration half too ("start at 6pm for 2 hours"). Otherwise the
  // stop's own (possibly customized) duration is the source of truth; only
  // an adapted replacement venue resets to the category default (same
  // convention as resettleTail).
  //
  // Resolved HERE, ahead of the usability check below, because that check now
  // asks whether the venue is open for the whole slot and cannot answer that
  // without knowing how long the slot is. Only the ordering moved: a
  // `resolveNewTotal` refusal is a refusal either way, and plan-then-commit
  // means neither path has touched the itinerary yet.
  const { baseMinutes, bufferMinutes } = getDuration(category);
  const defaultTotal = baseMinutes + bufferMinutes;
  let requestedTotal: number | null = null;
  if (interp.duration) {
    const resolved = resolveNewTotal(category, target, interp.duration);
    if (!resolved.ok) return { swapped: false, reason: resolved.reason };
    requestedTotal = resolved.total;
  }
  const keptTotal = requestedTotal ?? target.durationMinutes?.total ?? defaultTotal;

  // (a) the anchor itself: keep its venue if usable at the new time, else
  // adapt, else notify.
  let anchorPick: Place | undefined;
  let anchorSel: Selection | undefined;
  if (
    !usableForProposal(
      placeOf(target),
      category,
      base,
      weather,
      now,
      nd,
      keptTotal,
      tz,
      deps
    )
  ) {
    const repl = await findReplacement(
      category,
      nd,
      used,
      base,
      now,
      deps,
      tz,
      weather
    );
    if (!repl) {
      return { swapped: false, reason: `Nothing similar to ${target.name} is open around ${clockLabel(nd, tz)}.` };
    }
    anchorPick = repl.pick;
    anchorSel = repl.sel;
    used.delete(target.id!);
    used.add(anchorPick.id);
  }
  const anchorLoc = anchorPick?.location ?? target.location ?? null;
  if (!validLocation(anchorLoc)) {
    return {
      swapped: false,
      reason: `The route into ${target.name} can't be verified because its location is missing.`,
    };
  }
  // an ADAPTED replacement venue resets to the category default; a kept venue
  // holds the length resolved above
  const anchorTotal = anchorPick ? defaultTotal : keptTotal;
  const anchorEnd = new Date(newStartMs + anchorTotal * 60_000);
  const anchorInboundPlan = await planAnchorInbound(
    itinerary,
    timedIdx,
    stopIndex,
    anchorLoc,
    nd,
    deps
  );
  if (!anchorInboundPlan) {
    return {
      swapped: false,
      reason: `The route into ${
        anchorPick?.displayName?.text ?? target.name
      } can't reach ${clockLabel(nd, tz)}.`,
    };
  }

  // (b) resettle the downstream tail from the anchor's new end (try →
  // adapt → notify). Reusable — duration-swaps will call this too.
  const settle = await resettleTail(
    itinerary,
    stopIndex,
    timedIdx,
    anchorEnd,
    anchorLoc,
    floor,
    now,
    base,
    deps,
    used,
    weather
  );
  if (!settle.ok) return { swapped: false, reason: settle.reason };

  // ── commit (only now that the whole tail fits) ──
  const before = snap(target);
  const anchorOutbound =
    settle.changes[0]?.inbound ?? settle.terminalInbound ?? null;
  itinerary.stops[stopIndex] = buildStop(
    category,
    toZonedISO(nd, tz),
    anchorPick ? { pick: anchorPick, sel: anchorSel! } : { keep: target },
    anchorOutbound,
    anchorTotal,
    tz
  );
  commitAnchorInbound(itinerary, anchorInboundPlan);
  commitTail(itinerary, settle.changes, settle.terminalInbound);

  rebuildLegs(itinerary);
  withStatuses(itinerary, now);

  let reason = `Moved ${category} to ${clockLabel(nd, tz)}`;
  if (requestedTotal && !anchorPick) reason += ` for ${durLabel(requestedTotal)}`;
  if (anchorPick) reason += `, now ${anchorPick.displayName?.text ?? "a spot that's open then"}`;
  if (settle.changes.some((c) => c.venue)) reason += ` (and moved a later stop to something open then)`;
  reason += ".";

  return {
    swapped: true,
    stopIndex,
    path: "time",
    before,
    after: snap(itinerary.stops[stopIndex]),
    reason,
    downstreamShifted: settle.changes
      .filter((change) => change.moved)
      .map((change) => change.stopIndex),
  };
}

// ── The try → adapt → notify ladder, reusable by any change that moves a
// stop's end time (time-swaps now, duration-swaps next). Given the anchor's
// new end + location, it re-chains each downstream stop: try to keep its
// venue at the new arrival; if it's not usable then, ADAPT by re-searching
// an equivalent; if nothing adapts, NOTIFY (ok:false with the real reason).
// Locked/past stops are never moved. Returns a plan; the caller commits. ──
interface TailChange {
  stopIndex: number;
  startISO: string;
  totalMinutes: number; // this stop's duration (preserved when kept)
  inbound: TravelLeg; // leg into this stop from its predecessor
  moved: boolean;
  venue?: Place; // set only when the stop was adapted
  sel?: Selection;
}

async function resettleTail(
  itinerary: Itinerary,
  anchorIndex: number,
  timedIdx: number[],
  anchorEnd: Date,
  anchorLoc: LatLng | null,
  floor: Date,
  now: Date,
  base: ParsedPrompt,
  deps: SwapDeps,
  used: Set<string>,
  weather: WeatherHour[] | null,
  preserveCommittedStarts = false
): Promise<
  | {
      ok: true;
      changes: TailChange[];
      terminalInbound: TravelLeg | null;
    }
  | { ok: false; reason: string }
> {
  const tz = itinerary.timeZone ?? DEFAULT_ZONE;
  const anchorPos = timedIdx.indexOf(anchorIndex);
  const changes: TailChange[] = [];
  let prevEndMs = anchorEnd.getTime();
  let prevLoc = anchorLoc;

  if (anchorPos < 0 || !validLocation(prevLoc) || !Number.isFinite(prevEndMs)) {
    return {
      ok: false,
      reason: "The updated route is missing a location or time boundary.",
    };
  }

  for (let k = anchorPos + 1; k < timedIdx.length; k++) {
    const di = timedIdx[k];
    const stop = itinerary.stops[di];
    // Never move a locked/past stop. The proposal still has to prove the
    // newly routed prefix can reach that committed boundary without overlap.
    if (!stop.start_time || !validLocation(stop.location)) {
      return {
        ok: false,
        reason: `The route into ${
          stop.name ?? stop.category
        } can't be verified because its location or time is missing.`,
      };
    }

    const committedStartMs = new Date(stop.start_time).getTime();
    if (!Number.isFinite(committedStartMs)) {
      return {
        ok: false,
        reason: `The route into ${stop.name ?? stop.category} has an invalid time boundary.`,
      };
    }
    const fromIndex = k - 1;
    const committedOrLocked =
      stop.locked || committedStartMs <= floor.getTime();

    if (committedOrLocked) {
      const boundaryEndMs = stop.end_time
        ? new Date(stop.end_time).getTime()
        : Number.NaN;
      const boundaryInbound = await proposalLeg(
        deps,
        prevLoc,
        stop.location,
        fromIndex,
        new Date(prevEndMs).toISOString()
      );
      if (
        !boundaryInbound ||
        !Number.isFinite(committedStartMs) ||
        !Number.isFinite(boundaryEndMs) ||
        boundaryEndMs < committedStartMs ||
        prevEndMs + boundaryInbound.totalMinutes * 60_000 >
          committedStartMs
      ) {
        return {
          ok: false,
          reason: `The change would run into locked stop ${
            stop.name ?? stop.category
          }.`,
        };
      }
      return {
        ok: true,
        changes,
        terminalInbound: boundaryInbound,
      };
    }

    let inbound = await proposalLeg(
      deps,
      prevLoc,
      stop.location,
      fromIndex,
      new Date(prevEndMs).toISOString()
    );
    if (!inbound) {
      return {
        ok: false,
        reason: `The route into ${
          stop.name ?? stop.category
        } couldn't be verified.`,
      };
    }
    let startMs = prevEndMs + inbound.totalMinutes * 60_000;
    if (preserveCommittedStarts) {
      startMs = Math.max(startMs, committedStartMs);
    }
    let venue: Place | undefined;
    let sel: Selection | undefined;

    // This stop's length, resolved BEFORE the usability checks below because
    // they now ask whether the venue is open for the whole slot. The rule is
    // the one the commit at the bottom of this loop already applied: a KEPT
    // stop holds its own (possibly customized) duration, an ADAPTED
    // replacement takes the category default.
    const stopDefaults = getDuration(stop.category);
    const stopDefaultTotal =
      stopDefaults.baseMinutes + stopDefaults.bufferMinutes;
    const keptTotal = stop.durationMinutes?.total ?? stopDefaultTotal;

    // Did THIS swap actually reschedule the stop? `preserveCommittedStarts`
    // holds a downstream stop at its committed time whenever the change in
    // front of it did not overflow; that stop is untouched and is judged on
    // arrival, as it was planned. One the swap genuinely moves is a stop whose
    // times the swap now owns, so its whole new slot is re-validated.
    const movedByThisSwap = startMs !== committedStartMs;

    // try the existing venue; adapt if it isn't usable by the new arrival
    if (
      !usableForProposal(
        placeOf(stop),
        stop.category,
        base,
        weather,
        now,
        new Date(startMs),
        movedByThisSwap ? keptTotal : ARRIVAL_ONLY,
        tz,
        deps
      )
    ) {
      const attempted = new Set(used);
      let replacementFound = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const repl = await findReplacement(
          stop.category,
          new Date(startMs),
          attempted,
          base,
          now,
          deps,
          tz,
          weather
        );
        if (!repl || !validLocation(repl.pick.location)) break;
        const candidateInbound = await proposalLeg(
          deps,
          prevLoc,
          repl.pick.location,
          fromIndex,
          new Date(prevEndMs).toISOString()
        );
        if (!candidateInbound) {
          attempted.add(repl.pick.id);
          continue;
        }
        let candidateStartMs =
          prevEndMs + candidateInbound.totalMinutes * 60_000;
        if (preserveCommittedStarts) {
          candidateStartMs = Math.max(
            candidateStartMs,
            committedStartMs
          );
        }
        if (
          !usableForProposal(
            repl.pick,
            stop.category,
            base,
            weather,
            now,
            new Date(candidateStartMs),
            stopDefaultTotal,
            tz,
            deps
          )
        ) {
          attempted.add(repl.pick.id);
          continue;
        }
        venue = repl.pick;
        sel = repl.sel;
        inbound = candidateInbound;
        startMs = candidateStartMs;
        used.add(venue.id);
        replacementFound = true;
        break;
      }
      if (!replacementFound) {
        return {
          ok: false,
          reason: `Nothing similar to ${stop.name} is open by ${clockLabel(
            new Date(startMs),
            tz
          )}.`,
        };
      }
    }

    // keep the stop's own duration when it's kept (a prior duration-swap
    // must survive a later reflow); an adapted venue takes the default.
    // Both were resolved above, where the slot-length checks needed them.
    const totalMinutes = venue ? stopDefaultTotal : keptTotal;
    const endMs = startMs + totalMinutes * 60_000;
    const startISO = toZonedISO(new Date(startMs), tz);
    changes.push({
      stopIndex: di,
      startISO,
      totalMinutes,
      inbound,
      moved: startISO !== stop.start_time || !!venue,
      venue,
      sel,
    });
    prevEndMs = endMs;
    prevLoc = venue?.location ?? stop.location;
  }
  return { ok: true, changes, terminalInbound: null };
}

function commitTail(
  itinerary: Itinerary,
  changes: TailChange[],
  terminalInbound: TravelLeg | null
) {
  const tz = itinerary.timeZone ?? DEFAULT_ZONE;
  changes.forEach((ch, k) => {
    const existing = itinerary.stops[ch.stopIndex];
    const outbound =
      changes[k + 1]?.inbound ??
      (k === changes.length - 1 ? terminalInbound : null);
    itinerary.stops[ch.stopIndex] = buildStop(
      existing.category,
      ch.startISO,
      ch.venue ? { pick: ch.venue, sel: ch.sel! } : { keep: existing },
      outbound,
      ch.totalMinutes,
      tz
    );
  });
}

// Re-search a category for a venue usable at `when`, excluding used ids.
async function findReplacement(
  category: string,
  when: Date,
  excluded: Set<string>,
  base: ParsedPrompt,
  now: Date,
  deps: SwapDeps,
  timeZone: string = DEFAULT_ZONE,
  weather: WeatherHour[] | null = null
): Promise<{ sel: Selection; pick: Place } | null> {
  const parsed = scoped(base, {}, category);
  const rawPools = await deps.searchPools(parsed, [category]);
  const { pools } = filterPools(rawPools, parsed, weather, now, when, timeZone);
  // A replacement always takes the category's default length (the convention
  // every caller applies on adapt), so that is the slot it has to stay open
  // through — screening here keeps a closes-mid-slot venue from being proposed
  // and then rejected a few lines later by the caller's own check.
  const replacementDefaults = getDuration(category);
  const replacementTotal =
    replacementDefaults.baseMinutes + replacementDefaults.bufferMinutes;
  const candidates = (pools[category] ?? []).filter(
    (p) =>
      !excluded.has(p.id) &&
      validLocation(p.location) &&
      deps.isUsableAt(p, when, category, timeZone) &&
      usableThroughSlot(p, category, when, replacementTotal, timeZone, deps)
  );
  if (candidates.length === 0) return null;
  const sels = await deps.selectVenues(parsed, { [category]: candidates });
  const sel = sels.find((s) => s.category === category);
  const pick = sel?.id ? candidates.find((p) => p.id === sel.id) : undefined;
  return sel && pick ? { sel, pick } : null;
}

// Build a stop object from a fresh pick or a kept venue, at startISO.
// durationOverride sets a custom total (a duration-swap); its base is the
// override minus the category's buffer, so the buffer is preserved.
function buildStop(
  category: string,
  startISO: string,
  src: { pick: Place; sel: Selection } | { keep: ItineraryStop },
  outbound: TravelLeg | null,
  durationOverride?: number,
  timeZone: string = DEFAULT_ZONE
): ItineraryStop {
  const def = getDuration(category);
  const total = durationOverride ?? def.baseMinutes + def.bufferMinutes;
  const buffer = durationOverride ? Math.min(def.bufferMinutes, total) : def.bufferMinutes;
  const baseMinutes = total - buffer;
  const bufferMinutes = buffer;
  const endISO = toZonedISO(new Date(new Date(startISO).getTime() + total * 60_000), timeZone);
  const picked = "pick" in src ? src : null;
  const kept = "keep" in src ? src.keep : null;
  return {
    category,
    id: picked ? picked.pick.id : kept!.id!,
    name: picked ? picked.pick.displayName?.text ?? picked.sel.name : kept!.name,
    reason: picked ? picked.sel.reason : kept!.reason,
    ...(picked?.sel.fallback ? { fallback: true } : {}),
    rating: picked ? picked.pick.rating : kept!.rating,
    priceLevel: picked ? picked.pick.priceLevel : kept!.priceLevel,
    description: picked ? picked.pick.editorialSummary?.text : kept!.description,
    currentOpeningHours: picked
      ? picked.pick.currentOpeningHours
      : kept!.currentOpeningHours,
    location: picked ? picked.pick.location : kept!.location,
    start_time: startISO,
    end_time: endISO,
    durationMinutes: { base: baseMinutes, buffer: bufferMinutes, total },
    ...(outbound ? { travelToNext: outbound, travelMinutesToNext: outbound.totalMinutes } : {}),
    status: "upcoming",
    locked: false,
  };
}

function scoped(
  base: ParsedPrompt,
  over: { aesthetic?: string; budget?: string | null; constraints?: string[] },
  category: string
): ParsedPrompt {
  return {
    ...base,
    aesthetic: over.aesthetic ?? base.aesthetic,
    budget: over.budget !== undefined ? over.budget : base.budget,
    constraints: over.constraints ?? base.constraints,
    category_signals: [category],
  };
}

// ── Shared write-back: place the pick at startISO, recompute duration +
// legs, shift the downstream tail only when it overflows. ──
async function finalize(
  itinerary: Itinerary,
  stopIndex: number,
  target: ItineraryStop,
  pick: Place,
  sel: Selection,
  category: string,
  startISO: string,
  now: Date,
  deps: SwapDeps,
  path: "refilter" | "research" | "time",
  reason: string,
  base: ParsedPrompt,
  floor: Date,
  weather: WeatherHour[] | null
): Promise<SwapResult> {
  const tz = itinerary.timeZone ?? DEFAULT_ZONE;
  const before = snap(target);
  // Same rule as timeChange: once customized, the stop's own duration is
  // the source of truth — a venue swap holds the WHOLE slot, length
  // included. A category change ("dinner" → "bar") invalidates the old
  // length, so it falls back to the new category's default.
  const def = getDuration(category);
  const defaultTotal = def.baseMinutes + def.bufferMinutes;
  const total =
    category === target.category
      ? target.durationMinutes?.total ?? defaultTotal
      : defaultTotal;
  const newLoc = pick.location;
  const start = new Date(startISO);
  if (
    !validLocation(newLoc) ||
    !Number.isFinite(start.getTime()) ||
    !usableForProposal(
      pick,
      category,
      base,
      weather,
      now,
      start,
      total,
      tz,
      deps
    )
  ) {
    return {
      swapped: false,
      reason: `The replacement for ${target.name} isn't usable in that slot.`,
    };
  }

  const timedIdx = timedIndexes(itinerary);
  const inbound = await planAnchorInbound(
    itinerary,
    timedIdx,
    stopIndex,
    newLoc,
    start,
    deps
  );
  if (!inbound) {
    return {
      swapped: false,
      reason: `The replacement can't be reached by ${clockLabel(
        start,
        tz
      )} without moving the slot.`,
    };
  }
  const used = new Set<string>(
    itinerary.stops
      .map((stop) => stop.id)
      .filter((id): id is string => !!id)
  );
  if (target.id) used.delete(target.id);
  used.add(pick.id);
  const anchorEnd = new Date(start.getTime() + total * 60_000);
  const settle = await resettleTail(
    itinerary,
    stopIndex,
    timedIdx,
    anchorEnd,
    newLoc,
    floor,
    now,
    base,
    deps,
    used,
    weather,
    true
  );
  if (!settle.ok) return { swapped: false, reason: settle.reason };
  const outbound =
    settle.changes[0]?.inbound ?? settle.terminalInbound ?? null;

  // one stop-construction path: buildStop already owns the field set, the
  // buffer clamp, and the duration override, so finalize no longer keeps a
  // parallel copy of all three (code-audit 2026-07-18 §5.5)
  itinerary.stops[stopIndex] = buildStop(
    category,
    startISO,
    { pick, sel },
    outbound,
    total,
    tz
  );

  commitAnchorInbound(itinerary, inbound);
  commitTail(itinerary, settle.changes, settle.terminalInbound);
  const downstreamShifted = settle.changes
    .filter((change) => change.moved)
    .map((change) => change.stopIndex);
  rebuildLegs(itinerary);

  withStatuses(itinerary, now);

  return {
    swapped: true,
    stopIndex,
    path,
    before,
    after: snap(itinerary.stops[stopIndex]),
    reason,
    downstreamShifted,
  };
}
