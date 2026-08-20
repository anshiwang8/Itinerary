// Fixed, browser-safe itinerary colours. Palette slots are allocated by the
// schedule/mutation layer; presentation only resolves a valid slot here.
export const TRANSIT_RIDE_PALETTE = [
  "#005A9C",
  "#9A4D00",
  "#006B57",
  "#A31545",
  "#5F6500",
  "#6B4C9A",
  "#B3261E",
  "#006D8F",
  "#76502F",
  "#5145A4",
  "#3F6B35",
  "#8A3A75",
  "#2D6FA3",
  "#B05A14",
  "#1B7A67",
  "#B13F68",
  "#687014",
  "#805DA8",
  "#C13F37",
  "#176F89",
  "#89654A",
  "#675ABD",
  "#46753D",
  "#A04B87",
] as const;

export function transitRideColor(paletteSlot: unknown): string | undefined {
  if (
    typeof paletteSlot !== "number" ||
    !Number.isInteger(paletteSlot) ||
    paletteSlot < 0 ||
    paletteSlot >= TRANSIT_RIDE_PALETTE.length
  ) {
    return undefined;
  }
  return TRANSIT_RIDE_PALETTE[paletteSlot];
}
