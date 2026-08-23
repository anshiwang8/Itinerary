// Switch how an EXISTING plan travels — transit ↔ driving — and re-price the
// day around the answer.
//
// Stage 1 of drive-vs-transit mode let the user choose at creation and stored
// the choice; this is Stage 2, the live switch. It is the FOURTH mutation on
// an itinerary and, like the third, it composes the existing cascade rather
// than growing one of its own:
//
//   re-aim the first movable stop's inbound leg  →  resettleTail  →  commit
//
// THAT PAIR IS REMOVE-STOP'S, NOT REROUTE'S, and the reason is worth stating
// because reroute looks like the closer relative. A reroute replans a tail
// around a leg that broke: it re-searches venues, and it is supposed to. A
// mode switch changes exactly one thing about the day — the vehicle — so
// every venue stays and every leg is re-priced. "Re-price every leg from the
// first movable stop, keep every venue" is `planAnchorInbound` followed by
// `resettleTail`, which is precisely what `removeStop` composes, minus the
// splice.
//
// THREE RULES SHAPE EVERYTHING BELOW.
//
//  1. SWITCHING MODE MAY CHANGE EVERY STOP'S TIME. IT MUST NEVER CHANGE ANY
//     STOP'S VENUE. This is remove-stop's rule with the stakes raised, and it
//     needs BOTH halves of the guard because a mode switch moves stops in
//     both directions. Transit → driving is faster and pulls stops EARLIER,
//     where a venue that has not opened yet would be read as unusable and
//     REPLACED: `clampEarlierToAvailability` answers that, holding the stop at
//     its own opening time and keeping its venue. Driving → transit is slower
//     and pushes stops LATER, where a venue that has closed would be replaced
//     just the same and no clamp applies: `neverReplaceVenue` answers that by
//     refusing outright. The user asked to change how they TRAVEL, not where
//     they go, and a switch that quietly re-picked a restaurant would be the
//     worst possible reading of the request.
//
//  2. IT RE-PRICES TRAVEL AND NOTHING ELSE. No Places search, no select call,
//     no model call of any kind. The only provider traffic is the forecast
//     (which the shared availability gate needs) and one route lookup per leg
//     it actually re-prices. `neverReplaceVenue` is what makes that structural
//     instead of aspirational: it refuses BEFORE `findReplacement` can spend
//     anything.
//
//  3. PLAN THEN COMMIT. Everything runs on a clone; the real itinerary is
//     written by one `Object.assign` on the last line of the success path. A
//     refused switch leaves it byte-identical, exactly as a refused swap or
//     removal does.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH: any leg at or before the floor. A
// switch made mid-outing re-prices only what is still ahead, so the legs
// already travelled keep the mode they were actually travelled in. That is
// not a gap — it is the Stage 1 invariant holding: `travelMode` is the plan's
// INTENT, never a per-leg guarantee.
import {
  Itinerary,
  ItineraryStop,
  withStatuses,
  floorTime,
  timedIndexes,
  rebuildLegs,
} from "./store";
import { ParsedPrompt, WeatherHour } from "../places/search/filter";
import { PlanTravelMode } from "../schedule/travel";
import { getDuration } from "../schedule/durations";
import { toZonedISO, WINDOW_OVERRUN_TOLERANCE_MINUTES } from "../schedule/schedule";
import { DEFAULT_ZONE } from "../../lib/zoneTime";
import { logEvent } from "../_shared/http";
import { fallbackParsedFor, UNKNOWN_LOCATION_MESSAGE } from "./fallbackParsed";
import { setOutbound } from "./removeStop";
import {
  SwapDeps,
  clockLabel,
  cloneProposal,
  commitAnchorInbound,
  commitTail,
  earliestUsableStart,
  homeDeparture,
  placeOf,
  planAnchorInbound,
  realDeps,
  resettleTail,
  usableForProposal,
  validLocation,
  weatherFor,
} from "./swap";

export type ModeSwitchResult =
  | { switched: false; reason: string }
  | {
      switched: true;
      from: PlanTravelMode;
      to: PlanTravelMode;
      reason: string;
      /** indices of stops whose times actually moved — the client's reflow */
      shifted: number[];
      /** present only when the re-timed day now runs past a STATED end.
       *  A note, never a question: see `endTimeNote`. */
      endNote?: string;
    };

