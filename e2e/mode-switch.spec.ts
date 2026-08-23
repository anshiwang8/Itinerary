// Drive-vs-transit mode, Stage 2: switching a LIVE plan's travel mode, end to
// end on the fixtures (@mock).
//
// WHAT THE FIXTURE GEOGRAPHY MAKES THIS PROVE. Every fixture venue sits on the
// Ossington strip ~200-400 m apart while home (Chestnut) is ~2.8 km away, so
// the HOME leg is the one leg long enough for the mode to show at all and the
// inter-stop hops relabel to WALK under `DRIVING_SHORT_LEG_WALK_METERS`. That
// is not a limitation here — it is the Stage 1 invariant on screen a second
// time: a driving plan legitimately contains walk legs, and switching INTO
// driving must not turn those into drives.
//
// THE ASSERTION THAT MATTERS IN EVERY CASE IS THE VENUE LIST. A mode switch
// re-prices travel and must never re-select a place, so each case reads the
// strip's names before and after and requires them identical. The engine suite
// proves the same rule against the availability seam (including the revert-run
// where the clamp is off and the venue really is substituted); this proves it
// through the actual route, store and strip.
//
// NOT COVERED HERE, deliberately: the clamp itself. Making a switch pull a
// stop before its venue opens needs a leg that gets materially SHORTER, and in
// this fixture geography the drive is a minute LONGER than the transit ride.
// That case lives in `modeSwitch.test.ts`, where leg lengths are chosen to the
// minute, and on the owner's live pass.
import { expect, test } from "./test";
import {
  planEvening,
  stripCard,
  swapOn,
  switchMode,
  expectStripMatchesPin,
} from "./helpers";

/** The leg leaving home — the one fixture leg whose mode is discriminating. */
const homeLeg = (page: import("@playwright/test").Page) =>
  page.locator(".lstrip__leg").first();

/** Every venue name on the strip, in order. */
async function venueNames(page: import("@playwright/test").Page): Promise<string[]> {
  const names = page.locator(".lstrip__stop .lstrip__name");
  const count = await names.count();
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push((await names.nth(i).innerText()).trim());
  return out;
}

test("@mock a TRANSIT plan switched to driving re-routes and keeps every venue", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks tonight");
  const before = await venueNames(page);
  expect(before.length).toBeGreaterThan(1);
  await expect(homeLeg(page)).toHaveAttribute("aria-label", "transit leg");

  await switchMode(page, "driving");

  // the home leg is a real drive now, with none of the transit decorations
  const leg = homeLeg(page);
  await expect(leg).toHaveAttribute("aria-label", "driving leg");
  await expect(leg.locator(".lstrip__legline")).toHaveText("Drive");
  await expect(leg.locator(".lstrip__bubble")).toHaveCount(0);
  await expect(leg.locator(".lstrip__walkwarning")).toHaveCount(0);

  // THE LOAD-BEARING ASSERTION: the same places, in the same order.
  expect(await venueNames(page)).toEqual(before);
  // the short strip-to-strip hop is still a WALK inside the driving plan
  await expect(page.locator('[aria-label="walking leg"]').first()).toBeVisible();

  await expect(page.locator(".banner")).toContainText("Now driving");
  for (const name of before) await expectStripMatchesPin(page, name);
});

test("@mock a DRIVING plan switched to transit gets its rides back and keeps every venue", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks tonight", "driving");
  const before = await venueNames(page);
  await expect(homeLeg(page)).toHaveAttribute("aria-label", "driving leg");

  await switchMode(page, "transit");

  const leg = homeLeg(page);
  await expect(leg).toHaveAttribute("aria-label", "transit leg");
  await expect(leg.locator(".lstrip__legline")).not.toHaveText("Drive");
  // the ride is back, badge and all — the colours/board times this restores
  await expect(leg.locator(".lstrip__bubble").first()).toBeVisible();

  expect(await venueNames(page)).toEqual(before);
  await expect(page.locator(".banner")).toContainText("Now taking transit");
  for (const name of before) await expectStripMatchesPin(page, name);
});

test("@mock the toggle shows the plan's CURRENT mode before it offers the other", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks tonight");
  const transit = page.getByRole("radio", { name: "Transit" });
  const drive = page.getByRole("radio", { name: "Drive" });
  await expect(transit).toHaveAttribute("aria-checked", "true");
  await expect(drive).toHaveAttribute("aria-checked", "false");

  await switchMode(page, "driving");
  await expect(transit).toHaveAttribute("aria-checked", "false");
  await expect(drive).toHaveAttribute("aria-checked", "true");
});

test("@mock switching to the mode the plan is already in does nothing at all", async ({
  page,
}) => {
  await planEvening(page, "dinner and drinks tonight");
  const before = await venueNames(page);
  // Whatever the plan already had to say stays exactly as it was — the
  // assertion is "nothing changed", not "there is no banner", because a
  // freshly planned evening may legitimately be showing one already.
  const banner = page.locator(".banner");
  const bannerBefore = (await banner.count()) ? await banner.innerText() : null;

  const requests: string[] = [];
  page.on("request", (request) => {
    if (/\/mode$/.test(request.url())) requests.push(request.url());
  });
  await page.getByRole("radio", { name: "Transit" }).click();
  // Give a request that should never be sent time to be sent.
  await page.waitForTimeout(1_000);

  // Nothing sent, nothing changed, nothing new said about it. The engine
  // holds the same refusal; this is the cheap half, so the user never waits
  // on a request that cannot change anything.
  expect(requests, "a no-op must not reach the server").toEqual([]);
  const bannerAfter = (await banner.count()) ? await banner.innerText() : null;
  expect(bannerAfter, "a no-op must not change what the banner says").toBe(
    bannerBefore
  );
  expect(await venueNames(page)).toEqual(before);
  await expect(page.getByRole("radio", { name: "Transit" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
});

test("@mock a switched plan is still swappable, and the swap keeps the NEW mode", async ({
  page,
}) => {
  // The switch has to actually PERSIST, not just repaint: a mutation minutes
  // later re-prices its legs from the stored mode, so if the switch had only
  // relabelled the plan this leg would come back transit.
  await planEvening(page, "dinner and drinks tonight");
  await switchMode(page, "driving");

  const first = (await venueNames(page))[0];
  await swapOn(page, first, "somewhere else");

  const leg = homeLeg(page);
  await expect(leg).toHaveAttribute("aria-label", "driving leg");
  await expect(leg.locator(".lstrip__legline")).toHaveText("Drive");
  await expect(stripCard(page, first)).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Drive" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
});
