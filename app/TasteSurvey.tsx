"use client";

// The onboarding taste survey — asked once, of a brand-new signed-in user.
//
// CAPTURE ONLY — still true of THIS COMPONENT, and no longer true of the
// answers. It files them and has deliberately no way to spend them; what they
// then MEAN to a plan is decided in `api/parse/plannerPreferences.ts` and in
// the planner prompt. (The original comment here said no plan behaves any
// differently for having answered. That stopped being true when Stage 3B
// shipped, and the activities dimension made it emphatically untrue: an
// answer to the fourth question can change which KIND of stop a vague day
// gets.)
//
// FOUR OPTIONAL QUESTIONS, all multi-select. They come from SURVEY_QUESTIONS
// and are rendered by mapping it, so a new dimension needs no change here —
// except the COUNT in the sub-heading below, which is written out in words and
// is the one thing that has to move with the list.
//
// "Optional" is load-bearing — submitting with nothing ticked is a valid
// answer and is stored as one, so the primary button never disables and never
// scolds. The only irreversible thing on this screen is that it will not be
// shown again, which is true of the skip too; both write the same `surveySeen`
// flag.
//
// Structure mirrors LoginScreen and HistoryPanel — a centred card over a dimmed
// stage, escape to leave, focus moved inside on open. Palette is the app's own:
// white card, ink-navy type, mid-teal accent. Acid green (--live) is RESERVED
// for "happening now / just changed" and appears nowhere here, including on the
// confirmation: a stored preference is not a live event.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TasteQuestions from "./TasteQuestions";
import {
  EMPTY_ANSWERS,
  SURVEY_QUESTIONS,
  freeTextAnswer,
  type TasteAnswers,
  type TasteDimension,
} from "./lib/tastePreferences";

/** How long the confirmation sits before it drops the user into the app. Long
 *  enough to read four words, short enough that nobody reaches for a close
 *  button that isn't there. */
export const CONFIRM_MS = 2000;

