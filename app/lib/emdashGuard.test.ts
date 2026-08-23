// The guard so an em-dash doesn't creep back into user-facing text. Walks
// every non-test .ts/.tsx source file, strips code comments, and fails if an
// em-dash (—) or en-dash-as-punctuation (–) survives anywhere OUTSIDE the
// small, explicit, commented ALLOWLIST below.
//
// The allowlist exists because three genuinely legitimate kinds of dash live
// in this codebase on purpose, and none of them is "user-facing prose":
//   1. The three LLM system prompts (PLANNER_SYSTEM_PROMPT, REFINE_SYSTEM,
//      selectVenues' SYSTEM_PROMPT) — their own tuned wording is explicitly
//      NOT to be rewritten; the safety net is the sanitizer + the added
//      "don't use a dash" instruction, not scrubbing the prompt's prose.
//   2. Two regex literals that recognize a dash typed by a USER or supplied
//      by a PROVIDER as an hours/leading-separator character — structural
//      parsing, not authored text.
//   3. A handful of developer-facing log/error strings (console.*, thrown
//      Error text) that never reach the UI.
//   4. En-dashes used for their OWN correct job, a numeric time RANGE
//      ("7:00 PM – 9:00 PM") — not an em-dash's job, so not in scope.
//
// Anything else — a button label, a banner, a reason string, a placeholder,
// an aria-label — must be dash-free. Run with:
//   npx tsx app/lib/emdashGuard.test.ts
import assert from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const APP_ROOT = join(__dirname, "..");

const EM = "\u2014"; // —
const EN = "\u2013"; // –

/** The three system-prompt template literals, exempted WHOLESALE between
 *  their declaration and the next unescaped backtick — everything else in
 *  each of these files is still checked line by line. */
const PROMPT_CONSTS: Array<{ file: string; declares: string }> = [
  { file: "api/parse/planner.ts", declares: "export const PLANNER_SYSTEM_PROMPT = `" },
  { file: "api/itinerary/swap.ts", declares: "export const REFINE_SYSTEM = `" },
  { file: "api/select/selectVenues.ts", declares: "const SYSTEM_PROMPT = `" },
];

/** One-off legitimate lines, matched by a distinctive substring so an
 *  unrelated edit nearby doesn't break the match. Each is a dash that is
 *  parsing logic, a developer-only diagnostic, or a correct en-dash range —
 *  never something a user reads as a sentence. */
/** Whole files exempted entirely, because dash CHARACTERS are their subject
 *  matter rather than incidental punctuation -- allowlisting individual
 *  lines would just chase the sanitizer's own implementation around the
 *  file. */
const FILE_ALLOWLIST: string[] = [
  "lib/sanitizeProse.ts", // the code that recognizes/rewrites the dash IS this file
];

const LINE_ALLOWLIST: Array<{ file: string; contains: string; why: string }> = [
  {
    file: "api/_mock/fixtures.ts",
    contains: "(?:-|\u2013|\u2014|to|until|till)",
    why: "hours-range regex — recognizes a dash typed in provider/fixture hour text",
  },
  {
    file: "api/parse/planner.ts",
    contains: "minutes in the past",
    why: "findPlanProblems correction-ladder message, fed back to the MODEL on retry, never shown to a user",
  },
  {
    file: "api/parse/planner.ts",
    contains: "days away",
    why: "findPlanProblems correction-ladder message, fed back to the MODEL on retry, never shown to a user",
  },
  {
    file: "api/select/selectVenues.ts",
    contains: "is already used by an earlier slot",
    why: "findProblems correction-ladder message, fed back to the MODEL on retry, never shown to a user",
  },
  {
    file: "lib/transitBubbles.ts",
    contains: "LEADING_SEPARATORS = /^[\\s\\-",
    why: "strips a leading separator (incl. a provider-published dash) off a transit line name",
  },
  {
    file: "page.tsx",
    contains: '[survey-gate] identity changed',
    why: "console.log diagnostic — never rendered",
  },
  {
    file: "lib/useAuth.ts",
    contains: "[auth] ${stage} failed",
    why: "console diagnostic — never rendered",
  },
  {
    file: "api/_shared/caller.ts",
    contains: "An ID token was sent but FIREBASE_ADMIN_* credentials are unset",
    why: "logEvent detail for a deploy-config problem — never reaches a user",
  },
  {
    file: "api/itinerary/store.ts",
    contains: "Set KV_REST_API_URL + KV_REST_API_TOKEN",
    why: "thrown Error text for a deploy-config problem — never reaches a user",
  },
  {
    file: "lib/historyView.ts",
    contains: "${timeOnly(start, timeZone)} \u2013 ${timeOnly(end, timeZone)}",
    why: "en-dash doing an en-dash's actual job: a time RANGE, not em-dash punctuation",
  },
  {
    file: "lib/timeLabels.ts",
    contains: "${timeOnly(toDate(startInput), timeZone)} \u2013 ",
    why: "en-dash doing an en-dash's actual job: a time RANGE, not em-dash punctuation",
  },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/** Column ranges on this line that are comment (// to EOL, or inside a
 *  /* ... *\/ that may have opened on an earlier line / may close later).
 *  Mirrors the sweep script used to scope this whole fix, ported faithfully
 *  rather than re-derived, so both agree on what counts as "code". */
function commentRanges(
  line: string,
  blockOpenAtStart: boolean
): { ranges: Array<[number, number]>; blockOpenAtEnd: boolean } {
  const ranges: Array<[number, number]> = [];
  let inBlock = blockOpenAtStart;
  let quote: string | null = null;
  let blockStart = inBlock ? 0 : -1;
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (inBlock) {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        ranges.push([blockStart, n]);
        return { ranges, blockOpenAtEnd: true };
      }
      ranges.push([blockStart, end + 2]);
      inBlock = false;
      i = end + 2;
      continue;
    }
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && i + 1 < n) {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (line.slice(i, i + 2) === "/*") {
      inBlock = true;
      blockStart = i;
      i += 2;
      continue;
    }
    if (line.slice(i, i + 2) === "//") {
      ranges.push([i, n]);
      return { ranges, blockOpenAtEnd: false };
    }
    i += 1;
  }
  return { ranges, blockOpenAtEnd: false };
}

