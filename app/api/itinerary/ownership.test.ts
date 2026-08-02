// Ownership and the archive gate — the decisions around Firebase, which are
// ordinary branching and therefore checkable. The live pieces (token
// verification, the Firestore write) are covered by manual verification
// instead; a mocked auth test would prove only that the mock was called.
//
// The case that matters most here: an ANONYMOUS owner must never archive.
// That is the whole privacy promise of the slice — a guest's night out is
// never written anywhere, so there is nothing to delete afterwards.
import assert from "node:assert";
import {
  hasBeenArchived,
  isLegacyPlan,
  isResumable,
  ownsItinerary,
  shouldArchive,
  stampOwner,
  toArchivedPlan,
  type CallerIdentity,
} from "./ownership";
import type { Itinerary, ItineraryStatus } from "./store";

const REAL: CallerIdentity = { uid: "google-uid-1", isAnonymous: false };
const GUEST: CallerIdentity = { uid: "anon-uid-1", isAnonymous: true };

function plan(overrides: Partial<Itinerary> = {}): Itinerary {
  return {
    id: "itin-1",
    version: 1,
    createdAt: "2026-08-01T18:00:00.000Z",
    status: "completed" as ItineraryStatus,
    stops: [
      {
        name: "Ramen Isshin",
        category: "restaurant",
        start_time: "2026-08-01T19:00:00.000Z",
        end_time: "2026-08-01T20:00:00.000Z",
        status: "completed",
        locked: true,
      },
    ],
    legs: [],
    ...overrides,
  } as unknown as Itinerary;
}

