---
status: delivered
owner: direct
evidence: .harness/runtime/packets/managed-clone-readiness-closeout/evidence.md
goal: null
---

# Declarative Managed Clone Sync Alignment

## Goal

Mackup 只同步 `config.toml` 和用户维护的内容。可从 Git 重建的 managed clone checkout 只存在于 machine-local cache；配置中的 source 声明足以让普通 `asb sync` 恢复该 checkout 并在同一次运行中分发其内容。

```toml
[plugins.sources.ppt-master]
url = "https://github.com/example/ppt-master.git"
type = "clone"
```

```text
asb sync
→ <ASB_CACHE_HOME>/ppt-master/ 存在且可用
→ <ASB_HOME>/plugins/ppt-master 不因 managed clone 被创建
→ 已启用的 ppt-master components 在同一次 sync 中进入目标应用
```

- `[plugins.sources]` 下的 transport URL string 与显式 `type = "clone"` 行为一致。
- Managed cache checkout 已存在时，普通 sync 使用现有 generation，不对该 source checkout 执行 fetch 或 pull；`asb sync --update`、`plugins.auto_update = true` 和 marketplace update 继续负责显式刷新。
- `asb sync --no-update` 只关闭 refresh，仍执行普通 sync 的 missing-checkout readiness。
- Cache 被删除且没有 legacy checkout 时，下一次普通 sync 自动 clone；存在 ASB 创建且未修改的 legacy checkout 时，普通 sync 将同一 generation 安全迁移到 cache，不顺带刷新它。
- 缺失或待迁移的 managed source 无法安全 materialize 时，sync 在 distribution 前失败，既有目标输出不因不完整的 plugin inventory 被清理。
- `asb sync --dry-run` 不创建、迁移或修改 source/cache checkout。它报告下一次真实 sync 将尝试的 clone 或经验证后 migration 及目标路径；存在 readiness action 时，不基于缺失或尚未验证的内容生成 distribution preview。
- Local-path 和 `type = "subtree"` source 继续留在用户拥有的位置，不进入 managed cache。

## Design

```text
config.toml [plugins.sources]
             |
             v
      managed-clone readiness
      |-- cache checkout exists -----> use current generation
      |-- verified legacy checkout --> move same generation to cache
      |-- no checkout ---------------> atomic clone into cache
      `-- unavailable or unsafe -----> fail before distribution
             |
             +-- explicit refresh? --> refresh existing generation
             |
             v
      plugin index -> distribution

      dry-run -> read-only readiness plan
                  |-- readiness action pending --> report action/path; omit incomplete preview
                  `-- no action ------> run the existing distribution preview
```

- Missing-checkout materialization and existing-checkout refresh are separate internal intents. Ordinary sync always performs readiness; only the existing update controls trigger refresh.
- Clone staging, provenance, cache ownership, legacy verification and migration, cross-filesystem fallback, rollback, dual-location detection, and derived marketplace-cache ownership remain in the source lifecycle owner. Sync orchestration does not duplicate Git or filesystem mutation logic.
- `--no-update` disables refresh but still permits the configured checkout to be materialized. For a ready cache checkout, the source-readiness stage does not invoke Git.
- A readiness failure is a hard prerequisite failure. After readiness succeeds, explicit refresh errors retain their existing command behavior.
- Selected external marketplace entries retain their existing lazy `.entries` materialization semantics, including any Git transport they require; the no-fetch rule applies to the managed source checkout itself.

## Boundary

- Implementation is limited to `src/library/sources.ts`, `src/marketplace/cache.ts`, and `src/sync/command.ts`; regressions are limited to `tests/sources.test.ts` and `tests/sync-command.test.ts`; user documentation is limited to `README.md`.
- No CLI flag, config schema, public source type, dependency, cache level, symlink bridge, shared Git store, background update, retry state machine, or package-manager abstraction is added.
- Manual/local sources, subtree sources, external marketplace `.entries`, native plugins, managed project manifests, and application distribution ownership keep their existing lifecycles.
- Modified or unverifiable legacy checkouts stay in place; cache/legacy dual locations remain errors; symlinked cache roots, foreign cache content, root-swap rollback, and credential redaction remain fail-closed protections.
- Verification uses isolated `ASB_HOME`, `ASB_CACHE_HOME`, and `ASB_AGENTS_HOME`; real user checkout and cache directories are not read or modified.
- This change does not alter package versions, create tags, or publish npm artifacts.
