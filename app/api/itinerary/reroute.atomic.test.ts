import assert from "node:assert";
import { CurrentOpeningHours } from "../places/search/hours";
import { Place, WeatherHour } from "../places/search/filter";
import { ScheduledStop } from "../schedule/schedule";
import { LatLng, TravelLeg } from "../schedule/travel";
import { createItinerary } from "./store";
import { rerouteItinerary, RerouteDeps } from "./reroute";

const T = (hour: number, minute: number) =>
  `2026-07-03T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-04:00`;

function leg(fromIndex: number, totalMinutes = 10): TravelLeg {
  return {
    fromIndex,
    mode: "walk",
    rawMinutes: totalMinutes,
    marginMinutes: 0,
    totalMinutes,
    distanceMeters: 800,
    encodedPolyline: `leg-${fromIndex}`,
  };
}

function baseStops(): ScheduledStop[] {
  return [
    {
      category: "dinner",
      id: "d1",
      name: "Kept Dinner",
      start_time: T(19, 0),
      end_time: T(20, 0),
      durationMinutes: { base: 50, buffer: 10, total: 60 },
      location: { latitude: 43.640, longitude: -79.430 },
      travelMinutesToNext: 10,
      travelToNext: leg(0),
    },
    {
      category: "bar",
      id: "b1",
      name: "Old Bar",
      start_time: T(20, 10),
      end_time: T(21, 20),
      durationMinutes: { base: 60, buffer: 10, total: 70 },
      location: { latitude: 43.641, longitude: -79.429 },
      travelMinutesToNext: 10,
      travelToNext: leg(1),
    },
    {
      category: "dessert",
      id: "s1",
      name: "Old Dessert",
      start_time: T(21, 30),
      end_time: T(22, 10),
      durationMinutes: { base: 30, buffer: 10, total: 40 },
      location: { latitude: 43.642, longitude: -79.428 },
      travelMinutesToNext: 10,
      travelToNext: leg(2),
    },
    {
      category: "park",
      id: "p1",
      name: "Old Park",
      start_time: T(22, 20),
      end_time: T(23, 5),
      durationMinutes: { base: 40, buffer: 5, total: 45 },
      location: { latitude: 43.643, longitude: -79.427 },
    },
  ];
}

function itinerary() {
  return createItinerary(
    baseStops(),
    [leg(0), leg(1), leg(2)],
    {
      time_window: "evening",
      stop_count: null,
      aesthetic: "calm",
      category_signals: ["dinner", "bar", "dessert", "park"],
      group_context: "solo",
      budget: null,
      constraints: [],
      location: "Ossington",
      home: { latitude: 43.65, longitude: -79.40 },
    }
  );
}

function fridayHours(
  openHour: number,
  openMinute: number,
  closeHour: number,
  closeMinute: number
): CurrentOpeningHours {
  return {
    periods: [
      {
        open: { day: 5, hour: openHour, minute: openMinute },
        close: { day: 5, hour: closeHour, minute: closeMinute },
      },
    ],
  };
}

function venue(
  id: string,
  latitude: number,
  hours?: CurrentOpeningHours,
  withLocation = true
): Place {
  return {
    id,
    displayName: { text: id },
    rating: 4.6,
    businessStatus: "OPERATIONAL",
    ...(withLocation
      ? { location: { latitude, longitude: -79.40 - latitude / 10_000 } }
      : {}),
    ...(hours ? { currentOpeningHours: hours } : {}),
  };
}

interface RouteCall {
  origin: LatLng;
  destination: LatLng;
  fromIndex: number;
  departureTime: string | undefined;
  excludeTransit: boolean;
}

function defaultPools(): Record<string, Place[]> {
  return {
    bar: [venue("bar-new", 43.651)],
    dessert: [venue("dessert-new", 43.652)],
    park: [venue("park-new", 43.653)],
  };
}

