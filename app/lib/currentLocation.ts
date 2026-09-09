// "Use current location" — the ONE-SHOT device read behind the starting
// location field's dropdown.
//
// ─────────────────────────────────────────────────────────────────────────
// THIS IS NOT LIVE TRACKING, AND MUST NEVER BECOME IT
// ─────────────────────────────────────────────────────────────────────────
// `liveTracking.ts` is a continuous `watchPosition` stream with a staleness
// heartbeat, a visibility handler, and a whole status machine, because it
// answers "where is the traveller RIGHT NOW, repeatedly, for hours". This
// module answers a completely different question, exactly once: "what point
// should this plan start from?" It uses `getCurrentPosition`, holds no
// stream, starts no timer, registers no visibility handler, and is finished
// the moment the field is filled. The two share no state and no module, on
// purpose: a one-shot read that quietly grew a watch would put a permission
// prompt and a radio wake behind a landing-page text field.
//
// ─────────────────────────────────────────────────────────────────────────
// SHAPE
// ─────────────────────────────────────────────────────────────────────────
// Same discipline as `cameraTween.ts` / `bannerDismiss.ts` / `youMarker.ts`:
// every decision here is a PURE function of values that get passed in, so
// the accuracy policy, the three failure modes and the label fallback are
// all provable with no DOM, no clock and no GPS. The component does the two
// impure things (call the browser, call the geocoder) and nothing else.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT CODE OWNS HERE
// ─────────────────────────────────────────────────────────────────────────
// CLAUDE.md's core rule: code owns every verifiable fact. A device position
// IS a fact, and so is how precise it claims to be. Nothing in this module
// smooths, rounds toward, or invents a coordinate; the only judgement it
// makes is a threshold comparison against a stated POLICY number, and when
// the reverse geocoder cannot name the point, the label degrades to a plain
// word rather than a guessed street.

// ─────────────────────────────────────────────────────────────────────────
// Locked copy. One definition each, so no screen re-types a literal.
// ─────────────────────────────────────────────────────────────────────────

/** The dropdown's one row. */
export const CURRENT_LOCATION_OPTION_LABEL = "Use current location";

/** Shown in the row while the device is being asked. */
export const CURRENT_LOCATION_BUSY_LABEL = "Finding your location…";

/**
 * What fills the field when the coordinate is good but the reverse geocoder
 * gave nothing usable. Deliberately a plain word rather than a coordinate
 * pair or a guessed street: the plan starts from the real point either way,
 * and a label is a label.
 */
export const CURRENT_LOCATION_FALLBACK_LABEL = "Current location";

/** Permission refused. Actionable, no blame, and it names the way out. */
export const CURRENT_LOCATION_DENIED_NOTE =
  "Location permission is off. Turn it on in your browser settings, or type a starting address.";

/** The device answered, but not in time. Retrying is genuinely worth it. */
export const CURRENT_LOCATION_TIMEOUT_NOTE =
  "Your device took too long to find your location. Try again, or type a starting address.";

/** The device cannot produce a position at all right now. */
export const CURRENT_LOCATION_UNAVAILABLE_NOTE =
  "Your device could not provide a location right now. Type a starting address instead.";

/** No geolocation API in this browser at all. */
export const CURRENT_LOCATION_UNSUPPORTED_NOTE =
  "This browser cannot share your location. Type a starting address instead.";

/**
 * Geolocation is a powerful feature and browsers gate it on a secure
 * context. `localhost` counts as secure, a LAN address served over plain
 * http does not, which is exactly how a phone pointed at a dev machine
 * fails. Saying so beats a bare "permission denied", which is what Chrome
 * reports for the same situation.
 */
export const CURRENT_LOCATION_INSECURE_NOTE =
  "Sharing your location needs a secure (https) connection. Type a starting address instead.";

