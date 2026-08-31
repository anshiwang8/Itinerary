import assert from "node:assert";
import { ScheduledStop } from "../schedule/schedule";
import {
  ItineraryConflictError,
  activeItineraryIdForOwner,
  clearActiveItineraryForOwner,
  compareAndSetItinerary,
  createItinerary,
  loadItinerary,
  saveItinerary,
  setActiveItineraryForOwner,
  updateItinerary,
  withStatuses,
} from "./store";

for (const key of [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "VERCEL",
]) {
  delete process.env[key];
}

function mkStops(): ScheduledStop[] {
  return [
    {
      category: "dinner",
      id: "d1",
      name: "Dinner One",
      start_time: "2026-07-10T19:00:00-04:00",
      end_time: "2026-07-10T20:00:00-04:00",
      durationMinutes: { base: 50, buffer: 10, total: 60 },
    },
    {
      category: "bar",
      id: "b1",
      name: "Bar One",
      start_time: "2026-07-10T20:15:00-04:00",
      end_time: "2026-07-10T21:15:00-04:00",
      durationMinutes: { base: 50, buffer: 10, total: 60 },
    },
  ];
}

function twoPartyBarrier() {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived++;
    if (arrived === 2) release();
    await ready;
  };
}

async function storedPlan() {
  const itinerary = createItinerary(mkStops(), []);
  await saveItinerary(itinerary);
  return itinerary;
}

