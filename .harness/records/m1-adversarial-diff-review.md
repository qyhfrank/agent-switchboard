# M1 adversarial diff-first review

审查结论：**不通过**。目标为 `b8dc437..a9af15b28057af4ba9318ef44bcaaf96f000c501`。审查发现 12 项 blocking、13 项 should-fix、2 项 nit。审查只读取已提交对象和目标文件，没有运行可能写入工作区或临时状态的测试，也没有修改仓库源码。

本报告不重复计入委托方已确认的五项：project 配置写入 user-global 目标、早期版本在加锁前读取 ledger、`ledger.ts` 的原始 NUL、未消费的 region/project-distribution 字段、selected malformed/missing rule 阻塞所有 app aggregate。

## Blocking

### B-01 结构合法但语义损坏的 ledger 可越过 bundle 根目录删除任意文件

- 场景：`ledger.json` 是合法 JSON，且顶层为 `{version: 1, entries: [...]}`；其中一个 hash 与目标树一致的 `own-dir` 记录携带 `files: ["../../victim"]`。取消选择该 skill 后，planner 把该相对路径原样交给 removal，`path.join(root, rel)` 解析到根目录之外并执行 `unlinkSync`。同一缺口也接受伪造的 `provenance: "convention"`，但 removal 不检查 provenance，因而把 update-only 声明升级为删除权。
- 位置：`src/engine/ledger.ts:75`，`src/engine/plan.ts:625`，`src/engine/plan.ts:649`，`src/engine/shapes.ts:379`。
- 违反：B1 的 proof-gated delete、fail-closed ledger，以及 `..` traversal containment。
- 测试强度：`tests/v05/rules-sync.test.ts:229` 只覆盖无法解析的 JSON，没有覆盖字段类型、shape/provenance、相对路径或必填字段。

### B-02 dangling `ledger.json` symlink 绕过 fail-closed

- 场景：state home 中的 `ledger.json` 是指向不存在目标的 symlink。`existsSync` 返回 false，loader 把它当作空 ledger；sync 随后写目标，保存阶段的 atomic rename 再把 symlink 本身替换为普通 ledger 文件。整个运行不会抛出 `LedgerError`。
- 位置：`src/engine/ledger.ts:53`，`src/engine/ledger.ts:87`，`src/engine/shapes.ts:407`，`src/engine/shapes.ts:454`。
- 违反：claim 3 的 corrupt/unreadable ledger 必须在任何写入前 exit 2。

### B-03 两个 stale-lock reaper 可以同时持有 run lock

- 场景：A、B 都观察到同一个超过 10 分钟且 PID 已死的 lock。B 先 rename/unlink 旧 lock 并以 `wx` 建立新 lock；已完成 stale 判断的 A 随后把 B 的新 lock rename 到自己的 reap 路径、删除它并再次 `wx` 成功。A、B 此时都执行 reconciliation，release 还可能互删对方的 lock。
- 位置：`src/engine/ledger.ts:136`，`src/engine/ledger.ts:145`，`src/engine/ledger.ts:153`，`src/engine/ledger.ts:165`。
- 违反：claim 3 的 O_EXCL 单运行锁和并发 ledger 安全。

### B-04 containment 是 check-then-use，父目录可在检查后被换成外部 symlink

- 场景：一个同用户并发进程在 `targetEscapesRoot` 及 apply-time hash/fingerprint 检查完成后，把目标父目录换成指向外部目录的 symlink。rules write 会在外部路径 rename，rules remove 会 unlink 外部文件；skills write/remove 会沿 bundle 内部被换掉的父目录写入或删除外部文件。
- 位置：`src/engine/cli.ts:206`，`src/engine/cli.ts:216`，`src/engine/cli.ts:278`，`src/engine/shapes.ts:331`，`src/engine/shapes.ts:377`，`src/engine/shapes.ts:454`。
- 违反：B1、G10 apply-time proof，以及 write/remove symlink containment。
- 测试强度：`tests/v05/rules-apply-hardening.test.ts:69` 只测试静态 symlink；`tests/v05/rules-apply-hardening.test.ts:123` 只测试普通内容 drift，没有在检查与 syscall 之间换目录。

