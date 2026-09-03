"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatStopRange, formatStopTime } from "./lib/timeLabels";
import { TransitIcon, type StripHome, type StripLeg, type StripStop } from "./ItineraryStrip";
import { buildSheetEntries, pickPeekStop, type SheetEntry } from "./lib/mobileSheetLayout";
import {
  backgroundOpacityFor,
  clampDragHeight,
  contentStateFor,
  resolveSheetHeights,
  resolveSnapTarget,
  sheetHeightFor,
  type SheetHeights,
  type SheetSnap,
} from "./lib/bottomSheet";

// The mobile-only replacement for the top ItineraryStrip (desktop keeps that
// component completely unchanged — see globals.css's `.msheet`/`.lstrip`
// rules under the max-width: 768px breakpoint, which is the ONLY thing that
// decides which one is visible). This component receives the exact same
// home/stops/selected/now/arrivedStopId values page.tsx already computes for
// ItineraryStrip — no new data plumbing, no re-fetching.
//
// Scope note: unlike the desktop strip, this component does not render the
// swap/remove inline forms or the expandable transit board/alight timeline —
// neither was in the task's reuse list (selected stop, active/live status,
// the "now" indicator, transit segment data), and the transit-leg spec here
// asks for "compact strips", not the desktop's full timeline disclosure.
// Editing a stop from the sheet is a deliberate follow-up, not a gap.

const FALLBACK_VIEWPORT_HEIGHT_PX = 800;

const PRICE_LABEL: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

/** Reads the device's actual safe-area-inset-bottom in px. A common, minimal
 *  DOM-probe technique: `env()` only resolves inside real CSS, so a
 *  throwaway element applies it and getComputedStyle reads the resolved
 *  pixel value back. 0 on every non-notched device and in any environment
 *  without `viewport-fit=cover` (see app/layout.tsx's `viewport` export). */
function readSafeAreaBottomPx(): number {
  if (typeof document === "undefined") return 0;
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.paddingBottom = "env(safe-area-inset-bottom, 0px)";
  document.body.appendChild(probe);
  const value = Number.parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  document.body.removeChild(probe);
  return value;
}

/** The live/dynamic viewport height — visualViewport tracks Mobile Safari's
 *  address-bar-aware height (the JS analogue of CSS's `dvh`); innerHeight is
 *  the fallback for browsers without it. */
function readViewportHeightPx(): number {
  if (typeof window === "undefined") return FALLBACK_VIEWPORT_HEIGHT_PX;
  return window.visualViewport?.height ?? window.innerHeight;
}

function legSummaryText(leg: StripLeg): string {
  if (leg.mode === "walk") return "Walk";
  if (leg.mode === "driving") return "Drive";
  if (leg.mode === "unknown") return "Travel time unavailable";
  return leg.lineName ?? "Transit";
}

function StopFacts({ stop }: { stop: StripStop }) {
  const price = stop.price ? PRICE_LABEL[stop.price] ?? null : null;
  if (stop.rating == null && !price) return null;
  return (
    <span className="msheet__facts">
      {stop.rating != null && <span>★ {stop.rating.toFixed(1)}</span>}
      {price && <span>{price}</span>}
    </span>
  );
}

function LegSummary({ leg, timeZone }: { leg: StripLeg; timeZone: string }) {
  return (
    <>
      <TransitIcon mode={leg.mode} />
      <span>{legSummaryText(leg)}</span>
      <span>· {leg.totalMinutes} min</span>
      {leg.leaveISO && (
        <span>· leave {formatStopTime(leg.leaveISO, new Date(), timeZone)}</span>
      )}
    </>
  );
}

function PeekLine({
  stop,
  timeZone,
}: {
  stop: StripStop;
  timeZone: string;
}) {
  return (
    <div className="msheet__peek">
      <svg className="msheet__peekicon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 21s-7-6.2-7-11.6A7 7 0 0 1 19 9.4C19 14.8 12 21 12 21zm0-9.4a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z" />
      </svg>
      <span className="msheet__peekbody">
        <span className="msheet__peekname">{stop.name}</span>
        {stop.start && stop.end && (
          <span className="msheet__peekwhen">
            {formatStopRange(stop.start, stop.end, new Date(), timeZone)}
          </span>
        )}
      </span>
      {stop.status === "active" && <span className="msheet__peeknow">now</span>}
    </div>
  );
}

