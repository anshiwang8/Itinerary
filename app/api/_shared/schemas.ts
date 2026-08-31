import type { ParsedPrompt, Place, WeatherHour } from "../places/search/filter";
import type { LatLng } from "../schedule/travel";
import type { PathSegment, PlanTravelMode, TravelLeg } from "../schedule/travel";
import {
  MAX_TRAVEL_ID_CHARS,
  MAX_PATH_POLYLINE_CHARS,
  MAX_PATH_SEGMENTS_PER_LEG,
  TRANSIT_PALETTE_CAPACITY,
  TRAVEL_ID_PATTERN,
  isPlanTravelMode,
} from "../schedule/travel";
import type { ScheduledStop } from "../schedule/schedule";
import type { HomePoint } from "../schedule/home";
import { normalizeStopCountSlots } from "../../lib/planSlots";
import {
  REQUEST_LIMITS,
  badRequest,
  finiteNumber,
  isRecord,
  validIanaTimeZone,
  validIsoInstant,
  validLatitude,
  validLongitude,
} from "./http";

function boundedString(
  value: unknown,
  field: string,
  max: number = REQUEST_LIMITS.textFieldChars
): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    badRequest(`\`${field}\` must be a non-empty string no longer than ${max} characters.`);
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  field: string,
  max: number = REQUEST_LIMITS.textFieldChars
): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, field, max);
}

function stringList(
  value: unknown,
  field: string,
  maxItems = REQUEST_LIMITS.categories
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    badRequest(`\`${field}\` must be an array with at most ${maxItems} entries.`);
  }
  return value.map((item, index) => boundedString(item, `${field}[${index}]`));
}

/** One answered clarifying question, echoed back for the second planner pass. */
export interface PlannerAnswerInput {
  question: string;
  answer: string;
}

export interface PlannerRequest {
  prompt: string;
  /** the plan's resolved IANA zone — the planner reasons about "tonight"
   *  against the PLAN's clock, so the client geocodes before it parses */
  timeZone?: string;
  /** the client's current instant. The planner is the first stage that needs
   *  to know what "now" is, and the app already resolves start times from the
   *  browser clock (page.tsx passes `new Date()` into every resolver) — so
   *  accepting it here matches the existing trust model rather than widening
   *  it, and keeps the e2e clock-freeze seam working. Defaults to the
   *  server clock when absent. */
  nowISO?: string;
  city?: string;
  answers?: PlannerAnswerInput[];
}

export function parsePlannerBody(value: unknown): PlannerRequest {
  if (!isRecord(value)) badRequest("Request body must be a JSON object.");
  const request: PlannerRequest = {
    prompt: boundedString(value.prompt, "prompt", REQUEST_LIMITS.promptChars),
  };
  const timeZone = parseOptionalTimeZone(value.timeZone);
  if (timeZone) request.timeZone = timeZone;
  const nowISO = parseOptionalInstant(value.nowISO, "nowISO");
  if (nowISO) request.nowISO = nowISO;
  const city = optionalString(value.city, "city");
  if (city) request.city = city;
  if (value.answers !== undefined) {
    if (!Array.isArray(value.answers) || value.answers.length > REQUEST_LIMITS.categories) {
      badRequest(`\`answers\` must be an array with at most ${REQUEST_LIMITS.categories} entries.`);
    }
    request.answers = value.answers.map((entry, index) => {
      if (!isRecord(entry)) badRequest(`\`answers[${index}]\` must be an object.`);
      return {
        question: boundedString(entry.question, `answers[${index}].question`),
        answer: boundedString(entry.answer, `answers[${index}].answer`, REQUEST_LIMITS.refinementChars),
      };
    });
  }
  return request;
}

export function parseRefinement(value: unknown): string {
  return boundedString(value, "refinement", REQUEST_LIMITS.refinementChars);
}

