---
status: executing
owner: .harness/runtime/tasks/001-derived-ownership
evidence: null
goal: null
---

# Remove the ownership ledger Alignment

## Goal

Motivation: ASB should not keep its own record of what it distributed, and what it writes into your config should read as configuration you maintain by hand. The record is what makes an install that already has content produce skips and conflicts instead of just working, and it is the thing standing between a working 0.4-era setup and a clean 0.5 sync. What is on disk plus what the library would write is enough to decide everything; when they disagree, the library wins.

End state: no ownership state file, no code that reads one, and no asb-named string anywhere asb writes. Ownership evidence is location, name, and content, all of which a hand-maintained config would carry anyway. Ownership of every distributed slice is decided by comparing that slice against what the library renders for it. A selected component whose slice differs is written in one pass. A deselected component is removed when its slice is still the render; failing that, a file or directory carrying a library id under a directory ASB declares is swept, while a key inside a host document the user co-owns is reported once and left. The skills work already landed is the first of these shapes and its behavior is the reference for the rest.

Examples:

- `asb sync` on a machine whose distributed content predates this change → every row resolves; nothing reports `adopted`, `conflict`, or `left-behind (unproven)`
- `asb sync` twice in a row, no config change between → the second run's output is identical to the first, and neither writes an ownership record
- `<state dir>` after any sync → holds `run.lock` and the last-run marker, nothing else; `ledger.json`, `manifests/`, and the hook peer state are deleted on the first run of this version
- `~/.claude/CLAUDE.md` after any sync → blocks are delimited by `<!-- <rule id>:start -->`, and the surrounding region by `<!-- rules:start -->`; the file contains no asb-named string
- cursor and trae rules → `rules.mdc` and `rules.md`; an `asb-rules.*` left at the same path by an earlier version is swept on the first run
- a shared rules file an earlier version wrapped in `<!-- asb:rules:start -->` → the region is found, rewritten with the new wrapper, and not duplicated
- an interrupted write → any leftover temporary file is named without `asb`
- a rules block hand-edited inside its markers, then deselected → the marked block and its markers are removed, every byte outside them preserved
- `~/.claude/commands/foo.md` matching the render, then deselected → removed; the same file hand-edited first → reported once and left in place
- an MCP server you wrote by hand whose name matches a library server id, never selected → never read, never written, never removed
- a library MCP server you customized in `~/.codex/config.toml`, then deselected → left in the file and reported once, because its value is no longer the render
- a hook group whose command points at a path under `~/.asb` naming a library component, with no record of it anywhere → recognized as asb's, updated in place rather than appended a second time, and removed on deselect
- `asb sync` when a hook's content changes → in `~/.codex/hooks.json` every other group keeps its array index, so Codex asks you to review only the hook that actually changed
- a hook group asb cannot prove but that shares an event and matcher with a library hook → reported once with its location, and left in the file
- a project run in a repository whose `.claude/skills/foo` has drifted from the render → left in place and reported, because the name sweep does not reach into a shared repository
- `asb explain <id>` → the owner line names what proved ownership now, not a stored record
- `asb remove <source>` → slices distributed from that source's components are gone in the same run, before the source stops being renderable

## Design

```
per slice:  locate(target) ──┐
                             ├──► compare ──► same | differs | absent
            render(library) ─┘

                    selected            deselected
     absent         write               (nothing)
     same           unchanged           remove
     differs        write               sweep if file/dir, report if key
     unprovable     report              report
```