function HalfPage({
  entry,
  selected,
  onSelect,
  timeZone,
}: {
  entry: SheetEntry;
  selected: string | null;
  onSelect: (stopId: string) => void;
  timeZone: string;
}) {
  if (entry.kind === "home") {
    return (
      <div className="msheet__page msheet__page--leg">
        <div className="eyebrow">home</div>
        <div className="msheet__rowname">{entry.home.label}</div>
        {entry.home.leaveBy && (
          <span className="msheet__peekwhen">leave by {entry.home.leaveBy}</span>
        )}
      </div>
    );
  }
  if (entry.kind === "leg") {
    return (
      <div className="msheet__page msheet__page--leg">
        <LegSummary leg={entry.leg} timeZone={timeZone} />
      </div>
    );
  }
  const stop = entry.stop;
  return (
    <div className="msheet__page">
      <button
        type="button"
        className="msheet__pageselect"
        aria-pressed={selected === stop.id}
        onClick={() => onSelect(stop.id)}
      >
        <span className="msheet__stophead">
          <span className="eyebrow">{stop.category}</span>
          {stop.status === "active" && <span className="msheet__peeknow">now</span>}
        </span>
        <span className="msheet__pagename">{stop.name}</span>
        {stop.start && stop.end && (
          <span className="msheet__peekwhen">
            be here {formatStopRange(stop.start, stop.end, new Date(), timeZone)}
          </span>
        )}
        <StopFacts stop={stop} />
      </button>
    </div>
  );
}

function FullRow({
  entry,
  selected,
  onSelect,
  timeZone,
}: {
  entry: SheetEntry;
  selected: string | null;
  onSelect: (stopId: string) => void;
  timeZone: string;
}) {
  if (entry.kind === "home") {
    return (
      <div className="msheet__row">
        <span className="msheet__rowbody">
          <span className="eyebrow">home</span>
          <span className="msheet__rowname">{entry.home.label}</span>
        </span>
      </div>
    );
  }
  if (entry.kind === "leg") {
    return (
      <div className="msheet__legrow">
        <LegSummary leg={entry.leg} timeZone={timeZone} />
      </div>
    );
  }
  const stop = entry.stop;
  const isSel = selected === stop.id;
  return (
    <button
      type="button"
      className={"msheet__row" + (isSel ? " msheet__row--sel" : "")}
      aria-pressed={isSel}
      onClick={() => onSelect(stop.id)}
    >
      <span className="msheet__rowbody">
        <span className="eyebrow">
          {stop.category}
          {stop.status === "active" ? " · now" : ""}
        </span>
        <span className="msheet__rowname">{stop.name}</span>
        {stop.start && stop.end && (
          <span className="msheet__rowwhen">
            {formatStopRange(stop.start, stop.end, new Date(), timeZone)}
          </span>
        )}
      </span>
    </button>
  );
}

export interface MobileItinerarySheetProps {
  home?: StripHome | null;
  stops: StripStop[];
  selected: string | null;
  /** selects by VENUE ID — same contract as ItineraryStrip's onSelect */
  onSelect: (stopId: string) => void;
  timeZone?: string;
}

