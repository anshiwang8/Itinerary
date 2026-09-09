// The starting location field's "Use current location" row.
//
// Everything here runs against mock mode's fixture geocoder, so the reverse
// lookup, the relaxed result acceptance, the city distance check and the
// whole plan pipeline are the real code paths; only the provider data is
// replaced. The device position is Playwright's, set to the SAME anchor
// every mock geocode resolves to (43.6547, -79.3862), which is what keeps
// the fixture travel legs byte-stable for the end-to-end case.
import { expect, test } from "./test";
import { dismissClarifyIfShown, expandDesktopItinerary } from "./helpers";

/** The fixture anchor. Every mock geocode resolves here. */
const FIXTURE_ANCHOR = { latitude: 43.6547, longitude: -79.3862 };

/** What the mock reverse fixture calls that point. */
const FIXTURE_REVERSE_LABEL = "Chestnut St, Toronto, ON, Canada (fixture)";

const startField = "#q-start";
const menu = ".startmenu";
const row = '.startmenu [role="menuitem"]';

/** Count real permission requests, without changing what they do. Proving
 *  the prompt does NOT fire on focus needs the genuine call site, not a
 *  replacement. */
async function countGeolocationCalls(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    (window as unknown as { __geoCalls: number }).__geoCalls = 0;
    const geo = navigator.geolocation;
    const real = geo.getCurrentPosition.bind(geo);
    Object.defineProperty(geo, "getCurrentPosition", {
      configurable: true,
      value: (
        ok: PositionCallback,
        err?: PositionErrorCallback | null,
        options?: PositionOptions
      ) => {
        (window as unknown as { __geoCalls: number }).__geoCalls++;
        return real(ok, err, options);
      },
    });
  });
}

/** Replace the whole API so a failure mode the harness cannot stage (a
 *  timeout, a device that simply cannot answer) is reachable. */
async function stubGeolocationFailure(
  page: import("@playwright/test").Page,
  code: number
) {
  await page.addInitScript((failureCode: number) => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          _ok: PositionCallback,
          err?: PositionErrorCallback | null
        ) => {
          err?.({
            code: failureCode,
            message: "stubbed",
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          } as GeolocationPositionError);
        },
        watchPosition: () => 0,
        clearWatch: () => undefined,
      },
    });
  }, code);
}

test("@mock the field's dropdown opens on focus, holds one row, and asks for nothing until it is chosen", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ ...FIXTURE_ANCHOR, accuracy: 20 });
  await countGeolocationCalls(page);
  await page.goto("/");

  // closed until the field is touched
  await expect(page.locator(menu)).toHaveCount(0);

  await page.locator(startField).click();
  await expect(page.locator(menu)).toBeVisible();
  await expect(page.locator(row)).toHaveCount(1);
  await expect(page.locator(row)).toHaveText("Use current location");

  // FOCUS ASKS FOR NOTHING. A text field must never raise an operating
  // system permission dialog on its own.
  expect(await page.evaluate(() => (window as unknown as { __geoCalls: number }).__geoCalls)).toBe(0);

  // 44px target, on the row that a thumb has to hit
  const box = await page.locator(row).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  // and typing is completely unaffected by the menu being open
  await page.locator(startField).fill("100 Queen Street West");
  await expect(page.locator(startField)).toHaveValue("100 Queen Street West");
  await expect(page.locator(menu)).toBeVisible();
});

test("@mock the dropdown dismisses on Escape and on an outside pointer", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["geolocation"]);
  await page.goto("/");

  await page.locator(startField).click();
  await expect(page.locator(menu)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(menu)).toHaveCount(0);
  // Escape hands focus back to the field, so typing continues where it was
  await expect(page.locator(startField)).toBeFocused();

  await page.locator(startField).click();
  await expect(page.locator(menu)).toBeVisible();
  await page.locator(".prompt__input").click();
  await expect(page.locator(menu)).toHaveCount(0);
});

