// A framework-agnostic rAF camera tween for the stop-focus map animation.
//
// `map.panTo()` was the original approach and did not visibly animate in
// this app's environment (confirmed live: every focus teleported, including
// a same-zoom stop-to-stop hop, with reduced-motion off) — so the camera is
// now driven explicitly, frame by frame, via `map.moveCamera()`, which the
// Maps JS API documents as an INSTANT, unanimated camera set. That is
// exactly what a manual per-frame tween needs: one atomic, non-fighting
// camera write per frame, with this module owning the easing curve between
// frames.
//
// `raf`/`caf`/`now` are injected (defaulting to the real browser globals)
// purely so the frame math and the cancel-and-redirect behaviour can be
// proven without a DOM or real animation-frame timing — the same reason
// bannerDismiss.ts injects its own timing.

export interface CameraPoint {
  lat: number;
  lng: number;
  zoom: number;
}

/** Linear interpolation. t=0 -> a, t=1 -> b. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Standard smooth-in-smooth-out ease. t=0 -> 0, t=1 -> 1, t=0.5 -> 0.5. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Same position within floating-point/GPS noise — a tween has nothing to
 *  interpolate and would just burn frames landing where it already sits. */
const CAMERA_EPSILON = 1e-6;

export function camerasEqual(a: CameraPoint, b: CameraPoint): boolean {
  return (
    Math.abs(a.lat - b.lat) < CAMERA_EPSILON &&
    Math.abs(a.lng - b.lng) < CAMERA_EPSILON &&
    Math.abs(a.zoom - b.zoom) < CAMERA_EPSILON
  );
}

/** One eased frame between `start` and `target` at `elapsedMs` into a
 *  `durationMs` tween. `done` is true once `elapsedMs >= durationMs`, at
 *  which point `point` is the EXACT target — never a rounding-short lerp,
 *  so the camera always lands precisely rather than a hair off. */
export function cameraTweenFrame(
  start: CameraPoint,
  target: CameraPoint,
  elapsedMs: number,
  durationMs: number
): { point: CameraPoint; done: boolean } {
  const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
  if (t >= 1) return { point: target, done: true };
  const eased = easeInOutCubic(t);
  return {
    point: {
      lat: lerp(start.lat, target.lat, eased),
      lng: lerp(start.lng, target.lng, eased),
      zoom: lerp(start.zoom, target.zoom, eased),
    },
    done: false,
  };
}

/** ~400ms reads as a deliberate glide without feeling sluggish on a repeated
 *  stop-to-stop hop. */
export const CAMERA_TWEEN_DURATION_MS = 400;

export interface CameraTweenHandle {
  /** Stop the tween before it reaches the target. Safe to call more than
   *  once, and after the tween has already finished on its own. */
  cancel: () => void;
}

export interface CameraTweenDeps {
  raf: (cb: (time: number) => void) => number;
  caf: (id: number) => void;
  now: () => number;
}

const REAL_DEPS: CameraTweenDeps = {
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
};

/**
 * Drives one camera tween from `start` to `target`, calling `onFrame` with
 * each interpolated point (ending with one call carrying the EXACT target)
 * and `onDone` exactly once. If `start` and `target` are already the same
 * place, `onFrame`/`onDone` fire once, synchronously, with no frame
 * scheduled at all — re-focusing the stop the camera is already centred on
 * still notifies the caller without animating a tween that has nothing to
 * move.
 *
 * Returns a handle to cancel mid-flight. This module has no notion of
 * "redirect": the caller is expected to read the map's own current
 * center/zoom as the NEXT tween's `start`, so cancelling one tween and
 * starting another from wherever the camera actually stopped is how a
 * mid-glide redirect happens. Cancellation guards against a `caf` that
 * doesn't actually stop the browser from invoking an already-queued frame
 * (an internal flag, checked at the top of every frame, is the real guard —
 * `caf` is best-effort cleanup on top of it).
 */
export function startCameraTween(
  start: CameraPoint,
  target: CameraPoint,
  onFrame: (point: CameraPoint) => void,
  onDone: () => void,
  durationMs: number = CAMERA_TWEEN_DURATION_MS,
  deps: CameraTweenDeps = REAL_DEPS
): CameraTweenHandle {
  if (camerasEqual(start, target)) {
    onFrame(target);
    onDone();
    return { cancel: () => {} };
  }

  let cancelled = false;
  let rafId: number | null = null;
  const startedAt = deps.now();

  const tick = () => {
    if (cancelled) return;
    const { point, done } = cameraTweenFrame(start, target, deps.now() - startedAt, durationMs);
    onFrame(point);
    if (done) {
      rafId = null;
      onDone();
      return;
    }
    rafId = deps.raf(tick);
  };
  rafId = deps.raf(tick);

  return {
    cancel: () => {
      cancelled = true;
      if (rafId != null) {
        deps.caf(rafId);
        rafId = null;
      }
    },
  };
}
