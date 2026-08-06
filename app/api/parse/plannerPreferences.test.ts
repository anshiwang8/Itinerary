// Stage 3B — the one decision the stage makes in code: what a stored profile
// turns into before the planner is told about it.
//
// WHAT IS DELIBERATELY NOT TESTED HERE: whether a personalized plan is any
// GOOD. That is prompt behaviour against a live model, and this project has
// been burned by exactly that kind of test — a mock that agrees with the
// fixture proves the fixture, not the prompt. The plan CONTENT is an eyeball
// job. What a test can honestly pin is the projection: which preferences are
// sent, which are dropped, and — the one that matters most — that a caller
// with no usable profile produces no injection at all, because that path is
// every guest, every mock e2e run, and everyone who skipped the survey.
// Run with: npx tsx app/api/parse/plannerPreferences.test.ts
import assert from "node:assert";
import {
  NON_PLANNING_OPTIONS,
  PLANNER_PHRASES,
  toPlannerPreferences,
  type PlannerPreferences,
} from "./plannerPreferences";
import { buildPlannerMessages } from "./planner";
import { SURVEY_QUESTIONS, type TasteProfilePayload } from "../../lib/tastePreferences";
import { contradictionReason } from "../../lib/planGuards";
import type { ParsedPrompt } from "../places/search/filter";
import { DEFAULT_ZONE } from "../../lib/zoneTime";

const NOW = new Date("2026-08-06T15:00:00-04:00");

/** A full, usable profile. Every test changes exactly one thing about it, so
 *  what a given "nothing was injected" is caused by is never in doubt. */
function profile(over: Partial<TasteProfilePayload> = {}): TasteProfilePayload {
  return {
    style: ["cozy"],
    foods: ["japanese", "italian"],
    dietary: ["vegetarian"],
    surveySeen: true,
    surveyCompleted: true,
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...over,
  };
}

/** The un-personalized parse, for the contradiction guard: the guard reads the
 *  prompt AND the parse, and what we are checking is that a preference alone
 *  can never supply the second half of a contradiction. */
function parsedWith(over: Partial<ParsedPrompt> = {}): ParsedPrompt {
  return {
    time_window: "unspecified",
    stop_count: null,
    aesthetic: "unspecified",
    category_signals: ["restaurant"],
    group_context: "unspecified",
    budget: null,
    constraints: [],
    location: "",
    ...over,
  };
}

/** The JSON payload describing THIS request — the last message the builder
 *  emits. Read as an object rather than grepped, because the system prompt
 *  discusses preferences on every request and would match a text search. */
function userPayload(messages: unknown[]): Record<string, unknown> {
  const last = messages[messages.length - 1] as { role: string; content: string };
  assert.strictEqual(last.role, "user");
  return JSON.parse(last.content) as Record<string, unknown>;
}

