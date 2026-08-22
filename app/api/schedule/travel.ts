import { finiteNumber, isRecord, logEvent } from "../_shared/http";
import { fetchProvider, readProviderJson, requireProviderRecord } from "../_shared/provider";

// Real travel legs between consecutive stops via Routes API
// computeRoutes — real geometry (encoded polylines) and transit details
// per leg. Mode selection, short-leg relabel, and margin logic are
// unchanged from the Route Matrix version; only the data source moved.
const COMPUTE_ROUTES_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes";

// Pad transit legs on the departure side — buses/subways don't leave
// when you arrive at the stop. Walking needs no margin.
export const TRANSIT_MARGIN_MIN = 5;

// Below this distance a "transit" route is effectively a walk (Google
// walks short segments inside transit routing), so it gets the walk
// label and no margin.
export const SHORT_LEG_WALK_METERS = 400;

/**
 * How the WHOLE PLAN gets around. A plan-level INTENT, not a per-leg
 * guarantee: a driving plan still contains WALK legs wherever driving is
 * the wrong answer (see DRIVING_SHORT_LEG_WALK_METERS). Absent on every
 * stored plan means "transit", which is why nothing needed a migration.
 */
export type PlanTravelMode = "transit" | "driving";

export const PLAN_TRAVEL_MODES: readonly PlanTravelMode[] = ["transit", "driving"];

export function isPlanTravelMode(value: unknown): value is PlanTravelMode {
  return value === "transit" || value === "driving";
}

/**
 * POLICY, NOT A MEASUREMENT — and deliberately so.
 *
 * A driving leg costs more than the provider's door-to-door drive time:
 * roughly five minutes to get out of the building and moving, and roughly
 * five more to find parking and walk in at the far end. Google gives us the
 * DRIVE duration as a fact; it does not tell us how long parking takes, and
 * nothing here pretends to know. This number is a deliberate estimate that
 * bounds the schedule conservatively, exactly the way TRANSIT_MARGIN_MIN is
 * a buffer rather than a published wait.
 *
 * When a real parking/arrival data source exists, it replaces this constant
 * — the same shape as the `isUsableAt` reservation seam. Until then: do not
 * "source" it from anywhere, and do not present it to the user as measured.
 */
export const DRIVING_MARGIN_MIN = 10;

/**
 * Below this distance a DRIVE is the wrong answer and the leg relabels to
 * WALK. The threshold is HIGHER than transit's because the costs differ in
 * kind: transit's 400 m exists because Google is already walking the hop
 * internally, while a short drive is a real drive whose park-and-approach
 * overhead (DRIVING_MARGIN_MIN) swamps the driving itself. Also policy, not
 * a measurement.
 *
 * The consequence is an INVARIANT, not an edge case: a driving plan
 * legitimately contains walk legs. `travelMode` is the plan's intent; the
 * leg's own `mode` is what actually happens on it.
 */
export const DRIVING_SHORT_LEG_WALK_METERS = 700;

// A crow-flies hop must be comfortably below the route-based walk
// threshold before we omit TRANSIT. That lower bound leaves room for an
// ordinary street-grid detour while avoiding a provider call whose result
// would only be discarded as a walk.
export const TRANSIT_SKIP_HAVERSINE_METERS = 250;

// The walk-competitive relabel only applies to walks people actually
// take. Beyond this, "walk 75 / transit 72" must stay TRANSIT — nobody
// prefers an hour-plus walk to a similar transit ride — unless walking
// beats transit outright (at least twice as fast), i.e. transit there is
// effectively broken.
export const MAX_WALK_LABEL_MIN = 30;

// When Routes cannot price either mode, crow-flies distance is evidence
// about proximity, not a routable path. Inflate it for street-network
// detours, then add a separate uncertainty allowance. The leg remains
// mode "unknown" so callers never present this fallback as a real route.
export const FALLBACK_WALK_DETOUR_FACTOR = 1.35;
export const FALLBACK_WALK_UNCERTAINTY_RATIO = 0.2;
export const FALLBACK_WALK_MIN_UNCERTAINTY_MIN = 5;
const FALLBACK_WALK_SPEED_KMH = 5;

// A polyline per STEP is what lets the map draw a leg as the journey it is
// — walk to the stop, ride, transfer walk, ride — instead of one undivided
// line. `travelMode` is what says which of those a step IS (never guessed
// from whether transitDetails happens to be present), and `staticDuration`
// arrives with them.
//
// All three are ESSENTIALS-tier fields and a request bills at its HIGHEST
// tier — `routes.legs.steps.transitDetails` above is already Pro — so this
// should not move the SKU. That is inferred from Google's field-list
// pricing docs, NOT measured: check one live billing line after deploy.
const FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.polyline.encodedPolyline",
  "routes.legs.steps.transitDetails",
  "routes.legs.steps.polyline.encodedPolyline",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
].join(",");

