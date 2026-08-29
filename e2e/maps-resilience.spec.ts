import type { Locator, Page } from "@playwright/test";
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
    constructor() {
      this.points = [];
    }
    extend(point) {
      const value = coordinate(point);
      if (value) this.points.push(value);
      return this;
    }
    getCenter() {
      if (this.points.length === 0) return new LatLng({ lat: 0, lng: 0 });
      const lats = this.points.map((point) => point.lat);
      const lngs = this.points.map((point) => point.lng);
      return new LatLng({
        lat: (Math.min(...lats) + Math.max(...lats)) / 2,
        lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      });
    }
  }

  class Map {
    constructor(element, options) {
      this.element = element;
      this.zoom = (options && typeof options.zoom === "number") ? options.zoom : 14;
      this.center = coordinate((options && options.center) || null);
      this._listeners = {};
      element.dataset.providerMap = "ready";
      // A handle for the drag/scroll-zoom simulation below: the real API fires
      // "bounds_changed" continuously during a user gesture and "idle" once
      // when it settles. Nothing in production reaches the map object this
      // way; this is purely so a test can drive those two events without going
      // through the chip-click focus-request path.
      window.__mapsLastMap = this;
    }
    // Test-only: fire one gesture frame / the gesture settling, synchronously,
    // WITHOUT recording a camera call or mutating center/zoom.
    __fireBoundsChanged() {
      (this._listeners["bounds_changed"] || []).forEach((h) => h());
    }
    __fireIdle() {
      (this._listeners["idle"] || []).forEach((h) => h());
    }
    getZoom() {
      return this.zoom;
    }
    getCenter() {
      return this.center ? new LatLng(this.center) : undefined;
    }
    // A real MVCObject listener: production code uses map.addListener("idle", ...)
    // to know when a pan/zoom settles. Fired async (a microtask) so a caller
    // that issues setZoom() then panTo() in the same synchronous block still
    // only observes settling once, after both have registered.
    addListener(name, handler) {
      (this._listeners[name] = this._listeners[name] || []).push(handler);
      return {
        remove: () => {
          this._listeners[name] = (this._listeners[name] || []).filter(
            (h) => h !== handler
          );
        },
      };
    }
    _fire(name) {
      Promise.resolve().then(() => {
        (this._listeners[name] || []).forEach((h) => h());
      });
    }
    setCenter(point) {
      this.center = coordinate(point);
      window.__mapsSetCenters = window.__mapsSetCenters || [];
      window.__mapsSetCenters.push(coordinate(point));
      this._fire("idle");
    }
    panTo(point) {
      this.center = coordinate(point);
      window.__mapsPanTos = window.__mapsPanTos || [];
      window.__mapsPanTos.push(coordinate(point));
      this._fire("idle");
    }
    setZoom(zoom) {
      this.zoom = zoom;
      window.__mapsSetZooms = window.__mapsSetZooms || [];
      window.__mapsSetZooms.push(zoom);
      this._fire("idle");
    }
    // Real Maps: "Immediately sets the map's camera to the target camera
    // options, without animation." Production code drives its own rAF tween
    // (app/lib/cameraTween.ts) and calls this once per frame with both
    // center and zoom together, which is what the recorder below captures.
    moveCamera(options) {
      const center = options && options.center ? coordinate(options.center) : null;
      const zoom = options && typeof options.zoom === "number" ? options.zoom : null;
      if (center) this.center = center;
      if (zoom !== null) this.zoom = zoom;
      window.__mapsMoveCameraCalls = window.__mapsMoveCameraCalls || [];
      window.__mapsMoveCameraCalls.push({ center, zoom });
      this._fire("idle");
    }
    fitBounds(bounds) {
      window.__mapsFitBoundsCalls = window.__mapsFitBoundsCalls || [];
      window.__mapsFitBoundsCalls.push(
        (bounds.points || []).map((point) => [point.lat, point.lng])
      );
      this._fire("idle");
    }
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
      "ride-blue": [[43.656, -79.405], [43.6575, -79.402]],
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
      "visibility-home-walk": [[43.648, -79.421], [43.6482, -79.4208]],
      "visibility-home-ride-local": [[43.6482, -79.4208], [43.6485, -79.4205]],
      "visibility-home-transfer-walk": [[43.6485, -79.4205], [43.6487, -79.4203]],
      "visibility-home-ride-crosstown": [[43.6487, -79.4203], [43.649, -79.42]],
      "visibility-walk-decoded": [[43.649, -79.42], [43.6495, -79.4195], [43.65, -79.419]],
      "visibility-walk-manual": [[43.651, -79.418], [43.6515, -79.4175], [43.652, -79.417]],
      "visibility-transit-changed": [[43.652, -79.417], [43.6525, -79.4165], [43.653, -79.416]],
      // a driving leg's real road shape: three points that do NOT match the
      // straight line between its two venues
      "drive-road": [[43.648, -79.4214], [43.6505, -79.4155], [43.656, -79.405]],
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
      const geometry = {
        encoding: { decodePath },
        spherical: { computeDistanceBetween, computeLength },
      };
      namespace.geometry = geometry;
      return geometry;
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

async function activePolylines(page: Page): Promise<PolylineSnapshot[]> {
  return (await polylineSnapshots(page)).filter((line) => line.active);
}

async function decodeCalls(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __mapsDecodeCalls?: string[];
        }
      ).__mapsDecodeCalls ?? []
  );
}

async function resetDecodeCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as Window & {
        __mapsDecodeCalls?: string[];
      }
    ).__mapsDecodeCalls = [];
  });
}

async function fitBoundsCalls(page: Page): Promise<Array<Array<[number, number]>>> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __mapsFitBoundsCalls?: Array<Array<[number, number]>>;
        }
      ).__mapsFitBoundsCalls ?? []
  );
}

async function setZoomCalls(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __mapsSetZooms?: number[];
        }
      ).__mapsSetZooms ?? []
  );
}

type MoveCameraCall = { center: { lat: number; lng: number } | null; zoom: number | null };

async function moveCameraCalls(page: Page): Promise<MoveCameraCall[]> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __mapsMoveCameraCalls?: MoveCameraCall[];
        }
      ).__mapsMoveCameraCalls ?? []
  );
}

async function setCenterCalls(
  page: Page
): Promise<Array<{ lat: number; lng: number } | null>> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __mapsSetCenters?: Array<{ lat: number; lng: number } | null>;
        }
      ).__mapsSetCenters ?? []
  );
}

function overlaySignature(
  line: PolylineSnapshot
): Omit<PolylineSnapshot, "id" | "active"> {
  const { id, active, ...signature } = line;
  void id;
  void active;
  return signature;
}

type ElementColor = { background: string; foreground: string };

async function elementColors(locator: Locator): Promise<ElementColor[]> {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        foreground: style.color,
      };
    })
  );
}

const ACTIVE_ROUTE_OVERLAY_COUNT = 23;
const APP_RIDE_COLORS = {
  slot0: "#005A9C",
  slot1: "#9A4D00",
  slot2: "#006B57",
  slot3: "#A31545",
} as const;
const APP_RIDE_CSS_COLORS = {
  slot0: "rgb(0, 90, 156)",
  slot1: "rgb(154, 77, 0)",
  slot3: "rgb(163, 21, 69)",
  white: "rgb(255, 255, 255)",
} as const;
const FIRST_RIDE_PATH: Array<[number, number]> = [
  [43.6488, -79.4202],
  [43.6491, -79.4198],
];
const LATER_SHARED_RIDE_PATH: Array<[number, number]> = [
  [43.6497, -79.419],
  [43.65, -79.418],
];