const cases: Array<[string, () => void]> = [
  // ── stamping ──
  [
    "a verified caller becomes the owner, anonymity recorded alongside",
    () => {
      const real = stampOwner(plan(), REAL);
      assert.strictEqual(real.ownerUid, "google-uid-1");
      assert.strictEqual(real.ownerIsAnonymous, false);

      const guest = stampOwner(plan(), GUEST);
      assert.strictEqual(guest.ownerUid, "anon-uid-1");
      assert.strictEqual(
        guest.ownerIsAnonymous,
        true,
        "anonymity is recorded at creation, because the archive decision happens later"
      );
    },
  ],
  [
    "no caller stamps NOTHING — not a placeholder owner",
    () => {
      // Mock e2e and missing Admin credentials both land here. "Unknown owner"
      // and "owned by the string 'unknown'" behave differently everywhere
      // downstream, and only one of them is true.
      const unowned = stampOwner(plan(), null);
      assert.strictEqual(unowned.ownerUid, undefined);
      assert.strictEqual(unowned.ownerIsAnonymous, undefined);
      assert.ok(isLegacyPlan(unowned));
    },
  ],
  [
    "a blank uid is not an owner",
    () => {
      const blank = stampOwner(plan(), { uid: "   ", isAnonymous: false });
      assert.strictEqual(blank.ownerUid, undefined, "whitespace is absence");
      assert.ok(isLegacyPlan(blank));
    },
  ],

  // ── legacy plans (created before this slice) ──
  [
    "a legacy plan without an owner is recognised, never claimed, never archived",
    () => {
      // Keep-on-missing-data: a plan from before Stage 1B must keep working.
      const legacy = plan();
      assert.ok(isLegacyPlan(legacy), "no ownerUid at all");
      assert.strictEqual(ownsItinerary(legacy, REAL), false, "unowned is nobody's");
      assert.strictEqual(ownsItinerary(legacy, GUEST), false);
      assert.strictEqual(
        shouldArchive(legacy),
        false,
        "nobody to file it under — but it must not throw either"
      );
      // and blank/whitespace owners are treated identically
      assert.ok(isLegacyPlan(plan({ ownerUid: "" })));
      assert.ok(isLegacyPlan(plan({ ownerUid: "   " })));
    },
  ],
  [
    "ownership matches only the actual owner",
    () => {
      const owned = plan({ ownerUid: "google-uid-1", ownerIsAnonymous: false });
      assert.strictEqual(ownsItinerary(owned, REAL), true);
      assert.strictEqual(ownsItinerary(owned, GUEST), false, "a different uid is a stranger");
      assert.strictEqual(ownsItinerary(owned, null), false, "an unverified caller owns nothing");
    },
  ],

  // ── the archive gate ──
  [
    "a REAL account's concluded plan archives",
    () => {
      assert.strictEqual(
        shouldArchive(plan({ ownerUid: "google-uid-1", ownerIsAnonymous: false })),
        true
      );
    },
  ],
  [
    "an ANONYMOUS owner NEVER archives — the privacy promise of the slice",
    () => {
      // Not archived-then-deleted: never written. There is no cleanup story
      // because there is nothing to clean up.
      assert.strictEqual(
        shouldArchive(plan({ ownerUid: "anon-uid-1", ownerIsAnonymous: true })),
        false
      );
      // and an owner whose anonymity was never recorded is treated as a guest,
      // because the safe failure is a lost history entry, not a stranger's
      // outing filed under a real person
      assert.strictEqual(
        shouldArchive(plan({ ownerUid: "unknown-provenance" })),
        false,
        "undefined ownerIsAnonymous must not archive"
      );
    },
  ],
  [
    "an UNCONCLUDED plan never archives, however real its owner",
    () => {
      for (const status of ["planning", "active"] as ItineraryStatus[]) {
        assert.strictEqual(
          shouldArchive(plan({ status, ownerUid: "google-uid-1", ownerIsAnonymous: false })),
          false,
          `${status} is still changing`
        );
      }
    },
  ],
  [
    "archiving happens ONCE — conclusion is derived on every read, not fired once",
    () => {
      const archived = plan({
        ownerUid: "google-uid-1",
        ownerIsAnonymous: false,
        archivedAt: "2026-08-01T21:00:00.000Z",
      });
      assert.ok(hasBeenArchived(archived));
      assert.strictEqual(
        shouldArchive(archived),
        false,
        "without this guard every poll after conclusion would re-archive"
      );
      // a blank marker is not a marker
      assert.strictEqual(hasBeenArchived(plan({ archivedAt: "   " })), false);
      assert.strictEqual(
        shouldArchive(plan({ ownerUid: "google-uid-1", ownerIsAnonymous: false, archivedAt: "" })),
        true,
        "an empty marker must not block a real archive"
      );
    },
  ],

  // ── resumability ──
  [
    "a plan is resumable until it concludes — for guests exactly as for accounts",
    () => {
      assert.strictEqual(isResumable(plan({ status: "planning" })), true);
      assert.strictEqual(isResumable(plan({ status: "active" })), true);
      assert.strictEqual(isResumable(plan({ status: "completed" })), false);
      // resumability does not consult the owner at all: persistence is core
      // function and is never gated on having an account
      assert.strictEqual(
        isResumable(plan({ status: "active", ownerUid: "anon-uid-1", ownerIsAnonymous: true })),
        true
      );
    },
  ],

  // ── the archive record ──
  [
    "the archive record is a projection, not a dump",
    () => {
      const record = toArchivedPlan(
        plan({ ownerUid: "google-uid-1", ownerIsAnonymous: false, timeZone: "America/Toronto" }),
        "2026-08-01T21:00:00.000Z"
      );
      assert.strictEqual(record.itineraryId, "itin-1");
      assert.strictEqual(record.ownerUid, "google-uid-1");
      assert.strictEqual(record.archivedAt, "2026-08-01T21:00:00.000Z");
      assert.strictEqual(record.timeZone, "America/Toronto");
      assert.deepStrictEqual(record.stops, [
        {
          name: "Ramen Isshin",
          category: "restaurant",
          start_time: "2026-08-01T19:00:00.000Z",
          end_time: "2026-08-01T20:00:00.000Z",
          status: "completed",
        },
      ]);
      // no pools, polylines or provider payloads dragged into a second store
      assert.strictEqual("legs" in record, false);
      assert.strictEqual("parsed" in record, false);
      // an absent zone is null, not undefined — Firestore rejects undefined
      assert.strictEqual(
        toArchivedPlan(plan({ ownerUid: "u" }), "2026-08-01T21:00:00.000Z").timeZone,
        null
      );
    },
  ],
  [
    "projecting an unowned plan is a programming error, and says so",
    () => {
      assert.throws(
        () => toArchivedPlan(plan(), "2026-08-01T21:00:00.000Z"),
        /requires an owned itinerary/
      );
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