### B-05 skill capture 对同一目标读两次，可生成内部不一致的 SyncCapture

- 场景：已记录 bundle 和 source 都是 A。`listTargetFiles` 读取 A 后，用户把目标改成 B；紧接着 `bundleFingerprint` 读取 B。planner 用 A 的逐文件快照通过 `bytesClean()`，却把 B 的 fingerprint 作为 `expectedHash`。executor 看到仍为 B，认为无 drift，随后用 A 覆盖用户编辑。
- 位置：`src/engine/cli.ts:138`，`src/engine/cli.ts:141`，`src/engine/cli.ts:142`，`src/engine/plan.ts:658`，`src/engine/plan.ts:666`，`src/engine/plan.ts:686`。
- 违反：claim 1 的 capture fs once / 单快照，以及 planner-to-apply TOCTOU 防护。

### B-06 unreadable 或 dangling 的 rules occupant 被等同于 absent content

- 场景：一个 dedicated asb 文件以 mode `000` 存在，而父目录仍可 rename；capture 的 read 失败后保留 `exists: true, content: null`。无 ledger 时 planner 把它当 convention update，executor 再次把 read error 折叠为 `null`，与 `expectedHash: null` 相等并覆盖该未证明 occupant。若目标是 dangling symlink，`existsSync` 为 false，create 路径直接 rename 覆盖 symlink。
- 位置：`src/engine/cli.ts:68`，`src/engine/cli.ts:74`，`src/engine/cli.ts:265`，`src/engine/plan.ts:312`，`src/engine/plan.ts:383`，`src/engine/shapes.ts:454`。
- 违反：B1 的“unproven asb-named occupants are never touched”和 G10 的 apply-time proof。

### B-07 tree fingerprint 的序列化有确定性结构碰撞

- 场景：树 T1 只有文件 `a`，其 bytes 为 `P || header(b) || Y`；树 T2 有文件 `a=P` 和 `b=Y`，两者 mode 相同。fingerprint 在 file bytes 后没有长度或结束分隔符，因此两个不同树喂给 SHA-256 的字节流完全相同。记录 T1 后把目标改成 T2，再取消选择，ASB 仍认为 hash-match 并删除已被修改的 `a`。
- 位置：`src/engine/shapes.ts:217`，`src/engine/shapes.ts:229`，`src/engine/shapes.ts:230`，`src/engine/plan.ts:625`。
- 违反：B1 的 ledger hash-match 必须证明 byte/tree identity，以及 claim 4 的 SHA-256 ownership contract。

### B-08 重复 application ID 产生自冲突和 dry-run/apply 分歧

- 场景：合法配置 `[applications] enabled = ["codex", "codex"]`。planner 从同一 capture 生成两项 `expectedHash: null` create；dry-run 报两次 written。真实运行第一项写入成功，第二项因文件已存在而 conflict，留下部分写入并以 exit 1 结束。rules 和 skills 都受影响。
- 位置：`src/engine/config.ts:109`，`src/engine/config.ts:599`，`src/engine/config.ts:633`，`src/engine/plan.ts:186`，`src/engine/plan.ts:470`，`src/engine/cli.ts:335`，`src/engine/cli.ts:341`。
- 违反：claim 1 的同一 plan/dry-run parity，以及单 reconciliation 的 one-action-per-slice。
- 测试强度：rules/skills dry-run 测试只使用 unique apps，见 `tests/v05/rules-sync.test.ts:292`、`tests/v05/skills-bundles.test.ts:245`。

### B-09 app 和 agents-union 生命周期会在未 deselect 时删除，或在应清理时丢失所有权

