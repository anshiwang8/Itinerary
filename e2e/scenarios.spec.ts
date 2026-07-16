// Interacting-state scenarios from manual testing, pinned on the fixtures
// (@mock — deterministic picks/prices/times). Guards: the price indicator
// follows the swapped venue, the description line is data-driven, the swap
// input takes real keystrokes, repeated swaps cycle cleanly, a reroute
// respects a swapped-then-locked stop, and active stops can't be swapped.
// expectStripMatchesPin runs after every mutation — the strip/map/store
// desync check.
import { test, expect } from "@playwright/test";
import { planEvening, stripCard, swapOn, expectStripMatchesPin } from "./helpers";

// datetime-local value on the PLAN's day (dinner anchors 19:00 and rolls
// forward past 19:00, same rule as resolveStartTime) at the given hour —
// the dev time-sim input drives stop statuses deterministically.
function simAt(hour: number): string {
  const d = new Date();
  d.setHours(19, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hour)}:00`;
}

test("price refresh: a 'cheaper' swap moves the dollar signs $$$ → $$ @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");
  await expect(stripCard(page, "Velvet Fig").locator(".lstrip__price")).toHaveText("$$$");

  await swapOn(page, "Velvet Fig", "cheaper");
  const corner = stripCard(page, "The Corner Table");
  await expect(corner).toBeVisible({ timeout: 15_000 });
  // the indicator must reflect the SWAPPED venue's price — it rides on the
  // stop itself, not the (stale) plan-time pools lookup
  await expect(corner.locator(".lstrip__price")).toHaveText("$$");
  await expectStripMatchesPin(page, "The Corner Table");
  await expectStripMatchesPin(page, "Ten O'Clock Curfew");
});

test("description line: renders when present, absent when missing @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks and dessert");
  await expect(stripCard(page, "Velvet Fig").locator(".lstrip__desc")).toHaveText(
    "Dim-lit modern bistro known for fig-glazed duck and a serious wine list."
  );
  await expect(stripCard(page, "Ten O'Clock Curfew").locator(".lstrip__desc")).toHaveText(
    "Cocktail room with strict hours and stricter pours."
  );
  // Sundown Scoops is the deliberately description-less fixture — no line,
  // no placeholder (keep-on-missing)
  await expect(stripCard(page, "Sundown Scoops")).toBeVisible();
  await expect(stripCard(page, "Sundown Scoops").locator(".lstrip__desc")).toHaveCount(0);
  // the mentor-reported shape: on a description-less venue the SELECTED
  // card's only prose is the pick-reason — it must carry the "why here"
  // label so justification text can never read as a factual description
  await stripCard(page, "Sundown Scoops").click();
  await expect(stripCard(page, "Sundown Scoops").locator(".lstrip__why")).toHaveText(/why here/i);
  await expect(stripCard(page, "Sundown Scoops").locator(".lstrip__desc")).toHaveCount(0);
});

test("swap input accepts spaces (real keystrokes) @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");
  await stripCard(page, "Velvet Fig").click();
  const input = page.locator(".lstrip__swapinput");
  await expect(input).toBeVisible();
  // real key events — the old card-level keydown handler preventDefault-ed
  // bubbled spaces, which would have produced "abitcheaper"
  await input.pressSequentially("a bit cheaper", { delay: 10 });
  await expect(input).toHaveValue("a bit cheaper");
});

test("repeated swaps on one stop: cheaper → fancier → cheaper @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");

  await swapOn(page, "Velvet Fig", "cheaper");
  await expect(stripCard(page, "The Corner Table")).toBeVisible({ timeout: 15_000 });
  await expect(stripCard(page, "The Corner Table").locator(".lstrip__price")).toHaveText("$$");
  await expectStripMatchesPin(page, "The Corner Table");

  // "fancier" re-filters with no budget cap → top-rated Velvet Fig returns
  // (the previous venue is excluded, the one before that is fair game)
  await swapOn(page, "The Corner Table", "fancier");
  await expect(stripCard(page, "Velvet Fig")).toBeVisible({ timeout: 15_000 });
  await expect(stripCard(page, "Velvet Fig").locator(".lstrip__price")).toHaveText("$$$");
  await expectStripMatchesPin(page, "Velvet Fig");

  await swapOn(page, "Velvet Fig", "cheaper");
  await expect(stripCard(page, "The Corner Table")).toBeVisible({ timeout: 15_000 });
  await expect(stripCard(page, "The Corner Table").locator(".lstrip__price")).toHaveText("$$");
  await expectStripMatchesPin(page, "The Corner Table");
  await expectStripMatchesPin(page, "Ten O'Clock Curfew");
});

test("swap then reroute: the swapped, now-active stop survives untouched @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");
  await swapOn(page, "Velvet Fig", "cheaper");
  await expect(stripCard(page, "The Corner Table")).toBeVisible({ timeout: 15_000 });

  // time-travel to mid-dinner: the swapped stop goes active and locks
  await page.locator('.dev input[type="datetime-local"]').fill(simAt(20));
  await expect(stripCard(page, "The Corner Table").locator(".lstrip__now")).toBeVisible();

  // cancel the dinner → drinks leg (dev strip, leg 0 is the default)
  await page.locator(".dev").getByRole("button", { name: "cancel" }).click();
  const banner = page.locator(".banner--show");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText("cancelled. Replanned from");
  await expect(banner).toContainText("your dinner's unchanged");

  // floor rule: the locked swapped stop keeps its venue and its "now";
  // the tail resettled; strip and map still agree everywhere
  await expect(stripCard(page, "The Corner Table").locator(".lstrip__now")).toBeVisible();
  await expectStripMatchesPin(page, "The Corner Table");
  await expectStripMatchesPin(page, "Ten O'Clock Curfew");
});

test("vague-but-sincere prompt: clarify shows, answering lands a general itinerary @mock", async ({ page }) => {
  await page.goto("/");
  await page.locator(".prompt__input").fill("not sure what to do");
  await page.locator(".prompt__go").click();

  // NOT the unparseable rejection — the clarify step appears instead,
  // asking When? and for a vibe (fully vague parse)
  const clarify = page.locator(".clarify");
  await expect(clarify).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".empty__err")).toHaveCount(0);
  await expect(clarify).toContainText("When?");
  await expect(clarify).toContainText("vibe");

  // answer "later today" (deterministic evening anchor at any run hour)
  // and leave the vibe blank — Go continues the pipeline
  await clarify.getByRole("button", { name: "later today" }).click();
  await clarify.getByRole("button", { name: "Go", exact: true }).click();

  // the general "things to do" pool serves the itinerary — a real plan,
  // not an error, and not food-biased (the fixture general pool)
  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
  await expect(stripCard(page, "Fixture General One")).toBeVisible();
  await expectStripMatchesPin(page, "Fixture General One");
});

test("active stop can't be swapped; an upcoming one still can @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");
  await page.locator('.dev input[type="datetime-local"]').fill(simAt(20));

  const dinner = stripCard(page, "Velvet Fig");
  await expect(dinner.locator(".lstrip__now")).toBeVisible();
  await dinner.click();
  // active = locked: no swap prompt on this card
  await expect(page.locator(".lstrip__swapinput")).toHaveCount(0);

  // the upcoming drinks stop still offers the swap prompt
  await stripCard(page, "Ten O'Clock Curfew").click();
  await expect(page.locator(".lstrip__swapinput")).toBeVisible();
});
