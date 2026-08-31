// Real read/end/resume handlers, status derivation, ownership decisions,
// archive projection and store/CAS. Only Firebase Admin and Redis transport
// are substituted; this proves orchestration, NOT token verification or
// live Firestore/Redis service behavior.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import {
  activeItineraryIdForOwner,
  createItinerary,
  loadItinerary,
  saveItinerary,
  setActiveItineraryForOwner,
  updateItinerary,
  type Itinerary,
} from "./store";
import type { ArchivedPlan } from "./ownership";
import { resetRateLimitsForTests } from "../_shared/http";

const nodeRequire = createRequire(import.meta.url);
const adminPath = nodeRequire.resolve("../../lib/firebaseAdmin");
const originalAdmin = nodeRequire.cache[adminPath];
const archiveWrites: ArchivedPlan[] = [];
let failArchive = false;
nodeRequire.cache[adminPath] = {
  id: adminPath,
  filename: adminPath,
  loaded: true,
  exports: {
    isAdminConfigured: () => true,
    verifyIdToken: async (token: string) =>
      token === "owner-token" ? { uid: "owner", isAnonymous: false } : null,
    getAdminFirestore: () => ({
      collection: (name: string) => {
        assert.equal(name, "users");
        return { doc: (uid: string) => ({ collection: (name: string) => {
          assert.equal(name, "history");
          return { doc: (id: string) => ({ set: async (record: ArchivedPlan) => {
            assert.equal(record.ownerUid, uid);
            assert.equal(record.itineraryId, id);
            archiveWrites.push(record);
            if (failArchive) throw new Error("simulated transient archive failure");
          } }) };
        } }) };
      },
    }),
  },
} as NodeModule;

// Require AFTER the data-source substitution; no route or lifecycle is mocked.
const { GET: readRoute } = nodeRequire("./[id]/route") as typeof import("./[id]/route");
const { POST: endRoute } = nodeRequire("./[id]/end/route") as typeof import("./[id]/end/route");
const { GET: resumeRoute } = nodeRequire("./route") as typeof import("./route");

const realFetch = globalThis.fetch;
const envKeys = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN", "VERCEL"];
const originalEnv = envKeys.map((key) => [key, process.env[key]] as const);
const kvData = new Map<string, string>();
const commands: unknown[][] = [];
let replacePointerAfterLookup: string | undefined;
let statusConflicts = 0;
// Simulate a new plan replacing the pointer AFTER resume captured A, at the
// storage boundary. The real active-pointer reader and lifecycle still run.
const memoryOwnerIndex = (globalThis as typeof globalThis & {
  __itineraryOwnerIndex: Map<string, string>;
}).__itineraryOwnerIndex;
const memoryOwnerGet = memoryOwnerIndex.get;
memoryOwnerIndex.get = function (uid) {
  const captured = memoryOwnerGet.call(this, uid);
  if (uid === "owner" && replacePointerAfterLookup) {
    this.set(uid, replacePointerAfterLookup);
    replacePointerAfterLookup = undefined;
  }
  return captured;
};
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  assert.equal(String(url), "https://lifecycle-kv.example", "no real network in this suite");
  const cmd = JSON.parse(String(init?.body)) as unknown[];
  commands.push(cmd);
  const op = cmd[0];
  let result: unknown;
  if (op === "GET") {
    result = kvData.get(String(cmd[1])) ?? null;
    if (cmd[1] === "owner:owner:active" && replacePointerAfterLookup) {
      kvData.set(String(cmd[1]), replacePointerAfterLookup);
      replacePointerAfterLookup = undefined;
    }
  } else if (op === "SET") {
    const key = String(cmd[1]);
    result = cmd.includes("NX") && kvData.has(key) ? null : "OK";
    if (result === "OK") kvData.set(key, String(cmd[2]));
  } else if (op === "DEL") {
    // Kept so reverting D3 reproduces the actual bad deletion, not a stub error.
    result = Number(kvData.delete(String(cmd[1])));
  } else if (op === "EVAL") {
    assert.equal(cmd[2], 1);
    const script = String(cmd[1]);
    const key = String(cmd[3]);
    if (key.startsWith("owner:")) {
      // Pin the server-side comparison AND conditional delete. There must be
      // no client-side GET/DEL window; each route asserts one EVAL below.
      assert.match(script, /if redis\.call\("GET", KEYS\[1\]\) == ARGV\[1\] then\s+return redis\.call\("DEL", KEYS\[1\]\)\s+end\s+return 0/);
      result = kvData.get(key) === cmd[4] ? Number(kvData.delete(key)) : 0;
    } else {
      assert.match(script, /KEEPTTL/);
      if (statusConflicts > 0) {
        statusConflicts--;
        const competing = JSON.parse(kvData.get(key)!);
        competing.version++;
        competing.stops[0].reason = "concurrent committed edit";
        kvData.set(key, JSON.stringify(competing));
      }
      const raw = kvData.get(key);
      const version = raw ? (JSON.parse(raw).version ?? 1) : 0;
      result = !raw ? [-1, 0] : version !== cmd[4] ? [0, version] : [1, version + 1];
      if (raw && version === cmd[4]) kvData.set(key, String(cmd[5]));
    }
  } else {
    throw new Error(`Unexpected Redis operation ${String(op)}`);
  }
  return Response.json({ result });
}) as typeof fetch;

