// The PLANNER VALIDATOR — the layer standing between a hallucinated plan
// and the user, so it gets the heaviest coverage in this change. Everything
// here is pure: no Groq, no network. The ladder is exercised through an
// injected completion, the same seam the e2e fixture uses.
// Run with: npx tsx app/api/parse/planner.test.ts
import assert from "node:assert";
import {
  MAX_ACTIVITIES,
  MAX_ACTIVITY_MINUTES,
  MAX_PLAN_HORIZON_DAYS,
  MAX_QUESTIONS,
  MIN_ACTIVITY_MINUTES,
  applyTimeFloors,
  buildPlannerMessages,
  describeNow,
  fallbackPlan,
  findPlanProblems,
  planStartInstant,
  planToParsed,
  planWithModel,
  validatePlan,
  whenQuestion,
} from "./planner";
import { DEFAULT_ZONE, wallClockParts } from "../../lib/zoneTime";

const NOW = new Date("2026-07-27T15:00:00-04:00"); // Monday, 3 PM Toronto
const ZONE = DEFAULT_ZONE;

/** A minimal VALID planner response; each test perturbs one thing. */
function goodPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activities: [
      {
        slot: 0,
        intent: "a sit-down dinner",
        searchQuery: "italian restaurant",
        estimatedMinutes: 90,
        confident: true,
      },
    ],
    timeIntent: {
      startISO: "2026-07-27T19:00:00-04:00",
      endISO: null,
      kind: "explicit",
      label: "7pm",
    },
    questions: [],
    context: {
      aesthetic: "cozy",
      groupContext: "date",
      budget: null,
      constraints: [],
      location: "",
    },
    ...overrides,
  };
}

const activity = (over: Record<string, unknown> = {}) => ({
  slot: 0,
  intent: "something",
  searchQuery: "restaurant",
  estimatedMinutes: 60,
  confident: true,
  ...over,
});

/** Assert that a perturbed plan produces at least one problem mentioning `needle`. */
function expectProblem(raw: Record<string, unknown>, needle: RegExp, label: string): void {
  const problems = findPlanProblems(raw, NOW);
  assert.ok(problems.length > 0, `${label}: expected a problem, got none`);
  assert.ok(
    problems.some((p) => needle.test(p)),
    `${label}: expected a problem matching ${needle}, got: ${problems.join(" | ")}`
  );
}

