// The one-shot "Use current location" policy, proven without a DOM, a
// clock, or a real GPS: every decision in `currentLocation.ts` is a pure
// function of values passed in.
//
// What this suite is really pinning, in order of how expensive the bug
// would be: that a coordinate is never used while the field says something
// else (`startFixForField`), that a wildly imprecise reading is refused
// rather than silently becoming a starting point (`judgeFix`), and that a
// missing accuracy figure is NOT treated as a refusal (keep-on-missing).
import assert from "node:assert";
import {
  CURRENT_LOCATION_DENIED_NOTE,
  CURRENT_LOCATION_FALLBACK_LABEL,
  CURRENT_LOCATION_MAX_AGE_MS,
  CURRENT_LOCATION_POSITION_OPTIONS,
  CURRENT_LOCATION_TIMEOUT_NOTE,
  CURRENT_LOCATION_UNAVAILABLE_NOTE,
  CURRENT_LOCATION_UNUSABLE_NOTE,
  MAX_FIX_ACCURACY_METERS,
  describeAccuracy,
  geolocationErrorNote,
  judgeFix,
  startFixForField,
  startLabelFrom,
  type StartFix,
} from "./currentLocation";

type Case = [string, () => void];

const HERE = { latitude: 43.6547, longitude: -79.3862 };

function fix(accuracy: unknown) {
  return { ...HERE, accuracy };
}

