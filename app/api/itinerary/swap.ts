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
import { selectVenues as realSelectVenues, Selection } from "../select/selectVenues";
import { getDuration } from "../schedule/durations";
import { toZonedISO, isPlausibleAt, bandForCategories, hourInBand } from "../schedule/schedule";
import { DEFAULT_ZONE, instantAtWallClock, wallClockParts } from "../../lib/zoneTime";
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
const MODEL = "llama-3.3-70b-versatile";

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

const REFINE_SYSTEM = `You adjust ONE stop of an existing day plan from a short complaint. You get the stop's current settings (category, aesthetic, budget, constraints) and its current start time, plus the complaint. Classify the user's INTENT and return the parameters to act on it.

"intent":
- "time": the complaint is about WHEN. Return a "time" object.
   - RELATIVE ("an hour earlier", "30 min later", "a bit earlier", "much later"): set { "mode": "relative", "deltaMinutes": N } where N is signed minutes (earlier is NEGATIVE, later is POSITIVE). Exact amounts parse exactly (an hour = 60, half an hour = 30, "45 min" = 45). Vague amounts ("a bit", "a little", "somewhat", "slightly") default to 30. "much"/"way" can be 60–90.
   - ABSOLUTE ("after 8", "at 7:30", "by 9", "make it 7"): set { "mode": "absolute", "targetTime": "HH:MM" } in 24h. Assume the plan's part of day (an evening plan means PM).
- "duration": the complaint is about HOW LONG they stay at this stop. Return a "duration" object.
   - ABSOLUTE ("stay 2 hours", "make it 90 minutes", "just an hour here"): set { "mode": "absolute", "targetMinutes": N }.
   - RELATIVE ("stay longer", "more time here", "shorter", "less time", "an extra hour"): set { "mode": "relative", "deltaMinutes": N } (longer is POSITIVE, shorter NEGATIVE). "an extra hour" = 60, "a lot longer" = 60; vague "longer"/"shorter" default to ±30.
- "constraint": the complaint needs a different KIND of venue by feature/location — "with a patio", "near the water", "somewhere quieter that's outdoors". Set path "research", fold the feature into "constraints".
- "venue": the complaint is about the venue's quality/price/style in the SAME slot — "don't like it", "cheaper", "less fancy", "higher rated". Set path "refilter" (narrows the same pool) unless it needs different venues, then "research".

Rules:
- Keep "category" the same unless the complaint clearly changes the kind of place.
- Put budget words into "budget"; vibe/feature words into "constraints".
- Preserve still-relevant original constraints; drop ones the complaint overrides.

Respond with ONLY this JSON, no prose:
{ "intent": "venue"|"time"|"constraint"|"duration", "path": "refilter"|"research", "category": string, "aesthetic": string, "budget": string|null, "constraints": string[], "time": { "mode": "relative"|"absolute", "deltaMinutes": number, "targetTime": string } | null, "duration": { "mode": "relative"|"absolute", "deltaMinutes": number, "targetMinutes": number } | null }`;

