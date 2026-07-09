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
import { Itinerary, ItineraryStop, withStatuses, floorTime } from "./store";
import { filterPools, ParsedPrompt, Place } from "../places/search/filter";
import { searchPools as realSearchPools } from "../places/search/searchPlaces";
import { selectVenues as realSelectVenues, Selection } from "../select/selectVenues";
import { getDuration } from "../schedule/durations";
import { toTorontoISO, isPlausibleAt } from "../schedule/schedule";
import { isOpenAt } from "../places/search/hours";
import {
  getSingleLeg as realGetSingleLeg,
  LatLng,
  TravelLeg,
} from "../schedule/travel";
import { HOME, HOME_LEG_INDEX } from "../schedule/home";
import { isMockMode, mockSwapDeps } from "../_mock/fixtures";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

export type SwapIntent = "venue" | "time" | "constraint" | "duration";

// A parsed time request: relative ("an hour earlier" → -60) or absolute
// ("after 8" → 20:00). Vague amounts default to a 30-min step upstream.
export interface TimeShift {
  mode: "relative" | "absolute";
  deltaMinutes?: number; // relative
  targetTime?: string; // absolute, 24h "HH:MM"
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
  // touching the swap flow.
  isUsableAt: (place: Place, when: Date, category: string) => boolean;
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
export function parseTimeExpr(text: string): TimeShift | null {
  const s = text.toLowerCase();

  // absolute: "after 8", "at 7:30", "by 9(pm)"
  const abs = s.match(/\b(?:after|at|by|around|make it)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (abs) {
    let h = parseInt(abs[1], 10);
    const m = abs[2] ? parseInt(abs[2], 10) : 0;
    const ap = abs[3];
    if (ap === "pm" && h < 12) h += 12;
    else if (ap === "am" && h === 12) h = 0;
    // no am/pm and a small hour on an evening plan → assume PM
    else if (!ap && h >= 1 && h <= 11) h += 12;
    if (h >= 0 && h <= 24 && m >= 0 && m < 60) {
      return { mode: "absolute", targetTime: `${String(h % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}` };
    }
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
  if (/\b(much|way|a lot)\b/.test(s)) return { mode: "relative", deltaMinutes: sign * 60 };
  // vague ("a bit", "a little", "somewhat", "slightly", bare "earlier/later")
  return { mode: "relative", deltaMinutes: sign * 30 };
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

async function interpretRefinement(
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
  const localTime = parseTimeExpr(refinement);
  const localFallback = (): SwapInterpretation =>
    localDuration
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
    // phrase is a duration/time request even if the model called it a venue
    if (localDuration) intent = "duration";
    else if (localTime) intent = "time";

    let time: TimeShift | null = null;
    if (intent === "time") {
      const t = out.time;
      if (t?.mode === "relative" && typeof t.deltaMinutes === "number") {
        time = { mode: "relative", deltaMinutes: t.deltaMinutes };
      } else if (t?.mode === "absolute" && typeof t.targetTime === "string" && /^\d{1,2}:\d{2}$/.test(t.targetTime)) {
        time = { mode: "absolute", targetTime: t.targetTime };
      }
      time = time ?? localTime;
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
  };
}

// Default availability seam — objective hours only (keep-on-missing: no
// hours data means we can't rule it out, so it stays usable). A real
// availability API replaces this function body, nothing else.
function usableByHours(place: Place, when: Date): boolean {
  const verdict = isOpenAt(place.currentOpeningHours, {
    day: when.getDay(),
    hour: when.getHours(),
    minute: when.getMinutes(),
  });
  return verdict !== false;
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

const FALLBACK_PARSED: ParsedPrompt = {
  time_window: "unspecified", stop_count: null, aesthetic: "unspecified",
  category_signals: [], group_context: "unspecified", budget: null,
  constraints: [], location: "Ossington",
};

function snap(s: ItineraryStop): Snap {
  return { name: s.name ?? null, start: s.start_time, end: s.end_time, category: s.category };
}

function clockLabel(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
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

  const base = itinerary.parsed ?? FALLBACK_PARSED;
  const interp = await deps.interpret(base, target.category, target.start_time, refinement);

  if (interp.intent === "time") {
    return timeChange(itinerary, stopIndex, target, interp, base, floor, now, deps);
  }
  if (interp.intent === "duration") {
    return durationChange(itinerary, stopIndex, target, interp, base, floor, now, deps);
  }
  return venueSwap(itinerary, stopIndex, target, interp, base, floor, now, deps);
}

function durLabel(mins: number): string {
  if (mins % 60 === 0) return `${mins / 60} hour${mins === 60 ? "" : "s"}`;
  if (mins < 120) return `${mins} minutes`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
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
  const category = target.category;
  const dur = interp.duration;
  if (!dur) {
    return { swapped: false, reason: "Couldn't tell how long you meant — try “stay 2 hours” or “a bit longer”." };
  }

  const d = getDuration(category);
  const defaultTotal = d.baseMinutes + d.bufferMinutes;
  const currentTotal = target.durationMinutes?.total ?? defaultTotal;
  const newTotal = Math.round(
    dur.mode === "absolute" ? dur.targetMinutes ?? currentTotal : currentTotal + (dur.deltaMinutes ?? 0)
  );

  // sane bounds — cap at 6 hours, floor at the category's realistic minimum
  const MAX = 360;
  const categoryMin = Math.max(15, Math.round(defaultTotal * 0.4));
  if (newTotal > MAX) {
    return { swapped: false, reason: `${durLabel(newTotal)} is longer than a single stop makes sense — keep it under 6 hours.` };
  }
  if (newTotal < categoryMin) {
    return {
      swapped: false,
      reason: `A ${durLabel(newTotal)} ${category} isn't enough time — give it at least ${durLabel(categoryMin)}.`,
    };
  }

  const startISO = target.start_time!;
  const anchorEnd = new Date(new Date(startISO).getTime() + newTotal * 60_000);

  const timedIdx: number[] = [];
  itinerary.stops.forEach((s, i) => {
    if (s.start_time) timedIdx.push(i);
  });
  const used = new Set<string>(itinerary.stops.map((s) => s.id).filter((id): id is string => !!id));

  // resettle downstream from the new end (start + venue unchanged, so the
  // inbound leg into this stop is untouched)
  const settle = await resettleTail(itinerary, stopIndex, timedIdx, anchorEnd, target.location ?? null, floor, now, base, deps, used);
  if (!settle.ok) return { swapped: false, reason: settle.reason };

  const before = snap(target);
  const anchorOutbound = settle.changes[0]?.inbound ?? target.travelToNext ?? null;
  itinerary.stops[stopIndex] = buildStop(category, startISO, { keep: target }, anchorOutbound, newTotal);
  commitTail(itinerary, settle.changes);
  itinerary.legs = itinerary.stops.filter((s) => s.start_time && s.travelToNext).map((s) => s.travelToNext!);
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

// ── VENUE / CONSTRAINT: replace the venue, hold the slot ──
async function venueSwap(
  itinerary: Itinerary,
  stopIndex: number,
  target: ItineraryStop,
  interp: SwapInterpretation,
  base: ParsedPrompt,
  floor: Date,
  now: Date,
  deps: SwapDeps
): Promise<SwapResult> {
  const poolKey = interp.path === "research" ? interp.category : target.category;
  const searchParsed =
    interp.path === "refilter"
      ? scoped(base, {}, poolKey)
      : scoped(base, { aesthetic: interp.aesthetic, budget: interp.budget, constraints: interp.constraints }, poolKey);
  const judgeParsed = scoped(base, { aesthetic: interp.aesthetic, budget: interp.budget, constraints: interp.constraints }, poolKey);

  const rawPools = await deps.searchPools(searchParsed, [poolKey]);
  const { pools: filtered } = filterPools(rawPools, judgeParsed, null, now, new Date(target.start_time!));

  // never re-pick the rejected venue, nor anything already used elsewhere
  const excluded = new Set<string>(
    itinerary.stops
      .map((s, i) => (i === stopIndex ? target.id : s.id))
      .filter((id): id is string => id !== null)
  );
  const candidates = (filtered[poolKey] ?? []).filter((p) => !excluded.has(p.id));
  if (candidates.length === 0) {
    return { swapped: false, reason: `Couldn't find another ${target.category} that fits — keeping ${target.name}.` };
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
  const category = target.category;
  const shift = interp.time;
  if (!shift) {
    return { swapped: false, reason: "Couldn't tell what time you meant — try “after 8” or “an hour earlier”." };
  }

  const nd = new Date(target.start_time!);
  if (shift.mode === "relative") {
    nd.setMinutes(nd.getMinutes() + (shift.deltaMinutes ?? 0));
  } else if (shift.targetTime) {
    const [h, m] = shift.targetTime.split(":").map(Number);
    nd.setHours(h, m, 0, 0);
  }
  const newStartMs = nd.getTime();

  // guards (plausible hour first so "dinner at 4am" gives the real reason)
  if (!isPlausibleAt(nd, [category])) {
    return { swapped: false, reason: `A ${clockLabel(nd)} ${category} won't work — nothing's really open then.` };
  }
  if (newStartMs <= floor.getTime()) {
    return { swapped: false, reason: `Can't move ${target.name} earlier than where the evening already is.` };
  }
  const timedIdx: number[] = [];
  itinerary.stops.forEach((s, i) => {
    if (s.start_time) timedIdx.push(i);
  });
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
  if (!deps.isUsableAt(placeOf(target), nd, category)) {
    const repl = await findReplacement(category, nd, used, base, now, deps);
    if (!repl) {
      return { swapped: false, reason: `Nothing similar to ${target.name} is open around ${clockLabel(nd)}.` };
    }
    anchorPick = repl.pick;
    anchorSel = repl.sel;
    used.delete(target.id!);
    used.add(anchorPick.id);
  }
  const anchorLoc = anchorPick?.location ?? target.location ?? null;
  const { baseMinutes, bufferMinutes } = getDuration(category);
  const anchorEnd = new Date(newStartMs + (baseMinutes + bufferMinutes) * 60_000);

  // (b) resettle the downstream tail from the anchor's new end (try →
  // adapt → notify). Reusable — duration-swaps will call this too.
  const settle = await resettleTail(itinerary, stopIndex, timedIdx, anchorEnd, anchorLoc, floor, now, base, deps, used);
  if (!settle.ok) return { swapped: false, reason: settle.reason };

  // ── commit (only now that the whole tail fits) ──
  const before = snap(target);
  let anchorInbound: TravelLeg | null = null;
  if (anchorLoc) {
    anchorInbound = await deps.getSingleLeg(
      prevStop?.location ?? HOME.location,
      anchorLoc,
      prevStop ? tp - 1 : HOME_LEG_INDEX,
      prevStop?.end_time ?? undefined,
      false
    );
  }
  const anchorOutbound = settle.changes[0]?.inbound ?? null;
  itinerary.stops[stopIndex] = buildStop(
    category,
    toTorontoISO(nd),
    anchorPick ? { pick: anchorPick, sel: anchorSel! } : { keep: target },
    anchorOutbound
  );
  if (prevStop && anchorInbound) {
    prevStop.travelToNext = anchorInbound;
    prevStop.travelMinutesToNext = anchorInbound.totalMinutes;
  } else if (!prevStop && anchorInbound && itinerary.homeLeg) {
    itinerary.homeLeg = { ...anchorInbound, fromIndex: HOME_LEG_INDEX };
  }
  commitTail(itinerary, settle.changes);

  itinerary.legs = itinerary.stops.filter((s) => s.start_time && s.travelToNext).map((s) => s.travelToNext!);
  withStatuses(itinerary, now);

  let reason = `Moved ${category} to ${clockLabel(nd)}`;
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
    if (!deps.isUsableAt(placeOf(stop), new Date(startMs), stop.category)) {
      const repl = await findReplacement(stop.category, new Date(startMs), used, base, now, deps);
      if (!repl) {
        return { ok: false, reason: `Nothing similar to ${stop.name} is open by ${clockLabel(new Date(startMs))}.` };
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
    changes.push({ stopIndex: di, startISO: toTorontoISO(new Date(startMs)), totalMinutes, inbound, venue, sel });
    prevEndMs = endMs;
    prevLoc = venue?.location ?? stop.location;
  }
  return { ok: true, changes };
}

function commitTail(itinerary: Itinerary, changes: TailChange[]) {
  changes.forEach((ch, k) => {
    const existing = itinerary.stops[ch.stopIndex];
    const outbound = changes[k + 1]?.inbound ?? existing.travelToNext ?? null;
    itinerary.stops[ch.stopIndex] = buildStop(
      existing.category,
      ch.startISO,
      ch.venue ? { pick: ch.venue, sel: ch.sel! } : { keep: existing },
      outbound,
      ch.totalMinutes
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
  deps: SwapDeps
): Promise<{ sel: Selection; pick: Place } | null> {
  const parsed = scoped(base, {}, category);
  const rawPools = await deps.searchPools(parsed, [category]);
  const { pools } = filterPools(rawPools, parsed, null, now, when);
  const candidates = (pools[category] ?? []).filter(
    (p) => !excluded.has(p.id) && deps.isUsableAt(p, when, category)
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
  durationOverride?: number
): ItineraryStop {
  const def = getDuration(category);
  const total = durationOverride ?? def.baseMinutes + def.bufferMinutes;
  const buffer = durationOverride ? Math.min(def.bufferMinutes, total) : def.bufferMinutes;
  const baseMinutes = total - buffer;
  const bufferMinutes = buffer;
  const endISO = toTorontoISO(new Date(new Date(startISO).getTime() + total * 60_000));
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
  const before = snap(target);
  const { baseMinutes, bufferMinutes } = getDuration(category);
  const total = baseMinutes + bufferMinutes;
  const newLoc = pick.location ?? target.location;
  const endISO = toTorontoISO(new Date(new Date(startISO).getTime() + total * 60_000));

  const timedIdx: number[] = [];
  itinerary.stops.forEach((s, i) => {
    if (s.start_time) timedIdx.push(i);
  });
  const tp = timedIdx.indexOf(stopIndex);
  const prevStop = tp > 0 ? itinerary.stops[timedIdx[tp - 1]] : null;
  const nextStop = tp < timedIdx.length - 1 ? itinerary.stops[timedIdx[tp + 1]] : null;

  let inbound: TravelLeg | null = null;
  if (newLoc) {
    inbound = await deps.getSingleLeg(
      prevStop?.location ?? HOME.location,
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

  itinerary.stops[stopIndex] = {
    category,
    id: sel.id,
    name: pick.displayName?.text ?? sel.name,
    reason: sel.reason,
    ...(sel.fallback ? { fallback: true } : {}),
    rating: pick.rating,
    priceLevel: pick.priceLevel,
    description: pick.editorialSummary?.text,
    location: newLoc,
    start_time: startISO,
    end_time: endISO,
    durationMinutes: { base: baseMinutes, buffer: bufferMinutes, total },
    ...(outbound ? { travelToNext: outbound, travelMinutesToNext: outbound.totalMinutes } : {}),
    status: "upcoming",
    locked: false,
  };

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
        if (s.locked || !s.start_time || new Date(s.start_time).getTime() <= floor.getTime()) continue;
        s.start_time = toTorontoISO(new Date(new Date(s.start_time).getTime() + deltaMs));
        if (s.end_time) s.end_time = toTorontoISO(new Date(new Date(s.end_time).getTime() + deltaMs));
        downstreamShifted.push(timedIdx[k]);
      }
    }
  }

  itinerary.legs = itinerary.stops
    .filter((s) => s.start_time && s.travelToNext)
    .map((s) => s.travelToNext!);

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