function depsFor(options: {
  pools?: Record<string, Place[]>;
  weather?: WeatherHour[] | null;
  routeMinutes?: (origin: LatLng, destination: LatLng, fromIndex: number) => number;
  select?: RerouteDeps["selectVenues"];
  search?: RerouteDeps["searchPools"];
}) {
  const routeCalls: RouteCall[] = [];
  let searchCalls = 0;
  let weatherCalls = 0;
  let selectCalls = 0;
  const pools = options.pools ?? defaultPools();
  const deps: RerouteDeps = {
    searchPools: async (parsed, categories) => {
      searchCalls++;
      if (options.search) return options.search(parsed, categories);
      return pools;
    },
    selectVenues: async (parsed, available, slots) => {
      selectCalls++;
      if (options.select) return options.select(parsed, available, slots);
      const used = new Set<string>();
      return (slots ?? Object.keys(available)).map((category, slot) => {
        const pick = (available[category] ?? []).find((candidate) => !used.has(candidate.id));
        if (pick) used.add(pick.id);
        return pick
          ? {
              category,
              slot,
              id: pick.id,
              reason: `Selected ${pick.id}.`,
            }
          : { category, slot, id: null, reason: "missing" };
      });
    },
    getSingleLeg: async (
      origin,
      destination,
      fromIndex,
      departureTime,
      excludeTransit
    ) => {
      routeCalls.push({
        origin,
        destination,
        fromIndex,
        departureTime,
        excludeTransit,
      });
      const total = options.routeMinutes?.(origin, destination, fromIndex) ?? 10;
      return leg(fromIndex, total);
    },
    getWeather: async () => {
      weatherCalls++;
      return options.weather ?? null;
    },
  };
  return {
    deps,
    routeCalls,
    counts: {
      get search() {
        return searchCalls;
      },
      get weather() {
        return weatherCalls;
      },
      get select() {
        return selectCalls;
      },
    },
  };
}

const now = new Date(T(18, 0));
const disruption = { type: "transit_cancelled" as const, legIndex: 0 };

