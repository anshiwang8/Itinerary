// The stop-itinerary decision: (who you are, what you pressed) → what happens.
//
// The Firestore write and the CAS update are live-only, but this branching is
// checkable, and one of its branches is a privacy promise: a guest's plan is
// never written to history, no matter what the client asks for.
import assert from "node:assert";
import {
  isStopChoice,
  resolveStopOutcome,
  stopChoicesFor,
  type StopChoice,
} from "./stopPlan";

const GUEST = true;
const ACCOUNT = false;

const cases: Array<[string, () => void]> = [
  [
    "a signed-in user who chooses SAVE archives and ends",
    () => {
      assert.deepStrictEqual(resolveStopOutcome(ACCOUNT, "save-end"), {
        shouldArchive: true,
        shouldEnd: true,
      });
    },
  ],
  [
    "a signed-in user who chooses DISCARD ends WITHOUT archiving",
    () => {
      // The whole point of offering two end options: ending is not the same
      // as keeping, and choosing not to keep must actually not keep.
      assert.deepStrictEqual(resolveStopOutcome(ACCOUNT, "discard-end"), {
        shouldArchive: false,
        shouldEnd: true,
      });
    },
  ],
  [
    "a GUEST ending never archives — the privacy promise, restated here",
    () => {
      assert.deepStrictEqual(resolveStopOutcome(GUEST, "discard-end"), {
        shouldArchive: false,
        shouldEnd: true,
      });
    },
  ],
  [
    "a guest asking to SAVE still does not archive",
    () => {
      // Guests are never shown a save button, so this is a stale client or a
      // crafted request. The server runs this same function against the
      // VERIFIED identity, so the answer does not depend on being asked
      // nicely.
      assert.deepStrictEqual(resolveStopOutcome(GUEST, "save-end"), {
        shouldArchive: false,
        shouldEnd: true,
      });
    },
  ],
  [
    "CANCEL ends nothing and archives nothing, for either kind of user",
    () => {
      for (const who of [GUEST, ACCOUNT]) {
        assert.deepStrictEqual(
          resolveStopOutcome(who, "cancel"),
          { shouldArchive: false, shouldEnd: false },
          "cancel is not a soft end"
        );
      }
    },
  ],
  [
    "every end choice ends, and only a real account's save archives",
    () => {
      // The whole truth table in one place.
      const table: Array<[boolean, StopChoice, boolean, boolean]> = [
        [ACCOUNT, "save-end", true, true],
        [ACCOUNT, "discard-end", false, true],
        [ACCOUNT, "cancel", false, false],
        [GUEST, "save-end", false, true],
        [GUEST, "discard-end", false, true],
        [GUEST, "cancel", false, false],
      ];
      for (const [anon, choice, archive, end] of table) {
        assert.deepStrictEqual(
          resolveStopOutcome(anon, choice),
          { shouldArchive: archive, shouldEnd: end },
          `${anon ? "guest" : "account"} + ${choice}`
        );
      }
      // exactly ONE combination may ever archive
      const archiving = table.filter(([, , a]) => a);
      assert.strictEqual(archiving.length, 1, "only a signed-in save archives");
    },
  ],

  [
    "guests are offered two options; accounts three",
    () => {
      // Showing a guest a "Save & end" they are not eligible for would be
      // offering a button that silently does nothing.
      assert.deepStrictEqual(stopChoicesFor(GUEST), ["discard-end", "cancel"]);
      assert.deepStrictEqual(stopChoicesFor(ACCOUNT), ["save-end", "discard-end", "cancel"]);
      assert.ok(!stopChoicesFor(GUEST).includes("save-end"), "no save option for a guest");
      // cancel is always available — ending is never forced once the dialog opens
      for (const who of [GUEST, ACCOUNT]) {
        assert.ok(stopChoicesFor(who).includes("cancel"));
      }
    },
  ],
  [
    "an unrecognised choice is not a choice",
    () => {
      // An unknown instruction to END something is the one case where
      // guessing is expensive, so the parser refuses it and the route 400s.
      assert.ok(isStopChoice("save-end"));
      assert.ok(isStopChoice("discard-end"));
      assert.ok(isStopChoice("cancel"));
      for (const bad of ["end", "SAVE-END", "", null, undefined, 0, {}, ["cancel"]]) {
        assert.strictEqual(isStopChoice(bad), false, `${JSON.stringify(bad)} is not a choice`);
      }
    },
  ],
];

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
