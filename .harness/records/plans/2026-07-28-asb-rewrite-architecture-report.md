# ASB CLI Rewrite: Architecture Report

Baseline: repo `agent-switchboard` @ `3ddd91b` (v0.4.34), 106 TS files, 20,832 src LOC, 38 test files / 16,015 test LOC.
Evidence corpus: `.harness/runtime/rewrite-understand/{reports.json,digest.txt}` (ten-subsystem parallel read, 2026-07-28).
Note: npm has v0.4.35 (published 2026-07-26) that is absent from this repo and its remote; it lives unpushed on the peer machine.

## What the product is

One library (`~/.asb`: mcp.json, rules/, commands/, agents/, skills/, hooks/, plugins/) plus three TOML config layers
(user, profile, project), distributed into the native config locations of 8 AI-agent applications. The entire product is
one function: `desired state → files in other tools' config dirs, safely repeatable`.

## Verdict

The pain is structural, not incidental. Every subsystem hand-rolls the same pipeline (discover → select → render →
write-if-changed → track → clean up) with its own signatures, status enums, error policy, and cleanup semantics, and
ownership of written files is re-derived ad hoc at every site instead of recorded once. A slim-down was already tried:
the 2026-07-18 "lean release" capsule set LOC budgets, was dropped, and its budgets were blown within two releases —
dieting fails because the shape forces duplication back. The fix is one reconciliation engine over data-driven
descriptors, not more deletion inside the current shape.

## Diseases (with evidence)

1. **The 6×8 matrix is hand-rolled per cell.** The distribution pipeline exists 5-7 times (`rules/`, `skills/`,
   `subagents/`, `commands/` via `library/distribute.ts` vs `distribute-bundle.ts`, `mcp/`, `hooks/` twice), with
   divergent semantics for the same case: a stale enabled id aborts the whole sync for rules (`rules/composer.ts:66`)
   but is silently ignored for skills; deactivating an app cleans up skills and subagents but strands its rules file.
   Targets are duplicated across two layers: every `targets/builtin/*.ts` MCP handler is a 4-line passthrough onto a
   parallel `src/agents/*.ts` class instantiated exactly once. `src/index.ts` holds six near-identical copies of the
   select-then-distribute body and five copies of list rendering.
2. **Ownership is inferred, not recorded.** Six mechanisms answer "did ASB write this?": hook command-string regexes
   (`hooks/ownership.ts`), project manifests, `# managed-by: asb` markers, `asb-rules` filename prefixes and block
   delimiters, clone provenance markers, and cache-ownership predicates (six overlapping ones in `library/sources.ts`
   alone). History shows the cost: 92 fix commits vs 20 features; hooks distribution touched 33 times; v0.4.33→34 is an
   eight-commit cache-ownership saga; a six-commit oscillation on one day (2026-07-18) re-litigated hook ownership.
3. **No plan/apply separation.** Decisions and IO interleave everywhere: MCP dry-run predicts writes the real run
   skips (`mcp/distribution.ts:220-223`); spinner callbacks are stored inside the write-plan
   (`mcp/distribution.ts:91-102`); cleanup-before-state-persist ordering is load-bearing and invisible (commit
   3b1d4ff patched exactly that class of bug). Change detection is implemented five different ways.
4. **Config is an ambient IO hub, not a value.** Layers are re-read and re-parsed from disk dozens of times per
   command; the effective-vs-writable scope rule is copy-pasted eight times; every section schema is declared twice
   (base + defaulted); `.passthrough()` everywhere means a typo like `enabld` is silently accepted while per-app
   override tables are never validated at all; whole-file TOML rewrite destroys user comments that carry curation notes.
5. **Dead and speculative surface.** Targets DSL: 563 src + 661 test lines, zero users (no `[targets.*]` in any real
   config). GitHub-Copilot hook-format detection: 105 lines gating a `continue`. agentSync hashing: ~120 lines computed
   on every sync, persisted nowhere. `TargetHooksHandler` unreachable; `resolveTargetDir` implemented 8×, called 0×;
   Claude project/local native-plugin scope unreachable; dozens of exported-but-unreferenced schemas and types.
6. **God files and hidden globals.** `index.ts` 2,249 lines (24 inlined command bodies plus a full hook importer);
   `sources.ts` 1,058 lines spanning five layers; module-global target registry and plugin-index caches with test-only
   reset exports; `-p/-P` flags declared on 18 commands because parent flags are silently ignored (`asb rule -P . list`
   and `asb rule list -P .` differ).

## Usage reality

