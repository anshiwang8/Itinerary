import type { Itinerary } from "../api/itinerary/store";
import type { Selection } from "../api/select/selectVenues";
import type { TravelLeg, TransitSummary } from "../api/schedule/travel";
import type { CurrentOpeningHours } from "../api/places/search/hours";
import type { DropEntry, ParsedPrompt, Place } from "../api/places/search/filter";
import type { PlanIntent } from "../api/parse/planner";
import type {
  GeocodeBounds,
  GeocodeCandidate,
  GeocodeOutcome,
} from "../api/geocode/geocode";
import { normalizeZone } from "./zoneTime";

export interface ClientWeatherHour {
  hourISO: string;
  tempC: number | null;
  precipProbability: number | null;
  condition: string | null;
}

export interface ClientWeatherBlock {
  category: string;
  weatherBlocked: true;
  reason: string;
}

export interface PlacesPayload {
  pools: Record<string, Place[]>;
  drops: DropEntry[];
  weatherBlocks: ClientWeatherBlock[];
}

export type ReroutePayload =
  | { rerouted: false; reason: string }
  | {
      rerouted: true;
      floor_time: string;
      anchor_time: string;
      changed: Array<{
        stopIndex: number;
        before: { start: string | null };
      }>;
    };

/** The engine's proposal ran the day past the end the user stated. Mirrors
 *  `EndTimeConfirm` in the swap engine; labels are pre-formatted THERE, in the
 *  plan's zone, so the browser never renders a plan time in the viewer's. */
export interface SwapEndTimeConfirm {
  proposedEndISO: string;
  statedEndISO: string;
  overrunMinutes: number;
  proposedEndLabel: string;
  statedEndLabel: string;
}

export type SwapPayload =
  | {
      swapped: false;
      reason: string;
      /** present ⇒ a QUESTION the user can answer yes to, not a refusal */
      confirm?: SwapEndTimeConfirm;
    }
  | {
      swapped: true;
      reason: string;
      stopIndex: number;
      path: "refilter" | "research" | "time" | "duration";
      before: { category: string };
      downstreamShifted: number[];
    };

/** What POST /api/itinerary/[id]/remove answers with. Mirrors `RemoveResult`
 *  in the engine; `removed: false` is always a plain refusal — a removal has
 *  no question to ask, so there is no `confirm` arm here as there is on a
 *  swap. */