/** How the mode reads in a sentence the user sees. */
export function modeLabel(mode: PlanTravelMode): string {
  return mode === "driving" ? "driving" : "transit";
}

/** A stop's own name, or its kind when a venue never resolved. */
function nameOf(stop: ItineraryStop): string {
  return stop.name ?? stop.category;
}

/** The stop's own (possibly customized) length — the same source of truth
 *  every path that keeps a venue and its kind already uses. */
function totalMinutesOf(stop: ItineraryStop): number {
  const table = getDuration(stop.category);
  return stop.durationMinutes?.total ?? table.baseMinutes + table.bufferMinutes;
}

/**
 * The first stop this switch is allowed to move, and therefore the first leg
 * it is allowed to re-price.
 *
 * A stop at or before the floor is underway or done, and a locked one is
 * pinned by the ratchet — the same predicate `swapStop` and `removeStop` use
 * to decide what is editable. The leg INTO such a stop has already been
 * travelled, so re-pricing it in a mode nobody used would be a lie about the
 * past, not a correction.
 */
function firstMovableTimed(
  itinerary: Itinerary,
  timedIdx: number[],
  floor: Date
): number | null {
  for (const index of timedIdx) {
    const stop = itinerary.stops[index];
    const startMs = stop.start_time ? new Date(stop.start_time).getTime() : Number.NaN;
    if (!Number.isFinite(startMs)) continue;
    if (stop.locked || startMs <= floor.getTime()) continue;
    return index;
  }
  return null;
}

/**
 * The instant the anchor is departed FOR.
 *
 * With a previous timed stop it is that stop's committed end — the boundary
 * the ratchet holds, and the same departure every other inbound leg is priced
 * at. With none, the origin is home and the instant is the plan's own "leave
 * by", read off the OLD home leg before the new one replaces it. Holding it
 * is what makes a switch honest at the top of the day: you set off when you
 * were always going to, and the faster (or slower) vehicle changes when you
 * ARRIVE rather than silently rewriting when you left.
 */
function anchorDepartureMs(
  itinerary: Itinerary,
  timedIdx: number[],
  anchorIndex: number,
  anchorStart: Date
): number {
  const position = timedIdx.indexOf(anchorIndex);
  const prev = position > 0 ? itinerary.stops[timedIdx[position - 1]] : null;
  if (prev?.end_time) return new Date(prev.end_time).getTime();
  return new Date(homeDeparture(itinerary, anchorStart)).getTime();
}

/**
 * "Your day now runs past the end you named" — a NOTE, deliberately not a
 * question.
 *
 * A swap ASKS before pushing past `plannedEndISO`, because a swap is a
 * request for one specific thing and the push is a side effect the user never
 * mentioned. A mode switch is different in kind: the user named the whole
 * day's travel, the new end is the direct arithmetic of that choice, and the
 * plan is the answer to the question they asked. Interrupting to re-ask would
 * be asking them to confirm the thing they just chose. So it is surfaced in
 * the banner and left at that — and it is a note in ONE direction only, since
 * a day that now finishes EARLIER has nothing to warn about.
 *
 * Same constant as creation and as the swap guard: two definitions of "past
 * the stated window" is how one surface accepts twenty-five minutes silently
 * while another interrupts over five. NO STATED END MEANS NO NOTE.
 */
function endTimeNote(itinerary: Itinerary, timeZone: string): string | undefined {
  const statedEndISO = itinerary.plannedEndISO;
  if (!statedEndISO) return undefined;
  const statedEndMs = new Date(statedEndISO).getTime();
  if (!Number.isFinite(statedEndMs)) return undefined;

  let latest = Number.NEGATIVE_INFINITY;
  for (const stop of itinerary.stops) {
    const endMs = stop.end_time ? new Date(stop.end_time).getTime() : Number.NaN;
    if (Number.isFinite(endMs) && endMs > latest) latest = endMs;
  }
  if (!Number.isFinite(latest)) return undefined;
  if (Math.round((latest - statedEndMs) / 60_000) <= WINDOW_OVERRUN_TOLERANCE_MINUTES) {
    return undefined;
  }
  return `Heads up: your day now ends around ${clockLabel(
    new Date(latest),
    timeZone
  )}, past the ${clockLabel(new Date(statedEndMs), timeZone)} you asked for.`;
}

