---
status: frozen
scope: structure and semantics are frozen; the quarry pass fills factual parameters (exact paths, config keys, legacy schemas) and may add intents only through an explicit, recorded design update
---

# agent-switchboard 0.5 — design

## Motivation

Nine assistants read the same six ideas — rules, commands, agents, skills, hooks, MCP servers — from nine places in nine dialects, so a developer maintains nine drifting copies by hand and eventually trusts none of them. asb makes one library (`~/.asb`) the only place anything is authored or selected, and one command reconciles every installed app to it. The hard part is not the copying: it is being trustworthy while writing into directories the user also owns by hand — never writing what was not asked for, never deleting what it cannot prove it wrote, previewing exactly what it will do, and staying correct while a peer machine runs the previous major version against the same file-synced library.

## User intents

1. Make every installed app match the library (edit-then-sync, new app, retirement, MCP, project overlay, plugin content, native-plugin registration — one verb).
2. Know the truth without changing anything: what a run would do, what state each app is in, why one specific file is the way it is.
3. Choose what is active here: globally, per machine (profile), per app, per project, down to one component of a plugin.
4. Bring in someone else's content (plugin sources of four shapes, marketplaces) and take it back out.
5. Teach the tool a new app declaratively.
6. Start on a machine with pre-existing state without losing anything hand-written.
7. Pull existing hand-authored app-side content into the library (the one legitimate reverse flow besides adoption).

Peer coexistence is a constraint on every intent, not an intent. Declaring selection and sources is config the user can always edit directly; commands that edit it are conveniences over the same file.

## CLI surface

```
asb                       # compact status summary + the one next action; creates nothing
asb sync                  # reconcile every installed app to the library
    -n, --dry-run           plan and report; write nothing, clone nothing
    --update                refresh managed clones after readiness, before planning
    --no-update             suppress refresh (including plugins.auto_update); readiness still runs
    --source <name> ...     filter the whole plan to entries from named plugin sources
                            (readiness, refresh, and content actions alike)
    --app <a> ... --type <t> ...   narrow the plan (including its removals)
    -p, --profile <name>    per-machine selection set (default: ASB_PROFILE env, else global)
    -P, --project <dir>     apply that repo's project config at project scope
    --json
asb status [<id-glob>] [--all] [--app <a>]... [--type <t>]... [--json]
                          # inventory × selection × per-app reality, drift causes named
asb explain <id|path>     # one target: source, owner, recorded hash, current hash, desired content — recomputed live
asb enable <id>...  [--type <t>] [--app <a>]... [-p <name>] [-P <dir>]
asb disable <id>... [--type <t>] [--app <a>]... [-p <name>] [-P <dir>]
                          # comment-preserving edits to the owning config file
                          # `asb enable` with no ids opens the one interactive toggle picker
                          # (all types and plugin components, grouped); saving computes the
                          # enable/disable delta through the same comment-preserving splice
asb add <source> [--as <name>] [--marketplace]
                          # local dir | git URL | subtree path; writes the source declaration, clones nothing
asb remove <name>         # retire a source: removes the declaration AND splices the plugin and its
                          # components out of every selection this machine can edit (a declaration
                          # removed while selections still name it would strand a 0.4 peer into
                          # cleanup); managed cache checkouts are deleted under 0.4's deletable-
                          # checkout verdict, subtrees via git rm on a clean tree (both carried);
                          # a plain local dir loses only its declaration — if it sits under
                          # ~/.asb/plugins/ it stays presence-discovered, reported with its path
asb import <app> [path] [--type <t>] [-r] [-f]
                          # copy existing app-side files into the library (library-ward only);
                          # no --type imports every type the app supports from its default locations
asb init [--force]        # interactive project .asb.toml scaffold in the current repo
```

- Flags parse position-independently and identically across the whole chain; `asb sync --app cursor -n` ≡ `asb -n sync --app cursor`.
- `--dry-run` is a flag on `sync`, never a separate command: preview is the same load → scan → plan with the writer disabled, so preview and apply cannot diverge structurally.
- Bare names in `enable`/`disable` resolve across types; an ambiguous name errors listing the `--type`-qualified forms. The config file's per-type tables stay the unambiguous truth.
- Every command takes `--json`; the JSON carries the same per-entry records the human text is rendered from.
- Exit behavior: stdout flushed before exit, always.

## Domain and state model

