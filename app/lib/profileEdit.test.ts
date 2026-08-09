// The edit-profile panel's pure decisions: what the editor starts from, whether
// it has unsaved changes, and whether a save landed.
//
// The panel itself needs a real non-anonymous Google account, which mock e2e
// has no way to produce — so these three are the only parts of the feature a
// test can reach, and they are deliberately the parts where being wrong costs
// something: a mis-seeded editor overwrites real answers (the write is `set`
// with no merge), a mis-read dirty flag either nags on every close or discards
// work silently, and a mis-read save result says "Saved" when nothing was.
import assert from "node:assert";
import {
  EMPTY_ANSWERS,
  SURVEY_QUESTIONS,
  toTasteProfileDocument,
  type TasteAnswers,
} from "./tastePreferences";
import {
  answersDirty,
  answersEqual,
  parseProfileEditLoad,
  parseSaveResult,
} from "./profileEdit";

const AT = "2026-08-09T12:00:00.000Z";

/** A filled-in profile, one real choice per dimension. */
function filled(over: Partial<TasteAnswers> = {}): TasteAnswers {
  return {
    style: ["cozy"],
    foods: ["japanese", "thai"],
    dietary: ["vegetarian"],
    activities: ["art"],
    ...over,
  };
}

/** The wire shape `GET /api/profile` answers with. */
function response(profile: unknown, readFailed = false) {
  return { profile, readFailed };
}

/** A stored document, built by the ONE writer so the test cannot drift from
 *  the real record shape. Handed over whole, as `tastePreferences.test.ts`
 *  does: the parser reads named fields, so the owner uid the wire drops is
 *  simply ignored here. */
function stored(answers: TasteAnswers) {
  return toTasteProfileDocument("uid-1", answers, { completed: true, updatedAt: AT });
}