const cases: Array<[string, () => void]> = [
  // ── the closed set stays closed ──
  [
    "every survey option is either given a planner phrase or explicitly dropped",
    () => {
      for (const question of SURVEY_QUESTIONS) {
        const phrases = PLANNER_PHRASES[question.id];
        const dropped = NON_PLANNING_OPTIONS[question.id];
        for (const option of question.options) {
          const known =
            Object.prototype.hasOwnProperty.call(phrases, option.value) ||
            dropped.includes(option.value);
          assert.ok(
            known,
            `option "${option.value}" (${question.id}) has no planner phrase and is not listed as non-planning — adding a survey option must force a decision about what it MEANS to a plan`
          );
        }
      }
    },
  ],
  [
    "no planner phrase carries punctuation — `aesthetic` goes into the Places query verbatim",
    () => {
      for (const question of SURVEY_QUESTIONS) {
        for (const phrase of Object.values(PLANNER_PHRASES[question.id])) {
          assert.ok(
            /^[A-Za-z][A-Za-z -]*$/.test(phrase),
            `"${phrase}" is not query-safe: buildQuery prepends the aesthetic straight into the Places text search`
          );
        }
      }
    },
  ],
  [
    "a phrase is never a survey LABEL — rewording a button must not change planning",
    () => {
      // Not an equality check between two copies (that would just pin today's
      // wording); the point is that the tables are independent, and the button
      // copy is full of the punctuation the check above forbids.
      const labels = SURVEY_QUESTIONS.flatMap((q) => q.options.map((o) => o.label));
      assert.ok(
        labels.some((label) => /[(&]/.test(label)),
        "the survey labels are UI copy with punctuation; if that ever stops being true this test has lost its point"
      );
    },
  ],

  // ── the null path: every "plan exactly as before" case ──
  [
    "NO PROFILE injects nothing — the guest / no-Firebase / mock-e2e path",
    () => {
      assert.strictEqual(toPlannerPreferences(null, "dinner tonight"), null);
    },
  ],
  [
    "a SKIPPED survey injects nothing",
    () => {
      const skipped = profile({
        style: [],
        foods: [],
        dietary: [],
        surveyCompleted: false,
      });
      assert.strictEqual(toPlannerPreferences(skipped, "dinner tonight"), null);
    },
  ],
  [
    "a submission of nothing but non-planning options injects nothing",
    () => {
      // "No restrictions" and "Other" are real answers that say nothing a plan
      // can act on. `dietary: ["none"]` in particular must never reach a model,
      // which would read it as the presence of a restriction called "none".
      const empty = profile({ style: [], foods: ["other"], dietary: ["none", "other"] });
      assert.strictEqual(toPlannerPreferences(empty, "dinner tonight"), null);
    },
  ],
  [
    "unknown slugs are dropped, and a profile of ONLY unknown slugs injects nothing",
    () => {
      const stale = profile({ style: ["retired-option"], foods: [], dietary: [] });
      assert.strictEqual(toPlannerPreferences(stale, "dinner"), null);

      const mixed = toPlannerPreferences(
        profile({ style: ["retired-option", "cozy"], foods: [], dietary: [] }),
        "dinner"
      );
      assert.deepStrictEqual(mixed, { style: ["cozy"] });
    },
  ],
  [
    "an empty dimension is OMITTED, not sent as an empty list",
    () => {
      const injected = toPlannerPreferences(
        profile({ style: [], foods: ["korean"], dietary: [] }),
        "dinner"
      );
      assert.deepStrictEqual(injected, { foods: ["Korean"] });
      assert.deepStrictEqual(Object.keys(injected as PlannerPreferences), ["foods"]);
    },
  ],

  // ── the ordinary path ──
  [
    "a full profile is projected to phrases, in the survey's order",
    () => {
      assert.deepStrictEqual(toPlannerPreferences(profile(), "dinner tonight"), {
        style: ["cozy"],
        foods: ["Japanese", "Italian"],
        dietary: ["vegetarian"],
      });
    },
  ],
  [
    "`surveyCompleted` is not consulted — an answered profile is an answered profile",
    () => {
      const submitted = toPlannerPreferences(profile({ surveyCompleted: true }), "dinner");
      const dismissed = toPlannerPreferences(profile({ surveyCompleted: false }), "dinner");
      assert.deepStrictEqual(submitted, dismissed);
    },
  ],

  // ── dietary suppression: the fail-loud trap this stage must not set ──
  [
    "a stored diet the REQUEST contradicts is never injected (vegetarian + steakhouse)",
    () => {
      const injected = toPlannerPreferences(profile(), "the best steakhouse in town");
      assert.ok(injected, "the rest of the profile still applies");
      assert.strictEqual(
        injected?.dietary,
        undefined,
        "a stored vegetarian must not reach the planner alongside an explicit steakhouse"
      );
      // and the aspects the request left open are untouched
      assert.deepStrictEqual(injected?.style, ["cozy"]);
    },
  ],
  [
    "ONLY the conflicting diet is dropped — the rest of the profile survives",
    () => {
      const injected = toPlannerPreferences(
        profile({ dietary: ["vegan", "gluten-free"] }),
        "a proper steakhouse"
      );
      assert.deepStrictEqual(injected?.dietary, ["gluten-free"]);
    },
  ],
  [
    "suppression is per PAIR, not blanket — halal survives a steakhouse, pork does not",
    () => {
      // the contradiction table's own distinction: halal steak exists, halal
      // pork does not. Reused rather than re-encoded, so the two can't drift.
      const steak = toPlannerPreferences(profile({ dietary: ["halal"] }), "a steakhouse");
      assert.deepStrictEqual(steak?.dietary, ["halal"]);

      const pork = toPlannerPreferences(profile({ dietary: ["halal"] }), "a bacon-heavy brunch");
      assert.strictEqual(pork?.dietary, undefined);
    },
  ],
  [
    "an unrelated request keeps the diet — suppression is not the default",
    () => {
      const injected = toPlannerPreferences(profile(), "somewhere for dinner");
      assert.deepStrictEqual(injected?.dietary, ["vegetarian"]);
    },
  ],
  [
    "NO injected preference can supply half of a contradiction on its own",
    () => {
      // The guard reads the prompt plus the parse. A stored style landing in
      // `aesthetic` must never turn an ordinary "cheap dinner" into "cheap and
      // fancy pull opposite ways" — a fail-loud the user did not ask for.
      for (const phrase of Object.values(PLANNER_PHRASES.style)) {
        assert.strictEqual(
          contradictionReason("a cheap dinner", parsedWith({ aesthetic: phrase })),
          null,
          `style phrase "${phrase}" trips the contradiction guard against a budget prompt`
        );
      }
      for (const phrase of Object.values(PLANNER_PHRASES.dietary)) {
        assert.strictEqual(
          contradictionReason("somewhere for dinner", parsedWith({ constraints: [phrase] })),
          null,
          `dietary phrase "${phrase}" trips the contradiction guard against a neutral prompt`
        );
      }
    },
  ],

  // ── what actually reaches the model ──
  [
    "the preferences reach the model, and are ABSENT when there are none",
    () => {
      const withPrefs = userPayload(
        buildPlannerMessages("dinner tonight", NOW, DEFAULT_ZONE, {
          city: "Toronto",
          preferences: toPlannerPreferences(profile(), "dinner tonight"),
        })
      );
      assert.deepStrictEqual(withPrefs.preferences, {
        style: ["cozy"],
        foods: ["Japanese", "Italian"],
        dietary: ["vegetarian"],
      });

      const without = userPayload(
        buildPlannerMessages("dinner tonight", NOW, DEFAULT_ZONE, {
          city: "Toronto",
          preferences: null,
        })
      );
      // The KEY, not the word: the system prompt talks about preferences in
      // every request, which is fine — what must not appear is a preferences
      // object, or an empty one, in the payload describing THIS request.
      assert.ok(
        !("preferences" in without),
        "no profile must leave NO trace in the payload — not an empty object, not a key"
      );
      assert.deepStrictEqual(Object.keys(without), ["now", "request", "city"]);
    },
  ],
  [
    "no-preferences is byte-identical to not passing the option at all",
    () => {
      // The claim the whole stage rests on: the un-personalized request is not
      // a variant of the personalized one, it is the request as it was before
      // 3B existed. If these ever diverge, mock e2e is planning something new.
      const asBefore = JSON.stringify(
        buildPlannerMessages("dinner and drinks", NOW, DEFAULT_ZONE, { city: "Toronto" })
      );
      for (const preferences of [null, undefined] as const) {
        assert.strictEqual(
          JSON.stringify(
            buildPlannerMessages("dinner and drinks", NOW, DEFAULT_ZONE, {
              city: "Toronto",
              preferences,
            })
          ),
          asBefore
        );
      }
      assert.strictEqual(
        JSON.stringify(
          buildPlannerMessages("dinner and drinks", NOW, DEFAULT_ZONE, {
            city: "Toronto",
            preferences: toPlannerPreferences(null, "dinner and drinks"),
          })
        ),
        asBefore,
        "a guest's projected profile must produce the pre-3B payload exactly"
      );
    },
  ],
  [
    "the planner is TOLD how to weigh preferences — the rules are in the prompt, not implied",
    () => {
      const payload = JSON.stringify(
        buildPlannerMessages("dinner", NOW, DEFAULT_ZONE, {
          preferences: { foods: ["Japanese"] },
        })
      );
      // Not pinning the wording (this is the tuning surface and it will move),
      // only that the section exists at all: preferences arriving with no rule
      // for reading them is the one failure this cheap check can catch.
      assert.ok(/TASTE PREFERENCES/.test(payload), "the preference rules must be in the prompt");
      assert.ok(/VARIETY/.test(payload), "the variety rules must be in the prompt");
    },
  ],
];

async function run() {
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

void run();