const VISIBILITY_PATHS = {
  homeWalk: [
    [43.648, -79.421],
    [43.6482, -79.4208],
  ],
  homeLocal: [
    [43.6482, -79.4208],
    [43.6485, -79.4205],
  ],
  homeTransferWalk: [
    [43.6485, -79.4205],
    [43.6487, -79.4203],
  ],
  homeCrosstown: [
    [43.6487, -79.4203],
    [43.649, -79.42],
  ],
  decodedWalk: [
    [43.649, -79.42],
    [43.6495, -79.4195],
    [43.65, -79.419],
  ],
  fallbackWalk: [
    [43.65, -79.419],
    [43.651, -79.418],
  ],
  manualWalk: [
    [43.651, -79.418],
    [43.6515, -79.4175],
    [43.652, -79.417],
  ],
  changedTransit: [
    [43.652, -79.417],
    [43.6525, -79.4165],
    [43.653, -79.416],
  ],
} satisfies Record<string, Array<[number, number]>>;

const HOME_DECODE_SIGNATURES = [
  "visibility-home-walk",
  "visibility-home-ride-local",
  "visibility-home-transfer-walk",
  "visibility-home-ride-crosstown",
];

function linesForPath(
  lines: PolylineSnapshot[],
  path: Array<[number, number]>
): PolylineSnapshot[] {
  const signature = JSON.stringify(path);
  return lines.filter((line) => JSON.stringify(line.path) === signature);
}

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

async function openVisibilitySpecimen(page: Page): Promise<void> {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute(
    "data-map-state",
    "ready"
  );
  await page.getByRole("button", { name: "Show visibility specimen" }).click();
  await expect(page.getByTestId("visibility-strip-specimen")).toHaveCount(1);
  await expect(page.getByTestId("visibility-strip-specimen").locator(".lstrip")).toBeVisible();
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.homeLocal).length)
    .toBe(1);
}

test("@mock screenshot regression hides the future first-to-second identified WALK before the first event", async ({
  page,
}, testInfo) => {
  await openVisibilitySpecimen(page);

  expect(linesForPath(await polylineSnapshots(page), VISIBILITY_PATHS.decodedWalk)).toEqual([]);
  await expect(
    page.locator(".leglab").filter({ hasText: "Decoded walk · 15 min" })
  ).toHaveCount(0);
  expect(await decodeCalls(page)).toEqual(HOME_DECODE_SIGNATURES);
  expect(await decodeCalls(page)).not.toContain("visibility-walk-decoded");

  const opaqueIds = [
    "leg:visibility-home",
    "leg:visibility-walk-decoded",
    "leg:visibility-walk-fallback",
    "leg:visibility-walk-manual",
    "leg:visibility-transit-changed",
    "ride:visibility-home-local",
    "ride:visibility-home-crosstown",
    "ride:visibility-changed",
  ];
  const bodyText = await page.locator("body").innerText();
  expect(opaqueIds.some((id) => bodyText.includes(id))).toBe(false);
  expect(
    await page.evaluate((ids) => {
      const leaks: string[] = [];
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (ids.some((id) => attribute.value.includes(id))) {
            leaks.push(`${attribute.name}=${attribute.value}`);
          }
        }
      }
      return leaks;
    }, opaqueIds)
  ).toEqual([]);

  await testInfo.attach("future-walk-hidden-before-first-event", {
    body: await page.locator(".mapwrap").screenshot(),
    contentType: "image/png",
  });
});

test("@mock home transit is visible before departure and clears exactly at the first-stop boundary", async ({
  page,
}) => {
  await openVisibilitySpecimen(page);

  const homeLabel = page
    .locator(".leglab")
    .filter({ hasText: "10 Home Local → 20 Crosstown · 60 min" });
  await expect(homeLabel).toHaveCount(1);
  await expect(homeLabel.locator(".leglab__bubble")).toHaveCount(2);
  await expect(page.locator(".mk--transfer")).toHaveCount(1);
  const homePaths = [
    VISIBILITY_PATHS.homeWalk,
    VISIBILITY_PATHS.homeLocal,
    VISIBILITY_PATHS.homeTransferWalk,
    VISIBILITY_PATHS.homeCrosstown,
  ];
  for (const path of homePaths) {
    expect(linesForPath(await activePolylines(page), path)).toHaveLength(1);
  }
  // Home is not a changed leg: no solid or dotted underlay is allowed.
  expect(
    (await activePolylines(page)).filter(
      (line) =>
        homePaths.some((path) =>
          linesForPath([line], path).length === 1
        ) &&
        (line.strokeOpacity === 0.22 || line.iconFillOpacity === 0.24)
    )
  ).toEqual([]);

  const fitBeforeStatusChange = await fitBoundsCalls(page);
  expect(fitBeforeStatusChange.at(-1)).toEqual([
    [43.649, -79.42],
    [43.65, -79.419],
    [43.651, -79.418],
    [43.652, -79.417],
    [43.653, -79.416],
    [43.648, -79.421],
  ]);
  await expect(page.locator(".mk--home")).toHaveAttribute(
    "style",
    /left: 310px; top: 260px/
  );

  await page.getByRole("button", { name: "Exact home departure" }).click();
  await expect(homeLabel).toHaveCount(1);
  expect(linesForPath(await activePolylines(page), VISIBILITY_PATHS.homeLocal)).toHaveLength(1);

  await resetDecodeCalls(page);
  await page
    .getByRole("button", { name: "Exact first-stop boundary" })
    .click();
  await expect(homeLabel).toHaveCount(0);
  await expect(page.locator(".mk--transfer")).toHaveCount(0);
  for (const path of homePaths) {
    await expect
      .poll(async () => linesForPath(await activePolylines(page), path).length)
      .toBe(0);
  }
  const outboundLabel = page
    .locator(".leglab")
    .filter({ hasText: "Decoded walk · 15 min" });
  await expect(outboundLabel).toHaveCount(1);
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.decodedWalk))
    .toEqual([
      expect.objectContaining({
        strokeColor: "#2E6F8A",
        strokeOpacity: 0.92,
        strokeWeight: 2.5,
      }),
    ]);
  const boundaryDecodeCalls = await decodeCalls(page);
  expect(boundaryDecodeCalls).toContain("visibility-walk-decoded");
  for (const homeDecode of HOME_DECODE_SIGNATURES) {
    expect(boundaryDecodeCalls).not.toContain(homeDecode);
  }

  // Status-only movement does not change fit inputs or marker geography.
  expect(await fitBoundsCalls(page)).toHaveLength(fitBeforeStatusChange.length);
  await expect(page.locator(".mk--live")).toHaveCount(1);
  await expect(page.locator(".mk--live")).toHaveAttribute(
    "style",
    /left: 320px; top: 250px/
  );
  await expect(page.locator(".mk--changed")).toHaveCount(1);
  await expect(page.locator(".mk--live.mk--changed")).toHaveCount(0);
  await expect(page.locator(".chip--live")).toHaveCount(1);
});

