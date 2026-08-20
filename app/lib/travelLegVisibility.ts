import { legUnderway } from "./transitDetail";

export interface VisibilityLeg {
  legId?: string | null;
  mode?: "transit" | "walk" | "unknown";
  leaveISO?: string | null;
  arriveISO?: string | null;
}

export interface VisibilityStop {
  status?: "upcoming" | "active" | "completed" | "skipped";
  outbound?: VisibilityLeg | null;
}

export function automaticTransitLegId(input: {
  nowMs: number;
  home?: VisibilityLeg | null;
  stops: VisibilityStop[];
}): string | null {
  const legs = [input.home, ...input.stops.map((stop) => stop.outbound)];
  const underway = legs.find(
    (leg) =>
      leg?.mode === "transit" &&
      typeof leg.legId === "string" &&
      legUnderway(leg, input.nowMs)
  );
  if (underway?.legId) return underway.legId;

  const activeOutbound = input.stops.find((stop) => stop.status === "active")?.outbound;
  return activeOutbound?.mode === "transit" && typeof activeOutbound.legId === "string"
    ? activeOutbound.legId
    : null;
}

export function visibleTransitLegIds(
  automaticLegId: string | null,
  manualLegId: string | null
): string[] {
  return [...new Set([automaticLegId, manualLegId].filter((id): id is string => id !== null))];
}

export function toggleManualLegId(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

export function hasLegacyTransitLeg(legs: Array<VisibilityLeg | null | undefined>): boolean {
  return legs.some((leg) => leg?.mode === "transit" && typeof leg.legId !== "string");
}

export function retainManualLegId(
  manualLegId: string | null,
  legs: Array<VisibilityLeg | null | undefined>
): string | null {
  if (manualLegId === null) return null;
  return legs.some((leg) => leg?.mode === "transit" && leg.legId === manualLegId)
    ? manualLegId
    : null;
}
