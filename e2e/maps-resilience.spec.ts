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

  function coordinate(point) {
    if (!point || typeof point !== "object") return null;
    const lat = typeof point.lat === "function" ? point.lat() : point.lat;
    const lng = typeof point.lng === "function" ? point.lng() : point.lng;
    return typeof lat === "number" && typeof lng === "number"
      ? { lat, lng }
      : null;
  }

  function computeDistanceBetween(from, to) {
    const a = coordinate(from);
    const b = coordinate(to);
    if (!a || !b) return Number.NaN;
    const radians = (degrees) => degrees * Math.PI / 180;
    const lat1 = radians(a.lat);
    const lat2 = radians(b.lat);
    const dLat = lat2 - lat1;
    const dLng = radians(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 6371009 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function computeLength(path) {
    const points = Array.isArray(path) ? path : path.getArray();
    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
      total += computeDistanceBetween(points[index - 1], points[index]);
    }
    return total;
  }

  function decodePath(encoded) {
    window.__mapsDecodeCalls = window.__mapsDecodeCalls || [];
    window.__mapsDecodeCalls.push(encoded);
    if (encoded === "decode-throw" || encoded === "walk-decode-throw") {
      throw new Error("deterministic malformed encoded polyline");
    }
    if (encoded === "decode-empty" || encoded === "walk-decode-empty") return [];
    if (encoded === "decode-one" || encoded === "walk-decode-one") {
      return [new LatLng({ lat: 43.65, lng: -79.42 })];
    }
    if (encoded === "walk-decode-malformed") {
      return [null, new LatLng({ lat: 43.65, lng: -79.42 })];
    }
    if (encoded === "decode-nonfinite" || encoded === "walk-decode-nonfinite") {
      return [
        new LatLng({ lat: 43.65, lng: -79.42 }),
        new LatLng({ lat: Number.NaN, lng: -79.41 }),
      ];
    }
    if (encoded === "decode-out-of-range" || encoded === "walk-decode-out-of-range") {
      return [
        new LatLng({ lat: 43.65, lng: -79.42 }),
        new LatLng({ lat: 43.66, lng: 181 }),
      ];
    }
    const paths = {
      "walk-exact-a": [[43.648, -79.421], [43.6484, -79.4206]],
      "walk-exact-b": [[43.6484, -79.4206], [43.6488, -79.4202]],
      "ride-red": [[43.6488, -79.4202], [43.6491, -79.4198]],
      "walk-near-a": [[43.6491, -79.4198], [43.6494, -79.4194]],
      // ~1.33 m from walk-near-a's tail: inside the documented 2 m tolerance.
      "walk-near-b": [[43.649412, -79.4194], [43.6497, -79.419]],
      "ride-fallback": [[43.6497, -79.419], [43.65, -79.418]],
      "ride-invalid-color": [[43.6502, -79.417], [43.6505, -79.416]],
      "ride-blue": [[43.6505, -79.416], [43.6508, -79.4154]],
      "walk-leg-tail": [[43.6508, -79.4154], [43.651, -79.415]],
      // This exact shared endpoint belongs to a NEW itinerary leg.
      "walk-leg-head": [[43.651, -79.415], [43.6513, -79.4145]],
      "ride-green": [[43.6513, -79.4145], [43.6518, -79.414]],
      "walk-break-before": [[43.652, -79.4138], [43.6522, -79.4136]],
      "walk-break-after": [[43.6522, -79.4136], [43.6524, -79.4134]],
      // ~0.33 m total: approximately zero and therefore invisible.
      "walk-decode-zero": [[43.6525, -79.4133], [43.652503, -79.4133]],
      "walk-disconnected-a": [[43.6526, -79.4132], [43.6528, -79.413]],
      "walk-disconnected-b": [[43.6538, -79.412], [43.654, -79.4118]],
      "walk-beyond-a": [[43.6541, -79.4117], [43.6543, -79.4115]],
      // ~2.22 m from walk-beyond-a's tail: outside the 2 m tolerance.
      "walk-beyond-b": [[43.65432, -79.4115], [43.6545, -79.4113]],
      "whole-transit": [[43.648, -79.421], [43.6512, -79.4148]],
      "whole-transit-two": [[43.6512, -79.4148], [43.6542, -79.4098]],
      "plain-walk": [[43.6542, -79.4098], [43.656, -79.405]],
      "ordinary-walk-step": [[43.6542, -79.4098], [43.655, -79.407]],
    };
    const path = paths[encoded];
    if (!path) return [];
    return path.map(([lat, lng]) => new LatLng({ lat, lng }));
  }

  namespace.LatLng = LatLng;
  namespace.LatLngBounds = LatLngBounds;
  namespace.SymbolPath = { CIRCLE: "CIRCLE" };
  namespace.importLibrary = async (name) => {
    if (name === "maps") return { Map, OverlayView, Polyline };
    if (name === "geometry") {
      return {
        encoding: { decodePath },
        spherical: { computeDistanceBetween, computeLength },
      };
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
  path: Array<[number, number]>;
  clickable: boolean | null;
  strokeColor: string | null;
  strokeOpacity: number | null;
  strokeWeight: number | null;
  hasIcons: boolean;
  iconPath: string | number | null;
  iconFillColor: string | null;
  iconFillOpacity: number | null;
  iconStrokeColor: string | null;
  iconStrokeOpacity: number | null;
  iconStrokeWeight: number | null;
  iconScale: number | null;
  iconOffset: string | null;
  iconRepeat: string | null;
  zIndex: number | null;
};

async function polylineSnapshots(page: Page): Promise<PolylineSnapshot[]> {
  return page.evaluate(() => {
    const mapsWindow = window as Window & {
      __mapsPolylines?: Array<{
        id: number;
        active: boolean;
        options: {
          path?: Array<{
            lat: number | (() => number);
            lng: number | (() => number);
          }>;
          clickable?: boolean;
          strokeColor?: string;
          strokeOpacity?: number;
          strokeWeight?: number;
          icons?: Array<{
            icon?: {
              path?: string | number;
              fillColor?: string;
              fillOpacity?: number;
              strokeColor?: string;
              strokeOpacity?: number;
              strokeWeight?: number;
              scale?: number;
            };
            offset?: string;
            repeat?: string;
          }>;
          zIndex?: number;
        };
      }>;
    };
    return (mapsWindow.__mapsPolylines ?? []).map((line) => {
      const iconSequence = line.options.icons?.[0];
      const icon = iconSequence?.icon;
      return {
        id: line.id,
        active: line.active,
        path: (line.options.path ?? []).map((point) => [
          typeof point.lat === "function" ? point.lat() : point.lat,
          typeof point.lng === "function" ? point.lng() : point.lng,
        ] as [number, number]),
        clickable: line.options.clickable ?? null,
        strokeColor: line.options.strokeColor ?? null,
        strokeOpacity: line.options.strokeOpacity ?? null,
        strokeWeight: line.options.strokeWeight ?? null,
        hasIcons: Array.isArray(line.options.icons),
        iconPath: icon?.path ?? null,
        iconFillColor: icon?.fillColor ?? null,
        iconFillOpacity: icon?.fillOpacity ?? null,
        iconStrokeColor: icon?.strokeColor ?? null,
        iconStrokeOpacity: icon?.strokeOpacity ?? null,
        iconStrokeWeight: icon?.strokeWeight ?? null,
        iconScale: icon?.scale ?? null,
        iconOffset: iconSequence?.offset ?? null,
        iconRepeat: iconSequence?.repeat ?? null,
        zIndex: line.options.zIndex ?? null,
      };
    });
  });
}

const ACTIVE_ROUTE_OVERLAY_COUNT = 23;

const WALK_PATHS = {
  exact: [
    [43.648, -79.421],
    [43.6484, -79.4206],
    [43.6488, -79.4202],
  ],
  near: [
    [43.6491, -79.4198],
    [43.6494, -79.4194],
    [43.6497, -79.419],
  ],
  legTail: [
    [43.6508, -79.4154],
    [43.651, -79.415],
  ],
  legHead: [
    [43.651, -79.415],
    [43.6513, -79.4145],
  ],
  beforeMissing: [
    [43.652, -79.4138],
    [43.6522, -79.4136],
  ],
  afterMissing: [
    [43.6522, -79.4136],
    [43.6524, -79.4134],
  ],
  disconnectedA: [
    [43.6526, -79.4132],
    [43.6528, -79.413],
  ],
  disconnectedB: [
    [43.6538, -79.412],
    [43.654, -79.4118],
  ],
  beyondA: [
    [43.6541, -79.4117],
    [43.6543, -79.4115],
  ],
  beyondB: [
    [43.65432, -79.4115],
    [43.6545, -79.4113],
  ],
} satisfies Record<string, Array<[number, number]>>;

const EXPECTED_WALK_PRIMARY_PATHS = [
  WALK_PATHS.exact,
  WALK_PATHS.near,
  WALK_PATHS.legTail,
  WALK_PATHS.legHead,
  WALK_PATHS.beforeMissing,
  WALK_PATHS.afterMissing,
  WALK_PATHS.disconnectedA,
  WALK_PATHS.disconnectedB,
  WALK_PATHS.beyondA,
  WALK_PATHS.beyondB,
];

async function openRouteSpecimen(page: Page): Promise<PolylineSnapshot[]> {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute(
    "data-map-state",
    "ready"
  );
  await page.getByRole("button", { name: "Show route specimen" }).click();
  await expect
    .poll(
      async () =>
        (await polylineSnapshots(page)).filter((line) => line.active).length
    )
    .toBe(ACTIVE_ROUTE_OVERLAY_COUNT);
  return (await polylineSnapshots(page)).filter((line) => line.active);
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

test("@mock transit rides keep provider colors and ordinary walk legs stay solid", async ({
  page,
}) => {
  const active = await openRouteSpecimen(page);
  const rideLines = active.filter(
    (line) => line.strokeOpacity === 0.92 && line.strokeWeight === 3.5
  );
  expect(rideLines.map((line) => line.strokeColor)).toEqual([
    "#D71920",
    "#2E6F8A",
    "#2E6F8A",
    "#0066CC",
    "#00843D",
  ]);
  expect(rideLines.every((line) => !line.hasIcons && line.zIndex === 2)).toBe(
    true
  );

  const halos = active.filter((line) => line.strokeOpacity === 0.22);
  expect(halos.map((line) => line.strokeColor)).toEqual(
    rideLines.slice(0, 4).map((line) => line.strokeColor)
  );
  expect(halos.every((line) => line.strokeWeight === 8.5 && line.zIndex === 1)).toBe(
    true
  );
  for (let index = 0; index < halos.length; index += 1) {
    expect(halos[index].id).toBeLessThan(rideLines[index].id);
  }
  expect(active.some((line) => line.strokeColor === "#C8F000")).toBe(false);
  expect(active.some((line) => line.strokeColor === "#654321")).toBe(false);
  expect(active.some((line) => line.strokeColor === "#123456")).toBe(false);

  const ordinaryWalkLines = active.filter(
    (line) => line.strokeOpacity === 0.92 && line.strokeWeight === 2.5
  );
  expect(ordinaryWalkLines).toEqual([
    expect.objectContaining({
      strokeColor: "#2E6F8A",
      hasIcons: false,
      zIndex: null,
      path: [
        [43.6542, -79.4098],
        [43.656, -79.405],
      ],
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
    "walk-exact-a",
    "walk-exact-b",
    "ride-red",
    "walk-near-a",
    "walk-near-b",
    "ride-fallback",
    "decode-throw",
    "decode-empty",
    "decode-one",
    "decode-nonfinite",
    "decode-out-of-range",
    "ride-invalid-color",
    "ride-blue",
    "walk-leg-tail",
    "walk-leg-head",
    "ride-green",
    "walk-break-before",
    "walk-break-after",
    "walk-decode-throw",
    "walk-decode-malformed",
    "walk-decode-empty",
    "walk-decode-one",
    "walk-decode-nonfinite",
    "walk-decode-out-of-range",
    "walk-decode-zero",
    "walk-disconnected-a",
    "walk-disconnected-b",
    "walk-beyond-a",
    "walk-beyond-b",
    "plain-walk",
  ]);
  expect(decodeCalls).not.toContain("");
  expect(decodeCalls).not.toContain("whole-transit");
  expect(decodeCalls).not.toContain("whole-transit-two");
  expect(decodeCalls).not.toContain("ordinary-walk-step");
});

test("@mock consecutive embedded walks merge only at connected boundaries in provider order", async ({
  page,
}) => {
  const active = await openRouteSpecimen(page);
  const walkPrimaries = active.filter(
    (line) => line.iconPath === "CIRCLE" && line.iconFillOpacity === 0.72
  );

  // Exact path data, not overlay counts, is the contract: order is retained,
  // shared boundaries appear once, and no cross-leg run is manufactured.
  expect(walkPrimaries.map((line) => line.path)).toEqual(
    EXPECTED_WALK_PRIMARY_PATHS
  );
  expect(
    walkPrimaries[0].path.filter(
      ([lat, lng]) => lat === 43.6484 && lng === -79.4206
    )
  ).toHaveLength(1);
  // The ~1.33 m rounded boundary is treated as the same boundary and the
  // second copy is omitted; every retained point is decoder-supplied.
  expect(walkPrimaries[1].path).not.toContainEqual([43.649412, -79.4194]);

  const rideRed = active.find(
    (line) => line.strokeColor === "#D71920" && line.strokeOpacity === 0.92
  );
  expect(rideRed).toBeDefined();
  expect(walkPrimaries[0].id).toBeLessThan(rideRed!.id);
  expect(rideRed!.id).toBeLessThan(walkPrimaries[1].id);

  // These two runs meet at exactly [43.651, -79.415], but belong to
  // different itinerary legs and therefore remain separate native paths.
  expect(walkPrimaries[2].path).toEqual(WALK_PATHS.legTail);
  expect(walkPrimaries[3].path).toEqual(WALK_PATHS.legHead);
});

test("@mock invalid and disconnected embedded walks break runs without fabricated connectors", async ({
  page,
}) => {
  const active = await openRouteSpecimen(page);
  const paths = active
    .filter(
      (line) => line.iconPath === "CIRCLE" && line.iconFillOpacity === 0.72
    )
    .map((line) => line.path);

  // The empty geometry between these two paths breaks the run even though
  // the valid outer boundaries meet exactly.
  expect(paths).toContainEqual(WALK_PATHS.beforeMissing);
  expect(paths).toContainEqual(WALK_PATHS.afterMissing);
  expect(paths).not.toContainEqual([
    ...WALK_PATHS.beforeMissing,
    WALK_PATHS.afterMissing[1],
  ]);

  // Both valid disconnected pairs stay as separate arrays. No Polyline path
  // contains the straight edge that would bridge either gap.
  expect(paths).toContainEqual(WALK_PATHS.disconnectedA);
  expect(paths).toContainEqual(WALK_PATHS.disconnectedB);
  expect(paths).not.toContainEqual([
    ...WALK_PATHS.disconnectedA,
    ...WALK_PATHS.disconnectedB,
  ]);
  expect(paths).toContainEqual(WALK_PATHS.beyondA);
  expect(paths).toContainEqual(WALK_PATHS.beyondB);
  expect(paths).not.toContainEqual([
    ...WALK_PATHS.beyondA,
    ...WALK_PATHS.beyondB,
  ]);

  // Throwing, malformed, empty, one-point, non-finite, out-of-range, and
  // ~0.33 m geometry contributes no point to any walking primary.
  const points = paths.flat();
  expect(points).not.toContainEqual([43.65, -79.42]);
  expect(points).not.toContainEqual([43.6525, -79.4133]);
  expect(points).not.toContainEqual([43.652503, -79.4133]);
  expect(points.some(([lat, lng]) => !Number.isFinite(lat) || !Number.isFinite(lng))).toBe(
    false
  );
  expect(points.some(([lat, lng]) => Math.abs(lat) > 90 || Math.abs(lng) > 180)).toBe(
    false
  );
});

test("@mock embedded walk styling stays neutral and changed emphasis remains dotted", async ({
  page,
}) => {
  const active = await openRouteSpecimen(page);
  const walkPrimaries = active.filter(
    (line) => line.iconPath === "CIRCLE" && line.iconFillOpacity === 0.72
  );
  const walkUnderlays = active.filter(
    (line) => line.iconPath === "CIRCLE" && line.iconFillOpacity === 0.18
  );

  expect(walkPrimaries).toHaveLength(10);
  expect(
    walkPrimaries.every(
      (line) =>
        line.clickable === false &&
        line.strokeColor === null &&
        line.strokeOpacity === 0 &&
        line.strokeWeight === null &&
        line.iconFillColor === "#6B8797" &&
        line.iconStrokeColor === null &&
        line.iconStrokeOpacity === 0 &&
        line.iconStrokeWeight === null &&
        line.iconScale === 1.35 &&
        line.iconOffset === "0" &&
        line.iconRepeat === "10px" &&
        line.zIndex === 2
    )
  ).toBe(true);

  // Only the three runs in the changed inbound leg get emphasis. It is the
  // same gray and the same dotted repeat, but larger and lighter—not solid.
  expect(walkUnderlays).toHaveLength(3);
  expect(walkUnderlays.map((line) => line.path)).toEqual(
    EXPECTED_WALK_PRIMARY_PATHS.slice(0, 3)
  );
  for (let index = 0; index < walkUnderlays.length; index += 1) {
    expect(walkUnderlays[index].id).toBeLessThan(walkPrimaries[index].id);
  }
  expect(
    walkUnderlays.every(
      (line) =>
        line.clickable === false &&
        line.strokeColor === null &&
        line.strokeOpacity === 0 &&
        line.iconFillColor === "#6B8797" &&
        line.iconStrokeOpacity === 0 &&
        line.iconScale === 2.4 &&
        line.iconOffset === "0" &&
        line.iconRepeat === "10px" &&
        line.zIndex === 1
    )
  ).toBe(true);

  const rideLines = active.filter(
    (line) => line.strokeOpacity === 0.92 && line.strokeWeight === 3.5
  );
  expect(walkPrimaries.every((line) => line.iconFillOpacity! < 0.92)).toBe(true);
  expect(rideLines.every((line) => !line.hasIcons)).toBe(true);
  expect(
    [...walkPrimaries, ...walkUnderlays].some(
      (line) =>
        line.iconFillColor === "#C8F000" ||
        line.iconFillColor === "#2E6F8A" ||
        /^#(?:D71920|0066CC|00843D)$/i.test(line.iconFillColor ?? "")
    )
  ).toBe(false);
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
    .toBe(ACTIVE_ROUTE_OVERLAY_COUNT);
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
    .toEqual({ active: ACTIVE_ROUTE_OVERLAY_COUNT, oldStillActive: 0 });

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
    .toBe(ACTIVE_ROUTE_OVERLAY_COUNT);
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
