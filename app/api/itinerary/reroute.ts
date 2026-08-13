// Reroute engine — disruption trigger + floor_time replan.
//
// A reroute is planned on an isolated clone, stabilized against the real
// arrival time of every replacement, and copied back only after the entire
// affected chain is complete. No partial chain is ever committed.
import {
  Itinerary,
  ItineraryStop,
  floorTime,
  rebuildLegs,
  timedIndexes,
  withStatuses,
} from "./store";
import {
  filterPools,
  ParsedPrompt,
  Place,
  WeatherHour,
} from "../places/search/filter";
import { withModelFallback } from "../_shared/modelFallback";
import { fetchWeatherHours } from "../weather/fetchWeather";
import { searchPools as realSearchPools } from "../places/search/searchPlaces";
import {
  selectVenues as realSelectVenues,
  selectModelCall,
  Selection,
} from "../select/selectVenues";
import { buildSchedule } from "../schedule/schedule";
import { getDuration } from "../schedule/durations";
import { DEFAULT_ZONE } from "../../lib/zoneTime";
import {
  getSingleLeg as realGetSingleLeg,
  LatLng,
  TravelLeg,
} from "../schedule/travel";
import { isMockMode, mockRerouteDeps } from "../_mock/fixtures";
import { logEvent } from "../_shared/http";
import { fallbackParsedFor, UNKNOWN_LOCATION_MESSAGE } from "./fallbackParsed";

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
      /** Later of floor and the previous kept stop's committed end. */
      anchor_time: string;
      changed: ChangedStop[];
      unchanged: number[];
    };

export interface RerouteDeps {
  searchPools: (
    parsed: ParsedPrompt,
    categories: string[]
  ) => Promise<Record<string, Place[]>>;
  selectVenues: (
    parsed: ParsedPrompt,
    pools: Record<string, Place[]>,
    slots?: string[]
  ) => Promise<Selection[]>;
  getSingleLeg: (
    origin: LatLng,
    destination: LatLng,
    fromIndex: number,
    departureTime: string | undefined,
    excludeTransit: boolean
  ) => Promise<TravelLeg>;
  getWeather: (lat: number, lng: number) => Promise<WeatherHour[] | null>;
}

const MAX_STABILIZATION_PASSES = 5;
const INCOMPLETE_REASON =
  "Couldn't build a complete reroute for every remaining stop — the original plan is unchanged.";
const UNSTABLE_REASON =
  "Couldn't find a complete reroute that stays valid at the recalculated arrival times — the original plan is unchanged.";

function realDeps(): RerouteDeps {
  if (isMockMode()) return mockRerouteDeps();
  return {
    searchPools: (parsed, categories) =>
      realSearchPools(process.env.GOOGLE_PLACES_API_KEY ?? "", parsed, categories),
    selectVenues: (parsed, pools, slots) =>
      withModelFallback("select", (model) =>
        realSelectVenues(
          process.env.GROQ_API_KEY ?? "",
          parsed,
          pools,
          slots,
          selectModelCall(process.env.GROQ_API_KEY ?? "", model)
        )
      ),
    getSingleLeg: (origin, destination, fromIndex, departureTime, excludeTransit) =>
      realGetSingleLeg(
        process.env.GOOGLE_ROUTES_API_KEY ?? "",
        origin,
        destination,
        fromIndex,
        departureTime,
        excludeTransit
      ),
    getWeather: (lat, lng) =>
      fetchWeatherHours(process.env.GOOGLE_WEATHER_API_KEY, lat, lng),
  };
}

function cloneItinerary(itinerary: Itinerary): Itinerary {
  return JSON.parse(JSON.stringify(itinerary)) as Itinerary;
}

function snap(stop: ItineraryStop) {
  return {
    name: stop.name ?? null,
    start: stop.start_time,
    end: stop.end_time,
  };
}

