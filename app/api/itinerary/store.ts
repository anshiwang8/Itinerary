// In-memory itinerary store — the foundation for the reroute engine.
// No persistence (comes later), no rerouting logic, no disruption
// handling. Keyed by itinerary id.
import { ScheduledStop } from "../schedule/schedule";
import { TravelLeg } from "../schedule/travel";
import { ParsedPrompt } from "../places/search/filter";

export type StopStatus = "upcoming" | "active" | "completed" | "skipped";
export type ItineraryStatus = "planning" | "active" | "completed";

export interface ItineraryStop extends ScheduledStop {
  status: StopStatus;
  /**
   * Ratchet: flips true the first time the stop is active and NEVER
   * unflips — survives into completed (and backwards dev-time travel).
   * No consumer yet; the reroute engine is its consumer.
   */
  locked: boolean;
}

export interface Itinerary {
  id: string;
  createdAt: string;
  status: ItineraryStatus;
  stops: ItineraryStop[];
  legs: TravelLeg[];
  /** original parse output — the reroute engine re-runs the pipeline with it */
  parsed?: ParsedPrompt;
}

// Survive Next dev hot-reloads: module state resets on recompile, the
// globalThis slot doesn't.
const g = globalThis as { __itineraryStore?: Map<string, Itinerary> };
const store: Map<string, Itinerary> = (g.__itineraryStore ??= new Map());

/**
 * Pure status derivation against a reference time t:
 *   t < start          → upcoming
 *   start <= t < end   → active
 *   t >= end           → completed
 * Stops without usable times can't progress — treated as skipped.
 */
export function deriveStopStatus(
  start: string | null,
  end: string | null,
  t: Date
): StopStatus {
  if (!start || !end) return "skipped";
  const ts = new Date(start).getTime();
  const te = new Date(end).getTime();
  const now = t.getTime();
  if (isNaN(ts) || isNaN(te)) return "skipped";
  if (now < ts) return "upcoming";
  if (now < te) return "active";
  return "completed";
}

export function createItinerary(
  stops: ScheduledStop[],
  legs: TravelLeg[],
  parsed?: ParsedPrompt
): Itinerary {
  const itinerary: Itinerary = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "planning",
    stops: stops.map((s) => ({
      ...s,
      // null-id picks (blocked/empty pools) have no venue to visit
      status: s.id === null ? "skipped" : "upcoming",
      locked: false,
    })),
    legs,
    ...(parsed ? { parsed } : {}),
  };
  store.set(itinerary.id, itinerary);
  return itinerary;
}

export function getItinerary(id: string): Itinerary | undefined {
  return store.get(id);
}

/**
 * Compute stop + itinerary statuses against reference time t.
 * Statuses are pure derivations; `locked` is the one ratchet — once a
 * stop has been active (or is already past), it stays locked even if
 * the dev time control rewinds t.
 */
export function withStatuses(itinerary: Itinerary, t: Date): Itinerary {
  for (const stop of itinerary.stops) {
    if (stop.status === "skipped") continue;
    const status = deriveStopStatus(stop.start_time, stop.end_time, t);
    stop.status = status;
    if (status === "active" || status === "completed") stop.locked = true;
  }
  itinerary.status = itinerary.stops.every(
    (s) => s.status === "completed" || s.status === "skipped"
  )
    ? "completed"
    : "active";
  return itinerary;
}
