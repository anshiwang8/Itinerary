// The app's own user shape, and the pure mapping onto it.
//
// Kept separate from the Firebase SDK on purpose: this is the one piece of
// auth with real logic in it, so it is the one piece worth testing in
// isolation. `FirebaseUserLike` is declared STRUCTURALLY rather than imported
// as Firebase's `User`, so authUser.test.ts can exercise every shape the
// provider might hand back — including the malformed ones — without the SDK,
// a network, or a popup.

export interface AppUser {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  /**
   * Firebase ANONYMOUS sign-in — i.e. a guest. Since Stage 1B every visitor
   * is signed in, so "is there a user" no longer distinguishes guest from
   * account; THIS does. It gates exactly one thing (history archiving) and
   * whether the account chip is shown. It gates no app functionality:
   * anonymous users get the entire product, including a plan that survives
   * refresh.
   *
   * Defaults to true when the provider does not say. That direction is
   * deliberate: mistaking an account for a guest costs a history entry,
   * mistaking a guest for an account would file a stranger's outing under a
   * real person's uid.
   */
  isAnonymous: boolean;
}

/** Only the fields this slice needs, all `unknown` because a provider payload
 *  is untrusted input like any other — Google is not obliged to send a
 *  displayName, and an anonymous provider sends almost nothing. */
export interface FirebaseUserLike {
  uid?: unknown;
  displayName?: unknown;
  email?: unknown;
  photoURL?: unknown;
  isAnonymous?: unknown;
}

/** A present-but-blank string is absent. Google returns "" for a missing
 *  photo often enough that treating it as a URL would render a broken image. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Firebase user → AppUser, or null when there is no usable identity.
 *
 * The uid is the only REQUIRED field: it is the whole point of signing in
 * (later stages key off it) and a record without one cannot be an account.
 * Everything else is decoration and may legitimately be absent.
 */
export function toAppUser(user: FirebaseUserLike | null | undefined): AppUser | null {
  if (!user) return null;
  const uid = text(user.uid);
  if (!uid) return null;
  return {
    uid,
    displayName: text(user.displayName),
    email: text(user.email),
    photoURL: text(user.photoURL),
    // Only an EXPLICIT false makes someone a real account. Anything else —
    // absent, undefined, a non-boolean — reads as a guest, because the safe
    // failure is losing a history entry, not filing a stranger's night out
    // under someone's name.
    isAnonymous: user.isAnonymous !== false,
  };
}

/** What to call someone in the UI, never empty. */
export function userLabel(user: AppUser): string {
  return user.displayName ?? user.email ?? "Signed in";
}

/**
 * Avatar fallback when there is no photo. A name gives up to two initials; an
 * email gives one letter from its local part — "AG" for anshiwang@gmail.com
 * would read as a surname that isn't there.
 */
export function userInitials(user: AppUser): string {
  if (user.displayName) {
    const words = user.displayName.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
    if (words.length > 0) {
      return words
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase();
    }
  }
  if (user.email) {
    const local = user.email.split("@")[0] ?? "";
    const first = local.replace(/[^A-Za-z0-9]/g, "")[0];
    if (first) return first.toUpperCase();
  }
  return "?";
}
