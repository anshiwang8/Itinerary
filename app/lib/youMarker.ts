// PIECE 2 of live location tracking — deciding what the "you are here" marker
// shows, given the Piece 1 tracker state. Pure and DOM-free, the same mold as
// `activeTriangleCreep.ts` / `cameraTween.ts`: `nowMs` is injected so every
// branch is provable without a clock, a map, or a real GPS.
//
// ─────────────────────────────────────────────────────────────────────────
// THE ONE LOAD-BEARING RULE: a stale fix must NEVER look as current as a
// live one, and a fix that does not exist must NEVER be drawn at all.
// ─────────────────────────────────────────────────────────────────────────
// CLAUDE.md's core architecture rule forbids inventing a verifiable fact,
// and "where the device is" is one. So:
//   - RENDER NOTHING unless the tracker holds a REAL fix. "requesting" with
//     no prior fix, "denied", "unavailable", "off" all carry
//     `position: null` and return null here — no placeholder, no guess.
//   - The rendered coordinate is EXACTLY `state.position`, every call. It
//     never drifts with `nowMs` (a test pins this) — the marker is not a
//     dead-reckoning estimate.
//   - STALE is every state that still holds a fix but is not fresh right
//     now: `status: "stale"`, the retained-fix gap after returning from a
//     backgrounded tab (`status: "requesting"` with a kept position), and
//     the up-to-one-heartbeat window where `status` is still "live" but the
//     fix has aged past `LIVE_TRACKING_STALENESS_MS`. The caller must give
//     a stale marker a visibly different treatment (muted colour + a "Last
//     known 7:42 PM" label).

import {
  LIVE_TRACKING_DENIED_NOTE,
  LIVE_TRACKING_STALENESS_MS,
  LIVE_TRACKING_UNAVAILABLE_NOTE,
  LIVE_TRACKING_WHILE_OPEN_NOTE,
  type LiveTrackingState,
  type LiveTrackingStatus,
} from "./liveTracking";

export interface YouMarkerView {
  /** exactly what the device last reported — never interpolated. */
  lat: number;
  lng: number;
  /** the device's own accuracy estimate in metres, or null when it gave no
   *  usable figure. Null means: draw the dot, draw no accuracy ring. */
  accuracyM: number | null;
  /** true when the fix is not currently fresh (see the STALE note above).
   *  The caller renders a muted dot and a "last known" time when set. */
  stale: boolean;
  /** ms since we RECEIVED the last real fix (our clock), or null. */
  ageMs: number | null;
  /** our-clock epoch of the last real fix — the caller formats this into a
   *  "Last known 7:42 PM" label in the plan's own timezone. */
  lastFixAtMs: number;
}

/**
 * What the map's "you are here" marker should show, or null to render
 * nothing. `nowMs` is the app's one clock instant (the same `displayNow`
 * every other time-aware surface reads).
 */
export function computeYouMarker(
  state: Pick<LiveTrackingState, "status" | "position" | "lastUpdatedAt">,
  nowMs: number
): YouMarkerView | null {
  const { position } = state;
  if (!position) return null;
  if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) {
    return null;
  }
  // Defensive: the Piece 1 module never carries a position in these states
  // today, but if that ever changes, a not-fresh status must not paint a
  // dot that reads as live.
  if (
    state.status === "off" ||
    state.status === "denied" ||
    state.status === "unavailable"
  ) {
    return null;
  }

  const accuracyM =
    Number.isFinite(position.accuracyM) && position.accuracyM > 0
      ? position.accuracyM
      : null;
  const ageMs =
    state.lastUpdatedAt != null ? Math.max(0, nowMs - state.lastUpdatedAt) : null;

  // Fresh only when the module says "live" AND the fix has not aged past the
  // staleness threshold since we received it — the heartbeat runs every 15s,
  // so `status` can lag the truth by up to one interval, and this closes
  // that gap on the display side.
  const fresh =
    state.status === "live" &&
    (ageMs === null || ageMs <= LIVE_TRACKING_STALENESS_MS);

  return {
    lat: position.lat,
    lng: position.lng,
    accuracyM,
    stale: !fresh,
    ageMs,
    lastFixAtMs: state.lastUpdatedAt ?? position.deviceTimestamp,
  };
}

/**
 * Accessible name + tooltip for the map's live-location toggle. `wanted` is
 * the user's on/off intent; `status` is the tracker's current state.
 */
export function liveControlLabel(
  wanted: boolean,
  status: LiveTrackingStatus
): string {
  if (!wanted) return "Show your live location on the map";
  switch (status) {
    case "requesting":
      return "Finding your location";
    case "live":
      return `Live location on. ${LIVE_TRACKING_WHILE_OPEN_NOTE}`;
    case "stale":
      return "Live location paused. It resumes when you come back to this tab.";
    case "denied":
      return LIVE_TRACKING_DENIED_NOTE;
    case "unavailable":
      return LIVE_TRACKING_UNAVAILABLE_NOTE;
    case "off":
      return "Show your live location on the map";
  }
}
