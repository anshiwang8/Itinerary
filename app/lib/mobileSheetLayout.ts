// Pure content-sequencing for the mobile bottom sheet. Takes the exact same
// `StripHome`/`StripStop` data already flowing into the desktop
// `ItineraryStrip` (see ItineraryStrip.tsx) and decides two things no
// touch/DOM code should decide on its own:
//   - buildSheetEntries: the flattened home/leg/stop/leg/... sequence the
//     HALF carousel pages through and the FULL list renders as rows —
//     mirrors ItineraryStrip's own JSX order exactly (home, home's leg, then
//     each stop followed by its legToNext) so the two surfaces can never
//     silently disagree about which stop comes after which leg.
//   - pickPeekStop: which single stop the PEEK line names.
// No React, no DOM — provable with plain objects, same shape as
// bottomSheet.ts.

import type { StripHome, StripLeg, StripStop } from "../ItineraryStrip";

export type SheetEntry =
  | { kind: "home"; home: StripHome }
  | { kind: "leg"; leg: StripLeg; id: string }
  | { kind: "stop"; stop: StripStop };

/**
 * The flattened home -> leg -> stop -> leg -> stop... sequence, in riding
 * order. `id` on a leg entry is synthesized (never the leg's own possibly-null
 * `legId`) purely so each carousel page / list row has a stable React key;
 * it carries no other meaning and nothing reads it back as an identity.
 */
export function buildSheetEntries(
  home: StripHome | null | undefined,
  stops: StripStop[]
): SheetEntry[] {
  const entries: SheetEntry[] = [];
  if (home) entries.push({ kind: "home", home });
  if (home?.leg) entries.push({ kind: "leg", leg: home.leg, id: "home-leg" });
  for (const stop of stops) {
    entries.push({ kind: "stop", stop });
    if (stop.legToNext) {
      entries.push({ kind: "leg", leg: stop.legToNext, id: `leg-${stop.id}` });
    }
  }
  return entries;
}

/**
 * The single stop the PEEK line names: the ACTIVE stop if one is underway,
 * else the first UPCOMING stop, else the last stop (every stop completed or
 * skipped — the outing is effectively done, and naming the last one read is
 * more honest than naming nothing). Returns null only when there are no
 * stops at all, mirroring ItineraryStrip's own `stops.length === 0` guard.
 */
export function pickPeekStop(stops: StripStop[]): StripStop | null {
  if (stops.length === 0) return null;
  const active = stops.find((s) => s.status === "active");
  if (active) return active;
  const upcoming = stops.find((s) => s.status === "upcoming");
  if (upcoming) return upcoming;
  return stops[stops.length - 1];
}
