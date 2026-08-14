// The four-instant display model + transfer points — the pure seam under
// the strip's expandable leg and the map's transfer markers. Everything
// here is about being HONEST with provider data: show it when it belongs
// to this leg, fall back to the scheduler's own two instants when it does
// not, and never place a marker at a coordinate nobody published.
// Run with: npx tsx app/lib/transitDetail.test.ts
import assert from "node:assert";
import {
  RideDetail,
  buildTransitTimeline,
  legUnderway,
  shouldShowTimeline,
  transferPoints,
} from "./transitDetail";

// A real leg's shape: leave 19:00, board 19:07, alight 19:24, transfer,
// board 19:29, alight 19:41, arrive 19:47. The walk and the wait live in
// the gaps — which is the whole point of showing four instants.
const LEAVE = "2026-07-03T19:00:00-04:00";
const ARRIVE = "2026-07-03T19:47:00-04:00";

const RIDE_ONE: RideDetail = {
  lineName: "63 Ossington",
  shortName: "63",
  boardISO: "2026-07-03T19:07:00-04:00",
  alightISO: "2026-07-03T19:24:00-04:00",
  boardLocation: { latitude: 43.6501, longitude: -79.4204 },
  alightLocation: { latitude: 43.6624, longitude: -79.4262 },
  departStop: "Ossington Ave at Dundas",
  arriveStop: "Ossington Station",
};
const RIDE_TWO: RideDetail = {
  lineName: "Line 2 Bloor–Danforth",
  shortName: "2",
  boardISO: "2026-07-03T19:29:00-04:00",
  alightISO: "2026-07-03T19:41:00-04:00",
  boardLocation: { latitude: 43.6626, longitude: -79.4264 },
  alightLocation: { latitude: 43.6709, longitude: -79.3857 },
  departStop: "Ossington Station",
  arriveStop: "Yonge Station",
};

const timeline = (over: Partial<Parameters<typeof buildTransitTimeline>[0]> = {}) =>
  buildTransitTimeline({ leaveISO: LEAVE, arriveISO: ARRIVE, rides: [RIDE_ONE], ...over });

/** just the two provider instants of a ride — for building a second ride
 *  that runs LATER on the same line the first one did */
const timesOf = (ride: RideDetail) => ({
  boardISO: ride.boardISO,
  alightISO: ride.alightISO,
});

