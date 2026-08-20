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

function identifiedDisplayableLeg(
  leg: VisibilityLeg | null | undefined
): leg is VisibilityLeg & { legId: string; mode: "transit" | "walk" } {
  return (
    (leg?.mode === "transit" || leg?.mode === "walk") &&
    typeof leg.legId === "string"
  );
}

function instantMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function automaticTravelLegId(input: {
  nowMs: number;
  home?: VisibilityLeg | null;
  stops: VisibilityStop[];
}): string | null {
  const legs = [input.home, ...input.stops.map((stop) => stop.outbound)];
  const underway = legs.find(
    (leg) => identifiedDisplayableLeg(leg) && legUnderway(leg, input.nowMs)
  );
  if (underway && typeof underway.legId === "string") return underway.legId;

  const firstStopStartMs = instantMs(input.home?.arriveISO);
  if (
    input.home?.mode === "transit" &&
    typeof input.home.legId === "string" &&
    Number.isFinite(input.nowMs) &&
    firstStopStartMs !== null &&
    input.nowMs < firstStopStartMs
  ) {
    return input.home.legId;
  }

  const activeOutbound = input.stops.find((stop) => stop.status === "active")?.outbound;
  return identifiedDisplayableLeg(activeOutbound) ? activeOutbound.legId : null;
}

export function visibleTravelLegIds(
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
  return legs.some(
    (leg) => identifiedDisplayableLeg(leg) && leg.legId === manualLegId
  )
    ? manualLegId
    : null;
}

/**
 * One complete-leg visibility decision for every map surface. Modern
 * inter-stop WALK and TRANSIT legs are exact-ID gated; the compatibility
 * branches deliberately preserve identity-absent plans, the established
 * global legacy-transit fallback, and the existing always-visible home walk.
 */
export function travelLegVisible(input: {
  mode: VisibilityLeg["mode"];
  legId?: string | null;
  origin: "home" | "interstop";
  visibleLegIds: readonly string[];
  legacyTransitVisibility: boolean;
}): boolean {
  if (input.mode !== "transit" && input.mode !== "walk") return false;
  if (typeof input.legId !== "string") return true;
  if (input.mode === "transit" && input.legacyTransitVisibility) return true;
  if (input.origin === "home" && input.mode === "walk") return true;
  return input.visibleLegIds.includes(input.legId);
}
