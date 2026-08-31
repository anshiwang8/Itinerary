import assert from "node:assert";
import type { ParsedPrompt } from "../api/places/search/filter";
import {
  normalizeStopCountSlots,
  resolveRequestedSlots,
} from "./planSlots";

function parsed(overrides: Partial<ParsedPrompt>): ParsedPrompt {
  return {
    time_window: "evening",
    stop_count: null,
    aesthetic: "cozy",
    category_signals: [],
    group_context: "date",
    budget: null,
    constraints: [],
    location: "",
    ...overrides,
  };
}

const cases: Array<[string, () => void]> = [
  [
    "three coffee shops expands one category into three slots",
    () => {
      assert.deepStrictEqual(
        normalizeStopCountSlots(
          parsed({ stop_count: 3, category_signals: ["coffee shop"] })
        ).category_signals,
        ["coffee shop", "coffee shop", "coffee shop"]
      );
    },
  ],
  [
    "exactly three places needs a kind before it can expand",
    () => {
      assert.deepStrictEqual(
        resolveRequestedSlots(parsed({ stop_count: 3 })),
        { kind: "needs-kind", count: 3 }
      );
      assert.deepStrictEqual(
        normalizeStopCountSlots(
          parsed({ stop_count: 3, category_signals: ["museum"] })
        ).category_signals,
        ["museum", "museum", "museum"]
      );
    },
  ],
  [
    "three dinner-and-drinks stops require a distribution instead of guessing",
    () => {
      const value = parsed({
        stop_count: 3,
        category_signals: ["dinner", "drinks"],
      });
      assert.deepStrictEqual(resolveRequestedSlots(value), {
        kind: "needs-distribution",
        count: 3,
        categories: ["dinner", "drinks"],
      });
    },
  ],
  [
    "already-repeated slots remain in their requested order",
    () => {
      const value = parsed({
        stop_count: 3,
        category_signals: ["dinner", "drinks", "drinks"],
      });
      assert.deepStrictEqual(resolveRequestedSlots(value), {
        kind: "resolved",
        slots: ["dinner", "drinks", "drinks"],
      });
    },
  ],
  [
    "invalid counts are rejected deterministically",
    () => {
      for (const count of [0, -1, 1.5, 9, Number.NaN]) {
        const result = resolveRequestedSlots(
          parsed({ stop_count: count as number, category_signals: ["cafe"] })
        );
        assert.strictEqual(result.kind, "invalid", String(count));
      }
    },
  ],
  [
    "normalizeStopCountSlots leaves an unresolved counted request untouched",
    () => {
      const needsKind = parsed({ stop_count: 3 });
      assert.strictEqual(
        normalizeStopCountSlots(needsKind).category_signals,
        needsKind.category_signals
      );
      const needsDistribution = parsed({
        stop_count: 3,
        category_signals: ["dinner", "drinks"],
      });
      assert.deepStrictEqual(
        normalizeStopCountSlots(needsDistribution).category_signals,
        ["dinner", "drinks"]
      );
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
