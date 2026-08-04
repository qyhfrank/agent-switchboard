# Agent Switchboard

Agent Switchboard (ASB) keeps one library of rules, commands, agents, skills,
hooks, MCP servers, and plugins synchronized across supported coding agents.
The 0.5 engine plans from a captured filesystem state, writes only what it can
prove is its own, and reports the same outcome vocabulary in text and JSON.

## Requirements

- Node.js 20 or newer
- Git for managed remote sources

## Quick start

```bash
npm install --global agent-switchboard
mkdir -p ~/.asb
asb add /path/to/plugin-or-library
asb enable
asb status
asb sync --dry-run
asb sync
```

`asb enable` without ids opens the interactive picker. A library may also be
managed directly under `ASB_HOME` with the layout shown below.

## Commands

```text
asb sync                         reconcile installed applications
asb status [idGlob]              preview selection and per-app reality
asb enable [ids...]              select components or plugins
asb disable [ids...]             deselect components or plugins
asb explain <target>             show owner, hashes, and desired content
asb add <git-url|path>           add a plugin source
asb remove <name>                remove a source and retire its enabled ids
asb import <app> [path]          copy app-side content into the library
asb init                         create a project .asb.toml scaffold
```

Use `asb <subcommand> --help` for the complete option set. The reconciliation
commands accept these common filters and scopes:

```text
-n, --dry-run                    plan and report without writes or clones
--update                         refresh managed clones before planning
--no-update                      suppress explicit and configured refresh
--source <name>                  filter rows by source
--app <app>                      filter rows by application
--type <type>                    filter rows by component type
-p, --profile <name>             merge <ASB_HOME>/<name>.toml
-P, --project <dir>              merge <dir>/.asb.toml and use project paths
--json                           emit machine-readable output
```

`status` additionally accepts `--all` and an optional `idGlob`. `explain`
returns exit code 1 when nothing matches or any matched slice has a failing
outcome.

## Output

A report answers whether you are in sync rather than logging what ran. In an
interactive terminal a run with nothing to do is one line:

```text
✓ asb sync · profile aws · 120 components in sync across 5 apps
```

A run that did something groups its changes under the app that received them,
collects what needs a person under `needs attention`, tallies the rest, and
ends on the verdict:

```text
asb sync · profile aws

claude-code
  ✓ updated  ~/.claude/CLAUDE.md
  − removed  feishu-cli:feishu-cli-docs · lark-cli:lark-doc · lark-cli:lark-shared
cursor
  − removed  feishu-cli:feishu-cli-docs · lark-cli:lark-doc · lark-cli:lark-shared

needs attention
  ✗ rl-harness  library source missing
    enabled but its source content is not there; expected ~/Documents/Projects/rl-harness

1 updated · 6 removed · 110 in sync
✗ finished with 1 problem
```

`asb status` is that layout in the future tense, with the last completed sync
in its header outside project scope:

```text
asb status · profile aws · last sync 2026-08-03 17:50

pending
  → claude-code · CLAUDE.md will be updated
needs attention
  ✗ rl-harness · library source missing

110 in sync · 1 pending · 1 problem
→ asb sync applies 1 change
```

Severity reads from the glyph alone when there is no color: `✓` applied, `−`
removed, `→` pending or the next command to run, `⚠` a warning that leaves the
run passing, `✗` a failure that does not. `sync --dry-run` states itself in one
banner above the report instead of marking every row. Color follows chalk's
detection, so `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, and CI are honored.

This layout is for interactive terminals. Piped or redirected output keeps the
plain text of earlier releases, so a wrapper script reading it sees no change,
and `--json` is unaffected by either.

## Library and configuration

ASB resolves its home from `ASB_HOME`, then `~/.asb`, then the predecessor
home when it already exists. A typical library is:

```text
~/.asb/
├── config.toml
├── work.toml
├── mcp.json
├── rules/
├── commands/
├── agents/
├── skills/<id>/SKILL.md
├── hooks/
└── plugins/
```

The user configuration is always loaded. `-p work` adds `work.toml`, and
`-P /repo` adds `/repo/.asb.toml`. Later layers override earlier layers.

```toml
[applications]
enabled = ["claude-code", "codex"]
assume_installed = []

