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
    "farther venue replacement cannot reach the fixed target slot",
    async () => {
      const plan = itinerary();
      const before = JSON.stringify(plan);
      const far = venue("far-bar", 44);
      const h = harness({
        intent: "venue",
        pools: { bar: [far] },
        routeMinutes: (_origin, destination) =>
          destination.latitude >= 44 ? 30 : 10,
      });
      const result = await swapStop(
        plan,
        1,
        "somewhere else",
        now,
        h.deps
      );
      assert.strictEqual(result.swapped, false);
      assert.strictEqual(JSON.stringify(plan), before);
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
