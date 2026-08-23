"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ItineraryMap, { MapFocusRequest, MapHome, MapStop } from "../../ItineraryMap";
import ItineraryStrip, {
  StripHome,
  StripStop,
} from "../../ItineraryStrip";
import type { RideDetail } from "../../lib/transitDetail";
import {
  automaticTravelLegId,
  hasLegacyTransitLeg,
  retainManualLegId,
  toggleManualLegId,
  visibleTravelLegIds,
} from "../../lib/travelLegVisibility";

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
    alightLocation: { latitude: 43.649, longitude: -79.419 },
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
    alightLocation: { latitude: 43.65, longitude: -79.417 },
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

// ── DRIVING specimen (drive-vs-transit mode, Stage 1) ──
// Three legs on purpose, because a driving PLAN is not three drives:
//   1. an identified DRIVE with real provider geometry — the automatic leg,
//      so it is the one selectable card and the one solid road line;
//   2. a DRIVE with NO geometry — it must draw NOTHING. The walk branch's
//      straight-line endpoint fallback would put a fake road across the map;
//   3. a short WALK inside the same driving plan — the invariant that
//      `travelMode: "driving"` is a plan-level INTENT, not a per-leg promise.
// Legs 2 and 3 are deliberately identity-absent so they stay visible without
// competing for the one automatic/manual slot.
const DRIVING_LEG_ID = "leg:harness-drive";
const DRIVE_NOW = "2026-07-25T19:30:00-04:00";

const DRIVING_STOPS: MapStop[] = [
  {
    id: "maps-drive-one",
    category: "dinner",
    name: "Drive Specimen One",
    lat: 43.648,
    lng: -79.4214,
    startTime: "2026-07-25T19:00:00-04:00",
    endTime: "2026-07-25T20:00:00-04:00",
    status: "active",
    legModeToNext: "driving",
    legIdToNext: DRIVING_LEG_ID,
    polylineToNext: "drive-road",
    legLabel: "Drive · 22 min",
    legSegments: [],
  },
  {
    id: "maps-drive-two",
    category: "gallery",
    name: "Drive Specimen Two",
    lat: 43.656,
    lng: -79.405,
    startTime: "2026-07-25T20:22:00-04:00",
    endTime: "2026-07-25T21:22:00-04:00",
    status: "upcoming",
    legModeToNext: "driving",
    legIdToNext: null,
    polylineToNext: null,
  },
  {
    id: "maps-drive-three",
    category: "drinks",
    name: "Drive Specimen Three",
    lat: 43.66,
    lng: -79.398,
    startTime: "2026-07-25T21:40:00-04:00",
    endTime: "2026-07-25T22:40:00-04:00",
    status: "upcoming",
    legModeToNext: "walk",
    legIdToNext: null,
    polylineToNext: null,
  },
  {
    id: "maps-drive-four",
    category: "dessert",
    name: "Drive Specimen Four",
    lat: 43.662,
    lng: -79.395,
    startTime: "2026-07-25T22:48:00-04:00",
    endTime: "2026-07-25T23:18:00-04:00",
    status: "upcoming",
  },
];