export function parseParsedPrompt(value: unknown): ParsedPrompt {
  if (!isRecord(value)) badRequest("`parsed` must be a valid parsed prompt object.");
  const stopCount = value.stop_count;
  if (
    stopCount !== null &&
    stopCount !== undefined &&
    (!finiteNumber(stopCount) ||
      !Number.isInteger(stopCount) ||
      stopCount < 1 ||
      stopCount > REQUEST_LIMITS.categories)
  ) {
    badRequest(`\`parsed.stop_count\` must be null or an integer from 1 to ${REQUEST_LIMITS.categories}.`);
  }
  const budget =
    value.budget === null || value.budget === undefined
      ? null
      : boundedString(value.budget, "parsed.budget");
  const parsed: ParsedPrompt = {
    time_window: boundedString(value.time_window, "parsed.time_window"),
    stop_count: typeof stopCount === "number" ? stopCount : null,
    aesthetic: boundedString(value.aesthetic, "parsed.aesthetic"),
    category_signals: stringList(value.category_signals, "parsed.category_signals"),
    group_context: boundedString(value.group_context, "parsed.group_context"),
    budget,
    constraints: stringList(value.constraints, "parsed.constraints"),
    location:
      typeof value.location === "string" && value.location.length <= REQUEST_LIMITS.textFieldChars
        ? value.location.trim()
        : badRequest("`parsed.location` must be a string."),
  };
  const city = optionalString(value.city, "parsed.city");
  if (city) parsed.city = city;
  if (value.home !== undefined) {
    if (
      !isRecord(value.home) ||
      !validLatitude(value.home.latitude) ||
      !validLongitude(value.home.longitude)
    ) {
      badRequest("`parsed.home` must contain valid latitude and longitude.");
    }
    parsed.home = {
      latitude: value.home.latitude,
      longitude: value.home.longitude,
    };
  }
  if (value.cityCenter !== undefined) {
    if (
      !isRecord(value.cityCenter) ||
      !validLatitude(value.cityCenter.latitude) ||
      !validLongitude(value.cityCenter.longitude)
    ) {
      badRequest("`parsed.cityCenter` must contain valid latitude and longitude.");
    }
    parsed.cityCenter = {
      latitude: value.cityCenter.latitude,
      longitude: value.cityCenter.longitude,
    };
  }
  return normalizeStopCountSlots(parsed);
}

function parsePlace(value: unknown, field: string): Place {
  if (!isRecord(value)) badRequest(`\`${field}\` must be an object.`);
  const id = boundedString(value.id, `${field}.id`, 200);
  const place: Place = { ...(value as unknown as Place), id };
  if (
    place.location &&
    (!validLatitude(place.location.latitude) || !validLongitude(place.location.longitude))
  ) {
    badRequest(`\`${field}.location\` contains invalid coordinates.`);
  }
  if (place.rating !== undefined && (!finiteNumber(place.rating) || place.rating < 0 || place.rating > 5)) {
    badRequest(`\`${field}.rating\` must be between 0 and 5.`);
  }
  return place;
}

export function parsePools(value: unknown): Record<string, Place[]> {
  if (!isRecord(value)) badRequest("`pools` must be an object.");
  const entries = Object.entries(value);
  if (entries.length > REQUEST_LIMITS.categories) {
    badRequest(`\`pools\` may contain at most ${REQUEST_LIMITS.categories} categories.`);
  }
  let total = 0;
  const pools: Record<string, Place[]> = {};
  for (const [category, raw] of entries) {
    if (!category.trim() || category.length > REQUEST_LIMITS.textFieldChars || !Array.isArray(raw)) {
      badRequest("Each candidate pool must be an array under a valid category.");
    }
    if (raw.length > REQUEST_LIMITS.candidatesPerPool) {
      badRequest(`Each pool may contain at most ${REQUEST_LIMITS.candidatesPerPool} candidates.`);
    }
    total += raw.length;
    if (total > REQUEST_LIMITS.totalCandidates) {
      badRequest(`Candidate payload may contain at most ${REQUEST_LIMITS.totalCandidates} candidates.`);
    }
    pools[category] = raw.map((candidate, index) =>
      parsePlace(candidate, `pools.${category}[${index}]`)
    );
  }
  return pools;
}

