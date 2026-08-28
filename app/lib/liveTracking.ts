// Live device-location tracking — the honest, foreground-only kind.
//
// ─────────────────────────────────────────────────────────────────────────
// PIECE 0: THE HONEST CEILING (read before touching any copy)
// ─────────────────────────────────────────────────────────────────────────
// The web platform CANNOT track location once this tab is backgrounded or
// the screen is locked. `navigator.geolocation.watchPosition` simply stops
// calling back — no error, just silence — and there is no documented way to
// "resume" the same watch afterwards. Service workers cannot read
// geolocation at all, so shipping this as a PWA does not raise the ceiling.
// A prior investigation confirmed every part of that.
//
// Therefore every user-facing string about this feature must stay inside
// what the platform actually allows. No "always on", no "in the background",
// no "even when the app is closed". The vocabulary is "while this tab is
// open", "pauses when you switch away", "last known". The label constants
// below are the locked wording; nothing built on top of this module may
// imply more than they say.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS MODULE IS THE DELIBERATE EXCEPTION TO THE CSS-MOTION INVARIANT
// ─────────────────────────────────────────────────────────────────────────
// CLAUDE.md: "TIME-BASED UI MOTION IS CSS-DRIVEN OFF REAL INSTANTS, NEVER A
// JS TICKER ... no `setInterval`/`requestAnimationFrame` loop anywhere for
// 'now', and no `visibilitychange` handler." This module introduces the
// app's first `setInterval` and its first `visibilitychange` handler, on
// purpose, and that is NOT a violation:
//
//   - The CSS-motion rule works because ELAPSED TIME is knowable by pure
//     math: given a start instant and `now`, the exact fraction of a window
//     that has passed is a calculation, so the compositor can carry it
//     forward with a negative `animation-delay` and zero script.
//   - A DEVICE'S REAL POSITION is NOT knowable that way. Between two GPS
//     fixes, where the phone actually is is genuinely unknown, not merely
//     un-rendered. It cannot be interpolated or extrapolated without
//     inventing a fact — exactly what CLAUDE.md's core rule forbids.
//   - So the only honest thing to do is: hold the last real fix, and know
//     how old it is. Knowing it has gone stale (the watch went silent, the
//     tab backgrounded) requires either an event (`visibilitychange`) or a
//     small periodic check (`setInterval`) — there is no math that tells you
//     a stream stopped. The interval here does NOTHING but compare two
//     timestamps and possibly flip a status flag. It never moves, smooths,
//     estimates, or re-derives a position.
//
// Contrast with `cameraTween.ts`: that module DOES interpolate between two
// points — but they are two KNOWN camera states, and the interpolation is a
// deliberate visual choice about how the map view glides. This module must
// never do the equivalent for a device's position, because the "current"
// position between two fixes is not a display smoothing question, it is an
// unknown fact.
//
// ─────────────────────────────────────────────────────────────────────────
// SHAPE
// ─────────────────────────────────────────────────────────────────────────
// Same discipline as `cameraTween.ts` / `bannerDismiss.ts` /
// `activeTriangleCreep.ts`: the core is a plain factory with every browser
// dependency injected (geolocation, visibility, timers, `now`) so the whole
// state machine is provable without a DOM, a real clock, or a real GPS.
// `useLiveTracking.ts` is the thin React binding.

// ─────────────────────────────────────────────────────────────────────────
// Piece 0 — the locked honest label copy.
// ─────────────────────────────────────────────────────────────────────────

/** The feature's name. Plain, no capability claim. */
export const LIVE_TRACKING_LABEL = "Live location";

/** The one-line honesty note that sits next to the toggle (Piece 2 renders
 *  it). States the ceiling plainly. */
export const LIVE_TRACKING_WHILE_OPEN_NOTE =
  "Tracks only while this tab is open and in front of you.";

/** The longer explainer, for a tooltip or a first-run note. Says what
 *  happens on background/lock rather than hiding it. */
export const LIVE_TRACKING_EXPLAINER =
  "Your position shows on the map while you have this page open. It pauses when you switch tabs or lock your phone, and picks back up when you return.";

/** Prefix for a retained-but-stale reading, e.g. "Last known 7:42 PM". */
export const LIVE_TRACKING_LAST_KNOWN_LABEL = "Last known";

/** Shown when the browser permission is off. Actionable, no blame. */
export const LIVE_TRACKING_DENIED_NOTE =
  "Location permission is off. Turn it on in your browser settings to see yourself on the map.";

/** Shown when the device cannot produce a position at all. */
export const LIVE_TRACKING_UNAVAILABLE_NOTE =
  "Your device could not provide a location right now.";

