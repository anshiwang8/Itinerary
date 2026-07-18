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

const cases: Array<[string, () => Promise<void>]> = [
  [
    "§6.3: a model answer missing `location` still yields a usable parse",
    async () => {
      // valid JSON, wrong shape — the exact case that reached the UI as
      // "`parsed` (the /api/parse output object) is required in the body."
      groqContent = JSON.stringify({ time_window: "7pm", category_signals: ["dinner"] });
      const res = await POST(req("dinner at 7pm"));
      const data = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.location, "", "missing location becomes the documented empty value");
      assert.deepStrictEqual(data.category_signals, ["dinner"]);
      assert.strictEqual(data.time_window, "7pm");
      // every other documented field is present with its empty default
      assert.strictEqual(data.aesthetic, "unspecified");
      assert.strictEqual(data.group_context, "unspecified");
      assert.strictEqual(data.budget, null);
      assert.strictEqual(data.stop_count, null);
      assert.deepStrictEqual(data.constraints, []);
    },
  ],
  [
    "§6.3: junk field types are coerced, never passed through",
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
      assert.strictEqual(data.time_window, "unspecified");
      assert.strictEqual(data.stop_count, null);
      assert.deepStrictEqual(data.category_signals, ["bar", "park"]);
      assert.deepStrictEqual(data.constraints, []);
      assert.strictEqual(data.location, "");
      assert.strictEqual(data.budget, null);
    },
  ],
  [
    "§6.3: unparseable model output surfaces the fail-loud message, not a stack",
    async () => {
      groqContent = "sorry, I can't do that";
      const res = await POST(req("dinner"));
      const data = await res.json();
      assert.strictEqual(res.status, 500);
      // what the user sees is the planGuards message; the technical
      // detail rides alongside for debugging
      assert.strictEqual(data.error, UNPARSEABLE_MESSAGE);
      assert.match(data.detail, /Failed to parse Groq response/);
      assert.strictEqual(data.raw, "sorry, I can't do that");
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
