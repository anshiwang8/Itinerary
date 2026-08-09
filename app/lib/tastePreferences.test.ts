// Stage 3A — the two decisions worth pinning without a browser or a Firestore:
// WHO gets asked, and WHAT gets filed.
//
// The Firestore call itself is live-only and is not tested here, the same way
// `archiveConcludedPlan` isn't. Everything AROUND it is ordinary branching:
// four distinct reasons not to show the survey, a closed option set, and a
// document shape Firestore will reject if a single field goes undefined.
import assert from "node:assert";
import {
  EMPTY_ANSWERS,
  SURVEY_QUESTIONS,
  isEmptyAnswers,
  normalizeAnswerSet,
  normalizeTasteAnswers,
  parseTasteProfile,
  profileGateState,
  shouldRearmSurvey,
  shouldShowSurvey,
  toTasteProfileDocument,
  type SurveyGateInput,
  type TasteAnswers,
} from "./tastePreferences";

/** The showable case — a brand-new signed-in user with no profile. Every test
 *  below changes exactly one thing about it, so what each "no" is caused by is
 *  never in doubt. */
function gate(over: Partial<SurveyGateInput> = {}): SurveyGateInput {
  return {
    authStatus: "signed-in",
    isAnonymous: false,
    profile: "absent",
    alreadyShown: false,
    ...over,
  };
}

const AT = "2026-08-04T12:00:00.000Z";

function skipped() {
  return toTasteProfileDocument("uid-1", EMPTY_ANSWERS, {
    completed: false,
    updatedAt: AT,
  });
}

