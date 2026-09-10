// Encoded-polyline decoding and path arithmetic for the movement simulator.
//
// The polylines this decodes are the REAL ones Google Routes returned for the
// persona's own plan — read back off the wire from the app's own
// `GET /api/itinerary/<id>` response, not re-fetched and not invented. If a
// leg carries no geometry (the documented `unknown` estimate, or a provider
// response with no line), the caller is told so and records it; nothing here
// fabricates a path.

export interface Point {
  lat: number;
  lng: number;
}

/**
 * Google's encoded polyline algorithm, precision 5. Standard implementation:
 * five-bit chunks, little-endian, offset by 63, negatives one's-complemented.
 */
export function decodePolyline(encoded: string): Point[] {
  const points: Point[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle metres between two points. */
export function haversineMeters(a: Point, b: Point): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a path, in metres. */
export function pathLengthMeters(path: Point[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += haversineMeters(path[i - 1], path[i]);
  return total;
}

function lerp(a: Point, b: Point, t: number): Point {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/**
 * Re-sample a path into `count` points spaced evenly BY DISTANCE along the
 * real line, first and last inclusive. Coarse on purpose: the owner asked for
 * a directionally-correct crawl along the true street geometry, not sub-metre
 * fidelity. Every sample still sits ON the provider's line.
 */
export function resamplePath(path: Point[], count: number): Point[] {
  const clean = path.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)
  );
  if (clean.length === 0) return [];
  if (clean.length === 1 || count <= 1) return [clean[0]];

  const cumulative: number[] = [0];
  for (let i = 1; i < clean.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineMeters(clean[i - 1], clean[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total === 0) return [clean[0], clean[clean.length - 1]];

  const out: Point[] = [];
  let segment = 1;
  for (let i = 0; i < count; i++) {
    const want = (total * i) / (count - 1);
    while (segment < cumulative.length - 1 && cumulative[segment] < want) segment++;
    const spanStart = cumulative[segment - 1];
    const spanLength = cumulative[segment] - spanStart;
    const t = spanLength === 0 ? 0 : (want - spanStart) / spanLength;
    out.push(lerp(clean[segment - 1], clean[segment], t));
  }
  return out;
}

/**
 * A small realistic wobble around a point.
 *
 * TWO reasons, both real. (1) A phone never reports the identical coordinate
 * twice, so a perfectly static dwell is not what the app would ever see.
 * (2) Chromium's geolocation override may not re-deliver an unchanged
 * position to an active `watchPosition`, so an unjittered dwell could starve
 * the very stream this harness exists to exercise. Amplitude is a few metres
 * — far inside the app's own 75 m arrival radius, so it cannot manufacture
 * or prevent an arrival.
 */
export function jitter(point: Point, meters: number, rand = Math.random): Point {
  const angle = rand() * 2 * Math.PI;
  const distance = rand() * meters;
  const dLat = (distance * Math.cos(angle)) / 111_320;
  const dLng =
    (distance * Math.sin(angle)) /
    (111_320 * Math.max(0.1, Math.cos((point.lat * Math.PI) / 180)));
  return { lat: point.lat + dLat, lng: point.lng + dLng };
}
