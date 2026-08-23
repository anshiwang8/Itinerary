// The banner auto-dismiss timer, proven without a DOM.
//
// The failure mode this guards against is the classic one: a setTimeout that
// outlives the state it was armed for, so it either double-fires, fires after
// a cancel, or dismisses a banner that already changed underneath it. Every
// case below proves a SEQUENCE of callback firings, not just a final value.
//
// Real (tiny-ish) delays rather than a fake clock, matching this repo's
// existing timing tests (clientFetch.test.ts uses real timeouts for the same
// reason). Checkpoints keep a >=20ms margin on both sides of every threshold
// to stay clear of ordinary setTimeout jitter.
import assert from "node:assert";
import { createBannerDismissController } from "./bannerDismiss";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AsyncCase = [string, () => Promise<void>];

const DISMISS = 60;
const FADE = 60;

const cases: AsyncCase[] = [
  [
    "arm() fades then dismisses, in order, once each",
    async () => {
      const order: string[] = [];
      const controller = createBannerDismissController(
        { onFadeStart: () => order.push("fade"), onDismiss: () => order.push("dismiss") },
        DISMISS,
        FADE
      );
      controller.arm();
      await sleep(30);
      assert.deepStrictEqual(order, [], "must not fade before the dismiss delay elapses");
      await sleep(50); // total 80ms: past the 60ms dismiss delay, short of the 120ms dismiss+fade
      assert.deepStrictEqual(order, ["fade"], "fades once the dismiss delay elapses");
      await sleep(80); // total 160ms: past dismiss+fade (120ms)
      assert.deepStrictEqual(order, ["fade", "dismiss"], "dismiss follows fade, once");
    },
  ],
  [
    "cancel() before the dismiss delay stops the fade forever",
    async () => {
      const order: string[] = [];
      const controller = createBannerDismissController(
        { onFadeStart: () => order.push("fade"), onDismiss: () => order.push("dismiss") },
        DISMISS,
        FADE
      );
      controller.arm();
      await sleep(20); // well short of the 60ms dismiss delay
      controller.cancel(); // e.g. a hover/focus pause, or an unmount
      await sleep(150);
      assert.deepStrictEqual(order, [], "a cancelled countdown must never fire");
    },
  ],
  [
    "cancel() mid-fade stops the dismiss from ever landing",
    async () => {
      const order: string[] = [];
      const controller = createBannerDismissController(
        { onFadeStart: () => order.push("fade"), onDismiss: () => order.push("dismiss") },
        DISMISS,
        FADE
      );
      controller.arm();
      await sleep(80); // past the 60ms dismiss delay, short of dismiss+fade (120ms)
      assert.deepStrictEqual(order, ["fade"]);
      controller.cancel(); // e.g. the pointer arrives while it's fading
      await sleep(150);
      assert.deepStrictEqual(order, ["fade"], "a cancelled fade must not still dismiss");
    },
  ],
  [
    "a fresh arm() cancels the prior countdown — the new banner replaces the old",
    async () => {
      const order: string[] = [];
      const controller = createBannerDismissController(
        { onFadeStart: () => order.push("fade"), onDismiss: () => order.push("dismiss") },
        DISMISS,
        FADE
      );
      controller.arm();
      await sleep(30); // halfway through the first countdown, must not fire yet
      controller.arm(); // a new banner takes over
      await sleep(90); // 90ms since the SECOND arm: past its 60ms delay, short of its 120ms
      assert.deepStrictEqual(order, ["fade"], "only the second countdown's fade fires");
      await sleep(60); // total 150ms since the second arm, past its 120ms
      assert.deepStrictEqual(order, ["fade", "dismiss"], "and it dismisses exactly once");
    },
  ],
  [
    "arm() called twice back to back never double-fires",
    async () => {
      const order: string[] = [];
      const controller = createBannerDismissController(
        { onFadeStart: () => order.push("fade"), onDismiss: () => order.push("dismiss") },
        DISMISS,
        FADE
      );
      controller.arm();
      controller.arm();
      await sleep(160);
      assert.deepStrictEqual(order, ["fade", "dismiss"], "exactly one fade and one dismiss");
    },
  ],
  [
    "cancel() with nothing armed is a no-op, not a throw",
    async () => {
      const controller = createBannerDismissController({
        onFadeStart: () => {
          throw new Error("must not fire");
        },
        onDismiss: () => {
          throw new Error("must not fire");
        },
      });
      controller.cancel();
      controller.cancel();
    },
  ],
];

async function main() {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
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

void main();
