// Guards the mock-PLANNER contracts that mirror the REAL planner prompt's
// rules (the real model's behavior is prompt-level and live-verified; this
// pins the deterministic mock mirror so e2e scenarios exercising these
// categories stay honest). Every fixture response below is also run through
// the PRODUCTION validator, because that is exactly what the parse route
// does with it — a fixture the validator would reject is a broken seam.
// Run with: npx tsx app/api/_mock/fixtures.test.ts
import assert from "node:assert";
import { resolveGeocodeResponse } from "../geocode/geocode";
import { mockGeocodingResponse, mockPlan } from "./fixtures";
import { type PlanIntent, planToParsed, validatePlan } from "../parse/planner";
import type { ParsedPrompt } from "../places/search/filter";
import { DEFAULT_ZONE, wallClockParts } from "../../lib/zoneTime";

const NOW = new Date("2026-07-27T15:00:00-04:00");

/** Fixture response → production validator → the legacy parse shape, i.e.
 *  precisely the path /api/parse takes in mock mode. */
function planned(
  prompt: string,
  answers: Array<{ question: string; answer: string }> = []
): { parsed: ParsedPrompt; plan: PlanIntent } {
  const raw = mockPlan(prompt, NOW, DEFAULT_ZONE, answers);
  const result = validatePlan(raw, NOW);
  if (!result.ok) {
    throw new Error(
      `mock planner output failed validation for "${prompt}": ${result.problems.join("; ")}`
    );
  }
  return { parsed: planToParsed(result.plan), plan: result.plan };
}

