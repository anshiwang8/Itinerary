import { getDuration } from "../api/schedule/durations";

export type SlotArrivalMap = Record<number, string>;

export interface RecoveryRowLike {
  category: string;
  slot?: number;
}

export interface RecoverySelectionLike {
  category?: string;
  id?: string | null;
  slot?: number;
  /** the stop's own resolved length, when a planner/selector produced one */
  plannedMinutes?: number;
}

export interface ScheduledSlotLike {
  slot?: number;
  start_time?: string | null;
}

function validSlot(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function validDate(value: Date | string | null | undefined): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? "");
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Same rule the scheduler uses: the stop's OWN length wins, and the
 *  buffer stays the table's scheduling margin. DURATION_TABLE is the
 *  fallback for slots that never met a planner. */
function durationTotal(category: string, plannedMinutes?: number): number {
  const duration = getDuration(category);
  return (plannedMinutes ?? duration.baseMinutes) + duration.bufferMinutes;
}

/**
 * Estimate each requested slot's arrival before travel is known. Selection
 * categories override their original slot (for example, after a recovery
 * replacement changes a park into a museum), while the slot number remains
 * the stable identity.
 */
export function provisionalArrivals(
  requestedCategories: readonly string[],
  start: Date | string,
  selections: readonly RecoverySelectionLike[] = []
): SlotArrivalMap {
  const cursorStart = validDate(start);
  if (!cursorStart) return {};

  const categoryBySlot = new Map<number, string>();
  const minutesBySlot = new Map<number, number>();
  for (const selection of selections) {
    if (
      validSlot(selection.slot) &&
      typeof selection.category === "string" &&
      selection.category.trim()
    ) {
      categoryBySlot.set(selection.slot, selection.category);
    }
    if (
      validSlot(selection.slot) &&
      typeof selection.plannedMinutes === "number" &&
      Number.isFinite(selection.plannedMinutes)
    ) {
      minutesBySlot.set(selection.slot, selection.plannedMinutes);
    }
  }

  const arrivals: SlotArrivalMap = {};
  let cursorMs = cursorStart.getTime();
  requestedCategories.forEach((requestedCategory, slot) => {
    arrivals[slot] = new Date(cursorMs).toISOString();
    const category = categoryBySlot.get(slot) ?? requestedCategory;
    cursorMs += durationTotal(category, minutesBySlot.get(slot)) * 60_000;
  });
  return arrivals;
}

/**
 * Replace provisional instants with schedule-confirmed starts. Modern stops
 * carry their original slot; positional identity keeps legacy schedules safe.
 */
export function mergeFinalArrivals(
  provisional: Readonly<SlotArrivalMap>,
  stops: readonly ScheduledSlotLike[]
): SlotArrivalMap {
  const merged: SlotArrivalMap = { ...provisional };
  stops.forEach((stop, index) => {
    const start = validDate(stop.start_time);
    if (!start) return;
    const slot = validSlot(stop.slot) ? stop.slot : index;
    merged[slot] = start.toISOString();
  });
  return merged;
}

/**
 * Resolve the instant used to re-search one recovery row. A missing or corrupt
 * slot instant uses the plan anchor; an invalid anchor degrades to the epoch
 * instead of leaking an Invalid Date into a request.
 */
export function arrivalForRow(
  arrivals: Readonly<SlotArrivalMap>,
  row: RecoveryRowLike,
  fallback: Date | string
): Date {
  const candidate = validSlot(row.slot) ? validDate(arrivals[row.slot]) : null;
  return candidate ?? validDate(fallback) ?? new Date(0);
}

/** IDs occupied by every selection except the row currently being recovered. */
export function usedIdsOutsideRow(
  selections: readonly RecoverySelectionLike[],
  row: RecoveryRowLike
): Set<string> {
  const rowHasSlot = validSlot(row.slot);
  const used = new Set<string>();

  for (const selection of selections) {
    const isCurrentRow = rowHasSlot
      ? validSlot(selection.slot) && selection.slot === row.slot
      : selection.category === row.category;
    if (!isCurrentRow && typeof selection.id === "string" && selection.id) {
      used.add(selection.id);
    }
  }
  return used;
}

/**
 * Union refreshed Places results into the existing category pool. Earlier
 * entries win for duplicate IDs so another slot never loses the venue object
 * that backed its selection.
 */
export function mergePlacePools<T extends { id?: string | null }>(
  existing: readonly T[] | null | undefined,
  incoming: readonly T[] | null | undefined
): T[] {
  const merged = [...(existing ?? [])];
  const seen = new Set(
    merged
      .map((place) => place.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );

  for (const place of incoming ?? []) {
    const id = place.id;
    if (typeof id === "string" && id.length > 0) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    merged.push(place);
  }
  return merged;
}
