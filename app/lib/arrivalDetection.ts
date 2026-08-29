// PIECE 3 of live location tracking — deciding whether the traveller has
// ARRIVED at the stop that is active right now, from the Piece 1 position
// stream. Pure and DOM-free, the same mold as `activeTriangleCreep.ts` /
// `youMarker.ts` / `cameraTween.ts`: no clock of its own (every instant is
// in the sample), no geometry of its own (the caller measures the distance
// with the Maps library it already loads and passes the metres in), so
// every branch below is provable without a map, a real GPS, or a DOM.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS DECIDES, AND WHAT IT DELIBERATELY DOES NOT
// ─────────────────────────────────────────────────────────────────────────
// CLAUDE.md's core rule: the LLM does semantic work, CODE owns every
// verifiable fact. "Has the traveller arrived" is a fact — a distance
// comparison against a real device position held for a real span of time —
// so it lives here, in code, never in a model.
//
// It is DISPLAY-ONLY. Arrival here never touches the stored itinerary, the
// schedule, the schedule cursor, or any mutation engine (swap / remove /
// reroute / mode switch). Investigation B flagged "let arrival influence the
// schedule" as the dangerous option; it is explicitly out of scope. This
// module folds observations into a session-local boolean and nothing more.
// If the page reloads, the fold restarts from zero and arrival is
// re-detected — an accepted consequence of not persisting it.
//
// ─────────────────────────────────────────────────────────────────────────
// THE FOLD
// ─────────────────────────────────────────────────────────────────────────
// `reduceArrival(prev, sample)` takes the running progress and one
// observation of "where the live fix sits relative to the active stop, and
// when" and returns the next progress. The caller runs it once per render
// (there is no ticker anywhere in this app — see CLAUDE.md, "'Now' DOES NOT
// TICK"); a new device fix, or the active stop moving on, is what carries
// real new information into the fold, and each of those forces a render.

/** A distance threshold in metres: the live fix must be within this of the
 *  active stop's own coordinate to count toward arrival.
 *
 *  POLICY, not a measurement — the same discipline as `DRIVING_MARGIN_MIN`
 *  and `DRIVING_SHORT_LEG_WALK_METERS`. Reasoning, not data:
 *   - Piece 1 runs with `enableHighAccuracy: false`, so fixes come from
 *     wifi / cell towers: typically 20-65 m of error in a dense city, and
 *     the radius has to clear that band or a traveller genuinely standing
 *     at the door is kept from "arrived" by ordinary positioning scatter.
 *   - But not so loose that it fires from across a wide street or the far
 *     end of the block. Downtown Toronto blocks run ~100-150 m; 75 m keeps
 *     "arrived" to roughly "this building and its immediate frontage".
 *  75 m is the midpoint that satisfies both. If it proves too coarse or too
 *  tight in a real tuning pass, this constant (or Piece 1's
 *  `LIVE_TRACKING_ENABLE_HIGH_ACCURACY`) is the single knob. */
export const ARRIVAL_RADIUS_M = 75;

/** How long the fix must stay within `ARRIVAL_RADIUS_M` — continuously, on
 *  fresh accurate fixes — before arrival is confirmed.
 *
 *  POLICY, not a measurement. Reasoning:
 *   - With `maximumAge: 15_000` and `watchPosition` firing every ~10-30 s in
 *     practice, 45 s means at least two or three separate fixes have to
 *     agree you are here. One noisy fix that lands inside the radius while
 *     you walk past cannot trigger it — that is the whole point of a dwell.
 *   - Short enough that a traveller who actually stops is marked arrived
 *     inside a minute, not made to wait.
 *   - It deliberately equals `LIVE_TRACKING_STALENESS_MS` (45 s). They are
 *     not required to match, but it is the same "a healthy device should
 *     have produced corroborating evidence within this span" intuition, and
 *     reusing the number is better than minting a second one to drift from. */
export const ARRIVAL_DWELL_MS = 45_000;

export interface ArrivalConfig {
  /** metres — `ARRIVAL_RADIUS_M`. */
  radiusM: number;
  /** ms — `ARRIVAL_DWELL_MS`. */
  dwellMs: number;
}

export const DEFAULT_ARRIVAL_CONFIG: ArrivalConfig = {
  radiusM: ARRIVAL_RADIUS_M,
  dwellMs: ARRIVAL_DWELL_MS,
};

/** One observation of the live fix relative to the currently-active stop. */
export interface ArrivalSample {
  /** the venue id of the stop that is active RIGHT NOW (the same
   *  `stop.status === "active"` the creep triangle already reads), or null
   *  when nothing is active — before the outing, between windows, after the
   *  last stop. Arrival is only ever evaluated against this one stop. */
  activeStopId: string | null;
  /** straight-line metres from the live fix to the active stop's
   *  coordinate, measured by the caller with
   *  `google.maps.geometry.spherical.computeDistanceBetween` (the Maps lib
   *  the map component already loads — no second haversine, see
   *  `homeFitsWithStops`). null whenever it cannot be measured: no live
   *  fix, no active stop, or the geometry library has not loaded yet. All
   *  three mean "cannot tell" and drop any dwell in progress. */
  distanceM: number | null;
  /** the live fix's own accuracy estimate in metres (already validated to a
   *  positive number or null by `computeYouMarker`). A fix whose error
   *  radius is wider than `radiusM` cannot answer "am I within `radiusM`",
   *  so it is treated as INCONCLUSIVE — it neither confirms arrival nor
   *  resets the dwell. */
  accuracyM: number | null;
  /** true when the tracker's fix is not fresh right now (`youMarker.stale`):
   *  status "stale", the retained-fix gap after a backgrounded tab returns,
   *  or a "live" fix that has aged past the staleness threshold. A stale fix
   *  can NEVER create a new arrival — it proves nothing about where the user
   *  is now — but it never retracts one already confirmed. */
  stale: boolean;
  /** the app's one clock instant (`displayNow`), epoch ms. The dwell is
   *  measured against this, not the device's own timestamp. */
  nowMs: number;
}

