---
status: executing
owner: .harness/runtime/tasks/003-agent-switchboard-lean-release
evidence: null
goal: 019f715a-413c-7e20-8274-0dbe0a3485da
---

# Agent Switchboard Lean Release Alignment

## Goal

交付并发布一个比 `e4c43d3` 更小的 Agent Switchboard patch 版本：保留已证明有消费者的产品能力，只留下设备级 ownership、删除前内容或 provenance 校验，以及 released marketplace cache 的失败保留语义。

```text
pnpm lint && pnpm typecheck && pnpm test && pnpm run build -> success
source lines <= 20350
test lines <= 14800
two Mackup peers -> distinct hook and manifest ownership
foreign or modified output -> preserved
published package -> asb --version prints 0.4.32
```

## Design

- 从 `e4c43d3` 的隔离 worktree 重建结果，当前混合工作树只作为可恢复证据，不在其五千余行新增状态机上继续手术。
- 先应用删除和复用，再加入最小设备 key、managed fingerprint、hook state authority 和 managed clone marker。
- marketplace 使用 released deterministic cache、staged checkout 和失败 refresh 保留语义，不增加 selector generation、lifecycle revision 或 publisher fencing。
- 真实 CLI journey、确定性检查和独立审计全部通过后，合并到 `main`，创建并推送 `v0.4.32`，由 GitHub Release workflow 发布 npm，再安装准确版本复验。

## Boundary

- 实现可修改 `src/`、`tests/`、`README.md`、`package.json`、`pnpm-lock.yaml` 和本 alignment 文件；当前 dirty checkout 的既有内容在集成前保持可恢复。
- 保持 runtime extensions、config-driven targets、Git subtree、配置优先级、portable/native plugin 分离和 built-in target 行为兼容。
- 不增加依赖、通用 lock、journal、quarantine、deferred transaction、rollback debt、lifecycle revision 或公开 recovery API。
- Mackup 共享配置仍是单写者、last-writer-wins；不实现跨设备分布式锁或逐 filesystem call 崩溃恢复。
- 允许在候选 commit 的完整门禁与独立审计通过后执行 `git push origin main --follow-tags`，发布版本固定为 `0.4.32`。