const cases: Array<[string, () => Promise<void>]> = [
  [
    "empty selection aborts instead of deleting every required stop",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const harness = depsFor({ select: async () => [] });
      const result = await rerouteItinerary(plan, disruption, now, harness.deps);
      assert.strictEqual(result.rerouted, false);
      assert.strictEqual(JSON.stringify(plan), before);
      assert.strictEqual(harness.routeCalls.length, 0);
    },
  ],
  [
    "missing selection for one slot aborts the complete chain",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const harness = depsFor({
        select: async (_parsed, pools, slots) =>
          (slots ?? []).slice(0, 2).map((category, slot) => ({
            category,
            slot,
            id: pools[category][0].id,
            reason: "partial",
          })),
      });
      const result = await rerouteItinerary(plan, disruption, now, harness.deps);
      assert.strictEqual(result.rerouted, false);
      assert.strictEqual(JSON.stringify(plan), before);
    },
  ],
  [
    "missing middle coordinates aborts without compacting A→C",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const pools = defaultPools();
      pools.dessert = [venue("dessert-no-location", 43.652, undefined, false)];
      const harness = depsFor({ pools });
      const result = await rerouteItinerary(plan, disruption, now, harness.deps);
      assert.strictEqual(result.rerouted, false);
      assert.strictEqual(JSON.stringify(plan), before);
      assert.strictEqual(harness.routeCalls.length, 0);
    },
  ],
  [
    "A→B→C routing keeps every origin/destination pair aligned",
    async () => {
      const plan = itinerary();
      const harness = depsFor({});
      const result = await rerouteItinerary(plan, disruption, now, harness.deps);
      assert.ok(result.rerouted);
      assert.strictEqual(harness.routeCalls.length, 3);
      assert.deepStrictEqual(
        harness.routeCalls.map((call) => [
          call.origin.latitude,
          call.destination.latitude,
          call.fromIndex,
        ]),
        [
          [43.640, 43.651, 0],
          [43.651, 43.652, 1],
          [43.652, 43.653, 2],
        ]
      );
      assert.deepStrictEqual(plan.legs.map((item) => item.fromIndex), [0, 1, 2]);
    },
  ],
  [
    "each route departure accumulates prior travel, arrival, and dwell",
    async () => {
      const plan = itinerary();
      const harness = depsFor({});
      const result = await rerouteItinerary(plan, disruption, now, harness.deps);
      assert.ok(result.rerouted);
      assert.deepStrictEqual(
        harness.routeCalls.map((call) => new Date(call.departureTime!).getTime()),
        [new Date(T(20, 0)).getTime(), new Date(T(21, 20)).getTime(), new Date(T(22, 10)).getTime()]
      );
      assert.deepStrictEqual(
        plan.stops.slice(1).map((stop) => new Date(stop.start_time!).getTime()),
        [new Date(T(20, 10)).getTime(), new Date(T(21, 30)).getTime(), new Date(T(22, 20)).getTime()]
      );
    },
  ],
  [
    "later-opening venue is accepted at its real arrival, not rejected at anchor",
    async () => {
      const plan = itinerary();
      const pools = defaultPools();
      pools.bar = [venue("opens-after-anchor", 43.651, fridayHours(20, 5, 23, 59))];
      const harness = depsFor({ pools });
      const result = await rerouteItinerary(plan, disruption, now, harness.deps);
      assert.ok(result.rerouted);
      assert.strictEqual(plan.stops[1].id, "opens-after-anchor");
      assert.strictEqual(plan.stops[1].start_time, T(20, 10));
    },
  ],
  [
    "venue closing before recalculated arrival is replaced and rerouted",
    async () => {
      const plan = itinerary();
      const pools = defaultPools();
      pools.dessert = [
        venue("closes-too-soon", 43.652, fridayHours(18, 0, 21, 25)),
        venue("dessert-open", 43.654, fridayHours(18, 0, 23, 59)),
      ];
      const harness = depsFor({ pools });
      const result = await rerouteItinerary(plan, disruption, now, harness.deps);
      assert.ok(result.rerouted);
      assert.strictEqual(plan.stops[2].id, "dessert-open");
      assert.strictEqual(harness.counts.select, 2);
      assert.strictEqual(harness.counts.search, 1);
      assert.strictEqual(harness.counts.weather, 1);
    },
  ],
  [
    "weather is evaluated per slot arrival and can block only the later slot",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const weather: WeatherHour[] = [
        {
          hourISO: "2026-07-04T00:00:00.000Z",
          tempC: 20,
          precipProbability: 0,
          condition: "clear",
        },
        {
          hourISO: "2026-07-04T01:00:00.000Z",
          tempC: 20,
          precipProbability: 0,
          condition: "clear",
        },
        {
          hourISO: "2026-07-04T02:00:00.000Z",
          tempC: 20,
          precipProbability: 90,
          condition: "rain",
        },
      ];
      const harness = depsFor({ weather });
      const result = await rerouteItinerary(plan, disruption, now, harness.deps);
      assert.strictEqual(result.rerouted, false);
      assert.strictEqual(JSON.stringify(plan), before);
      assert.strictEqual(harness.counts.weather, 1);
    },
  ],
  [
    "longer replacement leg moving a stop past closing triggers replacement",
    async () => {
      const plan = itinerary();
      const pools = defaultPools();
      pools.dessert = [
        venue("dessert-early", 43.652, fridayHours(18, 0, 21, 50)),
        venue("dessert-late", 43.654, fridayHours(18, 0, 23, 59)),
      ];
      const harness = depsFor({
        pools,
        routeMinutes: (_origin, _destination, fromIndex) =>
          fromIndex === 1 ? 40 : 10,
      });
      const result = await rerouteItinerary(plan, disruption, now, harness.deps);
      assert.ok(result.rerouted);
      assert.strictEqual(plan.stops[2].id, "dessert-late");
      assert.strictEqual(plan.stops[2].start_time, T(22, 0));
      assert.strictEqual(harness.counts.select, 2);
    },
  ],
  [
    "bounded stabilization exhaustion aborts after five invalid passes",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const pools = defaultPools();
      pools.bar = Array.from({ length: 6 }, (_, index) =>
        venue(`closed-${index}`, 43.651 + index / 10_000, fridayHours(18, 0, 20, 5))
      );
      const harness = depsFor({ pools });
      const result = await rerouteItinerary(plan, disruption, now, harness.deps);
      assert.strictEqual(result.rerouted, false);
      assert.match(result.reason, /recalculated arrival times/);
      assert.strictEqual(harness.counts.select, 5);
      assert.strictEqual(harness.counts.search, 1);
      assert.strictEqual(harness.counts.weather, 1);
      assert.strictEqual(JSON.stringify(plan), before);
    },
  ],
  [
    "category/provider failure propagates while the original stays byte-identical",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const harness = depsFor({
        search: async () => {
          throw new Error("provider unavailable");
        },
      });
      await assert.rejects(
        () => rerouteItinerary(plan, disruption, now, harness.deps),
        /provider unavailable/
      );
      assert.strictEqual(JSON.stringify(plan), before);
    },
  ],
  [
    "failure after an invalid first pass still commits no partial mutation",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const pools = defaultPools();
      pools.bar = [
        venue("closed-first", 43.651, fridayHours(18, 0, 20, 5)),
        venue("open-second", 43.654, fridayHours(18, 0, 23, 59)),
      ];
      let calls = 0;
      const harness = depsFor({
        pools,
        select: async (_parsed, available, slots) => {
          calls++;
          if (calls === 2) return [];
          return (slots ?? []).map((category, slot) => ({
            category,
            slot,
            id: available[category][0].id,
            reason: "first pass",
          }));
        },
      });
      const result = await rerouteItinerary(plan, disruption, now, harness.deps);
      assert.strictEqual(result.rerouted, false);
      assert.strictEqual(JSON.stringify(plan), before);
    },
  ],
];

(async () => {
  let failed = 0;
  for (const [name, run] of cases) {
    try {
      await run();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error instanceof Error ? error.stack ?? error.message : error}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
})();
