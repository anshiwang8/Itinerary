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
  state: Pick<
    LiveTrackingState,
    "status" | "position" | "lastUpdatedAt" | "fixAgeAtReceiptMs"
  >,
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

  // TWO independent staleness gaps, and `fresh` must fail on EITHER:
  //
  //   1. ACCRUED-AFTER-ARRIVAL — a fix that was current when it landed but
  //      has since aged out. `status` can lag by up to one 15s heartbeat,
  //      so the `ageMs` (time since WE received it) check closes that on the
  //      display side. This is the gap this comment used to describe alone.
  //
  //   2. STALE-ON-ARRIVAL — a fix whose OWN timestamp was already older than
  //      the threshold when the device handed it over (seen live: an
  //      18h-old position painted confidently blue). `liveTracking` now
  //      measures that at receipt and carries it as `fixAgeAtReceiptMs`;
  //      past the threshold the dot must read "last known" from its first
  //      paint. Gap 1 never looked at the fix's own timestamp and did NOT
  //      cover this — the module also sets `status: "stale"` for it, but we
  //      re-check here so a future state that somehow kept "live" still
  //      cannot paint current.
  const fresh =
    state.status === "live" &&
    (ageMs === null || ageMs <= LIVE_TRACKING_STALENESS_MS) &&
    (state.fixAgeAtReceiptMs == null ||
      state.fixAgeAtReceiptMs <= LIVE_TRACKING_STALENESS_MS);

  // The instant the position was actually recorded, on OUR clock: receipt
  // time minus how old the fix already was at receipt. For an ordinary fix
  // that is ~receipt time; for one that arrived already stale it is the
  // genuinely older instant, so the "Last known 9:47 PM" tag tells the
  // truth instead of showing a near-current time. Falls back to receipt
  // time, then the device's own clock, when that age was not knowable
  // (device clock ahead of ours).
  const lastFixAtMs =
    state.lastUpdatedAt != null && state.fixAgeAtReceiptMs != null
      ? state.lastUpdatedAt - state.fixAgeAtReceiptMs
      : state.lastUpdatedAt ?? position.deviceTimestamp;

  return {
    lat: position.lat,
    lng: position.lng,
    accuracyM,
    stale: !fresh,
    ageMs,
    lastFixAtMs,
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
