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
  // 5pm start so all three fixture picks are open ON ARRIVAL: dinner
  // 17:00–18:45, drinks ~18:55, dessert ~20:15 (Sundown Scoops closes 21).
  // Without the stated time the evening runs late enough that the arrival
  // re-check correctly adapts dessert to Midnight Flour — see the dedicated
  // arrival-adapt test below.
  await planEvening(page, "dinner and drinks and dessert at 5pm");
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

  // NOT the unparseable rejection — the clarify step appears instead.
  // An ultra-vague prompt (no category) gets the batch-4 "what kind of
  // thing?" question ON TOP of When?/vibe.
  const clarify = page.locator(".clarify");
  await expect(clarify).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".empty__err")).toHaveCount(0);
  await expect(clarify).toContainText("What kind of thing?");
  await expect(clarify).toContainText("When?");
  await expect(clarify).toContainText("vibe");

  // answer "later today" (deterministic evening anchor at any run hour),
  // leave kind/vibe blank — Go continues on the general pool
  await clarify.getByRole("button", { name: "later today" }).click();
  await clarify.getByRole("button", { name: "Go", exact: true }).click();

  // the general "things to do" pool serves the itinerary — a real plan,
  // not an error, and not food-biased (the fixture general pool)
  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
  await expect(stripCard(page, "Fixture General One")).toBeVisible();
  await expectStripMatchesPin(page, "Fixture General One");
});

test("clarify: the KIND answer steers the plan, and repeated answers don't leak @mock", async ({ page }) => {
  // batch 4: answering "what kind of thing?" must actually narrow the
  // plan away from the general pool...
  await page.goto("/");
  await page.locator(".prompt__input").fill("not sure what to do");
  await page.locator(".prompt__go").click();
  const clarify = page.locator(".clarify");
  await expect(clarify).toBeVisible({ timeout: 30_000 });
  await clarify.getByRole("button", { name: "drinks", exact: true }).click();
  await clarify.getByRole("button", { name: "later today" }).click();
  await clarify.getByRole("button", { name: "Go", exact: true }).click();

  // "drinks" → the bar pool, NOT the general fixture pool
  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".lstrip__stop .eyebrow").first()).toHaveText(/drinks|bar/i);
  await expect(stripCard(page, "Fixture General One")).toHaveCount(0);

  // ...and a SECOND interaction in the same session must re-resolve from a
  // fresh parse — no category leaking from the first answer (the reported
  // state-leak hypothesis, pinned so it can never become true)
  await page.locator(".topbar__input").fill("not sure what to do");
  await page.locator(".topbar__go").click();
  await expect(clarify).toBeVisible({ timeout: 30_000 });
  // the kind question is asked AGAIN → the parse is vague again, not "bar"
  await expect(clarify).toContainText("What kind of thing?");
  await clarify.getByRole("button", { name: "outdoors", exact: true }).click();
  await clarify.getByRole("button", { name: "later today" }).click();
  await clarify.getByRole("button", { name: "Go", exact: true }).click();
  // now a park plan — the previous "drinks" answer left no trace
  await expect(page.locator(".lstrip__stop .eyebrow").first()).toHaveText(/park/i);
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

// ── duplicate categories (code-audit 2026-07-18 §7.1 / §7.2) ────────────
// "drinks at 7pm then another bar" is TWO stops sharing ONE pool. Before
// the fix, pools keyed by category collapsed them into a single stop and
// the second silently never existed — no message, no recovery panel.
test.describe("@mock duplicate categories", () => {
  test("a repeated category plans TWO stops with DIFFERENT venues @mock", async ({ page }) => {
    await planEvening(page, "drinks at 7pm then another bar");

    const names = await page.locator(".lstrip__stop .lstrip__name").allInnerTexts();
    expect(names.length).toBe(2);
    // the two highest-rated bars open at 7pm, in rating order
    expect(names[0].trim()).toBe("Ten O'Clock Curfew");
    expect(names[1].trim()).toBe("The Standing Room");
    expect(new Set(names.map((n) => n.trim())).size).toBe(2);

    // both cards say "drinks" — the category repeats, the venue must not
    const eyebrows = await page.locator(".lstrip__stop .eyebrow").allInnerTexts();
    // (the eyebrow is uppercased in CSS)
    expect(eyebrows.map((e) => e.trim().toLowerCase())).toEqual(["drinks", "drinks"]);
  });

  test("selecting the SECOND duplicate card acts on that stop, not the first @mock", async ({ page }) => {
    await planEvening(page, "drinks at 7pm then another bar");

    const cards = page.locator(".lstrip__stop");
    // open the second card's swap prompt — identity is the venue id, so
    // this must target The Standing Room, not the first bar (§7.2)
    await cards.nth(1).click();
    const swapBox = cards.nth(1).locator(".lstrip__swap");
    await expect(swapBox).toBeVisible();
    await expect(cards.nth(0).locator(".lstrip__swap")).toHaveCount(0);
    // and the "why here" reason belongs to the second card too
    await expect(cards.nth(1).locator(".lstrip__reason")).toBeVisible();
    await expect(cards.nth(0).locator(".lstrip__reason")).toHaveCount(0);
  });
});

