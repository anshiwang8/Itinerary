// The one piece of the auth slice with real logic in it: the mapping from a
// provider payload onto the app's own user shape. Pure, offline, no SDK — the
// live popup flow is verified by hand, but THIS is checkable, so it is checked.
import assert from "node:assert";
import {
  sameAppUserIdentity,
  toAppUser,
  userInitials,
  userLabel,
  type AppUser,
} from "./authUser";

/** A signed-in Google account, as `toAppUser` would hand it back. */
const account = (over: Partial<AppUser> = {}): AppUser => ({
  uid: "abc123",
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  photoURL: "https://lh3.googleusercontent.com/a/photo",
  isAnonymous: false,
  ...over,
});

const cases: Array<[string, () => void]> = [
  [
    "a full Google user maps across field for field",
    () => {
      assert.deepStrictEqual(
        toAppUser({
          uid: "abc123",
          displayName: "Anshi Wang",
          email: "anshi@example.com",
          photoURL: "https://lh3.googleusercontent.com/a/photo",
          isAnonymous: false,
        }),
        {
          uid: "abc123",
          displayName: "Anshi Wang",
          email: "anshi@example.com",
          photoURL: "https://lh3.googleusercontent.com/a/photo",
          isAnonymous: false,
        }
      );
    },
  ],
  [
    "anonymity: only an explicit false is a real account",
    () => {
      // The safe failure is losing a history entry, NOT filing a stranger's
      // night out under a real person's uid — so anything that isn't an
      // explicit `false` reads as a guest.
      assert.strictEqual(toAppUser({ uid: "u", isAnonymous: false })!.isAnonymous, false);
      assert.strictEqual(toAppUser({ uid: "u", isAnonymous: true })!.isAnonymous, true);
      assert.strictEqual(
        toAppUser({ uid: "u" })!.isAnonymous,
        true,
        "absent means guest, never account"
      );
      assert.strictEqual(
        toAppUser({ uid: "u", isAnonymous: "false" })!.isAnonymous,
        true,
        "a non-boolean is not an explicit false"
      );
      assert.strictEqual(toAppUser({ uid: "u", isAnonymous: 0 })!.isAnonymous, true);
    },
  ],
  [
    "no user is no user — null, undefined and a missing uid all map to null",
    () => {
      // The uid is the entire point of signing in; later stages key off it, so
      // a record without one is not an account, however much else it carries.
      assert.strictEqual(toAppUser(null), null);
      assert.strictEqual(toAppUser(undefined), null);
      assert.strictEqual(toAppUser({}), null);
      assert.strictEqual(toAppUser({ uid: "" }), null);
      assert.strictEqual(toAppUser({ uid: "   " }), null, "whitespace is not a uid");
      assert.strictEqual(toAppUser({ uid: 123 }), null, "a non-string uid is not a uid");
      assert.strictEqual(
        toAppUser({ displayName: "Anshi", email: "a@b.co" }),
        null,
        "decoration without a uid is still not an account"
      );
    },
  ],
  [
    "missing decoration is null, never an empty string",
    () => {
      // Google genuinely sends "" for a missing photo; passing that through
      // would render a broken image rather than the initials fallback.
      const user = toAppUser({
        uid: "u1",
        displayName: "",
        email: "   ",
        photoURL: "",
        isAnonymous: false,
      });
      assert.deepStrictEqual(user, {
        uid: "u1",
        displayName: null,
        email: null,
        photoURL: null,
        isAnonymous: false,
      });
    },
  ],
  [
    "surrounding whitespace is trimmed off every field",
    () => {
      assert.deepStrictEqual(
        toAppUser({ uid: "  u2  ", displayName: "  Ada L  ", isAnonymous: false }),
        {
          uid: "u2",
          displayName: "Ada L",
          email: null,
          photoURL: null,
          isAnonymous: false,
        }
      );
    },
  ],
  [
    "non-string fields are dropped rather than coerced",
    () => {
      const user = toAppUser({
        uid: "u3",
        displayName: 42,
        email: {},
        photoURL: [],
        isAnonymous: false,
      });
      assert.deepStrictEqual(user, {
        uid: "u3",
        displayName: null,
        email: null,
        photoURL: null,
        isAnonymous: false,
      });
    },
  ],

  [
    "the label prefers a name, falls back to email, and is never empty",
    () => {
      const named = toAppUser({ uid: "u", displayName: "Ada Lovelace", email: "ada@x.co" })!;
      const emailOnly = toAppUser({ uid: "u", email: "ada@x.co" })!;
      const bare = toAppUser({ uid: "u" })!;
      assert.strictEqual(userLabel(named), "Ada Lovelace");
      assert.strictEqual(userLabel(emailOnly), "ada@x.co");
      assert.strictEqual(userLabel(bare), "Signed in", "a uid alone still needs a label");
    },
  ],
  [
    "initials: two from a name, one from an email, and always something",
    () => {
      const initialsOf = (u: Parameters<typeof toAppUser>[0]) => userInitials(toAppUser(u)!);
      assert.strictEqual(initialsOf({ uid: "u", displayName: "Ada Lovelace" }), "AL");
      assert.strictEqual(
        initialsOf({ uid: "u", displayName: "Ada Byron King Lovelace" }),
        "AB",
        "two is the cap, not the count"
      );
      assert.strictEqual(initialsOf({ uid: "u", displayName: "Prince" }), "P");
      assert.strictEqual(initialsOf({ uid: "u", displayName: "mary-jane watson" }), "MJ");
      // an email gives ONE letter from its local part: "AG" for
      // anshiwang@gmail.com would read as a surname that does not exist
      assert.strictEqual(initialsOf({ uid: "u", email: "anshiwang@gmail.com" }), "A");
      assert.strictEqual(initialsOf({ uid: "u", email: "_weird@mail.com" }), "W");
      // a uid-only user still gets a glyph rather than an empty circle
      assert.strictEqual(initialsOf({ uid: "u" }), "?");
      assert.strictEqual(initialsOf({ uid: "u", displayName: "☃" }), "?", "no letters to take");
    },
  ],

  // ── the identity diff that makes a token refresh inert ──
  //
  // `useAuth` watches TOKENS, not auth state, because the SDK fires the
  // auth-state observer only on a uid CHANGE and upgrading a guest with
  // linkWithPopup deliberately keeps the uid. The price is that the observer
  // also fires on every token refresh, and `toAppUser` mints a fresh object
  // each time — so the subscription only stores a new user when this says
  // they differ. Under-firing loses the anonymity flip (the bug); over-firing
  // churns `user`'s identity on a timer and re-runs every effect keyed on it.
  [
    "a token refresh is NOT a change — identical fields compare equal",
    () => {
      // Two separately-mapped objects with the same content: exactly what two
      // consecutive token events produce. The subscription must keep the first.
      assert.strictEqual(sameAppUserIdentity(account(), account()), true);
    },
  ],
  [
    "THE BUG THIS EXISTS FOR: an anonymity flip on the SAME uid IS a change",
    () => {
      // linkWithPopup keeps the uid and flips isAnonymous. If this ever
      // returned true, the survey gate would never learn there is an account
      // and a brand-new user would see no survey until they reloaded.
      const guest = account({ isAnonymous: true, displayName: null, email: null });
      assert.strictEqual(
        sameAppUserIdentity(guest, account()),
        false,
        "the guest→account upgrade must replace the stored user"
      );
      // and isolated from the decoration that happens to move with it
      assert.strictEqual(
        sameAppUserIdentity(account({ isAnonymous: true }), account()),
        false,
        "isAnonymous alone is enough"
      );
    },
  ],
  [
    "a different uid is a different person",
    () => {
      // The signInWithCredential path (a returning Google account) mints a new
      // uid, and that must always replace the stored user.
      assert.strictEqual(sameAppUserIdentity(account(), account({ uid: "other" })), false);
    },
  ],
  [
    "every field the UI reads counts — name, email and photo included",
    () => {
      // Not a hand-picked subset: a field left out is a field that can go
      // stale on screen. The account corner renders all three.
      assert.strictEqual(
        sameAppUserIdentity(account(), account({ displayName: "Ada B Lovelace" })),
        false
      );
      assert.strictEqual(
        sameAppUserIdentity(account(), account({ email: "ada@other.co" })),
        false
      );
      assert.strictEqual(
        sameAppUserIdentity(account(), account({ photoURL: null })),
        false,
        "a changed avatar must reach the account corner"
      );
    },
  ],
  [
    "null and a present value are distinguished, not coerced",
    () => {
      // `toAppUser` normalises absent decoration to null, so null-vs-value is
      // the shape a real change arrives in — a loose == here would miss it.
      assert.strictEqual(
        sameAppUserIdentity(account({ displayName: null }), account()),
        false
      );
      assert.strictEqual(
        sameAppUserIdentity(account({ email: null }), account({ email: null })),
        true,
        "both absent is still the same person"
      );
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
