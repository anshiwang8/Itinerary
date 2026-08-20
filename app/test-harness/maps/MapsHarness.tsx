"use client";

import { useState } from "react";
import ItineraryMap, { MapStop } from "../../ItineraryMap";
import ItineraryStrip, { StripStop } from "../../ItineraryStrip";
import type { RideDetail } from "../../lib/transitDetail";

const PROVIDER_RED = "#D71920";

// Deliberately asymmetric facts/geometry. If either renderer pairs the two
// filtered arrays by position, the facts-only ride shifts every later colour:
//
//   facts:   slot 0, slot 1 (no geometry), slot 3
//   paths:   slot 0, slot 3, slot 2 (no facts)
//
// Each real surface must instead resolve the palette slot carried by its OWN
// record. The repeated 501 rides and every slotted provider-red record also
// prove that route/provider colour is not occurrence identity.
const SLOT_ZERO = {
  rideId: "ride:harness-slot-zero",
  sourceStepIndex: 2,
  paletteSlot: 0,
} as const;
const FACTS_ONLY_SLOT_ONE = {
  rideId: "ride:harness-facts-only-slot-one",
  sourceStepIndex: 5,
  paletteSlot: 1,
} as const;
const GEOMETRY_ONLY_SLOT_TWO = {
  rideId: "ride:harness-geometry-only-slot-two",
  sourceStepIndex: 18,
  paletteSlot: 2,
} as const;
const SLOT_THREE = {
  rideId: "ride:harness-slot-three",
  sourceStepIndex: 11,
  paletteSlot: 3,
} as const;
const OVERFLOW = {
  rideId: "ride:harness-overflow",
  sourceStepIndex: 1,
  paletteSlot: null,
} as const;

const INVALID_GEOMETRY_RIDES = [
  {
    rideId: "ride:harness-invalid-missing",
    sourceStepIndex: 12,
    paletteSlot: 4,
  },
  {
    rideId: "ride:harness-invalid-throw",
    sourceStepIndex: 13,
    paletteSlot: 5,
  },
  {
    rideId: "ride:harness-invalid-empty",
    sourceStepIndex: 14,
    paletteSlot: 6,
  },
  {
    rideId: "ride:harness-invalid-one",
    sourceStepIndex: 15,
    paletteSlot: 7,
  },
  {
    rideId: "ride:harness-invalid-nonfinite",
    sourceStepIndex: 16,
    paletteSlot: 8,
  },
  {
    rideId: "ride:harness-invalid-out-of-range",
    sourceStepIndex: 17,
    paletteSlot: 9,
  },
] as const;

const FIRST_LEG_RIDES: RideDetail[] = [
  {
    ...SLOT_ZERO,
    lineName: "501 Shared",
    shortName: "501",
    color: PROVIDER_RED,
    // App-owned palette rides must ignore this provider foreground.
    textColor: "#FFFF00",
    boardISO: "2026-07-25T20:31:00-04:00",
    alightISO: "2026-07-25T20:33:00-04:00",
    departStop: "Shared Start",
    arriveStop: "Shared First",
  },
  {
    ...FACTS_ONLY_SLOT_ONE,
    lineName: "63 Facts Only",
    shortName: "63",
    color: PROVIDER_RED,
    textColor: "#FFFF00",
    boardISO: "2026-07-25T20:34:00-04:00",
    alightISO: "2026-07-25T20:36:00-04:00",
    departStop: "Facts Only Start",
    arriveStop: "Facts Only End",
  },
  {
    ...SLOT_THREE,
    // The same published route appears a second time as a separate ride.
    lineName: "501 Shared",
    shortName: "501",
    color: PROVIDER_RED,
    textColor: "#FFFF00",
    boardISO: "2026-07-25T20:37:00-04:00",
    alightISO: "2026-07-25T20:39:00-04:00",
    departStop: "Shared Second",
    arriveStop: "Shared Return",
  },
];

const LEGACY_RIDE: RideDetail = {
  // This separate leg is wholly legacy: no app-owned identity fields exist on
  // either facts or geometry, so the boundary contract never has to guess.
  lineName: "900 Legacy Blue",
  shortName: "900",
  color: "#0066CC",
  textColor: "#FFFF00",
  boardISO: "2026-07-25T23:48:00-04:00",
  alightISO: "2026-07-25T23:57:00-04:00",
  departStop: "Legacy Start",
  arriveStop: "Legacy End",
};