/** The coordinates came back unusable (non-finite, out of range). */
export const CURRENT_LOCATION_UNUSABLE_NOTE =
  "Your device did not return a usable position. Type a starting address instead.";

// ─────────────────────────────────────────────────────────────────────────
// POLICY constants. Not measurements. Same discipline as DRIVING_MARGIN_MIN
// and the LIVE_TRACKING_* block: each is a line this app draws, and a real
// tuning pass may move any of them. None is derived from data today.
// ─────────────────────────────────────────────────────────────────────────

/**
 * POLICY. How imprecise a one-shot fix may be and still be accepted as a
 * starting point: 2 km.
 *
 * The reasoning, and it is a judgement rather than a measurement. A phone
 * with GNSS reports tens of metres; a degraded wifi fix reports hundreds,
 * and at that scale it still names the right neighbourhood, which is all a
 * start needs to be. Kilometres is the IP-geolocation regime, common on a
 * desktop with no wifi scanning: that number identifies a CITY, not a place
 * to leave from. Accepting it silently would do two bad things at once. The
 * home leg would be priced from a point the user is nowhere near, and the
 * reverse geocoder would confidently name a specific street to go with it,
 * so the interface would look precise while being wrong.
 *
 * This is the client-side twin of `MAX_START_DISTANCE_FROM_CITY_METERS`:
 * that one refuses a start too far from the city, this one refuses a start
 * we do not actually know. Both exist so a bad point never becomes a silent
 * multi-hour first leg.
 */
export const MAX_FIX_ACCURACY_METERS = 2_000;

/**
 * POLICY. `enableHighAccuracy: true`, which is the OPPOSITE of
 * `LIVE_TRACKING_ENABLE_HIGH_ACCURACY` and deliberately so. That flag is
 * false because a watch running for a whole outing should not hold the GPS
 * radio awake. This is one read, initiated by the user, that anchors every
 * leg of the day, so waking the radio once is the right trade.
 */
export const CURRENT_LOCATION_ENABLE_HIGH_ACCURACY = true;

/**
 * POLICY. `maximumAge: 0` — never accept a cached fix, again the opposite
 * of live tracking's 15s. Two reasons. A start is asked for once and should
 * describe where the user is standing now, not where the browser last saw
 * them. And a cached fix makes RETRY meaningless: if a coarse cached
 * reading is refused by the accuracy gate above, every retry inside the
 * cache window would hand back that identical reading, so the row's "try
 * again" would be a lie.
 */
export const CURRENT_LOCATION_MAX_AGE_MS = 0;

/**
 * POLICY. `timeout: 15s`. Shorter than live tracking's 30s because someone
 * is watching this row spin. A cold high-accuracy acquisition indoors can
 * genuinely take ten seconds or more; past fifteen the honest answer is
 * that it did not work, and typing an address is faster than waiting.
 */
export const CURRENT_LOCATION_TIMEOUT_MS = 15_000;

/** The exact options object handed to `getCurrentPosition`. */
export const CURRENT_LOCATION_POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: CURRENT_LOCATION_ENABLE_HIGH_ACCURACY,
  maximumAge: CURRENT_LOCATION_MAX_AGE_MS,
  timeout: CURRENT_LOCATION_TIMEOUT_MS,
};

// ─────────────────────────────────────────────────────────────────────────
// Pure decisions
// ─────────────────────────────────────────────────────────────────────────

/** A device reading, reduced to the three numbers this feature reads. */
export interface RawFix {
  latitude: unknown;
  longitude: unknown;
  /** Metres, 95% confidence radius. May be missing on an odd platform. */
  accuracy: unknown;
}

/** What the coordinate is worth. */
export type FixVerdict =
  | {
      ok: true;
      latitude: number;
      longitude: number;
      /** null when the platform reported no usable accuracy figure. */
      accuracyM: number | null;
    }
  | { ok: false; note: string };

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Round an accuracy radius into something a person can read. Deliberately
 * coarse: this number exists to explain a refusal, and reporting "within
 * about 11,431 m" would imply a precision the refusal is about not having.
 */
