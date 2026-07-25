# Code audit remediation — 2026-07-24

This is the live tracker for the 2026-07-24 full-project audit. Every finding is verified
against the current repository before implementation. Historical `DEVLOG.md` entries and the
2026-07-18 audit are evidence, not assumed current truth.

## Baseline

- Branch: `main`
- Starting commit: `6f36584ab29e9eb10d69a3556a13db9c673e3ee9`
- Starting untracked paths: `AGENTS.md` only (user-owned, relevant, preserved)
- Node: `v24.16.0`
- npm: `11.13.0`
- TypeScript: pass (`npx tsc --noEmit`)
- Production build: pass (Next.js 14.2.35)
- Unit tests: 251/251 across 18 suites
- Mock E2E: 41/41 on port 3100
- Lint: unusable; `next lint` opened an interactive configuration prompt
- Audit: failed with 2 high-severity dependency findings (Next.js and PostCSS)
- Port 3000: untouched

## Finding tracker

`SELF` in the commit column means the row was updated in the same commit as the change; exact
hashes are reconciled after the commit exists.

| Finding ID | Verified status | Root cause | Files changed | Tests added | Revert-run performed | Commit hash | Remaining manual work | Notes or deviations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | Pending verification | — | — | — | — | — | — | — |
| H2 | Confirmed — fixed | Next 14.2.35 and its bundled PostCSS/Sharp versions were covered by current high-severity advisories. | `package.json`; `package-lock.json`; `next.config.mjs`; `tsconfig.json`; `next-env.d.ts`; three dynamic itinerary routes | Existing 251 unit and 41 mock E2E tests exercised after the migration. | No | SELF | Full audit still reports dev-only transitive `brace-expansion`/`minimatch` advisories under ESLint; production audit is clean. | Upgraded to Next 16.2.11/React 19.2.8, migrated async route params, and pinned patched PostCSS/Sharp through Next-scoped overrides. |
| H3 | Pending verification | — | — | — | — | — | — | — |
| H4 | Pending verification | — | — | — | — | — | — | — |
| H5 | Pending verification | — | — | — | — | — | — | — |
| H6 | Pending verification | — | — | — | — | — | — | — |
| H7 | Pending verification | — | — | — | — | — | — | — |
| H8 | Pending verification | — | — | — | — | — | — | — |
| H9 | Pending verification | — | — | — | — | — | — | — |
| M1 | Pending verification | — | — | — | — | — | — | — |
| M2 | Pending verification | — | — | — | — | — | — | — |
| M3 | Pending verification | — | — | — | — | — | — | — |
| M4 | Pending verification | — | — | — | — | — | — | — |
| M5 | Pending verification | — | — | — | — | — | — | — |
| M6 | Pending verification | — | — | — | — | — | — | — |
| M7 | Pending verification | — | — | — | — | — | — | — |
| M8 | Confirmed — partially fixed | The module-level Maps promise permanently cached its first rejection, both map effects awaited it without a catch, and no non-Maps projection existed. | `app/ItineraryMap.tsx`; `app/lib/retryableLoader.ts`; `app/globals.css`; mock Playwright harness/docs | 3 loader unit cases; existing offline smoke now pins the accessible fallback and strip↔pin agreement | Yes — removing rejection eviction makes the recovery case fail (2/3); restored result is 3/3. | SELF | Batch G still needs invalid-key, retry-success, and remount browser scenarios alongside the shared client-fetch work. | The production component now catches failures, evicts rejected loads, offers two bounded retries, and keeps pins usable on a deterministic fallback projection. Mock E2E blocks all non-local browser requests. |
| M9 | Pending verification | — | — | — | — | — | — | — |
| M10 | Pending verification | — | — | — | — | — | — | — |
| M11 | Pending verification | — | — | — | — | — | — | — |
| M12 | Pending verification | — | — | — | — | — | — | — |
| M13 | Pending product-contract investigation | — | — | — | — | — | Define ownership/sharing semantics before user-visible enforcement. | Does not block unrelated batches. |
| M14 | Pending verification | — | — | — | — | — | — | — |
| M15 | Pending verification | — | — | — | — | — | — | — |
| M16 | Pending verification | — | — | — | — | — | — | — |
| M17 | Pending verification | — | — | — | — | — | — | — |
| M18 | Confirmed — fixed | `next lint` was interactive, `tsx` was undeclared, and unit suites had no aggregate runner. | `package.json`; `package-lock.json`; `eslint.config.mjs`; `scripts/run-unit-tests.ts`; `.gitignore`; two lint-only source cleanups | Aggregate runner executed all 251 existing unit tests; the full check also executed 41 mock E2E tests. | No | SELF | Batch J will remove the remaining 15 lint warnings and then enforce a zero-warning lint gate. | A normal clean `npm ci` succeeded, followed by lint, typecheck, unit, build, and mock E2E with exit 0. |
| L1 | Pending verification | — | — | — | — | — | — | — |
| L2 | Pending verification | — | — | — | — | — | — | — |
| L3 | Confirmed — fixed | Runtime CSS imported Fraunces and Space Grotesk from Google Fonts. | `app/layout.tsx`; `app/globals.css`; `package.json`; `package-lock.json`; mock Playwright harness/docs | The complete mock E2E suite runs with every non-local browser request blocked. | No | SELF | — | Uses OFL-1.1 `@fontsource-variable` packages served from the application bundle; the production build and hydration smoke pass. |
| D1 | Pending verification | — | — | — | — | — | — | — |
| D2 | Confirmed | Current docs still describe old test commands, dependency versions, dev controls, and provider behavior. | Pending | Command smoke checks pending | No | Pending | Final reconciliation after behavior batches. | Historical entries will not be rewritten. |
