"use client";

import { Fragment } from "react";
import { TransitIcon, type StripHome, type StripLeg, type StripStop } from "./ItineraryStrip";
import { originDisplayLabel } from "./lib/locationLabels";
import { type SheetEntry } from "./lib/mobileSheetLayout";
import { formatStopRange, formatStopTime } from "./lib/timeLabels";
import { bubbleDisplayColors, lineBadges, type LineBadge } from "./lib/transitBubbles";
import { buildTransitTimeline, type TimelineRow } from "./lib/transitDetail";

// These are views of the same strip models used on desktop. Provider transit
// details pass through the shared completeness/staleness guard before display;
// the gaps around rides never become invented walking or waiting instructions.
const PRICE_LABEL: Record<string, string> = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

interface EntryProps {
  entry: SheetEntry;
  selected: string | null;
  onSelect: (stopId: string) => void;
  timeZone: string;
  now?: Date;
  arrivedStopId?: string | null;
  stopNumber?: number;
  stopCount?: number;
}

interface HalfPageProps extends EntryProps {
  /** Opens the full, scrollable itinerary where every summary fact is shown. */
  onShowDetails: () => void;
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3 11 9-8 9 8M6 9v12h12V9m-8 12v-7h4v7" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg className="msheet__chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

function StopFacts({ stop }: { stop: StripStop }) {
  const price = stop.price ? PRICE_LABEL[stop.price] ?? null : null;
  if (stop.rating == null && !price) return null;
  return (
    <span className="msheet__facts">
      {stop.rating != null && <span aria-label={`Rated ${stop.rating.toFixed(1)} out of 5`}>★ {stop.rating.toFixed(1)}</span>}
      {stop.rating != null && price && <span className="msheet__factdot" aria-hidden="true" />}
      {price && <span>{price}</span>}
    </span>
  );
}

function RouteBadge({ line }: { line: LineBadge }) {
  const colors = bubbleDisplayColors(line.segment);
  return (
    <span
      className="msheet__routebadge"
      style={{ background: colors.background, color: colors.foreground }}
      aria-label={line.segment.lineName}
    >
      {line.badge}
    </span>
  );
}

function ModeIcon({ mode }: { mode: StripLeg["mode"] }) {
  return (
    <span className="msheet__modeicon">
      {mode === "unknown" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fillRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 14h2v2h-2v-2Zm1-11a3.6 3.6 0 0 0-3.7 3.5h2a1.7 1.7 0 0 1 3.4 0c0 .7-.4 1.1-1.1 1.6-.9.6-1.6 1.3-1.6 2.9v1h2v-1c0-.7.2-1 .9-1.5.9-.6 1.8-1.4 1.8-3A3.6 3.6 0 0 0 12 5Z" />
        </svg>
      ) : <TransitIcon mode={mode} />}
    </span>
  );
}

function WalkCaution() {
  return <span className="msheet__walkwarning" role="note" aria-label="Walking route caution: Walking routes are in beta and may miss sidewalks or pedestrian paths. Use caution.">Walking routes are in beta and may miss sidewalks or pedestrian paths. Use caution.</span>;
}

function modeLabel(leg: StripLeg): string {
  if (leg.mode === "walk") return "Walk";
  if (leg.mode === "driving") return "Drive";
  if (leg.mode === "unknown") return "Travel time unavailable";
  return "Transit";
}

function durationBetween(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const minutes = (Date.parse(end) - Date.parse(start)) / 60_000;
  return Number.isFinite(minutes) && minutes > 0 ? Math.max(1, Math.round(minutes)) : null;
}

function HomeLeave({ home, timeZone, now }: { home: StripHome; timeZone: string; now: Date }) {
  const leave = home.leg?.leaveISO;
  if (leave) return <span className="msheet__rowwhen">Leave at {formatStopTime(leave, now, timeZone)}</span>;
  return home.leaveBy ? <span className="msheet__rowwhen">Leave by {home.leaveBy}</span> : null;
}

function StopTime({ stop, timeZone, now, summary = false }: { stop: StripStop; timeZone: string; now: Date; summary?: boolean }) {
  if (!stop.start || !stop.end) return null;
  return (
    <span className={"msheet__rowwhen" + (stop.changed ? " msheet__rowwhen--changed" : "")}>
      {!summary && stop.changed && stop.oldStart && stop.oldStart !== stop.start && (
        <s className="msheet__oldtime">{formatStopTime(stop.oldStart, now, timeZone)}</s>
      )}
      {formatStopRange(stop.start, stop.end, now, timeZone)}
    </span>
  );
}

function statusClasses(base: string, stop: StripStop, arrived: boolean): string {
  return (stop.status === "active" ? ` ${base}--active` : "")
    + (stop.changed ? ` ${base}--changed` : "")
    + (stop.status === "completed" || stop.status === "skipped" ? ` ${base}--past` : "")
    + (arrived && stop.status === "active" ? ` ${base}--arrived` : "");
}