Nouns: **Component** `{type, id, source, path}` with id grammar `name` | `plugin:name` | `plugin@marketplace:name`. **App**: a data row `{id, detect, reserved, targets[type]}`. **Target** `{shape, path, create, dialect}` with shape ∈ `own-file | own-dir | region | keys`. **Selection**: per-type id arrays per scope plus the whole-plugin `[plugins].enabled` list, merged global < profile < project (arrays replace wholesale) with the project mode and collision policy, then the per-app overlays exactly as 0.4's config grammar documents them — `applications.<app>.<type>.{enabled|add|remove}` and `[plugins.exclude]`. `enable`/`disable --app` edit the app overlay's `add`/`remove` arrays; a bare plugin name (no colon) enables the whole plugin via `[plugins].enabled`, a qualified id enables one component. **Action/Result**: one (component, app, target) with op, outcome, reason, hash — the atom preview lists, apply executes, report enumerates, ledger records. **Ledger entry**: proof this machine wrote a specific slice.

Where state lives:

| State | Location | Why |
|---|---|---|
| Content, selection, sources, custom apps, profiles | `~/.asb` (config + content dirs + plugins/ + mcp.json) | travels between machines |
| Predecessor's ownership records: hook state (`state/hooks/`) and per-device project manifests (`state/manifests/<device>/`) | `~/.asb` (their existing locations, their exact schemas) | compatibility contract while any peer runs 0.4.x |
| Managed clones, marketplace catalogs, external entries | the 0.4 cache root and layout, unchanged — resolved `ASB_CACHE_HOME` → `XDG_CACHE_HOME/asb` → `~/.cache/asb` | machine-local, rebuildable from config |
| Ledger, run lock, last-run record | `ASB_STATE_HOME` → `XDG_STATE_HOME/asb` → `~/.local/state/asb` | machine-local, must survive a cache wipe |
| Managed content | target files themselves; `region` delimiters double as on-disk proof | what the apps read |

Recorded because it cannot be re-derived: ownership (path, shape, owned-slice hash, key paths for `keys`, per-file lists for `own-dir`), and the last-run fact (timestamp + summary — never derived content). Everything else — inventory, desired content, drift, install state, the whole plan — is recomputed every run; there is no cache of derived state to go stale and lie.

Ownership proof, in order, and nothing else counts: (1) ledger entry whose recorded hash matches the target's current owned slice; (2) self-evident marker (asb's own region delimiters); (3) byte-identity with what asb would render right now; (4) the predecessor's ownership records in the shared library — the hooks v1 state and the per-device project manifests (`state/manifests/<device>/<slug>.json`). A peer record proves exactly what it carries: hash-bearing entries (`ManifestEntry`, `RulesManifestEntry`) prove disk bytes like the ledger; hash-less entries (`ManagedMcpEntry` records only the server key) prove key placement, so their removal additionally requires the current value to match a library render — otherwise `left-behind`. (5) Convention — a file inside a table-declared tool-owned directory whose name matches a known library or plugin component id — is the weakest evidence and is scoped: it applies at global scope only (project scope has manifests and the collision policy), it grants adoption-for-update (0.4 overwrites these files today, so updating is behavior parity, and a differing file adopts as `adopted (convention, stale)`), and it never grants deletion — deleting always requires proof 1–4. Anything else is foreign: never written, never deleted, reported with its path. Adoption probes cover every table-declared managed location against the full library inventory — selected or not — so 0.4-era leftovers surface on the first run instead of lingering silently; unprovable ones report as `left-behind: unproven` for the user to delete or `import` once.

