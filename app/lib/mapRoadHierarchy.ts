// Zoom-dependent road hierarchy for the map style. Google's classic
// `MapTypeStyle` array (what ItineraryMap.tsx's PAPER_STYLE is, and the only
// styling mechanism available without a Cloud-configured Map ID) has NO
// notion of zoom in its own schema — a single static style array cannot say
// "hide this feature below zoom 14." The zoom-dependence here is achieved by
// the caller listening to the map's own `zoom_changed` event and swapping
// which static array is active, band by band — this module only decides
// which band a given zoom falls in and what that band's road overrides are.
// Both are pure and DOM-free so the decision can be proven without a live
// Maps instance.
//
// This is genuinely achievable via the inline style array (no Map ID
// required) — see the DEVLOG entry for the live-probed alternative
// (Cloud-based per-zoom "Feature layers") that was NOT needed here.

export type RoadHierarchyBand = "high" | "low";

/** Below this zoom the city reads as a wide area, not a neighbourhood —
 *  local streets stop being useful and start being clutter. Matches the
 *  map's own initial zoom (14) as the boundary: the default city-level view
 *  starts simplified, and zooming in to street level (past STOP_FOCUS_ZOOM's
 *  neighbourhood, 17) restores full detail. A feel constant, not a
 *  measurement — same category as DRIVING_MARGIN_MIN. */
export const ROAD_HIERARCHY_ZOOM_THRESHOLD = 14;

export function roadHierarchyBand(zoom: number): RoadHierarchyBand {
  return zoom >= ROAD_HIERARCHY_ZOOM_THRESHOLD ? "high" : "low";
}

/**
 * Road-specific style overrides for a band, meant to be appended AFTER the
 * base style array (Maps styling applies later array entries as overrides
 * for a matching feature/element selector, so appending — never
 * prepending — is what makes these take effect over the base road rules).
 *
 * "high" (zoom >= threshold): no override — the base style's unconditional
 * road rules already read as full detail.
 *
 * "low" (zoom < threshold): road.local (the minor/residential grid) is
 * hidden outright — geometry and labels both, via one feature-level
 * visibility rule — since at a wide-area zoom it is line noise, not
 * information. road.arterial keeps its geometry (the street GRID shape
 * still reads at a glance) but loses its labels, the biggest single source
 * of clutter at this zoom. road.highway is untouched in both bands: the
 * major-road skeleton stays visible and labeled at every zoom, per the
 * task's explicit requirement.
 */
export function roadHierarchyStyles(band: RoadHierarchyBand): google.maps.MapTypeStyle[] {
  if (band === "high") return [];
  return [
    { featureType: "road.local", stylers: [{ visibility: "off" }] },
    { featureType: "road.arterial", elementType: "labels", stylers: [{ visibility: "off" }] },
  ];
}
