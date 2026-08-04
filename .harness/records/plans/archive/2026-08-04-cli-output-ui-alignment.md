---
status: delivered
owner: direct
evidence: 7c61b0f
goal: task-1
---

# asb CLI output UI Alignment

## Decisions needed

Defaults chosen (veto to change):

- 非 TTY(管道、重定向、脚本)输出保持 0.5.1 现有文案逐字节不变,`NO_COLOR` 只是给交互布局去色,不切回旧文案。新布局只出现在交互终端里。依据:README 与 `tests/v05` 多处钉着现有文案,外部包装脚本可能在解析;这样现有测试与 smoke 全部原样通过。
- 问题行不合成"fix: 建议命令":报告数据里没有结构化修复动作,由渲染层从文案猜命令会给错建议。needs attention 行保留脱敏后的完整 reason;结构化 fix 属于将来引擎层的活。
- 空库屏不做 "apps found" 应用探测行(那是新的发现行为,不属于纯呈现层),只保留三条起步命令。
- 不做宽度感知换行:渲染器不接 width,输出缩进 + 完整 token,交给终端自然折行。
- last run 从 sync 报告移除;status 标题行在用户/profile 范围时显示 `last sync <绝对时间>`(项目范围不显示,因为 last-run 是机器全局状态,不记录项目事实);相对时间("21h ago")不做。
- 不预先抽 theme.ts 模块:token 表与动词映射先私有在 `src/engine/report.ts`,等兄弟任务(spinner/选择器)真正复用时再抽。
- 运行中 spinner 与 enable/disable 选择器重样式移入兄弟草案(2026-08-04-cli-live-progress-pickers-alignment.md),本次只交付报告渲染层。

## Goal

动机(用户原话大意):现在的输出是纯文本日志,没有层次,失败和无事发生看起来一样;要按"从零重造"的思路,做一套很人类友好、很好看的终端 UI。

三条设计判据,遇到未列明的取舍时以此为准:输出是对"我同步好了吗"的回答,不是操作日志;严重度向提示符流动(最后一行永远是一句结论,问题紧邻其上);同一渲染管线里的屏幕共用一套视觉语法,同一字形/颜色含义唯一。

端态:走 `renderReport` / `renderCompactStatus` / `renderExplain` 这条管线的命令(`sync`、`status`、`add`、`remove`、隐藏的 `summary`、`explain`、空库分支)在交互终端(stdout 为 TTY)按下列样例渲染;非 TTY 输出与 `--json`、退出码完全不变。

全部同步、无事可做时,一行结束:

```
✓ asb sync · profile aws · 120 components in sync across 5 apps
```

有变更且有问题时(用户 2026-08-03 真实一跑的目标形态;问题行第二行是脱敏后的 reason 原文,dim 显示):

```
asb sync · profile aws

claude-code
  ✓ updated  ~/.claude/CLAUDE.md
  − removed  feishu-cli:feishu-cli-docs · lark-cli:lark-doc · lark-cli:lark-shared
cursor
  − removed  feishu-cli:feishu-cli-docs · lark-cli:lark-doc · lark-cli:lark-shared
agents
  − removed  feishu-cli:feishu-cli-docs · lark-cli:lark-doc · lark-cli:lark-shared

needs attention
  ✗ rl-harness  library source missing
    enabled but its source content is not there; expected ~/Documents/Projects/rl-harness

1 updated · 9 removed · 110 in sync
✗ finished with 1 problem
```

`asb status`(前瞻视角,行内动词用将来时;标题行的 last sync 仅在非项目范围显示,绝对时间):

```
asb status · profile aws · last sync 2026-08-03 17:50

pending
  → claude-code · CLAUDE.md will be updated
needs attention
  ✗ rl-harness · library source missing

110 in sync · 1 pending · 1 problem
→ asb sync applies 1 change
```

裸跑 `asb`(隐藏的 summary 视图;`asb summary` 并非子命令。保持单行 + 单一 next 动作的契约):

```
✗ 1 needs attention → asb status
```

(健康时:`✓ 120 current`。)

`asb explain`(键值卡片;现有字段全部保留:outcome、reason、owner、current/desired 哈希、components、sources、desired content;desired content 在稳定分隔行下逐字节原样输出,不加样式;无匹配分支沿用现有提示文案):

```
claude-code · ~/.claude/CLAUDE.md
  outcome   · unchanged
  owner     identity
  current   3f9c2a11d0e4
  desired   3f9c2a11d0e4
  components
    base-style   ~/.asb/rules/base-style.md
    git-policy   ~/.asb/rules/git-policy.md
  source    lark-cli:lark-doc <- lark-cli (~/.asb/plugins/lark-cli)

--- desired content (claude-code) ---
(正文逐字节保留)
```

空库/首次运行(引导而非报错):

