// Remove one stop from a plan, and close the gap it leaves behind.
//
// The THIRD mutation on an itinerary, and deliberately the smallest. Swap
// replaces a venue or moves a slot; reroute replans a tail around a broken
// leg; this only ever DELETES, and then asks the existing cascade to re-time
// what is left. It invents no travel arithmetic, no scheduling rule and no
// availability rule of its own — every one of those already exists in
// `swap.ts` and is imported from there:
//
//   splice the stop out  →  resettleTail from its PREDECESSOR  →  commit
//
// `resettleTail`'s first iteration IS the bridging leg: the predecessor now
// travels directly to the successor, and the cascade prices that leg, re-times
// the successor against it, and carries the consequence down the rest of the
// day. Removing stop N is nothing more than "re-settle the tail from stop
// N-1", which is why there is no second cascade here to drift out of step
// with the first.
//
// TWO RULES SHAPE EVERYTHING BELOW.
//
//  1. CLOSE THE GAP, BUT NEVER TRADE A VENUE FOR IT. Later stops slide
//     EARLIER into the space the removed stop occupied, rather than holding
//     their times. Slid far enough, a stop lands before its own venue opens —
//     and `resettleTail`'s reaction to an unusable venue is to REPLACE it. So
//     removing your 7pm dinner would silently swap your 10pm bar for a
//     different bar, which is a change nobody asked for and no message would
//     make acceptable. The clamp (`clampEarlierToAvailability`, off for every
//     swap, on here) is what forbids it: a stop that cannot legally take the
//     whole gap takes as much of it as it can and keeps its venue. Removing
//     stop X may change stop Y's TIME. It must never change stop Y's VENUE.
//
//  2. PLAN THEN COMMIT. Everything happens on a clone; the real itinerary is
//     written in one `Object.assign` on the last line of the success path. A
//     refused removal leaves it byte-identical, exactly as a refused swap
//     does — and refusal here is not rare (a locked stop downstream, a venue
//     that shuts, the last stop in the plan), so "we already spliced it"
//     could not be allowed to be a state anything observes.
import {
  Itinerary,
  ItineraryStop,
  withStatuses,
  floorTime,
  timedIndexes,
  rebuildLegs,
} from "./store";
import { ParsedPrompt, WeatherHour } from "../places/search/filter";
import { TravelLeg } from "../schedule/travel";
import { getDuration } from "../schedule/durations";
import { toZonedISO } from "../schedule/schedule";
import { DEFAULT_ZONE } from "../../lib/zoneTime";
import { logEvent } from "../_shared/http";
import { fallbackParsedFor, UNKNOWN_LOCATION_MESSAGE } from "./fallbackParsed";
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

/** What was taken out, for the banner and the log. */
export interface RemovedStop {
  name: string | null;
  category: string;
  start: string | null;
  end: string | null;
}

export type RemoveResult =
  | { removed: false; reason: string }
  | {
      removed: true;
      /** the index the stop occupied BEFORE the splice */
      stopIndex: number;
      before: RemovedStop;
      reason: string;
      /** indices AFTER the splice, of stops whose times actually moved */
      downstreamShifted: number[];
    };

/**
 * The refusal that protects the plan's existence.
 *
 * An EMPTY `stops` array is not a harmless edge case — it reads as a FINISHED
 * outing. `nextItineraryStatus` asks `stops.every(completed || skipped)`, and
 * `[].every(...)` is vacuously TRUE, so a plan with nothing in it reports
 * `status: "completed"`. The by-id GET then acts on that: it clears the
 * owner's resume pointer and, for a signed-in account, writes the empty plan
 * into history through `archiveConcludedPlan`. `isResumable` reads the same
 * status, so the plan cannot be reached again either. Deleting your way to
 * zero would file a blank record under your name and lose the plan, and none
 * of it would look like an error.
 *
 * So it is refused BEFORE the splice, and pointed at the control that ends a
 * plan on purpose — which does all of the above deliberately, asks first, and
 * lets you choose whether it is saved.
 */
export const LAST_STOP_MESSAGE =
  "That's the only stop left, so removing it would leave you with no plan at all. " +
  "Use “End” in the top bar to finish the itinerary instead.";

/** A stop's own name, or its kind when a venue never resolved. */
function nameOf(stop: ItineraryStop): string {
  return stop.name ?? stop.category;
}

/** The stop's own (possibly customized) length — the same source of truth a
 *  swap keeps whenever the venue and its kind stay the same. */
