// The gate that stops a plan overtaking the survey write it depends on.
//
// The bug: the taste survey files its answers fire-and-forget and closes on a
// two-second timer, while `/api/parse` reads that profile back SERVER-SIDE. Plan
// inside the window and the read finds nothing, so the plan ignores answers the
// user gave seconds earlier — and then works after a reload, which is the worst
// way for a feature to look broken.
//
// ORDERING is the whole subject here, so every case proves a SEQUENCE rather
// than a return value: what had happened by the time the gate resolved.
import assert from "node:assert";
import { settlePendingWrite, type PendingWriteRef } from "./pendingWrite";

type AsyncCase = [string, () => Promise<void>];

/** A promise with its settle handles pulled out, so a test can decide exactly
 *  when the write lands relative to the plan asking for it. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const cases: AsyncCase[] = [
  [
    "THE FIX: a plan waits for a write that has not landed yet",
    async () => {
      const order: string[] = [];
      const write = deferred();
      const ref: PendingWriteRef = { current: write.promise };

      const planned = settlePendingWrite(ref).then(() => order.push("plan"));

      // Let every already-queued microtask run. If the gate did not actually
      // wait, "plan" would be recorded by now — this is the assertion that
      // catches a gate removed or short-circuited.
      await Promise.resolve();
      await Promise.resolve();
      // Length rather than deepStrictEqual: node's assert carries an `asserts`
      // signature, so comparing against a literal [] would narrow `order` to
      // never[] and make the pushes below a type error.
      assert.strictEqual(order.length, 0, "the plan must not proceed mid-write");

      order.push("write");
      write.resolve();
      await planned;

      assert.deepStrictEqual(order, ["write", "plan"], "the write finishes first");
    },
  ],
  [
    "NOTHING PENDING is the ordinary case and costs nothing",
    async () => {
      // Every plan except the one right after a submit lands here.
      const ref: PendingWriteRef = { current: null };
      await settlePendingWrite(ref);
      assert.strictEqual(ref.current, null);
    },
  ],
  [
    "a write that FAILED still lets the plan through",
    async () => {
      // The writer swallows its own failure, so this promise normally cannot
      // reject — but the guarantee has to hold for any caller, not just a
      // well-behaved one. A plan is not the place to report that a preference
      // did not save: delay it at most, never fail it.
      const ref: PendingWriteRef = { current: Promise.reject(new Error("write blew up")) };
      await settlePendingWrite(ref);
      assert.strictEqual(ref.current, null, "a failed write is cleared like any other");
    },
  ],
  [
    "the ref is cleared, so a second plan does not wait again",
    async () => {
      const ref: PendingWriteRef = { current: Promise.resolve() };
      await settlePendingWrite(ref);
      assert.strictEqual(ref.current, null);
      // and a second pass over the emptied ref is a no-op, not a throw
      await settlePendingWrite(ref);
      assert.strictEqual(ref.current, null);
    },
  ],
  [
    "a NEWER write started mid-wait is not dropped",
    async () => {
      // Clearing unconditionally would forget the second write and put the
      // next plan straight back into the race this gate exists to close.
      const first = deferred();
      const second = deferred();
      const ref: PendingWriteRef = { current: first.promise };

      const settled = settlePendingWrite(ref);
      ref.current = second.promise;
      first.resolve();
      await settled;

      assert.strictEqual(ref.current, second.promise, "the pending write survives");
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
