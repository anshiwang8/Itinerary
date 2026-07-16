// buildQuery unit tests — constraints must shape the search query.
// Run with: npx tsx app/api/places/search/searchPlaces.test.ts
import assert from "node:assert";
import { buildQuery, includedTypeFor } from "./searchPlaces";
import { ParsedPrompt } from "./filter";

function mkParsed(overrides: Partial<ParsedPrompt> = {}): ParsedPrompt {
  return {
    time_window: "unspecified",
    stop_count: null,
    aesthetic: "unspecified",
    category_signals: ["lunch"],
    group_context: "solo",
    budget: null,
    constraints: [],
    location: "Ossington",
    ...overrides,
  };
}

const cases: Array<[string, () => void]> = [
  [
    "vegan constraint lands in the query",
    () => {
      const q = buildQuery(mkParsed({ constraints: ["vegan"] }), "lunch");
      assert.strictEqual(q, "vegan lunch Ossington Toronto");
    },
  ],
  [
    "constrained and plain queries differ",
    () => {
      const plain = buildQuery(mkParsed(), "lunch");
      const vegan = buildQuery(mkParsed({ constraints: ["vegan"] }), "lunch");
      assert.strictEqual(plain, "lunch Ossington Toronto");
      assert.notStrictEqual(plain, vegan);
      assert.match(vegan, /vegan/);
    },
  ],
  [
    "multiple constraints + aesthetic all present, empty strings dropped",
    () => {
      const q = buildQuery(
        mkParsed({ aesthetic: "quiet", constraints: ["vegan", "", "wheelchair accessible"] }),
        "restaurant"
      );
      assert.strictEqual(q, "quiet vegan wheelchair accessible restaurant Ossington Toronto");
    },
  ],
  [
    "no constraints → query unchanged from the pre-fix shape",
    () => {
      const q = buildQuery(mkParsed({ aesthetic: "lively night out" }), "bar");
      assert.strictEqual(q, "lively night out bar Ossington Toronto");
    },
  ],
  [
    "MULTI-CITY: parsed.city replaces the Toronto literal; absent city keeps it",
    () => {
      // second city flows into the query — never a silent Ossington/Toronto
      const van = buildQuery(mkParsed({ city: "Vancouver", location: "west end" }), "coffee");
      assert.strictEqual(van, "coffee west end Vancouver");
      // pre-multi-city itineraries (no city on parsed) keep the old behavior
      const legacy = buildQuery(mkParsed(), "lunch");
      assert.strictEqual(legacy, "lunch Ossington Toronto");
      // neighbourhood "unspecified" (new parse contract: "" / unspecified) drops out
      const bare = buildQuery(mkParsed({ city: "Montreal", location: "" }), "dinner");
      assert.strictEqual(bare, "dinner Montreal");
    },
  ],
  [
    "park-biased search: green-space categories get includedType 'park'",
    () => {
      // the hard type filter keeps scenic lounges/restaurants out of the pool
      assert.strictEqual(includedTypeFor("park"), "park");
      assert.strictEqual(includedTypeFor("park walk"), "park");
      assert.strictEqual(includedTypeFor("garden"), "park");
      assert.strictEqual(includedTypeFor("quiet trail"), "park");
      // commercial categories stay unfiltered free-text searches
      assert.strictEqual(includedTypeFor("bar"), undefined);
      assert.strictEqual(includedTypeFor("dinner"), undefined);
      assert.strictEqual(includedTypeFor("boardwalk cafe"), undefined); // \bwalk\b — a boardwalk CAFE is commercial
      // the text query itself is unchanged for parks (type filter does the work)
      const q = buildQuery(mkParsed({ aesthetic: "quiet" }), "park");
      assert.strictEqual(q, "quiet park Ossington Toronto");
    },
  ],
  [
    "casino-biased search: casino categories get includedType 'casino'",
    () => {
      // live evidence: the text query "casino Toronto" returns poker clubs,
      // arcade bars, and jazz lounges rated HIGHER than the real casinos —
      // the hard type filter keeps the pool to genuine casino-type places
      assert.strictEqual(includedTypeFor("casino"), "casino");
      assert.strictEqual(includedTypeFor("casinos"), "casino");
      assert.strictEqual(includedTypeFor("casino night"), "casino");
      // nightlife lookalikes stay unfiltered free-text searches
      assert.strictEqual(includedTypeFor("nightclub"), undefined);
      assert.strictEqual(includedTypeFor("club"), undefined);
      assert.strictEqual(includedTypeFor("poker club"), undefined);
      // the text query itself is unchanged (type filter does the work)
      assert.strictEqual(buildQuery(mkParsed(), "casino"), "casino Ossington Toronto");
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
