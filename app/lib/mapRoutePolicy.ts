export type DisplayableRouteMode = "transit" | "walk";

/**
 * A map line is evidence of provider route geometry. An unknown leg is only
 * a conservative time estimate, so drawing its coordinate-to-coordinate
 * fallback as a solid walking route would overstate what Routes returned.
 */
export function displayableRouteMode(
  mode: "transit" | "walk" | "unknown" | undefined
): DisplayableRouteMode | null {
  return mode === "transit" || mode === "walk" ? mode : null;
}
