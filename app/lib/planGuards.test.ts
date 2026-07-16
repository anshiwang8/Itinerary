// Tests for the fail-loud plan guards: nonsense, contradictions, empty
// pools, unmet constraints — every bad input gets a reason + suggestion.
// Run with: npx tsx app/lib/planGuards.test.ts
import assert from "node:assert";
import {
  CONTRADICTION_MESSAGE,
  contradictionReason,
  degeneratePromptReason,
  emptyCategoryReason,
  emptyParseReason,
  noVenuesReason,
  partialEmptyCategories,
  UNPARSEABLE_MESSAGE,
  unmetConstraintReason,
  weatherBlockedReason,
  widenOfferLabel,
} from "./planGuards";
import { DropEntry, ParsedPrompt } from "../api/places/search/filter";
import type { Selection } from "../api/select/selectVenues";

// selection/drop builders for the recovery tests
const pick = (category: string, id = `${category}_1`): Selection => ({
  category,
  id,
  reason: `A fine ${category}.`,
});
const emptyPick = (category: string): Selection => ({
  category,
  id: null,
  reason: "no venues survived filtering",
});
const unmetPick = (category: string, constraint: string): Selection => ({
  category,
  id: null,
  reason: `no ${category} candidate actually meets "${constraint}"`,
  unmetConstraint: constraint,
});
const drop = (category: string, rule: DropEntry["rule"], detail = ""): DropEntry => ({
  category,
  name: `${category} spot`,
  id: `${category}_x`,
  rule,
  detail,
});

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