export function parseSlots(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return stringList(value, "slots");
}

/** The planner's per-slot duration estimates, index-aligned with `slots`.
 *  Bounds match the planner's own clamp; selectVenues re-clamps anyway. */
export function parseSlotEstimates(
  value: unknown,
  slotCount: number | undefined
): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > REQUEST_LIMITS.categories) {
    badRequest(`\`plannedMinutes\` must be an array with at most ${REQUEST_LIMITS.categories} entries.`);
  }
  if (slotCount !== undefined && value.length !== slotCount) {
    badRequest("`plannedMinutes` must have exactly one entry per slot.");
  }
  return value.map((minutes, index) => {
    if (!finiteNumber(minutes) || minutes < 1 || minutes > 360) {
      badRequest(`\`plannedMinutes[${index}]\` must be a number from 1 to 360.`);
    }
    return Math.round(minutes);
  });
}

export function parseCategories(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return stringList(value, "categoriesOverride");
}

export function parseWeather(value: unknown): WeatherHour[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 48) badRequest("`weather` must contain at most 48 hours.");
  return value.map((entry, index) => {
    if (!isRecord(entry) || !validIsoInstant(entry.hourISO)) {
      badRequest(`\`weather[${index}]\` must contain a valid hourISO.`);
    }
    for (const key of ["tempC", "precipProbability"] as const) {
      if (entry[key] !== null && entry[key] !== undefined && !finiteNumber(entry[key])) {
        badRequest(`\`weather[${index}].${key}\` must be finite or null.`);
      }
    }
    return {
      hourISO: entry.hourISO,
      tempC: finiteNumber(entry.tempC) ? entry.tempC : null,
      precipProbability: finiteNumber(entry.precipProbability)
        ? entry.precipProbability
        : null,
      condition: typeof entry.condition === "string" ? entry.condition.slice(0, 200) : null,
    };
  });
}

export function parsePoints(value: unknown): LatLng[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > REQUEST_LIMITS.points) {
    badRequest(`\`points\` must contain between 1 and ${REQUEST_LIMITS.points} coordinates.`);
  }
  return value.map((point, index) => {
    if (!isRecord(point) || !validLatitude(point.latitude) || !validLongitude(point.longitude)) {
      badRequest(`\`points[${index}]\` must contain valid latitude and longitude.`);
    }
    return { latitude: point.latitude, longitude: point.longitude };
  });
}

export function parseDwellMinutes(value: unknown, points: number): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== points) {
    badRequest("`dwellMinutes` must have exactly one entry per point.");
  }
  return value.map((minutes, index) => {
    if (!finiteNumber(minutes) || !Number.isInteger(minutes) || minutes < 0 || minutes > 360) {
      badRequest(`\`dwellMinutes[${index}]\` must be an integer from 0 to 360.`);
    }
    return minutes;
  });
}

export function parseOptionalInstant(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!validIsoInstant(value)) badRequest(`\`${field}\` must be a valid ISO timestamp.`);
  return value;
}

export function parseOptionalTimeZone(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!validIanaTimeZone(value)) badRequest("`timeZone` must be a valid IANA timezone.");
  return value;
}

/**
 * The plan's travel mode, mirroring `parseOptionalTimeZone`. UNDEFINED is a
 * valid answer and means "transit" downstream — every plan stored before
 * this field existed, and every transit plan since, simply omits it. An
 * unrecognised string is rejected rather than coerced: a mode we do not
 * know how to route is not a mode.
 */
export function parseOptionalTravelMode(value: unknown): PlanTravelMode | undefined {
  if (value === undefined) return undefined;
  if (!isPlanTravelMode(value)) {
    badRequest("`travelMode` must be \"transit\" or \"driving\".");
  }
  return value;
}