| Surface | Evidence | Status |
|---|---|---|
| rules, skills, hooks | 15 / 91 / 3 library entries; live output in 3-4 targets | core, heavily used |
| plugins (local dirs + git clones) | 12 trees, 5 enabled; 4 plain clones in `~/.cache/asb` | used |
| native plugin install (claude-code) | `codex@openai-codex` verified end to end | used, works |
| MCP curation (`asb mcp`, mcp.json) | 30 curated servers | used |
| MCP distribution | `[mcp].enabled = []` in both profiles; 0 servers in any target | unused here (README headline) |
| profiles | `aws.toml` active on this machine; full-copy semantics | used |
| commands, agents content types | 0 library files, 0 enabled, 0 output (library is shared, so empty on both machines) | unused |
| project scope + manifest store | one dead `.asb.toml` (Nov 2025, references a nonexistent rule) | unused |
| trae, trae-cn, coco targets | enabled in the shared default profile (peer machine) | used on peer |
| gemini, claude-desktop targets | enabled in no profile | unused |
| coco (TRAE CLI) | registered via `~/.asb/extensions/coco.mjs` (the only extension in existence) | used on peer |
| targets DSL, `.entries` materialization, subtree sources | no config, no cache dirs | never used |
| npm | 2,607 downloads last 30 days, growing; v0.4.35 current | external users exist |

The peer machine shares `~/.asb` (config, state, library) via Mackup; both machines' installs read the same state.

## What must survive (load-bearing inventory)

- **Hook ownership recognizers** (`hooks/ownership.ts`): four regex recognizers with asymmetric ANY/EVERY semantics,
  count-bounded group removal, foreign-home tolerance, fail-closed on unreadable state. The hardest-won code in the repo.
- **Symlink discipline**: publish through symlinks without replacing them (Mackup store), dangling-link publish,
  symlink-ancestor diagnostics, cache-root symlink refusal, no-realpath readlink walk (`hooks/target-config.ts`).
- **Safety ordering**: manifest saved in `finally`; corrupt/unknown-version ledger aborts before any write; cleanup runs
  before state persist; transaction-artifact refusal; atomic staged-clone rename; dev/ino identity re-check before
  rollback deletes; native-plugin preflight before any writes; dry-run brackets caches.
- **Credential hygiene**: persisted git URLs credential-free everywhere; auth via env-injected config, never argv.
- **Per-target quirks**: Trae strips `type`; Claude project MCP at `<root>/.mcp.json`; Codex `.system` skills dir
  reserved; codex/gemini/opencode write distinct global rules files and share one `AGENTS.md` only at project scope
  (write-once + conflict detection); trae/trae-cn mutual reservation;
  Codex `# managed-by: asb` marker discipline; Codex trust_level preserved when explicitly non-trusted; `${HOOK_DIR}`
  and `$HOME`-portable command rendering; block delimiters `<!-- <id>:start/end -->` byte-stable.
- **Config semantics**: array order = composition priority; project > profile > user with arrays replacing wholesale,
  `applications.enabled` included (`layered-config.ts:121-153` has no per-key exception; a profile setting it replaces
  the user list); scoped selector editing shows only that layer's explicit values; profile files are full selection
  sets, not patches; device-id hash inputs unchanged (changing them orphans manifests); legacy input formats keep
  loading (`active`→`enabled`, `[agents]`+`[subagents]`, legacy `~/.agent-switchboard` home).
- **Test assets**: behavior-first tests over real filesystems (symlinks, chmod, git repos) for hooks/sources/plugins/
  sync are the acceptance harness; the 16-line custom runner is correct — keep it.

## Target architecture

```
                 ┌────────────────────────────────────────────────┐
                 │ cli/  commander wiring, one command factory     │
                 │       per content type; one render module       │
                 └────────────────┬───────────────────────────────┘
                                  ▼
  config/  resolveEnv() + loadConfig() once → { env, layers, effective, writable }
                                  ▼
  catalog/ library dirs + plugins (one scanner, full entries, memoized load)
                                  ▼
        ┌─────────────────────────────────────────────────────────┐
        │ engine/                                                  │
        │  resolve  (pure)  Desired[] {section,target,path,kind,…} │
        │  plan     (pure)  diff vs ledger+disk → Action[]         │
        │  apply    (IO)    atomic writes, 3 structured mergers    │
        │  report           one renderer over Result[]             │
        └───────────┬─────────────────────────┬───────────────────┘
                    ▼                         ▼
  targets/ data rows ×9 (+~6 quirk fns)   ledger/ one ownership store
  hooks/   custom planner + recognizers   migration/ legacy readers, expiry-dated
```

- **Engine**: one `Desired → Action → Result` flow; four write kinds (`own-file`, `own-dir`, `region-in-shared-file`,
  `key-in-structured-file`); one status enum; one error policy (per-item result rows; abort only on unsafe preflight).
  Dry-run = stop after plan, so preview cannot disagree with apply.
- **Content types as descriptors** (`{section, dir, unit: file|dir, schema, compose?}`), targets as data rows
  (paths, formats, per-section dirs); genuine per-target logic is ~6 named functions, coco becomes a builtin row.