/** One step's geometry, capped. The cap is a FILTER and it deletes rather
 *  than errors, exactly like the routing price ceiling — set it too low and
 *  a legitimate long step's line silently goes missing from the map, which
 *  reads as a rendering bug three files away. A cross-town ride measured
 *  ~451 chars on the live probe, so this is ~9x headroom; raise it if a real
 *  step is ever seen near it, never lower it to "tidy up". */
export const MAX_PATH_POLYLINE_CHARS = 4_096;
/** A journey with more steps than this is not a journey. Turn-by-turn WALK
 *  routes are the reason it is not smaller: a walk leg's steps are per-turn,
 *  so dozens is ordinary where a transit leg has a handful. */
export const MAX_PATH_SEGMENTS_PER_LEG = 128;

/** App-owned itinerary-colour capacity. Part 1 stores only this slot number;
 *  the actual colours remain a later presentation decision. */
export const TRANSIT_PALETTE_CAPACITY = 24;

/** Opaque travel identities cross JSON, browser payloads and React keys.
 *  UUIDs fit this deliberately small, URL/HTML-neutral alphabet. */
export const MAX_TRAVEL_ID_CHARS = 128;
export const TRAVEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type TravelIdentityKind = "leg" | "ride";
export type TravelIdentityFactory = (kind: TravelIdentityKind) => string;

/** Small injectable seam: production uses the same Web Crypto UUID source as
 *  itinerary IDs; focused tests supply a deterministic sequence. */
export const createTravelIdentity: TravelIdentityFactory = () =>
  globalThis.crypto.randomUUID();