async function plan(past = false, overrides: Partial<Itinerary> = {}): Promise<Itinerary> {
  const start = Date.now() + (past ? -120 : 60) * 60_000;
  return saveItinerary({
    ...createItinerary([{
      id: "venue-one", category: "dinner", name: "Venue One",
      start_time: new Date(start).toISOString(),
      end_time: new Date(start + 60 * 60_000).toISOString(),
      durationMinutes: { base: 50, buffer: 10, total: 60 },
    }], []),
    ownerUid: "owner", ownerIsAnonymous: false,
    ...overrides,
  });
}

async function read(itinerary: Itinerary) {
  const after = new Date(new Date(itinerary.stops[0].end_time!).getTime() + 60_000).toISOString();
  return readRoute(new NextRequest(`http://localhost/api/itinerary/${itinerary.id}?now=${encodeURIComponent(after)}`),
    { params: Promise.resolve({ id: itinerary.id }) });
}

async function end(itinerary: Itinerary, choice = "discard-end") {
  return endRoute(new NextRequest(`http://localhost/api/itinerary/${itinerary.id}/end`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner-token" },
    body: JSON.stringify({ choice }),
  }), { params: Promise.resolve({ id: itinerary.id }) });
}

async function resume(token = "owner-token") {
  return resumeRoute(new NextRequest("http://localhost/api/itinerary", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }));
}

async function expectNoResume() {
  const response = await resume();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { itinerary: null });
}

