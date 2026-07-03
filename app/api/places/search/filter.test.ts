// Unit tests for filterPools. Run with: npx tsx app/api/places/search/filter.test.ts
import assert from "node:assert";
import {
  COLD_BLOCK_THRESHOLD_C,
  DropEntry,
  filterPools,
  isOutdoorCategory,
  ParsedPrompt,
  Place,
  PRECIP_BLOCK_THRESHOLD,
  RATING_FLOOR,
  WeatherHour,
} from "./filter";

// ── fixtures ──
// Open 08:00–18:00 every day of the week (day-independent verdicts, so
// tests don't depend on what "tomorrow" resolves to at runtime).
const HOURS_8_TO_18 = {
  periods: Array.from({ length: 7 }, (_, day) => ({
    open: { day, hour: 8, minute: 0 },
    close: { day, hour: 18, minute: 0 },
  })),
};

function mkPlace(id: string, overrides: Partial<Place> = {}): Place {
  return {
    id,
    displayName: { text: `Venue ${id}` },
    rating: 4.5,
    businessStatus: "OPERATIONAL",
    currentOpeningHours: HOURS_8_TO_18,
    ...overrides,
  };
}

function mkParsed(overrides: Partial<ParsedPrompt> = {}): ParsedPrompt {
  return {
    time_window: "tomorrow, 9am", // inside 08–18 → hours check passes
    stop_count: null,
    aesthetic: "cozy",
    category_signals: ["coffee shop"],
    group_context: "solo",
    budget: null,
    constraints: [],
    location: "Ossington",
    ...overrides,
  };
}

function rulesFor(dropLog: DropEntry[], id: string): string[] {
  return dropLog.filter((d) => d.id === id).map((d) => d.rule);
}

