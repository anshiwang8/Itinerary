"use client";

// Your taste, editable — the other half of the onboarding survey.
//
// A SIBLING OF `TasteSurvey`, NOT A REUSE OF IT, and the difference is the
// whole reason this file exists. The survey is a one-shot capture: it starts
// blank, it is shown once, escape files a skip, and it closes itself with a
// send-off two seconds after submitting. Every one of those is wrong for a
// screen you can re-open — a blank start would silently erase what is stored,
// an escape that writes would file an accidental answer, and a form you can
// leave without saving needs to say so. What the two DO share is the question
// grid, and only that: `TasteQuestions` renders it for both.
//
// Structure mirrors HistoryPanel — a centred card over a dimmed stage, a
// discriminated load state, one fetch per open, escape to leave, focus moved
// inside on open. Palette is the app's own: white card, ink-navy type, mid-teal
// accent. Acid green (--live) is RESERVED for "happening now / just changed"
// and appears nowhere here; a stored preference is neither.
//
// TWO TRAPS ARE GUARDED HERE, both documented at the point they bite:
//  1. `POST /api/profile` writes with `set` and NO merge, so a save that
//     omitted a dimension would erase it. Every save sends all four, seeded
//     from what was read — and a read that FAILED shows an error instead of an
//     editor, because blanks over real answers is the same wipe by another
//     route.
//  2. The planner reads this profile back SERVER-SIDE on the next plan. The
//     save therefore goes through page.tsx's shared writer, which keeps the
//     promise in `pendingProfileWrite` for the plan to wait on. A fetch issued
//     from in here would re-open exactly the race that closed on 2026-08-09.
import { useCallback, useEffect, useRef, useState } from "react";
import TasteQuestions from "./TasteQuestions";
import {
  answersDirty,
  type ProfileEditLoad,
  type ProfileSaveResult,
} from "./lib/profileEdit";
import {
  normalizeAnswerSet,
  type TasteAnswers,
  type TasteDimension,
} from "./lib/tastePreferences";

type LoadState =
  | { phase: "loading" }
  // `seed` is what is STORED; `answers` is what is on screen. Both live in the
  // ready phase so they cannot desync — there is no editable answer set before
  // the read lands, and a successful save replaces the seed with what it wrote.
  | { phase: "ready"; seed: TasteAnswers; answers: TasteAnswers }
  | { phase: "error" };

type SaveState = "idle" | "saving" | "saved" | "failed";

