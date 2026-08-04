# CLI output UI alignment adversarial review

Reviewed capsule: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md`, SHA-256 `7130159283c1f426583cbae0b4e37cfadcfa130713c7599dee971d0b73681562`.

## High severity

### F-01 Piped human output is already a compatibility surface

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:14`, reinforced by lines 25, 89, and 111.

Why it may be wrong: `--json` being the preferred machine interface does not prove that the existing text is unused. The public contract still says ASB reports the same outcome vocabulary in text and JSON at `README.md:6`, and the repository itself asserts text such as `Status:`, `Next:`, `unchanged:`, and the raw outcome names at `tests/v05/audit-final.test.ts:301`, `tests/v05/cli-surface.test.ts:123`, and `tests/v05/engine-surface.test.ts:70`. A wrapper that pipes `asb status` and matches one of those tokens breaks immediately, with no compatibility mode; a changelog entry only documents that break after the fact.

Recommended edit: restrict the redesign to the interactive layout. Replace line 14 with a decision that non-TTY output preserves the 0.5.1 human text, while a TTY receives the new layout. Treat `NO_COLOR` as a style control for the interactive layout, not as a request to switch to legacy piped text. Change line 111 so strip-ANSI equality compares colored and uncolored interactive rendering, not TTY and piped output.

### F-02 The boundary omits human-output commands that the edited call sites already cover

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:25`, together with lines 105, 115, and 116.

Why it may be wrong: `add` and `remove` flow through the same `renderReport(report)` call as `sync` and `status` at `src/engine/cli.ts:2133`; changing that renderer changes their output even though neither command has a target design. `enable`/`disable`, `import`, `init`, parse errors, runtime errors, help, and version use separate human-output paths at `src/engine/cli.ts:2022`, `src/engine/cli.ts:2039`, and `src/engine/cli.ts:2052`. The agreement therefore cannot both promise one visual language for all commands and call this a presentation-only change bounded to the listed renderer calls. The likely result is an accidental redesign of `add`/`remove` and unchanged one-off formats everywhere else.

Recommended edit: replace the “all commands” claim with the five named screens: `sync`, `status`, bare `summary`, the empty-library branch, and `explain`. Add an explicit compatibility boundary that `add`, `remove`, `enable`, `disable`, `import`, `init`, help/version, prompts, and stderr errors keep their 0.5.1 text in this slice. The implementation boundary must also require a command-specific render call so `add` and `remove` do not inherit the sync layout accidentally.

### F-03 One `(report, opts) -> string` renderer cannot serve the promised screens without a new union contract

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:105`, reinforced by lines 25 and 110.

Why it may be wrong: sync/status/add/remove use `Report`, explain uses `ExplainSlice[]` plus a target at `src/engine/report.ts:202`, the empty screen wants detected apps that are absent from `Report`, and bare summary has a deliberately compact next-action contract asserted at `tests/v05/audit-final.test.ts:294`. Passing a screen category and optional side data through one renderer replaces the existing small functions with a branching union whose invalid combinations the design does not define. The capsule also promises a hidden `summary` end state but gives it no sample.

Recommended edit: keep the existing focused pure-renderer split and add style options to each: detailed report, compact summary, and explain. Keep empty handling inside the detailed report unless its input is formally added. Share only the visual tokens. Add the bare-summary example and preserve its single-next-action contract, or explicitly defer summary redesign.

### F-04 The glyph table loses severity semantics as soon as color is absent

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:93`, specifically lines 99, 100, and 107.

Why it may be wrong: line 99 assigns the same `⚠` glyph to non-failing `left-behind` and exit-failing `conflict`/`blocked`, distinguishing them only by yellow versus red. The capsule separately promises identical words and glyphs without color. Current semantics intentionally exclude `left-behind` from exit failure at `src/engine/report.ts:65`, while `FAILING_OUTCOMES` includes it at `src/engine/report.ts:56`. A colorless report can therefore show indistinguishable warning rows for exit code 0 and exit code 1, and a report containing only `left-behind` can end in a green success verdict under a `needs attention` heading. This violates the line 23 rule that a glyph has one meaning everywhere and the final line answers whether sync succeeded.

Recommended edit: make glyphs carry severity without color. Reserve `⚠` for non-exit warnings such as `left-behind`; use `✗` for `missing`, `failed`, `blocked`, and `conflict`. Define the exit-0 warning verdict separately, for example `✓ finished with N warning(s)`, rather than treating all `FAILING_OUTCOMES` as one visual class.

### F-05 Every problem cannot have an executable fix under an unchanged report contract

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:107`.

