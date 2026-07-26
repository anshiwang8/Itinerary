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

export default function MapsHarness() {
  const [mounted, setMounted] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <main>
      <button
        type="button"
        style={{ position: "fixed", zIndex: 1000, top: 8, left: 8 }}
        onClick={() => setMounted((value) => !value)}
      >
        {mounted ? "Unmount map" : "Remount map"}
      </button>
      {mounted && (
        <ItineraryMap
          stops={STOPS}
          selected={selected}
          onSelect={setSelected}
        />
      )}
    </main>
  );
}
