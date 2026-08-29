// `computeYouMarker` + `liveControlLabel`, proven without a DOM, a clock, or
// a real GPS. `nowMs` is injected so every staleness branch is exact.
import assert from "node:assert";
import { computeYouMarker, liveControlLabel } from "./youMarker";
import {
  INITIAL_LIVE_TRACKING_STATE,
  LIVE_TRACKING_STALENESS_MS,
  type LiveTrackingState,
} from "./liveTracking";

type Case = [string, () => void];

const NOW = 1_000_000_000_000;
const FIX = {
  lat: 43.6488,
  lng: -79.4202,
  accuracyM: 42,
  deviceTimestamp: NOW - 3_000,
};

function state(patch: Partial<LiveTrackingState>): LiveTrackingState {
  return { ...INITIAL_LIVE_TRACKING_STATE, ...patch };
}

const cases: Case[] = [
  [
    "no position -> render nothing (any status)",
    () => {
      assert.strictEqual(computeYouMarker(state({ status: "requesting" }), NOW), null);
      assert.strictEqual(computeYouMarker(state({ status: "off" }), NOW), null);
      assert.strictEqual(computeYouMarker(state({ status: "unavailable" }), NOW), null);
    },
  ],
  [
    "denied with a (defensively) retained position -> still render nothing",
    () => {
      const view = computeYouMarker(
        state({ status: "denied", position: FIX, lastUpdatedAt: NOW - 1_000 }),
        NOW
      );
      assert.strictEqual(view, null);
    },
  ],
  [
    "non-finite coordinates -> render nothing rather than a broken dot",
    () => {
      const view = computeYouMarker(
        state({
          status: "live",
          position: { ...FIX, lat: Number.NaN },
          lastUpdatedAt: NOW,
        }),
        NOW
      );
      assert.strictEqual(view, null);
    },
  ],
  [
    "live, fresh fix -> a marker with live styling and the real accuracy",
    () => {
      const view = computeYouMarker(
        state({ status: "live", position: FIX, lastUpdatedAt: NOW - 3_000 }),
        NOW
      );
      assert.ok(view);
      assert.strictEqual(view!.stale, false);
      assert.strictEqual(view!.lat, 43.6488);
      assert.strictEqual(view!.lng, -79.4202);
      assert.strictEqual(view!.accuracyM, 42);
      assert.strictEqual(view!.ageMs, 3_000);
      assert.strictEqual(view!.lastFixAtMs, NOW - 3_000);
    },
  ],
  [
    "status 'stale' with a retained fix -> marker with the stale treatment, fix unchanged",
    () => {
      const view = computeYouMarker(
        state({
          status: "stale",
          position: FIX,
          lastUpdatedAt: NOW - 120_000,
          staleReason: "backgrounded",
        }),
        NOW
      );
      assert.ok(view);
      assert.strictEqual(view!.stale, true);
      // The coordinate is EXACTLY the last real fix — never nudged.
      assert.strictEqual(view!.lat, FIX.lat);
      assert.strictEqual(view!.lng, FIX.lng);
      assert.strictEqual(view!.ageMs, 120_000);
    },
  ],
  [
    "post-background 'requesting' still holding the old fix -> treated as stale",
    () => {
      const view = computeYouMarker(
        state({ status: "requesting", position: FIX, lastUpdatedAt: NOW - 30_000 }),
        NOW
      );
      assert.ok(view);
      assert.strictEqual(view!.stale, true);
    },
  ],
  [
    "status still 'live' but the fix has aged past the staleness threshold -> stale",
    () => {
      const aged = NOW - (LIVE_TRACKING_STALENESS_MS + 5_000);
      const view = computeYouMarker(
        state({ status: "live", position: FIX, lastUpdatedAt: aged }),
        NOW
      );
      assert.ok(view);
      assert.strictEqual(view!.stale, true);
    },
  ],
  [
    "status 'live', fix exactly at the staleness threshold -> still fresh (<=)",
    () => {
      const view = computeYouMarker(
        state({
          status: "live",
          position: FIX,
          lastUpdatedAt: NOW - LIVE_TRACKING_STALENESS_MS,
        }),
        NOW
      );
      assert.ok(view);
      assert.strictEqual(view!.stale, false);
    },
  ],
  [
    "accuracy that is not a usable positive number -> no ring (accuracyM null), dot still shows",
    () => {
      for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
        const view = computeYouMarker(
          state({
            status: "live",
            position: { ...FIX, accuracyM: bad },
            lastUpdatedAt: NOW,
          }),
          NOW
        );
        assert.ok(view, `accuracy ${bad}`);
        assert.strictEqual(view!.accuracyM, null, `accuracy ${bad}`);
      }
    },
  ],
  [
    "accuracy passes through faithfully so the ring can scale with it",
    () => {
      const tight = computeYouMarker(
        state({ status: "live", position: { ...FIX, accuracyM: 25 }, lastUpdatedAt: NOW }),
        NOW
      );
      const loose = computeYouMarker(
        state({ status: "live", position: { ...FIX, accuracyM: 900 }, lastUpdatedAt: NOW }),
        NOW
      );
      assert.strictEqual(tight!.accuracyM, 25);
      assert.strictEqual(loose!.accuracyM, 900);
    },
  ],
  [
    "NO INTERPOLATION: advancing nowMs never moves the marker off the last real fix",
    () => {
      const s = state({ status: "stale", position: FIX, lastUpdatedAt: NOW - 10_000 });
      const early = computeYouMarker(s, NOW);
      const later = computeYouMarker(s, NOW + 600_000);
      assert.strictEqual(early!.lat, later!.lat);
      assert.strictEqual(early!.lng, later!.lng);
      assert.strictEqual(early!.accuracyM, later!.accuracyM);
      // Only the reported age grows.
      assert.strictEqual(early!.ageMs, 10_000);
      assert.strictEqual(later!.ageMs, 610_000);
    },
  ],
  [
    "lastFixAtMs falls back to the device timestamp when our receipt clock is somehow null",
    () => {
      const view = computeYouMarker(
        state({ status: "stale", position: FIX, lastUpdatedAt: null }),
        NOW
      );
      assert.ok(view);
      assert.strictEqual(view!.ageMs, null);
      assert.strictEqual(view!.lastFixAtMs, FIX.deviceTimestamp);
    },
  ],
  [
    "liveControlLabel: off -> an invitation; denied/unavailable -> the honest note",
    () => {
      assert.match(liveControlLabel(false, "off"), /Show your live location/);
      assert.match(liveControlLabel(true, "live"), /Live location on/);
      assert.match(liveControlLabel(true, "stale"), /paused/i);
      assert.match(liveControlLabel(true, "denied"), /permission is off/i);
      assert.match(liveControlLabel(true, "unavailable"), /could not provide a location/i);
    },
  ],
];

function main() {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error instanceof Error ? error.stack : error}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
