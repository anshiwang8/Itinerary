// Tests for the fail-loud plan guards: nonsense, contradictions, empty
// pools, unmet constraints — every bad input gets a reason + suggestion.
// Run with: npx tsx app/lib/planGuards.test.ts
import assert from "node:assert";
import {
  CONTRADICTION_MESSAGE,
  contradictionReason,
  degeneratePromptReason,
  emptyParseReason,
  noVenuesReason,
  UNPARSEABLE_MESSAGE,
  unmetConstraintReason,
  weatherBlockedReason,
} from "./planGuards";
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
    "empty parse signature → unparseable; any extracted signal keeps going",
    () => {
      assert.strictEqual(emptyParseReason(base), UNPARSEABLE_MESSAGE);
      assert.strictEqual(emptyParseReason({ ...base, category_signals: ["dinner"] }), null);
      assert.strictEqual(emptyParseReason({ ...base, time_window: "tonight" }), null);
      assert.strictEqual(emptyParseReason({ ...base, aesthetic: "cozy" }), null);
      assert.strictEqual(emptyParseReason({ ...base, budget: "cheap" }), null);
      assert.strictEqual(emptyParseReason({ ...base, constraints: ["patio"] }), null);
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
