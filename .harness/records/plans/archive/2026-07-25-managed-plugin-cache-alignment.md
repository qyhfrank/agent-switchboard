---
status: delivered
owner: .harness/runtime/tasks/005-managed-plugin-cache
evidence: .harness/runtime/tasks/005-managed-plugin-cache/artifacts/disposition/summary.md
goal: null
---

# Managed Plugin Cache Alignment

## Goal

避免 Mackup 同步 `ppt-master` 等可从 GitHub 重建的大型 checkout；共享的 `$ASB_HOME` 只保存配置和用户明确维护的插件，每台机器把 ASB 管理的远程内容保存在本地 cache。

配置声明的 Git source 由 ASB 物化到扁平的 `$ASB_CACHE_HOME/<namespace>`。手动开发、手动 clone 或显式本地路径继续由用户维护，Git subtree 继续作为 `$ASB_HOME` 仓库中的可同步内容。

Examples:

```text
[plugins.sources.ppt-master]
url = "https://github.com/<owner>/ppt-master.git"
type = "clone"

asb plugin marketplace update ppt-master
-> checkout 位于 ~/.cache/asb/ppt-master
-> $ASB_HOME/plugins/ppt-master 不再保存 ASB 管理的 clone
```

```text
$ASB_HOME/plugins/my-dev-plugin
-> 继续自动发现为用户维护的 local source

[plugins.sources.vendor]
type = "subtree"
-> 继续位于 $ASB_HOME/plugins/vendor
```

删除 `$ASB_CACHE_HOME/ppt-master` 后刷新该远程 source，会从配置重新物化；仅存在于 cache、但未在配置或 marketplace selection 中声明的目录不会成为插件来源。

## Design

```text
config.toml
├── local path ───────────────> 用户维护的目录
├── type = "clone" ──────────> $ASB_CACHE_HOME/<namespace>
└── type = "subtree" ────────> $ASB_HOME/plugins/<namespace>

marketplace external entry ──> $ASB_CACHE_HOME/.entries/<identity>

自动发现只读取 $ASB_HOME/plugins/*
```

- `$ASB_CACHE_HOME` 是 ASB 独占的机器本地根目录。解析顺序为显式 `ASB_CACHE_HOME`、`$XDG_CACHE_HOME/asb`、`~/.cache/asb`。
- 配置管理的 source 直接使用 `$ASB_CACHE_HOME/<namespace>`；点号开头的目录保留给内部状态，marketplace 外部 entry 使用 `.entries/`。
- `type = "clone"` 保持现有配置格式并改为 cache-owned checkout，不增加每个 source 的 `checkout` 或 storage 字段。文档已承诺的字符串 Git URL 也按默认 clone 解析，本地路径字符串保持用户所有。
- 一个统一的 managed-source 路径解析负责新增、读取、更新、删除、迁移和 CLI 验证；cache 不参与目录扫描或插件自动发现。
- 现有 managed clone 只有在 ownership marker、remote identity 和 clean working tree 全部验证后才从 `$ASB_HOME/plugins/<namespace>` 迁移。无法验证、有本地修改、或新旧路径同时存在时保留内容并报错。
- 删除 source 只清理验证通过的 managed cache。手动 local source 不由 ASB 删除，subtree 继续通过 `$ASB_HOME` Git 仓库管理。
- marketplace materialization 迁入 `.entries/` 后继续保持按 source 和 entry 隔离、原子刷新、失败时保留上一份可用 checkout 的行为。

## Boundary

- 可修改 `src/config/`、`src/library/sources.ts`、`src/marketplace/`、`src/plugins/`、`src/sync/command.ts`、`src/index.ts`、对应测试和 `README.md`；不修改 distribution target、project manifest、MCP 或组件分发语义。
- 不增加依赖、公开 cache 管理命令、per-source checkout 配置、symlink bridge、通用 package-manager abstraction、共享 Git object store 或 cache 自动发现。
- 保持配置层级与覆盖规则、namespace 和 component ID、local source、subtree、Git credential redaction、ref 与 subdir、路径 containment、symlink 防护和 failed-refresh preservation 兼容。
- 迁移不得移动或删除未验证、被修改或用户维护的目录；同 namespace 的 local source 与 managed source 冲突时停止，不静默覆盖。
- 不增加配置协议版本或旧客户端 fencing。共享配置只有在执行它的 ASB 版本支持 cache 布局时，才能保证不在 `$ASB_HOME/plugins` 重建 managed clone。
- 本任务不发布版本、不创建 tag、不 push，也不迁移当前用户目录中的真实 checkout；只交付代码、文档和确定性验证。
