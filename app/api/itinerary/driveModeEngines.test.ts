// Drive-vs-transit mode, Stage 1: THE point of storing the mode. A plan is
// built driving; then a swap, a removal and a reroute re-price its legs, and
// every new leg must still be a DRIVE rather than silently reverting to
// transit.
//
// The binding is deliberately NOT stubbed out. `getSingleLeg` is the one dep
// these cases do not inject, so it comes from `realDeps(itinerary.travelMode)`
// — which, under E2E_MOCK, is the mock builder. That makes this suite cover
// the whole chain at once: stored `travelMode` → `realDeps(mode)` → the mock
// deps builder → `mockLeg(..., mode)`. Break the mode-threading at any link
// and these go red.
//
// Run with: npx tsx app/api/itinerary/driveModeEngines.test.ts

// Set BEFORE the engines are used: `isMockMode()` reads the env var at call
// time, so this makes realDeps() hand back the fixture deps.
process.env.E2E_MOCK = "1";

import assert from "node:assert";
import { createItinerary, Itinerary } from "./store";
import { SwapDeps, swapStop } from "./swap";
import { removeStop } from "./removeStop";
import { rerouteItinerary, RerouteDeps } from "./reroute";
import { Place } from "../places/search/filter";
import { ScheduledStop } from "../schedule/schedule";
import { PlanTravelMode, TravelLeg } from "../schedule/travel";

const T = (h: number, m: number) =>
  `2026-07-03T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`;

// Deliberately spread ~3 km apart: comfortably past
// DRIVING_SHORT_LEG_WALK_METERS, so a driving plan's legs really are drives
// and the assertions are about the MODE rather than about the threshold.
const A = { latitude: 43.6547, longitude: -79.3862 };
const B = { latitude: 43.6847, longitude: -79.3862 };
const C = { latitude: 43.7147, longitude: -79.3862 };

function leg(fromIndex: number, mode: "transit" | "driving", total: number): TravelLeg {
  return {
    fromIndex,
    mode,
    rawMinutes: mode === "driving" ? total - 10 : total - 5,
    marginMinutes: mode === "driving" ? 10 : 5,
    totalMinutes: total,
    distanceMeters: 3_300,
    encodedPolyline: "enc_stored",
  };
}

function mkStops(): ScheduledStop[] {
  return [
    {
      category: "dinner",
      id: "d1",
      name: "Dinner Spot",
      start_time: T(19, 0),
      end_time: T(20, 45),
      durationMinutes: { base: 90, buffer: 15, total: 105 },
      location: A,
      travelMinutesToNext: 20,
      travelToNext: leg(0, "driving", 20),
    },
    {
      category: "bar",
      id: "b1",
      name: "Bar Spot",
      start_time: T(21, 5),
      end_time: T(22, 15),
      durationMinutes: { base: 60, buffer: 10, total: 70 },
      location: B,
      travelMinutesToNext: 20,
      travelToNext: leg(1, "driving", 20),
    },
    {
      category: "dessert",
      id: "s1",
      name: "Dessert Spot",
      start_time: T(22, 35),
      end_time: T(23, 15),
      durationMinutes: { base: 30, buffer: 10, total: 40 },
      location: C,
    },
  ];
}

function mkItinerary(travelMode: PlanTravelMode | undefined): Itinerary {
  return createItinerary(
    mkStops(),
    [leg(0, "driving", 20), leg(1, "driving", 20)],
    {
      time_window: "evening",
      stop_count: null,
      aesthetic: "lively",
      category_signals: ["dinner", "bar", "dessert"],
      group_context: "date",
      budget: null,
      constraints: [],
      location: "Ossington",
    },
    null,
    { label: "Home", location: A },
    null,
    null,
    travelMode
  );
}

function mkVenue(id: string): Place {
  return {
    id,
    displayName: { text: `New ${id}` },
    rating: 4.5,
    businessStatus: "OPERATIONAL",
    // far from every existing stop, so its inbound leg is a real drive
    location: { latitude: 43.7447, longitude: -79.3862 },
  };
}

/**
 * EVERY dep except `getSingleLeg`. That omission is the whole test: the leg
 * fetcher has to come from the engine's own `realDeps(itinerary.travelMode)`.
 */
function swapDepsWithoutLegs(): Partial<SwapDeps> {
  return {
    interpret: async (parsed, category) => ({
      intent: "venue",
      path: "refilter",
      category,
      aesthetic: parsed.aesthetic,
      budget: parsed.budget,
      constraints: [],
      time: null,
      duration: null,
    }),
    searchPools: async (_parsed, cats) => ({ [cats[0]]: [mkVenue(`${cats[0]}_fresh`)] }),
    selectVenues: async (_parsed, pools) =>
      Object.entries(pools).map(([category, arr]) => ({
        category,
        id: arr[0]?.id ?? null,
        reason: `A fresh ${category}.`,
        name: arr[0]?.displayName?.text,
        rating: arr[0]?.rating,
      })),
    isUsableAt: () => true,
    getWeather: async () => null,
  };
}