export default function MobileItinerarySheet({
  home,
  stops,
  selected,
  onSelect,
  timeZone = "America/Toronto",
}: MobileItinerarySheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);

  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [dragging, setDragging] = useState(false);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [heights, setHeights] = useState<SheetHeights>(() =>
    resolveSheetHeights(FALLBACK_VIEWPORT_HEIGHT_PX, 0)
  );

  // Real viewport height and safe-area inset are browser-only facts — measured
  // after mount (never during the server render, which has neither) and
  // re-measured on resize/orientation change. Same "degrade safely on the
  // server, correct after mount" shape as this app's other browser-only reads
  // (see e.g. app/lib/firebase.ts's SSR bail-out).
  useEffect(() => {
    const measure = () => {
      setHeights(resolveSheetHeights(readViewportHeightPx(), readSafeAreaBottomPx()));
    };
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  // Refs mirroring the live state so the native (non-React) touch listeners,
  // attached once, always read the current values without a stale closure.
  // Synced in an effect (never written during render) so each commit's
  // values are current by the time any later event fires.
  const heightsRef = useRef(heights);
  const snapRef = useRef(snap);
  useEffect(() => {
    heightsRef.current = heights;
    snapRef.current = snap;
  }, [heights, snap]);

  const dragTouchId = useRef<number | null>(null);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const lastY = useRef(0);
  const lastT = useRef(0);
  const velocity = useRef(0);

  const endDrag = useCallback((finalHeight: number) => {
    const target = resolveSnapTarget(finalHeight, velocity.current, heightsRef.current);
    setSnap(target);
    setDragging(false);
    setDragHeight(null);
    dragTouchId.current = null;
  }, []);

  // The touch handlers are native (not React's synthetic onTouch* props) for
  // one reason: touchmove needs `{ passive: false }` to reliably call
  // preventDefault and stop the page from doing anything else with the
  // gesture, which React's synthetic touch handling does not guarantee. Same
  // "native browser API behind a thin binding" shape as createLiveTracker /
  // cameraTween elsewhere in this app.
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    const onTouchStart = (e: TouchEvent) => {
      if (dragTouchId.current != null) return; // already tracking a touch
      const touch = e.touches[0];
      if (!touch) return;
      dragTouchId.current = touch.identifier;
      dragStartY.current = touch.clientY;
      // The TRUE current rendered height, not the nominal snap height — a
      // new drag can start mid-transition (a quick re-grab), and starting
      // from the actual painted position avoids a visible jump.
      dragStartHeight.current =
        sheetRef.current?.getBoundingClientRect().height ?? heightsRef.current[snapRef.current];
      lastY.current = touch.clientY;
      lastT.current = performance.now();
      velocity.current = 0;
      setDragging(true);
      setDragHeight(dragStartHeight.current);
      // Belt-and-suspenders: touch-priority is spatial by DOM hit-testing
      // already (the map is a separate subtree beneath this overlay), but a
      // sheet-internal drag must also never bubble into any document-level
      // listener (e.g. an armed remove control's outside-press disarm).
      e.stopPropagation();
    };

    const onTouchMove = (e: TouchEvent) => {
      if (dragTouchId.current == null) return;
      const touch = Array.from(e.touches).find((t) => t.identifier === dragTouchId.current);
      if (!touch) return;
      const deltaY = dragStartY.current - touch.clientY; // up = positive = expanding
      const raw = dragStartHeight.current + deltaY;
      const clamped = clampDragHeight(raw, heightsRef.current);
      setDragHeight(clamped);

      const now = performance.now();
      const dt = now - lastT.current;
      if (dt > 0) velocity.current = (lastY.current - touch.clientY) / dt;
      lastY.current = touch.clientY;
      lastT.current = now;

      e.preventDefault();
      e.stopPropagation();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (dragTouchId.current == null) return;
      const touch = Array.from(e.changedTouches).find(
        (t) => t.identifier === dragTouchId.current
      );
      e.stopPropagation();
      if (!touch) {
        endDrag(dragStartHeight.current);
        return;
      }
      const deltaY = dragStartY.current - touch.clientY;
      const raw = dragStartHeight.current + deltaY;
      endDrag(clampDragHeight(raw, heightsRef.current));
    };

    handle.addEventListener("touchstart", onTouchStart, { passive: true });
    handle.addEventListener("touchmove", onTouchMove, { passive: false });
    handle.addEventListener("touchend", onTouchEnd, { passive: true });
    handle.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      handle.removeEventListener("touchstart", onTouchStart);
      handle.removeEventListener("touchmove", onTouchMove);
      handle.removeEventListener("touchend", onTouchEnd);
      handle.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [endDrag]);

  const entries = useMemo(() => buildSheetEntries(home, stops), [home, stops]);
  const peekStop = useMemo(() => pickPeekStop(stops), [stops]);

  if (stops.length === 0) return null;

  const liveHeight = dragging && dragHeight != null ? dragHeight : sheetHeightFor(snap, heights);
  const activeContent = contentStateFor(liveHeight, heights);
  const bgOpacity = backgroundOpacityFor(liveHeight, heights);

  return (
    <div
      ref={sheetRef}
      className={"msheet msheet--" + snap + (dragging ? " msheet--dragging" : "")}
      data-state={activeContent}
      style={{ height: `${liveHeight}px` }}
      role="region"
      aria-label="Your evening, stop by stop"
    >
      <div className="msheet__bg msheet__bg--frost" />
      <div className="msheet__bg msheet__bg--opaque" style={{ opacity: bgOpacity }} />
      <div className="msheet__draghandle" ref={handleRef}>
        <span className="msheet__grip" aria-hidden="true" />
        {/* The peek line has no internal state worth preserving (unlike the
            carousel/list below), so it mounts/unmounts freely with the
            content switch — a direct flex child of the handle, so its own
            flex:1 1 auto still fills the remaining peek-state height. */}
        {activeContent === "peek" && peekStop && (
          <PeekLine stop={peekStop} timeZone={timeZone} />
        )}
      </div>
      {/* The carousel and list DO carry scroll position worth preserving, so
          both stay mounted always and are hidden by style rather than
          conditionally unmounted — unmounting/remounting on every threshold
          crossing mid-drag would reset scroll position and thrash the DOM,
          the opposite of "fluid". */}
      <div
        className="msheet__half"
        style={{ display: activeContent === "half" ? undefined : "none" }}
      >
        <div className="msheet__track">
          {entries.map((entry) => (
            <HalfPage
              key={entry.kind === "leg" ? entry.id : entry.kind === "home" ? "home" : entry.stop.id}
              entry={entry}
              selected={selected}
              onSelect={onSelect}
              timeZone={timeZone}
            />
          ))}
        </div>
      </div>
      <div
        className="msheet__full"
        style={{ display: activeContent === "full" ? undefined : "none" }}
      >
        {entries.map((entry) => (
          <FullRow
            key={entry.kind === "leg" ? entry.id : entry.kind === "home" ? "home" : entry.stop.id}
            entry={entry}
            selected={selected}
            onSelect={onSelect}
            timeZone={timeZone}
          />
        ))}
      </div>
    </div>
  );
}
