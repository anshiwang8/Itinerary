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
  sheetHeightFor,
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
    "resolveSheetHeights: safe-area inset extends peek only, not half/full",
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
