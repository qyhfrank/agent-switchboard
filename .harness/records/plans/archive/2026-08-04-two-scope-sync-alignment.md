---
status: delivered
owner: direct
evidence: 4f1cf5e
goal: task-1
---

# Two-scope sync with project increments Alignment

## Decisions needed

Defaults chosen (veto to change):

- `-P <dir>` keeps its spelling but stops meaning "project only": every sync runs the user phase first, then the project phase when `-P` names a root or `./.asb.toml` exists. A script that used `-P` for an isolated project pass now also reconciles the machine's user scope (CI isolates with `ASB_AGENTS_HOME`).
- Ambient cwd detection applies to the read/reconcile commands (`asb`, `sync`, `status`, `explain`); `enable`, `disable`, and `init` keep explicit targeting, so which config file an edit lands in never depends on where it runs.
- Codex project trust is written only when `-P` names the project explicitly; ambient detection plans the project phase without the trust row and the report says so.
- `.asb.toml` keeps the full layer schema and the frozen merge semantics; the increment is computed at plan time as overlay minus base. The alternative, an add-only project schema, is rejected: it forks the "profile and project share the user schema" contract and drops 0.4-compatible spellings.
- A profile replaces selection and inherits infrastructure (exact split under Design). The alternative — a profile as a full standalone machine config — was rejected: it forces every profile to copy sources, targets, and UI settings it never meant to own.

## Goal

Motivation: one `asb sync`, run inside a repository, maintains both levels at once: the machine's agent configuration from its one active selection file, and the repository's own additions from `./.asb.toml`. The repository carries only what it adds over the user level, because user-level content is already visible to every app in every directory; duplicating it in the repo double-loads it. A profile is an alternative selection file, not a patch: `-p aws` means the machine syncs from `~/.asb/aws.toml`, not from `config.toml` with edits. After the refactor the codebase reads as if this had been the design from the start.

End state: sync always reconciles user scope first, from exactly one selection file: `~/.asb/config.toml`, or `~/.asb/<name>.toml` when `-p <name>` (or `ASB_PROFILE`) is given. Selection never merges across the two: what the active file's selection sections omit is not selected. Machine infrastructure (`[plugins].sources`, `[targets]`, `[extensions]`, `[distribution]`, `[ui]`) always comes from `config.toml`, so a profile stays a selection file, never a copy of the machine setup. When `-P <dir>` is given or `./.asb.toml` exists in the invocation cwd (never found by upward search), the same run then reconciles project scope: per app and type, the increment — what the full overlay selects that the base does not — lands at project destinations. One run lock, one report grouped by scope, one combined exit code. Ownership stays derived from the library render at both scopes. README, the `asb init` scaffold, and CLI help describe the two-scope model natively.

Examples:

```
~/.asb/config.toml   [applications] enabled=["claude-code"]   [skills] enabled=["a"]
repo/.asb.toml       [applications.claude-code.skills] add=["b"]

cd repo && asb sync
→ ~/.claude/skills/a        user phase, as today
→ repo/.claude/skills/b     project phase; no repo copy of "a"
```

- `.asb.toml` `[commands] enabled = ["x"]` while the user config enables `a, b` → the repo gets only `x`; `a` and `b` stay global. A project only adds; nothing subtracts user-scope content from one repository.
- `asb sync` in a directory without `.asb.toml` → today's user-scope run, identical outcomes.
- `asb sync -P <dir>` from anywhere → the same two phases with `<dir>` as project root; with `-P` given, the cwd's own `.asb.toml` is ignored.
- `.asb.toml` enables an app the user config does not → that app's entire selection is increment and lands at project destinations.
- a repository last synced by the full-render project model → the first run removes user-level duplicates wherever the render proves them (marker regions, and dedicated rules files composed of library blocks); an edited copy fails the proof and is reported `left-behind` with exit 0 — the row is the signal, by design.
- rules → the repo `AGENTS.md` region composes only increment rules, so agent context stops double-loading what `~/.claude/CLAUDE.md` already carries.
- `[distribution.project] mode = "none"` → the project phase is skipped whole.
- a repo subdirectory → no detection; cwd only.
- `asb sync -p aws` → the user phase syncs from `~/.asb/aws.toml`. A selection section absent from it selects nothing: for every app `aws.toml` enables, content `config.toml` distributed earlier is deselected and removed where the render proves it; plain `asb sync` afterwards restores `config.toml`'s set. A profile meaning "config plus tweaks" writes its selection out in full; one enabling no applications reconciles nothing, and the report says so.
- `[plugins.sources]` in a profile or a repo's `.asb.toml` → a report row and no clone; sources live in `config.toml` only, and selections resolve against the machine's own library.
- a repo `.asb.toml` adding a component for an app cell with no project destination → a report row names the gap; nothing lands silently, nothing lands globally.

## Design