- 场景一：Codex 仍 enabled 且仍选择 skill，但 detect dir 暂时消失。union capture 仍存在，`activeMembers` 却只含 detected 成员，union selection 变空；hash-match 的共享 bundle 被删除，尽管用户没有 deselect。
- 场景二：最后一个 union 成员从 `applications.enabled` 移除后，capture 不再读取 `~/.agents/skills`；ledger 仍创建虚拟 row，默认 capture 为 absent，于是报告 already-absent 并删除 ledger，实际 bundle 留在磁盘成为无主文件。
- 场景三：普通 app 从 `applications.enabled` 移除后，rules/skills capture 与 planner 都不再枚举它；其文件和 ledger entry 永久滞留。
- 位置：`src/engine/cli.ts:61`，`src/engine/cli.ts:82`，`src/engine/cli.ts:92`，`src/engine/plan.ts:186`，`src/engine/plan.ts:470`，`src/engine/plan.ts:488`，`src/engine/plan.ts:500`，`src/engine/plan.ts:543`，`src/engine/plan.ts:613`，`src/engine/plan.ts:625`。
- 违反：B1 的 removal only by deselection、single reconciliation，以及 ownership ledger 完整性。
- 测试强度：`tests/v05/skills-agents-union.test.ts:121` 的 toggle-off 仍保留 Codex enabled；没有 last-member、detect-dir disappearance 或 app removal 用例。

### B-10 `--app` 无法选择 agents-union 的实际 action

- 场景：`use_agents_dir=true`，Codex 选择 `alpha`，执行 `asb sync --app codex --type skills`。共享 action 的 app 是虚拟值 `agents`，exact-match filter 将它丢弃；若已有 Codex direct copy，scoped run 还能删除旧 copy，却不写对应 union copy。`explain ... --app codex` 同样丢掉共享 slice。
- 位置：`src/engine/plan.ts:482`，`src/engine/plan.ts:503`，`src/engine/cli.ts:320`，`src/engine/cli.ts:390`。
- 违反：claim 5 的 G11 app scope semantics。
- 测试强度：`tests/v05/skills-agents-union.test.ts:55` 起的 union 测试都未传 `apps`；CLI tests 只验证 argv parse 等价。

### B-11 apply-time removal drift 不会丢弃 stale ledger claim

- 场景：planner 在 hash-match 状态生成 remove + ledger delete；apply 前用户修改文件。executor 正确返回 `left-behind(modified)`，但在执行 ledger mutation 前提前返回，`runSync` 又只在 outcome 与原 action 相同才标记 ledger dirty。旧 ownership claim 因而保留；若 bytes 以后恢复，删除权会复活。
- 位置：`src/engine/cli.ts:216`，`src/engine/cli.ts:222`，`src/engine/cli.ts:271`，`src/engine/cli.ts:343`。
- 违反：builder claim 2 明示的“left-behind(modified) drops the stale ledger claim”。
- 测试强度：`tests/v05/rules-apply-hardening.test.ts:123` 断言目标未被碰触，却没有先放入 stale ledger claim 并断言其被删除。

### B-12 own-dir unlink 失败被当作 absent，运行仍报告成功并提交/删除 ledger

- 场景一：已记录 bundle root 改成 `0555`，source 删除其中一项。root mode 不进入 fingerprint，所以 proof 仍匹配；stale unlink 的 `EACCES` 被吞掉。运行报告 written，并以不含 stale rel 的新 ledger 覆盖旧记录；下一轮 `sliceClean` 不再检查该文件，报告 unchanged。
- 场景二：取消选择同一 bundle，所有 unlink 都失败；`removeBundleSlice` 返回 false，但 caller 忽略返回值，报告 removed 并删掉 ledger，实际目录完整保留。
- 位置：`src/engine/shapes.ts:208`，`src/engine/shapes.ts:361`，`src/engine/shapes.ts:377`，`src/engine/cli.ts:232`，`src/engine/cli.ts:261`，`src/engine/plan.ts:573`。
- 违反：B1 的 proof-gated removal、准确 ledger 更新和 partial-failure safety。
- 测试强度：现有 stale/removal tests 只覆盖可写目录和成功 syscall。

## Should-fix

### S-01 multi-file bundle apply 不是事务性的，瞬时失败会把 bundle 卡成永久 conflict

- 场景：source 同时更新两个文件；第一项 atomic rename 成功，第二项因 ENOSPC/EACCES 失败。ledger 不更新，但目标已是新旧混合树。下次运行既不匹配旧 recorded hash，`bytesClean()` 也为 false，只报 conflict，无法继续完成原更新。
- 位置：`src/engine/shapes.ts:338`，`src/engine/cli.ts:232`，`src/engine/plan.ts:658`。
- 违反：claim 1 的 single reconciliation 和 ledger lost-update/partial-failure safety。

