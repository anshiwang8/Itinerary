"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { StripHome, StripStop } from "./ItineraryStrip";
import { FullRow, HalfPage, PeekLine } from "./MobileSheetContent";
import { buildSheetEntries, pickPeekStop } from "./lib/mobileSheetLayout";
import { backgroundOpacityFor, clampDragHeight, resolveSheetHeights, resolveSnapTarget, sheetReleaseVelocity, SNAP_ORDER, type SheetSnap } from "./lib/bottomSheet";
import { DEFAULT_ZONE } from "./lib/zoneTime";

const MOTION_MS = 280;
const SURFACE_EXTENSION = 80;
const INITIAL_GEOMETRY = { heights: resolveSheetHeights(800, 0, 144), viewportBottom: 800, bottomInset: 0, safeArea: 0 };

function readSafeAreaBottom(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)";
  document.body.appendChild(probe);
  const value = Number.parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
  return value;
}

/** Only the grip owns sheet dragging. Content keeps native scrolling; the map
 *  keeps its own gestures. Both layouts stay mounted so their scroll survives. */
export default function MobileItinerarySheet({ home, stops, selected, onSelect, timeZone = DEFAULT_ZONE, now, arrivedStopId }: {
  home: StripHome | null;
  stops: StripStop[];
  selected: string | null;
  onSelect: (id: string) => void;
  timeZone?: string;
  now?: Date;
  arrivedStopId?: string | null;
}) {
  const panelId = useId();
  const peekId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const opaqueRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef(INITIAL_GEOMETRY);
  const snapRef = useRef<SheetSnap>("peek");
  const touchId = useRef<number | null>(null);
  const startY = useRef(0);
  const startHeight = useRef(INITIAL_GEOMETRY.heights.peek);
  const latestHeight = useRef(INITIAL_GEOMETRY.heights.peek);
  const lastY = useRef(0);
  const lastMoveAt = useRef(0);
  const velocity = useRef(0);
  const paintFrame = useRef<number | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ignoreClickUntil = useRef(0);
  const [geometry, setGeometry] = useState(INITIAL_GEOMETRY);
  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [contentSnap, setContentSnap] = useState<SheetSnap>("peek");

  const cancelPending = useCallback(() => {
    if (paintFrame.current != null) cancelAnimationFrame(paintFrame.current);
    if (settleTimer.current != null) clearTimeout(settleTimer.current);
    paintFrame.current = null;
    settleTimer.current = null;
  }, []);

  const paint = useCallback((height: number) => {
    const { heights } = geometryRef.current;
    if (sheetRef.current) sheetRef.current.style.transform = `translate3d(0,${heights.full - height}px,0)`;
    if (opaqueRef.current) opaqueRef.current.style.opacity = String(backgroundOpacityFor(height, heights));
    latestHeight.current = height;
  }, []);

  const finish = useCallback(() => {
    if (touchId.current != null) return;
    if (settleTimer.current != null) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    if (snapRef.current !== "peek" && sheetRef.current?.querySelector(".msheet__peekline")?.contains(document.activeElement)) {
      handleRef.current?.focus({ preventScroll: true });
    }
    setContentSnap(snapRef.current);
  }, []);

  const animateTo = useCallback((target: SheetSnap) => {
    cancelPending();
    const sheet = sheetRef.current;
    // Sample the painted position, including an interrupted CSS transition.
    const current = sheet ? geometryRef.current.viewportBottom - sheet.getBoundingClientRect().top : latestHeight.current;
    sheet?.classList.add("msheet--dragging");
    paint(current);
    sheet?.getBoundingClientRect();
    touchId.current = null;
    snapRef.current = target;
    sheet?.classList.remove("msheet--dragging");
    if (sheet) sheet.dataset.dragging = "false";
    setSnap(target);
    paint(geometryRef.current.heights[target]);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else settleTimer.current = setTimeout(finish, MOTION_MS + 40);
  }, [cancelPending, finish, paint]);

  useEffect(() => {
    const sheet = sheetRef.current;
    const stage = sheet?.closest<HTMLElement>(".stage");
    if (!sheet || !stage) return;
    const measure = () => {
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const offset = viewport?.offsetTop ?? 0;
      const viewportBottom = offset + height;
      const bottomInset = Math.max(0, window.innerHeight - viewportBottom);
      const safeArea = readSafeAreaBottom();
      const bottomOf = (selector: string, floor: number) => Array.from(stage.querySelectorAll<HTMLElement>(selector)).reduce((bottom, el) => {
        const rect = el.getBoundingClientRect();
        return rect.height > 0 ? Math.max(bottom, rect.bottom + 12) : bottom;
      }, floor);
      const chromeBottom = bottomOf(".topbar", offset + 12);
      stage.style.setProperty("--plan-chrome-bottom", `${chromeBottom}px`);
      const noticeBottom = bottomOf(".banner,.stage__err,.clarify--stage", chromeBottom);
      stage.style.setProperty("--plan-notice-bottom", `${noticeBottom}px`);
      const obstructionBottom = bottomOf(".mapfallback", noticeBottom);
      stage.style.setProperty("--plan-obstruction-bottom", `${obstructionBottom}px`);
      const dev = stage.querySelector<HTMLElement>(".dev");
      stage.style.setProperty("--plan-lower-controls-top", `${dev ? dev.getBoundingClientRect().top : viewportBottom - 22}px`);
      const next = { heights: resolveSheetHeights(height, safeArea, obstructionBottom - offset), viewportBottom, bottomInset, safeArea };
      if (JSON.stringify(next) === JSON.stringify(geometryRef.current)) return;
      cancelPending();
      touchId.current = null;
      geometryRef.current = next;
      sheet.classList.remove("msheet--dragging");
      sheet.dataset.dragging = "false";
      setGeometry(next);
      setContentSnap(snapRef.current);
    };
    const resize = new ResizeObserver(measure);
    const observeChrome = () => {
      resize.disconnect();
      stage.querySelectorAll(".topbar,.banner,.stage__err,.clarify--stage,.mapfallback,.dev").forEach(el => resize.observe(el));
      measure();
    };
    const mutation = new MutationObserver(observeChrome);
    mutation.observe(stage, { childList: true });
    const map = stage.querySelector(".mapwrap");
    if (map) mutation.observe(map, { childList: true });
    observeChrome();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
      cancelPending();
    };
  }, [cancelPending, stops.length]);

  useLayoutEffect(() => { paint(geometry.heights[snapRef.current]); }, [geometry, paint]);

  useEffect(() => {
    const grip = handleRef.current;
    if (!grip) return;
    const draggedHeight = (y: number) => Math.min(
      geometryRef.current.heights.full + SURFACE_EXTENSION,
      clampDragHeight(startHeight.current + startY.current - y, geometryRef.current.heights)
    );
    const onStart = (event: TouchEvent) => {
      if (touchId.current != null) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      cancelPending();
      touchId.current = touch.identifier;
      startY.current = lastY.current = touch.clientY;
      startHeight.current = geometryRef.current.viewportBottom - sheetRef.current!.getBoundingClientRect().top;
      lastMoveAt.current = performance.now();
      velocity.current = 0;
      sheetRef.current?.classList.add("msheet--dragging");
      if (sheetRef.current) sheetRef.current.dataset.dragging = "true";
      paint(startHeight.current);
      event.stopPropagation();
    };
    const onMove = (event: TouchEvent) => {
      const touch = Array.from(event.touches).find(item => item.identifier === touchId.current);
      if (!touch) return;
      const at = performance.now();
      const elapsed = at - lastMoveAt.current;
      if (elapsed > 0) velocity.current = (lastY.current - touch.clientY) / elapsed;
      lastY.current = touch.clientY;
      lastMoveAt.current = at;
      latestHeight.current = draggedHeight(touch.clientY);
      if (paintFrame.current == null) paintFrame.current = requestAnimationFrame(() => {
        paintFrame.current = null;
        paint(latestHeight.current);
      });
      event.preventDefault();
      event.stopPropagation();
    };
    const onEnd = (event: TouchEvent) => {
      const touch = Array.from(event.changedTouches).find(item => item.identifier === touchId.current);
      if (!touch) return;
      const releasedAt = performance.now();
      if (Math.abs(startY.current - touch.clientY) > 6) ignoreClickUntil.current = releasedAt + 400;
      const speed = sheetReleaseVelocity(velocity.current, lastMoveAt.current, releasedAt);
      animateTo(resolveSnapTarget(draggedHeight(touch.clientY), speed, geometryRef.current.heights));
      event.stopPropagation();
    };
    const onCancel = (event: TouchEvent) => {
      if (!Array.from(event.changedTouches).some(item => item.identifier === touchId.current)) return;
      ignoreClickUntil.current = performance.now() + 400;
      animateTo(resolveSnapTarget(latestHeight.current, 0, geometryRef.current.heights));
      event.stopPropagation();
    };
    grip.addEventListener("touchstart", onStart, { passive: true });
    grip.addEventListener("touchmove", onMove, { passive: false });
    grip.addEventListener("touchend", onEnd, { passive: true });
    grip.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      grip.removeEventListener("touchstart", onStart);
      grip.removeEventListener("touchmove", onMove);
      grip.removeEventListener("touchend", onEnd);
      grip.removeEventListener("touchcancel", onCancel);
      cancelPending();
    };
  }, [animateTo, cancelPending, paint, stops.length]);

  const entries = useMemo(() => buildSheetEntries(home, stops), [home, stops]);
  const peekStop = pickPeekStop(stops);
  const stopNumbers = useMemo(() => new Map(stops.map((stop, index) => [stop.id, index + 1])), [stops]);
  if (!stops.length) return null;
  const style = {
    height: geometry.heights.full + SURFACE_EXTENSION,
    bottom: geometry.bottomInset - SURFACE_EXTENSION,
    transform: `translate3d(0,${geometry.heights.full - geometry.heights[snap]}px,0)`,
    "--msheet-content-height": `${geometry.heights[contentSnap] - geometry.safeArea}px`,
    "--msheet-body-height": `${Math.max(0, geometry.heights[contentSnap] - geometry.safeArea - 104)}px`,
  } as CSSProperties;

  return (
    <div ref={sheetRef} className={`msheet msheet--${snap}`} style={style} data-state={contentSnap} data-dragging="false" role="region" aria-label="Your itinerary, stop by stop"
      onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === "transform") finish(); }}>
      <div className="msheet__bg msheet__bg--frost" aria-hidden="true" />
      <div ref={opaqueRef} className="msheet__bg msheet__bg--opaque" style={{ opacity: backgroundOpacityFor(geometry.heights[snap], geometry.heights) }} aria-hidden="true" />
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
      <button type="button" className="msheet__peekline" hidden={contentSnap !== "peek"} inert={contentSnap !== "peek"} aria-label="Show itinerary cards" aria-describedby={peekId} onClick={() => animateTo("half")}>
        <span id={peekId}>{peekStop && <PeekLine stop={peekStop} timeZone={timeZone} now={now} />}</span>
      </button>
      <div className="msheet__heading" hidden={contentSnap === "peek"}>
        <div><h2>Your itinerary</h2><p className="msheet__meta">{stops.length} {stops.length === 1 ? "stop" : "stops"}</p></div>
        <button type="button" className="msheet__view" aria-label={contentSnap === "half" ? "Show full itinerary" : "Show itinerary cards"} onClick={() => animateTo(contentSnap === "half" ? "full" : "half")}>
          <span aria-hidden="true">{contentSnap === "half" ? "☰" : "⌄"}</span>
        </button>
      </div>
      <div id={panelId} className="msheet__body" hidden={contentSnap === "peek"}>
        <div className="msheet__half" hidden={contentSnap !== "half"} inert={contentSnap !== "half"}>
          <div className="msheet__track">{entries.map(entry => <HalfPage key={entry.kind === "home" ? "home" : entry.kind === "leg" ? entry.id : entry.stop.id} entry={entry} selected={selected} onSelect={onSelect} timeZone={timeZone} now={now} arrivedStopId={arrivedStopId} stopNumber={entry.kind === "stop" ? stopNumbers.get(entry.stop.id) : undefined} stopCount={stops.length} />)}</div>
        </div>
        <div className="msheet__full" hidden={contentSnap !== "full"} inert={contentSnap !== "full"}>
          {entries.map(entry => <FullRow key={entry.kind === "home" ? "home" : entry.kind === "leg" ? entry.id : entry.stop.id} entry={entry} selected={selected} onSelect={onSelect} timeZone={timeZone} now={now} arrivedStopId={arrivedStopId} stopNumber={entry.kind === "stop" ? stopNumbers.get(entry.stop.id) : undefined} stopCount={stops.length} />)}
        </div>
      </div>
    </div>
  );
}