[rules]
enabled = ["shared-policy"]

[commands]
enabled = ["review"]

[agents]
enabled = ["reviewer"]

[skills]
enabled = ["research"]

[hooks]
enabled = ["notify"]

[mcp]
enabled = ["filesystem"]

[plugins]
enabled = ["team-tools"]
auto_update = false
```

Per-application tables may replace, add, or remove a component selection:

```toml
[applications.codex.skills]
add = ["codex-only"]
remove = ["research"]

[applications.cursor.rules]
enabled = ["cursor-policy"]
```

Configuration is strict after the supported 0.4 compatibility spellings are
migrated in memory. Unknown keys, invalid target shapes, and type errors fail
before planning. Supported compatibility inputs include `active`, the former
agents/subagents split, legacy plugin forms, and `[extensions]` parser
tolerance.

## Supported applications

| Application | Rules | Commands | Agents | Skills | Hooks | MCP |
|---|---:|---:|---:|---:|---:|---:|
| Claude Code | yes | yes | yes | yes | yes | yes |
| Claude Desktop |  |  |  |  |  | yes |
| Codex | yes | yes | yes | yes | yes | yes |
| Gemini | yes | yes |  | yes |  | yes |
| OpenCode | yes | yes | yes | yes |  | yes |
| Cursor | yes | yes | yes | yes |  | yes |
| Trae | yes |  |  | yes |  | yes |
| Trae CN | yes |  |  | yes |  | yes |

Configuration-defined targets can add other applications without runtime
code. Define one or more cells under `[targets.<id>]`, for example:

```toml
[targets.my-agent.commands]
target_dir = "~/.my-agent/commands"
project_target_dir = ".my-agent/commands"

