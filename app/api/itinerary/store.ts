// Versioned itinerary persistence. Redis is authoritative when configured;
// memory mode implements the same clone/CAS contract for dev and tests.
import { ScheduledStop } from "../schedule/schedule";
import {
  assignTransitPaletteSlots,
  type PlanTravelMode,
  type TravelLeg,
} from "../schedule/travel";
import { HomePoint } from "../schedule/home";
import { ParsedPrompt } from "../places/search/filter";
import { ApiError, isRecord } from "../_shared/http";
import {
  ProviderError,
  fetchProvider,
  readProviderJson,
  requireProviderRecord,
} from "../_shared/provider";

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
  /** Monotonic optimistic-concurrency token. Version 1 is the initial write. */
  version: number;
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
  /**
   * The end the USER STATED, resolved to an instant ("back by 10", "3-8pm").
   * Absent whenever they never named a finish — which is most plans, every
   * plan created before this field existed, and the deliberate meaning of
   * "no ceiling": a swap may then push the day as late as real opening hours
   * allow. Code must NEVER invent one; the planner works under the same rule
   * ("an end time is a stated fact or nothing").
   *
   * It is persisted because it outlives the request that knew it. The planner
   * resolves it, `checkWindowFit` validates the INITIAL plan against it in the
   * browser, and then it used to be dropped — so a swap hours later had no way
   * to know the day was supposed to be over by ten. Same reason
   * `ownerIsAnonymous` is recorded at creation rather than looked up later.
   */
  plannedEndISO?: string;
  /**
   * How this plan gets around — chosen once at creation from the landing
   * toggle, never detected from the prompt and never changed by an engine.
   *
   * OPTIONAL, exactly like `timeZone` and `plannedEndISO`, and ABSENT MEANS
   * "transit": every plan stored before this field existed stays valid with
   * no migration, and reads as the behaviour it was actually built with.
   *
   * It is a PLAN-LEVEL INTENT, not a per-leg guarantee. A driving plan
   * legitimately contains WALK legs wherever a drive is the wrong answer
   * (`DRIVING_SHORT_LEG_WALK_METERS`), so never infer a leg's mode from it,
   * and never assume `travelMode === "driving"` means every leg is a drive.
   *
   * It is persisted because it outlives the request that knew it — a swap,
   * a removal or a reroute hours later has to re-price its legs the same
   * way the plan was built, or the day silently changes how it travels.
   */
  travelMode?: PlanTravelMode;
  /** original parse output — the reroute engine re-runs the pipeline with it */
  parsed?: ParsedPrompt;
  /**
   * The verified uid this plan belongs to (anonymous guest OR real account).
   * OPTIONAL on purpose: plans created before Stage 1B have none, and mock
   * e2e runs with no Firebase at all. Absent = unowned, which is readable and
   * mutable exactly as before — keep-on-missing-data applies to owners too.
   * Never set from a browser-supplied value; see `_shared/caller.ts`.
   */
  ownerUid?: string;
  /** Whether that owner is a Firebase ANONYMOUS user. Recorded at creation
   *  from the verified token rather than looked up later, because the archive
   *  decision happens long after the request that knew the answer. */
  ownerIsAnonymous?: boolean;
  /** Set once, when the concluded plan was written to history. Its presence
   *  is what stops a derived-on-every-read conclusion from re-archiving. */
  archivedAt?: string;
  /**
   * Set when the USER ended this plan from the stop control, as opposed to it
   * running out the clock.
   *
   * It has to be persisted rather than expressed as `status: "completed"`,
   * because `withStatuses` RE-DERIVES status from the clock on every read — a
   * status written here would simply be recomputed back to "active" on the
   * next GET. This marker is the one thing that says "a person decided this
   * was over", and `isResumable` reads it so an ended plan cannot come back.
   */
  endedAt?: string;
}

// Survive Next dev hot-reloads: module state resets on recompile, the
// globalThis slot doesn't.
const g = globalThis as {
  __itineraryStore?: Map<string, Itinerary>;
  __itineraryOwnerIndex?: Map<string, string>;
};
const store: Map<string, Itinerary> = (g.__itineraryStore ??= new Map());
/** uid → current plan id, for the memory (dev/e2e) mode of the owner index. */
const ownerIndex: Map<string, string> = (g.__itineraryOwnerIndex ??= new Map());