/**
 * Switch the plan's travel mode and re-price every leg that is still ahead.
 *
 * Mirrors `removeStop`'s shape — clone, derive statuses, take the floor,
 * refuse or commit — because it is the same kind of operation on the same
 * object, and the differences should be the ones that are real.
 */
export async function switchTravelMode(
  itinerary: Itinerary,
  target: PlanTravelMode,
  now: Date,
  depsIn: Partial<SwapDeps> = {}
): Promise<ModeSwitchResult> {
  const from: PlanTravelMode = itinerary.travelMode ?? "transit";

  // THE NO-OP, and it is a refusal on purpose: `switched: false` reaches the
  // route as `changed: false`, so nothing is written, no version is bumped
  // and no CAS runs. Re-pricing a day into the mode it is already in would
  // spend a route lookup per leg to arrive back where it started — and could
  // still MOVE stops, since a re-priced leg is not obliged to come back the
  // same length as the one stored an hour ago.
  if (from === target) {
    return {
      switched: false,
      reason: `This plan already gets around by ${modeLabel(target)}.`,
    };
  }

  // THE ONE PLACE IN THE APP WHERE THE DEPS ARE BOUND TO A MODE THE PLAN DOES
  // NOT YET HAVE. Swap, remove and reroute all bind `realDeps(itinerary
  // .travelMode)` — they inherit how the plan travels. This mutation IS the
  // change to how it travels, so every leg it prices has to be priced in the
  // TARGET mode. Binding the stored mode here would re-price the whole day in
  // the mode being left and then relabel the plan, which is the silent
  // failure this stage exists to prevent.
  const deps = { ...realDeps(target), ...depsIn };
  const work = cloneProposal(itinerary);
  withStatuses(work, now);
  const floor = floorTime(work, now);
  const tz = work.timeZone ?? DEFAULT_ZONE;

  const timedIdx = timedIndexes(work);
  const anchorIndex = firstMovableTimed(work, timedIdx, floor);
  if (anchorIndex === null) {
    return {
      switched: false,
      reason:
        "There's nothing left to re-route — every stop is already underway or done.",
    };
  }

  const anchor = work.stops[anchorIndex];
  const committedStartMs = anchor.start_time
    ? new Date(anchor.start_time).getTime()
    : Number.NaN;
  if (!validLocation(anchor.location) || !Number.isFinite(committedStartMs)) {
    return {
      switched: false,
      reason: `The route to ${nameOf(anchor)} can't be verified because its location or time is missing.`,
    };
  }

  // Needed by the cascade's filter gate. No stored parse and no recoverable
  // city → refuse honestly rather than judge venues against the wrong place.
  const base: ParsedPrompt | null = work.parsed ?? fallbackParsedFor(work);
  if (!base) return { switched: false, reason: UNKNOWN_LOCATION_MESSAGE };
  const weather: WeatherHour[] | null = await weatherFor(work, deps);

  const departMs = anchorDepartureMs(
    work,
    timedIdx,
    anchorIndex,
    new Date(committedStartMs)
  );
  if (!Number.isFinite(departMs)) {
    return {
      switched: false,
      reason: `The route to ${nameOf(anchor)} couldn't be verified.`,
    };
  }

  // The anchor's inbound leg, re-priced in the TARGET mode. With a previous
  // timed stop this is that leg; with none it is the HOME leg, and
  // `planAnchorInbound` already knows the difference.
  const inbound = await planAnchorInbound(
    work,
    timedIdx,
    anchorIndex,
    anchor.location,
    new Date(committedStartMs),
    deps
  );
  if (!inbound) {
    return {
      switched: false,
      reason: `The route to ${nameOf(anchor)} couldn't be re-checked for ${modeLabel(
        target
      )}.`,
    };
  }

  const totalMinutes = totalMinutesOf(anchor);
  // Depart when the plan always said, arrive when the NEW leg actually gets
  // you there — floored by the present, because no vehicle arrives in the
  // past.
  let startMs = Math.max(
    departMs + inbound.leg.totalMinutes * 60_000,
    floor.getTime()
  );

  if (startMs < committedStartMs) {
    // THE OPEN-TIME CLAMP, on the anchor. A faster vehicle pulls it earlier,
    // and early enough is before its own door opens — which the check below
    // would read as unusable and answer, here, with a refusal. Clamping first
    // lets the stop take as much of the gain as it legally can and keep the
    // rest as slack, exactly as the tail does.
    startMs = earliestUsableStart(
      placeOf(anchor),
      anchor.category,
      base,
      weather,
      now,
      startMs,
      committedStartMs,
      totalMinutes,
      tz,
      deps
    );
  }

  // Judged at the RESOLVED start, across the whole slot. Clamped downward
  // this always holds — the ceiling is where the stop already sat — so in
  // practice it bites only when the new leg pushes the stop LATER than it was
  // planned for. A REFUSAL, never a substitution: rule 1.
  if (
    !usableForProposal(
      placeOf(anchor),
      anchor.category,
      base,
      weather,
      now,
      new Date(startMs),
      totalMinutes,
      tz,
      deps
    )
  ) {
    return {
      switched: false,
      reason: `Switching to ${modeLabel(target)} would move ${nameOf(
        anchor
      )} to ${clockLabel(new Date(startMs), tz)}, and it isn't open then.`,
    };
  }

  // Every venue already in the plan. `neverReplaceVenue` means the cascade
  // can never spend this set, but it is what `resettleTail` takes and an
  // empty one would be a lie about what the day is holding.
  const used = new Set<string>(
    work.stops.map((stop) => stop.id).filter((id): id is string => !!id)
  );

  const settle = await resettleTail(
    work,
    anchorIndex,
    timedIdx,
    new Date(startMs + totalMinutes * 60_000),
    anchor.location,
    floor,
    now,
    base,
    deps,
    used,
    weather,
    // Let the day re-time around the new travel times rather than holding
    // committed starts — a faster vehicle really does get you there sooner.
    false,
    // ...but never earlier than a venue is open.
    true,
    // ...and never, in either direction, by changing which venue it is.
    true
  );
  if (!settle.ok) {
    logEvent("info", "travel_mode_switched", {
      outcome: "refused",
      from,
      to: target,
    });
    return {
      switched: false,
      reason: `Couldn't switch to ${modeLabel(target)}. ${settle.reason}`,
    };
  }

  // ── commit (still on the clone) ──
  commitAnchorInbound(work, inbound);
  // Re-timed IN PLACE rather than rebuilt. A mode switch never changes a
  // venue, so the only fields with any reason to move are the instants —
  // and `buildStop` would quietly reset the ones it does not copy from a
  // kept stop (`locked`, `slot`, `fallback`).
  anchor.start_time = toZonedISO(new Date(startMs), tz);
  anchor.end_time = toZonedISO(new Date(startMs + totalMinutes * 60_000), tz);

  commitTail(work, settle.changes, settle.terminalInbound);
  setOutbound(anchor, settle.changes[0]?.inbound ?? settle.terminalInbound ?? null);

  // "transit" is the ABSENT meaning, so switching TO it REMOVES the field
  // rather than writing it out — a transit plan stays byte-identical to a
  // pre-drive-mode one, which is the contract `createItinerary` set.
  if (target === "driving") work.travelMode = "driving";
  else delete work.travelMode;

  rebuildLegs(work);
  withStatuses(work, now);

  const shifted = [
    ...(startMs !== committedStartMs ? [anchorIndex] : []),
    ...settle.changes.filter((change) => change.moved).map((change) => change.stopIndex),
  ];

  // THE ONE WRITE.
  Object.assign(itinerary, work);
  // `Object.assign` COPIES keys; it cannot remove one. The delete above
  // happened on the clone, and without replaying it here a plan switched to
  // transit would keep reading as driving — the exact silent failure the
  // absent-means-transit contract is supposed to make impossible.
  if (target !== "driving") delete itinerary.travelMode;

  const endNote = endTimeNote(itinerary, tz);

  logEvent("info", "travel_mode_switched", {
    outcome: "switched",
    from,
    to: target,
    shifted: shifted.length,
    pastStatedEnd: !!endNote,
  });

  return {
    switched: true,
    from,
    to: target,
    reason:
      target === "driving"
        ? `Now driving${shifted.length > 0 ? " — the times moved to match" : ""}.`
        : `Now taking transit${shifted.length > 0 ? " — the times moved to match" : ""}.`,
    shifted,
    ...(endNote ? { endNote } : {}),
  };
}