- **Adoption** (first run, or any unrecorded target): proofs 2–5 create a ledger entry without writing the file; the outcome is `adopted` with provenance (`marker` | `identity` | `peer-record` | `convention`), and every adopting run prints the adopted paths one per line — adoption is the only operation that expands what the tool may later delete, so it is never silent. `sync -n` previews it. Provenance travels into the ledger and bounds authority: a `convention` entry authorizes updates only, and its deletion additionally requires an independent proof 2–4 or byte-identity with a render of the component being retired — otherwise `left-behind: unproven`. The restriction lifts the moment 0.5 itself writes the target (the entry becomes `written`; the bytes are then ours by fact), so a hand-written same-name file that was adopted by convention and deselected before 0.5 ever rewrote it is preserved, not deleted. Unproven occupied targets are `blocked (foreign)`.
- **Removal is authorized only by deselection.** A component disabled or gone from config produces `remove` actions for its ledger entries; a component still enabled whose source files are absent is `missing` (with the configured path) and never triggers removal. A half-arrived library sync therefore cannot cascade deletions; only a deliberate selection change can. At removal time the proof is re-checked: hash mismatch → `left-behind` with reason, file untouched.
- **Creation**: the table's `create` column governs every shape. A target file is created only when a selected component maps to it, the desired content is non-empty, and the row says `create = true` — for `keys`/`region` rows with `create = true` (the MCP roots 0.4 legitimately creates, e.g. `~/.claude.json`, `<root>/.mcp.json`, the Codex TOML) a minimal host containing only the managed slice is materialized. `skipped: host-file-absent` applies to `create = false` rows only. Zero selected MCP servers plan no MCP file anywhere, and an empty desired set never creates anything.
- **Drift** is two named facts, never one word: `user-edited` (target's owned slice ≠ recorded hash) and `stale` (recorded ≠ current render). `status` shows which side moved.
- **Conflict** is judged at slice granularity, not file granularity: two apps writing different keys into one shared structured file (trae + trae-cn server sets in one `mcp.json`) or different components into one shared directory (the `use_agents_dir` union of codex/gemini/opencode skills) are ordinary merges — each slice has one writer. `conflict` means one slice, divergent desired content: two apps rendering the same slice differently, two components claiming one `own-file` path, or a foreign file at a project-scope target. The documented project collision policy selects the branch: `warn-skip` (default) reports and leaves the target untouched; `error` aborts that project scope's apply before any project write (global sections continue — this is not one of the run-fatal aborts); `takeover` treats the path as ASB-managed and overwrites — the one documented overwrite grant, declared by the user in the project's own config, after which ownership is recorded and normal rules resume. Shared slices have exactly one writer per run, and shared-slice content is always computed from the full app set — `--app`/`--type` filters select which actions execute, never which inputs the planner sees.
- **Shapes**: `region` is for markdown-style hosts only; structured hosts — JSON, TOML, and YAML — use `keys` with recorded key paths (including keyed-array addressing, where an array element is identified by its name key, which is how the existing custom-target grammar's YAML MCP form and similar rows stay expressible) and byte-preserving round-trip of everything else. Hooks are `keys` at the file level but their owned slice is the set of groups identified content-wise by the hooks state and recognizers (0.4's deep-equal-plus-marker identification, carried), never positional array indexes. A fifth kind, `native`, covers apps with their own plugin managers: probe and apply go through the manager's reported state (0.4's preflight carried), no file ownership, so a plugin disabled behind asb's back reports stale instead of up-to-date. Each shape implements one interface — render-slice, hash-current, write, remove — so the owned slice is defined in exactly one place.
- **Write mechanics**: symlinks resolved first and written through; the temp file is created in the resolved target's own directory so rename never crosses devices; containment is re-checked at action time — a target whose resolved real path escapes the resolved root of its app's table-declared tree (a parent replaced by a symlink pointing elsewhere) is `blocked: path-escape`, never written or deleted, matching 0.4's path-escape refusal. All edits to one host file in one run are grouped into a single read-modify-write, so a retire-plus-add to the same host is one atomic replace. A write over an existing owned target additionally requires the current owned slice to equal the recorded hash: a mismatch is `conflict: modified since write`, target untouched — the update-path mirror of `left-behind` — unless the governing collision policy is `takeover`. A single `O_EXCL` lock file with a stale timeout in the state dir serializes same-machine runs; there is deliberately no cross-machine locking.
- **Peer contract**: 0.5 reads and rewrites the predecessor's ownership records — hook state and project manifests — in their exact schemas, preserving unknown fields; entries those records own are handled through them, never through the ledger alone. 0.5 adds no config keys the 0.4 parser rejects (verified against the 0.4 parser in the quarry, not assumed). All 0.5-only state is machine-local. Accepted transition-window property of the frozen v1 hook contract: group identification is content-based with no per-machine provenance, so a peer's 0.4 can mistake a byte-identical hand-written group on its own machine for a managed one — a pre-existing 0.4↔0.4 behavior that 0.5 neither introduces nor can fix while the schema is frozen.
- **Fail closed**: unreadable/corrupt ledger or predecessor records grant no deletion authority anywhere they cover; corrupt target-file transaction artifacts abort before any write.

## Module map