// ── Persistence seam (same discipline as the mock layer: a data-source
// swap, not a rewrite). The in-memory Map is fine for dev/e2e where one
// long-lived process serves every request — but on serverless (Vercel)
// each route invocation can land on a different instance, so globalThis
// does NOT survive between the POST that stores an itinerary and the
// GET/swap/reroute that read it. When a Redis REST endpoint is configured
// (Vercel KV or Upstash env vars), all persistence operations go through it
// and Redis is the single source of truth. Routes use the load/create/CAS
// seam; engines never touch the store. ──
const KV_TTL_SECONDS = 7 * 24 * 60 * 60; // itineraries are ephemeral demos
const DEFAULT_UPDATE_ATTEMPTS = 2;

export class ItineraryConflictError extends ApiError {
  constructor() {
    super(
      409,
      "itinerary_conflict",
      "This itinerary changed while your request was running. Refresh it and try again."
    );
    this.name = "ItineraryConflictError";
  }
}

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
  const res = await fetchProvider("redis", kv.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kv.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  const data = requireProviderRecord("redis", await readProviderJson("redis", res));
  if (!Object.prototype.hasOwnProperty.call(data, "result")) {
    throw new ProviderError("redis", 502, "redis_invalid_response");
  }
  return data.result;
}

const kvKey = (id: string) => `itin:${id}`;
// The owner index: uid → the id of that user's current plan. This is what
// makes "resume on refresh" possible at all — the page holds the itinerary in
// React state only, so a reload forgets the id while the plan itself is still
// sitting in Redis. Storing the id under the user is the missing link, not
// more persistence for the plan.
const ownerKey = (uid: string) => `owner:${uid}:active`;

// Redis compares the stored version and writes the complete proposal in one
// server-side operation. KEEPTTL is load-bearing: a mutation must not refresh
// a seven-day plan or turn it into a permanent key.
const CAS_LUA = `
local current = redis.call("GET", KEYS[1])
if not current then
  return {-1, 0}
end
local ok, decoded = pcall(cjson.decode, current)
if not ok then
  return {-2, 0}
end
local currentVersion = tonumber(decoded.version) or 1
if currentVersion ~= tonumber(ARGV[1]) then
  return {0, currentVersion}
end
redis.call("SET", KEYS[1], ARGV[2], "KEEPTTL")
return {1, tonumber(ARGV[1]) + 1}
`.trim();

function cloneItinerary(itinerary: Itinerary): Itinerary {
  return JSON.parse(JSON.stringify(itinerary)) as Itinerary;
}

function storedItinerary(raw: string, expectedId: string): Itinerary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderError("redis", 502, "redis_invalid_response");
  }
  if (
    !isRecord(parsed) ||
    parsed.id !== expectedId ||
    typeof parsed.createdAt !== "string" ||
    !Array.isArray(parsed.stops) ||
    !Array.isArray(parsed.legs)
  ) {
    throw new ProviderError("redis", 502, "redis_invalid_response");
  }
  // Plans created before the CAS rollout are treated as version 1. The Lua
  // script uses the same fallback, so their first mutation migrates them.
  const version =
    typeof parsed.version === "number" &&
    Number.isSafeInteger(parsed.version) &&
    parsed.version >= 1
      ? parsed.version
      : 1;
  return { ...(parsed as unknown as Itinerary), version };
}

/**
 * Fetch an itinerary for a route handler. KV mode always reads Redis (a
 * per-instance memory copy could be stale the moment another instance
 * writes); memory mode returns an isolated clone so object identity can
 * never bypass compare-and-set.
 */
export async function loadItinerary(id: string): Promise<Itinerary | undefined> {
  requirePersistenceOnServerless();
  if (kvConfigured()) {
    const raw = await redis(["GET", kvKey(id)]);
    return typeof raw === "string" ? storedItinerary(raw, id) : undefined;
  }
  const current = store.get(id);
  return current ? cloneItinerary(current) : undefined;
}

/** Create a new version-1 itinerary. Existing ids are never overwritten. */
export async function saveItinerary(itinerary: Itinerary): Promise<Itinerary> {
  requirePersistenceOnServerless();
  const initial = cloneItinerary({ ...itinerary, version: 1 });
  if (kvConfigured()) {
    const result = await redis([
      "SET",
      kvKey(initial.id),
      JSON.stringify(initial),
      "NX",
      "EX",
      KV_TTL_SECONDS,
    ]);
    if (result !== "OK") throw new ItineraryConflictError();
    return cloneItinerary(initial);
  }
  if (store.has(initial.id)) throw new ItineraryConflictError();
  store.set(initial.id, cloneItinerary(initial));
  return cloneItinerary(initial);
}

