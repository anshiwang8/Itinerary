"use client";

// The starting location field's dropdown. Exactly one row today:
// "Use current location".
//
// WHAT IT IS NOT. It is not an address autocomplete. The field's manual
// typing path is untouched and stays the primary way in: this menu appears
// beside it, never in front of it, and a user who ignores it types an
// address exactly as they always did. That is why the input keeps its own
// focus and this component never steals it, and why nothing here filters,
// suggests, or reacts to what is being typed.
//
// WHEN THE PERMISSION PROMPT FIRES. On the ROW, never on the field.
// Focusing a text input must not raise an operating-system permission
// dialog, so opening the menu does nothing at all beyond rendering it; the
// browser is only asked once the row has been deliberately chosen.
//
// THE PATTERN IS `AccountMenu`'s, with one deliberate difference. That menu
// moves focus to its first item on open, because a menu button's whole job
// is to hand over to the menu. This one hangs off a TEXT FIELD the user may
// well be about to type into, so focus stays exactly where it is and the row
// is reached by Tab or by the down arrow. Everything else matches: role
// menu/menuitem, Escape closes and returns focus, an outside POINTERDOWN
// closes (not click, which stays open under a finger through a scroll), and
// choosing the row closes first.
//
// Palette is the app's card language, the same as `.acctmenu__pop`. No
// `--live` (nothing here is happening now) and no `--danger` (a location
// that could not be read ends nothing).
import { useCallback, useEffect, useRef } from "react";
import {
  CURRENT_LOCATION_BUSY_LABEL,
  CURRENT_LOCATION_OPTION_LABEL,
} from "./lib/currentLocation";

export default function StartLocationMenu({
  open,
  busy,
  note,
  onUseCurrentLocation,
  onClose,
  /** The field this menu belongs to, so an outside pointer or a focus move
   *  onto the input itself does not count as "outside". */
  anchorRef,
}: {
  open: boolean;
  /** The device is being asked right now. The row says so and refuses a
   *  second press rather than stacking permission requests. */
  busy: boolean;
  /** A refusal or failure to explain, or null. The row stays available
   *  underneath it, because every one of these is worth one retry. */
  note: string | null;
  onUseCurrentLocation: () => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLInputElement | null>;
}) {
  const popRef = useRef<HTMLDivElement>(null);

  const outside = useCallback(
    (target: Node | null) => {
      if (!target) return false;
      if (popRef.current?.contains(target)) return false;
      if (anchorRef.current?.contains(target)) return false;
      return true;
    },
    [anchorRef]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
      anchorRef.current?.focus();
    };
    // POINTERDOWN for the same reason AccountMenu uses it: a click-based
    // close stays open under a finger through a scroll. The input is
    // excluded so pressing back into the field does not shut the menu the
    // field just opened.
    const onPointer = (event: PointerEvent) => {
      if (outside(event.target as Node | null)) onClose();
    };
    // Tabbing away closes too. Without this the menu would sit open behind
    // the travel-mode toggle for a keyboard user.
    const onFocusIn = (event: FocusEvent) => {
      if (outside(event.target as Node | null)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, onClose, outside, anchorRef]);

  if (!open) return null;

  return (
    // THE NOTE SITS OUTSIDE `role="menu"`, deliberately. A menu may only own
    // menuitems (and groups of them); a paragraph inside one is an
    // `aria-required-children` violation, and this app's axe gate would be
    // right to fail it. So the popover is the plain box, the menu is the row
    // it contains, and the explanation is the menu's sibling, announced on
    // its own as a status.
    <div className="startmenu" ref={popRef}>
      <div role="menu" aria-label="Starting location options">
        <button
          type="button"
          role="menuitem"
          className="startmenu__item"
          disabled={busy}
          aria-busy={busy}
          onClick={onUseCurrentLocation}
        >
          <svg className="startmenu__icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" />
            <circle cx="12" cy="10" r="2.6" />
          </svg>
          <span>{busy ? CURRENT_LOCATION_BUSY_LABEL : CURRENT_LOCATION_OPTION_LABEL}</span>
        </button>
      </div>
      {note && <p className="startmenu__note">{note}</p>}
      {/* The live region is mounted with the menu and EMPTY, so the note
          lands as a CHANGE inside an existing region rather than as a
          freshly inserted one, which is the arrangement assistive tech
          actually announces reliably. Same shape as the live-tracking
          status line in page.tsx. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {note ?? ""}
      </span>
    </div>
  );
}