export default function TasteSurvey({
  onSubmit,
  onSkip,
  onClose,
}: {
  /** Files the answers. Never rejects in a way this screen has to handle: the
   *  route answers 200 even when there is nowhere to write, so a failed save is
   *  a silent no-op rather than an error dialog over a finished form. */
  onSubmit: (answers: TasteAnswers) => void;
  /** Files the dismissal, so the survey does not reappear next login. */
  onSkip: () => void;
  /** Unmounts the survey. Called by the skip immediately, and by the submit
   *  after the confirmation has had its moment. */
  onClose: () => void;
}) {
  const [answers, setAnswers] = useState<TasteAnswers>(EMPTY_ANSWERS);
  const [confirming, setConfirming] = useState(false);
  const skipRef = useRef<HTMLButtonElement>(null);
  const headingId = "taste-title";

  const toggle = useCallback((dimension: TasteDimension, value: string) => {
    setAnswers((current) => {
      const chosen = current[dimension];
      return {
        ...current,
        [dimension]: chosen.includes(value)
          ? chosen.filter((v) => v !== value)
          : [...chosen, value],
      };
    });
  }, []);

  /** The typed cuisine, held RAW. Sanitizing per keystroke would fight the
   *  typist — a trim eats the space in "soul food" the moment it is pressed —
   *  so the text is cleaned once, on the way into storage, by the same
   *  normaliser the server runs. Text left behind by an un-pressed "Other" is
   *  dropped there too, so nothing needs clearing here. */
  const setOther = useCallback((dimension: TasteDimension, value: string) => {
    setAnswers((current) => ({
      ...current,
      other: { ...current.other, [dimension]: value },
    }));
  }, []);

  const submit = useCallback(() => {
    // Fire-and-forget by design. The confirmation is about the ANSWERS being
    // given, not about a round trip completing, and holding a spinner over a
    // finished form to wait for a write that cannot fail loudly would be a
    // worse screen.
    onSubmit(answers);
    setConfirming(true);
  }, [answers, onSubmit]);

  const skip = useCallback(() => {
    // A skip STILL WRITES. "Skip for now" means "not now", but "don't ask me
    // every time I open the app" is the promise the flag keeps. No confirmation
    // screen: nothing was given, so there is nothing to acknowledge.
    onSkip();
    onClose();
  }, [onSkip, onClose]);

  // The latest onClose, held in a ref so the timer below does not depend on its
  // IDENTITY. Callers pass an inline arrow (page.tsx does), which is a new
  // function on every parent render — and with `onClose` in the dependency
  // array, each of those renders would clear the pending timer and start a
  // fresh two seconds. Home re-renders for plenty of reasons that have nothing
  // to do with this screen, and a parent that re-rendered on an interval would
  // hold the confirmation open indefinitely.
  //
  // Not a bug that was observed in the wild — the ref is here because the
  // dependency was wrong, not because anyone saw it stick.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // The confirmation auto-closes. Depends on `confirming` ALONE, so the two
  // seconds start once and mean two seconds. Cleared on unmount so a fast
  // unmount can never call onClose against a screen that is already gone.
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => onCloseRef.current(), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  // Escape is the SKIP, not a silent dismissal — leaving with no record would
  // mean the survey returns on the next login, which is the one behaviour this
  // stage promises not to have. Disabled during the confirmation: the answers
  // are already filed and the screen is closing on its own.
  useEffect(() => {
    if (confirming) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") skip();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirming, skip]);

  // Land keyboard focus inside the card. Skip is the safe target: it is the
  // choice that discards nothing the user has entered.
  useEffect(() => {
    skipRef.current?.focus();
  }, []);

  // A typed cuisine counts as an answer given — someone who ticked "Other" and
  // wrote "Ethiopian" should see "Save preferences", not "Continue".
  const chosenCount = useMemo(
    () =>
      SURVEY_QUESTIONS.reduce((total, q) => total + answers[q.id].length, 0) +
      (freeTextAnswer(answers) ? 1 : 0),
    [answers]
  );

  if (confirming) return <Confirmation headingId={headingId} />;

  return (
    <div className="taste" role="presentation">
      <div
        className="taste__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby="taste-sub"
      >
        <div className="taste__head">
          <div className="taste__mark" aria-hidden="true">
            Itinerary
          </div>
          <h2 className="taste__title" id={headingId}>
            Tell us your taste
          </h2>
          <p className="taste__sub" id="taste-sub">
            Four quick questions, all optional. Pick as many as you like.
          </p>
        </div>

        <div className="taste__body">
          {/* Rendering only. The grid is shared with the edit-profile panel;
              everything this screen does with an answer — the blank start, the
              escape-writes-a-skip, the send-off — stays here. */}
          <TasteQuestions answers={answers} onToggle={toggle} onOtherChange={setOther} />
        </div>

        <div className="taste__foot">
          <button type="button" className="taste__skip" onClick={skip} ref={skipRef}>
            Skip for now
          </button>
          {/* Never disabled. Submitting nothing is a real answer, and a greyed
              primary button would read as "you must pick something". */}
          <button type="button" className="taste__save" onClick={submit}>
            {chosenCount > 0 ? "Save preferences" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The send-off. Two seconds, no controls — a screen with a button on it is a
 *  screen asking for a decision, and this one has nothing left to decide. */
function Confirmation({ headingId }: { headingId: string }) {
  return (
    <div className="taste" role="presentation">
      <div
        className="taste__card taste__card--done"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <div className="taste__burst" aria-hidden="true">
          <span className="taste__spark taste__spark--a" />
          <span className="taste__spark taste__spark--b" />
          <span className="taste__spark taste__spark--c" />
          <span className="taste__check">✓</span>
        </div>
        <h2 className="taste__done" id={headingId} role="status" aria-live="polite">
          Perfect! You&apos;re all set
        </h2>
        <p className="taste__doneSub">Taking you to your plans…</p>
      </div>
    </div>
  );
}