### S-02 file 与 directory 的合法 source 转换无法 reconcile

- 场景：旧 bundle 含文件 `docs`，新 source 改为 `docs/readme.md`。apply 先创建/写 desired，再删除 stale，`mkdir docs` 因旧文件存在而失败；反向从目录转文件时，atomic rename 目标是仍存在的目录，也失败。
- 位置：`src/engine/shapes.ts:338`，`src/engine/shapes.ts:352`，`src/engine/shapes.ts:360`。
- 违反：claim 4 的 frozen bundle-copy/update contract。

### S-03 non-executable 文件内容更新会扩大权限

- 场景：目标脚本为 `0600` 且 non-executable，source bytes 更新。atomic replacement 按常见 umask 建成 `0644`；代码随后把 `currentMode` 改成新文件 mode，而 non-executable predicate 只检查 exec bits，因此不 chmod 回原权限，私有文件变成 group/world-readable。
- 位置：`src/engine/shapes.ts:249`，`src/engine/shapes.ts:351`，`src/engine/shapes.ts:354`，`src/engine/shapes.ts:356`。
- 违反：claim 4 的 frozen 0.4 mode/write semantics。
- 测试强度：`tests/v05/skills-bundles.test.ts:135` 和 `:165` 覆盖 mode drift，但没有覆盖“内容变化 + 原目标 0600”。

### S-04 dangling recorded target symlink 会被 de-own，但 symlink 留在磁盘

- 场景：已记录 rules file 或 skill bundle 后，将其替换成 dangling symlink，再取消选择。capture 把它当 absent；planner 走 already-absent 并删除 ledger，symlink 自身没有被移除。之后它可以重新变为可达 occupant，但已失去所有权记录。
- 位置：`src/engine/cli.ts:74`，`src/engine/cli.ts:138`，`src/engine/plan.ts:250`，`src/engine/plan.ts:600`。
- 违反：B1 的准确 removal/ledger cleanup。

### S-05 symlinked library `SKILL.md` 被解析但不会被复制

- 场景：library skill 目录中的 `SKILL.md` 是指向普通文件的 symlink。scanner 的 exists/read 会跟随它并接受 metadata；`listBundleFiles` 对 symlink Dirent 既不递归也不加入 files。sync 成功，却部署一个缺少 `SKILL.md` 的 bundle。
- 位置：`src/engine/library.ts:188`，`src/engine/library.ts:190`，`src/engine/library.ts:193`，`src/engine/shapes.ts:183`。
- 违反：claim 4 的 frozen byte-for-byte skill bundle contract。

### S-06 一个 unreadable target subtree 会在 capture 阶段中止整个运行

- 场景：一个候选 skill bundle 内含 mode `000` 子目录或 capture 过程中出现 I/O error。`listTargetFiles` 可能返回 null，但紧接着的 `bundleFingerprint` 递归 read/lstat error 未捕获，`captureFor` 抛出；所有健康 app/bundle 都无法 plan 或报告。
- 位置：`src/engine/cli.ts:141`，`src/engine/cli.ts:142`，`src/engine/shapes.ts:217`，`src/engine/shapes.ts:223`，`src/engine/shapes.ts:230`，`src/engine/shapes.ts:294`。
- 违反：claim 1 的 single reconciliation failure containment，以及 G14 的 slice-local failure intent。

### S-07 TOML splice editor 错误解码合法的 Unicode escape

- 场景：配置含 `enabled = ["foo\u002Dbar"]`，TOML 语义值为 `foo-bar`。editor 只去掉反斜杠，内部值变成 `foou002Dbar`；disable `foo-bar` 无效，enable `foo-bar` 又加入第二个语义相同项，随后可触发 duplicate planning。
- 位置：`src/engine/config.ts:738`，`src/engine/config.ts:749`，`src/engine/config.ts:900`，`src/engine/config.ts:931`。
- 违反：claim 4 的 frozen TOML grammar 和 comment-preserving splice editor。

### S-08 disable 会删除元素行上的注释

- 场景：multiline array 中有 `"alpha", # why this is enabled`。disable alpha 时，`lineIsOnlyElement` 把 comment 也视为可删除区域，整行及 rationale 一起消失。
- 位置：`src/engine/config.ts:856`，`src/engine/config.ts:863`，`src/engine/config.ts:865`。
- 违反：claim 4 的 comment-preserving splice editor。
- 测试强度：enable 测试保留注释，但 disable 用例是无注释单行输入。