// ─────────────────────────────────────────────────────────────────────────
// Piece 1 — policy constants. POLICY, not measurements (same discipline as
// DRIVING_MARGIN_MIN). A real tuning pass or a battery study can revisit
// each; none is derived from data today.
// ─────────────────────────────────────────────────────────────────────────

/**
 * `enableHighAccuracy: false`. This feature answers "am I on my way / have I
 * roughly arrived" — a block-level question on a pale city map, not
 * turn-by-turn navigation. `false` lets the device answer from wifi/cell
 * (tens of metres, ample for "near the venue") instead of waking the GPS
 * radio, which matters for a phone carried through a multi-hour outing.
 * Piece 3's arrival detection will use a generous radius for exactly this
 * reason. If arrival ever proves too coarse, this is the single knob.
 */
export const LIVE_TRACKING_ENABLE_HIGH_ACCURACY = false;

/**
 * `maximumAge: 15_000`. Accept a fix the device already has if it is under
 * 15s old rather than force a fresh acquisition on every callback. At
 * walking/transit speed 15s is well under the accuracy band we already
 * accept, and it further cuts radio wakeups. Not 0 (forces a fresh
 * acquisition every time) and not minutes (would hand back genuinely old
 * fixes as if current — the dishonesty this module exists to prevent; the
 * staleness rule below is the backstop, but the option should not fight it).
 */
export const LIVE_TRACKING_MAX_AGE_MS = 15_000;

/**
 * `timeout: 30_000`. How long the device may take to return a position
 * before the error callback fires with TIMEOUT. A cold acquisition indoors
 * can take 20s+; 30s tolerates that without hanging "requesting" forever.
 */
export const LIVE_TRACKING_TIMEOUT_MS = 30_000;

/**
 * A foreground fix older than this is no longer "current". Derived as
 * `maximumAge` (15s) + `timeout` (30s): a healthy device would have
 * delivered a new fix or fired an error within that span, so past it
 * something is wrong (GPS lost, the OS throttled the tab, the watch went
 * silent). POLICY: the point past which we would rather say "last known
 * 7:42" than let a dot imply it is live.
 */
export const LIVE_TRACKING_STALENESS_MS = 45_000;

/**
 * How often the foreground staleness check runs. Must be shorter than the
 * staleness threshold so "stale" is noticed within roughly one threshold
 * plus one heartbeat of the last fix. The interval does one thing: compare
 * two timestamps, maybe flip `status` to "stale". It is the app's first
 * `setInterval` and exists only because a silent watch has no other tell.
 */
export const LIVE_TRACKING_HEARTBEAT_MS = 15_000;

export interface LiveTrackingConfig {
  enableHighAccuracy: boolean;
  maximumAgeMs: number;
  timeoutMs: number;
  stalenessMs: number;
  heartbeatMs: number;
}

export const DEFAULT_LIVE_TRACKING_CONFIG: LiveTrackingConfig = {
  enableHighAccuracy: LIVE_TRACKING_ENABLE_HIGH_ACCURACY,
  maximumAgeMs: LIVE_TRACKING_MAX_AGE_MS,
  timeoutMs: LIVE_TRACKING_TIMEOUT_MS,
  stalenessMs: LIVE_TRACKING_STALENESS_MS,
  heartbeatMs: LIVE_TRACKING_HEARTBEAT_MS,
};

// ─────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────

export type LiveTrackingStatus =
  /** not tracking (never started, or explicitly stopped). */
  | "off"
  /** started; permission requested; no real fix in hand yet. Also the state
   *  while the tab is hidden before the first fix ever arrived. */
  | "requesting"
  /** a real fix in hand and fresh (received within the staleness window). */
  | "live"
  /** a real fix in hand but no longer current: the tab backgrounded, or no
   *  fix has arrived within the staleness window, or a transient error came
   *  in after a good fix. The last fix is RETAINED, flagged not deleted. */
  | "stale"
  /** permission refused. Tracking cannot run; the app is fully usable
   *  without it. */
  | "denied"
  /** the device could not produce a position (POSITION_UNAVAILABLE or
   *  TIMEOUT) and there is no prior fix to fall back on. */
  | "unavailable";

export interface LivePosition {
  /** exactly what the device reported. NEVER interpolated or extrapolated. */
  lat: number;
  lng: number;
  /** the device's own accuracy estimate for this fix, in metres. */
  accuracyM: number;
  /** `GeolocationPosition.timestamp` — when the DEVICE recorded the fix, on
   *  the device's clock. Distinct from `lastUpdatedAt`, which is when WE
   *  received it. Piece 2 should display the age from this, honestly. */
  deviceTimestamp: number;
}

export type LiveTrackingErrorKind = "denied" | "unavailable" | "timeout";

