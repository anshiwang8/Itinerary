"use client";

// "This runs past when you said you'd be done" — the one swap outcome that is
// a QUESTION rather than an answer.
//
// It exists because pushing the later stops back to fit a replacement can end
// the day after the finish the user actually stated ("back by 10"). That is
// not a refusal — nothing is impossible about it — and it is not ours to wave
// through either. A closing time is physics and gets an honest refusal
// upstream; a stated end is the user's own intent, so this asks.
//
// Structure mirrors StopItineraryDialog, deliberately: same centred card over
// a dimmed stage, same escape-to-dismiss, same focus discipline. A second
// dialog language would be a second thing to keep consistent.
//
// DECLINE IS THE SAFE DEFAULT and is wired that way at every level — escape
// dismisses to it, focus lands on it, and the server never wrote anything to
// begin with (the proposal is still a clone). Acid green is RESERVED for
// "happening now / just changed"; nothing here has happened yet.
import { useEffect, useRef } from "react";
import type { SwapEndTimeConfirm } from "./lib/clientPayloads";

export default function SwapEndTimeDialog({
  confirm,
  busy,
  error,
  onDecide,
}: {
  confirm: SwapEndTimeConfirm;
  busy: boolean;
  error: string | null;
  onDecide: (accepted: boolean) => void;
}) {
  const declineRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape means decline. "Get me out of here" must never be the key that
      // rewrites the rest of someone's evening.
      if (event.key === "Escape" && !busy) onDecide(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDecide, busy]);

  // Focus lands on "Keep it as it is", not on the accepting action — a stray
  // Enter should not extend the night.
  useEffect(() => {
    declineRef.current?.focus();
  }, []);

  return (
    <div className="stopdlg" role="presentation">
      <div
        className="stopdlg__card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="swapend-title"
        aria-describedby="swapend-sub"
      >
        <h2 className="stopdlg__title" id="swapend-title">
          This will push your day to {confirm.proposedEndLabel} instead of{" "}
          {confirm.statedEndLabel}. Continue?
        </h2>
        <p className="stopdlg__sub" id="swapend-sub">
          The replacement can&rsquo;t be reached in time, so the later stops
          have to move back. Everything stays open &mdash; it just ends later
          than you asked for.
        </p>

        {error && (
          <p className="stopdlg__err" role="alert">
            {error}
          </p>
        )}

        <div className="stopdlg__actions">
          <button
            type="button"
            className="stopdlg__btn stopdlg__btn--save"
            disabled={busy}
            onClick={() => onDecide(true)}
          >
            {busy ? "…" : `Continue — end at ${confirm.proposedEndLabel}`}
          </button>
          <button
            type="button"
            ref={declineRef}
            className="stopdlg__btn stopdlg__btn--cancel"
            onClick={() => onDecide(false)}
          >
            Keep it as it is
          </button>
        </div>
      </div>
    </div>
  );
}
