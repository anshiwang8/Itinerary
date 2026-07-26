import assert from "node:assert";
import type { ParsedPrompt } from "../api/places/search/filter";
import {
  finalizeRequestedSlots,
  normalizeStopCountSlots,
  resolveRequestedSlots,
  slotsFromDistributionAnswer,
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
      assert.deepStrictEqual(
        slotsFromDistributionAnswer("2 dinner + 1 drinks", value.category_signals, 3),
        ["dinner", "dinner", "drinks"]
      );
      assert.deepStrictEqual(
        slotsFromDistributionAnswer("one dinner and two drinks", value.category_signals, 3),
        ["dinner", "drinks", "drinks"]
      );
      assert.strictEqual(
        slotsFromDistributionAnswer("dinner + drinks", value.category_signals, 3),
        null
      );
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
    "post-clarification finalization blocks every unresolved counted request",
    () => {
      const needsKind = finalizeRequestedSlots(parsed({ stop_count: 3 }));
      assert.strictEqual(needsKind.ok, false);
      if (!needsKind.ok) {
        assert.strictEqual(needsKind.resolution.kind, "needs-kind");
        assert.match(needsKind.reason, /all 3 stops/i);
      }

      const needsDistribution = finalizeRequestedSlots(
        parsed({
          stop_count: 3,
          category_signals: ["dinner", "drinks"],
        })
      );
      assert.strictEqual(needsDistribution.ok, false);
      if (!needsDistribution.ok) {
        assert.strictEqual(needsDistribution.resolution.kind, "needs-distribution");
      }

      const invalid = finalizeRequestedSlots(
        parsed({ stop_count: 0, category_signals: ["coffee shop"] })
      );
      assert.strictEqual(invalid.ok, false);
      if (!invalid.ok) assert.strictEqual(invalid.resolution.kind, "invalid");
    },
  ],
  [
    "post-clarification finalization expands a counted broad kind exactly",
    () => {
      const result = finalizeRequestedSlots(
        parsed({
          stop_count: 3,
          category_signals: ["things to do"],
        })
      );
      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.deepStrictEqual(result.parsed.category_signals, [
          "things to do",
          "things to do",
          "things to do",
        ]);
      }
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