export type LiveStaleReason =
  /** the tab was backgrounded, so the watch was explicitly cleared. */
  | "backgrounded"
  /** no fix has arrived within the staleness window, or a transient error
   *  came in, while the tab is still visible. */
  | "no_recent_fix";

export interface LiveTrackingState {
  status: LiveTrackingStatus;
  /** the last real device fix. Retained across "stale". Null until the
   *  first fix, and cleared on "off" / "denied". */
  position: LivePosition | null;
  /** epoch ms on OUR clock when `position` was received. Null with no
   *  position. This is what the staleness check measures against. */
  lastUpdatedAt: number | null;
  /** the precise cause behind "denied" / "unavailable", or the transient
   *  error that pushed a good fix to "stale". Null when nothing is wrong. */
  errorKind: LiveTrackingErrorKind | null;
  /** only meaningful with status "stale": why freshness was lost. */
  staleReason: LiveStaleReason | null;
}

export const INITIAL_LIVE_TRACKING_STATE: LiveTrackingState = {
  status: "off",
  position: null,
  lastUpdatedAt: null,
  errorKind: null,
  staleReason: null,
};

// ─────────────────────────────────────────────────────────────────────────
// Injected dependencies
// ─────────────────────────────────────────────────────────────────────────

/** The slice of `navigator.geolocation` this module uses. */
export interface GeolocationLike {
  watchPosition: (
    success: (position: GeolocationPosition) => void,
    error: (error: GeolocationPositionError) => void,
    options?: PositionOptions
  ) => number;
  clearWatch: (watchId: number) => void;
}

type LiveTrackingTimer = ReturnType<typeof setInterval>;

export interface LiveTrackingDeps {
  /** null when there is no geolocation API at all (SSR, or a browser
   *  without it). Read lazily so the module does no work at import time. */
  getGeolocation: () => GeolocationLike | null;
  /** subscribe to tab visibility changes; returns an unsubscribe fn. */
  addVisibilityListener: (listener: () => void) => () => void;
  /** true when the tab is currently backgrounded / hidden. */
  isHidden: () => boolean;
  setHeartbeat: (callback: () => void, everyMs: number) => LiveTrackingTimer;
  clearHeartbeat: (timer: LiveTrackingTimer) => void;
  now: () => number;
}

export const REAL_LIVE_TRACKING_DEPS: LiveTrackingDeps = {
  getGeolocation: () =>
    typeof navigator !== "undefined" && "geolocation" in navigator
      ? navigator.geolocation
      : null,
  addVisibilityListener: (listener) => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  isHidden: () =>
    typeof document !== "undefined" && document.visibilityState === "hidden",
  setHeartbeat: (callback, everyMs) => setInterval(callback, everyMs),
  clearHeartbeat: (timer) => clearInterval(timer),
  now: () => Date.now(),
};

// ─────────────────────────────────────────────────────────────────────────
// The tracker
// ─────────────────────────────────────────────────────────────────────────

export interface LiveTracker {
  /** Begin tracking: request permission and start `watchPosition`. If the
   *  tab is hidden right now, the watch is deferred until it is visible.
   *  Idempotent while already started. */
  start: () => void;
  /** Stop tracking entirely: `clearWatch`, drop the heartbeat and the
   *  visibility listener, status back to "off", fix cleared. Idempotent. */
  stop: () => void;
  /** The current snapshot (also delivered through the `onState` callback). */
  getState: () => LiveTrackingState;
}

function errorKindFromCode(code: number): LiveTrackingErrorKind {
  // GeolocationPositionError: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE,
  // 3 TIMEOUT.
  if (code === 1) return "denied";
  if (code === 3) return "timeout";
  return "unavailable";
}

/**
 * Creates a live-position tracker. `onState` fires on every transition with
 * a fresh snapshot. `deps` and `config` are injected so the machine below
 * is testable without a browser.
 *
 * The tracker owns three things the caller does not touch: the
 * `watchPosition` handle, the tab-visibility pause/resume, and the staleness
 * heartbeat. The caller only calls `start` / `stop` and reads state.
 */