const cases: Array<[string, () => void]> = [
  [
    "passive outdoor phrasing normalizes to 'park' (bench/scenery/etc.)",
    () => {
      for (const p of [
        "sit on a bench and enjoy quiet scenery",
        "somewhere with greenery and fresh air",
        "somewhere calm outside to enjoy nature",
      ]) {
        assert.deepStrictEqual(planned(p).parsed.category_signals, ["park"], `"${p}"`);
      }
    },
  ],
  [
    "active outdoor phrasing keeps 'park walk' (weather-gate fixture path)",
    () => {
      assert.deepStrictEqual(planned("a walk in the park at 3pm").parsed.category_signals, [
        "park walk",
      ]);
    },
  ],
  [
    "mock geocoding swaps provider data while the real validator resolves it",
    () => {
      const cityRequest = { query: "Vancouver", kind: "city" } as const;
      const city = resolveGeocodeResponse(
        mockGeocodingResponse(cityRequest),
        cityRequest
      );
      assert.strictEqual(city.outcome, "resolved");
      if (city.outcome !== "resolved") return;
      assert.deepStrictEqual(city.location, {
        latitude: 43.6547,
        longitude: -79.3862,
      });
      assert.strictEqual(city.label, "Vancouver (fixture)");

      const addressRequest = {
        query: "800 Robson St",
        kind: "address",
        cityContext: city,
      } as const;
      const address = resolveGeocodeResponse(
        mockGeocodingResponse(addressRequest),
        addressRequest
      );
      assert.strictEqual(address.outcome, "resolved");
      if (address.outcome !== "resolved") return;
      assert.deepStrictEqual(address.location, city.location);
    },
  ],
  [
    "food prompts are untouched by the park rule",
    () => {
      assert.deepStrictEqual(planned("dinner and drinks").parsed.category_signals, [
        "dinner",
        "drinks",
      ]);
    },
  ],
  [
    "a venue FEATURE is a constraint, never its own category (mirrors the prompt rule)",
    () => {
      // "dessert with a patio" is ONE dessert stop with a patio requirement
      const p = planned("dessert with a patio").parsed;
      assert.deepStrictEqual(p.category_signals, ["dessert"]);
      assert.deepStrictEqual(p.constraints, ["patio"]);
      // dietary words behave the same way (the rule this generalizes)
      const v = planned("vegan dinner").parsed;
      assert.deepStrictEqual(v.category_signals, ["dinner"]);
      assert.deepStrictEqual(v.constraints, ["vegan"]);
      const vegetarian = planned("vegetarian dinner").parsed;
      assert.deepStrictEqual(vegetarian.category_signals, ["dinner"]);
      assert.deepStrictEqual(vegetarian.constraints, ["vegetarian"]);
      // genuinely distinct activities still get their own entries
      assert.deepStrictEqual(planned("dinner then a bar").parsed.category_signals, [
        "dinner",
        "drinks",
      ]);
    },
  ],
  [
    "a stated COUNT becomes exactly that many activities, and budget text survives",
    () => {
      // stop_count is gone from the wire: the activity LIST is the answer
      const dated = planned("three coffee shops at 7pm under $20");
      assert.strictEqual(dated.parsed.stop_count, null);
      assert.deepStrictEqual(dated.parsed.category_signals, ["coffee", "coffee", "coffee"]);
      assert.strictEqual(dated.parsed.budget, "under $20");
      // the planner resolves the clock itself now — 7pm means 19:00 local
      const start = dated.plan.timeIntent.startISO;
      assert.ok(start, "an explicit clock time must resolve to an instant");
      assert.strictEqual(dated.plan.timeIntent.kind, "explicit");
      assert.strictEqual(wallClockParts(new Date(start!), DEFAULT_ZONE).hour, 19);
    },
  ],
  [
    "a stated WINDOW resolves both ends; the trailing meridiem governs both",
    () => {
      const { plan } = planned("make me a schedule from 3-8 tomorrow including a food option");
      const { startISO, endISO } = plan.timeIntent;
      assert.ok(startISO && endISO, "a stated range must resolve start AND end");
      assert.strictEqual(wallClockParts(new Date(startISO!), DEFAULT_ZONE).hour, 15);
      assert.strictEqual(wallClockParts(new Date(endISO!), DEFAULT_ZONE).hour, 20);
      assert.ok(new Date(endISO!) > new Date(startISO!));
    },
  ],
  [
    "a stated WINDOW stays coherent at EVERY hour of the day (rolls as a unit)",
    () => {
      // Regression: the two ends used to roll to tomorrow independently, so
      // at 5:30 PM "5-9pm" resolved to start=tomorrow 17:00 / end=today
      // 21:00 — inverted, validator-rejected, silently downgraded to the
      // fallback plan. Every other test here pins NOW at 15:00, so only the
      // e2e suite saw it, and only after 5 PM. Sweep the clock instead.
      for (let hour = 0; hour < 24; hour++) {
        const now = new Date(`2026-07-27T${String(hour).padStart(2, "0")}:30:00-04:00`);
        const raw = mockPlan("dinner and drinks from 5-9pm", now, DEFAULT_ZONE);
        const result = validatePlan(raw, now);
        assert.ok(result.ok, `rejected at ${hour}:30 — ${result.ok ? "" : result.problems.join("; ")}`);
        const { startISO, endISO } = result.plan.timeIntent;
        assert.ok(startISO && endISO, `both ends must resolve at ${hour}:30`);
        assert.ok(
          new Date(endISO!) > new Date(startISO!),
          `window inverted at ${hour}:30 (${startISO} → ${endISO})`
        );
        // the stated END is always kept exactly as asked
        assert.strictEqual(wallClockParts(new Date(endISO!), DEFAULT_ZONE).hour, 21, `${hour}:30`);
        // the start is the stated 5 PM, EXCEPT while the window is already
        // underway (18:30/19:30/20:30), where code cannot plan into the past
        // and the repair moves it up to now
        const startHour = wallClockParts(new Date(startISO!), DEFAULT_ZONE).hour;
        const underway = hour >= 17 && hour < 21;
        assert.strictEqual(startHour, underway ? hour : 17, `start at ${hour}:30`);
        assert.ok(
          new Date(startISO!).getTime() >= now.getTime() - 60 * 60_000,
          `start must never be planned into the past at ${hour}:30`
        );
      }
    },
  ],
  [
    "a window already UNDERWAY stays today; one already OVER rolls to tomorrow",
    () => {
      // 5:30 PM, asked for 5-9pm: underway, not tomorrow's problem.
      const underway = new Date("2026-07-27T17:30:00-04:00");
      const now1 = validatePlan(mockPlan("dinner from 5-9pm", underway, DEFAULT_ZONE), underway);
      assert.ok(now1.ok);
      assert.strictEqual(
        wallClockParts(new Date(now1.plan.timeIntent.startISO!), DEFAULT_ZONE).day,
        wallClockParts(underway, DEFAULT_ZONE).day,
        "a window already underway must stay TODAY"
      );
      // 11:30 PM, asked for 5-9pm: that window is gone; it means tomorrow's.
      const over = new Date("2026-07-27T23:30:00-04:00");
      const now2 = validatePlan(mockPlan("dinner from 5-9pm", over, DEFAULT_ZONE), over);
      assert.ok(now2.ok);
      assert.notStrictEqual(
        wallClockParts(new Date(now2.plan.timeIntent.startISO!), DEFAULT_ZONE).day,
        wallClockParts(over, DEFAULT_ZONE).day,
        "a window whose end has passed must roll to TOMORROW"
      );
    },
  ],
  [
    "a vague prompt asks, and one answer resolves every slot sharing its query",
    () => {
      const vague = planned("not sure what to do");
      assert.deepStrictEqual(vague.parsed.category_signals, ["things to do"]);
      assert.strictEqual(vague.plan.activities[0].confident, false);
      const asked = vague.plan.questions.map((q) => q.question);
      assert.ok(asked.includes("What kind of thing?"));
      assert.ok(asked.includes("When?"));

      // the SECOND pass folds the answers in and stops asking
      const answered = planned("not sure what to do", [
        { question: "What kind of thing?", answer: "drinks" },
        { question: "When?", answer: "this evening" },
      ]);
      assert.deepStrictEqual(answered.parsed.category_signals, ["bar"]);
      assert.deepStrictEqual(answered.plan.questions, []);
      assert.strictEqual(answered.plan.activities[0].confident, true);
    },
  ],
  [
    "an already-specific request is planned straight through, with no questions",
    () => {
      const sushi = planned("sushi tonight");
      assert.deepStrictEqual(sushi.parsed.category_signals, ["sushi"]);
      assert.deepStrictEqual(sushi.plan.questions, []);
      assert.strictEqual(sushi.plan.timeIntent.kind, "relative");
    },
  ],
  [
    "the malformed-output trigger really is rejected by the production validator",
    () => {
      const raw = mockPlan("fixture-badplan tonight", NOW, DEFAULT_ZONE);
      const result = validatePlan(raw, NOW);
      assert.strictEqual(result.ok, false);
    },
  ],
];

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
