// Reading an archived plan — the shape check and the labels, in one pure file.
//
// PURE. No Firestore, no Firebase, no fetch, no React. Both sides use it: the
// SERVER normalises each Firestore document through `parseHistoryPlan` before
// it goes on the wire, and the CLIENT runs the same function over the response
// before it renders. One definition of "what a usable history record is",
// exactly as `resolveStopOutcome` is one definition of what a stop choice
// means. A second copy on the client is how the two would drift.
//
// WHAT THERE IS TO SHOW, and nothing more. Stage 1B archives a PROJECTION of a
// concluded plan (`ArchivedPlan`): an id, two timestamps, a zone, and a list of
// stops with names, categories, times and statuses. There is no title, no
// original prompt, no city, no venue coordinates, no travel legs. So this file
// renders dates and stops, and invents nothing — a "Dinner in Toronto" heading
// would be a guess dressed as a record.
import { DateTime } from "luxon";
import { normalizeZone } from "./zoneTime";
import type { ArchivedPlan } from "../api/itinerary/ownership";

/**
 * One archived plan on the wire: the stored record MINUS the owner uid.
 *
 * Typed off `ArchivedPlan` rather than redeclared, so if the write side ever
 * changes shape this stops compiling instead of quietly rendering nothing.
 * `ownerUid` is dropped because the caller is the owner — it is the one field
 * the reader already knows and the view will never show.
 */
export type HistoryPlanPayload = Omit<ArchivedPlan, "ownerUid">;
export type HistoryStopPayload = ArchivedPlan["stops"][number];

/** A stop as the screen renders it. */
export interface HistoryStopView {
  /** Stable list key. Archived stops carry no venue id — the record is a
   *  projection — so position is the only identity available. */
  key: string;
  /** The venue's name, or the category when the slot never resolved to one. */
  title: string;
  category: string;
  /** "7:00 PM – 8:45 PM", or a single time, or null when the record has
   *  neither. Never a fabricated time. */
  timeLabel: string | null;
  status: string;
  /** A slot that was skipped rather than visited. It is kept in the record and
   *  shown as skipped: leaving it out would silently rewrite the evening. */
  skipped: boolean;
}

/** One row of the history list, and the same object the detail view renders. */
export interface HistoryEntryView {
  id: string;
  /** The plan's own IANA zone, already normalised. Every label below is
   *  rendered in it — never the viewer's browser zone, and never
   *  unconditionally Toronto. */
  timeZone: string;
  /** "Sat Jul 4, 2026". Carries the year, unlike the live strip's labels: a
   *  history list spans arbitrary past dates, where "Sat Jul 4" is ambiguous. */
  dateLabel: string;
  /** The outing's span, "7:00 PM – 10:15 PM", or null when no stop carried a
   *  usable time. */
  timeLabel: string | null;
  stopCountLabel: string;
  stops: HistoryStopView[];
  /** Ordering value in epoch ms, newest largest. Part of the view because the
   *  order IS something the screen shows, and pinning it in a test beats
   *  trusting a provider query to have sorted. */
  sortKey: number;
}

/** Newest first, and never more than this in one response. Bounded work, like
 *  every other outward call in this app. */
export const HISTORY_LIMIT = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A present-but-blank string is absent — same rule `authUser` applies to a
 *  provider payload, and the same one `ownership` applies to a uid. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** An instant we can actually render, or null. A string that does not parse is
 *  treated as absent rather than shown as "Invalid Date". */
function instant(value: unknown): Date | null {
  const raw = text(value);
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function isoOrEmpty(value: unknown): string {
  return instant(value) !== null ? (text(value) as string) : "";
}

function timeOnly(when: Date, timeZone: string): string {
  // "7:00 PM" — the same luxon format the live strip uses, so a stop reads
  // identically whether it is on the map or in history.
  return DateTime.fromJSDate(when).setZone(normalizeZone(timeZone)).toFormat("h:mm a");
}

function range(start: Date | null, end: Date | null, timeZone: string): string | null {
  if (start && end) return `${timeOnly(start, timeZone)} – ${timeOnly(end, timeZone)}`;
  if (start) return timeOnly(start, timeZone);
  if (end) return timeOnly(end, timeZone);
  return null;
}

/** "live music" → "Live Music". Used only when a slot has no venue name; the
 *  category is the honest fallback, and lowercase mid-sentence would read as a
 *  missing value rather than a deliberate one. */
function titleFromCategory(category: string): string {
  const words = category
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1));
  return words.length > 0 ? words.join(" ") : "Stop";
}

/**
 * One archived stop, or null when there is nothing renderable in it.
 *
 * KEEP-ON-MISSING-DATA, the same bargain the venue filters make: a stop with
 * no times, no status or no name is kept and shown with what it has. Only a
 * record that identifies NOTHING — neither a name nor a category — is dropped,
 * because a blank row is not a record of anything.
 */