export type RemovePayload =
  | { removed: false; reason: string }
  | {
      removed: true;
      reason: string;
      stopIndex: number;
      before: { name: string | null; category: string };
      /** indices AFTER the splice, of stops whose times moved */
      downstreamShifted: number[];
    };

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as JsonRecord;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return (
    finiteNumber(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function validLegIndex(value: unknown): value is number {
  return (
    finiteNumber(value) &&
    Number.isSafeInteger(value) &&
    value >= -1 &&
    value <= 1_000
  );
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function validInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

function nullableInstant(value: unknown): value is string | null {
  return value === null || validInstant(value);
}

function optionalInstant(value: unknown): value is string | null | undefined {
  return value === undefined || nullableInstant(value);
}

function isLatLng(value: unknown): value is {
  latitude: number;
  longitude: number;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const location = value as JsonRecord;
  return (
    finiteNumber(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    finiteNumber(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

function optionalLatLng(value: unknown): boolean {
  return value === undefined || value === null || isLatLng(value);
}

function isHoursPoint(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const point = value as JsonRecord;
  return (
    nonNegativeInteger(point.day, 6) &&
    nonNegativeInteger(point.hour, 23) &&
    nonNegativeInteger(point.minute, 59)
  );
}

function isCurrentOpeningHours(value: unknown): value is CurrentOpeningHours {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const hours = value as JsonRecord;
  if (!optionalBoolean(hours.openNow)) return false;
  if (hours.periods === undefined) return true;
  return (
    Array.isArray(hours.periods) &&
    hours.periods.every((period) => {
      if (
        typeof period !== "object" ||
        period === null ||
        Array.isArray(period)
      ) {
        return false;
      }
      const entry = period as JsonRecord;
      return (
        (entry.open === undefined || isHoursPoint(entry.open)) &&
        (entry.close === undefined || isHoursPoint(entry.close))
      );
    })
  );
}

const TRAVEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRANSIT_PALETTE_CAPACITY = 24;
const RIDE_IDENTITY_FIELDS = [
  "rideId",
  "sourceStepIndex",
  "paletteSlot",
] as const;

function validTravelId(value: unknown): value is string {
  return typeof value === "string" && TRAVEL_ID_PATTERN.test(value);
}

function rideIdentityBundle(value: JsonRecord): "legacy" | "complete" | "invalid" {
  const present = RIDE_IDENTITY_FIELDS.map((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  );
  if (present.every((entry) => !entry)) return "legacy";
  if (!present.every(Boolean)) return "invalid";

  return validTravelId(value.rideId) &&
    nonNegativeInteger(value.sourceStepIndex) &&
    (value.paletteSlot === null ||
      nonNegativeInteger(value.paletteSlot, TRANSIT_PALETTE_CAPACITY - 1))
    ? "complete"
    : "invalid";
}

function isTransitSummary(value: unknown): value is TransitSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const transit = value as JsonRecord;
  return (
    rideIdentityBundle(transit) !== "invalid" &&
    typeof transit.lineName === "string" &&
    nullableString(transit.shortName) &&
    nullableString(transit.color) &&
    nullableString(transit.textColor) &&
    nullableString(transit.vehicle) &&
    typeof transit.headsign === "string" &&
    (transit.stopCount === null ||
      nonNegativeInteger(transit.stopCount, 10_000)) &&
    typeof transit.departStop === "string" &&
    typeof transit.arriveStop === "string" &&
    // The provider's board/alight instants and stop coordinates. Optional
    // AND nullable in both directions: absent on every plan stored before
    // they were read, null whenever the response omits them. Present and
    // malformed is the only rejection — a coordinate that fails here would
    // otherwise be a map marker at a number nobody published.
    optionalInstant(transit.boardISO) &&
    optionalInstant(transit.alightISO) &&
    optionalLatLng(transit.boardLocation) &&
    optionalLatLng(transit.alightLocation)
  );
}

function isPlace(value: unknown): value is Place {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const place = value as JsonRecord;
  return typeof place.id === "string" && place.id.length > 0;
}

function isDropEntry(value: unknown): value is DropEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const drop = value as JsonRecord;
  return (
    typeof drop.category === "string" &&
    typeof drop.name === "string" &&
    typeof drop.id === "string" &&
    typeof drop.rule === "string" &&
    typeof drop.detail === "string"
  );
}

function isWeatherBlock(value: unknown): value is ClientWeatherBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const block = value as JsonRecord;
  return (
    typeof block.category === "string" &&
    block.weatherBlocked === true &&
    typeof block.reason === "string"
  );
}

function isSelection(value: unknown): value is Selection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const selection = value as JsonRecord;
  return (
    typeof selection.category === "string" &&
    (selection.id === null || typeof selection.id === "string") &&
    typeof selection.reason === "string" &&
    (selection.slot === undefined ||
      (typeof selection.slot === "number" && Number.isInteger(selection.slot))) &&
    (selection.plannedMinutes === undefined ||
      (finiteNumber(selection.plannedMinutes) && selection.plannedMinutes > 0))
  );
}

// The leg-geometry bounds, written out again rather than imported: this file
// runs in the BROWSER and `travel.ts` pulls in server-only modules, which is
// the same reason every other bound here (1_440 minutes, 64-char instants) is
// spelled twice. Keep them equal to travel.ts's own constants.
const MAX_PATH_POLYLINE_CHARS = 4_096;
const MAX_PATH_SEGMENTS_PER_LEG = 128;

/** One drawable step of a leg. Rejected here (rather than dropped, as the
 *  server does on ingest) for the same reason every other guard in this file
 *  rejects: by the time a payload reaches the browser the server has already
 *  sanitized it, so a malformed segment means the data is not what it claims
 *  to be. `color` is optional AND nullable — a walk step publishes none. */
function isPathSegment(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const segment = value as JsonRecord;
  const baseIsValid =
    (segment.mode === "walk" || segment.mode === "transit") &&
    typeof segment.encodedPolyline === "string" &&
    segment.encodedPolyline.length > 0 &&
    segment.encodedPolyline.length <= MAX_PATH_POLYLINE_CHARS &&
    (segment.color === undefined || nullableString(segment.color));
  if (!baseIsValid) return false;

  const identity = rideIdentityBundle(segment);
  return segment.mode === "walk"
    ? identity === "legacy"
    : identity !== "invalid";
}

type CompleteRideIdentity = {
  rideId: string;
  sourceStepIndex: number;
  paletteSlot: number | null;
};

type TopologyOccurrence = CompleteRideIdentity & { legIndex: number };

function completeRideIdentity(value: unknown): CompleteRideIdentity | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const record = value as JsonRecord;
  if (rideIdentityBundle(record) !== "complete") return null;
  return {
    rideId: record.rideId as string,
    sourceStepIndex: record.sourceStepIndex as number,
    paletteSlot: record.paletteSlot as number | null,
  };
}

function sameOccurrence(a: TopologyOccurrence, b: TopologyOccurrence): boolean {
  return (
    a.legIndex === b.legIndex &&
    a.rideId === b.rideId &&
    a.sourceStepIndex === b.sourceStepIndex
  );
}

function sameRideIdentity(
  a: CompleteRideIdentity,
  b: CompleteRideIdentity
): boolean {
  return (
    a.rideId === b.rideId &&
    a.sourceStepIndex === b.sourceStepIndex &&
    a.paletteSlot === b.paletteSlot
  );
}

/** Browser-side relational validation for the complete travel topology.
 * Shape-valid records must still agree on the exact app-owned occurrence,
 * and distinct occurrences must not claim the same non-null palette slot. */
function hasCoherentTravelIdentityTopology(legs: JsonRecord[]): boolean {
  const legIds = new Set<string>();
  const byRideId = new Map<string, TopologyOccurrence>();
  const bySource = new Map<string, TopologyOccurrence>();
  const bySlot = new Map<number, TopologyOccurrence>();

  const register = (candidate: TopologyOccurrence): boolean => {
    const sameRide = byRideId.get(candidate.rideId);
    if (
      sameRide &&
      (!sameOccurrence(sameRide, candidate) ||
        sameRide.paletteSlot !== candidate.paletteSlot)
    ) {
      return false;
    }
    const sameSource = bySource.get(
      `${candidate.legIndex}:${candidate.sourceStepIndex}`
    );
    if (
      sameSource &&
      (!sameOccurrence(sameSource, candidate) ||
        sameSource.paletteSlot !== candidate.paletteSlot)
    ) {
      return false;
    }
    if (candidate.paletteSlot !== null) {
      const sameSlot = bySlot.get(candidate.paletteSlot);
      if (sameSlot && !sameOccurrence(sameSlot, candidate)) return false;
    }
    byRideId.set(candidate.rideId, candidate);
    bySource.set(
      `${candidate.legIndex}:${candidate.sourceStepIndex}`,
      candidate
    );
    if (candidate.paletteSlot !== null) {
      bySlot.set(candidate.paletteSlot, candidate);
    }
    return true;
  };

  for (const [legIndex, leg] of legs.entries()) {
    if (typeof leg.legId === "string") {
      if (legIds.has(leg.legId)) return false;
      legIds.add(leg.legId);
    }
    const segmentFacts = Array.isArray(leg.transitSegments)
      ? leg.transitSegments
      : [];
    const hasLegIdentity = typeof leg.legId === "string";
    const allFacts = [
      ...(leg.transit ? [leg.transit] : []),
      ...segmentFacts,
    ];
    if (
      hasLegIdentity &&
      Boolean(leg.transit) !== (segmentFacts.length > 0)
    ) {
      return false;
    }
    for (const fact of allFacts) {
      if (hasLegIdentity !== (completeRideIdentity(fact) !== null)) {
        return false;
      }
    }
    const compatibilityIdentity = completeRideIdentity(leg.transit);
    const firstSegmentIdentity = completeRideIdentity(segmentFacts[0]);
    if (
      compatibilityIdentity &&
      firstSegmentIdentity &&
      !sameRideIdentity(compatibilityIdentity, firstSegmentIdentity)
    ) {
      return false;
    }
    const factRideIds = new Set<string>();
    for (const fact of segmentFacts) {
      const identity = completeRideIdentity(fact);
      if (!identity) continue;
      if (factRideIds.has(identity.rideId)) return false;
      factRideIds.add(identity.rideId);
    }
    for (const fact of allFacts) {
      const identity = completeRideIdentity(fact);
      if (identity && !register({ ...identity, legIndex })) return false;
    }
  }

  for (const [legIndex, leg] of legs.entries()) {
    const hasLegIdentity = typeof leg.legId === "string";
    const pathsSeen = new Set<string>();
    const paths = Array.isArray(leg.pathSegments) ? leg.pathSegments : [];
    for (const path of paths) {
      if (
        typeof path !== "object" ||
        path === null ||
        Array.isArray(path) ||
        (path as JsonRecord).mode !== "transit"
      ) {
        continue;
      }
      const identity = completeRideIdentity(path);
      if (!identity) {
        if (hasLegIdentity) return false;
        continue;
      }
      if (!hasLegIdentity) return false;
      const occurrenceKey = `${legIndex}:${identity.rideId}`;
      if (
        pathsSeen.has(occurrenceKey) ||
        !register({ ...identity, legIndex })
      ) {
        return false;
      }
      pathsSeen.add(occurrenceKey);
    }
  }
  return true;
}

function isTravelLegShape(value: unknown): value is TravelLeg {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const leg = value as JsonRecord;
  return (
    (leg.legId === undefined || validTravelId(leg.legId)) &&
    validLegIndex(leg.fromIndex) &&
    // Mirrors the server's leg-mode allowlist. "driving" is a LEG mode, and
    // it appears alongside walk legs inside one driving plan.
    (leg.mode === "walk" ||
      leg.mode === "transit" ||
      leg.mode === "driving" ||
      leg.mode === "unknown") &&
    nonNegativeInteger(leg.rawMinutes, 1_440) &&
    nonNegativeInteger(leg.marginMinutes, 1_440) &&
    nonNegativeInteger(leg.totalMinutes, 1_440) &&
    (leg.distanceMeters === null ||
      (finiteNumber(leg.distanceMeters) && leg.distanceMeters >= 0)) &&
    nullableString(leg.encodedPolyline) &&
    (leg.transit === undefined || isTransitSummary(leg.transit)) &&
    (leg.transitSegments === undefined ||
      (Array.isArray(leg.transitSegments) &&
        leg.transitSegments.every(isTransitSummary))) &&
    // absent on a walk leg with no step geometry, on the unknown estimate,
    // and on every plan stored before per-step geometry was read
    (leg.pathSegments === undefined ||
      (Array.isArray(leg.pathSegments) &&
        leg.pathSegments.length <= MAX_PATH_SEGMENTS_PER_LEG &&
        leg.pathSegments.every(isPathSegment)))
  );
}

function isTravelLeg(value: unknown): value is TravelLeg {
  return (
    isTravelLegShape(value) &&
    hasCoherentTravelIdentityTopology([value as unknown as JsonRecord])
  );
}

function isDurationMinutes(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const duration = value as JsonRecord;
  return (
    nonNegativeInteger(duration.base, 360) &&
    nonNegativeInteger(duration.buffer, 360) &&
    nonNegativeInteger(duration.total, 360)
  );
}

function isItineraryStop(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const stop = value as JsonRecord;
  return (
    typeof stop.category === "string" &&
    stop.category.trim().length > 0 &&
    (stop.id === null ||
      (typeof stop.id === "string" && stop.id.trim().length > 0)) &&
    optionalString(stop.name) &&
    optionalString(stop.reason) &&
    optionalBoolean(stop.fallback) &&
    (stop.slot === undefined ||
      nonNegativeInteger(stop.slot, 10_000)) &&
    (stop.rating === undefined || finiteNumber(stop.rating)) &&
    optionalString(stop.priceLevel) &&
    optionalString(stop.description) &&
    (stop.currentOpeningHours === undefined ||
      isCurrentOpeningHours(stop.currentOpeningHours)) &&
    (stop.location === undefined || isLatLng(stop.location)) &&
    nullableInstant(stop.start_time) &&
    nullableInstant(stop.end_time) &&
    isDurationMinutes(stop.durationMinutes) &&
    (stop.travelMinutesToNext === undefined ||
      nonNegativeInteger(stop.travelMinutesToNext, 1_440)) &&
    (stop.travelToNext === undefined || isTravelLeg(stop.travelToNext)) &&
    (stop.status === "upcoming" ||
      stop.status === "active" ||
      stop.status === "completed" ||
      stop.status === "skipped") &&
    typeof stop.locked === "boolean"
  );
}

function isHomePoint(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const home = value as JsonRecord;
  return (
    typeof home.label === "string" &&
    home.label.trim().length > 0 &&
    isLatLng(home.location)
  );
}

function isIanaTimeZone(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    normalizeZone(value) === value
  );
}

export function parseParsedPayload(value: unknown): ParsedPrompt {
  const parsed = record(value);
  if (
    typeof parsed.time_window !== "string" ||
    (parsed.stop_count !== null &&
      (typeof parsed.stop_count !== "number" || !Number.isInteger(parsed.stop_count))) ||
    typeof parsed.aesthetic !== "string" ||
    !strings(parsed.category_signals) ||
    typeof parsed.group_context !== "string" ||
    (parsed.budget !== null && typeof parsed.budget !== "string") ||
    !strings(parsed.constraints) ||
    typeof parsed.location !== "string" ||
    (parsed.city !== undefined && typeof parsed.city !== "string") ||
    (parsed.home !== undefined && !isLatLng(parsed.home))
  ) {
    throw new Error("invalid parsed prompt");
  }
  return parsed as unknown as ParsedPrompt;
}

/**
 * The PLANNER envelope: `{ plan, parsed }`. The server has already run the
 * plan through its own validator, so this is the client-boundary runtime
 * check every other payload gets — shape only, no re-litigating bounds.
 */
export function parsePlanPayload(value: unknown): {
  plan: PlanIntent;
  parsed: ParsedPrompt;
} {
  const data = record(value);
  const parsed = parseParsedPayload(data.parsed);
  const plan = record(data.plan);

  if (
    !Array.isArray(plan.activities) ||
    plan.activities.length === 0 ||
    !plan.activities.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const a = entry as JsonRecord;
      return (
        typeof a.slot === "number" &&
        Number.isInteger(a.slot) &&
        typeof a.intent === "string" &&
        typeof a.searchQuery === "string" &&
        a.searchQuery.trim() !== "" &&
        typeof a.estimatedMinutes === "number" &&
        Number.isFinite(a.estimatedMinutes) &&
        typeof a.confident === "boolean"
      );
    })
  ) {
    throw new Error("invalid plan activities");
  }

  const timeIntent = record(plan.timeIntent);
  if (
    !nullableString(timeIntent.startISO) ||
    !nullableString(timeIntent.endISO) ||
    typeof timeIntent.label !== "string" ||
    !["explicit", "relative", "unspecified"].includes(String(timeIntent.kind))
  ) {
    throw new Error("invalid plan timeIntent");
  }

  if (
    !Array.isArray(plan.questions) ||
    !plan.questions.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const q = entry as JsonRecord;
      return (
        typeof q.id === "string" &&
        q.id !== "" &&
        typeof q.question === "string" &&
        q.question !== "" &&
        strings(q.options) &&
        (q.appliesToSlot === null ||
          (typeof q.appliesToSlot === "number" && Number.isInteger(q.appliesToSlot)))
      );
    })
  ) {
    throw new Error("invalid plan questions");
  }

  record(plan.context);
  return { plan: plan as unknown as PlanIntent, parsed };
}