function validLocation(value: Place["location"]): value is LatLng {
  return (
    !!value &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}

function validLeg(leg: TravelLeg): boolean {
  return (
    Number.isFinite(leg.totalMinutes) &&
    Number.isInteger(leg.totalMinutes) &&
    leg.totalMinutes >= 0
  );
}

/**
 * Convert the selector's slot-aware response into one exact entry per
 * required slot. Slot-less injected fakes remain supported by consuming a
 * category queue, but a missing, extra, or mis-categorized answer fails.
 */
function orderSelections(
  selections: Selection[],
  categories: string[]
): Selection[] | null {
  if (selections.length !== categories.length) return null;
  const bySlot = new Map<number, Selection>();
  const queues = new Map<string, Selection[]>();

  for (const selection of selections) {
    if (typeof selection.slot === "number") {
      if (
        !Number.isInteger(selection.slot) ||
        selection.slot < 0 ||
        selection.slot >= categories.length ||
        bySlot.has(selection.slot)
      ) {
        return null;
      }
      bySlot.set(selection.slot, selection);
    } else {
      const queue = queues.get(selection.category) ?? [];
      queue.push(selection);
      queues.set(selection.category, queue);
    }
  }

  const ordered: Selection[] = [];
  for (let slot = 0; slot < categories.length; slot++) {
    const category = categories[slot];
    const selection = bySlot.get(slot) ?? queues.get(category)?.shift();
    if (!selection || selection.category !== category) return null;
    ordered.push(selection);
  }
  return [...queues.values()].some((queue) => queue.length > 0) ? null : ordered;
}

function candidateAtArrival(
  place: Place,
  category: string,
  parsed: ParsedPrompt,
  weather: WeatherHour[] | null,
  now: Date,
  arrival: Date,
  timeZone: string
): boolean {
  const result = filterPools(
    { [category]: [place] },
    parsed,
    weather,
    now,
    arrival,
    timeZone
  );
  return (result.pools[category] ?? []).some((candidate) => candidate.id === place.id);
}

interface StableChain {
  selections: Array<Selection & { location: LatLng }>;
  inbound: TravelLeg;
  interLegs: TravelLeg[];
  arrivals: Date[];
}

export async function rerouteItinerary(
  itinerary: Itinerary,
  disruption: Disruption,
  now: Date,
  depsIn: Partial<RerouteDeps> = {}
): Promise<RerouteResult> {
  const deps = { ...realDeps(), ...depsIn };
  const work = cloneItinerary(itinerary);
  const timeZone = work.timeZone ?? DEFAULT_ZONE;

  // Status derivation and the lock ratchet happen on the proposal. A failed
  // reroute leaves even those fields byte-identical on the caller's object.
  withStatuses(work, now);
  const floor = floorTime(work, now);
  const timedIdx = timedIndexes(work);
  const firstDownstreamPos = Math.max(0, disruption.legIndex) + 1;

  const affectedIdx: number[] = [];
  const affectedPositions: number[] = [];
  timedIdx.forEach((stopIndex, position) => {
    const stop = work.stops[stopIndex];
    if (
      position >= firstDownstreamPos &&
      stop.status !== "skipped" &&
      !stop.locked &&
      new Date(stop.start_time!).getTime() > floor.getTime()
    ) {
      affectedIdx.push(stopIndex);
      affectedPositions.push(position);
    }
  });

  logEvent("info", "reroute_started", {
    legIndex: disruption.legIndex,
    now: now.toISOString(),
    floor: floor.toISOString(),
    committedStarts: work.stops.map((stop) => stop.start_time),
    affectedIndexes: affectedIdx,
  });

  if (affectedIdx.length === 0) {
    return { rerouted: false, reason: "nothing after the current stop to replan" };
  }

  // A compacted list across a locked/skipped gap is not a chain. In
  // particular, never claim to repair leg k while silently skipping its
  // locked destination and starting at a later stop.
  if (
    affectedPositions[0] !== firstDownstreamPos ||
    affectedPositions.some(
      (position, index) => position !== affectedPositions[0] + index
    )
  ) {
    return { rerouted: false, reason: INCOMPLETE_REASON };
  }

  const firstAffectedTimedPos = affectedPositions[0];
  const prevTimedStop =
    firstAffectedTimedPos > 0
      ? work.stops[timedIdx[firstAffectedTimedPos - 1]]
      : null;
  if (!prevTimedStop?.end_time || !validLocation(prevTimedStop.location)) {
    return { rerouted: false, reason: INCOMPLETE_REASON };
  }

  const parsed = work.parsed ?? fallbackParsedFor(work);
  if (!parsed) return { rerouted: false, reason: UNKNOWN_LOCATION_MESSAGE };
  const categories = affectedIdx.map((index) => work.stops[index].category);
  const beforeSnaps = affectedIdx.map((index) => snap(work.stops[index]));
  const departMs = Math.max(
    floor.getTime(),
    new Date(prevTimedStop.end_time).getTime()
  );
  if (!Number.isFinite(departMs)) {
    return { rerouted: false, reason: INCOMPLETE_REASON };
  }
  const departISO = new Date(departMs).toISOString();

  // Pools and weather are fetched once for the whole proposal. Subsequent
  // stabilization passes only exclude proven-invalid candidate IDs.
  const rawPools = await deps.searchPools(parsed, categories);
  // The CITY's forecast, not the start's: a start may sit up to 75 km
  // outside the city, and every venue this gates is in the city. Older
  // plans carry no cityCenter and keep their original home fallback.
  const weatherOrigin =
    parsed.cityCenter ?? work.home?.location ?? parsed.home ?? null;
  const weather = weatherOrigin
    ? await deps.getWeather(weatherOrigin.latitude, weatherOrigin.longitude)
    : null;
  const keptIds = new Set(
    work.stops
      .filter((_, index) => !affectedIdx.includes(index))
      .map((stop) => stop.id)
      .filter((id): id is string => typeof id === "string")
  );
  const excluded = new Map<string, Set<string>>();
  let stable: StableChain | null = null;
  let stableOrdered: Selection[] = [];

  for (let pass = 0; pass < MAX_STABILIZATION_PASSES; pass++) {
    const pools: Record<string, Place[]> = {};
    for (const category of new Set(categories)) {
      const denied = excluded.get(category) ?? new Set<string>();
      pools[category] = (rawPools[category] ?? []).filter(
        (candidate) => !keptIds.has(candidate.id) && !denied.has(candidate.id)
      );
      if (pools[category].length === 0) {
        return { rerouted: false, reason: INCOMPLETE_REASON };
      }
    }

    const selected = await deps.selectVenues(parsed, pools, categories);
    const ordered = orderSelections(selected, categories);
    if (!ordered) return { rerouted: false, reason: INCOMPLETE_REASON };

    const used = new Set<string>(keptIds);
    const chosen: Array<{
      selection: Selection;
      place: Place;
      location: LatLng;
    }> = [];
    for (let slot = 0; slot < ordered.length; slot++) {
      const selection = ordered[slot];
      const id = selection.id;
      const place =
        typeof id === "string"
          ? pools[categories[slot]]?.find((candidate) => candidate.id === id)
          : undefined;
      if (!place || used.has(place.id)) {
        return { rerouted: false, reason: INCOMPLETE_REASON };
      }
      if (!validLocation(place.location)) {
        return { rerouted: false, reason: INCOMPLETE_REASON };
      }
      used.add(place.id);
      chosen.push({ selection, place, location: place.location });
    }

    let cursorMs = departMs;
    const arrivals: Date[] = [];
    const interLegs: TravelLeg[] = [];
    let invalid: { category: string; id: string } | null = null;

    const inbound = await deps.getSingleLeg(
      prevTimedStop.location,
      chosen[0].location,
      firstAffectedTimedPos - 1,
      new Date(cursorMs).toISOString(),
      firstAffectedTimedPos - 1 === disruption.legIndex
    );
    if (!validLeg(inbound)) {
      return { rerouted: false, reason: INCOMPLETE_REASON };
    }
    cursorMs += inbound.totalMinutes * 60_000;

    for (let slot = 0; slot < chosen.length; slot++) {
      const arrival = new Date(cursorMs);
      arrivals.push(arrival);
      const current = chosen[slot];
      if (
        !candidateAtArrival(
          current.place,
          categories[slot],
          parsed,
          weather,
          now,
          arrival,
          timeZone
        )
      ) {
        invalid = { category: categories[slot], id: current.place.id };
        break;
      }

      const duration = getDuration(categories[slot]);
      cursorMs +=
        (duration.baseMinutes + duration.bufferMinutes) * 60_000;
      if (slot < chosen.length - 1) {
        const absolutePair = firstAffectedTimedPos + slot;
        const routed = await deps.getSingleLeg(
          current.location,
          chosen[slot + 1].location,
          absolutePair,
          new Date(cursorMs).toISOString(),
          absolutePair === disruption.legIndex
        );
        if (!validLeg(routed)) {
          return { rerouted: false, reason: INCOMPLETE_REASON };
        }
        // buildSchedule consumes relative pair indexes for this sub-chain;
        // write-back converts them to absolute timed-pair indexes.
        interLegs.push({ ...routed, fromIndex: slot });
        cursorMs += routed.totalMinutes * 60_000;
      }
    }

    if (invalid) {
      const denied = excluded.get(invalid.category) ?? new Set<string>();
      denied.add(invalid.id);
      excluded.set(invalid.category, denied);
      continue;
    }

    stableOrdered = ordered;
    stable = {
      inbound,
      interLegs,
      arrivals,
      selections: chosen.map(({ selection, place, location }) => ({
        ...selection,
        id: place.id,
        name: place.displayName?.text ?? selection.name,
        rating: place.rating,
        priceLevel: place.priceLevel,
        description: place.editorialSummary?.text,
        currentOpeningHours: place.currentOpeningHours,
        location,
      })),
    };
    break;
  }

  if (!stable) return { rerouted: false, reason: UNSTABLE_REASON };

  const { stops: scheduled } = buildSchedule(
    stable.selections,
    "",
    now,
    stable.interLegs,
    stable.arrivals[0],
    null,
    timeZone
  );
  if (
    scheduled.length !== affectedIdx.length ||
    scheduled.some(
      (stop, index) =>
        stop.id === null ||
        !validLocation(stop.location) ||
        !stop.start_time ||
        new Date(stop.start_time).getTime() !== stable!.arrivals[index].getTime()
    )
  ) {
    return { rerouted: false, reason: INCOMPLETE_REASON };
  }

  affectedIdx.forEach((stopIndex, index) => {
    const next = scheduled[index];
    if (next.travelToNext) {
      next.travelToNext = {
        ...next.travelToNext,
        fromIndex: firstAffectedTimedPos + index,
      };
    }
    work.stops[stopIndex] = {
      ...next,
      status: "upcoming",
      locked: false,
    };
  });
  prevTimedStop.travelToNext = {
    ...stable.inbound,
    fromIndex: firstAffectedTimedPos - 1,
  };
  prevTimedStop.travelMinutesToNext = stable.inbound.totalMinutes;
  rebuildLegs(work);
  withStatuses(work, now);

  // Final invariant check before the one commit to the caller's object.
  for (let index = 0; index < itinerary.stops.length; index++) {
    if (affectedIdx.includes(index)) continue;
    const before = itinerary.stops[index];
    const after = work.stops[index];
    if (
      before.id !== after.id ||
      before.name !== after.name ||
      before.start_time !== after.start_time ||
      before.end_time !== after.end_time
    ) {
      return { rerouted: false, reason: INCOMPLETE_REASON };
    }
  }

  const changed: ChangedStop[] = affectedIdx.map((stopIndex, index) => ({
    stopIndex,
    before: beforeSnaps[index],
    after: snap(work.stops[stopIndex]),
    reason: stableOrdered[index].reason,
  }));
  const unchanged = work.stops
    .map((_, index) => index)
    .filter((index) => !affectedIdx.includes(index));

  Object.assign(itinerary, work);
  logEvent("info", "reroute_applied", {
    starts: itinerary.stops.map((stop) => stop.start_time),
  });

  return {
    rerouted: true,
    floor_time: floor.toISOString(),
    anchor_time: departISO,
    changed,
    unchanged,
  };
}