test("@mock active and manual WALK routes keep exact decoded and endpoint-fallback geometry", async ({
  page,
}) => {
  await openVisibilitySpecimen(page);
  const strip = page.getByTestId("visibility-strip-specimen");
  const walkLegs = strip.locator('.lstrip__leg[aria-label="walking leg"]');
  const decodedControl = walkLegs.filter({ hasText: "15 min" }).getByRole("button");
  const fallbackControl = walkLegs.filter({ hasText: "12 min" }).getByRole("button");
  const manualControl = walkLegs.filter({ hasText: "18 min" }).getByRole("button");

  for (const control of [decodedControl, fallbackControl, manualControl]) {
    await expect(control).toHaveAttribute("aria-pressed", "false");
    await expect(control).not.toHaveAttribute("aria-expanded", /.+/);
    await expect(control).not.toHaveAttribute("aria-controls", /.+/);
  }

  await page.getByRole("button", { name: "Second stop active" }).click();
  await resetDecodeCalls(page);
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.fallbackWalk))
    .toEqual([
      expect.objectContaining({
        strokeColor: "#2E6F8A",
        strokeOpacity: 0.92,
        strokeWeight: 2.5,
      }),
    ]);
  await expect(
    page.locator(".leglab").filter({ hasText: "Endpoint fallback walk · 12 min" })
  ).toHaveCount(1);
  expect(await decodeCalls(page)).toEqual([]);

  await page.getByRole("button", { name: "All stops completed" }).click();
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.fallbackWalk).length)
    .toBe(0);
  await resetDecodeCalls(page);
  await decodedControl.press("Enter");
  await expect(decodedControl).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.decodedWalk))
    .toEqual([
      expect.objectContaining({
        path: VISIBILITY_PATHS.decodedWalk,
        strokeColor: "#2E6F8A",
        strokeOpacity: 0.92,
        strokeWeight: 2.5,
      }),
    ]);
  expect(await decodeCalls(page)).toEqual(["visibility-walk-decoded"]);

  await resetDecodeCalls(page);
  await fallbackControl.press("Space");
  await expect(decodedControl).toHaveAttribute("aria-pressed", "false");
  await expect(fallbackControl).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => ({
      decoded: linesForPath(await activePolylines(page), VISIBILITY_PATHS.decodedWalk).length,
      fallback: linesForPath(await activePolylines(page), VISIBILITY_PATHS.fallbackWalk).length,
    }))
    .toEqual({ decoded: 0, fallback: 1 });
  expect(await decodeCalls(page)).toEqual([]);

  await manualControl.click();
  await expect(fallbackControl).toHaveAttribute("aria-pressed", "false");
  await expect(manualControl).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.manualWalk))
    .toEqual([
      expect.objectContaining({
        path: VISIBILITY_PATHS.manualWalk,
        strokeColor: "#2E6F8A",
        strokeOpacity: 0.92,
        strokeWeight: 2.5,
      }),
    ]);
  await manualControl.click();
  await expect(manualControl).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.manualWalk).length)
    .toBe(0);
});

test("@mock automatic and manual selection of the same WALK leg deduplicate exactly", async ({
  page,
}) => {
  await openVisibilitySpecimen(page);
  await page
    .getByRole("button", { name: "Exact first-stop boundary" })
    .click();
  const decodedControl = page
    .getByTestId("visibility-strip-specimen")
    .locator('.lstrip__leg[aria-label="walking leg"]')
    .filter({ hasText: "15 min" })
    .getByRole("button");
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.decodedWalk).length)
    .toBe(1);
  await decodedControl.click();
  await expect(decodedControl).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.decodedWalk).length)
    .toBe(1);
});

test("@mock later active and completed WALK states hand automatic visibility to manual selection", async ({
  page,
}) => {
  await openVisibilitySpecimen(page);
  const manualControl = page
    .getByTestId("visibility-strip-specimen")
    .locator('.lstrip__leg[aria-label="walking leg"]')
    .filter({ hasText: "18 min" })
    .getByRole("button");

  await page.getByRole("button", { name: "Later active stop" }).click();
  await expect(manualControl).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.manualWalk).length)
    .toBe(1);

  await page.getByRole("button", { name: "All stops completed" }).click();
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.manualWalk).length)
    .toBe(0);
  await manualControl.click();
  await expect(manualControl).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.manualWalk).length)
    .toBe(1);
});

test("@mock manual WALK lifecycle replaces overlays and retains only a surviving exact leg ID", async ({
  page,
}) => {
  await openVisibilitySpecimen(page);
  await page.getByRole("button", { name: "All stops completed" }).click();
  const strip = page.getByTestId("visibility-strip-specimen");
  const manualControl = strip
    .locator('.lstrip__leg[aria-label="walking leg"]')
    .filter({ hasText: "18 min" })
    .getByRole("button");
  await manualControl.click();
  await expect(manualControl).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.manualWalk).length)
    .toBe(1);
  const first = linesForPath(await activePolylines(page), VISIBILITY_PATHS.manualWalk);
  const firstIds = first.map((line) => line.id);
  const exactSignatures = first.map(overlaySignature);

  await page.getByRole("button", { name: "Rerender visibility plan" }).click();
  await expect
    .poll(async () => {
      const current = linesForPath(await activePolylines(page), VISIBILITY_PATHS.manualWalk);
      return {
        signatures: current.map(overlaySignature),
        oldStillActive: current.filter((line) => firstIds.includes(line.id)).length,
      };
    })
    .toEqual({ signatures: exactSignatures, oldStillActive: 0 });

  await page.getByRole("button", { name: "Unmount map" }).click();
  await expect(page.locator(".mapwrap")).toHaveCount(0);
  await expect.poll(async () => (await activePolylines(page)).length).toBe(0);
  await page.getByRole("button", { name: "Remount map" }).click();
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");
  await expect
    .poll(async () =>
      linesForPath(await activePolylines(page), VISIBILITY_PATHS.manualWalk).map(
        overlaySignature
      )
    )
    .toEqual(exactSignatures);

  await page.getByRole("button", { name: "Reroute clone exact IDs" }).click();
  await expect(manualControl).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () =>
      linesForPath(await activePolylines(page), VISIBILITY_PATHS.manualWalk).map(
        overlaySignature
      )
    )
    .toEqual(exactSignatures);

  await page
    .getByRole("button", { name: "Reroute replace manual leg" })
    .click();
  await expect(manualControl).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await activePolylines(page)).length).toBe(0);

  await page.getByRole("button", { name: "Reset visibility plan" }).click();
  await page.getByRole("button", { name: "All stops completed" }).click();
  const resetManualControl = page
    .getByTestId("visibility-strip-specimen")
    .locator('.lstrip__leg[aria-label="walking leg"]')
    .filter({ hasText: "18 min" })
    .getByRole("button");
  await resetManualControl.click();
  await expect(resetManualControl).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Replace plan or history" }).click();
  const replacementControl = page
    .getByTestId("visibility-strip-specimen")
    .locator('.lstrip__leg[aria-label="walking leg"]')
    .filter({ hasText: "18 min" })
    .getByRole("button");
  await expect(replacementControl).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await activePolylines(page)).length).toBe(0);
});