export interface ArrivalProgress {
  /** the stop confirmed ARRIVED. Sticky once set: nothing — not a stale
   *  fix, not stepping out of range, not an inconclusive fix — clears it
   *  while that same stop is still the active one. It clears only when the
   *  active stop becomes a DIFFERENT id (the outing moved on), or when the
   *  caller hard-resets on plan replacement. */
  arrivedStopId: string | null;
  /** the stop a dwell is currently accumulating for, and the `nowMs` it
   *  began at. Both null when no dwell is in progress. */
  dwellStopId: string | null;
  dwellSinceMs: number | null;
}

export const INITIAL_ARRIVAL_PROGRESS: ArrivalProgress = {
  arrivedStopId: null,
  dwellStopId: null,
  dwellSinceMs: null,
};

/**
 * Folds one observation into the arrival progress. Pure: same inputs, same
 * output, and folding a repeated identical sample is a fixed point (safe
 * under React's double-invoked effects).
 */
export function reduceArrival(
  prev: ArrivalProgress,
  sample: ArrivalSample,
  config: ArrivalConfig = DEFAULT_ARRIVAL_CONFIG
): ArrivalProgress {
  const { activeStopId, distanceM, accuracyM, stale, nowMs } = sample;

  // Arrival AND dwell are per-stop. Any bookkeeping tied to a different id
  // than the one active now is the outing having moved on — drop it. (The
  // caller also hard-resets on plan replacement; this covers the ordinary
  // case of the active window simply advancing to the next stop.)
  const arrivedStopId =
    prev.arrivedStopId !== null && prev.arrivedStopId === activeStopId
      ? prev.arrivedStopId
      : null;
  const priorDwellSinceMs =
    prev.dwellStopId !== null &&
    prev.dwellStopId === activeStopId &&
    prev.dwellSinceMs !== null
      ? prev.dwellSinceMs
      : null;

  // "Hold": keep the arrival verdict and whatever dwell exists, unchanged.
  // Used for every inconclusive observation.
  const hold: ArrivalProgress = {
    arrivedStopId,
    dwellStopId: priorDwellSinceMs !== null ? activeStopId : null,
    dwellSinceMs: priorDwellSinceMs,
  };
  // "Clear": keep the arrival verdict, abandon any dwell in progress.
  const clear: ArrivalProgress = {
    arrivedStopId,
    dwellStopId: null,
    dwellSinceMs: null,
  };

  // Nothing measurable: no active stop, no distance (no fix, no active
  // stop, or the geometry lib is not up yet), or a bad clock. A dwell needs
  // continuous evidence, and there is none — abandon it. Arrival already
  // confirmed for this stop is untouched.
  if (
    activeStopId === null ||
    distanceM === null ||
    !Number.isFinite(distanceM) ||
    !Number.isFinite(nowMs)
  ) {
    return clear;
  }

  // Already arrived at this exact stop -> sticky, done. Nothing below can
  // undo it while this stop stays active.
  if (arrivedStopId === activeStopId) {
    return { arrivedStopId, dwellStopId: null, dwellSinceMs: null };
  }

  // ── ACCURACY GATE ──────────────────────────────────────────────────
  // A fix whose own error radius exceeds the arrival radius cannot
  // meaningfully answer "am I within `radiusM`". Inconclusive: do NOT
  // confirm, and do NOT reset the dwell (the traveller was in range on the
  // fixes either side of this one — most likely they simply stayed put).
  // The confirming branch below is past every gate, so an inconclusive fix
  // can never itself be the one that confirms.
  if (
    accuracyM !== null &&
    Number.isFinite(accuracyM) &&
    accuracyM > config.radiusM
  ) {
    return hold;
  }

  // Out of range -> the traveller is not here. Any dwell in progress is
  // broken; start over next time they are close.
  if (distanceM > config.radiusM) {
    return clear;
  }

  // In range, but the fix is STALE -> it says nothing about where the user
  // is at this instant. It cannot start or complete a dwell. It also does
  // not reset one: a tab backgrounded while the traveller sits at the venue
  // is the common case, and punishing that with a restart is wrong.
  if (stale) {
    return hold;
  }

  // ── In range, fresh, accurate enough: accumulate the dwell. ─────────
  const dwellSinceMs = priorDwellSinceMs ?? nowMs;
  const elapsedMs = nowMs - dwellSinceMs;

  // The clock ran backwards (the dev sim-time control, or a device time
  // jump). Never emit a negative elapsed or confirm early — restart the
  // dwell cleanly from this instant.
  if (elapsedMs < 0) {
    return { arrivedStopId, dwellStopId: activeStopId, dwellSinceMs: nowMs };
  }

  if (elapsedMs >= config.dwellMs) {
    return { arrivedStopId: activeStopId, dwellStopId: null, dwellSinceMs: null };
  }

  return { arrivedStopId, dwellStopId: activeStopId, dwellSinceMs };
}

/** Is `stopId` the one currently confirmed arrived? Convenience for the
 *  render path, which also gates on `stop.status === "active"` so the
 *  chartreuse "arrived" wash only ever decorates the active card. */
export function isArrived(
  progress: ArrivalProgress,
  stopId: string | null
): boolean {
  return stopId !== null && progress.arrivedStopId === stopId;
}
