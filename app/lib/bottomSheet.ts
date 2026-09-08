// Pure drag/snap math for the mobile itinerary bottom sheet. Same shape as
// cameraTween.ts/bannerDismiss.ts: no DOM, no React, every input a plain
// value (heights in px, velocity in px/ms) so the physics can be proven
// without a device or a touch screen. The React binding (MobileItinerarySheet)
// owns the touch listeners and feeds real measurements through this module;
// this file only ever decides "given these numbers, what height/state/opacity
// results" — it never reads window/document itself.
//
// The sheet mounts with the desktop dock; CSS alone chooses which surface
// is visible at the established 768px breakpoint.

export type SheetSnap = "peek" | "half" | "full";

/** Collapsed → expanded, the direction a positive (upward) drag moves. */
export const SNAP_ORDER: SheetSnap[] = ["peek", "half", "full"];

/** PEEK is a fixed content height (a drag handle + one line), not a fraction
 *  of the viewport — matching the desktop strip's own fixed-height cards.
 *  HALF/FULL scale with the viewport because their content (a carousel, a
 *  scrollable list) genuinely wants more room on a taller phone. */
export const PEEK_HEIGHT_PX = 128;
export const HALF_HEIGHT_FRACTION = 0.45;
export const FULL_HEIGHT_FRACTION = 0.9;

/** How much a drag past peek/full keeps moving the sheet, scaled down — the
 *  standard "rubber band" feel so a drag never hard-stops, but a release past
 *  the bound settles back at the bound (see clampDragHeight below). Purely a
 *  feel constant, not a measurement — same category as DRIVING_MARGIN_MIN. */
const OVERDRAG_RESISTANCE = 0.35;

/** A fling faster than this (px/ms) overrides "nearest point" and moves one
 *  snap step in the fling's direction, even mid-way between two points —
 *  the standard bottom-sheet feel: a fast flick commits, a slow drag settles
 *  wherever you let go. ~500px/s, a typical native swipe-page threshold. */
const FLING_VELOCITY_PX_PER_MS = 0.5;

export interface SheetHeights {
  peek: number;
  half: number;
  full: number;
}

/** Keep the home-indicator inset below peek content and cap full below the
 *  measured top controls. On a short visual viewport the smaller snaps
 *  yield to that cap while staying strictly ordered. The component reserves
 *  safe-area space inside the settled content viewport. */
export function resolveSheetHeights(
  viewportHeightPx: number,
  safeAreaBottomPx: number,
  topClearancePx = 0
): SheetHeights {
  const full = Math.max(3, Math.min(
    viewportHeightPx * FULL_HEIGHT_FRACTION,
    viewportHeightPx - Math.max(0, topClearancePx)
  ));
  const peek = Math.min(PEEK_HEIGHT_PX + Math.max(0, safeAreaBottomPx), full - 2);
  const half = Math.min(full - 1, Math.max(viewportHeightPx * HALF_HEIGHT_FRACTION, peek + 1));
  return { peek, half, full };
}

/** A finger held still at release must not reuse a stale fling sample. */
export function sheetReleaseVelocity(velocity: number, lastMoveAt: number, releasedAt: number): number {
  const age = releasedAt - lastMoveAt;
  return Number.isFinite(velocity) && age >= 0 && age <= 100 ? velocity : 0;
}

/** The live height while a finger is down: tracks the raw drag 1:1 inside
 *  [peek, full], and applies resistance beyond either bound rather than a
 *  hard stop — the sheet still visibly follows the finger past its limits,
 *  it just moves slower there. */
export function clampDragHeight(rawHeightPx: number, heights: SheetHeights): number {
  if (rawHeightPx < heights.peek) {
    const over = heights.peek - rawHeightPx;
    return heights.peek - over * OVERDRAG_RESISTANCE;
  }
  if (rawHeightPx > heights.full) {
    const over = rawHeightPx - heights.full;
    return heights.full + over * OVERDRAG_RESISTANCE;
  }
  return rawHeightPx;
}

/**
 * Decides which of the three snap points a drag should land on. Nearest
 * point by pixel distance, UNLESS the release velocity clears the fling
 * threshold, in which case it moves exactly one step in the fling's
 * direction from the nearest point (never skips a state, and never moves
 * past the ends of SNAP_ORDER). `velocityPxPerMs` is signed: positive means
 * moving up (expanding), negative means moving down (collapsing) — the
 * same sign convention the component derives from clientY deltas (up on
 * screen = decreasing Y = increasing height).
 */
export function resolveSnapTarget(
  currentHeightPx: number,
  velocityPxPerMs: number,
  heights: SheetHeights
): SheetSnap {
  const points: Array<[SheetSnap, number]> = [
    ["peek", heights.peek],
    ["half", heights.half],
    ["full", heights.full],
  ];

  let nearest: SheetSnap = "peek";
  let nearestDist = Infinity;
  for (const [snap, h] of points) {
    const dist = Math.abs(currentHeightPx - h);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = snap;
    }
  }

  if (Math.abs(velocityPxPerMs) <= FLING_VELOCITY_PX_PER_MS) return nearest;

  const nearestIndex = SNAP_ORDER.indexOf(nearest);
  const direction = velocityPxPerMs > 0 ? 1 : -1;
  const targetIndex = Math.min(
    SNAP_ORDER.length - 1,
    Math.max(0, nearestIndex + direction)
  );
  return SNAP_ORDER[targetIndex];
}

/** Nearest content state for a measured height. The UI commits content only
 *  after settling so a finger crossing a midpoint never rebuilds its layout. */
export function contentStateFor(currentHeightPx: number, heights: SheetHeights): SheetSnap {
  return resolveSnapTarget(currentHeightPx, 0, heights);
}

export function sheetHeightFor(snap: SheetSnap, heights: SheetHeights): number {
  return heights[snap];
}

/**
 * The opaque-background crossfade: 0 (fully translucent/frosted, peek and
 * half's look) at or below HALF height, rising linearly to 1 (fully opaque,
 * matching the desktop strip's solid card background) at or above FULL
 * height. Only the half->full range fades — peek and half intentionally
 * read identically translucent, per the task's own spec.
 */
export function backgroundOpacityFor(currentHeightPx: number, heights: SheetHeights): number {
  if (heights.full <= heights.half) return currentHeightPx >= heights.full ? 1 : 0;
  const t = (currentHeightPx - heights.half) / (heights.full - heights.half);
  return Math.min(1, Math.max(0, t));
}
