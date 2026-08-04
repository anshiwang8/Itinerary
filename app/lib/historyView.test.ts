// Reading an archived plan: the shape check, and the labels it turns into.
//
// The Firestore query is live-only, but everything between the document and
// the pixels is ordinary branching — which record is usable, which date an
// outing belongs to, which zone its times render in, what a missing field
// shows as. That is what this file pins.
//
// The rule underneath all of it: the archive holds a PROJECTION (id, two
// timestamps, a zone, stops with names/categories/times/statuses) and the view
// may show that and nothing else. Several cases below exist to prove a missing
// field degrades honestly instead of being invented.
import assert from "node:assert";
import {
  parseHistoryPlan,
  parseHistoryResponse,
  parseHistoryStop,
  toHistoryEntries,
  toHistoryEntry,
  type HistoryPlanPayload,
} from "./historyView";

/** A full, well-formed archived document — the shape `toArchivedPlan` writes,
 *  minus the owner uid the wire drops. */
function doc(overrides: Partial<HistoryPlanPayload> = {}): HistoryPlanPayload {
  return {
    itineraryId: "plan-1",
    createdAt: "2026-07-04T17:12:00-04:00",
    archivedAt: "2026-07-05T02:00:00-04:00",
    timeZone: "America/Toronto",
    stops: [
      {
        name: "Kinton Ramen",
        category: "dinner",
        start_time: "2026-07-04T19:00:00-04:00",
        end_time: "2026-07-04T20:15:00-04:00",
        status: "completed",
      },
      {
        name: "Bar Raval",
        category: "bar",
        start_time: "2026-07-04T20:45:00-04:00",
        end_time: "2026-07-04T22:30:00-04:00",
        status: "completed",
      },
    ],
    ...overrides,
  };
}