const cases: Array<[string, () => void]> = [
  // ── the happy path ──
  [
    "a well-formed plan validates and survives coercion unchanged",
    () => {
      const result = validatePlan(goodPlan(), NOW);
      assert.ok(result.ok);
      if (!result.ok) return;
      assert.strictEqual(result.plan.activities.length, 1);
      assert.strictEqual(result.plan.activities[0].searchQuery, "italian restaurant");
      assert.strictEqual(result.plan.activities[0].estimatedMinutes, 90);
      assert.strictEqual(result.plan.timeIntent.kind, "explicit");
      assert.deepStrictEqual(result.plan.questions, []);
    },
  ],

  // ── clamping (the "hallucinated 8-hour coffee" rule) ──
  [
    "estimatedMinutes is CLAMPED, not rejected: 480 → 360, 2 → 15",
    () => {
      const long = validatePlan(
        goodPlan({ activities: [activity({ estimatedMinutes: 480 })] }),
        NOW
      );
      assert.ok(long.ok);
      if (!long.ok) return;
      assert.strictEqual(long.plan.activities[0].estimatedMinutes, MAX_ACTIVITY_MINUTES);

      const short = validatePlan(
        goodPlan({ activities: [activity({ estimatedMinutes: 2 })] }),
        NOW
      );
      assert.ok(short.ok);
      if (!short.ok) return;
      assert.strictEqual(short.plan.activities[0].estimatedMinutes, MIN_ACTIVITY_MINUTES);

      // fractional estimates round rather than reaching the scheduler raw
      const fractional = validatePlan(
        goodPlan({ activities: [activity({ estimatedMinutes: 47.6 })] }),
        NOW
      );
      assert.ok(fractional.ok);
      if (!fractional.ok) return;
      assert.strictEqual(fractional.plan.activities[0].estimatedMinutes, 48);
    },
  ],
  [
    "a NON-NUMERIC estimate is a real problem — there is nothing to clamp",
    () => {
      expectProblem(
        goodPlan({ activities: [activity({ estimatedMinutes: "about an hour" })] }),
        /estimatedMinutes/,
        "string duration"
      );
      expectProblem(
        goodPlan({ activities: [activity({ estimatedMinutes: Number.NaN })] }),
        /estimatedMinutes/,
        "NaN duration"
      );
    },
  ],

  // ── malformed shapes ──
  [
    "malformed output is rejected: non-object, missing/empty/oversized activities",
    () => {
      assert.deepStrictEqual(findPlanProblems(null, NOW), ["the response is not a JSON object"]);
      assert.deepStrictEqual(findPlanProblems("{}", NOW), ["the response is not a JSON object"]);
      assert.deepStrictEqual(findPlanProblems([], NOW), ["the response is not a JSON object"]);
      expectProblem(goodPlan({ activities: [] }), /non-empty array/, "empty activities");
      expectProblem(goodPlan({ activities: "nope" }), /non-empty array/, "activities not an array");
      expectProblem(
        goodPlan({
          activities: Array.from({ length: MAX_ACTIVITIES + 1 }, (_, i) => activity({ slot: i })),
        }),
        /at most 8/,
        "too many activities"
      );
    },
  ],
  [
    "an activity missing its searchQuery cannot reach the search step",
    () => {
      expectProblem(
        goodPlan({ activities: [activity({ searchQuery: "" })] }),
        /searchQuery/,
        "blank searchQuery"
      );
      expectProblem(
        goodPlan({ activities: [activity({ searchQuery: undefined })] }),
        /searchQuery/,
        "absent searchQuery"
      );
      expectProblem(
        goodPlan({ activities: [activity({ searchQuery: "x".repeat(300) })] }),
        /searchQuery/,
        "oversized searchQuery"
      );
    },
  ],
  [
    "slots must be unique integers in range",
    () => {
      expectProblem(
        goodPlan({ activities: [activity({ slot: 0 }), activity({ slot: 0 })] }),
        /used twice/,
        "duplicate slot"
      );
      expectProblem(goodPlan({ activities: [activity({ slot: -1 })] }), /slot/, "negative slot");
      expectProblem(goodPlan({ activities: [activity({ slot: 1.5 })] }), /slot/, "fractional slot");
    },
  ],
  [
    "sparse slots are renumbered dense from 0, and questions follow them",
    () => {
      const result = validatePlan(
        goodPlan({
          activities: [
            activity({ slot: 5, searchQuery: "bar", confident: false }),
            activity({ slot: 2, searchQuery: "ramen" }),
          ],
          questions: [
            { id: "bar-type", question: "What kind of bar?", options: ["dive"], appliesToSlot: 5 },
          ],
        }),
        NOW
      );
      assert.ok(result.ok);
      if (!result.ok) return;
      // ordered by the model's slot, then renumbered
      assert.deepStrictEqual(
        result.plan.activities.map((a) => [a.slot, a.searchQuery]),
        [
          [0, "ramen"],
          [1, "bar"],
        ]
      );
      // the question's target was remapped with them, not left dangling
      assert.strictEqual(result.plan.questions[0].appliesToSlot, 1);
    },
  ],

  // ── time intent ──
  [
    "startISO/endISO must be real instants with a date AND a time",
    () => {
      expectProblem(
        goodPlan({ timeIntent: { startISO: "2026-07-27", endISO: null, kind: "explicit", label: "x" } }),
        /startISO/,
        "bare date (would silently read as UTC midnight)"
      );
      expectProblem(
        goodPlan({ timeIntent: { startISO: "tonight", endISO: null, kind: "relative", label: "x" } }),
        /startISO/,
        "prose instead of an instant"
      );
      expectProblem(
        goodPlan({
          timeIntent: {
            startISO: "2026-13-45T99:00:00-04:00",
            endISO: null,
            kind: "explicit",
            label: "x",
          },
        }),
        /startISO/,
        "impossible calendar values"
      );
    },
  ],
  [
    "end must be after start, and an end without a start is rejected",
    () => {
      expectProblem(
        goodPlan({
          timeIntent: {
            startISO: "2026-07-27T20:00:00-04:00",
            endISO: "2026-07-27T18:00:00-04:00",
            kind: "explicit",
            label: "x",
          },
        }),
        /must be after/,
        "end before start"
      );
      expectProblem(
        goodPlan({
          timeIntent: {
            startISO: "2026-07-27T20:00:00-04:00",
            endISO: "2026-07-27T20:00:00-04:00",
            kind: "explicit",
            label: "x",
          },
        }),
        /must be after/,
        "zero-length window"
      );
      expectProblem(
        goodPlan({
          timeIntent: {
            startISO: null,
            endISO: "2026-07-27T20:00:00-04:00",
            kind: "explicit",
            label: "x",
          },
        }),
        /without a `startISO`/,
        "end with no start"
      );
    },
  ],
  [
    "an absurd horizon is rejected in BOTH directions",
    () => {
      const farFuture = new Date(NOW.getTime() + (MAX_PLAN_HORIZON_DAYS + 2) * 86_400_000);
      expectProblem(
        goodPlan({
          timeIntent: {
            startISO: farFuture.toISOString(),
            endISO: null,
            kind: "explicit",
            label: "x",
          },
        }),
        /more than 14 days/,
        "three weeks out"
      );
      // a plan anchored yesterday is a mis-resolved date, not a rounding
      const yesterday = new Date(NOW.getTime() - 26 * 3_600_000);
      expectProblem(
        goodPlan({
          timeIntent: {
            startISO: yesterday.toISOString(),
            endISO: null,
            kind: "explicit",
            label: "x",
          },
        }),
        /in the past/,
        "yesterday"
      );
      // …but ordinary rounding slack is fine ("tonight" resolved 20 min back)
      const justBehind = new Date(NOW.getTime() - 20 * 60_000);
      assert.deepStrictEqual(
        findPlanProblems(
          goodPlan({
            timeIntent: {
              startISO: justBehind.toISOString(),
              endISO: null,
              kind: "relative",
              label: "now",
            },
          }),
          NOW
        ),
        []
      );
    },
  ],
  [
    "an unusual-but-possible hour is NOT refused — hours are decided on real data",
    () => {
      // 3 AM brunch used to be refused by a hardcoded plausibility band.
      // The planner is allowed to propose it; the hours filter decides.
      const threeAM = goodPlan({
        activities: [activity({ searchQuery: "brunch" })],
        timeIntent: {
          startISO: "2026-07-28T03:00:00-04:00",
          endISO: null,
          kind: "explicit",
          label: "3am",
        },
      });
      assert.deepStrictEqual(findPlanProblems(threeAM, NOW), []);
    },
  ],

  // ── the vagueness contract ──
  [
    "a confident:false activity with NO question is a problem",
    () => {
      expectProblem(
        goodPlan({ activities: [activity({ confident: false })], questions: [] }),
        /no question attached/,
        "unanswered vague activity"
      );
    },
  ],
  [
    "ONE question covers every vague slot sharing its searchQuery",
    () => {
      const raw = goodPlan({
        activities: [
          activity({ slot: 0, searchQuery: "things to do", confident: false }),
          activity({ slot: 1, searchQuery: "things to do", confident: false }),
          activity({ slot: 2, searchQuery: "things to do", confident: false }),
        ],
        questions: [
          { id: "kind", question: "What kind of thing?", options: ["food"], appliesToSlot: 0 },
        ],
        timeIntent: {
          startISO: "2026-07-27T19:00:00-04:00",
          endISO: null,
          kind: "explicit",
          label: "7pm",
        },
      });
      assert.deepStrictEqual(findPlanProblems(raw, NOW), []);

      // a DIFFERENT searchQuery is not covered by that answer
      const mixed = goodPlan({
        activities: [
          activity({ slot: 0, searchQuery: "things to do", confident: false }),
          activity({ slot: 1, searchQuery: "restaurant", confident: false }),
        ],
        questions: [
          { id: "kind", question: "What kind of thing?", options: ["food"], appliesToSlot: 0 },
        ],
      });
      expectProblem(mixed, /no question attached/, "uncovered second query");
    },
  ],
  [
    "a question pointing at a slot that does not exist is a problem",
    () => {
      expectProblem(
        goodPlan({
          questions: [{ id: "x", question: "Which?", options: ["a"], appliesToSlot: 7 }],
        }),
        /appliesToSlot/,
        "dangling appliesToSlot"
      );
    },
  ],
  [
    "question options must be a bounded list of non-empty strings",
    () => {
      expectProblem(
        goodPlan({ questions: [{ id: "x", question: "Which?", options: "a", appliesToSlot: null }] }),
        /options/,
        "options not an array"
      );
      expectProblem(
        goodPlan({
          questions: [
            { id: "x", question: "Which?", options: Array(20).fill("a"), appliesToSlot: null },
          ],
        }),
        /options/,
        "too many options"
      );
      expectProblem(
        goodPlan({ questions: [{ id: "x", question: "", options: ["a"], appliesToSlot: null }] }),
        /question/,
        "blank question text"
      );
    },
  ],

  // ── code-owned guarantees ──
  [
    "an UNSPECIFIED time always gets a when-question, even if the model forgot",
    () => {
      const result = validatePlan(
        goodPlan({
          activities: [activity()],
          timeIntent: { startISO: null, endISO: null, kind: "unspecified", label: "unspecified" },
          questions: [],
        }),
        NOW
      );
      assert.ok(result.ok);
      if (!result.ok) return;
      const when = result.plan.questions.find((q) => q.id === "when");
      assert.ok(when, "code must inject the when-question");
      assert.deepStrictEqual(when!.options, [
        "now",
        "this afternoon",
        "this evening",
        "pick a time",
      ]);
    },
  ],
  [
    "questions are capped at 3: vague-attached first, then when, then filler",
    () => {
      const result = validatePlan(
        goodPlan({
          activities: [
            activity({ slot: 0, searchQuery: "restaurant", confident: false }),
            activity({ slot: 1, searchQuery: "bar", confident: false }),
          ],
          timeIntent: { startISO: null, endISO: null, kind: "unspecified", label: "unspecified" },
          questions: [
            { id: "vibe", question: "What vibe?", options: ["cozy"], appliesToSlot: null },
            { id: "who", question: "Who's coming?", options: ["solo"], appliesToSlot: null },
            { id: "when", question: "When?", options: ["now"], appliesToSlot: null },
            { id: "food", question: "Craving?", options: ["Italian"], appliesToSlot: 0 },
            { id: "bar", question: "What bar?", options: ["dive"], appliesToSlot: 1 },
          ],
        }),
        NOW
      );
      assert.ok(result.ok);
      if (!result.ok) return;
      assert.strictEqual(result.plan.questions.length, MAX_QUESTIONS);
      assert.deepStrictEqual(
        result.plan.questions.map((q) => q.id),
        ["food", "bar", "when"]
      );
    },
  ],
  [
    "duplicate question ids are made unique (they key the UI's answer state)",
    () => {
      const result = validatePlan(
        goodPlan({
          questions: [
            { id: "same", question: "A?", options: ["x"], appliesToSlot: null },
            { id: "same", question: "B?", options: ["y"], appliesToSlot: null },
          ],
        }),
        NOW
      );
      assert.ok(result.ok);
      if (!result.ok) return;
      const ids = result.plan.questions.map((q) => q.id);
      assert.strictEqual(new Set(ids).size, ids.length, `ids collided: ${ids.join(",")}`);
    },
  ],

  // ── the ladder: retry then fallback ──
  [
    "a valid first answer is used as-is (no retry)",
    async () => {
      let calls = 0;
      const outcome = await planWithModel([], NOW, "dinner", ZONE, async () => {
        calls++;
        return JSON.stringify(goodPlan());
      });
      assert.strictEqual(calls, 1);
      assert.strictEqual(outcome.source, "model");
      assert.deepStrictEqual(outcome.problems, []);
    },
  ],
  [
    "an invalid answer gets ONE correction retry, and a good retry is used",
    async () => {
      const replies = [JSON.stringify({ activities: [] }), JSON.stringify(goodPlan())];
      const seen: unknown[][] = [];
      const outcome = await planWithModel([{ role: "system", content: "s" }], NOW, "dinner", ZONE, async (messages) => {
        seen.push(messages);
        return replies.shift()!;
      });
      assert.strictEqual(outcome.source, "retry");
      assert.strictEqual(seen.length, 2);
      // the retry must actually SPELL OUT the problems, like selectVenues'
      const correction = JSON.stringify(seen[1]);
      assert.ok(/was invalid/.test(correction), "retry must carry the correction");
      assert.ok(/non-empty array/.test(correction), "retry must name the problem");
      assert.ok(outcome.problems.length > 0);
    },
  ],
  [
    "a retry that is STILL invalid falls back deterministically — never an error",
    async () => {
      let calls = 0;
      const outcome = await planWithModel([], NOW, "surprise me", ZONE, async () => {
        calls++;
        return "not json at all";
      });
      assert.strictEqual(calls, 2, "exactly one retry, then stop");
      assert.strictEqual(outcome.source, "fallback");
      // the fallback is a WORKING plan: one general activity, plus the two
      // broad questions, anchored at the next full hour
      assert.strictEqual(outcome.plan.activities.length, 1);
      assert.strictEqual(outcome.plan.activities[0].searchQuery, "things to do");
      assert.strictEqual(outcome.plan.activities[0].confident, false);
      assert.deepStrictEqual(
        outcome.plan.questions.map((q) => q.id),
        ["kind", "when"]
      );
      assert.ok(outcome.plan.timeIntent.startISO);
      assert.strictEqual(wallClockParts(new Date(outcome.plan.timeIntent.startISO!), ZONE).minute, 0);
    },
  ],
  [
    "the fallback itself is a VALID plan (it must survive its own validator)",
    () => {
      const plan = fallbackPlan("something", NOW, ZONE);
      assert.deepStrictEqual(
        findPlanProblems(JSON.parse(JSON.stringify(plan)), NOW),
        []
      );
    },
  ],

  // ── the deterministic floors ──
  [
    "the IMMEDIACY floor overrides whatever the model returned",
    () => {
      // live repro shape: the model dropped the immediacy and rolled to tomorrow
      const dropped = fallbackPlan("x", NOW, ZONE);
      dropped.timeIntent = {
        startISO: "2026-07-28T19:00:00-04:00",
        endISO: null,
        kind: "explicit",
        label: "tomorrow 7pm",
      };
      const floored = applyTimeFloors(dropped, "restaurants to eat at right now", NOW, ZONE);
      assert.strictEqual(floored.timeIntent.label, "now");
      assert.strictEqual(floored.timeIntent.kind, "relative");
      const start = new Date(floored.timeIntent.startISO!);
      assert.strictEqual(wallClockParts(start, ZONE).hour, 16); // NOW is 15:00 → next full hour
      assert.strictEqual(wallClockParts(start, ZONE).minute, 0);
      // and an immediate plan never asks "when?" — they just said
      assert.ok(!floored.questions.some((q) => q.id === "when"));
    },
  ],
  [
    "the ALL-DAY floor anchors a missing start, and invents no end",
    () => {
      const plan = fallbackPlan("x", NOW, ZONE);
      plan.timeIntent = { startISO: null, endISO: null, kind: "unspecified", label: "unspecified" };
      const floored = applyTimeFloors(plan, "plan me a full day tomorrow", NOW, ZONE);
      assert.ok(floored.timeIntent.startISO);
      assert.strictEqual(wallClockParts(new Date(floored.timeIntent.startISO!), ZONE).hour, 11);
      // an end time is a stated fact or nothing — the floor must not fabricate one
      assert.strictEqual(floored.timeIntent.endISO, null);
    },
  ],
  [
    "the all-day floor NEVER overrides a start the model did resolve",
    () => {
      const plan = fallbackPlan("x", NOW, ZONE);
      plan.timeIntent = {
        startISO: "2026-07-28T09:00:00-04:00",
        endISO: null,
        kind: "explicit",
        label: "9am tomorrow",
      };
      const floored = applyTimeFloors(plan, "a full day tomorrow starting at 9am", NOW, ZONE);
      assert.strictEqual(floored.timeIntent.startISO, "2026-07-28T09:00:00-04:00");
    },
  ],
  [
    "a prompt with no floor signal passes through untouched",
    () => {
      const result = validatePlan(goodPlan(), NOW);
      assert.ok(result.ok);
      if (!result.ok) return;
      assert.deepStrictEqual(applyTimeFloors(result.plan, "dinner at 7pm", NOW, ZONE), result.plan);
    },
  ],

  // ── the adapter + anchor ──
  [
    "planToParsed maps the plan onto the pipeline's currency",
    () => {
      const result = validatePlan(
        goodPlan({
          activities: [
            activity({ slot: 0, searchQuery: "ramen" }),
            activity({ slot: 1, searchQuery: "cocktail bar" }),
          ],
          context: {
            aesthetic: "cozy",
            groupContext: "date",
            budget: "cheap",
            constraints: ["patio"],
            location: "west end",
          },
        }),
        NOW
      );
      assert.ok(result.ok);
      if (!result.ok) return;
      const parsed = planToParsed(result.plan);
      assert.deepStrictEqual(parsed.category_signals, ["ramen", "cocktail bar"]);
      assert.strictEqual(parsed.aesthetic, "cozy");
      assert.strictEqual(parsed.group_context, "date");
      assert.strictEqual(parsed.budget, "cheap");
      assert.deepStrictEqual(parsed.constraints, ["patio"]);
      assert.strictEqual(parsed.location, "west end");
      // stop_count is gone from the contract: the activity list IS the count
      assert.strictEqual(parsed.stop_count, null);
      // time_window is PROSE now — the resolved instant travels separately
      assert.strictEqual(parsed.time_window, "7pm");
    },
  ],
  [
    "planStartInstant falls back to the next full hour when no time was given",
    () => {
      const plan = fallbackPlan("x", NOW, ZONE);
      plan.timeIntent.startISO = null;
      const start = planStartInstant(plan, NOW, ZONE);
      assert.strictEqual(wallClockParts(start, ZONE).hour, 16);
      assert.strictEqual(wallClockParts(start, ZONE).minute, 0);

      plan.timeIntent.startISO = "2026-07-27T19:30:00-04:00";
      assert.strictEqual(
        planStartInstant(plan, NOW, ZONE).toISOString(),
        new Date("2026-07-27T19:30:00-04:00").toISOString()
      );
    },
  ],

  // ── the injected "now" (the key enabler) ──
  [
    "the model is actually TOLD the current instant, weekday and zone",
    () => {
      const now = describeNow(NOW, ZONE);
      assert.strictEqual(now.weekday, "Monday");
      assert.strictEqual(now.localDate, "2026-07-27");
      assert.strictEqual(now.localTime, "15:00");
      assert.strictEqual(now.timeZone, ZONE);

      // the same instant in another zone reports THAT zone's wall clock
      const vancouver = describeNow(NOW, "America/Vancouver");
      assert.strictEqual(vancouver.localTime, "12:00");

      const messages = buildPlannerMessages("dinner tonight", NOW, ZONE, { city: "Toronto" });
      const payload = JSON.stringify(messages);
      assert.ok(/Monday/.test(payload), "the weekday must reach the model");
      assert.ok(/2026-07-27/.test(payload), "the date must reach the model");
      assert.ok(/dinner tonight/.test(payload), "the request must reach the model");
    },
  ],
  [
    "answered questions produce a SECOND pass that is told to stop asking",
    () => {
      const messages = buildPlannerMessages("something to do", NOW, ZONE, {
        answers: [{ question: "What kind of thing?", answer: "bowling" }],
      });
      const payload = JSON.stringify(messages);
      // JSON.stringify escapes the inner quotes, so match the escaped form
      assert.ok(
        /EMPTY \\"questions\\" array/.test(payload),
        "the second pass must forbid re-asking"
      );
      assert.ok(/bowling/.test(payload), "the answer must reach the model");
    },
  ],
  [
    "whenQuestion is the one code-owned question shape",
    () => {
      const q = whenQuestion();
      assert.strictEqual(q.id, "when");
      assert.strictEqual(q.appliesToSlot, null);
      assert.strictEqual(q.options.length, 4);
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