const cases: Array<[string, () => Promise<void>]> = [
  [
    "two interleaved swaps retry safely and preserve both committed edits",
    async () => {
      const itinerary = await storedPlan();
      const barrier = twoPartyBarrier();
      let firstAttempts = 0;
      let secondAttempts = 0;

      const first = updateItinerary(
        itinerary.id,
        async (proposal) => {
          firstAttempts++;
          if (firstAttempts === 1) await barrier();
          proposal.stops[0].name = "Dinner Swapped";
          return { value: "first" };
        },
        { maxAttempts: 3 }
      );
      const second = updateItinerary(
        itinerary.id,
        async (proposal) => {
          secondAttempts++;
          if (secondAttempts === 1) await barrier();
          proposal.stops[1].name = "Bar Swapped";
          return { value: "second" };
        },
        { maxAttempts: 3 }
      );

      const results = await Promise.all([first, second]);
      assert.ok(results[0] && results[1]);
      assert.ok(
        firstAttempts === 2 || secondAttempts === 2,
        "one proposal must retry after losing the first CAS"
      );
      const current = (await loadItinerary(itinerary.id))!;
      assert.strictEqual(current.version, 3);
      assert.strictEqual(current.stops[0].name, "Dinner Swapped");
      assert.strictEqual(current.stops[1].name, "Bar Swapped");
    },
  ],
  [
    "interleaved swap versus reroute commits a complete proposal from each",
    async () => {
      const itinerary = await storedPlan();
      const barrier = twoPartyBarrier();
      let swapAttempts = 0;
      let rerouteAttempts = 0;

      await Promise.all([
        updateItinerary(
          itinerary.id,
          async (proposal) => {
            swapAttempts++;
            if (swapAttempts === 1) await barrier();
            proposal.stops[0].id = "d2";
            proposal.stops[0].name = "Replacement Dinner";
            return { value: "swap" };
          },
          { maxAttempts: 3 }
        ),
        updateItinerary(
          itinerary.id,
          async (proposal) => {
            rerouteAttempts++;
            if (rerouteAttempts === 1) await barrier();
            proposal.stops[1].start_time = "2026-07-10T20:30:00-04:00";
            proposal.stops[1].end_time = "2026-07-10T21:30:00-04:00";
            return { value: "reroute" };
          },
          { maxAttempts: 3 }
        ),
      ]);

      const current = (await loadItinerary(itinerary.id))!;
      assert.strictEqual(current.version, 3);
      assert.strictEqual(current.stops[0].id, "d2");
      assert.strictEqual(current.stops[1].start_time, "2026-07-10T20:30:00-04:00");
      assert.ok(swapAttempts === 2 || rerouteAttempts === 2);
    },
  ],
  [
    "status and lock ratchet racing a swap preserves both facts",
    async () => {
      const itinerary = await storedPlan();
      const barrier = twoPartyBarrier();
      let statusAttempts = 0;
      let swapAttempts = 0;

      await Promise.all([
        updateItinerary(
          itinerary.id,
          async (proposal) => {
            statusAttempts++;
            if (statusAttempts === 1) await barrier();
            withStatuses(proposal, new Date("2026-07-10T19:30:00-04:00"));
            return { value: "status" };
          },
          { maxAttempts: 3 }
        ),
        updateItinerary(
          itinerary.id,
          async (proposal) => {
            swapAttempts++;
            if (swapAttempts === 1) await barrier();
            proposal.stops[1].name = "Concurrent Bar";
            return { value: "swap" };
          },
          { maxAttempts: 3 }
        ),
      ]);

      const current = (await loadItinerary(itinerary.id))!;
      assert.strictEqual(current.version, 3);
      assert.strictEqual(current.stops[0].status, "active");
      assert.strictEqual(current.stops[0].locked, true);
      assert.strictEqual(current.stops[1].name, "Concurrent Bar");
    },
  ],
  [
    "stale writer receives deterministic 409 and cannot partially mutate storage",
    async () => {
      const itinerary = await storedPlan();
      const stale = (await loadItinerary(itinerary.id))!;
      await updateItinerary(itinerary.id, (proposal) => {
        proposal.stops[0].name = "Committed Winner";
        return { value: null };
      });

      stale.stops[0].name = "Stale Loser";
      await assert.rejects(
        () => compareAndSetItinerary(stale, stale.version),
        (error: unknown) =>
          error instanceof ItineraryConflictError &&
          error.status === 409 &&
          error.code === "itinerary_conflict"
      );
      const current = (await loadItinerary(itinerary.id))!;
      assert.strictEqual(current.version, 2);
      assert.strictEqual(current.stops[0].name, "Committed Winner");
    },
  ],
  [
    "explicit stale client version fails before running mutation work",
    async () => {
      const itinerary = await storedPlan();
      await updateItinerary(itinerary.id, (proposal) => {
        proposal.stops[0].name = "Newer";
        return { value: null };
      });
      let ran = false;
      await assert.rejects(
        () =>
          updateItinerary(
            itinerary.id,
            (proposal) => {
              ran = true;
              proposal.stops[1].name = "Must Not Run";
              return { value: null };
            },
            { expectedVersion: 1 }
          ),
        (error: unknown) =>
          error instanceof ItineraryConflictError && error.status === 409
      );
      assert.strictEqual(ran, false);
    },
  ],
  [
    "no-op status read does not bump version",
    async () => {
      const itinerary = await storedPlan();
      const result = await updateItinerary(
        itinerary.id,
        (proposal) => {
          const touched = { changed: false };
          withStatuses(proposal, new Date("2026-07-10T18:00:00-04:00"), touched);
          return { value: null, changed: touched.changed };
        },
        { maxAttempts: 3 }
      );
      assert.strictEqual(result!.itinerary.version, 1);
      assert.strictEqual((await loadItinerary(itinerary.id))!.version, 1);
    },
  ],

  // ── the owner index (Stage 1B): uid → that user's current plan ──
  //
  // This is the round-trip that makes resume-on-refresh possible. The plan
  // itself was never the problem — it survives in the store either way — so
  // what is worth proving is that the POINTER is set, found, and dropped.
  [
    "owner index round-trips: a user is pointed at their plan and can find it again",
    async () => {
      const itinerary = await saveItinerary(createItinerary(mkStops(), []));
      await setActiveItineraryForOwner("uid-alpha", itinerary.id);
      assert.strictEqual(await activeItineraryIdForOwner("uid-alpha"), itinerary.id);
      // and the plan itself still loads through the normal path
      assert.strictEqual((await loadItinerary(itinerary.id))!.id, itinerary.id);
    },
  ],
  [
    "the index is per user, and an unknown user has nothing to resume",
    async () => {
      const mine = await saveItinerary(createItinerary(mkStops(), []));
      await setActiveItineraryForOwner("uid-beta", mine.id);
      assert.strictEqual(await activeItineraryIdForOwner("uid-gamma"), undefined);
      assert.strictEqual(await activeItineraryIdForOwner("uid-beta"), mine.id);
    },
  ],
  [
    "clearing the pointer stops a concluded plan resuming over the landing page",
    async () => {
      const itinerary = await saveItinerary(createItinerary(mkStops(), []));
      await setActiveItineraryForOwner("uid-delta", itinerary.id);
      await clearActiveItineraryForOwner("uid-delta", itinerary.id);
      assert.strictEqual(await activeItineraryIdForOwner("uid-delta"), undefined);
      // the PLAN is untouched — only the pointer went away
      assert.ok(await loadItinerary(itinerary.id), "clearing the index must not delete the plan");
    },
  ],
  [
    "a blank uid is not a key — it must never become a shared bucket",
    async () => {
      const itinerary = await saveItinerary(createItinerary(mkStops(), []));
      await setActiveItineraryForOwner("   ", itinerary.id);
      assert.strictEqual(await activeItineraryIdForOwner("   "), undefined);
      assert.strictEqual(await activeItineraryIdForOwner(""), undefined);
    },
  ],
];

(async () => {
  let failed = 0;
  for (const [name, run] of cases) {
    try {
      await run();
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
