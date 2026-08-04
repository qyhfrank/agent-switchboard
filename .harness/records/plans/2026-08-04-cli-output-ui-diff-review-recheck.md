# Interactive CLI output targeted post-fix recheck

Target: `7c61b0f2017e983acef2d87d9a139a5ff071136c` on `feat/cli-interactive-output`

Base: `30ce410a95c695a31fb9d6cd8271e2c5f84c4e1d`

Scope: only F-001 through F-005 from the prior diff review, their binding adjudications 6-10, their reproduction assertions, and the two named invariants. No whole-change review and no test rerun.

## F-001: resolved

`renderCompactStatus` retains the total attention count, while `renderCompactScreen` now derives the displayed severity from `count(report, 'failing')`. A warning-only report therefore uses yellow `⚠`; any exit-failing entry promotes the same total attention count to red `✗`, exactly as adjudication 6 requires.

Evidence: `src/engine/report.ts:194`, `src/engine/report.ts:695`, `tests/v05/interactive-output.test.ts:370`.

## F-002: resolved

`allInSync` returns true only when every row is `unchanged` and has a non-null app. Both `runScreen` and `statusScreen` use it before entering `cleanLine`. Catalog rows, skipped rows, and skipped app probes therefore take the short header/tally/verdict path, preserving `N in sync` and `N skipped` without counting probe apps as synchronized apps. The short status path inserts exactly one blank line before the tally.

Evidence: `src/engine/report.ts:492`, `src/engine/report.ts:596`, `src/engine/report.ts:639`, `tests/v05/interactive-output.test.ts:380`.

## F-003: resolved

`statusScreen` records the footer's spoken exit code only when there are no pending actions. It omits warnings for an exit-0 verdict, omits problems for an exit-1 verdict, keeps both for exit 2, and keeps the full state tally when the footer is the next action. The original duplicate-count scenarios no longer survive.

Evidence: `src/engine/report.ts:666`, `tests/v05/interactive-output.test.ts:427`.

## F-004: resolved

`cleanLine` now builds its title through `header` and enables `lastSync` only for `status`. The order is scope, last sync, component summary. `lastSync` still suppresses the stamp at project scope, and the sync clean line still omits it.

Evidence: `src/engine/report.ts:473`, `src/engine/report.ts:497`, `tests/v05/interactive-output.test.ts:459`.

## F-005: resolved

`rowKey` now includes `entry.type ?? ''` between app and outcome, so entries whose attention headlines differ by type cannot fold together. The two-type identical-error assertion pins two separately typed rows.

Evidence: `src/engine/report.ts:435`, `tests/v05/interactive-output.test.ts:478`.

## Named invariants

The legacy non-interactive branch of `renderCompactStatus` remains byte-identical to the base. The predicate expressions, branch order, and four returned strings match `30ce410`; the only changes before that branch are the optional render options, the interactive early return, and the local rename from `failing` to the equal-valued `attention`.

`git show --stat 7c61b0f` and `git diff-tree --no-commit-id --name-status -r 7c61b0f -- tests` show only `A tests/v05/interactive-output.test.ts`; no pre-existing test file was touched.

Trusted machine evidence: `pnpm check` passed with 566 tests. It was not rerun during this targeted source recheck.

Overall verdict: pass