// ── arrival-time correctness (code-audit 2026-07-18 §1.4) ───────────────
// The objective filter judges every category at the PLAN's anchor instant,
// so a later stop used to be filtered on the outing's start time rather
// than on when you actually get there. "dinner and drinks and dessert"
// reaches dessert around 10:15pm; Sundown Scoops (closes 21:00) passed the
// 7pm filter and was shipped anyway — a plan that could not be executed.
test.describe("@mock arrival-time re-check", () => {
  test("a venue that closes before you arrive is adapted away, and said so @mock", async ({ page }) => {
    await planEvening(page, "dinner and drinks and dessert");

    const names = (await page.locator(".lstrip__stop .lstrip__name").allInnerTexts()).map((n) =>
      n.trim()
    );
    expect(names).toHaveLength(3);
    // dessert lands on the late-opening fixture, never the closed one
    expect(names[2]).toBe("Midnight Flour");
    expect(names).not.toContain("Sundown Scoops");
    // and the change is announced, not silent
    await expect(page.locator(".banner")).toContainText(/Midnight Flour/);
    await expect(page.locator(".banner")).toContainText(/closed by the time you got there/i);
  });

  test("every scheduled stop is actually open at its own start time @mock", async ({ page }) => {
    await planEvening(page, "dinner and drinks and dessert");
    // Sundown Scoops shuts at 21:00 and Ten O'Clock Curfew at 22:00 — the
    // plan must not contain any stop starting after its venue's close.
    const cards = page.locator(".lstrip__stop");
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      const name = (await cards.nth(i).locator(".lstrip__name").innerText()).trim();
      const be = (await cards.nth(i).locator(".lstrip__be").innerText()).trim();
      const hour = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(be);
      expect(hour, `stop ${name} has no readable start time: ${be}`).not.toBeNull();
      const h24 =
        (parseInt(hour![1], 10) % 12) + (/pm/i.test(hour![3]) ? 12 : 0);
      if (name === "Sundown Scoops") expect(h24).toBeLessThan(21);
      if (name === "Ten O'Clock Curfew") expect(h24).toBeLessThan(22);
    }
  });
});

// ── generic-category clarify (category presence ≠ category specificity) ──
// "restaurant tonight" used to skip clarification entirely: category
// present, time present, done. But a bare "restaurant" isn't enough to
// search well — it now draws its narrowing question even though a time is
// present, while an already-specific dish ("sushi") still plans straight
// through on the unchanged skip rule.
test.describe("@mock generic-category clarify", () => {
  test("'restaurant tonight' asks the cuisine question; the answer narrows the plan @mock", async ({ page }) => {
    await page.goto("/");
    await page.locator(".prompt__input").fill("restaurant tonight");
    await page.locator(".prompt__go").click();

    const clarify = page.locator(".clarify");
    await expect(clarify).toBeVisible({ timeout: 30_000 });
    await expect(clarify).toContainText("What are you craving?");
    // time was given — the When? question must NOT be re-asked
    await expect(clarify).not.toContainText("When?");

    await clarify.getByRole("button", { name: "Italian", exact: true }).click();
    await clarify.getByRole("button", { name: "Go", exact: true }).click();

    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    // the answer folded onto the category: the stop's eyebrow carries it
    // (cuisine is a PREFIX — "Italian dinner" is still a dinner, so the
    // durations/bands/search plumbing all still match)
    const eyebrow = page.locator(".lstrip__stop .eyebrow").first();
    await expect(eyebrow).toHaveText(/italian dinner/i);
    // and the pick comes from the dinner pool as usual
    await expect(page.locator(".lstrip__stop .lstrip__name").first()).toHaveText("Velvet Fig");
  });

  test("'sushi tonight' is already specific — no questions, straight to a plan @mock", async ({ page }) => {
    await page.goto("/");
    await page.locator(".prompt__input").fill("sushi tonight");
    await page.locator(".prompt__go").click();

    // the plan lands without the clarify step ever appearing
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".clarify")).toHaveCount(0);
    await expect(page.locator(".lstrip__stop .eyebrow").first()).toHaveText(/sushi/i);
  });
});
