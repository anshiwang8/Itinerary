// The one piece of the auth slice with real logic in it: the mapping from a
// provider payload onto the app's own user shape. Pure, offline, no SDK — the
// live popup flow is verified by hand, but THIS is checkable, so it is checked.
import assert from "node:assert";
import { toAppUser, userInitials, userLabel } from "./authUser";

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
        }),
        {
          uid: "abc123",
          displayName: "Anshi Wang",
          email: "anshi@example.com",
          photoURL: "https://lh3.googleusercontent.com/a/photo",
        }
      );
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
      });
      assert.deepStrictEqual(user, {
        uid: "u1",
        displayName: null,
        email: null,
        photoURL: null,
      });
    },
  ],
  [
    "surrounding whitespace is trimmed off every field",
    () => {
      assert.deepStrictEqual(toAppUser({ uid: "  u2  ", displayName: "  Ada L  " }), {
        uid: "u2",
        displayName: "Ada L",
        email: null,
        photoURL: null,
      });
    },
  ],
  [
    "non-string fields are dropped rather than coerced",
    () => {
      const user = toAppUser({ uid: "u3", displayName: 42, email: {}, photoURL: [] });
      assert.deepStrictEqual(user, {
        uid: "u3",
        displayName: null,
        email: null,
        photoURL: null,
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