const DRIVING_STRIP_STOPS: StripStop[] = [
  {
    id: "maps-drive-one",
    category: "dinner",
    name: "Drive Specimen One",
    start: "2026-07-25T19:00:00-04:00",
    end: "2026-07-25T20:00:00-04:00",
    status: "active",
    legToNext: {
      legId: DRIVING_LEG_ID,
      mode: "driving",
      totalMinutes: 22,
      marginMinutes: 10,
      lineName: null,
      leaveISO: "2026-07-25T20:00:00-04:00",
      arriveISO: "2026-07-25T20:22:00-04:00",
      segments: [],
    },
  },
  {
    id: "maps-drive-two",
    category: "gallery",
    name: "Drive Specimen Two",
    start: "2026-07-25T20:22:00-04:00",
    end: "2026-07-25T21:22:00-04:00",
    status: "upcoming",
    legToNext: {
      mode: "driving",
      totalMinutes: 18,
      marginMinutes: 10,
      lineName: null,
      leaveISO: "2026-07-25T21:22:00-04:00",
      arriveISO: "2026-07-25T21:40:00-04:00",
      segments: [],
    },
  },
  {
    id: "maps-drive-three",
    category: "drinks",
    name: "Drive Specimen Three",
    start: "2026-07-25T21:40:00-04:00",
    end: "2026-07-25T22:40:00-04:00",
    status: "upcoming",
    legToNext: {
      mode: "walk",
      totalMinutes: 8,
      marginMinutes: 0,
      lineName: null,
      leaveISO: "2026-07-25T22:40:00-04:00",
      arriveISO: "2026-07-25T22:48:00-04:00",
      segments: [],
    },
  },
  {
    id: "maps-drive-four",
    category: "dessert",
    name: "Drive Specimen Four",
    start: "2026-07-25T22:48:00-04:00",
    end: "2026-07-25T23:18:00-04:00",
    status: "upcoming",
    legToNext: null,
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
    legIdToNext: "leg:harness-first",
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
    legIdToNext: "leg:harness-second",
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
      legId: "leg:harness-first",
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
      legId: "leg:harness-second",
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

// A separate modern visibility specimen. It intentionally contains no
// identity-absent transit: the established global legacy fallback belongs to
// ROUTE_STOPS above and would make every identified transit leg visible,
// masking the exact home-boundary behavior this specimen exists to exercise.
const VISIBILITY_HOME_LEG_ID = "leg:visibility-home";
const VISIBILITY_DECODED_WALK_ID = "leg:visibility-walk-decoded";
const VISIBILITY_FALLBACK_WALK_ID = "leg:visibility-walk-fallback";
const VISIBILITY_MANUAL_WALK_ID = "leg:visibility-walk-manual";
const VISIBILITY_CHANGED_TRANSIT_ID = "leg:visibility-transit-changed";

const VISIBILITY_HOME_RIDES: RideDetail[] = [
  {
    rideId: "ride:visibility-home-local",
    sourceStepIndex: 1,
    paletteSlot: 12,
    lineName: "10 Home Local",
    shortName: "10",
    color: PROVIDER_RED,
    textColor: "#FFFF00",
    boardISO: "2026-08-20T09:08:00-04:00",
    alightISO: "2026-08-20T09:28:00-04:00",
    departStop: "Home Platform",
    arriveStop: "Visibility Junction",
    alightLocation: { latitude: 43.6485, longitude: -79.4205 },
  },
  {
    rideId: "ride:visibility-home-crosstown",
    sourceStepIndex: 3,
    paletteSlot: 13,
    lineName: "20 Crosstown",
    shortName: "20",
    color: PROVIDER_RED,
    textColor: "#FFFF00",
    boardISO: "2026-08-20T09:34:00-04:00",
    alightISO: "2026-08-20T09:55:00-04:00",
    departStop: "Visibility Junction East",
    arriveStop: "First Event Stop",
    boardLocation: { latitude: 43.6487, longitude: -79.4203 },
  },
];

const VISIBILITY_CHANGED_RIDE: RideDetail = {
  rideId: "ride:visibility-changed",
  sourceStepIndex: 0,
  paletteSlot: 14,
  lineName: "40 Changed Line",
  shortName: "40",
  color: "#0066CC",
  textColor: "#FFFFFF",
  boardISO: "2026-08-20T14:05:00-04:00",
  alightISO: "2026-08-20T14:20:00-04:00",
  departStop: "Fourth Event Stop",
  arriveStop: "Changed Event Stop",
};

type VisibilityPlan = {
  id: string;
  mapHome: MapHome;
  stripHome: StripHome;
  mapStops: MapStop[];
  stripStops: StripStop[];
};

function makeVisibilityPlan(id: string, legSuffix = ""): VisibilityPlan {
  const legId = (base: string) => `${base}${legSuffix}`;
  const mapHome: MapHome = {
    label: "Visibility Home",
    lat: 43.648,
    lng: -79.421,
    legModeToNext: "transit",
    legIdToNext: legId(VISIBILITY_HOME_LEG_ID),
    legLabel: "10 Home Local → 20 Crosstown · 60 min",
    legSegments: VISIBILITY_HOME_RIDES,
    leaveBy: "9:00 AM",
    pathSegmentsToNext: [
      { mode: "walk", encodedPolyline: "visibility-home-walk", color: null },
      {
        mode: "transit",
        encodedPolyline: "visibility-home-ride-local",
        color: PROVIDER_RED,
        rideId: VISIBILITY_HOME_RIDES[0].rideId!,
        sourceStepIndex: VISIBILITY_HOME_RIDES[0].sourceStepIndex!,
        paletteSlot: VISIBILITY_HOME_RIDES[0].paletteSlot!,
      },
      {
        mode: "walk",
        encodedPolyline: "visibility-home-transfer-walk",
        color: null,
      },
      {
        mode: "transit",
        encodedPolyline: "visibility-home-ride-crosstown",
        color: PROVIDER_RED,
        rideId: VISIBILITY_HOME_RIDES[1].rideId!,
        sourceStepIndex: VISIBILITY_HOME_RIDES[1].sourceStepIndex!,
        paletteSlot: VISIBILITY_HOME_RIDES[1].paletteSlot!,
      },
    ],
  };
  const stripHome: StripHome = {
    label: mapHome.label,
    leaveBy: mapHome.leaveBy,
    leg: {
      legId: mapHome.legIdToNext,
      mode: "transit",
      totalMinutes: 60,
      marginMinutes: 5,
      lineName: VISIBILITY_HOME_RIDES[0].lineName,
      leaveISO: "2026-08-20T09:00:00-04:00",
      arriveISO: "2026-08-20T10:00:00-04:00",
      segments: VISIBILITY_HOME_RIDES,
    },
  };

  const mapStops: MapStop[] = [
    {
      id: `visibility-first${legSuffix}`,
      category: "breakfast",
      name: "First Visibility Event",
      lat: 43.649,
      lng: -79.42,
      startTime: "2026-08-20T10:00:00-04:00",
      endTime: "2026-08-20T11:00:00-04:00",
      legModeToNext: "walk",
      legIdToNext: legId(VISIBILITY_DECODED_WALK_ID),
      legLabel: "Decoded walk · 15 min",
      polylineToNext: "visibility-walk-decoded",
    },
    {
      id: `visibility-second${legSuffix}`,
      category: "gallery",
      name: "Second Visibility Event",
      lat: 43.65,
      lng: -79.419,
      startTime: "2026-08-20T11:15:00-04:00",
      endTime: "2026-08-20T12:00:00-04:00",
      legModeToNext: "walk",
      legIdToNext: legId(VISIBILITY_FALLBACK_WALK_ID),
      legLabel: "Endpoint fallback walk · 12 min",
      // No encoded polyline: once legitimately visible, this exercises the
      // established exact two-provider-endpoint WALK fallback.
    },
    {
      id: `visibility-third${legSuffix}`,
      category: "lunch",
      name: "Third Visibility Event",
      lat: 43.651,
      lng: -79.418,
      startTime: "2026-08-20T12:12:00-04:00",
      endTime: "2026-08-20T13:00:00-04:00",
      legModeToNext: "walk",
      legIdToNext: legId(VISIBILITY_MANUAL_WALK_ID),
      legLabel: "Manual decoded walk · 18 min",
      polylineToNext: "visibility-walk-manual",
    },
    {
      id: `visibility-fourth${legSuffix}`,
      category: "park",
      name: "Fourth Visibility Event",
      lat: 43.652,
      lng: -79.417,
      startTime: "2026-08-20T13:18:00-04:00",
      endTime: "2026-08-20T14:00:00-04:00",
      legModeToNext: "transit",
      legIdToNext: legId(VISIBILITY_CHANGED_TRANSIT_ID),
      legLabel: "40 Changed Line · 25 min",
      legSegments: [VISIBILITY_CHANGED_RIDE],
      pathSegmentsToNext: [
        {
          mode: "transit",
          encodedPolyline: "visibility-transit-changed",
          color: VISIBILITY_CHANGED_RIDE.color,
          rideId: VISIBILITY_CHANGED_RIDE.rideId!,
          sourceStepIndex: VISIBILITY_CHANGED_RIDE.sourceStepIndex!,
          paletteSlot: VISIBILITY_CHANGED_RIDE.paletteSlot!,
        },
      ],
    },
    {
      id: `visibility-fifth${legSuffix}`,
      category: "drinks",
      name: "Changed Visibility Event",
      lat: 43.653,
      lng: -79.416,
      startTime: "2026-08-20T14:25:00-04:00",
      endTime: "2026-08-20T15:00:00-04:00",
      changed: true,
    },
  ];

  const stripStops: StripStop[] = [
    {
      id: mapStops[0].id,
      category: mapStops[0].category,
      name: mapStops[0].name,
      start: mapStops[0].startTime,
      end: mapStops[0].endTime,
      legToNext: {
        legId: mapStops[0].legIdToNext,
        mode: "walk",
        totalMinutes: 15,
        marginMinutes: 0,
        leaveISO: mapStops[0].endTime,
        arriveISO: mapStops[1].startTime,
      },
    },
    {
      id: mapStops[1].id,
      category: mapStops[1].category,
      name: mapStops[1].name,
      start: mapStops[1].startTime,
      end: mapStops[1].endTime,
      legToNext: {
        legId: mapStops[1].legIdToNext,
        mode: "walk",
        totalMinutes: 12,
        marginMinutes: 0,
        leaveISO: mapStops[1].endTime,
        arriveISO: mapStops[2].startTime,
      },
    },
    {
      id: mapStops[2].id,
      category: mapStops[2].category,
      name: mapStops[2].name,
      start: mapStops[2].startTime,
      end: mapStops[2].endTime,
      legToNext: {
        legId: mapStops[2].legIdToNext,
        mode: "walk",
        totalMinutes: 18,
        marginMinutes: 0,
        leaveISO: mapStops[2].endTime,
        arriveISO: mapStops[3].startTime,
      },
    },
    {
      id: mapStops[3].id,
      category: mapStops[3].category,
      name: mapStops[3].name,
      start: mapStops[3].startTime,
      end: mapStops[3].endTime,
      legToNext: {
        legId: mapStops[3].legIdToNext,
        mode: "transit",
        totalMinutes: 25,
        marginMinutes: 5,
        lineName: VISIBILITY_CHANGED_RIDE.lineName,
        leaveISO: mapStops[3].endTime,
        arriveISO: mapStops[4].startTime,
        segments: [VISIBILITY_CHANGED_RIDE],
      },
    },
    {
      id: mapStops[4].id,
      category: mapStops[4].category,
      name: mapStops[4].name,
      start: mapStops[4].startTime,
      end: mapStops[4].endTime,
      changed: true,
      legToNext: null,
    },
  ];

  return { id, mapHome, stripHome, mapStops, stripStops };
}

function cloneVisibilityPlan(plan: VisibilityPlan): VisibilityPlan {
  return {
    ...plan,
    mapHome: {
      ...plan.mapHome,
      legSegments: plan.mapHome.legSegments?.map((ride) => ({ ...ride })),
      pathSegmentsToNext: plan.mapHome.pathSegmentsToNext?.map((path) => ({
        ...path,
      })),
    },
    stripHome: {
      ...plan.stripHome,
      leg: plan.stripHome.leg
        ? {
            ...plan.stripHome.leg,
            segments: plan.stripHome.leg.segments?.map((ride) => ({ ...ride })),
          }
        : plan.stripHome.leg,
    },
    mapStops: plan.mapStops.map((stop) => ({
      ...stop,
      legSegments: stop.legSegments?.map((ride) => ({ ...ride })),
      pathSegmentsToNext: stop.pathSegmentsToNext?.map((path) => ({ ...path })),
    })),
    stripStops: plan.stripStops.map((stop) => ({
      ...stop,
      legToNext: stop.legToNext
        ? {
            ...stop.legToNext,
            segments: stop.legToNext.segments?.map((ride) => ({ ...ride })),
          }
        : stop.legToNext,
    })),
  };
}

function replaceVisibilityLeg(
  plan: VisibilityPlan,
  oldLegId: string,
  newLegId: string
): VisibilityPlan {
  const clone = cloneVisibilityPlan(plan);
  return {
    ...clone,
    mapStops: clone.mapStops.map((stop) =>
      stop.legIdToNext === oldLegId
        ? { ...stop, legIdToNext: newLegId }
        : stop
    ),
    stripStops: clone.stripStops.map((stop) =>
      stop.legToNext?.legId === oldLegId
        ? { ...stop, legToNext: { ...stop.legToNext, legId: newLegId } }
        : stop
    ),
  };
}

type VisibilityMoment =
  | "before"
  | "departure"
  | "boundary"
  | "second-active"
  | "later-active"
  | "completed";

const VISIBILITY_MOMENTS: Record<
  VisibilityMoment,
  {
    now: string;
    statuses: Record<string, NonNullable<MapStop["status"]>>;
  }
> = {
  before: { now: "2026-08-20T08:00:00-04:00", statuses: {} },
  departure: { now: "2026-08-20T09:00:00-04:00", statuses: {} },
  boundary: {
    now: "2026-08-20T10:00:00-04:00",
    statuses: { "visibility-first": "active" },
  },
  "second-active": {
    now: "2026-08-20T11:30:00-04:00",
    statuses: {
      "visibility-first": "completed",
      "visibility-second": "active",
    },
  },
  "later-active": {
    now: "2026-08-20T12:30:00-04:00",
    statuses: {
      "visibility-first": "completed",
      "visibility-second": "completed",
      "visibility-third": "active",
    },
  },
  completed: {
    now: "2026-08-20T16:00:00-04:00",
    statuses: {
      "visibility-first": "completed",
      "visibility-second": "completed",
      "visibility-third": "completed",
      "visibility-fourth": "completed",
      "visibility-fifth": "completed",
    },
  },
};

export default function MapsHarness() {
  const [mounted, setMounted] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  // Mirrors page.tsx's selectAndFocusStop: a real click routes through this,
  // so the harness proves the same nonce-request wiring the product page
  // uses. A PROGRAMMATIC setSelected (below, and every other setSelected
  // call in this file) deliberately does NOT go through this path — that
  // asymmetry is exactly what "camera never keyed on `selected`" tests.
  const [focusRequest, setFocusRequest] = useState<MapFocusRequest | null>(
    null
  );
  const focusNonce = useRef(0);
  const selectAndFocus = (stopId: string) => {
    setSelected(stopId);
    focusNonce.current += 1;
    setFocusRequest({ stopId, nonce: focusNonce.current });
  };
  const [routeSpecimen, setRouteSpecimen] = useState(false);
  const [visibilitySpecimen, setVisibilitySpecimen] = useState(false);
  const [drivingSpecimen, setDrivingSpecimen] = useState(false);
  const [manualLegId, setManualLegId] = useState<string | null>(null);
  const [routeStops, setRouteStops] = useState(ROUTE_STOPS);
  const [visibilityPlan, setVisibilityPlan] = useState(() =>
    makeVisibilityPlan("visibility-plan")
  );
  const [visibilityMoment, setVisibilityMoment] =
    useState<VisibilityMoment>("before");
  const displayedPlanId = useRef(visibilityPlan.id);
  const moment = VISIBILITY_MOMENTS[visibilityMoment];
  const visibilityNow = useMemo(() => new Date(moment.now), [moment.now]);
  const visibilityMapStops = useMemo(
    () =>
      visibilityPlan.mapStops.map((stop) => ({
        ...stop,
        status: moment.statuses[stop.id] ?? "upcoming",
      })),
    [moment.statuses, visibilityPlan.mapStops]
  );
  const visibilityStripStops = useMemo(
    () =>
      visibilityPlan.stripStops.map((stop) => ({
        ...stop,
        status: moment.statuses[stop.id] ?? "upcoming",
      })),
    [moment.statuses, visibilityPlan.stripStops]
  );
  const currentHome = visibilitySpecimen
    ? visibilityPlan.mapHome
    : undefined;
  const currentStripHome = visibilitySpecimen
    ? visibilityPlan.stripHome
    : undefined;
  const currentStripStops = useMemo(
    () =>
      drivingSpecimen
        ? DRIVING_STRIP_STOPS
        : visibilitySpecimen
          ? visibilityStripStops
          : routeSpecimen
            ? ROUTE_STRIP_STOPS
            : [],
    [drivingSpecimen, routeSpecimen, visibilitySpecimen, visibilityStripStops]
  );
  const stops = drivingSpecimen
    ? DRIVING_STOPS
    : visibilitySpecimen
      ? visibilityMapStops
      : routeSpecimen
        ? routeStops
        : STOPS;
  const projectedTravelLegs = useMemo(
    () => [
      currentStripHome?.leg,
      ...currentStripStops.map((stop) => stop.legToNext),
    ],
    [currentStripHome, currentStripStops]
  );
  const automaticLegId = useMemo(
    () =>
      automaticTravelLegId({
        nowMs: drivingSpecimen
          ? new Date(DRIVE_NOW).getTime()
          : visibilitySpecimen
            ? visibilityNow.getTime()
            : new Date("2026-07-25T18:00:00-04:00").getTime(),
        home: currentStripHome?.leg,
        stops: currentStripStops.map((stop) => ({
          status: stop.status,
          outbound: stop.legToNext,
        })),
      }),
    [
      currentStripHome,
      currentStripStops,
      drivingSpecimen,
      visibilityNow,
      visibilitySpecimen,
    ]
  );
  const visibleLegIds = useMemo(
    () => visibleTravelLegIds(automaticLegId, manualLegId),
    [automaticLegId, manualLegId]
  );
  const legacyTransitVisibility = useMemo(
    () => hasLegacyTransitLeg(projectedTravelLegs),
    [projectedTravelLegs]
  );

  // These two effects deliberately mirror page.tsx. Plan/history identity
  // replacement clears ephemeral manual state, while an ordinary render or
  // topology update retains it only if that exact app-owned leg ID survives.
  useEffect(() => {
    if (displayedPlanId.current !== visibilityPlan.id) {
      setManualLegId(null);
      displayedPlanId.current = visibilityPlan.id;
    }
  }, [visibilityPlan.id]);

  useEffect(() => {
    // Same retention effect as the product page; the state update is the
    // synchronization target, not derived render data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setManualLegId((current) =>
      retainManualLegId(current, projectedTravelLegs)
    );
  }, [projectedTravelLegs]);

  const showRouteSpecimen = () => {
    setVisibilitySpecimen(false);
    setDrivingSpecimen(false);
    setRouteSpecimen(true);
    setManualLegId(null);
    setSelected(null);
  };

  const showDrivingSpecimen = () => {
    setVisibilitySpecimen(false);
    setDrivingSpecimen(true);
    setRouteSpecimen(true);
    setManualLegId(null);
    setSelected(null);
  };

  const showVisibilitySpecimen = () => {
    setVisibilityPlan(makeVisibilityPlan("visibility-plan"));
    setVisibilityMoment("before");
    setDrivingSpecimen(false);
    setVisibilitySpecimen(true);
    setRouteSpecimen(true);
    setManualLegId(null);
    setSelected(null);
  };

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
        onClick={() => {
          if (routeSpecimen && !visibilitySpecimen && !drivingSpecimen) {
            setRouteSpecimen(false);
            setManualLegId(null);
            setSelected(null);
          } else {
            showRouteSpecimen();
          }
        }}
      >
        {routeSpecimen && !visibilitySpecimen && !drivingSpecimen
          ? "Show fallback specimen"
          : "Show route specimen"}
      </button>
      {routeSpecimen && !visibilitySpecimen && !drivingSpecimen && (
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
      <button
        type="button"
        style={{ position: "fixed", zIndex: 1000, top: 136, left: 8 }}
        onClick={() => {
          if (drivingSpecimen) showRouteSpecimen();
          else showDrivingSpecimen();
        }}
      >
        {drivingSpecimen ? "Show all-leg specimen" : "Show driving specimen"}
      </button>
      <button
        type="button"
        style={{ position: "fixed", zIndex: 1000, top: 104, left: 8 }}
        onClick={() => {
          if (visibilitySpecimen) showRouteSpecimen();
          else showVisibilitySpecimen();
        }}
      >
        {visibilitySpecimen ? "Show all-leg specimen" : "Show visibility specimen"}
      </button>
      {visibilitySpecimen && (
        <div
          data-testid="visibility-controls"
          style={{
            position: "fixed",
            zIndex: 1000,
            top: 8,
            left: 170,
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            maxWidth: 1000,
          }}
        >
          <button type="button" onClick={() => setVisibilityMoment("before")}>
            Before departure
          </button>
          <button
            type="button"
            onClick={() => setVisibilityMoment("departure")}
          >
            Exact home departure
          </button>
          <button
            type="button"
            onClick={() => setVisibilityMoment("boundary")}
          >
            Exact first-stop boundary
          </button>
          <button
            type="button"
            onClick={() => setVisibilityMoment("second-active")}
          >
            Second stop active
          </button>
          <button
            type="button"
            onClick={() => setVisibilityMoment("later-active")}
          >
            Later active stop
          </button>
          <button
            type="button"
            onClick={() => setVisibilityMoment("completed")}
          >
            All stops completed
          </button>
          <button
            type="button"
            onClick={() => setVisibilityPlan((plan) => cloneVisibilityPlan(plan))}
          >
            Rerender visibility plan
          </button>
          <button
            type="button"
            onClick={() =>
              setVisibilityPlan((plan) => cloneVisibilityPlan(plan))
            }
          >
            Reroute clone exact IDs
          </button>
          <button
            type="button"
            onClick={() =>
              setVisibilityPlan((plan) =>
                replaceVisibilityLeg(
                  plan,
                  VISIBILITY_MANUAL_WALK_ID,
                  `${VISIBILITY_MANUAL_WALK_ID}:rerouted`
                )
              )
            }
          >
            Reroute replace manual leg
          </button>
          <button
            type="button"
            onClick={() =>
              setVisibilityPlan(makeVisibilityPlan("visibility-history-plan"))
            }
          >
            Replace plan or history
          </button>
          <button type="button" onClick={showVisibilitySpecimen}>
            Reset visibility plan
          </button>
        </div>
      )}
      <button
        type="button"
        style={{ position: "fixed", zIndex: 1000, top: 168, left: 8 }}
        onClick={() => setSelected(stops[0]?.id ?? null)}
      >
        Select first stop programmatically
      </button>
      {mounted && (
        <ItineraryMap
          stops={stops}
          home={currentHome}
          selected={selected}
          onSelect={selectAndFocus}
          visibleTravelLegIds={visibleLegIds}
          legacyTransitVisibility={legacyTransitVisibility}
          focusRequest={focusRequest}
        />
      )}
      {routeSpecimen && (
        <div
          data-testid={
            drivingSpecimen
              ? "driving-strip-specimen"
              : visibilitySpecimen
                ? "visibility-strip-specimen"
                : "route-strip-specimen"
          }
        >
          <ItineraryStrip
            home={currentStripHome}
            stops={currentStripStops}
            selected={selected}
            onSelect={selectAndFocus}
            now={
              drivingSpecimen
                ? new Date(DRIVE_NOW)
                : visibilitySpecimen
                  ? visibilityNow
                  : new Date("2026-07-25T18:00:00-04:00")
            }
            manualLegId={manualLegId}
            onToggleManualLeg={(legId) =>
              setManualLegId((current) => toggleManualLegId(current, legId))
            }
          />
        </div>
      )}
    </main>
  );
}
