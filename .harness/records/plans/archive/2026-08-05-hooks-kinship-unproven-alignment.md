---
status: delivered
owner: direct
evidence: pnpm test (hooks-ownership/derived + focused kinship cases green); pnpm typecheck; node dist/index.js status --type hooks --app codex shows no left-behind after residual cleanup
goal: null
---

# Hooks kinship unproven noise Alignment

## Goal

Sync 对 hooks 共享配置里的“疑似 ASB 旧残留”报警要准：真旧渲染继续提醒用户自删，外来安装器（如 cmux）不要再被当成 left-behind。

Examples:

- `asb sync` 后，同 event 且非空 matcher 与库 hook 相同、但内容已不是当前 render 的 group → 仍报 `left-behind (unproven)`，reason 尽量点名库 hook id；group 原位保留、不删除。
- 无 matcher（或空字符串 matcher）的外来 group，即使与库里某 hook 同 event → 不报 left-behind，原位保留；selected hook 的 managed/深比较归属与写入不受影响。
- 取消选择后，非空 matcher 的旧 group 仍可被报告（全库 render 参与亲缘，不只 selected）。
- 排除：不自动删除 unproven group；不新增 force/prune 默认路径；不改 ownership 证明规则（managed path / legacy marker / deep-equal）。

## Design

```text
existing group
  ├─ proven (path / marker / deep-equal) → rewrite or remove as today
  └─ unproven
       ├─ matcher is non-empty string AND equals some inventory render's matcher on same event
       │    → report left-behind (unproven), name first matching library id when known
       └─ otherwise
            → silent keep
```

- Kinship predicate: same event and both matchers are equal non-empty strings; missing, non-string, and `""` never establish kinship.
- Kinship still scans the full inventory of hook renders (selected or not), so deselect residuals with a concrete matcher keep reporting.
- Reason text names the likely library id when kinship hits one: `likely an older render of <id>`; keep “delete it yourself”; do not invent a foreign-peer report class (foreign groups should be silent).
- Ceiling accepted and documented in code: an unbundled, no-matcher inline hook whose definition drifts leaves a silent residual (still not deleted); managed-path hooks are unaffected.

## Boundary

- Mutable: `src/engine/plan.ts` (hooks kinship / unproven report only), `tests/v05/hooks-ownership.test.ts` and any reason-string assertions that the new wording breaks.
- Red lines: do not auto-delete or overwrite unproven groups; do not add `--force`/`--prune` for hooks in this delivery; do not change `hookGroupOwner`, bundle removal, or MCP/rules ownership.
- Non-goals: machine cleanup of `~/.codex/hooks.json` (operator action, separate from the CLI change); cmux product integration into ASB selection; command-similarity heuristics.
- Compatibility: exit codes and outcome vocabulary (`left-behind` / `unproven`) stay; only which groups qualify and the reason string may change.