export function parseGeocodePayload(value: unknown): GeocodeOutcome {
  const data = record(value);

  const isBounds = (candidate: unknown): candidate is GeocodeBounds => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return false;
    }
    const bounds = candidate as JsonRecord;
    return isLatLng(bounds.southwest) && isLatLng(bounds.northeast);
  };

  const isCandidate = (candidate: unknown): candidate is GeocodeCandidate => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return false;
    }
    const item = candidate as JsonRecord;
    return (
      typeof item.label === "string" &&
      item.label.trim().length > 0 &&
      typeof item.formattedAddress === "string" &&
      item.formattedAddress.trim().length > 0 &&
      isLatLng(item.location) &&
      isIanaTimeZone(item.timeZone) &&
      typeof item.locality === "string" &&
      item.locality.trim().length > 0 &&
      optionalString(item.administrativeArea) &&
      typeof item.country === "string" &&
      item.country.trim().length > 0 &&
      typeof item.countryCode === "string" &&
      /^[A-Z]{2}$/.test(item.countryCode) &&
      strings(item.resultTypes) &&
      item.resultTypes.length > 0 &&
      (item.bounds === undefined || isBounds(item.bounds)) &&
      optionalString(item.placeId)
    );
  };

  if (
    data.outcome === "resolved" &&
    (data.queryType === "city" || data.queryType === "address") &&
    isCandidate(data)
  ) {
    return data as unknown as GeocodeOutcome;
  }
  if (
    data.outcome === "ambiguous" &&
    (data.queryType === "city" || data.queryType === "address") &&
    data.code === "geocode_ambiguous" &&
    typeof data.message === "string" &&
    data.message.trim().length > 0 &&
    Array.isArray(data.candidates) &&
    data.candidates.length > 1 &&
    data.candidates.length <= 5 &&
    data.candidates.every(isCandidate)
  ) {
    return data as unknown as GeocodeOutcome;
  }
  throw new Error("invalid geocode");
}

