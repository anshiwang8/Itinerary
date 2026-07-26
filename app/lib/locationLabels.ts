/**
 * Remove the UI's semantic origin prefix while preserving the geocoder's
 * formatted city/address verbatim.
 */
export function originDisplayLabel(label: string): string {
  return label.replace(/^(?:Home|Start)\s*·\s*/i, "").trim();
}