export function createLiveTracker(
  onState: (state: LiveTrackingState) => void,
  deps: LiveTrackingDeps = REAL_LIVE_TRACKING_DEPS,
  config: LiveTrackingConfig = DEFAULT_LIVE_TRACKING_CONFIG
): LiveTracker {
  let state: LiveTrackingState = { ...INITIAL_LIVE_TRACKING_STATE };
  let started = false;
  let watchId: number | null = null;
  let heartbeat: LiveTrackingTimer | null = null;
  let unsubscribeVisibility: (() => void) | null = null;

  function set(patch: Partial<LiveTrackingState>): void {
    state = { ...state, ...patch };
    onState({ ...state });
  }

  function positionOptions(): PositionOptions {
    return {
      enableHighAccuracy: config.enableHighAccuracy,
      maximumAge: config.maximumAgeMs,
      timeout: config.timeoutMs,
    };
  }

  function beginWatch(): void {
    if (watchId !== null) return; // already watching
    const geo = deps.getGeolocation();
    if (!geo) {
      set({ status: "unavailable", errorKind: "unavailable" });
      return;
    }
    // A NEW watch every time. There is no documented "resume" of a watch
    // that stopped when the tab backgrounded, so we never assume the old
    // one comes back — visibility-visible always lands here for a fresh id.
    watchId = geo.watchPosition(handleFix, handleError, positionOptions());
  }

  function endWatch(): void {
    if (watchId === null) return;
    deps.getGeolocation()?.clearWatch(watchId);
    watchId = null;
  }

  function handleFix(position: GeolocationPosition): void {
    // A callback can land after stop() in a race; ignore it.
    if (!started) return;
    const fix: LivePosition = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracyM: position.coords.accuracy,
      deviceTimestamp: position.timestamp,
    };
    set({
      status: "live",
      position: fix,
      lastUpdatedAt: deps.now(),
      errorKind: null,
      staleReason: null,
    });
  }

  function handleError(error: GeolocationPositionError): void {
    if (!started) return;
    const kind = errorKindFromCode(error.code);

    if (kind === "denied") {
      // Permission refused. Tracking cannot run — tear everything down and
      // rest at "denied". The app is unaffected; this is enhancement only.
      teardown();
      set({
        status: "denied",
        position: null,
        lastUpdatedAt: null,
        errorKind: "denied",
        staleReason: null,
      });
      return;
    }

    // POSITION_UNAVAILABLE or TIMEOUT. Per spec the watch stays alive and
    // keeps trying, so we leave it running and let the next real fix flip
    // back to "live".
    if (state.position) {
      // We had a real fix; the device just cannot refresh it. Retain it,
      // flag it stale, record why.
      set({ status: "stale", errorKind: kind, staleReason: "no_recent_fix" });
    } else {
      // Never got a first fix. Surface the reason; the watch keeps trying.
      set({ status: "unavailable", errorKind: kind });
    }
  }

  function checkStaleness(): void {
    // The heartbeat's entire job. Only a "live" fix can go stale from here;
    // every other status is already terminal or already stale.
    if (state.status !== "live" || state.lastUpdatedAt === null) return;
    if (deps.now() - state.lastUpdatedAt > config.stalenessMs) {
      set({ status: "stale", staleReason: "no_recent_fix" });
    }
  }

  function handleVisibilityChange(): void {
    if (!started) return;
    if (deps.isHidden()) {
      // watchPosition silently stops delivering when the tab backgrounds.
      // Clear it EXPLICITLY rather than trust a callback that will never
      // come, and mark the last fix stale (retained, not deleted).
      endWatch();
      if (state.position) {
        set({ status: "stale", staleReason: "backgrounded" });
      } else {
        // Backgrounded before the first fix — nothing to show yet.
        set({ status: "requesting", staleReason: null });
      }
    } else {
      // Visible again. Start a NEW watch; status returns to "live" only when
      // a real fix actually arrives.
      set({ status: "requesting", staleReason: null });
      beginWatch();
    }
  }

  function ensureInfra(): void {
    if (unsubscribeVisibility === null) {
      unsubscribeVisibility = deps.addVisibilityListener(handleVisibilityChange);
    }
    if (heartbeat === null) {
      heartbeat = deps.setHeartbeat(checkStaleness, config.heartbeatMs);
    }
  }

  function teardown(): void {
    endWatch();
    if (heartbeat !== null) {
      deps.clearHeartbeat(heartbeat);
      heartbeat = null;
    }
    if (unsubscribeVisibility !== null) {
      unsubscribeVisibility();
      unsubscribeVisibility = null;
    }
    started = false;
  }

  return {
    start(): void {
      if (started) return;
      if (!deps.getGeolocation()) {
        // No geolocation API at all. Rest at "unavailable"; do not set up
        // infra we would immediately have to tear down.
        set({ status: "unavailable", errorKind: "unavailable" });
        return;
      }
      started = true;
      set({
        status: "requesting",
        errorKind: null,
        staleReason: null,
      });
      ensureInfra();
      if (deps.isHidden()) {
        // Do not call watchPosition into a hidden tab; the
        // visibility-visible handler will start it.
        return;
      }
      beginWatch();
    },

    stop(): void {
      // Idempotent: only bail if there is genuinely nothing running and we
      // are already at rest.
      if (!started && state.status === "off") return;
      teardown();
      set({
        status: "off",
        position: null,
        lastUpdatedAt: null,
        errorKind: null,
        staleReason: null,
      });
    },

    getState(): LiveTrackingState {
      return { ...state };
    },
  };
}
