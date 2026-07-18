// Reroute engine — disruption trigger + floor_time replan.
// Manual trigger for now (dev button); GTFS replaces the trigger later,
// the engine underneath is identical.
//
// THE guarantee: no stop at or before floor_time is ever changed.
// floor_time = max(now, end of the currently active stop); locked,
// active, and completed stops are never touched.
import { Itinerary, ItineraryStop, withStatuses, floorTime } from "./store";
import { filterPools, ParsedPrompt, Place } from "../places/search/filter";
import { searchPools as realSearchPools } from "../places/search/searchPlaces";
import { selectVenues as realSelectVenues, Selection } from "../select/selectVenues";
import { buildSchedule } from "../schedule/schedule";
import { DEFAULT_ZONE } from "../../lib/zoneTime";
import {
  getSingleLeg as realGetSingleLeg,
  LatLng,
  TravelLeg,
} from "../schedule/travel";
import { isMockMode, mockRerouteDeps } from "../_mock/fixtures";

export interface Disruption {
  type: "transit_cancelled";
  /** index of the broken travel leg (timed-stop pair i → i+1) */
  legIndex: number;
}

export interface ChangedStop {
  stopIndex: number;
  before: { name: string | null; start: string | null; end: string | null };
  after: { name: string | null; start: string | null; end: string | null };
  reason: string;
}

export type RerouteResult =
  | { rerouted: false; reason: string }
  | {
      rerouted: true;
      floor_time: string;
      /** the instant the replanned chain actually departs from — the later
       * of floor and the previous kept stop's committed end. The banner
       * shows this; floor_time stays the guarantee value. */
      anchor_time: string;
      changed: ChangedStop[];
      unchanged: number[];
    };

// Injectable pipeline deps so the engine's guarantees are testable
// without network. Defaults hit the real modules with env keys.
export interface RerouteDeps {
  searchPools: (
    parsed: ParsedPrompt,
    categories: string[]
  ) => Promise<Record<string, Place[]>>;
  selectVenues: (
    parsed: ParsedPrompt,
    pools: Record<string, Place[]>,
    /** the affected stops in order, duplicates intact — see §7.1 */
    slots?: string[]
  ) => Promise<Selection[]>;
  getSingleLeg: (
    origin: LatLng,
    destination: LatLng,
    fromIndex: number,
    departureTime: string | undefined,
    excludeTransit: boolean
  ) => Promise<TravelLeg>;
}

