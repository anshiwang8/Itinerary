// Tests for the rule-based clarifying questions (no LLM involved).
// Run with: npx tsx app/lib/clarify.test.ts
import assert from "node:assert";
import { categoriesForKindAnswer, clarifyQuestions, timeWindowForWhenAnswer } from "./clarify";
import { ParsedPrompt } from "../api/places/search/filter";

const base: ParsedPrompt = {
  time_window: "unspecified",
  stop_count: null,
  aesthetic: "unspecified",
  category_signals: [],
  group_context: "unspecified",
  budget: null,
  constraints: [],
  location: "Ossington",
};

const ids = (p: ParsedPrompt) => clarifyQuestions(p).map((q) => q.id);

const cases: Array<[string, () => void]> = [
  [
    "ULTRA-VAGUE ('not sure what to do') → asks KIND first, then When?, then vibe",
    () => {
      // batch 4: a prompt with no category at all gets the extra question —
      // without it the plan rests entirely on the broad general pool
      assert.deepStrictEqual(ids(base), ["kind", "when", "vibe"]);
    },
  ],
  [
    "kind is asked ONLY when there's no category at all",
    () => {
      // a real category means we already know what they want
      assert.ok(!ids({ ...base, category_signals: ["dinner"] }).includes("kind"));
      assert.ok(ids(base).includes("kind"));
      // ...and it never displaces the existing questions
      assert.deepStrictEqual(ids({ ...base, category_signals: ["dinner"] }), ["when", "vibe"]);
    },
  ],
  [
    "kind answers map onto pipeline-understood categories",
    () => {
      assert.deepStrictEqual(categoriesForKindAnswer("food"), ["restaurant"]);
      assert.deepStrictEqual(categoriesForKindAnswer("drinks"), ["bar"]);
      assert.deepStrictEqual(categoriesForKindAnswer("outdoors"), ["park"]);
      // "something to do" deliberately stays general — the broad pool IS
      // the right tool for "surprise me"
      assert.deepStrictEqual(categoriesForKindAnswer("something to do"), []);
      // free text becomes its own category, like any typed prompt would
      assert.deepStrictEqual(categoriesForKindAnswer("bowling"), ["bowling"]);
      assert.deepStrictEqual(categoriesForKindAnswer("  "), []);
    },
  ],
  [
    "no time signal → When? is asked",
    () => {
      assert.ok(ids({ ...base, aesthetic: "cozy" }).includes("when"));
    },
  ],
  [
    "aesthetic+group+constraints all unspecified → vibe is asked",
    () => {
      assert.ok(ids({ ...base, time_window: "tonight" }).includes("vibe"));
    },
  ],
  [
    "SKIP: category + time specified → no questions",
    () => {
      assert.deepStrictEqual(ids({ ...base, category_signals: ["dinner"], time_window: "7pm" }), []);
    },
  ],
  [
    "SKIP: category + aesthetic specified → no questions",
    () => {
      assert.deepStrictEqual(ids({ ...base, category_signals: ["dinner"], aesthetic: "cozy" }), []);
    },
  ],
  [
    "vibe NOT asked when any of aesthetic/group/constraints is present",
    () => {
      assert.ok(!ids({ ...base, group_context: "date" }).includes("vibe"));
      assert.ok(!ids({ ...base, constraints: ["vegan"] }).includes("vibe"));
      assert.ok(!ids({ ...base, aesthetic: "lively" }).includes("vibe"));
    },
  ],
  [
    "When? answers map onto resolver-understood time windows",
    () => {
      assert.strictEqual(timeWindowForWhenAnswer("now"), "now");
      assert.strictEqual(timeWindowForWhenAnswer("later today"), "evening");
      assert.strictEqual(timeWindowForWhenAnswer("7pm"), "7pm"); // free text passthrough
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