test("@mock changed identified transit keeps one same-colour halo while legacy WALK and transit controls remain unchanged", async ({
  page,
}) => {
  await openVisibilitySpecimen(page);
  await page.getByRole("button", { name: "All stops completed" }).click();
  const changedControl = page
    .getByTestId("visibility-strip-specimen")
    .locator('.lstrip__leg[aria-label="transit leg"]')
    .filter({ hasText: "40 Changed Line" })
    .getByRole("button");
  await changedControl.click();
  await expect(changedControl).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => linesForPath(await activePolylines(page), VISIBILITY_PATHS.changedTransit))
    .toEqual([
      expect.objectContaining({
        strokeColor: "#1B7A67",
        strokeOpacity: 0.22,
        strokeWeight: 8.5,
        zIndex: 1,
      }),
      expect.objectContaining({
        strokeColor: "#1B7A67",
        strokeOpacity: 0.92,
        strokeWeight: 3.5,
        zIndex: 2,
      }),
    ]);
  const changedLines = linesForPath(
    await activePolylines(page),
    VISIBILITY_PATHS.changedTransit
  );
  expect(changedLines[0].id).toBeLessThan(changedLines[1].id);
  expect(changedLines.every((line) => line.strokeColor !== "#C8F000")).toBe(true);
  await expect(
    page.locator(".leglab").filter({ hasText: "40 Changed Line · 25 min" })
  ).toHaveCount(1);
  await expect(page.locator(".mk--changed")).toHaveCount(1);
  await expect(page.locator(".mk--live")).toHaveCount(0);

  await page.getByRole("button", { name: "Show all-leg specimen" }).click();
  await expect(page.getByTestId("route-strip-specimen")).toHaveCount(1);
  await expect(page.getByTestId("route-strip-specimen").locator(".lstrip")).toBeVisible();
  await expect
    .poll(async () => ({
      legacyWalk: linesForPath(await activePolylines(page), [
        [43.6542, -79.4098],
        [43.656, -79.405],
      ]).length,
      legacyTransit: linesForPath(await activePolylines(page), [
        [43.656, -79.405],
        [43.6575, -79.402],
      ]).length,
    }))
    // The legacy transit destination is the existing changed stop, so its
    // unchanged contract is one provider-blue halo plus one provider-blue
    // primary. The identity-absent WALK remains one solid ink route.
    .toEqual({ legacyWalk: 1, legacyTransit: 2 });
  await expect(
    page.locator(".leglab").filter({ hasText: "900 Legacy Blue · 1 stop · 15 min" })
  ).toHaveCount(1);
});

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

test("@mock clicking a stop chip animates the camera to that exact stop, and re-clicking it re-centers", async ({ page }) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");

  const chips = page.locator(".chip");
  await expect(chips).toHaveCount(2);

  await chips.first().click();
  await expect(chips.first()).toHaveClass(/chip--selected/);
  await expect
    .poll(async () => (await moveCameraCalls(page)).at(-1))
    .toEqual({ center: { lat: 43.6479, lng: -79.4214 }, zoom: 17 });
  const callsAfterFirst = await moveCameraCalls(page);
  // A real multi-frame glide, not a single teleporting jump.
  expect(callsAfterFirst.length).toBeGreaterThan(1);

  // Re-clicking the SAME stop bumps the nonce and re-centers, even though
  // `selected` itself does not change value. The camera is already exactly
  // there, so the tween's no-op path fires one immediate moveCamera call
  // rather than animating a glide with nothing to interpolate.
  await chips.first().click();
  await expect
    .poll(async () => (await moveCameraCalls(page)).length)
    .toBe(callsAfterFirst.length + 1);
  expect((await moveCameraCalls(page)).at(-1)).toEqual({
    center: { lat: 43.6479, lng: -79.4214 },
    zoom: 17,
  });

  // Clicking the OTHER stop focuses its own coordinate, animated again.
  const beforeSecond = (await moveCameraCalls(page)).length;
  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveClass(/chip--selected/);
  await expect
    .poll(async () => (await moveCameraCalls(page)).at(-1))
    .toEqual({ center: { lat: 43.6512, lng: -79.4148 }, zoom: 17 });
  expect((await moveCameraCalls(page)).length).toBeGreaterThan(beforeSecond + 1);
});

test("@mock clicking a second stop mid-glide cancels the first tween and redirects from wherever the camera actually was", async ({ page }) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");

  const chips = page.locator(".chip");
  await expect(chips).toHaveCount(2);

  await chips.first().click();
  await expect(chips.first()).toHaveClass(/chip--selected/);
  // Interrupt partway through the ~400ms glide toward stop 1.
  await page.waitForTimeout(120);
  const midFlightCalls = await moveCameraCalls(page);
  expect(midFlightCalls.length).toBeGreaterThan(0);
  // This assertion is only meaningful if it genuinely interrupts an
  // in-flight glide rather than a finished one.
  expect(midFlightCalls.at(-1)).not.toEqual({
    center: { lat: 43.6479, lng: -79.4214 },
    zoom: 17,
  });

  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveClass(/chip--selected/);
  await expect
    .poll(async () => (await moveCameraCalls(page)).at(-1))
    .toEqual({ center: { lat: 43.6512, lng: -79.4148 }, zoom: 17 });

  // A redirect must start from wherever the camera actually stopped, not
  // snap back to stop 1's exact coordinate first and then re-animate — that
  // would read as a stutter rather than one continuous glide.
  const callsAfterRedirect = (await moveCameraCalls(page)).slice(midFlightCalls.length);
  expect(
    callsAfterRedirect.some(
      (call) => call.center && call.center.lat === 43.6479 && call.center.lng === -79.4214
    )
  ).toBe(false);
});

test("@mock a stop-to-stop hop holds zoom constant across every frame; an overview-to-stop focus animates zoom too", async ({ page }) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");

  const chips = page.locator(".chip");
  await expect(chips).toHaveCount(2);

  // The map starts at the overview zoom (14): the first focus needs a real
  // zoom change, so at least one intermediate frame must show a zoom
  // strictly between 14 and 17 (a genuine interpolation, not an instant
  // jump straight to the target).
  await chips.first().click();
  await expect(chips.first()).toHaveClass(/chip--selected/);
  await expect
    .poll(async () => (await moveCameraCalls(page)).at(-1)?.zoom)
    .toBe(17);
  const firstFocusCalls = await moveCameraCalls(page);
  const intermediateZooms = firstFocusCalls.slice(0, -1).map((call) => call.zoom);
  expect(intermediateZooms.some((zoom) => zoom !== null && zoom > 14 && zoom < 17)).toBe(true);

  // Hopping to the other stop is already at STOP_FOCUS_ZOOM (17): every
  // frame of that glide should hold zoom exactly at 17 and animate only the
  // center.
  const beforeHop = firstFocusCalls.length;
  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveClass(/chip--selected/);
  await expect
    .poll(async () => (await moveCameraCalls(page)).at(-1)?.center)
    .toEqual({ lat: 43.6512, lng: -79.4148 });
  const hopCalls = (await moveCameraCalls(page)).slice(beforeHop);
  expect(hopCalls.length).toBeGreaterThan(1); // a real multi-frame glide
  expect(hopCalls.every((call) => call.zoom === 17)).toBe(true);
});

test("@mock reduced motion jumps the camera instantly instead of animating", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");

  const chips = page.locator(".chip");
  const movesBefore = (await moveCameraCalls(page)).length;
  const centersBefore = (await setCenterCalls(page)).length;

  await chips.first().click();
  await expect(chips.first()).toHaveClass(/chip--selected/);

  // setCenter (instant), never the animated moveCamera tween, under reduced motion.
  expect((await moveCameraCalls(page)).length).toBe(movesBefore);
  const centers = await setCenterCalls(page);
  expect(centers.length).toBe(centersBefore + 1);
  expect(centers.at(-1)).toEqual({ lat: 43.6479, lng: -79.4214 });
  expect((await setZoomCalls(page)).at(-1)).toBe(17);
});