Why it may be wrong: `ReportEntry` has `detail` and free-form `reason`, but no structured fix or command field at `src/engine/report.ts:22`. Current failures include parse errors, write errors, containment failures, collisions, unreadable content, and source failures; many require inspecting or editing a named file, not running one safe command. A renderer that synthesizes `fix:` from `detail`, path, or prose would move operational policy into presentation and can recommend the wrong action. Adding a fix field would change the data contract despite lines 105 and 116 saying it remains unchanged.

Recommended edit: delete “每条自带一条可执行 fix 命令”. Require every attention row to retain its redacted `reason`. Keep the sample's remediation as reason text for that known missing-source case. Defer a separate `fix` row until the engine produces a structured, source-verified action.

### F-06 The proposed status tense is not represented by the current outcome mapping

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:106`, together with the status sample at lines 60 through 66.

Why it may be wrong: `status` calls the same planner with `dryRun: true` at `src/engine/cli.ts:2138`. Ordinary planned file changes remain `outcome: 'written'` with `detail: 'created'|'updated'` at `src/engine/plan.ts:537`, and the dry-run path copies those actions into the report at `src/engine/cli.ts:1005`. `pending` is used only for specific source clone/refresh previews at `src/engine/plan.ts:3313`. Mapping only `pending -> will be updated` cannot produce the sample's `CLAUDE.md will be updated`, and mapping `written+updated -> updated` would falsely use past tense in status.

Recommended edit: define display mapping as a function of screen plus outcome and detail. At minimum, specify `sync + written/created -> created`, `sync + written/updated -> updated`, `status + written/created -> will be created`, `status + written/updated -> will be updated`, and source `pending/clone|refresh -> will clone|refresh`. Define the `pending` section as “actions this preview would apply”, not as rows whose Outcome literally equals `pending`.

### F-07 The explain example does not specify the data it promises to preserve

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:69`, specifically lines 69 through 76.

Why it may be wrong: the text promises to retain owner, current, desired, components, sources, and desired content, but the only example shows none of those fields. Current explain output renders all of them and supports multiple slices plus a desired-content block at `src/engine/report.ts:207`. It also has a no-match branch at `src/engine/report.ts:203`. An implementation can match the sample while silently dropping the actual explain contract, or invent incompatible layouts for multi-slice and multiline content.

Recommended edit: add one complete successful example containing every existing field, multiple slices, and desired content, plus the no-match example. State that desired content remains byte-preserving payload below a stable delimiter and is not wrapped or styled internally. If that example cannot be frozen now, remove `explain` from the slice instead of leaving its design implicit.

## Medium severity

### F-08 “Last run” is global machine state, not necessarily the status scope being shown

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:17`, together with lines 55 through 58.

Why it may be wrong: `runSync` loads one machine-global `last-run.json` before planning at `src/engine/cli.ts:823`; project runs explicitly do not write it at `src/engine/cli.ts:1013`, but project dry runs still attach it to the report at `src/engine/cli.ts:1005`. Showing `last run 21h ago` on `asb status -P <repo>` therefore implies a project-scoped fact that the state does not record. Relative time also adds clock-dependent rendering and undefined behavior for future or malformed timestamps without improving the sync report itself.

Recommended edit: keep last-run off sync, but show it only when `report.scope.project === null`, label it `last global sync`, and render the stored timestamp in a deterministic absolute form for this slice. Omit it for project status. Defer relative-time formatting until a clock input and boundary cases are specified.

### F-09 The color decision bypasses the conventions already handled by the installed dependency

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:105`.

Why it may be wrong: `stdout.isTTY && !NO_COLOR` does not define presence versus value for `NO_COLOR`, ignores `FORCE_COLOR=0|1|2|3`, and ignores `TERM=dumb`, CI detection, and Windows terminal capability. An empty `NO_COLOR` value is falsey under the literal expression; `FORCE_COLOR=0` on a TTY still selects pretty mode; positive `FORCE_COLOR` in a pipe is ignored. Chalk is already installed at `package.json:52`, and its support detector handles `FORCE_COLOR`, TTY, CI, `TERM`, and Windows at `node_modules/chalk/source/vendor/supports-color/index.js:33` and line 60.