export function parseWeatherPayload(value: unknown): ClientWeatherHour[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const hour = entry as JsonRecord;
      return (
        typeof hour.hourISO === "string" &&
        nullableNumber(hour.tempC) &&
        nullableNumber(hour.precipProbability) &&
        nullableString(hour.condition)
      );
    })
  ) {
    throw new Error("invalid weather");
  }
  return value as ClientWeatherHour[];
}

export function parsePlacesPayload(value: unknown): PlacesPayload {
  const data = record(value);
  const pools: Record<string, Place[]> = {};
  for (const [category, candidates] of Object.entries(data)) {
    if (category === "_dropLog" || category === "_weatherBlocked") continue;
    if (!Array.isArray(candidates) || !candidates.every(isPlace)) {
      throw new Error("invalid place pool");
    }
    pools[category] = candidates;
  }
  const drops = data._dropLog ?? [];
  const weatherBlocks = data._weatherBlocked ?? [];
  if (
    !Array.isArray(drops) ||
    !drops.every(isDropEntry) ||
    !Array.isArray(weatherBlocks) ||
    !weatherBlocks.every(isWeatherBlock)
  ) {
    throw new Error("invalid place metadata");
  }
  return { pools, drops, weatherBlocks };
}

export function parseSelectionsPayload(value: unknown): { selections: Selection[] } {
  const data = record(value);
  if (!Array.isArray(data.selections) || !data.selections.every(isSelection)) {
    throw new Error("invalid selections");
  }
  return { selections: data.selections };
}