const cases: Array<[string, () => void]> = [
  // ── the seed: what the editor pre-fills with ──
  [
    "seeds every dimension from a stored profile",
    () => {
      const load = parseProfileEditLoad(response(stored(filled())));
      assert.strictEqual(load.readFailed, false);
      assert.deepStrictEqual(load.answers, filled());
    },
  ],
  [
    "seeds a user with nothing stored as an empty — but editable — answer set",
    () => {
      // Not an error and not a failure: a real account that skipped the survey
      // has a profile document whose answers are all empty, and one that has no
      // document at all is in the same position as far as the editor cares.
      const none = parseProfileEditLoad(response(null));
      assert.strictEqual(none.readFailed, false);
      assert.deepStrictEqual(none.answers, EMPTY_ANSWERS);

      const skipped = parseProfileEditLoad(
        response({ ...stored(EMPTY_ANSWERS), surveyCompleted: false })
      );
      assert.strictEqual(skipped.readFailed, false);
      assert.deepStrictEqual(skipped.answers, EMPTY_ANSWERS);
    },
  ],
  [
    "a PRE-ACTIVITIES profile seeds cleanly — no migration, no undefined",
    () => {
      // A document written before the fourth dimension existed simply has no
      // `activities` field. It must read as "chose nothing", because the save
      // that follows sends all four and a missing key would be sent as one.
      const load = parseProfileEditLoad(
        response({
          surveySeen: true,
          surveyCompleted: true,
          style: ["chill"],
          foods: ["italian"],
          dietary: [],
          updatedAt: AT,
        })
      );
      assert.deepStrictEqual(load.answers, {
        style: ["chill"],
        foods: ["italian"],
        dietary: [],
        activities: [],
      });
    },
  ],
  [
    "a RETIRED slug is dropped from the seed, and the rest survives",
    () => {
      // "cultural" was retired when the activities question shipped. The editor
      // must not show a chip that no longer exists, and must not re-file one.
      const load = parseProfileEditLoad(
        response({
          surveySeen: true,
          surveyCompleted: true,
          style: ["cultural", "cozy"],
          foods: ["korean"],
          dietary: [],
          activities: ["music"],
          updatedAt: AT,
        })
      );
      assert.deepStrictEqual(load.answers.style, ["cozy"]);
      assert.deepStrictEqual(load.answers.foods, ["korean"]);
      assert.deepStrictEqual(load.answers.activities, ["music"]);
    },
  ],
  [
    "a FAILED read is reported as failed — the editor must not open on it",
    () => {
      // THE WIPE TRAP. `POST /api/profile` writes with `set` and no merge, and
      // every save sends all four dimensions — so an editor seeded with blanks
      // because the read failed would offer a Save button that erases real
      // answers. Same trade `shouldShowSurvey` makes: on a failed read, do the
      // thing that cannot destroy anything.
      const failed = parseProfileEditLoad(response(stored(filled()), true));
      assert.strictEqual(failed.readFailed, true);
      assert.deepStrictEqual(failed.answers, EMPTY_ANSWERS);

      for (const junk of ["garbage", null, undefined, [], 7]) {
        assert.strictEqual(
          parseProfileEditLoad(junk).readFailed,
          true,
          `${JSON.stringify(junk) ?? "undefined"} is an unreadable body`
        );
      }
    },
  ],

  // ── dirty tracking ──
  [
    "identical answers are CLEAN",
    () => {
      assert.strictEqual(answersEqual(filled(), filled()), true);
      assert.strictEqual(answersDirty(filled(), filled()), false);
      assert.strictEqual(answersDirty(EMPTY_ANSWERS, EMPTY_ANSWERS), false);
    },
  ],
  [
    "ONE toggle in ANY dimension is DIRTY",
    () => {
      // Every dimension, so a change to one of them cannot be the only one the
      // comparison notices.
      for (const question of SURVEY_QUESTIONS) {
        const added = filled({ [question.id]: [...filled()[question.id], question.options[question.options.length - 1].value] });
        const removed = filled({ [question.id]: [] });
        assert.strictEqual(
          answersDirty(filled(), added) || answersDirty(filled(), removed),
          true,
          `${question.id} must register as changed`
        );
        assert.strictEqual(answersDirty(filled(), removed), true, `${question.id} cleared`);
      }
    },
  ],
  [
    "SAME SET, different click order, is CLEAN",
    () => {
      // Order is not meaning: the stored record re-emits every dimension in the
      // question's own order, so a panel that called a re-ordered array dirty
      // would prompt "Discard changes?" at someone who changed nothing.
      const seed = filled({ foods: ["japanese", "thai"] });
      const reordered = filled({ foods: ["thai", "japanese"] });
      assert.strictEqual(answersEqual(seed, reordered), true);
      assert.strictEqual(answersDirty(seed, reordered), false);
    },
  ],
  [
    "a SUBSET is dirty — matching membership is not enough",
    () => {
      const seed = filled({ foods: ["japanese", "thai"] });
      assert.strictEqual(answersDirty(seed, filled({ foods: ["japanese"] })), true);
      assert.strictEqual(
        answersDirty(filled({ foods: ["japanese"] }), seed),
        true
      );
    },
  ],
  [
    "a SUCCESSFUL save makes the saved answers the new clean baseline",
    () => {
      // The composition that decides whether closing right after saving
      // wrongly prompts: the panel replaces its seed with what it just saved.
      const seed = filled();
      const edited = filled({ activities: ["art", "music"] });
      assert.strictEqual(answersDirty(seed, edited), true);
      const afterSave = edited;
      assert.strictEqual(answersDirty(afterSave, edited), false);
    },
  ],
  [
    "the seed a load produces compares clean against itself",
    () => {
      // The two halves meeting: a freshly-loaded editor is never born dirty.
      const load = parseProfileEditLoad(response(stored(filled())));
      assert.strictEqual(answersDirty(load.answers, load.answers), false);
      assert.strictEqual(
        answersDirty(load.answers, parseProfileEditLoad(response(stored(filled()))).answers),
        false
      );
    },
  ],

  // ── the save result ──
  [
    "only an explicit saved:true counts as saved",
    () => {
      assert.deepStrictEqual(parseSaveResult({ saved: true }), { saved: true });
      for (const body of [
        { saved: false },
        { saved: "true" },
        { saved: 1 },
        {},
        null,
        undefined,
        [],
        "saved",
      ]) {
        assert.strictEqual(
          parseSaveResult(body).saved,
          false,
          `${JSON.stringify(body) ?? "undefined"} is not a save`
        );
      }
    },
  ],
  [
    "saved:false is an ORDINARY answer, not an exception",
    () => {
      // The route answers 200 with `{saved:false}` when there is nowhere to
      // write — a guest, a deployment with no Firebase. The panel reports that
      // as "couldn't save", which is true, rather than throwing.
      assert.doesNotThrow(() => parseSaveResult({ saved: false }));
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
