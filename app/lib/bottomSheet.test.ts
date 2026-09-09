// The mobile bottom sheet's drag/snap math, proven without a DOM or a real
// touch screen. Every function takes plain numbers, so each case controls
// height/velocity/viewport exactly — same shape as activeTriangleCreep.test.ts.
import assert from "node:assert";
import {
  backgroundOpacityFor,
  clampDragHeight,
  contentStateFor,
  resolveSheetHeights,
  resolveSnapTarget,
  sheetReleaseVelocity,
  sheetTerminalVelocity,
  sheetHeightFor,
  unclampDragHeight,
  PEEK_HEIGHT_PX,
} from "./bottomSheet";

type Case = [string, () => void];

// A representative tall phone viewport (matches mobile.spec.ts's own
// VIEWPORT_HEIGHT) with no safe-area inset — the common case.
const VIEWPORT = 900;
const HEIGHTS = resolveSheetHeights(VIEWPORT, 0);

const cases: Case[] = [
  [
    "resolveSheetHeights: peek is the fixed constant with no safe-area inset",
    () => {
      assert.strictEqual(HEIGHTS.peek, PEEK_HEIGHT_PX);
    },
  ],
  [
    "resolveSheetHeights: half/full scale with viewport height (45%/90%)",
    () => {
      assert.strictEqual(HEIGHTS.half, VIEWPORT * 0.45);
      assert.strictEqual(HEIGHTS.full, VIEWPORT * 0.9);
    },
  ],
  [
    "resolveSheetHeights: on tall viewports the safe-area inset extends peek without changing half/full",
    () => {
      const withInset = resolveSheetHeights(VIEWPORT, 34);
      assert.strictEqual(withInset.peek, PEEK_HEIGHT_PX + 34);
      assert.strictEqual(withInset.half, HEIGHTS.half);
      assert.strictEqual(withInset.full, HEIGHTS.full);
    },
  ],
  [
    "resolveSheetHeights: a negative inset (should never happen) is floored at zero extra",
    () => {
      const result = resolveSheetHeights(VIEWPORT, -20);
      assert.strictEqual(result.peek, PEEK_HEIGHT_PX);
    },
  ],
  [
    "resolveSheetHeights: on a very short viewport, half/full never collapse into peek or invert",
    () => {
      const result = resolveSheetHeights(50, 0);
      assert.ok(result.half > result.peek, "half must stay strictly above peek");
      assert.ok(result.full > result.half, "full must stay strictly above half");
    },
  ],
  [
    "resolveSheetHeights: expanded sheet leaves the measured plan controls and notice unobscured",
    () => {
      // An 844px phone with 180px of controls and a 34px home indicator.
      // The controls, rather than the old 90%-of-viewport rule, set full.
      const result = resolveSheetHeights(844, 34, 180);
      assert.strictEqual(result.full, 664);
      assert.strictEqual(844 - result.full, 180);
      assert.strictEqual(result.peek, PEEK_HEIGHT_PX + 34);
      assert.strictEqual(result.half, 844 * 0.45);
    },
  ],
  [
    "resolveSheetHeights: the 90% viewport ceiling still wins when controls fit above it",
    () => {
      assert.deepStrictEqual(resolveSheetHeights(VIEWPORT, 0, 60), HEIGHTS);
      assert.deepStrictEqual(resolveSheetHeights(VIEWPORT, 0, -50), HEIGHTS);
      assert.deepStrictEqual(resolveSheetHeights(VIEWPORT, 0, 90), HEIGHTS);
      assert.ok(resolveSheetHeights(VIEWPORT, 0, 91).full < HEIGHTS.full);
    },
  ],
  [
    "resolveSheetHeights: short half viewports leave a readable body below the grip and heading",
    () => {
      const landscape = resolveSheetHeights(390, 0, 144);
      assert.deepStrictEqual(landscape, { peek: 128, half: 216, full: 246 });
      assert.strictEqual(landscape.half - 44 - 60, 112);
      const withSafeArea = resolveSheetHeights(390, 34, 120);
      assert.deepStrictEqual(withSafeArea, { peek: 162, half: 250, full: 270 });
      assert.strictEqual(withSafeArea.half - 34 - 44 - 60, 112);
      // The minimum changes only cramped layouts; a normal tall phone keeps
      // its established fractional snap positions.
      assert.deepStrictEqual(resolveSheetHeights(844, 34, 144), { peek: 162, half: 379.8, full: 700 });
    },
  ],
  [
    "resolveSheetHeights: a short keyboard viewport compresses all snaps inside the available space",
    () => {
      const result = resolveSheetHeights(300, 34, 180);
      assert.deepStrictEqual(result, { peek: 118, half: 119, full: 120 });
      assert.ok(result.peek > 0);
      assert.ok(result.peek < result.half);
      assert.ok(result.half < result.full);
      assert.ok(result.peek < PEEK_HEIGHT_PX, "the fixed peek must yield to the actual viewport cap");
    },
  ],
  [
    "resolveSheetHeights: controls and unusually large safe areas never invert the snap order",
    () => {
      for (const viewport of [240, 390, 640, 844, 1024]) {
        for (const safeArea of [0, 34, 1000]) {
          for (const clearance of [0, 144, viewport - 3, viewport, viewport + 100]) {
            const result = resolveSheetHeights(viewport, safeArea, clearance);
            const label = JSON.stringify({ viewport, safeArea, clearance, result });
            assert.ok(result.peek > 0, label);
            assert.ok(result.peek < result.half && result.half < result.full, label);
            assert.ok(result.full <= viewport * 0.9, label);
            // With less than three pixels available, the three ordered
            // states retain a minimal emergency surface instead of NaN.
            if (viewport - clearance >= 3) assert.ok(result.full <= viewport - clearance, label);
            else assert.strictEqual(result.full, 3, label);
          }
        }
      }
    },
  ],
  [
    "clampDragHeight: inside [peek, full] passes through unchanged",
    () => {
      const mid = (HEIGHTS.peek + HEIGHTS.full) / 2;
      assert.strictEqual(clampDragHeight(mid, HEIGHTS), mid);
      assert.strictEqual(clampDragHeight(HEIGHTS.peek, HEIGHTS), HEIGHTS.peek);
      assert.strictEqual(clampDragHeight(HEIGHTS.full, HEIGHTS), HEIGHTS.full);
    },
  ],
  [
    "clampDragHeight: below peek is resisted, never a 1:1 drag past the bound",
    () => {
      const raw = HEIGHTS.peek - 100;
      const clamped = clampDragHeight(raw, HEIGHTS);
      assert.ok(clamped > raw, "resistance must pull the value back toward peek");
      assert.ok(clamped < HEIGHTS.peek, "but still move somewhat below peek, not hard-stop");
      assert.strictEqual(clamped, HEIGHTS.peek - 100 * 0.35);
    },
  ],
  [
    "clampDragHeight: above full is resisted symmetrically",
    () => {
      const raw = HEIGHTS.full + 100;
      const clamped = clampDragHeight(raw, HEIGHTS);
      assert.ok(clamped < raw);
      assert.ok(clamped > HEIGHTS.full);
      assert.strictEqual(clamped, HEIGHTS.full + 100 * 0.35);
    },
  ],
  [
    "unclampDragHeight: re-grabbing either resisted edge preserves position and small finger movement",
    () => {
      const heights = resolveSheetHeights(844, 34, 144);
      for (const painted of [127, 735]) {
        const raw = unclampDragHeight(painted, heights);
        assert.strictEqual(clampDragHeight(raw, heights), painted, "a stationary re-grab must not jump");
        assert.ok(Math.abs(clampDragHeight(raw + 1, heights) - (painted + 0.35)) < 1e-9);
        assert.ok(Math.abs(clampDragHeight(raw - 1, heights) - (painted - 0.35)) < 1e-9);
      }
    },
  ],
  [
    "unclampDragHeight: raw and painted heights round-trip across bounds and compressed viewports",
    () => {
      for (const heights of [HEIGHTS, resolveSheetHeights(844, 34, 144), resolveSheetHeights(300, 34, 180)]) {
        for (const raw of [heights.peek - 500, heights.peek - 1, heights.peek, heights.half, heights.full, heights.full + 1, heights.full + 300]) {
          const restored = unclampDragHeight(clampDragHeight(raw, heights), heights);
          assert.ok(Math.abs(restored - raw) < 1e-9, `${raw} must survive a drag/re-grab round trip`);
        }
        // The component caps its painted overshoot at full + 80px. Recover
        // an equivalent raw baseline from that cap, not the pre-cap finger.
        const capped = heights.full + 80;
        assert.ok(Math.abs(clampDragHeight(unclampDragHeight(capped, heights), heights) - capped) < 1e-9);
      }
    },
  ],
  [
    "resolveSnapTarget: exactly at a point with no velocity returns that point",
    () => {
      assert.strictEqual(resolveSnapTarget(HEIGHTS.peek, 0, HEIGHTS), "peek");
      assert.strictEqual(resolveSnapTarget(HEIGHTS.half, 0, HEIGHTS), "half");
      assert.strictEqual(resolveSnapTarget(HEIGHTS.full, 0, HEIGHTS), "full");
    },
  ],
  [
    "resolveSnapTarget: slow drag settles at the NEAREST point regardless of direction",
    () => {
      const justAbovePeek = HEIGHTS.peek + 5;
      assert.strictEqual(resolveSnapTarget(justAbovePeek, 0.01, HEIGHTS), "peek");
      const justBelowFull = HEIGHTS.full - 5;
      assert.strictEqual(resolveSnapTarget(justBelowFull, -0.01, HEIGHTS), "full");
    },
  ],
  [
    "resolveSnapTarget: a point exactly equidistant between two snaps rounds down to the lower one",
    () => {
      const midpoint = (HEIGHTS.peek + HEIGHTS.half) / 2;
      assert.strictEqual(resolveSnapTarget(midpoint, 0, HEIGHTS), "peek");
    },
  ],
  [
    "resolveSnapTarget: a fast upward fling from near peek commits to half, even before the midpoint",
    () => {
      const barelyMoved = HEIGHTS.peek + 5;
      assert.strictEqual(resolveSnapTarget(barelyMoved, 0.8, HEIGHTS), "half");
    },
  ],
  [
    "resolveSnapTarget: a fast downward fling from near full commits to half",
    () => {
      const barelyMoved = HEIGHTS.full - 5;
      assert.strictEqual(resolveSnapTarget(barelyMoved, -0.8, HEIGHTS), "half");
    },
  ],
  [
    "resolveSnapTarget: crossing the old nearest-point midpoint cannot skip half in either direction",
    () => {
      const heights = resolveSheetHeights(844, 34, 144);
      for (const height of [270.9, 271.9]) {
        assert.strictEqual(resolveSnapTarget(height, 0.8, heights), "half");
      }
      for (const height of [540.9, 539.9]) {
        assert.strictEqual(resolveSnapTarget(height, -0.8, heights), "half");
      }
    },
  ],
  [
    "resolveSnapTarget: a fling advances past an exact snap only after the release reaches it",
    () => {
      const half = HEIGHTS.half;
      assert.strictEqual(resolveSnapTarget(half - 0.01, 0.8, HEIGHTS), "half");
      assert.strictEqual(resolveSnapTarget(half, 0.8, HEIGHTS), "full");
      assert.strictEqual(resolveSnapTarget(half + 0.01, 0.8, HEIGHTS), "full");
      assert.strictEqual(resolveSnapTarget(half + 0.01, -0.8, HEIGHTS), "half");
      assert.strictEqual(resolveSnapTarget(half, -0.8, HEIGHTS), "peek");
      assert.strictEqual(resolveSnapTarget(half - 0.01, -0.8, HEIGHTS), "peek");
    },
  ],
  [
    "resolveSnapTarget: flinging back from overscroll returns to the first bound instead of skipping it",
    () => {
      for (const speed of [-0.8, 0, 0.8]) {
        assert.strictEqual(resolveSnapTarget(HEIGHTS.peek - 35, speed, HEIGHTS), "peek");
        assert.strictEqual(resolveSnapTarget(HEIGHTS.full + 35, speed, HEIGHTS), "full");
      }
    },
  ],
  [
    "resolveSnapTarget: a fling never overshoots past the ends of SNAP_ORDER",
    () => {
      // already effectively at full, flinging further up must still resolve full
      assert.strictEqual(resolveSnapTarget(HEIGHTS.full, 0.9, HEIGHTS), "full");
      // already effectively at peek, flinging further down must still resolve peek
      assert.strictEqual(resolveSnapTarget(HEIGHTS.peek, -0.9, HEIGHTS), "peek");
    },
  ],
  [
    "resolveSnapTarget: velocity right at the threshold does not count as a fling (strict >)",
    () => {
      const barelyMoved = HEIGHTS.peek + 5;
      assert.strictEqual(resolveSnapTarget(barelyMoved, 0.5, HEIGHTS), "peek");
      assert.strictEqual(resolveSnapTarget(HEIGHTS.full - 5, -0.5, HEIGHTS), "full");
    },
  ],
  [
    "sheetReleaseVelocity: a fresh sample preserves upward and downward fling direction",
    () => {
      assert.strictEqual(sheetReleaseVelocity(0.8, 1000, 1040), 0.8);
      assert.strictEqual(sheetReleaseVelocity(-0.8, 1000, 1040), -0.8);
      assert.strictEqual(sheetReleaseVelocity(0.25, 1000, 1000), 0.25);
    },
  ],
  [
    "sheetReleaseVelocity: the 100ms freshness boundary is inclusive and expires immediately after",
    () => {
      assert.strictEqual(sheetReleaseVelocity(0.8, 1000, 1100), 0.8);
      assert.strictEqual(sheetReleaseVelocity(0.8, 1000, 1100.01), 0);
    },
  ],
  [
    "sheetReleaseVelocity: holding after a flick settles at the nearby point rather than reusing the old fling",
    () => {
      const stoppedNearPeek = HEIGHTS.peek + 5;
      const fresh = sheetReleaseVelocity(0.8, 1000, 1040);
      const held = sheetReleaseVelocity(0.8, 1000, 1500);
      assert.strictEqual(resolveSnapTarget(stoppedNearPeek, fresh, HEIGHTS), "half");
      assert.strictEqual(resolveSnapTarget(stoppedNearPeek, held, HEIGHTS), "peek");
      const stoppedNearFull = HEIGHTS.full - 5;
      assert.strictEqual(resolveSnapTarget(stoppedNearFull, sheetReleaseVelocity(-0.8, 1000, 1500), HEIGHTS), "full");
    },
  ],
  [
    "sheetReleaseVelocity: invalid samples or clocks cannot manufacture a fling",
    () => {
      for (const invalid of [NaN, Infinity, -Infinity]) {
        assert.strictEqual(sheetReleaseVelocity(invalid, 1000, 1010), 0);
        assert.strictEqual(sheetReleaseVelocity(0.8, invalid, 1010), 0);
        assert.strictEqual(sheetReleaseVelocity(0.8, 1000, invalid), 0);
      }
      assert.strictEqual(sheetReleaseVelocity(0.8, 1000, 999), 0);
    },
  ],
  [
    "sheetTerminalVelocity: a distinct release coordinate replaces a recent opposite-direction sample",
    () => {
      const heights = resolveSheetHeights(844, 34, 144);
      const speed = sheetTerminalVelocity({ velocity: 1, lastY: 464, lastMoveAt: 1000, releaseY: 474, releasedAt: 1050 });
      assert.strictEqual(speed, -0.2);
      assert.strictEqual(resolveSnapTarget(370, speed, heights), "half");
      const strongReversal = sheetTerminalVelocity({ velocity: 1, lastY: 464, lastMoveAt: 1000, releaseY: 484, releasedAt: 1010 });
      assert.strictEqual(strongReversal, -2);
      assert.strictEqual(resolveSnapTarget(370, strongReversal, heights), "peek");
      assert.strictEqual(sheetTerminalVelocity({ velocity: -1, lastY: 464, lastMoveAt: 1000, releaseY: 444, releasedAt: 1010 }), 2);
    },
  ],
  [
    "sheetTerminalVelocity: an unchanged release coordinate retains fresh motion but expires after a hold",
    () => {
      const sample = { velocity: 0.8, lastY: 464, lastMoveAt: 1000, releaseY: 464 };
      assert.strictEqual(sheetTerminalVelocity({ ...sample, releasedAt: 1000 }), 0.8);
      assert.strictEqual(sheetTerminalVelocity({ ...sample, releasedAt: 1100 }), 0.8);
      assert.strictEqual(sheetTerminalVelocity({ ...sample, releasedAt: 1100.01 }), 0);
      assert.strictEqual(sheetTerminalVelocity({ ...sample, releasedAt: 1500 }), 0);
      assert.strictEqual(sheetTerminalVelocity({ ...sample, releaseY: 364, releasedAt: 1100 }), 1);
      assert.strictEqual(sheetTerminalVelocity({ ...sample, releaseY: 364, releasedAt: 1100.01 }), 0);
    },
  ],
  [
    "sheetTerminalVelocity: missing timing or invalid coordinates never invent terminal motion",
    () => {
      const sample = { velocity: 0.8, lastY: 464, lastMoveAt: 1000, releaseY: 454, releasedAt: 1010 };
      assert.strictEqual(sheetTerminalVelocity({ ...sample, releasedAt: 1000 }), 0);
      assert.strictEqual(sheetTerminalVelocity({ ...sample, releasedAt: 999 }), 0);
      for (const invalid of [NaN, Infinity, -Infinity]) {
        assert.strictEqual(sheetTerminalVelocity({ ...sample, lastY: invalid }), 0);
        assert.strictEqual(sheetTerminalVelocity({ ...sample, releaseY: invalid }), 0);
        assert.strictEqual(sheetTerminalVelocity({ ...sample, lastMoveAt: invalid }), 0);
        assert.strictEqual(sheetTerminalVelocity({ ...sample, releasedAt: invalid }), 0);
        assert.strictEqual(sheetTerminalVelocity({ ...sample, velocity: invalid, releaseY: sample.lastY }), 0);
      }
    },
  ],
  [
    "contentStateFor: mirrors resolveSnapTarget with no velocity term",
    () => {
      assert.strictEqual(contentStateFor(HEIGHTS.peek + 1, HEIGHTS), "peek");
      assert.strictEqual(contentStateFor(HEIGHTS.half, HEIGHTS), "half");
      assert.strictEqual(contentStateFor(HEIGHTS.full - 1, HEIGHTS), "full");
    },
  ],
  [
    "sheetHeightFor: looks up the exact height for a resting state",
    () => {
      assert.strictEqual(sheetHeightFor("peek", HEIGHTS), HEIGHTS.peek);
      assert.strictEqual(sheetHeightFor("half", HEIGHTS), HEIGHTS.half);
      assert.strictEqual(sheetHeightFor("full", HEIGHTS), HEIGHTS.full);
    },
  ],
  [
    "backgroundOpacityFor: fully translucent at and below half height",
    () => {
      assert.strictEqual(backgroundOpacityFor(HEIGHTS.peek, HEIGHTS), 0);
      assert.strictEqual(backgroundOpacityFor(HEIGHTS.half, HEIGHTS), 0);
    },
  ],
  [
    "backgroundOpacityFor: fully opaque at and above full height",
    () => {
      assert.strictEqual(backgroundOpacityFor(HEIGHTS.full, HEIGHTS), 1);
      assert.strictEqual(backgroundOpacityFor(HEIGHTS.full + 50, HEIGHTS), 1);
    },
  ],
  [
    "backgroundOpacityFor: linear midway between half and full is 0.5",
    () => {
      const mid = (HEIGHTS.half + HEIGHTS.full) / 2;
      assert.strictEqual(backgroundOpacityFor(mid, HEIGHTS), 0.5);
    },
  ],
  [
    "backgroundOpacityFor: never negative or > 1 even for out-of-range input",
    () => {
      assert.strictEqual(backgroundOpacityFor(-1000, HEIGHTS), 0);
      assert.strictEqual(backgroundOpacityFor(1_000_000, HEIGHTS), 1);
    },
  ],
];

function main() {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
