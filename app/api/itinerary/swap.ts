// Per-stop swap — user-initiated and surgical. The user taps ONE
// upcoming stop and types a short complaint ("somewhere cheaper", "with
// a patio"); that single stop is replaced with a closer match and the
// held time slot is kept. Everything else stays put; downstream stops
// shift only when the new pick genuinely can't fit.
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
import { toTorontoISO } from "../schedule/schedule";
import {
  getSingleLeg as realGetSingleLeg,
  LatLng,
  TravelLeg,
} from "../schedule/travel";
import { HOME, HOME_LEG_INDEX } from "../schedule/home";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

// How the complaint reshapes this one stop's search.
export interface SwapInterpretation {
  // refilter = narrow the SAME pool (cheaper, higher-rated, less fancy);
  // research = the request needs venues the pool may not hold (a patio,
  // a different cuisine) → new Places search.
  path: "refilter" | "research";
  category: string;
  aesthetic: string;
  budget: string | null;
  constraints: string[];
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
      path: "refilter" | "research";
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

const REFINE_SYSTEM = `You adjust ONE stop of an existing day plan based on a short complaint from the user. You get the stop's current settings (category, aesthetic, budget, constraints) and the complaint. Fold the complaint into an updated setting for THIS stop only.

Classify "path":
- "refilter": the complaint narrows the same kind of place — cheaper, higher-rated, quieter, less fancy, more casual. Keep the category.
- "research": the complaint needs venues the current pool may not contain — a patio / outdoor seating, a specific feature, or a different cuisine or type of place.

Rules:
- Keep "category" the same unless the complaint clearly changes the kind of place (e.g. "dessert instead").
- Put budget words ("cheaper", "budget") into "budget".
- Put vibe/feature words ("patio", "quiet", "casual", "less fancy") into "constraints".
- Preserve the user's still-relevant original constraints; drop ones the complaint overrides.

Respond with ONLY this JSON, no prose:
{ "path": "refilter"|"research", "category": string, "aesthetic": string, "budget": string|null, "constraints": string[] }`;

async function interpretRefinement(
  apiKey: string,
  parsed: ParsedPrompt,
  category: string,
  refinement: string
): Promise<SwapInterpretation> {
  const fallback: SwapInterpretation = {
    path: "refilter",
    category,
    aesthetic: parsed.aesthetic,
    budget: parsed.budget,
    constraints: [...(parsed.constraints ?? []), refinement],
  };
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
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
    return {
      path: out.path === "research" ? "research" : "refilter",
      category: typeof out.category === "string" && out.category.trim() ? out.category : category,
      aesthetic: typeof out.aesthetic === "string" ? out.aesthetic : parsed.aesthetic,
      budget: typeof out.budget === "string" ? out.budget : out.budget === null ? null : parsed.budget,
      constraints: Array.isArray(out.constraints)
        ? out.constraints.filter((c: unknown): c is string => typeof c === "string")
        : fallback.constraints,
    };
  } catch {
    return fallback;
  }
}

function realDeps(): SwapDeps {
  return {
    interpret: (parsed, category, refinement) =>
      interpretRefinement(process.env.GROQ_API_KEY ?? "", parsed, category, refinement),
    searchPools: (parsed, categories) =>
      realSearchPools(process.env.GOOGLE_PLACES_API_KEY ?? "", parsed, categories),
    selectVenues: (parsed, pools) =>
      realSelectVenues(process.env.GROQ_API_KEY ?? "", parsed, pools),
    getSingleLeg: (origin, destination, fromIndex, departureTime, excludeTransit) =>
      realGetSingleLeg(
        process.env.GOOGLE_ROUTES_API_KEY ?? "",
        origin,
        destination,
        fromIndex,
        departureTime,
        excludeTransit
      ),
  };
}

const FALLBACK_PARSED: ParsedPrompt = {
  time_window: "unspecified",
  stop_count: null,
  aesthetic: "unspecified",
  category_signals: [],
  group_context: "unspecified",
  budget: null,
  constraints: [],
  location: "Ossington",
};

