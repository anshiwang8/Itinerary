// The safety net under the "no em-dashes" prompt instruction (planner.ts's
// PLANNER_SYSTEM_PROMPT, selectVenues.ts's SYSTEM_PROMPT, swap.ts's
// REFINE_SYSTEM). An instruction alone does not reliably stop a model
// reaching for one — so every PROSE field a model authors is routed through
// this before it is stored or displayed: a venue's "why here" reason
// (selectVenues.ts), a clarifying question and its options, and a plan's
// time-window label (both planner.ts, in coercePlan).
//
// SCOPE IS PROSE ONLY. Never route an id, a category signal, a search query,
// or any other structured field through this — a "—" there might be load-
// bearing data this function has no business rewriting (the same boundary
// the keep-on-missing-data rule draws around venue fields it must not touch).
//
// Also fixes the two ways a UTF-8 em/en-dash is known to arrive corrupted
// when a byte stream is misread as a single-byte codepage before reaching
// here (CP437, CP1252) — belt-and-suspenders: nothing in this codebase's own
// request path does that misencoding today, but a provider-side hop is not
// this app's to guarantee.
const MOJIBAKE_EM_DASH = [
  "ΓÇö", // "ΓÇö" — UTF-8 em-dash bytes misread as CP437
  "â€”", // "â€”" — UTF-8 em-dash bytes misread as CP1252
];
const MOJIBAKE_EN_DASH = [
  "ΓÇô", // "ΓÇô" — UTF-8 en-dash bytes misread as CP437
  "â€“", // "â€“" — UTF-8 en-dash bytes misread as CP1252
];

/**
 * Replace every em-dash/en-dash used as sentence punctuation with a comma,
 * and fix the two known mojibake corruptions first so they resolve through
 * the same rule rather than surviving as garbage. Pure; safe to call on
 * every model-authored prose field, every time, including text that already
 * has no dash at all (returned unchanged, modulo trimming).
 */
export function sanitizeModelProse(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;

  let out = text;
  for (const moji of MOJIBAKE_EM_DASH) out = out.split(moji).join("—");
  for (const moji of MOJIBAKE_EN_DASH) out = out.split(moji).join("–");

  // The dash itself, with any surrounding whitespace, becomes ", " — this is
  // the one substantive rule; everything below just cleans up the seams a
  // mechanical swap can leave.
  out = out.replace(/\s*[—–]+\s*/g, ", ");

  out = out
    // a dash that opened the string (or a sentence) left a leading ", "
    .replace(/^,\s*/, "")
    // a dash right after a sentence boundary left "PUNC, " — drop the
    // comma, keep exactly one space so the next sentence doesn't glue on
    .replace(/([.!?]),\s*/g, "$1 ")
    // a dash immediately before terminal punctuation left ", ." / ", ,"
    .replace(/,\s*([.,!?])/g, "$1")
    // whitespace before punctuation, and doubled interior spaces
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return out;
}

/** Same rule, applied to every string in an array (a question's options). */
export function sanitizeModelProseList(texts: readonly string[]): string[] {
  return texts.map(sanitizeModelProse);
}