function inAnyRange(col: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => col >= s && col < e);
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function findDashHits(absPath: string, relPath: string): Hit[] {
  if (FILE_ALLOWLIST.includes(relPath)) return [];
  const text = readFileSync(absPath, "utf-8");
  const lines = text.split("\n");

  // Exempt the prompt-const body wholesale: from the declaration line's
  // opening backtick to the next unescaped backtick (these three prompts
  // contain no embedded backtick, verified by inspection).
  const declares = PROMPT_CONSTS.find((p) => p.file === relPath)?.declares;

  let inBlock = false;
  const hits: Hit[] = [];
  let inPromptBody = false;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    if (declares && !inPromptBody && line.includes(declares)) {
      inPromptBody = true;
      // does the SAME line also close it (a one-line prompt — none here, but
      // handle it rather than assume)?
      const afterOpen = line.indexOf(declares) + declares.length;
      const closeOnSameLine = line.indexOf("`", afterOpen);
      if (closeOnSameLine !== -1) inPromptBody = false;
      return;
    }
    if (inPromptBody) {
      if (line.includes("`")) inPromptBody = false;
      return;
    }

    const { ranges, blockOpenAtEnd } = commentRanges(line, inBlock);
    inBlock = blockOpenAtEnd;

    for (const target of [EM, EN]) {
      let from = 0;
      for (;;) {
        const col = line.indexOf(target, from);
        if (col === -1) break;
        from = col + 1;
        if (inAnyRange(col, ranges)) continue;
        const allowed = LINE_ALLOWLIST.some(
          (entry) => entry.file === relPath && line.includes(entry.contains)
        );
        if (allowed) continue;
        hits.push({ file: relPath, line: lineNo, text: line.trim() });
      }
    }
  });

  return hits;
}

const cases: Array<[string, () => void]> = [
  [
    "no em-dash or en-dash-as-punctuation survives outside the explicit allowlist",
    () => {
      const files = listSourceFiles(APP_ROOT);
      const allHits: Hit[] = [];
      for (const abs of files) {
        const rel = relative(APP_ROOT, abs).split("\\").join("/");
        allHits.push(...findDashHits(abs, rel));
      }
      if (allHits.length > 0) {
        const report = allHits
          .map((h) => `  ${h.file}:${h.line}: ${h.text}`)
          .join("\n");
        assert.fail(
          `${allHits.length} unexpected dash(es) found outside the allowlist:\n${report}\n\n` +
            `If this is a NEW legitimate case (a prompt, a regex, a dev-only log, an en-dash ` +
            `range), add it to LINE_ALLOWLIST or PROMPT_CONSTS with a reason. Otherwise it is ` +
            `user-facing text that needs the same comma/restructure treatment as everything else.`
        );
      }
    },
  ],
  [
    "the allowlist itself still matches something (a stale entry would hide a real regression)",
    () => {
      // Sanity check on the checker: every LINE_ALLOWLIST entry's file must
      // still exist and still contain the marker it claims to exempt, or the
      // allowlist is silently protecting nothing (and the guard above would
      // never have been testing that line in the first place).
      for (const entry of LINE_ALLOWLIST) {
        const abs = join(APP_ROOT, entry.file);
        const text = readFileSync(abs, "utf-8");
        assert.ok(
          text.includes(entry.contains),
          `allowlist entry for ${entry.file} no longer matches anything ("${entry.contains}") — remove it or update the marker`
        );
      }
      for (const entry of PROMPT_CONSTS) {
        const abs = join(APP_ROOT, entry.file);
        const text = readFileSync(abs, "utf-8");
        assert.ok(
          text.includes(entry.declares),
          `prompt exemption for ${entry.file} no longer matches ("${entry.declares}") — the const was renamed or moved`
        );
      }
      for (const relPath of FILE_ALLOWLIST) {
        const abs = join(APP_ROOT, relPath);
        assert.ok(
          existsSync(abs),
          `whole-file exemption "${relPath}" no longer exists — remove it from FILE_ALLOWLIST`
        );
      }
    },
  ],
  [
    "listSourceFiles finds real production files and excludes test files",
    () => {
      const files = listSourceFiles(APP_ROOT).map((f) => relative(APP_ROOT, f));
      assert.ok(files.some((f) => f.endsWith("page.tsx")));
      assert.ok(!files.some((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx")));
    },
  ],
];

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
})();
