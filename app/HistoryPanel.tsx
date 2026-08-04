"use client";

// History — a read-only look back at plans that have concluded.
//
// VIEW ONLY, and the emptiness of this component's action list is the point:
// there is no delete, no edit, no replay, no "start this again". Stage 1B
// began writing an archive; this stage does nothing but show it.
//
// WHAT IT CAN SHOW is fixed by what was archived — an id, timestamps, a zone,
// and stops with names, categories, times and statuses. No map, no title, no
// prompt, no city: those were never written, and a heading invented from a
// category would be a guess presented as a record. Every label on screen comes
// from `historyView`, which is where that discipline is enforced and tested.
//
// Structure mirrors LoginScreen and StopItineraryDialog — a centred card over
// a dimmed stage, escape to leave, focus moved inside on open. Palette is the
// app's own: white card, ink-navy type, mid-teal accent. Acid green is
// RESERVED for "happening now / just changed" and appears nowhere here; a
// finished outing is the opposite of live.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistoryEntryView, HistoryResponseView } from "./lib/historyView";

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; entries: HistoryEntryView[]; readFailed: boolean }
  | { phase: "error" };

export default function HistoryPanel({
  isGuest,
  canSignIn,
  onSignIn,
  onDismiss,
  load,
}: {
  /** No REAL account — an anonymous guest, or a session that never resolved.
   *  Guests have no history because none was ever written for them, so they
   *  get the sign-in nudge instead of a list and no request is made at all. */
  isGuest: boolean;
  /** Whether sign-in can be offered (false when Firebase is unconfigured). */
  canSignIn: boolean;
  onSignIn: () => void;
  onDismiss: () => void;
  /** Injected so this component knows nothing about tokens or fetch: page.tsx
   *  owns the session, exactly as it does for every other authed call. */
  load: () => Promise<HistoryResponseView>;
}) {
  // Seeded rather than set from inside the effect: the panel mounts fresh on
  // every open, so "we are about to ask" is the honest initial state for
  // anyone who will be asked about, and a guest is never asked about at all.
  const [state, setState] = useState<LoadState>(() =>
    isGuest ? { phase: "idle" } : { phase: "loading" }
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingId = "hist-title";

  // One fetch per open, and never for a guest — asking Firestore about a uid
  // the archive gate guarantees is empty is a round trip with a known answer.
  useEffect(() => {
    if (isGuest) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await load();
        if (!cancelled) {
          setState({
            phase: "ready",
            entries: result.entries,
            readFailed: result.readFailed,
          });
        }
      } catch {
        // The route answers 200 even with nothing to say, so reaching here
        // means the request never landed. That is a failure to LOAD, which
        // must not be dressed up as "you have no saved plans".
        if (!cancelled) setState({ phase: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isGuest, load]);

  // The opened plan is looked up by id rather than held as its own state, so
  // a reload cannot leave the detail view showing a record the list no longer
  // has. Nothing is open until there is a loaded list to open it from.
  const open = useMemo(() => {
    if (state.phase !== "ready" || openId === null) return null;
    return state.entries.find((entry) => entry.id === openId) ?? null;
  }, [state, openId]);

  const back = useCallback(() => setOpenId(null), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape steps back one level rather than throwing the whole screen
      // away: someone reading a plan meant to leave the plan, not the list.
      if (openId !== null) back();
      else onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss, openId, back]);

  // Land keyboard focus inside the card. Close is the safe target — nothing
  // in here does anything but navigate, so there is no dangerous default.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div className="hist" role="presentation">
      <div
        className="hist__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <div className="hist__head">
          {open && (
            <button type="button" className="hist__back" onClick={back}>
              ← All plans
            </button>
          )}
          <h2 className="hist__title" id={headingId}>
            {open ? open.dateLabel : "Your history"}
          </h2>
          <button
            type="button"
            className="hist__close"
            onClick={onDismiss}
            ref={closeRef}
            aria-label="Close history"
          >
            ✕
          </button>
        </div>

        <div className="hist__body">
          {isGuest ? (
            <GuestNudge canSignIn={canSignIn} onSignIn={onSignIn} />
          ) : open ? (
            <PlanDetail entry={open} />
          ) : (
            <PlanList state={state} onOpen={setOpenId} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The signup nudge. A guest is not missing a feature by accident — their
 *  plans were never archived, by design — so this says what an account would
 *  change and offers the way in, rather than reporting an empty list. */
function GuestNudge({
  canSignIn,
  onSignIn,
}: {
  canSignIn: boolean;
  onSignIn: () => void;
}) {
  return (
    <div className="hist__empty">
      <p className="hist__emptyTitle">Sign in to save your plans</p>
      <p className="hist__emptyText">
        Plans you finish while signed in are kept here, so you can look back at
        where you went. Guests keep the whole app — an account only keeps the
        record.
      </p>
      {canSignIn ? (
        <button type="button" className="hist__cta" onClick={onSignIn}>
          Sign in
        </button>
      ) : (
        <p className="hist__note" role="status">
          Sign-in is unavailable right now. Everything else still works.
        </p>
      )}
    </div>
  );
}

function PlanList({
  state,
  onOpen,
}: {
  state: LoadState;
  onOpen: (id: string) => void;
}) {
  if (state.phase === "idle" || state.phase === "loading") {
    return (
      <p className="hist__note" role="status" aria-live="polite">
        Looking for your saved plans…
      </p>
    );
  }

  // A read that FAILED is not an empty history. Saying "no saved plans yet" to
  // someone with twenty of them would read as data loss.
  if (state.phase === "error" || state.readFailed) {
    return (
      <p className="hist__err" role="alert">
        Couldn&apos;t load your history just now. Nothing has been lost — try
        again in a moment.
      </p>
    );
  }

  if (state.entries.length === 0) {
    return (
      <div className="hist__empty">
        <p className="hist__emptyTitle">No saved plans yet</p>
        <p className="hist__emptyText">
          When you finish an outing, it lands here.
        </p>
      </div>
    );
  }

  return (
    <ul className="hist__list">
      {state.entries.map((entry) => (
        <li key={entry.id}>
          <button type="button" className="hist__row" onClick={() => onOpen(entry.id)}>
            <span className="hist__rowDate">{entry.dateLabel}</span>
            <span className="hist__rowMeta">
              {entry.timeLabel ? `${entry.timeLabel} · ` : ""}
              {entry.stopCountLabel}
            </span>
            {/* The stop names ARE the summary — there is no title in the
                record, and this is the most a row can honestly say. */}
            <span className="hist__rowStops">
              {entry.stops.map((stop) => stop.title).join(" → ") || "—"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One plan, read-only. Deliberately no controls: opening a past outing is
 *  looking at it, and this stage adds no way to act on one. */
function PlanDetail({ entry }: { entry: HistoryEntryView }) {
  return (
    <div className="hist__detail">
      <p className="hist__detailMeta">
        {entry.timeLabel ? `${entry.timeLabel} · ` : ""}
        {entry.stopCountLabel}
      </p>
      {entry.stops.length === 0 ? (
        <p className="hist__note">This plan has no stops on record.</p>
      ) : (
        <ol className="hist__stops">
          {entry.stops.map((stop) => (
            <li
              key={stop.key}
              className={"hist__stop" + (stop.skipped ? " hist__stop--skipped" : "")}
            >
              <span className="hist__stopCat eyebrow">{stop.category || "stop"}</span>
              <span className="hist__stopName">{stop.title}</span>
              <span className="hist__stopTime">
                {stop.timeLabel ?? "no time recorded"}
                {stop.skipped ? " · skipped" : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
