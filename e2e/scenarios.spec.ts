// Interacting-state scenarios from manual testing, pinned on the fixtures
// (@mock — deterministic picks/prices/times). Guards: the price indicator
// follows the swapped venue, the description line is data-driven, the swap
// input takes real keystrokes, repeated swaps cycle cleanly, a reroute
// respects a swapped-then-locked stop, and active stops can't be swapped.
// expectStripMatchesPin runs after every mutation — the strip/map/store
// desync check.
import { test, expect } from "./test";
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
  // Two guards in one. (1) The indicator must reflect the SWAPPED venue's
  // price — it rides on the stop itself, not the (stale) plan-time pools
  // lookup. (2) "cheaper" is a DIRECTION relative to the current venue, so
  // the result must be STRICTLY fewer dollar signs than the $$$ it replaced —
  // not merely "some other venue under a flat ≤$$ cap".
  await expect(corner.locator(".lstrip__price")).toHaveText("$$");
  await expect(stripCard(page, "Velvet Fig")).toHaveCount(0);
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

test("price direction: repeated swaps move strictly, and refuse rather than ping-pong @mock", async ({ page }) => {
  // The dinner fixtures top out at $$$ (Velvet Fig AND Brass and Bone), with
  // The Corner Table at $$ and two $ spots. So "fancier" on Velvet Fig has
  // genuinely nowhere UP to go — and the same-tier Brass and Bone is the trap:
  // the old behaviour handed back "any candidate not currently in the plan",
  // and a gate that allowed same-tier would hand back Brass and Bone.
  await planEvening(page, "dinner and drinks");
  await expect(stripCard(page, "Velvet Fig").locator(".lstrip__price")).toHaveText("$$$");

  // 1. "fancier" at the top of the pool REFUSES honestly. Before the fix this
  //    returned The Corner Table — a CHEAPER venue, for a "fancier" request.
  await swapOn(page, "Velvet Fig", "fancier");
  await expect(page.locator(".banner--show")).toContainText(/already the priciest/i, {
    timeout: 15_000,
  });
  await expect(stripCard(page, "Velvet Fig").locator(".lstrip__price")).toHaveText("$$$");
  await expect(stripCard(page, "The Corner Table")).toHaveCount(0);
  // the same-tier trap: a $$$ sibling is NOT "fancier" than a $$$ venue
  await expect(stripCard(page, "Brass and Bone")).toHaveCount(0);
  await expectStripMatchesPin(page, "Velvet Fig");

  // 2. "cheaper" moves STRICTLY down.
  await swapOn(page, "Velvet Fig", "cheaper");
  await expect(stripCard(page, "The Corner Table")).toBeVisible({ timeout: 15_000 });
  await expect(stripCard(page, "The Corner Table").locator(".lstrip__price")).toHaveText("$$");
  await expectStripMatchesPin(page, "The Corner Table");

  // 3. "fancier" moves STRICTLY up — $$$ is the only tier above $$, so
  //    returning to Velvet Fig here is the CORRECT answer, not a bounce.
  await swapOn(page, "The Corner Table", "fancier");
  await expect(stripCard(page, "Velvet Fig")).toBeVisible({ timeout: 15_000 });
  await expect(stripCard(page, "Velvet Fig").locator(".lstrip__price")).toHaveText("$$$");
  await expectStripMatchesPin(page, "Velvet Fig");

  // 4. THE PING-PONG PIN: "fancier" twice in a row must never walk back down.
  //    The old engine returned The Corner Table again here, cycling A→B→A
  //    forever; the direction rule refuses instead and keeps the venue.
  await swapOn(page, "Velvet Fig", "fancier");
  await expect(page.locator(".banner--show")).toContainText(/already the priciest/i, {
    timeout: 15_000,
  });
  await expect(stripCard(page, "Velvet Fig").locator(".lstrip__price")).toHaveText("$$$");
  await expect(stripCard(page, "The Corner Table")).toHaveCount(0);
  // the same-tier trap: a $$$ sibling is NOT "fancier" than a $$$ venue
  await expect(stripCard(page, "Brass and Bone")).toHaveCount(0);
  await expectStripMatchesPin(page, "Velvet Fig");
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

  // answer "this evening" (deterministic evening anchor at any run hour),
  // leave kind/vibe blank — Go continues on the general pool. The WHEN
  // options changed with the planner: now / this afternoon / this evening
  // / pick a time.
  await clarify.getByRole("button", { name: "this evening" }).click();
  await clarify.getByRole("button", { name: "Go", exact: true }).click();

  // the general "things to do" pool serves the itinerary — a real plan,
  // not an error, and not food-biased (the fixture general pool)
  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
  await expect(stripCard(page, "Fixture General One")).toBeVisible();
  await expectStripMatchesPin(page, "Fixture General One");
});

