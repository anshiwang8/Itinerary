// Tests for /api/select validation: invalid id → correction retry →
// highest-rated fallback. Groq is stubbed via globalThis.fetch so the
// invalid-id path is deterministic.
// Run with: npx tsx app/api/select/select.test.ts
import assert from "node:assert";
import { POST } from "./route";
import { Place } from "../places/search/filter";

process.env.GROQ_API_KEY = "test-key";

// ── Groq stub ──
interface GroqCall {
  messages: { role: string; content: string }[];
}
let groqCalls: GroqCall[] = [];
// decides what content the fake Groq returns on the Nth call (1-based)
let responder: (callNumber: number) => string = () => "";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (String(url).includes("api.groq.com")) {
    const body = JSON.parse(String(init?.body));
    groqCalls.push({ messages: body.messages });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: responder(groqCalls.length) } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  return realFetch(url as never, init);
}) as typeof fetch;

// ── fixtures ──
function mkPlace(id: string, rating: number): Place {
  return {
    id,
    displayName: { text: `Venue ${id}` },
    rating,
    location: { latitude: 43.65, longitude: -79.42 },
  };
}

const parsed = {
  time_window: "evening",
  stop_count: null,
  aesthetic: "cozy",
  category_signals: ["cafe"],
  group_context: "date",
  budget: null,
  constraints: [],
  location: "Ossington",
};

// pool: "b" is highest-rated → expected fallback winner
const pools = { cafe: [mkPlace("a", 4.2), mkPlace("b", 4.8)] };

function req(body: unknown) {
  return new Request("http://localhost/api/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // route handlers accept the web Request shape
  }) as never;
}

const ghost = (category = "cafe") =>
  JSON.stringify({
    selections: [{ category, id: "ghost-id-999", reason: "sounds nice" }],
  });
const valid = (id: string) =>
  JSON.stringify({
    selections: [{ category: "cafe", id, reason: "Cozy corner spot." }],
  });

