// Unit tests for durations + scheduling (step 6a).
// Run with: npx tsx app/api/schedule/schedule.test.ts
import assert from "node:assert";
import { DURATION_TABLE, getDuration, resolveCategory } from "./durations";
import {
  buildSchedule,
  IMPLAUSIBLE_TIME_MESSAGE,
  resolveStartTime,
  resolveStartTimeChecked,
} from "./schedule";
import { TravelLeg } from "./travel";

// Fixed "now": Friday 2026-07-03 13:20 local (EDT, -04:00).
const NOW = new Date(2026, 6, 3, 13, 20, 0);

const cases: Array<[string, () => void]> = [
  [
    "resolver: cuisine + free-vocab categories map to table keys",
    () => {
      assert.strictEqual(resolveCategory("ramen"), "restaurant");
      assert.strictEqual(resolveCategory("fine dining"), "restaurant");
      assert.strictEqual(resolveCategory("tacos"), "restaurant");
      assert.strictEqual(resolveCategory("cocktails"), "bar");
      assert.strictEqual(resolveCategory("pub"), "bar");
      assert.strictEqual(resolveCategory("coffee shop"), "coffee shop");
      assert.strictEqual(resolveCategory("matcha cafe"), "coffee shop");
      assert.strictEqual(resolveCategory("gelato"), "dessert");
      assert.strictEqual(resolveCategory("art gallery"), "museum");
      assert.strictEqual(resolveCategory("walk in the park"), "park");
      assert.strictEqual(resolveCategory("movie"), "movie");
    },
  ],
  [
    "resolver: unknown category → default",
    () => {
      assert.strictEqual(resolveCategory("axe throwing"), "default");
      assert.strictEqual(resolveCategory(""), "default");
    },
  ],
  [
    "duration math: resolved categories return the right table entries",
    () => {
      assert.deepStrictEqual(getDuration("ramen"), { baseMinutes: 90, bufferMinutes: 15 });
      assert.deepStrictEqual(getDuration("cocktails"), { baseMinutes: 60, bufferMinutes: 10 });
      assert.deepStrictEqual(getDuration("axe throwing"), DURATION_TABLE.default);
    },
  ],
  [
    "day-part defaults: evening → 19:00, tonight → 20:00 (same day)",
    () => {
      assert.strictEqual(
        resolveStartTime("evening", NOW).toISOString(),
        new Date(2026, 6, 3, 19, 0, 0).toISOString()
      );
      assert.strictEqual(
        resolveStartTime("tonight", NOW).toISOString(),
        new Date(2026, 6, 3, 20, 0, 0).toISOString()
      );
      assert.strictEqual(
        resolveStartTime("tomorrow morning", NOW).toISOString(),
        new Date(2026, 6, 4, 10, 0, 0).toISOString()
      );
    },
  ],
  [
    "day-part already past rolls to the NEXT day (morning asked at 13:20)",
    () => {
      // 10:00 today is already past at 13:20 → tomorrow 10:00
      assert.strictEqual(
        resolveStartTime("morning", NOW).toISOString(),
        new Date(2026, 6, 4, 10, 0, 0).toISOString()
      );
      // clock time already past rolls too: "6am" asked at 13:20
      assert.strictEqual(
        resolveStartTime("6am", NOW).toISOString(),
        new Date(2026, 6, 4, 6, 0, 0).toISOString()
      );
    },
  ],
  [
    "unspecified → next full hour from now (13:20 → 14:00)",
    () => {
      assert.strictEqual(
        resolveStartTime("unspecified", NOW).toISOString(),
        new Date(2026, 6, 3, 14, 0, 0).toISOString()
      );
    },
  ],
  [
    "category-aware default: brunch-unspecified → 10:30 (same day at 3 AM, rolled when past)",
    () => {
      const threeAM = new Date(2026, 6, 3, 3, 0, 0);
      // at 3 AM, 10:30 is still ahead → today 10:30
      assert.strictEqual(
        resolveStartTime("unspecified", threeAM, ["brunch", "beach walk"]).toISOString(),
        new Date(2026, 6, 3, 10, 30, 0).toISOString()
      );
      // at 13:20, 10:30 is past → rolls to tomorrow 10:30
      assert.strictEqual(
        resolveStartTime("unspecified", NOW, ["brunch"]).toISOString(),
        new Date(2026, 6, 4, 10, 30, 0).toISOString()
      );
    },
  ],
  [
    "category defaults: coffee 10:00, bar 20:00, club 22:00, comedy club 20:00 (show wins over club)",
    () => {
      const threeAM = new Date(2026, 6, 3, 3, 0, 0);
      const at = (cats: string[]) =>
        resolveStartTime("unspecified", threeAM, cats).toISOString();
      assert.strictEqual(at(["coffee shop"]), new Date(2026, 6, 3, 10, 0, 0).toISOString());
      assert.strictEqual(at(["cocktail bar"]), new Date(2026, 6, 3, 20, 0, 0).toISOString());
      assert.strictEqual(at(["night club"]), new Date(2026, 6, 3, 22, 0, 0).toISOString());
      assert.strictEqual(at(["comedy club"]), new Date(2026, 6, 3, 20, 0, 0).toISOString());
      assert.strictEqual(at(["ramen"]), new Date(2026, 6, 3, 19, 0, 0).toISOString());
      // unknown category → next full hour (3:00 → 4:00)
      assert.strictEqual(at(["axe throwing"]), new Date(2026, 6, 3, 4, 0, 0).toISOString());
    },
  ],
  [
    "anchor = earliest matching category: 'dessert then dinner' → 19:00, not 20:00 or 4 AM",
    () => {
      const threeAM = new Date(2026, 6, 3, 3, 0, 0);
      // dessert matches (20:00), dinner matches (19:00) → earliest wins
      assert.strictEqual(
        resolveStartTime("unspecified", threeAM, ["dessert", "dinner"]).toISOString(),
        new Date(2026, 6, 3, 19, 0, 0).toISOString()
      );
      // dessert alone anchors at its own 20:00; ice cream at 15:00
      assert.strictEqual(
        resolveStartTime("unspecified", threeAM, ["dessert"]).toISOString(),
        new Date(2026, 6, 3, 20, 0, 0).toISOString()
      );
      assert.strictEqual(
        resolveStartTime("unspecified", threeAM, ["ice cream"]).toISOString(),
        new Date(2026, 6, 3, 15, 0, 0).toISOString()
      );
      // unmatched first category no longer poisons the anchor
      assert.strictEqual(
        resolveStartTime("unspecified", threeAM, ["escape room", "ramen"]).toISOString(),
        new Date(2026, 6, 3, 19, 0, 0).toISOString()
      );
    },
  ],
  [
    "ONLY unmatched categories still fall to next full hour",
    () => {
      const threeAM = new Date(2026, 6, 3, 3, 0, 0);
      assert.strictEqual(
        resolveStartTime("unspecified", threeAM, ["axe throwing", "escape room"]).toISOString(),
        new Date(2026, 6, 3, 4, 0, 0).toISOString()
      );
    },
  ],
  [
    "4 AM 'dinner': category default → 7 PM today, NOT 4 AM (checked resolver passes)",
    () => {
      const fourAM = new Date(2026, 6, 3, 4, 0, 0);
      const res = resolveStartTimeChecked("unspecified", fourAM, ["dinner"]);
      assert.strictEqual(res.ok, true);
      if (res.ok) {
        assert.strictEqual(
          res.start.toISOString(),
          new Date(2026, 6, 3, 19, 0, 0).toISOString()
        );
      }
    },
  ],
  [
    "MULTI-CITY: 'lunch now' resolves to a LOCAL noon-ish hour per city, not Toronto's",
    () => {
      // one absolute instant: 2026-07-11 16:20 UTC = 12:20 EDT Toronto / 09:20 PDT Vancouver
      const inst = new Date("2026-07-11T16:20:00Z");
      // Toronto: lunch default 12:00 already passed (12:20) → rolls to tomorrow noon EDT
      const tor = resolveStartTime("unspecified", inst, ["lunch"], "America/Toronto");
      assert.strictEqual(tor.toISOString(), "2026-07-12T16:00:00.000Z"); // noon EDT next day
      // Vancouver: it's only 09:20 there → lunch noon TODAY, Pacific
      const van = resolveStartTime("unspecified", inst, ["lunch"], "America/Vancouver");
      assert.strictEqual(van.toISOString(), "2026-07-11T19:00:00.000Z"); // 12:00 PDT today
      // sanity: the Vancouver start's LOCAL hour is noon, not Toronto's 15:00
      assert.strictEqual(
        van.toLocaleString("en-US", { timeZone: "America/Vancouver", hour: "numeric", hour12: false }),
        "12"
      );
    },
  ],
  [
    "MULTI-CITY: plausibility band judged in the plan's zone (independent of runner TZ)",
    () => {
      // an explicit 8pm dinner is fine in Vancouver's own clock
      const inst = new Date("2026-07-11T16:00:00Z");
      const ok = resolveStartTimeChecked("8pm", inst, ["dinner"], "America/Vancouver");
      assert.strictEqual(ok.ok, true);
      // 4am dinner refused, and the message quotes the LOCAL hour "4 AM"
      const bad = resolveStartTimeChecked("4am", inst, ["dinner"], "America/Vancouver");
      assert.strictEqual(bad.ok, false);
      if (!bad.ok) assert.match(bad.reason, /Couldn't plan a 4 AM dinner/);
    },
  ],
  [
    "CONTRACT (mentor repro): 'plan a lunch' at 11:20 AM → SAME-DAY noon",
    () => {
      // real Groq for "plan a lunch" returns time_window "unspecified" (or
      // "today, lunchtime"), categories ["lunch"] — both must land noon today
      const at1120 = new Date(2026, 6, 11, 11, 20, 0);
      for (const tw of ["unspecified", "today, lunchtime", "lunch"]) {
        const r = resolveStartTimeChecked(tw, at1120, ["lunch"]);
        assert.strictEqual(r.ok, true, `"${tw}" refused`);
        if (r.ok) {
          assert.strictEqual(
            r.start.toISOString(),
            new Date(2026, 6, 11, 12, 0, 0).toISOString(),
            `"${tw}" resolved off same-day noon`
          );
        }
      }
    },
  ],
  [
    "CONTRACT (mentor repro): 'plan a lunch' at 9 PM → NEXT-DAY noon",
    () => {
      const at9pm = new Date(2026, 6, 11, 21, 0, 0);
      const r = resolveStartTimeChecked("unspecified", at9pm, ["lunch"]);
      assert.strictEqual(r.ok, true);
      if (r.ok) {
        assert.strictEqual(
          r.start.toISOString(),
          new Date(2026, 6, 12, 12, 0, 0).toISOString()
        );
      }
    },
  ],
  [
    "CONTRACT: past-resolving time references roll forward on BOTH branches",
    () => {
      const at5pm = new Date(2026, 6, 11, 17, 0, 0);
      // day-part branch: "afternoon" (14:00) asked at 5 PM → tomorrow 14:00
      assert.strictEqual(
        resolveStartTime("afternoon", at5pm, []).toISOString(),
        new Date(2026, 6, 12, 14, 0, 0).toISOString()
      );
      // category-inferred branch: brunch (10:30) asked at 5 PM → tomorrow 10:30
      assert.strictEqual(
        resolveStartTime("unspecified", at5pm, ["brunch"]).toISOString(),
        new Date(2026, 6, 12, 10, 30, 0).toISOString()
      );
    },
  ],
  [
    "park prompts anchor immediately and pass their dawn-to-dusk band",
    () => {
      // no category default → next full hour; the park band (6–22) accepts
      // early-morning and daytime immediate slots the generic band refused
      const at5am = new Date(2026, 6, 11, 5, 10, 0);
      const early = resolveStartTimeChecked("unspecified", at5am, ["park"]);
      assert.strictEqual(early.ok, true);
      if (early.ok) {
        assert.strictEqual(early.start.toISOString(), new Date(2026, 6, 11, 6, 0, 0).toISOString());
      }
      const midday = resolveStartTimeChecked("unspecified", new Date(2026, 6, 11, 12, 20, 0), ["park"]);
      assert.strictEqual(midday.ok, true);
      // a midnight park sit still honestly refuses
      const late = resolveStartTimeChecked("unspecified", new Date(2026, 6, 11, 23, 30, 0), ["park"]);
      assert.strictEqual(late.ok, false);
    },
  ],
  [
    "explicit 'now' → next full hour, overriding category defaults",
    () => {
      const t = new Date(2026, 6, 11, 15, 20, 0); // 3:20 PM
      // a clarify "now" answer on a dinner-ish parse must anchor
      // immediately, not at dinner's 19:00 default
      assert.strictEqual(
        resolveStartTime("now", t, ["dinner"]).toISOString(),
        new Date(2026, 6, 11, 16, 0, 0).toISOString()
      );
      // midday "now" passes the checked resolver
      const ok = resolveStartTimeChecked("now", t, []);
      assert.strictEqual(ok.ok, true);
      // 3 AM "now" is refused with the SPECIFIC nothing-open message —
      // never the "add a time" one (the user just gave a time)
      const late = resolveStartTimeChecked("now", new Date(2026, 6, 11, 2, 57, 0), []);
      assert.strictEqual(late.ok, false);
      if (!late.ok) {
        assert.match(late.reason, /nothing much is open then/);
        assert.notStrictEqual(late.reason, IMPLAUSIBLE_TIME_MESSAGE);
      }
    },
  ],
  [
    "CONTRACT: no time signal + no category match → next full hour (immediate)",
    () => {
      const t = new Date(2026, 6, 11, 13, 20, 0);
      assert.strictEqual(
        resolveStartTime("unspecified", t, ["axe throwing"]).toISOString(),
        new Date(2026, 6, 11, 14, 0, 0).toISOString()
      );
      // KNOWN INTERACTION (flagged for the ambiguous-prompt work, not fixed
      // here): late at night the immediate slot falls outside the generic
      // 8–23 band and the checked resolver refuses it — a vague prompt at
      // 11:30 PM cannot get an immediate itinerary today.
      const late = new Date(2026, 6, 11, 23, 30, 0);
      const r = resolveStartTimeChecked("unspecified", late, ["axe throwing"]);
      assert.strictEqual(r.ok, false);
    },
  ],
  [
    "4 AM 'axe throwing' (no default): plausible-band check fails loud",
    () => {
      const fourAM = new Date(2026, 6, 3, 4, 0, 0);
      // next-full-hour would book 5 AM — outside the generic 8–23 band
      const res = resolveStartTimeChecked("unspecified", fourAM, ["axe throwing"]);
      assert.deepStrictEqual(res, { ok: false, reason: IMPLAUSIBLE_TIME_MESSAGE });
    },
  ],
  [
    "checked resolver: sane inferred, plausible explicit, and day-part times pass",
    () => {
      // 13:20 → next full hour 14:00, inside the generic band
      const NOW = new Date(2026, 6, 3, 13, 20, 0);
      const sane = resolveStartTimeChecked("unspecified", NOW, ["axe throwing"]);
      assert.strictEqual(sane.ok, true);
      // explicit clock time inside the category's band passes
      const fourAM = new Date(2026, 6, 3, 3, 0, 0);
      const explicit = resolveStartTimeChecked("7pm", fourAM, ["dinner"]);
      assert.strictEqual(explicit.ok, true);
      // stated day-part passes too (morning → 10:00, generic band)
      const dayPart = resolveStartTimeChecked("morning", fourAM, ["axe throwing"]);
      assert.strictEqual(dayPart.ok, true);
      // club at 22:00 is inside its own (midnight-wrapping) band
      const club = resolveStartTimeChecked("unspecified", fourAM, ["night club"]);
      assert.strictEqual(club.ok, true);
      // 1 AM drinks: inside the bar band's past-midnight wrap
      const lateBar = resolveStartTimeChecked("1am", fourAM, ["bar"]);
      assert.strictEqual(lateBar.ok, true);
    },
  ],
  [
    "explicit implausible times fail loud with the category's window (BUG 1)",
    () => {
      const now = new Date(2026, 6, 3, 1, 0, 0);
      // "brunch at 3am" — names brunch, its window, and says try LATER
      const brunch = resolveStartTimeChecked("3am", now, ["brunch"]);
      assert.strictEqual(brunch.ok, false);
      if (!brunch.ok) {
        assert.strictEqual(
          brunch.reason,
          "Couldn't plan a 3 AM brunch — brunch around here runs about 8 AM to 3 PM. Try a later time?"
        );
      }
      // "dinner at 4am" — same surface, dinner's window
      const dinner = resolveStartTimeChecked("4am", now, ["dinner"]);
      assert.strictEqual(dinner.ok, false);
      if (!dinner.ok) {
        assert.strictEqual(
          dinner.reason,
          "Couldn't plan a 4 AM dinner — dinner around here runs about 11 AM to 11 PM. Try a later time?"
        );
      }
      // past close (non-wrapping band) suggests EARLIER: brunch at 5 PM
      const lateBrunch = resolveStartTimeChecked("5pm", now, ["brunch"]);
      assert.strictEqual(lateBrunch.ok, false);
      if (!lateBrunch.ok) assert.match(lateBrunch.reason, /Try an earlier time\?$/);
      // explicit time, no banded category → generic honest message
      const generic = resolveStartTimeChecked("4am", now, ["axe throwing"]);
      assert.strictEqual(generic.ok, false);
      if (!generic.ok) {
        assert.strictEqual(
          generic.reason,
          "Couldn't plan that for 4 AM — nothing much is open then. Try a time between 8 AM and 11 PM?"
        );
      }
      // implausible DAY-PART hits the same surface ("brunch tonight")
      const evening = resolveStartTimeChecked("evening", now, ["brunch"]);
      assert.strictEqual(evening.ok, false);
      if (!evening.ok) assert.match(evening.reason, /brunch around here runs about 8 AM to 3 PM/);
    },
  ],
  [
    "explicit clock time and day-part both override category defaults",
    () => {
      const threeAM = new Date(2026, 6, 3, 3, 0, 0);
      assert.strictEqual(
        resolveStartTime("7pm", threeAM, ["brunch"]).toISOString(),
        new Date(2026, 6, 3, 19, 0, 0).toISOString()
      );
      assert.strictEqual(
        resolveStartTime("evening", threeAM, ["brunch"]).toISOString(),
        new Date(2026, 6, 3, 19, 0, 0).toISOString()
      );
    },
  ],
  [
    "clock-time path: 'tomorrow, 6am' → Saturday 06:00 via parseTargetTime",
    () => {
      assert.strictEqual(
        resolveStartTime("tomorrow, 6am", NOW).toISOString(),
        new Date(2026, 6, 4, 6, 0, 0).toISOString()
      );
      // bare duration numbers must NOT be mistaken for clock times
      assert.strictEqual(
        resolveStartTime("evening, 5 hours", NOW).toISOString(),
        new Date(2026, 6, 3, 19, 0, 0).toISOString()
      );
    },
  ],
  [
    "3-stop chain: sequential, non-overlapping, Toronto ISO, travel placeholder",
    () => {
      const { startISO, stops } = buildSchedule(
        [
          { category: "ramen", id: "r1", name: "Ramen Spot" },      // 90+15 = 105
          { category: "cocktails", id: "b1", name: "Cocktail Bar" }, // 60+10 = 70
          { category: "gelato", id: "d1", name: "Gelato Place" },    // 30+10 = 40
        ],
        "evening",
        NOW
      );
      assert.strictEqual(startISO, "2026-07-03T19:00:00-04:00");

      assert.strictEqual(stops[0].start_time, "2026-07-03T19:00:00-04:00");
      assert.strictEqual(stops[0].end_time, "2026-07-03T20:45:00-04:00");
      assert.strictEqual(stops[1].start_time, "2026-07-03T20:45:00-04:00");
      assert.strictEqual(stops[1].end_time, "2026-07-03T21:55:00-04:00");
      assert.strictEqual(stops[2].start_time, "2026-07-03T21:55:00-04:00");
      assert.strictEqual(stops[2].end_time, "2026-07-03T22:35:00-04:00");

      // sequential + non-overlapping with zero travel
      for (let i = 0; i < stops.length - 1; i++) {
        assert.strictEqual(stops[i].end_time, stops[i + 1].start_time);
        assert.strictEqual(stops[i].travelMinutesToNext, 0);
      }
      // last stop has no travel leg
      assert.strictEqual(stops[2].travelMinutesToNext, undefined);
      assert.deepStrictEqual(stops[0].durationMinutes, { base: 90, buffer: 15, total: 105 });
    },
  ],
  [
    "null-id selection passes through untimed without breaking the chain",
    () => {
      const { stops } = buildSchedule(
        [
          { category: "coffee shop", id: "c1", name: "Cafe" },
          { category: "bookstore", id: null, reason: "no venues survived filtering" },
        ],
        "morning",
        NOW
      );
      // "morning" at 13:20 rolls to tomorrow 10:00
      assert.strictEqual(stops[0].start_time, "2026-07-04T10:00:00-04:00");
      assert.strictEqual(stops[0].end_time, "2026-07-04T11:00:00-04:00");
      assert.strictEqual(stops[1].start_time, null);
      assert.strictEqual(stops[1].durationMinutes, null);
      // the only timed stop is also the last timed stop → no travel leg
      assert.strictEqual(stops[0].travelMinutesToNext, undefined);
    },
  ],
  [
    "home leg: resolved start = leave-home time, first stop starts after the leg",
    () => {
      const homeLeg: TravelLeg = {
        fromIndex: -1,
        mode: "transit",
        rawMinutes: 27,
        marginMinutes: 5,
        totalMinutes: 32,
        distanceMeters: 5200,
        encodedPolyline: "enc_home",
      };
      const walk10: TravelLeg = {
        fromIndex: 0,
        mode: "walk",
        rawMinutes: 10,
        marginMinutes: 0,
        totalMinutes: 10,
        distanceMeters: 800,
        encodedPolyline: null,
      };
      const { startISO, stops } = buildSchedule(
        [
          { category: "ramen", id: "r1", name: "Ramen Spot" }, // 90+15
          { category: "cocktails", id: "b1", name: "Cocktail Bar" },
        ],
        "evening",
        NOW,
        [walk10],
        undefined,
        homeLeg
      );
      // leave home at the resolved 19:00; arrive stop 1 at 19:32
      assert.strictEqual(startISO, "2026-07-03T19:00:00-04:00");
      assert.strictEqual(stops[0].start_time, "2026-07-03T19:32:00-04:00");
      assert.strictEqual(stops[0].end_time, "2026-07-03T21:17:00-04:00");
      // inter-stop legs unaffected: bar = ramen end + 10 min walk
      assert.strictEqual(stops[1].start_time, "2026-07-03T21:27:00-04:00");
      assert.strictEqual(stops[0].travelToNext, walk10);
    },
  ],
  [
    "no home leg → schedule unchanged (home is opt-in, reroute path untouched)",
    () => {
      const { startISO, stops } = buildSchedule(
        [{ category: "ramen", id: "r1", name: "Ramen Spot" }],
        "evening",
        NOW
      );
      assert.strictEqual(startISO, "2026-07-03T19:00:00-04:00");
      assert.strictEqual(stops[0].start_time, "2026-07-03T19:00:00-04:00");
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