const cases: Array<[string, () => void]> = [
  [
    "a complete plan renders its date, its span and its stops",
    () => {
      const view = toHistoryEntry(doc());
      assert.strictEqual(view.id, "plan-1");
      assert.strictEqual(view.dateLabel, "Sat Jul 4, 2026");
      // The span runs from the FIRST start to the LAST end, not stop by stop.
      assert.strictEqual(view.timeLabel, "7:00 PM – 10:30 PM");
      assert.strictEqual(view.stopCountLabel, "2 stops");
      assert.strictEqual(view.stops.length, 2);
      assert.strictEqual(view.stops[0].title, "Kinton Ramen");
      assert.strictEqual(view.stops[0].timeLabel, "7:00 PM – 8:15 PM");
      assert.strictEqual(view.stops[1].title, "Bar Raval");
      assert.strictEqual(view.stops[1].timeLabel, "8:45 PM – 10:30 PM");
      // Nothing here is a title, a prompt or a city: the archive has none of
      // those, and inventing one is the failure this whole file guards.
      assert.ok(!("title" in view), "an archived plan has no title to show");
    },
  ],
  [
    "every label renders in the PLAN's zone, not the reader's and not Toronto",
    () => {
      // The same absolute instants, filed under Vancouver. 12:30 AM Toronto on
      // Jul 5 is 9:30 PM Vancouver on Jul 4 — so both the time AND the date
      // move. A Toronto-shaped answer here is the Phase-4 bug returning.
      const vancouver = toHistoryEntry(
        doc({
          timeZone: "America/Vancouver",
          stops: [
            {
              name: "Late set",
              category: "live music",
              start_time: "2026-07-05T00:30:00-04:00",
              end_time: "2026-07-05T02:00:00-04:00",
              status: "completed",
            },
          ],
        })
      );
      assert.strictEqual(vancouver.timeZone, "America/Vancouver");
      assert.strictEqual(vancouver.dateLabel, "Sat Jul 4, 2026");
      assert.strictEqual(vancouver.timeLabel, "9:30 PM – 11:00 PM");

      const toronto = toHistoryEntry(
        doc({
          timeZone: "America/Toronto",
          stops: [
            {
              name: "Late set",
              category: "live music",
              start_time: "2026-07-05T00:30:00-04:00",
              end_time: "2026-07-05T02:00:00-04:00",
              status: "completed",
            },
          ],
        })
      );
      assert.strictEqual(toronto.dateLabel, "Sun Jul 5, 2026");
      assert.strictEqual(toronto.timeLabel, "12:30 AM – 2:00 AM");
    },
  ],
  [
    "an absent or unusable zone falls back to the default, never to a crash",
    () => {
      for (const zone of [null, "", "Mars/Olympus", "   "]) {
        const view = toHistoryEntry(doc({ timeZone: zone }));
        assert.strictEqual(view.timeZone, "America/Toronto", `zone ${JSON.stringify(zone)}`);
        assert.strictEqual(view.dateLabel, "Sat Jul 4, 2026");
      }
    },
  ],
  [
    "the date is the OUTING's, not the moment the plan was typed",
    () => {
      // Typed at 11:40pm for the next morning. Filing it under the night it
      // was typed would put a Sunday brunch in Saturday's list.
      const view = toHistoryEntry(
        doc({
          createdAt: "2026-07-04T23:40:00-04:00",
          archivedAt: "2026-07-05T14:00:00-04:00",
          stops: [
            {
              name: "Maha's",
              category: "brunch",
              start_time: "2026-07-05T10:30:00-04:00",
              end_time: "2026-07-05T11:45:00-04:00",
              status: "completed",
            },
          ],
        })
      );
      assert.strictEqual(view.dateLabel, "Sun Jul 5, 2026");
    },
  ],
  [
    "with no stop times the date falls back to createdAt, then to archivedAt",
    () => {
      const noTimes = doc({
        stops: [{ name: "Somewhere", category: "dinner", start_time: null, end_time: null, status: "completed" }],
      });
      assert.strictEqual(toHistoryEntry(noTimes).dateLabel, "Sat Jul 4, 2026");
      assert.strictEqual(toHistoryEntry(noTimes).timeLabel, null, "no invented span");

      const onlyArchived = toHistoryEntry({ ...noTimes, createdAt: "" });
      assert.strictEqual(onlyArchived.dateLabel, "Sun Jul 5, 2026");
    },
  ],
  [
    "a record with no usable instant at all says so rather than guessing",
    () => {
      const view = toHistoryEntry(
        doc({
          createdAt: "",
          archivedAt: "",
          stops: [{ name: "Somewhere", category: "dinner", start_time: null, end_time: null, status: "" }],
        })
      );
      assert.strictEqual(view.dateLabel, "Undated");
      assert.strictEqual(view.timeLabel, null);
      // Undated still sorts — last — instead of vanishing from the list.
      assert.strictEqual(view.sortKey, 0);
    },
  ],
  [
    "a slot with no venue shows its category, and a skipped one says skipped",
    () => {
      const view = toHistoryEntry(
        doc({
          stops: [
            {
              name: null,
              category: "live music",
              start_time: null,
              end_time: null,
              status: "skipped",
            },
          ],
        })
      );
      assert.strictEqual(view.stops[0].title, "Live Music", "category is the honest fallback");
      assert.strictEqual(view.stops[0].skipped, true);
      assert.strictEqual(view.stops[0].timeLabel, null);
      assert.strictEqual(view.stops[0].category, "live music");
    },
  ],
  [
    "a half-timed stop shows the half it has",
    () => {
      const view = toHistoryEntry(
        doc({
          stops: [
            { name: "A", category: "dinner", start_time: "2026-07-04T19:00:00-04:00", end_time: null, status: "completed" },
            { name: "B", category: "bar", start_time: null, end_time: "2026-07-04T22:00:00-04:00", status: "completed" },
          ],
        })
      );
      assert.strictEqual(view.stops[0].timeLabel, "7:00 PM");
      assert.strictEqual(view.stops[1].timeLabel, "10:00 PM");
      // The span still spans: first start to last end.
      assert.strictEqual(view.timeLabel, "7:00 PM – 10:00 PM");
    },
  ],
  [
    "stop counts read as English",
    () => {
      const counts: Array<[number, string]> = [
        [0, "no stops"],
        [1, "1 stop"],
        [2, "2 stops"],
        [5, "5 stops"],
      ];
      for (const [count, label] of counts) {
        const stops = Array.from({ length: count }, (_, index) => ({
          name: `Stop ${index}`,
          category: "dinner",
          start_time: null,
          end_time: null,
          status: "completed",
        }));
        assert.strictEqual(toHistoryEntry(doc({ stops })).stopCountLabel, label);
      }
    },
  ],
  [
    "stop keys are unique so a list cannot collapse rows",
    () => {
      const view = toHistoryEntry(
        doc({
          stops: [
            { name: "One", category: "bar", start_time: null, end_time: null, status: "completed" },
            { name: "Two", category: "bar", start_time: null, end_time: null, status: "completed" },
          ],
        })
      );
      assert.strictEqual(new Set(view.stops.map((s) => s.key)).size, 2);
    },
  ],

  // ── the shape check ──
  [
    "a document needs an id, and the Firestore key can supply it",
    () => {
      assert.strictEqual(parseHistoryPlan({ stops: [] }), null, "no id anywhere");
      const fromKey = parseHistoryPlan({ stops: [] }, "plan-from-key");
      assert.strictEqual(fromKey?.itineraryId, "plan-from-key");
      // A stored field wins when present; both agree in every real document.
      const fromField = parseHistoryPlan({ itineraryId: "stored", stops: [] }, "key");
      assert.strictEqual(fromField?.itineraryId, "stored");
      assert.strictEqual(parseHistoryPlan({ itineraryId: "   " }, "  "), null, "blank is absent");
    },
  ],
  [
    "anything that is not a document is not a plan",
    () => {
      for (const bad of [null, undefined, 7, "plan", [], true]) {
        assert.strictEqual(parseHistoryPlan(bad, "id"), null, `${JSON.stringify(bad)}`);
      }
    },
  ],
  [
    "missing fields degrade; they do not disqualify the record",
    () => {
      // Keep-on-missing-data, the same bargain the venue filters make.
      const parsed = parseHistoryPlan({ itineraryId: "plan-9" });
      assert.deepStrictEqual(parsed, {
        itineraryId: "plan-9",
        createdAt: "",
        archivedAt: "",
        timeZone: null,
        stops: [],
      });
      // An unparseable timestamp is treated as absent, never rendered raw.
      const bogus = parseHistoryPlan({
        itineraryId: "plan-9",
        createdAt: "the fourth of July",
        archivedAt: "2026-07-05T02:00:00-04:00",
      });
      assert.strictEqual(bogus?.createdAt, "");
      assert.strictEqual(bogus?.archivedAt, "2026-07-05T02:00:00-04:00");
    },
  ],
  [
    "a stop is dropped only when it identifies nothing",
    () => {
      assert.strictEqual(parseHistoryStop({}), null, "neither name nor category");
      assert.strictEqual(parseHistoryStop({ name: "  ", category: "" }), null, "blank both");
      assert.strictEqual(parseHistoryStop("dinner"), null, "not a record");
      // Everything else survives with whatever it has.
      assert.deepStrictEqual(parseHistoryStop({ category: "bar" }), {
        name: null,
        category: "bar",
        start_time: null,
        end_time: null,
        status: "",
      });
      assert.deepStrictEqual(parseHistoryStop({ name: "Somewhere", start_time: 7 }), {
        name: "Somewhere",
        category: "",
        start_time: null,
        end_time: null,
        status: "",
      });
    },
  ],
  [
    "junk stops are dropped without taking the plan down with them",
    () => {
      const parsed = parseHistoryPlan({
        itineraryId: "plan-3",
        stops: [{ name: "Real" }, null, 42, {}, { category: "bar" }],
      });
      assert.strictEqual(parsed?.stops.length, 2);
      assert.deepStrictEqual(
        parsed?.stops.map((stop) => stop.name ?? stop.category),
        ["Real", "bar"]
      );
      // A non-array `stops` is an empty plan, not a thrown error.
      assert.deepStrictEqual(parseHistoryPlan({ itineraryId: "p", stops: "two" })?.stops, []);
    },
  ],

  // ── ordering ──
  [
    "the list is newest-first regardless of the order it arrived in",
    () => {
      const entries = toHistoryEntries([
        doc({ itineraryId: "old", archivedAt: "2026-06-01T20:00:00-04:00" }),
        doc({ itineraryId: "newest", archivedAt: "2026-07-20T20:00:00-04:00" }),
        doc({ itineraryId: "middle", archivedAt: "2026-07-05T20:00:00-04:00" }),
      ]);
      assert.deepStrictEqual(
        entries.map((entry) => entry.id),
        ["newest", "middle", "old"]
      );
    },
  ],
  [
    "ties break deterministically, and undated records sort last",
    () => {
      const sameInstant = "2026-07-05T20:00:00-04:00";
      const entries = toHistoryEntries([
        doc({ itineraryId: "b", archivedAt: sameInstant }),
        doc({ itineraryId: "undated", createdAt: "", archivedAt: "", stops: [] }),
        doc({ itineraryId: "a", archivedAt: sameInstant }),
      ]);
      assert.deepStrictEqual(
        entries.map((entry) => entry.id),
        ["a", "b", "undated"]
      );
    },
  ],
  [
    "unusable records are dropped from the list, not rendered blank",
    () => {
      const entries = toHistoryEntries([doc(), null, { stops: [] }, "nope"]);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].id, "plan-1");
    },
  ],

  // ── the response envelope ──
  [
    "a well-formed response becomes entries; readFailed rides along",
    () => {
      const ok = parseHistoryResponse({ plans: [doc()], readFailed: false });
      assert.strictEqual(ok.entries.length, 1);
      assert.strictEqual(ok.readFailed, false);

      const failed = parseHistoryResponse({ plans: [], readFailed: true });
      assert.deepStrictEqual(failed, { entries: [], readFailed: true });
    },
  ],
  [
    "an unreadable body is a FAILED read, never an empty history",
    () => {
      // The distinction this whole flag exists for: telling someone with
      // twenty saved outings that they have none would read as data loss.
      for (const bad of [null, undefined, "plans", 5, [], {}, { plans: "none" }]) {
        assert.deepStrictEqual(
          parseHistoryResponse(bad),
          { entries: [], readFailed: true },
          `${JSON.stringify(bad)}`
        );
      }
      // An empty list with no failure flag is a genuinely empty history.
      assert.deepStrictEqual(parseHistoryResponse({ plans: [] }), {
        entries: [],
        readFailed: false,
      });
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
