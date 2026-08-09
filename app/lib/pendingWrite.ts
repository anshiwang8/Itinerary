// A background write the next foreground action has to wait for.
//
// PURE. No React, no fetch — the shape is deliberately structural (`{ current }`
// is exactly a React ref object) so a component can hand its own `useRef`
// straight in, and this file can be tested without one.
//
// THE PROBLEM IT SOLVES, precisely. The onboarding taste survey files its
// answers fire-and-forget: the confirmation screen is about the answers being
// GIVEN, not about a round trip completing, and holding a spinner over a
// finished form to wait for a write that cannot fail loudly would be a worse
// screen. That is the right call for the SURVEY and the wrong one for what
// happens next — the planner reads that profile back SERVER-SIDE, fresh, on the
// very next plan. A user who submitted the survey and immediately planned could
// beat their own write and get an un-personalized day, then see the same prompt
// work after a reload. The window is small (the confirmation alone is two
// seconds) but the write is on the coldest path a session has: a first ID-token
// verification fetches Google's signing certs and a first Firestore call opens
// its channel, both before the document is even touched.
//
// So the WRITE stays unawaited where the user can feel it, and the PLAN — the
// one action whose correctness depends on it — waits for whatever is left.

/** A mutable holder for the in-flight write. Structurally a React ref. */
export interface PendingWriteRef {
  current: Promise<void> | null;
}

/**
 * Wait for a pending background write, then forget it.
 *
 * NULL IS THE ORDINARY CASE and returns immediately: every plan that is not
 * the one right after a survey submit pays nothing at all for this.
 *
 * THIS NEVER THROWS, and that is the whole contract. A write that failed or
 * timed out must DELAY the action behind it, never FAIL it — a plan is not the
 * place to report that a preference did not save. The writer already swallows
 * its own failure; this is belt to that braces, so the guarantee holds for any
 * caller rather than only for a well-behaved one. The bound on the wait is
 * whatever bound the write itself carries (`fetchJson` has a 15s deadline);
 * nothing here adds a second, competing timeout.
 *
 * The ref is cleared only if it still holds the promise that was awaited — a
 * newer write started while this one was settling is still pending, and
 * dropping it would put the next caller back in the race this exists to close.
 */
export async function settlePendingWrite(ref: PendingWriteRef): Promise<void> {
  const pending = ref.current;
  if (!pending) return;
  try {
    await pending;
  } catch {
    // A write that broke is not the next action's problem to report.
  }
  if (ref.current === pending) ref.current = null;
}
