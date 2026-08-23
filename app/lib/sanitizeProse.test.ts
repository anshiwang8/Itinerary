// sanitizeModelProse — the safety net under the "no em-dashes" prompt
// instruction. Pure function; every case here is a synchronous assertion.
// Run with: npx tsx app/lib/sanitizeProse.test.ts
import assert from "node:assert";
import { sanitizeModelProse, sanitizeModelProseList } from "./sanitizeProse";

const cases: Array<[string, () => void]> = [
  [
    "an em-dash joining two clauses becomes a comma",
    () => {
      assert.strictEqual(
        sanitizeModelProse("Dim-lit spot known for duck — a serious wine list too."),
        "Dim-lit spot known for duck, a serious wine list too."
      );
    },
  ],
  [
    "an en-dash used the same way is treated identically",
    () => {
      assert.strictEqual(
        sanitizeModelProse("Great patio – open till late."),
        "Great patio, open till late."
      );
    },
  ],
  [
    "a string with no dash at all is returned unchanged",
    () => {
      const clean = "A cozy ramen counter with a short, focused menu.";
      assert.strictEqual(sanitizeModelProse(clean), clean);
    },
  ],
  [
    "a tight (no-space) em-dash is still caught",
    () => {
      assert.strictEqual(
        sanitizeModelProse("Loud room—bring earplugs."),
        "Loud room, bring earplugs."
      );
    },
  ],
  [
    "multiple dashes in one string are all replaced",
    () => {
      assert.strictEqual(
        sanitizeModelProse("Small — cozy — and always full."),
        "Small, cozy, and always full."
      );
    },
  ],
  [
    "a leading dash leaves no stray leading comma",
    () => {
      assert.strictEqual(
        sanitizeModelProse("— worth the wait, honestly."),
        "worth the wait, honestly."
      );
    },
  ],
  [
    "a dash immediately before terminal punctuation leaves no dangling comma",
    () => {
      assert.strictEqual(sanitizeModelProse("Great pick —."), "Great pick.");
      assert.strictEqual(sanitizeModelProse("Worth it —!"), "Worth it!");
    },
  ],
  [
    "a dash right after a sentence-ending period does not double the stop",
    () => {
      assert.strictEqual(
        sanitizeModelProse("Closed Mondays. — Everything else stays open."),
        "Closed Mondays. Everything else stays open."
      );
    },
  ],
  [
    "double-space artifacts around the swap are collapsed",
    () => {
      assert.strictEqual(
        sanitizeModelProse("Cozy spot   —   great for a first date."),
        "Cozy spot, great for a first date."
      );
    },
  ],
  [
    "the cp437 em-dash mojibake (ΓÇö) resolves through the same rule",
    () => {
      assert.strictEqual(
        sanitizeModelProse("Beloved dumpling counter ΓÇö now closed."),
        "Beloved dumpling counter, now closed."
      );
    },
  ],
  [
    "the cp1252 em-dash mojibake (â€”) resolves through the same rule",
    () => {
      assert.strictEqual(
        sanitizeModelProse("Loud but fun â€” bring earplugs."),
        "Loud but fun, bring earplugs."
      );
    },
  ],
  [
    "the cp437 and cp1252 en-dash mojibake forms resolve too",
    () => {
      assert.strictEqual(
        sanitizeModelProse("Open late ΓÇô worth it."),
        "Open late, worth it."
      );
      assert.strictEqual(
        sanitizeModelProse("Open late â€“ worth it."),
        "Open late, worth it."
      );
    },
  ],
  [
    "a non-string is returned as-is rather than throwing",
    () => {
      // model JSON can hand back an unexpected type before validation runs;
      // the sanitizer must never be the thing that crashes on it.
      assert.strictEqual(sanitizeModelProse(undefined as unknown as string), undefined);
      assert.strictEqual(sanitizeModelProse(null as unknown as string), null);
    },
  ],
  [
    "an empty string stays empty",
    () => {
      assert.strictEqual(sanitizeModelProse(""), "");
    },
  ],
  [
    "sanitizeModelProseList maps the same rule across an array (question options)",
    () => {
      assert.deepStrictEqual(
        sanitizeModelProseList(["Now — right away", "In an hour", "Tonight — later"]),
        ["Now, right away", "In an hour", "Tonight, later"]
      );
    },
  ],
];

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
})();
