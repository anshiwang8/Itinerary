// Unit tests for durations + scheduling (step 6a).
// Run with: npx tsx app/api/schedule/schedule.test.ts
import assert from "node:assert";
import { DURATION_TABLE, getDuration, resolveCategory } from "./durations";
import {
  buildSchedule,
  checkWindowFit,
  resolveStartTime,
  resolveStartTimeChecked,
  WINDOW_OVERRUN_TOLERANCE_MINUTES,
} from "./schedule";
import { TravelLeg } from "./travel";
import { wallClockParts } from "../../lib/zoneTime";

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
    "TOMORROW-FALLBACK REPRO: 'tomorrow' + no-default category lands TOMORROW morning, never tonight",
    () => {
      // The reported bug: "plan a full schedule for things to do as a
      // soccer fan tomorrow", typed at 11:38 PM. "soccer" matches nothing
      // in CATEGORY_START_DEFAULTS, so resolution fell through to the
      // final next-full-hour fallback — which dropped dayOffset and
      // produced an overnight plan at midnight instead of tomorrow.
      const lateEvening = new Date(2026, 6, 3, 23, 38, 0);
      assert.strictEqual(
        resolveStartTime("tomorrow", lateEvening, ["soccer"]).toISOString(),
        new Date(2026, 6, 4, 10, 0, 0).toISOString() // tomorrow 10:00, the morning anchor
      );
      // afternoon-typed variant: still tomorrow morning, never "today next full hour"
      assert.strictEqual(
        resolveStartTime("tomorrow", NOW, ["axe throwing"]).toISOString(),
        new Date(2026, 6, 4, 10, 0, 0).toISOString()
      );
    },
  ],
  [
    "ALL-DAY: 'tomorrow, all day' anchors tomorrow 11:00 — the food facet can't hijack the start",
    () => {
      // themed full-day expansion: the parse hands over several facets,
      // some with table defaults (restaurant 19:00). Before "all day"
      // was a day-part, the earliest-category anchor put a FULL DAY at
      // 7 PM — with the museum stop arriving after close.
      const themed = ["soccer stadium tour", "sports museum", "sports bar", "restaurant"];
      assert.strictEqual(
        resolveStartTime("tomorrow, all day", NOW, themed).toISOString(),
        new Date(2026, 6, 4, 11, 0, 0).toISOString()
      );
      // and the checked resolver PASSES at 11:00 — this pins the hour
      // choice: 10:00 would sit outside both matched food bands
      // (bar 11→2, restaurant 11→23) and refuse the whole themed plan
      const checked = resolveStartTimeChecked("tomorrow, all day", NOW, themed);
      assert.strictEqual(checked.ok, true);
      // a specific day-part beats "all day" when both appear
      assert.strictEqual(
        resolveStartTime("tonight, all day", NOW, themed).toISOString(),
        new Date(2026, 6, 3, 20, 0, 0).toISOString()
      );
    },
  ],
  [
    "tomorrow + table-matched category still uses the category default (regression)",
    () => {
      // this path already threaded dayOffset correctly — keep it that way
      assert.strictEqual(
        resolveStartTime("tomorrow", NOW, ["dinner"]).toISOString(),
        new Date(2026, 6, 4, 19, 0, 0).toISOString()
      );
    },
  ],
  [
    "explicit 'now' keeps ignoring day qualifiers (correct on purpose)",
    () => {
      // the immediate branch wins before day math — a clarify-stamped
      // "now" means NOW even if stray day words ride along
      assert.strictEqual(
        resolveStartTime("now, tomorrow", NOW, ["soccer"]).toISOString(),
        new Date(2026, 6, 3, 14, 0, 0).toISOString() // next full hour from 13:20
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
    "MULTI-CITY: an explicit clock time lands on the PLAN's wall clock, not the runner's",
    () => {
      // REWRITTEN 2026-07-27: this used to also assert that a 4 AM dinner
      // was REFUSED by the plausibility band. That verdict is gone — a 4 AM
      // dinner is now planned, and the objective hours filter decides
      // whether anything is actually open. What still matters, and is what
      // this case was really protecting, is that "8pm" means 8 PM in
      // Vancouver rather than 8 PM in Toronto or on the test runner.
      const inst = new Date("2026-07-11T16:00:00Z");
      const ok = resolveStartTimeChecked("8pm", inst, ["dinner"], "America/Vancouver");
      assert.strictEqual(ok.ok, true);
      if (ok.ok) {
        assert.strictEqual(wallClockParts(ok.start, "America/Vancouver").hour, 20);
      }
      // the unusual hour resolves rather than refusing, on the same clock
      const smallHours = resolveStartTimeChecked("4am", inst, ["dinner"], "America/Vancouver");
      assert.strictEqual(smallHours.ok, true);
      if (smallHours.ok) {
        assert.strictEqual(wallClockParts(smallHours.start, "America/Vancouver").hour, 4);
      }
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
    "park prompts anchor immediately at ANY hour — openness is a filter question",
    () => {
      // REWRITTEN 2026-07-27: the last assertion used to be "a midnight
      // park sit honestly refuses", from the park band (6–22). That was the
      // table's opinion. A 24-hour waterfront path exists; whether THIS park
      // is open at 23:30 is decided by the hours filter on real data, so the
      // resolver's only job here is the anchor.
      const at5am = new Date(2026, 6, 11, 5, 10, 0);
      const early = resolveStartTimeChecked("unspecified", at5am, ["park"]);
      assert.strictEqual(early.ok, true);
      if (early.ok) {
        assert.strictEqual(early.start.toISOString(), new Date(2026, 6, 11, 6, 0, 0).toISOString());
      }
      const midday = resolveStartTimeChecked("unspecified", new Date(2026, 6, 11, 12, 20, 0), ["park"]);
      assert.strictEqual(midday.ok, true);
      const late = resolveStartTimeChecked("unspecified", new Date(2026, 6, 11, 23, 30, 0), ["park"]);
      assert.strictEqual(late.ok, true);
      if (late.ok) {
        assert.strictEqual(late.start.toISOString(), new Date(2026, 6, 12, 0, 0, 0).toISOString());
      }
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
      // REWRITTEN 2026-07-27: 3 AM "now" used to be refused ("nothing much
      // is open then"). Someone typing "right now" at 3 AM means it — the
      // plan is built and the hours filter reports what is genuinely open.
      const late = resolveStartTimeChecked("now", new Date(2026, 6, 11, 2, 57, 0), []);
      assert.strictEqual(late.ok, true);
      if (late.ok) {
        assert.strictEqual(late.start.toISOString(), new Date(2026, 6, 11, 3, 0, 0).toISOString());
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
      // a vague/unrecognized request at 11:30 PM gets its immediate slot
      // (00:00). This once depended on the generic band happening to wrap
      // past midnight; with no band at all it simply resolves.
      const late = new Date(2026, 6, 11, 23, 30, 0);
      const r = resolveStartTimeChecked("unspecified", late, ["axe throwing"]);
      assert.strictEqual(r.ok, true);
      if (r.ok) {
        assert.strictEqual(r.start.toISOString(), new Date(2026, 6, 12, 0, 0, 0).toISOString());
      }
    },
  ],
  [
    "LATE-NIGHT (batch 4): a vague 'now' at 10:18 PM resolves instead of refusing",
    () => {
      // the reported repro: "now" rounds UP to 23:00 and the old 8–23 band
      // refused it by a minute of rounding. No categories = the general case.
      const t = new Date(2026, 6, 16, 22, 18, 0);
      const r = resolveStartTimeChecked("now", t, []);
      assert.strictEqual(r.ok, true);
      if (r.ok) assert.strictEqual(r.start.getHours(), 23);
      // and past midnight works — there is no longer an edge to fall off
      const midnight = resolveStartTimeChecked("now", new Date(2026, 6, 16, 23, 40, 0), []);
      assert.strictEqual(midnight.ok, true);
      // REWRITTEN 2026-07-27: the small hours used to be refused outright.
      // 24-hour venues exist; the hours filter is the honest judge.
      const threeAM = resolveStartTimeChecked("now", new Date(2026, 6, 16, 2, 57, 0), []);
      assert.strictEqual(threeAM.ok, true);
      if (threeAM.ok) assert.strictEqual(threeAM.start.getHours(), 3);
    },
  ],
  [
    "checked resolver: every well-formed time resolves to the instant it names",
    () => {
      // REWRITTEN 2026-07-27: these used to assert only `ok === true`, and
      // each comment explained which BAND the time fell inside. With no
      // bands, the meaningful assertion is the resolved instant itself.
      const NOW = new Date(2026, 6, 3, 13, 20, 0);
      const sane = resolveStartTimeChecked("unspecified", NOW, ["axe throwing"]);
      assert.strictEqual(sane.ok, true);
      if (sane.ok) {
        assert.strictEqual(sane.start.toISOString(), new Date(2026, 6, 3, 14, 0, 0).toISOString());
      }
      const threeAM = new Date(2026, 6, 3, 3, 0, 0);
      const explicit = resolveStartTimeChecked("7pm", threeAM, ["dinner"]);
      assert.strictEqual(explicit.ok, true);
      if (explicit.ok) {
        assert.strictEqual(explicit.start.toISOString(), new Date(2026, 6, 3, 19, 0, 0).toISOString());
      }
      const dayPart = resolveStartTimeChecked("morning", threeAM, ["axe throwing"]);
      assert.strictEqual(dayPart.ok, true);
      if (dayPart.ok) {
        assert.strictEqual(dayPart.start.toISOString(), new Date(2026, 6, 3, 10, 0, 0).toISOString());
      }
      const club = resolveStartTimeChecked("unspecified", threeAM, ["night club"]);
      assert.strictEqual(club.ok, true);
      const lateBar = resolveStartTimeChecked("1am", threeAM, ["bar"]);
      assert.strictEqual(lateBar.ok, true);
      if (lateBar.ok) {
        assert.strictEqual(lateBar.start.toISOString(), new Date(2026, 6, 4, 1, 0, 0).toISOString());
      }
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
    "RIGHT-NOW REPRO: time_window 'now' resolves to TONIGHT's next full hour, never tomorrow",
    () => {
      // the reported bug's shape: late evening, immediate request. Pre-fix
      // the parse LOST the immediacy ("unspecified"), the resolver fell to
      // the restaurant default 19:00 — already passed — and rolled the plan
      // to TOMORROW 7 PM. With time_window "now" the resolver books the
      // immediate slot tonight instead.
      const late = new Date(2026, 6, 3, 21, 15, 0); // Fri 21:15
      assert.strictEqual(
        resolveStartTime("now", late, ["restaurant"]).toISOString(),
        new Date(2026, 6, 3, 22, 0, 0).toISOString() // TONIGHT 22:00
      );
      // the buggy path, pinned for contrast: "unspecified" still rolls the
      // passed category default forward a day — which is exactly why losing
      // "right now" in the parse produced "tomorrow at 8"
      assert.strictEqual(
        resolveStartTime("unspecified", late, ["restaurant"]).toISOString(),
        new Date(2026, 6, 4, 19, 0, 0).toISOString() // tomorrow 19:00
      );
      // even past the category's band, "now" stays TONIGHT — the band check
      // then refuses honestly, which beats silently booking tomorrow
      const veryLate = new Date(2026, 6, 3, 23, 28, 0); // the reported 11:28 PM
      assert.strictEqual(
        resolveStartTime("now", veryLate, ["restaurant"]).toISOString(),
        new Date(2026, 6, 4, 0, 0, 0).toISOString() // midnight, ~32 min away
      );
    },
  ],
  [
    "CALENDAR: bare weekdays use the nearest future occurrence; next weekday is strict when today matches",
    () => {
      // NOW is Friday. A future clock on bare Friday stays today; a passed
      // clock rolls to the following Friday. "next Friday" is always +7.
      assert.strictEqual(
        resolveStartTime("Friday, 7pm", NOW).toISOString(),
        new Date(2026, 6, 3, 19, 0).toISOString()
      );
      assert.strictEqual(
        resolveStartTime("Friday, 10am", NOW).toISOString(),
        new Date(2026, 6, 10, 10, 0).toISOString()
      );
      assert.strictEqual(
        resolveStartTime("next Friday, 7pm", NOW).toISOString(),
        new Date(2026, 6, 10, 19, 0).toISOString()
      );
      assert.strictEqual(
        resolveStartTime("Monday, 7pm", NOW).toISOString(),
        new Date(2026, 6, 6, 19, 0).toISOString()
      );
    },
  ],
  [
    "CALENDAR: ISO and named dates combine with clocks in the plan zone",
    () => {
      assert.strictEqual(
        resolveStartTime("2026-08-15 at 19:30", NOW, [], "America/Toronto").toISOString(),
        "2026-08-15T23:30:00.000Z"
      );
      assert.strictEqual(
        resolveStartTime("August 15, 2026 at 7:30pm", NOW, [], "America/Toronto").toISOString(),
        "2026-08-15T23:30:00.000Z"
      );
      assert.strictEqual(
        resolveStartTime("15 August 2026 at 7:30pm", NOW, [], "America/Toronto").toISOString(),
        "2026-08-15T23:30:00.000Z"
      );
      assert.strictEqual(
        resolveStartTime("Friday 19", NOW, [], "America/Toronto").toISOString(),
        "2026-07-03T23:00:00.000Z"
      );
      assert.strictEqual(
        resolveStartTime("2026-08-15 19", NOW, [], "America/Toronto").toISOString(),
        "2026-08-15T23:00:00.000Z"
      );
      assert.strictEqual(
        resolveStartTime("August 15 19", NOW, [], "America/Toronto").toISOString(),
        "2026-08-15T23:00:00.000Z"
      );
      // Date components and durations are not clocks when no separate clock
      // token exists.
      assert.strictEqual(
        resolveStartTime("2026-08-15", NOW, [], "America/Toronto").toISOString(),
        "2026-08-15T14:00:00.000Z"
      );
      assert.strictEqual(
        resolveStartTime("August 15", NOW, [], "America/Toronto").toISOString(),
        "2026-08-15T14:00:00.000Z"
      );
      assert.strictEqual(
        resolveStartTime("Friday, 5 hours", NOW, [], "America/Toronto").toISOString(),
        "2026-07-10T14:00:00.000Z"
      );

      // REWRITTEN 2026-07-27: a bare hour after a weekday ("Monday 2") is
      // still READ as a clock time — that parsing contract is what this
      // case protects. It used to then be refused as an implausible 2 AM
      // dinner; now it simply resolves to Monday 02:00 local.
      const explicitBare = resolveStartTimeChecked(
        "Monday 2",
        NOW,
        ["dinner"],
        "America/Toronto"
      );
      assert.strictEqual(explicitBare.ok, true);
      if (explicitBare.ok) {
        assert.strictEqual(explicitBare.start.toISOString(), "2026-07-06T06:00:00.000Z");
      }
    },
  ],
  [
    "CALENDAR: invalid dates, ambiguous numeric dates, and impossible clocks fail loud",
    () => {
      for (const tw of [
        "February 30, 2027 at 7pm",
        "02/03/2027 at 7pm",
        "13pm",
        "00pm",
        "24:00",
        "7:5pm",
        "7:60",
        "-1pm",
        "at -1:30",
        "2026-08-150",
        "August 123",
        "August 15thh",
      ]) {
        const result = resolveStartTimeChecked(tw, NOW, ["dinner"]);
        assert.strictEqual(result.ok, false, `${tw} must be rejected`);
        if (!result.ok) assert.ok(result.reason.length > 20);
      }
      for (const tw of ["-1pm", "at -1:30"]) {
        const result = resolveStartTimeChecked(tw, NOW, ["dinner"]);
        assert.strictEqual(result.ok, false);
        if (!result.ok) assert.match(result.reason, /Couldn't understand the time/);
      }
      for (const tw of ["2026-08-150", "August 123", "August 15thh"]) {
        const result = resolveStartTimeChecked(tw, NOW, ["dinner"]);
        assert.strictEqual(result.ok, false);
        if (!result.ok) assert.match(result.reason, /calendar date/);
      }
    },
  ],
  [
    "CALENDAR: DST gaps reject and fall-back overlaps choose the earliest instant",
    () => {
      const beforeSpring = new Date("2026-03-07T17:00:00Z");
      const gap = resolveStartTimeChecked(
        "2026-03-08 at 2:30am",
        beforeSpring,
        ["coffee"],
        "America/Toronto"
      );
      assert.strictEqual(gap.ok, false);

      const beforeFall = new Date("2026-10-31T16:00:00Z");
      assert.strictEqual(
        resolveStartTime(
          "2026-11-01 at 1:30am",
          beforeFall,
          ["bar"],
          "America/Toronto"
        ).toISOString(),
        "2026-11-01T05:30:00.000Z"
      );
    },
  ],
  [
    "a stop's OWN duration wins over the table; the buffer stays ours",
    () => {
      const { stops } = buildSchedule(
        [
          // the LLM says this tasting-menu place needs 150, not the table's 90
          { category: "ramen", id: "r1", name: "Tasting Menu", plannedMinutes: 150 },
          // no estimate → DURATION_TABLE, exactly as before (bar = 60 + 10)
          { category: "cocktails", id: "b1", name: "Cocktail Bar" },
        ],
        "evening",
        NOW,
        [],
        undefined,
        null,
        "America/Toronto"
      );
      // base is the model's; buffer is the table's for the RESOLVED category
      // (restaurant = 15), because a buffer is our scheduling margin rather
      // than a judgment about the venue
      assert.deepStrictEqual(stops[0].durationMinutes, {
        base: 150,
        buffer: 15,
        total: 165,
      });
      assert.deepStrictEqual(stops[1].durationMinutes, {
        base: 60,
        buffer: 10,
        total: 70,
      });
      // and the chain actually MOVES by the refined length: 19:00 + 2h45
      assert.strictEqual(stops[0].start_time, "2026-07-03T19:00:00-04:00");
      assert.strictEqual(stops[0].end_time, "2026-07-03T21:45:00-04:00");
      assert.strictEqual(stops[1].start_time, "2026-07-03T21:45:00-04:00");
    },
  ],
  // ── window validation (Part 5): the planner PROPOSES how much fits;
  // code decides, here, once the real travel legs are known ──
  [
    "a stated 3-8 window fits several stops that end near 8",
    () => {
      // 3 PM start, three stops with real legs between them
      const start = new Date(2026, 6, 3, 15, 0, 0);
      const legs: TravelLeg[] = [
        { fromIndex: 0, mode: "transit", rawMinutes: 15, marginMinutes: 5, totalMinutes: 20, distanceMeters: 3000, encodedPolyline: null },
        { fromIndex: 1, mode: "walk", rawMinutes: 10, marginMinutes: 0, totalMinutes: 10, distanceMeters: 800, encodedPolyline: null },
      ];
      const { stops } = buildSchedule(
        [
          { category: "museum", id: "m1", name: "Museum", plannedMinutes: 90 },   // 90+15
          { category: "coffee shop", id: "c1", name: "Cafe", plannedMinutes: 45 }, // 45+10
          { category: "ramen", id: "r1", name: "Ramen", plannedMinutes: 90 },      // 90+15
        ],
        "",
        NOW,
        legs,
        start,
        null,
        "America/Toronto"
      );
      // 15:00 +105 =16:45, +20 travel =17:05 +55 =18:00, +10 travel =18:10 +105 =19:55
      assert.strictEqual(stops[2].end_time, "2026-07-03T19:55:00-04:00");
      const fit = checkWindowFit(stops, "2026-07-03T20:00:00-04:00");
      assert.ok(fit);
      assert.strictEqual(fit!.fits, true);
      assert.strictEqual(fit!.keep, 3);
      assert.strictEqual(fit!.overrunMinutes, 0);
      // ends 5 minutes before 8 — no meaningful gap to report
      assert.strictEqual(fit!.unfilledMinutes, 5);
    },
  ],
  [
    "a SLIGHT overrun is tolerated rather than costing someone a whole stop",
    () => {
      const start = new Date(2026, 6, 3, 15, 0, 0);
      const { stops } = buildSchedule(
        [
          { category: "museum", id: "m1", name: "Museum", plannedMinutes: 120 },
          { category: "ramen", id: "r1", name: "Ramen", plannedMinutes: 120 },
        ],
        "",
        NOW,
        [],
        start,
        null,
        "America/Toronto"
      );
      // 15:00 +135 = 17:15, +135 = 19:30 … against an 19:15 end = 15 over
      const fit = checkWindowFit(stops, "2026-07-03T19:15:00-04:00");
      assert.ok(fit);
      assert.strictEqual(fit!.overrunMinutes, 15);
      assert.ok(fit!.overrunMinutes < WINDOW_OVERRUN_TOLERANCE_MINUTES);
      assert.strictEqual(fit!.fits, true, "inside the tolerance nothing is dropped");
      assert.strictEqual(fit!.keep, 2);
    },
  ],
  [
    "an OVER-STUFFED window keeps what fits and reports the rest honestly",
    () => {
      const start = new Date(2026, 6, 3, 15, 0, 0);
      const legs: TravelLeg[] = [
        { fromIndex: 0, mode: "transit", rawMinutes: 25, marginMinutes: 5, totalMinutes: 30, distanceMeters: 9000, encodedPolyline: null },
        { fromIndex: 1, mode: "transit", rawMinutes: 25, marginMinutes: 5, totalMinutes: 30, distanceMeters: 9000, encodedPolyline: null },
        { fromIndex: 2, mode: "transit", rawMinutes: 25, marginMinutes: 5, totalMinutes: 30, distanceMeters: 9000, encodedPolyline: null },
      ];
      const { stops } = buildSchedule(
        [
          { category: "museum", id: "m1", name: "Museum", plannedMinutes: 105 },
          { category: "ramen", id: "r1", name: "Ramen", plannedMinutes: 90 },
          { category: "cocktails", id: "b1", name: "Bar", plannedMinutes: 60 },
          { category: "gelato", id: "d1", name: "Gelato", plannedMinutes: 30 },
        ],
        "",
        NOW,
        legs,
        start,
        null,
        "America/Toronto"
      );
      // The planner's four "fit" 3-8 on paper. With real 30-minute legs the
      // chain is 15:00-17:00, 17:30-19:15, 19:45-20:55, 21:25-22:05 — the
      // exact scenario the architecture rule names: the LLM proposed a
      // number, and code catches that it was wrong.
      assert.strictEqual(stops[3].end_time, "2026-07-03T22:05:00-04:00");
      const fit = checkWindowFit(stops, "2026-07-03T20:00:00-04:00");
      assert.ok(fit);
      assert.strictEqual(fit!.fits, false);
      assert.strictEqual(fit!.timed, 4);
      // only the stops finishing inside 20:00 + the 30-minute tolerance
      assert.strictEqual(fit!.keep, 2);
      // 22:05 against a 20:00 end — over two hours, not a rounding error
      assert.strictEqual(fit!.overrunMinutes, 125);
      assert.ok(fit!.overrunMinutes > WINDOW_OVERRUN_TOLERANCE_MINUTES);
    },
  ],
  [
    "no stated end means NO constraint — code must not invent one",
    () => {
      const { stops } = buildSchedule(
        [{ category: "ramen", id: "r1", name: "Ramen" }],
        "evening",
        NOW,
        [],
        undefined,
        null,
        "America/Toronto"
      );
      assert.strictEqual(checkWindowFit(stops, null), null);
      assert.strictEqual(checkWindowFit(stops, undefined), null);
      assert.strictEqual(checkWindowFit(stops, "not a date"), null);
      // and a plan with no TIMED stops has nothing to measure
      assert.strictEqual(
        checkWindowFit(
          [{ category: "x", id: null, start_time: null, end_time: null, durationMinutes: null }],
          "2026-07-03T20:00:00-04:00"
        ),
        null
      );
    },
  ],
  [
    "even the FIRST stop overrunning is reported as keep:0, not a silent trim",
    () => {
      const start = new Date(2026, 6, 3, 19, 0, 0);
      const { stops } = buildSchedule(
        [{ category: "museum", id: "m1", name: "Museum", plannedMinutes: 180 }],
        "",
        NOW,
        [],
        start,
        null,
        "America/Toronto"
      );
      const fit = checkWindowFit(stops, "2026-07-03T19:30:00-04:00");
      assert.ok(fit);
      assert.strictEqual(fit!.keep, 0);
      assert.strictEqual(fit!.fits, false);
      // there is no activity to drop that rescues this — the caller fails loud
      assert.ok(fit!.overrunMinutes > WINDOW_OVERRUN_TOLERANCE_MINUTES);
    },
  ],
  [
    "an UNDER-filled window is measured, not filled",
    () => {
      const start = new Date(2026, 6, 3, 15, 0, 0);
      const { stops } = buildSchedule(
        [{ category: "coffee shop", id: "c1", name: "Cafe", plannedMinutes: 45 }],
        "",
        NOW,
        [],
        start,
        null,
        "America/Toronto"
      );
      // 15:00 + 55 = 15:55, against a 20:00 end
      const fit = checkWindowFit(stops, "2026-07-03T20:00:00-04:00");
      assert.ok(fit);
      assert.strictEqual(fit!.fits, true);
      assert.strictEqual(fit!.unfilledMinutes, 245);
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