test("@mock a programmatic selection change never moves the map camera", async ({ page }) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");

  const before = await moveCameraCalls(page);
  await page.getByRole("button", { name: "Select first stop programmatically" }).click();
  await expect(page.locator(".chip").first()).toHaveClass(/chip--selected/);
  const after = await moveCameraCalls(page);
  // `selected` changed (proven by the class above); the camera did not.
  expect(after.length).toBe(before.length);
});

// BUG 2: the chip-ease suppression flag was wired to the focus tween ONLY. A
// real user drag or scroll-wheel zoom never set it, so the chip kept its
// 0.55s left/top ease chasing a per-frame-moving target and visibly swam
// behind its pin. The fix wires `bounds_changed` (fires on ANY camera change)
// as the rising edge; `idle` stays the one falling edge.
test("@mock a user drag or scroll-zoom suppresses the chip position ease, independent of the focus tween", async ({ page }) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");

  const ovLayer = page.locator(".ov-layer");
  // The initial fit settles to idle, so the chip ease is NOT suppressed at rest.
  await expect(ovLayer).not.toHaveClass(/ov-layer--camera-moving/);

  // A drag / scroll-wheel zoom fires bounds_changed repeatedly. This is NOT
  // the chip-click focus path: no moveCamera tween ever runs.
  const movesBefore = (await moveCameraCalls(page)).length;
  await page.evaluate(() => {
    (
      window as Window & { __mapsLastMap?: { __fireBoundsChanged: () => void } }
    ).__mapsLastMap?.__fireBoundsChanged();
  });
  await expect(ovLayer).toHaveClass(/ov-layer--camera-moving/);
  expect((await moveCameraCalls(page)).length).toBe(movesBefore);

  // The gesture settling (idle) clears it again.
  await page.evaluate(() => {
    (
      window as Window & { __mapsLastMap?: { __fireIdle: () => void } }
    ).__mapsLastMap?.__fireIdle();
  });
  await expect(ovLayer).not.toHaveClass(/ov-layer--camera-moving/);
});

// BUG 1: `.mk--home`'s anchor box used to include the address label, so
// centering the box on the coordinate (translate(-50%, -50%)) left the DOT
// itself offset — by half the label's width horizontally and a constant
// ~11.5px vertically. The mock projection is a fixed linear fake, so this can
// only be observed as a real-CSS layout assertion, not a projection round-trip.
test("@mock the home marker's dot sits on its coordinate for a short label and a long address", async ({ page }) => {
  await openVisibilitySpecimen(page);

  const readOffsets = async () => {
    const style = (await page.locator(".mk--home").getAttribute("style")) ?? "";
    const declaredLeft = Number.parseFloat(/left:\s*([\d.]+)px/.exec(style)?.[1] ?? "NaN");
    const declaredTop = Number.parseFloat(/top:\s*([\d.]+)px/.exec(style)?.[1] ?? "NaN");
    const [ov, dot, tag] = await Promise.all([
      page.locator(".ov-layer").boundingBox(),
      page.locator(".mk--home .mk__dot").boundingBox(),
      page.locator(".mk--home .mk__tag").boundingBox(),
    ]);
    if (!ov || !dot || !tag) throw new Error("home marker parts are not laid out");
    return {
      // rendered dot centre, relative to the declared coordinate
      dotX: dot.x + dot.width / 2 - ov.x - declaredLeft,
      dotY: dot.y + dot.height / 2 - ov.y - declaredTop,
      // the tag stays centred on the dot, 5px below it
      tagCentreOffset: tag.x + tag.width / 2 - ov.x - declaredLeft,
      tagGap: tag.y - (dot.y + dot.height),
    };
  };

  // Short label ("Visibility Home").
  const short = await readOffsets();
  expect(Math.abs(short.dotX)).toBeLessThan(1);
  expect(Math.abs(short.dotY)).toBeLessThan(1);
  expect(Math.abs(short.tagCentreOffset)).toBeLessThan(1);
  expect(short.tagGap).toBeGreaterThan(3);
  expect(short.tagGap).toBeLessThan(7);

  // A long formatted address: the tag is now far wider than the dot, which is
  // exactly the case that used to shove the dot ~150px sideways.
  await page.getByRole("button", { name: "Use long home label" }).click();
  await expect(page.locator(".mk--home .mk__tag")).toContainText("1200 Bay Street");
  const long = await readOffsets();
  expect(Math.abs(long.dotX)).toBeLessThan(1);
  expect(Math.abs(long.dotY)).toBeLessThan(1);
  expect(Math.abs(long.tagCentreOffset)).toBeLessThan(1);
  expect(long.tagGap).toBeGreaterThan(3);
  expect(long.tagGap).toBeLessThan(7);
});

test("@mock the show-full-itinerary control reframes through the same fitAllStops path as the initial fit", async ({ page }) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");

  const initialFits = await fitBoundsCalls(page);
  expect(initialFits.length).toBeGreaterThan(0);

  // Focus one stop first, so the button's reframe is a real, visible change.
  await page.locator(".chip").first().click();

  await page.getByRole("button", { name: "Show the whole itinerary" }).click();
  const afterFits = await fitBoundsCalls(page);
  expect(afterFits.length).toBe(initialFits.length + 1);
  // Same bounds math on the same geography: the button's call reproduces
  // exactly the initial fit's result, because both call fitAllStops().
  expect(afterFits.at(-1)).toEqual(initialFits.at(-1));
});

test("@mock transit rides use their own palette slots while fallback and ordinary walk stay intact", async ({
  page,
}) => {
  const active = await openRouteSpecimen(page);
  const rideLines = active.filter(
    (line) => line.strokeOpacity === 0.92 && line.strokeWeight === 3.5
  );
  expect(rideLines.map((line) => line.strokeColor)).toEqual([
    APP_RIDE_COLORS.slot0,
    APP_RIDE_COLORS.slot3,
    APP_RIDE_COLORS.slot2,
    "#00843D",
    "#0066CC",
  ]);
  expect(rideLines.every((line) => !line.hasIcons && line.zIndex === 2)).toBe(
    true
  );

  const halos = active.filter((line) => line.strokeOpacity === 0.22);
  expect(halos.map((line) => line.strokeColor)).toEqual([
    APP_RIDE_COLORS.slot0,
    APP_RIDE_COLORS.slot3,
    APP_RIDE_COLORS.slot2,
    "#0066CC",
  ]);
  expect(halos.every((line) => line.strokeWeight === 8.5 && line.zIndex === 1)).toBe(
    true
  );
  for (const halo of halos) {
    const primary = rideLines.find(
      (line) =>
        line.strokeColor === halo.strokeColor &&
        JSON.stringify(line.path) === JSON.stringify(halo.path)
    );
    expect(primary).toBeDefined();
    expect(halo.id).toBeLessThan(primary!.id);
  }
  // The first three geometry records all publish the same provider red. A
  // facts-only slot between them cannot shift their per-record slot colours.
  expect(new Set(rideLines.slice(0, 3).map((line) => line.strokeColor)).size).toBe(3);
  expect(active.some((line) => line.strokeColor === "#D71920")).toBe(false);
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
    "ride-blue",
  ]);
  expect(decodeCalls).not.toContain("");
  expect(decodeCalls).not.toContain("whole-transit");
  expect(decodeCalls).not.toContain("whole-transit-two");
  expect(decodeCalls).not.toContain("legacy-whole-transit");
  expect(decodeCalls).not.toContain("ordinary-walk-step");
});

