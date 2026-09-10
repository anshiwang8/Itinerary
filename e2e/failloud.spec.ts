// The fail-loud surface, pinned end to end (@mock — fixture-deterministic):
// every degenerate/impossible/contradictory input must land on ONE honest
// message (reason + suggested fix), never an empty map and never an error
// borrowed from the wrong branch. Exact-text assertions on purpose: these
// messages ARE the product behavior the manual-testing bugs were about.
import { test, expect } from "./test";
import {
  dismissClarifyIfShown,
  planEvening,
  planExpectingProblem,
  stripCard,
  expectStripMatchesPin,
} from "./helpers";

const UNPARSEABLE =
  "I couldn't make sense of that. Try describing your evening, like “dinner and drinks in Ossington”.";

// prompt → the exact message it must produce
// DELETED 2026-07-27: "brunch at 3am" and "dinner at 4am" used to be
// pinned here with the plausibility gate's category-window messages. Those
// were refusals based on a hardcoded table's opinion about reasonable
// hours, and the gate is gone — an unusual hour is now PLANNED, and the
// objective hours filter decides what is genuinely open (a 24-hour diner
// at 3 AM is a real answer, not an error). The honest all-closed outcome
// is still covered: see the hours-dominant case below.
const FAIL_LOUD_CASES: Array<[string, string]> = [
  [
    "cheap fancy dinner",
    "That's a bit contradictory, cheap and fancy pull opposite ways.",
  ],
  ["asdfghjkl", UNPARSEABLE],
  // non-row gibberish (vowel-less noise) — used to slip past the mash check
  ["xkjvbz qzwvk", UNPARSEABLE],
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
    "Couldn't plan this one, park walk: rain likely at 3pm. Try an indoor plan?"
  );
});

test("constraints: 'vegan steakhouse' is caught as a contradiction, up front @mock", async ({ page }) => {
  // QA Bug 2: a hard diet vs a venue whose identity is the forbidden thing
  // is a CONTRADICTION, caught before search/select — the parse used to
  // treat "steakhouse" as a mere category and plan a vegan spot under that
  // label. Named-pair message, same voice as "cheap fancy".
  expect(await planExpectingProblem(page, "vegan steakhouse")).toBe(
    "That's a bit contradictory, vegan and steakhouse pull opposite ways."
  );
});

test("constraints: an unmet PROVABLE constraint opens the recovery panel, not a dead end @mock", async ({ page }) => {
  // "patio" IS provable (a real provider boolean), and NO dessert fixture
  // carries it ("patio" lives only on The Standing Room, a bar), so select
  // returns id:null + unmetConstraint. That used to be a hard fail() with
  // no way out; it now reaches the SAME recovery panel an empty pool gets.
  await page.goto("/");
  await page.locator(".prompt__input").fill("dessert with a patio at 8pm in Ossington");
  await page.locator(".prompt__go").click();
  await dismissClarifyIfShown(page);
  await expect(page.locator(".recover")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".recover__reason")).toContainText(/patio/i);
  // NOT a fail-loud surface, and no silent plan behind it
  await expect(page.locator(".empty__err, .stage__err")).toHaveCount(0);
  await expect(page.locator(".lstrip")).toHaveCount(0);
});

test("constraints: 'vegetarian dinner' takes the structured-evidence pick @mock", async ({ page }) => {
  // Noodle Letterpress is the one dinner fixture whose provider field
  // servesVegetarianFood is true. Narrative text alone is never evidence.
  await planEvening(page, "vegetarian dinner");
  await expect(stripCard(page, "Noodle Letterpress")).toBeVisible();
  await expect(page.locator(".lstrip__stop")).toHaveCount(1);
  await expectStripMatchesPin(page, "Noodle Letterpress");
});