const cases: Array<[string, () => Promise<void>]> = [];
for (const backend of ["memory", "redis"] as const) {
  function reset() {
    for (const key of envKeys) delete process.env[key];
    if (backend === "redis") {
      process.env.KV_REST_API_URL = "https://lifecycle-kv.example";
      process.env.KV_REST_API_TOKEN = "fake-token";
    }
    kvData.clear();
    commands.length = 0;
    archiveWrites.length = 0;
    failArchive = false;
    replacePointerAfterLookup = undefined;
    statusConflicts = 0;
    resetRateLimitsForTests();
  }

  for (const action of ["read", "end"] as const) {
    for (const newerPointer of [true, false]) {
      cases.push([`D3 ${backend}: ${action} A ${newerPointer ? "preserves newer B" : "clears current A"}`, async () => {
        reset();
        // Already archived A still reaches pointer clearing on every read/end.
        const old = await plan(true, { archivedAt: "2026-01-01T00:00:00Z" });
        const newer = await plan();
        await setActiveItineraryForOwner("owner", newerPointer ? newer.id : old.id);
        commands.length = 0;
        const response = await (action === "read" ? read(old) : end(old));
        assert.equal(response.status, 200);
        assert.equal(await activeItineraryIdForOwner("owner"), newerPointer ? newer.id : undefined,
          newerPointer ? "concluding A must not remove B's resume pointer" : "A's own pointer must clear");
        assert.ok(await loadItinerary(old.id), "conclusion must not delete A");
        assert.deepEqual(await loadItinerary(newer.id), newer, "B must be untouched");
        assert.equal(archiveWrites.length, 0, "already archived A is not written again");
        if (backend === "redis") {
          const ownerCommands = commands.filter((cmd) => cmd.includes("owner:owner:active"));
          assert.deepEqual(ownerCommands.map((cmd) => cmd[0]), ["EVAL", "GET"],
            "clear is one atomic EVAL; the only GET is this test's assertion");
          assert.equal(ownerCommands[0][4], old.id, "caller supplies concluding A's id");
        }
      }]);
    }
  }

  cases.push([`D5 ${backend}: discard stays out of history after its window elapses`, async () => {
    reset();
    const itinerary = await plan();
    await setActiveItineraryForOwner("owner", itinerary.id);
    const ended = await end(itinerary);
    assert.equal(ended.status, 200);
    assert.equal((await ended.json()).archived, false);
    assert.equal(archiveWrites.length, 0);
    const readBack = await read(itinerary);
    assert.equal(readBack.status, 200);
    assert.equal(archiveWrites.length, 0, "a later completed read must not archive a discard");
    const stored = (await loadItinerary(itinerary.id))!;
    assert.equal(stored.status, "completed", "clock derivation still runs");
    assert.equal(stored.discardedAt, stored.endedAt, "the decision persists with the end");
    assert.ok(stored.discardedAt);
    assert.equal(stored.archivedAt, undefined);
    // A later duplicate End request cannot reverse the first end's decision.
    const repeated = await end(itinerary, "save-end");
    assert.equal((await repeated.json()).archived, false);
    assert.equal(archiveWrites.length, 0, "a repeated save must not resurrect a discard");
  }]);

  cases.push([`D5 ${backend}: save-end archives once and is not a discard`, async () => {
    reset();
    const itinerary = await plan();
    const ended = await end(itinerary, "save-end");
    assert.equal(ended.status, 200);
    assert.equal((await ended.json()).archived, true);
    assert.equal(archiveWrites.length, 1);
    assert.equal((await read(itinerary)).status, 200);
    const stored = (await loadItinerary(itinerary.id))!;
    assert.ok(stored.endedAt);
    assert.ok(stored.archivedAt);
    assert.equal(stored.discardedAt, undefined);
    assert.equal(archiveWrites.length, 1);
  }]);

  cases.push([`D5 ${backend}: failed save-end remains eligible for a later read's retry`, async () => {
    reset();
    const itinerary = await plan();
    failArchive = true;
    const ended = await end(itinerary, "save-end");
    assert.equal(ended.status, 200, "secondary archive failure is non-fatal");
    assert.equal((await ended.json()).archived, false);
    const failedSave = (await loadItinerary(itinerary.id))!;
    assert.ok(failedSave.endedAt);
    assert.equal(failedSave.archivedAt, undefined);
    assert.equal(failedSave.discardedAt, undefined, "failure is not user intent");
    failArchive = false;
    assert.equal((await read(itinerary)).status, 200);
    assert.equal(archiveWrites.length, 2, "later completion retries the failed write");
    assert.ok((await loadItinerary(itinerary.id))!.archivedAt);
  }]);

  cases.push([`D5 ${backend}: natural completion without disposition still archives`, async () => {
    reset();
    const itinerary = await plan(true);
    assert.equal((await read(itinerary)).status, 200);
    assert.equal(archiveWrites.length, 1);
    const stored = (await loadItinerary(itinerary.id))!;
    assert.ok(stored.archivedAt);
    assert.equal(stored.endedAt, undefined);
    assert.equal(stored.discardedAt, undefined);
  }]);

  cases.push([`D4 ${backend}: ordinary natural completion resumes to null AND archives`, async () => {
    reset();
    const itinerary = await plan(true);
    await setActiveItineraryForOwner("owner", itinerary.id);
    await expectNoResume();
    assert.equal(archiveWrites.length, 1, "resume must archive without any by-id read or End action");
    const stored = (await loadItinerary(itinerary.id))!;
    assert.equal(stored.status, "completed");
    assert.equal(stored.stops[0].status, "completed");
    assert.equal(stored.stops[0].locked, true, "resume must persist the lock ratchet");
    assert.equal(stored.version, 3, "status and archive marker each commit through CAS");
    assert.ok(stored.archivedAt);
    assert.equal(stored.endedAt, undefined);
    assert.equal(await activeItineraryIdForOwner("owner"), undefined);
    await expectNoResume();
    assert.equal((await read(itinerary)).status, 200);
    assert.equal(archiveWrites.length, 1, "resume and by-id share the archived guard");
  }]);

  cases.push([`D4 ${backend}: resume of an elapsed discard honors D5`, async () => {
    reset();
    const itinerary = await plan();
    assert.equal((await end(itinerary)).status, 200);
    // Model elapsed time in fixture data, not production clock arithmetic.
    await updateItinerary(itinerary.id, (proposal) => {
      proposal.stops[0].start_time = new Date(Date.now() - 120 * 60_000).toISOString();
      proposal.stops[0].end_time = new Date(Date.now() - 60 * 60_000).toISOString();
      return { value: null };
    });
    // Recreate the stale pointer that a failed /end clear can leave behind.
    await setActiveItineraryForOwner("owner", itinerary.id);
    await expectNoResume();
    assert.equal(archiveWrites.length, 0, "D5 must veto archiving on the new resume path");
    const stored = (await loadItinerary(itinerary.id))!;
    assert.equal(stored.status, "completed", "resume must still persist status on a discard");
    assert.equal(stored.stops[0].locked, true);
    assert.ok(stored.discardedAt);
    assert.equal(stored.archivedAt, undefined);
    assert.equal(await activeItineraryIdForOwner("owner"), undefined);
  }]);

  cases.push([`D4 ${backend}: in-flight resume of A preserves newer B through D3`, async () => {
    reset();
    const old = await plan(true);
    const newer = await plan();
    await setActiveItineraryForOwner("owner", old.id);
    replacePointerAfterLookup = newer.id;
    await expectNoResume();
    assert.equal(archiveWrites.length, 1, "the in-flight read still concludes A");
    assert.equal(archiveWrites[0].itineraryId, old.id);
    assert.equal(await activeItineraryIdForOwner("owner"), newer.id, "D3 protects B during resume's conclusion");
    const nextVisit = await resume();
    assert.equal((await nextVisit.json()).itinerary.id, newer.id, "the next visit resumes B");
    assert.deepEqual(await loadItinerary(newer.id), newer);
  }]);

  cases.push([`D4 ${backend}: active resume persists locks and repeated no-op reads do not write`, async () => {
    reset();
    const itinerary = await plan();
    await updateItinerary(itinerary.id, (proposal) => {
      proposal.stops[0].start_time = new Date(Date.now() - 30 * 60_000).toISOString();
      return { value: null };
    });
    await setActiveItineraryForOwner("owner", itinerary.id);
    const response = await resume();
    assert.equal(response.status, 200);
    const resumed = (await response.json()).itinerary as Itinerary;
    assert.equal(resumed.status, "active");
    assert.equal(resumed.stops[0].locked, true);
    assert.deepEqual(await loadItinerary(itinerary.id), resumed);
    const next = await resume();
    assert.deepEqual((await next.json()).itinerary, resumed, "no-op resume must not bump version");
    assert.equal(archiveWrites.length, 0);
  }]);

  for (const ownerUid of ["someone-else", undefined]) {
    cases.push([`D4 ${backend}: resume rejects ${ownerUid ?? "unowned"} pointer before side effects`, async () => {
      reset();
      const itinerary = await plan(true, { ownerUid });
      await setActiveItineraryForOwner("owner", itinerary.id);
      if (ownerUid) await setActiveItineraryForOwner(ownerUid, itinerary.id);
      await expectNoResume();
      assert.equal(archiveWrites.length, 0);
      assert.deepEqual(await loadItinerary(itinerary.id), itinerary, "unauthorized resume cannot mutate statuses either");
      assert.equal(await activeItineraryIdForOwner("owner"), itinerary.id);
      if (ownerUid) assert.equal(await activeItineraryIdForOwner(ownerUid), itinerary.id);
    }]);
  }

  cases.push([`D4 ${backend}: archive failure stays non-fatal and leaves a retryable marker`, async () => {
    reset();
    const itinerary = await plan(true);
    await setActiveItineraryForOwner("owner", itinerary.id);
    failArchive = true;
    await expectNoResume();
    assert.equal(archiveWrites.length, 1);
    const stored = (await loadItinerary(itinerary.id))!;
    assert.equal(stored.status, "completed");
    assert.equal(stored.archivedAt, undefined);
    assert.equal(stored.discardedAt, undefined);
    // As on by-id reads, the pointer clears independently of archive success.
    assert.equal(await activeItineraryIdForOwner("owner"), undefined);
    failArchive = false;
    assert.equal((await read(itinerary)).status, 200);
    assert.ok((await loadItinerary(itinerary.id))!.archivedAt);
  }]);

  cases.push([`D4 ${backend}: missing plan and unverified caller remain harmless null reads`, async () => {
    reset();
    await setActiveItineraryForOwner("owner", "missing-plan");
    await expectNoResume();
    const itinerary = await plan(true);
    await setActiveItineraryForOwner("owner", itinerary.id);
    for (const token of ["", "invalid-token"]) {
      const response = await resume(token);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { itinerary: null });
    }
    assert.deepEqual(await loadItinerary(itinerary.id), itinerary);
    assert.equal(archiveWrites.length, 0);
    assert.equal(await activeItineraryIdForOwner("owner"), itinerary.id);
  }]);

  if (backend === "redis") {
    cases.push(["D4 redis: status CAS retries twice without losing concurrent edits", async () => {
      reset();
      const itinerary = await plan(true);
      await setActiveItineraryForOwner("owner", itinerary.id);
      statusConflicts = 2;
      await expectNoResume();
      assert.equal(statusConflicts, 0);
      const stored = (await loadItinerary(itinerary.id))!;
      assert.equal(stored.version, 5);
      assert.equal(stored.stops[0].reason, "concurrent committed edit");
      assert.equal(stored.stops[0].locked, true);
      assert.ok(stored.archivedAt);
      assert.equal(archiveWrites.length, 1);
      assert.equal(commands.filter((cmd) => cmd[0] === "EVAL" && cmd[3] === `itin:${itinerary.id}`).length, 4,
        "three status attempts, then one archive-marker CAS");
    }]);
  }
}

void (async () => {
  let failed = 0;
  const selected = cases.filter(([name]) => !process.env.LIFECYCLE_TEST_FILTER || name.includes(process.env.LIFECYCLE_TEST_FILTER));
  try {
    assert.ok(selected.length, "test filter must select cases");
    for (const [name, run] of selected) {
      try {
        await run();
        console.log(`PASS  ${name}`);
      } catch (error) {
        failed++;
        console.log(`FAIL  ${name}`);
        console.log(error instanceof Error ? error.stack : error);
      }
    }
  } finally {
    globalThis.fetch = realFetch;
    memoryOwnerIndex.get = memoryOwnerGet;
    if (originalAdmin) nodeRequire.cache[adminPath] = originalAdmin;
    else delete nodeRequire.cache[adminPath];
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  console.log(`\n${selected.length - failed}/${selected.length} passed`);
  if (failed) process.exitCode = 1;
})();
