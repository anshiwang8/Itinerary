"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { StripHome, StripStop } from "./ItineraryStrip";
import { FullRow, HalfPage, PeekLine } from "./MobileSheetContent";
import { buildSheetEntries, pickPeekStop } from "./lib/mobileSheetLayout";
import { backgroundOpacityFor, clampDragHeight, unclampDragHeight, resolveSheetHeights, resolveSnapTarget, sheetTerminalVelocity, SNAP_ORDER, type SheetSnap } from "./lib/bottomSheet";
import { DEFAULT_ZONE } from "./lib/zoneTime";

const MOTION_MS = 280;
const SURFACE_EXTENSION = 80;
const INITIAL_GEOMETRY = { heights: resolveSheetHeights(800, 0, 144), viewportBottom: 800, bottomInset: 0, safeArea: 0 };
type Animation = { from: number; started: number; duration: number; target: SheetSnap };

/** The header owns dragging; reading panes keep native scrolling. One frame
 * loop paints position and reveal together, including interruptions. */
export default function MobileItinerarySheet({ home, stops, selected, onSelect, timeZone = DEFAULT_ZONE, now, arrivedStopId }: {
  home: StripHome | null; stops: StripStop[]; selected: string | null;
  onSelect: (id: string) => void; timeZone?: string; now?: Date; arrivedStopId?: string | null;
}) {
  const panelId = useId();
  const peekId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const peekRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const halfRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLDivElement>(null);
  const opaqueRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef(INITIAL_GEOMETRY);
  const snapRef = useRef<SheetSnap>("peek");
  const touchId = useRef<number | null>(null);
  const startY = useRef(0);
  const startHeight = useRef(INITIAL_GEOMETRY.heights.peek);
  const latestHeight = useRef(INITIAL_GEOMETRY.heights.peek);
  const pendingHeight = useRef(INITIAL_GEOMETRY.heights.peek);
  const lastY = useRef(0);
  const lastMoveAt = useRef(0);
  const velocity = useRef(0);
  const moved = useRef(false);
  const frame = useRef<number | null>(null);
  const animation = useRef<Animation | null>(null);
  const ignoreClickUntil = useRef(0);
  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [settledSnap, setSettledSnap] = useState<SheetSnap>("peek");
  const hasStops = stops.length > 0;

  const cancelFrame = useCallback(() => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const paint = useCallback((height: number) => {
    const { heights, safeArea } = geometryRef.current;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const reveal = Math.min(1, Math.max(0, (height - heights.peek) / Math.min(48, heights.half - heights.peek)));
    const fullReveal = backgroundOpacityFor(height, heights);
    sheet.style.transform = `translate3d(0,${heights.full - height}px,0)`;
    sheet.style.setProperty("--msheet-body-height", `${Math.max(0, height - safeArea - 104) * reveal}px`);
    sheet.style.setProperty("--msheet-reveal", String(reveal));
    sheet.style.setProperty("--msheet-full-reveal", String(fullReveal));
    if (opaqueRef.current) opaqueRef.current.style.opacity = String(fullReveal);
    // Keep panes laid out to retain scroll positions, but exclude invisible
    // controls from focus and hit testing throughout the reveal.
    const expose = (el: HTMLElement | null, visible: boolean, interactive: boolean) => {
      if (!el) return;
      if (!interactive && el.contains(document.activeElement)) handleRef.current?.focus({ preventScroll: true });
      const visibility = visible ? "visible" : "hidden";
      if (el.style.visibility !== visibility) el.style.visibility = visibility;
      if (el.inert === interactive) el.inert = !interactive;
      if (el.getAttribute("aria-hidden") !== String(!interactive)) el.setAttribute("aria-hidden", String(!interactive));
    };
    expose(peekRef.current, reveal < 1, reveal < 0.5);
    expose(headingRef.current, reveal > 0, reveal >= 0.5);
    expose(halfRef.current, reveal > 0 && fullReveal < 1, reveal >= 0.5 && fullReveal < 0.5);
    expose(fullRef.current, fullReveal > 0, fullReveal >= 0.5);
    latestHeight.current = height;
  }, []);

  const finish = useCallback(() => {
    animation.current = null;
    if (sheetRef.current) sheetRef.current.dataset.moving = "false";
    setSettledSnap(snapRef.current);
  }, []);

  const animateTo = useCallback((target: SheetSnap) => {
    cancelFrame();
    touchId.current = null;
    snapRef.current = target;
    setSnap(target);
    const sheet = sheetRef.current;
    sheet?.classList.remove("msheet--dragging");
    if (sheet) { sheet.dataset.dragging = "false"; sheet.dataset.moving = "true"; }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paint(geometryRef.current.heights[target]);
      finish();
      return;
    }
    animation.current = { from: latestHeight.current, started: performance.now(), duration: MOTION_MS, target };
    const step = (at: number) => {
      frame.current = null;
      const motion = animation.current;
      if (!motion) return;
      const progress = Math.min(1, Math.max(0, (at - motion.started) / motion.duration));
      const eased = 1 - (1 - progress) ** 3;
      const destination = geometryRef.current.heights[motion.target];
      paint(motion.from + (destination - motion.from) * eased);
      if (progress === 1) finish();
      else frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [cancelFrame, finish, paint]);

  useEffect(() => {
    const sheet = sheetRef.current;
    const stage = sheet?.closest<HTMLElement>(".stage");
    if (!sheet || !stage) return;
    let measurementFrame: number | null = null;
    const safeAreaProbe = document.createElement("div");
    safeAreaProbe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px)";
    document.body.appendChild(safeAreaProbe);
    const property = (name: string, value: string) => {
      if (stage.style.getPropertyValue(name) !== value) stage.style.setProperty(name, value);
    };
    const measure = () => {
      measurementFrame = null;
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const offset = viewport?.offsetTop ?? 0;
      const viewportBottom = offset + height;
      const bottomInset = window.innerHeight - viewportBottom;
      const safeArea = Number.parseFloat(getComputedStyle(safeAreaProbe).paddingBottom) || 0;
      // Toolbar follows the visible viewport, including accessible page zoom.
      property("--plan-viewport-top", `${offset}px`);
      property("--plan-viewport-left", `${viewport?.offsetLeft ?? 0}px`);
      property("--plan-viewport-width", `${viewport?.width ?? window.innerWidth}px`);
      const bottomOf = (selector: string, floor: number) => Array.from(stage.querySelectorAll<HTMLElement>(selector)).reduce((bottom, el) => {
        const rect = el.getBoundingClientRect();
        return rect.height > 0 ? Math.max(bottom, rect.bottom + 12) : bottom;
      }, floor);
      const chromeBottom = bottomOf(".topbar", offset + 12);
      property("--plan-chrome-bottom", `${chromeBottom}px`);
      const noticeBottom = bottomOf(".banner,.stage__err,.clarify--stage", chromeBottom);
      property("--plan-notice-bottom", `${noticeBottom}px`);
      const obstructionBottom = bottomOf(".mapfallback", noticeBottom);
      property("--plan-obstruction-bottom", `${obstructionBottom}px`);
      const dev = stage.querySelector<HTMLElement>(".dev");
      property("--plan-lower-controls-top", `${dev ? dev.getBoundingClientRect().top : viewportBottom - 22}px`);
      const previous = geometryRef.current;
      const next = { heights: resolveSheetHeights(height, safeArea, obstructionBottom - offset), viewportBottom, bottomInset, safeArea };
      const isMoving = touchId.current != null || animation.current != null;
      // A viewport resize may already have displaced the old bottom-anchored
      // DOM. Preserve the last painted coordinates rather than that new rect.
      const paintedTop = previous.viewportBottom - latestHeight.current;
      geometryRef.current = next;
      sheet.style.height = `${next.heights.full + SURFACE_EXTENSION}px`;
      sheet.style.bottom = `${bottomInset - SURFACE_EXTENSION}px`;
      sheet.style.setProperty("--msheet-half-height", `${Math.max(0, next.heights.half - safeArea - 104)}px`);
      sheet.style.setProperty("--msheet-full-height", `${Math.max(0, next.heights.full - safeArea - 104)}px`);
      if (JSON.stringify(next) !== JSON.stringify(previous) && isMoving) {
        const preservedHeight = viewportBottom - paintedTop;
        if (touchId.current != null) {
          cancelFrame();
          startHeight.current = unclampDragHeight(preservedHeight, next.heights);
          startY.current = lastY.current;
          velocity.current = 0;
          lastMoveAt.current = performance.now();
          pendingHeight.current = preservedHeight;
        }
        if (animation.current) {
          const at = performance.now();
          const remaining = Math.max(1, animation.current.started + animation.current.duration - at);
          animation.current = { ...animation.current, from: preservedHeight, started: at, duration: remaining };
        }
        paint(preservedHeight);
      } else if (!isMoving) paint(next.heights[snapRef.current]);
    };
    const scheduleMeasure = () => {
      if (measurementFrame == null) measurementFrame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(scheduleMeasure);
    const observeChrome = () => {
      resize.disconnect();
      stage.querySelectorAll(".topbar,.banner,.stage__err,.clarify--stage,.mapfallback,.dev").forEach(el => resize.observe(el));
      scheduleMeasure();
    };
    const mutation = new MutationObserver(observeChrome);
    mutation.observe(stage, { childList: true });
    const map = stage.querySelector(".mapwrap");
    if (map) mutation.observe(map, { childList: true });
    measure();
    observeChrome();
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("orientationchange", scheduleMeasure);
    window.visualViewport?.addEventListener("resize", scheduleMeasure);
    window.visualViewport?.addEventListener("scroll", scheduleMeasure);
    return () => {
      if (measurementFrame != null) cancelAnimationFrame(measurementFrame);
      resize.disconnect(); mutation.disconnect(); safeAreaProbe.remove();
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("orientationchange", scheduleMeasure);
      window.visualViewport?.removeEventListener("resize", scheduleMeasure);
      window.visualViewport?.removeEventListener("scroll", scheduleMeasure);
    };
  }, [cancelFrame, paint, stops.length]);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const draggedHeight = (y: number) => Math.min(geometryRef.current.heights.full + SURFACE_EXTENSION,
      clampDragHeight(startHeight.current + startY.current - y, geometryRef.current.heights));
    const onStart = (event: TouchEvent) => {
      if (touchId.current != null) return;
      const button = (event.target as Element).closest("button");
      if (button && button !== handleRef.current && button !== peekRef.current) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      cancelFrame(); animation.current = null;
      touchId.current = touch.identifier;
      startY.current = lastY.current = touch.clientY;
      startHeight.current = unclampDragHeight(latestHeight.current, geometryRef.current.heights);
      pendingHeight.current = latestHeight.current;
      lastMoveAt.current = performance.now(); velocity.current = 0; moved.current = false;
      sheetRef.current?.classList.add("msheet--dragging");
      if (sheetRef.current) { sheetRef.current.dataset.dragging = "true"; sheetRef.current.dataset.moving = "true"; }
      event.stopPropagation();
    };
    const onMove = (event: TouchEvent) => {
      const touch = Array.from(event.changedTouches).find(item => item.identifier === touchId.current);
      if (!touch) return;
      const at = performance.now();
      const elapsed = at - lastMoveAt.current;
      if (elapsed > 0) velocity.current = (lastY.current - touch.clientY) / elapsed;
      if (Math.abs(startY.current - touch.clientY) > 6) moved.current = true;
      lastY.current = touch.clientY; lastMoveAt.current = at;
      pendingHeight.current = draggedHeight(touch.clientY);
      if (frame.current == null) frame.current = requestAnimationFrame(() => { frame.current = null; paint(pendingHeight.current); });
      event.preventDefault(); event.stopPropagation();
    };
    const onEnd = (event: TouchEvent) => {
      const touch = Array.from(event.changedTouches).find(item => item.identifier === touchId.current);
      if (!touch) return;
      const releasedAt = performance.now();
      if (!moved.current && Math.abs(startY.current - touch.clientY) <= 6) {
        // A tap keeps the displayed destination intact. The button's native
        // click owns its action; a tap on blank header simply resumes motion.
        ignoreClickUntil.current = 0;
        animateTo(snapRef.current);
        event.stopPropagation();
        return;
      }
      ignoreClickUntil.current = releasedAt + 400;
      const speed = sheetTerminalVelocity({ velocity: velocity.current, lastY: lastY.current, lastMoveAt: lastMoveAt.current, releaseY: touch.clientY, releasedAt });
      cancelFrame();
      const releasedHeight = draggedHeight(touch.clientY);
      paint(releasedHeight);
      animateTo(resolveSnapTarget(releasedHeight, speed, geometryRef.current.heights));
      event.stopPropagation();
    };
    const onCancel = (event: TouchEvent) => {
      if (!Array.from(event.changedTouches).some(item => item.identifier === touchId.current)) return;
      ignoreClickUntil.current = performance.now() + 400;
      animateTo(resolveSnapTarget(latestHeight.current, 0, geometryRef.current.heights));
      event.stopPropagation();
    };
    header.addEventListener("touchstart", onStart, { passive: true });
    header.addEventListener("touchmove", onMove, { passive: false });
    header.addEventListener("touchend", onEnd, { passive: true });
    header.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      header.removeEventListener("touchstart", onStart); header.removeEventListener("touchmove", onMove);
      header.removeEventListener("touchend", onEnd); header.removeEventListener("touchcancel", onCancel);
      cancelFrame(); animation.current = null; touchId.current = null;
    };
  }, [animateTo, cancelFrame, hasStops, paint]);

  const entries = useMemo(() => buildSheetEntries(home, stops), [home, stops]);
  const peekStop = pickPeekStop(stops);
  const stopNumbers = useMemo(() => new Map(stops.map((stop, index) => [stop.id, index + 1])), [stops]);
  const showDetails = (entryIndex: number) => {
    const list = fullRef.current;
    // Both panes render this same entry list, with one full row per entry.
    // Scroll only the list; scrollIntoView could pan the surrounding viewport.
    const row = list?.children.item(entryIndex);
    if (list && row) list.scrollTo({ top: list.scrollTop + row.getBoundingClientRect().top - list.getBoundingClientRect().top, behavior: "instant" });
    animateTo("full");
  };
  if (!stops.length) return null;
  return (
    <div ref={sheetRef} className={`msheet msheet--${snap}`} data-state={settledSnap} role="region" aria-label="Your itinerary, stop by stop">
      <div className="msheet__bg msheet__bg--frost" aria-hidden="true" />
      <div ref={opaqueRef} className="msheet__bg msheet__bg--opaque" aria-hidden="true" />
      <div ref={headerRef} className="msheet__header">
        <button ref={handleRef} type="button" className="msheet__draghandle" aria-controls={panelId} aria-expanded={snap !== "peek"} aria-label={snap === "full" ? "Collapse itinerary" : "Expand itinerary"}
          onClick={() => { if (performance.now() >= ignoreClickUntil.current) animateTo(snapRef.current === "peek" ? "half" : snapRef.current === "half" ? "full" : "half"); }}
          onKeyDown={event => {
            let target: SheetSnap | undefined;
            const index = SNAP_ORDER.indexOf(snapRef.current);
            if (event.key === "ArrowUp") target = SNAP_ORDER[Math.min(2, index + 1)];
            if (event.key === "ArrowDown") target = SNAP_ORDER[Math.max(0, index - 1)];
            if (event.key === "Home" || event.key === "Escape") target = "peek";
            if (event.key === "End") target = "full";
            if (target) { event.preventDefault(); event.stopPropagation(); animateTo(target); }
          }}><span className="msheet__grip" aria-hidden="true" /></button>
        <div className="msheet__headercontent">
          <button ref={peekRef} type="button" className="msheet__peekline" aria-label="Show itinerary cards" aria-describedby={peekId} onClick={() => { if (performance.now() >= ignoreClickUntil.current) animateTo("half"); }}>
            <span id={peekId}>{peekStop && <PeekLine stop={peekStop} timeZone={timeZone} now={now} />}</span>
          </button>
          <div ref={headingRef} className="msheet__heading" inert aria-hidden="true">
            <div><h2>Your itinerary</h2><p className="msheet__meta">{stops.length} {stops.length === 1 ? "stop" : "stops"}</p></div>
            <button type="button" className="msheet__view" aria-label={snap === "full" ? "Show itinerary cards" : "Show full itinerary"} onClick={() => animateTo(snapRef.current === "full" ? "half" : "full")}>
              <span aria-hidden="true">{snap === "full" ? "⌄" : "☰"}</span>
            </button>
          </div>
        </div>
      </div>
      <div id={panelId} className="msheet__body">
        <div ref={halfRef} className="msheet__half" inert aria-hidden="true">
          <div className="msheet__track">{entries.map((entry, index) => <HalfPage key={entry.kind === "home" ? "home" : entry.kind === "leg" ? entry.id : entry.stop.id} entry={entry} selected={selected} onSelect={onSelect} onShowDetails={() => showDetails(index)} timeZone={timeZone} now={now} arrivedStopId={arrivedStopId} stopNumber={entry.kind === "stop" ? stopNumbers.get(entry.stop.id) : undefined} stopCount={stops.length} />)}</div>
        </div>
        <div ref={fullRef} className="msheet__full" inert aria-hidden="true">
          {entries.map(entry => <FullRow key={entry.kind === "home" ? "home" : entry.kind === "leg" ? entry.id : entry.stop.id} entry={entry} selected={selected} onSelect={onSelect} timeZone={timeZone} now={now} arrivedStopId={arrivedStopId} stopNumber={entry.kind === "stop" ? stopNumbers.get(entry.stop.id) : undefined} stopCount={stops.length} />)}
        </div>
      </div>
    </div>
  );
}