### S-09 selection edit 会切断 user config symlink

- 场景：user `.asb.toml` 是指向配置仓库的 symlink。editor 通过 symlink 读取 backing file，却在 symlink 所在目录创建 temp 并 rename 到逻辑路径；结果 symlink 被普通文件替换，backing file 保持旧内容。
- 位置：`src/engine/config.ts:891`，`src/engine/config.ts:950`，`src/engine/config.ts:956`；旧版写入点为 `b8dc437:src/config/layered-config.ts:212`。
- 违反：claim 4 的 legacy/config editing behavior。

### S-10 `--source`、`--update`、`--no-update` 只解析，不产生声明的行为

- 场景：执行 `asb sync --source absent` 仍规划并写入所有 source；`--update` 不刷新 clone，`--no-update` 也不参与任何 update 决策。parser 把字段放进 `CliOptions`，但 `SyncOptions` 和 `runSync` 完全不消费它们。
- 位置：`src/engine/cli.ts:50`，`src/engine/cli.ts:402`，`src/engine/cli.ts:417`，`src/engine/cli.ts:519`。
- 违反：claim 5 的 G11 CLI surface。
- 测试强度：`tests/v05/cli-surface.test.ts:8` 只比较 parsed invocation，字段即使永远不执行也会通过。

### S-11 app-scoped 运行仍会被已排除 app 的 missing rule 置为失败

- 场景：Codex override 选择不存在的 `ghost`，Claude Code 没有选择它；执行 `sync --app claude-code`。missing row 在 filter 前以 `app: null` 生成，filter 总是保留 null row，scoped Claude Code 运行仍因 Codex-only missing rule exit 1。
- 位置：`src/engine/plan.ts:160`，`src/engine/plan.ts:171`，`src/engine/cli.ts:320`。
- 违反：claim 5 的 G11 scope semantics。

### S-12 skills explain 总把 selected desired state 渲染为 empty

- 场景：已选择并安装一个 skill，或 source 已更新使 target stale；`explain` 仍把 `desiredHash` 和 `desired` 固定为 null，renderer 输出 `desired: empty`，与实际 source bundle 相反。
- 位置：`src/engine/plan.ts:801`，`src/engine/plan.ts:822`，`src/engine/plan.ts:829`，`src/engine/report.ts:128`。
- 违反：claim 5 的 explain contract（command description 也声明 desired content）。
- 测试强度：`tests/v05/skills-status.test.ts:54` 只断言 source/current/recorded，没有断言 desired。

### S-13 lock 创建或释放失败会遗留不可恢复的 lock

- 场景：`open(..., "wx")` 成功后，`writeSync` 因 quota/I/O error 抛出；函数尚未返回 `RunLock`，fd 和 lock file 都没有 cleanup。另一条路径中，release 的 unlink 失败被无条件吞掉。另一个可达状态是旧 PID 被无关进程复用，超过 10 分钟的 crash lock 会因 `kill(pid, 0)` 一直被判 alive。
- 位置：`src/engine/ledger.ts:127`，`src/engine/ledger.ts:162`，`src/engine/ledger.ts:165`。
- 违反：claim 3 的 10-minute stale takeover 和 run-lock lifecycle。

## Nit

### N-01 Windows 上的 skills explain path-suffix 查询不匹配

