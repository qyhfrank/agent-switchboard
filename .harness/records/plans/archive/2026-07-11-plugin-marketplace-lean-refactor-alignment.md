---
status: delivered
owner: .harness/runtime/tasks/002-plugin-marketplace-lean-refactor
evidence: .harness/runtime/tasks/002-plugin-marketplace-lean-refactor/artifacts/audit/final-2.md
goal: null
---

# Plugin marketplace 精简重构对齐

## 目标

完成插件 marketplace 重构：catalog inventory 不下载 disabled remote entries，selected plugin 才解析内容；compatible same-origin `git-subdir` 复用 source checkout，external Git entry 使用确定性 state-owned sparse cache；应用级 portable plugin 选择和 canonical CLI identity 正确；保留 credential、路径、失败刷新、exact ref 和配置 symlink 等真实保护，删除不服务真实用户路径的 lifecycle 复杂度。

示例：`asb plugin list --json` 对 disabled external entry 只返回 metadata 且不创建 cache；该 entry 被配置后 `asb sync` 才 materialize，后续 source update 刷新已 materialize entry，source removal 只清理对应 derived cache。

## 设计

```text
Catalog inventory
      │ metadata only
      ▼
Plugin selection
      ├─ compatible same-origin ──> reuse source checkout
      └─ external Git ────────────> state-owned sparse cache
                                             │
                                             ├─ source update: refresh materialized entries
                                             └─ source removal: remove derived cache only
```

- Source checkout 的 ownership 和 add/remove/update 继续由现有配置与 source command 决定；marketplace cache 不引入独立的 source lifecycle journal。
- Cache 以 source、plugin、credential-free URL、resolved ref、SHA 和 subdirectory 形成确定性 identity；新 checkout 验证完成后原子替换，失败时保留上一份可用 generation。
- Same-origin reuse 只在 selected resolution 执行，通过本地 origin、HEAD 和 exact pin 判断；inventory 不执行网络请求或组件读取。
- Git credential 仅通过瞬时 transport 传递，持久 metadata、Git remote 和错误输出均不包含 credential。
- 路径 containment、symlink 防护、exact branch/tag/SHA 语义和配置 symlink 兼容保留；同用户恶意 inode 替换、并行 source mutation 和每个 filesystem syscall 的 crash recovery 不属于产品契约。

## 边界

- 可修改 `src/config/`、`src/index.ts`、`src/library/sources.ts`、`src/marketplace/`、`src/native-plugins/`、`src/plugins/`、`src/sync/command.ts`、`src/ui/plugin-ui.ts`、对应测试、`README.md` 和 `docs/claude-marketplace-format.md`。
- 不增加依赖、公开配置项或通用 package-manager abstraction；`src/targets/`、`src/manifest/`、`scripts/` 和 `.github/` 不变。
- 保持 direct source discovery、relative-path marketplace entry、portable aliases、source-qualified component IDs 和 native plugin separation 兼容。
- 最终验证覆盖 metadata-only inventory、same-origin selected reuse、external sparse cache、pin/update/cleanup、应用级选择、canonical JSON、credential redaction、containment、failed-refresh preservation 和 exact ref。
- 当前 dirty `main` checkout 的 `README.md`、`package.json` 和 `scripts/release.sh` 不改动；实现、合并和发布从独立 clean worktree 完成。
- 允许在完整检查、真实 CLI journeys 和限定边界的最终 audit 通过后 push `origin/main`，创建并 push 下一个 patch tag，由 GitHub Actions 发布 npm，再安装准确版本并验证 `asb --version`。