const OVERFLOW_RIDE: RideDetail = {
  ...OVERFLOW,
  lineName: "77 Overflow Green",
  shortName: "77",
  color: "#00843D",
  textColor: "#E8F3F8",
  boardISO: "2026-07-25T21:48:00-04:00",
  alightISO: "2026-07-25T21:57:00-04:00",
  departStop: "Overflow Start",
  arriveStop: "Overflow End",
};

const STOPS: MapStop[] = [
  {
    id: "maps-harness-one",
    category: "dinner",
    name: "Fallback Pin One",
    lat: 43.6479,
    lng: -79.4214,
    startTime: "2026-07-25T19:00:00-04:00",
    endTime: "2026-07-25T20:30:00-04:00",
    status: "upcoming",
    // An unknown travel estimate has no provider geometry. The map harness
    // keeps one in view so browser coverage can prove it never becomes a
    // confident straight walking line.
    legModeToNext: "unknown",
  },
  {
    id: "maps-harness-two",
    category: "drinks",
    name: "Fallback Pin Two",
    lat: 43.6512,
    lng: -79.4148,
    startTime: "2026-07-25T20:45:00-04:00",
    endTime: "2026-07-25T22:00:00-04:00",
    status: "upcoming",
  },
];

const ROUTE_STOPS: MapStop[] = [
  {
    id: "maps-route-one",
    category: "dinner",
    name: "Route Specimen One",
    lat: 43.6479,
    lng: -79.4214,
    startTime: "2026-07-25T19:00:00-04:00",
    endTime: "2026-07-25T20:30:00-04:00",
    status: "upcoming",
    legModeToNext: "transit",
    legLabel: "2 transfers · 15 min",
    legSegments: FIRST_LEG_RIDES,
    // This valid whole-leg shape must not be used once authoritative step
    // data exists: a broken ride step cannot become a fabricated fallback.
    polylineToNext: "whole-transit",
    pathSegmentsToNext: [
      // exact shared boundary → one run with the shared point only once
      { mode: "walk", encodedPolyline: "walk-exact-a", color: null },
      { mode: "walk", encodedPolyline: "walk-exact-b", color: null },
      {
        mode: "transit",
        encodedPolyline: "ride-red",
        color: PROVIDER_RED,
        ...SLOT_ZERO,
      },
      // one E5-scale rounding mismatch → one safely merged run
      { mode: "walk", encodedPolyline: "walk-near-a", color: null },
      { mode: "walk", encodedPolyline: "walk-near-b", color: null },
      {
        mode: "transit",
        encodedPolyline: "ride-fallback",
        color: PROVIDER_RED,
        ...SLOT_THREE,
      },
      {
        mode: "transit",
        encodedPolyline: "",
        color: "#123456",
        ...INVALID_GEOMETRY_RIDES[0],
      },
      {
        mode: "transit",
        encodedPolyline: "decode-throw",
        color: "#654321",
        ...INVALID_GEOMETRY_RIDES[1],
      },
      {
        mode: "transit",
        encodedPolyline: "decode-empty",
        color: "#654321",
        ...INVALID_GEOMETRY_RIDES[2],
      },
      {
        mode: "transit",
        encodedPolyline: "decode-one",
        color: "#654321",
        ...INVALID_GEOMETRY_RIDES[3],
      },
      {
        mode: "transit",
        encodedPolyline: "decode-nonfinite",
        color: "#654321",
        ...INVALID_GEOMETRY_RIDES[4],
      },
      {
        mode: "transit",
        encodedPolyline: "decode-out-of-range",
        color: "#654321",
        ...INVALID_GEOMETRY_RIDES[5],
      },
      {
        mode: "transit",
        encodedPolyline: "ride-invalid-color",
        color: PROVIDER_RED,
        ...GEOMETRY_ONLY_SLOT_TWO,
      },
      // The next leg begins at this exact endpoint. Per-leg ownership must
      // still keep the two walking runs separate.
      { mode: "walk", encodedPolyline: "walk-leg-tail", color: null },
    ],
  },
  {
    id: "maps-route-two",
    category: "gallery",
    name: "Route Specimen Two",
    lat: 43.6512,
    lng: -79.4148,
    startTime: "2026-07-25T20:45:00-04:00",
    endTime: "2026-07-25T21:45:00-04:00",
    status: "upcoming",
    // `changed` lives on the destination stop, so every ride entering this
    // stop should receive the same non-colour changed-leg emphasis.
    changed: true,
    legModeToNext: "transit",
    legLabel: "77 Overflow Green · 2 stops · 15 min",
    legSegments: [OVERFLOW_RIDE],
    polylineToNext: "whole-transit-two",
    pathSegmentsToNext: [
      { mode: "walk", encodedPolyline: "walk-leg-head", color: null },
      {
        mode: "transit",
        encodedPolyline: "ride-green",
        color: "#00843D",
        ...OVERFLOW,
      },
      // The valid paths on either side meet exactly, but this missing shape
      // is an authoritative break and must prevent a merge across it.
      { mode: "walk", encodedPolyline: "walk-break-before", color: null },
      { mode: "walk", encodedPolyline: "", color: null },
      { mode: "walk", encodedPolyline: "walk-break-after", color: null },
      // Every invalid/degenerate decoder shape is isolated here.
      { mode: "walk", encodedPolyline: "walk-decode-throw", color: null },
      { mode: "walk", encodedPolyline: "walk-decode-malformed", color: null },
      { mode: "walk", encodedPolyline: "walk-decode-empty", color: null },
      { mode: "walk", encodedPolyline: "walk-decode-one", color: null },
      { mode: "walk", encodedPolyline: "walk-decode-nonfinite", color: null },
      { mode: "walk", encodedPolyline: "walk-decode-out-of-range", color: null },
      { mode: "walk", encodedPolyline: "walk-decode-zero", color: null },
      // Both pairs contain valid paths. The first is plainly disconnected;
      // the second misses the two-metre tolerance by a small measured amount.
      { mode: "walk", encodedPolyline: "walk-disconnected-a", color: null },
      { mode: "walk", encodedPolyline: "walk-disconnected-b", color: null },
      { mode: "walk", encodedPolyline: "walk-beyond-a", color: null },
      { mode: "walk", encodedPolyline: "walk-beyond-b", color: null },
    ],
  },
  {
    id: "maps-route-three",
    category: "drinks",
    name: "Route Specimen Three",
    lat: 43.6542,
    lng: -79.4098,
    startTime: "2026-07-25T22:00:00-04:00",
    endTime: "2026-07-25T23:00:00-04:00",
    status: "upcoming",
    // An ordinary whole-leg WALK keeps its one solid legacy line and ignores
    // step geometry entirely — embedded walk runs are transit-leg-only.
    legModeToNext: "walk",
    polylineToNext: "plain-walk",
    pathSegmentsToNext: [
      { mode: "walk", encodedPolyline: "ordinary-walk-step", color: null },
    ],
  },
  {
    id: "maps-route-four",
    category: "dessert",
    name: "Route Specimen Four",
    lat: 43.656,
    lng: -79.405,
    startTime: "2026-07-25T23:15:00-04:00",
    endTime: "2026-07-25T23:45:00-04:00",
    status: "upcoming",
    // A wholly legacy ride keeps provider background/foreground fallbacks on
    // the real surfaces and never receives a guessed app-owned slot.
    legModeToNext: "transit",
    legLabel: "900 Legacy Blue · 1 stop · 15 min",
    legSegments: [LEGACY_RIDE],
    polylineToNext: "legacy-whole-transit",
    pathSegmentsToNext: [
      { mode: "transit", encodedPolyline: "ride-blue", color: "#0066CC" },
    ],
  },
  {
    id: "maps-route-five",
    category: "late snack",
    name: "Route Specimen Five",
    lat: 43.6575,
    lng: -79.402,
    startTime: "2026-07-26T00:00:00-04:00",
    endTime: "2026-07-26T00:30:00-04:00",
    status: "upcoming",
    // `changed` belongs to the destination stop, so the wholly legacy inbound
    // ride still proves same-provider-colour changed emphasis.
    changed: true,
    // A legacy transit leg with no provider geometry must not become an
    // endpoint-to-endpoint straight line either.
    legModeToNext: "transit",
  },
  {
    id: "maps-route-six",
    category: "nightcap",
    name: "Route Specimen Six",
    lat: 43.659,
    lng: -79.399,
    startTime: "2026-07-26T00:45:00-04:00",
    endTime: "2026-07-26T01:15:00-04:00",
    status: "upcoming",
  },
];

