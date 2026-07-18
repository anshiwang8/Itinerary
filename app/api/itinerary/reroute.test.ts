// Reroute engine tests — the floor_time guarantee must be airtight.
// Pipeline deps are injected fakes; no network involved.
// Run with: npx tsx app/api/itinerary/reroute.test.ts
import assert from "node:assert";
import { createItinerary, withStatuses } from "./store";
import { rerouteItinerary, RerouteDeps } from "./reroute";
import { Place } from "../places/search/filter";
import { ScheduledStop } from "../schedule/schedule";
import { TravelLeg } from "../schedule/travel";

// ── fixtures: the familiar 3-stop Friday evening chain ──
// dinner 19:00–20:45 → bar 21:00–22:10 → dessert 22:20–23:00
const T = (h: number, m: number) =>
  `2026-07-03T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`;

function leg(fromIndex: number, mode: "transit" | "walk", total: number): TravelLeg {
  return {
    fromIndex,
    mode,
    rawMinutes: mode === "transit" ? total - 5 : total,
    marginMinutes: mode === "transit" ? 5 : 0,
    totalMinutes: total,
    distanceMeters: 1000,
    encodedPolyline: "enc_old",
  };
}

function mkStops(): ScheduledStop[] {
  return [
    {
      category: "dinner", id: "d1", name: "Dinner Spot",
      start_time: T(19, 0), end_time: T(20, 45),
      durationMinutes: { base: 90, buffer: 15, total: 105 },
      location: { latitude: 43.647, longitude: -79.42 },
      travelMinutesToNext: 15, travelToNext: leg(0, "transit", 15),
    },
    {
      category: "bar", id: "b1", name: "Bar Spot",
      start_time: T(21, 0), end_time: T(22, 10),
      durationMinutes: { base: 60, buffer: 10, total: 70 },
      location: { latitude: 43.649, longitude: -79.41 },
      travelMinutesToNext: 10, travelToNext: leg(1, "walk", 10),
    },
    {
      category: "dessert", id: "s1", name: "Dessert Spot",
      start_time: T(22, 20), end_time: T(23, 0),
      durationMinutes: { base: 30, buffer: 10, total: 40 },
      location: { latitude: 43.65, longitude: -79.405 },
    },
  ];
}

function mkItinerary(homeLeg?: TravelLeg) {
  return createItinerary(
    mkStops(),
    [leg(0, "transit", 15), leg(1, "walk", 10)],
    {
      time_window: "evening", stop_count: null, aesthetic: "lively",
      category_signals: ["dinner", "bar", "dessert"], group_context: "date",
      budget: null, constraints: [], location: "Ossington",
    },
    homeLeg
  );
}

// ── fake pipeline deps ──
function mkVenue(id: string, lat = 43.651): Place {
  return {
    id,
    displayName: { text: `New ${id}` },
    rating: 4.5,
    businessStatus: "OPERATIONAL",
    location: { latitude: lat, longitude: -79.415 },
  };
}

interface LegCall { fromIndex: number; excludeTransit: boolean }

function mkDeps(legCalls: LegCall[]): RerouteDeps {
  return {
    // calm by default — weather-gate behaviour has its own case
    getWeather: async () => null,
    searchPools: async (_parsed, categories) =>
      Object.fromEntries(
        categories.map((c, i) => [c, [mkVenue(`${c}_new`, 43.651 + i * 0.002)]])
      ),
    selectVenues: async (_parsed, pools) =>
      Object.entries(pools).map(([category, arr]) =>
        arr.length
          ? {
              category, id: arr[0].id, reason: `A fresh pick that fits the replanned ${category}.`,
              name: arr[0].displayName?.text, rating: arr[0].rating,
            }
          : { category, id: null, reason: "no venues survived filtering" }
      ),
    getSingleLeg: async (_o, _d, fromIndex, _dep, excludeTransit) => {
      legCalls.push({ fromIndex, excludeTransit });
      return {
        fromIndex,
        mode: excludeTransit ? "walk" : "transit",
        rawMinutes: 10,
        marginMinutes: excludeTransit ? 0 : 5,
        totalMinutes: excludeTransit ? 10 : 15,
        distanceMeters: 900,
        encodedPolyline: "enc_new",
      };
    },
  };
}

// the core guarantee, asserted on every rerouted case
function assertFloorGuarantee(
  before: Array<{ start: string | null; end: string | null; name?: string }>,
  itinerary: ReturnType<typeof mkItinerary>,
  floorISO: string
) {
  const floor = new Date(floorISO).getTime();
  itinerary.stops.forEach((s, i) => {
    if (!before[i].start) return;
    if (new Date(before[i].start!).getTime() <= floor) {
      assert.strictEqual(s.start_time, before[i].start, `stop ${i} start moved despite being at/before floor`);
      assert.strictEqual(s.end_time, before[i].end, `stop ${i} end moved despite being at/before floor`);
      assert.strictEqual(s.name, before[i].name, `stop ${i} venue changed despite being at/before floor`);
    }
  });
}