```
asb · nothing selected yet

  asb add <git-url|path>   add a source
  asb enable               pick components
  asb sync                 write app configs
```

边界样例:`asb sync --dry-run` 在报告顶部加一条黄色横幅 `dry run · nothing will be written`,行内不再有 `[dry-run]` 前缀;`status` 本身即预览,不加横幅。`asb sync | cat`、`asb sync > log` 输出 0.5.1 现有文案逐字节不变;`--json` 与退出码语义(0/1/2)不变。`enable`/`disable`/`import`/`init`、帮助、版本、stderr 错误路径的文案本次不动。

## Design

字形与颜色含义唯一;无色时字形单独承担严重度(⚠ 永不用于致败项):

```
✓ green   applied (created / updated)
− yellow  removed
→ cyan    pending / next runnable command
⚠ yellow  non-failing warnings (left-behind), exit code stays 0
✗ red     exit-failing (missing / failed / blocked / conflict)
· dim     separator; unchanged/skipped only ever appear as counts
bold = identities (apps, component ids) · dim = metadata (paths, reasons) · cyan = commands
```

- 布局选择与颜色能力分离:`cli.ts` 在唯一一处判定——布局 = `stdout.isTTY` ? 交互 : 旧版文案;颜色 = 按 NO_COLOR 标准自行判定(`NO_COLOR` 存在且非空即禁色,chalk 5 自身不读它)再与 chalk 的能力检测相与(`chalk.level > 0`,覆盖 `FORCE_COLOR`/`TERM=dumb`/CI/Windows)。渲染器为纯函数,布局与颜色经参数传入,不自行读环境。
- 保持现有分渲染器结构不合并:`renderReport`、`renderCompactStatus`、`renderExplain` 各自增加交互布局分支,只共享 token 表;token 表与动词映射私有在 `src/engine/report.ts`。
- 动词映射是 (屏幕, outcome, detail) 的函数:sync 用完成时(`written`+`created`→`created`、`written`+`updated`→`updated`、`removed`→`removed`);status(dry-run)用将来时(`will be created` / `will be updated` / `will be removed`);源操作预览 `pending`+`clone|refresh`→`will clone` / `will refresh`;词表外的 detail 以 dim 括号原样跟随,信息不丢失。
- 交互布局:变更按 app 分组(app 名加粗、字形+动词列对齐);`FAILING_OUTCOMES` 中致败项(✗)与非致败警示(⚠)都汇入 needs attention 块,每行下一行是脱敏 reason(dim);倒数第二行为计数摘要(严重度降序);最后一行 verdict 按 exitCode:0 → 绿 `✓`(有警示时 `✓ finished with N warning(s)`);1 → 红 `✗ finished with N problem(s)`;2 → 红 `✗ aborted before writing`。
- 同组同 outcome 的多个 id 用 ` · ` 连接,超过 4 个折叠为 `(+N more)`(沿用现有折叠逻辑);unchanged/skipped 永不逐行列出。
- 路径显示为 `~` 缩写(仅交互布局);id 与路径始终为连续完整 token,不截断、不自行换行;仅 16 色语义 ANSI,无背景色。
- 测试沿用 `tests/v05` 的 `assert.match`/`assert.equal` 风格:表驱动断言交互布局的精确文本、有色与无色交互输出 strip-ANSI 后相等、非 TTY 路径与 0.5.1 文案逐字相等(现有断言原样保留即为证明);不引入快照文件机制。

## Boundary

- 可改:`src/engine/report.ts`(新增交互布局分支与 token 表)、`src/engine/cli.ts`(仅布局/颜色判定与渲染调用点)、`tests/v05/**` 新增断言、`CHANGELOG.md`、README 的输出示例段。
- 红线:非 TTY 人类输出、`--json` 结构与内容、退出码语义、Outcome 封闭词表、`FAILING_OUTCOMES`/`EXIT_FAILURE_OUTCOMES` 集合、`redactCredentials` 脱敏路径、explain 的 desired-content 逐字节输出全部不变;不新增运行时依赖(chalk 为既有依赖);不新增 CLI 旗标;不改 plan/apply 任何行为;`enable`/`disable`/`import`/`init`/帮助/版本/stderr 错误文案不动。
- 陷阱:现有 `tests/v05` 断言与 `scripts/smoke-baseline.mjs`(它比对的是文件系统快照,不是 stdout 文案)必须原样通过,不得为新布局改旧断言;ora 本期不用(spinner 属兄弟任务,勿顺手加);`add`/`remove` 与 `sync` 走同一 `renderReport` 调用点,交互布局对它们同样生效,这是有意为之,不要为排除它们加命令判断。
- 执行方式(用户要求):实现与测试改写全部由并行子代理完成;本会话只出任务书、做验收与集成,不直接写代码。
