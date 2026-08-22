"use client";

import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { formatStopRange, formatStopTime } from "./lib/timeLabels";
import { resolveCategory } from "./api/schedule/durations";
import {
  LineBadge,
  bubbleDisplayColors,
  lineBadges,
} from "./lib/transitBubbles";
import {
  RideDetail,
  buildTransitTimeline,
  legUnderway,
  shouldShowTimeline,
} from "./lib/transitDetail";
import { originDisplayLabel } from "./lib/locationLabels";

// Horizontal itinerary strip — the primary surface, sitting just under
// the search bar. Reads left to right like a transit-app trip view:
// home → stop → transit leg → stop → transit leg → stop. Low-emphasis by
// default, crisp on hover/focus. Warm-paper cards, ink-navy, Fraunces +
// Space Grotesk; chartreuse stays reserved for the active/changed stop.

export interface StripLeg {
  legId?: string | null;
  mode: "transit" | "walk" | "driving" | "unknown";
  totalMinutes: number;
  marginMinutes: number;
  lineName?: string | null;
  headsign?: string | null;
  stopCount?: number | null;
  departStop?: string | null;
  /** the SCHEDULER's two instants for this leg: when the previous stop's
   * dwell ends (you leave) and when the next one starts (you arrive).
   * `leaveISO` used to be called `boardISO` and was printed as "board",
   * which named the wrong moment entirely — you do not board the train
   * when you stand up from dinner. The real board time is the provider's,
   * and it rides on each segment. */
  leaveISO?: string | null;
  arriveISO?: string | null;
  /** every ride of the leg in order (transfer bubbles + the provider's own
   * board/alight instants); absent/empty on walk legs and on plans stored
   * before segments existed */
  segments?: RideDetail[] | null;
}

export interface StripStop {
  id: string;
  category: string;
  name: string;
  start: string | null;
  end: string | null;
  rating?: number | null;
  price?: string | null;
  /** one-line venue blurb (Places editorialSummary) */
  description?: string | null;
  reason?: string | null;
  status?: "upcoming" | "active" | "completed" | "skipped";
  changed?: boolean;
  oldStart?: string | null;
  /** the transit/walk leg leaving this stop (null on the last) */
  legToNext?: StripLeg | null;
}

export interface StripHome {
  label: string;
  leaveBy?: string | null;
  leg?: StripLeg | null;
}

/**
 * Star row for a rating. Presentation only — it renders the `rating` the
 * pipeline already carries on the stop, rounded to the nearest whole star,
 * with the numeric value alongside. Deliberately NO review count: Places'
 * userRatingCount isn't in the search field mask, so showing one would mean
 * changing what the pipeline fetches, which is a data change, not a design
 * one.
 */
function Stars({ rating }: { rating: number }) {
  const full = Math.round(rating);
  return (
    <span className="lstrip__stars" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} viewBox="0 0 24 24">
          <path
            className={i < full ? "st-on" : "st-off"}
            d="M12 3.4l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.5l5.8-.8z"
          />
        </svg>
      ))}
    </span>
  );
}

const PRICE_LABEL: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

function TransitIcon({ mode }: { mode: StripLeg["mode"] }) {
  if (mode === "driving") {
    // A car. It exists because the mode ternary below used to have no
    // driving branch: a drive leg fell through to the WALK arm and was
    // rendered with the walking safety caution under a BUS glyph.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M18.9 6.6A1.5 1.5 0 0 0 17.5 5.5h-11A1.5 1.5 0 0 0 5.1 6.6L3 12.7V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.5h12V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-7.3zM6.8 7.5h10.4l1.4 4.1H5.4zM6.5 16.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm11 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z" />
      </svg>
    );
  }
  if (mode === "walk") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M13 5.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM9 21l2-5 2 2v3h2v-4.3l-2-2 .6-3A6 6 0 0 0 18 12v-2a4 4 0 0 1-3.4-2l-1-1.6a2 2 0 0 0-2.6-.6L7.5 8v4h2V9.2l1.4-.6L9.3 15 6.8 20z" />
      </svg>
    );
  }
  // transit (subway/bus glyph)
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3c-2.8 0-5 .4-5 3v8.5A2.5 2.5 0 0 0 4.5 17L3 18.5V19h2l1.3-1.3c.2 0 .5.1.7.1h6c.2 0 .5 0 .7-.1L15 19h2v-.5L15.5 17A2.5 2.5 0 0 0 18 14.5V6c0-2.6-2.7-3-5-3zm-2.5 12A1.5 1.5 0 1 1 6 13.5 1.5 1.5 0 0 1 4.5 15zM11 10H4V6h7zm2 0V6h7v4zm2.5 5a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5z" />
    </svg>
  );
}

