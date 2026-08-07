import assert from "node:assert";
import {
  hardPriceLevelMaximum,
  parseBudget,
  parsePriceDirection,
  priceDirectionSearchTerm,
  rankByPriceDirection,
} from "./budget";

const FREE = "PRICE_LEVEL_FREE";
const CHEAP = "PRICE_LEVEL_INEXPENSIVE";
const MID = "PRICE_LEVEL_MODERATE";
const DEAR = "PRICE_LEVEL_EXPENSIVE";
const DEAREST = "PRICE_LEVEL_VERY_EXPENSIVE";

const v = (id: string, priceLevel?: string) => ({ id, priceLevel });
const ids = (list: Array<{ id: string }>) => list.map((p) => p.id);

const cases: Array<[string, () => void]> = [
  [
    "relative symbols and language produce defensible Places caps",
    () => {
      const one = parseBudget("$");
      const two = parseBudget("$$");
      const cheap = parseBudget("budget");
      assert.deepStrictEqual(one, { kind: "places-level", maxLevel: 1, raw: "$" });
      assert.deepStrictEqual(two, { kind: "places-level", maxLevel: 2, raw: "$$" });
      assert.deepStrictEqual(cheap, { kind: "relative", level: "cheap", raw: "budget" });
      assert.strictEqual(hardPriceLevelMaximum(one), 1);
      assert.strictEqual(hardPriceLevelMaximum(two), 2);
      assert.strictEqual(hardPriceLevelMaximum(cheap), 2);
    },
  ],
  [
    "numeric maxima retain amount and currency without inventing a Places cap",
    () => {
      assert.deepStrictEqual(parseBudget("under $20"), {
        kind: "numeric-max",
        amount: 20,
        currency: "USD",
        raw: "under $20",
      });
      assert.deepStrictEqual(parseBudget("under $300"), {
        kind: "numeric-max",
        amount: 300,
        currency: "USD",
        raw: "under $300",
      });
      assert.deepStrictEqual(parseBudget("under €30"), {
        kind: "numeric-max",
        amount: 30,
        currency: "EUR",
        raw: "under €30",
      });
      assert.deepStrictEqual(parseBudget("under 30€"), {
        kind: "numeric-max",
        amount: 30,
        currency: "EUR",
        raw: "under 30€",
      });
      assert.deepStrictEqual(parseBudget("under $1,000"), {
        kind: "numeric-max",
        amount: 1000,
        currency: "USD",
        raw: "under $1,000",
      });
      assert.deepStrictEqual(parseBudget("up to 40 CAD"), {
        kind: "numeric-max",
        amount: 40,
        currency: "CAD",
        raw: "up to 40 CAD",
      });
      assert.strictEqual(hardPriceLevelMaximum(parseBudget("under $20")), null);
      assert.strictEqual(hardPriceLevelMaximum(parseBudget("under $300")), null);
      assert.strictEqual(parseBudget("under $1,000 CAD"), null);
    },
  ],
  [
    "parseBudget still represents NO upward signal — the reason direction is its own parser",
    () => {
      // the defect this whole slice exists for: every expensive-ward phrase
      // falls through parseBudget to null, so the objective filter's price
      // rule never fires and the selector is handed budget:null
      for (const raw of ["fancier", "upscale", "splurge", "$$$", "$$$$", "more expensive"]) {
        assert.strictEqual(parseBudget(raw), null, `parseBudget(${raw})`);
      }
      // ...and the cap it CAN produce is a maximum, never a minimum
      assert.strictEqual(hardPriceLevelMaximum(parseBudget("cheap")), 2);
    },
  ],
  [
    "parsePriceDirection reads up-ward and down-ward phrasing",
    () => {
      for (const raw of [
        "fancier",
        "somewhere fancier",
        "somewhere fancy",
        "nicer",
        "more upscale",
        "posh",
        "classier",
        "swanky",
        "bougie",
        "pricier",
        "more expensive",
        "splurge a bit",
        "high end",
        "high-end",
        "fine dining",
        "$$$",
        "$$$$",
      ]) {
        assert.strictEqual(parsePriceDirection(raw), "up", `up: ${raw}`);
      }
      for (const raw of [
        "cheaper",
        "somewhere cheaper",
        "cheap",
        "budget",
        "inexpensive",
        "more affordable",
        "low cost",
      ]) {
        assert.strictEqual(parsePriceDirection(raw), "down", `down: ${raw}`);
      }
    },
  ],
  [
    "a NEGATED up-word is a DOWN request, not an up one",
    () => {
      // every string here also matches the up pattern; testing negation first
      // is the only thing that keeps them from reading exactly backwards
      for (const raw of [
        "less fancy",
        "not so fancy",
        "not too expensive",
        "nothing fancy",
        "nothing too posh",
        "less of a splurge",
        "not as pricey",
        "no fancier than this",
      ]) {
        assert.strictEqual(parsePriceDirection(raw), "down", `negated: ${raw}`);
      }
    },
  ],
  [
    "parsePriceDirection stays silent on refinements that are not about price",
    () => {
      for (const raw of [
        "",
        "   ",
        "an hour earlier",
        "after 8",
        "stay 2 hours",
        "somewhere with a patio",
        "closer",
        "walking distance",
        "don't like it",
        "something else",
        "higher rated",
        "a different cuisine",
        // "$"/"$$" already mean a hard ceiling through parseBudget; taking
        // them over as a DIRECTION would change shipped behaviour
        "$",
        "$$",
        // British "fancy" is a verb here, not a price tier
        "fancy a drink instead",
        "fancy the patio one",
        // a loose negation window used to swallow this and call it "down"
        "no patio, want fancier",
      ]) {
        const expected = raw === "no patio, want fancier" ? "up" : null;
        assert.strictEqual(parsePriceDirection(raw), expected, `silent: "${raw}"`);
      }
      assert.strictEqual(parsePriceDirection(null), null);
      assert.strictEqual(parsePriceDirection(undefined), null);
    },
  ],
  [
    "the search term is punctuation-free (it is prepended verbatim into a Places query)",
    () => {
      for (const direction of ["up", "down"] as const) {
        const term = priceDirectionSearchTerm(direction);
        assert.match(term, /^[a-z]+(?: [a-z]+)*$/, `"${term}" must be plain words`);
      }
      assert.notStrictEqual(
        priceDirectionSearchTerm("up"),
        priceDirectionSearchTerm("down")
      );
    },
  ],
  [
    "rankByPriceDirection UP keeps only STRICTLY pricier, priciest first",
    () => {
      const pool = [
        v("cheap", CHEAP),
        v("same", MID),
        v("dear", DEAR),
        v("dearest", DEAREST),
        v("free", FREE),
      ];
      const { ranked, unpriced, bestEffort } = rankByPriceDirection(pool, MID, "up");
      assert.deepStrictEqual(ids(ranked), ["dearest", "dear"]);
      assert.deepStrictEqual(unpriced, []);
      assert.strictEqual(bestEffort, false);
    },
  ],
  [
    "rankByPriceDirection DOWN keeps only STRICTLY cheaper, cheapest first",
    () => {
      const pool = [
        v("dear", DEAR),
        v("same", MID),
        v("cheap", CHEAP),
        v("free", FREE),
      ];
      const { ranked, bestEffort } = rankByPriceDirection(pool, MID, "down");
      assert.deepStrictEqual(ids(ranked), ["free", "cheap"]);
      assert.strictEqual(bestEffort, false);
    },
  ],
  [
    "SAME TIER is never in direction — this is the whole ping-pong guarantee",
    () => {
      // the reported bug: a ramen shop swapped for another ramen shop at the
      // SAME price, then back again. A same-tier pool must yield nothing.
      const sameTier = [v("a", MID), v("b", MID), v("c", MID)];
      assert.deepStrictEqual(ids(rankByPriceDirection(sameTier, MID, "up").ranked), []);
      assert.deepStrictEqual(ids(rankByPriceDirection(sameTier, MID, "down").ranked), []);
      // and the boundaries: nothing is pricier than the top tier, nothing
      // cheaper than free
      assert.deepStrictEqual(
        ids(rankByPriceDirection([v("x", DEAR), v("y", DEAREST)], DEAREST, "up").ranked),
        []
      );
      assert.deepStrictEqual(
        ids(rankByPriceDirection([v("x", FREE), v("y", CHEAP)], FREE, "down").ranked),
        []
      );
    },
  ],
  [
    "DOWN is relative to the CURRENT venue, not a flat ≤$$ cap",
    () => {
      // the old "cheaper" behaviour capped at MODERATE, so on a $$$$ stop the
      // genuinely-cheaper $$$ option was invisible. Relative keeps it.
      const pool = [v("dear", DEAR), v("mid", MID)];
      assert.deepStrictEqual(ids(rankByPriceDirection(pool, DEAREST, "down").ranked), [
        "mid",
        "dear",
      ]);
      // ...and the same flat cap would have let a $ stop "get cheaper" into
      // a $$ venue, which is upward. Relative refuses instead.
      assert.deepStrictEqual(
        ids(rankByPriceDirection([v("mid", MID)], CHEAP, "down").ranked),
        []
      );
    },
  ],
  [
    "no price on the CURRENT venue is BEST EFFORT, never a refusal",
    () => {
      const pool = [v("cheap", CHEAP), v("dearest", DEAREST), v("mid", MID)];
      const up = rankByPriceDirection(pool, undefined, "up");
      assert.strictEqual(up.bestEffort, true);
      assert.deepStrictEqual(ids(up.ranked), ["dearest", "mid", "cheap"]);
      const down = rankByPriceDirection(pool, undefined, "down");
      assert.strictEqual(down.bestEffort, true);
      assert.deepStrictEqual(ids(down.ranked), ["cheap", "mid", "dearest"]);
      // an unrecognised provider string is "no price", not rank 0
      assert.strictEqual(
        rankByPriceDirection(pool, "PRICE_LEVEL_UNSPECIFIED", "up").bestEffort,
        true
      );
    },
  ],
  [
    "KEEP-ON-MISSING: an unpriced candidate is never dropped, and never ranked",
    () => {
      const pool = [v("noprice"), v("dear", DEAR), v("alsonone"), v("cheap", CHEAP)];
      const { ranked, unpriced } = rankByPriceDirection(pool, MID, "up");
      // proven-in-direction only
      assert.deepStrictEqual(ids(ranked), ["dear"]);
      // ...but the unpriced ones are reported, in pool order, rather than
      // being filtered out for lacking data. Reported is not RANKED: the
      // caller may log or explain them, never answer a price request with one.
      assert.deepStrictEqual(ids(unpriced), ["noprice", "alsonone"]);
      // even when NOTHING is in direction, they are still handed back
      const stuck = rankByPriceDirection(pool, DEAREST, "up");
      assert.deepStrictEqual(ids(stuck.ranked), []);
      assert.deepStrictEqual(ids(stuck.unpriced), ["noprice", "alsonone"]);
      // and that refusal IS about price: two candidates were priced and
      // neither beat $$$$, which is a different fact from "nothing had a price"
      assert.strictEqual(stuck.comparable, true);
    },
  ],
  [
    "COMPARABLE: nothing priced to compare against is its own fact — the park case",
    () => {
      // Places populates priceLevel for food and drink and leaves parks and
      // attractions blank, so a direction request on one of those has no
      // price signal on EITHER side: no fancier/cheaper to deliver, and no
      // honest "it's already the priciest" to say either.
      const parks = [v("green"), v("commons"), v("quay")];
      const none = rankByPriceDirection(parks, undefined, "up");
      assert.strictEqual(none.comparable, false);
      assert.strictEqual(none.bestEffort, true);
      assert.deepStrictEqual(ids(none.ranked), []);
      // nothing was dropped — they are all still here, just unanswerable
      assert.deepStrictEqual(ids(none.unpriced), ["green", "commons", "quay"]);

      // a KNOWN current price does not make the pool comparable: knowing what
      // you have says nothing about what is on offer
      const currentOnly = rankByPriceDirection(parks, MID, "up");
      assert.strictEqual(currentOnly.comparable, false);
      assert.deepStrictEqual(ids(currentOnly.ranked), []);

      // ONE priced candidate is enough for a real comparison — strictly...
      assert.strictEqual(
        rankByPriceDirection([v("a"), v("b", MID)], DEAR, "down").comparable,
        true
      );
      // ...and on the best-effort path, where it is also what keeps that path
      // working: a priced candidate is exactly what `ranked` is drawn from
      const effort = rankByPriceDirection([v("a"), v("b", MID)], undefined, "up");
      assert.strictEqual(effort.comparable, true);
      assert.deepStrictEqual(ids(effort.ranked), ["b"]);

      // an empty pool compares nothing
      assert.strictEqual(rankByPriceDirection([], MID, "up").comparable, false);
    },
  ],
  [
    "ranking is pure: it never mutates or drops the caller's array",
    () => {
      const pool = [v("a", DEAR), v("b", CHEAP), v("c")];
      const snapshot = ids(pool);
      const { ranked, unpriced } = rankByPriceDirection(pool, MID, "up");
      assert.deepStrictEqual(ids(pool), snapshot, "input array reordered");
      // every candidate is accounted for in exactly one bucket
      const seen = [...ids(ranked), ...ids(unpriced)].sort();
      assert.deepStrictEqual(seen, ["a", "c"]);
      assert.deepStrictEqual(ids(rankByPriceDirection([], MID, "up").ranked), []);
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
