// Real travel time between consecutive stops via Routes API
// computeRouteMatrix. Replaces the travelMinutesToNext: 0 placeholder.
const MATRIX_URL =
  "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

// Pad transit legs on the departure side — buses/subways don't leave
// when you arrive at the stop. Walking needs no margin.
export const TRANSIT_MARGIN_MIN = 5;

// Below this distance a "transit" route is effectively a walk (Google
// walks short segments inside transit routing), so it gets the walk
// label and no margin.
export const SHORT_LEG_WALK_METERS = 400;

// originIndex/destinationIndex are required in the mask even though the
// caller only asked for duration/distance/condition: the matrix response
// is an unordered stream of elements, and without the indices there is
// no way to tell which origin/destination pair an element belongs to.
const FIELD_MASK =
  "originIndex,destinationIndex,duration,distanceMeters,condition";

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface MatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  duration?: string; // "123s"
  distanceMeters?: number;
  condition?: string; // "ROUTE_EXISTS" | "ROUTE_NOT_FOUND"
}

export interface TravelLeg {
  /** leg from timed stop i to timed stop i+1 */
  fromIndex: number;
  mode: "transit" | "walk" | "unknown";
  rawMinutes: number;
  marginMinutes: number;
  totalMinutes: number;
  distanceMeters: number | null;
}

function parseDurationMinutes(duration?: string): number | null {
  if (!duration) return null;
  const m = duration.match(/^(\d+(?:\.\d+)?)s$/);
  if (!m) return null;
  return Math.ceil(parseFloat(m[1]) / 60);
}

function findElement(
  elements: MatrixElement[],
  origin: number,
  destination: number
): MatrixElement | undefined {
  return elements.find(
    (e) => e.originIndex === origin && e.destinationIndex === destination
  );
}

function usable(e: MatrixElement | undefined): boolean {
  return (
    !!e &&
    e.condition === "ROUTE_EXISTS" &&
    parseDurationMinutes(e.duration) !== null
  );
}

/**
 * Pure: build consecutive legs (i → i+1) from matrix elements.
 * Transit is preferred and gets TRANSIT_MARGIN_MIN — unless the leg is
 * effectively a walk (distance < SHORT_LEG_WALK_METERS, or transit is
 * no faster than walking the same leg), which gets the walk label and
 * no margin. A leg falls back to the walk matrix when transit has no
 * route. Neither usable → mode "unknown" with 0 minutes (schedule
 * proceeds, UI can flag it).
 */
export function extractConsecutiveLegs(
  transitElements: MatrixElement[],
  walkElements: MatrixElement[] | null,
  stopCount: number
): TravelLeg[] {
  const legs: TravelLeg[] = [];
  for (let i = 0; i < stopCount - 1; i++) {
    const transit = findElement(transitElements, i, i + 1);
    if (usable(transit)) {
      const raw = parseDurationMinutes(transit!.duration)!;
      const dist = transit!.distanceMeters ?? null;
      const walk = walkElements
        ? findElement(walkElements, i, i + 1)
        : undefined;
      const walkRaw = usable(walk) ? parseDurationMinutes(walk!.duration) : null;

      const shortHop = dist !== null && dist < SHORT_LEG_WALK_METERS;
      const noFasterThanWalk = walkRaw !== null && raw <= walkRaw;
      if (shortHop || noFasterThanWalk) {
        legs.push({
          fromIndex: i,
          mode: "walk",
          rawMinutes: raw,
          marginMinutes: 0,
          totalMinutes: raw,
          distanceMeters: dist,
        });
        continue;
      }

      legs.push({
        fromIndex: i,
        mode: "transit",
        rawMinutes: raw,
        marginMinutes: TRANSIT_MARGIN_MIN,
        totalMinutes: raw + TRANSIT_MARGIN_MIN,
        distanceMeters: dist,
      });
      continue;
    }
    const walk = walkElements ? findElement(walkElements, i, i + 1) : undefined;
    if (usable(walk)) {
      const raw = parseDurationMinutes(walk!.duration)!;
      legs.push({
        fromIndex: i,
        mode: "walk",
        rawMinutes: raw,
        marginMinutes: 0,
        totalMinutes: raw,
        distanceMeters: walk!.distanceMeters ?? null,
      });
      continue;
    }
    legs.push({
      fromIndex: i,
      mode: "unknown",
      rawMinutes: 0,
      marginMinutes: 0,
      totalMinutes: 0,
      distanceMeters: null,
    });
  }
  return legs;
}

async function computeMatrix(
  apiKey: string,
  points: LatLng[],
  travelMode: "TRANSIT" | "WALK",
  departureTime?: string
): Promise<MatrixElement[]> {
  const waypoints = points.map((p) => ({
    waypoint: { location: { latLng: p } },
  }));
  const body: Record<string, unknown> = {
    origins: waypoints,
    destinations: waypoints,
    travelMode,
  };
  // Transit routing is schedule-dependent; pass the outing start when
  // it's in the future. (Matrix takes one departureTime for all legs —
  // close enough at Ossington scale.)
  if (departureTime && new Date(departureTime).getTime() > Date.now()) {
    body.departureTime = departureTime;
  }
  const res = await fetch(MATRIX_URL, {
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
    throw new Error(
      data?.error?.message ?? `Route matrix request failed (${res.status}).`
    );
  }
  // computeRouteMatrix returns a JSON array of elements
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch consecutive-pair travel legs for the ordered stop coordinates.
 * N ≤ 5, so requesting the full matrix (and a walk matrix only when a
 * transit leg is missing) is trivially cheap.
 */
export async function getTravelLegs(
  apiKey: string,
  points: LatLng[],
  departureTime?: string
): Promise<TravelLeg[]> {
  if (points.length < 2) return [];

  // Both matrices in parallel: walk data serves as fallback for
  // no-route transit legs AND the transit-no-faster-than-walk check.
  const [transitElements, walkElements] = await Promise.all([
    computeMatrix(apiKey, points, "TRANSIT", departureTime),
    computeMatrix(apiKey, points, "WALK", departureTime),
  ]);

  return extractConsecutiveLegs(transitElements, walkElements, points.length);
}
