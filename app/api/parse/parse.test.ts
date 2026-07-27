// /api/parse ROUTE-level behaviour, at the real HTTP boundary: what the
// route does with what the model returns, end to end through the ladder.
// The validator's own rules are exercised exhaustively in planner.test.ts;
// this file pins the wiring — the retry actually reaching the provider, the
// fallback actually being served instead of an error, the floors applying
// to the SHIPPED plan, and the response carrying both the plan and the
// legacy parse the rest of the pipeline consumes.
//
// REWRITTEN 2026-07-27 (planner). The previous suite pinned the extraction
// contract: `groq_invalid_schema` 502s for wrong-shaped output, and
// stop_count expansion. Both are gone by design — a malformed answer is now
// CORRECTED and then FALLEN BACK from rather than 502'd (a raw model error
// must never reach the user), and stop_count no longer exists on the wire
// because the planner emits the activity list directly.
// Run with: npx tsx app/api/parse/parse.test.ts
import assert from "node:assert";
import { POST } from "./route";
import { MAX_ACTIVITY_MINUTES } from "./planner";

process.env.GROQ_API_KEY = "test-key";

/** Queued model replies; the last one repeats if the route asks again. */
let groqReplies: string[] = [];
let groqCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (String(url).includes("api.groq.com")) {
    groqCalls.push(String(init?.body ?? ""));
    const content = groqReplies.length > 1 ? groqReplies.shift()! : groqReplies[0] ?? "";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return realFetch(url as never, init);
}) as typeof fetch;

const NOW_ISO = "2026-07-27T15:00:00-04:00";

const req = (prompt: string, extra: Record<string, unknown> = {}) =>
  new Request("http://localhost/api/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      timeZone: "America/Toronto",
      nowISO: NOW_ISO,
      ...extra,
    }),
  }) as never;

/** A valid planner response; each case perturbs one thing. */
const plan = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    activities: [
      {
        slot: 0,
        intent: "dinner",
        searchQuery: "restaurant",
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
      aesthetic: "unspecified",
      groupContext: "unspecified",
      budget: null,
      constraints: [],
      location: "",
    },
    ...overrides,
  });

function reset(...replies: string[]) {
  groqReplies = replies;
  groqCalls = [];
}

