"use client";

// The taste questions as a grid of chips — RENDERING ONLY.
//
// Shared by the onboarding survey and the edit-profile panel, and the boundary
// is drawn tightly on purpose: this file holds the MARKUP those two screens
// genuinely have in common (a fieldset per dimension, a multi-select chip per
// option, `aria-pressed` because a chip that toggles is a checkbox whatever it
// looks like, and the one free-text box the foods question's "Other" chip
// reveals) and NONE of the behaviour they do not. Everything the two screens
// disagree about — a blank start versus a pre-filled one, escape writing a skip
// versus asking about unsaved work, a two-second send-off versus a Save button,
// shown-once versus re-openable — stays in the screen it belongs to.
//
// Class names stay `taste__*`. These ARE the taste chips; both screens ask the
// same four questions, and giving the editor a parallel set of identical rules
// would be a second copy of the same styling free to drift from this one.
import {
  FREE_TEXT_DIMENSION,
  MAX_FREE_TEXT_LENGTH,
  OTHER_OPTION,
  SURVEY_QUESTIONS,
  type TasteAnswers,
  type TasteDimension,
} from "./lib/tastePreferences";

export default function TasteQuestions({
  answers,
  onToggle,
  onOtherChange,
}: {
  /** The current selection. Membership is by SLUG — the stored value — so a
   *  reworded label cannot change what appears ticked. */
  answers: TasteAnswers;
  onToggle: (dimension: TasteDimension, value: string) => void;
  /** The typed cuisine changed. REQUIRED, not optional: an optional handler
   *  would let a screen render the box and quietly drop what is typed into
   *  it, and both screens that exist want the text. */
  onOtherChange: (dimension: TasteDimension, value: string) => void;
}) {
  return (
    <>
      {SURVEY_QUESTIONS.map((question) => (
        <fieldset className="taste__q" key={question.id}>
          <legend className="taste__qLabel">{question.question}</legend>
          <div className="taste__opts">
            {question.options.map((opt) => {
              const on = answers[question.id].includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={"taste__opt" + (on ? " taste__opt--on" : "")}
                  // A multi-select chip is a checkbox, whatever it looks like —
                  // screen readers must hear "pressed", not a button that seems
                  // to do nothing.
                  aria-pressed={on}
                  onClick={() => onToggle(question.id, opt.value)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {/* The one free-text box, revealed by the one chip that opens it.
              Rendering only, like everything else here: the value and the
              handler both live in the screen. `FREE_TEXT_DIMENSION` decides
              which question gets it — dietary has an "Other" chip too and
              deliberately does NOT get a box (see the constant). Wrapped in a
              <label> rather than wired by id, because two screens can hold
              this grid and duplicate ids would break the association. */}
          {question.id === FREE_TEXT_DIMENSION &&
            answers[question.id].includes(OTHER_OPTION) && (
              <label className="taste__other">
                <span className="taste__otherLabel">Which cuisine?</span>
                <input
                  className="taste__otherInput"
                  type="text"
                  value={answers.other?.[question.id] ?? ""}
                  onChange={(event) => onOtherChange(question.id, event.target.value)}
                  // The same cap storage applies, enforced where the user can
                  // see it happen rather than silently on save.
                  maxLength={MAX_FREE_TEXT_LENGTH}
                  placeholder="e.g. Ethiopian"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            )}
        </fieldset>
      ))}
    </>
  );
}