// Deterministic fallback for time expressions, so common relative phrases
// resolve even if the model whiffs. Earlier is negative, later positive.
export function parseTimeExpr(text: string, category?: string): TimeShift | null {
  const s = text.toLowerCase();
  // The PM assumption below is right for most stops but was applied blind:
  // on a BRUNCH stop "make it 10" became 22:00, which the plausible-band
  // guard then refused with "A 10:00 PM brunch won't work" — a confusing
  // answer to a request that plainly meant 10 AM. When the stop's category
  // has a known band, prefer the reading that fits it (§7.3).
  const band = category ? bandForCategories([category]) : null;

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
      const amFits = band ? hourInBand(h, band) : false;
      const pmFits = band ? hourInBand(h + 12, band) : true;
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
  const fallback: SwapInterpretation = {
    intent: "venue",
    path: "refilter",
    category,
    aesthetic: parsed.aesthetic,
    budget: parsed.budget,
    constraints: [...(parsed.constraints ?? []), refinement],
    time: null,
    duration: null,
  };
  // Trust the local parsers as the floor — the model can only refine
  // arithmetic requests, never lose them. Duration wins over time.
  const localDuration = parseDurationExpr(refinement);
  const localTime = parseTimeExpr(refinement, category);
  const localFallback = (): SwapInterpretation =>
    localDuration && localTime
      ? { ...fallback, intent: "time", time: localTime, duration: localDuration }
      : localDuration
      ? { ...fallback, intent: "duration", duration: localDuration }
      : localTime
      ? { ...fallback, intent: "time", time: localTime }
      : fallback;
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
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
    const data = await res.json();
    if (!res.ok) return localFallback();
    const out = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
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
  if (isMockMode()) return mockSwapDeps(parseTimeExpr, parseDurationExpr);
  return {
    interpret: (parsed, category, currentStartISO, refinement) =>
      interpretRefinement(process.env.GROQ_API_KEY ?? "", parsed, category, currentStartISO, refinement),
    searchPools: (parsed, categories) =>
      realSearchPools(process.env.GOOGLE_PLACES_API_KEY ?? "", parsed, categories),
    selectVenues: (parsed, pools) =>
      realSelectVenues(process.env.GROQ_API_KEY ?? "", parsed, pools),
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

// A Place view of a stored stop — for the availability check. Stored stops
// carry no hours, so by default they read as usable (keep-on-missing).
function placeOf(stop: ItineraryStop): Place {
  return {
    id: stop.id ?? "",
    displayName: stop.name ? { text: stop.name } : undefined,
    rating: stop.rating,
    location: stop.location,
  };
}

/** Forecast for the plan's origin, or null when there's nothing to ask
 *  about (pre-multi-city plans carry no home) — keep-on-missing. */
async function weatherFor(itinerary: Itinerary, deps: SwapDeps): Promise<WeatherHour[] | null> {
  const origin = itinerary.home?.location;
  return origin ? deps.getWeather(origin.latitude, origin.longitude) : null;
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

  withStatuses(itinerary, now);
  const floor = floorTime(itinerary, now);

  const target = itinerary.stops[stopIndex];
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
  const base = itinerary.parsed ?? fallbackParsedFor(itinerary);
  if (!base) return { swapped: false, reason: UNKNOWN_LOCATION_MESSAGE };
  const interp = await deps.interpret(base, target.category, target.start_time, refinement);

  // observability at the apply step (like the weather-gate log): parsed
  // intent + the stop's start/duration before vs after, so a swap that
  // silently rewrites the wrong field is visible in the server log
  const beforeStart = target.start_time;
  const beforeTotal = target.durationMinutes?.total ?? null;

  let result: SwapResult;
  if (interp.intent === "time") {
    result = await timeChange(itinerary, stopIndex, target, interp, base, floor, now, deps);
  } else if (interp.intent === "duration") {
    result = await durationChange(itinerary, stopIndex, target, interp, base, floor, now, deps);
  } else {
    result = await venueSwap(itinerary, stopIndex, target, interp, base, floor, now, deps, refinement);
  }

  const after = result.swapped ? itinerary.stops[result.stopIndex] : null;
  console.log(
    `[swap-apply] refinement="${refinement}" intent=${interp.intent} ` +
      `time=${JSON.stringify(interp.time)} duration=${JSON.stringify(interp.duration)} | ` +
      `before start=${beforeStart} total=${beforeTotal} | ` +
      (after
        ? `after start=${after.start_time} total=${after.durationMinutes?.total ?? null}`
        : `REFUSED: ${(result as { reason: string }).reason}`)
  );
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
  deps: SwapDeps
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
  const anchorEnd = new Date(new Date(startISO).getTime() + newTotal * 60_000);

  const timedIdx = timedIndexes(itinerary);
  const used = new Set<string>(itinerary.stops.map((s) => s.id).filter((id): id is string => !!id));

  // resettle downstream from the new end (start + venue unchanged, so the
  // inbound leg into this stop is untouched)
  const settle = await resettleTail(itinerary, stopIndex, timedIdx, anchorEnd, target.location ?? null, floor, now, base, deps, used);
  if (!settle.ok) return { swapped: false, reason: settle.reason };

  const before = snap(target);
  const anchorOutbound = settle.changes[0]?.inbound ?? target.travelToNext ?? null;
  itinerary.stops[stopIndex] = buildStop(category, startISO, { keep: target }, anchorOutbound, newTotal, tz);
  commitTail(itinerary, settle.changes);
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
    downstreamShifted: settle.changes.map((c) => c.stopIndex),
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
  refinement: string
): Promise<SwapResult> {
  const poolKey = interp.path === "research" ? interp.category : target.category;
  const searchParsed =
    interp.path === "refilter"
      ? scoped(base, {}, poolKey)
      : scoped(base, { aesthetic: interp.aesthetic, budget: interp.budget, constraints: interp.constraints }, poolKey);
  const judgeParsed = scoped(base, { aesthetic: interp.aesthetic, budget: interp.budget, constraints: interp.constraints }, poolKey);

  const tz = itinerary.timeZone ?? DEFAULT_ZONE;
  const rawPools = await deps.searchPools(searchParsed, [poolKey]);
  // a swap must not move an outdoor stop into the rain either (§7.6)
  const wx = await weatherFor(itinerary, deps);
  const { pools: filtered } = filterPools(rawPools, judgeParsed, wx, now, new Date(target.start_time!), tz);

  // never re-pick the rejected venue, nor anything already used elsewhere
  const excluded = new Set<string>(
    itinerary.stops
      .map((s, i) => (i === stopIndex ? target.id : s.id))
      .filter((id): id is string => id !== null)
  );
  let candidates = (filtered[poolKey] ?? []).filter((p) => !excluded.has(p.id));
  if (candidates.length === 0) {
    return { swapped: false, reason: `Couldn't find another ${target.category} that fits — keeping ${target.name}.` };
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
        : `Couldn't find another ${target.category} that fits — keeping ${target.name}.`,
    };
  }

  return finalize(itinerary, stopIndex, target, pick, sel, poolKey, target.start_time!, now, deps, interp.path, sel.reason);
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
  deps: SwapDeps
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

  // guards (plausible hour first so "dinner at 4am" gives the real reason)
  if (!isPlausibleAt(nd, [category], tz)) {
    return { swapped: false, reason: `A ${clockLabel(nd, tz)} ${category} won't work — nothing's really open then.` };
  }
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

  // (a) the anchor itself: keep its venue if usable at the new time, else
  // adapt, else notify.
  let anchorPick: Place | undefined;
  let anchorSel: Selection | undefined;
  if (!deps.isUsableAt(placeOf(target), nd, category, tz)) {
    const repl = await findReplacement(category, nd, used, base, now, deps, tz, await weatherFor(itinerary, deps));
    if (!repl) {
      return { swapped: false, reason: `Nothing similar to ${target.name} is open around ${clockLabel(nd, tz)}.` };
    }
    anchorPick = repl.pick;
    anchorSel = repl.sel;
    used.delete(target.id!);
    used.add(anchorPick.id);
  }
  const anchorLoc = anchorPick?.location ?? target.location ?? null;
  // A time-swap moves the slot — it never resizes it, UNLESS the request
  // carried a duration half too ("start at 6pm for 2 hours"). Otherwise the
  // stop's own (possibly customized) duration is the source of truth; only
  // an adapted replacement venue resets to the category default (same
  // convention as resettleTail).
  const { baseMinutes, bufferMinutes } = getDuration(category);
  const defaultTotal = baseMinutes + bufferMinutes;
  let requestedTotal: number | null = null;
  if (interp.duration) {
    const resolved = resolveNewTotal(category, target, interp.duration);
    if (!resolved.ok) return { swapped: false, reason: resolved.reason };
    requestedTotal = resolved.total;
  }
  const anchorTotal = anchorPick
    ? defaultTotal
    : requestedTotal ?? target.durationMinutes?.total ?? defaultTotal;
  const anchorEnd = new Date(newStartMs + anchorTotal * 60_000);

  // (b) resettle the downstream tail from the anchor's new end (try →
  // adapt → notify). Reusable — duration-swaps will call this too.
  const settle = await resettleTail(itinerary, stopIndex, timedIdx, anchorEnd, anchorLoc, floor, now, base, deps, used);
  if (!settle.ok) return { swapped: false, reason: settle.reason };

  // ── commit (only now that the whole tail fits) ──
  const before = snap(target);
  let anchorInbound: TravelLeg | null = null;
  if (anchorLoc) {
    anchorInbound = await deps.getSingleLeg(
      prevStop?.location ?? itinerary.home?.location ?? HOME.location,
      anchorLoc,
      prevStop ? tp - 1 : HOME_LEG_INDEX,
      prevStop?.end_time ?? undefined,
      false
    );
  }
  const anchorOutbound = settle.changes[0]?.inbound ?? null;
  itinerary.stops[stopIndex] = buildStop(
    category,
    toZonedISO(nd, tz),
    anchorPick ? { pick: anchorPick, sel: anchorSel! } : { keep: target },
    anchorOutbound,
    anchorTotal,
    tz
  );
  if (prevStop && anchorInbound) {
    prevStop.travelToNext = anchorInbound;
    prevStop.travelMinutesToNext = anchorInbound.totalMinutes;
  } else if (!prevStop && anchorInbound && itinerary.homeLeg) {
    itinerary.homeLeg = { ...anchorInbound, fromIndex: HOME_LEG_INDEX };
  }
  commitTail(itinerary, settle.changes);

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
    downstreamShifted: settle.changes.map((c) => c.stopIndex),
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
  used: Set<string>
): Promise<{ ok: true; changes: TailChange[] } | { ok: false; reason: string }> {
  const tz = itinerary.timeZone ?? DEFAULT_ZONE;
  const anchorPos = timedIdx.indexOf(anchorIndex);
  const changes: TailChange[] = [];
  let prevEndMs = anchorEnd.getTime();
  let prevLoc = anchorLoc;

  for (let k = anchorPos + 1; k < timedIdx.length; k++) {
    const di = timedIdx[k];
    const stop = itinerary.stops[di];
    // never move locked/past stops — stop reflowing at the first one
    if (stop.locked || !stop.start_time || new Date(stop.start_time).getTime() <= floor.getTime()) break;
    if (!prevLoc || !stop.location) break;

    const fromIndex = k - 1; // leg from the previous timed stop into this one
    let inbound = await deps.getSingleLeg(prevLoc, stop.location, fromIndex, new Date(prevEndMs).toISOString(), false);
    let startMs = prevEndMs + inbound.totalMinutes * 60_000;
    let venue: Place | undefined;
    let sel: Selection | undefined;

    // try the existing venue; adapt if it isn't usable by the new arrival
    if (!deps.isUsableAt(placeOf(stop), new Date(startMs), stop.category, tz)) {
      const repl = await findReplacement(stop.category, new Date(startMs), used, base, now, deps, tz, await weatherFor(itinerary, deps));
      if (!repl) {
        return { ok: false, reason: `Nothing similar to ${stop.name} is open by ${clockLabel(new Date(startMs), tz)}.` };
      }
      venue = repl.pick;
      sel = repl.sel;
      used.add(venue.id);
      inbound = await deps.getSingleLeg(prevLoc, venue.location!, fromIndex, new Date(prevEndMs).toISOString(), false);
      startMs = prevEndMs + inbound.totalMinutes * 60_000;
    }

    // keep the stop's own duration when it's kept (a prior duration-swap
    // must survive a later reflow); an adapted venue takes the default.
    const { baseMinutes, bufferMinutes } = getDuration(stop.category);
    const defaultTotal = baseMinutes + bufferMinutes;
    const totalMinutes = venue ? defaultTotal : stop.durationMinutes?.total ?? defaultTotal;
    const endMs = startMs + totalMinutes * 60_000;
    changes.push({ stopIndex: di, startISO: toZonedISO(new Date(startMs), tz), totalMinutes, inbound, venue, sel });
    prevEndMs = endMs;
    prevLoc = venue?.location ?? stop.location;
  }
  return { ok: true, changes };
}

function commitTail(itinerary: Itinerary, changes: TailChange[]) {
  const tz = itinerary.timeZone ?? DEFAULT_ZONE;
  changes.forEach((ch, k) => {
    const existing = itinerary.stops[ch.stopIndex];
    const outbound = changes[k + 1]?.inbound ?? existing.travelToNext ?? null;
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
  const candidates = (pools[category] ?? []).filter(
    (p) => !excluded.has(p.id) && deps.isUsableAt(p, when, category, timeZone)
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
  reason: string
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
  const bufferMinutes = Math.min(def.bufferMinutes, total);
  const baseMinutes = total - bufferMinutes;
  const newLoc = pick.location ?? target.location;
  const endISO = toZonedISO(new Date(new Date(startISO).getTime() + total * 60_000), tz);

  const timedIdx = timedIndexes(itinerary);
  const tp = timedIdx.indexOf(stopIndex);
  const prevStop = tp > 0 ? itinerary.stops[timedIdx[tp - 1]] : null;
  const nextStop = tp < timedIdx.length - 1 ? itinerary.stops[timedIdx[tp + 1]] : null;

  let inbound: TravelLeg | null = null;
  if (newLoc) {
    inbound = await deps.getSingleLeg(
      prevStop?.location ?? itinerary.home?.location ?? HOME.location,
      newLoc,
      prevStop ? tp - 1 : HOME_LEG_INDEX,
      prevStop?.end_time ?? undefined,
      false
    );
  }
  let outbound: TravelLeg | null = null;
  if (nextStop?.location && newLoc) {
    outbound = await deps.getSingleLeg(newLoc, nextStop.location, tp, endISO, false);
  }

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

  if (prevStop && inbound) {
    prevStop.travelToNext = inbound;
    prevStop.travelMinutesToNext = inbound.totalMinutes;
  } else if (!prevStop && inbound && itinerary.homeLeg) {
    itinerary.homeLeg = { ...inbound, fromIndex: HOME_LEG_INDEX };
  }

  const floor = floorTime(itinerary, now);
  const downstreamShifted: number[] = [];
  if (nextStop && outbound && nextStop.start_time) {
    const requiredNextMs = new Date(endISO).getTime() + outbound.totalMinutes * 60_000;
    const deltaMs = requiredNextMs - new Date(nextStop.start_time).getTime();
    if (deltaMs > 0) {
      for (let k = tp + 1; k < timedIdx.length; k++) {
        const s = itinerary.stops[timedIdx[k]];
        // STOP at the first locked/past stop, don't skip over it. `continue`
        // kept shifting the stops BEYOND a locked one, so an earlier stop
        // could be pushed into the locked stop's slot — the ratchet held,
        // but the chain stopped being consistent. resettleTail has always
        // used break for this same condition (code-audit §2.3).
        if (s.locked || !s.start_time || new Date(s.start_time).getTime() <= floor.getTime()) break;
        s.start_time = toZonedISO(new Date(new Date(s.start_time).getTime() + deltaMs), tz);
        if (s.end_time) s.end_time = toZonedISO(new Date(new Date(s.end_time).getTime() + deltaMs), tz);
        downstreamShifted.push(timedIdx[k]);
      }
    }
  }

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