Recommended edit: split layout selection from color capability. Use TTY only to select the interactive layout, then use Chalk's stdout support result for ANSI capability. Define that `FORCE_COLOR` follows Chalk precedence; otherwise the presence of `NO_COLOR`, including an empty value, disables ANSI. Add these environment cases to the design table instead of the single `pretty` boolean formula.

### F-10 Unicode glyphs in piped output are an unnecessary compatibility bet

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:15`, reinforced by lines 25 and 89.

Why it may be wrong: examples from Vite or pnpm do not establish the encoding of every ASB consumer. The repository smoke environment explicitly forces `LANG=C.UTF-8` at `scripts/smoke-baseline.mjs:170`, which avoids testing `LANG=C`, legacy Windows code pages, and log collectors that do not preserve UTF-8. In those environments the only severity marker can become mojibake or a replacement box. The glyphs add no value to a non-interactive stream that already has stable outcome words.

Recommended edit: keep Unicode glyphs in the interactive layout only. Preserve ASCII outcome words in non-TTY output. If the product intentionally requires UTF-8 everywhere, state that as a runtime requirement and add a Windows and non-UTF log acceptance gate instead of relying on analogy.

### F-11 Width-aware wrapping is an underspecified feature, not defensive rendering

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:109`, together with the `width` option at line 105.

Why it may be wrong: “id and path remain one token”, “wrap to terminal width”, and “never truncate” cannot all hold when one id or path is wider than the terminal. Correct display width also depends on ANSI sequences, combining characters, and ambiguous-width Unicode glyphs. The capsule defines neither a minimum width nor overflow behavior, so tests would turn whichever first implementation appears into a promised layout. This work is not needed to make the output hierarchical and readable.

Recommended edit: remove `width` from the first renderer contract and delete custom wrapping from the design. Emit indentation and full unbroken tokens, then let the terminal perform natural wrapping. Add width-aware layout only after a concrete broken journey establishes the width floor and overflow rule.

### F-12 The empty-screen app list is new discovery behavior hidden inside a presentation task

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:110`, together with the sample at lines 78 through 87.

Why it may be wrong: the ordinary planner detects all apps only when `allApps` is true at `src/engine/cli.ts:159`; otherwise it probes configured enabled apps at line 162. An empty selection therefore does not already carry the promised `apps found` list. Computing it in `cli.ts` adds a second filesystem scan and new behavior outside the unchanged `Report` contract, contradicting the pure-presentation boundary at line 116.

Recommended edit: delete `apps found` from this slice and keep the three quick-start commands. If detected apps materially improve the journey, make that a separate status/inventory requirement that decides which app table and project scope it scans, then expose the result as data rather than an ad hoc renderer side input.

### F-13 The validation plan misidentifies the smoke baseline and replaces the repository's assertion style

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:111`, together with lines 115 and 117.

Why it may be wrong: `scripts/smoke-baseline.mjs` captures command output only to detect nonzero exits and inspect help/version at lines 59 through 83 and 157 through 167. Its sync comparison ignores stdout and compares filesystem snapshots at lines 369 through 380, so there is no “文案基线” to update. Adding a 0.4-versus-0.5 text comparison would necessarily fail the intentional redesign and would broaden a release compatibility harness. Meanwhile the current v05 renderer tests use focused `assert.match` and `assert.equal` checks at `tests/v05/cli-surface.test.ts:98` and `tests/v05/engine-surface.test.ts:44`, not snapshot files.

Recommended edit: remove the claim that the smoke script pins old wording. Keep its filesystem comparison unchanged and require it to pass. Validate new output with table-driven exact strings and targeted invariants in existing v05 tests, including colored versus uncolored interactive parity and legacy piped compatibility. If packaged-artifact output needs proof, add one candidate-only packed-bin assertion to the existing smoke exercise rather than comparing new text with 0.4.

## Low severity

### F-14 A new theme module is an abstraction before there is a second owner

Capsule line challenged: `.harness/records/plans/2026-08-04-cli-output-ui-alignment.md:105`, together with the mutable boundary at line 115.

Why it may be wrong: all current human renderers live in `src/engine/report.ts`, and the live-progress/picker work that might share a theme is explicitly outside this slice at line 16. Moving a small token table and verb map into `theme.ts`, plus unspecified same-layer helpers, adds a public internal seam without current reuse.

Recommended edit: keep the token table and mappings private in `src/engine/report.ts`. Extract `theme.ts` only when the sibling live-progress implementation actually consumes the same stable tokens.