// ── cases ──
const cases: Array<[string, () => Promise<void>]> = [
  [
    "invalid id twice → retry fires, then fallback:true with highest-rated venue",
    async () => {
      groqCalls = [];
      responder = () => ghost(); // invalid on attempt 1 AND attempt 2
      const res = await POST(req({ parsed, pools }));
      const data = await res.json();

      // retry fired: exactly 2 Groq calls
      assert.strictEqual(groqCalls.length, 2, "expected exactly 2 Groq calls");
      // 2nd call got the appended correction conversation
      const retryMsgs = groqCalls[1].messages;
      assert.strictEqual(retryMsgs.length, 4, "retry should carry 4 messages");
      assert.strictEqual(retryMsgs[2].role, "assistant");
      assert.strictEqual(retryMsgs[3].role, "user");
      assert.match(retryMsgs[3].content, /invalid/);
      assert.match(retryMsgs[3].content, /ghost-id-999.*not in the "cafe" pool/);

      // fallback fired: highest-rated venue, flagged
      assert.strictEqual(res.status, 200);
      const sel = data.selections[0];
      assert.strictEqual(sel.fallback, true);
      assert.strictEqual(sel.id, "b");
      assert.strictEqual(sel.name, "Venue b");
      assert.strictEqual(sel.rating, 4.8);
      console.log("      result:", JSON.stringify(data));
    },
  ],
  [
    "invalid id then valid on retry → corrected pick, NO fallback flag",
    async () => {
      groqCalls = [];
      responder = (n) => (n === 1 ? ghost() : valid("a"));
      const res = await POST(req({ parsed, pools }));
      const data = await res.json();
      assert.strictEqual(groqCalls.length, 2);
      const sel = data.selections[0];
      assert.strictEqual(sel.id, "a");
      assert.strictEqual(sel.fallback, undefined);
      assert.strictEqual(sel.reason, "Cozy corner spot.");
      console.log("      result:", JSON.stringify(data));
    },
  ],
  [
    "valid id first try → single Groq call, no retry, no fallback",
    async () => {
      groqCalls = [];
      responder = () => valid("a");
      const res = await POST(req({ parsed, pools }));
      const data = await res.json();
      assert.strictEqual(groqCalls.length, 1);
      assert.strictEqual(data.selections[0].id, "a");
      assert.strictEqual(data.selections[0].fallback, undefined);
    },
  ],
  [
    "unmet hard constraint → id:null + unmetConstraint, NO retry, NO fallback",
    async () => {
      groqCalls = [];
      responder = () =>
        JSON.stringify({
          selections: [
            { category: "cafe", id: null, reason: "", unmet_constraint: "vegan" },
          ],
        });
      const res = await POST(
        req({ parsed: { ...parsed, constraints: ["vegan"] }, pools })
      );
      const data = await res.json();
      // an honest null is a VALID answer — no correction retry, no
      // highest-rated fallback papering over the constraint
      assert.strictEqual(groqCalls.length, 1, "honest null must not trigger a retry");
      const sel = data.selections[0];
      assert.strictEqual(sel.id, null);
      assert.strictEqual(sel.unmetConstraint, "vegan");
      assert.strictEqual(sel.fallback, undefined);
      console.log("      result:", JSON.stringify(data));
    },
  ],
  [
    "hedged pick under constraints ('worth confirming') → converted to unmet constraint",
    async () => {
      groqCalls = [];
      responder = () =>
        JSON.stringify({
          selections: [
            {
              category: "cafe",
              id: "a",
              reason: "Great spot, though the vegan options are worth confirming with them.",
            },
          ],
        });
      const res = await POST(
        req({ parsed: { ...parsed, constraints: ["vegan"] }, pools })
      );
      const data = await res.json();
      const sel = data.selections[0];
      // never suggest a venue while telling the user to verify it
      assert.strictEqual(sel.id, null);
      assert.strictEqual(sel.unmetConstraint, "vegan");
      console.log("      result:", JSON.stringify(data));
    },
  ],
  [
    "hedge guard is OFF without constraints — cautious phrasing keeps the pick",
    async () => {
      groqCalls = [];
      responder = () =>
        JSON.stringify({
          selections: [
            { category: "cafe", id: "a", reason: "Cozy — maybe check with friends first." },
          ],
        });
      const res = await POST(req({ parsed, pools }));
      const data = await res.json();
      assert.strictEqual(data.selections[0].id, "a");
      assert.strictEqual(data.selections[0].unmetConstraint, undefined);
    },
  ],
  [
    "parsed.home → each candidate carries a CODE-computed kmFromHome; absent without it",
    async () => {
      // with the anchor: the payload the model judges must carry distances
      groqCalls = [];
      responder = () => valid("a");
      const home = { latitude: 43.6547, longitude: -79.3862 };
      await POST(req({ parsed: { ...parsed, home }, pools }));
      const payload = JSON.parse(groqCalls[0].messages[1].content);
      const cands = payload.candidates.cafe as Array<{ id: string; kmFromHome?: number }>;
      for (const c of cands) {
        assert.strictEqual(typeof c.kmFromHome, "number", `candidate ${c.id} missing kmFromHome`);
        assert.ok(c.kmFromHome! > 0 && c.kmFromHome! < 10, `implausible kmFromHome ${c.kmFromHome}`);
      }
      // and the system prompt actually states the distance rule
      assert.match(groqCalls[0].messages[0].content, /kmFromHome/);

      // without the anchor (legacy plans): no invented distances
      groqCalls = [];
      await POST(req({ parsed, pools }));
      const payload2 = JSON.parse(groqCalls[0].messages[1].content);
      for (const c of payload2.candidates.cafe as Array<{ kmFromHome?: number }>) {
        assert.strictEqual(c.kmFromHome, undefined);
      }
    },
  ],
];

// ── runner ──
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
