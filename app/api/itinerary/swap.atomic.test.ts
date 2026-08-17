import assert from "node:assert";
import { CurrentOpeningHours } from "../places/search/hours";
import { Place, WeatherHour } from "../places/search/filter";
import { ScheduledStop } from "../schedule/schedule";
import { LatLng, TravelLeg } from "../schedule/travel";
import {
  mockLeg,
  mockPools,
  mockSwapDeps,
} from "../_mock/fixtures";
import { createItinerary } from "./store";
import {
  DurationShift,
  SwapDeps,
  SwapInterpretation,
  TimeShift,
  parseDurationExpr,
  parseTimeExpr,
  swapStop,
  usableByHours,
} from "./swap";

const T = (hour: number, minute: number) =>
  `2026-07-03T${String(hour).padStart(2, "0")}:${String(minute).padStart(
    2,
    "0"
  )}:00-04:00`;

function leg(fromIndex: number, totalMinutes = 10): TravelLeg {
  return {
    fromIndex,
    mode: "walk",
    rawMinutes: totalMinutes,
    marginMinutes: 0,
    totalMinutes,
    distanceMeters: 800,
    encodedPolyline: `leg-${fromIndex}-${totalMinutes}`,
  };
}

function transitMetadataLeg(
  fromIndex: number,
  legId: string,
  rideId: string,
  paletteSlot: number | null,
  totalMinutes = 10
): TravelLeg {
  const ride = {
    rideId,
    sourceStepIndex: 0,
    paletteSlot,
    lineName: "Test Line",
    shortName: "T",
    color: null,
    textColor: null,
    vehicle: "BUS",
    headsign: "Test Terminal",
    stopCount: 3,
    departStop: "Origin",
    arriveStop: "Destination",
  };
  return {
    ...leg(fromIndex, totalMinutes),
    legId,
    mode: "transit",
    rawMinutes: totalMinutes - 5,
    marginMinutes: 5,
    transit: { ...ride },
    transitSegments: [{ ...ride }],
    pathSegments: [
      {
        mode: "transit",
        encodedPolyline: `path-${rideId}`,
        color: null,
        rideId,
        sourceStepIndex: 0,
        paletteSlot,
      },
    ],
  };
}

function assertRideSlot(route: TravelLeg, rideId: string, paletteSlot: number) {
  assert.strictEqual(route.transit?.rideId, rideId);
  assert.strictEqual(route.transit?.sourceStepIndex, 0);
  assert.strictEqual(route.transit?.paletteSlot, paletteSlot);
  assert.strictEqual(route.transitSegments?.[0]?.rideId, rideId);
  assert.strictEqual(route.transitSegments?.[0]?.sourceStepIndex, 0);
  assert.strictEqual(route.transitSegments?.[0]?.paletteSlot, paletteSlot);
  const path = route.pathSegments?.find((segment) => segment.mode === "transit");
  assert.strictEqual(path?.rideId, rideId);
  assert.strictEqual(path?.sourceStepIndex, 0);
  assert.strictEqual(path?.paletteSlot, paletteSlot);
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
  latitude = 43.65,
  hours?: CurrentOpeningHours
): Place {
  return {
    id,
    displayName: { text: id },
    rating: 4.6,
    businessStatus: "OPERATIONAL",
    location: { latitude, longitude: -79.4 },
    ...(hours ? { currentOpeningHours: hours } : {}),
  };
}

function baseStops(): ScheduledStop[] {
  return [
    {
      category: "dinner",
      id: "d1",
      name: "Dinner",
      start_time: T(19, 0),
      end_time: T(20, 0),
      durationMinutes: { base: 50, buffer: 10, total: 60 },
      location: { latitude: 43.64, longitude: -79.43 },
      travelMinutesToNext: 10,
      travelToNext: leg(0),
    },
    {
      category: "bar",
      id: "b1",
      name: "Bar",
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
      name: "Dessert",
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
      name: "Park",
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
    },
    null,
    {
      label: "Start",
      location: { latitude: 43.65, longitude: -79.4 },
    }
  );
}

