---
status: draft
owner: null
evidence: null
goal: null
---

# asb live progress and picker restyle Alignment

## Goal

动机:报告渲染层重设计(2026-08-04-cli-output-ui-alignment.md)确立的视觉语法应当同样覆盖"运行中"的瞬时界面,否则工具在跑与跑完是两副面孔。

范围雏形:sync 运行期间用单行 ora spinner 显示当前阶段(如 `⠿ syncing claude-code · 3/5 apps`),报告打印前擦除,滚动缓冲里只留报告;`enable`/`disable` 交互选择器换用同一 token 体系(●/○ 青色选中态、dim 的 per-app 支持标签、底部实时计数)。

构建顺序:依赖报告渲染层任务先落地(token 表与动词映射暂私有在 `src/engine/report.ts`);本任务启动时把 token 表抽成共享模块再复用,不自建第二份。

候选顺带项(届时再定):空库屏的 "apps found" 已安装应用行,前提是把安装探测以数据方式暴露,而不是渲染层自己扫文件系统。
