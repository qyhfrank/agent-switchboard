# Changelog

## Unreleased

## 0.5.4

### Cross-machine Codex hook trust

- **Selected ASB hook groups form a canonical configured-order prefix in
  Codex.** Machines with different local hooks assign the same positional
  trust keys to their shared ASB hooks, while unowned groups keep their content
  and relative order at the tail. Writes that shift surviving hooks after a
  deselection also report the required Codex trust review.

### Test suite reorganized by feature area

- **`tests/v05/` is gone; the suite lives flat in `tests/`, one file per
  feature area.** Milestone-era files (`m6-suite-floor`, `audit-final`,
  `dogfood-final`) dissolved into the domain files that own their behaviors;
  redundant assertions were consolidated. `npm test` no longer needs a prior
  `npm run build`.

## 0.5.3

### Hooks unproven residuals

- **Unowned hook groups report `left-behind (unproven)` only when they share
  an event and a concrete non-empty matcher with a library hook.** Missing and
  empty matchers no longer establish kinship, so foreign installers that only
  share an event (for example a parallel Codex hooks installer) stay silent.
  The reason names the likely library id. Groups are still never auto-deleted.

## 0.5.2

### One sync, two scopes

`asb sync` reconciles the machine's user scope and, when a project is in play,
that repository's own additions: two phases of one run, under one lock, with
one report and one exit code.

- **A profile replaces the user configuration's selection instead of layering
  over it.** `-p aws`, or `ASB_PROFILE=aws`, takes `[applications]`, the
  component sections, and `[plugins].enabled` from `~/.asb/aws.toml` alone. A
  selection section the profile omits selects nothing, so content `config.toml`
  distributed earlier is deselected for that run and removed wherever the
  render proves it. Machine infrastructure (`[plugins].sources`,
  `[plugins].auto_update`, `[targets]`, `[extensions]`, `[distribution]`,
  `[ui]`) still comes from `config.toml`, so a profile carries a selection and
  never a copy of the machine setup. A profile meaning "the user configuration
  plus tweaks" has to write its selection out in full; one enabling no
  applications reconciles nothing, and the report says so. The two files used
  to deep-merge.
- **`[plugins.sources]` outside `config.toml` is inert.** A source declared in
  a profile or in a repository's `.asb.toml` is reported once and never cloned
  or refreshed: sources live in `config.toml`, and every selection resolves
  against the machine's own library. `asb add` and `asb remove` write there
  under any profile.
- **`-P <dir>` is no longer a project-only run.** Every run reconciles user
  scope first and the project after it; `-P` names the project root. A script
  that used `-P` for an isolated project pass reconciles the machine as well.
- **`./.asb.toml` is detected.** `asb`, `sync`, `status`, and `explain` run the
  project phase when the invocation directory holds an `.asb.toml` — that
  directory only, never a parent, and never against an explicit `-P`. A root
  that is or contains the agents home is refused with a report row, because one
  tree cannot be both scopes. An edit keeps explicit targeting: `enable` and
  `disable` write to the file `-P` or `-p` names, otherwise to `config.toml`.
- **A project receives the increment, not the whole selection.** Per app and
  type, project destinations get what `<root>/.asb.toml` selects over the base
  file and nothing more, compared after alias resolution and plugin expansion.
  User-level content is already visible to every app in every directory, so a
  repository synced by an earlier version loses its user-level duplicates on
  the first run of this version wherever the render proves them, and a drifted
  copy is reported `left-behind`. The `AGENTS.md` region composes increment
  rules only, and an increment for an app and type whose cell has no project
  destination is reported rather than dropped. A project still only adds: no
  spelling in `.asb.toml` withholds user-scope content from one repository.
- **Codex project trust is written only under an explicit `-P`.** A detected
  project plans its phase without the trust row, so `asb sync` inside a
  repository you cloned never adds it to the machine's trusted projects.
- **Report entries carry their scope.** Text output reads the whole user phase
  before the project rows, and JSON entries carry `scope`. The last-run marker
  is written by every real run, the user phase's to write, where a run given a
  project used to leave it unwritten.

### Migration notes

- **MIG-16, profile semantics:** Breaking. A profile replaces the user
  configuration's selection instead of layering over it, so a profile written
  as a patch selects only what it spells out and the run removes the rest
  wherever the render proves it. Write the selection out in full;
  infrastructure keys are inherited from `config.toml` and need no copy.

### Reports render as a screen in an interactive terminal

When stdout is a terminal, a report answers "am I in sync?" instead of logging
what the run did. A run with nothing to do is one line. A run that did
something groups its changes under the app that received them, collects every
row that needs a person under a `needs attention` block with the redacted
reason beneath each one, counts the rest in a one-line tally, and closes on a
single verdict line that says what the exit code says.

- Severity is carried by a glyph and a color, and by the glyph alone when there
  is no color: `✓` applied, `−` removed, `→` pending or the next command to
  run, `⚠` a warning that leaves the run passing, `✗` a failure that does not.
  Paths under the home directory are shown with `~`.
- `sync --dry-run` states itself once in a banner above the report rather than
  prefixing every row with `[dry-run]`. `status` is a preview already and
  carries no banner.
- The last run moved from the end of the `sync` report into the `status`
  header, as `last sync <time>`: it is a fact about the machine, not about the
  run in front of you. Project scope omits it, and so does the non-terminal
  layout.
- Color follows chalk's own detection, so `NO_COLOR`, `FORCE_COLOR`,
  `TERM=dumb`, and CI are honored. Dropping the color changes no text.

Output that is not going to a terminal is byte-identical to 0.5.1. A pipe, a
redirect, or a script reads the lines it read before. `--json` structure and
content, the outcome vocabulary, and the exit codes are untouched.

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