const cases: Array<[string, () => void]> = [
  // ── the survey definition ──
  [
    "asks exactly the four dimensions, in order",
    () => {
      assert.deepStrictEqual(
        SURVEY_QUESTIONS.map((q) => q.id),
        ["style", "foods", "dietary", "activities"]
      );
    },
  ],
  [
    "the activities question offers exactly the five steerable kinds",
    () => {
      // The closed set is the whole point: these are the interests the planner
      // can actually steer a vague plan toward. Adding a sixth means proving
      // it first — see the note beside the options.
      const activities = SURVEY_QUESTIONS.find((q) => q.id === "activities");
      assert.deepStrictEqual(
        activities?.options.map((o) => o.value),
        ["art", "outdoors", "games", "active", "music"]
      );
    },
  ],
  [
    "style is PURE VIBE — 'cultural' was retired to the activities question",
    () => {
      const style = SURVEY_QUESTIONS.find((q) => q.id === "style");
      assert.deepStrictEqual(
        style?.options.map((o) => o.value),
        ["chill", "lively", "trendy", "cozy", "adventurous"]
      );
    },
  ],
  [
    "a RETIRED slug in a stored profile is silently dropped on read",
    () => {
      // What makes retiring an option safe with no migration: the closed set
      // is applied on the way OUT of storage too, so a profile written when
      // "cultural" existed simply comes back without it — and the rest of that
      // person's answers are untouched.
      assert.deepStrictEqual(normalizeAnswerSet("style", ["chill", "cultural"]), ["chill"]);
      const stored = parseTasteProfile({
        surveySeen: true,
        surveyCompleted: true,
        style: ["cultural", "cozy"],
        foods: ["thai"],
        updatedAt: AT,
      });
      assert.deepStrictEqual(stored?.style, ["cozy"]);
      assert.deepStrictEqual(stored?.foods, ["thai"]);
      // and a pre-activities document reads as "chose nothing", not undefined
      assert.deepStrictEqual(stored?.activities, []);
    },
  ],
  [
    "every option has a unique slug within its question",
    () => {
      for (const question of SURVEY_QUESTIONS) {
        const values = question.options.map((o) => o.value);
        assert.strictEqual(
          new Set(values).size,
          values.length,
          `duplicate slug in ${question.id}`
        );
        assert.ok(values.length > 1, `${question.id} needs real options`);
      }
    },
  ],
  [
    "stores a slug, never the label — a reword must not orphan records",
    () => {
      // The whole reason SurveyOption carries two fields.
      assert.deepStrictEqual(SURVEY_QUESTIONS[0].options[0], {
        value: "chill",
        label: "Chill & low-key",
      });
    },
  ],

  // ── who gets asked ──
  [
    "shows to a new signed-in user with no profile",
    () => {
      assert.strictEqual(shouldShowSurvey(gate()), true);
    },
  ],
  [
    "does NOT show to a guest (anonymous)",
    () => {
      assert.strictEqual(shouldShowSurvey(gate({ isAnonymous: true })), false);
    },
  ],
  [
    "does NOT show when anonymity is unknown",
    () => {
      // AppUser defaults isAnonymous to true when the provider does not say,
      // and the gate fails the same direction: no proven account, no survey.
      assert.strictEqual(shouldShowSurvey(gate({ isAnonymous: null })), false);
    },
  ],
  [
    "does NOT show to a returning user who already has a profile",
    () => {
      assert.strictEqual(shouldShowSurvey(gate({ profile: "present" })), false);
    },
  ],
  [
    "does NOT show while the profile read is still in flight",
    () => {
      // The gap between sign-in and the read landing is exactly how a
      // returning user would get asked a second time.
      assert.strictEqual(shouldShowSurvey(gate({ profile: "unknown" })), false);
    },
  ],
  [
    "does NOT show when the profile read FAILED",
    () => {
      // Fail safe: a survey shown on a failed read is a survey shown to
      // someone who already answered, and the write behind it would overwrite
      // the answers they gave.
      assert.strictEqual(shouldShowSurvey(gate({ profile: "failed" })), false);
    },
  ],
  [
    "does NOT show before auth resolves, or when signed out",
    () => {
      assert.strictEqual(shouldShowSurvey(gate({ authStatus: "loading" })), false);
      assert.strictEqual(shouldShowSurvey(gate({ authStatus: "signed-out" })), false);
    },
  ],
  [
    "does NOT show twice in one session",
    () => {
      assert.strictEqual(shouldShowSurvey(gate({ alreadyShown: true })), false);
    },
  ],
  [
    "a guest is refused even with every other condition met",
    () => {
      // Anonymity outranks a genuinely absent profile: a guest HAS no profile
      // and never will, so "absent" is not evidence they should be asked.
      assert.strictEqual(
        shouldShowSurvey(gate({ isAnonymous: true, profile: "absent" })),
        false
      );
    },
  ],

  // ── whether the ask is still ARMED for whoever is here now ──
  //
  // `alreadyShown` is a PAGE-SESSION fact and the person is not. Everything
  // below is one page load; only the uid moves.
  [
    "re-arms when a DIFFERENT account takes over the session",
    () => {
      assert.strictEqual(shouldRearmSurvey("uid-account-1", "uid-account-2"), true);
    },
  ],
  [
    "does NOT re-arm on the same uid — a token refresh must not re-pop it",
    () => {
      // The observer is `onIdTokenChanged`, so it fires hourly and on every
      // getIdToken() renewal. Same person, same uid, nothing to re-ask.
      assert.strictEqual(shouldRearmSurvey("uid-account-1", "uid-account-1"), false);
    },
  ],
  [
    "does NOT re-arm on the anonymous→account LINK, which keeps the uid",
    () => {
      // `signIn()` upgrades a guest with linkWithPopup precisely because that
      // preserves the uid (the in-progress plan stays theirs). Same identity
      // gaining an account is not a new audience — and it needs no re-arm,
      // because nothing was shown or read for a guest in the first place.
      assert.strictEqual(shouldRearmSurvey("uid-guest", "uid-guest"), false);
    },
  ],
  [
    "does NOT re-arm while there is no current uid",
    () => {
      // The gap between signOut() and the anonymous sign-in that replaces it:
      // the observer delivers null. Nobody to arm for.
      assert.strictEqual(shouldRearmSurvey("uid-account-1", null), false);
      assert.strictEqual(shouldRearmSurvey("uid-account-1", undefined), false);
    },
  ],
  [
    "does NOT re-arm on the FIRST identity of a session",
    () => {
      // Nothing has been shown and nothing has been read yet, so there is
      // nothing to invalidate — the caller is only recording who it is.
      assert.strictEqual(shouldRearmSurvey(null, "uid-guest"), false);
      assert.strictEqual(shouldRearmSurvey(undefined, "uid-guest"), false);
    },
  ],
  [
    "a blank uid is an absence on either side, never an identity",
    () => {
      assert.strictEqual(shouldRearmSurvey("uid-account-1", "   "), false);
      assert.strictEqual(shouldRearmSurvey("  ", "uid-account-2"), false);
      // and surrounding space does not make the same person a new one
      assert.strictEqual(shouldRearmSurvey("uid-account-1", " uid-account-1 "), false);
    },
  ],
  [
    "the ORDINARY account switch: the guest hop between two accounts re-arms",
    () => {
      // The real sequence, and the one the bug rode: signing out mints a
      // BRAND-NEW anonymous uid, so the re-arm lands on that hop — before the
      // second account has even chosen its Google identity. Nothing here needs
      // to know whether a uid belongs to a guest or an account.
      const first = "uid-guest-a"; // guest, then linked to account 1
      const second = "uid-guest-b"; // the guest minted by signing out
      assert.strictEqual(shouldRearmSurvey(first, null), false); // signed out
      assert.strictEqual(shouldRearmSurvey(first, second), true); // new guest
      assert.strictEqual(shouldRearmSurvey(second, second), false); // linked
    },
  ],
  [
    "composes with the gate: the second account of a session IS asked again",
    () => {
      // THE BUG, end to end. Account 1 was offered the survey, so the latch is
      // set; account 2 arrives in the same page session with a profile of its
      // own that says absent.
      const latched = { alreadyShown: true, profile: "absent" as const };
      assert.strictEqual(shouldShowSurvey(gate(latched)), false);
      // The uid moved, so the latch is not account 2's to honour.
      assert.strictEqual(shouldRearmSurvey("uid-account-1", "uid-account-2"), true);
      assert.strictEqual(
        shouldShowSurvey(gate({ ...latched, alreadyShown: false })),
        true
      );
      // …and a re-arm is never a reason on its own: account 2 having already
      // answered still says no, on its OWN profile read.
      assert.strictEqual(
        shouldShowSurvey(gate({ alreadyShown: false, profile: "present" })),
        false
      );
      // …nor does it out-vote the read still being in flight, which is the
      // state a re-arm deliberately returns the gate to.
      assert.strictEqual(
        shouldShowSurvey(gate({ alreadyShown: false, profile: "unknown" })),
        false
      );
    },
  ],

  // ── normalizing an answer set ──
  [
    "keeps known values",
    () => {
      assert.deepStrictEqual(normalizeAnswerSet("style", ["chill", "cozy"]), [
        "chill",
        "cozy",
      ]);
      assert.deepStrictEqual(normalizeAnswerSet("activities", ["music", "art"]), [
        "art",
        "music",
      ]);
    },
  ],
  [
    "returns the question's order, not the click order",
    () => {
      // Two records with the same answers must compare equal.
      assert.deepStrictEqual(normalizeAnswerSet("foods", ["thai", "italian", "korean"]), [
        "italian",
        "korean",
        "thai",
      ]);
    },
  ],
  [
    "drops values the survey never offered",
    () => {
      assert.deepStrictEqual(
        normalizeAnswerSet("style", ["chill", "sports", "<script>"]),
        ["chill"]
      );
    },
  ],
  [
    "de-duplicates",
    () => {
      assert.deepStrictEqual(normalizeAnswerSet("dietary", ["vegan", "vegan"]), ["vegan"]);
    },
  ],
  [
    "tolerates non-strings and non-arrays without throwing",
    () => {
      assert.deepStrictEqual(normalizeAnswerSet("foods", [1, null, {}, "thai"]), ["thai"]);
      for (const junk of ["thai", null, undefined, 7, {}]) {
        assert.deepStrictEqual(normalizeAnswerSet("foods", junk), [], `${JSON.stringify(junk)}`);
      }
    },
  ],
  [
    "keeps 'other' — it is a real option, not a fallback",
    () => {
      assert.deepStrictEqual(normalizeAnswerSet("dietary", ["other"]), ["other"]);
      assert.deepStrictEqual(normalizeAnswerSet("foods", ["other"]), ["other"]);
    },
  ],

  // ── every dimension, always an array ──
  [
    "fills missing dimensions with empty arrays, never undefined",
    () => {
      // Firestore rejects undefined outright; this is where that is prevented.
      const answers = normalizeTasteAnswers({ style: ["cozy"] });
      assert.deepStrictEqual(answers, {
        style: ["cozy"],
        foods: [],
        dietary: [],
        activities: [],
      });
      for (const value of Object.values(answers)) assert.ok(Array.isArray(value));
    },
  ],
  [
    "survives junk input entirely",
    () => {
      for (const junk of [null, undefined, "nope", 5, [], { style: "chill" }]) {
        assert.deepStrictEqual(
          normalizeTasteAnswers(junk),
          EMPTY_ANSWERS,
          `${JSON.stringify(junk)}`
        );
      }
    },
  ],
  [
    "recognises an all-empty answer set",
    () => {
      assert.strictEqual(isEmptyAnswers(EMPTY_ANSWERS), true);
      assert.strictEqual(
        isEmptyAnswers({ style: [], foods: ["thai"], dietary: [], activities: [] }),
        false
      );
      // the new dimension counts too — a survey answered ONLY here is answered
      assert.strictEqual(
        isEmptyAnswers({ style: [], foods: [], dietary: [], activities: ["art"] }),
        false
      );
    },
  ],

  // ── what actually gets filed ──
  [
    "stores the four answer sets, both flags and a timestamp",
    () => {
      const doc = toTasteProfileDocument(
        "uid-1",
        {
          style: ["chill"],
          foods: ["korean", "italian"],
          dietary: ["vegetarian"],
          activities: ["music", "art"],
        },
        { completed: true, updatedAt: AT }
      );
      assert.deepStrictEqual(doc, {
        ownerUid: "uid-1",
        style: ["chill"],
        foods: ["italian", "korean"],
        dietary: ["vegetarian"],
        activities: ["art", "music"],
        surveySeen: true,
        surveyCompleted: true,
        updatedAt: AT,
      });
    },
  ],
  [
    "marks a SKIP as seen but not completed",
    () => {
      // This pair is what stops the survey reappearing after a skip.
      const doc = skipped();
      assert.strictEqual(doc.surveySeen, true);
      assert.strictEqual(doc.surveyCompleted, false);
    },
  ],
  [
    "a submit with nothing ticked is seen AND completed",
    () => {
      const doc = toTasteProfileDocument("uid-1", EMPTY_ANSWERS, {
        completed: true,
        updatedAt: AT,
      });
      assert.strictEqual(doc.surveySeen, true);
      // "submitted nothing" and "skipped" have identical answer sets and are
      // told apart ONLY by this flag.
      assert.strictEqual(doc.surveyCompleted, true);
      assert.deepStrictEqual(doc.style, []);
    },
  ],
  [
    "contains no undefined values anywhere — Firestore rejects them",
    () => {
      const partial = { style: ["chill"] } as unknown as TasteAnswers;
      const doc = toTasteProfileDocument("uid-1", partial, {
        completed: true,
        updatedAt: AT,
      });
      for (const [key, value] of Object.entries(doc)) {
        assert.notStrictEqual(value, undefined, `${key} is undefined`);
      }
      assert.deepStrictEqual(doc.foods, []);
      assert.deepStrictEqual(doc.dietary, []);
      assert.deepStrictEqual(doc.activities, []);
    },
  ],
  [
    "normalizes on the way in, so a stale client cannot store junk",
    () => {
      const doc = toTasteProfileDocument(
        "  uid-1  ",
        { style: ["chill", "not-an-option"], foods: [], dietary: [], activities: [] },
        { completed: true, updatedAt: AT }
      );
      assert.deepStrictEqual(doc.style, ["chill"]);
      assert.strictEqual(doc.ownerUid, "uid-1");
    },
  ],

  // ── reading a stored document back ──
  [
    "round-trips a document this app wrote",
    () => {
      const doc = toTasteProfileDocument(
        "uid-1",
        {
          style: ["lively"],
          foods: ["japanese"],
          dietary: ["halal"],
          activities: ["outdoors"],
        },
        { completed: true, updatedAt: AT }
      );
      assert.deepStrictEqual(parseTasteProfile(doc), {
        style: ["lively"],
        foods: ["japanese"],
        dietary: ["halal"],
        activities: ["outdoors"],
        surveySeen: true,
        surveyCompleted: true,
        updatedAt: AT,
      });
    },
  ],
  [
    "is null for anything that is not an object",
    () => {
      for (const bad of [null, undefined, "preferences", 5, []]) {
        assert.strictEqual(parseTasteProfile(bad), null, `${JSON.stringify(bad)}`);
      }
    },
  ],
  [
    "reads surveySeen strictly, so a malformed doc re-asks rather than hides",
    () => {
      for (const bad of [{ surveySeen: "yes" }, { surveySeen: 1 }, {}]) {
        assert.strictEqual(parseTasteProfile(bad)?.surveySeen, false, `${JSON.stringify(bad)}`);
      }
    },
  ],
  [
    "keeps a record whose answer arrays are broken",
    () => {
      // Keep-on-missing-data: the field the gate needs is the flag.
      const parsed = parseTasteProfile({ surveySeen: true, style: "chill", foods: null });
      assert.notStrictEqual(parsed, null);
      assert.strictEqual(parsed?.surveySeen, true);
      assert.deepStrictEqual(parsed?.style, []);
    },
  ],

  // ── the response → the gate ──
  [
    "present for a real stored profile",
    () => {
      const result = profileGateState({ profile: skipped(), readFailed: false });
      assert.strictEqual(result.state, "present");
      assert.strictEqual(result.profile?.surveyCompleted, false);
    },
  ],
  [
    "absent when the caller has no profile",
    () => {
      assert.strictEqual(
        profileGateState({ profile: null, readFailed: false }).state,
        "absent"
      );
    },
  ],
  [
    "failed when the read broke — never 'absent'",
    () => {
      // The distinction the flag exists for: a failed read must not be
      // mistaken for a new user.
      assert.strictEqual(
        profileGateState({ profile: null, readFailed: true }).state,
        "failed"
      );
      for (const bad of ["garbage", null, undefined, []]) {
        assert.strictEqual(profileGateState(bad).state, "failed", `${JSON.stringify(bad)}`);
      }
    },
  ],
  [
    "treats a document that was never marked seen as absent",
    () => {
      assert.strictEqual(
        profileGateState({ profile: { style: [] }, readFailed: false }).state,
        "absent"
      );
    },
  ],
  [
    "composes with the gate: a fresh account is asked, a returning one is not",
    () => {
      const fresh = profileGateState({ profile: null, readFailed: false }).state;
      const returning = profileGateState({ profile: skipped(), readFailed: false }).state;
      assert.strictEqual(shouldShowSurvey(gate({ profile: fresh })), true);
      assert.strictEqual(shouldShowSurvey(gate({ profile: returning })), false);
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