const cases: Array<[string, () => void]> = [
  [
    "single ride: leave → board → alight → arrive, in that order",
    () => {
      const rows = timeline();
      assert.deepStrictEqual(
        rows!.map((r) => r.kind),
        ["leave", "board", "alight", "arrive"]
      );
      assert.deepStrictEqual(rows!.map((r) => r.instantISO), [
        LEAVE,
        RIDE_ONE.boardISO,
        RIDE_ONE.alightISO,
        ARRIVE,
      ]);
    },
  ],
  [
    "the BOARD instant is the provider's, NOT the dwell end — the bug this replaces",
    () => {
      const rows = timeline()!;
      const board = rows.find((r) => r.kind === "board")!;
      assert.strictEqual(board.instantISO, RIDE_ONE.boardISO);
      assert.notStrictEqual(
        board.instantISO,
        LEAVE,
        "you do not board the train when you stand up from dinner"
      );
      // and the seven minutes between them are the walk + the wait, now
      // visible instead of folded invisibly into one span
      assert.strictEqual(
        (Date.parse(board.instantISO) - Date.parse(LEAVE)) / 60_000,
        7
      );
    },
  ],
  [
    "board/alight rows carry the line and the stop they happen at",
    () => {
      const rows = timeline()!;
      const board = rows.find((r) => r.kind === "board")!;
      const alight = rows.find((r) => r.kind === "alight")!;
      assert.strictEqual(board.kind === "board" && board.line, "63 Ossington");
      assert.strictEqual(board.kind === "board" && board.stop, "Ossington Ave at Dundas");
      assert.strictEqual(alight.kind === "alight" && alight.stop, "Ossington Station");
    },
  ],
  [
    "MULTI-RIDE: a board/alight pair per ride, riding order preserved",
    () => {
      const rows = timeline({ rides: [RIDE_ONE, RIDE_TWO] })!;
      assert.deepStrictEqual(
        rows.map((r) => r.kind),
        ["leave", "board", "alight", "board", "alight", "arrive"]
      );
      assert.deepStrictEqual(
        rows.filter((r) => r.kind === "board").map((r) => (r.kind === "board" ? r.line : "")),
        ["63 Ossington", "Line 2 Bloor–Danforth"]
      );
      // the transfer gap is now visible: alight 19:24 → board 19:29
      const instants = rows.map((r) => Date.parse(r.instantISO));
      assert.ok(instants.every((ms, i) => i === 0 || ms >= instants[i - 1]));
    },
  ],
  [
    "every board/alight row names the RIDE it belongs to — the row's own route badge",
    () => {
      const rows = timeline({ rides: [RIDE_ONE, RIDE_TWO] })!;
      assert.deepStrictEqual(
        rows
          .filter((r) => r.kind === "board" || r.kind === "alight")
          .map((r) => (r.kind === "board" || r.kind === "alight" ? r.rideIndex : -1)),
        [0, 0, 1, 1]
      );
      // by INDEX, not by name: a leg can ride the same line twice, and
      // matching on the name would hand the second ride the first's badge
      const twice = timeline({ rides: [RIDE_ONE, { ...RIDE_ONE, ...timesOf(RIDE_TWO) }] })!;
      const boards = twice.filter((r) => r.kind === "board");
      assert.deepStrictEqual(
        boards.map((r) => (r.kind === "board" ? [r.line, r.rideIndex] : null)),
        [
          ["63 Ossington", 0],
          ["63 Ossington", 1],
        ]
      );
    },
  ],
  [
    "an empty stop name is dropped rather than rendered as a blank",
    () => {
      const rows = timeline({ rides: [{ ...RIDE_ONE, departStop: "  ", arriveStop: undefined }] })!;
      const board = rows.find((r) => r.kind === "board")!;
      const alight = rows.find((r) => r.kind === "alight")!;
      assert.strictEqual(board.kind === "board" && board.stop, null);
      assert.strictEqual(alight.kind === "alight" && alight.stop, null);
    },
  ],
  [
    "FALLBACK: no rides, or a ride with no provider times → null (the single line)",
    () => {
      assert.strictEqual(timeline({ rides: [] }), null);
      assert.strictEqual(timeline({ rides: null }), null);
      assert.strictEqual(
        timeline({ rides: [{ lineName: "505 Queen" }] }),
        null,
        "a ride the agency publishes no times for cannot be timelined"
      );
      assert.strictEqual(
        timeline({ rides: [{ ...RIDE_ONE, alightISO: null }] }),
        null,
        "half a ride is not a sequence"
      );
    },
  ],
  [
    "FALLBACK: a PARTIAL multi-ride leg never renders — a hidden ride would read as a complete journey",
    () => {
      assert.strictEqual(
        timeline({ rides: [RIDE_ONE, { ...RIDE_TWO, boardISO: null, alightISO: null }] }),
        null
      );
    },
  ],
  [
    "FALLBACK: without the scheduler's own instants there is nothing to bracket the ride",
    () => {
      assert.strictEqual(timeline({ leaveISO: null }), null);
      assert.strictEqual(timeline({ arriveISO: undefined }), null);
      assert.strictEqual(timeline({ leaveISO: "whenever" }), null);
    },
  ],
  [
    "STALENESS: a board time BEFORE you leave is refused, not shown",
    () => {
      // the shape a shifted plan leaves on an untouched leg: the leg's
      // window moved later, the provider times did not
      assert.strictEqual(
        timeline({ leaveISO: "2026-07-03T19:20:00-04:00" }),
        null,
        "boarding at 19:07 a train you leave for at 19:20 is not a timetable, it's a stale one"
      );
    },
  ],
  [
    "THE WAIT: an alight after the scheduler's arrive drops the ARRIVE ROW, not the timeline",
    () => {
      // Fresh data does this routinely. `arrive` is leave + totalMinutes,
      // and totalMinutes is the provider's route duration + margin —
      // measured from the moment you start moving, so the wait on the
      // platform is outside it. Bracketing published instants with that
      // forecast used to suppress the whole breakdown.
      const rows = timeline({ arriveISO: "2026-07-03T19:20:00-04:00" })!;
      assert.notStrictEqual(rows, null, "the published instants are all real and in order");
      assert.deepStrictEqual(
        rows.map((r) => r.kind),
        ["leave", "board", "alight"],
        "the forecast yields to the published instant it contradicts"
      );
      // ...and never by printing an arrival earlier than the ride that
      // delivers you
      const instants = rows.map((r) => Date.parse(r.instantISO));
      assert.ok(instants.every((ms, i) => i === 0 || ms >= instants[i - 1]));
    },
  ],
  [
    "THE WAIT, measured: the live 3-ride leg this fix was found on opens",
    () => {
      // Verbatim from the Routes API, a cross-town home leg priced for a
      // 00:00 departure: duration 77 min (+5 margin) while the first board
      // is 15.5 min in — so the last alight lands 5.4 min past the
      // scheduler's arrival, and the leg used to render no button at all.
      const leaveISO = "2026-08-15T00:00:00.000Z";
      const arriveISO = "2026-08-15T01:22:00.000Z"; // leave + 82 min
      const ride = (
        lineName: string,
        boardISO: string,
        alightISO: string
      ): RideDetail => ({ lineName, shortName: null, boardISO, alightISO });
      const rows = buildTransitTimeline({
        leaveISO,
        arriveISO,
        rides: [
          ride("42 Cummer", "2026-08-15T00:15:28Z", "2026-08-15T00:26:00Z"),
          ride("Line 1 Yonge - University", "2026-08-15T00:34:11Z", "2026-08-15T00:59:36Z"),
          ride("506 Carlton", "2026-08-15T01:07:50Z", "2026-08-15T01:27:25Z"),
        ],
      });
      assert.ok(rows, "every provider instant here is real, published and in order");
      assert.deepStrictEqual(rows!.map((r) => r.kind), [
        "leave",
        "board",
        "alight",
        "board",
        "alight",
        "board",
        "alight",
      ]);
      // and THAT is what makes the card tappable — the rule in front of the
      // OR is "has a timeline", so no tap could reach it while this was null
      assert.strictEqual(
        shouldShowTimeline({
          isTransit: true,
          hasTimeline: rows !== null,
          isActiveNow: false,
          isSelected: true,
        }),
        true
      );
    },
  ],
  [
    "COHERENCE: a ride span longer than the whole leg is refused",
    () => {
      // the tail guard that replaced the instant comparison: elapsed
      // against elapsed, which the two clocks make comparable where their
      // instants are not. 17 minutes of riding cannot fit a 10-minute leg.
      assert.strictEqual(
        timeline({ arriveISO: "2026-07-03T19:10:00-04:00" }),
        null,
        "riding 19:07→19:24 inside a leg that lasts 19:00→19:10 is not a journey"
      );
    },
  ],
  [
    "COHERENCE: an inverted window (arrive before leave) is refused",
    () => {
      assert.strictEqual(timeline({ arriveISO: "2026-07-03T18:50:00-04:00" }), null);
    },
  ],
  [
    "STALENESS: rides out of order (alight after the next board) are refused",
    () => {
      assert.strictEqual(
        timeline({ rides: [RIDE_TWO, RIDE_ONE] }),
        null,
        "ride 2 alights at 19:41, ride 1 boards at 19:07 — not a journey"
      );
    },
  ],
  [
    "a leg where every instant coincides still renders (equal is in order)",
    () => {
      const same = {
        ...RIDE_ONE,
        boardISO: LEAVE,
        alightISO: LEAVE,
      };
      const rows = buildTransitTimeline({
        leaveISO: LEAVE,
        arriveISO: LEAVE,
        rides: [same],
      });
      assert.strictEqual(rows?.length, 4);
    },
  ],

  // ── transfer points ──
  [
    "transfers: one ride is no transfer",
    () => {
      assert.deepStrictEqual(transferPoints([RIDE_ONE]), []);
      assert.deepStrictEqual(transferPoints([]), []);
      assert.deepStrictEqual(transferPoints(null), []);
    },
  ],
  [
    "transfers: two rides → one point, at where you GET OFF, named for that stop",
    () => {
      const points = transferPoints([RIDE_ONE, RIDE_TWO]);
      assert.strictEqual(points.length, 1);
      assert.deepStrictEqual(
        [points[0].latitude, points[0].longitude],
        [43.6624, -79.4262],
        "ride 1's alight coordinate — never an average of anything"
      );
      assert.strictEqual(points[0].stopName, "Ossington Station");
      assert.strictEqual(points[0].fromLine, "63 Ossington");
      assert.strictEqual(points[0].toLine, "Line 2 Bloor–Danforth");
    },
  ],
  [
    "transfers: three rides → two points, with distinct keys",
    () => {
      const third: RideDetail = {
        ...RIDE_TWO,
        lineName: "501 Queen",
        boardLocation: { latitude: 43.6709, longitude: -79.3857 },
        alightLocation: { latitude: 43.6489, longitude: -79.3752 },
        departStop: "Yonge Station",
        arriveStop: "Queen at Sherbourne",
      };
      const points = transferPoints([RIDE_ONE, RIDE_TWO, third]);
      assert.strictEqual(points.length, 2);
      assert.strictEqual(new Set(points.map((p) => p.key)).size, 2);
      assert.deepStrictEqual(
        [points[1].latitude, points[1].longitude],
        [43.6709, -79.3857]
      );
    },
  ],
  [
    "transfers: no alight coordinate falls back to where you BOARD next — and takes THAT stop's name",
    () => {
      const points = transferPoints([
        { ...RIDE_ONE, alightLocation: null },
        { ...RIDE_TWO, departStop: "Ossington Station (platform)" },
      ]);
      assert.deepStrictEqual(
        [points[0].latitude, points[0].longitude],
        [43.6626, -79.4264],
        "ride 2's board coordinate — also a real place"
      );
      assert.strictEqual(
        points[0].stopName,
        "Ossington Station (platform)",
        "the name follows the coordinate that was actually used"
      );
    },
  ],
  [
    "transfers: NEITHER coordinate → NO marker (never a guessed position)",
    () => {
      assert.deepStrictEqual(
        transferPoints([
          { ...RIDE_ONE, alightLocation: null },
          { ...RIDE_TWO, boardLocation: undefined },
        ]),
        []
      );
    },
  ],
  // ── WHEN the breakdown shows: active on this leg, or tapped ──
  [
    "underway: now inside the leg's window is ON this leg",
    () => {
      const at = (hhmm: string) => Date.parse(`2026-07-03T${hhmm}:00-04:00`);
      const leg = { leaveISO: LEAVE, arriveISO: ARRIVE }; // 19:00 → 19:47
      assert.strictEqual(legUnderway(leg, at("19:30")), true);
      assert.strictEqual(legUnderway(leg, at("18:59")), false, "not yet left");
      assert.strictEqual(legUnderway(leg, at("19:50")), false, "already arrived");
    },
  ],
  [
    "underway: the window is half-open [leave, arrive) — the same shape a stop's status has",
    () => {
      const leg = { leaveISO: LEAVE, arriveISO: ARRIVE };
      assert.strictEqual(legUnderway(leg, Date.parse(LEAVE)), true, "you are on it the moment you leave");
      assert.strictEqual(
        legUnderway(leg, Date.parse(ARRIVE)),
        false,
        "the instant you arrive belongs to the venue, not the ride"
      );
    },
  ],
  [
    "underway: a window that cannot be READ contains nothing",
    () => {
      assert.strictEqual(legUnderway({ leaveISO: null, arriveISO: ARRIVE }, Date.parse(LEAVE)), false);
      assert.strictEqual(legUnderway({ leaveISO: LEAVE }, Date.parse(LEAVE)), false);
      assert.strictEqual(legUnderway({ leaveISO: "whenever", arriveISO: ARRIVE }, Date.parse(LEAVE)), false);
      assert.strictEqual(legUnderway({ leaveISO: LEAVE, arriveISO: ARRIVE }, NaN), false);
    },
  ],
  [
    "show rule: ACTIVE shows the full breakdown with no tap",
    () => {
      assert.strictEqual(
        shouldShowTimeline({
          isTransit: true,
          hasTimeline: true,
          isActiveNow: true,
          isSelected: false,
        }),
        true
      );
    },
  ],
  [
    "show rule: SELECTED shows it on a leg nobody is riding yet",
    () => {
      assert.strictEqual(
        shouldShowTimeline({
          isTransit: true,
          hasTimeline: true,
          isActiveNow: false,
          isSelected: true,
        }),
        true
      );
    },
  ],
  [
    "show rule: BOTH is not a conflict — it is just shown",
    () => {
      assert.strictEqual(
        shouldShowTimeline({
          isTransit: true,
          hasTimeline: true,
          isActiveNow: true,
          isSelected: true,
        }),
        true
      );
    },
  ],
  [
    "show rule: NEITHER is the compact card",
    () => {
      assert.strictEqual(
        shouldShowTimeline({
          isTransit: true,
          hasTimeline: true,
          isActiveNow: false,
          isSelected: false,
        }),
        false
      );
    },
  ],
  [
    "show rule: a NON-TRANSIT leg never opens, whatever the clock or the tap say",
    () => {
      for (const isActiveNow of [true, false]) {
        for (const isSelected of [true, false]) {
          assert.strictEqual(
            shouldShowTimeline({
              isTransit: false,
              hasTimeline: true,
              isActiveNow,
              isSelected,
            }),
            false,
            "a walk has no rides to break down"
          );
        }
      }
    },
  ],
  [
    "show rule: NO USABLE TIMES stays on the single line — being on it cannot conjure a timetable",
    () => {
      for (const isActiveNow of [true, false]) {
        for (const isSelected of [true, false]) {
          assert.strictEqual(
            shouldShowTimeline({
              isTransit: true,
              hasTimeline: false,
              isActiveNow,
              isSelected,
            }),
            false
          );
        }
      }
    },
  ],
  [
    "show rule end to end: a stale leg falls back even while it is being ridden",
    () => {
      // the staleness shape above (a board time before you leave), on a leg
      // whose window contains now: the guard still wins
      const stale = buildTransitTimeline({
        leaveISO: "2026-07-03T19:20:00-04:00",
        arriveISO: ARRIVE,
        rides: [RIDE_ONE],
      });
      assert.strictEqual(stale, null);
      assert.strictEqual(
        shouldShowTimeline({
          isTransit: true,
          hasTimeline: stale !== null,
          isActiveNow: legUnderway(
            { leaveISO: "2026-07-03T19:20:00-04:00", arriveISO: ARRIVE },
            Date.parse("2026-07-03T19:30:00-04:00")
          ),
          isSelected: true,
        }),
        false
      );
    },
  ],
  [
    "transfers: a malformed coordinate is treated as absent, not drawn",
    () => {
      const junk = { latitude: 43.66, longitude: 900 } as { latitude: number; longitude: number };
      assert.deepStrictEqual(
        transferPoints([
          { ...RIDE_ONE, alightLocation: junk },
          { ...RIDE_TWO, boardLocation: junk },
        ]),
        []
      );
      // ...and when only the preferred one is junk, the other still stands
      const points = transferPoints([
        { ...RIDE_ONE, alightLocation: junk },
        RIDE_TWO,
      ]);
      assert.deepStrictEqual(
        [points[0].latitude, points[0].longitude],
        [43.6626, -79.4264]
      );
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
