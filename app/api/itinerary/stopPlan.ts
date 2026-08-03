// Ending a plan on purpose — what the user chose, and what that means.
//
// PURE. No store, no Firestore, no request. The Firestore write and the CAS
// update are live-only, but "does this choice archive, and does it end" is
// ordinary branching, so it lives here where `stopPlan.test.ts` can pin it.
//
// This is a SECOND route to conclusion, alongside the end-time one. It does
// not replace it: `withStatuses` still derives "completed" from the clock, and
// the by-id GET still archives when it first sees that. This module only
// covers the case where a person pressed the button.
//
// IMPORTANT — the same function runs on both sides, and the SERVER's answer is
// the one that counts. The browser tells us which button was pressed; whether
// that button may archive is decided from the VERIFIED caller's anonymity, so
// a guest client asking to save gets a no-archive answer regardless.

/** What the person chose in the confirmation dialog. */
export type StopChoice = "save-end" | "discard-end" | "cancel";

export interface StopOutcome {
  /** Write this plan to the owner's Firestore history before ending it. */
  shouldArchive: boolean;
  /** Conclude the plan and stop it being resumable. */
  shouldEnd: boolean;
}

/** Anything that is not one of the three known choices is treated as cancel:
 *  an unrecognised instruction to END something is the one case where
 *  guessing is expensive, so it does nothing. */
export function isStopChoice(value: unknown): value is StopChoice {
  return value === "save-end" || value === "discard-end" || value === "cancel";
}

/**
 * Turn (who they are, what they pressed) into what actually happens.
 *
 * The anonymity gate is the same promise Stage 1B made: a guest's plan is
 * NEVER written to history. Not written-then-deleted — never written. So a
 * guest is not offered a save option, and if one is somehow requested anyway
 * (a stale client, a crafted request), it still does not archive. The UI
 * choice is an input to be validated, exactly like every other input.
 */
export function resolveStopOutcome(isAnonymous: boolean, choice: StopChoice): StopOutcome {
  if (choice === "cancel") {
    // Cancel is not a soft end. Nothing is archived, nothing is concluded,
    // and the plan the user is standing in front of is untouched.
    return { shouldArchive: false, shouldEnd: false };
  }
  // Both remaining choices end the plan. They differ only in whether a copy
  // is kept, and only a real account can keep one.
  return {
    shouldArchive: choice === "save-end" && !isAnonymous,
    shouldEnd: true,
  };
}

/**
 * Which buttons the dialog offers. Guests get TWO, not three: showing someone
 * a "Save & end" they are not eligible for would be offering a thing that
 * silently does nothing — worse than not offering it.
 */
export function stopChoicesFor(isAnonymous: boolean): StopChoice[] {
  return isAnonymous
    ? ["discard-end", "cancel"]
    : ["save-end", "discard-end", "cancel"];
}