export function parseTravelPayload(value: unknown): { legs: TravelLeg[] } {
  const data = record(value);
  if (
    !Array.isArray(data.legs) ||
    !data.legs.every(isTravelLeg) ||
    !hasCoherentTravelIdentityTopology(
      data.legs as unknown as JsonRecord[]
    )
  ) {
    throw new Error("invalid travel legs");
  }
  return { legs: data.legs };
}

export function parseCreatePayload(value: unknown): { id: string } {
  const data = record(value);
  if (typeof data.id !== "string" || data.id.length === 0) {
    throw new Error("invalid itinerary id");
  }
  return { id: data.id };
}

export function parseItineraryPayload(value: unknown): Itinerary {
  const data = record(value);
  if (
    typeof data.id !== "string" ||
    data.id.trim().length === 0 ||
    !nonNegativeInteger(data.version) ||
    data.version < 1 ||
    !validInstant(data.createdAt) ||
    !Array.isArray(data.stops) ||
    !data.stops.every(isItineraryStop) ||
    !Array.isArray(data.legs) ||
    !data.legs.every(isTravelLeg) ||
    (data.status !== "planning" &&
      data.status !== "active" &&
      data.status !== "completed") ||
    (data.homeLeg !== undefined && !isTravelLeg(data.homeLeg)) ||
    (data.home !== undefined && !isHomePoint(data.home)) ||
    (data.timeZone !== undefined && !isIanaTimeZone(data.timeZone)) ||
    // The plan's travel mode, mirroring the server. UNDEFINED is valid and
    // means "transit" — every plan stored before drive mode omits it. The
    // duplication is the standing posture here: this file cannot import
    // server modules.
    (data.travelMode !== undefined &&
      data.travelMode !== "transit" &&
      data.travelMode !== "driving")
  ) {
    throw new Error("invalid itinerary");
  }
  const travelTopology = [
    ...(data.homeLeg === undefined ? [] : [data.homeLeg]),
    ...data.legs,
  ] as unknown as JsonRecord[];
  if (!hasCoherentTravelIdentityTopology(travelTopology)) {
    throw new Error("invalid itinerary");
  }
  if (data.parsed !== undefined) parseParsedPayload(data.parsed);
  return data as unknown as Itinerary;
}