/** The route badge: the agency's authentic designation in the ride
 *  occurrence's app-owned colour. Legacy and overflow records retain the
 *  provider-colour treatment. Shape, border, shadow and placement stay the
 *  same everywhere the badge appears, including BOARD timeline rows.
 *
 *  Decorative by construction: an unpublished colour falls back to ink and
 *  an unpublished short name to initials, so there is never a blank circle,
 *  and the published line name travels beside it in text for a screen
 *  reader (spans, not divs — this sits inside the card's selection button,
 *  whose content model is phrasing content). */
function RouteBadge({ line }: { line: LineBadge }) {
  const colors = bubbleDisplayColors(line.segment);
  return (
    <span
      className="lstrip__bubble lstrip__bubble--inline"
      style={{
        background: colors.background,
        color: colors.foreground,
      }}
      title={line.segment.lineName}
      aria-hidden="true"
    >
      {line.badge}
    </span>
  );
}

/** What the leg IS: a route badge where each route is referenced, the place
 *  that route serves beside it, and an arrow BETWEEN the rides of a
 *  transfer. One ride is one badge and no arrow; a leg with no known rides
 *  never reaches here and keeps its mode glyph and its plain line text. */
function LegLines({
  lines,
  stopCount,
}: {
  lines: LineBadge[];
  stopCount?: number | null;
}) {
  return (
    <span className="lstrip__lineid">
      {/* ORDINARY TEXT FLOW, not a row of boxes: the badge is an inline
          element sitting on the text's own line, so a long place name wraps
          across the FULL width of the card the way the spelled-out line
          always did. Laid out as flex rows instead, each name is squeezed
          into whatever is left beside its circle and breaks mid-word. */}
      {lines.map((line, i) => (
        <span className="lstrip__lineseg" key={i}>
          {i > 0 && (
            <>
              <span className="lstrip__linearrow" aria-hidden="true">
                →
              </span>{" "}
              <span className="sr-only">, then </span>
            </>
          )}
          <RouteBadge line={line} />
          {/* the badge is a colour and a designation; the line's PUBLISHED
              name is what a screen reader should hear, so the visible place
              text beside it is the duplicate that hides */}
          <span className="sr-only">{line.segment.lineName}</span>
          {line.place && (
            <>
              {" "}
              <span className="lstrip__lineplace" aria-hidden="true">
                {line.place}
              </span>
            </>
          )}
          {i < lines.length - 1 ? " " : null}
        </span>
      ))}
      {/* stopCount is the FIRST ride's, so it still prints only when one
          ride owns the whole leg — unchanged from the spelled-out line */}
      {lines.length === 1 && stopCount ? (
        <span className="lstrip__linestops"> · {stopCount} stops</span>
      ) : null}
    </span>
  );
}

/**
 * One travel leg. On a transit leg with the provider's own board/alight
 * instants it shows the FOUR REAL INSTANTS — leave → board → alight →
 * arrive, a board/alight pair per ride — so the walk to the stop, the
 * wait, and each transfer are visible rather than folded invisibly into
 * one span. Compact, it shows the line and how long the leg takes.
 *
 * WHEN it shows them is `shouldShowTimeline`: the traveller is ON this leg
 * right now, or they tapped it. There is no show/hide control — the one
 * that used to sit here asked the user to operate a switch for information
 * they had either just asked for or were standing in the middle of.
 *
 * Without usable provider times (a walk leg, an older stored plan, a ride
 * the agency publishes no times for, or times that no longer match this
 * leg's window) the card keeps the single `leave · arrive` line. Identified
 * inter-stop walks remain selectable as complete map legs, but never invent
 * a transit timeline or timeline disclosure state.
 */