test("@mock one ride color agrees across map line, halo, map bubble, compact badge, and BOARD badge", async ({
  page,
}) => {
  const active = await openRouteSpecimen(page);
  const hasFirstRidePath = (line: PolylineSnapshot) =>
    JSON.stringify(line.path) === JSON.stringify(FIRST_RIDE_PATH);
  const firstPrimary = active.find(
    (line) =>
      hasFirstRidePath(line) &&
      line.strokeOpacity === 0.92 &&
      line.strokeWeight === 3.5
  );
  const firstHalo = active.find(
    (line) => hasFirstRidePath(line) && line.strokeOpacity === 0.22
  );
  expect(firstPrimary).toEqual(
    expect.objectContaining({ strokeColor: APP_RIDE_COLORS.slot0, zIndex: 2 })
  );
  expect(firstHalo).toEqual(
    expect.objectContaining({
      strokeColor: APP_RIDE_COLORS.slot0,
      strokeWeight: 8.5,
      zIndex: 1,
    })
  );
  expect(firstHalo!.id).toBeLessThan(firstPrimary!.id);
  const laterSharedPrimary = active.find(
    (line) =>
      JSON.stringify(line.path) === JSON.stringify(LATER_SHARED_RIDE_PATH) &&
      line.strokeOpacity === 0.92 &&
      line.strokeWeight === 3.5
  );
  // The facts-only ride sits before this shared slot-three occurrence, while
  // geometry-only slot two sits after it. Any filtered-array zip therefore
  // gives this exact later ride the wrong colour.
  expect(laterSharedPrimary).toEqual(
    expect.objectContaining({ strokeColor: APP_RIDE_COLORS.slot3, zIndex: 2 })
  );

  const firstMapLabel = page
    .locator(".leglab")
    .filter({ hasText: "2 transfers · 15 min" });
  await expect(firstMapLabel).toHaveCount(1);
  const mapBubbles = firstMapLabel.locator(".leglab__bubble");
  await expect(mapBubbles).toHaveCount(3);
  // Facts are slot 0, facts-only slot 1, then slot 3; geometry-only slot 2
  // must not shift this list. The first pair is color-only, while the odd
  // final ride keeps its compact route designation.
  await expect(mapBubbles).toHaveText(["", "", "501"]);
  const expectedFactColors: ElementColor[] = [
    {
      background: APP_RIDE_CSS_COLORS.slot0,
      foreground: APP_RIDE_CSS_COLORS.white,
    },
    {
      background: APP_RIDE_CSS_COLORS.slot1,
      foreground: APP_RIDE_CSS_COLORS.white,
    },
    {
      background: APP_RIDE_CSS_COLORS.slot3,
      foreground: APP_RIDE_CSS_COLORS.white,
    },
  ];
  expect(await elementColors(mapBubbles)).toEqual(expectedFactColors);
  expect((await elementColors(mapBubbles)).map((color) => color.background)).not.toContain(
    "rgb(0, 107, 87)"
  );

  // Paired map bubbles stay color-only visually, but their full authentic
  // route names remain outside the aria-hidden visual cluster in ride order.
  const accessibleRoutes = firstMapLabel.locator(".sr-only");
  await expect(accessibleRoutes).toHaveText(
    "Routes 501 Shared, then 63 Facts Only, then 501 Shared"
  );
  expect(
    await accessibleRoutes.evaluate(
      (element) => element.closest('[aria-hidden="true"]') === null
    )
  ).toBe(true);
  await expect(firstMapLabel.locator(".leglab__bubbles")).toHaveAttribute(
    "aria-hidden",
    "true"
  );

  const overflowMapLabel = page
    .locator(".leglab")
    .filter({ hasText: "77 Overflow Green · 2 stops · 15 min" });
  await expect(overflowMapLabel).toHaveCount(1);
  expect(await elementColors(overflowMapLabel.locator(".leglab__bubble"))).toEqual([
    { background: "rgb(0, 132, 61)", foreground: "rgb(232, 243, 248)" },
  ]);
  await expect(overflowMapLabel.locator(".sr-only")).toHaveCount(0);

  const legacyMapLabel = page
    .locator(".leglab")
    .filter({ hasText: "900 Legacy Blue · 1 stop · 15 min" });
  await expect(legacyMapLabel).toHaveCount(1);
  expect(await elementColors(legacyMapLabel.locator(".leglab__bubble"))).toEqual([
    { background: "rgb(0, 102, 204)", foreground: "rgb(255, 255, 0)" },
  ]);
  await expect(legacyMapLabel.locator(".sr-only")).toHaveCount(0);

  const strip = page.getByTestId("route-strip-specimen");
  const stripLegs = strip.locator('.lstrip__leg[aria-label="transit leg"]');
  await expect(stripLegs).toHaveCount(3);
  const firstStripLeg = stripLegs.nth(0);
  const compactBadges = firstStripLeg.locator(
    ".lstrip__legline .lstrip__bubble"
  );
  await expect(compactBadges).toHaveCount(3);
  expect(await elementColors(compactBadges)).toEqual(expectedFactColors);
  await expect(firstStripLeg.locator(".lstrip__legselect")).toHaveAccessibleName(
    /501 Shared.*63 Facts Only.*501 Shared/
  );

  const overflowCompact = stripLegs
    .nth(1)
    .locator(".lstrip__legline .lstrip__bubble");
  expect(await elementColors(overflowCompact)).toEqual([
    { background: "rgb(0, 132, 61)", foreground: "rgb(232, 243, 248)" },
  ]);

  const legacyCompact = stripLegs
    .nth(2)
    .locator(".lstrip__legline .lstrip__bubble");
  expect(await elementColors(legacyCompact)).toEqual([
    { background: "rgb(0, 102, 204)", foreground: "rgb(255, 255, 0)" },
  ]);

  await firstStripLeg.locator(".lstrip__legselect").click();
  const boardBadges = firstStripLeg.locator(
    ".lstrip__tlrow--board .lstrip__bubble"
  );
  await expect(boardBadges).toHaveCount(3);
  expect(await elementColors(boardBadges)).toEqual(expectedFactColors);

  // The exact slot-zero appearance agrees everywhere; provider yellow never
  // controls an app-palette foreground, and app-owned metadata never leaks.
  for (const colors of [
    (await elementColors(mapBubbles))[0],
    (await elementColors(compactBadges))[0],
    (await elementColors(boardBadges))[0],
  ]) {
    expect(colors).toEqual({
      background: APP_RIDE_CSS_COLORS.slot0,
      foreground: APP_RIDE_CSS_COLORS.white,
    });
  }
  for (const colors of [
    (await elementColors(mapBubbles))[2],
    (await elementColors(compactBadges))[2],
    (await elementColors(boardBadges))[2],
  ]) {
    expect(colors).toEqual({
      background: APP_RIDE_CSS_COLORS.slot3,
      foreground: APP_RIDE_CSS_COLORS.white,
    });
  }

  const metadataIds = [
    "ride:harness-slot-zero",
    "ride:harness-facts-only-slot-one",
    "ride:harness-geometry-only-slot-two",
    "ride:harness-slot-three",
    "ride:harness-overflow",
    "ride:harness-invalid-missing",
    "ride:harness-invalid-throw",
    "ride:harness-invalid-empty",
    "ride:harness-invalid-one",
    "ride:harness-invalid-nonfinite",
    "ride:harness-invalid-out-of-range",
  ];
  const visibleText = await page.locator("body").innerText();
  for (const id of metadataIds) expect(visibleText).not.toContain(id);
  const leakedAttributeValues = await page.evaluate((ids) => {
    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (ids.some((id) => attribute.value.includes(id))) {
          leaks.push(`${attribute.name}=${attribute.value}`);
        }
      }
    }
    return leaks;
  }, metadataIds);
  expect(leakedAttributeValues).toEqual([]);
});

