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

const FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.polyline.encodedPolyline",
  "routes.legs.steps.transitDetails",
].join(",");

export interface LatLng {
  latitude: number;
  longitude: number;
}

// Raw computeRoutes response shape (the parts we read).
export interface ComputeRoutesResponse {
  routes?: Array<{
    duration?: string; // "123s"
    distanceMeters?: number;
    polyline?: { encodedPolyline?: string };
    legs?: Array<{
      steps?: Array<{
        transitDetails?: {
          headsign?: string;
          stopCount?: number;
          transitLine?: { name?: string; nameShort?: string };
          stopDetails?: {
            departureStop?: { name?: string };
            arrivalStop?: { name?: string };
          };
        };
      }>;
    }>;
  }>;
}

export interface TransitSummary {
  lineName: string;
  headsign: string;
  stopCount: number | null;
  departStop: string;
  arriveStop: string;
}

export interface TravelLeg {
  /** leg from timed stop i to timed stop i+1 */
  fromIndex: number;
  mode: "transit" | "walk" | "unknown";
  rawMinutes: number;
  marginMinutes: number;
  totalMinutes: number;
  distanceMeters: number | null;
  /** real route geometry for the map; null when no route data */
  encodedPolyline: string | null;
  /** first transit ride of the leg — only on transit-labeled legs */
  transit?: TransitSummary;
}

function parseDurationMinutes(duration?: string): number | null {
  if (!duration) return null;
  const m = duration.match(/^(\d+(?:\.\d+)?)s$/);
  if (!m) return null;
  return Math.ceil(parseFloat(m[1]) / 60);
}

function extractTransitSummary(
  route: NonNullable<ComputeRoutesResponse["routes"]>[number]
): TransitSummary | null {
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const td = step.transitDetails;
      if (!td) continue;
      const line = td.transitLine ?? {};
      // avoid "501 501 Queen" when the long name already contains the
      // short name
      const lineName =
        line.nameShort && line.name?.includes(line.nameShort)
          ? line.name
          : [line.nameShort, line.name].filter(Boolean).join(" ").trim();
      return {
        lineName: lineName || "transit",
        headsign: td.headsign ?? "",
        stopCount: td.stopCount ?? null,
        departStop: td.stopDetails?.departureStop?.name ?? "",
        arriveStop: td.stopDetails?.arrivalStop?.name ?? "",
      };
    }
  }
  return null;
}

interface ParsedRoute {
  ok: boolean;
  rawMinutes: number;
  distanceMeters: number | null;
  encodedPolyline: string | null;
  transit: TransitSummary | null;
}

function parseRoute(
  res: ComputeRoutesResponse | null | undefined
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
    };
  }
  return {
    ok: true,
    rawMinutes,
    distanceMeters: route.distanceMeters ?? null,
    encodedPolyline: route.polyline?.encodedPolyline ?? null,
    transit: extractTransitSummary(route),
  };
}

/**
 * Pure: build one consecutive leg from the two computeRoutes responses.
 * Transit is labeled transit (with TRANSIT_MARGIN_MIN) only when it
 * meaningfully beats walking door to door. A leg becomes a walk when:
 *   - distance < SHORT_LEG_WALK_METERS (transit routing walks short
 *     segments internally anyway), or
 *   - walking is competitive INCLUDING the margin
 *     (walkRaw <= transitRaw + TRANSIT_MARGIN_MIN) — a 7-minute walk
 *     beats a 13-minutes-with-buffer bus ride.
 * Walk-labeled legs use the WALK route's own numbers and geometry when
 * available (falling back to the transit route's on short hops without
 * walk data). Transit unusable → walk route. Neither → "unknown", 0 min.
 */
export function buildLeg(
  fromIndex: number,
  transitRes: ComputeRoutesResponse | null,
  walkRes: ComputeRoutesResponse | null
): TravelLeg {
  const t = parseRoute(transitRes);
  const w = parseRoute(walkRes);

  const walkLeg = (src: ParsedRoute): TravelLeg => ({
    fromIndex,
    mode: "walk",
    rawMinutes: src.rawMinutes,
    marginMinutes: 0,
    totalMinutes: src.rawMinutes,
    distanceMeters: src.distanceMeters,
    encodedPolyline: src.encodedPolyline,
  });

  if (t.ok) {
    const shortHop =
      t.distanceMeters !== null && t.distanceMeters < SHORT_LEG_WALK_METERS;
    const walkCompetitive =
      w.ok && w.rawMinutes <= t.rawMinutes + TRANSIT_MARGIN_MIN;
    if (shortHop || walkCompetitive) {
      // prefer the real walking route; a short hop without walk data
      // keeps the transit route's numbers (it's walking-pace anyway)
      return walkLeg(w.ok ? w : t);
    }
    return {
      fromIndex,
      mode: "transit",
      rawMinutes: t.rawMinutes,
      marginMinutes: TRANSIT_MARGIN_MIN,
      totalMinutes: t.rawMinutes + TRANSIT_MARGIN_MIN,
      distanceMeters: t.distanceMeters,
      encodedPolyline: t.encodedPolyline,
      ...(t.transit ? { transit: t.transit } : {}),
    };
  }

  if (w.ok) return walkLeg(w);

  return {
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
  travelMode: "TRANSIT" | "WALK",
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
    const res = await fetch(COMPUTE_ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await res.json();
    if (!res.ok) {
      // Per-leg failure shouldn't sink the whole plan; the other mode
      // (or "unknown") absorbs it. Log so real key/config errors are
      // visible server-side.
      console.error(
        `[travel] computeRoutes ${travelMode} failed (${res.status}):`,
        data?.error?.message ?? data
      );
      return null;
    }
    return data as ComputeRoutesResponse;
  } catch (err) {
    console.error(`[travel] computeRoutes ${travelMode} unreachable:`, err);
    return null;
  }
}

/**
 * Fetch a single leg between two points. `excludeTransit` is the
 * reroute engine's disruption handling: a cancelled transit leg is
 * re-fetched walk-only so the dead route can't be re-proposed.
 */
export async function getSingleLeg(
  apiKey: string,
  origin: LatLng,
  destination: LatLng,
  fromIndex: number,
  departureTime?: string,
  excludeTransit = false
): Promise<TravelLeg> {
  const [transitRes, walkRes] = await Promise.all([
    excludeTransit
      ? Promise.resolve(null)
      : computeRoute(apiKey, origin, destination, "TRANSIT", departureTime),
    computeRoute(apiKey, origin, destination, "WALK", departureTime),
  ]);
  return buildLeg(fromIndex, transitRes, walkRes);
}

/**
 * Fetch consecutive-pair travel legs for the ordered stop coordinates.
 * Two computeRoutes calls per leg (TRANSIT + WALK), all in parallel.
 * Cost note: fine at demo scale.
 * TODO: skip the TRANSIT call when haversine distance <
 * SHORT_LEG_WALK_METERS — the short-leg relabel would win anyway, and
 * it halves calls on dense itineraries.
 */
export async function getTravelLegs(
  apiKey: string,
  points: LatLng[],
  departureTime?: string
): Promise<TravelLeg[]> {
  if (points.length < 2) return [];

  return Promise.all(
    points
      .slice(0, -1)
      .map((origin, i) =>
        getSingleLeg(apiKey, origin, points[i + 1], i, departureTime)
      )
  );
}
