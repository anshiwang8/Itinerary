// Unit tests for filterPools. Run with: npx tsx app/api/places/search/filter.test.ts
import assert from "node:assert";
import {
  DropEntry,
  filterPools,
  ParsedPrompt,
  Place,
  RATING_FLOOR,
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