function LegCard({
  leg,
  timeZone,
  now,
  origin,
  manualLegId,
  onToggleManualLeg,
}: {
  leg: StripLeg;
  timeZone: string;
  /** the instant the plan is being READ at — the app's one "now", so the
   *  leg that is underway agrees with the stop wearing the "now" pill */
  now: Date;
  origin: "home" | "interstop";
  manualLegId: string | null;
  onToggleManualLeg: (legId: string) => void;
}) {
  // This leg's SELECTION: the user tapped this card. One of the two inputs
  // to the visibility rule — the other is the clock, and neither is a
  // disclosure the user has to find.
  const [legacySelected, setLegacySelected] = useState(false);
  const timelineId = useId();
  const isTransit = leg.mode === "transit";
  const isWalk = leg.mode === "walk";
  const segments = isTransit ? leg.segments ?? [] : [];
  const timeline = isTransit
    ? buildTransitTimeline({
        leaveISO: leg.leaveISO,
        arriveISO: leg.arriveISO,
        rides: segments,
      })
    : null;
  const isDriving = leg.mode === "driving";
  const identified = typeof leg.legId === "string";
  // A driving leg is selectable even though it has no timeline to expand:
  // selecting it is what focuses the map on that leg and shows its duration
  // pointer, the way a maps app puts the time on the route you tapped.
  const routeSelectable =
    identified && (isTransit || isDriving || (isWalk && origin === "interstop"));
  const manuallySelected = routeSelectable
    ? manualLegId === leg.legId
    : isTransit && !identified
      ? legacySelected
      : false;
  const underway = legUnderway(leg, now.getTime());
  const showTimeline = shouldShowTimeline({
    isTransit,
    hasTimeline: timeline !== null,
    isActiveNow: underway,
    isSelected: manuallySelected,
  });
  const legLabel =
    leg.mode === "transit"
      ? "transit leg"
      : leg.mode === "walk"
        ? "walking leg"
        : leg.mode === "driving"
          ? "driving leg"
          : "travel estimate";
  const at = (iso: string) => formatStopTime(iso, new Date(), timeZone);

  // The leg's rides as badge + place, in riding order. Empty on a walk, on
  // an `unknown` estimate, and on a plan stored before segments existed —
  // all three keep the mode glyph and the plain line text below.
  const lines = lineBadges(segments);

  // the mode glyph, for a leg with no rides to badge. Phrasing content so
  // it can sit inside the selection button below.
  const glyph = (
    <span className="lstrip__legicon">
      <TransitIcon mode={leg.mode} />
    </span>
  );

  // What the leg IS, and how long it takes. The identity survives every
  // state of the card; only the TIMES move. The minutes are the leg's
  // total — the buffer inside them is a scheduling margin, not something
  // the traveller acts on.
  const transitSummary = (
    <>
      {lines.length === 0 && glyph}
      <span className="lstrip__legline">
        {lines.length > 0 ? (
          // the routes you actually ride, in order, each as its own badge
          <LegLines lines={lines} stopCount={leg.stopCount} />
        ) : (
          `${leg.lineName ?? "transit"}${leg.stopCount ? ` · ${leg.stopCount} stops` : ""}`
        )}
      </span>
      <span className="lstrip__legmeta">{leg.totalMinutes} min</span>
      {/* the two instants the SCHEDULER owns, named for what they are */}
      {!showTimeline && (leg.leaveISO || leg.arriveISO) && (
        <span className="lstrip__legtimes">
          {leg.leaveISO ? `leave ${at(leg.leaveISO)}` : null}
          {leg.leaveISO && leg.arriveISO ? " · " : null}
          {leg.arriveISO ? `arrive ${at(leg.arriveISO)}` : null}
        </span>
      )}
    </>
  );

  const walkSummary = (
    <>
      {glyph}
      <span className="lstrip__legline">walk</span>
      <span className="lstrip__legmeta">{leg.totalMinutes} min</span>
    </>
  );

  // A DRIVING leg says what it is, how long it takes, and when you leave and
  // arrive — and nothing else. No route badges (there is no route), no
  // board/alight timeline (nothing is published), no transfer rows, and NO
  // walking caution: that caution is a provider requirement about pedestrian
  // paths and is a lie on a leg nobody walks.
  //
  // The transit decorations degrade on their own — `legDetail`/`legSegments`
  // return null off transit, `shouldShowTimeline` refuses on `!isTransit`,
  // and the palette only mints slots from transit steps — so this branch adds
  // the base row rather than suppressing anything.
  const driveSummary = (
    <>
      {glyph}
      <span className="lstrip__legline">Drive</span>
      <span className="lstrip__legmeta">{leg.totalMinutes} min</span>
      {(leg.leaveISO || leg.arriveISO) && (
        <span className="lstrip__legtimes">
          {leg.leaveISO ? `leave ${at(leg.leaveISO)}` : null}
          {leg.leaveISO && leg.arriveISO ? " · " : null}
          {leg.arriveISO ? `arrive ${at(leg.arriveISO)}` : null}
        </span>
      )}
    </>
  );

  return (
    <div
      className={"lstrip__leg" + (showTimeline ? " lstrip__leg--open" : "")}
      role="listitem"
      aria-label={legLabel}
    >
      {isTransit ? (
        <>
          {identified ? (
            // A native button, like the stop card's summary — the timeline
            // is its SIBLING, never nested inside it.
            <button
              type="button"
              className="lstrip__legselect"
              aria-pressed={manuallySelected}
              aria-expanded={timeline ? showTimeline : undefined}
              aria-controls={timeline ? timelineId : undefined}
              onClick={() => onToggleManualLeg(leg.legId!)}
            >
              {transitSummary}
            </button>
          ) : timeline ? (
            <button
              type="button"
              className="lstrip__legselect"
              aria-expanded={showTimeline}
              aria-controls={timelineId}
              onClick={() => setLegacySelected((v) => !v)}
            >
              {transitSummary}
            </button>
          ) : (
            transitSummary
          )}
          {timeline && showTimeline && (
            <>
              <ol className="lstrip__timeline" id={timelineId}>
                {timeline.map((row, i) => (
                  <li
                    key={i}
                    className={`lstrip__tlrow lstrip__tlrow--${row.kind}`}
                  >
                    {/* the badge rides with the BOARD instant, because that
                        is where you get on that route. The cell is always
                        present so every row's word starts at the same
                        column — an empty rail, not a shifted line. */}
                    <span className="lstrip__tlbadge">
                      {row.kind === "board" && lines[row.rideIndex] ? (
                        <RouteBadge line={lines[row.rideIndex]} />
                      ) : null}
                    </span>
                    <span className="lstrip__tlwhat">{row.kind}</span>
                    <span className="lstrip__tltime">{at(row.instantISO)}</span>
                    {row.kind === "board" && (
                      <span className="lstrip__tlwhere">
                        {row.stop ? `${row.line} · ${row.stop}` : row.line}
                      </span>
                    )}
                    {row.kind === "alight" && row.stop && (
                      <span className="lstrip__tlwhere">{row.stop}</span>
                    )}
                  </li>
                ))}
              </ol>
              {/* The board/alight instants are the timetable for the
                  departure this leg was priced at — a schedule, not a
                  promise about the vehicle you will be standing on. */}
              <p className="lstrip__tlnote">scheduled times</p>
            </>
          )}
        </>
      ) : leg.mode === "unknown" ? (
        <>
          {glyph}
          {/* neither routing mode came back — the number is a straight-line
              estimate, and must never read as a promise (§6.2) */}
          <div className="lstrip__legline">travel time unavailable</div>
          <div className="lstrip__legmeta">~{leg.totalMinutes} min (estimated)</div>
        </>
      ) : isDriving ? (
        // EXPLICIT, and it has to be: the final `else` below is the WALK arm,
        // so a mode with no branch of its own is silently rendered as a walk.
        // TypeScript cannot catch that — the else makes the ternary total.
        routeSelectable ? (
          <button
            type="button"
            className="lstrip__legselect"
            aria-pressed={manuallySelected}
            onClick={() => onToggleManualLeg(leg.legId!)}
          >
            {driveSummary}
          </button>
        ) : (
          driveSummary
        )
      ) : (
        <>
          {routeSelectable ? (
            <button
              type="button"
              className="lstrip__legselect"
              aria-pressed={manuallySelected}
              onClick={() => onToggleManualLeg(leg.legId!)}
            >
              {walkSummary}
            </button>
          ) : (
            walkSummary
          )}
          <div
            className="lstrip__walkwarning"
            role="note"
            aria-label="Walking route caution: Walking routes are in beta and may miss sidewalks or pedestrian paths. Use caution."
          >
            Walking routes are in beta and may miss sidewalks or pedestrian
            paths. Use caution.
          </div>
        </>
      )}
    </div>
  );
}

