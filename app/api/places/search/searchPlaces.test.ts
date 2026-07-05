// buildQuery unit tests — constraints must shape the search query.
// Run with: npx tsx app/api/places/search/searchPlaces.test.ts
import assert from "node:assert";
import { buildQuery } from "./searchPlaces";
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
