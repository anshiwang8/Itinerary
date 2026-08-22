export type DisplayableRouteMode = "transit" | "walk" | "driving";

/**
 * A map line is evidence of provider route geometry. An unknown leg is only
 * a conservative time estimate, so drawing its coordinate-to-coordinate
 * fallback as a solid walking route would overstate what Routes returned.
 *
 * "driving" is displayable for the same reason transit and walk are: a DRIVE
 * response populates `route.polyline.encodedPolyline` exactly as the other
 * modes do, so a driving leg's line is real provider geometry. What it must
 * NOT inherit is the walk branch's straight-line endpoint fallback — a line
 * between two venues is not a road. That rule lives at the draw site.
 */
export function displayableRouteMode(
  mode: "transit" | "walk" | "driving" | "unknown" | undefined
): DisplayableRouteMode | null {
  return mode === "transit" || mode === "walk" || mode === "driving"
    ? mode
    : null;
}