export function PeekLine({
  stop,
  timeZone,
  now = new Date(),
}: { stop: StripStop; timeZone: string; now?: Date }) {
  return (
    <span className="msheet__peek">
      <svg className="msheet__peekicon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 21s-7-6.2-7-11.6A7 7 0 0 1 19 9.4C19 14.8 12 21 12 21zm0-9.4a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z" />
      </svg>
      <span className="msheet__peekbody">
        <span className="msheet__peekname">{stop.name}</span>
        {stop.start && stop.end && (
          <span className="msheet__peekwhen">{formatStopRange(stop.start, stop.end, now, timeZone)}</span>
        )}
      </span>
      {stop.status === "active" && <span className="msheet__peeknow">now</span>}
      <Chevron />
    </span>
  );
}

export function HalfPage({
  entry, selected, onSelect, onShowDetails, timeZone, now = new Date(), arrivedStopId, stopNumber, stopCount,
}: HalfPageProps) {
  if (entry.kind === "home") {
    return (
      <div className="msheet__page msheet__page--home">
        <div className="msheet__pagesummary">
          <span className="msheet__summaryhead"><span className="msheet__homeicon"><HomeIcon /></span><span className="msheet__eyebrow">Home</span></span>
          <span className="msheet__homename">{originDisplayLabel(entry.home.label)}</span>
          <HomeLeave home={entry.home} timeZone={timeZone} now={now} />
        </div>
        <button type="button" className="msheet__details" onClick={onShowDetails} aria-label="Show home details in full itinerary">Details <Chevron /></button>
      </div>
    );
  }
  if (entry.kind === "leg") {
    const leg = entry.leg;
    const lines = leg.mode === "transit" ? lineBadges(leg.segments ?? []) : [];
    return (
      <div className="msheet__page msheet__page--leg" aria-label={`${modeLabel(leg)}${leg.mode !== "unknown" ? `, ${leg.totalMinutes} minutes` : ""}`}>
        <div className="msheet__pagesummary">
          <span className="msheet__summaryhead"><ModeIcon mode={leg.mode} /><span className="msheet__legname">{modeLabel(leg)}</span></span>
          {lines.length > 0 && (
            <span className="msheet__routes">
              {lines.slice(0, 2).map((line, index) => (
                <Fragment key={line.segment.rideId ?? index}>
                  {index > 0 && <span className="msheet__routearrow" aria-hidden="true">→</span>}
                  <RouteBadge line={line} />
                </Fragment>
              ))}
              {lines.length > 2 && <span className="msheet__more-routes" aria-label={`${lines.length - 2} more rides in full itinerary`}>+{lines.length - 2}</span>}
            </span>
          )}
          <span className="msheet__summarytime">
            {leg.mode !== "unknown" && <span className="msheet__legdetail">{leg.totalMinutes} min</span>}
            {leg.leaveISO && <span className="msheet__legdetail">Leave {formatStopTime(leg.leaveISO, now, timeZone)}</span>}
          </span>
        </div>
        <button type="button" className="msheet__details" onClick={onShowDetails} aria-label={leg.mode === "walk" ? "Show walking route caution and full itinerary" : `Show ${modeLabel(leg).toLowerCase()} details in full itinerary`}>
          {leg.mode === "walk" ? "Caution & details" : "Details"} <Chevron />
        </button>
      </div>
    );
  }
  const stop = entry.stop;
  return (
    <div className={"msheet__page" + statusClasses("msheet__page", stop, arrivedStopId === stop.id)}>
      <button
        type="button"
        className="msheet__pageselect"
        aria-pressed={selected === stop.id}
        onClick={() => onSelect(stop.id)}
      >
        <span className="msheet__stophead">
          <span className="msheet__eyebrow">{stop.category}</span>
          {arrivedStopId === stop.id && stop.status === "active" && <span className="sr-only">Arrived</span>}
          {stop.status === "active" ? <span className="msheet__peeknow">now</span> : stopNumber && stopCount ? (
            <span className="msheet__stopcount">{stopNumber} of {stopCount}</span>
          ) : null}
        </span>
        <span className="msheet__pagename">{stop.name}</span>
        <StopTime stop={stop} timeZone={timeZone} now={now} summary />
      </button>
      <button type="button" className="msheet__details" onClick={onShowDetails} aria-label={`Show details for ${stop.name} in full itinerary`}>Details <Chevron /></button>
    </div>
  );
}

type RideTimelineRow = Extract<TimelineRow, { kind: "board" | "alight" }>;

