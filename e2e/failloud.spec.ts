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

test("constraints: 'vegan steakhouse' fails honestly — no hedged pick @mock", async ({ page }) => {
  // the generic steakhouse pool has no vegan evidence → mockSelect returns
  // id:null + unmetConstraint (mirroring the real contract), and the page
  // must surface it — never a steakhouse that "may accommodate vegans"
  expect(await planExpectingProblem(page, "vegan steakhouse")).toBe(
    "Couldn't find a steakhouse that's really vegan — want to drop a constraint, or try a different kind of place?"
  );
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
