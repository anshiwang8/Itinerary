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
    constructor(options) {
      window.__mapsPolylineCount = (window.__mapsPolylineCount || 0) + 1;
      window.__mapsPolylines = window.__mapsPolylines || [];
      this.record = {
        id: window.__mapsPolylines.length + 1,
        active: Boolean(options.map),
        options,
        setMapCalls: 0,
      };
      window.__mapsPolylines.push(this.record);
    }
    setMap(map) {
      this.record.active = Boolean(map);
      this.record.setMapCalls += 1;
    }
  }

  function decodePath(encoded) {
    window.__mapsDecodeCalls = window.__mapsDecodeCalls || [];
    window.__mapsDecodeCalls.push(encoded);
    if (encoded === "decode-throw") {
      throw new Error("deterministic malformed encoded polyline");
    }
    if (encoded === "decode-empty") return [];
    if (encoded === "decode-one") {
      return [new LatLng({ lat: 43.65, lng: -79.42 })];
    }
    if (encoded === "decode-nonfinite") {
      return [
        new LatLng({ lat: 43.65, lng: -79.42 }),
        new LatLng({ lat: Number.NaN, lng: -79.41 }),
      ];
    }
    if (encoded === "decode-out-of-range") {
      return [
        new LatLng({ lat: 43.65, lng: -79.42 }),
        new LatLng({ lat: 43.66, lng: 181 }),
      ];
    }
    const validStarts = {
      "walk-step": [43.648, -79.421],
      "ride-red": [43.649, -79.42],
      "ride-fallback": [43.65, -79.418],
      "ride-invalid-color": [43.6505, -79.416],
      "ride-blue": [43.651, -79.415],
      "walk-step-two": [43.6511, -79.4149],
      "whole-transit": [43.648, -79.421],
      "plain-walk": [43.6512, -79.4148],
    };
    const start = validStarts[encoded];
    if (!start) return [];
    return [
      new LatLng({ lat: start[0], lng: start[1] }),
      new LatLng({ lat: start[0] + 0.001, lng: start[1] + 0.001 }),
    ];
  }

  namespace.LatLng = LatLng;
  namespace.LatLngBounds = LatLngBounds;
  namespace.importLibrary = async (name) => {
    if (name === "maps") return { Map, OverlayView, Polyline };
    if (name === "geometry") {
      return { encoding: { decodePath } };
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

async function serveMaps(page: Page) {
  await page.route(MAPS_SCRIPT, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: MAPS_STUB,
    })
  );
}

type PolylineSnapshot = {
  id: number;
  active: boolean;
  strokeColor: string | null;
  strokeOpacity: number | null;
  strokeWeight: number | null;
  hasIcons: boolean;
  zIndex: number | null;
};

async function polylineSnapshots(page: Page): Promise<PolylineSnapshot[]> {
  return page.evaluate(() => {
    const mapsWindow = window as Window & {
      __mapsPolylines?: Array<{
        id: number;
        active: boolean;
        options: {
          strokeColor?: string;
          strokeOpacity?: number;
          strokeWeight?: number;
          icons?: unknown[];
          zIndex?: number;
        };
      }>;
    };
    return (mapsWindow.__mapsPolylines ?? []).map((line) => ({
      id: line.id,
      active: line.active,
      strokeColor: line.options.strokeColor ?? null,
      strokeOpacity: line.options.strokeOpacity ?? null,
      strokeWeight: line.options.strokeWeight ?? null,
      hasIcons: Array.isArray(line.options.icons),
      zIndex: line.options.zIndex ?? null,
    }));
  });
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
  await serveMaps(page);
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

test("@mock transit ride steps keep provider colors, skip bad geometry, and leave walk steps deferred", async ({
  page,
}) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute(
    "data-map-state",
    "ready"
  );

  await page.getByRole("button", { name: "Show route specimen" }).click();
  await expect
    .poll(async () => (await polylineSnapshots(page)).filter((line) => line.active).length)
    .toBe(9);

  const active = (await polylineSnapshots(page)).filter((line) => line.active);
  const rideLines = active.filter(
    (line) => line.strokeOpacity === 0.92 && line.strokeWeight === 3.5
  );
  expect(rideLines.map((line) => line.strokeColor)).toEqual([
    "#D71920",
    "#2E6F8A",
    "#2E6F8A",
    "#0066CC",
  ]);
  expect(rideLines.every((line) => !line.hasIcons && line.zIndex === 2)).toBe(
    true
  );

  const halos = active.filter((line) => line.strokeOpacity === 0.22);
  expect(halos.map((line) => line.strokeColor)).toEqual(
    rideLines.map((line) => line.strokeColor)
  );
  expect(halos.every((line) => line.strokeWeight === 8.5 && line.zIndex === 1)).toBe(
    true
  );
  for (let index = 0; index < rideLines.length; index += 1) {
    expect(halos[index].id).toBeLessThan(rideLines[index].id);
  }
  expect(active.some((line) => line.strokeColor === "#C8F000")).toBe(false);
  expect(active.some((line) => line.strokeColor === "#654321")).toBe(false);
  expect(active.some((line) => line.strokeColor === "#123456")).toBe(false);

  const walkLines = active.filter(
    (line) => line.strokeOpacity === 0.92 && line.strokeWeight === 2.5
  );
  expect(walkLines).toEqual([
    expect.objectContaining({
      strokeColor: "#2E6F8A",
      hasIcons: false,
      zIndex: null,
    }),
  ]);

  const decodeCalls = await page.evaluate(
    () =>
      (
        window as Window & {
          __mapsDecodeCalls?: string[];
        }
      ).__mapsDecodeCalls ?? []
  );
  expect(decodeCalls).toEqual([
    "ride-red",
    "ride-fallback",
    "decode-throw",
    "decode-empty",
    "decode-one",
    "decode-nonfinite",
    "decode-out-of-range",
    "ride-invalid-color",
    "ride-blue",
    "plain-walk",
  ]);
  expect(decodeCalls).not.toContain("whole-transit");
  expect(decodeCalls).not.toContain("walk-step");
  expect(decodeCalls).not.toContain("walk-step-two");
});

test("@mock route overlays are replaced on rerender and detached on unmount", async ({
  page,
}) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute(
    "data-map-state",
    "ready"
  );
  await page.getByRole("button", { name: "Show route specimen" }).click();
  await expect
    .poll(async () => (await polylineSnapshots(page)).filter((line) => line.active).length)
    .toBe(9);
  const firstIds = (await polylineSnapshots(page))
    .filter((line) => line.active)
    .map((line) => line.id);

  await page.getByRole("button", { name: "Rerender routes" }).click();
  await expect
    .poll(async () => {
      const lines = await polylineSnapshots(page);
      return {
        active: lines.filter((line) => line.active).length,
        oldStillActive: lines.filter(
          (line) => line.active && firstIds.includes(line.id)
        ).length,
      };
    })
    .toEqual({ active: 9, oldStillActive: 0 });

  await page.getByRole("button", { name: "Unmount map" }).click();
  await expect(page.locator(".mapwrap")).toHaveCount(0);
  await expect
    .poll(async () => (await polylineSnapshots(page)).filter((line) => line.active).length)
    .toBe(0);

  await page.getByRole("button", { name: "Remount map" }).click();
  await expect(page.locator(".mapwrap")).toHaveAttribute(
    "data-map-state",
    "ready"
  );
  await expect
    .poll(async () => (await polylineSnapshots(page)).filter((line) => line.active).length)
    .toBe(9);
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