| Module | ~LOC | Owns | Intents |
|---|---|---|---|
| `cli.ts` | 200 | position-independent parsing, command bodies, exit codes, flush | all |
| `config.ts` | 300 | load/validate/merge the three scopes; unknown-key detection (run-fatal, with nearest-key suggestion); legacy input formats; comment-preserving byte-splice edits | 3, 5 |
| `apps.ts` | data | the app × type table: detect probe, per-type target rows (shape, path template incl. project-scope, create, dialect id, reserved ids/dirs), native-plugin rows; custom `[targets.<id>]` config validated into the same row type | 1, 5 |
| `dialects.ts` | 150 | the handful of real per-app transforms (MCP schema variants, hook binding shapes, $HOME-portable rendering), keyed from the table | 1 |
| `library.ts` | 200 | scan content dirs + plugin roots into Components; id grammar; a malformed entry becomes a failed component, never a thrown run | 1, 2 |
| `sources.ts` | 350 | resolve the four source kinds to content roots; managed-clone readiness (clone-if-missing, no implicit fetch, `--update` refresh, staged rename, legacy-path migration); marketplace catalogs + external entries | 4 |
| `plan.ts` | 300 | pure: selection × inventory × table × ledger × fs probe → Action[] with removals, conflicts, adoption classification | 1, 2, 6 |
| `shapes.ts` | 350 | the four write shapes behind one interface; atomicity, symlink-through, host-file grouping | 1 |
| `ledger.ts` | 200 | state-dir store: proofs, lock, last-run record, fail-closed | 1, 6 |
| `peer.ts` | 180 | the predecessor's ownership schemas — shared hook state and per-device project manifests — quarantined; deletable in one commit when the fleet is on 0.5 | 6 |
| `report.ts` | 200 | outcome vocabulary → human text and JSON; credential redactor on every reason string; aggregation; exit code | 2 |

Roughly 2,400 lines of code plus the table data. No dispatch layers, no per-app adapters, no source-kind class hierarchy: variation that fits a column is a column; only genuine transforms are functions.

## Flows

- **First sync, pre-existing files**: config load → source readiness (missing clones materialized first, per the frozen 0.4.35 order, so their components exist before anything plans) → library scan → plan with empty ledger → per target: proof-2–5 matches become `adopted` (paths printed), provably-ours-but-different become `written`, unproven occupied become `blocked (foreign)` (or follow the project collision policy where one governs), absent-with-create become `written`. Ledger written once, atomically, in a finally block.
- **Ordinary sync after one edit**: recompute everything; hash comparison marks all but the edited component `unchanged`; the changed renders re-prove ownership, write atomically, update the ledger.
- **Preview / status / explain**: same plan. `-n` mutates no sources ever: pending readiness reports one per-source row — `pending: clone <url> → <cache path>` — and that plugin contributes no content entries (its components are unknowable until materialization, so nothing is guessed); with `--update`, sources that would refresh likewise report `pending: refresh`, and content previews come from the current generation only. The real run performs exactly the reported readiness/refresh actions, then plans from the materialized state. `status` groups by app and adds probe results and the last-run fact. `explain` runs the planner for one target and prints source, owner, both hashes, and the desired content.
- **Enable one plugin skill**: `asb add <url>` writes the source declaration (no clone) → `asb enable pack:formatter` splices the id into the per-type table — against an unmaterialized source the id cannot be validated yet, so it is recorded with a warning saying so and validated at the next sync (where a wrong id surfaces as `missing` with its configured source) → `sync` performs readiness, plans, writes. Siblings of the enabled component never enter the plan; `asb enable pack` (bare name) enables the whole plugin instead.
- **Retire a rule**: `disable` splices it out; next sync's plan carries `remove` per ledger entry; proofs re-checked; drifted copies are `left-behind` with both hashes; exit is nonzero because something requested did not happen.
- **Peer coexistence**: 0.5 changes no shared formats; hook writes go through `peer.ts` in the 0.4 schema; a 0.4 `sync --dry-run` on the shared state after a 0.5 sync is an acceptance case.
- **One malformed entry**: the component fails with its parser message and path; every other entry plans and applies; exit nonzero. Containment is per slice: for aggregated targets (several rules composing into one block), a malformed member blocks that whole slice with `failed: aggregate-blocked (<id>: <reason>)` — the previous composed content is left in place rather than silently re-rendered without the broken member — while every other slice and type proceeds.

## Failure and reporting