function totalMinutesOf(stop: ItineraryStop): number {
  const table = getDuration(stop.category);
  return stop.durationMinutes?.total ?? table.baseMinutes + table.bufferMinutes;
}

/**
 * Would a plan still exist after this removal?
 *
 * "At least one stop with a venue and a time" — the same thing the status
 * derivation counts as a live stop. It is checked against the ORIGINAL array,
 * before anything is spliced, because the whole point is that the splice must
 * not happen.
 */
function leavesAPlan(itinerary: Itinerary, stopIndex: number): boolean {
  return itinerary.stops.some(
    (stop, index) => index !== stopIndex && stop.id !== null && !!stop.start_time
  );
}

/**
 * Point a stop at its new next leg — or at nothing.
 *
 * THE DANGLING LEG is the whole reason this is a function. Removing the LAST
 * stop leaves its predecessor still holding `travelToNext`, a real leg to a
 * venue that is no longer in the plan; `rebuildLegs` would copy it into
 * `itinerary.legs` and the strip would draw a journey to nothing after the
 * final card. `resettleTail` hands back no leg in exactly that case (an empty
 * `changes` and a null `terminalInbound`), which is the signal to delete both
 * fields — the same shape `buildSchedule` gives the last stop of a fresh plan.
 *
 * EXPORTED for `modeSwitch`, which composes the same pair and inherits the
 * same hazard: an anchor whose outbound leg is not re-pointed would keep a
 * leg priced in the mode the plan just left. The export follows the precedent
 * `swap.ts` set for this cascade — one keyword, no behaviour change — rather
 * than a second copy of a rule that would drift.
 */
export function setOutbound(stop: ItineraryStop, leg: TravelLeg | null): void {
  if (leg) {
    stop.travelToNext = leg;
    stop.travelMinutesToNext = leg.totalMinutes;
    return;
  }
  delete stop.travelToNext;
  delete stop.travelMinutesToNext;
}

type Reanchored =
  | { ok: true; changes: { stopIndex: number; moved: boolean }[] }
  | { ok: false; reason: string };

/**
 * The ORDINARY case: the removed stop had a predecessor, so the predecessor
 * becomes the anchor and the untouched cascade does the rest.
 *
 * Nothing about the predecessor moves. Its committed start and end are exactly
 * where they were — this is a removal downstream of it, and a stop that is
 * already settled has no reason to shift because something after it went away.
 */
async function reanchorOnPredecessor(
  work: Itinerary,
  timedIdx: number[],
  prevIndex: number,
  floor: Date,
  now: Date,
  base: ParsedPrompt,
  deps: SwapDeps,
  used: Set<string>,
  weather: WeatherHour[] | null
): Promise<Reanchored> {
  const prev = work.stops[prevIndex];
  const anchorEndMs = prev.end_time ? new Date(prev.end_time).getTime() : Number.NaN;
  if (!validLocation(prev.location) || !Number.isFinite(anchorEndMs)) {
    return {
      ok: false,
      reason: `The route out of ${nameOf(prev)} can't be verified because its location or time is missing.`,
    };
  }

  const settle = await resettleTail(
    work,
    prevIndex,
    timedIdx,
    new Date(anchorEndMs),
    prev.location,
    floor,
    now,
    base,
    deps,
    used,
    weather,
    // CLOSE THE GAP: stops slide earlier, they do not hold their times.
    false,
    // ...but never earlier than their own venue is usable.
    true
  );
  if (!settle.ok) return { ok: false, reason: settle.reason };

  commitTail(work, settle.changes, settle.terminalInbound);
  setOutbound(prev, settle.changes[0]?.inbound ?? settle.terminalInbound ?? null);
  return { ok: true, changes: settle.changes };
}

/**
 * The FIRST-STOP case: there is no predecessor to anchor on, so the origin is
 * HOME and the home leg has to be re-aimed at what is now the first stop.
 *
 * WHEN YOU LEAVE HOME DOES NOT CHANGE. The departure instant is the one the
 * plan already implied — the removed stop's start less the home leg that
 * served it, which is the same subtraction the strip renders as "leave by".
 * `homeDeparture` computes it, and it is read BEFORE `commitAnchorInbound`
 * overwrites `homeLeg` with the new one. Holding that instant is what makes
 * this the same "close the gap" the tail gets: you set off at the hour you
 * were always going to, and go straight to the second stop instead.
 *
 * The new first stop then starts as early as the REAL new leg allows, floored
 * by `now` (you cannot arrive before the present) and clamped by its own
 * opening time. It can also land LATER than it was: home may simply be
 * further from the second stop than the route through the first one was, and
 * that is a fact about the map, not a failure.
 */
