// Guards the mock-parse normalization contracts that mirror the REAL
// parse SYSTEM_PROMPT's rules (the real model's behavior is prompt-level
// and live-verified; this pins the deterministic mock mirror so e2e
// scenarios exercising these categories stay honest).
// Run with: npx tsx app/api/_mock/fixtures.test.ts
import assert from "node:assert";
import { resolveGeocodeResponse } from "../geocode/geocode";
import { mockGeocodingResponse, mockParse } from "./fixtures";

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
    "mock geocoding swaps provider data while the real validator resolves it",
    () => {
      const cityRequest = { query: "Vancouver", kind: "city" } as const;
      const city = resolveGeocodeResponse(
        mockGeocodingResponse(cityRequest),
        cityRequest
      );
      assert.strictEqual(city.outcome, "resolved");
      if (city.outcome !== "resolved") return;
      assert.deepStrictEqual(city.location, {
        latitude: 43.6547,
        longitude: -79.3862,
      });
      assert.strictEqual(city.label, "Vancouver (fixture)");

      const addressRequest = {
        query: "800 Robson St",
        kind: "address",
        cityContext: city,
      } as const;
      const address = resolveGeocodeResponse(
        mockGeocodingResponse(addressRequest),
        addressRequest
      );
      assert.strictEqual(address.outcome, "resolved");
      if (address.outcome !== "resolved") return;
      assert.deepStrictEqual(address.location, city.location);
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
      const vegetarian = mockParse("vegetarian dinner");
      assert.deepStrictEqual(vegetarian.category_signals, ["dinner"]);
      assert.deepStrictEqual(vegetarian.constraints, ["vegetarian"]);
      // genuinely distinct activities still get their own entries
      assert.deepStrictEqual(mockParse("dinner then a bar").category_signals, ["dinner", "drinks"]);
    },
  ],
  [
    "calendar qualifiers, stop counts, and structured budget text survive the mock seam",
    () => {
      const dated = mockParse("three coffee shops next Saturday at 7pm under $20");
      assert.strictEqual(dated.time_window, "next saturday, 7pm");
      assert.strictEqual(dated.stop_count, 3);
      assert.deepStrictEqual(dated.category_signals, ["coffee"]);
      assert.strictEqual(dated.budget, "under $20");
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
