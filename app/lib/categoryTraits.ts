// ONE place that decides what KIND of thing a free-vocab category is.
//
// Four separate regexes used to answer overlapping questions — the weather
// gate's OUTDOOR_PATTERN, the search type filter's PARK_PATTERN, the
// duration table's park rule, and the plausible-band park entry — and they
// disagreed on membership. A category containing "patio" was weather-gated
// but got no park type filter, park duration, or park band; "bench" was the
// exact inverse, hard-filtered to Places' park type yet never weather-gated,
// so a bench sit could be planned in a thunderstorm. Consolidated here so a
// category's treatment is coherent everywhere (code-audit 2026-07-18 §5.3).
//
// The two traits are deliberately DISTINCT rather than one boolean: a patio
// bar is weather-exposed but is not a park, and must not be searched,
// timed, or banded like one.

/** Green space and the activities that happen in it — a real park, not a
 *  venue with a view. Drives the Places `includedType: "park"` filter, the
 *  park duration, and the dawn-to-dusk plausible band.
 *  `\bwalk\b` is a word boundary on purpose: a "boardwalk cafe" is a cafe. */
const PARK_LIKE =
  /park|trail|garden|green\s*space|greenspace|beach|bench|stroll|hike|picnic|\bwalk\b/i;

/** Weather-exposed but NOT green space: you're outside, so rain and cold
 *  matter, but it's still a commercial venue. */
const OPEN_AIR = /patio|terrace|rooftop|outdoor|market/i;

export interface CategoryTraits {
  /** subject to the weather gate */
  outdoor: boolean;
  /** treated as green space: park search type, park duration, park band */
  parkLike: boolean;
}

export function categoryTraits(raw: string): CategoryTraits {
  const s = raw ?? "";
  const parkLike = PARK_LIKE.test(s);
  return { parkLike, outdoor: parkLike || OPEN_AIR.test(s) };
}

/** Is this category weather-sensitive? (park-like OR open-air) */
export function isOutdoorCategory(raw: string): boolean {
  return categoryTraits(raw).outdoor;
}

/** Is this category green space? */
export function isParkLike(raw: string): boolean {
  return categoryTraits(raw).parkLike;
}
