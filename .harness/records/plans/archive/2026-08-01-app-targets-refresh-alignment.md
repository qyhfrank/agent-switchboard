---
status: delivered
owner: .harness/runtime/tasks/001-app-targets-refresh
evidence: .harness/runtime/tasks/001-app-targets-refresh (merged: f3dc4d0+feb083e+9e4b704 on main, pushed)
goal: null
---

# 应用目标表刷新（清 coco、增 traecli、复核 trae/trae-cn） Alignment

## Goal

动机：coco（TRAE CLI 1.0）已退役，官方 2.0 手册提供完整迁移路径，ASB 里的 coco 实现要清得"就像从来就没有过一样"。traecli 2.0 是 codex 的 fork，要用最简单、最优雅、最高效的设计在实现里充分支持它，但 README 一个字都不提。trae 和 trae-cn 的实现要按官方最新现状更新。

终态：coco 在 ASB 产品面彻底消失（应用表、方言渲染器、测试、README）；新增名为 `traecli` 的应用目标，rules、MCP、commands、agents 四类资源全格支持，skills 经既有机制流入，README 全文零 `traecli` 字样；trae、trae-cn 两行与官方当前文档及本机最新构建逐项复核，确认有效的保持，失实的修正。主工作交付完成后，协助清理 `~/.coco/` 存量。

Examples:

- `rg -i coco src tests README.md` → 零命中（`.harness/records/` 历史档案除外）
- `rg -i traecli README.md` → 零命中
- `asb sync`（启用 traecli）→ `~/.trae/traecli.toml` 写入托管 `[mcp_servers.<name>]` 表；`~/.trae/AGENTS.md` 与 codex 行同内容；`~/.trae/commands/<id>.md` 与 `~/.trae/agents/<id>.md` 生成
- 无 `~/.trae/cli` 的机器（纯 Trae IDE 用户）→ traecli 检测为未安装，不产生任何写入
- 存在含 `app: coco` 记录的历史状态目录时运行 `asb status`、`asb sync` → 不崩溃，coco 记录按未知应用安全跳过
- 收尾动作（主工作交付后）：列出 `~/.coco/` 与 `~/Library/Application Support/coco/` 内容，经用户确认后删除；`~/.cursor/rules/asb-rules.mdc` 属 cursor 目标，不在清理范围

## Design

- traecli 行以 codex 行为模板克隆：rules → `~/.trae/AGENTS.md`（项目级项目根 `AGENTS.md`，`rawBody`，非专有宿主）；MCP → `~/.trae/traecli.toml`（TOML、`mcp_servers`、`codexServer` 方言、`renderCodexTable` 序列化、`create: true`）。实测 `~/.trae/AGENTS.md` 会被注入提示输入。
- commands → `~/.trae/commands/<id>.md`，渲染沿用 kebab-case frontmatter 变换（join allowed_tools、rename allowed_tools→allowed-tools、argument_hint→argument-hint），函数命名 `renderTraecliCommand`；agents → `~/.trae/agents/<id>.md`，复用 claude 形状渲染。依据：traecli 官方迁移把 `~/.coco/commands`、`~/.claude/agents` 原样迁入这两个目录（本机迁移报告证实）。
- 不设 skills 格：traecli 原生扫描 `~/.trae/skills` 与 `~/.agents/skills`（均实测证实），前者由 `trae` 行管理，后者由 union 管理；`AGENTS_SKILLS_UNION.members` 增加 `'traecli'`。在 `~/.trae/skills` 上加第二个 owner 会与 trae 行互相清理。
- 检测点 `detectDir = ~/.trae/cli`：traecli 专有运行时目录（auth/sessions/memories），避免纯 Trae IDE 用户被误判为已安装。
- traecli 不做 hooks（`traecli.toml` `[[hooks.*]]` 机制与 codex `hooks.json` 不同）、不做项目级 MCP（官方手册未确认项目级 toml 位置）、不做 commands/agents 的导入器；后续需要各自单独立项。
- coco 删除面：`apps.ts` 的 coco 行与 `cocoConfigDir`/`cocoDataDir` 两个 helper、`dialects.ts` 的 `renderCocoCommand`/`renderCocoAgent`、`tests/v05/coco-target.test.ts` 整文件、`status-explain`/`skills-library`/`project-scope` 三个测试中的 coco 引用、README 的示例配置与能力矩阵 Coco 行。代码与注释同样不得残留 coco 字样。
- trae/trae-cn 复核结论：全部保持，路径零变化。全局 rules 格维持 `user_rules/` 目录形式（当前构建的 AI 组装模块仍引用；官方面板改版未动文件机制）；skills（`~/.trae/skills`、`~/.trae-cn/skills` 与官方文档一致）；MCP（vendor `User/mcp.json` 全局 + `.trae/mcp.json` 项目级已从实验转正式）。

## Boundary

- 可变文件仅限 `src/engine/apps.ts`、`src/engine/dialects.ts`、`src/engine/plan.ts`、`tests/v05/**`、`README.md`。
- README 及任何面向用户的文档零 `traecli` 字样；不动 `.harness/records/**` 与 git 历史（历史档案保留 coco 字样合法）；不新增运行时依赖；不动其他 app 行（claude-code、claude-desktop、codex、gemini、opencode、cursor）；TRAE Work 相关一概不做。
- traecli 行不得新增 skills 格（`~/.trae/skills` 已由 trae 行独占管理，双 owner 会互相清理）。
- `codexServer`、`renderCodexTable` 被 codex 与 traecli 两行共享，改其行为即改 codex，不得为 traecli 调整它们。
- 项目 `AGENTS.md` 是 codex/gemini/opencode 三行共享的非专有宿主，traecli 加入后四行共存属既有模式，不得改为专有文件。
- 冻结路径值来自官方文档或本机实测，executor 不得凭直觉"修正"命名（如 `user_rules` 改成 `user-rules`、`traecli.toml` 改成 `config.toml`、`.trae/skills` 改成 `.agents/skills`）。
- `~/.coco/` 与 `~/Library/Application Support/coco/` 的删除发生在主工作交付后，删除前必须列出内容并经用户确认。
