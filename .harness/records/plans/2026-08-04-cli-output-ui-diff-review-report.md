# Interactive CLI output diff review

**Verdict:** `fail`

Target: working tree `feat/cli-interactive-output` over `main` at `30ce410a95c695a31fb9d6cd8271e2c5f84c4e1d`

Review shape: one read-only adversarial pass, no sub-reviewers, no evidence reruns. The candidate is entirely uncommitted; `tests/v05/interactive-output.test.ts` is untracked and was read directly. `src/engine/report.ts` was reviewed through `git diff --text main -- src/engine/report.ts` because its pre-existing raw NUL separators make normal diff statistics unusable.

Five blocking findings stand.

### F-001

Severity: `blocking`, rank 1

Actionability: `required_fix`

Finding: The compact interactive summary renders a warning-only report as a red failure.

Trigger: A bare `asb` preview contains one `left-behind` entry and no exit-failing outcome. `buildReport` correctly returns exit code 0, but `renderCompactStatus` counts every `FAILING_OUTCOMES` entry as `failing`; `renderCompactScreen` then emits `✗ 1 needs attention` in red.

Impact: The terminal says the run failed while the process exits successfully. This breaks the frozen glyph contract that reserves `⚠` for non-failing `left-behind` warnings and `✗` for exit-failing outcomes.

Anchor: `src/engine/report.ts:194`, `src/engine/report.ts:694`

Violated contract: alignment lines 110-119 and 125; `left-behind` is deliberately absent from `EXIT_FAILURE_OUTCOMES` at `src/engine/report.ts:65`.

Minimal fix: In the interactive compact branch, distinguish exit-failing entries from warnings and render warning-only attention with `⚠`/yellow. Add the existing `LEFT_BEHIND` fixture to the compact-summary assertions.

### F-002

Severity: `blocking`, rank 2

Actionability: `required_fix`

Finding: The clean fast path treats every quiet report as app components in sync, drops skipped counts, and counts skipped probe apps as synchronized apps.

Trigger: Run `asb status --type plugins` in a TTY with one resolved configured source and one or more unselected plugins. `planCatalogStatus` emits `app: null` `unchanged`/`skipped` rows. Because neither outcome is an action or attention item, `statusScreen` enters `cleanLine`, which reports `1 component in sync across 0 apps` and omits every skipped row. Likewise, a clean `status --all` includes `app-not-installed`/`app-lacks-type` skipped probes in the app set, so apps that were never synchronized inflate `across N apps`.

Impact: Supported status filters produce a factually impossible success sentence and conceal the quiet-state counts the contract says must remain visible.

Anchor: `src/engine/report.ts:488`, `src/engine/report.ts:635`

Reachability: `src/engine/plan.ts:218`, `src/engine/plan.ts:232`, `src/engine/plan.ts:277`

Violated contract: alignment line 126 and parent adjudication 1 require `skipped` to remain a count; the one-line success mockup describes actual unchanged app components, not catalog rows or app probes.

Minimal fix: Use the one-line fast path only when every row is an unchanged app component. Otherwise render a quiet-state tally, and derive the app count only from unchanged rows with a non-null app. Add plugin-only and skipped-only status fixtures.

### F-003

Severity: `blocking`, rank 3

Actionability: `required_fix`

Finding: `status` duplicates the count named by its fallback verdict when there are no pending actions.

Trigger: A TTY `asb status` has no action rows but has an exit-1 problem, for example a selected component missing from the library while every existing target is unchanged. `statusScreen` adds `N problems` to its tally, then selects `verdict(report, ink)` because `actions.length === 0`, producing `✗ finished with N problems` on the next line. A warning-only exit-0 report similarly prints `N warnings` and then `✓ finished with N warnings`.

Impact: The count appears twice, contrary to the binding tally/verdict split. The exact no-pending fallback path in parent adjudication 3 is therefore not implemented.

Anchor: `src/engine/report.ts:664`, `src/engine/report.ts:672`

Violated contract: parent adjudications 1 and 3.

Minimal fix: When the status footer is a verdict, omit exactly the count that verdict names, using the same exit-code split as `runTally`. Add no-action exit-1 and warning-only status assertions.

### F-004

Severity: `blocking`, rank 4

Actionability: `required_fix`

Finding: A clean global/profile `status` loses the required `last sync` timestamp.

Trigger: A previous real global run exists and the next TTY `asb status` finds only unchanged entries. `runSync` attaches `previousLastRun`, but `statusScreen` returns `cleanLine` before calling the only header path that renders `lastSync`; `cleanLine` has no timestamp segment.

Impact: The common fully-synchronized status screen omits the machine fact explicitly assigned to the status title. The current test misses the bug because its clean status fixture has no `lastRun`.

Anchor: `src/engine/report.ts:635`

Reachability: `src/engine/cli.ts:1009`

Violated contract: alignment lines 18, 57-60, and 122.

Minimal fix: Include the non-project `lastSync(report)` segment in the clean status line. Add a clean status fixture with `lastRun`, plus the existing project-scope negative case.

### F-005

Severity: `blocking`, rank 5

Actionability: `required_fix`

Finding: The interactive dedup key omits `type` even though the attention headline renders the first entry's type for the whole group.

Trigger: A plugin declares the same unreadable custom path for `commands` and `agents`. The library scanner emits two failed components with the same app, id, path, outcome, detail, and filesystem error but different types; `planRules` carries both into the report. `rowKey` merges them, `subjectList` prints the same id twice, and `attentionHeadline` labels both with whichever type came first.

Impact: One failure is misclassified and its real component type disappears from the interactive report. The NUL separator itself is correct; the missing rendered discriminator is the fault.

Anchor: `src/engine/report.ts:437`

Reachability: `src/engine/library.ts:580`, `src/engine/plan.ts:557`

Minimal fix: Add `entry.type ?? ''` to `rowKey`. Add a two-type identical-error fixture that must render as two correctly typed attention groups.

## What held up

- Plain rendering remains byte-identical by construction for every report shape: `renderReport`, `renderCompactStatus`, and `renderExplain` enter the unchanged legacy bodies whenever layout is `plain` or options are absent. The pre-existing raw-NUL grouping key at `src/engine/report.ts:175` is unchanged. No old test file or assertion was modified.
- `--json` bypasses all renderers, and the CLI still returns `report.exitCode`; help/version parsing and stderr error rendering stay outside the new surface branch.
- `surface()` is the single layout/color decision. `stdout.isTTY` controls layout; a non-empty `NO_COLOR` disables color before `chalk.level`, so it wins over `FORCE_COLOR` as adjudicated.
- Credential redaction still precedes report rendering for both reports and explain slices. Null `app`/`path`, absent `detail`, verb fallback, and the `(+N more)` arithmetic do not crash or drop the unfamiliar detail text.
- The new tests pin every fenced mockup they instantiate and color stripping is not tautological. They do not cover the five trigger shapes above. Existing PTY/parity artifacts corroborate the covered routes only; their A-side records `main` at `81e99fc`, not this review's declared `30ce410` base, so the source comparison is the authority for base attribution.