const ROUTE_STRIP_STOPS: StripStop[] = [
  {
    id: "maps-route-one",
    category: "dinner",
    name: "Route Specimen One",
    start: "2026-07-25T19:00:00-04:00",
    end: "2026-07-25T20:30:00-04:00",
    status: "upcoming",
    legToNext: {
      mode: "transit",
      totalMinutes: 15,
      marginMinutes: 5,
      lineName: FIRST_LEG_RIDES[0].lineName,
      leaveISO: "2026-07-25T20:30:00-04:00",
      arriveISO: "2026-07-25T20:45:00-04:00",
      segments: FIRST_LEG_RIDES,
    },
  },
  {
    id: "maps-route-two",
    category: "gallery",
    name: "Route Specimen Two",
    start: "2026-07-25T20:45:00-04:00",
    end: "2026-07-25T21:45:00-04:00",
    status: "upcoming",
    legToNext: {
      mode: "transit",
      totalMinutes: 15,
      marginMinutes: 5,
      lineName: OVERFLOW_RIDE.lineName,
      leaveISO: "2026-07-25T21:45:00-04:00",
      arriveISO: "2026-07-25T22:00:00-04:00",
      segments: [OVERFLOW_RIDE],
    },
  },
  {
    id: "maps-route-three",
    category: "drinks",
    name: "Route Specimen Three",
    start: "2026-07-25T22:00:00-04:00",
    end: "2026-07-25T23:00:00-04:00",
    status: "upcoming",
    legToNext: {
      mode: "walk",
      totalMinutes: 15,
      marginMinutes: 0,
      lineName: null,
      leaveISO: "2026-07-25T23:00:00-04:00",
      arriveISO: "2026-07-25T23:15:00-04:00",
      segments: [],
    },
  },
  {
    id: "maps-route-four",
    category: "dessert",
    name: "Route Specimen Four",
    start: "2026-07-25T23:15:00-04:00",
    end: "2026-07-25T23:45:00-04:00",
    status: "upcoming",
    legToNext: {
      mode: "transit",
      totalMinutes: 15,
      marginMinutes: 5,
      lineName: LEGACY_RIDE.lineName,
      leaveISO: "2026-07-25T23:45:00-04:00",
      arriveISO: "2026-07-26T00:00:00-04:00",
      segments: [LEGACY_RIDE],
    },
  },
  {
    id: "maps-route-five",
    category: "late snack",
    name: "Route Specimen Five",
    start: "2026-07-26T00:00:00-04:00",
    end: "2026-07-26T00:30:00-04:00",
    status: "upcoming",
    legToNext: null,
  },
];