function realDeps(): RerouteDeps {
  // e2e fixture seam — deterministic search/select/legs
  if (isMockMode()) return mockRerouteDeps();
  return {
    searchPools: (parsed, categories) =>
      realSearchPools(process.env.GOOGLE_PLACES_API_KEY ?? "", parsed, categories),
    selectVenues: (parsed, pools, slots) =>
      realSelectVenues(process.env.GROQ_API_KEY ?? "", parsed, pools, slots),
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

function snap(s: ItineraryStop) {
  return {
    name: s.name ?? null,
    start: s.start_time,
    end: s.end_time,
  };
}

export async function rerouteItinerary(
  itinerary: Itinerary,
  disruption: Disruption,
  now: Date,
  depsIn: Partial<RerouteDeps> = {}
): Promise<RerouteResult> {
  const deps = { ...realDeps(), ...depsIn };
  const tz = itinerary.timeZone ?? DEFAULT_ZONE;

  // Current statuses + locked ratchet against the reference time.
  withStatuses(itinerary, now);

  // floor_time = max(now, end of the active stop); no active stop → now.
  const floor = floorTime(itinerary, now);

  // Timed-stop bookkeeping first — legs join timed pairs, and the
  // disruption's blast radius is defined in timed positions.
  const timedIdx: number[] = [];
  itinerary.stops.forEach((s, i) => {
    if (s.start_time) timedIdx.push(i);
  });

  // Affected: strictly DOWNSTREAM of the broken leg (leg k joins timed
  // stops k → k+1, so positions ≥ k+1), strictly after the floor, and
  // never locked. Stops upstream of the break keep their COMMITTED times
  // even when the outing hasn't started — a reroute reflows the tail, it
  // never re-derives the schedule from `now`.
  const firstDownstreamPos = Math.max(0, disruption.legIndex) + 1;
  const affectedIdx: number[] = [];
  timedIdx.forEach((stopIdx, pos) => {
    const s = itinerary.stops[stopIdx];
    if (
      pos >= firstDownstreamPos &&
      s.status !== "skipped" &&
      !s.locked &&
      new Date(s.start_time!).getTime() > floor.getTime()
    ) {
      affectedIdx.push(stopIdx);
    }
  });

  // observability at the apply step: where is the plan anchored, what
  // does the engine think is affected — a reroute that re-derives times
  // from `now` instead of the committed schedule is visible right here
  console.log(
    `[reroute-apply] leg=${disruption.legIndex} now=${now.toISOString()} floor=${floor.toISOString()} | ` +
      `committed: ${itinerary.stops.map((s) => `${s.category}@${s.start_time ?? "-"}`).join(" ")} | ` +
      `affected=[${affectedIdx.join(",")}]`
  );

  if (affectedIdx.length === 0) {
    return {
      rerouted: false,
      reason: "nothing after the current stop to replan",
    };
  }

  const firstAffectedTimedPos = timedIdx.indexOf(affectedIdx[0]);
  const prevTimedStop =
    firstAffectedTimedPos > 0
      ? itinerary.stops[timedIdx[firstAffectedTimedPos - 1]]
      : null;

  const beforeSnaps = affectedIdx.map((i) => snap(itinerary.stops[i]));

  // ── Re-run the pipeline scoped to the affected categories ──
  const parsed = itinerary.parsed ?? FALLBACK_PARSED;
  const categories = affectedIdx.map((i) => itinerary.stops[i].category);

  const rawPools = await deps.searchPools(parsed, categories);
  // TODO: thread live weather through the reroute filter (null skips
  // the weather gate, matching the keep-on-missing policy).
  const { pools } = filterPools(rawPools, parsed, null, now, floor, tz);

  // Venues already used by kept stops must not be re-proposed.
  const keptIds = new Set(
    itinerary.stops
      .filter((_, i) => !affectedIdx.includes(i))
      .map((s) => s.id)
      .filter((id): id is string => id !== null)
  );
  for (const k of Object.keys(pools)) {
    pools[k] = pools[k].filter((p) => !keptIds.has(p.id));
  }

  // SLOT-aware: two affected stops can share a category, and they must get
  // DIFFERENT venues. Indexing the answers by category (as this did) made
  // both resolve to the SAME Selection object — the reroute planned one
  // venue twice in one evening (code-audit 2026-07-18 §7.1).
  const selections = await deps.selectVenues(parsed, pools, categories);
  const bySlot = new Map(
    selections.filter((s) => typeof s.slot === "number").map((s) => [s.slot!, s])
  );
  const leftoverByCategory = new Map<string, Selection[]>();
  for (const s of selections) {
    if (typeof s.slot === "number") continue;
    const list = leftoverByCategory.get(s.category) ?? [];
    list.push(s);
    leftoverByCategory.set(s.category, list);
  }
  const ordered: Selection[] = categories.map((c, i) => {
    const bySlotHit = bySlot.get(i);
    if (bySlotHit) return bySlotHit;
    // tolerate a slot-less answer (older dep implementations/tests): take
    // the next unused selection for that category, never the same one twice
    const queue = leftoverByCategory.get(c);
    const next = queue && queue.length > 0 ? queue.shift() : undefined;
    return (
      next ?? {
        category: c,
        id: null,
        reason: "no venues survived filtering",
      }
    );
  });

  // attach coordinates for travel + map
  const venueOf = (sel: Selection): Place | undefined =>
    sel.id ? pools[sel.category]?.find((p) => p.id === sel.id) : undefined;
  const withLocations: Array<Selection & { location?: LatLng }> = ordered.map(
    (sel) => {
      const loc = venueOf(sel)?.location;
      return loc ? { ...sel, location: loc } : { ...sel };
    }
  );

  // ── Travel: inbound leg (last kept timed stop → first new venue),
  // then legs between the new venues. The cancelled transit leg is
  // re-fetched with transit excluded so the dead route can't return.
  // Departure = the later of the floor and the previous kept stop's
  // COMMITTED end — the committed schedule is the source of truth; the
  // clock only wins once it has actually overtaken the plan.
  const departMs = Math.max(
    floor.getTime(),
    prevTimedStop?.end_time ? new Date(prevTimedStop.end_time).getTime() : 0
  );
  const departISO = new Date(departMs).toISOString();
  const timedPicks = withLocations.filter((s) => s.id && s.location);

  let inbound: TravelLeg | null = null;
  if (prevTimedStop?.location && timedPicks[0]?.location) {
    const pairIndex = firstAffectedTimedPos - 1;
    inbound = await deps.getSingleLeg(
      prevTimedStop.location,
      timedPicks[0].location!,
      pairIndex,
      departISO,
      pairIndex === disruption.legIndex
    );
  }

  const interLegs: TravelLeg[] = [];
  for (let j = 0; j < timedPicks.length - 1; j++) {
    const absolutePair = firstAffectedTimedPos + j;
    interLegs.push(
      await deps.getSingleLeg(
        timedPicks[j].location!,
        timedPicks[j + 1].location!,
        j, // relative index — buildSchedule matches by position
        departISO,
        absolutePair === disruption.legIndex
      )
    );
  }

  // ── Schedule the replanned chain, anchored at the departure instant
  // (+ inbound travel when the user has to get there from the kept stop).
  const chainStart = new Date(departMs + (inbound?.totalMinutes ?? 0) * 60_000);
  const { stops: newSched } = buildSchedule(
    withLocations,
    "",
    now,
    interLegs,
    chainStart,
    null,
    tz
  );

  // ── Write back: replace affected stops in place, renumber leg
  // indexes to absolute timed pairs, update the boundary stop's
  // outbound leg (its times/venue stay untouched).
  affectedIdx.forEach((stopIdx, j) => {
    const ns = newSched[j];
    if (ns.travelToNext) {
      ns.travelToNext = {
        ...ns.travelToNext,
        fromIndex: firstAffectedTimedPos + j,
      };
    }
    itinerary.stops[stopIdx] = {
      ...ns,
      status: ns.id === null ? "skipped" : "upcoming",
      locked: false,
    };
  });
  if (prevTimedStop && inbound) {
    prevTimedStop.travelToNext = inbound;
    prevTimedStop.travelMinutesToNext = inbound.totalMinutes;
  }
  // legs array rebuilt from the stops' travelToNext chain
  itinerary.legs = itinerary.stops
    .filter((s) => s.start_time && s.travelToNext)
    .map((s) => s.travelToNext!);

  withStatuses(itinerary, now);

  console.log(
    `[reroute-apply] after: ${itinerary.stops.map((s) => `${s.category}@${s.start_time ?? "-"}`).join(" ")}`
  );

  const changed: ChangedStop[] = affectedIdx.map((stopIdx, j) => ({
    stopIndex: stopIdx,
    before: beforeSnaps[j],
    after: snap(itinerary.stops[stopIdx]),
    reason: ordered[j].reason,
  }));
  const unchanged = itinerary.stops
    .map((_, i) => i)
    .filter((i) => !affectedIdx.includes(i));

  return {
    rerouted: true,
    floor_time: floor.toISOString(),
    anchor_time: departISO,
    changed,
    unchanged,
  };
}