export function parseOptionalVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    !finiteNumber(value) ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    badRequest("`version` must be a positive safe integer.");
  }
  return value;
}

export function parseScheduledStops(value: unknown): ScheduledStop[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > REQUEST_LIMITS.categories
  ) {
    badRequest(
      `\`stops\` must contain between 1 and ${REQUEST_LIMITS.categories} stops.`
    );
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) badRequest(`\`stops[${index}]\` must be an object.`);
    const category = boundedString(entry.category, `stops[${index}].category`);
    const id =
      entry.id === null ? null : boundedString(entry.id, `stops[${index}].id`, 200);
    for (const field of ["start_time", "end_time"] as const) {
      if (entry[field] !== null && !validIsoInstant(entry[field])) {
        badRequest(`\`stops[${index}].${field}\` must be a valid ISO timestamp or null.`);
      }
    }
    if (entry.location !== undefined) {
      if (
        !isRecord(entry.location) ||
        !validLatitude(entry.location.latitude) ||
        !validLongitude(entry.location.longitude)
      ) {
        badRequest(`\`stops[${index}].location\` contains invalid coordinates.`);
      }
    }
    if (entry.durationMinutes !== null) {
      if (!isRecord(entry.durationMinutes)) {
        badRequest(`\`stops[${index}].durationMinutes\` must be an object or null.`);
      }
      for (const field of ["base", "buffer", "total"] as const) {
        const minutes = entry.durationMinutes[field];
        if (
          !finiteNumber(minutes) ||
          !Number.isInteger(minutes) ||
          minutes < 0 ||
          minutes > 360
        ) {
          badRequest(
            `\`stops[${index}].durationMinutes.${field}\` must be an integer from 0 to 360.`
          );
        }
      }
    }
    return { ...(entry as unknown as ScheduledStop), id, category };
  });
}

/** New ride identity is atomic: new facts carry all three values, while a
 * legacy stored ride carries none. A partial bundle is more dangerous than
 * an absent one because it could falsely associate facts with geometry. */
const RIDE_IDENTITY_FIELDS = [
  "rideId",
  "sourceStepIndex",
  "paletteSlot",
] as const;

function validTravelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TRAVEL_ID_CHARS &&
    TRAVEL_ID_PATTERN.test(value)
  );
}