export function parseReroutePayload(value: unknown): ReroutePayload {
  const data = record(value);
  if (data.rerouted === false && typeof data.reason === "string") {
    return { rerouted: false, reason: data.reason };
  }
  if (
    data.rerouted !== true ||
    typeof data.floor_time !== "string" ||
    typeof data.anchor_time !== "string" ||
    !Array.isArray(data.changed) ||
    !data.changed.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const changed = entry as JsonRecord;
      if (typeof changed.stopIndex !== "number" || !Number.isInteger(changed.stopIndex)) {
        return false;
      }
      const before = changed.before;
      return (
        typeof before === "object" &&
        before !== null &&
        !Array.isArray(before) &&
        nullableString((before as JsonRecord).start)
      );
    })
  ) {
    throw new Error("invalid reroute");
  }
  return data as unknown as ReroutePayload;
}

function swapEndTimeConfirm(value: unknown): SwapEndTimeConfirm | undefined {
  if (value === undefined) return undefined;
  const data = record(value);
  if (
    !validInstant(data.proposedEndISO) ||
    !validInstant(data.statedEndISO) ||
    typeof data.overrunMinutes !== "number" ||
    !Number.isFinite(data.overrunMinutes) ||
    typeof data.proposedEndLabel !== "string" ||
    typeof data.statedEndLabel !== "string"
  ) {
    // A malformed confirmation must not become a silent plain refusal — the
    // user would be told "no" to something the engine was willing to do.
    throw new Error("invalid swap confirmation");
  }
  return data as unknown as SwapEndTimeConfirm;
}