Closed per-entry vocabulary, identical in human and JSON output: `written` (`created`|`updated`) · `unchanged` · `adopted` (`marker`|`identity`|`peer-record`|`convention`) · `removed` · `skipped` (`app-not-installed` + assume_installed pointer, `app-lacks-type`, `host-file-absent`, `not-selected`) · `missing` (enabled but absent, with configured path) · `blocked` (`foreign`|`path-escape`) · `left-behind` (`modified`|`unproven`) · `conflict` · `pending` (`clone`|`refresh`, dry-run only) · `failed` (`parse-error`|`render-error`|`write-error`|`aggregate-blocked`).

Aggregation is per-entry; nothing aborts the run except three pre-write conditions: invalid config (unknown key, with suggestion), readiness failure (stops before any distribution), corrupt ledger/peer state (fail closed). Human output: one line per non-clean entry grouped by app, `unchanged` as a count, a final tally; empty library says there is nothing to do and points at the quick start. JSON: `{version, scope, entries[], summary, exitCode}`. Git/stderr text passes through the credential redactor before it can become a reason string.

Exit codes: `0` — everything `written`/`unchanged`/`adopted`/`removed`/`pending` or benignly `skipped` (`pending` is an accurate preview of readiness work, not a failure); `1` — any `failed`, `blocked`, `left-behind`, `conflict`, or `missing`; `2` — the three pre-write aborts.

## Deliberately absent

- A library-init command, `doctor`, `migrate`, `plan`, `apply`, per-type command trees, and any router/index command: stages and slices of `sync`/`status`, or a text editor with extra steps. (`asb init` exists only as the project-scope scaffold; the library is created by the first `add`/`enable`/`import` that needs it.)
- `--force` on sync: every place it would act is a place ownership cannot be proven, which is exactly where writing is forbidden. The report prints the path; deleting it is one command the user already knows. (`import -f` overwrites library files the user owns anyway — a different, legitimate contract.)
- Interactive prompts inside `sync`: conflicts report and skip; runs stay scriptable. Interactivity lives only in the deliberate surfaces: the `enable` picker and `init`.
- Backups, rollback, undo, trash: provable ownership + atomic writes + the library as source of truth make them a second ownership problem, not a safety net.
- Caches or indexes of derived state; a daemon or watcher; cross-machine locking (impossible over file sync by construction); a schema-validation dependency for config (hand-rolled key-set checks give better messages); a template DSL; plugin version/semver resolution (a git ref pins better); telemetry, log frameworks; env-var expansion or secret injection in MCP values (verbatim copy keeps secrets in the environment).
- Two-way sync / writing app state back into the library: one direction, one truth. Adoption covers the only legitimate reverse flow: recognizing our own output.
- App-version awareness: the table tracks where apps read today; an app relocating its config in an upgrade is a table update shipped as an asb release, and `status` still shows the stale/foreign evidence. Accepted limitation.

## Quarry verdict

The design above was frozen blind, then the 0.4.35 sources were read as a quarry. Four real intents surfaced that the blind design missed and entered as recorded updates; everything else either carries over as material or is dropped with its reason.

### Design updates forced by the materials

1. **Import** (`asb import`, intent 7): 0.4's per-type `load` subcommands are a documented, real capability — copying existing app-side files into the library is how a user bootstraps from hand-maintained configs. One command with `--type` replaces five per-type spellings; semantics (platform default paths, `-r`, `-f` confirmation) carry over.
2. **Project bootstrap** (`asb init`): 0.4's `init` scaffolds a commented `.asb.toml` in the current repo interactively. That is the entry point of the project-scope intent, kept as-is.
3. **Discoverable selection** (`asb enable` with no ids): 0.4's six bare per-type commands open toggle pickers, and that picker is how selection is actually edited in practice (the walked journeys used it). One cross-type picker replaces six, writing through the same comment-preserving splice — including the documented reorder capability (array order is composition priority, so the picker moves entries as well as toggling them).
4. **Per-source refresh** (`sync --source`): `plugin marketplace update [name]` refreshes one source; a global-only `--update` would lose that. `--source` narrows readiness and refresh.

### Resolved parameters

