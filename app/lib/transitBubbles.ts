// Transit route badges — the PURE half of the coloured-circle treatment,
// shared by the strip (primary surface) and the map's leg labels so the two
// can't drift. Rendering lives in the components; grouping, labelling and
// the badge/place split live here, unit-testable without a DOM.
//
// Two shapes, one badge. The MAP still stacks them (`groupBubbleUnits`) —
// a leg label has no room for prose. The STRIP puts each badge INLINE where
// its route is referenced (`lineBadges`), so the circle carries the route's
// designation and the words beside it carry the place, rather than the
// number being printed twice: once in a badge and once in the text.

import { transitRideColor } from "./transitRidePalette";

/** The slice of a TransitSummary a bubble needs. Structural, so both the
 *  server TravelLeg segments and the client view-models satisfy it. */
export interface BubbleSegment {
  lineName: string;
  shortName?: string | null;
  color?: string | null;
  textColor?: string | null;
  /** App-owned ride identity/palette metadata. It travels with the ride
   *  model, but is never part of the route badge or place label. */
  rideId?: string;
  sourceStepIndex?: number;
  paletteSlot?: number | null;
}

/** The exact colours a ride badge/bubble displays. Identified, slotted rides
 * use the app-owned occurrence palette with a known-readable white foreground;
 * legacy and explicit-overflow rides retain their provider metadata fallback. */
export function bubbleDisplayColors(seg: BubbleSegment): {
  background: string;
  foreground: string;
} {
  const assigned = transitRideColor(seg.paletteSlot);
  return assigned
    ? { background: assigned, foreground: "#FFFFFF" }
    : {
        background: seg.color || "var(--ink)",
        foreground: seg.textColor || "#FFFFFF",
      };
}

/**
 * Group ordered segments into render units — the confirmed design:
 *   1 segment  → one full-size circle (today's single-badge look, now
 *                explicitly the n=1 case of the general rule)
 *   2 segments → one stacked pair of small circles
 *   3 segments → one stacked pair + one full-size single (leftover LAST,
 *                riding order preserved)
 *   4 segments → two stacked pairs
 * A unit of length 1 renders full-size; length 2 renders stacked.
 * 0 segments → no units (walk legs / no transit detail keep their glyph).
 */
export function groupBubbleUnits<T>(segments: T[]): T[][] {
  const units: T[][] = [];
  const pairs = Math.floor(segments.length / 2);
  for (let i = 0; i < pairs * 2; i += 2) units.push([segments[i], segments[i + 1]]);
  if (segments.length % 2 === 1) units.push([segments[segments.length - 1]]);
  return units;
}

/**
 * What a bubble prints. The agency's short designation ("1", "63", "501")
 * when published; otherwise initials built from the line name ("Lakeshore
 * West" → "LW") — a circle has no room for prose. Never empty: an
 * unnamed line falls back to "T" (transit) rather than a blank dot.
 */
export function bubbleLabel(seg: BubbleSegment): string {
  const short = (seg.shortName ?? "").trim();
  if (short) return short.length <= 4 ? short : short.slice(0, 4);
  const words = (seg.lineName ?? "").trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  return initials || "T";
}

/** A route badge and the words that belong beside it. The circle carries
 *  the route's own designation, so the text next to it never repeats it:
 *  "091 Bayview" is a badge that says 091 and a place that says Bayview. */
export interface LineBadge {
  /** the ride the badge belongs to — its colour and its published name */
  segment: BubbleSegment;
  /** what the circle prints; never empty (`bubbleLabel`'s contract) */
  badge: string;
  /** what to print BESIDE the circle: the line's published name with the
   *  designation the badge already carries taken off the front. Null when
   *  the name is nothing BUT that designation — the badge has said it all,
   *  and repeating it is the thing this split exists to stop. */
  place: string | null;
}

/** leading punctuation left behind by a cut ("091 - Bayview" → "- Bayview") */
const LEADING_SEPARATORS = /^[\s\-–—:·,]+/;

/**
 * What is left of the line's name once the badge has said its part.
 *
 * The badge is the route identifier, so the text beside it should be the
 * PLACE the route serves. Agencies write the designation into the name two
 * ways — "091 Bayview" and "Line 2 Bloor–Danforth" — so the designation is
 * looked for in the first TWO tokens only. Deeper in, a matching token is a
 * coincidence rather than a prefix, and cutting there would eat words the
 * badge never said.
 *
 * NEVER a broken result, and the test is what the CIRCLE actually prints —
 * not what the agency published. When that string is not literally in the
 * name — the initials fallback ("Lakeshore West" → "LW"), a designation
 * clipped to circle width ("EXPRESS" → "EXPR") — the name stands WHOLE,
 * which is exactly what the card printed before this split existed. Cutting
 * a word the badge only half-says would lose it from the card entirely.
 * When the name is nothing but the designation ("Line 2"), the place is
 * null and the badge stands alone.
 */
export function linePlace(seg: BubbleSegment): string | null {
  const name = (seg.lineName ?? "").trim();
  if (name === "") return null;
  const badge = bubbleLabel(seg).toLowerCase();
  const tokens = name.split(/\s+/);

  let cut = -1;
  for (let i = 0; i < Math.min(2, tokens.length); i++) {
    if (tokens[i].toLowerCase() === badge) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return name;

  const rest = tokens
    .slice(cut + 1)
    .join(" ")
    .replace(LEADING_SEPARATORS, "")
    .trim();
  return rest === "" ? null : rest;
}

/**
 * The leg's rides as an ordered badge+place model — one entry per ride, in
 * riding order, which is what the strip renders inline with an arrow drawn
 * BETWEEN entries. One ride is one entry and therefore no arrow; no rides
 * (a walk leg, a plan stored before segments existed) is no entries and
 * therefore no badge at all.
 */
export function lineBadges(segments: BubbleSegment[]): LineBadge[] {
  return segments.map((segment) => ({
    segment,
    badge: bubbleLabel(segment),
    place: linePlace(segment),
  }));
}