export default function ProfilePanel({
  load,
  save,
  onDismiss,
}: {
  /** Reads the caller's stored profile. Injected so this component knows
   *  nothing about tokens or fetch — page.tsx owns the session, exactly as it
   *  does for HistoryPanel. */
  load: () => Promise<ProfileEditLoad>;
  /** Files the edited answers. This is page.tsx's SHARED writer, so the save
   *  inherits `pendingProfileWrite` (trap 2 above) and the optimistic profile
   *  gate. It resolves to whether anything was stored and never rejects. */
  save: (answers: TasteAnswers) => Promise<ProfileSaveResult>;
  onDismiss: () => void;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const headingId = "prof-title";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // One fetch per open, with the same `cancelled` latch HistoryPanel uses. The
  // panel mounts fresh on every open, so this is also how a second open picks
  // up an edit made in a different tab.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await load();
        if (cancelled) return;
        // A read that FAILED is not an empty profile. Showing an editor here
        // would offer a Save that writes blanks over whatever is actually
        // stored — see trap 1.
        if (result.readFailed) setState({ phase: "error" });
        else setState({ phase: "ready", seed: result.answers, answers: result.answers });
      } catch {
        // The route answers 200 even with nothing to say, so reaching here
        // means the request never landed. Same conclusion, same reason.
        if (!cancelled) setState({ phase: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const dirty = state.phase === "ready" && answersDirty(state.seed, state.answers);

  /** Editing IS "keep editing", and a stale "Saved" beside answers that have
   *  moved on since would be a lie. Both edit paths — a chip and the text box
   *  — start here so the two cannot drift. */
  const beginEdit = useCallback(() => {
    setConfirmDiscard(false);
    setSaveState((current) => (current === "saving" ? current : "idle"));
  }, []);

  const toggle = useCallback((dimension: TasteDimension, value: string) => {
    beginEdit();
    setState((current) => {
      if (current.phase !== "ready") return current;
      const chosen = current.answers[dimension];
      const next = chosen.includes(value)
        ? chosen.filter((v) => v !== value)
        : [...chosen, value];
      return {
        ...current,
        answers: {
          ...current.answers,
          // Re-emitted in the question's own order, by the same function
          // storage uses. Keeps the on-screen set byte-comparable with the
          // stored one, and drops anything outside the closed option set.
          [dimension]: normalizeAnswerSet(dimension, next),
        },
      };
    });
  }, [beginEdit]);

  /** The typed cuisine. Held RAW while the user types — sanitizing per
   *  keystroke would eat the space in "soul food" — and cleaned by the same
   *  normaliser on both sides of the dirty comparison and again on the way
   *  into storage, so "Ethiopian!" over a stored "Ethiopian" correctly reads
   *  as no change at all. */
  const setOther = useCallback(
    (dimension: TasteDimension, value: string) => {
      beginEdit();
      setState((current) =>
        current.phase === "ready"
          ? {
              ...current,
              answers: {
                ...current.answers,
                other: { ...current.answers.other, [dimension]: value },
              },
            }
          : current
      );
    },
    [beginEdit]
  );

  const commit = useCallback(async () => {
    if (state.phase !== "ready" || saveState === "saving") return;
    const answers = state.answers;
    setSaveState("saving");
    // ALL FOUR DIMENSIONS AND THE FREE TEXT, ALWAYS — `answers` is a complete
    // TasteAnswers seeded from the stored profile, and the typed cuisine rides
    // INSIDE it (`answers.other`) rather than as a second argument, so a
    // dimension the user never touched is sent back exactly as it was filed.
    // The write is `set` with no merge; anything omitted here would be erased.
    const result = await save(answers);
    if (!mounted.current) return;
    if (result.saved) {
      // What was saved becomes the new clean baseline, so closing straight
      // after saving does not ask about changes that are no longer unsaved.
      setState((current) =>
        current.phase === "ready" ? { ...current, seed: answers } : current
      );
      setSaveState("saved");
    } else {
      setSaveState("failed");
    }
  }, [state, saveState, save]);

  /** Leaving. Clean closes at once; dirty asks first — an Escape keypress must
   *  not be able to throw away work silently. */
  const requestClose = useCallback(() => {
    if (dirty) setConfirmDiscard(true);
    else onDismiss();
  }, [dirty, onDismiss]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape steps back one level, as it does in HistoryPanel — and the step
      // back from the discard prompt is KEEPING the changes, because the safe
      // default at every level is the one that destroys nothing.
      if (confirmDiscard) setConfirmDiscard(false);
      else requestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDiscard, requestClose]);

  // Land keyboard focus inside the card. Close is the safe target on open —
  // nothing is written until Save — and "Keep editing" is the safe target once
  // the discard prompt is up.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    if (confirmDiscard) keepRef.current?.focus();
  }, [confirmDiscard]);

  return (
    <div className="prof" role="presentation">
      <div
        className="prof__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <div className="prof__head">
          <h2 className="prof__title" id={headingId}>
            Your preferences
          </h2>
          <button
            type="button"
            className="prof__close"
            onClick={requestClose}
            ref={closeRef}
            aria-label="Close preferences"
          >
            ✕
          </button>
        </div>

        <div className="prof__body">
          {state.phase === "loading" && (
            <p className="prof__note" role="status" aria-live="polite">
              Looking up your preferences…
            </p>
          )}
          {state.phase === "error" && (
            // No editor on a failed read, deliberately. We do not know what is
            // stored, and the save would replace all of it.
            <p className="prof__err" role="alert">
              Couldn&apos;t load your preferences just now. Nothing has been
              changed, close this and try again in a moment.
            </p>
          )}
          {state.phase === "ready" && (
            <>
              <p className="prof__lede">
                These shade the plans we make when your request leaves something
                open. Change as much or as little as you like.
              </p>
              <TasteQuestions
                answers={state.answers}
                onToggle={toggle}
                onOtherChange={setOther}
              />
            </>
          )}
        </div>

        {state.phase === "ready" && (
          <div className="prof__foot">
            {confirmDiscard ? (
              <>
                <p className="prof__confirm" role="alert">
                  Discard your changes?
                </p>
                <button
                  type="button"
                  className="prof__cancel"
                  onClick={() => setConfirmDiscard(false)}
                  ref={keepRef}
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  className="prof__discard"
                  onClick={onDismiss}
                >
                  Discard
                </button>
              </>
            ) : (
              <>
                {/* One line, three states, and silence when there is nothing to
                    report. An explicit Save with no acknowledgement reads as a
                    button that did nothing. */}
                <p
                  className={
                    "prof__status" + (saveState === "failed" ? " prof__status--err" : "")
                  }
                  role="status"
                  aria-live="polite"
                >
                  {saveState === "saving" && "Saving…"}
                  {saveState === "saved" && "Saved"}
                  {saveState === "failed" && "Couldn't save, try again"}
                </p>
                <button type="button" className="prof__cancel" onClick={requestClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="prof__save"
                  onClick={() => void commit()}
                  // Nothing changed is nothing to save. It lights up the moment
                  // a chip moves, which is also the moment the panel starts
                  // asking before it closes.
                  disabled={!dirty || saveState === "saving"}
                >
                  Save changes
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