// ── Owner index (uid → that user's current plan id) ───────────────────────
//
// A pointer, never a second copy of the plan: the itinerary itself stays the
// single source of truth under `itin:<id>`, and this only records which one a
// user was last given. It shares the plan's TTL so the pointer can never
// outlive what it points at — and `activeItineraryIdForOwner` re-loads
// through the normal path anyway, so a dangling pointer degrades to "no
// active plan" rather than an error.

/** Point a user at their current plan. Best-effort by design: failing to
 *  write the pointer must not fail the plan that was just created. */
export async function setActiveItineraryForOwner(uid: string, id: string): Promise<void> {
  const owner = uid.trim();
  if (owner.length === 0) return;
  if (kvConfigured()) {
    await redis(["SET", ownerKey(owner), id, "EX", KV_TTL_SECONDS]);
    return;
  }
  ownerIndex.set(owner, id);
}

/** The id this user was last pointed at, or undefined. */
export async function activeItineraryIdForOwner(uid: string): Promise<string | undefined> {
  const owner = uid.trim();
  if (owner.length === 0) return undefined;
  if (kvConfigured()) {
    const raw = await redis(["GET", ownerKey(owner)]);
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return ownerIndex.get(owner);
}

/** Drop the pointer once its plan has concluded, so a finished outing does
 *  not keep resuming over the landing page. The plan itself is untouched. */
export async function clearActiveItineraryForOwner(uid: string): Promise<void> {
  const owner = uid.trim();
  if (owner.length === 0) return;
  if (kvConfigured()) {
    await redis(["DEL", ownerKey(owner)]);
    return;
  }
  ownerIndex.delete(owner);
}

/** Atomically replace exactly one known version and preserve its TTL. */
export async function compareAndSetItinerary(
  proposal: Itinerary,
  expectedVersion: number
): Promise<Itinerary> {
  requirePersistenceOnServerless();
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new ItineraryConflictError();
  }
  const next = cloneItinerary({ ...proposal, version: expectedVersion + 1 });

  if (kvConfigured()) {
    const result = await redis([
      "EVAL",
      CAS_LUA,
      1,
      kvKey(next.id),
      expectedVersion,
      JSON.stringify(next),
    ]);
    if (
      !Array.isArray(result) ||
      typeof result[0] !== "number" ||
      result[0] !== 1 ||
      result[1] !== next.version
    ) {
      throw new ItineraryConflictError();
    }
    return cloneItinerary(next);
  }

  // No await between compare and set: atomic within one Node process, and
  // the same observable contract as the Redis script in dev/e2e.
  const current = store.get(next.id);
  if (!current || current.version !== expectedVersion) {
    throw new ItineraryConflictError();
  }
  store.set(next.id, cloneItinerary(next));
  return cloneItinerary(next);
}

export interface ItineraryUpdate<T> {
  value: T;
  /** Pure/no-op reads can opt out of a version bump and persistence write. */
  changed?: boolean;
}

export interface UpdatedItinerary<T> {
  itinerary: Itinerary;
  value: T;
}

/**
 * Load → clone → propose → CAS. A conflict retries only when no client
 * version was supplied; an explicitly stale client receives a deterministic
 * 409 rather than silently applying its intent to a different plan.
 */
export async function updateItinerary<T>(
  id: string,
  mutate: (proposal: Itinerary) => Promise<ItineraryUpdate<T>> | ItineraryUpdate<T>,
  options: { expectedVersion?: number; maxAttempts?: number } = {}
): Promise<UpdatedItinerary<T> | undefined> {
  const requestedAttempts =
    options.expectedVersion === undefined
      ? options.maxAttempts ?? DEFAULT_UPDATE_ATTEMPTS
      : 1;
  const maxAttempts = Math.max(1, Math.min(3, requestedAttempts));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const base = await loadItinerary(id);
    if (!base) return undefined;
    if (
      options.expectedVersion !== undefined &&
      base.version !== options.expectedVersion
    ) {
      throw new ItineraryConflictError();
    }

    const proposal = cloneItinerary(base);
    const outcome = await mutate(proposal);
    if (outcome.changed === false) {
      return { itinerary: base, value: outcome.value };
    }

    try {
      const committed = await compareAndSetItinerary(proposal, base.version);
      return { itinerary: committed, value: outcome.value };
    } catch (error) {
      if (!(error instanceof ItineraryConflictError) || attempt + 1 >= maxAttempts) {
        throw error;
      }
    }
  }
  throw new ItineraryConflictError();
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