export default function MapsHarness() {
  const [mounted, setMounted] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [routeSpecimen, setRouteSpecimen] = useState(false);
  const [routeStops, setRouteStops] = useState(ROUTE_STOPS);
  const stops = routeSpecimen ? routeStops : STOPS;

  return (
    <main>
      <button
        type="button"
        style={{ position: "fixed", zIndex: 1000, top: 8, left: 8 }}
        onClick={() => setMounted((value) => !value)}
      >
        {mounted ? "Unmount map" : "Remount map"}
      </button>
      <button
        type="button"
        style={{ position: "fixed", zIndex: 1000, top: 40, left: 8 }}
        onClick={() => setRouteSpecimen((value) => !value)}
      >
        {routeSpecimen ? "Show fallback specimen" : "Show route specimen"}
      </button>
      {routeSpecimen && (
        <button
          type="button"
          style={{ position: "fixed", zIndex: 1000, top: 72, left: 8 }}
          onClick={() =>
            setRouteStops((current) => current.map((stop) => ({ ...stop })))
          }
        >
          Rerender routes
        </button>
      )}
      {mounted && (
        <ItineraryMap
          stops={stops}
          selected={selected}
          onSelect={setSelected}
        />
      )}
      {routeSpecimen && (
        <div data-testid="route-strip-specimen">
          <ItineraryStrip
            stops={ROUTE_STRIP_STOPS}
            selected={selected}
            onSelect={setSelected}
            now={new Date("2026-07-25T18:00:00-04:00")}
          />
        </div>
      )}
    </main>
  );
}
