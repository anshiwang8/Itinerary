// GET /api/history — the promise that it never fails because of who is asking.
//
// A guest, a visitor whose token cannot be checked, and a deployment with no
// Firebase all get the same answer: 200 and an empty list. That is not a
// nicety. Mock e2e runs with no Firebase at all, so a 401 or a 500 on this
// path would break a suite that has nothing to do with history — and a signed-
// out visitor opening the screen is a completely ordinary thing to do.
//
// NOT TESTED HERE, and deliberately: Firestore reads and token verification.
// Both are live-only, and per this project's own lesson a mocked auth test
// proves the mock was called, not that verification works. The trust boundary
// itself — that only `caller.uid` is ever read back — is held by construction:
// the route has exactly one call to `readHistoryForOwner`, and it passes the
// verified caller. There is no uid parameter to reach for.
import assert from "node:assert";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { resetRateLimitsForTests } from "../_shared/http";

// The unconfigured condition, made explicit rather than inherited from
// whatever happens to be in the environment. `firebaseAdmin` reads these
// lazily, so clearing them here is enough for every case below.
for (const key of [
  "FIREBASE_ADMIN_PROJECT_ID",
  "FIREBASE_ADMIN_CLIENT_EMAIL",
  "FIREBASE_ADMIN_PRIVATE_KEY",
]) {
  delete process.env[key];
}

interface HistoryBody {
  plans: unknown[];
  readFailed: boolean;
}

async function get(headers: Record<string, string> = {}): Promise<{
  status: number;
  body: HistoryBody;
}> {
  resetRateLimitsForTests();
  const response = await GET(new NextRequest("http://localhost/api/history", { headers }));
  return { status: response.status, body: (await response.json()) as HistoryBody };
}

const cases: Array<[string, () => Promise<void>]> = [
  [
    "a visitor with no token gets an empty history, not a 401",
    async () => {
      const { status, body } = await get();
      assert.strictEqual(status, 200, "an unauthenticated read is not an error");
      assert.deepStrictEqual(body, { plans: [], readFailed: false });
    },
  ],
  [
    "an empty list is reported as empty, NOT as a failed read",
    async () => {
      // The difference the flag exists for. Nothing was ever archived for a
      // caller with no identity, so "you have none" is the true answer — and
      // the screen should say so plainly rather than apologise for an error
      // that did not happen.
      const { body } = await get();
      assert.strictEqual(body.readFailed, false);
    },
  ],
  [
    "a token that cannot be verified is treated as no token, still 200",
    async () => {
      // With FIREBASE_ADMIN_* unset there is no way to check this token, so
      // the caller is unauthenticated. What must NOT happen is trusting it,
      // and what must not happen either is failing the request over it.
      const { status, body } = await get({ Authorization: "Bearer not-a-real-token" });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body, { plans: [], readFailed: false });
    },
  ],
  [
    "a malformed Authorization header is simply no identity",
    async () => {
      for (const header of ["", "Bearer", "Bearer   ", "Basic abc123", "token abc"]) {
        const { status, body } = await get({ Authorization: header });
        assert.strictEqual(status, 200, `header ${JSON.stringify(header)}`);
        assert.deepStrictEqual(body.plans, [], `header ${JSON.stringify(header)}`);
      }
    },
  ],
  [
    "the response says nothing about who asked",
    async () => {
      // History is scoped to the caller, so the payload never needs to name
      // one — and a uid echoed back is a uid that can be logged, screenshotted
      // or pasted somewhere it should not be.
      const { body } = await get({ Authorization: "Bearer not-a-real-token" });
      const keys = Object.keys(body).sort();
      assert.deepStrictEqual(keys, ["plans", "readFailed"]);
    },
  ],
  [
    "the shared error contract is still wired — the rate limiter can refuse",
    async () => {
      resetRateLimitsForTests();
      // Deliberately a fixed count rather than "until it stops returning 200":
      // this case must fail when the LIMITER breaks, not merely when the
      // response above it changes shape.
      const request = () => GET(new NextRequest("http://localhost/api/history"));
      let last = await request();
      for (let i = 0; i < 121; i += 1) last = await request();
      assert.strictEqual(last.status, 429, "a read this cheap is still bounded");
      const body = (await last.json()) as { code: string };
      assert.strictEqual(body.code, "rate_limited");
      assert.ok(last.headers.get("retry-after"), "a refusal says when to come back");
      resetRateLimitsForTests();
    },
  ],
];

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error instanceof Error ? error.stack ?? error.message : error}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
})();
