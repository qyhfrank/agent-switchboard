# Changelog

## Unreleased

### Skills ownership is derived, not recorded

Skill bundles are no longer planned from the ownership ledger. A bundle is
compared against its library render, and that comparison decides everything:

- A selected skill whose bundle differs is written in one pass. The two-step
  `adopted (convention)` then `written (updated)` sequence is gone, as is the
  `conflict` a hand-edited bundle used to raise. The library is the source of
  truth for a distributed copy; edit the library entry, not the copy.
- A distributed bundle mirrors its library directory. Files the render does
  not name are cleared, which is what keeps a synced bundle byte-identical to
  its render and therefore removable later without a stored record.
- A deselected bundle is removed on that byte proof. Failing it, a bundle whose
  id matches a library skill under a skills parent the app table declares is
  swept as `removed (stale-copy)`. This clears copies distributed before
  ownership was derived, which no record can attribute and which otherwise
  report as `left-behind (unproven)` on every run.

A directory you wrote by hand under a library skill's id is destroyed by that
sweep. Bundles holding symlinks or special files are still never removed.

Ledger entries are still written for skills so that a project run proves
ownership to its peer manifest, which 0.4 peers read. Global planning no longer
consults them.

## 0.5.0

### Migration notes

- **MIG-01, strict plugin configuration:** Unknown keys under `[plugins]` are
  rejected. Supported predecessor spellings are migrated before strict schema
  validation; other unknown top-level, nested, target, and transform keys fail
  before planning.
- **MIG-02, predecessor marketplace cache:** The predecessor
  `state/marketplace-plugins` cache is read only to retire identity-verified
  entries. Version 0.5 does not write it.
- **MIG-03, source removal:** `asb remove` retires plugin-expanded enabled ids
  contributed by the removed source.
- **MIG-04, empty MCP hosts:** Version 0.5 neither creates empty MCP host files
  nor treats an empty container as ownership evidence.
- **MIG-05, byte preservation:** Shared-document writers preserve unrelated
  bytes. They cannot restore comments or formatting already destroyed by a
  predecessor whole-file rewrite.
- **MIG-06, managed MCP values:** An owned MCP value is replaced wholly. Bytes
  modified since the recorded write cause a conflict instead of a deep merge
  with foreign subkeys.
- **MIG-07, Codex project trust:** Trust is add-only. Existing trusted values
  are preserved, untrusted or malformed values are refused, and ASB provides
  no removal path.
- **MIG-08, import boundaries:** `asb import` supports commands, agents,
  skills, and hooks. There is no rules import; rules remain library-authored.
- **MIG-09, marketplace refresh:** `asb sync --update --source <name>` both
  refreshes the marketplace and reconciles that source in the same run.
- **MIG-10, custom target ids:** Configuration fails when a custom target id
  collides with a builtin app id; custom targets cannot override builtins.
- **MIG-11, Codex agent eligibility:** A selected agent without the Codex role
  metadata is reported as `skipped (no-codex-role)` and no role file is made.
- **MIG-12, entry filenames:** Component ids use an ASCII-safe filename
  encoding. Non-ASCII and other unsafe characters become `-`; collisions fail
  closed before either component is written.
- **MIG-13, project initialization:** `asb init` writes a dormant, commented scaffold.
  Detected apps are annotations, and `AGENTS.md` is optional.
- **MIG-14, remote source add:** `asb add` materializes the checkout or subtree
  before persisting its declaration; a failed materialization writes no source.
- **MIG-15, Codex skills import:** The default Codex skills import reads
  `.codex/skills` and ignores its reserved `.system` directory.

### Compatibility boundaries

- Executable target extensions are replaced by `[targets.<id>]` data. Leftover
  `.mjs` and `.js` files remain untouched for a 0.4 peer sharing `ASB_HOME`.
- Hook bundle groups can recover ownership from recognized managed paths and
  predecessor evidence after state loss. Definition hooks remain unclaimable
  without state; byte equality is not ownership proof, so an identical
  hand-written group is preserved and a definition may be appended again.
- Configuration validation is strict after the explicit compatibility
  migrations for `active`, the agents/subagents split, legacy plugin forms,
  legacy home resolution, and `[extensions]` parser tolerance.
