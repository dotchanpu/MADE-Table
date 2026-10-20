---
version: alpha
name: MADE Deployment Workspace
description: "An English-only deployment workspace on a cool-gray #f5f6f8 canvas, white panels, and a restrained #315fce accent. Inter provides clear UI typography; JetBrains Mono supports dense event and artifact lists. Pipeline labels remain 14px. Rows expand individually or together without introducing a dark terminal background."
colors:
  primary: "#315fce"
  primary-soft: "#edf2ff"
  ink: "#202633"
  ink-muted: "#616b7d"
  canvas: "#f5f6f8"
  surface-1: "#ffffff"
  surface-2: "#f8f9fb"
  hairline: "#e1e5ec"
  hairline-strong: "#b7c0ce"
  success: "#23794e"
  warning: "#956200"
  error: "#c03c49"
  terminal-canvas: "#ffffff"
  terminal-ink: "#202633"
  terminal-muted: "#616b7d"
  terminal-hairline: "#e1e5ec"
  terminal-selected: "#edf2ff"
typography:
  headline:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 25px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: -0.875px
  title-md:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 17px
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: -0.425px
  metric:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 25px
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: -0.875px
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0px
  caption:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
  eyebrow:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 10px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: 1.2px
  button:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0px
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0px
rounded:
  sm: 4px
  md: 8px
  card: 10px
  panel: 12px
  pill: 9999px
spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  gap: 20px
  lg: 24px
  xl: 32px
  xxl: 48px
components:
  panel:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: 20px 24px
  phase-node:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: 12px 14px
  phase-node-selected:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
    rounded: "{rounded.card}"
  button-secondary:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    height: 36px
  nav-item-selected:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
    height: 42px
  event-row:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: 13px 0
---

## Overview

以 `{colors.canvas}` 为画布，`{colors.primary}` 用于当前导航、选中阶段、运行状态、键盘焦点和链接。总览首屏依次展示运行身份与六项指标、部署流程、事件与产物。相比营销页面的大字、装饰插画和大面积渐变，这里通过明确的分区与一致的行距支持持续阅读。

这是基于现有 MADE 页面、日志字段和已安装 design-md 技能的设计改进。成功、待生成、失败仍由 `{colors.success}`、`{colors.warning}`、`{colors.error}` 表达，并同时显示文字。蓝色不用于静态指标卡装饰。

## Colors

`{colors.surface-1}` 用于主要面板，`{colors.surface-2}` 用于流程节点、表头、徽标底色。`{colors.ink}` 用于标题与业务内容，`{colors.ink-muted}` 用于标签、说明与时间。`{colors.hairline}` 分隔信息，`{colors.hairline-strong}` 标记悬停或控件边界。所有对应值集中在 `static/workspace.css` 的 `:root` 中。

## Typography

| 角色 | 字号 | 字重 | 行高 | 字距 | 用途 |
| --- | --- | --- | --- | --- | --- |
| headline | 25px | 700 | 1.3 | -0.875px | 控制台页标题 |
| title-md | 17px | 650 | 1.4 | -0.425px | 面板标题 |
| metric | 25px | 650 | 1.3 | -0.875px | 详情指标数值 |
| body | 13px | 400 | 1.6 | 0 | 事件及正文 |
| caption | 11px | 400 | 1.5 | 0 | 辅助说明 |
| eyebrow | 10px | 600 | 1.5 | 1.2px | 英文分区标签 |
| button | 12px | 500 | 1.5 | 0 | 控件 |
| mono | 12px | 400 | 1.6 | 0 | 变量、时间、路径 |

Use self-hosted Inter for headings, controls, and body text, with JetBrains Mono for logs, variables, paths, and code. Both variable fonts and their SIL Open Font Licenses live in `static/fonts/`; no external font service is needed at runtime. Use `font-display: swap`, tabular numerals, and disable code ligatures. Keep 14px pipeline names and 11.5px / 18px dense log text. All authored interface copy is English; original run identifiers, variable values, and raw log payloads remain unchanged.

## Layout

以 4px 为基础单位；面板通常内边距 20–24px，分区间距 `{spacing.gap}`。总览最大宽度 1760px；详情工作区最大宽度 1560px，桌面侧栏 236px。总览事件栏与产物栏按 1.6:1 分配空间，事件优先阅读。

五阶段及 WeightResolve / DockerSetUp 并行关系始终保留。详情页固定保留“总览详情、共享状态、智能体协作、服务与测试”四个入口。顶部运行上下文与刷新按钮跨页面可见。运行切换保留当前子页面。

总览监控以“触发事件”和“产物状态”为页面主体：桌面与平板采用视口高度网格，顶部标题及指标压缩为摘要，流程面板固定 148px；下方双栏填满剩余空间，每栏至少 280px，保证流程区严格矮于任一列表面板。小于等于 560px 时，流程区 164px，两个列表面板各 340px 并纵向排列。列表内部独立滚动，页头不随事件数量膨胀。阶段名称采用 14px，状态采用 11px，以字号而非增加整块区域高度来改善可读性。

流程图使用统一坐标的 SVG 分叉、汇合与直线连接器。并行节点的中心与连线端点对应，窄屏在流程区内部横向滚动，保留完整并行结构。

## Elevation & Depth

| 层级 | 处理 | 使用 |
| --- | --- | --- |
| 画布 | `{colors.canvas}` | 页面底层 |
| 面板 | `{colors.surface-1}`、1px 边框、极弱阴影 | 内容分区 |
| 内嵌 | `{colors.surface-2}` | 流程节点、表头、响应结果 |
| 选中 | 蓝色边框、2px 淡蓝外环 | 当前阶段 |
| 焦点 | 2px 蓝色描边、3px 间距 | 键盘操作 |

## Shapes