// ── cases ──
const cases: Array<[string, () => void]> = [
  [
    "CLOSED_PERMANENTLY venue dropped (rule: businessStatus)",
    () => {
      const { pools, dropLog } = filterPools(
        { cafe: [mkPlace("a", { businessStatus: "CLOSED_PERMANENTLY" }), mkPlace("b")] },
        mkParsed()
      );
      assert.deepStrictEqual(pools.cafe.map((p) => p.id), ["b"]);
      assert.deepStrictEqual(rulesFor(dropLog, "a"), ["businessStatus"]);
    },
  ],
  [
    "CLOSED_TEMPORARILY venue dropped (rule: businessStatus)",
    () => {
      const { pools, dropLog } = filterPools(
        { cafe: [mkPlace("a", { businessStatus: "CLOSED_TEMPORARILY" })] },
        mkParsed()
      );
      assert.strictEqual(pools.cafe.length, 0);
      assert.deepStrictEqual(rulesFor(dropLog, "a"), ["businessStatus"]);
    },
  ],
  [
    "venue closed at target time dropped (rule: hours)",
    () => {
      // target 6am, venue opens 08:00 → closed
      const { pools, dropLog } = filterPools(
        { cafe: [mkPlace("a")] },
        mkParsed({ time_window: "tomorrow, 6am" })
      );
      assert.strictEqual(pools.cafe.length, 0);
      assert.deepStrictEqual(rulesFor(dropLog, "a"), ["hours"]);
      assert.match(dropLog[0].detail, /closed at target/);
    },
  ],
  [
    "venue with missing hours data KEPT despite clock-time target",
    () => {
      const { pools, dropLog } = filterPools(
        { cafe: [mkPlace("a", { currentOpeningHours: undefined })] },
        mkParsed({ time_window: "tomorrow, 6am" })
      );
      assert.deepStrictEqual(pools.cafe.map((p) => p.id), ["a"]);
      assert.strictEqual(dropLog.length, 0);
    },
  ],
  [
    "no clock time in time_window → hours check skipped entirely",
    () => {
      // 8–18 venue would be closed at any early target, but "morning"
      // has no comparable clock time → everything passes the hours rule
      const { pools, dropLog } = filterPools(
        { cafe: [mkPlace("a")] },
        mkParsed({ time_window: "morning" })
      );
      assert.deepStrictEqual(pools.cafe.map((p) => p.id), ["a"]);
      assert.strictEqual(dropLog.length, 0);
    },
  ],
  [
    "rating below floor dropped, boundary rating kept (rule: rating)",
    () => {
      const { pools, dropLog } = filterPools(
        {
          cafe: [
            mkPlace("low", { rating: 3.2 }),
            mkPlace("edge", { rating: RATING_FLOOR }),
          ],
        },
        mkParsed()
      );
      assert.deepStrictEqual(pools.cafe.map((p) => p.id), ["edge"]);
      assert.deepStrictEqual(rulesFor(dropLog, "low"), ["rating"]);
    },
  ],
  [
    "missing rating kept",
    () => {
      const { pools, dropLog } = filterPools(
        { cafe: [mkPlace("a", { rating: undefined })] },
        mkParsed()
      );
      assert.deepStrictEqual(pools.cafe.map((p) => p.id), ["a"]);
      assert.strictEqual(dropLog.length, 0);
    },
  ],
  [
    "cheap budget drops EXPENSIVE and VERY_EXPENSIVE (rule: price)",
    () => {
      const { pools, dropLog } = filterPools(
        {
          cafe: [
            mkPlace("exp", { priceLevel: "PRICE_LEVEL_EXPENSIVE" }),
            mkPlace("vexp", { priceLevel: "PRICE_LEVEL_VERY_EXPENSIVE" }),
            mkPlace("mod", { priceLevel: "PRICE_LEVEL_MODERATE" }),
          ],
        },
        mkParsed({ budget: "cheap" })
      );
      assert.deepStrictEqual(pools.cafe.map((p) => p.id), ["mod"]);
      assert.deepStrictEqual(rulesFor(dropLog, "exp"), ["price"]);
      assert.deepStrictEqual(rulesFor(dropLog, "vexp"), ["price"]);
    },
  ],
  [
    "missing priceLevel KEPT even with budget stated",
    () => {
      const { pools, dropLog } = filterPools(
        { cafe: [mkPlace("a", { priceLevel: undefined })] },
        mkParsed({ budget: "budget friendly" })
      );
      assert.deepStrictEqual(pools.cafe.map((p) => p.id), ["a"]);
      assert.strictEqual(dropLog.length, 0);
    },
  ],
  [
    "no budget stated → EXPENSIVE kept",
    () => {
      const { pools, dropLog } = filterPools(
        { cafe: [mkPlace("a", { priceLevel: "PRICE_LEVEL_EXPENSIVE" })] },
        mkParsed({ budget: null })
      );
      assert.deepStrictEqual(pools.cafe.map((p) => p.id), ["a"]);
      assert.strictEqual(dropLog.length, 0);
    },
  ],
  [
    "duplicate id dropped from SECOND category only (rule: dedup)",
    () => {
      const shared = mkPlace("dup");
      const { pools, dropLog } = filterPools(
        {
          dinner: [shared, mkPlace("d2")],
          bars: [mkPlace("b1"), { ...shared }],
        },
        mkParsed({ category_signals: ["dinner", "bars"] })
      );
      assert.deepStrictEqual(pools.dinner.map((p) => p.id), ["dup", "d2"]);
      assert.deepStrictEqual(pools.bars.map((p) => p.id), ["b1"]);
      const dupDrops = dropLog.filter((d) => d.id === "dup");
      assert.strictEqual(dupDrops.length, 1);
      assert.strictEqual(dupDrops[0].category, "bars");
      assert.strictEqual(dupDrops[0].rule, "dedup");
    },
  ],
  [
    "venue dropped in earlier category does NOT block later category (dedup is survivors-only)",
    () => {
      // "dup" gets dropped from dinner by rating; it should still be
      // allowed to survive in bars (it never "survived" earlier).
      const { pools } = filterPools(
        {
          dinner: [mkPlace("dup", { rating: 3.0 })],
          bars: [mkPlace("dup")],
        },
        mkParsed({ category_signals: ["dinner", "bars"] })
      );
      assert.strictEqual(pools.dinner.length, 0);
      assert.deepStrictEqual(pools.bars.map((p) => p.id), ["dup"]);
    },
  ],
  // ── weather gate ──
  // Fixed now: Fri 2026-07-03 13:20 → "afternoon" resolves to 14:00.
  [
    "outdoor matcher: parks/walks/patios/markets yes, indoor no",
    () => {
      for (const c of ["park", "walk in the park", "patio", "garden", "beach", "trail", "farmers market", "picnic", "hike"]) {
        assert.strictEqual(isOutdoorCategory(c), true, `${c} should be outdoor`);
      }
      for (const c of ["museum", "coffee shop", "bar", "ramen", "bookstore"]) {
        assert.strictEqual(isOutdoorCategory(c), false, `${c} should NOT be outdoor`);
      }
    },
  ],
  [
    "rain above threshold blocks outdoor pool at category level",
    () => {
      const NOW = new Date(2026, 6, 3, 13, 20, 0);
      const weather: WeatherHour[] = [
        { hourISO: new Date(2026, 6, 3, 14, 0).toISOString(), tempC: 22, precipProbability: 80, condition: "Rain" },
      ];
      const { pools, weatherBlocked, dropLog } = filterPools(
        { park: [mkPlace("p1"), mkPlace("p2")] },
        mkParsed({ time_window: "afternoon" }),
        weather,
        NOW
      );
      assert.deepStrictEqual(pools.park, []);
      assert.deepStrictEqual(weatherBlocked, [
        { category: "park", weatherBlocked: true, reason: "rain likely at 2pm" },
      ]);
      // blocked at category level — no per-venue drop entries
      assert.strictEqual(dropLog.length, 0);
    },
  ],
  [
    "precip exactly at threshold (50) does NOT block",
    () => {
      const NOW = new Date(2026, 6, 3, 13, 20, 0);
      const weather: WeatherHour[] = [
        { hourISO: new Date(2026, 6, 3, 14, 0).toISOString(), tempC: 22, precipProbability: PRECIP_BLOCK_THRESHOLD, condition: "Cloudy" },
      ];
      const { pools, weatherBlocked } = filterPools(
        { park: [mkPlace("p1")] },
        mkParsed({ time_window: "afternoon" }),
        weather,
        NOW
      );
      assert.deepStrictEqual(pools.park.map((p) => p.id), ["p1"]);
      assert.deepStrictEqual(weatherBlocked, []);
    },
  ],
  [
    "cold below threshold blocks; exactly -5 does NOT",
    () => {
      const NOW = new Date(2026, 6, 3, 13, 20, 0);
      const at = (tempC: number): WeatherHour[] => [
        { hourISO: new Date(2026, 6, 3, 14, 0).toISOString(), tempC, precipProbability: 0, condition: "Clear" },
      ];
      const blocked = filterPools(
        { trail: [mkPlace("t1")] },
        mkParsed({ time_window: "afternoon" }),
        at(-6),
        NOW
      );
      assert.strictEqual(blocked.weatherBlocked.length, 1);
      assert.match(blocked.weatherBlocked[0].reason, /too cold at 2pm \(-6°C\)/);

      const boundary = filterPools(
        { trail: [mkPlace("t1")] },
        mkParsed({ time_window: "afternoon" }),
        at(COLD_BLOCK_THRESHOLD_C),
        NOW
      );
      assert.deepStrictEqual(boundary.weatherBlocked, []);
    },
  ],
  [
    "missing weather data → outdoor pool passes untouched",
    () => {
      const NOW = new Date(2026, 6, 3, 13, 20, 0);
      const noWeather = filterPools(
        { park: [mkPlace("p1")] },
        mkParsed({ time_window: "afternoon" }),
        null,
        NOW
      );
      assert.deepStrictEqual(noWeather.pools.park.map((p) => p.id), ["p1"]);
      // forecast horizon miss (target hour not in data) also passes
      const wrongHour: WeatherHour[] = [
        { hourISO: new Date(2026, 6, 3, 9, 0).toISOString(), tempC: 20, precipProbability: 99, condition: "Rain" },
      ];
      const horizonMiss = filterPools(
        { park: [mkPlace("p1")] },
        mkParsed({ time_window: "afternoon" }),
        wrongHour,
        NOW
      );
      assert.deepStrictEqual(horizonMiss.weatherBlocked, []);
    },
  ],
  [
    "indoor categories unaffected by a terrible forecast",
    () => {
      const NOW = new Date(2026, 6, 3, 13, 20, 0);
      const weather: WeatherHour[] = [
        { hourISO: new Date(2026, 6, 3, 14, 0).toISOString(), tempC: -20, precipProbability: 100, condition: "Blizzard" },
      ];
      const { pools, weatherBlocked } = filterPools(
        { bar: [mkPlace("b1")], museum: [mkPlace("m1")] },
        mkParsed({ time_window: "afternoon" }),
        weather,
        NOW
      );
      assert.deepStrictEqual(pools.bar.map((p) => p.id), ["b1"]);
      assert.deepStrictEqual(pools.museum.map((p) => p.id), ["m1"]);
      assert.deepStrictEqual(weatherBlocked, []);
    },
  ],
  [
    "dropLog entry shape",
    () => {
      const { dropLog } = filterPools(
        { cafe: [mkPlace("a", { businessStatus: "CLOSED_PERMANENTLY" })] },
        mkParsed()
      );
      assert.deepStrictEqual(Object.keys(dropLog[0]).sort(), [
        "category",
        "detail",
        "id",
        "name",
        "rule",
      ]);
      assert.strictEqual(dropLog[0].name, "Venue a");
      assert.strictEqual(dropLog[0].category, "cafe");
    },
  ],
];

// ── runner ──
let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
