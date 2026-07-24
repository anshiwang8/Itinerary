// Tests for the rule-based clarifying questions (no LLM involved).
// Run with: npx tsx app/lib/clarify.test.ts
import assert from "node:assert";
import {
  applyNarrowAnswer,
  categoriesForKindAnswer,
  clarifyQuestions,
  genericCategoryQuestion,
  kindQuestion,
  timeWindowForWhenAnswer,
} from "./clarify";
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
      // a real category means we already know what KIND they want — even a
      // generic one ("dinner" now draws its own narrowing question instead)
      assert.ok(!ids({ ...base, category_signals: ["dinner"] }).includes("kind"));
      assert.ok(ids(base).includes("kind"));
      // ...and it never displaces the existing questions; a generic
      // category slots its narrow question ABOVE when/vibe
      assert.deepStrictEqual(ids({ ...base, category_signals: ["dinner"] }), ["narrow", "when", "vibe"]);
      // a SPECIFIC category keeps the exact pre-narrowing shape
      assert.deepStrictEqual(ids({ ...base, category_signals: ["sushi"] }), ["when", "vibe"]);
    },
  ],
  [
    "kindQuestion() IS the kind question clarifyQuestions asks (one source — the time-gate reuses it)",
    () => {
      const asked = clarifyQuestions(base).find((q) => q.id === "kind");
      assert.deepStrictEqual(asked, kindQuestion());
      // every option round-trips through the answer mapping without error
      for (const o of kindQuestion().options) {
        assert.ok(Array.isArray(categoriesForKindAnswer(o)));
      }
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
    "SKIP: SPECIFIC category + time specified → no questions (unchanged rule)",
    () => {
      // the skip condition itself is untouched — a dish/cuisine category
      // plus a time still asks nothing ("sushi tonight" plans straight away)
      assert.deepStrictEqual(ids({ ...base, category_signals: ["sushi"], time_window: "7pm" }), []);
      assert.deepStrictEqual(ids({ ...base, category_signals: ["bowling"], time_window: "tonight" }), []);
    },
  ],
  [
    "SKIP: SPECIFIC category + aesthetic specified → no questions (unchanged rule)",
    () => {
      assert.deepStrictEqual(ids({ ...base, category_signals: ["ramen"], aesthetic: "cozy" }), []);
    },
  ],
  [
    "GENERIC category pierces the skip: 'restaurant tonight' asks the cuisine question",
    () => {
      // the whole point of the specificity axis — category PRESENCE is not
      // category SPECIFICITY, and a time being present must not silence it
      const qs = clarifyQuestions({ ...base, category_signals: ["restaurant"], time_window: "tonight" });
      assert.strictEqual(qs[0].id, "narrow");
      assert.strictEqual(qs[0].category, "restaurant");
      assert.match(qs[0].question, /craving/i);
      assert.ok(qs[0].options.includes("Italian"));
      // time present → no When?; nothing else specified → vibe may follow
      assert.ok(!qs.some((q) => q.id === "when"));
    },
  ],
  [
    "GENERIC axis: each family gets its own question; specific members do not",
    () => {
      const q = (c: string) => genericCategoryQuestion(c);
      assert.match(q("restaurant")!.question, /craving/i);
      assert.match(q("bar")!.question, /kind of bar/i);
      assert.match(q("drinks")!.question, /kind of bar/i);
      assert.match(q("dessert")!.question, /sounds good/i);
      assert.match(q("shopping")!.question, /kind of shopping/i);
      assert.match(q("entertainment")!.question, /kind of thing/i);
      // already-specific terms are never re-asked
      for (const c of ["sushi", "ramen", "cocktail bar", "wine bar", "ice cream", "bookstore", "arcade", "Italian restaurant", "park"]) {
        assert.strictEqual(q(c), null, `"${c}" should not be re-asked`);
      }
      // a narrowing CONSTRAINT counts as specificity too ("vegan" already
      // shapes the search query, so don't re-ask the cuisine)
      assert.strictEqual(genericCategoryQuestion("restaurant", ["vegan"]), null);
    },
  ],
  [
    "GENERIC axis: narrow answers fold back onto the category correctly",
    () => {
      // cuisines are MODIFIERS — the generic term survives so durations,
      // bands and the search query still match
      assert.strictEqual(applyNarrowAnswer("restaurant", "Italian"), "Italian restaurant");
      assert.strictEqual(applyNarrowAnswer("dinner", "BBQ"), "BBQ dinner");
      // venue-type answers ARE the category
      assert.strictEqual(applyNarrowAnswer("bar", "cocktail bar"), "cocktail bar");
      assert.strictEqual(applyNarrowAnswer("dessert", "ice cream"), "ice cream");
      assert.strictEqual(applyNarrowAnswer("entertainment", "bowling"), "bowling");
      // no answer → category unchanged
      assert.strictEqual(applyNarrowAnswer("restaurant", "  "), "restaurant");
    },
  ],
  [
    "GENERIC axis: budget still caps at 3 and narrow outranks vibe",
    () => {
      // two generic categories + no time + nothing else → narrow, narrow,
      // when — vibe (lowest priority) is what falls off the budget
      const qs = clarifyQuestions({ ...base, category_signals: ["dinner", "drinks"] });
      assert.strictEqual(qs.length, 3);
      assert.deepStrictEqual(qs.map((q) => q.id), ["narrow", "narrow", "when"]);
      assert.deepStrictEqual(qs.map((q) => q.category), ["dinner", "drinks", undefined]);
      // duplicate slots of one category ask ONE question
      const dup = clarifyQuestions({ ...base, category_signals: ["drinks", "drinks"], time_window: "7pm" });
      assert.deepStrictEqual(dup.map((q) => q.id), ["narrow", "vibe"]);
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
