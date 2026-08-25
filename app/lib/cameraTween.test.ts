// The stop-focus camera tween, proven without a DOM or real animation-frame
// timing. `startCameraTween`'s raf/caf/now are injected so every case below
// controls frame timing exactly — no sleeps, no flakiness.
import assert from "node:assert";
import {
  camerasEqual,
  cameraTweenFrame,
  easeInOutCubic,
  lerp,
  startCameraTween,
  type CameraPoint,
  type CameraTweenDeps,
} from "./cameraTween";

type Case = [string, () => void];

const START: CameraPoint = { lat: 43.6, lng: -79.4, zoom: 14 };
const TARGET: CameraPoint = { lat: 43.65, lng: -79.42, zoom: 17 };

/** A controllable fake clock + rAF queue: `raf` enqueues without running,
 *  `advance` moves the clock, `flushOne` runs the next queued callback (as
 *  the real browser would on its next frame), and `caf` behaves like the
 *  real API — it actually removes a still-queued callback. */
function makeFakeClock() {
  let time = 0;
  let nextId = 1;
  const queue: Array<{ id: number; cb: (t: number) => void }> = [];
  const cancelledIds: number[] = [];
  const deps: CameraTweenDeps = {
    now: () => time,
    raf: (cb) => {
      const id = nextId++;
      queue.push({ id, cb });
      return id;
    },
    caf: (id) => {
      cancelledIds.push(id);
      const idx = queue.findIndex((q) => q.id === id);
      if (idx >= 0) queue.splice(idx, 1);
    },
  };
  return {
    advance: (ms: number) => {
      time += ms;
    },
    flushOne: (): boolean => {
      const next = queue.shift();
      if (!next) return false;
      next.cb(time);
      return true;
    },
    queueLength: () => queue.length,
    cancelledIds,
    deps,
  };
}