test("@mock consecutive embedded walks merge only at connected boundaries in provider order", async ({
  page,
}) => {
  const active = await openRouteSpecimen(page);
  const walkPrimaries = active.filter(
    (line) => line.iconPath === "CIRCLE" && line.iconFillOpacity === 0.88
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

  const slotZeroRide = active.find(
    (line) =>
      line.strokeColor === APP_RIDE_COLORS.slot0 &&
      line.strokeOpacity === 0.92
  );
  expect(slotZeroRide).toBeDefined();
  expect(walkPrimaries[0].id).toBeLessThan(slotZeroRide!.id);
  expect(slotZeroRide!.id).toBeLessThan(walkPrimaries[1].id);

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
      (line) => line.iconPath === "CIRCLE" && line.iconFillOpacity === 0.88
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
    (line) => line.iconPath === "CIRCLE" && line.iconFillOpacity === 0.88
  );
  const walkUnderlays = active.filter(
    (line) => line.iconPath === "CIRCLE" && line.iconFillOpacity === 0.24
  );

  expect(walkPrimaries).toHaveLength(10);
  expect(
    walkPrimaries.every(
      (line) =>
        line.clickable === false &&
        line.strokeColor === null &&
        line.strokeOpacity === 0 &&
        line.strokeWeight === null &&
        line.iconFillColor === "#4F6F7E" &&
        line.iconStrokeColor === null &&
        line.iconStrokeOpacity === 0 &&
        line.iconStrokeWeight === null &&
        line.iconScale === 2 &&
        line.iconOffset === "0" &&
        line.iconRepeat === "12px" &&
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
        line.strokeWeight === null &&
        line.iconFillColor === "#4F6F7E" &&
        line.iconStrokeColor === null &&
        line.iconStrokeOpacity === 0 &&
        line.iconStrokeWeight === null &&
        line.iconScale === 3.6 &&
        line.iconOffset === "0" &&
        line.iconRepeat === "12px" &&
        line.zIndex === 1
    )
  ).toBe(true);

  const rideLines = active.filter(
    (line) => line.strokeOpacity === 0.92 && line.strokeWeight === 3.5
  );
  expect(walkPrimaries.every((line) => line.iconFillOpacity! < 0.92)).toBe(true);
  expect(rideLines.every((line) => !line.hasIcons)).toBe(true);
  const rideColors = new Set(rideLines.map((line) => line.strokeColor));
  expect(
    [...walkPrimaries, ...walkUnderlays].some(
      (line) =>
        line.iconFillColor === "#C8F000" ||
        line.iconFillColor === "#2E6F8A" ||
        line.iconFillColor === "#D71920" ||
        rideColors.has(line.iconFillColor)
    )
  ).toBe(false);
});

// ── drive-vs-transit mode, Stage 1: the driving display ──
// The strip's leg card is a ternary whose final ELSE is the WALK arm, so a
// mode with no branch of its own renders as a walk with a walking-safety
// caution under a BUS glyph — and TypeScript cannot catch it, because the
// else makes the ternary total. These are the tests that bite when the
// explicit driving branch is removed.
test("@mock a driving leg renders as Drive, not as a walk, and stays selectable", async ({
  page,
}) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");
  await page.getByRole("button", { name: "Show driving specimen" }).click();

  const strip = page.getByTestId("driving-strip-specimen");
  const driving = strip.locator('[role="listitem"][aria-label="driving leg"]');
  await expect(driving).toHaveCount(2);

  const first = driving.first();
  await expect(first.locator(".lstrip__legline")).toHaveText("Drive");
  await expect(first.locator(".lstrip__legmeta")).toHaveText("22 min");
  // leave · arrive, the scheduler's own two instants
  await expect(first.locator(".lstrip__legtimes")).toContainText("leave");
  await expect(first.locator(".lstrip__legtimes")).toContainText("arrive");

  // NOT the walk arm: no pedestrian caution anywhere on a driving leg.
  await expect(driving.locator(".lstrip__walkwarning")).toHaveCount(0);
  // NOT the transit arm either: no route badges, no board/alight timeline.
  await expect(driving.locator(".lstrip__bubble")).toHaveCount(0);
  await expect(driving.locator(".lstrip__timeline")).toHaveCount(0);

  // The CAR glyph, not the bus fallback every non-walk mode used to get.
  await expect(first.locator(".lstrip__legicon svg path")).toHaveAttribute(
    "d",
    /^M18\.9/
  );

  // Selectable: an identified driving leg is a native button that reports
  // its pressed state, even though there is nothing to expand.
  const button = first.locator("button.lstrip__legselect");
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAttribute("aria-pressed", "false");
  // and no timeline disclosure state is invented for it
  await expect(button).not.toHaveAttribute("aria-expanded", /.*/);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");

  // The invariant on screen: a driving PLAN legitimately contains a WALK leg.
  await expect(
    strip.locator('[role="listitem"][aria-label="walking leg"]')
  ).toHaveCount(1);
});

// ── the active-stop real-time creep triangle ──
// "Drive Specimen One" is the driving specimen's only fixture-marked
// `active` stop, in a 19:00-20:00 window; the specimen's own fixed `now`
// (19:30) sits at exactly its midpoint, so the triangle's position is
// deterministic — no real clock, no polling, no flakiness.
test("@mock the active stop's card alone shows the real-time creep triangle, at its computed fraction", async ({
  page,
}) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");
  await page.getByRole("button", { name: "Show driving specimen" }).click();

  const strip = page.getByTestId("driving-strip-specimen");
  const stops = strip.locator(".lstrip__stop");
  await expect(stops).toHaveCount(4);

  // Present, exactly once, on the active card.
  const activeCard = stops.filter({ hasText: "Drive Specimen One" });
  await expect(activeCard.locator(".lstrip__triangle")).toHaveCount(1);

  // Absent on every upcoming card — three stops, zero triangles between them.
  const upcoming = stops.filter({ hasText: /Drive Specimen (Two|Three|Four)/ });
  await expect(upcoming).toHaveCount(3);
  await expect(upcoming.locator(".lstrip__triangle")).toHaveCount(0);

  // And roughly positioned per the computed fraction: 30 of 60 minutes
  // elapsed is exactly 50%, so the triangle's horizontal center should sit
  // at the card's own midpoint (a generous ±2% tolerance covers subpixel
  // rounding in the two bounding boxes, well inside the investigation's
  // measured ±1% accuracy for the underlying CSS technique).
  const cardBox = await activeCard.boundingBox();
  const triangleBox = await activeCard.locator(".lstrip__triangle").boundingBox();
  if (!cardBox || !triangleBox) throw new Error("expected both boxes to be measurable");
  const fraction = (triangleBox.x + triangleBox.width / 2 - cardBox.x) / cardBox.width;
  expect(fraction).toBeGreaterThan(0.48);
  expect(fraction).toBeLessThan(0.52);
});

