// /api/parse output normalization. The model returns JSON, but not
// necessarily the RIGHT JSON — and a shape miss used to travel two routes
// downstream before being rejected by a body-shape check whose
// developer-facing message went straight to the user
// (code-audit 2026-07-18 §6.3).
// Run with: npx tsx app/api/parse/parse.test.ts
import assert from "node:assert";
import { POST } from "./route";
import { UNPARSEABLE_MESSAGE } from "../../lib/planGuards";

process.env.GROQ_API_KEY = "test-key";

let groqContent = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (String(url).includes("api.groq.com")) {
    return new Response(JSON.stringify({ choices: [{ message: { content: groqContent } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return realFetch(url as never, init);
}) as typeof fetch;

const req = (prompt: string) =>
  new Request("http://localhost/api/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  }) as never;

const model = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    time_window: "unspecified",
    stop_count: null,
    aesthetic: "unspecified",
    category_signals: [],
    group_context: "unspecified",
    budget: null,
    constraints: [],
    location: "",
    ...overrides,
  });

const cases: Array<[string, () => Promise<void>]> = [
  [
    "missing required parse fields are rejected as an invalid provider schema",
    async () => {
      // valid JSON, wrong shape — the exact case that reached the UI as
      // "`parsed` (the /api/parse output object) is required in the body."
      groqContent = JSON.stringify({ time_window: "7pm", category_signals: ["dinner"] });
      const res = await POST(req("dinner at 7pm"));
      const data = await res.json();
      assert.strictEqual(res.status, 502);
      assert.strictEqual(data.code, "groq_invalid_schema");
      assert.ok(!("raw" in data));
    },
  ],
  [
    "junk field types are rejected rather than normalized into trusted facts",
    async () => {
      groqContent = JSON.stringify({
        time_window: 7, // wrong type
        stop_count: "two", // wrong type
        category_signals: ["bar", 42, "", "park"], // mixed junk
        constraints: "vegan", // not an array
        location: null,
        budget: "",
      });
      const res = await POST(req("whatever"));
      const data = await res.json();
      assert.strictEqual(res.status, 502);
      assert.strictEqual(data.code, "groq_invalid_schema");
      assert.ok(!("raw" in data));
    },
  ],
  [
    "unparseable model output is actionable but never exposes raw model text",
    async () => {
      groqContent = "sorry, I can't do that";
      const res = await POST(req("dinner"));
      const data = await res.json();
      assert.strictEqual(res.status, 502);
      assert.strictEqual(data.error, UNPARSEABLE_MESSAGE);
      assert.strictEqual(data.code, "groq_invalid_json");
      assert.strictEqual(typeof data.requestId, "string");
      assert.ok(!("detail" in data));
      assert.ok(!("raw" in data));
    },
  ],
  [
    "IMMEDIATE FLOOR: 'right now' stamps time_window to 'now' even when the model lost it",
    async () => {
      // the live repro: the model returned "unspecified" for a prompt that
      // said "right now" — the deterministic floor must not care what the
      // model returned (here it answers a day-part, the worst case: that
      // resolves to 20:00 and rolls a late-night plan to TOMORROW)
      groqContent = model({
        time_window: "tonight",
        category_signals: ["restaurant"],
      });
      const res = await POST(req("restaurants to eat at right now"));
      const data = await res.json();
      assert.strictEqual(data.time_window, "now");
      // variants
      for (const prompt of ["food asap im starving", "somewhere to eat immediately", "whats open now"]) {
        groqContent = model({ time_window: "unspecified", category_signals: ["restaurant"] });
        const r = await POST(req(prompt));
        assert.strictEqual((await r.json()).time_window, "now", `floor missed: "${prompt}"`);
      }
      // and it NEVER fires without an immediacy phrase — a stated clock
      // time passes through untouched
      groqContent = model({ time_window: "7pm", category_signals: ["restaurant"] });
      const r2 = await POST(req("dinner at 7pm"));
      assert.strictEqual((await r2.json()).time_window, "7pm");
    },
  ],
  [
    "ALL-DAY FLOOR: full-day language survives the model, and APPENDS rather than replaces",
    async () => {
      // the live probe: "…japanese culture for a day" came back
      // "unspecified" — the floor must stamp "all day" regardless
      groqContent = model({ time_window: "unspecified", category_signals: ["sushi"] });
      const res = await POST(req("immerse myself in japanese culture for a day"));
      assert.strictEqual((await res.json()).time_window, "all day");
      // a captured day qualifier SURVIVES: append, never replace
      groqContent = model({ time_window: "tomorrow", category_signals: ["soccer"] });
      const r2 = await POST(req("plan a full schedule for things to do as a soccer fan tomorrow"));
      assert.strictEqual((await r2.json()).time_window, "tomorrow, all day");
      // already captured by the model → untouched, no double-append
      groqContent = model({ time_window: "tomorrow, all day", category_signals: ["soccer"] });
      const r3 = await POST(req("a full day as a soccer fan tomorrow"));
      assert.strictEqual((await r3.json()).time_window, "tomorrow, all day");
      // immediacy outranks all-day when both appear: "now" replaces wholesale
      groqContent = model({ time_window: "unspecified", category_signals: ["restaurant"] });
      const r4 = await POST(req("everything open right now for a full day out"));
      assert.strictEqual((await r4.json()).time_window, "now");
      // and it NEVER fires without all-day language — "day trip ideas
      // some other day" has bare "day"s only
      groqContent = model({ time_window: "unspecified", category_signals: ["hike"] });
      const r5 = await POST(req("day trip ideas some other day"));
      assert.strictEqual((await r5.json()).time_window, "unspecified");
    },
  ],
  [
    "a well-formed answer passes through unchanged",
    async () => {
      const good = {
        time_window: "evening",
        stop_count: 2,
        aesthetic: "cozy",
        category_signals: ["dinner", "bar"],
        group_context: "date",
        budget: "cheap",
        constraints: ["vegan"],
        location: "west end",
      };
      groqContent = JSON.stringify(good);
      const res = await POST(req("cheap vegan dinner then a bar in the west end"));
      assert.deepStrictEqual(await res.json(), good);
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