export function parseHistoryStop(value: unknown): HistoryStopPayload | null {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  const category = text(value.category);
  if (name === null && category === null) return null;
  return {
    name,
    category: category ?? "",
    start_time: text(value.start_time),
    end_time: text(value.end_time),
    status: text(value.status) ?? "",
  };
}

/**
 * One archived document → the wire payload, or null when it cannot be one.
 *
 * The ONLY hard requirement is an id: it is the document key, so a record
 * without one cannot be addressed, opened or de-duplicated. Everything else
 * degrades — a plan whose timestamps are missing still lists, labelled
 * honestly as undated.
 *
 * `fallbackId` is the Firestore document id, which the writer sets to the
 * itinerary id. It is used when the stored field is missing, and it is the
 * more trustworthy of the two: a field can be absent, a document key cannot.
 */
export function parseHistoryPlan(
  value: unknown,
  fallbackId?: string
): HistoryPlanPayload | null {
  if (!isRecord(value)) return null;
  const id = text(value.itineraryId) ?? text(fallbackId);
  if (id === null) return null;
  const rawStops = Array.isArray(value.stops) ? value.stops : [];
  return {
    itineraryId: id,
    createdAt: isoOrEmpty(value.createdAt),
    archivedAt: isoOrEmpty(value.archivedAt),
    timeZone: text(value.timeZone),
    stops: rawStops
      .map(parseHistoryStop)
      .filter((stop): stop is HistoryStopPayload => stop !== null),
  };
}

function stopCountLabel(count: number): string {
  if (count === 0) return "no stops";
  return count === 1 ? "1 stop" : `${count} stops`;
}

/**
 * A wire payload → what the screen renders.
 *
 * WHICH DATE this shows is a decision worth naming: it is the OUTING's date
 * (the first stop's start), falling back to when the plan was created and then
 * to when it was archived. A plan made at 11:40pm for the next morning belongs
 * under the morning it was for, not the night it was typed.
 */
export function toHistoryEntry(plan: HistoryPlanPayload): HistoryEntryView {
  const timeZone = normalizeZone(plan.timeZone);
  const starts = plan.stops.map((stop) => instant(stop.start_time));
  const ends = plan.stops.map((stop) => instant(stop.end_time));
  const firstStart = starts.find((when) => when !== null) ?? null;
  const lastEnd = [...ends].reverse().find((when) => when !== null) ?? null;

  const created = instant(plan.createdAt);
  const archived = instant(plan.archivedAt);
  const dateAnchor = firstStart ?? created ?? archived;

  return {
    id: plan.itineraryId,
    timeZone,
    dateLabel: dateAnchor
      ? DateTime.fromJSDate(dateAnchor).setZone(timeZone).toFormat("ccc LLL d, yyyy")
      : "Undated",
    timeLabel: range(firstStart, lastEnd, timeZone),
    stopCountLabel: stopCountLabel(plan.stops.length),
    stops: plan.stops.map((stop, index) => ({
      key: `${index}-${stop.category}`,
      title: stop.name ?? titleFromCategory(stop.category),
      category: stop.category,
      timeLabel: range(instant(stop.start_time), instant(stop.end_time), timeZone),
      status: stop.status,
      skipped: stop.status === "skipped",
    })),
    // Ordering keys off when the plan CONCLUDED, which is the one instant every
    // record has and the one the provider query sorts on. Created-at is the
    // fallback; zero sorts an undated record last rather than dropping it.
    sortKey: (archived ?? created)?.getTime() ?? 0,
  };
}

/**
 * A list of untrusted values → renderable entries, newest first.
 *
 * The sort is done HERE rather than trusted from the query: a Firestore
 * `orderBy` silently omits documents missing the ordered field, and a client
 * that re-sorts what it was given cannot show a list in the wrong order
 * because of a provider detail. Ties break on id so the order is total and a
 * re-render never reshuffles.
 */
export function toHistoryEntries(values: unknown[]): HistoryEntryView[] {
  return values
    .map((value) => parseHistoryPlan(value))
    .filter((plan): plan is HistoryPlanPayload => plan !== null)
    .map(toHistoryEntry)
    .sort((a, b) => b.sortKey - a.sortKey || a.id.localeCompare(b.id));
}

export interface HistoryResponseView {
  entries: HistoryEntryView[];
  /** The read itself failed. Distinct from "no plans": telling someone with
   *  twenty saved outings that they have none would look like data loss. */
  readFailed: boolean;
}

/** The `/api/history` response → the view. An unreadable body is a failed
 *  read, not an empty history, for the same reason. */
export function parseHistoryResponse(value: unknown): HistoryResponseView {
  if (!isRecord(value) || !Array.isArray(value.plans)) {
    return { entries: [], readFailed: true };
  }
  return {
    entries: toHistoryEntries(value.plans),
    readFailed: value.readFailed === true,
  };
}
