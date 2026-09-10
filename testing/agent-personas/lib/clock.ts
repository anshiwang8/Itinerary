// Reaching "the plan finished on its own" inside a test run.
//
// A real plan ends hours after it starts, so natural completion cannot be
// waited out. The app has ONE documented control for this and it is a real
// server path, not a test hook: `?now=ISO` on `GET /api/itinerary/[id]`,
// described in CLAUDE.md as "the dev time control and the backbone of reroute
// testing". The conclusion lifecycle (`readItineraryWithLifecycle` →
// `withStatuses` → `maybeArchive` → the owner's pointer clear) runs inside
// that same GET, so asking for a future instant exercises the REAL
// completion and archive code, not a shortcut around it.
//
// The request is issued from the persona's own browser context, carrying the
// SAME `Authorization` header the app itself sent (captured off the wire by
// `ItineraryProbe`), so the server sees the plan's genuine owner. Ownership
// is not bypassed; without that header an owned plan answers 404, exactly as
// it would for anyone else.
//
// Every use of this is labelled in the report, so a reader can tell which
// results came from a simulated instant and which from the wall clock.

import type { Page } from "@playwright/test";
import type { ObservedItinerary } from "../types";

export interface ClockAdvanceResult {
  ok: boolean;
  status: number | null;
  /** The plan as the server described it at the simulated instant. */
  plan: ObservedItinerary | null;
  simulatedInstant: string;
  detail: string;
}

/** An instant a given number of minutes past one stop's end. */
export function instantAfterStopEnd(
  end: string | null,
  minutesPast: number
): string | null {
  if (!end) return null;
  const ms = new Date(end).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + minutesPast * 60_000).toISOString();
}

/** The instant every timed stop has finished, plus a margin. */
export function instantAfterPlanEnd(plan: ObservedItinerary, marginMinutes = 20): string {
  const ends = plan.stops
    .map((stop) => stop.end_time)
    .filter((end): end is string => typeof end === "string")
    .map((end) => new Date(end).getTime())
    .filter((ms) => Number.isFinite(ms));
  const latest = ends.length > 0 ? Math.max(...ends) : Date.now();
  return new Date(latest + marginMinutes * 60_000).toISOString();
}

/**
 * Ask the server for this plan at a future instant. Returns what it said.
 *
 * NOTE this writes: a status change commits through the store's CAS, and a
 * completed owned plan is archived and its resume pointer cleared. That is
 * the behaviour under test.
 */
export async function readPlanAt(
  page: Page,
  baseURL: string,
  planId: string,
  instantISO: string,
  authorization: string | null
): Promise<ClockAdvanceResult> {
  const url =
    baseURL + "/api/itinerary/" + planId + "?now=" + encodeURIComponent(instantISO);
  try {
    const response = await page.request.get(url, {
      headers: authorization ? { Authorization: authorization } : {},
      timeout: 45_000,
    });
    const status = response.status();
    if (!response.ok()) {
      return {
        ok: false,
        status,
        plan: null,
        simulatedInstant: instantISO,
        detail: "server answered " + status,
      };
    }
    const plan = (await response.json()) as ObservedItinerary;
    return {
      ok: true,
      status,
      plan,
      simulatedInstant: instantISO,
      detail: "plan status " + plan.status,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      plan: null,
      simulatedInstant: instantISO,
      detail: "request failed: " + String(error).slice(0, 200),
    };
  }
}