test("@mock choosing the row fills the field with a real reverse-geocoded label, and the plan runs from it", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ ...FIXTURE_ANCHOR, accuracy: 24 });

  const geocodeBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/geocode", async (route) => {
    geocodeBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.continue();
  });

  await page.goto("/");
  await page.locator(startField).click();
  await page.locator(row).click();

  await expect(page.locator(startField)).toHaveValue(FIXTURE_REVERSE_LABEL);
  // selecting dismisses, and the caret is back in the field
  await expect(page.locator(menu)).toHaveCount(0);
  await expect(page.locator(startField)).toBeFocused();

  // the label lookup carries NO city context: no city has been resolved yet
  const labelCall = geocodeBodies.find((body) => body.kind === "reverse");
  expect(labelCall).toBeTruthy();
  expect(labelCall!.cityContext).toBeUndefined();
  expect(labelCall!.location).toEqual(FIXTURE_ANCHOR);

  await page.locator(".prompt__input").fill("dinner and drinks at 7pm");
  await page.locator(".prompt__go").click();
  await dismissClarifyIfShown(page);
  await expandDesktopItinerary(page, { waitForDock: true });
  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 90_000 });

  // The plan genuinely starts from the device point, under its own name.
  await expect(page.locator(".lstrip__name--home")).toContainText(
    FIXTURE_REVERSE_LABEL
  );

  // AND the guardrail ran: the second reverse call is the one carrying the
  // resolved city, which is where the country and distance rules live.
  const checked = geocodeBodies.filter(
    (body) => body.kind === "reverse" && body.cityContext !== undefined
  );
  expect(checked.length).toBe(1);
  expect(checked[0].location).toEqual(FIXTURE_ANCHOR);
  // and no typed-address lookup was made for a field the user never typed
  expect(geocodeBodies.some((body) => body.kind === "address")).toBe(false);
});

test("@mock typing over a filled location invalidates the coordinate, not just the text", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ ...FIXTURE_ANCHOR, accuracy: 24 });

  const geocodeBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/geocode", async (route) => {
    geocodeBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.continue();
  });

  await page.goto("/");
  await page.locator(startField).click();
  await page.locator(row).click();
  await expect(page.locator(startField)).toHaveValue(FIXTURE_REVERSE_LABEL);

  // the user thinks better of it and types their own address
  await page.locator(startField).fill("100 Queen Street West");

  await page.locator(".prompt__input").fill("dinner and drinks at 7pm");
  await page.locator(".prompt__go").click();
  await dismissClarifyIfShown(page);
  await expandDesktopItinerary(page, { waitForDock: true });
  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 90_000 });

  // THE COORDINATE IS GONE, not merely hidden: the plan resolved the TYPED
  // text through the ordinary forward geocode, and no reverse lookup was
  // sent with a city context.
  const typed = geocodeBodies.filter((body) => body.kind === "address");
  expect(typed.length).toBe(1);
  expect(typed[0].query).toBe("100 Queen Street West");
  expect(
    geocodeBodies.some(
      (body) => body.kind === "reverse" && body.cityContext !== undefined
    )
  ).toBe(false);
  await expect(page.locator(".lstrip__name--home")).toContainText(
    "100 Queen Street West"
  );
});

test("@mock a coarse reading is refused with its own imprecision named, and a good one is not", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["geolocation"]);
  // 12 km: the IP-geolocation regime, well past MAX_FIX_ACCURACY_METERS
  await context.setGeolocation({ ...FIXTURE_ANCHOR, accuracy: 12_000 });
  await page.goto("/");

  await page.locator(startField).click();
  await page.locator(row).click();

  const note = page.locator(".startmenu__note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("12 km");
  // the field is untouched and the menu stays open to retry
  await expect(page.locator(startField)).toHaveValue("");
  await expect(page.locator(row)).toBeEnabled();

  // the same point at a believable accuracy is accepted
  await context.setGeolocation({ ...FIXTURE_ANCHOR, accuracy: 30 });
  await page.locator(row).click();
  await expect(page.locator(startField)).toHaveValue(FIXTURE_REVERSE_LABEL);
});

for (const failure of [
  { name: "denied", code: 1, says: /permission is off/i },
  { name: "unavailable", code: 2, says: /could not provide a location/i },
  { name: "timed out", code: 3, says: /took too long/i },
] as const) {
  test(`@mock a ${failure.name} location leaves the field fully usable`, async ({
    page,
  }) => {
    await stubGeolocationFailure(page, failure.code);
    await page.goto("/");

    await page.locator(startField).click();
    await page.locator(row).click();

    await expect(page.locator(".startmenu__note")).toContainText(failure.says);
    await expect(page.locator(startField)).toHaveValue("");

    // THE POINT OF ALL THREE: manual entry still works, exactly as before.
    await page.locator(startField).fill("100 Queen Street West");
    await expect(page.locator(startField)).toHaveValue("100 Queen Street West");
    await page.keyboard.press("Escape");
    await expect(page.locator(menu)).toHaveCount(0);

    // and so does the rest of the page
    await page.locator(".prompt__input").fill("dinner and drinks at 7pm");
    await page.locator(".prompt__go").click();
    await dismissClarifyIfShown(page);
    await expandDesktopItinerary(page, { waitForDock: true });
    await expect(page.locator(".lstrip")).toBeVisible({ timeout: 90_000 });
  });
}
