// Transit transfer bubbles — the PURE half of the stacked-mini-circle
// treatment, shared by the strip (primary surface) and the map's leg
// labels so the two can't drift. Rendering lives in the components;
// grouping and labelling live here, unit-testable without a DOM.

/** The slice of a TransitSummary a bubble needs. Structural, so both the
 *  server TravelLeg segments and the client view-models satisfy it. */
export interface BubbleSegment {
  lineName: string;
  shortName?: string | null;
  color?: string | null;
  textColor?: string | null;
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