/**
 * Build an itinerary object. PURE — it does not persist. Callers must
 * follow with `saveItinerary`, which is the only write path and the only
 * one that enforces the serverless persistence check. This used to write
 * straight into the in-memory Map, which made it the single store entry
 * point that "succeeded" on Vercel without KV configured, and left a
 * shadow copy that is never read once KV is on (code-audit §2.1).
 */
export function createItinerary(
  stops: ScheduledStop[],
  legs: TravelLeg[],
  parsed?: ParsedPrompt,
  homeLeg?: TravelLeg | null,
  home?: HomePoint | null,
  timeZone?: string | null,
  plannedEndISO?: string | null,
  travelMode?: PlanTravelMode | null
): Itinerary {
  const itinerary: Itinerary = {
    id: crypto.randomUUID(),
    version: 1,
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
    ...(plannedEndISO ? { plannedEndISO } : {}),
    // "transit" is the ABSENT meaning, so it is never written out — a
    // transit plan stays byte-identical to a pre-drive-mode one.
    ...(travelMode === "driving" ? { travelMode } : {}),
    ...(parsed ? { parsed } : {}),
  };
  return itinerary;
}

/**
 * Indexes of the stops that have a time — "which stops are timed" is a real
 * domain concept, and legs join TIMED pairs, so both engines need it. It was
 * written out four times (code-audit 2026-07-18 §5.4).
 */
export function timedIndexes(itinerary: Itinerary): number[] {
  const out: number[] = [];
  itinerary.stops.forEach((s, i) => {
    if (s.start_time) out.push(i);
  });
  return out;
}

/** Rebuild `itinerary.legs` from the stops' own travelToNext chain — the
 *  legs array is a projection of the stops, never an independent source. */
export function rebuildLegs(itinerary: Itinerary): void {
  itinerary.legs = itinerary.stops
    .filter((s) => s.start_time && s.travelToNext)
    .map((s) => s.travelToNext!);
  // Every successful route-changing mutation already converges here. Reserve
  // untouched ride slots first, then fill freshly computed rides across the
  // final topology (home first) without changing which legs were rebuilt.
  assignTransitPaletteSlots([
    ...(itinerary.homeLeg ? [itinerary.homeLeg] : []),
    ...itinerary.legs,
  ]);
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
export function withStatuses(
  itinerary: Itinerary,
  t: Date,
  /** optional out-param: set `changed` when anything actually moved, so a
   *  read-only GET doesn't have to write back (code-audit §2.4) */
  out?: { changed: boolean }
): Itinerary {
  let changed = false;
  for (const stop of itinerary.stops) {
    if (stop.status === "skipped") continue;
    const status = deriveStopStatus(stop.start_time, stop.end_time, t);
    if (stop.status !== status) changed = true;
    stop.status = status;
    if ((status === "active" || status === "completed") && !stop.locked) {
      stop.locked = true;
      changed = true;
    }
  }
  const itineraryStatus = nextItineraryStatus(itinerary, t);
  if (itinerary.status !== itineraryStatus) changed = true;
  itinerary.status = itineraryStatus;
  if (out) out.changed = changed;
  return itinerary;
}

/**
 * "planning" until the outing actually starts, then active, then completed.
 * The pre-start state used to be unreachable: every GET overwrote the
 * freshly-created "planning" with "active", so a plan booked for tomorrow
 * evening reported itself as underway all day today (code-audit §7.4).
 */
function nextItineraryStatus(itinerary: Itinerary, t: Date): ItineraryStatus {
  const live = itinerary.stops.filter((s) => s.status !== "skipped");
  if (live.length > 0 && live.every((s) => s.status === "completed")) return "completed";
  if (itinerary.stops.every((s) => s.status === "completed" || s.status === "skipped")) {
    return "completed";
  }
  const started = itinerary.stops.some(
    (s) => s.status === "active" || s.status === "completed"
  );
  return started ? "active" : "planning";
}
