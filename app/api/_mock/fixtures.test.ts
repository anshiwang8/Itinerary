// Guards the mock-parse normalization contracts that mirror the REAL
// parse SYSTEM_PROMPT's rules (the real model's behavior is prompt-level
// and live-verified; this pins the deterministic mock mirror so e2e
// scenarios exercising these categories stay honest).
// Run with: npx tsx app/api/_mock/fixtures.test.ts
import assert from "node:assert";
import { mockParse } from "./fixtures";

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
    "food prompts are untouched by the park rule",
    () => {
      assert.deepStrictEqual(mockParse("dinner and drinks").category_signals, [
        "dinner",
        "drinks",
      ]);
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