async function reanchorOnHome(
  work: Itinerary,
  timedIdx: number[],
  removedStartISO: string,
  floor: Date,
  now: Date,
  base: ParsedPrompt,
  deps: SwapDeps,
  used: Set<string>,
  weather: WeatherHour[] | null,
  tz: string
): Promise<Reanchored> {
  const firstIdx = timedIdx[0];
  // Unreachable: the "down to zero" guard already refused the case where no
  // timed stop survives. Kept because the alternative to a guard here is an
  // undefined index, and a plan is what is at stake.
  if (firstIdx === undefined) return { ok: false, reason: LAST_STOP_MESSAGE };

  const newFirst = work.stops[firstIdx];
  const committedStartMs = newFirst.start_time
    ? new Date(newFirst.start_time).getTime()
    : Number.NaN;
  if (!validLocation(newFirst.location) || !Number.isFinite(committedStartMs)) {
    return {
      ok: false,
      reason: `The route to ${nameOf(newFirst)} can't be verified because its location or time is missing.`,
    };
  }

  // The instant the day departs — read off the OLD home leg, before the new
  // one replaces it.
  const departMs = new Date(homeDeparture(work, new Date(removedStartISO))).getTime();
  if (!Number.isFinite(departMs)) {
    return { ok: false, reason: `The route to ${nameOf(newFirst)} couldn't be verified.` };
  }

  const inbound = await planAnchorInbound(
    work,
    timedIdx,
    firstIdx,
    newFirst.location,
    new Date(removedStartISO),
    deps
  );
  if (!inbound) {
    return { ok: false, reason: `The route from home to ${nameOf(newFirst)} couldn't be verified.` };
  }

  const totalMinutes = totalMinutesOf(newFirst);
  let startMs = Math.max(departMs + inbound.leg.totalMinutes * 60_000, floor.getTime());

  // A LOCKED or already-underway stop is never re-timed — the ratchet holds
  // whatever else changes around it. All this removal may do is prove the new
  // home leg still reaches its committed start; if it does not, the plan can't
  // physically absorb the removal and says so.
  const immovable = newFirst.locked || committedStartMs <= floor.getTime();
  if (immovable) {
    if (startMs > committedStartMs) {
      return {
        ok: false,
        reason: `Removing that stop would leave you unable to reach ${nameOf(newFirst)} by ${clockLabel(
          new Date(committedStartMs),
          tz
        )}.`,
      };
    }
    startMs = committedStartMs;
  } else if (startMs < committedStartMs) {
    // The same clamp the tail gets, for the same reason — except that here a
    // venue found unusable would not be replaced but REFUSED, so the clamp is
    // what keeps an ordinary removal from becoming a dead end.
    startMs = earliestUsableStart(
      placeOf(newFirst),
      newFirst.category,
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

  // Judged at the RESOLVED start. Clamped downward this always holds (the
  // ceiling is where the stop already sat), so in practice this only bites
  // when the new home leg pushes the stop LATER than it was planned for.
  if (
    !usableForProposal(
      placeOf(newFirst),
      newFirst.category,
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
      ok: false,
      reason: `Removing that stop would move ${nameOf(newFirst)} to ${clockLabel(
        new Date(startMs),
        tz
      )}, and it isn't open then.`,
    };
  }

  const settle = await resettleTail(
    work,
    firstIdx,
    timedIdx,
    new Date(startMs + totalMinutes * 60_000),
    newFirst.location,
    floor,
    now,
    base,
    deps,
    used,
    weather,
    false,
    true
  );
  if (!settle.ok) return { ok: false, reason: settle.reason };

  // ── commit (still on the clone) ──
  commitAnchorInbound(work, inbound);
  // Re-timed IN PLACE rather than rebuilt. A removal never changes a venue, so
  // the only two fields with any reason to move are the instants — and going
  // through `buildStop` would quietly reset the fields it does not copy from a
  // kept stop (`locked`, `slot`, `fallback`), which is a lot of collateral for
  // an edit that is genuinely two assignments.
  newFirst.start_time = toZonedISO(new Date(startMs), tz);
  newFirst.end_time = toZonedISO(new Date(startMs + totalMinutes * 60_000), tz);

  commitTail(work, settle.changes, settle.terminalInbound);
  setOutbound(newFirst, settle.changes[0]?.inbound ?? settle.terminalInbound ?? null);

  // The new first stop is itself a moved stop when the gap actually closed in
  // front of it, and the client strikes through what moved — so it belongs in
  // the same list as the tail rather than being the one shift nothing marks.
  return {
    ok: true,
    changes: [
      { stopIndex: firstIdx, moved: startMs !== committedStartMs },
      ...settle.changes.map((change) => ({
        stopIndex: change.stopIndex,
        moved: change.moved,
      })),
    ],
  };
}

/**
 * Remove `stopIndex` and re-time everything after it.
 *
 * Mirrors `swapStop`'s shape exactly — clone, derive statuses, take the floor,
 * refuse or commit — because they are the same kind of operation on the same
 * object and the differences should be the ones that are real.
 */
export async function removeStop(
  itinerary: Itinerary,
  stopIndex: number,
  now: Date,
  depsIn: Partial<SwapDeps> = {}
): Promise<RemoveResult> {
  // Removal re-prices the bridging leg and everything after it, so it has
  // to travel the way the plan does. Same one-line binding as swap/reroute.
  const deps = { ...realDeps(itinerary.travelMode), ...depsIn };
  const work = cloneProposal(itinerary);
  withStatuses(work, now);
  const floor = floorTime(work, now);
  const tz = work.timeZone ?? DEFAULT_ZONE;

  const target = work.stops[stopIndex];
  if (!target) return { removed: false, reason: "That stop doesn't exist." };
  if (!target.start_time || target.id === null) {
    return { removed: false, reason: "That stop has no venue to remove." };
  }
  // The SAME predicate `swapStop` uses. A past stop is history and a locked
  // one is pinned; neither is editable, and deleting is an edit.
  if (target.locked || new Date(target.start_time).getTime() <= floor.getTime()) {
    return {
      removed: false,
      reason: `You can only remove an upcoming stop — “${nameOf(target)}” is already underway or done.`,
    };
  }
  if (!leavesAPlan(work, stopIndex)) {
    return { removed: false, reason: LAST_STOP_MESSAGE };
  }

  // Needed by the cascade for the filter gate and for any downstream stop it
  // genuinely has to adapt. No stored parse and no recoverable city → refuse
  // honestly rather than search the wrong place (§3.1).
  const base = work.parsed ?? fallbackParsedFor(work);
  if (!base) return { removed: false, reason: UNKNOWN_LOCATION_MESSAGE };
  const weather = await weatherFor(work, deps);

  const before: RemovedStop = {
    name: target.name ?? null,
    category: target.category,
    start: target.start_time,
    end: target.end_time,
  };

  const timedBefore = timedIndexes(work);
  const position = timedBefore.indexOf(stopIndex);
  if (position < 0) return { removed: false, reason: "That stop has no time to remove." };
  const prevIndex = position > 0 ? timedBefore[position - 1] : null;

  // Every venue already in the plan, INCLUDING the one being removed: if the
  // cascade has to adapt a later stop, handing back the venue the user just
  // deleted would be the worst possible answer to "remove this".
  const used = new Set<string>(
    work.stops.map((stop) => stop.id).filter((id): id is string => !!id)
  );

  // ── THE SPLICE ── on the clone. Indices from here on are POST-removal;
  // `prevIndex` survives it unchanged because a predecessor sits before the
  // cut, and everything after shifts down by one.
  work.stops.splice(stopIndex, 1);
  const timedIdx = timedIndexes(work);

  const outcome =
    prevIndex === null
      ? await reanchorOnHome(
          work,
          timedIdx,
          before.start!,
          floor,
          now,
          base,
          deps,
          used,
          weather,
          tz
        )
      : await reanchorOnPredecessor(
          work,
          timedIdx,
          prevIndex,
          floor,
          now,
          base,
          deps,
          used,
          weather
        );

  if (!outcome.ok) {
    logEvent("info", "stop_removed", {
      outcome: "refused",
      stopIndex,
      category: before.category,
    });
    return { removed: false, reason: outcome.reason };
  }

  rebuildLegs(work);
  withStatuses(work, now);

  const downstreamShifted = outcome.changes
    .filter((change) => change.moved)
    .map((change) => change.stopIndex);

  // THE ONE WRITE. Everything above ran on the clone; a refusal returned
  // before reaching here and left the caller's itinerary untouched.
  Object.assign(itinerary, work);

  logEvent("info", "stop_removed", {
    outcome: "removed",
    stopIndex,
    category: before.category,
    remaining: itinerary.stops.length,
    downstreamShifted,
  });

  return {
    removed: true,
    stopIndex,
    before,
    reason: `Removed ${before.name ?? before.category}${
      downstreamShifted.length > 0 ? " and moved the later stops earlier" : ""
    }.`,
    downstreamShifted,
  };
}