const cases: Array<[string, () => void]> = [
  [
    "degenerate prompts ('.', '!!!', '123', keyboard mash) → unparseable, pre-LLM",
    () => {
      assert.strictEqual(degeneratePromptReason("."), UNPARSEABLE_MESSAGE);
      assert.strictEqual(degeneratePromptReason("!!!"), UNPARSEABLE_MESSAGE);
      assert.strictEqual(degeneratePromptReason("123"), UNPARSEABLE_MESSAGE);
      assert.strictEqual(degeneratePromptReason("asdfghjkl"), UNPARSEABLE_MESSAGE);
      assert.strictEqual(degeneratePromptReason("qwerty asdf"), UNPARSEABLE_MESSAGE);
    },
  ],
  [
    "real prompts are NOT degenerate (incl. short words that sit on a key row)",
    () => {
      assert.strictEqual(degeneratePromptReason("dinner and drinks"), null);
      assert.strictEqual(degeneratePromptReason("as we like"), null); // 'as'/'we' are row runs but short
      assert.strictEqual(degeneratePromptReason("ramen at 7"), null);
    },
  ],
  [
    "empty parse + DEGENERATE prompt → unparseable (gibberish still fails)",
    () => {
      assert.strictEqual(emptyParseReason(base, "asdfghjkl"), UNPARSEABLE_MESSAGE);
      assert.strictEqual(emptyParseReason(base, "."), UNPARSEABLE_MESSAGE);
    },
  ],
  [
    "empty parse + SINCERE prompt → null (vague uncertainty is not gibberish)",
    () => {
      // real words, genuine uncertainty — falls through to the general
      // "things to do" pool instead of a rejection
      assert.strictEqual(emptyParseReason(base, "not sure what to do"), null);
      assert.strictEqual(emptyParseReason(base, "no idea, surprise me"), null);
      assert.strictEqual(emptyParseReason(base, "bored, help"), null);
    },
  ],
  [
    "any extracted signal keeps going regardless of prompt",
    () => {
      assert.strictEqual(emptyParseReason({ ...base, category_signals: ["dinner"] }, "x y z"), null);
      assert.strictEqual(emptyParseReason({ ...base, time_window: "tonight" }, "x y z"), null);
      assert.strictEqual(emptyParseReason({ ...base, aesthetic: "cozy" }, "x y z"), null);
      assert.strictEqual(emptyParseReason({ ...base, budget: "cheap" }, "x y z"), null);
      assert.strictEqual(emptyParseReason({ ...base, constraints: ["patio"] }, "x y z"), null);
    },
  ],
  [
    "cheap + fancy → contradiction, from the prompt or the parsed fields",
    () => {
      assert.strictEqual(
        contradictionReason("cheap fancy dinner", { ...base, category_signals: ["dinner"] }),
        CONTRADICTION_MESSAGE
      );
      // parse split them into budget + aesthetic — still caught
      assert.strictEqual(
        contradictionReason("dinner", { ...base, budget: "cheap", aesthetic: "upscale" }),
        CONTRADICTION_MESSAGE
      );
    },
  ],
  [
    "one-sided or negated signals are NOT contradictions",
    () => {
      assert.strictEqual(contradictionReason("cheap dinner", base), null);
      assert.strictEqual(contradictionReason("fancy dinner", base), null);
      // "nothing fancy" is a cheap signal, not a fancy one
      assert.strictEqual(contradictionReason("cheap eats, nothing fancy", base), null);
      assert.strictEqual(contradictionReason("affordable, not too posh", base), null);
    },
  ],
  [
    "dietary vs incompatible venue type → contradiction, naming the pair",
    () => {
      // the exact QA Scenario 9 case, incl. how it actually parses
      assert.strictEqual(
        contradictionReason("vegan steakhouse", {
          ...base,
          category_signals: ["steakhouse", "vegan"],
          constraints: ["vegan options"],
        }),
        "That's a bit contradictory — vegan and steakhouse pull opposite ways."
      );
      // other obvious clashes (message names the actual words)
      assert.strictEqual(
        contradictionReason("vegetarian bbq", base),
        "That's a bit contradictory — vegetarian and bbq pull opposite ways."
      );
      assert.strictEqual(
        contradictionReason("kosher pork joint", base),
        "That's a bit contradictory — kosher and pork pull opposite ways."
      );
      assert.match(contradictionReason("vegan butcher", base) ?? "", /vegan and butcher pull opposite ways/);
      assert.match(contradictionReason("halal bacon spot", base) ?? "", /halal and bacon pull opposite ways/);
    },
  ],
  [
    "satisfiable diet requests do NOT trip the new guard (Scenario 10 regression)",
    () => {
      // "vegan dinner" must plan, never refuse
      assert.strictEqual(
        contradictionReason("vegan dinner", { ...base, constraints: ["vegan"], category_signals: ["dinner"] }),
        null
      );
      assert.strictEqual(contradictionReason("vegan cafe", base), null);
      assert.strictEqual(contradictionReason("vegetarian ramen", base), null);
      // per-diet: these venue types are only incompatible with SOME diets
      assert.strictEqual(contradictionReason("halal steakhouse", base), null); // halal steak is fine
      assert.strictEqual(contradictionReason("gluten-free steakhouse", base), null); // GF steak is fine
      assert.strictEqual(contradictionReason("kosher bbq", base), null); // kosher BBQ is common
    },
  ],
  [
    "accommodation phrasing (mixed group) is not a contradiction",
    () => {
      // "vegan options" / "vegan-friendly" / "a vegan friend" = a preference
      // for the group, not a hard whole-venue requirement
      assert.strictEqual(contradictionReason("vegan options at a steakhouse", base), null);
      assert.strictEqual(contradictionReason("steakhouse with a vegan friend", base), null);
      assert.strictEqual(contradictionReason("vegan-friendly steakhouse", base), null);
      assert.strictEqual(contradictionReason("a bbq place with vegetarian options", base), null);
    },
  ],
  [
    "no-venues + weather + unmet-constraint messages carry reason + suggestion",
    () => {
      assert.strictEqual(
        noVenuesReason(["dinner", "drinks"], "11:00 PM"),
        "Couldn't find any dinner or drinks spots open around 11:00 PM — everything nearby got filtered out. Try a different time?"
      );
      assert.match(noVenuesReason(["general"], null), /Couldn't find any places —/);
      assert.strictEqual(
        weatherBlockedReason([{ category: "park walk", reason: "rain likely at 8pm" }]),
        "Couldn't plan this one — park walk: rain likely at 8pm. Try an indoor plan?"
      );
      assert.strictEqual(
        unmetConstraintReason("steakhouse", "vegan"),
        "Couldn't find a steakhouse that's really vegan — want to drop a constraint, or try a different kind of place?"
      );
    },
  ],
  [
    "PARTIAL empty: some real picks + ≥1 empty pool → the empty categories",
    () => {
      // ramen empty, bar picked → recovery targets ONLY ramen
      assert.deepStrictEqual(
        partialEmptyCategories([emptyPick("ramen"), pick("bar")]),
        ["ramen"]
      );
      // two empties among picks → both surface, per-category
      assert.deepStrictEqual(
        partialEmptyCategories([pick("dinner"), emptyPick("ramen"), emptyPick("dessert")]),
        ["ramen", "dessert"]
      );
    },
  ],
  [
    "ALL empty or NONE empty → [] (all-empty keeps its own noVenuesReason path)",
    () => {
      // every pool empty → NOT partial (the all-empty net owns this)
      assert.deepStrictEqual(partialEmptyCategories([emptyPick("ramen"), emptyPick("bar")]), []);
      // nothing empty → nothing to recover
      assert.deepStrictEqual(partialEmptyCategories([pick("dinner"), pick("bar")]), []);
      // empty list
      assert.deepStrictEqual(partialEmptyCategories([]), []);
    },
  ],
  [
    "unmet-constraint null picks are NOT treated as empty pools (different failure)",
    () => {
      // a constraint failure (id null + unmetConstraint) is handled by
      // unmetConstraintReason, never routed into recovery
      assert.deepStrictEqual(
        partialEmptyCategories([pick("bar"), unmetPick("steakhouse", "vegan")]),
        []
      );
      // mixed: a real empty pool DOES surface; the unmet one still doesn't
      assert.deepStrictEqual(
        partialEmptyCategories([pick("bar"), emptyPick("ramen"), unmetPick("steakhouse", "vegan")]),
        ["ramen"]
      );
    },
  ],
  [
    "emptyCategoryReason names the objective reason from the drop log",
    () => {
      // the exact Scenario-1 case: only nearby match permanently closed
      assert.strictEqual(
        emptyCategoryReason("ramen", [drop("ramen", "businessStatus", "CLOSED_PERMANENTLY")], "Ossington"),
        "Couldn't find any ramen open near Ossington — the only one nearby is permanently closed."
      );
      // multiple, closed-at-hour
      assert.strictEqual(
        emptyCategoryReason("bar", [drop("bar", "hours"), drop("bar", "hours")], "Ossington"),
        "Couldn't find any bar open near Ossington — the ones nearby are closed at that hour."
      );
      // rating + price phrasings
      assert.match(emptyCategoryReason("cafe", [drop("cafe", "rating")], "Ossington"), /too poorly rated/);
      assert.match(emptyCategoryReason("dinner", [drop("dinner", "price")], "Ossington"), /doesn't fit your budget/);
      // no drops at all (nothing was even returned) → the softer fallback
      assert.strictEqual(
        emptyCategoryReason("ramen", [], "Ossington"),
        "Couldn't find any ramen near Ossington."
      );
      // unspecified/empty location → "nearby", not "near unspecified"
      assert.strictEqual(
        emptyCategoryReason("ramen", [], "unspecified"),
        "Couldn't find any ramen nearby."
      );
    },
  ],
  [
    "widenOfferLabel scopes to the neighbourhood, else a generic city-wide offer",
    () => {
      assert.strictEqual(widenOfferLabel("Ossington"), "Look further than Ossington");
      assert.strictEqual(widenOfferLabel("unspecified"), "Look further out");
      assert.strictEqual(widenOfferLabel(""), "Look further out");
      assert.strictEqual(widenOfferLabel(null), "Look further out");
    },
  ],
];

// ── runner ──
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
