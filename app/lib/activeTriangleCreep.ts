// Pure math for the active stop's bottom-edge "creep" triangle — a small
// caret on the strip card that shows how far through its REAL time window
// the currently-active stop is. Purely CSS-driven: this function computes a
// CSS animation's duration and (negative) delay ONCE, from the stop's real
// start/end and the current instant; the browser's animation engine then
// carries the motion forward continuously with zero further JS involvement.
//
// Why CSS and not a ticker: this codebase deliberately has no
// setInterval/rAF loop anywhere for "now" — every displayed status is
// derived once per read (see CLAUDE.md, `'Now' DOES NOT TICK`). A CSS
// animation with `animation-delay: -elapsedMs` starts already offset into
// its own timeline, so the compositor keeps it moving with no script
// running at all — including across a genuinely frozen/backgrounded tab,
// which a JS ticker would need its own resync logic to survive.
//
// Same shape as cameraTween.ts/bannerDismiss.ts: a pure function, `now`
// injected as a parameter so every case below is provable without a clock.

export interface TriangleCreepStyle {
  /** 0..1, how far through the window `now` sits. Not itself what drives
   *  the motion (the animation is) — carried as the static fallback
   *  position for `prefers-reduced-motion` (see globals.css) and asserted
   *  directly in tests. */
  fraction: number;
  /** the CSS animation's total duration: the stop's real window length. */
  durationMs: number;
  /** negative: how far into that duration `now` already sits, so the
   *  animation starts already offset at the correct position instead of
   *  restarting from the left edge every time the card renders. */
  delayMs: number;
}

/**
 * Computes the creep animation's timing from a stop's real start/end
 * instants and `now`. Returns null — "do not render the triangle at all" —
 * whenever the fraction wouldn't be a valid, meaningful position:
 *   - a missing or malformed start/end instant
 *   - a zero or inverted window (`end <= start`), which would otherwise
 *     produce a non-positive or NaN animation-duration
 *   - `now` outside the half-open window `[start, end)` — the same
 *     convention `deriveStopStatus`/`legUnderway` already use elsewhere, so
 *     a stop exactly AT its end instant (fully elapsed) reads as not-active
 *     rather than "creeped all the way to 100% forever"
 *
 * This function does not decide WHETHER a stop is active — `stop.status`
 * already owns that — only WHERE within the card the triangle sits once
 * something else has decided to show it. Callers must still gate on
 * `status === "active"`.
 */
export function computeTriangleCreep(
  startISO: string | null | undefined,
  endISO: string | null | undefined,
  now: Date
): TriangleCreepStyle | null {
  if (!startISO || !endISO) return null;
  const startMs = new Date(startISO).getTime();
  const endMs = new Date(endISO).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const durationMs = endMs - startMs;
  // Named explicitly (never let a zero/negative duration reach the return
  // value) even though the half-open check below already implies it for
  // any `now` — a window can only ever CONTAIN an instant when its end is
  // strictly after its start, so no `now` could pass that check with
  // durationMs <= 0. Keeping this guard names the specific hazard
  // (NaN/negative animation-duration) directly rather than leaning on that
  // derivation, and it stops a future edit to the window check from
  // silently losing the protection too.
  if (durationMs <= 0) return null;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || nowMs < startMs || nowMs >= endMs) return null;
  const elapsedMs = nowMs - startMs;
  return {
    fraction: elapsedMs / durationMs,
    durationMs,
    delayMs: -elapsedMs,
  };
}