```
asb sync
  base    = ~/.asb/config.toml | ~/.asb/<name>.toml under -p    selection: one file; infrastructure: always config.toml
  overlay = base + <root>/.asb.toml       root = -P | ./.asb.toml | none
  sources → catalog → inventory → expansion        once, from base infrastructure
  phase 1   user scope      global table    wanted = selection(base)
            capture → plan → apply
  phase 2   project scope   project table   wanted = selection(overlay) − selection(base)
            capture → plan → apply          no root, or mode "none": skipped
```

- PlanInput carries the wanted set as an explicit input (a resolved per-app/type selection), and planners stop deriving it from config themselves; plan.ts's header contract "selection × inventory × table × captured fs state → actions" becomes literally true. The subtraction happens once, in the sync composition.
- The increment is a canonical-id set difference per app and type, computed after alias resolution and plugin expansion, overlay order preserved. An app absent from base contributes an empty base side. Delimiters, placement, mode, and collision read from the overlay.
- Shared project targets integrate increments per physical file: a composed rules host requires every contributing app's increment to render one body (divergence keeps the existing shared-writer conflict row); id-keyed shared directories (the Trae pair, the agents union) take the union of member increments.
- Phases run strictly in order under one held lock: capture₁ plan₁ apply₁, then capture₂ plan₂ apply₂, so the project phase's capture sees user-phase writes instead of planning from stale bytes.
- The project phase refuses a root that equals or contains the agents home: two scopes writing one physical tree would let phase 2 treat phase 1's writes as removable; refusal is a report row, not a guess.
- The user phase never loads the project layer, so a `.asb.toml` that replaces a list can never rewrite global targets, whatever directory sync runs from.
- A profile replaces selection wholesale — `[applications]`, the six component sections, `[plugins].enabled` — and inherits infrastructure (`[plugins].sources`, `[targets]`, `[extensions]`, `[distribution]`, `[ui]`) from `config.toml`. The reconciliation universe is the apps the active file enables. `asb enable`/`disable -p` already edit the profile file; `asb add`/`remove <source>` edit `config.toml`, which owns sources in every run.
- The sources phase runs from base infrastructure alone. A `[plugins.sources]` declaration in a profile or project layer is inert: reported, never cloned, never refreshed — an ambient sync touches the network and the machine cache only as far as `config.toml` already allows. Overlay selections resolve against the machine's catalog; a ref nothing resolves surfaces as the existing gap row.
- ProjectPlanPolicy records whether the root was named by `-P`; the Codex trust row plans only from an explicit root, so ambient detection cannot reach outside the repository.
- A dedicated project rules file proves ownership the way a markerless global host already does: content composed of library rule blocks is a render — current or stale — and is rewritten to the increment or removed. That proof is what cleans up the full-render files the previous model wrote; an edited copy fails it and is preserved.
- The increment model rests on the built-in table's project cells composing additively with their user-level counterparts (they all do). Custom `[targets]` declare project paths on the user's own judgment. A cell with no project destination cannot host an increment: a project-layer selection for it is reported as skipped, never silently dropped.
- Report entries carry their scope; rendering groups user rows before project rows; the exit code combines both phases. The last-run marker is written once per real run by the user phase; the project phase keeps writing no machine-local state.
- `runRemoveSource`'s unfiltered sweep inherits both phases, so removing a source also clears its slices from the named project in the same run. Project trees of other repositories remain out of reach, as today.
- Deleted by this design: the global-vs-project table switch duplicated across `runSync` and `runExplain` (one scope pipeline, called twice), the `mode === "none"` stripped-table special case (none = skip phase 2), the scope-exclusivity tests and docs, `-P` as a separate kind of run, and the three-layer merge (the only remaining merge computes the overlay: base + `.asb.toml`).

## Boundary

- Mutable: `src/engine/cli.ts`, `src/engine/config.ts`, `src/engine/plan.ts`, `src/engine/report.ts`, `src/engine/apps.ts`, `src/engine/sources.ts`, `tests/v05/**`, `scripts/smoke-baseline.mjs` and its fixtures if baseline rows shift, `README.md`, `CHANGELOG.md`.
- Frozen 0.4.35 contracts stay frozen: file locations, env overrides, every documented config key, legacy spellings. The overlay computation (base + `.asb.toml`) keeps the 0.4 merge semantics (objects deep-merge, arrays replace wholesale). Profile-as-overlay is deliberately retired — a user-stated semantic change, named as breaking in the changelog. No new config keys, no schema forks between layers.
- Ownership stays derived; no new state files or manifests, no interactive prompts in sync.
- Profiles and the project layer never mutate machine infrastructure: no clones, no refreshes, no global-path writes originate from them.
- The project phase writes nothing outside the repository except Codex trust under explicit `-P`; path containment checks keep their strictness.
- cwd detection only; no upward search, no repo-root discovery via `.git`.
- The increment only adds. No per-project mechanism to hide or remove user-scope content; do not invent one to make `enabled` replacement "fully honored" at project scope.
- A `left-behind` row is a preserved user edit, not a failure: it never flips the exit code, and no sweep is added to force it out.
- No new dependencies. The `~/.asb` asb-guide skill text is follow-up work outside this deliverable.
