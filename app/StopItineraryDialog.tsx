"use client";

// The "are you sure" for ending a plan.
//
// Structure mirrors LoginScreen: a centred card over a dimmed stage, escape to
// dismiss, focus moved inside on open. Palette is the app's own — white card,
// ink type, teal accent. Acid green is RESERVED for "happening now / just
// changed" and appears nowhere here; ending a plan is the opposite of live.
//
// The options come from `stopChoicesFor`, so a guest is never shown a "Save &
// end" they are not eligible for. The button labels live here; the DECISION
// lives in stopPlan.ts and is re-made on the server.
import { useEffect, useRef } from "react";
import { stopChoicesFor, type StopChoice } from "./api/itinerary/stopPlan";

const LABELS: Record<StopChoice, string> = {
  "save-end": "Save & end",
  // A guest sees this same choice, but it is the ONLY end option they get, so
  // it is labelled plainly rather than as a discard — there is nothing they
  // could have saved, and "discard" would imply they lost something.
  "discard-end": "Discard & end",
  cancel: "Cancel",
};

const GUEST_END_LABEL = "End itinerary";

export default function StopItineraryDialog({
  isAnonymous,
  busy,
  error,
  onChoose,
}: {
  isAnonymous: boolean;
  busy: boolean;
  error: string | null;
  onChoose: (choice: StopChoice) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const choices = stopChoicesFor(isAnonymous);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape is cancel. The safe outcome is always the one that keeps the
      // plan, so the key that means "get me out of here" must not end it.
      if (event.key === "Escape" && !busy) onChoose("cancel");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onChoose, busy]);

  // Focus lands on Cancel, not on an ending action — a stray Enter should
  // never conclude someone's evening.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div className="stopdlg" role="presentation">
      <div
        className="stopdlg__card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="stopdlg-title"
      >
        <h2 className="stopdlg__title" id="stopdlg-title">
          Are you sure you want to end this itinerary?
        </h2>
        <p className="stopdlg__sub">
          {isAnonymous
            ? "Ending it clears the plan and takes you back to the start."
            : "You can keep a copy in your history, or end without saving."}
        </p>

        {error && (
          <p className="stopdlg__err" role="alert">
            {error}
          </p>
        )}

        <div className="stopdlg__actions">
          {choices.map((choice) => {
            const isCancel = choice === "cancel";
            const label =
              isAnonymous && choice === "discard-end" ? GUEST_END_LABEL : LABELS[choice];
            return (
              <button
                key={choice}
                type="button"
                ref={isCancel ? cancelRef : undefined}
                className={
                  "stopdlg__btn" +
                  (isCancel ? " stopdlg__btn--cancel" : "") +
                  (choice === "save-end" ? " stopdlg__btn--save" : "")
                }
                disabled={busy}
                onClick={() => onChoose(choice)}
              >
                {busy && !isCancel ? "…" : label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