const snapAll = (it: ReturnType<typeof mkItinerary>) =>
  it.stops.map((s) => ({ start: s.start_time, end: s.end_time, name: s.name }));

const cases: Array<[string, () => Promise<void>]> = [
  [
    "floor_time = active stop's end, never earlier, when disruption fires mid-stop",
    async () => {
      const it = mkItinerary();
      const legCalls: LegCall[] = [];
      const now = new Date(T(19, 30)); // mid-dinner
      const before = snapAll(it);
      const res = await rerouteItinerary(it, { type: "transit_cancelled", legIndex: 0 }, now, mkDeps(legCalls));
      assert.ok(res.rerouted);
      if (!res.rerouted) return;
      // floor is dinner's END (20:45), not now (19:30)
      assert.strictEqual(new Date(res.floor_time).getTime(), new Date(T(20, 45)).getTime());
      assertFloorGuarantee(before, it, res.floor_time);
      // dinner untouched, listed unchanged
      assert.deepStrictEqual(res.unchanged, [0]);
      assert.strictEqual(it.stops[0].name, "Dinner Spot");
      assert.strictEqual(it.stops[0].start_time, T(19, 0));
      // replanned stops start strictly after the floor
      for (const c of res.changed) {
        const after = it.stops[c.stopIndex];
        assert.ok(new Date(after.start_time!).getTime() > new Date(res.floor_time).getTime() - 1);
      }
    },
  ],
  [
    "locked stop after the disruption time is still never touched",
    async () => {
      const it = mkItinerary();
      // simulate the ratchet having fired for the bar (e.g. dev time
      // visited 21:30 then rewound)
      withStatuses(it, new Date(T(21, 30)));
      assert.strictEqual(it.stops[1].locked, true);
      const legCalls: LegCall[] = [];
      const now = new Date(T(19, 30)); // rewound to mid-dinner
      const before = snapAll(it);
      const res = await rerouteItinerary(it, { type: "transit_cancelled", legIndex: 1 }, now, mkDeps(legCalls));
      assert.ok(res.rerouted);
      if (!res.rerouted) return;
      // bar (index 1) starts after floor but is locked → untouched
      assert.strictEqual(it.stops[1].name, "Bar Spot");
      assert.strictEqual(it.stops[1].start_time, T(21, 0));
      assert.ok(res.unchanged.includes(1));
      // only dessert replanned
      assert.deepStrictEqual(res.changed.map((c) => c.stopIndex), [2]);
      assertFloorGuarantee(before, it, res.floor_time);
    },
  ],
  [
    "empty affected → rerouted: false with a clean reason",
    async () => {
      const it = mkItinerary();
      const legCalls: LegCall[] = [];
      const now = new Date(T(22, 30)); // mid-dessert, nothing after
      const res = await rerouteItinerary(it, { type: "transit_cancelled", legIndex: 1 }, now, mkDeps(legCalls));
      assert.deepStrictEqual(res, {
        rerouted: false,
        reason: "nothing after the current stop to replan",
      });
      assert.strictEqual(legCalls.length, 0); // pipeline never invoked
    },
  ],
  [
    "3-stop, active in stop 1, leg 1→2 cancelled: stop 1 kept, stops 2–3 replanned from its end",
    async () => {
      const it = mkItinerary();
      const legCalls: LegCall[] = [];
      const now = new Date(T(20, 0)); // mid-dinner
      const res = await rerouteItinerary(it, { type: "transit_cancelled", legIndex: 0 }, now, mkDeps(legCalls));
      assert.ok(res.rerouted);
      if (!res.rerouted) return;
      assert.strictEqual(res.floor_time, new Date(T(20, 45)).toISOString());
      assert.deepStrictEqual(res.changed.map((c) => c.stopIndex), [1, 2]);
      // new bar venue + times: floor 20:45 + 10 min walk (excluded
      // transit) → starts 20:55
      const newBar = it.stops[1];
      assert.strictEqual(newBar.name, "New bar_new");
      assert.strictEqual(new Date(newBar.start_time!).getTime(), new Date(T(20, 55)).getTime());
      assert.strictEqual(newBar.status, "upcoming");
      assert.strictEqual(newBar.locked, false);
      // dessert follows: 20:55 + 70min = 22:05 + 15 transit = 22:20
      const newDessert = it.stops[2];
      assert.strictEqual(newDessert.name, "New dessert_new");
      assert.strictEqual(new Date(newDessert.start_time!).getTime(), new Date(T(22, 20)).getTime());
      // diff shape: before snapshots preserved
      assert.deepStrictEqual(res.changed[0].before, { name: "Bar Spot", start: T(21, 0), end: T(22, 10) });
      assert.match(res.changed[0].reason, /replanned bar/);
    },
  ],
  [
    "cancelled transit mode does not reappear on the broken leg",
    async () => {
      const it = mkItinerary();
      const legCalls: LegCall[] = [];
      const now = new Date(T(19, 30));
      // leg 0 (dinner→bar) is the cancelled transit leg
      const res = await rerouteItinerary(it, { type: "transit_cancelled", legIndex: 0 }, now, mkDeps(legCalls));
      assert.ok(res.rerouted);
      // inbound leg (pair 0) was fetched with transit excluded
      const inboundCall = legCalls.find((c) => c.fromIndex === 0);
      assert.ok(inboundCall, "inbound leg fetched");
      assert.strictEqual(inboundCall!.excludeTransit, true);
      // and the stored boundary leg is not transit
      assert.strictEqual(it.stops[0].travelToNext?.mode, "walk");
      // the untouched-pair fetch (bar→dessert, relative 0 in inter legs)
      // did NOT exclude transit
      const interCall = legCalls.filter((c) => c !== inboundCall);
      assert.ok(interCall.every((c) => c.excludeTransit === false));
    },
  ],
  [
    "cancelled leg deeper in the chain: upstream stops kept, only the dead pair excludes transit",
    async () => {
      const it = mkItinerary();
      const legCalls: LegCall[] = [];
      const now = new Date(T(19, 30));
      // leg 1 (bar→dessert) cancelled — the bar itself is UPSTREAM of the
      // break and reachable exactly as planned, so it is kept, not replanned
      const res = await rerouteItinerary(it, { type: "transit_cancelled", legIndex: 1 }, now, mkDeps(legCalls));
      assert.ok(res.rerouted);
      if (!res.rerouted) return;
      assert.strictEqual(it.stops[1].name, "Bar Spot");
      assert.strictEqual(it.stops[1].start_time, T(21, 0));
      assert.deepStrictEqual(res.changed.map((c) => c.stopIndex), [2]);
      // one fetched leg: bar → new dessert, transit excluded (the dead pair)
      assert.strictEqual(legCalls.length, 1);
      assert.strictEqual(legCalls[0].excludeTransit, true);
      assert.strictEqual(it.stops[1].travelToNext?.mode, "walk");
      // dessert replans from the bar's COMMITTED end: 22:10 + 10 walk
      assert.strictEqual(new Date(it.stops[2].start_time!).getTime(), new Date(T(22, 20)).getTime());
    },
  ],
  [
    "UNSTARTED itinerary: cancelled mid leg keeps committed times, only downstream reflows",
    async () => {
      const it = mkItinerary();
      const legCalls: LegCall[] = [];
      // planned for 19:00, disruption fires at 13:03 — nothing started,
      // no active stop, no locked floor
      const now = new Date(T(13, 3));
      const res = await rerouteItinerary(it, { type: "transit_cancelled", legIndex: 0 }, now, mkDeps(legCalls));
      assert.ok(res.rerouted);
      if (!res.rerouted) return;
      // dinner is UPSTREAM of the broken leg — its committed 19:00 holds;
      // the schedule must never re-anchor to the current clock
      assert.strictEqual(it.stops[0].start_time, T(19, 0), "dinner re-anchored off its committed start");
      assert.strictEqual(it.stops[0].end_time, T(20, 45));
      assert.strictEqual(it.stops[0].name, "Dinner Spot");
      assert.ok(res.unchanged.includes(0));
      // downstream replans anchor at dinner's COMMITTED end (20:45) + the
      // 10-min no-transit inbound → bar 20:55, dessert 22:20
      assert.strictEqual(new Date(res.anchor_time).getTime(), new Date(T(20, 45)).getTime());
      assert.deepStrictEqual(res.changed.map((c) => c.stopIndex), [1, 2]);
      assert.strictEqual(new Date(it.stops[1].start_time!).getTime(), new Date(T(20, 55)).getTime());
      assert.strictEqual(new Date(it.stops[2].start_time!).getTime(), new Date(T(22, 20)).getTime());
    },
  ],
  [
    "home leg (leg 0) is fixed history: reroute after departure never touches it",
    async () => {
      const homeLeg: TravelLeg = {
        fromIndex: -1,
        mode: "transit",
        rawMinutes: 27,
        marginMinutes: 5,
        totalMinutes: 32,
        distanceMeters: 5200,
        encodedPolyline: "enc_home",
        transit: {
          lineName: "501 Queen", headsign: "West", stopCount: 9,
          departStop: "Queen St West at University Ave",
          arriveStop: "Queen St West at Ossington Ave",
        },
      };
      const it = mkItinerary(homeLeg);
      const homeBefore = JSON.parse(JSON.stringify(it.homeLeg));
      const legCalls: LegCall[] = [];
      const now = new Date(T(19, 30)); // mid-dinner — left home long ago
      const before = snapAll(it);
      const res = await rerouteItinerary(
        it, { type: "transit_cancelled", legIndex: 0 }, now, mkDeps(legCalls)
      );
      assert.ok(res.rerouted);
      if (!res.rerouted) return;
      // the home leg is byte-identical after the replan
      assert.deepStrictEqual(it.homeLeg, homeBefore);
      // rebuilt legs array holds only real stop pairs — home never enters it
      assert.ok(it.legs.every((l) => l.fromIndex >= 0));
      // and the stop home feeds into (dinner) is untouched, per the floor
      assert.strictEqual(it.stops[0].start_time, T(19, 0));
      assert.strictEqual(it.stops[0].name, "Dinner Spot");
      assertFloorGuarantee(before, it, res.floor_time);
    },
  ],
  [
    "DUPLICATE CATEGORY (§7.1): two affected bar stops get two DIFFERENT venues",
    async () => {
      // an evening with TWO bars — "a drink, then another drink somewhere
      // else". Pre-fix, indexing the selections by CATEGORY made both
      // affected stops resolve to the same Selection object, so the reroute
      // planned the same venue twice in one night.
      const stops: ScheduledStop[] = [
        {
          category: "dinner", id: "d1", name: "Dinner Spot",
          start_time: T(19, 0), end_time: T(20, 45),
          durationMinutes: { base: 90, buffer: 15, total: 105 },
          location: { latitude: 43.647, longitude: -79.42 },
          travelMinutesToNext: 15, travelToNext: leg(0, "transit", 15),
        },
        {
          category: "bar", id: "b1", name: "First Bar",
          start_time: T(21, 0), end_time: T(22, 10),
          durationMinutes: { base: 60, buffer: 10, total: 70 },
          location: { latitude: 43.649, longitude: -79.41 },
          travelMinutesToNext: 10, travelToNext: leg(1, "walk", 10),
        },
        {
          category: "bar", id: "b2", name: "Second Bar",
          start_time: T(22, 20), end_time: T(23, 30),
          durationMinutes: { base: 60, buffer: 10, total: 70 },
          location: { latitude: 43.65, longitude: -79.405 },
        },
      ];
      const it = createItinerary(stops, [leg(0, "transit", 15), leg(1, "walk", 10)], {
        time_window: "evening", stop_count: null, aesthetic: "lively",
        category_signals: ["dinner", "bar", "bar"], group_context: "date",
        budget: null, constraints: [], location: "Ossington",
      });
      const now = new Date(T(18, 0)); // nothing started
      // two distinct candidates in the shared bar pool
      const deps: RerouteDeps = {
        getWeather: async () => null,
        searchPools: async () => ({ bar: [mkVenue("bar_A", 43.6515), mkVenue("bar_B", 43.6525)] }),
        selectVenues: async (_parsed, pools, slots) => {
          // mirrors the real slot contract: one entry per requested slot,
          // never repeating a venue
          const list = (slots ?? Object.keys(pools)) as string[];
          const taken = new Set<string>();
          return list.map((category, slot) => {
            const pick = (pools[category] ?? []).find((p) => !taken.has(p.id));
            if (pick) taken.add(pick.id);
            return pick
              ? { category, slot, id: pick.id, reason: `Fresh ${category}.`, name: pick.displayName?.text }
              : { category, slot, id: null, narrowed: true, reason: "only found one bar nearby" };
          });
        },
        getSingleLeg: async (_o, _d, fromIndex, _dep, excludeTransit) => ({
          fromIndex, mode: excludeTransit ? "walk" : "transit",
          rawMinutes: 10, marginMinutes: excludeTransit ? 0 : 5,
          totalMinutes: excludeTransit ? 10 : 15,
          distanceMeters: 900, encodedPolyline: "enc_new",
        }),
      };
      // break leg 0 (dinner → first bar): BOTH bars are downstream
      const res = await rerouteItinerary(it, { type: "transit_cancelled", legIndex: 0 }, now, deps);
      assert.ok(res.rerouted, "both bars are downstream of the broken leg");
      if (!res.rerouted) return;
      assert.strictEqual(res.changed.length, 2, "both bar stops replanned");
      const ids = [it.stops[1].id, it.stops[2].id];
      assert.strictEqual(new Set(ids).size, 2, `the two bars must be different venues, got ${JSON.stringify(ids)}`);
      assert.deepStrictEqual(ids, ["bar_A", "bar_B"]);
      // dinner untouched
      assert.strictEqual(it.stops[0].id, "d1");
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
