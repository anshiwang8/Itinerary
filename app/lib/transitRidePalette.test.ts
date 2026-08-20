// Fixed transit ride palette contract — pure presentation data, independent
// of Google Maps and React rendering.
// Run with: npx tsx app/lib/transitRidePalette.test.ts
import assert from "node:assert";
import {
  TRANSIT_RIDE_PALETTE,
  transitRideColor,
} from "./transitRidePalette";

const APPROVED_COLORS = [
  "#005A9C",
  "#9A4D00",
  "#006B57",
  "#A31545",
  "#5F6500",
  "#6B4C9A",
  "#B3261E",
  "#006D8F",
  "#76502F",
  "#5145A4",
  "#3F6B35",
  "#8A3A75",
  "#2D6FA3",
  "#B05A14",
  "#1B7A67",
  "#B13F68",
  "#687014",
  "#805DA8",
  "#C13F37",
  "#176F89",
  "#89654A",
  "#675ABD",
  "#46753D",
  "#A04B87",
] as const;

const cases: Array<[string, () => void]> = [
  [
    "slots 0 through 23 resolve to the exact approved colors in order",
    () => {
      assert.deepStrictEqual(TRANSIT_RIDE_PALETTE, APPROVED_COLORS);
      assert.deepStrictEqual(
        APPROVED_COLORS.map((_, slot) => transitRideColor(slot)),
        [...APPROVED_COLORS]
      );
    },
  ],
  [
    "all 24 colors are unique and reserved chartreuse is absent",
    () => {
      assert.strictEqual(TRANSIT_RIDE_PALETTE.length, 24);
      assert.strictEqual(new Set(TRANSIT_RIDE_PALETTE).size, 24);
      assert.ok(!new Set<string>(TRANSIT_RIDE_PALETTE).has("#C8F000"));
    },
  ],
  [
    "missing, null, non-integer, negative, and out-of-range slots resolve no app color",
    () => {
      const invalidSlots: unknown[] = [
        undefined,
        null,
        -1,
        24,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        "0",
      ];
      for (const slot of invalidSlots) {
        assert.strictEqual(transitRideColor(slot), undefined, String(slot));
      }
    },
  ],
];

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.stack ?? error.message : error}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