function rerouteDepsWithoutLegs(): Partial<RerouteDeps> {
  return {
    searchPools: async (_parsed, cats) =>
      Object.fromEntries(cats.map((c) => [c, [mkVenue(`${c}_fresh`)]])),
    selectVenues: async (_parsed, pools) =>
      Object.entries(pools).map(([category, arr]) => ({
        category,
        id: arr[0]?.id ?? null,
        reason: `A fresh ${category}.`,
        name: arr[0]?.displayName?.text,
        rating: arr[0]?.rating,
      })),
    getWeather: async () => null,
  };
}

/** Every leg the plan now holds, home leg included. */
function allLegs(it: Itinerary): TravelLeg[] {
  return [
    ...(it.homeLeg ? [it.homeLeg] : []),
    ...it.stops.flatMap((s) => (s.travelToNext ? [s.travelToNext] : [])),
  ];
}

/** The legs a mutation actually re-priced, identified by losing the stored
 *  fixture polyline. Untouched legs keep `enc_stored`. */
function recomputedLegs(it: Itinerary): TravelLeg[] {
  return allLegs(it).filter((l) => l.encodedPolyline !== "enc_stored");
}

const cases: Array<[string, () => Promise<void>]> = [
  [
    "a DRIVING plan's swap re-prices its new legs as DRIVING",
    async () => {
      const it = mkItinerary("driving");
      const res = await swapStop(it, 1, "somewhere else", new Date(T(18, 0)), swapDepsWithoutLegs());
      assert.ok(res.swapped, "the swap itself succeeded");
      const fresh = recomputedLegs(it);
      assert.ok(fresh.length > 0, "the swap re-priced at least one leg");
      for (const l of fresh) {
        assert.strictEqual(
          l.mode,
          "driving",
          "a stored driving plan must never silently mutate into transit"
        );
      }
    },
  ],
  [
    "the same swap on a TRANSIT plan still re-prices as TRANSIT",
    async () => {
      const it = mkItinerary("transit");
      const res = await swapStop(it, 1, "somewhere else", new Date(T(18, 0)), swapDepsWithoutLegs());
      assert.ok(res.swapped);
      const fresh = recomputedLegs(it);
      assert.ok(fresh.length > 0);
      for (const l of fresh) assert.strictEqual(l.mode, "transit");
    },
  ],
  [
    "a plan with NO stored travelMode swaps as transit — absent means transit",
    async () => {
      const it = mkItinerary(undefined);
      assert.strictEqual(it.travelMode, undefined, "transit is never written out");
      const res = await swapStop(it, 1, "somewhere else", new Date(T(18, 0)), swapDepsWithoutLegs());
      assert.ok(res.swapped);
      for (const l of recomputedLegs(it)) assert.strictEqual(l.mode, "transit");
    },
  ],
  [
    "a DRIVING plan's removal bridges the gap with a DRIVING leg",
    async () => {
      const it = mkItinerary("driving");
      const res = await removeStop(it, 1, new Date(T(18, 0)), {
        isUsableAt: () => true,
        getWeather: async () => null,
      });
      assert.ok(res.removed, "the removal itself succeeded");
      assert.strictEqual(it.stops.length, 2);
      const bridging = it.stops[0].travelToNext;
      assert.ok(bridging, "the predecessor now travels straight to the successor");
      assert.strictEqual(
        bridging!.mode,
        "driving",
        "the bridging leg is priced in the plan's own mode"
      );
      assert.strictEqual(bridging!.marginMinutes, 10, "and carries the driving margin");
    },
  ],
  [
    "the same removal on a TRANSIT plan bridges with a TRANSIT leg",
    async () => {
      const it = mkItinerary("transit");
      const res = await removeStop(it, 1, new Date(T(18, 0)), {
        isUsableAt: () => true,
        getWeather: async () => null,
      });
      assert.ok(res.removed);
      assert.strictEqual(it.stops[0].travelToNext?.mode, "transit");
    },
  ],
  [
    "a DRIVING plan's reroute replans its tail with DRIVING legs",
    async () => {
      const it = mkItinerary("driving");
      const res = await rerouteItinerary(
        it,
        { type: "transit_cancelled", legIndex: 0 },
        new Date(T(18, 0)),
        rerouteDepsWithoutLegs()
      );
      assert.ok(res.rerouted, "the reroute itself succeeded");
      const fresh = recomputedLegs(it);
      assert.ok(fresh.length > 0, "the reroute re-priced at least one leg");
      // NOTE: the disruption type is transit_cancelled, which has no driving
      // meaning — a driving plan has no reachable disruption trigger in
      // Stage 1. What is under test here is only that the REPLANNED legs
      // travel the way the plan does.
      for (const l of fresh) {
        assert.notStrictEqual(
          l.mode,
          "transit",
          "a driving plan's reroute must not hand back transit legs"
        );
      }
    },
  ],
  [
    "the same reroute on a TRANSIT plan is unchanged",
    async () => {
      const it = mkItinerary("transit");
      const res = await rerouteItinerary(
        it,
        { type: "transit_cancelled", legIndex: 0 },
        new Date(T(18, 0)),
        rerouteDepsWithoutLegs()
      );
      assert.ok(res.rerouted);
      const fresh = recomputedLegs(it);
      assert.ok(fresh.length > 0);
      for (const l of fresh) {
        assert.ok(
          l.mode === "transit" || l.mode === "walk",
          `transit plans keep their transit/walk legs, saw ${l.mode}`
        );
      }
    },
  ],
];

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
})();
