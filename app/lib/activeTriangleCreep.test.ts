// The active-stop creep triangle's timing math, proven without a DOM or a
// real clock. `computeTriangleCreep`'s `now` is injected so every case
// below controls elapsed time exactly.
import assert from "node:assert";
import { computeTriangleCreep } from "./activeTriangleCreep";

type Case = [string, () => void];

const START = "2026-08-28T19:00:00-04:00";
const END = "2026-08-28T20:00:00-04:00"; // a clean 60-minute window
const START_MS = new Date(START).getTime();
const END_MS = new Date(END).getTime();

const cases: Case[] = [
  [
    "0% elapsed: now === start -> fraction 0, delay 0, duration is the full window",
    () => {
      const result = computeTriangleCreep(START, END, new Date(START_MS));
      assert.ok(result, "must render at the exact start instant");
      assert.strictEqual(result!.fraction, 0);
      // -elapsedMs at elapsedMs=0 is negative zero in JS; Math.abs sidesteps
      // the -0-vs-0 distinction Object.is (which strictEqual uses) would
      // otherwise flag as a mismatch.
      assert.strictEqual(Math.abs(result!.delayMs), 0);
      assert.strictEqual(result!.durationMs, 60 * 60_000);
    },
  ],
  [
    "50% elapsed: now at the window's midpoint -> fraction 0.5, delay is -half the duration",
    () => {
      const midMs = START_MS + 30 * 60_000;
      const result = computeTriangleCreep(START, END, new Date(midMs));
      assert.ok(result, "must render at the midpoint");
      assert.strictEqual(result!.fraction, 0.5);
      assert.strictEqual(result!.durationMs, 60 * 60_000);
      assert.strictEqual(result!.delayMs, -30 * 60_000);
    },
  ],
  [
    "just under 100% elapsed: now one minute before end -> fraction just under 1",
    () => {
      const almostEndMs = END_MS - 60_000;
      const result = computeTriangleCreep(START, END, new Date(almostEndMs));
      assert.ok(result, "must still render one minute before the window closes");
      assert.strictEqual(result!.fraction, 59 / 60);
      assert.strictEqual(result!.delayMs, -59 * 60_000);
    },
  ],
  [
    "now === end (100% elapsed, the half-open boundary) -> do not render",
    () => {
      // Mirrors deriveStopStatus/legUnderway's own half-open [start, end)
      // convention: at the exact end instant the stop is no longer active,
      // so the triangle must not claim a permanent 100% position.
      assert.strictEqual(computeTriangleCreep(START, END, new Date(END_MS)), null);
    },
  ],
  [
    "now past end -> do not render",
    () => {
      assert.strictEqual(
        computeTriangleCreep(START, END, new Date(END_MS + 5 * 60_000)),
        null
      );
    },
  ],
  [
    "now before start -> do not render",
    () => {
      assert.strictEqual(
        computeTriangleCreep(START, END, new Date(START_MS - 60_000)),
        null
      );
    },
  ],
  [
    "end === start (zero-duration window) -> do not render, never NaN",
    () => {
      const result = computeTriangleCreep(START, START, new Date(START_MS));
      assert.strictEqual(result, null);
    },
  ],
  [
    "end < start (inverted window) -> do not render, never a negative duration",
    () => {
      const result = computeTriangleCreep(END, START, new Date(START_MS));
      assert.strictEqual(result, null);
    },
  ],
  [
    "missing start or end -> do not render",
    () => {
      assert.strictEqual(computeTriangleCreep(null, END, new Date(START_MS)), null);
      assert.strictEqual(computeTriangleCreep(START, null, new Date(START_MS)), null);
      assert.strictEqual(computeTriangleCreep(undefined, undefined, new Date(START_MS)), null);
    },
  ],
  [
    "malformed start/end strings -> do not render, never NaN",
    () => {
      const result = computeTriangleCreep("not-a-date", END, new Date(START_MS));
      assert.strictEqual(result, null);
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