- **One ledger** for "what ASB wrote" (path + owner key + hash, device-scoped) — except hooks, whose shared
  `state/hooks/*.json` v1 files remain the live authority read and written on every run while any machine runs 0.4.x
  (the peer keeps writing them; a one-time-seeded private ledger would go stale). First 0.5 run adopts existing
  0.4-written outputs into the ledger via conventional paths + 0.4 recognizers; deletion authority always requires
  recognizer or ledger proof. Recognizer demotion to `migration/` (expiry-dated) waits until the fleet is on 0.5.
- **Config as a value**: sections declared once in a SECTIONS table; validate after merge; warn on unknown keys inside
  known sections; comment-preserving writes for the narrow mutations ASB performs (enabled arrays, source tables).
- Module budget: cli ~1.9k, config ~0.65k, engine+content ~1.7k, targets ~0.5k, hooks ~1.0k, sources/git ~0.5k,
  plugins+cache+native ~1.45k, util ~0.3k → **~8k src LOC (from 20.8k)**, with per-module shapes per the subsystem
  reports in the evidence corpus. The figure is a forecast, never a gate or an argument to keep or drop a feature.

## Scope (owner decision, 2026-07-28)

The product promise is completeness: 0.5 keeps the full documented surface — all six content types, all targets plus
coco promoted to builtin, MCP distribution, project scope with its modes and collision policies, profiles, and every
documented plugin-source form (plain clones, external-entry materialization, sparse checkout, subtree), the latter
rebuilt on the engine's single resolved-ownership model. Breadth lives as data rows, descriptors, and plan-stage
policies, never per-cell pipelines; unused-on-these-machines cells get table-driven engine tests as acceptance.

Removed (internals only): agentSync persistence (~120+, computed, never written to disk — its `rule list --json`
field and the permanently broken sync-status column are enumerated output changes), `TargetHooksHandler`,
`resolveTargetDir` ×8, Claude project/local native-plugin scope, `asb source` tombstone, unreferenced
exports/types/schemas, pre-cache clone-location migration arms (~180, expiry-dated), opencode singular-dir cleanup,
the undocumented `~/.asb/extensions/*.mjs` loader (superseded by schema-validated `[targets.<id>]` data rows, ~40
lines replacing the 563-line DSL compiler), and the 105-line Copilot validator (behavior "valid Copilot v1 files
silently ignored" survives via a shape probe).
One addition: read-only `asb status` (drift view rendered from the plan stage).
Forecast with full surface: ~10k src LOC (from 20.8k); a forecast, never a gate.

The 0.5 structure, command surface, and state model are owned by `2026-07-28-asb-rewrite-design.md` (frozen
blind from the product motivation, then reconciled with these sources as a quarry); where that document and this
report differ, the design document wins.

## Walked journeys (v0.4.35 binary, 2026-07-28)

Real-surface walk with a seeded scratch `ASB_HOME`/`ASB_AGENTS_HOME` plus read-only commands on the live home;
interactive selectors, `load` importers, git-clone plugin flows, and mutating live syncs were not walked.

- Empty home: `asb sync` prints "✓ Sync complete." with zero apps configured — success with no next-step guidance.
- Undetected enabled apps are counted as "up-to-date" with no skip reason and no `assume_installed` hint.
- Dry-run/apply divergence reproduced on the first journey: dry-run reported MCP "2 up-to-date"; the real run then
  wrote `~/.claude.json` — creating `{"mcpServers": {}}` unprompted with zero servers enabled.
- Drift is invisible: immediately after a successful sync, `rule list` renders "Agent sync status: no sync recorded"
  for all 8 targets (the dead agentSync machinery), including 6 never-enabled ones, plus hardcoded
  "unsupported agents" prose. Live machine: `sync -p aws --dry-run` shows real staleness (taskboard skill:
  `scripts/board.py` differs, `tests/` never copied) that no product surface reports as status.
- One stale enabled rule id aborts the entire sync; one malformed rule file aborts the entire sync; a typo'd config
  key (`enabld`) produces no warning anywhere.
- Scope-flag trap is worse than the source reading suggested: with a project `.asb.toml` explicitly selecting
  `enabled = []`, both `asb rule -P <dir> list` and `asb rule list -P <dir>` display the user-layer selection.
- `asb plugin list` omits the enabled-but-absent `rl-harness` plugin entirely — no missing state, no reason.
- Native plugins report "1 written (would sync)" on every dry-run against an already-installed, working plugin
  (suspected idempotence over-report; unverified).
- Good UX worth keeping: `plugin list`'s ●/○ enabled/available presentation with component counts; the malformed-file
  parse error message quality; per-file written/created lines during sync.

## Risks

- v0.4.35 exists only on the peer machine; rewriting from 0.4.34 forfeits a release of fixes. Baseline must be
  reconciled first.
- Transition window: peer runs 0.4.x against the shared `~/.asb` while this machine runs the rewrite. Shared state
  (config.toml, state/hooks/*.json, library) must stay readable by both; device-scoped state is free to change.
- `--json` output shapes are inconsistent today (`activeOrder` vs `enabled`, `snippets` vs `entries`); unifying is a
  visible break for scripts and needs a changelog entry.
