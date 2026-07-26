import type { Page } from "@playwright/test";
import { expect, test } from "./test";

const MAPS_SCRIPT = /^https:\/\/maps\.googleapis\.com\/maps\/api\/js\?/;

// A minimal, local implementation of the exact Maps surface ItineraryMap
// consumes. The provider script normally replaces the bootstrap
// importLibrary function before resolving google.maps.__ib__.
const MAPS_STUB = String.raw`
(() => {
  const namespace = window.google.maps;

  class LatLng {
    constructor(value, lng) {
      this.latitude = typeof value === "object" ? value.lat : value;
      this.longitude = typeof value === "object" ? value.lng : lng;
    }
    lat() { return this.latitude; }
    lng() { return this.longitude; }
  }

  class LatLngBounds {
    extend() { return this; }
  }

  class Map {
    constructor(element) {
      this.element = element;
      element.dataset.providerMap = "ready";
    }
    setCenter() {}
    setZoom() {}
    fitBounds() {}
  }

  class OverlayView {
    setMap(map) {
      this.map = map;
      if (map) {
        if (this.onAdd) this.onAdd();
        if (this.draw) this.draw();
      } else if (this.onRemove) {
        this.onRemove();
      }
    }
    getProjection() {
      return {
        fromLatLngToContainerPixel(point) {
          return {
            x: 320 + (point.lng() + 79.42) * 10000,
            y: 260 - (point.lat() - 43.648) * 10000,
          };
        },
      };
    }
  }

  class Polyline {
    constructor() {
      window.__mapsPolylineCount = (window.__mapsPolylineCount || 0) + 1;
    }
    setMap() {}
  }

  namespace.LatLng = LatLng;
  namespace.LatLngBounds = LatLngBounds;
  namespace.importLibrary = async (name) => {
    if (name === "maps") return { Map, OverlayView, Polyline };
    if (name === "geometry") {
      return { encoding: { decodePath: () => [] } };
    }
    return {};
  };

  namespace.__ib__();
})();
`;

// Authentication failures are delivered by a successfully downloaded Maps
// script, not by the script element's transport error. Mirror that provider
// path by firing the documented global callback and making importLibrary
// reject with Google's InvalidKeyMapError before resolving the bootstrap.
const MAPS_AUTH_FAILURE = String.raw`
(() => {
  const namespace = window.google.maps;
  if (typeof window.gm_authFailure === "function") {
    window.gm_authFailure();
  }
  const error = new Error(
    "Google Maps JavaScript API error: InvalidKeyMapError"
  );
  namespace.importLibrary = async () => { throw error; };
  namespace.__ib__();
})();
`;

type FirstAttemptFailure = "auth" | "transport";

async function failThenServeMaps(
  page: Page,
  firstFailure: FirstAttemptFailure = "transport"
) {
  let attempts = 0;
  const keys: string[] = [];

  await page.route(MAPS_SCRIPT, async (route) => {
    attempts += 1;
    keys.push(new URL(route.request().url()).searchParams.get("key") ?? "");
    if (attempts === 1) {
      if (firstFailure === "auth") {
        await route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: MAPS_AUTH_FAILURE,
        });
        return;
      }
      await route.fulfill({
        status: 403,
        contentType: "application/javascript",
        body: "/* deterministic blocked-script response */",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: MAPS_STUB,
    });
  });

  return {
    attempts: () => attempts,
    keys,
  };
}

test("@mock invalid Maps key auth failure keeps fallback pins usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mapsWindow = window as Window & {
      __mapsAuthFailures?: number;
      gm_authFailure?: () => void;
    };
    mapsWindow.gm_authFailure = () => {
      mapsWindow.__mapsAuthFailures =
        (mapsWindow.__mapsAuthFailures ?? 0) + 1;
    };
  });
  const provider = await failThenServeMaps(page, "auth");
  await page.goto("/test-harness/maps");

  const map = page.locator(".mapwrap");
  await expect(map).toHaveAttribute("data-map-state", "failed");
  expect(
    await page.evaluate(
      () =>
        (
          window as Window & {
            __mapsAuthFailures?: number;
          }
        ).__mapsAuthFailures
    )
  ).toBe(1);
  const fallback = page.locator(".mapfallback");
  await expect(fallback).toContainText(
    "Your itinerary and venue pins are still usable."
  );
  await expect(page.locator(".chip")).toHaveCount(2);
  await page.locator(".chip").first().click();
  await expect(page.locator(".chip").first()).toHaveClass(/chip--selected/);
  expect(provider.attempts()).toBe(1);
  expect(provider.keys).toEqual(["e2e-invalid-browser-key"]);
});

test("@mock an uncertain travel estimate does not draw a solid map route", async ({
  page,
}) => {
  await page.route(MAPS_SCRIPT, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: MAPS_STUB,
    })
  );
  await page.goto("/test-harness/maps");

  await expect(page.locator(".mapwrap")).toHaveAttribute(
    "data-map-state",
    "ready"
  );
  expect(
    await page.evaluate(
      () =>
        (
          window as Window & {
            __mapsPolylineCount?: number;
          }
        ).__mapsPolylineCount ?? 0
    )
  ).toBe(0);
});

test("@mock blocked Maps script keeps fallback pins usable and Retry recovers", async ({
  page,
}) => {
  const provider = await failThenServeMaps(page);
  await page.goto("/test-harness/maps");

  const map = page.locator(".mapwrap");
  await expect(map).toHaveAttribute("data-map-state", "failed");
  const fallback = page.locator(".mapfallback");
  await expect(fallback).toContainText(
    "Your itinerary and venue pins are still usable."
  );
  await expect(page.locator(".chip")).toHaveCount(2);
  await page.locator(".chip").first().click();
  await expect(page.locator(".chip").first()).toHaveClass(/chip--selected/);

  await page.getByRole("button", { name: "Retry map" }).click();

  await expect(map).toHaveAttribute("data-map-state", "ready");
  await expect(page.locator(".map")).toHaveAttribute("data-provider-map", "ready");
  await expect(fallback).toHaveCount(0);
  expect(provider.attempts()).toBe(2);
});

test("@mock remount after a cached Maps rejection starts a clean attempt", async ({
  page,
}) => {
  const provider = await failThenServeMaps(page);
  await page.goto("/test-harness/maps");

  await expect(page.locator(".mapwrap")).toHaveAttribute(
    "data-map-state",
    "failed"
  );
  await page.getByRole("button", { name: "Unmount map" }).click();
  await expect(page.locator(".mapwrap")).toHaveCount(0);
  await page.getByRole("button", { name: "Remount map" }).click();

  await expect(page.locator(".mapwrap")).toHaveAttribute(
    "data-map-state",
    "ready"
  );
  await expect(page.locator(".map")).toHaveAttribute("data-provider-map", "ready");
  await expect(page.locator(".chip")).toHaveCount(2);
  expect(provider.attempts()).toBe(2);
});