function rideIdentityBundle(
  value: Record<string, unknown>
): "legacy" | "complete" | "invalid" {
  const present = RIDE_IDENTITY_FIELDS.map((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  );
  if (present.every((entry) => !entry)) return "legacy";
  if (!present.every(Boolean)) return "invalid";

  return validTravelId(value.rideId) &&
    finiteNumber(value.sourceStepIndex) &&
    Number.isSafeInteger(value.sourceStepIndex) &&
    value.sourceStepIndex >= 0 &&
    (value.paletteSlot === null ||
      (finiteNumber(value.paletteSlot) &&
        Number.isSafeInteger(value.paletteSlot) &&
        value.paletteSlot >= 0 &&
        value.paletteSlot < TRANSIT_PALETTE_CAPACITY))
    ? "complete"
    : "invalid";
}

/** The board/alight instants and stop coordinates are optional and nullable;
 * the occurrence identity bundle is optional only as one complete legacy/new
 * unit. Any present malformed fact rejects the request before persistence. */
function checkRideDetail(ride: unknown, where: string): void {
  if (!isRecord(ride)) badRequest(`\`${where}\` must be an object.`);
  if (rideIdentityBundle(ride) === "invalid") {
    badRequest(
      `\`${where}\` must carry either no ride identity fields or one complete, valid ride identity bundle.`
    );
  }
  for (const key of ["boardISO", "alightISO"] as const) {
    const instant = ride[key];
    if (instant !== undefined && instant !== null && !validIsoInstant(instant)) {
      badRequest(`\`${where}.${key}\` must be a valid ISO timestamp or null.`);
    }
  }
  for (const key of ["boardLocation", "alightLocation"] as const) {
    const point = ride[key];
    if (point === undefined || point === null) continue;
    if (
      !isRecord(point) ||
      !validLatitude(point.latitude) ||
      !validLongitude(point.longitude)
    ) {
      badRequest(`\`${where}.${key}\` must contain valid coordinates or be null.`);
    }
  }
}

/**
 * The leg's per-step geometry, sanitized. Deliberately MORE FORGIVING than
 * the ride check above, and the difference is what the data is FOR: a
 * segment is a line on a map, with the whole-leg polyline still behind it as
 * a fallback, so a malformed one is dropped and the leg survives — refusing
 * the request would cost the caller an entire stored plan over a decoration.
 * The two things that ARE refused are shape errors about the field itself:
 * not an array, or more entries than any journey has.
 *
 * Returns undefined when nothing survives, so the key is omitted rather than
 * left as an empty array — "no geometry" is the same fact whichever way it
 * arrived.
 */
function keepPathSegments(value: unknown, where: string): PathSegment[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PATH_SEGMENTS_PER_LEG) {
    badRequest(`\`${where}\` must be an array of at most ${MAX_PATH_SEGMENTS_PER_LEG} segments.`);
  }
  const kept: PathSegment[] = [];
  for (const segment of value) {
    if (!isRecord(segment)) continue;
    const { mode, encodedPolyline, color } = segment;
    if (mode !== "walk" && mode !== "transit") continue;
    if (
      typeof encodedPolyline !== "string" ||
      encodedPolyline.length === 0 ||
      encodedPolyline.length > MAX_PATH_POLYLINE_CHARS
    ) {
      continue;
    }
    if (color !== undefined && color !== null && typeof color !== "string") continue;
    const identity = rideIdentityBundle(segment);
    // Walk paths never carry transit occurrence metadata. Transit paths are
    // either legacy (all three absent) or carry the complete new bundle.
    // As with every other malformed path record, an invalid bundle drops only
    // that decorative segment and never the containing itinerary.
    if (identity === "invalid" || (mode === "walk" && identity !== "legacy")) {
      continue;
    }
    if (mode === "walk") {
      kept.push({
        mode,
        encodedPolyline,
        ...(color === undefined ? {} : { color: color as string | null }),
      });
      continue;
    }
    kept.push({
      mode,
      encodedPolyline,
      ...(color === undefined ? {} : { color: color as string | null }),
      ...(identity === "complete"
        ? {
            rideId: segment.rideId as string,
            sourceStepIndex: segment.sourceStepIndex as number,
            paletteSlot: segment.paletteSlot as number | null,
          }
        : {}),
    });
  }
  return kept.length > 0 ? kept : undefined;
}

type CompleteRideIdentity = {
  rideId: string;
  sourceStepIndex: number;
  paletteSlot: number | null;
};

type TopologyOccurrence = CompleteRideIdentity & { legIndex: number };