export interface SwapInline {
  text: string;
  onText: (v: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  disabled: boolean;
  error: string | null;
  canSwap: boolean;
}

export interface RemoveInline {
  onConfirm: () => void;
  submitting: boolean;
  disabled: boolean;
  error: string | null;
  canRemove: boolean;
}

export interface StripFocusRequest {
  stopId: string;
  nonce: number;
}

/**
 * Remove, in two beats: ARM, then CONFIRM.
 *
 * A single-press delete on a card the user may only have tapped to read is the
 * wrong shape, and there is no undo to fall back on — `removeStop` splices the
 * stop out and the record of it is gone. So the press that looks destructive
 * only ASKS, and the press that acts is the second one, on a control that has
 * turned red and says plainly that it cannot be taken back.
 *
 * Everything about the armed state defaults to SAFE. "Keep" takes focus the
 * moment the question appears, so the destructive button is never what a
 * Return keypress lands on. Escape steps back one level rather than out.
 * A pointer press anywhere else disarms — POINTERDOWN and not click, the rule
 * the account menu already follows: a click-based dismissal survives under a
 * finger through a scroll, which leaves an armed delete sitting on screen
 * after the user has visibly moved on.
 */
function RemoveControl({
  stopName,
  armed,
  onArm,
  onDisarm,
  remove,
}: {
  stopName: string;
  armed: boolean;
  onArm: () => void;
  onDisarm: () => void;
  remove: RemoveInline;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const wasSubmitting = useRef(false);

  useEffect(() => {
    if (armed) keepRef.current?.focus();
  }, [armed]);

  // Disarm once the request settles. A SUCCESSFUL removal takes this card off
  // the strip entirely, so the case this actually serves is a refusal — where
  // leaving the control armed would invite a retry of something the server has
  // already explained it will not do.
  useEffect(() => {
    if (wasSubmitting.current && !remove.submitting) onDisarm();
    wasSubmitting.current = remove.submitting;
  }, [remove.submitting, onDisarm]);

  useEffect(() => {
    if (!armed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDisarm();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      onDisarm();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [armed, onDisarm]);

  if (!armed) {
    return (
      <div className="lstrip__remove" ref={rootRef}>
        <button
          type="button"
          className="lstrip__removearm"
          disabled={remove.disabled}
          onClick={onArm}
          aria-label={`Remove ${stopName}`}
        >
          Remove
        </button>
      </div>
    );
  }

  return (
    <div className="lstrip__remove lstrip__remove--armed" ref={rootRef}>
      <p className="lstrip__removeask" role="alert">
        Remove this stop? This can&apos;t be undone.
      </p>
      <div className="lstrip__removerow">
        <button
          type="button"
          className="lstrip__removekeep"
          ref={keepRef}
          onClick={onDisarm}
        >
          Keep
        </button>
        <button
          type="button"
          className="lstrip__removego"
          disabled={remove.disabled}
          onClick={remove.onConfirm}
          aria-label={`Confirm removing ${stopName}`}
          aria-describedby={remove.error ? errorId : undefined}
        >
          {remove.submitting ? "…" : "Confirm"}
        </button>
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {remove.submitting ? `Removing ${stopName}…` : ""}
      </span>
      {remove.error && (
        <div id={errorId} className="lstrip__removeerr" role="alert">
          {remove.error}
        </div>
      )}
    </div>
  );
}

function StopCard({
  stop,
  index,
  selected,
  onSelect,
  swap,
  remove,
  timeZone,
  focusRequest,
  onFocusHandled,
}: {
  stop: StripStop;
  index: number;
  selected: boolean;
  onSelect: () => void;
  swap?: SwapInline | null;
  remove?: RemoveInline | null;
  timeZone: string;
  focusRequest?: StripFocusRequest | null;
  onFocusHandled?: (nonce: number) => void;
}) {
  const selectRef = useRef<HTMLButtonElement>(null);
  const handledFocusNonce = useRef<number | null>(null);
  const detailsId = useId();
  const swapInputId = useId();
  const swapErrorId = useId();
  // Armed lives HERE rather than inside the control, because the card's own
  // border turns danger-red while the question is up — the thing being removed
  // has to be the thing that looks at risk. It needs no reset: the control is
  // only rendered for the selected card, so deselecting unmounts it and the
  // state goes with it.
  const [armed, setArmed] = useState(false);
  const disarm = useCallback(() => setArmed(false), []);
  const price = stop.price ? PRICE_LABEL[stop.price] ?? null : null;
  const cls =
    "lstrip__stop" +
    (selected ? " lstrip__stop--sel" : "") +
    (stop.status === "active" ? " lstrip__stop--live" : "") +
    (stop.status === "completed" ? " lstrip__stop--done" : "") +
    (stop.changed ? " lstrip__stop--changed" : "") +
    (armed ? " lstrip__stop--arming" : "");

  useEffect(() => {
    if (
      !focusRequest ||
      focusRequest.stopId !== stop.id ||
      handledFocusNonce.current === focusRequest.nonce
    ) {
      return;
    }

    const button = selectRef.current;
    if (!button) return;
    button.scrollIntoView({ block: "nearest", inline: "center" });
    button.focus({ preventScroll: true });
    if (document.activeElement !== button) return;

    handledFocusNonce.current = focusRequest.nonce;
    onFocusHandled?.(focusRequest.nonce);
  }, [focusRequest, onFocusHandled, stop.id]);

  return (
    <div className={cls} role="listitem">
      <button
        ref={selectRef}
        type="button"
        className="lstrip__select"
        aria-expanded={selected}
        aria-controls={detailsId}
        onClick={onSelect}
      >
        <span className="sr-only">View stop {index + 1}: </span>
        <span className="lstrip__stophead">
          <span className="lstrip__num" aria-hidden="true">
            {index + 1}
          </span>
          <span className="eyebrow">{stop.category}</span>
          {stop.status === "active" && <span className="lstrip__now">now</span>}
        </span>
        <span className="lstrip__name">{stop.name}</span>
        {stop.start && stop.end && (
          <span className="lstrip__be">
            {stop.changed && stop.oldStart ? (
              <>
                <span className="old-time">{formatStopTime(stop.oldStart, new Date(), timeZone)}</span>
                <span className="new-time">{formatStopTime(stop.start, new Date(), timeZone)}</span>
              </>
            ) : (
              <>be here {formatStopRange(stop.start, stop.end, new Date(), timeZone)}</>
            )}
          </span>
        )}
        <span className="lstrip__facts">
          {stop.rating != null && (
            <>
              <Stars rating={stop.rating} />
              <span className="lstrip__rating">{stop.rating.toFixed(1)}</span>
            </>
          )}
          {price && <span className="lstrip__price">{price}</span>}
          {/* parks with no price data are free — say so instead of a blank
              (keep-on-missing elsewhere: unknown price on a venue stays silent) */}
          {!price && resolveCategory(stop.category) === "park" && (
            <span className="lstrip__price">Free</span>
          )}
        </span>
        {stop.description && <span className="lstrip__desc">{stop.description}</span>}
      </button>
      <div id={detailsId} hidden={!selected}>
        {/* the reason is PICK JUSTIFICATION, never a description — labeled so
            that on venues with no Places editorial (desc line absent) the
            LLM-written reason can't read as a factual description */}
        {stop.reason && (
          <div className="lstrip__reason">
            <span className="lstrip__why">why here</span>
            {stop.reason}
          </div>
        )}
        {swap?.canSwap && (
          <form
            className="lstrip__swap"
            aria-label={`Change ${stop.name}`}
            aria-busy={swap.submitting}
            onSubmit={(event) => {
              event.preventDefault();
              if (!swap.disabled && swap.text.trim()) swap.onSubmit();
            }}
          >
            <span
              className="sr-only"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {swap.submitting ? `Updating ${stop.name}…` : ""}
            </span>
            <label
              className="lstrip__swaplabel"
              htmlFor={swapInputId}
            >
              Not quite right?
            </label>
            <div className="lstrip__swaprow">
              <input
                id={swapInputId}
                className="lstrip__swapinput"
                value={swap.text}
                disabled={swap.disabled}
                onChange={(e) => swap.onText(e.target.value)}
                placeholder="cheaper, an hour earlier, a patio…"
                aria-invalid={swap.error ? true : undefined}
                aria-describedby={swap.error ? swapErrorId : undefined}
              />
              <button
                type="submit"
                className="lstrip__swapgo"
                disabled={swap.disabled || !swap.text.trim()}
                aria-label={`Swap ${stop.name}`}
              >
                {swap.submitting ? "…" : "Swap"}
              </button>
            </div>
            {swap.error && (
              <div id={swapErrorId} className="lstrip__swaperr" role="alert">
                {swap.error}
              </div>
            )}
          </form>
        )}
        {/* A SIBLING of the swap form, never a child of it: a button nested
            inside that form would submit it, and the arm press would fire a
            swap with an empty refinement instead of asking a question. */}
        {remove?.canRemove && (
          <RemoveControl
            stopName={stop.name}
            armed={armed}
            onArm={() => setArmed(true)}
            onDisarm={disarm}
            remove={remove}
          />
        )}
      </div>
    </div>
  );
}

export interface ItineraryStripProps {
  home?: StripHome | null;
  stops: StripStop[];
  selected: string | null;
  /** selects by VENUE ID — a category is not a stop identity (§7.2) */
  onSelect: (stopId: string) => void;
  swap?: SwapInline | null;
  remove?: RemoveInline | null;
  timeZone?: string;
  /** The instant this plan is being read at — the SAME one the store was
   *  asked for when it derived which stop is "active" (the dev time control
   *  moves both, or neither). It decides which leg is underway, and it is
   *  read at RENDER: nothing here ticks, so an auto-shown leg re-evaluates
   *  on the app's existing render cadence, never on a timer of its own. */
  now?: Date;
  manualLegId?: string | null;
  onToggleManualLeg?: (legId: string) => void;
  focusRequest?: StripFocusRequest | null;
  onFocusHandled?: (nonce: number) => void;
}

export default function ItineraryStrip({
  home,
  stops,
  selected,
  onSelect,
  swap,
  remove,
  timeZone = "America/Toronto",
  now = new Date(),
  manualLegId = null,
  onToggleManualLeg = () => {},
  focusRequest,
  onFocusHandled,
}: ItineraryStripProps) {
  if (stops.length === 0) return null;
  return (
    <div className="lstrip" role="list" aria-label="Your evening, stop by stop">
      {home && (
        <div className="lstrip__home" role="listitem">
          <div className="lstrip__homehead">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="lstrip__homeicon">
              <path d="M12 3 3 10v11h6v-6h6v6h6V10z" />
            </svg>
            <span className="eyebrow">home</span>
          </div>
          <div className="lstrip__name lstrip__name--home">
            {originDisplayLabel(home.label)}
          </div>
          {home.leaveBy && <div className="lstrip__be">leave by {home.leaveBy}</div>}
        </div>
      )}
      {home?.leg && <LegCard leg={home.leg} timeZone={timeZone} now={now} origin="home" manualLegId={manualLegId} onToggleManualLeg={onToggleManualLeg} />}
      {stops.map((s, i) => (
        <Fragment key={s.id}>
          <StopCard
            stop={s}
            index={i}
            selected={selected === s.id}
            onSelect={() => onSelect(s.id)}
            swap={selected === s.id ? swap : null}
            remove={selected === s.id ? remove : null}
            timeZone={timeZone}
            focusRequest={focusRequest}
            onFocusHandled={onFocusHandled}
          />
          {s.legToNext && (
            <LegCard leg={s.legToNext} timeZone={timeZone} now={now} origin="interstop" manualLegId={manualLegId} onToggleManualLeg={onToggleManualLeg} />
          )}
        </Fragment>
      ))}
    </div>
  );
}
