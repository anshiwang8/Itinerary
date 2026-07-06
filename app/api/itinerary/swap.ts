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
import {
  getSingleLeg as realGetSingleLeg,
  LatLng,
  TravelLeg,
} from "../schedule/travel";
import { HOME, HOME_LEG_INDEX } from "../schedule/home";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

export type SwapIntent = "venue" | "time" | "constraint";

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
  // time intent only: the requested new start, 24h "HH:MM".
  newStartClock: string | null;
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
      path: "refilter" | "research" | "time";
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
}

const REFINE_SYSTEM = `You adjust ONE stop of an existing day plan from a short complaint. You get the stop's current settings (category, aesthetic, budget, constraints) and its current start time, plus the complaint. Classify the user's INTENT and return the parameters to act on it.

"intent":
- "time": the complaint is about WHEN — "too late", "earlier", "later", "after 8", "make it 7". Return "newStartClock" as 24h "HH:MM" — the concrete new start time the user wants. For vague ones ("too late", "earlier") pick a sensible time relative to the current start (e.g. an hour or two earlier). This is the ONLY case that sets newStartClock.
- "constraint": the complaint needs a different KIND of venue by feature/location — "with a patio", "near the water", "somewhere quieter that's outdoors". Set path "research", fold the feature into "constraints".
- "venue": the complaint is about the venue's quality/price/style in the SAME slot — "don't like it", "cheaper", "less fancy", "higher rated". Set path "refilter" (narrows the same pool) unless it needs different venues, then "research".

Rules:
- Keep "category" the same unless the complaint clearly changes the kind of place.
- Put budget words into "budget"; vibe/feature words into "constraints".
- Preserve still-relevant original constraints; drop ones the complaint overrides.

Respond with ONLY this JSON, no prose:
{ "intent": "venue"|"time"|"constraint", "path": "refilter"|"research", "category": string, "aesthetic": string, "budget": string|null, "constraints": string[], "newStartClock": string|null }`;

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
    newStartClock: null,
  };
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
    if (!res.ok) return fallback;
    const out = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
    const intent: SwapIntent =
      out.intent === "time" || out.intent === "constraint" ? out.intent : "venue";
    return {
      intent,
      path: out.path === "research" || intent === "constraint" ? "research" : "refilter",
      category: typeof out.category === "string" && out.category.trim() ? out.category : category,
      aesthetic: typeof out.aesthetic === "string" ? out.aesthetic : parsed.aesthetic,
      budget: typeof out.budget === "string" ? out.budget : out.budget === null ? null : parsed.budget,
      constraints: Array.isArray(out.constraints)
        ? out.constraints.filter((c: unknown): c is string => typeof c === "string")
        : fallback.constraints,
      newStartClock:
        intent === "time" && typeof out.newStartClock === "string" && /^\d{1,2}:\d{2}$/.test(out.newStartClock)
          ? out.newStartClock
          : null,
    };
  } catch {
    return fallback;
  }
}

function realDeps(): SwapDeps {
  return {
    interpret: (parsed, category, currentStartISO, refinement) =>
      interpretRefinement(process.env.GROQ_API_KEY ?? "", parsed, category, currentStartISO, refinement),
    searchPools: (parsed, categories) =>
      realSearchPools(process.env.GOOGLE_PLACES_API_KEY ?? "", parsed, categories),
    selectVenues: (parsed, pools) =>
      realSelectVenues(process.env.GROQ_API_KEY ?? "", parsed, pools),
    getSingleLeg: (origin, destination, fromIndex, departureTime, excludeTransit) =>
      realGetSingleLeg(process.env.GOOGLE_ROUTES_API_KEY ?? "", origin, destination, fromIndex, departureTime, excludeTransit),
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
  return venueSwap(itinerary, stopIndex, target, interp, base, floor, now, deps);
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
    return { swapped: false, reason: `Couldn't find another ${target.category} that fits — keeping ${target.name}.` };
  }

  return finalize(itinerary, stopIndex, target, pick, sel, poolKey, target.start_time!, now, deps, interp.path, sel.reason);
}

// ── TIME: move the slot, re-check what's open at the new time ──
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
  if (!interp.newStartClock) {
    return { swapped: false, reason: "Couldn't tell what time you meant — try “after 8” or “an hour earlier”." };
  }
  const [nh, nm] = interp.newStartClock.split(":").map(Number);
  const nd = new Date(target.start_time!);
  nd.setHours(nh, nm, 0, 0);
  const newStartMs = nd.getTime();

  // 1. plausible hour for the category (checked FIRST so "dinner at 4am"
  //    fails with the real reason, not a floor message)
  if (!isPlausibleAt(nd, [category])) {
    return { swapped: false, reason: `A ${clockLabel(nd)} ${category} won't work — nothing's really open then.` };
  }
  // 2. never before floor_time (the current point in the evening)
  if (newStartMs <= floor.getTime()) {
    return { swapped: false, reason: `Can't move ${target.name} earlier than where the evening already is.` };
  }

  // timed bookkeeping for the overlap guard
  const timedIdx: number[] = [];
  itinerary.stops.forEach((s, i) => {
    if (s.start_time) timedIdx.push(i);
  });
  const tp = timedIdx.indexOf(stopIndex);
  const prevStop = tp > 0 ? itinerary.stops[timedIdx[tp - 1]] : null;
  // 3. don't overlap the previous stop
  if (prevStop?.end_time && newStartMs < new Date(prevStop.end_time).getTime()) {
    return { swapped: false, reason: `That's too early — it runs into ${prevStop.name}.` };
  }

  // re-check what's open at the new time (same category, original query);
  // keep the current venue if it's still open, don't exclude it
  const searchParsed = scoped(base, {}, category);
  const rawPools = await deps.searchPools(searchParsed, [category]);
  const { pools: filtered } = filterPools(rawPools, searchParsed, null, now, nd);
  const usedElsewhere = new Set<string>(
    itinerary.stops
      .map((s, i) => (i === stopIndex ? null : s.id))
      .filter((id): id is string => id !== null)
  );
  const candidates = (filtered[category] ?? []).filter((p) => !usedElsewhere.has(p.id));
  if (candidates.length === 0) {
    return { swapped: false, reason: `Nothing open around ${clockLabel(nd)} for ${category}.` };
  }
  const selections = await deps.selectVenues(searchParsed, { [category]: candidates });
  const sel = selections.find((s) => s.category === category);
  const pick = sel?.id ? candidates.find((p) => p.id === sel.id) : undefined;
  if (!sel || sel.id === null || !pick) {
    return { swapped: false, reason: `Nothing open around ${clockLabel(nd)} for ${category}.` };
  }

  const stillSame = pick.id === target.id;
  const reason = stillSame
    ? `Moved ${category} to ${clockLabel(nd)} — ${pick.displayName?.text ?? target.name} still works.`
    : `Moved ${category} to ${clockLabel(nd)} — now ${pick.displayName?.text ?? "a spot that's open then"}.`;

  return finalize(itinerary, stopIndex, target, pick, sel, category, toTorontoISO(nd), now, deps, "time", reason);
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
