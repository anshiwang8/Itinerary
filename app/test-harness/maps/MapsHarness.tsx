"use client";

import { useState } from "react";
import ItineraryMap, { MapStop } from "../../ItineraryMap";

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
    // This valid whole-leg shape must not be used once authoritative step
    // data exists: a broken ride step cannot become a fabricated fallback.
    polylineToNext: "whole-transit",
    pathSegmentsToNext: [
      { mode: "walk", encodedPolyline: "walk-step", color: null },
      { mode: "transit", encodedPolyline: "ride-red", color: "#D71920" },
      { mode: "transit", encodedPolyline: "", color: "#123456" },
      { mode: "transit", encodedPolyline: "ride-fallback", color: null },
      { mode: "transit", encodedPolyline: "decode-throw", color: "#654321" },
      { mode: "transit", encodedPolyline: "decode-empty", color: "#654321" },
      { mode: "transit", encodedPolyline: "decode-one", color: "#654321" },
      { mode: "transit", encodedPolyline: "decode-nonfinite", color: "#654321" },
      { mode: "transit", encodedPolyline: "decode-out-of-range", color: "#654321" },
      { mode: "transit", encodedPolyline: "ride-invalid-color", color: "route-red" },
      { mode: "transit", encodedPolyline: "ride-blue", color: "#0066CC" },
      { mode: "walk", encodedPolyline: "walk-step-two", color: null },
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
    legModeToNext: "walk",
    polylineToNext: "plain-walk",
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
    // A legacy transit leg with no provider geometry must not become an
    // endpoint-to-endpoint straight line either.
    legModeToNext: "transit",
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
    </main>
  );
}