function FullLeg({ leg, timeZone, now }: { leg: StripLeg; timeZone: string; now: Date }) {
  const segments = leg.mode === "transit" ? leg.segments ?? [] : [];
  const timeline = leg.mode === "transit" ? buildTransitTimeline({
    leaveISO: leg.leaveISO,
    arriveISO: leg.arriveISO,
    rides: segments,
  }) : null;
  const lines = lineBadges(segments);

  if (!timeline) {
    return (
      <div className={"msheet__legrow msheet__legrow--" + leg.mode}>
        <ModeIcon mode={leg.mode} />
        <div className="msheet__legbody">
          <span className="msheet__legname">{modeLabel(leg)}{leg.mode !== "unknown" ? ` ${leg.totalMinutes} min` : ""}</span>
          {leg.mode === "transit" && (lines.length > 0 ? (
            <span className="msheet__routelist">
              {lines.map((line, index) => <span className="msheet__routeline" key={line.segment.rideId ?? index}><RouteBadge line={line} /><span>{line.place}</span></span>)}
            </span>
          ) : leg.lineName ? <span className="msheet__legdetail">{leg.lineName}</span> : null)}
          {leg.leaveISO && <span className="msheet__legdetail">Leave {formatStopTime(leg.leaveISO, now, timeZone)}</span>}
          {leg.mode === "walk" && <WalkCaution />}
        </div>
      </div>
    );
  }

  return (
    <div className="msheet__journey-leg">
      <div className="msheet__legrow msheet__legrow--summary">
        <ModeIcon mode="transit" />
        <div className="msheet__legbody">
          <span className="msheet__legname">Transit · {leg.totalMinutes} min total</span>
          {leg.leaveISO && <span className="msheet__legdetail">Leave {formatStopTime(leg.leaveISO, now, timeZone)}</span>}
          {leg.headsign && <span className="msheet__legdetail">Toward {leg.headsign}</span>}
        </div>
      </div>
      {lines.map((line, rideIndex) => {
        // lineBadges maps the complete source rides without filtering. The
        // timeline's rideIndex names that exact same source ride occurrence.
        const rows = timeline.filter((row): row is RideTimelineRow =>
          (row.kind === "board" || row.kind === "alight") && row.rideIndex === rideIndex
        );
        const rideMinutes = durationBetween(rows[0]?.instantISO, rows[1]?.instantISO);
        return (
          <div className="msheet__ride" key={line.segment.rideId ?? rideIndex}>
            <div className="msheet__ridehead">
              <RouteBadge line={line} />
              {line.place && <span className="msheet__ridename">{line.place}</span>}
              {rideMinutes !== null && <span className="msheet__rideminutes">{rideMinutes} min</span>}
            </div>
            <ol className="msheet__ridestops">
              {rows.map((row) => (
                <li className={"msheet__ridepoint msheet__ridepoint--" + row.kind} key={row.kind}>
                  <span className="msheet__riderail" aria-hidden="true" />
                  <span className="msheet__ridewhere"><strong>{row.kind === "board" ? "Board" : "Alight"}</strong>{row.stop && <span>{row.stop}</span>}</span>
                  <time dateTime={row.instantISO}>{formatStopTime(row.instantISO, now, timeZone)}</time>
                </li>
              ))}
            </ol>
          </div>
        );
      })}
      <span className="msheet__scheduled">Scheduled transit times</span>
    </div>
  );
}

export function FullRow({
  entry, selected, onSelect, timeZone, now = new Date(), arrivedStopId, stopNumber,
}: EntryProps) {
  if (entry.kind === "home") {
    return (
      <div className="msheet__row msheet__row--home">
        <span className="msheet__homeicon"><HomeIcon /></span>
        <span className="msheet__rowbody">
          <span className="msheet__originheading">Home</span>
          <span className="msheet__originname">{originDisplayLabel(entry.home.label)}</span>
          <HomeLeave home={entry.home} timeZone={timeZone} now={now} />
        </span>
      </div>
    );
  }
  if (entry.kind === "leg") return <FullLeg leg={entry.leg} timeZone={timeZone} now={now} />;
  const stop = entry.stop;
  const isSelected = selected === stop.id;
  const minutes = durationBetween(stop.start, stop.end);
  return (
    <button
      type="button"
      className={"msheet__row msheet__row--stop" + (isSelected ? " msheet__row--sel" : "") + statusClasses("msheet__row", stop, arrivedStopId === stop.id)}
      aria-pressed={isSelected}
      onClick={() => onSelect(stop.id)}
    >
      {stopNumber != null && <span className="msheet__stopnumber" aria-hidden="true">{stopNumber}</span>}
      <span className="msheet__rowbody">
        <span className="msheet__stophead">
          <span className="msheet__eyebrow">{stop.category}</span>
          {arrivedStopId === stop.id && stop.status === "active" && <span className="sr-only">Arrived</span>}
          {stop.status === "active" && <span className="msheet__peeknow">now</span>}
        </span>
        <span className="msheet__rowname">{stop.name}</span>
        <StopTime stop={stop} timeZone={timeZone} now={now} />
        {minutes !== null && <span className="msheet__duration">{minutes} minutes here</span>}
        <StopFacts stop={stop} />
      </span>
      <Chevron />
    </button>
  );
}
