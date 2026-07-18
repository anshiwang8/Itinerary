"use client";

import { formatStopRange, formatStopTime } from "./lib/timeLabels";
import { resolveCategory } from "./api/schedule/durations";

// Horizontal itinerary strip — the primary surface, sitting just under
// the search bar. Reads left to right like a transit-app trip view:
// home → stop → transit leg → stop → transit leg → stop. Low-emphasis by
// default, crisp on hover/focus. Warm-paper cards, ink-navy, Fraunces +
// Space Grotesk; chartreuse stays reserved for the active/changed stop.

export interface StripLeg {
  mode: "transit" | "walk" | "unknown";
  totalMinutes: number;
  marginMinutes: number;
  lineName?: string | null;
  headsign?: string | null;
  stopCount?: number | null;
  departStop?: string | null;
  boardISO?: string | null;
  arriveISO?: string | null;
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

const PRICE_LABEL: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

function TransitIcon({ mode }: { mode: StripLeg["mode"] }) {
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

function LegCard({ leg, timeZone }: { leg: StripLeg; timeZone: string }) {
  const isTransit = leg.mode === "transit";
  return (
    <div className="lstrip__leg" aria-label={isTransit ? "transit leg" : "walking leg"}>
      <div className="lstrip__legicon">
        <TransitIcon mode={leg.mode} />
      </div>
      {isTransit ? (
        <>
          <div className="lstrip__legline">
            {leg.lineName ?? "transit"}
            {leg.stopCount ? ` · ${leg.stopCount} stops` : ""}
          </div>
          <div className="lstrip__legmeta">
            {leg.totalMinutes} min{leg.marginMinutes ? ` · incl ${leg.marginMinutes} buffer` : ""}
          </div>
          {(leg.boardISO || leg.arriveISO) && (
            <div className="lstrip__legtimes">
              board {formatStopTime(leg.boardISO ?? "", new Date(), timeZone)} · arrive {formatStopTime(leg.arriveISO ?? "", new Date(), timeZone)}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="lstrip__legline">walk</div>
          <div className="lstrip__legmeta">{leg.totalMinutes} min</div>
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
  error: string | null;
  canSwap: boolean;
}

function StopCard({
  stop,
  index,
  selected,
  onSelect,
  swap,
  timeZone,
}: {
  stop: StripStop;
  index: number;
  selected: boolean;
  onSelect: () => void;
  swap?: SwapInline | null;
  timeZone: string;
}) {
  const price = stop.price ? PRICE_LABEL[stop.price] ?? null : null;
  const cls =
    "lstrip__stop" +
    (selected ? " lstrip__stop--sel" : "") +
    (stop.status === "active" ? " lstrip__stop--live" : "") +
    (stop.status === "completed" ? " lstrip__stop--done" : "") +
    (stop.changed ? " lstrip__stop--changed" : "");
  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        // only keys aimed at the card itself — the inline swap input lives
        // inside this "button", and preventDefault here would eat its spaces
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="lstrip__stophead">
        <span className="lstrip__num">{index + 1}</span>
        <span className="eyebrow">{stop.category}</span>
        {stop.status === "active" && <span className="lstrip__now">now</span>}
      </div>
      <div className="lstrip__name">{stop.name}</div>
      {stop.start && stop.end && (
        <div className="lstrip__be">
          {stop.changed && stop.oldStart ? (
            <>
              <span className="old-time">{formatStopTime(stop.oldStart, new Date(), timeZone)}</span>
              <span className="new-time">{formatStopTime(stop.start, new Date(), timeZone)}</span>
            </>
          ) : (
            <>be here {formatStopRange(stop.start, stop.end, new Date(), timeZone)}</>
          )}
        </div>
      )}
      <div className="lstrip__facts">
        {stop.rating != null && <span className="lstrip__rating">{stop.rating.toFixed(1)}★</span>}
        {price && <span className="lstrip__price">{price}</span>}
        {/* parks with no price data are free — say so instead of a blank
            (keep-on-missing elsewhere: unknown price on a venue stays silent) */}
        {!price && resolveCategory(stop.category) === "park" && (
          <span className="lstrip__price">Free</span>
        )}
      </div>
      {stop.description && <div className="lstrip__desc">{stop.description}</div>}
      {/* the reason is PICK JUSTIFICATION, never a description — labeled so
          that on venues with no Places editorial (desc line absent) the
          Groq-written reason can't read as a factual description */}
      {selected && stop.reason && (
        <div className="lstrip__reason">
          <span className="lstrip__why">why here</span>
          {stop.reason}
        </div>
      )}
      {selected && swap?.canSwap && (
        <div className="lstrip__swap" onClick={(e) => e.stopPropagation()}>
          <div className="lstrip__swaplabel">Not quite right?</div>
          <div className="lstrip__swaprow">
            <input
              className="lstrip__swapinput"
              value={swap.text}
              onChange={(e) => swap.onText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") swap.onSubmit();
              }}
              placeholder="cheaper, an hour earlier, a patio…"
              aria-label={`Tell me what to change about ${stop.name}`}
            />
            <button
              className="lstrip__swapgo"
              onClick={swap.onSubmit}
              disabled={swap.submitting || !swap.text.trim()}
            >
              {swap.submitting ? "…" : "Swap"}
            </button>
          </div>
          {swap.error && <div className="lstrip__swaperr">{swap.error}</div>}
        </div>
      )}
    </div>
  );
}

export default function ItineraryStrip({
  home,
  stops,
  selected,
  onSelect,
  swap,
  timeZone = "America/Toronto",
}: {
  home?: StripHome | null;
  stops: StripStop[];
  selected: string | null;
  /** selects by VENUE ID — a category is not a stop identity (§7.2) */
  onSelect: (stopId: string) => void;
  swap?: SwapInline | null;
  timeZone?: string;
}) {
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
          <div className="lstrip__name lstrip__name--home">{home.label.replace(/^Home · /, "")}</div>
          {home.leaveBy && <div className="lstrip__be">leave by {home.leaveBy}</div>}
        </div>
      )}
      {home?.leg && <LegCard leg={home.leg} timeZone={timeZone} />}
      {stops.map((s, i) => (
        <div key={s.id} className="lstrip__pair" role="listitem" style={{ display: "contents" }}>
          <StopCard
            stop={s}
            index={i}
            selected={selected === s.id}
            onSelect={() => onSelect(s.id)}
            swap={selected === s.id ? swap : null}
            timeZone={timeZone}
          />
          {s.legToNext && <LegCard leg={s.legToNext} timeZone={timeZone} />}
        </div>
      ))}
    </div>
  );
}