function nextTravelIdentity(
  factory: TravelIdentityFactory,
  kind: TravelIdentityKind
): string {
  const id = factory(kind);
  if (
    typeof id !== "string" ||
    id.length > MAX_TRAVEL_ID_CHARS ||
    !TRAVEL_ID_PATTERN.test(id)
  ) {
    throw new Error(`Travel identity factory returned an invalid ${kind} id.`);
  }
  return id;
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Straight-line metres between two points — the code-side distance fact
 *  used wherever proximity is judged (select's kmFromHome, the swap
 *  engine's "closer" ranking). Never the LLM's job to compute. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.latitude * Math.PI) / 180) *
      Math.cos((b.latitude * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

// Raw computeRoutes response shape (the parts we read).
export interface ComputeRoutesResponse {
  routes?: Array<{
    duration?: string; // "123s"
    distanceMeters?: number;
    polyline?: { encodedPolyline?: string };
    legs?: Array<{
      steps?: Array<{
        /** this step's own geometry — the newly requested field, and the
         *  only source of a per-step line. A step without one draws nothing. */
        polyline?: { encodedPolyline?: string };
        /** "WALK" | "TRANSIT" (Google also spells DRIVE/BICYCLE/TWO_WHEELER,
         *  which this app never requests). Read as the step's identity, not
         *  inferred from the presence of transitDetails. */
        travelMode?: string;
        /** the step's own duration ("323s"). It arrives with the geometry and
         *  is deliberately NOT stored on the leg: a per-step number is the one
         *  thing here that could be mistaken for a scheduling input, and the
         *  schedule runs on `totalMinutes` alone. If a later slice ever keeps
         *  it, it is a LABEL. */
        staticDuration?: string;
        transitDetails?: {
          headsign?: string;
          stopCount?: number;
          // color/textColor/vehicle arrive under the SAME field mask —
          // routes.legs.steps.transitDetails is a parent path, and Google
          // returns the full nested object for it (verified live: TTC
          // Line 1 came back color #f2c10b, vehicle SUBWAY). No mask
          // change was needed to surface them.
          transitLine?: {
            name?: string;
            nameShort?: string;
            color?: string;
            textColor?: string;
            vehicle?: { type?: string };
          };
          // Same parent path, same free ride: the board/alight INSTANTS and
          // the two stops' COORDINATES arrive on every transit response and
          // were being dropped at the parser. Reading them costs no field
          // mask change, no extra call and no cent.
          stopDetails?: {
            departureStop?: { name?: string; location?: { latLng?: Partial<LatLng> } };
            arrivalStop?: { name?: string; location?: { latLng?: Partial<LatLng> } };
            /** RFC3339 — when this ride LEAVES the departure stop */
            departureTime?: string;
            /** RFC3339 — when it REACHES the arrival stop */
            arrivalTime?: string;
          };
        };
      }>;
    }>;
  }>;
}

export interface TransitSummary {
  /** App-owned identity for THIS ride occurrence. Generated from the source
   * provider step before geometry and facts are filtered independently.
   * Optional only so pre-contract stored itineraries remain loadable. */
  rideId?: string;
  /** Raw provider-step ordinal within this leg's selected route, flattened
   * across provider route legs. It preserves provider order across one-sided
   * facts/geometry records; it is not a provider trip identifier. */
  sourceStepIndex?: number;
  /** Part 1 display metadata only. 0..23 is unique within the itinerary;
   * null explicitly records overflow. Absent means legacy data. */
  paletteSlot?: number | null;
  lineName: string;
  /** the line's own short designation ("1", "63", "501") — the bubble
   * label; null when the agency publishes no short name */
  shortName: string | null;
  /** the agency's factual line colour ("#f2c10b") / label text colour; null
   * when unpublished. These control only legacy/null-overflow display fallback. */
  color: string | null;
  textColor: string | null;
  /** vehicle kind ("SUBWAY", "BUS", "TRAM"…); null when unpublished */
  vehicle: string | null;
  headsign: string;
  stopCount: number | null;
  departStop: string;
  arriveStop: string;
  /** The provider's SCHEDULED board/alight instants for this ride, as
   * published for the departure instant this leg was priced at. DISPLAY
   * ONLY — the schedule is built on `totalMinutes` (the padded door-to-door
   * number) and must never be re-derived from these. Optional because a
   * plan stored before this shipped has neither; null because a response
   * may omit them, and null is honest where a guess would not be. */
  boardISO?: string | null;
  alightISO?: string | null;
  /** Where you actually get on and off — the provider's own coordinates
   * for the two stops. A transfer marker is drawn at one of these or not
   * at all; nothing here is interpolated. */
  boardLocation?: LatLng | null;
  alightLocation?: LatLng | null;
}

/** ONE drawable piece of a leg: the geometry of a single provider STEP, in
 *  travel order. Together they are the leg's real shape broken at every
 *  change of mode and line — the walk to the stop, the ride, the transfer
 *  walk, the next ride — which the single whole-leg `encodedPolyline` cannot
 *  express because it has no seams.
 *
 *  DISPLAY ONLY, on the same terms as the board/alight instants above:
 *  nothing scheduling reads a segment, and the per-step `staticDuration`
 *  that arrives alongside is not stored at all. A step the provider drew no
 *  line for produces NO segment — a line we did not receive is not ours to
 *  invent. */
interface PathSegmentBase {
  /** the provider's own encoded polyline for this step, verbatim */
  encodedPolyline: string;
  /** the provider's factual ride colour ("#f2c10b"). Identified, slotted
   *  rides display the app-owned occurrence colour instead; this remains the
   *  legacy/overflow fallback. null on walking and when unpublished. */
  color?: string | null;
}

/** Walk geometry is deliberately outside the transit identity/palette
 * contract. It remains presentation-neutral and carries no ride metadata. */
export interface WalkPathSegment extends PathSegmentBase {
  mode: "walk";
}

export interface TransitPathSegment extends PathSegmentBase {
  mode: "transit";
  /** Same occurrence metadata as the matching TransitSummary when that
   * source step also supplied usable facts. Optional for legacy geometry. */
  rideId?: string;
  sourceStepIndex?: number;
  paletteSlot?: number | null;
}

export type PathSegment = WalkPathSegment | TransitPathSegment;

export interface TravelLeg {
  /** Opaque app-owned identity for this computed leg. A freshly recomputed
   * route receives a fresh identity; untouched persisted legs retain theirs.
   * Optional only for legacy stored itineraries. */
  legId?: string;
  /** leg from timed stop i to timed stop i+1 */
  fromIndex: number;
  /** What actually happens on THIS leg. On a driving plan most legs are
   * "driving", but a short hop relabels to "walk" — the plan's travelMode is
   * an intent, never a per-leg guarantee. */
  mode: "transit" | "walk" | "driving" | "unknown";
  rawMinutes: number;
  marginMinutes: number;
  totalMinutes: number;
  distanceMeters: number | null;
  /** real route geometry for the map; null when no route data */
  encodedPolyline: string | null;
  /** FIRST transit ride of the leg — kept as the first element of
   * transitSegments on purpose: persisted itineraries and existing
   * callers (the disruption banner's line-name lookup, the leg detail
   * label) read it, and changing its type would force a store migration
   * for zero gain. New readers should prefer transitSegments. */
  transit?: TransitSummary;
  /** EVERY transit ride of the leg, in riding order — a two-transfer
   * journey is three segments. Absent on walk legs, on pre-existing
   * stored plans, and when the route carried no transit detail. */
  transitSegments?: TransitSummary[];
  /** The leg's geometry step by step, in travel order — what the map draws
   * a mode-and-line-aware route from. ADDITIVE and independent of
   * `transitSegments` (which carries the rides' times/colours, not their
   * shape); `encodedPolyline` above is untouched and stays the fallback.
   * Absent whenever no step carried geometry: every plan stored before
   * 2026-08-16, the `unknown` estimate, and any response the provider drew
   * no step lines for. */
  pathSegments?: PathSegment[];
}

type RideMetadataCarrier = {
  rideId?: string;
  sourceStepIndex?: number;
  paletteSlot?: number | null;
};

interface RideOccurrence {
  rideId: string;
  sourceStepIndex: number;
  legOrder: number;
  firstSeen: number;
  records: RideMetadataCarrier[];
  assignedSlot?: number | null;
}

function validPaletteSlot(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < TRANSIT_PALETTE_CAPACITY
  );
}

function identifiedRideRecord(
  record: RideMetadataCarrier
): record is RideMetadataCarrier & {
  rideId: string;
  sourceStepIndex: number;
  paletteSlot: number | null;
} {
  return (
    typeof record.rideId === "string" &&
    record.rideId.length <= MAX_TRAVEL_ID_CHARS &&
    TRAVEL_ID_PATTERN.test(record.rideId) &&
    typeof record.sourceStepIndex === "number" &&
    Number.isSafeInteger(record.sourceStepIndex) &&
    record.sourceStepIndex >= 0 &&
    (record.paletteSlot === null || validPaletteSlot(record.paletteSlot))
  );
}

/**
 * Assign the metadata-only palette slots for a COMPLETE itinerary topology.
 * Callers pass home first, then inter-stop legs. Existing valid slots are
 * reserved in a first pass before any unassigned ride is considered, so a
 * newly inserted early leg can never steal a later untouched ride's slot.
 *
 * Geometry and facts are joined ONLY by the app-owned rideId created on the
 * source step. `sourceStepIndex` orders the union when one side was filtered;
 * filtered array positions, provider colour/name/time and geometry never do.
 * Legacy records have no complete identity bundle and remain untouched.
 */
export function assignTransitPaletteSlots(legs: readonly TravelLeg[]): void {
  const occurrences: RideOccurrence[] = [];
  let firstSeen = 0;

  for (const [legOrder, leg] of legs.entries()) {
    const byRideId = new Map<string, RideOccurrence>();
    const add = (record: RideMetadataCarrier | undefined) => {
      if (!record || !identifiedRideRecord(record)) return;
      const existing = byRideId.get(record.rideId);
      if (existing) {
        // A generated rideId has exactly one source ordinal. Refuse to merge
        // inconsistent persisted records instead of guessing which is true.
        if (existing.sourceStepIndex !== record.sourceStepIndex) return;
        existing.records.push(record);
        return;
      }
      const occurrence: RideOccurrence = {
        rideId: record.rideId,
        sourceStepIndex: record.sourceStepIndex,
        legOrder,
        firstSeen: firstSeen++,
        records: [record],
      };
      byRideId.set(record.rideId, occurrence);
      occurrences.push(occurrence);
    };

    // `transit` is a serialized compatibility copy of the first array item,
    // not guaranteed object-identical after reload, so include and sync it.
    add(leg.transit);
    for (const ride of leg.transitSegments ?? []) add(ride);
    for (const path of leg.pathSegments ?? []) {
      if (path.mode === "transit") add(path);
    }
  }

  occurrences.sort(
    (a, b) =>
      a.legOrder - b.legOrder ||
      a.sourceStepIndex - b.sourceStepIndex ||
      a.firstSeen - b.firstSeen
  );

  const used = new Set<number>();
  // Preserve every non-colliding persisted assignment before filling gaps.
  for (const occurrence of occurrences) {
    const existing = occurrence.records
      .map((record) => record.paletteSlot)
      .find((slot): slot is number => validPaletteSlot(slot) && !used.has(slot));
    if (existing !== undefined) {
      occurrence.assignedSlot = existing;
      used.add(existing);
    }
  }

  for (const occurrence of occurrences) {
    if (occurrence.assignedSlot === undefined) {
      let slot: number | null = null;
      for (let candidate = 0; candidate < TRANSIT_PALETTE_CAPACITY; candidate++) {
        if (!used.has(candidate)) {
          slot = candidate;
          used.add(candidate);
          break;
        }
      }
      occurrence.assignedSlot = slot;
    }
    for (const record of occurrence.records) {
      record.paletteSlot = occurrence.assignedSlot;
    }
  }
}

function parseDurationMinutes(duration?: string): number | null {
  if (!duration) return null;
  const m = duration.match(/^(\d+(?:\.\d+)?)s$/);
  if (!m) return null;
  return Math.ceil(parseFloat(m[1]) / 60);
}

/** A provider instant, kept VERBATIM when it parses and dropped when it
 *  does not. The string crosses the wire into the store and back, so it is
 *  checked here rather than trusted: a value we cannot read as a time can
 *  only ever be rendered as one. */
function instantOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** A provider coordinate, or null. Anything that is not a real, in-range
 *  pair is dropped whole — half a coordinate is not a place, and a marker
 *  must never be drawn at a number we made up. */
function latLngOrNull(value: unknown): LatLng | null {
  if (!isRecord(value)) return null;
  const { latitude, longitude } = value;
  if (!finiteNumber(latitude) || latitude < -90 || latitude > 90) return null;
  if (!finiteNumber(longitude) || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

/** WALK / TRANSIT as the app spells them, or null for anything else. A mode
 *  is never inferred — a step whose travelMode we do not recognise is
 *  skipped rather than guessed into one of ours. */
function pathMode(travelMode: unknown): PathSegment["mode"] | null {
  if (travelMode === "WALK") return "walk";
  if (travelMode === "TRANSIT") return "transit";
  return null;
}

/** One step's line, or null. Geometry we cannot read, do not have, or that
 *  is implausibly long for a single step is simply absent — never a
 *  placeholder, because an empty string would decode to a line at (0,0). */
function stepPolyline(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > MAX_PATH_POLYLINE_CHARS ? null : value;
}

/** Both readings of the same walk over `route.legs[].steps[]`, done ONCE:
 *  the rides (Build A — times, colours, stops) and the geometry (this
 *  slice). They are independent outputs of one traversal, so a step can
 *  contribute to either, both, or neither. */
function readSteps(
  route: NonNullable<ComputeRoutesResponse["routes"]>[number],
  identityFactory: TravelIdentityFactory
): { transit: TransitSummary[]; paths: PathSegment[] } {
  const segments: TransitSummary[] = [];
  const paths: PathSegment[] = [];
  let sourceStepIndex = 0;
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      // Capture the raw provider position before EITHER independent filter.
      // A missing step therefore leaves a gap rather than shifting every
      // later ride into somebody else's identity/slot.
      const currentSourceStepIndex = sourceStepIndex++;
      const td = step.transitDetails;
      const mode = pathMode(step.travelMode);
      // A source transit occurrence can survive on either side: provider
      // facts identify one even without drawable geometry; an explicit
      // TRANSIT mode identifies one even when facts are absent.
      const rideId =
        mode === "transit" || td
          ? nextTravelIdentity(identityFactory, "ride")
          : null;
      // GEOMETRY first, and on its own terms: a walk step has no
      // transitDetails and still has a line to draw. Both conditions are
      // hard — no recognised mode or no polyline means no segment, never a
      // half-known one.
      const encoded = stepPolyline(step.polyline?.encodedPolyline);
      if (mode && encoded) {
        if (mode === "transit" && rideId) {
          paths.push({
            mode,
            encodedPolyline: encoded,
            // The provider colour remains factual metadata and the display
            // fallback for legacy/null-overflow rides.
            color: td?.transitLine?.color ?? null,
            rideId,
            sourceStepIndex: currentSourceStepIndex,
            paletteSlot: null,
          });
        } else {
          paths.push({ mode: "walk", encodedPolyline: encoded, color: null });
        }
      }
      if (!td) continue;
      const line = td.transitLine ?? {};
      // avoid "501 501 Queen" when the long name already contains the
      // short name
      const lineName =
        line.nameShort && line.name?.includes(line.nameShort)
          ? line.name
          : [line.nameShort, line.name].filter(Boolean).join(" ").trim();
      const stops = td.stopDetails;
      segments.push({
        rideId: rideId!,
        sourceStepIndex: currentSourceStepIndex,
        paletteSlot: null,
        lineName: lineName || "transit",
        shortName: line.nameShort ?? null,
        color: line.color ?? null,
        textColor: line.textColor ?? null,
        vehicle: line.vehicle?.type ?? null,
        headsign: td.headsign ?? "",
        stopCount: td.stopCount ?? null,
        departStop: stops?.departureStop?.name ?? "",
        arriveStop: stops?.arrivalStop?.name ?? "",
        // the four facts that were arriving and being thrown away
        boardISO: instantOrNull(stops?.departureTime),
        alightISO: instantOrNull(stops?.arrivalTime),
        boardLocation: latLngOrNull(stops?.departureStop?.location?.latLng),
        alightLocation: latLngOrNull(stops?.arrivalStop?.location?.latLng),
      });
    }
  }
  return { transit: segments, paths };
}

// EVERY transit ride of the route, in riding order. This used to return
// on the FIRST step with transitDetails — any transfer after it was
// discarded before the data ever reached the UI, which is why the strip
// could only ever name one line per leg.
//
// Exported as ONE combined result for the MOCK fixture, which builds
// provider-shaped steps and runs them through this same parser. Facts and
// geometry must never be extracted through separate traversals: each pass
// would mint a different app-owned ride identity for the same source step.
export function extractTravelStepRecords(
  route: NonNullable<ComputeRoutesResponse["routes"]>[number],
  identityFactory: TravelIdentityFactory = createTravelIdentity
): { transit: TransitSummary[]; paths: PathSegment[] } {
  return readSteps(route, identityFactory);
}

interface ParsedRoute {
  ok: boolean;
  rawMinutes: number;
  distanceMeters: number | null;
  encodedPolyline: string | null;
  transit: TransitSummary | null;
  transitSegments: TransitSummary[];
  pathSegments: PathSegment[];
}

function parseRoute(
  res: ComputeRoutesResponse | null | undefined,
  identityFactory: TravelIdentityFactory
): ParsedRoute {
  const route = res?.routes?.[0];
  const rawMinutes = parseDurationMinutes(route?.duration);
  if (!route || rawMinutes === null) {
    return {
      ok: false,
      rawMinutes: 0,
      distanceMeters: null,
      encodedPolyline: null,
      transit: null,
      transitSegments: [],
      pathSegments: [],
    };
  }
  const { transit: segments, paths } = extractTravelStepRecords(
    route,
    identityFactory
  );
  return {
    ok: true,
    rawMinutes,
    distanceMeters: route.distanceMeters ?? null,
    encodedPolyline: route.polyline?.encodedPolyline ?? null,
    transit: segments[0] ?? null,
    transitSegments: segments,
    // a leg with more steps than any journey has is not trusted to be one
    pathSegments: paths.length > MAX_PATH_SEGMENTS_PER_LEG ? [] : paths,
  };
}

/**
 * Pure: build one consecutive leg from the two computeRoutes responses.
 * Transit is labeled transit (with TRANSIT_MARGIN_MIN) only when it
 * meaningfully beats walking door to door. A leg becomes a walk when:
 *   - distance < SHORT_LEG_WALK_METERS (transit routing walks short
 *     segments internally anyway), or
 *   - walking is competitive INCLUDING the margin
 *     (walkRaw <= transitRaw + TRANSIT_MARGIN_MIN) AND the walk is one a
 *     person actually takes (<= MAX_WALK_LABEL_MIN) — a 7-minute walk
 *     beats a 13-minutes-with-buffer bus ride, but a 75-minute walk must
 *     never be presented over a 72-minute transit ride, or
 *   - walking beats transit OUTRIGHT (at least twice as fast) — transit
 *     there is effectively broken, any length.
 * Walk-labeled legs use the WALK route's own numbers and geometry when
 * available (falling back to the transit route's on short hops without
 * walk data). Transit unusable → walk route. If neither mode is usable,
 * getSingleLeg keeps mode "unknown" and adds a conservative estimate.
 */
export function buildLeg(
  fromIndex: number,
  transitRes: ComputeRoutesResponse | null,
  walkRes: ComputeRoutesResponse | null,
  identityFactory: TravelIdentityFactory = createTravelIdentity
): TravelLeg {
  const legId = nextTravelIdentity(identityFactory, "leg");
  const t = parseRoute(transitRes, identityFactory);
  const w = parseRoute(walkRes, identityFactory);

  // Geometry always comes from the SAME route as the numbers it describes —
  // a walk-labeled leg must never be drawn from the transit route's steps.
  // Omitted when empty, exactly like transitSegments: an absent field is how
  // this stays additive for every existing reader and stored plan.
  const walkLeg = (src: ParsedRoute): TravelLeg => ({
    legId,
    fromIndex,
    mode: "walk",
    rawMinutes: src.rawMinutes,
    marginMinutes: 0,
    totalMinutes: src.rawMinutes,
    distanceMeters: src.distanceMeters,
    encodedPolyline: src.encodedPolyline,
    ...(src.pathSegments.length > 0 ? { pathSegments: src.pathSegments } : {}),
  });

  if (t.ok) {
    const shortHop =
      t.distanceMeters !== null && t.distanceMeters < SHORT_LEG_WALK_METERS;
    const walkCompetitive =
      w.ok &&
      w.rawMinutes <= t.rawMinutes + TRANSIT_MARGIN_MIN &&
      (w.rawMinutes <= MAX_WALK_LABEL_MIN || w.rawMinutes * 2 <= t.rawMinutes);
    if (shortHop || walkCompetitive) {
      // prefer the real walking route; a short hop without walk data
      // keeps the transit route's numbers (it's walking-pace anyway)
      return walkLeg(w.ok ? w : t);
    }
    return {
      legId,
      fromIndex,
      mode: "transit",
      rawMinutes: t.rawMinutes,
      marginMinutes: TRANSIT_MARGIN_MIN,
      totalMinutes: t.rawMinutes + TRANSIT_MARGIN_MIN,
      distanceMeters: t.distanceMeters,
      encodedPolyline: t.encodedPolyline,
      ...(t.transit ? { transit: t.transit } : {}),
      ...(t.transitSegments.length > 0 ? { transitSegments: t.transitSegments } : {}),
      ...(t.pathSegments.length > 0 ? { pathSegments: t.pathSegments } : {}),
    };
  }

  if (w.ok) return walkLeg(w);

  return {
    legId,
    fromIndex,
    mode: "unknown",
    rawMinutes: 0,
    marginMinutes: 0,
    totalMinutes: 0,
    distanceMeters: null,
    encodedPolyline: null,
  };
}

/**
 * Pure: build one consecutive leg for a DRIVING plan, from the DRIVE and
 * WALK responses. Deliberately a SEPARATE function rather than a mode flag
 * inside `buildLeg` — the transit relabel rules do not transfer, and the
 * two policies should be readable side by side rather than interleaved.
 *
 * The rules, in order:
 *   - The drive priced and is at least DRIVING_SHORT_LEG_WALK_METERS →
 *     a driving leg: the provider's DRIVE duration (a FACT) plus
 *     DRIVING_MARGIN_MIN (a labelled POLICY estimate for leaving and
 *     parking).
 *   - The drive priced but the hop is shorter than that → relabel to WALK,
 *     but ONLY when the WALK route actually priced. This is where driving
 *     departs from transit: a short "transit" route's duration IS Google
 *     walking the hop, so borrowing its number is honest, whereas a short
 *     DRIVE's duration is a car's. Presenting car minutes as walk minutes
 *     would be inventing a fact, so a short drive with no walk data stays
 *     a drive.
 *   - The drive did not price but the walk did → a walk leg, exactly as the
 *     transit path does.
 *   - Neither priced → "unknown", and see getSingleLeg for why a driving
 *     plan gets NO straight-line estimate there.
 *
 * Nothing here consults transit: a driving plan never requests it.
 */
export function buildDrivingLeg(
  fromIndex: number,
  driveRes: ComputeRoutesResponse | null,
  walkRes: ComputeRoutesResponse | null,
  identityFactory: TravelIdentityFactory = createTravelIdentity
): TravelLeg {
  const legId = nextTravelIdentity(identityFactory, "leg");
  const d = parseRoute(driveRes, identityFactory);
  const w = parseRoute(walkRes, identityFactory);

  // Geometry comes from the same route as the numbers, exactly as above.
  // A DRIVE response carries no transit steps, so `pathSegments` is empty
  // here in practice — `pathMode` recognises only WALK and TRANSIT, and a
  // DRIVE step is skipped rather than guessed into one of ours. The
  // whole-leg `encodedPolyline` is a driving leg's map geometry.
  const walkLeg = (src: ParsedRoute): TravelLeg => ({
    legId,
    fromIndex,
    mode: "walk",
    rawMinutes: src.rawMinutes,
    marginMinutes: 0,
    totalMinutes: src.rawMinutes,
    distanceMeters: src.distanceMeters,
    encodedPolyline: src.encodedPolyline,
    ...(src.pathSegments.length > 0 ? { pathSegments: src.pathSegments } : {}),
  });

  if (d.ok) {
    const shortHop =
      d.distanceMeters !== null &&
      d.distanceMeters < DRIVING_SHORT_LEG_WALK_METERS;
    if (shortHop && w.ok) return walkLeg(w);
    return {
      legId,
      fromIndex,
      mode: "driving",
      rawMinutes: d.rawMinutes,
      marginMinutes: DRIVING_MARGIN_MIN,
      totalMinutes: d.rawMinutes + DRIVING_MARGIN_MIN,
      distanceMeters: d.distanceMeters,
      encodedPolyline: d.encodedPolyline,
    };
  }

  if (w.ok) return walkLeg(w);

  return {
    legId,
    fromIndex,
    mode: "unknown",
    rawMinutes: 0,
    marginMinutes: 0,
    totalMinutes: 0,
    distanceMeters: null,
    encodedPolyline: null,
  };
}

async function computeRoute(
  apiKey: string,
  origin: LatLng,
  destination: LatLng,
  travelMode: "TRANSIT" | "WALK" | "DRIVE",
  departureTime?: string
): Promise<ComputeRoutesResponse | null> {
  const body: Record<string, unknown> = {
    origin: { location: { latLng: origin } },
    destination: { location: { latLng: destination } },
    travelMode,
  };
  // Transit routing is schedule-dependent; pass the outing start when
  // it's in the future.
  if (departureTime && new Date(departureTime).getTime() > Date.now()) {
    body.departureTime = departureTime;
  }
  try {
    const res = await fetchProvider("routes", COMPUTE_ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = requireProviderRecord("routes", await readProviderJson("routes", res));
    if (!Array.isArray(data.routes)) {
      throw new Error("Routes provider returned an invalid response.");
    }
    for (const route of data.routes) {
      if (!isRecord(route)) throw new Error("Routes provider returned an invalid route.");
      if (route.duration !== undefined && typeof route.duration !== "string") {
        throw new Error("Routes provider returned an invalid duration.");
      }
      if (
        route.distanceMeters !== undefined &&
        (!finiteNumber(route.distanceMeters) || route.distanceMeters < 0)
      ) {
        throw new Error("Routes provider returned an invalid distance.");
      }
      if (route.legs !== undefined && !Array.isArray(route.legs)) {
        throw new Error("Routes provider returned invalid legs.");
      }
    }
    return data as ComputeRoutesResponse;
  } catch {
    // Per-mode failure is absorbed by the other mode or the explicit
    // unknown fallback. Never log the upstream body or thrown message.
    logEvent("error", "routes_mode_unavailable", { travelMode });
    return null;
  }
}

/**
 * Fetch a single leg between two points. `excludeTransit` is the
 * reroute engine's disruption handling: a cancelled transit leg is
 * re-fetched walk-only so the dead route can't be re-proposed.
 *
 * `planMode` is the PLAN's travel mode, bound once where the engines build
 * their deps rather than passed at each `deps.getSingleLeg(...)` call site.
 * A driving plan requests DRIVE + WALK (the walk so a short hop can still
 * relabel — see DRIVING_SHORT_LEG_WALK_METERS); a transit plan is
 * byte-identical to before this parameter existed.
 *
 * NOTE: `excludeTransit` has no driving meaning. It is the reroute engine's
 * `transit_cancelled` handling, and a driving plan has no transit to
 * cancel — Stage 1 leaves it inert there rather than inventing a driving
 * disruption. Stated, not fixed.
 */
export async function getSingleLeg(
  apiKey: string,
  origin: LatLng,
  destination: LatLng,
  fromIndex: number,
  departureTime?: string,
  excludeTransit = false,
  identityFactory: TravelIdentityFactory = createTravelIdentity,
  planMode: PlanTravelMode = "transit"
): Promise<TravelLeg> {
  const straightLineMeters = haversineMeters(origin, destination);
  if (planMode === "driving") {
    const [driveRes, driveWalkRes] = await Promise.all([
      computeRoute(apiKey, origin, destination, "DRIVE", departureTime),
      computeRoute(apiKey, origin, destination, "WALK", departureTime),
    ]);
    // No walk-speed fallback here, deliberately. The shared estimate below
    // is crow-flies distance at FALLBACK_WALK_SPEED_KMH, which is 3-6x a
    // car's time — a number that would be wrong in the direction that
    // matters, and one nothing measured. When BOTH modes fail we know
    // nothing about this pair of points, and this plan says so rather than
    // guessing. The cost is real and worth naming: an unknown leg carries
    // zero minutes, so the schedule does not pad for it (the §6.2 hazard
    // the transit fallback exists to close). It requires the provider to
    // fail on DRIVE *and* WALK for the same hop.
    return buildDrivingLeg(fromIndex, driveRes, driveWalkRes, identityFactory);
  }
  const skipTransit =
    excludeTransit ||
    straightLineMeters < TRANSIT_SKIP_HAVERSINE_METERS;
  const [transitRes, walkRes] = await Promise.all([
    skipTransit
      ? Promise.resolve(null)
      : computeRoute(apiKey, origin, destination, "TRANSIT", departureTime),
    computeRoute(apiKey, origin, destination, "WALK", departureTime),
  ]);
  const leg = buildLeg(fromIndex, transitRes, walkRes, identityFactory);
  // Neither mode came back. "We don't know how long this takes" was being
  // rendered as "this takes zero minutes", which schedules the next stop
  // the instant this one ends, across any distance — a WRONG time, not a
  // missing one (code-audit 2026-07-18 §6.2). Fall back to a conservative
  // straight-line walking estimate, inflated for street-network detours
  // and then padded for uncertainty. Keep mode "unknown" so the UI says
  // this is an estimate rather than a route or promise.
  if (leg.mode === "unknown") {
    const detouredMinutes = Math.max(
      1,
      Math.ceil(
        (straightLineMeters / 1000 / FALLBACK_WALK_SPEED_KMH) *
          60 *
          FALLBACK_WALK_DETOUR_FACTOR
      )
    );
    const uncertaintyMinutes = Math.max(
      FALLBACK_WALK_MIN_UNCERTAINTY_MIN,
      Math.ceil(detouredMinutes * FALLBACK_WALK_UNCERTAINTY_RATIO)
    );
    return {
      ...leg,
      rawMinutes: detouredMinutes,
      marginMinutes: uncertaintyMinutes,
      totalMinutes: detouredMinutes + uncertaintyMinutes,
      distanceMeters: straightLineMeters,
    };
  }
  return leg;
}

/**
 * Fetch consecutive-pair travel legs for the ordered stop coordinates.
 * On a transit plan most legs use TRANSIT + WALK; defensibly short
 * crow-flies hops request WALK only because transit would be discarded by
 * the short-leg rule. On a driving plan every leg requests DRIVE + WALK.
 */
export async function getTravelLegs(
  apiKey: string,
  points: LatLng[],
  departureTime?: string,
  dwellMinutes: number[] = [],
  identityFactory: TravelIdentityFactory = createTravelIdentity,
  planMode: PlanTravelMode = "transit"
): Promise<TravelLeg[]> {
  if (points.length < 2) return [];

  // Each leg is routed at ITS OWN estimated departure instant, accumulated
  // from the outing start plus the dwell at each preceding point plus the
  // legs already priced. Transit routing is schedule-dependent, so pricing
  // every leg at the outing's START (as this did) gave a late leg the
  // frequencies — sometimes the services — of the early evening
  // (code-audit 2026-07-18 §1.5). The accumulation is inherently
  // sequential: leg i+1's departure isn't known until leg i is priced. At
  // demo scale (2–4 legs) a correct schedule is worth the round trips.
  // dwellMinutes[i] is the stay at points[i]; index 0 is home (no dwell).
  const startMs = departureTime ? new Date(departureTime).getTime() : NaN;
  let cursorMs = startMs;
  const legs: TravelLeg[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const depart = Number.isFinite(cursorMs)
      ? new Date(cursorMs).toISOString()
      : undefined;
    const leg = await getSingleLeg(
      apiKey,
      points[i],
      points[i + 1],
      i,
      depart,
      false,
      identityFactory,
      planMode
    );
    legs.push(leg);
    if (Number.isFinite(cursorMs)) {
      // travel, then stay at the destination before the next leg departs
      cursorMs += (leg.totalMinutes + (dwellMinutes[i + 1] ?? 0)) * 60_000;
    }
  }
  assignTransitPaletteSlots(legs);
  return legs;
}
