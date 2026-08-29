// The arrival fold (`reduceArrival`), proven without a DOM, a clock, or a
// real GPS. Every instant is in the sample and the distance is a plain
// number the caller would have measured — so each branch is exact here.
import assert from "node:assert";
import {
  ARRIVAL_DWELL_MS,
  ARRIVAL_RADIUS_M,
  DEFAULT_ARRIVAL_CONFIG,
  INITIAL_ARRIVAL_PROGRESS,
  isArrived,
  reduceArrival,
  type ArrivalProgress,
  type ArrivalSample,
} from "./arrivalDetection";

type Case = [string, () => void];

const STOP = "venue-active";
const T0 = 1_000_000_000_000;

function sample(patch: Partial<ArrivalSample>): ArrivalSample {
  return {
    activeStopId: STOP,
    distanceM: 10,
    accuracyM: 30,
    stale: false,
    nowMs: T0,
    ...patch,
  };
}

/** Fold a sequence of samples from the initial progress. */
function run(samples: ArrivalSample[], config = DEFAULT_ARRIVAL_CONFIG): ArrivalProgress {
  return samples.reduce(
    (progress, s) => reduceArrival(progress, s, config),
    INITIAL_ARRIVAL_PROGRESS as ArrivalProgress
  );
}

const cases: Case[] = [
  [
    "within threshold + sustained dwell -> arrived",
    () => {
      const end = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + 20_000 }),
        sample({ nowMs: T0 + ARRIVAL_DWELL_MS }),
      ]);
      assert.strictEqual(end.arrivedStopId, STOP);
      assert.strictEqual(end.dwellStopId, null);
      assert.strictEqual(end.dwellSinceMs, null);
      assert.ok(isArrived(end, STOP));
      assert.ok(!isArrived(end, "some-other-stop"));
    },
  ],
  [
    "within threshold but insufficient dwell -> not yet (dwell in progress)",
    () => {
      const end = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + ARRIVAL_DWELL_MS - 1 }),
      ]);
      assert.strictEqual(end.arrivedStopId, null);
      assert.strictEqual(end.dwellStopId, STOP);
      assert.strictEqual(end.dwellSinceMs, T0);
    },
  ],
  [
    "a single momentary close pass never arrives (this is what the dwell buys)",
    () => {
      // One in-range fix, then the traveller has walked on. Without the
      // dwell requirement (revert-run: set ARRIVAL_DWELL_MS to 0) the first
      // line alone would confirm.
      const end = run([
        sample({ distanceM: 12, nowMs: T0 }),
        sample({ distanceM: 400, nowMs: T0 + 15_000 }),
        sample({ distanceM: 900, nowMs: T0 + 30_000 }),
      ]);
      assert.strictEqual(end.arrivedStopId, null);
      assert.strictEqual(end.dwellStopId, null);
    },
  ],
  [
    "outside threshold -> not arrived, and resets any in-progress dwell",
    () => {
      const mid = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + 20_000 }),
      ]);
      assert.strictEqual(mid.dwellSinceMs, T0, "dwell running before the step out");

      const afterStepOut = reduceArrival(
        mid,
        sample({ distanceM: ARRIVAL_RADIUS_M + 1, nowMs: T0 + 25_000 })
      );
      assert.strictEqual(afterStepOut.dwellStopId, null);
      assert.strictEqual(afterStepOut.dwellSinceMs, null);

      // ...and coming back starts the clock over, so the earlier 20 s do
      // not carry: it takes a fresh full dwell from here.
      const backInRange = reduceArrival(
        afterStepOut,
        sample({ nowMs: T0 + 30_000 })
      );
      assert.strictEqual(backInRange.dwellSinceMs, T0 + 30_000);
      const stillShort = reduceArrival(
        backInRange,
        sample({ nowMs: T0 + 30_000 + ARRIVAL_DWELL_MS - 1 })
      );
      assert.strictEqual(stillShort.arrivedStopId, null);
    },
  ],
  [
    "exactly at the radius still counts (<=), one metre past does not",
    () => {
      const atEdge = run([
        sample({ distanceM: ARRIVAL_RADIUS_M, nowMs: T0 }),
        sample({ distanceM: ARRIVAL_RADIUS_M, nowMs: T0 + ARRIVAL_DWELL_MS }),
      ]);
      assert.strictEqual(atEdge.arrivedStopId, STOP);

      const pastEdge = run([
        sample({ distanceM: ARRIVAL_RADIUS_M + 0.5, nowMs: T0 }),
        sample({ distanceM: ARRIVAL_RADIUS_M + 0.5, nowMs: T0 + ARRIVAL_DWELL_MS }),
      ]);
      assert.strictEqual(pastEdge.arrivedStopId, null);
      assert.strictEqual(pastEdge.dwellStopId, null);
    },
  ],
  [
    "accuracy too coarse -> inconclusive: neither confirms nor resets dwell",
    () => {
      // Start a dwell on good fixes, then a coarse fix lands mid-dwell.
      const beforeCoarse = run([
        sample({ accuracyM: 25, nowMs: T0 }),
        sample({ accuracyM: 25, nowMs: T0 + 15_000 }),
      ]);
      assert.strictEqual(beforeCoarse.dwellSinceMs, T0);

      const coarse = reduceArrival(
        beforeCoarse,
        sample({ accuracyM: ARRIVAL_RADIUS_M + 1, distanceM: 5, nowMs: T0 + 20_000 })
      );
      // dwell held, not reset, not confirmed
      assert.strictEqual(coarse.arrivedStopId, null);
      assert.strictEqual(coarse.dwellStopId, STOP);
      assert.strictEqual(coarse.dwellSinceMs, T0);

      // a coarse fix cannot BE the confirming one, even past the dwell span
      const coarseLate = reduceArrival(
        beforeCoarse,
        sample({
          accuracyM: ARRIVAL_RADIUS_M + 200,
          distanceM: 3,
          nowMs: T0 + ARRIVAL_DWELL_MS + 10_000,
        })
      );
      assert.strictEqual(coarseLate.arrivedStopId, null);

      // the next good fix, past the span from the ORIGINAL anchor, confirms
      const goodAgain = reduceArrival(
        coarse,
        sample({ accuracyM: 20, nowMs: T0 + ARRIVAL_DWELL_MS + 1 })
      );
      assert.strictEqual(goodAgain.arrivedStopId, STOP);
    },
  ],
  [
    "accuracy exactly at the radius is still usable (> is the gate, not >=)",
    () => {
      const end = run([
        sample({ accuracyM: ARRIVAL_RADIUS_M, nowMs: T0 }),
        sample({ accuracyM: ARRIVAL_RADIUS_M, nowMs: T0 + ARRIVAL_DWELL_MS }),
      ]);
      assert.strictEqual(end.arrivedStopId, STOP);
    },
  ],
  [
    "a null accuracy (device gave none) does not trip the gate",
    () => {
      const end = run([
        sample({ accuracyM: null, nowMs: T0 }),
        sample({ accuracyM: null, nowMs: T0 + ARRIVAL_DWELL_MS }),
      ]);
      assert.strictEqual(end.arrivedStopId, STOP);
    },
  ],

  // ── the stale-position asymmetry (CLAUDE.md / task §2.6) ──────────────
  [
    "a stale fix cannot CREATE a new arrival, even in range for the full span",
    () => {
      const end = run([
        sample({ stale: true, nowMs: T0 }),
        sample({ stale: true, nowMs: T0 + 20_000 }),
        sample({ stale: true, nowMs: T0 + ARRIVAL_DWELL_MS + 10_000 }),
      ]);
      assert.strictEqual(end.arrivedStopId, null);
      assert.strictEqual(end.dwellStopId, null, "stale never even starts a dwell");
    },
  ],
  [
    "a stale fix does not reset an in-progress dwell (backgrounded tab at the venue)",
    () => {
      const running = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + 15_000 }),
      ]);
      assert.strictEqual(running.dwellSinceMs, T0);

      const wentStale = reduceArrival(running, sample({ stale: true, nowMs: T0 + 25_000 }));
      assert.strictEqual(wentStale.dwellStopId, STOP);
      assert.strictEqual(wentStale.dwellSinceMs, T0);

      // fresh again, past the span -> confirms from the preserved anchor
      const freshAgain = reduceArrival(
        wentStale,
        sample({ stale: false, nowMs: T0 + ARRIVAL_DWELL_MS + 1 })
      );
      assert.strictEqual(freshAgain.arrivedStopId, STOP);
    },
  ],
  [
    "an already-arrived stop stays arrived when the position later goes stale",
    () => {
      const arrived = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + ARRIVAL_DWELL_MS }),
      ]);
      assert.strictEqual(arrived.arrivedStopId, STOP);

      const thenStale = reduceArrival(arrived, sample({ stale: true, nowMs: T0 + 60_000 }));
      assert.strictEqual(thenStale.arrivedStopId, STOP);

      const thenStaleAndFar = reduceArrival(
        thenStale,
        sample({ stale: true, distanceM: 5_000, nowMs: T0 + 120_000 })
      );
      assert.strictEqual(
        thenStaleAndFar.arrivedStopId,
        STOP,
        "and even a stale far fix does not retract it"
      );
    },
  ],
  [
    "an already-arrived stop is NOT retracted by a fresh out-of-range fix either",
    () => {
      // Once confirmed, it is confirmed for as long as this stop is active.
      // Walking to the washroom across the street does not un-arrive you.
      const arrived = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + ARRIVAL_DWELL_MS }),
      ]);
      const wandered = reduceArrival(
        arrived,
        sample({ distanceM: 300, nowMs: T0 + 90_000 })
      );
      assert.strictEqual(wandered.arrivedStopId, STOP);
    },
  ],

  // ── the active stop changing ─────────────────────────────────────────
  [
    "the active stop moving on clears arrival and any dwell",
    () => {
      const arrivedAtFirst = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + ARRIVAL_DWELL_MS }),
      ]);
      assert.strictEqual(arrivedAtFirst.arrivedStopId, STOP);

      const nextStop = reduceArrival(
        arrivedAtFirst,
        sample({ activeStopId: "venue-second", distanceM: 8, nowMs: T0 + 3_600_000 })
      );
      assert.strictEqual(nextStop.arrivedStopId, null, "first stop's arrival does not carry");
      assert.strictEqual(nextStop.dwellStopId, "venue-second", "a fresh dwell for the new stop");
      assert.strictEqual(nextStop.dwellSinceMs, T0 + 3_600_000);
    },
  ],
  [
    "a dwell in progress for one stop does not transfer when the active stop changes",
    () => {
      const dwelling = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + 20_000 }),
      ]);
      assert.strictEqual(dwelling.dwellStopId, STOP);

      const newActive = reduceArrival(
        dwelling,
        sample({ activeStopId: "venue-second", distanceM: 5, nowMs: T0 + 25_000 })
      );
      assert.strictEqual(newActive.dwellSinceMs, T0 + 25_000, "clock restarts for the new stop");
    },
  ],
  [
    "no active stop -> nothing accumulates; a prior arrival for a real id does not survive a null active id",
    () => {
      const arrived = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + ARRIVAL_DWELL_MS }),
      ]);
      const nowIdle = reduceArrival(
        arrived,
        sample({ activeStopId: null, distanceM: null, nowMs: T0 + 100_000 })
      );
      assert.strictEqual(nowIdle.arrivedStopId, null);
      assert.strictEqual(nowIdle.dwellStopId, null);
    },
  ],

  // ── measurement gaps ────────────────────────────────────────────────
  [
    "distance null (no fix / geometry lib not up) -> dwell drops, arrival kept",
    () => {
      const dwelling = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + 20_000 }),
      ]);
      const noMeasure = reduceArrival(dwelling, sample({ distanceM: null, nowMs: T0 + 25_000 }));
      assert.strictEqual(noMeasure.dwellStopId, null);
      assert.strictEqual(noMeasure.dwellSinceMs, null);

      const arrived = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + ARRIVAL_DWELL_MS }),
      ]);
      const arrivedThenNoMeasure = reduceArrival(
        arrived,
        sample({ distanceM: null, nowMs: T0 + 60_000 })
      );
      assert.strictEqual(arrivedThenNoMeasure.arrivedStopId, STOP);
    },
  ],
  [
    "a non-finite distance or now is treated as no measurement",
    () => {
      const a = reduceArrival(INITIAL_ARRIVAL_PROGRESS, sample({ distanceM: Number.NaN }));
      assert.strictEqual(a.dwellStopId, null);
      const b = reduceArrival(INITIAL_ARRIVAL_PROGRESS, sample({ nowMs: Number.NaN }));
      assert.strictEqual(b.dwellStopId, null);
    },
  ],
  [
    "the dev sim clock jumping backwards restarts the dwell rather than confirming early or going negative",
    () => {
      const dwelling = run([
        sample({ nowMs: T0 }),
        sample({ nowMs: T0 + 30_000 }),
      ]);
      assert.strictEqual(dwelling.dwellSinceMs, T0);

      const wentBack = reduceArrival(dwelling, sample({ nowMs: T0 - 10_000 }));
      assert.strictEqual(wentBack.dwellStopId, STOP);
      assert.strictEqual(wentBack.dwellSinceMs, T0 - 10_000, "re-anchored, never a negative elapsed");
    },
  ],
  [
    "folding a repeated identical sample is a fixed point (safe under double-invoked effects)",
    () => {
      const s = sample({ nowMs: T0 + 10_000 });
      const once = reduceArrival(INITIAL_ARRIVAL_PROGRESS, s);
      const twice = reduceArrival(once, s);
      assert.deepStrictEqual(twice, once);

      const arrived = run([sample({ nowMs: T0 }), sample({ nowMs: T0 + ARRIVAL_DWELL_MS })]);
      const arrivedAgain = reduceArrival(arrived, sample({ nowMs: T0 + ARRIVAL_DWELL_MS }));
      assert.deepStrictEqual(arrivedAgain, arrived);
    },
  ],
  [
    "isArrived is false for null and for a mismatched id",
    () => {
      assert.strictEqual(isArrived(INITIAL_ARRIVAL_PROGRESS, null), false);
      assert.strictEqual(isArrived(INITIAL_ARRIVAL_PROGRESS, STOP), false);
      assert.strictEqual(isArrived({ ...INITIAL_ARRIVAL_PROGRESS, arrivedStopId: STOP }, null), false);
      assert.strictEqual(isArrived({ ...INITIAL_ARRIVAL_PROGRESS, arrivedStopId: STOP }, "x"), false);
      assert.strictEqual(isArrived({ ...INITIAL_ARRIVAL_PROGRESS, arrivedStopId: STOP }, STOP), true);
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
