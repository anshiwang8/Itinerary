// Simulated device movement along the plan's REAL route geometry.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS FEEDS THE REAL CODE PATH, AND HOW TO KEEP IT THAT WAY
// ─────────────────────────────────────────────────────────────────────────
// `context.setGeolocation()` sets Chromium's geolocation OVERRIDE at the
// browser level (CDP `Emulation.setGeolocationOverride`). The page's
// `navigator.geolocation` is the real one; the position it hands back is the
// emulated one. So the app's own `liveTracking.ts` → `REAL_LIVE_TRACKING_DEPS`
// → `navigator.geolocation.watchPosition` runs completely unmodified, its
// `handleFix` receives a genuine `GeolocationPosition` (with a real
// `timestamp`, so the stale-on-arrival guard behaves normally), and the
// heartbeat, the visibility handling, `computeYouMarker` and `reduceArrival`
// all run for real.
//
// NOTHING here injects state into the page, stubs `navigator.geolocation`,
// patches a module, or calls an app function. If a future edit is tempted to
// do any of that, the harness has stopped testing the thing it exists for.
//
// The geometry walked is the provider's own polyline for THIS plan's legs,
// read back off the wire. Where a leg genuinely carries no geometry (the
// documented `unknown` estimate), the caller is told and records it; this
// module never invents a road.

import type { BrowserContext } from "@playwright/test";
import { decodePolyline, jitter, pathLengthMeters, resamplePath, type Point } from "./geo";
import { PACE_METERS_PER_SECOND, type RunOptions } from "../config";
import type { ObservedLeg } from "../types";

export interface LegPath {
  points: Point[];
  /** Where the line came from, for the report's evidence trail. */
  source: "pathSegments" | "encodedPolyline" | "none";
  meters: number;
}

/**
 * The drawable line for one leg, preferring the step-by-step `pathSegments`
 * (the walk to the stop, the ride, the transfer walk) over the seamless
 * whole-leg `encodedPolyline`. Both are the provider's own; the segments are
 * simply the more faithful shape.
 */
export function legPath(leg: ObservedLeg | null): LegPath {
  if (!leg) return { points: [], source: "none", meters: 0 };

  const segments = leg.pathSegments ?? [];
  if (segments.length > 0) {
    const points: Point[] = [];
    for (const segment of segments) {
      if (typeof segment.encodedPolyline !== "string" || !segment.encodedPolyline) continue;
      const decoded = decodePolyline(segment.encodedPolyline);
      // Drop a duplicated seam point so the joined path has no zero-length hop.
      const start =
        points.length > 0 &&
        decoded.length > 0 &&
        Math.abs(points[points.length - 1].lat - decoded[0].lat) < 1e-6 &&
        Math.abs(points[points.length - 1].lng - decoded[0].lng) < 1e-6
          ? 1
          : 0;
      points.push(...decoded.slice(start));
    }
    if (points.length >= 2) {
      return { points, source: "pathSegments", meters: pathLengthMeters(points) };
    }
  }

  if (leg.encodedPolyline) {
    const points = decodePolyline(leg.encodedPolyline);
    if (points.length >= 2) {
      return { points, source: "encodedPolyline", meters: pathLengthMeters(points) };
    }
  }
  return { points: [], source: "none", meters: 0 };
}

export interface CrawlOutcome {
  /** How the line was obtained, or that there was none. */
  source: LegPath["source"];
  meters: number;
  fixesDelivered: number;
  wallClockMs: number;
  finalPoint: Point | null;
}

/**
 * Walk the device along a path, delivering a position every
 * `fixIntervalMs`.
 *
 * Pace is derived from a REAL ground speed for the leg's mode, then divided
 * by `speedMultiplier` so a full run is minutes rather than hours. The route
 * followed is unchanged by that compression: the same real points in the same
 * real order. `maxLegTravelMs` caps any single leg so one cross-town ride
 * cannot dominate the run.
 */
export async function crawlPath(
  context: BrowserContext,
  path: LegPath,
  options: {
    mode: "walk" | "drive" | "transit";
    /** The leg's own door-to-door minutes, when the provider gave them. */
    legMinutes?: number;
    accuracyM: number;
    run: RunOptions;
    abort: () => boolean;
  }
): Promise<CrawlOutcome> {
  const started = Date.now();
  if (path.points.length < 2) {
    return { source: path.source, meters: 0, fixesDelivered: 0, wallClockMs: 0, finalPoint: null };
  }

  const realSpeed =
    options.mode === "transit" && options.legMinutes && options.legMinutes > 0
      ? path.meters / (options.legMinutes * 60)
      : PACE_METERS_PER_SECOND[options.mode];
  const realSeconds = path.meters / Math.max(0.5, realSpeed);
  const compressedMs = (realSeconds * 1000) / options.run.speedMultiplier;
  const budgetMs = Math.min(options.run.maxLegTravelMs, Math.max(options.run.fixIntervalMs * 2, compressedMs));

  const steps = Math.max(2, Math.round(budgetMs / options.run.fixIntervalMs));
  const samples = resamplePath(path.points, steps);

  let delivered = 0;
  let last: Point | null = null;
  for (const sample of samples) {
    if (options.abort()) break;
    const reported = jitter(sample, 3);
    await context.setGeolocation({
      latitude: reported.lat,
      longitude: reported.lng,
      accuracy: options.accuracyM,
    });
    delivered++;
    last = reported;
    await sleep(options.run.fixIntervalMs);
  }
  return {
    source: path.source,
    meters: path.meters,
    fixesDelivered: delivered,
    wallClockMs: Date.now() - started,
    finalPoint: last,
  };
}

/**
 * Stand still at a point, still reporting a live position.
 *
 * The dwell is REAL wall-clock time and deliberately NOT compressed: the
 * app's `ARRIVAL_DWELL_MS` is 45 s of real time and its staleness threshold
 * is 45 s of real time, so compressing a dwell would be testing a different
 * app. The position wobbles a few metres per fix — far inside the 75 m
 * arrival radius, so it cannot manufacture or prevent an arrival, and it
 * keeps the fix stream genuinely alive.
 */
export async function dwellAt(
  context: BrowserContext,
  point: Point,
  options: { seconds: number; accuracyM: number; run: RunOptions; abort: () => boolean }
): Promise<{ fixesDelivered: number; wallClockMs: number }> {
  const started = Date.now();
  const until = started + options.seconds * 1000;
  let delivered = 0;
  while (Date.now() < until) {
    if (options.abort()) break;
    const reported = jitter(point, 4);
    await context.setGeolocation({
      latitude: reported.lat,
      longitude: reported.lng,
      accuracy: options.accuracyM,
    });
    delivered++;
    await sleep(options.run.fixIntervalMs);
  }
  return { fixesDelivered: delivered, wallClockMs: Date.now() - started };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
