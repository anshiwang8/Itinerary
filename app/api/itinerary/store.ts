// In-memory itinerary store — the foundation for the reroute engine.
// No persistence (comes later), no rerouting logic, no disruption
// handling. Keyed by itinerary id.
import { ScheduledStop } from "../schedule/schedule";
import { TravelLeg } from "../schedule/travel";
import { HomePoint } from "../schedule/home";
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
  /**
   * Leg 0: home → first stop. Origin metadata, NOT a stop — no status,
   * no lock, excluded from completion. Fixed history once the outing
   * starts; the reroute engine never reads or writes it.
   */
  homeLeg?: TravelLeg;
  /** the plan's origin point (geocoded starting address / city centre);
   * absent on pre-multi-city itineraries → engines fall back to HOME */
  home?: HomePoint;
  /** the plan's resolved IANA timezone (e.g. "America/Vancouver"). ALL
   * scheduling math and display labels for this plan use it — persisted so
   * every read (GET/swap/reroute/dev-sim) uses the SAME zone. Absent →
   * America/Toronto (pre-multi-city plans, Toronto, unresolvable). */
  timeZone?: string;
  /** original parse output — the reroute engine re-runs the pipeline with it */
  parsed?: ParsedPrompt;
}

// Survive Next dev hot-reloads: module state resets on recompile, the
// globalThis slot doesn't.
const g = globalThis as { __itineraryStore?: Map<string, Itinerary> };
const store: Map<string, Itinerary> = (g.__itineraryStore ??= new Map());

// ── Persistence seam (same discipline as the mock layer: a data-source
// swap, not a rewrite). The in-memory Map is fine for dev/e2e where one
// long-lived process serves every request — but on serverless (Vercel)
// each route invocation can land on a different instance, so globalThis
// does NOT survive between the POST that stores an itinerary and the
// GET/swap/reroute that read it. When a Redis REST endpoint is configured
// (Vercel KV or Upstash env vars), loadItinerary/saveItinerary go through
// it and Redis is the single source of truth; otherwise they collapse to
// the Map. Routes use ONLY these two; the engines never touch the store. ──
const KV_TTL_SECONDS = 7 * 24 * 60 * 60; // itineraries are ephemeral demos

function kvEnv(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

/** True when a persistent (Redis REST) store is configured. */
export function kvConfigured(): boolean {
  return kvEnv() !== null;
}

// Serverless without a persistent store = silent 404s mid-demo. Refuse
// loudly instead: the deploy checklist says to set the KV env vars.
function requirePersistenceOnServerless() {
  if (process.env.VERCEL && !kvConfigured()) {
    throw new Error(
      "No persistent store configured: itineraries can't survive serverless invocations in memory. " +
        "Set KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV / Upstash Redis) — see DEPLOY.md."
    );
  }
}

// One Upstash/Vercel-KV REST command, e.g. ["SET", key, value, "EX", ttl].
async function redis(cmd: (string | number)[]): Promise<unknown> {
  const kv = kvEnv()!;
  const res = await fetch(kv.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kv.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`KV request failed (${res.status}): ${data?.error ?? "unknown"}`);
  }
  return data?.result;
}

const kvKey = (id: string) => `itin:${id}`;

/**
 * Fetch an itinerary for a route handler. KV mode always reads Redis (a
 * per-instance memory copy could be stale the moment another instance
 * writes); memory mode reads the Map. Mutating routes MUST follow up with
 * saveItinerary — object identity alone persists nothing under KV.
 */
export async function loadItinerary(id: string): Promise<Itinerary | undefined> {
  requirePersistenceOnServerless();
  if (kvConfigured()) {
    const raw = await redis(["GET", kvKey(id)]);
    return typeof raw === "string" ? (JSON.parse(raw) as Itinerary) : undefined;
  }
  return store.get(id);
}

/** Write an itinerary back after creation or any mutation (statuses/lock
 * ratchet included — withStatuses mutates). Memory mode: Map upsert. */
export async function saveItinerary(itinerary: Itinerary): Promise<void> {
  requirePersistenceOnServerless();
  if (kvConfigured()) {
    await redis(["SET", kvKey(itinerary.id), JSON.stringify(itinerary), "EX", KV_TTL_SECONDS]);
    return;
  }
  store.set(itinerary.id, itinerary);
}

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
  parsed?: ParsedPrompt,
  homeLeg?: TravelLeg | null,
  home?: HomePoint | null,
  timeZone?: string | null
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
    ...(homeLeg ? { homeLeg } : {}),
    ...(home ? { home } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(parsed ? { parsed } : {}),
  };
  store.set(itinerary.id, itinerary);
  return itinerary;
}

export function getItinerary(id: string): Itinerary | undefined {
  return store.get(id);
}

/**
 * floor_time = max(now, end of the currently active stop). Stops at or
 * before this instant are underway/past and never change. The single
 * source of this rule — the reroute and swap engines both call it.
 * Assumes withStatuses(itinerary, now) has already been applied.
 */
export function floorTime(itinerary: Itinerary, now: Date): Date {
  const active = itinerary.stops.find((s) => s.status === "active");
  return active?.end_time
    ? new Date(Math.max(now.getTime(), new Date(active.end_time).getTime()))
    : now;
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