export function describeAccuracy(meters: number): string {
  if (meters < 1_000) {
    // to the nearest 10 m below a kilometre
    return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  }
  const km = meters / 1_000;
  // one decimal under 10 km, whole kilometres above it
  const value = km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
  return `${value} km`;
}

/**
 * The whole accuracy policy, in one place. Two ways to fail and one way to
 * pass.
 *
 * A MISSING accuracy figure PASSES. That is the app's keep-on-missing-data
 * rule applied to a device instead of a venue: never refuse for a field
 * that was not reported. The coordinate itself is still checked, because a
 * non-finite or out-of-range coordinate is not missing data, it is broken
 * data, and there is nothing to start a plan from.
 */
export function judgeFix(
  fix: RawFix,
  maxAccuracyM: number = MAX_FIX_ACCURACY_METERS
): FixVerdict {
  const { latitude, longitude, accuracy } = fix;
  if (
    !finite(latitude) ||
    !finite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return { ok: false, note: CURRENT_LOCATION_UNUSABLE_NOTE };
  }
  const accuracyM = finite(accuracy) && accuracy >= 0 ? accuracy : null;
  if (accuracyM !== null && accuracyM > maxAccuracyM) {
    return {
      ok: false,
      note: `Your device could only place you within about ${describeAccuracy(
        accuracyM
      )}. Type a starting address instead.`,
    };
  }
  return { ok: true, latitude, longitude, accuracyM };
}

/**
 * The three failure modes the task names, plus the two the platform can
 * produce before it ever calls back. `GeolocationPositionError` codes are
 * 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT; anything else is
 * treated as unavailable, which is the honest reading of "it did not work
 * and we do not know why".
 */
export function geolocationErrorNote(code: unknown): string {
  if (code === 1) return CURRENT_LOCATION_DENIED_NOTE;
  if (code === 3) return CURRENT_LOCATION_TIMEOUT_NOTE;
  return CURRENT_LOCATION_UNAVAILABLE_NOTE;
}

/**
 * What the field should say for a resolved point. The reverse geocoder is
 * allowed to give nothing: a GPS fix in a park, on a highway, or on a
 * street the provider only knows as a route may come back with no usable
 * formatted address at all, and refusing the whole flow over a missing
 * LABEL would throw away a perfectly good coordinate.
 */
export function startLabelFrom(formattedAddress: string | null | undefined): string {
  const label = typeof formattedAddress === "string" ? formattedAddress.trim() : "";
  return label.length > 0 ? label : CURRENT_LOCATION_FALLBACK_LABEL;
}

/**
 * A resolved current-location start: the DEVICE's own coordinate plus the
 * text that was put in the field for it.
 *
 * `label` is not decoration. It is what makes the coordinate's invalidation
 * structural rather than a thing every future edit path has to remember:
 * the pipeline only uses this fix while the field still reads exactly what
 * this fix put there. See `startFixForField` below.
 */
export interface StartFix {
  latitude: number;
  longitude: number;
  label: string;
}

/**
 * THE STALE-COORDINATE GUARD. Given the fix in hand and what the field
 * currently says, decide whether the fix still describes that text.
 *
 * The field's own `onChange` clears the fix, so in practice this is a
 * second lock on the same door. It is here because the two are different
 * KINDS of guarantee: clearing on change is a thing a handler has to
 * remember to do, and this is a thing that is true or not. Any future path
 * that sets the field's text without clearing the fix is caught here, and
 * the plan falls back to geocoding the text the user can actually see.
 * Displaying one place while planning from another is the failure this
 * exists to make impossible.
 */
export function startFixForField(
  fix: StartFix | null,
  fieldValue: string
): StartFix | null {
  if (!fix) return null;
  return fix.label === fieldValue.trim() ? fix : null;
}