const cases: Case[] = [
  [
    "lerp: t=0 -> a, t=1 -> b, t=0.5 -> midpoint",
    () => {
      assert.strictEqual(lerp(10, 20, 0), 10);
      assert.strictEqual(lerp(10, 20, 1), 20);
      assert.strictEqual(lerp(10, 20, 0.5), 15);
      assert.strictEqual(lerp(-5, 5, 0.5), 0);
    },
  ],
  [
    "easeInOutCubic: t=0 -> 0, t=1 -> 1, t=0.5 -> 0.5, monotonic in between",
    () => {
      assert.strictEqual(easeInOutCubic(0), 0);
      assert.strictEqual(easeInOutCubic(1), 1);
      assert.strictEqual(easeInOutCubic(0.5), 0.5);
      assert.ok(easeInOutCubic(0.25) < 0.5, "eases in slower than linear before the midpoint");
      assert.ok(easeInOutCubic(0.75) > 0.5, "eases out toward 1 after the midpoint");
    },
  ],
  [
    "cameraTweenFrame: elapsed=0 lands exactly on start (eased), never done",
    () => {
      const { point, done } = cameraTweenFrame(START, TARGET, 0, 400);
      assert.deepStrictEqual(point, START);
      assert.strictEqual(done, false);
    },
  ],
  [
    "cameraTweenFrame: elapsed>=duration lands exactly on target and is done",
    () => {
      const atDuration = cameraTweenFrame(START, TARGET, 400, 400);
      assert.deepStrictEqual(atDuration.point, TARGET);
      assert.strictEqual(atDuration.done, true);
      const pastDuration = cameraTweenFrame(START, TARGET, 999, 400);
      assert.deepStrictEqual(pastDuration.point, TARGET);
      assert.strictEqual(pastDuration.done, true);
    },
  ],
  [
    "cameraTweenFrame: elapsed=duration/2 is the eased midpoint (0.5 -> arithmetic mean)",
    () => {
      const { point, done } = cameraTweenFrame(START, TARGET, 200, 400);
      assert.strictEqual(done, false);
      assert.strictEqual(point.lat, (START.lat + TARGET.lat) / 2);
      assert.strictEqual(point.lng, (START.lng + TARGET.lng) / 2);
      assert.strictEqual(point.zoom, (START.zoom + TARGET.zoom) / 2);
    },
  ],
  [
    "camerasEqual: true for identical and epsilon-close points, false otherwise",
    () => {
      assert.ok(camerasEqual(START, { ...START }));
      assert.ok(camerasEqual(START, { ...START, lat: START.lat + 1e-9 }));
      assert.ok(!camerasEqual(START, { ...START, lat: START.lat + 1e-3 }));
      assert.ok(!camerasEqual(START, { ...START, zoom: START.zoom + 1 }));
    },
  ],
  [
    "startCameraTween: same start/target notifies once, synchronously, with no frame scheduled",
    () => {
      let rafCalled = false;
      const deps: CameraTweenDeps = {
        now: () => 0,
        raf: () => {
          rafCalled = true;
          return 1;
        },
        caf: () => {},
      };
      const frames: CameraPoint[] = [];
      let doneCount = 0;
      const handle = startCameraTween(
        TARGET,
        TARGET,
        (p) => frames.push(p),
        () => doneCount++,
        400,
        deps
      );
      assert.ok(!rafCalled, "nothing to interpolate — no frame should be scheduled");
      assert.deepStrictEqual(frames, [TARGET]);
      assert.strictEqual(doneCount, 1);
      handle.cancel(); // must not throw, must not double-fire
      assert.strictEqual(doneCount, 1);
    },
  ],
  [
    "startCameraTween: runs frame by frame to completion, landing exactly on target once",
    () => {
      const clock = makeFakeClock();
      const frames: CameraPoint[] = [];
      let doneCount = 0;
      startCameraTween(START, TARGET, (p) => frames.push(p), () => doneCount++, 100, clock.deps);
      assert.strictEqual(clock.queueLength(), 1, "the first frame is scheduled, not run inline");

      clock.advance(50);
      assert.ok(clock.flushOne());
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].lat, (START.lat + TARGET.lat) / 2, "50/100ms is the eased midpoint");
      assert.strictEqual(doneCount, 0);
      assert.strictEqual(clock.queueLength(), 1, "the next frame is queued");

      clock.advance(50); // total 100ms: exactly at duration
      assert.ok(clock.flushOne());
      assert.strictEqual(frames.length, 2);
      assert.deepStrictEqual(frames[1], TARGET, "the final frame lands exactly on target");
      assert.strictEqual(doneCount, 1, "onDone fires exactly once");
      assert.strictEqual(clock.queueLength(), 0, "no further frame is scheduled after done");
    },
  ],
  [
    "startCameraTween: cancel() mid-flight removes the queued frame and stops onFrame/onDone",
    () => {
      const clock = makeFakeClock();
      const frames: CameraPoint[] = [];
      let doneCount = 0;
      const handle = startCameraTween(
        START,
        TARGET,
        (p) => frames.push(p),
        () => doneCount++,
        100,
        clock.deps
      );
      clock.advance(20);
      assert.ok(clock.flushOne());
      assert.strictEqual(frames.length, 1);

      handle.cancel();
      assert.strictEqual(clock.cancelledIds.length, 1, "caf is called exactly once");
      assert.strictEqual(clock.queueLength(), 0, "the pending frame is removed");

      clock.advance(500);
      assert.strictEqual(clock.flushOne(), false, "nothing left to run");
      assert.strictEqual(frames.length, 1, "no frame after cancel");
      assert.strictEqual(doneCount, 0, "never completes after cancel");

      handle.cancel(); // calling it again is a safe no-op
      assert.strictEqual(frames.length, 1);
    },
  ],
  [
    "startCameraTween: the internal cancelled flag guards against a caf that fails to actually stop the browser",
    () => {
      const captured: { cb: ((t: number) => void) | null } = { cb: null };
      let time = 0;
      const deps: CameraTweenDeps = {
        now: () => time,
        raf: (cb) => {
          captured.cb = cb;
          return 1;
        },
        // A hostile/racey caf: it does NOT prevent the queued callback from
        // still being invoked, unlike the real browser API.
        caf: () => {},
      };
      const frames: CameraPoint[] = [];
      let doneCount = 0;
      const handle = startCameraTween(
        START,
        TARGET,
        (p) => frames.push(p),
        () => doneCount++,
        100,
        deps
      );
      time = 20;
      captured.cb?.(time);
      assert.strictEqual(frames.length, 1);
      const leaked = captured.cb;

      handle.cancel();
      time = 50;
      leaked?.(time); // simulate the browser firing the "cancelled" frame anyway
      assert.strictEqual(frames.length, 1, "the internal flag must block the leaked frame");
      assert.strictEqual(doneCount, 0);
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