// REWRITTEN 2026-07-27 (planner). This used to assert that BOTH escape
// hatches (Skip and a blank Go) were REFUSED until the user named a kind —
// a mandatory gate that came from stop_count needing a distribution before
// planSlots could resolve. The planner emits the activity list directly, so
// there is no unresolved count to gate on, and refusing to plan for someone
// who declined to answer is exactly the behaviour this whole change exists
// to remove. Skipping now produces a real three-stop plan; answering steers
// it. Both are pinned below.
test("an exact stop count produces every stop, whether or not the kind is answered @mock", async ({ page }) => {
  await page.goto("/");
  await page.locator(".prompt__input").fill("exactly three places at 7pm");
  await page.locator(".prompt__go").click();

  const clarify = page.locator(".clarify");
  await expect(clarify).toBeVisible({ timeout: 30_000 });
  await expect(clarify).toContainText("What kind of thing?");

  // SKIPPING still plans — three stops from the general pool
  await clarify.locator(".clarify__skip").click();
  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
  const skipped = await page.locator(".lstrip__stop .lstrip__name").allInnerTexts();
  expect(skipped).toHaveLength(3);
  expect(new Set(skipped).size).toBe(3);
  for (const name of skipped) await expectStripMatchesPin(page, name);

  // and ANSWERING produces three stops too, of the kind that was chosen
  await page.locator(".topbar__input").fill("exactly three places at 7pm");
  await page.locator(".topbar__go").click();
  await expect(clarify).toBeVisible({ timeout: 30_000 });
  await clarify.getByRole("button", { name: "something to do", exact: true }).click();
  await clarify.getByRole("button", { name: "Go", exact: true }).click();

  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
  const answered = await page.locator(".lstrip__stop .lstrip__name").allInnerTexts();
  expect(answered).toHaveLength(3);
  expect(new Set(answered).size).toBe(3);
  for (const name of answered) await expectStripMatchesPin(page, name);
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
  await clarify.getByRole("button", { name: "this evening" }).click();
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
  await clarify.getByRole("button", { name: "this evening" }).click();
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

// ── category-changing swaps ──────────────────────────────────────────────
// "board games instead" on a dinner must produce a board-game cafe, not
// another restaurant. The fixture interpret returns the shape a real model has
// been seen to return — path "refilter" disagreeing with its own new category,
// and that category ALSO leaked into constraints — so this exercises both
// guarantees through the real engine and the real constraint machinery.
test("swap into a DIFFERENT KIND of place re-kinds the stop @mock", async ({ page }) => {
  await planEvening(page, "dinner and drinks");
  await expect(stripCard(page, "Velvet Fig").locator(".eyebrow")).toHaveText(/dinner/i);

  await swapOn(page, "Velvet Fig", "board games instead");

  // the stop is now a board game cafe, from that pool — NOT another dinner
  const swapped = page.locator(".lstrip__stop").first();
  await expect(swapped.locator(".eyebrow")).toHaveText(/board game cafe/i, { timeout: 15_000 });
  await expect(swapped.locator(".lstrip__name")).toHaveText(/Fixture Board game cafe/);
  await expect(stripCard(page, "Velvet Fig")).toHaveCount(0);
  // If the engine failed to strip the leaked kind from constraints, mockSelect
  // (which runs the real placeMeetsAllConstraints) would answer
  // unmet_constraint and the swap would REFUSE — Velvet Fig would still be
  // here and the assertions above would fail. This is that guarantee, live.
  await expectStripMatchesPin(page, "Fixture Board game cafe One");
  // the drinks stop is untouched: a swap holds its own slot
  await expectStripMatchesPin(page, "Ten O'Clock Curfew");
});

test("a same-kind swap phrase does NOT change the category @mock", async ({ page }) => {
  // The guardrail, end to end: plain dissatisfaction is a different VENUE of
  // the same kind. If "somewhere else" ever started changing categories, this
  // is what would catch it in the product rather than in a unit test.
  await planEvening(page, "dinner and drinks");
  await swapOn(page, "Velvet Fig", "somewhere else");

  const swapped = page.locator(".lstrip__stop").first();
  await expect(swapped.locator(".eyebrow")).toHaveText(/dinner/i, { timeout: 15_000 });
  await expect(swapped.locator(".lstrip__name")).not.toHaveText(/Velvet Fig/);
  await expect(swapped.locator(".lstrip__name")).not.toHaveText(/Fixture/);
});

// ── pushing the later stops back ─────────────────────────────────────────
// Every other fixture is a few hundred metres from the rest of the strip, so
// a swap always fits the gap the schedule left. "Riverside Long Bar" is ~12 km
// out (a ~53-minute fixture transit ride), which is the deterministic way to
// reach a replacement that CANNOT be at its committed start. That used to be
// an outright refusal; it now moves the slot later and cascades.
test("a replacement too far to reach pushes its slot and the stops after it @mock", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks");
  const drinksBefore = await stripCard(page, "Ten O'Clock Curfew")
    .locator(".lstrip__be")
    .innerText();

  await swapOn(page, "Ten O'Clock Curfew", "a riverside bar instead");

  // it committed rather than refusing — the whole point of the feature
  const swapped = stripCard(page, "Riverside Long Bar");
  await expect(swapped).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".banner--show")).toContainText(/can't be reached any earlier/i);

  // and it says so on the card: the pushed stop shows its OLD time struck
  // through beside the new one, because its own slot moved
  await expect(swapped.locator(".old-time")).toBeVisible();
  await expect(swapped.locator(".new-time")).toBeVisible();
  const drinksAfter = await swapped.locator(".lstrip__be").innerText();
  expect(drinksAfter).not.toBe(drinksBefore);

  // strip, map and store still agree on when it is — the desync check
  await expectStripMatchesPin(page, "Riverside Long Bar");
  // dinner is upstream of the change and must not have moved
  await expectStripMatchesPin(page, "Velvet Fig");
  await expect(stripCard(page, "Velvet Fig").locator(".old-time")).toHaveCount(0);
});