const cases: Array<[string, () => Promise<void>]> = [
  [
    "a good answer is served as {plan, parsed}, in ONE model call",
    async () => {
      reset(plan());
      const res = await POST(req("dinner at 7pm"));
      const data = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(groqCalls.length, 1);
      assert.strictEqual(data.plan.activities[0].searchQuery, "restaurant");
      // the legacy currency the rest of the pipeline speaks
      assert.deepStrictEqual(data.parsed.category_signals, ["restaurant"]);
      assert.strictEqual(data.parsed.stop_count, null);
      assert.strictEqual(data.parsed.time_window, "7pm");
    },
  ],
  [
    "the model is TOLD the current instant, its weekday, and the plan's zone",
    async () => {
      reset(plan());
      await POST(req("dinner tonight"));
      const sent = groqCalls[0];
      assert.ok(/Monday/.test(sent), "weekday must be sent");
      assert.ok(/2026-07-27/.test(sent), "local date must be sent");
      assert.ok(/America\/Toronto/.test(sent), "the plan zone must be sent");
    },
  ],
  [
    "a malformed answer is CORRECTED, not 502'd, and the retry names the problems",
    async () => {
      reset(JSON.stringify({ activities: [] }), plan());
      const res = await POST(req("dinner at 7pm"));
      const data = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(groqCalls.length, 2, "exactly one correction retry");
      assert.ok(/was invalid/.test(groqCalls[1]), "the retry must carry a correction");
      assert.ok(/non-empty array/.test(groqCalls[1]), "the retry must name the problem");
      assert.deepStrictEqual(data.parsed.category_signals, ["restaurant"]);
    },
  ],
  [
    "output that is not JSON at all still ends in a WORKING plan, never an error",
    async () => {
      reset("sorry, I can't do that");
      const res = await POST(req("something to do"));
      const data = await res.json();
      assert.strictEqual(res.status, 200, "a raw model error must never reach the user");
      assert.strictEqual(groqCalls.length, 2, "one retry, then the fallback");
      // the deterministic fallback: one general activity + the broad questions
      assert.deepStrictEqual(data.parsed.category_signals, ["things to do"]);
      assert.deepStrictEqual(
        data.plan.questions.map((q: { id: string }) => q.id),
        ["kind", "when"]
      );
      assert.ok(data.plan.timeIntent.startISO, "the fallback still anchors a start");
      // and no raw model text leaks
      assert.ok(!("raw" in data) && !("detail" in data));
    },
  ],
  [
    "a hallucinated duration is CLAMPED before it can reach the scheduler",
    async () => {
      reset(
        plan({
          activities: [
            {
              slot: 0,
              intent: "coffee",
              searchQuery: "coffee shop",
              estimatedMinutes: 480,
              confident: true,
            },
          ],
        })
      );
      const res = await POST(req("coffee"));
      const data = await res.json();
      assert.strictEqual(data.plan.activities[0].estimatedMinutes, MAX_ACTIVITY_MINUTES);
    },
  ],
  [
    "IMMEDIATE FLOOR: 'right now' overrides whatever the model resolved",
    async () => {
      // the live repro shape: the model loses the immediacy and answers a
      // day-part (or tomorrow), which used to roll a late-night plan a day
      for (const prompt of [
        "restaurants to eat at right now",
        "food asap im starving",
        "somewhere to eat immediately",
        "whats open now",
      ]) {
        reset(
          plan({
            timeIntent: {
              startISO: "2026-07-28T19:00:00-04:00",
              endISO: null,
              kind: "explicit",
              label: "tomorrow 7pm",
            },
          })
        );
        const res = await POST(req(prompt));
        const data = await res.json();
        assert.strictEqual(data.plan.timeIntent.label, "now", `floor missed: "${prompt}"`);
        // 15:00 → the next full hour, today
        assert.strictEqual(
          new Date(data.plan.timeIntent.startISO).toISOString(),
          new Date("2026-07-27T16:00:00-04:00").toISOString(),
          `floor resolved wrong: "${prompt}"`
        );
      }
      // and it NEVER fires without an immediacy phrase
      reset(plan());
      const untouched = await POST(req("dinner at 7pm"));
      assert.strictEqual((await untouched.json()).plan.timeIntent.label, "7pm");
    },
  ],
  [
    "ALL-DAY FLOOR: anchors a missing start at 11:00, and invents no end",
    async () => {
      reset(
        plan({
          timeIntent: { startISO: null, endISO: null, kind: "unspecified", label: "unspecified" },
          activities: [
            {
              slot: 0,
              intent: "sushi",
              searchQuery: "sushi",
              estimatedMinutes: 90,
              confident: true,
            },
          ],
        })
      );
      const res = await POST(req("immerse myself in japanese culture for a day"));
      const data = await res.json();
      assert.ok(data.plan.timeIntent.startISO);
      assert.strictEqual(
        new Date(data.plan.timeIntent.startISO).toISOString(),
        new Date("2026-07-28T11:00:00-04:00").toISOString()
      );
      // an END is a stated fact or nothing — the floor must not fabricate one
      assert.strictEqual(data.plan.timeIntent.endISO, null);

      // a start the model DID resolve is never overridden
      reset(plan());
      const kept = await POST(req("a full day out, starting at 7pm"));
      assert.strictEqual((await kept.json()).plan.timeIntent.label, "7pm");

      // and it NEVER fires without all-day language — "day trip ideas some
      // other day" has bare "day"s only
      reset(plan());
      const bare = await POST(req("day trip ideas some other day"));
      assert.strictEqual((await bare.json()).plan.timeIntent.label, "7pm");
    },
  ],
  [
    "an UNSPECIFIED time always ships a when-question, even if the model forgot",
    async () => {
      reset(
        plan({
          timeIntent: { startISO: null, endISO: null, kind: "unspecified", label: "unspecified" },
          questions: [],
        })
      );
      const res = await POST(req("dinner somewhere"));
      const data = await res.json();
      const when = data.plan.questions.find((q: { id: string }) => q.id === "when");
      assert.ok(when, "code must guarantee the when-question");
    },
  ],
  [
    "ANSWERS drive a second pass that is told to stop asking",
    async () => {
      reset(plan());
      await POST(
        req("something to do", {
          answers: [{ question: "What kind of thing?", answer: "bowling" }],
        })
      );
      const sent = groqCalls[0];
      assert.ok(/bowling/.test(sent), "the answer must reach the model");
      assert.ok(/EMPTY/.test(sent), "the second pass must forbid re-asking");
    },
  ],
  [
    "the request boundary still rejects junk before any provider work",
    async () => {
      const bad = new Request("http://localhost/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "dinner", timeZone: "Mars/Olympus" }),
      }) as never;
      reset(plan());
      const res = await POST(bad);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(groqCalls.length, 0, "no provider call for an invalid request");
    },
  ],
];

(async () => {
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
})();