interface HarnessOptions {
  intent?: SwapInterpretation["intent"];
  path?: SwapInterpretation["path"];
  category?: string;
  time?: TimeShift | null;
  duration?: DurationShift | null;
  pools?: Record<string, Place[]>;
  weather?: WeatherHour[] | null;
  unusableIds?: string[];
  routeMinutes?: (
    origin: LatLng,
    destination: LatLng,
    fromIndex: number
  ) => number;
  routeError?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const counts = { weather: 0, route: 0 };
  const deps: SwapDeps = {
    interpret: async (parsed, category) => ({
      intent: options.intent ?? "duration",
      path: options.path ?? "refilter",
      category: options.category ?? category,
      aesthetic: parsed.aesthetic,
      budget: parsed.budget,
      constraints: parsed.constraints,
      time: options.time ?? null,
      duration:
        options.duration ??
        (options.intent === "time"
          ? null
          : { mode: "relative", deltaMinutes: 10 }),
    }),
    searchPools: async (_parsed, categories) => {
      const category = categories[0];
      return {
        [category]:
          options.pools?.[category] ?? [venue(`${category}-fresh`)],
      };
    },
    selectVenues: async (_parsed, pools) =>
      Object.entries(pools).map(([category, candidates]) =>
        candidates.length
          ? {
              category,
              id: candidates[0].id,
              name: candidates[0].displayName?.text,
              rating: candidates[0].rating,
              reason: "Atomic replacement",
            }
          : { category, id: null, reason: "No candidate" }
      ),
    getSingleLeg: async (origin, destination, fromIndex) => {
      counts.route++;
      if (options.routeError) throw new Error("routes unavailable");
      return leg(
        fromIndex,
        options.routeMinutes?.(origin, destination, fromIndex) ?? 10
      );
    },
    isUsableAt: (place) =>
      !(options.unusableIds ?? []).includes(place.id),
    getWeather: async () => {
      counts.weather++;
      return options.weather ?? null;
    },
  };
  return { deps, counts };
}

const now = new Date(T(17, 0));
const rain: WeatherHour[] = Array.from({ length: 24 }, (_, index) => ({
  hourISO: new Date(
    new Date(T(12, 0)).getTime() + index * 3_600_000
  ).toISOString(),
  tempC: 15,
  precipProbability: 90,
  condition: "rain",
}));