function snap(s: ItineraryStop): Snap {
  return { name: s.name ?? null, start: s.start_time, end: s.end_time, category: s.category };
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
  // Guard: swaps are for UPCOMING stops only — reuse floor_time.
  if (target.locked || new Date(target.start_time).getTime() <= floor.getTime()) {
    return {
      swapped: false,
      reason: `You can only swap an upcoming stop — “${target.name}” is already underway or done.`,
    };
  }

  // ── Interpret the complaint into an updated search for this stop ──
  const base = itinerary.parsed ?? FALLBACK_PARSED;
  const interp = await deps.interpret(base, target.category, refinement);
  const poolKey = interp.path === "research" ? interp.category : target.category;

  const scoped = (
    over: { aesthetic?: string; budget?: string | null; constraints?: string[] },
    category: string
  ): ParsedPrompt => ({
    ...base,
    aesthetic: over.aesthetic ?? base.aesthetic,
    budget: over.budget !== undefined ? over.budget : base.budget,
    constraints: over.constraints ?? base.constraints,
    category_signals: [category],
  });

  // refilter searches the ORIGINAL query (same pool), then judges with
  // the new constraints; research searches with the new query too.
  const searchParsed =
    interp.path === "refilter"
      ? scoped({}, poolKey)
      : scoped({ aesthetic: interp.aesthetic, budget: interp.budget, constraints: interp.constraints }, poolKey);
  const judgeParsed = scoped(
    { aesthetic: interp.aesthetic, budget: interp.budget, constraints: interp.constraints },
    poolKey
  );

  const rawPools = await deps.searchPools(searchParsed, [poolKey]);
  // hours/weather gate at the HELD slot time; weather null (keep-on-missing)
  const { pools: filtered } = filterPools(rawPools, judgeParsed, null, now, new Date(target.start_time));

  // never re-pick the rejected venue, nor anything already used elsewhere
  const excluded = new Set<string>(
    itinerary.stops
      .map((s, i) => (i === stopIndex ? target.id : s.id))
      .filter((id): id is string => id !== null)
  );
  const candidates = (filtered[poolKey] ?? []).filter((p) => !excluded.has(p.id));

  if (candidates.length === 0) {
    return {
      swapped: false,
      reason: `Couldn't find a better ${target.category} than ${target.name} — keeping it.`,
    };
  }

  const selections = await deps.selectVenues(judgeParsed, { [poolKey]: candidates });
  const sel = selections.find((s) => s.category === poolKey);
  const pick = sel?.id ? candidates.find((p) => p.id === sel.id) : undefined;
  if (!sel || sel.id === null || !pick) {
    return {
      swapped: false,
      reason: `Couldn't find a better ${target.category} than ${target.name} — keeping it.`,
    };
  }

  // ── Build the replacement, HOLDING the time slot ──
  const before = snap(target);
  const { baseMinutes, bufferMinutes } = getDuration(poolKey);
  const total = baseMinutes + bufferMinutes;
  const heldStartISO = target.start_time;
  const newLoc = pick.location ?? target.location;
  const newEndISO = toTorontoISO(new Date(new Date(heldStartISO).getTime() + total * 60_000));

  // Timed-stop bookkeeping (legs index timed pairs).
  const timedIdx: number[] = [];
  itinerary.stops.forEach((s, i) => {
    if (s.start_time) timedIdx.push(i);
  });
  const tp = timedIdx.indexOf(stopIndex);
  const prevStop = tp > 0 ? itinerary.stops[timedIdx[tp - 1]] : null;
  const nextStop = tp < timedIdx.length - 1 ? itinerary.stops[timedIdx[tp + 1]] : null;

  // Recompute inbound (for the map geometry — the route now points at the
  // new venue) and outbound (feeds the fit check). Times are NOT changed
  // by the inbound leg; the slot is held.
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
    outbound = await deps.getSingleLeg(newLoc, nextStop.location, tp, newEndISO, false);
  }

  const newStop: ItineraryStop = {
    category: poolKey,
    id: sel.id,
    name: pick.displayName?.text ?? sel.name,
    reason: sel.reason,
    ...(sel.fallback ? { fallback: true } : {}),
    rating: pick.rating,
    location: newLoc,
    start_time: heldStartISO,
    end_time: newEndISO,
    durationMinutes: { base: baseMinutes, buffer: bufferMinutes, total },
    ...(outbound ? { travelToNext: outbound, travelMinutesToNext: outbound.totalMinutes } : {}),
    status: "upcoming",
    locked: false,
  };
  itinerary.stops[stopIndex] = newStop;

  // inbound geometry: previous stop's outbound leg, or the home leg
  if (prevStop && inbound) {
    prevStop.travelToNext = inbound;
    prevStop.travelMinutesToNext = inbound.totalMinutes;
  } else if (!prevStop && inbound && itinerary.homeLeg) {
    itinerary.homeLeg = { ...inbound, fromIndex: HOME_LEG_INDEX };
  }

  // ── Fit check: does the next stop still start at/after the new pick's
  // end + travel? If yes, nothing downstream moves. If not, shift the
  // downstream tail by the delta (later stops are all upcoming — locked/
  // past stops sit BEFORE the swapped one and are never touched). ──
  const downstreamShifted: number[] = [];
  if (nextStop && outbound && nextStop.start_time) {
    const requiredNextMs = new Date(newEndISO).getTime() + outbound.totalMinutes * 60_000;
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

  // rebuild legs from the stops' travelToNext chain (mirrors reroute)
  itinerary.legs = itinerary.stops
    .filter((s) => s.start_time && s.travelToNext)
    .map((s) => s.travelToNext!);

  withStatuses(itinerary, now);

  return {
    swapped: true,
    stopIndex,
    path: interp.path,
    before,
    after: snap(itinerary.stops[stopIndex]),
    reason: sel.reason,
    downstreamShifted,
  };
}