- One predicate decides every shape: is this slice what the library renders for it. The six rows above are the whole planner; today each type reimplements a variant of record lookup, staleness, and provenance around the same decision.
- What varies per shape is locating and comparing the slice, so this lands as four comparators rather than four planners: own-file compares bytes, own-dir compares the rel set plus bytes and executable bits, region compares what sits between the marker pair, keys compares the serialized value at the key path.
- Project scope derives the same way global scope does, so all three state stores go: `ledger.json`, the project manifest under `<asb home>/state/manifests/`, and the hook peer state. The manifest was the project run's ownership proof and `projectMcpPeerLedgerEntries` already recomputes its expected hash from the current render, so it decides nothing the comparison does not.
- The name sweep stays out of project scope. A project tree is shared with the repository, so only a byte-proven copy is removed there, and a drifted one is reported.
- Rules need no new evidence and no sweep: the markers locate and prove the slice on their own. The asb name is what goes, not the mechanism. The wrapper at `shapes.ts:98` keeps its role and is renamed to `<!-- rules:start -->` / `<!-- rules:end -->`, which is a constant change rather than new boundary logic; the per-rule delimiters at `shapes.ts:81` are already named after the rule and are untouched.
- Locating accepts the old wrapper spelling as well as the new one, so a file an earlier version wrote is found and rewritten instead of gaining a second region. Writing emits only the new spelling, and the alias is dropped once no supported upgrade path still starts from a file carrying it.
- Dedicated rules files drop the `asb-` prefix and become `rules.mdc` and `rules.md`. Whole-file replace is authorized by the app table's `dedicated` flag, so the `basename.startsWith('asb-rules')` check at `shapes.ts:226` goes with the prefix, and the old `asb-rules.*` is swept by name at its declared path.
- Atomic-write temporary files drop `asb` from their name at `shapes.ts:1137`, so an interrupted write cannot leave one behind.
- The name sweep is evidence, not convenience, and only holds for own-file and own-dir: those sit in a parent directory the app table declares, holding an id the library defines. A key in `~/.codex/config.toml` or `~/.claude/settings.json` sits in a document the user co-owns, where the natural name for a server is the name anyone would pick.
- Derivation cannot attribute a slice that has drifted, so an edited slice is never removed automatically. That is the trade the sweep buys back for files and directories and deliberately does not buy for keys.
- Hook groups are written back at the index they already occupy rather than removed and re-appended. Codex keys its trust record by position (`hooks.json:<event>:<group>:<hook>` holding a `trusted_hash`), so appending shifts every group below it out from under its approval and makes Codex re-prompt for hooks the user never touched.
- A group sharing an event and matcher with a library hook but not otherwise provable is reported once and left, never removed. It is usually an older render of that hook whose command no longer carries a managed path, and reporting is what the red line on keys allows.
- Hook bundle directories are the same shape as skill bundles and derive identically. Hook groups spliced into a settings file already carry their own proof: `isManagedPathOwnedGroup` recognizes a group whose commands reference a path under a managed root naming a known component, which is stronger evidence than byte equality and is already what authorizes removal. The state file is a redundant third recognizer behind it, so dropping it costs nothing and ends the duplicate append that happens today when a recognized group is not also in the record.
- A component whose library entry is gone has nothing to compare against, so `asb remove <source>` must render and remove that source's slices while the library still holds them. This is an ordering rule inside the command, not a reason to keep state.
- The `adopt` operation and the `adopted` outcome disappear: adoption only existed to move a slice from unrecorded to recorded. Slices that were adopted now simply read as `unchanged`.
- `acquireRunLock` is not part of this. It serializes two runs on one machine and has nothing to do with ownership; it keeps its file in the state directory. The `last run:` line likewise survives, in its own small file.
- No migration step converts anything. Removing state has no target to migrate to, so the new version deletes the three orphaned stores on its first run and the per-shape sweep handles slices the old model stranded.

## Boundary

- Mutable: `src/engine/plan.ts`, `src/engine/cli.ts`, `src/engine/ledger.ts`, `src/engine/peer.ts`, `src/engine/report.ts`, `src/engine/shapes.ts`, `src/engine/apps.ts`, `src/engine/config.ts`, `tests/v05/**`, `README.md`, `CHANGELOG.md`.
- The skills shape is already implemented in the working tree and is the reference for the rest; it is finished work, not a draft to revisit.
- A key is never removed because its name matches a library id. Deleting an MCP server or hook entry a user wrote by hand is the one outcome this work must not produce, and a name match inside a host document is not evidence of authorship.
- `acquireRunLock` and `run.lock` stay exactly as they are, including the fail-closed behavior on a leftover lock. They are not ownership state.
- Bundles and files holding symlinks or special files are still never removed, on any path, swept or proven.
- Per-rule marker bytes do not change. They are what locates an existing block, so altering their text orphans every block a previous version wrote, which no derivation can then find or reclaim. The wrapper may be renamed only because locating accepts both spellings.
- `<!-- rules:start -->` now shares a namespace with the per-rule delimiters, so a rule whose id is `rules` would render a marker identical to the wrapper. Configuration fails closed on that id rather than writing a file whose region boundary is ambiguous.
- Nothing asb writes names asb. That covers markers, comments, generated headers, filenames, directory names, and temporary files, in every target and both scopes.
- A 0.4 install sharing the same `~/.asb` stops seeing its records once 0.5 deletes them, and falls back to whatever it does with an absent store. Nothing becomes unremovable: every slice those records described is reachable by comparison, marker, or path token. The changelog notes it alongside the `adopted` outcome leaving `--json` output, as breaking changes rather than internal cleanup.
- `peer.ts` is only half state. Its hook-command splice half (`commandContainsPathToken`, `stripLegacyMarkerLines`, `removeOwnedHookGroups`, `filterRecognizedDesiredGroups`) parses and edits hook config and is needed regardless; only the `PeerState` and `ProjectManifest` halves go.
- `ledgerKey` and the `LedgerEntry` shape are dead once all five types derive. Their disappearance is the last step, not a signal to leave the plumbing in place.
- Ordering: rules, then commands and agents, then MCP and hooks, then project scope and the module deletions. Each step lands with the suite green rather than as one cut-over.
