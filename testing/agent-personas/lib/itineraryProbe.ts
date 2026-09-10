// Reads the plan's REAL data back off the wire.
//
// The app already fetches `GET /api/itinerary/<id>` after creating a plan and
// after every mutation (page.tsx: `readItinerary` / `refreshItinerary`). This
// listens to those responses rather than issuing its own, so the harness sees
// EXACTLY what the browser saw — same plan, same version, no extra provider
// cost and no second source of truth.
//
// It also captures the `Authorization` header the app itself sent, which is
// what lets the clock-simulation helper ask the same server the same question
// at a different instant (`?now=`, the app's own documented time control).

import type { Page } from "@playwright/test";
import type { ObservedItinerary } from "../types";

/** `GET /api/itinerary/<id>` — the read after creation and after every
 *  mutation. Body IS the itinerary. */
const BY_ID = /^\/api\/itinerary\/[A-Za-z0-9-]{1,128}$/;

/** `GET /api/itinerary` — the RESUME read, which fires on every page load.
 *  Different path AND different shape (`{ itinerary }`). Missing it is not a
 *  small gap: after a reload the probe would keep serving the pre-reload plan,
 *  so a status this harness waited for would look like it never arrived. */
const RESUME = /^\/api\/itinerary$/;

export class ItineraryProbe {
  private latest: ObservedItinerary | null = null;
  private latestAt = 0;
  private authorization: string | null = null;
  readonly seenPlanIds: string[] = [];

  attach(page: Page): void {
    page.on("request", (request) => {
      const header = request.headers()["authorization"];
      if (header && header.startsWith("Bearer ")) this.authorization = header;
    });
    page.on("response", (response) => {
      const request = response.request();
      if (request.method() !== "GET") return;
      const url = new URL(response.url());
      const byId = BY_ID.test(url.pathname);
      const resume = RESUME.test(url.pathname);
      if (!byId && !resume) return;
      if (!response.ok()) return;
      void response
        .json()
        .then((body: unknown) => {
          const parsed = asItinerary(
            resume && body && typeof body === "object"
              ? (body as { itinerary?: unknown }).itinerary
              : body
          );
          if (!parsed) return;
          this.latest = parsed;
          this.latestAt = Date.now();
          if (!this.seenPlanIds.includes(parsed.id)) this.seenPlanIds.push(parsed.id);
        })
        .catch(() => {
          /* a body we cannot read is not a plan; the UI checks still stand */
        });
    });
  }

  current(): ObservedItinerary | null {
    return this.latest;
  }

  authHeader(): string | null {
    return this.authorization;
  }

  /** Wait until a plan has been observed (or the deadline passes). */
  async waitForPlan(timeoutMs: number): Promise<ObservedItinerary | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.latest) return this.latest;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.latest;
  }

  /**
   * Wait for a plan read that happened AFTER `sinceMs`.
   *
   * A reload re-reads the plan through the resume route, and only that fresh
   * read carries statuses derived against the current instant. Waiting a fixed
   * few seconds instead would sometimes read the pre-reload plan and report a
   * stop as still upcoming when the server had already called it active.
   */
  async waitForReadAfter(sinceMs: number, timeoutMs: number): Promise<ObservedItinerary | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.latestAt > sinceMs) return this.latest;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.latest;
  }

  /** Wait for a plan whose version is newer than `afterVersion`. */
  async waitForVersionAfter(
    afterVersion: number,
    timeoutMs: number
  ): Promise<ObservedItinerary | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.latest && this.latest.version > afterVersion) return this.latest;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.latest;
  }
}

function asItinerary(body: unknown): ObservedItinerary | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  if (!Array.isArray(record.stops) || !Array.isArray(record.legs)) return null;
  return body as ObservedItinerary;
}

/** The plan's timed stops, in order — the ones a persona can travel to. */
export function timedStops(plan: ObservedItinerary) {
  return plan.stops.filter((stop) => stop.start_time !== null && stop.location);
}

/** The leg that ARRIVES at timed-stop index `index`: the home leg for the
 *  first, otherwise the preceding stop's own outbound leg. */
export function inboundLeg(plan: ObservedItinerary, index: number) {
  if (index <= 0) return plan.homeLeg ?? null;
  const previous = timedStops(plan)[index - 1];
  if (previous?.travelToNext) return previous.travelToNext;
  return plan.legs.find((leg) => leg.fromIndex === index - 1) ?? null;
}
