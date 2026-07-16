// Guards the mock-parse normalization contracts that mirror the REAL
// parse SYSTEM_PROMPT's rules (the real model's behavior is prompt-level
// and live-verified; this pins the deterministic mock mirror so e2e
// scenarios exercising these categories stay honest).
// Run with: npx tsx app/api/_mock/fixtures.test.ts
import assert from "node:assert";
import { mockGeocode, mockParse } from "./fixtures";

const cases: Array<[string, () => void]> = [
  [
    "passive outdoor phrasing normalizes to 'park' (bench/scenery/etc.)",
    () => {
      for (const p of [
        "sit on a bench and enjoy quiet scenery",
        "somewhere with greenery and fresh air",
        "somewhere calm outside to enjoy nature",
      ]) {
        assert.deepStrictEqual(mockParse(p).category_signals, ["park"], `"${p}"`);
      }
    },
  ],
  [
    "active outdoor phrasing keeps 'park walk' (weather-gate fixture path)",
    () => {
      assert.deepStrictEqual(mockParse("a walk in the park at 3pm").category_signals, [
        "park walk",
      ]);
    },
  ],
  [
    "mockGeocode is deterministic: any query → fixture home coords",
    () => {
      const a = mockGeocode("Vancouver");
      const b = mockGeocode("800 Robson St, Vancouver");
      assert.deepStrictEqual(a.location, { latitude: 43.6547, longitude: -79.3862 });
      assert.deepStrictEqual(b.location, a.location);
      assert.strictEqual(a.label, "Vancouver (fixture)");
    },
  ],
  [
    "food prompts are untouched by the park rule",
    () => {
      assert.deepStrictEqual(mockParse("dinner and drinks").category_signals, [
        "dinner",
        "drinks",
      ]);
    },
  ],
  [
    "a venue FEATURE is a constraint, never its own category (mirrors the prompt rule)",
    () => {
      // "dessert with a patio" is ONE dessert stop with a patio requirement
      const p = mockParse("dessert with a patio");
      assert.deepStrictEqual(p.category_signals, ["dessert"]);
      assert.deepStrictEqual(p.constraints, ["patio"]);
      // dietary words behave the same way (the rule this generalizes)
      const v = mockParse("vegan dinner");
      assert.deepStrictEqual(v.category_signals, ["dinner"]);
      assert.deepStrictEqual(v.constraints, ["vegan"]);
      // genuinely distinct activities still get their own entries
      assert.deepStrictEqual(mockParse("dinner then a bar").category_signals, ["dinner", "drinks"]);
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