function completeRideIdentity(value: unknown): CompleteRideIdentity | null {
  if (!isRecord(value) || rideIdentityBundle(value) !== "complete") return null;
  return {
    rideId: value.rideId as string,
    sourceStepIndex: value.sourceStepIndex as number,
    paletteSlot: value.paletteSlot as number | null,
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

/**
 * Enforce the relational half of the ride contract across one complete
 * travel topology. Per-record shape checks happen first; this pass proves
 * that exact IDs, source-step ordinals and non-null palette slots cannot
 * disagree across the compatibility fact copy, the facts array, geometry,
 * home, or later legs.
 *
 * Facts and leg IDs are authoritative stored data, so a contradiction
 * rejects. Geometry keeps its established decoration policy: a conflicting
 * identified path is dropped, never guessed or allowed to cost the plan.
 * Legacy all-absent records remain outside the relationship entirely.
 */
export function validateTravelIdentityTopology(
  legs: TravelLeg[],
  field = "legs"
): TravelLeg[] {
  const legIds = new Set<string>();
  const byRideId = new Map<string, TopologyOccurrence>();
  const bySource = new Map<string, TopologyOccurrence>();
  const bySlot = new Map<number, TopologyOccurrence>();

  const conflict = (candidate: TopologyOccurrence): boolean => {
    const sameRide = byRideId.get(candidate.rideId);
    if (
      sameRide &&
      (!sameOccurrence(sameRide, candidate) ||
        sameRide.paletteSlot !== candidate.paletteSlot)
    ) {
      return true;
    }
    const sameSource = bySource.get(
      `${candidate.legIndex}:${candidate.sourceStepIndex}`
    );
    if (
      sameSource &&
      (!sameOccurrence(sameSource, candidate) ||
        sameSource.paletteSlot !== candidate.paletteSlot)
    ) {
      return true;
    }
    if (candidate.paletteSlot !== null) {
      const sameSlot = bySlot.get(candidate.paletteSlot);
      if (sameSlot && !sameOccurrence(sameSlot, candidate)) return true;
    }
    return false;
  };

  const register = (candidate: TopologyOccurrence): boolean => {
    if (conflict(candidate)) return false;
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

  // Reserve every fact occurrence before considering geometry. A bad line
  // can be dropped; a later fact must never lose to whichever path appeared
  // first in the request.
  for (const [legIndex, leg] of legs.entries()) {
    if (leg.legId !== undefined) {
      if (legIds.has(leg.legId)) {
        badRequest(`\`${field}\` contains a duplicate leg identity.`);
      }
      legIds.add(leg.legId);
    }
    const segmentFacts = leg.transitSegments ?? [];
    const hasLegIdentity = leg.legId !== undefined;
    const allFacts = [
      ...(leg.transit ? [leg.transit] : []),
      ...segmentFacts,
    ];
    if (
      hasLegIdentity &&
      Boolean(leg.transit) !== (segmentFacts.length > 0)
    ) {
      badRequest(
        `\`${field}\` must keep the transit compatibility record with its identified ride array.`
      );
    }
    for (const fact of allFacts) {
      const hasRideIdentity = completeRideIdentity(fact) !== null;
      if (hasLegIdentity !== hasRideIdentity) {
        badRequest(
          `\`${field}\` must keep leg and transit ride identity metadata together.`
        );
      }
    }
    const compatibilityIdentity = completeRideIdentity(leg.transit);
    const firstSegmentIdentity = completeRideIdentity(segmentFacts[0]);
    if (
      compatibilityIdentity &&
      firstSegmentIdentity &&
      !sameRideIdentity(compatibilityIdentity, firstSegmentIdentity)
    ) {
      badRequest(
        `\`${field}\` contains a transit compatibility record that is not its first identified ride.`
      );
    }
    const factRideIds = new Set<string>();
    for (const fact of segmentFacts) {
      const identity = completeRideIdentity(fact);
      if (!identity) continue;
      if (factRideIds.has(identity.rideId)) {
        badRequest(`\`${field}\` contains a duplicate identified transit ride.`);
      }
      factRideIds.add(identity.rideId);
    }
    for (const fact of allFacts) {
      const identity = completeRideIdentity(fact);
      if (!identity) continue;
      if (!register({ ...identity, legIndex })) {
        badRequest(
          `\`${field}\` contains conflicting transit ride identities or palette slots.`
        );
      }
    }
  }

  for (const [legIndex, leg] of legs.entries()) {
    if (!leg.pathSegments) continue;
    const pathsSeen = new Set<string>();
    const kept: PathSegment[] = [];
    for (const path of leg.pathSegments) {
      if (path.mode !== "transit") {
        kept.push(path);
        continue;
      }
      const identity = completeRideIdentity(path);
      if (!identity) {
        if (leg.legId === undefined) kept.push(path);
        continue;
      }
      if (leg.legId === undefined) continue;
      const occurrenceKey = `${legIndex}:${identity.rideId}`;
      const candidate = { ...identity, legIndex };
      if (pathsSeen.has(occurrenceKey) || !register(candidate)) continue;
      pathsSeen.add(occurrenceKey);
      kept.push(path);
    }
    if (kept.length > 0) leg.pathSegments = kept;
    else delete leg.pathSegments;
  }

  return legs;
}

export function parseTravelLegs(value: unknown, field = "legs"): TravelLeg[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > REQUEST_LIMITS.points - 1) {
    badRequest(`\`${field}\` must contain at most ${REQUEST_LIMITS.points - 1} legs.`);
  }
  const legs = value.map((entry, index) => {
    if (!isRecord(entry)) badRequest(`\`${field}[${index}]\` must be an object.`);
    if (entry.legId !== undefined && !validTravelId(entry.legId)) {
      badRequest(`\`${field}[${index}].legId\` is invalid.`);
    }
    if (
      !finiteNumber(entry.fromIndex) ||
      !Number.isInteger(entry.fromIndex) ||
      entry.fromIndex < -1 ||
      entry.fromIndex >= REQUEST_LIMITS.points
    ) {
      badRequest(`\`${field}[${index}].fromIndex\` is invalid.`);
    }
    // "driving" joins the leg modes here rather than at the plan level: a
    // leg's mode is what actually happened on it, and a driving PLAN
    // legitimately stores walk legs alongside its drives.
    if (!["transit", "walk", "driving", "unknown"].includes(String(entry.mode))) {
      badRequest(`\`${field}[${index}].mode\` is invalid.`);
    }
    for (const key of ["rawMinutes", "marginMinutes", "totalMinutes"] as const) {
      if (
        !finiteNumber(entry[key]) ||
        !Number.isInteger(entry[key]) ||
        entry[key] < 0 ||
        entry[key] > 1_440
      ) {
        badRequest(`\`${field}[${index}].${key}\` must be a non-negative integer.`);
      }
    }
    if (
      entry.distanceMeters !== null &&
      (!finiteNumber(entry.distanceMeters) || entry.distanceMeters < 0)
    ) {
      badRequest(`\`${field}[${index}].distanceMeters\` must be non-negative or null.`);
    }
    if (entry.transit !== undefined) {
      checkRideDetail(entry.transit, `${field}[${index}].transit`);
    }
    if (entry.transitSegments !== undefined) {
      if (!Array.isArray(entry.transitSegments)) {
        badRequest(`\`${field}[${index}].transitSegments\` must be an array.`);
      }
      entry.transitSegments.forEach((ride, rideIndex) =>
        checkRideDetail(ride, `${field}[${index}].transitSegments[${rideIndex}]`)
      );
    }
    const leg = entry as unknown as TravelLeg;
    if (entry.pathSegments === undefined) return leg;
    // Sanitizing, not just checking: the stored leg must carry only segments
    // that passed, so a dropped one cannot come back out of the store later.
    const kept = keepPathSegments(entry.pathSegments, `${field}[${index}].pathSegments`);
    const sanitized: TravelLeg = { ...leg };
    if (kept) sanitized.pathSegments = kept;
    else delete sanitized.pathSegments;
    return sanitized;
  });
  return validateTravelIdentityTopology(legs, field);
}

export function parseHomePoint(value: unknown): HomePoint | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.label !== "string" ||
    value.label.trim() === "" ||
    value.label.length > 500 ||
    !isRecord(value.location) ||
    !validLatitude(value.location.latitude) ||
    !validLongitude(value.location.longitude)
  ) {
    badRequest("`home` must contain a label and valid coordinates.");
  }
  return {
    label: value.label.trim(),
    location: {
      latitude: value.location.latitude,
      longitude: value.location.longitude,
    },
  };
}