- **Peer config tolerance — verified, not assumed**: every 0.4 config schema is zod `.passthrough()` (src/config/schemas.ts, 20 sites), so additive 0.5-only keys are provably invisible to the peer. (The same passthrough is why 0.4 swallows typos; 0.5's strict validation is the intentional change, with legacy input formats — `active`→`enabled`, `[agents]`+`[subagents]`, `~/.agent-switchboard` home — whitelisted. Before cut-over, 0.5 validation runs against this machine's real `config.toml` and `aws.toml` as an acceptance check.)
- **Predecessor ownership schemas** `peer.ts` preserves. Hooks: `{version: 1, events: {}, bundles: [], legacyBundles: []}` in shared per-target files (`state/hooks/claude-code.json`, `codex.json`, plus per-scope variants), written whole; 0.4's save also read-merges then deletes device-scoped legacy copies (src/hooks/state.ts:119-149), and 0.5 replicates that exactly — hooks state is never per-device-primary. Project manifests: `{version: 1, updatedAt, sections}` at `state/manifests/<device>/<slug>.json` (src/manifest/store.ts), which are per-device by the frozen device-id derivation — the first 16 hex chars of `sha256(ASB_DEVICE_ID|hostname, NUL, agentsHome)` (src/config/device-id.ts:12), with project hook-state filenames additionally carrying their 10-hex path hash (src/hooks/state.ts:37); `peer.ts` reproduces both exactly.
- **Tooling**: existing dependencies only — commander (subcommand tree; scope flags registered chain-wide and resolved once, which is the flag-position fix), zod `.strict()` with a nearest-key error mapper, @iarna/toml for reads (writes are byte-splice, never re-serialization), jsonc-parser `modify`/`applyEdits` as the JSON `keys`-shape writer, @inquirer for the picker and `init`, chalk/ora for rendering. `node:util` parseArgs rejected: it would re-implement subcommand routing to save a dependency already present.

### Carried from 0.4.35 (by origin, serving the frozen structure)

- Source lifecycle mechanics → `sources.ts`: staged-rename clone materialization, cache provenance marker, legacy-path migration, 0.4.35 readiness semantics, cache ownership verdicts (src/library/sources.ts, src/marketplace/cache.ts); tests/sources.test.ts (2,476 lines) is the acceptance floor.
- Hook state read/write and command-string recognizers → `peer.ts` and adoption proof 4 (src/hooks/state.ts); project manifest store and its collision/cleanup semantics → `peer.ts` and the plan's project policies (src/manifest/store.ts, src/library/distribute.ts).
- Block delimiters, symlink-through atomic writer, `$HOME`-portable rendering, `${HOOK_DIR}` handling → `shapes.ts`/`dialects.ts`.
- Layer merge semantics — project > profile > user, arrays replace wholesale including `applications.enabled` → `config.ts` (src/config/layered-config.ts:121).
- Native-plugin registration with preflight-before-any-write → `apps.ts` rows + apply path.
- Copilot v1 hook files inside plugins: silently-ignored behavior kept via a shape probe in `library.ts` (105-line validator shrunk).
- The app × type table's frozen values (paths, formats, frontmatter, reserved sets, trae `type` omission, `<root>/.mcp.json`, delimiters) transcribe from 0.4.35 source and README per section as the staged replacement lands, cell by cell, with that cell's behavior tests ported in the same stage.
- @inquirer toggle-picker interaction patterns → the single `enable` picker.

### Dropped (serves no intent)

- The per-type command trees (`asb rule|command|agent|skill|hook|mcp` with their `list`/`load`/selector duplicates): six copies of three verbs — the CLI face of the per-cell disease. Replaced by `status`/`--type`, `enable`/`disable`, the picker, `import`.
- `plugin install`/`uninstall`: verbatim aliases of `enable`/`disable` in 0.4 (src/index.ts:1833). Zero capability loss.
- `plugin info` and `plugin list` as separate views → `explain <id>` and `status --all` (one read surface that always shows enabled-but-absent rows).
- `plugin marketplace add|remove|update|list` verb tree → `add --marketplace`, `remove`, `sync --update --source <name>`, `status`. One enumerated behavioral change: 0.4's `marketplace update` refreshed the cache without touching targets; the 0.5 equivalent also reconciles that source's own content in the same run (the plan is filtered to that source, so nothing else deploys).
- The `[targets.<id>]` DSL compiler (563 lines) and the `.mjs` extensions loader: replaced by schema-validated data rows expressing the same grammar (including the YAML keyed-array MCP form, via the `keys` shape). A leftover `~/.asb/extensions/*.mjs` gets one warning naming the removal and noting that the file still serves any 0.4 peer sharing the library — it is deleted only after the fleet is on 0.5, never at cut-over.
- `agentSync` computed-never-persisted status machinery and the permanently broken "Agent sync status" section → replaced by the ledger and the recorded last-run fact.
- `asb source` tombstone command, `TargetHooksHandler` (unreachable), the whole-file TOML rewrite path (replaced by byte-splice), and the five-to-seven divergent per-cell pipeline copies the engine replaces.
