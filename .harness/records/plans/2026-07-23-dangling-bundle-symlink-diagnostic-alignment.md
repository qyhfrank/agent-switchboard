---
status: executing
owner: .harness/runtime/tasks/004-diagnose-dangling-bundle-symlink
evidence: null
goal: null
---

# Dangling Bundle Symlink Diagnostic Alignment

## Goal

避免 Mackup、Seafile 或其他 dotfile 工具留下悬空目录 symlink 时，`asb sync` 只暴露难以定位的 `ENOENT mkdir`；ASB 应在写入前指出失效链接及其目标，保护可能尚未挂载或同步的用户状态，并把修复作为下一可用 patch 版本交付。

当 bundle entry 的逻辑父链含 dangling symlink 时，共用 distributor 对受影响 entry 返回可操作的 preparation error。Hook distributor 随即停止该 target 的配置与 ownership state 发布。ASB 不修改链接、链接目标或受影响 entry；普通缺失目录、指向现存目录的 symlink、以及 ASB-owned entry 叶子的现有行为保持不变。

Examples:

```text
~/.codex/hooks -> ../workspace/Settings/MacBackup/mackup/.codex/hooks
解析后的目标不存在

asb sync
-> Failed to prepare <hook-id>
-> 报错包含 ~/.codex/hooks、readlink 原始目标及相对目标解析位置
-> 提示先恢复或重新连接预期目标；仅在确认链接已废弃后再自行修正或移除
-> 明确 ASB 未修改该链接
-> ~/.codex/hooks 的链接和值不变，缺失目标不被创建
-> 既有 ~/.codex/hooks.json 内容不变
```

- `~/.codex/hooks` 或 `~/.codex/hooks/managed` 指向现存目录时，bundle 继续写到真实目标，链接保持不变。
- `~/.codex/hooks` 是普通缺失路径时，bundle 目录照常创建。
- `managed/<hook-id>` 这个 ASB-owned 叶子或其内部文件是 symlink 时，继续沿用现有替换语义。
- 完整门禁通过后，结果进入 `main`，由下一可用 patch tag 触发 GitHub publish workflow；本机安装该准确版本后，`asb --version` 输出相同版本。

## Design

```text
bundle entry
    |
    v
只读检查 bundleRootDir .. dirname(targetDir)，包含两端
    |-- 普通目录或指向现存目录的 symlink --> 继续现有写入
    |-- 首个普通缺失组件 -------------------> 交回现有递归创建
    `-- 首个 dangling symlink --------------> preparation error
                                                  |
                                                  `--> hook target 不发布配置或 state
```

- 父链检查位于共用 `distributeBundle` 的 entry preparation 边界，发生在 `targetDir` 检查、叶子替换和首次递归 `mkdir` 之前；不检查 `bundleRootDir` 的祖先、`targetDir` 本身或其内部路径。
- 每个现存逻辑组件先用 `lstat` 识别 symlink。只有组件是 symlink 且 dereference 以 `ENOENT` 失败时才判定为 dangling；有效目录 symlink 继续使用，首个普通缺失组件结束检查。
- 诊断包含 entry、逻辑 symlink 路径、`readlink` 原始目标，以及相对目标的解析位置。恢复提示优先要求恢复或重新连接预期目标；只有用户确认链接已废弃且无需恢复内容时，才建议自行修正或移除。
- `asb sync --dry-run` 运行同一只读检查。检查后的并发文件系统变化仍可产生底层错误，不增加锁或重试状态机。
- Codex hooks 回归用例使用预存 `hooks.json`，约束 preparation error、链接与 `readlink` 值不变、链接目标未创建、配置字节不变；已有有效父 symlink 与 ASB-owned 叶子替换用例继续作为兼容性证据。

## Boundary

- 实现只修改 `src/library/distribute-bundle.ts` 与 `tests/hooks-distribution.test.ts`；不为测试导出新 guard。发布阶段只修改仓库 release 流程要求的版本元数据。
- 不修改 `src/hooks/codex-distribute.ts`、`src/hooks/distribution.ts` 或 `src/hooks/bundle-dirs.ts`；现有 bundle error barrier 继续拥有 hook 配置与 state 的停止语义。
- 不自动 `unlink`、retarget、替换 dangling 父 symlink，也不创建其目标；不判断 Mackup 或 Seafile ownership，不把链接目标限制在 home 内，不重新引入 symlink trust allowlist。
- 不改变有效父 symlink、ASB-owned entry 与内部文件的替换、orphan cleanup ownership、project manifest、配置发布事务或多 entry 的既有非事务语义。
- 不增加公开命令、flag、配置字段、状态文件、依赖、迁移逻辑、跨 entry rollback 或 filesystem locking。
- 实现、验证、review、集成和 release 由 `/harness` 管理。只有完整门禁通过且 `main` 与 `origin/main` 同步、工作树干净时，才可 commit、合并到 `main`、push `origin/main`、创建并 push 下一 patch tag；不在本机运行 `npm publish`。
- GitHub publish workflow 成功后，运行 `npm install -g agent-switchboard@<version>`，并以 `asb --version` 确认准确版本。