[targets.my-agent.mcp]
format = "json"
config_path = "~/.my-agent/mcp.json"
root_key = "mcpServers"
```

A path you write into `[targets.<id>]` is your choice, not a name ASB claims,
so nothing at it is ever removed for sitting there. A `rules.file_path` whose
component selection is empty is reported and left, and no sibling of it is
touched.

Executable `.mjs` and `.js` target extensions are not loaded by 0.5. When
files remain directly under `ASB_HOME/extensions`, every reconciliation emits
one non-failing warning pointing to `[targets.<id>]`. ASB leaves those files
alone: they are yours to delete once the `[targets.<id>]` tables replace them.

## Sources and plugins

`asb add` accepts a local directory or Git URL. `--as` sets its namespace,
`--ref` pins a branch, tag, or commit, and `--subtree` selects subtree mode.
Managed clones are made ready before inventory. Use `asb sync --update` to
refresh them or `--no-update` to suppress `plugins.auto_update`.

Plugin components are namespaced as `plugin:component`. A plugin reference may
use `plugin@source` when the same plugin name exists in multiple sources.
External marketplace entries are materialized only when selected content needs
them. The predecessor marketplace cache is read only to retire entries whose
identity is verified; 0.5 never writes that cache.

`asb remove <source>` retires every id that came from the source, in the
global lists, the plugin list, and any per-application override, takes the
slices they distributed, and only then drops the declaration and any managed
checkout. The order is load-bearing: a component the library can no longer
render proves nothing, so removing the content first would leave every file it
distributed behind. If a slice cannot be taken, the source is kept along with
the named rows, because while it is still declared a later run can still prove
what it distributed. A local directory you pointed at is never deleted.

## Ownership

A slice is ASB's when it holds what the library renders for it. That
comparison is made fresh on every run and nothing is written down, so there is
no ownership record to lose, migrate, or disagree with a second machine about.

Four shapes carry the comparison. A dedicated file compares by its bytes; a
distributed bundle by its file set, contents, and executable bits; a key
inside a structured host by the serialized value at that key, never by the
key's name; and a region between ASB's delimiters inside a file it shares is
proven by the delimiters themselves, so bytes outside them survive every sync.

Deselecting a component removes its slice while that slice still holds the
render. One that says something else is a target ASB cannot attribute, and
what happens next depends on how strong the remaining claim is. A bundle
directory carries a library id under a parent the application table declares,
which is claim enough: under your home directory it is swept as a stale copy,
and inside a repository it is preserved and named, because the repository is
shared. A single file carries no such id in its contents, so a drifted command
or agent is preserved and named in either scope; it is yours to delete or to
re-enable. A key inside a shared document is never removed at all.

`asb explain <target>` names what proves a slice right now: `identity` for a
target holding the render, `marker` for a delimited region, `native-manager`
for work an application's own plugin manager owns, and `unproven` when nothing
does.

The state directory (`XDG_STATE_HOME/asb`, else `~/.local/state/asb`) holds
`run.lock` while a run is in flight and `last-run.json` afterwards. Neither
decides what ASB owns.

## MCP ownership

MCP definitions live in `ASB_HOME/mcp.json` under `mcpServers`. ASB masks
credential values in `explain` and report output while preserving environment
variable names.

A server is ASB's while the value at its key equals the render, so a
hand-written server sharing a library id you have not selected is never read,
written, or removed. Selecting that id is the instruction to put the library's
definition at that key, and the value there is replaced. ASB does not create
empty MCP host files, and an existing empty container is evidence of nothing.
An owned value is replaced whole rather than merged, so a drifted one
conflicts instead of absorbing unknown foreign subkeys.

Writers preserve unrelated bytes in shared JSON, JSONC, YAML, and TOML hosts.
They cannot restore comments or formatting already removed by an earlier
whole-file writer.

## Project scope

Run `asb init` in a repository to create a `.asb.toml` scaffold. Project-capable
rules, commands, agents, skills, hooks, and MCP cells use project destinations
under `-P`. Source lifecycle and native plugin manager rows remain global.

```toml
[distribution.project]
mode = "managed"
collision = "warn-skip"
```

Project modes are `managed`, `exclusive`, and `none`. Managed mode preserves
foreign content; its collision policies are `warn-skip`, `error`, and
`takeover`. A project run writes nothing outside the repository, and proves
what it owns against the same library render a global run compares to.

Because a repository is shared, a target ASB cannot attribute is preserved and
named rather than swept. The rules region inside `AGENTS.md` is delimited, and
those delimiters are its proof, so it is rewritten and removed like any other
marked region while bytes outside it are left alone.

Codex project trust is add-only. ASB preserves an existing trusted value,
refuses untrusted or malformed values, and provides no trust-removal path.

## Hooks

A hook group in an application's configuration is ASB's when its command runs
a file ASB distributed, or when it equals a group the library renders. A group
ASB cannot attribute keeps its content and its place: Codex records trust
against a group's array index, so a group that did not change is rewritten
where it already sits instead of being moved behind whatever else is there.

A definition hook owns no directory, so a hand-written group byte-identical to
its render is taken as ASB's rather than duplicated beside itself. A group a
predecessor wrote whose command names no distributed file is reported once and
left for you to remove.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` runs only `tests/v05/*.test.ts`. Five source-management suites spawn
Git or native-manager subprocesses and may be denied by restricted sandboxes;
the remaining suites do not need subprocess permission.

### Releasing

Publish patch releases through the Release workflow. Start on a clean `main`
branch synchronized with `origin`. Bump the package without creating a tag,
move the `Unreleased` changelog entries under the new version, and commit both:

```bash
npm version patch --no-git-tag-version
git add package.json CHANGELOG.md
git commit -m "chore(release): v<version>"
```

Run the release gates against that exact commit:

```bash
pnpm lint
pnpm typecheck
pnpm run build
pnpm test
pnpm run smoke:baseline
```

After the final audit and user-journey checks pass, create and push the tag:

```bash
git tag -a v<version> -m "chore(release): v<version>"
git push origin main --follow-tags
```

Do not run `npm publish` locally. Pushing the tag triggers
`.github/workflows/publish.yml`. After the workflow publishes, install the
released version with `npm install -g agent-switchboard@<version>` and verify
`asb --version`.
