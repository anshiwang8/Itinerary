// Transfer-bubble grouping + labels — the pure half of the stacked
// mini-circle treatment, tested independent of the rendering (real
// Google routes rarely produce 3-4-ride legs on demand, so the grouping
// rule is pinned here exactly).
// Run with: npx tsx app/lib/transitBubbles.test.ts
import assert from "node:assert";
import { bubbleLabel, groupBubbleUnits } from "./transitBubbles";

const cases: Array<[string, () => void]> = [
  [
    "grouping: 0 rides → no units (walk legs keep their glyph)",
    () => {
      assert.deepStrictEqual(groupBubbleUnits([]), []);
    },
  ],
  [
    "grouping: 1 ride → one full-size single (today's badge, now the n=1 case)",
    () => {
      assert.deepStrictEqual(groupBubbleUnits(["a"]), [["a"]]);
    },
  ],
  [
    "grouping: 2 rides → one stacked pair",
    () => {
      assert.deepStrictEqual(groupBubbleUnits(["a", "b"]), [["a", "b"]]);
    },
  ],
  [
    "grouping: 3 rides → one pair + one full-size single, leftover LAST",
    () => {
      assert.deepStrictEqual(groupBubbleUnits(["a", "b", "c"]), [["a", "b"], ["c"]]);
    },
  ],
  [
    "grouping: 4 rides → two stacked pairs",
    () => {
      assert.deepStrictEqual(groupBubbleUnits(["a", "b", "c", "d"]), [
        ["a", "b"],
        ["c", "d"],
      ]);
    },
  ],
  [
    "grouping: 5 rides → two pairs + the leftover single, order preserved throughout",
    () => {
      assert.deepStrictEqual(groupBubbleUnits(["a", "b", "c", "d", "e"]), [
        ["a", "b"],
        ["c", "d"],
        ["e"],
      ]);
    },
  ],
  [
    "labels: agency short name wins; initials when unpublished; never blank",
    () => {
      assert.strictEqual(bubbleLabel({ lineName: "1 Yonge - University", shortName: "1" }), "1");
      assert.strictEqual(bubbleLabel({ lineName: "501 Queen", shortName: "501" }), "501");
      // no short name → initials from the line name
      assert.strictEqual(bubbleLabel({ lineName: "Lakeshore West", shortName: null }), "LW");
      assert.strictEqual(bubbleLabel({ lineName: "Carlton" }), "C");
      // an over-long short designation is clipped to circle width
      assert.strictEqual(bubbleLabel({ lineName: "Express", shortName: "EXPRESS" }), "EXPR");
      // nothing published at all → the transit fallback, never a blank dot
      assert.strictEqual(bubbleLabel({ lineName: "" }), "T");
    },
  ],
];

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
