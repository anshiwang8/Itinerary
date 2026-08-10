"use client";

// The account corner's one control: your name, and what it opens.
//
// It replaced three pills sitting side by side — History, your name, Sign out —
// which was already one too many for a corner and would have grown by one with
// every screen worth reaching from an account. A menu is the shape that stops
// counting.
//
// SIGN OUT IS SET APART, and that is the only visual rule this file really
// makes. Preferences and History open a panel you can close again; signing out
// ends the session. Putting all three in one flat list would make the
// destructive one the same weight as its neighbours and the same distance from
// the pointer, which is how somebody signs out looking for their preferences.
// It sits below a rule, in its own quieter treatment, last.
//
// A SMALL, HONEST MENU RATHER THAN A LIBRARY. `role="menu"` with
// `role="menuitem"` children is a promise about keyboard behaviour, so the
// behaviour is here: arrows move between items, Home/End jump, Escape closes
// and hands focus back to the trigger, Tab leaves, an outside pointer closes
// without stealing focus from wherever it landed, and choosing anything closes
// first. What is deliberately NOT here is a focus trap — a menu is not a
// dialog, and trapping focus in one is how a keyboard user gets stuck in a
// corner of the hero.
//
// The OPEN STATE lives in page.tsx, not here. The survey's identity re-arm has
// to be able to shut this the moment the account changes, and a state this
// component owned would be invisible to it.
//
// Palette is the account corner's own — translucent white pill, ink type, teal
// accent. Acid green (--live) is RESERVED for "happening now / just changed"
// and appears nowhere here.
import { useCallback, useEffect, useRef } from "react";

export default function AccountMenu({
  label,
  initials,
  photoURL,
  open,
  onToggle,
  onClose,
  onPreferences,
  onHistory,
  onSignOut,
}: {
  /** The display name, already resolved by `userLabel`. */
  label: string;
  /** Fallback monogram when the provider gave no avatar. */
  initials: string;
  photoURL: string | null;
  open: boolean;
  /** The trigger was pressed. The parent flips its own state. */
  onToggle: () => void;
  /** Escape, an outside pointer, Tab, or an item that has just been chosen. */
  onClose: () => void;
  onPreferences: () => void;
  onHistory: () => void;
  onSignOut: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  /** The items, read from the DOM rather than from a parallel array of refs.
   *  There are three of them in one place; a ref array would be a second list
   *  to keep in step with the markup for no gain. */
  const items = useCallback(
    () =>
      Array.from(
        popRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
      ),
    []
  );

  /** Close, and put focus back where it came from. For Escape and Tab this is
   *  the whole point; for a chosen item it is harmless — a panel opening moves
   *  focus into itself on mount, and Sign out takes the trigger off screen. */
  const closeToTrigger = useCallback(() => {
    onClose();
    triggerRef.current?.focus();
  }, [onClose]);

  // Focus lands on the first item when the menu opens. A menu that opens
  // without moving focus is a menu a keyboard user has to hunt for.
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
  }, [open, items]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeToTrigger();
    };
    // POINTERDOWN, not click: a menu that waits for mouseup stays open under
    // the finger through a scroll. The trigger is excluded because its own
    // handler toggles — closing here as well would close and reopen in one
    // press, which reads as the menu refusing to shut.
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, onClose, closeToTrigger]);

  /** Roving focus inside the menu. Wraps at both ends, which is what a menu
   *  does; Tab is a deliberate exception that LEAVES rather than cycling. */
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      onClose();
      return;
    }
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (index: number) => {
      event.preventDefault();
      list[(index + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") focus(at + 1);
    else if (event.key === "ArrowUp") focus(at - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(list.length - 1);
  };

  /** Every item does the same two things in the same order: shut the menu,
   *  then act. Closing first means the panel that opens is not layered over a
   *  menu still holding a stale `aria-expanded`. */
  const choose = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <div className="acctmenu">
      <button
        type="button"
        className="acct__who"
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        // The accessible name CONTAINS the visible label, so speaking it still
        // matches what is on screen.
        aria-label={`${label} — account menu`}
        onClick={onToggle}
        onKeyDown={(event) => {
          // Down-arrow opens and lands on the first item, the standard way
          // into a menu from its button.
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        {photoURL ? (
          // eslint-disable-next-line @next/next/no-img-element -- provider avatar on an unconfigurable remote host
          <img className="acct__avatar" src={photoURL} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="acct__initials" aria-hidden="true">
            {initials}
          </span>
        )}
        <span className="acct__name">{label}</span>
        <span className="acctmenu__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div
          className="acctmenu__pop"
          role="menu"
          aria-label="Account"
          ref={popRef}
          onKeyDown={onMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            className="acctmenu__item"
            onClick={choose(onPreferences)}
          >
            Preferences
          </button>
          <button
            type="button"
            role="menuitem"
            className="acctmenu__item"
            onClick={choose(onHistory)}
          >
            History
          </button>
          {/* Not decoration: this is the line between "opens something" and
              "ends the session". */}
          <div className="acctmenu__rule" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="acctmenu__item acctmenu__item--out"
            onClick={choose(onSignOut)}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
