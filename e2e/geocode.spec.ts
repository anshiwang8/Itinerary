import { expect, test } from "./test";
import { dismissClarifyIfShown } from "./helpers";

function cityCandidate(options: {
  label: string;
  locality: string;
  administrativeArea: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  timeZone: string;
  placeId: string;
}) {
  return {
    label: options.label,
    formattedAddress: options.label,
    location: {
      latitude: options.latitude,
      longitude: options.longitude,
    },
    timeZone: options.timeZone,
    locality: options.locality,
    administrativeArea: options.administrativeArea,
    country: options.country,
    countryCode: options.countryCode,
    resultTypes: ["locality", "political"],
    bounds: {
      southwest: {
        latitude: options.latitude - 0.1,
        longitude: options.longitude - 0.1,
      },
      northeast: {
        latitude: options.latitude + 0.1,
        longitude: options.longitude + 0.1,
      },
    },
    placeId: options.placeId,
  };
}

const londonOntario = cityCandidate({
  label: "London, ON, Canada",
  locality: "London",
  administrativeArea: "Ontario",
  country: "Canada",
  countryCode: "CA",
  // Mock mode deliberately keeps every geocode at the classic fixture
  // anchor so deterministic Routes fixtures remain byte-stable.
  latitude: 43.6547,
  longitude: -79.3862,
  timeZone: "America/Toronto",
  placeId: "london-ca",
});

const londonEngland = cityCandidate({
  label: "London, England, United Kingdom",
  locality: "London",
  administrativeArea: "England",
  country: "United Kingdom",
  countryCode: "GB",
  latitude: 51.5072,
  longitude: -0.1276,
  timeZone: "Europe/London",
  placeId: "london-gb",
});

const toronto = cityCandidate({
  label: "Toronto, ON, Canada",
  locality: "Toronto",
  administrativeArea: "Ontario",
  country: "Canada",
  countryCode: "CA",
  latitude: 43.6532,
  longitude: -79.3832,
  timeZone: "America/Toronto",
  placeId: "toronto-ca",
});

test("@mock an ambiguous city pauses before search and resumes from the explicit choice", async ({
  page,
}) => {
  let cityCalls = 0;
  let placesCalls = 0;
  await page.route("**/api/geocode", async (route) => {
    const body = route.request().postDataJSON() as { kind?: string };
    if (body.kind !== "city") throw new Error(`unexpected geocode kind ${body.kind}`);
    cityCalls++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "ambiguous",
        queryType: "city",
        code: "geocode_ambiguous",
        message: "More than one city matched. Choose the city you meant.",
        candidates: [londonOntario, londonEngland],
      }),
    });
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/api/places/search")) placesCalls++;
  });

  await page.goto("/");
  await page.getByLabel("Describe your evening").fill("dinner and drinks at 7pm");
  await page.getByLabel("City").fill("London");
  await page.getByRole("button", { name: "Plan it" }).click();
  await dismissClarifyIfShown(page);

  await expect(
    page.getByRole("group", { name: "Choose the city you meant" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Use London, ON, Canada" })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Use London, England, United Kingdom",
    })
  ).toBeVisible();
  expect(placesCalls).toBe(0);

  await page.getByRole("button", { name: "Use London, ON, Canada" }).click();
  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".lstrip__name--home")).toContainText(
    "London, ON, Canada"
  );
  expect(cityCalls).toBe(1);
  expect(placesCalls).toBe(1);
});

test("@mock an ambiguous address receives city context and preserves the selected formatted label", async ({
  page,
}) => {
  let addressBody: Record<string, unknown> = {};
  await page.route("**/api/geocode", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.kind === "city") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          outcome: "resolved",
          queryType: "city",
          ...toronto,
        }),
      });
      return;
    }
    addressBody = body;
    const west = {
      ...toronto,
      label: "100 Queen St W, Toronto, ON, Canada",
      formattedAddress: "100 Queen St W, Toronto, ON, Canada",
      resultTypes: ["street_address"],
      placeId: "queen-west",
    };
    const east = {
      ...west,
      label: "100 Queen St E, Toronto, ON, Canada",
      formattedAddress: "100 Queen St E, Toronto, ON, Canada",
      location: { latitude: 43.6535, longitude: -79.37 },
      placeId: "queen-east",
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "ambiguous",
        queryType: "address",
        code: "geocode_ambiguous",
        message: "More than one starting address matched. Choose the address you meant.",
        candidates: [west, east],
      }),
    });
  });

  await page.goto("/");
  await page.getByLabel("Describe your evening").fill("dinner and drinks at 7pm");
  await page.getByLabel("Starting address").fill("100 Queen Street");
  await page.getByRole("button", { name: "Plan it" }).click();
  await dismissClarifyIfShown(page);

  await expect(
    page.getByRole("group", { name: "Choose your starting address" })
  ).toBeVisible();
  expect(addressBody.query).toBe("100 Queen Street");
  expect(
    (addressBody.cityContext as { countryCode?: string } | undefined)
      ?.countryCode
  ).toBe("CA");

  await page
    .getByRole("button", {
      name: "Use 100 Queen St E, Toronto, ON, Canada",
    })
    .click();
  await expect(page.locator(".lstrip")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".lstrip__name--home")).toContainText(
    "100 Queen St E, Toronto, ON, Canada"
  );
});