test("a push past a STATED end asks first: decline keeps the plan, accept applies it @mock", async ({
  page,
}) => {
  // "from 5-8pm" is a stated FINISH, so the plan carries an end instant the
  // swap engine can check the push against. Without one there is no ceiling
  // and no question — that is the case the test above covers.
  await planEvening(page, "dinner and drinks from 5-8pm");
  const drinksBefore = await stripCard(page, "Ten O'Clock Curfew")
    .locator(".lstrip__be")
    .innerText();

  await swapOn(page, "Ten O'Clock Curfew", "a riverside bar instead");

  // ── it ASKS rather than applying ──
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText(/push your day to .* instead of 8:00 PM/i);

  // ── DECLINE: nothing was ever written, so the plan is exactly as it was ──
  await dialog.getByRole("button", { name: /keep it as it is/i }).click();
  await expect(dialog).toBeHidden();
  await expect(stripCard(page, "Ten O'Clock Curfew")).toBeVisible();
  await expect(stripCard(page, "Riverside Long Bar")).toHaveCount(0);
  expect(
    await stripCard(page, "Ten O'Clock Curfew").locator(".lstrip__be").innerText()
  ).toBe(drinksBefore);
  await expectStripMatchesPin(page, "Ten O'Clock Curfew");

  // ── ACCEPT: the same swap, now with consent, applies the push ──
  await swapOn(page, "Ten O'Clock Curfew", "a riverside bar instead");
  const again = page.getByRole("alertdialog");
  await expect(again).toBeVisible({ timeout: 15_000 });
  await again.getByRole("button", { name: /^continue/i }).click();

  await expect(stripCard(page, "Riverside Long Bar")).toBeVisible({ timeout: 15_000 });
  await expect(stripCard(page, "Ten O'Clock Curfew")).toHaveCount(0);
  await expectStripMatchesPin(page, "Riverside Long Bar");
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
    await expect(cards.nth(0).locator(".lstrip__reason")).toBeHidden();
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

// ── stated windows (Part 5): the planner PROPOSES how much fits; code
// decides once the real travel legs are known ─────────────────────────────
test.describe("@mock stated time windows", () => {
  test("a stated window plans multiple stops that end inside it @mock", async ({ page }) => {
    await planEvening(page, "dinner and drinks from 5-9pm");

    // both stops survive — nothing was dropped, so no window banner at all
    await expect(page.locator(".lstrip__stop")).toHaveCount(2);
    await expect(page.locator(".banner--show")).toHaveCount(0);

    // and every stop genuinely STARTS inside the stated 5-9 PM window —
    // read from the strip's own rendered times, so this fails if the plan
    // silently drifts outside what was asked for
    const times = await page.locator(".lstrip__stop .lstrip__be").allInnerTexts();
    expect(times).toHaveLength(2);
    for (const text of times) {
      const match = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      expect(match, `unparseable stop time "${text}"`).not.toBeNull();
      const hour12 = Number(match![1]) % 12;
      const hour24 = /pm/i.test(match![3]) ? hour12 + 12 : hour12;
      const minutes = hour24 * 60 + Number(match![2]);
      expect(minutes, `"${text}" starts before the 5 PM window`).toBeGreaterThanOrEqual(17 * 60);
      expect(minutes, `"${text}" starts after the 9 PM window`).toBeLessThanOrEqual(21 * 60);
    }
  });

  test("an OVER-STUFFED window drops what doesn't fit and says so @mock", async ({ page }) => {
    // Three stops into a two-hour window. Dinner alone is 105 minutes, so
    // 7-9 fits exactly one of them once travel is counted — and the user
    // must be TOLD, never silently handed a plan running hours over.
    await planEvening(page, "dinner and drinks and dessert from 7-9pm");

    const banner = page.locator(".banner--show");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText(/7-9pm window fits 1 of these 3/i);
    await expect(banner).toContainText(/once travel is counted/i);
    // the dropped activities are NAMED, never silently discarded
    await expect(banner).toContainText(/drinks/i);
    await expect(banner).toContainText(/dessert/i);

    // and the plan that ships is the part that actually fits
    await expect(page.locator(".lstrip__stop")).toHaveCount(1);
    await expect(page.locator(".lstrip__stop .eyebrow").first()).toHaveText(/dinner/i);
  });
});

// ── the "right now" repro (reported live at 11:28 PM) ───────────────────
// The parse LOST immediacy phrasing entirely — "right now" came back
// time_window "unspecified", the resolver fell to the category's default
// start, which had already passed, and the whole plan silently rolled to
// TOMORROW. The deterministic floor now stamps "now" from the raw prompt
// (regardless of what the model returns), and "now" resolves to TONIGHT's
// next full hour. The client clock is frozen at 21:15 so the resolved slot
// (22:00) is deterministic; "drinks" keeps the pool server-hour-proof via
// the hours-less Night Owl fixture (keep-on-missing survivor).
test("'right away' plans TONIGHT's next full hour, never tomorrow @mock", async ({ page }) => {
  await page.addInitScript(`{
    const RealDate = Date;
    const fixed = new RealDate('2026-07-16T21:15:00-04:00').getTime();
    function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
    FakeDate.now = () => fixed;
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    window.Date = FakeDate;
  }`);
  await page.goto("/");
  await page.locator(".prompt__input").fill("drinks right away");
  await page.locator(".prompt__go").click();
  // "drinks" is generic → the (intended) narrowing question shows; the
  // floor already stamped time_window "now", so When? must NOT be asked
  const clarify = page.locator(".clarify");
  await expect(clarify).toBeVisible({ timeout: 30_000 });
  await expect(clarify).not.toContainText("When?");
  await page.getByRole("button", { name: "Skip — just plan it" }).click();

  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 30_000 });
  const be = page.locator(".lstrip__stop .lstrip__be").first();
  // TONIGHT: leave home at the 22:00 slot, arrive within the 10 PM hour
  // (the exact minute is the home leg's travel, which depends on which bar
  // the server-hour filter left standing). Pre-fix this read
  // "tomorrow, 8:00 PM" — bar default 20:00, passed at 21:15, rolled a day.
  await expect(be).toContainText(/be here 10:\d\d PM/);
  await expect(be).not.toContainText("tomorrow");
});