// ── arrival detection: the chartreuse "arrived" card (live tracking, Piece 3) ──
// The GPS proximity + dwell decision cannot be mocked (it needs a real
// device), but the render plumbing can: the harness feeds a fixed
// `arrivedStopId` straight to the strip. "Drive Specimen One" is the
// specimen's only active stop, so it is the only valid target.
test("@mock a stop marked arrived turns its card chartreuse and keeps the active caret", async ({
  page,
}) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");
  await page.getByRole("button", { name: "Show driving specimen" }).click();

  const strip = page.getByTestId("driving-strip-specimen");
  const activeCard = strip.locator(".lstrip__stop").filter({ hasText: "Drive Specimen One" });

  // Before arrival: active border only, no arrived wash.
  await expect(activeCard).toHaveClass(/lstrip__stop--live/);
  await expect(activeCard).not.toHaveClass(/lstrip__stop--arrived/);

  await page.getByRole("button", { name: "Mark drive stop one arrived" }).click();

  // The card goes chartreuse — the arrived class plus a visible background
  // wash that the plain active state does not carry.
  await expect(activeCard).toHaveClass(/lstrip__stop--arrived/);
  const bg = await activeCard.evaluate(
    (el) => getComputedStyle(el).backgroundColor
  );
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(bg).not.toBe("rgb(255, 255, 255)");

  // The clock-based caret is INDEPENDENT and still true — it stays.
  await expect(activeCard.locator(".lstrip__triangle")).toHaveCount(1);
  // A screen reader still hears the fact the colour conveys.
  await expect(activeCard).toContainText("arrived");

  // Only the active stop is eligible: an upcoming card never gets the wash.
  const upcoming = strip.locator(".lstrip__stop").filter({ hasText: "Drive Specimen Two" });
  await expect(upcoming).not.toHaveClass(/lstrip__stop--arrived/);

  // And it clears cleanly.
  await page.getByRole("button", { name: "Arrival off" }).click();
  await expect(activeCard).not.toHaveClass(/lstrip__stop--arrived/);
});

test("@mock a driving leg draws its real road line, and none at all without geometry", async ({
  page,
}) => {
  await serveMaps(page);
  await page.goto("/test-harness/maps");
  await expect(page.locator(".mapwrap")).toHaveAttribute("data-map-state", "ready");
  await page.getByRole("button", { name: "Show driving specimen" }).click();

  const road: Array<[number, number]> = [
    [43.648, -79.4214],
    [43.6505, -79.4155],
    [43.656, -79.405],
  ];
  await expect
    .poll(async () =>
      (await polylineSnapshots(page))
        .filter((line) => line.active)
        .map((line) => JSON.stringify(line.path))
    )
    .toContain(JSON.stringify(road));

  const active = (await polylineSnapshots(page)).filter((line) => line.active);
  const drive = active.find((line) => JSON.stringify(line.path) === JSON.stringify(road))!;
  // Solid ink, the same language as a whole-leg walk — this IS real provider
  // geometry — and never a dotted or symbol-icon line.
  expect(drive.strokeColor).toBe("#2E6F8A");
  expect(drive.strokeOpacity).toBe(0.92);
  expect(drive.strokeWeight).toBe(2.5);
  expect(drive.hasIcons).toBe(false);

  // THE GEOMETRY RULE: the second driving leg has no provider polyline, so it
  // draws NOTHING. A straight line between two venues is not a road, and the
  // walk branch's endpoint fallback must never be inherited here.
  const fakeRoad = JSON.stringify([
    [43.656, -79.405],
    [43.66, -79.398],
  ]);
  expect(active.map((line) => JSON.stringify(line.path))).not.toContain(fakeRoad);

  // The plain WALK leg in the same driving plan keeps its own existing
  // endpoint fallback — that behaviour is deliberately untouched.
  const walkFallback = JSON.stringify([
    [43.66, -79.398],
    [43.662, -79.395],
  ]);
  expect(active.map((line) => JSON.stringify(line.path))).toContain(walkFallback);
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
  const firstActive = (await polylineSnapshots(page)).filter(
    (line) => line.active
  );
  const firstIds = firstActive.map((line) => line.id);
  const expectedOverlaySet = firstActive.map(overlaySignature);

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
  await expect
    .poll(async () =>
      (await polylineSnapshots(page))
        .filter((line) => line.active)
        .map(overlaySignature)
    )
    .toEqual(expectedOverlaySet);
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

// ── Live-location "you are here" marker (Piece 2) ──────────────────────────
// The marker's rendering is driven straight off a YouMarkerRender view via
// the harness's "You marker …" buttons — the tracker state machine and a
// real GPS are proven elsewhere / by owner eyeball. What matters here: the
// marker never appears without a real fix, a stale fix looks different from a
// live one, the accuracy ring scales with the reported metres, and the
// marker never moves the camera.
test.describe("the you-are-here marker", () => {
  async function openYouMarkerHarness(page: Page) {
    await serveMaps(page);
    await page.goto("/test-harness/maps");
    await expect(page.locator(".mapwrap")).toHaveAttribute(
      "data-map-state",
      "ready"
    );
  }

  test("@mock appears only with a real fix and clears when tracking goes off", async ({
    page,
  }) => {
    await openYouMarkerHarness(page);
    await expect(page.locator(".mk--you")).toHaveCount(0);

    await page.getByRole("button", { name: "You marker live" }).click();
    await expect(page.locator(".mk--you")).toHaveCount(1);
    await expect(page.locator(".mk--you")).not.toHaveClass(/mk--you-stale/);
    await expect(page.locator(".mk--you .mk__tag")).toHaveCount(0);

    await page.getByRole("button", { name: "You marker off" }).click();
    await expect(page.locator(".mk--you")).toHaveCount(0);
  });

  test("@mock a stale fix is visibly muted and carries a last-known time", async ({
    page,
  }) => {
    await openYouMarkerHarness(page);

    await page.getByRole("button", { name: "You marker live" }).click();
    const liveDot = page.locator(".mk--you .mk__dot");
    const liveBackground = await liveDot.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    );

    await page.getByRole("button", { name: "You marker stale" }).click();
    const stale = page.locator(".mk--you.mk--you-stale");
    await expect(stale).toHaveCount(1);
    await expect(stale.locator(".mk__tag")).toHaveText("Last known 7:42 PM");
    const staleBackground = await stale
      .locator(".mk__dot")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(staleBackground).not.toBe(liveBackground);
  });

  test("@mock the accuracy ring grows with the reported accuracy", async ({
    page,
  }) => {
    await openYouMarkerHarness(page);

    await page.getByRole("button", { name: "You marker live" }).click();
    const ring = page.locator(".mk--you .mk__accuracy");
    await expect(ring).toHaveCount(1);
    const tight = await ring.evaluate(
      (element) => element.getBoundingClientRect().width
    );
    expect(tight).toBeGreaterThan(0);

    await page.getByRole("button", { name: "You marker wide accuracy" }).click();
    await expect
      .poll(async () =>
        page
          .locator(".mk--you .mk__accuracy")
          .evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeGreaterThan(tight * 3);
  });

  test("@mock the marker never moves the camera", async ({ page }) => {
    await openYouMarkerHarness(page);
    const moveBefore = (await moveCameraCalls(page)).length;
    const centerBefore = (await setCenterCalls(page)).length;
    const fitBefore = (await fitBoundsCalls(page)).length;

    await page.getByRole("button", { name: "You marker live" }).click();
    await expect(page.locator(".mk--you")).toHaveCount(1);
    await page.getByRole("button", { name: "You marker wide accuracy" }).click();
    await page.getByRole("button", { name: "You marker stale" }).click();
    await expect(page.locator(".mk--you.mk--you-stale")).toHaveCount(1);

    expect((await moveCameraCalls(page)).length).toBe(moveBefore);
    expect((await setCenterCalls(page)).length).toBe(centerBefore);
    expect((await fitBoundsCalls(page)).length).toBe(fitBefore);
  });
});