const cases: Array<[string, () => Promise<void>]> = [
  [
    "the production mock seam completes a cheaper first-stop swap",
    async () => {
      const pools = mockPools(["dinner", "drinks"]);
      const dinner = pools.dinner.find(
        (place) => place.id === "fx_dinner_velvet"
      )!;
      const drinks = pools.drinks.find(
        (place) => place.id === "fx_bar_curfew"
      )!;
      const home = { latitude: 43.65348, longitude: -79.38393 };
      const stops: ScheduledStop[] = [
        {
          category: "dinner",
          id: dinner.id,
          name: dinner.displayName?.text,
          rating: dinner.rating,
          priceLevel: dinner.priceLevel,
          description: dinner.editorialSummary?.text,
          currentOpeningHours: dinner.currentOpeningHours,
          location: dinner.location,
          start_time: T(19, 16),
          end_time: T(21, 1),
          durationMinutes: { base: 90, buffer: 15, total: 105 },
          travelToNext: mockLeg(0, dinner.location!, drinks.location!),
          travelMinutesToNext: mockLeg(
            0,
            dinner.location!,
            drinks.location!
          ).totalMinutes,
        },
        {
          category: "drinks",
          id: drinks.id,
          name: drinks.displayName?.text,
          rating: drinks.rating,
          priceLevel: drinks.priceLevel,
          description: drinks.editorialSummary?.text,
          currentOpeningHours: drinks.currentOpeningHours,
          location: drinks.location,
          start_time: T(21, 4),
          end_time: T(22, 14),
          durationMinutes: { base: 60, buffer: 10, total: 70 },
        },
      ];
      const homeLeg = mockLeg(-1, home, dinner.location!);
      const plan = createItinerary(
        stops,
        [stops[0].travelToNext!],
        {
          time_window: "evening",
          stop_count: null,
          aesthetic: "calm",
          category_signals: ["dinner", "drinks"],
          group_context: "solo",
          budget: null,
          constraints: [],
          location: "",
          city: "Toronto",
        },
        homeLeg,
        { label: "Start · Toronto centre", location: home }
      );
      const result = await swapStop(
        plan,
        0,
        "cheaper",
        now,
        mockSwapDeps(
          parseTimeExpr,
          parseDurationExpr,
          usableByHours
        )
      );
      assert.ok(result.swapped);
      assert.strictEqual(plan.stops[0].name, "The Corner Table");
    },
  ],
  [
    // REWRITTEN with the push feature. This case used to assert that a
    // replacement the inbound leg cannot reach in time is REFUSED outright
    // ("cannot reach the fixed target slot") — the target's start was fixed,
    // so there was nowhere for the extra travel to go. The slot may now start
    // later, and the whole tail resettles behind it. The atomicity this file
    // is about is unchanged and is asserted below: one coherent commit, no
    // half-applied chain.
    "farther venue replacement pushes its own slot and cascades the whole tail",
    async () => {
      const plan = itinerary();
      const far = venue("far-bar", 44);
      const h = harness({
        intent: "venue",
        pools: { bar: [far] },
        routeMinutes: (_origin, destination) =>
          destination.latitude >= 44 ? 30 : 10,
      });
      const result = await swapStop(plan, 1, "somewhere else", now, h.deps);

      assert.strictEqual(result.swapped, true);
      if (!result.swapped) return;
      assert.strictEqual(plan.stops[1].id, "far-bar");
      // dinner ends 20:00, the leg out to far-bar is 30 minutes, so 20:30 is
      // the earliest it can be reached — twenty past the committed 20:10
      assert.strictEqual(new Date(plan.stops[1].start_time!).getTime(), new Date(T(20, 30)).getTime());
      assert.strictEqual(new Date(plan.stops[1].end_time!).getTime(), new Date(T(21, 40)).getTime());

      // THREE deep: the push cascades bar → dessert → park, each start
      // recomputed from its own real leg rather than shifted by a delta
      assert.deepStrictEqual(result.downstreamShifted, [2, 3]);
      assert.strictEqual(new Date(plan.stops[2].start_time!).getTime(), new Date(T(21, 50)).getTime());
      assert.strictEqual(new Date(plan.stops[2].end_time!).getTime(), new Date(T(22, 30)).getTime());
      assert.strictEqual(new Date(plan.stops[3].start_time!).getTime(), new Date(T(22, 40)).getTime());
      assert.strictEqual(new Date(plan.stops[3].end_time!).getTime(), new Date(T(23, 25)).getTime());

      // every kept stop keeps its own venue and its own length — a push moves
      // stops, it never shortens them to buy room
      assert.strictEqual(plan.stops[2].id, "s1");
      assert.strictEqual(plan.stops[3].id, "p1");
      assert.strictEqual(plan.stops[2].durationMinutes?.total, 40);
      assert.strictEqual(plan.stops[3].durationMinutes?.total, 45);

      // upstream of the change, nothing moved
      assert.strictEqual(plan.stops[0].start_time, T(19, 0));
      assert.strictEqual(plan.stops[0].end_time, T(20, 0));

      // the committed chain is internally consistent: no stop starts before
      // the previous one ends, which is what a half-applied push would break
      for (let i = 1; i < plan.stops.length; i++) {
        const prevEnd = new Date(plan.stops[i - 1].end_time!).getTime();
        const start = new Date(plan.stops[i].start_time!).getTime();
        assert.ok(start >= prevEnd, `stop ${i} starts before stop ${i - 1} ends`);
      }
    },
  ],
  [
    "a push whose tail is stranded leaves the plan byte-identical",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const far = venue("far-bar", 44);
      const h = harness({
        intent: "venue",
        pools: { bar: [far] },
        routeMinutes: (_origin, destination) =>
          destination.latitude >= 44 ? 30 : 10,
        // the pushed dessert arrival is unusable, and so is the only
        // replacement the re-search can offer
        unusableIds: ["s1", "dessert-fresh"],
      });
      const result = await swapStop(plan, 1, "somewhere else", now, h.deps);

      assert.strictEqual(result.swapped, false);
      if (result.swapped) return;
      // a stranded stop is a FACT, so it refuses rather than asking
      assert.strictEqual(result.confirm, undefined);
      assert.match(result.reason, /moving the later stops back/i);
      assert.strictEqual(
        JSON.stringify(plan),
        before,
        "a failed cascade must not leave a partially pushed chain behind"
      );
    },
  ],
  [
    "a time swap may move the target when the complete chain is valid",
    async () => {
      const plan = itinerary();
      const h = harness({
        intent: "time",
        time: { mode: "relative", deltaMinutes: 30 },
      });
      const result = await swapStop(plan, 1, "30 minutes later", now, h.deps);
      assert.ok(result.swapped);
      assert.strictEqual(plan.stops[1].start_time, T(20, 40));
      assert.ok(
        new Date(plan.stops[2].start_time!).getTime() >=
          new Date(plan.stops[1].end_time!).getTime() + 10 * 60_000
      );
    },
  ],
  [
    "successful swap retains untouched identities and assigns new rides the first unused slots",
    async () => {
      const plan = itinerary();
      plan.homeLeg = transitMetadataLeg(
        -1,
        "leg-swap-home-retained",
        "ride-swap-home-retained",
        0
      );
      const retainedUpstream = transitMetadataLeg(
        0,
        "leg-swap-upstream-retained",
        "ride-swap-upstream-retained",
        5
      );
      const oldInbound = transitMetadataLeg(
        1,
        "leg-swap-inbound-old",
        "ride-swap-inbound-old",
        1
      );
      const oldOutbound = transitMetadataLeg(
        2,
        "leg-swap-outbound-old",
        "ride-swap-outbound-old",
        2
      );
      plan.stops[0].travelToNext = retainedUpstream;
      plan.stops[0].travelMinutesToNext = retainedUpstream.totalMinutes;
      plan.stops[1].travelToNext = oldInbound;
      plan.stops[1].travelMinutesToNext = oldInbound.totalMinutes;
      plan.stops[2].travelToNext = oldOutbound;
      plan.stops[2].travelMinutesToNext = oldOutbound.totalMinutes;
      plan.legs = [retainedUpstream, oldInbound, oldOutbound];

      const homeBefore = JSON.stringify(plan.homeLeg);
      const upstreamBefore = JSON.stringify(plan.stops[0].travelToNext);
      const h = harness({
        intent: "duration",
        duration: { mode: "relative", deltaMinutes: 10 },
      });
      let nextRoute = 0;
      const deps: SwapDeps = {
        ...h.deps,
        getSingleLeg: async (_origin, _destination, fromIndex) => {
          const sequence = nextRoute++;
          return transitMetadataLeg(
            fromIndex,
            `leg-swap-fresh-${sequence}`,
            `ride-swap-fresh-${sequence}`,
            null
          );
        },
      };

      const result = await swapStop(
        plan,
        2,
        "stay ten minutes longer",
        now,
        deps
      );
      assert.ok(result.swapped);
      if (!result.swapped) return;

      assert.strictEqual(JSON.stringify(plan.homeLeg), homeBefore);
      assert.strictEqual(
        JSON.stringify(plan.stops[0].travelToNext),
        upstreamBefore
      );
      assertRideSlot(plan.homeLeg!, "ride-swap-home-retained", 0);
      assertRideSlot(
        plan.stops[0].travelToNext!,
        "ride-swap-upstream-retained",
        5
      );

      const newInbound = plan.stops[1].travelToNext!;
      const newOutbound = plan.stops[2].travelToNext!;
      assert.strictEqual(newInbound.legId, "leg-swap-fresh-0");
      assert.notStrictEqual(newInbound.legId, oldInbound.legId);
      assert.strictEqual(newOutbound.legId, "leg-swap-fresh-1");
      assert.notStrictEqual(newOutbound.legId, oldOutbound.legId);
      assert.notStrictEqual(newInbound.legId, newOutbound.legId);
      assertRideSlot(newInbound, "ride-swap-fresh-0", 1);
      assertRideSlot(newOutbound, "ride-swap-fresh-1", 2);

      const slots = [
        plan.homeLeg!.transit!.paletteSlot,
        ...plan.legs.map((route) => route.transit!.paletteSlot),
      ];
      assert.deepStrictEqual(slots, [0, 5, 1, 2]);
      assert.strictEqual(new Set(slots).size, slots.length);
    },
  ],
  [
    "a locked downstream collision refuses the whole proposal",
    async () => {
      const plan = itinerary();
      plan.stops[2].locked = true;
      const before = JSON.stringify(plan);
      const h = harness({
        intent: "duration",
        duration: { mode: "relative", deltaMinutes: 30 },
      });
      const result = await swapStop(plan, 1, "stay longer", now, h.deps);
      assert.strictEqual(result.swapped, false);
      if (!result.swapped) assert.match(result.reason, /locked stop/i);
      assert.strictEqual(JSON.stringify(plan), before);
    },
  ],
  [
    "a shifted stop that closes at its final arrival refuses atomically",
    async () => {
      const plan = itinerary();
      plan.stops[1].currentOpeningHours = fridayHours(18, 0, 20, 25);
      const before = JSON.stringify(plan);
      const h = harness({
        intent: "duration",
        duration: { mode: "relative", deltaMinutes: 20 },
        pools: { bar: [] },
      });
      const result = await swapStop(plan, 0, "stay longer", now, h.deps);
      assert.strictEqual(result.swapped, false);
      assert.strictEqual(JSON.stringify(plan), before);
    },
  ],
  [
    "a shifted outdoor stop is rechecked against the proposal weather",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const h = harness({
        intent: "duration",
        duration: { mode: "relative", deltaMinutes: 20 },
        weather: rain,
        pools: { park: [venue("covered-nowhere")] },
      });
      const result = await swapStop(plan, 0, "stay longer", now, h.deps);
      assert.strictEqual(result.swapped, false);
      assert.strictEqual(JSON.stringify(plan), before);
    },
  ],
  [
    "a missing middle location is a failure, never a successful partial tail",
    async () => {
      const plan = itinerary();
      delete plan.stops[1].location;
      const before = JSON.stringify(plan);
      const result = await swapStop(
        plan,
        0,
        "stay longer",
        now,
        harness().deps
      );
      assert.strictEqual(result.swapped, false);
      assert.strictEqual(JSON.stringify(plan), before);
    },
  ],
  [
    "an internally inconsistent locked boundary refuses even when reachable",
    async () => {
      const plan = itinerary();
      plan.stops[2].locked = true;
      plan.stops[2].end_time = T(21, 0);
      const before = JSON.stringify(plan);
      const h = harness({
        intent: "duration",
        duration: { mode: "relative", deltaMinutes: -10 },
      });
      const result = await swapStop(plan, 0, "a little shorter", now, h.deps);
      assert.strictEqual(result.swapped, false);
      assert.strictEqual(JSON.stringify(plan), before);
    },
  ],
  [
    "a replacement is revalidated after its inbound route crosses closing",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const candidate = venue(
        "far-bar",
        44,
        fridayHours(18, 0, 20, 30)
      );
      const h = harness({
        intent: "duration",
        duration: { mode: "relative", deltaMinutes: 10 },
        pools: { bar: [candidate] },
        unusableIds: ["b1"],
        routeMinutes: (_origin, destination) =>
          destination.latitude >= 44 ? 30 : 10,
      });
      const result = await swapStop(plan, 0, "stay longer", now, h.deps);
      assert.strictEqual(result.swapped, false);
      assert.strictEqual(JSON.stringify(plan), before);
    },
  ],
  [
    "one proposal fetches weather exactly once across the whole tail",
    async () => {
      const plan = itinerary();
      const h = harness({
        intent: "duration",
        duration: { mode: "relative", deltaMinutes: 10 },
      });
      const result = await swapStop(plan, 0, "stay longer", now, h.deps);
      assert.ok(result.swapped);
      assert.strictEqual(h.counts.weather, 1);
    },
  ],
  [
    "route failure leaves the caller's itinerary byte-identical",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const result = await swapStop(
        plan,
        0,
        "stay longer",
        now,
        harness({ routeError: true }).deps
      );
      assert.strictEqual(result.swapped, false);
      assert.strictEqual(JSON.stringify(plan), before);
    },
  ],
  [
    "a reachable locked boundary commits while its full suffix stays fixed",
    async () => {
      const plan = itinerary();
      plan.stops[1].locked = true;
      const lockedStart = plan.stops[1].start_time;
      const suffix = JSON.stringify(plan.stops.slice(1));
      const h = harness({
        intent: "venue",
        pools: { dinner: [venue("new-dinner")] },
      });
      const result = await swapStop(
        plan,
        0,
        "somewhere else",
        now,
        h.deps
      );
      assert.ok(result.swapped);
      assert.strictEqual(plan.stops[1].start_time, lockedStart);
      assert.strictEqual(JSON.stringify(plan.stops.slice(1)), suffix);
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
      console.log(
        `      ${
          error instanceof Error ? error.stack ?? error.message : error
        }`
      );
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
})();
