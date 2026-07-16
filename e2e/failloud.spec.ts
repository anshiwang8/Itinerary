// The fail-loud surface, pinned end to end (@mock — fixture-deterministic):
// every degenerate/impossible/contradictory input must land on ONE honest
// message (reason + suggested fix), never an empty map and never an error
// borrowed from the wrong branch. Exact-text assertions on purpose: these
// messages ARE the product behavior the manual-testing bugs were about.
import { test, expect } from "@playwright/test";
import { planEvening, planExpectingProblem, stripCard, expectStripMatchesPin } from "./helpers";

const UNPARSEABLE =
  "I couldn't make sense of that — try describing your evening, like “dinner and drinks in Ossington”.";

// prompt → the exact message it must produce
const FAIL_LOUD_CASES: Array<[string, string]> = [
  [
    "brunch at 3am",
    "Couldn't plan a 3 AM brunch — brunch around here runs about 8 AM to 3 PM. Try a later time?",
  ],
  [
    "dinner at 4am",
    "Couldn't plan a 4 AM dinner — dinner around here runs about 11 AM to 11 PM. Try a later time?",
  ],
  [
    "cheap fancy dinner",
    "That's a bit contradictory — cheap and fancy pull opposite ways. Which matters more?",
  ],
  ["asdfghjkl", UNPARSEABLE],
  [".", UNPARSEABLE],
];

for (const [prompt, message] of FAIL_LOUD_CASES) {
  test(`fail-loud: "${prompt}" gets its own honest message @mock`, async ({ page }) => {
    expect(await planExpectingProblem(page, prompt)).toBe(message);
  });
}

test("empty-pool net: rained-out outdoor plan fails loud, not an empty map @mock", async ({ page }) => {
  // mockWeather rains (precip 80) at 3 PM local every day — an outdoor
  // category "at 3pm" is weather-blocked whether it resolves today or
  // rolls forward to tomorrow, so every pool comes back empty.
  expect(await planExpectingProblem(page, "a walk in the park at 3pm")).toBe(
    "Couldn't plan this one — park walk: rain likely at 3pm. Try an indoor plan?"
  );
});

test("constraints: 'vegan steakhouse' is caught as a contradiction, up front @mock", async ({ page }) => {
  // QA Bug 2: a hard diet vs a venue whose identity is the forbidden thing
  // is a CONTRADICTION, caught before search/select — the parse used to
  // treat "steakhouse" as a mere category and plan a vegan spot under that
  // label. Named-pair message, same voice as "cheap fancy".
  expect(await planExpectingProblem(page, "vegan steakhouse")).toBe(
    "That's a bit contradictory — vegan and steakhouse pull opposite ways. Which matters more?"
  );
});

test("constraints: 'dessert with a patio' hits the unmet-constraint fail-loud @mock", async ({ page }) => {
  // restores the e2e coverage the vegan-steakhouse test carried before it
  // was retargeted at the contradiction guard: a single hard constraint
  // that NO dessert fixture evidences ("patio" lives only on The Standing
  // Room, a bar), with nothing matching the dietary/venue-type
  // contradiction patterns — so it flows past the guard, through select's
  // id:null + unmetConstraint, into the page-level unmetConstraintReason.
  expect(await planExpectingProblem(page, "dessert with a patio at 8pm")).toBe(
    "Couldn't find a dessert that's really patio — want to drop a constraint, or try a different kind of place?"
  );
  // and it must NOT surface as the partial-empty recovery panel — an unmet
  // constraint is a different failure from an empty pool
  await expect(page.locator(".recover")).toHaveCount(0);
});

test("constraints: 'vegan dinner' takes the evidenced pick @mock", async ({ page }) => {
  // Noodle Letterpress is the one dinner fixture whose description
  // evidences "vegan" — the constraint narrows the pool to it, beating
  // the higher-rated Velvet Fig
  await planEvening(page, "vegan dinner");
  await expect(stripCard(page, "Noodle Letterpress")).toBeVisible();
  await expect(page.locator(".lstrip__stop")).toHaveCount(1);
  await expectStripMatchesPin(page, "Noodle Letterpress");
});
