// The PURE half of "when do I actually board, and where do I change?" —
// the display model built from the provider's own board/alight instants and
// stop coordinates (parsed in `travel.ts`, carried on each TransitSummary).
// Rendering lives in the strip and the map; the rules live here, unit-
// testable without a DOM.
//
// DISPLAY ONLY, and that is the load-bearing sentence. The schedule is
// built on `leg.totalMinutes` — the padded door-to-door number — and none
// of it is re-derived from anything in this file. A provider board time is
// a TIMETABLE ANSWER for the departure instant the leg was priced at, not a
// promise about the ride you will be standing on.
import { BubbleSegment } from "./transitBubbles";

export interface RidePoint {
  latitude: number;
  longitude: number;
}

/** The slice of a transit ride this module needs. Structural (like
 *  `BubbleSegment`, which it extends), so a server `TransitSummary` and the
 *  client view-models both satisfy it without an import across the seam.
 *  Every added field is optional AND nullable: absent on a plan stored
 *  before these were read, null when the agency publishes neither. */
export interface RideDetail extends BubbleSegment {
  boardISO?: string | null;
  alightISO?: string | null;
  boardLocation?: RidePoint | null;
  alightLocation?: RidePoint | null;
  departStop?: string | null;
  arriveStop?: string | null;
}

export type TimelineRow =
  | { kind: "leave"; instantISO: string }
  | { kind: "arrive"; instantISO: string }
  | {
      kind: "board" | "alight";
      instantISO: string;
      line: string;
      stop: string | null;
      /** which ride of the leg this instant belongs to, 0-based in riding
       *  order. It is how the row finds its OWN route badge without
       *  matching on the line's name — a leg can ride the same line twice.
       *  Display only, like everything else in this file. */
      rideIndex: number;
    };

function instantMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function point(value: unknown): RidePoint | null {
  if (typeof value !== "object" || value === null) return null;
  const { latitude, longitude } = value as Partial<RidePoint>;
  if (typeof latitude !== "number" || !Number.isFinite(latitude)) return null;
  if (typeof longitude !== "number" || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

const trimmed = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
};

/**
 * The four instants of a transit leg, in the order they happen:
 *
 *   LEAVE  — the scheduler's dwell end. You stand up and walk out.
 *   BOARD  — the provider's departure time for a ride. You get on.
 *   ALIGHT — the provider's arrival time for that ride. You get off.
 *   ARRIVE — the scheduler's next-stop start. You are at the next venue.
 *
 * Between them sit the walk to the stop, the wait on the platform, each
 * transfer, and the walk at the far end — the minutes that were previously
 * folded invisibly into one span labelled "board · arrive", which is what
 * made the numbers look like they did not add up. A multi-ride leg gets a
 * board/alight pair PER RIDE.
 *
 * Returns null — meaning "fall back to the single line" — whenever the
 * detailed view could not be honest:
 *
 *  - either scheduler instant is missing or unreadable;
 *  - there are no rides;
 *  - ANY ride is missing a board or an alight. A partial timeline would
 *    silently drop a ride from the middle of a journey and still read as
 *    a complete sequence;
 *  - the instants are not in order. This is the STALENESS guard: provider
 *    times are anchored to the departure this leg was priced at, so a plan
 *    that moved underneath an untouched leg leaves times that no longer
 *    belong to it — and a board time before you leave, or an alight after
 *    you have arrived, is exactly the shape that mismatch takes. Rather
 *    than show a stale instant as though it were current, the leg falls
 *    back to the two instants the scheduler owns.
 */
export function buildTransitTimeline(input: {
  leaveISO?: string | null;
  arriveISO?: string | null;
  rides?: RideDetail[] | null;
}): TimelineRow[] | null {
  const leaveMs = instantMs(input.leaveISO);
  const arriveMs = instantMs(input.arriveISO);
  if (leaveMs === null || arriveMs === null) return null;

  const rides = input.rides ?? [];
  if (rides.length === 0) return null;

  const rows: TimelineRow[] = [{ kind: "leave", instantISO: input.leaveISO as string }];
  let previousMs = leaveMs;
  for (const [rideIndex, ride] of rides.entries()) {
    const boardMs = instantMs(ride.boardISO);
    const alightMs = instantMs(ride.alightISO);
    if (boardMs === null || alightMs === null) return null;
    if (boardMs < previousMs || alightMs < boardMs) return null;
    rows.push({
      kind: "board",
      instantISO: ride.boardISO as string,
      line: ride.lineName,
      stop: trimmed(ride.departStop),
      rideIndex,
    });
    rows.push({
      kind: "alight",
      instantISO: ride.alightISO as string,
      line: ride.lineName,
      stop: trimmed(ride.arriveStop),
      rideIndex,
    });
    previousMs = alightMs;
  }
  if (arriveMs < previousMs) return null;
  rows.push({ kind: "arrive", instantISO: input.arriveISO as string });
  return rows;
}

/**
 * Is the traveller ON this leg at `nowMs`? The leg's window is the two
 * instants the SCHEDULER owns — you leave the previous stop, you arrive at
 * the next — and the comparison is the one `deriveStopStatus` makes about a
 * stop: half-open [leave, arrive), so the instant you arrive already belongs
 * to the venue rather than to the ride.
 *
 * DISPLAY ONLY, like everything else in this file. It decides whether a card
 * shows its own detail; it never writes a status, and the store's derivation
 * of what is "active" is untouched by it.
 *
 * A missing or unreadable instant is NOT underway. A window that cannot be
 * read cannot be shown to contain anything — the same posture the timeline
 * takes when the provider's instants don't hold up.
 */
export function legUnderway(
  leg: { leaveISO?: string | null; arriveISO?: string | null },
  nowMs: number
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const leaveMs = instantMs(leg.leaveISO);
  const arriveMs = instantMs(leg.arriveISO);
  if (leaveMs === null || arriveMs === null) return false;
  return nowMs >= leaveMs && nowMs < arriveMs;
}

/**
 * The whole four-instant breakdown, or the compact line?
 *
 * TWO reasons to show it, ORed, and neither is a control the user has to
 * find: they are ON this leg right now (standing on the platform, the next
 * instant is the only thing that matters), or they TAPPED it (they asked).
 * Anything else is the compact form — the line and how long it takes.
 *
 * This replaced a manual "board times / hide times" disclosure, which made
 * the traveller operate a switch for information they had either just asked
 * for or were standing in the middle of.
 *
 * The two gates in front of the OR are the same ones the card has always
 * had: only a TRANSIT leg has rides, and only a leg whose provider instants
 * survived `buildTransitTimeline` (published, complete, still in order) has
 * anything honest to open into. Neither an active leg nor a tapped one can
 * conjure times that were never published or that no longer belong to it.
 */
export function shouldShowTimeline(input: {
  isTransit: boolean;
  /** `buildTransitTimeline` returned rows for this leg */
  hasTimeline: boolean;
  isActiveNow: boolean;
  isSelected: boolean;
}): boolean {
  if (!input.isTransit) return false;
  if (!input.hasTimeline) return false;
  return input.isActiveNow || input.isSelected;
}

export interface TransferPoint {
  /** stable within one leg — the map prefixes it with the leg's own key */
  key: string;
  latitude: number;
  longitude: number;
  fromLine: string;
  toLine: string;
  /** the stop the coordinate belongs to, when the agency names it */
  stopName: string | null;
}

/**
 * Where the traveller changes lines: between ride i and ride i+1, at a
 * REAL provider coordinate. Preference goes to where you get OFF (the
 * change starts there); when that stop publishes no location, where you
 * get ON the next ride is used instead — also a real place. The name
 * always follows whichever coordinate was taken, so a marker never carries
 * the label of a different stop.
 *
 * A transfer with NEITHER coordinate yields NOTHING. It is not averaged,
 * interpolated, or hung off the leg's midpoint: a transfer is a place, and
 * a marker at a computed position would be a fact we invented.
 */
export function transferPoints(rides?: RideDetail[] | null): TransferPoint[] {
  const list = rides ?? [];
  const out: TransferPoint[] = [];
  for (let i = 0; i < list.length - 1; i++) {
    const from = list[i];
    const to = list[i + 1];
    const alight = point(from.alightLocation);
    const board = alight ? null : point(to.boardLocation);
    const where = alight ?? board;
    if (!where) continue;
    out.push({
      key: `x${i}`,
      latitude: where.latitude,
      longitude: where.longitude,
      fromLine: from.lineName,
      toLine: to.lineName,
      stopName: alight ? trimmed(from.arriveStop) : trimmed(to.departStop),
    });
  }
  return out;
}