- 场景：Windows target path 使用 `\`，用户按测试/API 传 `skills/review-pr`。代码只在 target 前添加一个 native `\`，形成 mixed-separator suffix `\skills/review-pr`，无法匹配真实路径。
- 位置：`src/engine/plan.ts:813`，`tests/v05/skills-status.test.ts:87`。
- 违反：claim 5 的 explain target-path CLI contract。

### N-02 “byte-for-byte” acceptance helper 把文件解码为 UTF-8

- 场景：source 与 target 含不同的非法 UTF-8 byte sequence，但解码后都成为相同 replacement characters；`treeOf` 深比较仍通过，因此 bundle copy 即使不再 byte-identical，测试也可能为绿。
- 位置：`tests/v05/skills-bundles.test.ts:20`，`tests/v05/skills-bundles.test.ts:50`，`tests/v05/skills-bundles.test.ts:57`。
- 违反：claim 4 对 frozen byte-for-byte contract 的验证强度。

## Unconfirmed suspicions

- package/bin 是否已切换到新的 `src/engine/main` 不在本次给定 surface 内；从 surface 无法确认 M1 runtime entrypoint 是否已接线，因此不计 finding。
- `status`/`explain` 的完整 0.4 CLI grammar 可能还有未移植选项，但本次 builder claims 只冻结了列出的 G11 行为，未扩大为 finding。

## Claims with no additional finding

- **Claim 1, G10 planner purity**：`src/engine/plan.ts` 没有 filesystem import，也没有隐式 fs access；它只消费 `PlanInput/SyncCapture`。在 unique apps、静止 filesystem 的普通 create/update/remove 路径上，dry-run 与 real run使用同一 action list。问题限定为 B-05、B-08 及 partial apply，不另报 planner impurity。
- **Claim 2, B1 normal ownership paths**：稳定状态下，identity adoption 要求期望文件 bytes/mode 相符；普通 recorded hash-match deletion、convention update-only 和 planner-time modified left-behind 的逻辑成立；静态 unproven special/symlink bundle 不会被 write/remove。边界缺口已列于 B-01、B-04、B-06、B-07、B-09、B-11、B-12、S-04。
- **Claim 3, ordinary fail-closed path**：普通 unreadable regular ledger、invalid JSON、错误顶层 version/entries 会在 target write 前抛 `LedgerError`；无竞争时 `wx` acquisition 和单一 dead stale lock takeover 成立。语义验证、dangling symlink、双 reaper 和 lifecycle 缺口已单列。
- **Claim 4, frozen 0.4.35 rules contracts**：与 `b8dc437` 的 composer/distribution/paths/builtin targets 对照后，没有发现 per-app rule target path、MDC frontmatter bytes、composition 顺序/分隔符/normalization、rules SHA-256、layer merge 或列出的 legacy migration 漂移。发现的 frozen-contract 偏差仅为 tree proof、bundle mode/copy 和 TOML splice 项。
- **Claim 5, G11 confirmed subset**：root 与 subcommand flags 的顺序合并结果一致；empty plan 的 quick-start guidance 存在；`main()` 返回 code 且不调用 `process.exit`。无额外 finding；实际 scope/flag/explain 缺口已列于 B-10、S-10、S-11、S-12、N-01。
- **Claim 6, G14/G8 confirmed subset**：unselected malformed rule 和单个 malformed skill 可各自失败而健康 sibling 继续；普通 enabled-but-undetected app 会输出 skipped、detect path 和 `assume_installed` 指针。委托方已排除的 selected aggregate 问题不重复计算；S-06 是 target I/O containment 的不同失败类。

## Attack categories with no additional finding

- **Planner impurity**：未发现；planner 没有 fs API。
- **TOCTOU**：发现 B-04、B-05、B-11；除此之外，稳定目标上的 apply-time content/fingerprint recheck 能拒绝普通 drift。
- **Ledger corruption / partial failure / concurrency**：发现 B-01、B-02、B-03、B-12、S-01、S-13。真实运行已在 load/capture 前加锁，因此除 stale reaper race 外，没有再发现普通两-run lost update。
- **Path containment**：发现 ledger `files` traversal 和动态 symlink swap。配置及 table-derived target 中没有找到用户可注入 absolute path 或 `..` 的直接路线；静态 parent-symlink write/remove 会被 capture/planner 和 executor 双重阻断。
- **Run-lock leak/race**：发现 B-03、S-13；单进程正常返回和异常离开 `runSync` 时，`finally` 会 release。
- **Frozen bytes/paths drift**：rules paths、MDC bytes、compose normalization/hash 未发现漂移；bundle proof/mode、TOML editor 的偏差已列出。
- **Weak tests**：每个相关 finding 已标出会漏过它的现有断言。除此之外，`tests/run.mjs` 会枚举 root 与 `tests/v05` 的 `.test.ts`，未发现新增 v05 文件未进入 runner 的问题。
