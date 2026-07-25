import assert from "node:assert";
import { createRetryableLoader } from "./retryableLoader";

const cases: Array<[string, () => Promise<void>]> = [
  [
    "concurrent callers share one provider attempt",
    async () => {
      let calls = 0;
      let resolve!: (value: string) => void;
      const pending = new Promise<string>((done) => {
        resolve = done;
      });
      const load = createRetryableLoader(() => {
        calls++;
        return pending;
      });

      const first = load();
      const second = load();
      assert.strictEqual(first, second);
      assert.strictEqual(calls, 1);
      resolve("ready");
      assert.deepStrictEqual(await Promise.all([first, second]), ["ready", "ready"]);
    },
  ],
  [
    "a rejected attempt is evicted so retry can recover",
    async () => {
      let calls = 0;
      const load = createRetryableLoader(async () => {
        calls++;
        if (calls === 1) throw new Error("temporary provider failure");
        return "ready";
      });

      await assert.rejects(load(), /temporary provider failure/);
      assert.strictEqual(await load(), "ready");
      assert.strictEqual(calls, 2);
    },
  ],
  [
    "a successful result remains cached across later mounts",
    async () => {
      let calls = 0;
      const load = createRetryableLoader(async () => {
        calls++;
        return { ready: true };
      });

      const first = await load();
      const second = await load();
      assert.strictEqual(first, second);
      assert.strictEqual(calls, 1);
    },
  ],
];

async function main() {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

void main();