export function parseSwapPayload(value: unknown): SwapPayload {
  const data = record(value);
  if (data.swapped === false && typeof data.reason === "string") {
    const confirm = swapEndTimeConfirm(data.confirm);
    return { swapped: false, reason: data.reason, ...(confirm ? { confirm } : {}) };
  }
  if (
    data.swapped !== true ||
    typeof data.reason !== "string" ||
    typeof data.stopIndex !== "number" ||
    !Number.isInteger(data.stopIndex) ||
    !["refilter", "research", "time", "duration"].includes(String(data.path)) ||
    !Array.isArray(data.downstreamShifted) ||
    !data.downstreamShifted.every(
      (index) => typeof index === "number" && Number.isInteger(index)
    )
  ) {
    throw new Error("invalid swap");
  }
  const before = record(data.before);
  if (typeof before.category !== "string") throw new Error("invalid swap before");
  return data as unknown as SwapPayload;
}

export function parseRemovePayload(value: unknown): RemovePayload {
  const data = record(value);
  if (data.removed === false && typeof data.reason === "string") {
    return { removed: false, reason: data.reason };
  }
  if (
    data.removed !== true ||
    typeof data.reason !== "string" ||
    typeof data.stopIndex !== "number" ||
    !Number.isInteger(data.stopIndex) ||
    !Array.isArray(data.downstreamShifted) ||
    !data.downstreamShifted.every(
      (index) => typeof index === "number" && Number.isInteger(index)
    )
  ) {
    throw new Error("invalid remove");
  }
  const before = record(data.before);
  if (typeof before.category !== "string" || !nullableString(before.name)) {
    throw new Error("invalid remove before");
  }
  return data as unknown as RemovePayload;
}
