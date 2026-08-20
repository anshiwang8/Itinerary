// Route-badge grouping, labels + the inline badge/place split — the pure
// half of the coloured-circle treatment, tested independent of the
// rendering (real Google routes rarely produce 3-4-ride legs on demand, so
// the rules are pinned here exactly).
// Run with: npx tsx app/lib/transitBubbles.test.ts
import assert from "node:assert";
import {
  bubbleDisplayColors,
  bubbleLabel,
  groupBubbleUnits,
  lineBadges,
  linePlace,
} from "./transitBubbles";

const cases: Array<[string, () => void]> = [
  [
    "grouping: 0 rides → no units (walk legs keep their glyph)",
    () => {
      assert.deepStrictEqual(groupBubbleUnits([]), []);
    },
  ],
  [
    "grouping: 1 ride → one full-size single (today's badge, now the n=1 case)",
    () => {
      assert.deepStrictEqual(groupBubbleUnits(["a"]), [["a"]]);
    },
  ],
  [
    "grouping: 2 rides → one stacked pair",
    () => {
      assert.deepStrictEqual(groupBubbleUnits(["a", "b"]), [["a", "b"]]);
    },
  ],
  [
    "grouping: 3 rides → one pair + one full-size single, leftover LAST",
    () => {
      assert.deepStrictEqual(groupBubbleUnits(["a", "b", "c"]), [["a", "b"], ["c"]]);
    },
  ],
  [
    "grouping: 4 rides → two stacked pairs",
    () => {
      assert.deepStrictEqual(groupBubbleUnits(["a", "b", "c", "d"]), [
        ["a", "b"],
        ["c", "d"],
      ]);
    },
  ],
  [
    "grouping: 5 rides → two pairs + the leftover single, order preserved throughout",
    () => {
      assert.deepStrictEqual(groupBubbleUnits(["a", "b", "c", "d", "e"]), [
        ["a", "b"],
        ["c", "d"],
        ["e"],
      ]);
    },
  ],
  [
    "labels: agency short name wins; initials when unpublished; never blank",
    () => {
      assert.strictEqual(bubbleLabel({ lineName: "1 Yonge - University", shortName: "1" }), "1");
      assert.strictEqual(bubbleLabel({ lineName: "501 Queen", shortName: "501" }), "501");
      // no short name → initials from the line name
      assert.strictEqual(bubbleLabel({ lineName: "Lakeshore West", shortName: null }), "LW");
      assert.strictEqual(bubbleLabel({ lineName: "Carlton" }), "C");
      // an over-long short designation is clipped to circle width
      assert.strictEqual(bubbleLabel({ lineName: "Express", shortName: "EXPRESS" }), "EXPR");
      // nothing published at all → the transit fallback, never a blank dot
      assert.strictEqual(bubbleLabel({ lineName: "" }), "T");
    },
  ],

  // ── the inline split: the badge says the route, the text says the place ──
  [
    "MULTI-RIDE: an ordered badge+place per ride — arrows are what sits BETWEEN them",
    () => {
      const model = lineBadges([
        { lineName: "091 Bayview", shortName: "091", color: "#ed1c24" },
        { lineName: "1 Yonge - University", shortName: "1", color: "#f2c10b" },
      ]);
      assert.deepStrictEqual(
        model.map((m) => [m.badge, m.place]),
        [
          ["091", "Bayview"],
          ["1", "Yonge - University"],
        ]
      );
      // two entries → exactly one arrow between them; riding order kept
      assert.strictEqual(model.length, 2);
      // the segment travels with the badge, so colour and tooltip come off
      // the same ride the badge does
      assert.strictEqual(model[0].segment.color, "#ed1c24");
      assert.strictEqual(model[1].segment.lineName, "1 Yonge - University");
    },
  ],
  [
    "ride metadata reaches the bubble model but never becomes user-facing badge/place text",
    () => {
      const ride = {
        lineName: "091 Bayview",
        shortName: "091",
        color: "#ed1c24",
        textColor: "#ffffff",
        rideId: "ride_internal_sentinel",
        sourceStepIndex: 17,
        paletteSlot: 23,
      };
      const [line] = lineBadges([ride]);

      // The bubble model keeps the exact ride/fact object, including the
      // additive app-owned fields and the provider's published colours.
      assert.strictEqual(line.segment, ride);
      assert.deepStrictEqual(
        [line.segment.rideId, line.segment.sourceStepIndex, line.segment.paletteSlot],
        ["ride_internal_sentinel", 17, 23]
      );
      assert.deepStrictEqual(
        [line.segment.color, line.segment.textColor],
        ["#ed1c24", "#ffffff"]
      );

      // Only agency-facing route words are projected into visible copy.
      assert.deepStrictEqual([line.badge, line.place], ["091", "Bayview"]);
      const visibleText = [line.badge, line.place].filter(Boolean).join(" ");
      assert.ok(!visibleText.includes("ride_internal_sentinel"));
      assert.ok(!visibleText.includes("17"));
      assert.ok(!visibleText.includes("23"));
    },
  ],
  [
    "a slotted ride ignores provider colors and always uses its app color with white text",
    () => {
      const first = bubbleDisplayColors({
        lineName: "501 Queen",
        color: "#DA291C",
        textColor: "#111111",
        rideId: "ride-slotted",
        sourceStepIndex: 4,
        paletteSlot: 0,
      });
      const providerChanged = bubbleDisplayColors({
        lineName: "501 Queen",
        color: "#00FF00",
        textColor: "#F2C10B",
        rideId: "ride-slotted",
        sourceStepIndex: 4,
        paletteSlot: 0,
      });

      assert.deepStrictEqual(first, {
        background: "#005A9C",
        foreground: "#FFFFFF",
      });
      assert.deepStrictEqual(providerChanged, first);
    },
  ],
  [
    "two rides with the same provider red but different slots display different colors",
    () => {
      const provider = { color: "#DA291C", textColor: "#000000" };
      const first = bubbleDisplayColors({
        lineName: "501 Queen",
        ...provider,
        rideId: "ride-501-occurrence",
        sourceStepIndex: 1,
        paletteSlot: 0,
      });
      const second = bubbleDisplayColors({
        lineName: "504 King",
        ...provider,
        rideId: "ride-504-occurrence",
        sourceStepIndex: 4,
        paletteSlot: 1,
      });

      assert.deepStrictEqual(first, {
        background: "#005A9C",
        foreground: "#FFFFFF",
      });
      assert.deepStrictEqual(second, {
        background: "#9A4D00",
        foreground: "#FFFFFF",
      });
      assert.notStrictEqual(first.background, second.background);
    },
  ],
  [
    "legacy and explicit-overflow rides retain the exact provider fallback",
    () => {
      const provider = {
        lineName: "501 Queen",
        color: "#DA291C",
        textColor: "#101010",
      };
      const legacy = bubbleDisplayColors(provider);
      const overflow = bubbleDisplayColors({
        ...provider,
        rideId: "ride-overflow",
        sourceStepIndex: 24,
        paletteSlot: null,
      });

      assert.deepStrictEqual(legacy, {
        background: "#DA291C",
        foreground: "#101010",
      });
      assert.deepStrictEqual(overflow, legacy);
      assert.deepStrictEqual(bubbleDisplayColors({ lineName: "uncolored" }), {
        background: "var(--ink)",
        foreground: "#FFFFFF",
      });
    },
  ],
  [
    "SINGLE-RIDE: one badge, one place, and nothing to draw an arrow between",
    () => {
      const model = lineBadges([{ lineName: "505 Fixture", shortName: "505" }]);
      assert.strictEqual(model.length, 1);
      assert.strictEqual(model[0].badge, "505");
      assert.strictEqual(model[0].place, "Fixture");
    },
  ],
  [
    "WALK (or a plan stored before segments existed): no rides → NO badge at all",
    () => {
      assert.deepStrictEqual(lineBadges([]), []);
    },
  ],
  [
    "the route number is never printed twice — the badge is the identifier now",
    () => {
      assert.strictEqual(linePlace({ lineName: "091 Bayview", shortName: "091" }), "Bayview");
      assert.strictEqual(linePlace({ lineName: "63 Ossington", shortName: "63" }), "Ossington");
      // the designation written the OTHER way agencies write it
      assert.strictEqual(
        linePlace({ lineName: "Line 2 Bloor–Danforth", shortName: "2" }),
        "Bloor–Danforth"
      );
      // ...and with a separator left behind by the cut
      assert.strictEqual(linePlace({ lineName: "501 - Queen", shortName: "501" }), "Queen");
    },
  ],
  [
    "MISSING short name: the badge falls back to initials and the name stands WHOLE",
    () => {
      const [line] = lineBadges([{ lineName: "Lakeshore West", shortName: null }]);
      assert.strictEqual(line.badge, "LW");
      assert.strictEqual(
        line.place,
        "Lakeshore West",
        "the badge is not in the name, so nothing may be cut off it"
      );
      // a truncated designation is not in the name either — same rule
      assert.strictEqual(linePlace({ lineName: "Express", shortName: "EXPRESS" }), "Express");
      // nothing published at all: a "T" badge, and no place to print
      assert.deepStrictEqual(lineBadges([{ lineName: "" }]), [
        { segment: { lineName: "" }, badge: "T", place: null },
      ]);
    },
  ],
  [
    "a name that is ONLY the designation leaves the badge to say it alone",
    () => {
      assert.strictEqual(linePlace({ lineName: "Line 2", shortName: "2" }), null);
      assert.strictEqual(linePlace({ lineName: "505", shortName: "505" }), null);
    },
  ],
  [
    "the designation is looked for at the FRONT only — a match deeper in is a coincidence",
    () => {
      assert.strictEqual(
        linePlace({ lineName: "Queen West to 501 Loop", shortName: "501" }),
        "Queen West to 501 Loop",
        "cutting at the third token would eat words the badge never said"
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