| Token | 用途 |
| --- | --- |
| `{rounded.sm}` | 工具徽标、分类标签 |
| `{rounded.md}` | 选择器、按钮 |
| `{rounded.card}` | 流程节点 |
| `{rounded.panel}` | 主要面板 |
| `{rounded.pill}` | 状态标签 |

No decorative photography. Use the supplied paper logo from `static/paper-logo.png` in the monitor header, detail-page brand lockup, and browser favicon. Preserve its aspect ratio and original artwork; keep it compact so events and artifacts remain the primary content. The header logo has a subtle four-second blue breathing glow and a 1.06 hover scale on precise pointing devices, with no layout shift. Reduced-motion preferences disable both effects. Running nodes retain status indicators and live feedback without continuously scaling cards, and respect reduced-motion preferences.

## Components

`phase-node`：总览点击后直达对应运行、对应阶段的共享状态详情；详情页点击更新当前阶段检查器。状态文字、编号、阶段名与回退次数保留。

`event-row`：终端式输出使用 `{colors.terminal-canvas}` 背景、`{colors.terminal-ink}` 正文及 `{colors.terminal-muted}` 详情。日志为 11.5px JetBrains Mono、18px 行高，行上下各 2px 内边距，单行约 23px。时间、类型标记、标题、工具与附加数据按顺序连续排列；类型标记为 [LLM] / [TOOL] / [STATE] / [GATE] / [PHASE] / [DONE] 等。默认单行预览，点击或 Enter / Space 选中后展开完整文字，再次操作收起；完整内容也保留在 title 提示中。原始标题、工具、元数据和事件数量均保留。

`live-metric`：运行时间每秒更新，超过一小时仍显示秒。Token 数值由实际 SSE 模型调用事件累加，变化时用 480ms 数字过渡和淡蓝闪亮提示。运行中的两项指标各有呼吸状态点，流程结束后停止计时与状态点。已完成历史记录不持续计时。

`row-selection`: Each row independently expands with click, Enter, or Space. Expanded rows wrap full titles and metadata and expose `aria-expanded`. Real header buttons offer Expand all / Collapse all, with labels synchronized to current rows. Pale blue selection and brief feedback remain. Expansion survives same-run refreshes and live updates; changing runs clears it. Empty lists disable the header buttons.

`artifact-row`：同样采用约 23px 终端密集行。键名与“阶段 · 已生成 / 待生成”同行，状态固定在行尾；过长键名默认省略，选中展开换行。原始键名、完整阶段名、数量和状态全部保留。选中行使用 `{colors.terminal-selected}` 与细蓝色边标记，新增数据使用浅蓝或浅绿短暂高亮。终端式仅指密集等宽排版，不使用深色背景。

`state-table`：固定表头、可横向滚动。变量、阶段、值预览、来源四列保留；账本保留状态、已产出和缺失产物。

`file-dropzone`：延续原有目录选择、拖入与自动调用行为；输入说明、调用端点、响应结果保留。可通过键盘 Enter / Space 触发。

`nav-item-selected`：使用 `{colors.primary-soft}` 和 `{colors.primary}`。加上 aria-current；阶段按钮加 aria-pressed。窄屏通过原生 select 切换运行。

## Do's and Don'ts

### Do

- 保持运行、流程、事件的阅读顺序。
- 保留所有原始数据键、阶段状态和服务契约。
- 标题与指标通过字号、字重和留白区分。
- 长文本可换行或通过 title 查看完整值。
- 状态同时提供颜色和文字。
- 相同控件在所有详情页面保持一致。

### Don't

- 不将日志中的 completed 等同于当前服务在线。
- 不使用多种装饰色区分无状态的指标卡。
- 不把英文辅助标签做得比业务标题更醒目。
- 不用固定窄列挤压全部表格内容。
- 不在轮询时反复重建未变化的运行选择列表。
- 不通过强制缩小字体把所有内容压进首屏。

## Responsive Behavior

| 断点 | 行为 |
| --- | --- |
| >1280px | 桌面侧栏、四项指标单行、详情双栏 |
| ≤1280px | 运行信息分行，详情指标两列、内容单列 |
| ≤960px | 总览自然页面滚动；详情流程纵向、并行节点双列 |
| ≤820px | 侧栏变顶部四项导航，显示运行下拉框；总览六项指标三列 |
| ≤680px | 总览流程纵向、并行节点保持双列；事件与产物单列；表格横向滚动 |

监控总览的紧凑布局优先于上表通用规则：其流程始终横向、最小宽度 640px；≤560px 两个主体面板才改为纵向排列。详情页面沿用上表的纵向流程与导航规则。

按钮最小高度 36px，导航 40–42px；流程节点至少 68px。核心数据正文不小于 11px；次级编号与时间允许 9–10px。

## Iteration Guide

1. 修改共享视觉参数时先更新 `static/workspace.css` 的语义变量。
2. 功能逻辑仍在原始 app.js / details.js 中，后端 API 和日志格式独立保留。
3. 新增字段时确定所属运行、阶段、事件或服务区块。
4. 检查桌面、窄屏、长运行名、空数据和事件筛选。
5. 示例提示：“按此 DESIGN.md 增加指标，沿用当前业务字段与单一蓝色强调。”
6. 示例提示：“优化共享状态表的可读性，保留列名、值与来源，支持窄屏横向滚动。”

## Known Gaps

- 当前 Docker 不可用时，无法用界面验证部署服务的实时推理结果；历史日志完成状态照实呈现。
- 本次仅定义浅色产品界面，未提供深色主题。
- 数值精度、运行状态推断、日志内容和 API 合约沿用原逻辑。
- design-showcase.html 为离线视觉示例，其中数据明确标记为示例；实际监控以服务器页面为准。