const cases: Case[] = [
  // ── the accuracy gate ──
  [
    "a phone-grade fix passes and reports its own accuracy back",
    () => {
      const verdict = judgeFix(fix(18));
      assert.strictEqual(verdict.ok, true);
      if (!verdict.ok) return;
      assert.strictEqual(verdict.latitude, HERE.latitude);
      assert.strictEqual(verdict.longitude, HERE.longitude);
      assert.strictEqual(verdict.accuracyM, 18);
    },
  ],
  [
    "a degraded wifi fix in the hundreds of metres still passes",
    () => {
      assert.strictEqual(judgeFix(fix(650)).ok, true);
    },
  ],
  [
    "the threshold itself passes; one metre past it refuses",
    () => {
      // pinned on BOTH sides so the comparison can never silently flip to <
      assert.strictEqual(judgeFix(fix(MAX_FIX_ACCURACY_METERS)).ok, true);
      const past = judgeFix(fix(MAX_FIX_ACCURACY_METERS + 1));
      assert.strictEqual(past.ok, false);
      if (past.ok) return;
      assert.match(past.note, /within about/);
      assert.match(past.note, /type a starting address/i);
    },
  ],
  [
    "an IP-level reading names its own imprecision in the refusal",
    () => {
      const verdict = judgeFix(fix(11_400));
      assert.strictEqual(verdict.ok, false);
      if (verdict.ok) return;
      assert.match(verdict.note, /11 km/);
    },
  ],
  [
    "a MISSING accuracy figure passes: keep-on-missing-data, applied to a device",
    () => {
      for (const missing of [undefined, null, NaN, "far", -1]) {
        const verdict = judgeFix(fix(missing));
        assert.strictEqual(verdict.ok, true, `accuracy ${String(missing)}`);
        if (!verdict.ok) return;
        assert.strictEqual(verdict.accuracyM, null);
      }
    },
  ],
  [
    "a broken coordinate is refused, which is not the same as missing data",
    () => {
      const bad = [
        { latitude: NaN, longitude: -79.3, accuracy: 10 },
        { latitude: 43.6, longitude: Infinity, accuracy: 10 },
        { latitude: 91, longitude: -79.3, accuracy: 10 },
        { latitude: 43.6, longitude: -181, accuracy: 10 },
        { latitude: "43.6", longitude: -79.3, accuracy: 10 },
        { latitude: undefined, longitude: undefined, accuracy: 10 },
      ];
      for (const coords of bad) {
        const verdict = judgeFix(coords);
        assert.strictEqual(verdict.ok, false, JSON.stringify(coords));
        if (verdict.ok) return;
        assert.strictEqual(verdict.note, CURRENT_LOCATION_UNUSABLE_NOTE);
      }
    },
  ],
  [
    "0,0 is a real coordinate and is not confused with a missing one",
    () => {
      assert.strictEqual(judgeFix({ latitude: 0, longitude: 0, accuracy: 12 }).ok, true);
    },
  ],
  [
    "the threshold is injectable, so the policy number is not baked into the rule",
    () => {
      assert.strictEqual(judgeFix(fix(300), 100).ok, false);
      assert.strictEqual(judgeFix(fix(300), 500).ok, true);
    },
  ],

  // ── how an imprecision is spoken ──
  [
    "accuracy reads coarsely on purpose: metres below a km, km above it",
    () => {
      assert.strictEqual(describeAccuracy(12), "10 m");
      assert.strictEqual(describeAccuracy(340), "340 m");
      assert.strictEqual(describeAccuracy(999), "1000 m");
      assert.strictEqual(describeAccuracy(1_000), "1 km");
      assert.strictEqual(describeAccuracy(2_450), "2.5 km");
      assert.strictEqual(describeAccuracy(11_431), "11 km");
      // never "0 m", which would read as perfect precision
      assert.strictEqual(describeAccuracy(0), "10 m");
    },
  ],

  // ── the three failure modes ──
  [
    "each geolocation error code gets its own honest note",
    () => {
      assert.strictEqual(geolocationErrorNote(1), CURRENT_LOCATION_DENIED_NOTE);
      assert.strictEqual(geolocationErrorNote(2), CURRENT_LOCATION_UNAVAILABLE_NOTE);
      assert.strictEqual(geolocationErrorNote(3), CURRENT_LOCATION_TIMEOUT_NOTE);
    },
  ],
  [
    "an unknown or absent code degrades to unavailable rather than throwing",
    () => {
      for (const code of [undefined, null, 0, 99, "1"]) {
        assert.strictEqual(
          geolocationErrorNote(code),
          CURRENT_LOCATION_UNAVAILABLE_NOTE
        );
      }
    },
  ],
  [
    "every failure note points at typing an address, so the field is never a dead end",
    () => {
      for (const note of [
        CURRENT_LOCATION_DENIED_NOTE,
        CURRENT_LOCATION_TIMEOUT_NOTE,
        CURRENT_LOCATION_UNAVAILABLE_NOTE,
        CURRENT_LOCATION_UNUSABLE_NOTE,
      ]) {
        assert.match(note, /starting address/i);
      }
    },
  ],

  // ── the label ──
  [
    "a real formatted address becomes the field's text, trimmed",
    () => {
      assert.strictEqual(
        startLabelFrom("  Chestnut St, Toronto, ON  "),
        "Chestnut St, Toronto, ON"
      );
    },
  ],
  [
    "no usable name degrades to plain wording, never a coordinate or a guess",
    () => {
      for (const empty of [null, undefined, "", "   "]) {
        assert.strictEqual(startLabelFrom(empty), CURRENT_LOCATION_FALLBACK_LABEL);
      }
      assert.doesNotMatch(CURRENT_LOCATION_FALLBACK_LABEL, /\d/);
    },
  ],

  // ── the stale-coordinate guard (the expensive bug) ──
  [
    "the fix is used only while the field still reads exactly what it wrote",
    () => {
      const held: StartFix = { ...HERE, label: "Chestnut St, Toronto, ON" };
      assert.strictEqual(startFixForField(held, "Chestnut St, Toronto, ON"), held);
      // surrounding whitespace is the field's, not a different place
      assert.strictEqual(startFixForField(held, "  Chestnut St, Toronto, ON "), held);
    },
  ],
  [
    "any edit to the text drops the coordinate rather than planning from it",
    () => {
      const held: StartFix = { ...HERE, label: "Chestnut St, Toronto, ON" };
      for (const typed of [
        "Chestnut St, Toronto, O",
        "Chestnut St, Toronto, ON!",
        "100 Queen St W",
        "",
        "chestnut st, toronto, on",
      ]) {
        assert.strictEqual(startFixForField(held, typed), null, typed);
      }
    },
  ],
  [
    "no fix in hand is always null, whatever the field says",
    () => {
      assert.strictEqual(startFixForField(null, "Current location"), null);
      assert.strictEqual(startFixForField(null, ""), null);
    },
  ],
  [
    "the fallback label round-trips through the guard like any other",
    () => {
      // the "nothing usable came back" path still has to survive a replan
      const held: StartFix = { ...HERE, label: CURRENT_LOCATION_FALLBACK_LABEL };
      assert.strictEqual(
        startFixForField(held, CURRENT_LOCATION_FALLBACK_LABEL),
        held
      );
    },
  ],

  // ── the options actually handed to the browser ──
  [
    "a retry is meaningful: no cached fix is ever accepted",
    () => {
      // A cached reading would make the row's retry a lie, because a refused
      // coarse fix would come straight back inside the cache window.
      assert.strictEqual(CURRENT_LOCATION_MAX_AGE_MS, 0);
      assert.strictEqual(CURRENT_LOCATION_POSITION_OPTIONS.maximumAge, 0);
      assert.strictEqual(CURRENT_LOCATION_POSITION_OPTIONS.enableHighAccuracy, true);
      assert.ok((CURRENT_LOCATION_POSITION_OPTIONS.timeout ?? 0) > 0);
    },
  ],
];

function main() {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error instanceof Error ? error.stack : error}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
