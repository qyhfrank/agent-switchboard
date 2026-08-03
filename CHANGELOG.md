# Changelog

## 0.5.1

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

### Ownership is derived for every component type

What was true for skills is now true for rules, commands, agents, hooks, and
MCP servers: a slice is ASB's while it holds what the library renders, and no
run consults a record to decide.

- **The ownership stores are deleted.** `<state dir>/ledger.json`, the project
  manifests under `<ASB_HOME>/state/manifests/`, and the hook peer state under
  `<ASB_HOME>/state/hooks/` are removed on the first run of this version. The
  state directory keeps `run.lock` and a new `last-run.json`.
- **0.4 interoperation ends.** A 0.4 peer sharing one `ASB_HOME` read those
  stores and 0.5 no longer writes them, so the two versions can no longer share
  a library. Finish migrating before running this version against a home a 0.4
  install still uses.
- **`adopted` is gone from the output.** A target already holding the render is
  reported `unchanged` and nothing is written; the `adopted (convention)` step
  that used to precede a write no longer exists.
- **Predecessor hook groups are reported, not migrated.** A group a 0.4 install
  wrote whose command names no distributed file cannot be attributed, so it is
  reported once per run and left for you to delete. A group byte-identical to
  what the library renders is taken as ASB's rather than duplicated beside
  itself, which reverses the previous "byte equality is not proof" rule for
  definition hooks.
- **A recognized hook group keeps its array index.** Codex records trust
  against a group's position, so a group that did not change is rewritten where
  it already sits instead of being appended behind whatever else is in the
  file.
- **Nothing ASB writes into your configuration carries its name.** The Cursor
  and Trae rules files are `rules.mdc` and `rules.md`, replacing `asb-rules.*`,
  which are swept on the next run. Only those built-in paths carry the old
  spelling, so a `[targets.<id>].rules` path you chose is left alone along with
  anything beside it. The rules region delimiters are
  `<!-- rules:start -->` and `<!-- rules:end -->`; the previous spelling is
  still recognized when locating an existing region, so a file written by an
  earlier version is rewritten once rather than gaining a second region. A rule
  id of `rules` is rejected, since it would collide with the new filename.
- **`asb remove <source>` takes what the source distributed.** It retires the
  ids — in the global lists, the plugin list, and any per-application override
  — distributes once while the library can still render them, and only then
  drops the declaration and any managed checkout. A slice it could not take
  keeps the source in place for a later attempt. Previously it removed the
  source and told you to sync afterwards, which now would leave every
  distributed file behind with nothing able to attribute it.
- **Disabling an id reaches a per-application `enabled` list.** That spelling
  replaces the global selection for its app and ignores `remove`, so a disable
  that only wrote `remove` used to leave the id selected there.
- **A project region in `AGENTS.md` is proven by its delimiters.** An edit
  inside the region is overwritten on the next project sync, exactly as it is
  in a shared file under your home directory. Bytes outside the region are
  untouched.

### Reports collapse repeated outcomes

Entries sharing an outcome, detail, and reason render as one line naming the
first four subjects and counting the rest, restoring 0.4's `... (+N more)`
behavior. A run resolving forty bundles the same way is one line, not forty.

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
- **MIG-06, managed MCP values:** An owned MCP value is replaced wholly. A
  value that no longer equals the render conflicts instead of deep-merging with
  foreign subkeys.
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
  `.mjs` and `.js` files remain untouched.
- A hook group is attributed by the managed path in its command or by equality
  with a rendered group. Predecessor markers are still recognized, and a group
  neither signal reaches keeps its content and its position.
- Configuration validation is strict after the explicit compatibility
  migrations for `active`, the agents/subagents split, legacy plugin forms,
  legacy home resolution, and `[extensions]` parser tolerance.
